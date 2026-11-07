// SPDX-License-Identifier: GPL-3.0-only
// LSDj's songs in the emulated FM-1's flash: the firmware's save store (firmware/lsdj_ftl.h),
// 73 sectors of 4 KiB at 0x97000. A map sector lists which sector holds each of the 32 blocks of
// the 128 KiB cartridge RAM; a commit entry closes each save. Read here the same way the
// firmware's ftl_boot does, and written as a fresh store the firmware loads at boot.
export const FTL_LO = 0x97000, FTL_N = 73, SECTOR = 0x1000, BLOCKS = 32, SAVE_BYTES = BLOCKS * SECTOR;
const MAGIC = 0x4D46534C, E_DATA = 0x5A, E_COMMIT = 0xC3, E_SETTINGS = 0x5E, PER_MAP = 255;

const TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(crc, bytes) {
  crc = ~crc >>> 0;
  for (const b of bytes) crc = TABLE[(crc ^ b) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
}
const view = (flash, at, n) => new DataView(flash.buffer, flash.byteOffset + at, n);
const sector = s => FTL_LO + s * SECTOR;

/* The newest committed save (128 KiB), or null when the store has none. */
export function readSave(flash) {
  if (flash.length < FTL_LO + FTL_N * SECTOR) throw Error('The emulated flash is too small.');
  let best = -1, gen = 0;
  for (let s = 0; s < FTL_N; s++) {
    const h = view(flash, sector(s), 16);
    if (h.getUint32(0, true) !== MAGIC) continue;
    if (h.getUint32(12, true) !== crc32(0x5EED, flash.subarray(sector(s), sector(s) + 12))) continue;
    const g = h.getUint32(4, true);
    if (best < 0 || (g - gen | 0) > 0) { best = s; gen = g; }
  }
  if (best < 0) return null;
  const mapOf = new Array(BLOCKS).fill(-1), crcOf = new Uint32Array(BLOCKS);
  let pending = [];
  for (let i = 0; i < PER_MAP; i++) {
    const at = sector(best) + 16 + i * 16, raw = flash.subarray(at, at + 16);
    if (raw.every(b => b === 0xFF)) continue;
    const e = view(flash, at, 16);
    if (e.getUint32(12, true) !== crc32(0x5EED, raw.subarray(0, 12))) { pending = []; continue; }
    const type = raw[0], block = raw[1], sec = raw[2];
    if (type === E_DATA && block < BLOCKS && sec < FTL_N && pending.length < BLOCKS)
      pending.push([block, sec, e.getUint32(8, true)]);
    else if (type === E_COMMIT) { for (const [b, s, c] of pending) { mapOf[b] = s; crcOf[b] = c; } pending = []; }
  }
  const save = new Uint8Array(SAVE_BYTES);
  let loaded = 0;
  for (let b = 0; b < BLOCKS; b++) {
    if (mapOf[b] < 0) continue;
    const data = flash.subarray(sector(mapOf[b]), sector(mapOf[b]) + SECTOR);
    if (crc32(0, data) !== crcOf[b]) continue;
    save.set(data, b * SECTOR); loaded++;
  }
  return loaded ? save : null;
}

/* Replace the store with one holding `save` (128 KiB): map in sector 0, block b in sector 1+b.
   The firmware's settings, effects and MIDI records already in the store are kept. */
export function writeSave(flash, save) {
  if (!(save instanceof Uint8Array) || save.length !== SAVE_BYTES) throw Error('An LSDj save is 131072 bytes.');
  const records = keptRecords(flash);
  flash.fill(0xFF, FTL_LO, FTL_LO + FTL_N * SECTOR);
  let seq = 0, next = 0;
  const entry = (type, block, sec, dcrc) => {
    const at = sector(0) + 16 + next++ * 16, e = view(flash, at, 16);
    flash[at] = type; flash[at + 1] = block; flash[at + 2] = sec; flash[at + 3] = 0xFF;
    e.setUint32(4, ++seq, true); e.setUint32(8, dcrc >>> 0, true);
    e.setUint32(12, crc32(0x5EED, flash.subarray(at, at + 12)), true);
  };
  for (let b = 0; b < BLOCKS; b++) {
    const data = save.subarray(b * SECTOR, (b + 1) * SECTOR);
    flash.set(data, sector(1 + b));
    entry(E_DATA, b, 1 + b, crc32(0, data));
  }
  entry(E_COMMIT, 0xFF, 0xFF, 0);
  for (const [block, value] of records) entry(E_SETTINGS, block, 0xFF, value);
  const h = view(flash, sector(0), 16);
  h.setUint32(0, MAGIC, true); h.setUint32(4, 1, true); h.setUint32(8, 0xFFFFFFFF, true);
  h.setUint32(12, crc32(0x5EED, flash.subarray(sector(0), sector(0) + 12)), true);
}

/* The newest value of each settings record in the current map, as [block, value]. */
function keptRecords(flash) {
  let best = -1, gen = 0;
  for (let s = 0; s < FTL_N; s++) {
    const h = view(flash, sector(s), 16);
    if (h.getUint32(0, true) !== MAGIC || h.getUint32(12, true) !== crc32(0x5EED, flash.subarray(sector(s), sector(s) + 12))) continue;
    const g = h.getUint32(4, true);
    if (best < 0 || (g - gen | 0) > 0) { best = s; gen = g; }
  }
  const kept = new Map();
  if (best < 0) return kept;
  for (let i = 0; i < PER_MAP; i++) {
    const at = sector(best) + 16 + i * 16, raw = flash.subarray(at, at + 16);
    if (raw[0] !== E_SETTINGS) continue;
    const e = view(flash, at, 16);
    if (e.getUint32(12, true) === crc32(0x5EED, raw.subarray(0, 12))) kept.set(raw[1], e.getUint32(8, true));
  }
  return kept;
}
