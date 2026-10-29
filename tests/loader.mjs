import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {BANK, SLOT_HEADER, crc32, identifyRom, programHash, listKits, sparsePack, planRom, buildSlot, parseSlot} from '../lsdj/lsdj-rom.js';
import {prepareLsdjFirmware} from '../lsdj/lsdj-firmware.js';
import {checkPackage} from '../lsdj/install.js';
import {Package, crc16} from '../vendor/fm1pkg.js';
import {Updater, pack7, STAGE_DONE, WRITE_DONE} from '../vendor/fm1ota.js';

function header(rom) {
  let n = 0;
  for (let i = 0x134; i < 0x14d; i++) n = (n - rom[i] - 1) & 255;
  rom[0x14d] = n;
}
function synthetic() {
  const rom = new Uint8Array(64 * BANK).fill(255);
  rom.fill(0, 0, 2 * BANK);
  rom.fill(1, BANK, 2 * BANK);
  rom.set(new TextEncoder().encode('LSDj-v9.3.9'), 0x134);
  rom[0x147] = 0x1b; rom[0x148] = 5; rom[0x149] = 4;
  for (const b of [8, 26, 40]) {
    rom.fill(b, b * BANK, (b + 1) * BANK);
    rom[b * BANK] = 0x60; rom[b * BANK + 1] = 0x40;
  }
  header(rom);
  return rom;
}
const rom = synthetic(), original = rom.slice(), cap = SLOT_HEADER + 4 * BANK;
assert.deepEqual(listKits(rom).map(k => k.bank), [8, 26, 40]);
assert.equal(planRom(rom, [8, 26, 40], cap).fits, false);
const plan = planRom(rom, [26, 40], cap);
assert.equal(plan.fits, true); assert.deepEqual(plan.omitted.map(k => k.bank), [8]);
const packed = sparsePack(rom, [26, 40]);
assert.equal(packed.bankMap[8], 255);
assert.equal(packed.bankMap[26], 2); assert.equal(packed.bankMap[40], 3);
assert.deepEqual(packed.storage.subarray(2 * BANK, 3 * BANK), rom.subarray(26 * BANK, 27 * BANK));
assert.deepEqual(rom, original);
const zeroBank = rom.slice(); zeroBank.fill(0, 2 * BANK, 3 * BANK);
assert.notEqual(sparsePack(zeroBank, []).bankMap[2], 255);
assert.notEqual(await programHash(zeroBank), await programHash(rom));
assert.throws(() => sparsePack(rom, [1]), /selection/);
await assert.rejects(buildSlot(rom, [8, 26, 40], cap), /Too many/);
let total = 0;
for (let b = 0; b < 64; b++) for (let i = 0; i < BANK; i++) {
  if (!b && (i === 0x14e || i === 0x14f)) continue;
  total = (total + (packed.bankMap[b] === 255 ? 255 : packed.storage[packed.bankMap[b] * BANK + i])) & 65535;
}
assert.equal(total, packed.storage[0x14e] << 8 | packed.storage[0x14f]);
const {slot} = await buildSlot(rom, [26, 40], cap);
assert.equal(parseSlot(slot, cap).stored, 4);
assert.equal(parseSlot(slot, cap).cursorProfile, 0, 'a matching title alone cannot enable cursor tracking');
const badProfile = slot.slice(); badProfile[148] = 2;
new DataView(badProfile.buffer).setUint32(252, crc32(badProfile.subarray(0, 252)), true);
assert.equal(parseSlot(badProfile, cap).error, 'layout');
for (const size of [0, 8, 255, slot.length - 1]) assert.ok(parseSlot(slot.subarray(0, size), cap).error);
const corrupt = slot.slice(); corrupt[300] ^= 1; assert.equal(parseSlot(corrupt, cap).error, 'data');
const duplicate = slot.slice(); duplicate[20 + 40] = 2;
new DataView(duplicate.buffer).setUint32(252, crc32(duplicate.subarray(0, 252)), true);
assert.equal(parseSlot(duplicate, cap).error, 'layout');
const changedKit = rom.slice(); changedKit[26 * BANK + 600] ^= 1;
assert.equal(await programHash(changedKit), await programHash(rom));
const changedCode = rom.slice(); changedCode[BANK + 600] ^= 1;
assert.notEqual(await programHash(changedCode), await programHash(rom));
for (const [offset, value] of [[0x148, 4], [0x149, 3], [0x147, 0x1c], [0x143, 0xc0]]) {
  const bad = rom.slice(); bad[offset] = value; header(bad);
  await assert.rejects(identifyRom(bad, []));
}
await assert.rejects(identifyRom(new Uint8Array(40), []), /not an LSDj/);

function request(addr, len) {
  const u = [0, 0x59, 0x30, 15, 0, 0, 0, addr & 255, addr >>> 8 & 255, addr >>> 16 & 255,
    addr >>> 24, len & 255, len >>> 8 & 255, 0];
  u.push(~u.slice(6).reduce((n, b) => n + b, 0) & 255);
  return [0xf0, ...pack7(u), 0xf7];
}
const updater = new Updater({});
function link(q) { return {q, lost: false, sent: [], send(m) { this.sent.push(m); return true; }}; }
const queued = link([request(STAGE_DONE, 8)]);
assert.equal((await updater.serve(queued, new Uint8Array(1024), STAGE_DONE, 100)).finished, true);
assert.equal(queued.onSysex, null);
for (const q of [[request(WRITE_DONE, 8)], [request(0, 0)], [request(1020, 8)], [request(STAGE_DONE, 7)]]) {
  const l = link(q);
  await assert.rejects(updater.serve(l, new Uint8Array(1024), STAGE_DONE, 100));
  assert.equal(l.sent.length, 0); assert.equal(l.onSysex, null);
}
const retries = link([request(512, 512), request(0, 512), request(0, 512), request(WRITE_DONE, 8)]);
const progress = [];
assert.equal((await updater.serve(retries, new Uint8Array(1024), WRITE_DONE, 100, n => progress.push(n))).finished, true);
assert.deepEqual(progress, [1024, 1024, 1024]);

const metaPath = new URL('../lsdj/template.json', import.meta.url);
const metadata = JSON.parse(readFileSync(metaPath));
const template = new Uint8Array(readFileSync(new URL('../lsdj/fm1-lsdj-template.fwsc', import.meta.url)));
const templateBefore = template.slice();
await assert.rejects(prepareLsdjFirmware(rom, [26, 40], template, metadata), /consent/);
const result = await prepareLsdjFirmware(rom, [26, 40], template, metadata, {experimental: true});
assert.equal(checkPackage(result.bytes).product, 'FM-1_985');
await assert.rejects(prepareLsdjFirmware(rom, [], template, {...metadata, product: 'FM-1_972'}, {experimental: true}), /Unsupported/);
assert.deepEqual(template, templateBefore);
const p = new Package(result.bytes);
assert.equal(crc16(p.dec.subarray(p.appOff, p.appOff + p.app.size)), p.app.dcrc);
const loader = p.entries.find(e => e.name === 'ota.bin');
const damagedLoader = result.bytes.slice(); damagedLoader[loader.dataOff + p.skew + 10] ^= 1;
assert.throws(() => checkPackage(damagedLoader), /CRC/);
await assert.rejects(prepareLsdjFirmware(rom, [], template, {...metadata, cartridge_offset: -1}, {experimental: true}), /window/);
const badTemplate = template.slice(); badTemplate[1000] ^= 1;
await assert.rejects(prepareLsdjFirmware(rom, [], badTemplate, metadata, {experimental: true}), /integrity/);
for (const key of ['protected_app_sha256', 'loader_sha256']) {
  await assert.rejects(prepareLsdjFirmware(rom, [], template, {...metadata, [key]: '0'.repeat(64)}, {experimental: true}), /verification/);
}
const versions = JSON.parse(readFileSync(new URL('../lsdj/versions.json', import.meta.url)));
for (const file of process.argv.slice(2)) {
  const local = new Uint8Array(readFileSync(file)), kits = listKits(local);
  const info = await identifyRom(local, versions);
  if (info.tested) assert.equal(info.sameProgram, true, 'catalogue program fingerprint matches known full ROM');
  const full = planRom(local, kits.map(k => k.bank), metadata.cartridge_capacity);
  // Test explicit first-kit selection only; the UI never makes this choice for the user.
  const keep = kits.slice(0, Math.max(0, Math.floor((metadata.cartridge_capacity - SLOT_HEADER) / BANK) - full.codeBanks)).map(k => k.bank);
  if (full.codeBanks * BANK + SLOT_HEADER > metadata.cartridge_capacity) {
    await assert.rejects(prepareLsdjFirmware(local, [], template, metadata, {experimental: true}), /Deselect kits/);
    console.log('PASS oversized program refused:', (await identifyRom(local, [])).title);
    continue;
  }
  const r = await prepareLsdjFirmware(local, keep, template, metadata, {experimental: true});
  assert.equal(r.plan.kept, keep.length);
  if (info.tested && info.version === '9.3.9') {
    assert.equal(r.info.cursorProfile, 1);
    for (const selected of [[], keep]) {
      const originalSlot = await buildSlot(local, selected, metadata.cartridge_capacity);
      assert.equal(parseSlot(originalSlot.slot, metadata.cartridge_capacity).cursorProfile, 1);
    }
    const samples = local.slice();
    assert.ok(kits.length);
    samples[kits[0].bank * BANK + 600] ^= 1;
    const sampleSlot = await buildSlot(samples, keep, metadata.cartridge_capacity);
    assert.equal(parseSlot(sampleSlot.slot, metadata.cartridge_capacity).cursorProfile, 1, 'custom kits retain cursor profile');
    const program = local.slice(); program[BANK + 600] ^= 1;
    const unknownSlot = await buildSlot(program, keep, metadata.cartridge_capacity);
    assert.equal(parseSlot(unknownSlot.slot, metadata.cartridge_capacity).cursorProfile, 0, 'changed program cannot inherit a cursor profile');
  }
  console.log('PASS local package round trip:', r.info.title, 'code', r.plan.codeBanks, 'kits', keep.length, '/', kits.length);
  if (process.env.LSDJ_SLOT_SMOKE) {
    const dir = mkdtempSync(join(tmpdir(), 'lsdj-slot-')), path = join(dir, 'slot.bin');
    try {
      writeFileSync(path, (await buildSlot(local, keep, metadata.cartridge_capacity)).slot);
      const args = process.env.LSDJ_CURSOR_SAVE ? [path, process.env.LSDJ_CURSOR_SAVE] : [path];
      const smoke = spawnSync(process.env.LSDJ_SLOT_SMOKE, args, {encoding: 'utf8', timeout: 120000});
      assert.equal(smoke.status, 0, String(smoke.error || smoke.stderr));
      if (info.cursorProfile && process.env.LSDJ_CURSOR_SAVE) assert.match(smoke.stdout, /PASS cursor FX/);
      console.log(smoke.stdout.trim());
    } finally { unlinkSync(path); rmdirSync(dir); }
  }
}
console.log('PASS loader: validation, kit identity, checksum, bounds, program fingerprints, template protection, loader CRC, queued and invalid completion, retries');
