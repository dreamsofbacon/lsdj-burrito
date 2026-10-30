// SPDX-License-Identifier: GPL-3.0-only
// For screenshots and the narrow-screen check only (local preview, mocked FM-1_979, no device):
// connects a pretend FM-1 with PU2 muted, effects on, battery on USB; shows the Effects tab.
import {OP, le32} from '../lsdj/link.js';

export async function runFxShot() {
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) throw Error('Local preview only');
  const input = {name: 'FM-1 test'};
  const b = Array(68).fill(0);
  b[36] = 5; b[37] = 2; b[38] = 1; b[42] = 0xf2; b[43] = 0x30;
  b[7 + 0] = 1; b[7 + 1] = 0x40; b[7 + 6] = 0x20;              // PU2: low-pass 40, echo send 20
  b[14 + 3] = 0x10; b[44 + 12] = 3;                             // WAV: drive, fuzz
  b[44 + 6 + 3] = 0x30; b[44 + 6 + 5] = 0;                      // PU2: LFO depth to the cutoff
  b[21 + 4] = 0x30; b[21 + 5] = 0x18;                           // NOI: crush, decimate
  b[28] = 0x40; b[29] = 0x50; b[30] = 0x60;                     // echo time, feedback, mix
  const output = {name: 'FM-1 test', send(message) {
    const op = message[4];
    const send = (data = [], status = 0) => queueMicrotask(() => input.onmidimessage?.({
      data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(x => [x & 127, x >> 7]), 0xf7]}));
    if (op === OP.INFO) { const info = Array(35).fill(0); info[0] = 1; info[34] = 1; [...'FM-1_979'].forEach((c, i) => info[1 + i] = c.charCodeAt(0)); return send(info); }
    if (op === OP.FX_GET) return send(b);
    if (op === OP.SETTINGS_GET) return send(le32(0x5a000000));
    if (op === OP.THEME_GET) return send(Array(16).fill(0));
    if (op === OP.FEAT_GET) return send(le32(0x460001CE));
    if (op === OP.MIDI_GET) return send(le32(0x4D000809));
    if (op === OP.LIVE) return send([1, 1, 140, 0, 2, 0, 0xF, ...b, 0x82]);
    return send();
  }};
  Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true,
    value: async () => ({inputs: new Map([['test', input]]), outputs: new Map([['test', output]])})});
  location.hash = '#connect';
  await document.getElementById('connect-btn').onclick();
  location.hash = '#live-sec';
  await new Promise(r => setTimeout(r, 1200));
  return `scrollWidth ${document.documentElement.scrollWidth} / innerWidth ${innerWidth}`;
}
