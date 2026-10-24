// SPDX-License-Identifier: GPL-3.0-only
// The page's link to the FM-1's running LSDJ Burrito firmware, over USB-MIDI
// SysEx (firmware/lsdj_link.h). Songs, settings, effects and themes only: this
// never writes firmware.
//   request  F0 7D 'G' 'S' op [data] F7
//   reply    F0 7D 'G' 'S' op status [data] F7      data bytes as 7-bit pairs

export const OP = {INFO: 0x01, READ: 0x02, BEGIN: 0x03, CHUNK: 0x04, COMMIT: 0x05, ABORT: 0x06,
  SETTINGS_GET: 0x10, SETTINGS_SET: 0x11, FX_GET: 0x12, FX_SET: 0x13, THEME_GET: 0x14, THEME_SET: 0x15,
  STORE: 0x16, LIVE: 0x20};
export const STATUS = ['ok', 'bad request', 'wrong state', 'checksum mismatch', 'flash error'];
export const CHUNK = 128;
export const SAVE_SIZE = 131072;

export function crc32(bytes) {
  let crc = ~0 >>> 0;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
export const le32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
export const rd32 = (b, i) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;
export const rd16 = (b, i) => b[i] | b[i + 1] << 8;

/* Bytes -> the SysEx request (pairs). */
export function frame(op, bytes = []) {
  const out = [0xF0, 0x7D, 0x47, 0x53, op];
  for (const b of bytes) out.push(b & 127, b >> 7);
  out.push(0xF7);
  return out;
}
/* A reply -> {op, status, data} or null if it is not one of ours. */
export function parse(msg) {
  if (msg.length < 7 || msg[0] !== 0xF0 || msg[1] !== 0x7D || msg[2] !== 0x47 || msg[3] !== 0x53 || msg[msg.length - 1] !== 0xF7) return null;
  const pairs = msg.slice(6, msg.length - 1);
  if (pairs.length % 2) return null;
  const data = new Uint8Array(pairs.length / 2);
  for (let i = 0; i < data.length; i++) data[i] = pairs[2 * i] | (pairs[2 * i + 1] & 1) << 7;
  return {op: msg[4], status: msg[5], data};
}

export class LinkError extends Error {}

export class Link {
  /* input / output: Web MIDI ports (or anything with onmidimessage / send). */
  constructor(input, output) {
    this.input = input; this.output = output; this.waiting = null; this.queue = Promise.resolve();
    input.onmidimessage = e => {
      const r = parse(Array.from(e.data));
      if (r && this.waiting && r.op === this.waiting.op) { const w = this.waiting; this.waiting = null; w.resolve(r); }
    };
  }
  close() { this.input.onmidimessage = null; }

  /* One request at a time; resolves {status, data}; rejects on a timeout or bad status. */
  req(op, bytes = [], {timeout = 1500, allow = [0]} = {}) {
    const run = () => new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting = null; reject(new LinkError('The FM-1 did not answer. Is LSDJ Burrito running and the cable connected?')); }, timeout);
      this.waiting = {op, resolve: r => { clearTimeout(t); if (!allow.includes(r.status)) reject(new LinkError(`FM-1: ${STATUS[r.status] || 'error ' + r.status}`)); else resolve(r); }};
      this.output.send(frame(op, bytes));
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async info() {
    const {data: d} = await this.req(OP.INFO);
    const str = (a, b) => String.fromCharCode(...d.slice(a, b)).replace(/\0.*$/, '');
    return {protocol: d[0], firmware: str(1, 9), title: str(9, 25), saveSize: rd32(d, 25), saveCrc: rd32(d, 29), importing: d[33], liveKnown: !!(d[34] & 1)};
  }
  async exportSave(progress = () => {}) {
    const out = new Uint8Array(SAVE_SIZE);
    for (let off = 0; off < SAVE_SIZE; off += CHUNK) {
      const {data} = await this.req(OP.READ, le32(off));
      out.set(data.slice(0, CHUNK), off);
      progress(off + CHUNK, SAVE_SIZE);
    }
    return out;
  }
  async importSave(bytes, progress = () => {}) {
    if (bytes.length !== SAVE_SIZE) throw new LinkError(`An LSDj save is ${SAVE_SIZE} bytes; this file is ${bytes.length}.`);
    await this.req(OP.BEGIN, [...le32(SAVE_SIZE), ...le32(crc32(bytes))], {timeout: 20000});
    try {
      for (let off = 0; off < SAVE_SIZE; off += CHUNK) {
        await this.req(OP.CHUNK, [...le32(off), ...bytes.slice(off, off + CHUNK)]);
        progress(off + CHUNK, SAVE_SIZE);
      }
      await this.req(OP.COMMIT, [], {timeout: 20000});
    } catch (e) {
      await this.req(OP.ABORT).catch(() => {});
      throw e;
    }
  }
  async settingsGet() { return rd32((await this.req(OP.SETTINGS_GET)).data, 0); }
  async settingsSet(v) { await this.req(OP.SETTINGS_SET, le32(v)); }
  async fxGet() { const {data} = await this.req(OP.FX_GET); return Array.from({length: 11}, (_, i) => rd32(data, 4 * i)); }
  async fxSet(words) { await this.req(OP.FX_SET, words.flatMap(le32)); }
  async themeGet() { const {data} = await this.req(OP.THEME_GET); return Array.from({length: 8}, (_, i) => rd16(data, 2 * i)); }
  async themeSet(colors) { await this.req(OP.THEME_SET, colors.flatMap(c => [c & 255, c >> 8])); }
  async store() { await this.req(OP.STORE, [], {timeout: 10000}); }
  async live() {
    const {data: d} = await this.req(OP.LIVE, [], {timeout: 800});
    return {page: d[0], cursor: d[1], bpm: rd16(d, 2), mute: d[4], freeze: d[5], playing: d[6],
            fx: Array.from({length: 11}, (_, i) => rd32(d, 7 + 4 * i))};
  }
}

/* Web MIDI: the FM-1's ports (its USB name is Felucca), or every port to choose from. */
export async function midiPorts() {
  if (!navigator.requestMIDIAccess) throw new LinkError('This browser has no Web MIDI. Use Chrome or Edge.');
  const access = await navigator.requestMIDIAccess({sysex: true});
  const ins = [...access.inputs.values()], outs = [...access.outputs.values()];
  const fm1 = p => /felucca|fm-?1|h.gelton/i.test(`${p.name} ${p.manufacturer}`);
  return {access, ins, outs, input: ins.find(fm1), output: outs.find(fm1)};
}
