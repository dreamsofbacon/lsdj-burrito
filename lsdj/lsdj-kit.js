// SPDX-License-Identifier: GPL-3.0-only
// LSDj sample kits in the user's own ROM (in the browser only). Pure: no DOM.
// A kit bank (16 KiB, as LSDPatcher writes it): 60 40, then 16 little-endian pointers (sample 0 starts at
// 0x4060; pointer k+1 is where sample k ends; 0 = no sample), 15 x 3-character sample names at 0x22, the
// kit name at 0x52 (6), 0x5F = 1 when the sample frames are rotated for LSDj 9.2.0+, sample data from 0x60.
// An empty kit slot is a bank of FF. LSDj numbers kits by counting the kit and empty banks in ROM order
// (checked in LSDj 9.3.9: kit 0x11 = bank 19, kit 0x28 = bank 35), 6 bits: instrument byte 2 = KIT1,
// byte 9 = KIT2 (bit 6 of byte 2: half speed).
export const BANK = 0x4000;
export const MAX_SAMPLES = 15;
export const MAX_SAMPLE_SPACE = 0x3fa0;
export const isKitBank = b => b[0] === 0x60 && b[1] === 0x40;
export const isEmptyKitBank = b => b[0] === 0xff && b[1] === 0xff;
const text = (bytes) => String.fromCharCode(...bytes).replace(/[^\x20-\x7e]/g, ' ').trimEnd();

/* A kit bank -> {name, samples: [{index, name, bytes}], used, free}. */
export function parseKit(bank) {
  if (!isKitBank(bank)) return null;
  const word = k => bank[2 * k] | bank[2 * k + 1] << 8;
  const samples = [];
  let used = 0;
  for (let k = 0; k < MAX_SAMPLES; k++) {
    const start = word(k), end = word(k + 1);
    if (!start || !end || end <= start || end > 0x8000) continue;
    samples.push({index: k, name: text(bank.subarray(0x22 + 3 * k, 0x25 + 3 * k)), bytes: end - start});
    used = Math.max(used, end - 0x4060);
  }
  return {name: text(bank.subarray(0x52, 0x58)), samples, used, free: MAX_SAMPLE_SPACE - used};
}

/* Every kit slot of a ROM, in LSDj's numbering: [{number, bank, empty, kit}] (kit: parseKit, null if empty). */
export function kitSlots(rom) {
  const slots = [];
  for (let b = 1; b < rom.length / BANK; b++) {
    const bank = rom.subarray(b * BANK, (b + 1) * BANK);
    if (isKitBank(bank)) slots.push({number: slots.length, bank: b, empty: false, kit: parseKit(bank)});
    else if (isEmptyKitBank(bank)) slots.push({number: slots.length, bank: b, empty: true, kit: null});
  }
  return slots;
}

/* ---- changing kits in the user's ROM (always a copy: the original is never changed) ---- */
export class KitError extends Error {}
/* LSDj's name characters: A-Z, 0-9, space and - (as LSDj's own kits use) */
const nameOf = (t, n, pad = ' ') => [...String(t).toUpperCase().replace(/[^A-Z0-9 -]/g, '').slice(0, n).padEnd(n, pad)].map(c => c.charCodeAt(0));
/* the Game Boy header checksum (0x14D) and global checksum (0x14E, big-endian) */
export function fixChecksums(rom) {
  let h = 0;
  for (let i = 0x134; i < 0x14d; i++) h = (h - rom[i] - 1) & 0xff;
  rom[0x14d] = h;
  let g = 0;
  for (let i = 0; i < rom.length; i++) if (i !== 0x14e && i !== 0x14f) g = (g + rom[i]) & 0xffff;
  rom[0x14e] = g >> 8; rom[0x14f] = g & 0xff;
  return rom;
}
const slotAt = (rom, bank) => {
  const s = kitSlots(rom).find(x => x.bank === bank);
  if (!s) throw new KitError(`Bank ${bank.toString(16).toUpperCase()} is not a kit slot (LSDj's own code is there).`);
  return s;
};
const change = (rom, bank, f) => { slotAt(rom, bank); const out = rom.slice(); f(out.subarray(bank * BANK, (bank + 1) * BANK)); return fixChecksums(out); };
/* a kit as a .kit file (the 16 KiB bank, as LSDPatcher saves it) */
export function kitFile(rom, bank) {
  if (slotAt(rom, bank).empty) throw new KitError('This kit slot is empty.');
  return rom.slice(bank * BANK, (bank + 1) * BANK);
}
/* a .kit file into a kit slot (a kit already there is replaced) -> a new ROM */
export function putKit(rom, bank, file) {
  if (!(file instanceof Uint8Array) || file.length < BANK || !isKitBank(file)) throw new KitError('This is not an LSDj .kit file.');
  return change(rom, bank, b => b.set(file.subarray(0, BANK)));
}
export const clearKit = (rom, bank) => change(rom, bank, b => b.fill(0xff));
export function renameKit(rom, bank, name) {
  if (slotAt(rom, bank).empty) throw new KitError('This kit slot is empty.');
  return change(rom, bank, b => b.set(nameOf(name, 6), 0x52));
}

/* ---- a kit from the user's own sounds ----
   pcm: Float32Array, mono, -1..1, at 11468 Hz (5734 for half speed; wav-kit.js decodes and resamples).
   As LSDPatcher: DC removed, peak normalised (then volumeDb), silence trimmed at both ends, trim = 32-sample
   frames off the end, optional dither (TPDF, one 4-bit step) -> 4-bit values 0..15 in whole 32-sample frames
   (the last frame padded with silence). */
export const SAMPLE_RATE = 11468;
const SILENCE = 1 / 16;
export function sampleNibbles(pcm, {volumeDb = 0, trim = 0, dither = true, random = Math.random} = {}) {
  const n = pcm.length;
  let mean = 0, peak = 0;
  for (let i = 0; i < n; i++) mean += pcm[i];
  mean = n ? mean / n : 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(pcm[i] - mean));
  const gain = (peak ? 1 / peak : 0) * 10 ** (volumeDb / 20);
  const x = Float32Array.from(pcm, v => (v - mean) * gain);
  let head = 0, tail = n;
  while (head < tail && Math.abs(x[head]) < SILENCE) head++;
  while (tail > head && Math.abs(x[tail - 1]) < SILENCE) tail--;
  tail = Math.max(head, tail - trim * 32);
  const len = Math.max(32, Math.ceil((tail - head) / 32) * 32);
  const out = new Uint8Array(len).fill(8);
  for (let i = 0; head + i < tail; i++) {
    const d = dither ? (random() - random()) / 7.5 : 0;
    out[i] = Math.min(15, Math.max(0, Math.round(Math.max(-1, Math.min(1, x[head + i] + d)) * 7.5 + 7.5)));
  }
  return out;
}
/* {name, samples: [{name, nibbles}]} -> a 16 KiB kit bank. rotate: for LSDj 9.2.0 and later (each 32-sample
   frame rotated by one, version byte 1). DMG polarity (15 - value), high nibble first, as LSDPatcher.
   Throws KitError when it doesn't fit. */
export function buildKit({name, samples, rotate = true}) {
  if (samples.length > MAX_SAMPLES) throw new KitError(`A kit holds at most ${MAX_SAMPLES} samples.`);
  const bytes = samples.reduce((t, s) => t + s.nibbles.length / 2, 0);
  if (bytes > MAX_SAMPLE_SPACE) throw new KitError(`The samples need ${bytes} bytes; a kit holds ${MAX_SAMPLE_SPACE}. Shorten or remove some.`);
  const b = new Uint8Array(BANK).fill(0xff);
  b[0] = 0x60; b[1] = 0x40;
  b.fill(0, 2, 0x22);
  let at = 0x60;
  samples.forEach((s, k) => {
    const v = s.nibbles;
    if (!v.length || v.length % 32) throw new KitError('A sample is a whole number of 32-sample frames.');
    const pos = (f, p) => rotate ? v[f + (p + 31) % 32] : v[f + p];   /* rotated: place p holds sample p - 1 */
    for (let f = 0; f < v.length; f += 32)
      for (let p = 0; p < 32; p += 2) b[at + (f + p) / 2] = (15 - pos(f, p)) << 4 | (15 - pos(f, p + 1));
    at += v.length / 2;
    const end = 0x4000 + at;
    b[2 * (k + 1)] = end & 0xff; b[2 * (k + 1) + 1] = end >> 8;
  });
  for (let k = 0; k < MAX_SAMPLES; k++) b.set(k < samples.length ? nameOf(samples[k].name, 3, '-') : [0, 0x2d, 0x2d], 0x22 + 3 * k);
  b.fill(0, 0x4f, 0x52);
  b.set(nameOf(name, 6), 0x52);
  b.fill(0, 0x58, 0x5f);
  b[0x5f] = rotate ? 1 : 0;
  return b;
}
/* a kit's sample back as 4-bit values (to play it on the page): undoes polarity and rotation */
export function kitSampleNibbles(bank, index) {
  const word = k => bank[2 * k] | bank[2 * k + 1] << 8;
  const start = word(index) - 0x4000, end = word(index + 1) - 0x4000, rotated = bank[0x5f] === 1;
  const out = new Uint8Array((end - start) * 2);
  for (let i = 0; i < out.length; i++) out[i] = 15 - (i & 1 ? bank[start + (i >> 1)] & 15 : bank[start + (i >> 1)] >> 4);
  if (!rotated) return out;
  const r = new Uint8Array(out.length);
  for (let f = 0; f < out.length; f += 32) for (let p = 0; p < 32; p++) r[f + (p + 31) % 32] = out[f + p];
  return r;
}
