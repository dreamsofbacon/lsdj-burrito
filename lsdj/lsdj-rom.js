// SPDX-License-Identifier: GPL-3.0-only
// The user's own LSDj ROM, handled entirely in the browser: identify it, list
// its kits, drop unused banks and build the firmware ROM slot (src/lsdj_slot.h).
import {sha256hex} from '../vendor/fm1pkg.js?v=20261013';

export const BANK = 16384;
export const SLOT_HEADER = 256;
export const SLOT_MAX_BANKS = 128;

export function crc32(bytes, crc = 0) {
  crc = ~crc >>> 0;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

const title = rom => String.fromCharCode(...rom.subarray(0x134, 0x143)).replace(/\0.*$/s, '');
const isKit = bank => bank[0] === 0x60 && bank[1] === 0x40;
const isEmpty = bank => bank.every(b => b === 0xff) || bank.every(b => b === 0);

// Accept tested versions directly; other LSDj builds need the user's confirmation.
export async function identifyRom(rom, versions) {
  const name = rom.length >= 0x150 ? title(rom) : '';
  if (!name.startsWith('LSDj')) throw Error('This is not an LSDj ROM.');
  const banks = rom.length / BANK;
  if (!Number.isInteger(banks) || banks < 2 || banks > SLOT_MAX_BANKS || (banks & (banks - 1)))
    throw Error('Unexpected LSDj ROM size.');
  if (![0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e].includes(rom[0x147])) throw Error('Unexpected LSDj cartridge type (expected MBC5).');
  let sum = 0; for (let i = 0x134; i < 0x14d; i++) sum = (sum - rom[i] - 1) & 255;
  if (sum !== rom[0x14d]) throw Error('LSDj ROM header checksum failed. The file may be damaged.');
  const sha256 = await sha256hex(rom), known = versions.find(v => v.sha256 === sha256);
  return {title: name, sha256, tested: !!known, version: known?.version ?? name.replace(/^LSDj-?v?/, '')};
}

export function listKits(rom) {
  const kits = [];
  for (let b = 0; b < rom.length / BANK; b++) {
    const bank = rom.subarray(b * BANK, (b + 1) * BANK);
    if (isKit(bank)) kits.push({bank: b, name: String.fromCharCode(...bank.subarray(0x52, 0x58)).replace(/[^\x20-\x7e]/g, ' ').trim()});
  }
  return kits;
}

// Same result as tools/build.py sparse_pack(), except kits are chosen by bank
// number instead of "the first n". keepKits: iterable of kit bank numbers.
export function sparsePack(rom, keepKits) {
  const keep = new Set(keepKits), count = rom.length / BANK, map = new Array(count).fill(0xff), stored = [];
  let kept = 0;
  for (let b = 0; b < count; b++) {
    const bank = rom.subarray(b * BANK, (b + 1) * BANK);
    if (isEmpty(bank)) continue;
    if (isKit(bank)) { if (!keep.has(b)) continue; kept++; }
    map[b] = stored.length; stored.push(bank);
  }
  if (map[0] !== 0) throw Error('LSDj ROM bank 0 is empty.');
  const storage = new Uint8Array(stored.length * BANK);
  stored.forEach((bank, i) => storage.set(bank, i * BANK));
  // LSDj's first-boot check sums the whole ROM as the emulator will read it
  // (absent banks read 0xFF), so the header's global checksum is recomputed.
  let total = 0;
  for (let b = 0; b < count; b++) {
    if (map[b] === 0xff) { total += 0xff * BANK; continue; }
    const s = storage.subarray(map[b] * BANK, (map[b] + 1) * BANK);
    for (let i = 0; i < BANK; i++) total += s[i];
  }
  total = (total - storage[0x14e] - storage[0x14f]) & 0xffff;
  storage[0x14e] = total >> 8; storage[0x14f] = total & 255;
  return {storage, bankMap: map, kept};
}

export const slotBytes = storedBanks => SLOT_HEADER + storedBanks * BANK;

// Build the window contents read by lsdj_slot_parse().
export function buildSlot(rom, keepKits, capacity) {
  const {storage, bankMap, kept} = sparsePack(rom, keepKits), stored = storage.length / BANK;
  if (slotBytes(stored) > capacity)
    throw Error(`Too many kits: needs ${slotBytes(stored)} bytes, the firmware slot holds ${capacity}.`);
  const slot = new Uint8Array(slotBytes(stored)), v = new DataView(slot.buffer);
  slot.set([..."LSDJSLOT"].map(c => c.charCodeAt(0)));
  v.setUint16(8, 1, true); v.setUint16(10, bankMap.length, true); v.setUint16(12, stored, true); v.setUint16(14, kept, true);
  slot.fill(0xff, 20, 20 + SLOT_MAX_BANKS); slot.set(bankMap, 20);
  slot.set(storage, SLOT_HEADER);
  v.setUint32(16, crc32(storage), true);
  v.setUint32(252, crc32(slot.subarray(0, 252)), true);
  return {slot, stored, kept};
}

// JS twin of lsdj_slot_parse(), used to re-check the packed firmware.
export function parseSlot(w, capacity) {
  const v = new DataView(w.buffer, w.byteOffset, w.byteLength);
  if (capacity < SLOT_HEADER) return {error: 'layout'};
  if (w.subarray(0, 8).every(b => b === 0xff)) return {error: 'empty'};
  if (String.fromCharCode(...w.subarray(0, 8)) !== 'LSDJSLOT' || v.getUint16(8, true) !== 1 ||
      v.getUint32(252, true) !== crc32(w.subarray(0, 252))) return {error: 'header'};
  const logical = v.getUint16(10, true), stored = v.getUint16(12, true), kits = v.getUint16(14, true);
  if (logical < 2 || logical > SLOT_MAX_BANKS || !stored || stored > logical || stored > Math.floor((capacity - SLOT_HEADER) / BANK)) return {error: 'layout'};
  const map = Array.from(w.subarray(20, 20 + SLOT_MAX_BANKS));
  if (map.some((m, b) => b >= logical ? m !== 0xff : m !== 0xff && m >= stored) || map[0] !== 0) return {error: 'layout'};
  if (v.getUint32(16, true) !== crc32(w.subarray(SLOT_HEADER, SLOT_HEADER + stored * BANK))) return {error: 'data'};
  return {logical, stored, kits, map: map.slice(0, logical)};
}
