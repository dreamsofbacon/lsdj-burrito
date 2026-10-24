// SPDX-License-Identifier: GPL-3.0-only
// MIDI over Bluetooth LE for the page: the FM-1 running LSDJ Burrito with
// BLUETOOTH = DEVICE is a standard BLE-MIDI device ("LSDJ Burrito"). This
// connects to it with Web Bluetooth and gives link.js the same shape a Web MIDI
// port pair has (input.onmidimessage, output.send), so every page feature works
// over Bluetooth as over USB.
// The packet format is the MMA's BLE-MIDI 1.0, as firmware/lsdj_blemidi.h:
//   a header byte 10tttttt, then messages each after a timestamp byte 1ttttttt;
//   a SysEx may span packets (a continuation is the header, then data bytes);
//   its F7 comes after a timestamp byte. Real-time bytes may sit anywhere.

export const BLE_MIDI_SERVICE = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
export const BLE_MIDI_IO = '7772e5db-3868-4112-a1a9-f2669d106bf3';
export const SX_MAX = 320;   // as the firmware's LSDJ_BM_SX_MAX

const need = st => st < 0xF0 ? ((st & 0xF0) === 0xC0 || (st & 0xF0) === 0xD0 ? 1 : 2)
  : st === 0xF1 || st === 0xF3 ? 1 : st === 0xF2 ? 2 : 0;

/* In: packets -> whole messages. onMessage(Uint8Array): short and real-time
   messages as they are, a SysEx with its F0 and F7. */
export class BleMidiRx {
  constructor(onMessage) { this.onMessage = onMessage; this.reset(); }
  reset() { this.running = 0; this.msg = []; this.need = 0; this.inSx = false; this.sx = []; this.over = false; this.bad = 0; }
  #status(b) {
    if (b >= 0xF8) { this.onMessage(Uint8Array.of(b)); return; }
    if (b === 0xF0) { this.inSx = true; this.sx = []; this.over = false; this.running = 0; this.need = 0; this.msg = []; return; }
    if (b === 0xF7) return;
    this.inSx = false;
    this.msg = [b]; this.need = need(b); this.running = b < 0xF0 ? b : 0;
    if (!this.need) { this.onMessage(Uint8Array.of(b)); this.running = 0; }
  }
  #data(b) {
    if (!this.need) {
      if (!this.running) { this.bad++; return; }
      this.msg = [this.running]; this.need = need(this.running);
    }
    this.msg.push(b);
    if (this.msg.length === 1 + this.need) { this.onMessage(Uint8Array.from(this.msg)); this.need = 0; this.msg = []; }
  }
  #sxByte(b) { if (this.sx.length < SX_MAX) this.sx.push(b); else this.over = true; }
  packet(p) {
    if (p.length < 2 || (p[0] & 0xC0) !== 0x80) { this.bad++; return; }
    let i = 1;
    if (this.inSx) { while (i < p.length && !(p[i] & 0x80)) this.#sxByte(p[i++]); }
    else if (!(p[1] & 0x80)) { this.bad++; return; }
    while (i < p.length) {
      if (!(p[i] & 0x80)) { this.bad++; return; }   // a timestamp
      i++;
      if (i >= p.length) { this.bad++; return; }
      const b = p[i];
      if (this.inSx) {
        if (b === 0xF7) {
          this.inSx = false; i++;
          if (!this.over) this.onMessage(Uint8Array.from([0xF0, ...this.sx, 0xF7]));
          continue;
        }
        if (b >= 0xF8) { this.onMessage(Uint8Array.of(b)); i++; while (i < p.length && !(p[i] & 0x80)) this.#sxByte(p[i++]); continue; }
        this.inSx = false;                              // another status: the SysEx was cut
      }
      if (b & 0x80) { this.#status(b); i++; }
      if (this.inSx) { while (i < p.length && !(p[i] & 0x80)) this.#sxByte(p[i++]); continue; }
      while (i < p.length && !(p[i] & 0x80)) this.#data(p[i++]);
    }
  }
}

/* Out: whole messages -> packets of at most max bytes (the ATT MTU - 3), as
   the firmware's lsdj_bm_tx_packet makes them. */
export function blePackets(messages, max, tsMs = 0) {
  if (max < 5) throw new Error('BLE-MIDI packets need at least 5 bytes');
  const th = 0x80 | ((tsMs >> 7) & 0x3F), tl = 0x80 | (tsMs & 0x7F);
  const q = messages.flatMap(m => Array.from(m));
  const out = []; let pkt = [th], inSx = false, k = 0;
  const flush = () => { if (pkt.length > 1) out.push(Uint8Array.from(pkt)); pkt = [th]; };
  while (k < q.length) {
    const b = q[k], room = max - pkt.length;
    if (inSx) {
      if (b === 0xF7) { if (room < 2) { flush(); continue; } pkt.push(tl, 0xF7); k++; inSx = false; continue; }
      if (room < 1) { flush(); continue; }
      pkt.push(b); k++; continue;
    }
    if (b === 0xF0) { if (room < 3) { flush(); continue; } pkt.push(tl, 0xF0); k++; inSx = true; continue; }
    const len = 1 + (b & 0x80 ? need(b) : 0);
    if (room < 1 + len) { flush(); continue; }
    pkt.push(tl, ...q.slice(k, k + len)); k += len;
  }
  flush();
  return out;
}

/* Connect: the browser's device chooser lists BLE-MIDI devices. Resolves
   {input, output, name, close()} for link.js; ondisconnected(cb) for a lost link. */
export async function connectBleMidi() {
  if (!navigator.bluetooth) throw new Error('This browser has no Web Bluetooth. Use Chrome or Edge (not on iPhone / iPad).');
  const device = await navigator.bluetooth.requestDevice({filters: [{services: [BLE_MIDI_SERVICE]}]});
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(BLE_MIDI_SERVICE);
  const io = await service.getCharacteristic(BLE_MIDI_IO);
  const input = {onmidimessage: null};
  const rx = new BleMidiRx(m => input.onmidimessage?.({data: m}));
  io.addEventListener('characteristicvaluechanged', e => rx.packet(new Uint8Array(e.target.value.buffer)));
  await io.startNotifications();
  // Writes: the largest packet the link takes. The ATT MTU is not visible from
  // here, so start large and drop to the minimum (20) on the first refusal.
  let max = 180, chain = Promise.resolve(), lost = null;
  const write = async pkt => {
    try { await io.writeValueWithoutResponse(pkt); }
    catch (err) {
      if (max === 20 || !device.gatt.connected) throw err;
      max = 20; throw Object.assign(new Error('retry'), {retry: true});   // (the firmware restarts a resent SysEx at its F0)
    }
  };
  const output = {
    send(bytes) {
      const msg = Uint8Array.from(bytes);
      chain = chain.then(async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try { for (const p of blePackets([msg], max, performance.now() | 0)) await write(p); return; }
          catch (err) { if (!err.retry) throw err; }   // sent again in smaller packets
        }
      }).catch(err => { lost?.(err); });
    }
  };
  return {
    input, output, name: device.name || 'LSDJ Burrito',
    ondisconnected(cb) { lost = cb; device.addEventListener('gattserverdisconnected', () => cb(new Error('Bluetooth disconnected'))); },
    close() { try { device.gatt.disconnect(); } catch {} }
  };
}
