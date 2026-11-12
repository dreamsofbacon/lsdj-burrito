// SPDX-License-Identifier: GPL-3.0-only
// Made-up LSDj files for tests (no real LSDj, song or kit: users bring their own): kits of patterned sounds, an LSDj
// ROM with code banks and kit slots, songs that play kit instruments, a blank save and an .lsdprj.
import {BANK, buildKit} from '../lsdj/lsdj-kit.js';
import {writeLsdsng, SAV_SIZE} from '../lsdj/lsdj-sav.js';

/* a sound: n frames of a pattern (seed changes it) */
export const sound = (frames, seed) => Uint8Array.from({length: frames * 32}, (_, i) => (i * seed + (i >> 3)) % 16);
export const kitOf = (name, sizes, rotate, seed = 1) => buildKit({name, rotate,
  samples: sizes.map((f, i) => ({name: `${name[0]}${i}`, nibbles: sound(f, seed + i)}))});
/* an LSDj ROM: header "LSDj-vX", code banks 0-7, then kit slots (kits given, the rest empty) up to 32 banks */
export function lsdj(version, kits, slotCount = 8) {
  const rom = new Uint8Array(32 * BANK).fill(0xff);
  for (let b = 0; b < 8; b++) rom.fill(b + 1, b * BANK, (b + 1) * BANK);
  rom.fill(0x20, 0x134, 0x144);
  rom.set([...`LSDj-v${version}`].map(c => c.charCodeAt(0)), 0x134);
  rom[0x143] = 0; rom[0x147] = 0x1b; rom[0x148] = 4; rom[0x149] = 4;
  kits.forEach((k, i) => k && rom.set(k, (8 + i) * BANK));
  for (let b = 8 + slotCount; b < 32; b++) rom.fill(0x30 + b, b * BANK, (b + 1) * BANK);   /* code after the slots */
  let h = 0; for (let i = 0x134; i < 0x14d; i++) h = (h - rom[i] - 1) & 0xff; rom[0x14d] = h;
  return rom;
}
/* a song: kit instruments [{ins, k1, k2}], and on the wave channel one phrase of notes played by instrument ins0 */
export function song(instruments, notes, ins0 = instruments[0]?.ins ?? 0) {
  const s = new Uint8Array(0x8000);
  s.fill(0xff, 0x1290, 0x1290 + 1024); s.fill(0xff, 0x2080, 0x2080 + 2048); s.fill(0xff, 0x7000, 0x7000 + 0xff0);
  for (const {ins, k1, k2 = 0, type = 2} of instruments) { s[0x2040 + ins] = 1; s[0x3080 + ins * 16] = type; s[0x3082 + ins * 16] = 0x40 | k1; s[0x3089 + ins * 16] = 0x80 | k2; }
  s[0x1290 + 2] = 0; s[0x2080] = 0;
  notes.forEach((n, i) => { s[i] = n; s[0x7000 + i] = i ? 0xff : ins0; });
  return s;
}

export const blank = () => { const s = new Uint8Array(SAV_SIZE); s[0x813e] = 0x6a; s[0x813f] = 0x6b; return s; };
export const prj = (name, sng, kits) => { const l = writeLsdsng({name, version: 3, song: sng}); const out = new Uint8Array(l.length + kits.length * BANK);
  out.set(l); kits.forEach((k, i) => out.set(k, l.length + i * BANK)); return out; };

