// SPDX-License-Identifier: GPL-3.0-only
// lsdj/lsdj-kit.js: .kit files in and out, rename, clear, checksums, kits built from sounds (node tests/lsdj-kit.mjs).
// A made-up ROM only. With a ROM path: also takes each of its kits apart and builds it again (a local check).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BANK, kitSlots, parseKit, kitFile, putKit, clearKit, renameKit, fixChecksums, sampleNibbles, buildKit, kitSampleNibbles,
  KitError, MAX_SAMPLE_SPACE} from '../lsdj/lsdj-kit.js';

const checksumsOk = rom => {
  let h = 0; for (let i = 0x134; i < 0x14d; i++) h = (h - rom[i] - 1) & 0xff;
  let g = 0; for (let i = 0; i < rom.length; i++) if (i !== 0x14e && i !== 0x14f) g = (g + rom[i]) & 0xffff;
  return rom[0x14d] === h && (rom[0x14e] << 8 | rom[0x14f]) === g;
};

/* sounds -> 4-bit: normalised to the full range, silence trimmed, whole frames, padded with the middle value */
{
  const pcm = new Float32Array(1000);
  for (let i = 100; i < 600; i++) pcm[i] = 0.25 * Math.sin(i / 5);
  const v = sampleNibbles(pcm, {dither: false});
  assert.equal(v.length % 32, 0); assert.ok(v.length >= 480 && v.length <= 544);
  assert.equal(Math.max(...v), 15); assert.equal(Math.min(...v), 0);
  assert.equal(v.at(-1), 8);
  assert.equal(sampleNibbles(pcm, {dither: false, trim: 2}).length, v.length - 64);
  assert.equal(sampleNibbles(new Float32Array(10), {dither: false}).length, 32);       /* silence: one frame */
  const quiet = sampleNibbles(pcm, {dither: false, volumeDb: -12});
  assert.ok(Math.max(...quiet) <= 10 && Math.min(...quiet) >= 5);
  let r = 0; const noisy = sampleNibbles(pcm, {random: () => (r = (r * 9301 + 49297) % 233280) / 233280});
  assert.equal(noisy.length, v.length); assert.ok(noisy.some((x, i) => x !== v[i]));
}

/* a kit built and read back: pointers, names, name, version byte, polarity and rotation undone */
const ramp = n => Uint8Array.from({length: n}, (_, i) => i % 16);
{
  const samples = [{name: 'kick', nibbles: ramp(64)}, {name: 'SN', nibbles: ramp(32).reverse()}];
  for (const rotate of [true, false]) {
    const bank = buildKit({name: 'my kit!', samples, rotate});
    const k = parseKit(bank);
    assert.equal(k.name, 'MY KIT');
    assert.deepEqual(k.samples.map(s => [s.index, s.name, s.bytes]), [[0, 'KIC', 32], [1, 'SN-', 16]]);
    assert.equal(bank[0x5f], rotate ? 1 : 0);
    assert.deepEqual([...bank.subarray(0x22 + 6, 0x22 + 9)], [0, 0x2d, 0x2d]);
    assert.deepEqual(kitSampleNibbles(bank, 0), samples[0].nibbles);
    assert.deepEqual(kitSampleNibbles(bank, 1), samples[1].nibbles);
    assert.equal(bank[0x60] >> 4, 15 - (rotate ? samples[0].nibbles[31] : samples[0].nibbles[0]));
  }
  assert.throws(() => buildKit({name: 'X', samples: [{name: 'A', nibbles: new Uint8Array(MAX_SAMPLE_SPACE * 2 + 64)}]}), KitError);
  assert.throws(() => buildKit({name: 'X', samples: Array.from({length: 16}, () => ({name: 'A', nibbles: ramp(32)}))}), KitError);
  assert.throws(() => buildKit({name: 'X', samples: [{name: 'A', nibbles: ramp(30)}]}), KitError);
  assert.equal(parseKit(buildKit({name: 'FULL', samples: [{name: 'A', nibbles: new Uint8Array(MAX_SAMPLE_SPACE * 2)}]})).free, 0);
}

/* a ROM: code 0-7, kit 8, code 9, empty slot A */
const rom = new Uint8Array(12 * BANK);
rom.fill(0x22, 0, 8 * BANK); rom.fill(0x33, 9 * BANK, 10 * BANK); rom.fill(0xff, 10 * BANK, 11 * BANK); rom.fill(0x44, 11 * BANK);
rom.set(buildKit({name: 'DRUMS', samples: [{name: 'BD', nibbles: ramp(64)}]}), 8 * BANK);
fixChecksums(rom);
const before = rom.slice();
{
  const file = kitFile(rom, 8);
  assert.equal(file.length, BANK); assert.equal(parseKit(file).name, 'DRUMS');
  assert.throws(() => kitFile(rom, 10), /empty/);
  const added = putKit(rom, 10, file);                         /* into the empty slot */
  assert.deepEqual(kitSlots(added).map(s => [s.bank, s.empty]), [[8, false], [10, false]]);
  assert.ok(checksumsOk(added)); assert.deepEqual(rom, before);    /* the original untouched */
  assert.throws(() => putKit(rom, 9, file), /not a kit slot/);  /* never over LSDj's code */
  assert.throws(() => putKit(rom, 0, file), /not a kit slot/);
  assert.throws(() => putKit(rom, 10, new Uint8Array(BANK)), /not an LSDj .kit/);
  const renamed = renameKit(rom, 8, 'beats');
  assert.equal(parseKit(renamed.subarray(8 * BANK, 9 * BANK)).name, 'BEATS'); assert.ok(checksumsOk(renamed));
  const cleared = clearKit(rom, 8);
  assert.deepEqual(kitSlots(cleared).map(s => [s.bank, s.empty]), [[8, true], [10, true]]);   /* still numbered the same */
  assert.ok(checksumsOk(cleared));
}

/* local only: every kit of a real ROM, taken apart and built again, gives the same sample bytes */
if (process.argv[2]) {
  const real = new Uint8Array(readFileSync(process.argv[2]));
  let n = 0;
  for (const s of kitSlots(real)) {
    if (s.empty) continue;
    const bank = real.subarray(s.bank * BANK, (s.bank + 1) * BANK);
    if (bank[0x5f] !== 1) continue;
    const samples = s.kit.samples.map(x => ({name: x.name, nibbles: kitSampleNibbles(bank, x.index)}));
    if (s.kit.samples.some((x, i) => x.index !== i)) continue;
    const again = buildKit({name: s.kit.name, samples});
    const end = 0x60 + s.kit.used;
    assert.deepEqual(again.subarray(0, 0x22), bank.subarray(0, 0x22), s.kit.name);
    assert.deepEqual(again.subarray(0x60, end), bank.subarray(0x60, end), s.kit.name);
    n++;
  }
  console.log(`  ${n} kits of ${process.argv[2]} rebuilt byte for byte`);
}

console.log('PASS lsdj-kit: sounds to 4-bit (normalise, trim, frames, volume, dither), kits built and read back (rotation, polarity, names, limits), .kit in/out, rename, clear, code banks refused, checksums');
