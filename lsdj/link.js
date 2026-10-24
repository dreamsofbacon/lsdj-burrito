// SPDX-License-Identifier: GPL-3.0-only
// The page's link to the FM-1's running LSDJ Burrito firmware, over USB-MIDI
// SysEx (firmware/lsdj_link.h). Songs, settings, effects and themes only: this
// never writes firmware.
//   request  F0 7D 'G' 'S' op [data] F7
//   reply    F0 7D 'G' 'S' op status [data] F7      data bytes as 7-bit pairs

export const OP = {INFO: 0x01, READ: 0x02, BEGIN: 0x03, CHUNK: 0x04, COMMIT: 0x05, ABORT: 0x06,
  SETTINGS_GET: 0x10, SETTINGS_SET: 0x11, FX_GET: 0x12, FX_SET: 0x13, THEME_GET: 0x14, THEME_SET: 0x15,
  STORE: 0x16, LIVE: 0x20, BLUETOOTH: 0x21};
export const BT_STATES = ['off', 'starting', 'ready', 'advertising', 'connected', 'failed'];
export const BT_ERRORS = ['', 'no radio calibration in flash', 'start timed out', 'no task', 'address refused', 'advertising refused', 'link refused'];
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
  /* input / output: Web MIDI ports (or anything with onmidimessage / send: lsdj/ble-midi.js).
     slow: Bluetooth (each request waits longer). */
  constructor(input, output, {slow = false} = {}) {
    this.input = input; this.output = output; this.waiting = null; this.queue = Promise.resolve();
    this.slow = slow;
    input.onmidimessage = e => {
      const r = parse(Array.from(e.data));
      if (r && this.waiting && r.op === this.waiting.op) { const w = this.waiting; this.waiting = null; w.resolve(r); }
    };
  }
  close() { this.input.onmidimessage = null; }

  /* One request at a time; resolves {status, data, tries}; rejects on a timeout or bad status.
     The USB link drops about one message in a hundred or more (measured on alpha 55: a request or
     its reply never arrives; a late reply was never seen), so a request that is safe to repeat is
     sent again after a timeout: retries more times. */
  req(op, bytes = [], {timeout = 1500, allow = [0], retries = 0} = {}) {
    if (this.slow) timeout *= 3;
    const once = () => new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting = null; reject(new LinkError('The FM-1 did not answer. Is LSDJ Burrito running and the cable connected?', {cause: 'timeout'})); }, timeout);
      this.waiting = {op, resolve: r => { clearTimeout(t); if (!allow.includes(r.status)) reject(new LinkError(`FM-1: ${STATUS[r.status] || 'error ' + r.status}`)); else resolve(r); }};
      this.output.send(frame(op, bytes));
    });
    const run = async () => {
      for (let tries = 1; ; tries++) {
        try { const r = await once(); r.tries = tries; return r; }
        catch (e) { if (e.cause !== 'timeout' || tries > retries) throw e; this.retried = (this.retried || 0) + 1; }
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async info() {
    const {data: d} = await this.req(OP.INFO, [], {retries: 2});
    const str = (a, b) => String.fromCharCode(...d.slice(a, b)).replace(/\0.*$/, '');
    return {protocol: d[0], firmware: str(1, 9), title: str(9, 25), saveSize: rd32(d, 25), saveCrc: rd32(d, 29), importing: d[33], liveKnown: !!(d[34] & 1)};
  }
  async exportSave(progress = () => {}) {
    const out = new Uint8Array(SAVE_SIZE);
    for (let off = 0; off < SAVE_SIZE; off += CHUNK) {
      const {data} = await this.req(OP.READ, le32(off), {retries: 4});
      out.set(data.slice(0, CHUNK), off);
      progress(off + CHUNK, SAVE_SIZE);
    }
    return out;
  }
  async importSave(bytes, progress = () => {}) {
    if (bytes.length !== SAVE_SIZE) throw new LinkError(`An LSDj save is ${SAVE_SIZE} bytes; this file is ${bytes.length}.`);
    const crc = crc32(bytes);
    await this.req(OP.ABORT, [], {retries: 2});   // an import a closed page left behind: gone first
    // BEGIN stores the current songs first (seconds). Sent again only if nothing came back; then
    // "wrong state" means the first one arrived and the import is open.
    const b = await this.req(OP.BEGIN, [...le32(SAVE_SIZE), ...le32(crc)], {timeout: 20000, retries: 1, allow: [0, 2]});
    if (b.status === 2 && b.tries === 1) throw new LinkError('FM-1: wrong state (an import is already running)');
    try {
      for (let off = 0; off < SAVE_SIZE; off += CHUNK) {   // a chunk sent again is fine (the firmware takes the last one twice)
        await this.req(OP.CHUNK, [...le32(off), ...bytes.slice(off, off + CHUNK)], {retries: 4});
        progress(off + CHUNK, SAVE_SIZE);
      }
      // COMMIT: within the firmware's 5 s import timeout, so a lost one is sent again while the
      // import still waits. "Wrong state" on a resend: the first arrived; INFO's checksum says
      // whether the FM-1 now holds this file (stored) or restored its songs (not stored).
      const c = await this.req(OP.COMMIT, [], {timeout: 4500, retries: 1, allow: [0, 2]});
      if (c.status === 2) {
        if (c.tries === 1) throw new LinkError('FM-1: wrong state (the import was given up)');
        const info = await this.info();
        if (info.importing || info.saveCrc !== crc) throw new LinkError('The import may not have been stored. Export the songs to check what the FM-1 holds.');
      }
    } catch (e) {
      await this.req(OP.ABORT, [], {retries: 2}).catch(() => {});
      throw e;
    }
  }
  // (gets and sets are safe to send again: a set writes the same value twice)
  async settingsGet() { return rd32((await this.req(OP.SETTINGS_GET, [], {retries: 2})).data, 0); }
  async settingsSet(v) { await this.req(OP.SETTINGS_SET, le32(v), {retries: 2}); }
  async fxGet() { const {data} = await this.req(OP.FX_GET, [], {retries: 2}); return Array.from({length: 11}, (_, i) => rd32(data, 4 * i)); }
  async fxSet(words) { await this.req(OP.FX_SET, words.flatMap(le32), {retries: 2}); }
  async themeGet() { const {data} = await this.req(OP.THEME_GET, [], {retries: 2}); return Array.from({length: 8}, (_, i) => rd16(data, 2 * i)); }
  async themeSet(colors) { await this.req(OP.THEME_SET, colors.flatMap(c => [c & 255, c >> 8]), {retries: 2}); }
  async store() { await this.req(OP.STORE, [], {timeout: 10000, retries: 1}); }
  /* the FM-1's Bluetooth (firmware/lsdj_ble.h), or null in a build without it */
  async bluetooth() {
    const r = await this.req(OP.BLUETOOTH, [], {allow: [0, 1], retries: 1});
    if (r.status) return null;
    const v = i => rd32(r.data, 4 * i);
    return {state: BT_STATES[v(0)] || 'state ' + v(0), error: BT_ERRORS[v(1)] || (v(1) ? 'error ' + v(1) : ''),
            packetsIn: v(2), packetsOut: v(3), sysexIn: v(4), bad: v(5), mtu: v(6), heapHigh: v(7), heapFails: v(8)};
  }
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
