// SPDX-License-Identifier: GPL-3.0-only
// The user's own LSDj ROM, handled entirely in the browser: identify it, list
// its kits, drop unused banks and build the firmware ROM slot (src/lsdj_slot.h).
const sha256hex = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

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
// Only erased banks can be omitted without changing what the emulator reads.
const isEmpty = bank => bank.every(b => b === 0xff);
const cursorProfile = hash => hash === 'df0dee277306cf77eb883d8ce0a85aacebd6e17e82dca50b6ad188c7d691b76d' ? 1 : 0;

export function validateRom(rom) {
  if (!(rom instanceof Uint8Array) || rom.length < 0x150 || !title(rom).startsWith('LSDj'))
    throw Error('This is not an LSDj ROM.');
  const banks = rom.length / BANK;
  if (!Number.isInteger(banks) || banks < 2 || banks > SLOT_MAX_BANKS || (banks & (banks - 1)))
    throw Error('Unexpected LSDj ROM size (32 KiB to 2 MiB, power of two required).');
  if (rom[0x148] > 6 || rom.length !== 32768 * 2 ** rom[0x148])
    throw Error('LSDj ROM size does not match its header.');
  if (rom[0x143] === 0xc0) throw Error('GBC-only ROMs are not supported.');
  if (![0x19, 0x1a, 0x1b].includes(rom[0x147]) || rom[0x149] !== 4)
    throw Error('Expected an LSDj MBC5 cartridge with 128 KiB save RAM (no rumble).');
  let sum = 0;
  for (let i = 0x134; i < 0x14d; i++) sum = (sum - rom[i] - 1) & 255;
  if (sum !== rom[0x14d]) throw Error('LSDj ROM header checksum failed. The file may be damaged.');
}

// A sample edit must not be mistaken for a different program, nor a title for proof of compatibility.
export async function programHash(rom) {
  validateRom(rom);
  const parts = [];
  for (let b = 0; b < rom.length / BANK; b++) {
    const bank = rom.slice(b * BANK, (b + 1) * BANK);
    if ((b && isKit(bank)) || isEmpty(bank)) continue;
    if (!b) bank[0x14e] = bank[0x14f] = 0;
    parts.push(Uint8Array.of(b), bank);
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { bytes.set(p, offset); offset += p.length; }
  return sha256hex(bytes);
}

// Accept tested versions directly; other LSDj builds need the user's confirmation.
export async function identifyRom(rom, versions) {
  validateRom(rom);
  const name = title(rom);
  const sha256 = await sha256hex(rom), known = versions.find(v => v.sha256 === sha256);
  const programSha256 = await programHash(rom);
  const sameProgram = versions.find(v => v.programSha256 === programSha256);
  let global = 0;
  for (let i = 0; i < rom.length; i++) if (i !== 0x14e && i !== 0x14f) global = (global + rom[i]) & 0xffff;
  return {title: name, sha256, programSha256, cursorProfile: cursorProfile(programSha256), tested: !!known, sameProgram: !!sameProgram,
    globalChecksumValid: global === (rom[0x14e] << 8 | rom[0x14f]),
    version: known?.version ?? name.replace(/^LSDj-?v?/, '')};
}

export function listKits(rom) {
  const kits = [];
  for (let b = 1; b < rom.length / BANK; b++) {
    const bank = rom.subarray(b * BANK, (b + 1) * BANK);
    if (isKit(bank)) kits.push({bank: b, name: String.fromCharCode(...bank.subarray(0x52, 0x58)).replace(/[^\x20-\x7e]/g, ' ').trim()});
  }
  return kits;
}

// Kits are chosen by logical bank number, never renumbered. Zero-filled banks
// remain required data because omitted banks read as 0xFF.
export function sparsePack(rom, keepKits) {
  validateRom(rom);
  const keep = new Set(keepKits), count = rom.length / BANK, map = new Array(count).fill(0xff), stored = [];
  const kits = new Set(listKits(rom).map(k => k.bank));
  for (const bank of keep) if (!kits.has(bank)) throw Error('Invalid sample-kit bank selection.');
  let kept = 0;
  for (let b = 0; b < count; b++) {
    const bank = rom.subarray(b * BANK, (b + 1) * BANK);
    if (isEmpty(bank)) continue;
    if (b && isKit(bank)) { if (!keep.has(b)) continue; kept++; }
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

export function planRom(rom, keepKits, capacity) {
  if (!Number.isInteger(capacity) || capacity < SLOT_HEADER + BANK || (capacity - SLOT_HEADER) % BANK)
    throw Error('Invalid firmware slot capacity.');
  const packed = sparsePack(rom, keepKits);
  const stored = packed.storage.length / BANK;
  const omitted = listKits(rom).filter(k => packed.bankMap[k.bank] === 0xff);
  return {stored, kept: packed.kept, codeBanks: stored - packed.kept, omitted,
    needed: slotBytes(stored), capacity, fits: slotBytes(stored) <= capacity};
}

// Build the window contents read by lsdj_slot_parse().
export async function buildSlot(rom, keepKits, capacity) {
  if (!Number.isInteger(capacity) || capacity < SLOT_HEADER + BANK || (capacity - SLOT_HEADER) % BANK)
    throw Error('Invalid firmware slot capacity.');
  const {storage, bankMap, kept} = sparsePack(rom, keepKits), stored = storage.length / BANK;
  if (slotBytes(stored) > capacity)
    throw Error(`Too many kits: needs ${slotBytes(stored)} bytes, the firmware slot holds ${capacity}.`);
  const slot = new Uint8Array(slotBytes(stored)), v = new DataView(slot.buffer);
  slot.set([..."LSDJSLOT"].map(c => c.charCodeAt(0)));
  v.setUint16(8, 1, true); v.setUint16(10, bankMap.length, true); v.setUint16(12, stored, true); v.setUint16(14, kept, true);
  slot.fill(0xff, 20, 20 + SLOT_MAX_BANKS); slot.set(bankMap, 20);
  slot[148] = cursorProfile(await programHash(rom));
  slot.set(storage, SLOT_HEADER);
  v.setUint32(16, crc32(storage), true);
  v.setUint32(252, crc32(slot.subarray(0, 252)), true);
  return {slot, stored, kept};
}

// JS twin of lsdj_slot_parse(), used to re-check the packed firmware.
export function parseSlot(w, capacity) {
  if (!(w instanceof Uint8Array) || !Number.isInteger(capacity) || capacity < SLOT_HEADER || w.length < SLOT_HEADER)
    return {error: 'layout'};
  const v = new DataView(w.buffer, w.byteOffset, w.byteLength);
  if (capacity < SLOT_HEADER) return {error: 'layout'};
  if (w.subarray(0, 8).every(b => b === 0xff)) return {error: 'empty'};
  if (String.fromCharCode(...w.subarray(0, 8)) !== 'LSDJSLOT' || v.getUint16(8, true) !== 1 ||
      v.getUint32(252, true) !== crc32(w.subarray(0, 252))) return {error: 'header'};
  if (w[148] > 1) return {error: 'layout'};
  const logical = v.getUint16(10, true), stored = v.getUint16(12, true), kits = v.getUint16(14, true);
  if (logical < 2 || logical > SLOT_MAX_BANKS || (logical & (logical - 1)) || !stored || kits > stored ||
      stored > logical || stored > Math.floor((capacity - SLOT_HEADER) / BANK) || w.length < slotBytes(stored))
    return {error: 'layout'};
  const map = Array.from(w.subarray(20, 20 + SLOT_MAX_BANKS));
  if (map.some((m, b) => b >= logical ? m !== 0xff : m !== 0xff && m >= stored) || map[0] !== 0) return {error: 'layout'};
  const present = map.filter(m => m !== 0xff);
  if (present.length !== stored || present.some((m, i) => m !== i)) return {error: 'layout'};
  if (v.getUint32(16, true) !== crc32(w.subarray(SLOT_HEADER, SLOT_HEADER + stored * BANK))) return {error: 'data'};
  return {logical, stored, kits, cursorProfile: w[148], map: map.slice(0, logical)};
}

// Recover exactly what the emulator can read, not sample banks previously omitted.
export function romFromSlot(slot) {
  const parsed = parseSlot(slot, slot.length);
  if (parsed.error || slot.length !== slotBytes(parsed.stored))
    throw Error('Installed cartridge failed slot integrity/layout checks. Nothing was prepared.');
  const rom = new Uint8Array(parsed.logical * BANK).fill(0xff);
  parsed.map.forEach((stored, logical) => {
    if (stored !== 0xff) rom.set(slot.subarray(SLOT_HEADER + stored * BANK, SLOT_HEADER + (stored + 1) * BANK), logical * BANK);
  });
  validateRom(rom);
  return rom;
}
