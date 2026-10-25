// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
// (Felucca tools/fm1_install.py; WebMIDI port by GameDude web/vendor/fm1ota.js)
//
// The FM-1 USB-MIDI update protocol over WebMIDI. Step 1: the running firmware
// reads parts of the package and stages the update loader. Step 2: the loader
// reads the whole image and writes it. Both steps are "the device asks, we
// answer": cmd 0x30 read requests on the logical image.
//
// LSDJ Burrito changes: every request is answered at once from the message
// event. The old code waited 10 ms with a timer before each of ~1200 answers;
// in a background tab Chrome stretches such timers to a second or a minute,
// and the loader gave up part way (the alpha installer's half-written FM-1).
// Progress is a callback; only the FM-1 (no other boards).

export const HS_QUERY = [0xF0, 0x00, 0x32, 0x45, 0x00, 0x00, 0x00, 0x40, 0x7F, 0xF7];
export const UPGRADE = [0xF0, 0x22, 0x24, 0x35, 0x7F, 0xF7];
export const MAXDATA = 512;
export const STAGE_DONE = 0xE0000000, WRITE_DONE = 0xF0000000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pack7(data) {
  const out = []; let acc = 0, nb = 0;
  for (const b of data) {
    acc |= b << nb; nb += 8;
    while (nb >= 7) { out.push(acc & 0x7F); acc >>>= 7; nb -= 7; }
  }
  if (nb) out.push(acc & 0x7F);
  return out;
}
export function unpack7(s) {
  const out = []; let acc = 0, nb = 0;
  for (const b of s) {
    acc |= (b & 0x7F) << nb; nb += 7;
    while (nb >= 8) { out.push(acc & 0xFF); acc >>>= 8; nb -= 8; }
  }
  return out;
}
export function response(addr, data, fl = 0) {
  const len = data.length;
  const body = [0x00, 0x59, 0x30, (len + 8) & 0xFF, ((len + 8) >> 8) & 0xFF, 0, fl,
    addr & 0xFF, (addr >>> 8) & 0xFF, (addr >>> 16) & 0xFF, (addr >>> 24) & 0xFF,
    len & 0xFF, (len >> 8) & 0xFF, 0, ...data];
  let s = 0;
  for (let i = 6; i < body.length; i++) s += body[i];
  body.push(~s & 0xFF);
  return [0xF0, ...pack7(body), 0xF7];
}
export function parseRequest(pkt) {
  if (pkt[0] !== 0xF0 || pkt[pkt.length - 1] !== 0xF7) return null;
  const u = unpack7(pkt.slice(1, -1));
  if (u.length !== 15 || u[0] !== 0 || u[1] !== 0x59 || u[2] !== 0x30) return null;
  let s = 0;
  for (let i = 6; i < 14; i++) s += u[i];
  if ((~s & 0xFF) !== u[14]) return null;
  return {fl: u[6], addr: (u[7] | (u[8] << 8) | (u[9] << 16) | (u[10] << 24)) >>> 0, len: u[11] | (u[12] << 8) | (u[13] << 16)};
}
export function parseIdentity(pkt) {
  if (pkt[0] !== 0xF0 || pkt[pkt.length - 1] !== 0xF7) return null;
  const d = unpack7(pkt.slice(1, -1));
  if (d.length !== 34 || d[0] !== 0 || d[1] !== 0x59 || d[2] !== 0x11) return null;
  const txt = String.fromCharCode(...d.slice(6, 33)).replace(/\0+$/, '');
  const m = /^([^_]+)_(\d+)$/.exec(txt);
  return m ? {text: txt, model: m[1], version: parseInt(m[2], 10)} : null;
}

/* one MIDI in/out pair with a SysEx queue; read() waits for an event, not a timer tick */
export class Link {
  constructor(input, output) {
    this.input = input; this.output = output; this.q = []; this.waiter = null;
    this.onSysex = null;   // optional: answer in the event itself (serve)
    input.onmidimessage = (ev) => {
      if (ev.data[0] !== 0xF0) return;
      const m = Array.from(ev.data);
      if (this.onSysex && this.onSysex(m)) return;
      this.q.push(m);
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
    };
  }
  get lost() { return this.input.state === 'disconnected' || this.output.state === 'disconnected'; }
  send(bytes) { try { this.output.send(bytes); return true; } catch (_) { return false; } }
  drain() { this.q.length = 0; }
  async read(ms) {
    if (!this.q.length) {
      let tm;
      await Promise.race([new Promise((r) => { this.waiter = r; }), new Promise((r) => { tm = setTimeout(r, ms); })]);
      clearTimeout(tm);
      this.waiter = null;
    }
    return this.q.shift() || null;
  }
  close() { this.input.onmidimessage = null; this.onSysex = null; }
}

export const isFm1 = (id) => id.model === 'FM-1' || id.model === 'ota-FM-1';

export class Updater {
  constructor(access, log = () => {}, portPattern = /fm-?1|felucca|ota|composite|usb-midi|gelton/i) {
    this.access = access; this.log = log; this.portPattern = portPattern;
  }
  /* every port of this family is asked who it is; exactly one FM-1 must answer */
  async findAny(filter, {probeMs = 700} = {}) {
    const ok = (p) => p.state !== 'disconnected' && this.portPattern.test(p.name || '');
    const inputs = [...this.access.inputs.values()].filter(ok), outputs = [...this.access.outputs.values()].filter(ok);
    const matches = [], listeners = [];
    let querying = null;
    for (const input of inputs) {
      try { await input.open?.(); } catch (_) { continue; }
      const receive = (ev) => {
        if (!querying) return;
        const id = parseIdentity(Array.from(ev.data));
        if (id && filter(id) && !matches.some((m) => m.input === input && m.output === querying)) matches.push({input, output: querying, id});
      };
      input.addEventListener('midimessage', receive); listeners.push([input, receive]);
    }
    try {
      for (const output of outputs) {
        try { await output.open?.(); } catch (_) { continue; }
        querying = output;
        try { output.send(HS_QUERY); await sleep(probeMs); } catch (e) { this.log('Identity query failed: ' + e.message); }
        querying = null;
      }
    } finally { for (const [input, receive] of listeners) input.removeEventListener('midimessage', receive); }
    if (new Set(matches.map((m) => m.input)).size > 1)
      throw new Error('More than one FM-1 answered. Connect only the one to update. Nothing was installed.');
    const m = matches.find((x) => x.input.name === x.output.name) || matches[0];
    return m ? {id: m.id, link: new Link(m.input, m.output), name: m.output.name} : null;
  }
  async waitForAny(filter, ms) {
    const end = Date.now() + ms;
    do {
      const dev = await this.findAny(filter);
      if (dev) return dev;
      await sleep(Math.max(0, Math.min(500, end - Date.now())));
    } while (Date.now() < end);
    return null;
  }
  /* answer read requests until the device asks for finishAddr ("success"). Each answer goes out
     from the message event itself. Resolves {served, finished, lost}. */
  serve(link, image, finishAddr, idleMs, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      let served = 0, last = Date.now(), done = false;
      const end = (r) => { if (done) return; done = true; clearInterval(watch); link.onSysex = null; resolve(r); };
      link.onSysex = (pkt) => {
        const r = parseRequest(pkt);
        if (!r) return false;
        last = Date.now();
        if (r.addr === STAGE_DONE || r.addr === WRITE_DONE) {
          if (!link.send(response(r.addr, [...new TextEncoder().encode('success'), 0]))) end({served, finished: false, lost: true});
          else if (r.addr === finishAddr) end({served, finished: true});
          return true;
        }
        if (r.len > MAXDATA || r.addr + r.len > image.length) {
          done = true; clearInterval(watch); link.onSysex = null;
          reject(new Error(`The FM-1 asked for bytes outside the firmware (${r.addr.toString(16)}+${r.len}). Nothing more was sent.`));
          return true;
        }
        if (!link.send(response(r.addr, Array.from(image.subarray(r.addr, r.addr + r.len)), r.fl))) { end({served, finished: false, lost: true}); return true; }
        served++;
        onProgress(r.addr + r.len, image.length);
        return true;
      };
      for (const m of link.q.splice(0)) if (!done) link.onSysex?.(m);   // requests that came before we listened
      // (only for giving up: a stretched timer here never slows the answers)
      const watch = setInterval(() => {
        if (link.lost) end({served, finished: false, lost: true});
        else if (Date.now() - last > idleMs) end({served, finished: false});
      }, 500);
    });
  }
}
