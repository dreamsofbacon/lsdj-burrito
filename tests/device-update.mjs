// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {Link, OP, CART_CHUNK, le32, rd32, crc32} from '../lsdj/link.js';
import {BANK, SLOT_HEADER, buildSlot, parseSlot, romFromSlot, listKits, planRom, programHash} from '../lsdj/lsdj-rom.js';
import {prepareLsdjFirmware} from '../lsdj/lsdj-firmware.js';

function synthetic() {
  const rom = new Uint8Array(16 * BANK).fill(255);
  rom.fill(0, 0, 2 * BANK);
  rom.set(new TextEncoder().encode('LSDj-v9.3.9'), 0x134);
  rom[0x147] = 0x1b; rom[0x148] = 3; rom[0x149] = 4;
  rom.fill(0, 0x134 + 10, 0x143);
  rom[BANK * 8] = 0x60; rom[BANK * 8 + 1] = 0x40;
  let checksum = 0;
  for (let i = 0x134; i < 0x14d; i++) checksum = (checksum - rom[i] - 1) & 255;
  rom[0x14d] = checksum;
  return rom;
}
function response(op, data, status = 0) {
  return [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(v => [v & 127, v >> 7]), 0xf7];
}
function fake(slot, mode = '') {
  const input = {}, ops = [];
  let infos = 0, dropped = false;
  const output = {send(message) {
    const op = message[4], args = [];
    for (let i = 5; i < message.length - 1; i += 2) args.push(message[i] | message[i + 1] << 7);
    ops.push(op);
    assert.ok([OP.CART_INFO, OP.CART_READ].includes(op), 'readback must never send writes');
    const send = (data, status = 0) => queueMicrotask(() => input.onmidimessage?.({data: response(op, data, status)}));
    if (mode === 'timeout') return;
    if (op === OP.CART_INFO) {
      infos++;
      if (mode === 'old') return send([], 1);
      if (mode === 'importing') return send([], 2);
      if (mode === 'short-info') return send([1]);
      const size = mode === 'oversize' ? 0xffffffff : slot.length;
      const headerCrc = rd32(slot, 252) ^ (mode === 'changed' && infos > 1 ? 1 : 0);
      return send([...le32(size), ...le32(headerCrc), ...le32(rd32(slot, 16))]);
    }
    const off = rd32(args, 0), count = Math.min(CART_CHUNK, slot.length - off);
    if (mode === 'retry' && !dropped) { dropped = true; return; }
    if (mode === 'late' && off) send([...le32(off - CART_CHUNK), ...slot.slice(off - CART_CHUNK, off)]);
    const data = [...slot.slice(off, off + count)];
    if (mode === 'short') data.pop();
    if (mode === 'corrupt' && off === 240) data[20] ^= 1;
    if (mode === 'wrong-offset') return send([...le32(off + CART_CHUNK), ...data]);
    send([...le32(off), ...data]);
  }};
  const link = new Link(input, output);
  const req = link.req.bind(link);
  link.req = (op, data, options) => req(op, data, {...options, timeout: 5});
  return {link, ops};
}
const rom = synthetic(), capacity = SLOT_HEADER + 3 * BANK;
const {slot} = await buildSlot(rom, [8], capacity);
for (const mode of ['', 'retry', 'late']) {
  const {link, ops} = fake(slot, mode), progress = [];
  const bytes = await link.exportCartridge((n, total) => progress.push([n, total]));
  assert.deepEqual(bytes, slot);
  assert.deepEqual(progress.at(-1), [slot.length, slot.length]);
  assert.equal(ops.filter(op => op === OP.CART_INFO).length, 2);
  if (mode === 'retry') assert.equal(link.retried, 1);
  link.close();
}
for (const [mode, error] of [['old', /Install FM-1_974/], ['importing', /wrong state/],
  ['short-info', /information/], ['oversize', /size/], ['short', /chunk/],
  ['corrupt', /checksum/], ['changed', /changed/], ['timeout', /did not answer/], ['wrong-offset', /did not answer/]]) {
  const {link} = fake(slot, mode);
  await assert.rejects(link.exportCartridge(), error);
  assert.equal(link.waiting, null);
  link.close();
}
{
  const {link, ops} = fake(slot);
  const controller = new AbortController();
  await assert.rejects(link.exportCartridge(() => controller.abort(), controller.signal), /cancelled/);
  assert.equal(ops.filter(op => op === OP.CART_READ).length, 1);
  link.close();
}
{
  const {link} = fake(slot, 'timeout'), controller = new AbortController();
  const pending = link.exportCartridge(() => {}, controller.signal);
  await Promise.resolve(); controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(link.waiting, null); link.close();
}
{
  const {link} = fake(slot, 'timeout');
  const pending = link.exportCartridge();
  await Promise.resolve(); link.close();
  await assert.rejects(pending, /Disconnected/);
}
{
  const input = {}, link = new Link(input, {send() { throw Error('Port disconnected'); }});
  await assert.rejects(link.exportCartridge(), /Port disconnected/);
  assert.equal(link.waiting, null); link.close();
}
const recovered = romFromSlot(slot);
assert.equal(await programHash(recovered), await programHash(rom));
assert.deepEqual((await buildSlot(recovered, [8], capacity)).slot, slot, 'all stored banks, numbers and profile preserved');
const corruptMap = slot.slice(); corruptMap[20 + 8] = 0;
new DataView(corruptMap.buffer).setUint32(252, crc32(corruptMap.subarray(0, 252)), true);
assert.throws(() => romFromSlot(corruptMap), /integrity/);
assert.throws(() => romFromSlot(slot.slice(0, -1)), /integrity/);
const metadata = JSON.parse(readFileSync(new URL('../lsdj/template.json', import.meta.url)));
const template = new Uint8Array(readFileSync(new URL('../lsdj/fm1-lsdj-template.fwsc', import.meta.url)));

async function roundTrip(original, keep) {
  const packed = await buildSlot(original, keep, metadata.cartridge_capacity);
  const {link} = fake(packed.slot);
  const read = await link.exportCartridge(); link.close();
  const reconstructed = romFromSlot(read), retained = listKits(reconstructed).map(k => k.bank);
  assert.deepEqual(retained, keep);
  assert.deepEqual((await buildSlot(reconstructed, retained, metadata.cartridge_capacity)).slot, packed.slot);
  const direct = await prepareLsdjFirmware(original, keep, template, metadata, {experimental: true});
  const update = await prepareLsdjFirmware(reconstructed, retained, template, metadata, {experimental: true});
  assert.deepEqual(update.bytes, direct.bytes, 'device-based update equals original-ROM preparation');
  assert.equal(update.info.cursorProfile, direct.info.cursorProfile);
  assert.throws(() => planRom(reconstructed, retained, 256), /capacity/);
  assert.equal(planRom(reconstructed, retained, SLOT_HEADER + BANK).fits, false, 'smaller slot cannot silently drop kits');
  return packed.slot;
}
await roundTrip(rom, [8]);

async function firmwareBridge(slot) {
  const dir = mkdtempSync(join(tmpdir(), 'lsdj-readback-')), path = join(dir, 'private-slot.bin');
  let child, lines, link;
  try {
    writeFileSync(path, slot);
    child = spawn(process.env.LSDJ_CARTRIDGE_LINK, [path], {stdio: ['pipe', 'pipe', 'pipe']});
    const exit = once(child, 'exit');
    const input = {}, errors = [];
    child.stderr.on('data', data => errors.push(data.toString()));
    lines = createInterface({input: child.stdout});
    lines.on('line', text => input.onmidimessage?.({data: text.trim().split(/\s+/).map(v => parseInt(v, 16))}));
    link = new Link(input, {send(message) { child.stdin.write(message.map(v => v.toString(16).padStart(2, '0')).join(' ') + '\n'); }});
    const received = await link.exportCartridge();
    assert.deepEqual(received, slot, 'real firmware C protocol returns byte-exact installed slot');
    link.close(); child.stdin.end();
    const [code] = await exit;
    assert.equal(code, 0, errors.join(''));
  } finally {
    link?.close(); lines?.close();
    if (child && child.exitCode === null) child.kill();
    unlinkSync(path); rmdirSync(dir);
  }
}
if (process.env.LSDJ_CARTRIDGE_LINK) await firmwareBridge(slot);
for (const path of process.argv.slice(2)) {
  const original = new Uint8Array(readFileSync(path));
  const required = planRom(original, [], metadata.cartridge_capacity).codeBanks;
  const keep = listKits(original).slice(0, (metadata.cartridge_capacity - SLOT_HEADER) / BANK - required).map(k => k.bank);
  const privateSlot = await roundTrip(original, keep);
  if (process.env.LSDJ_CARTRIDGE_LINK) await firmwareBridge(privateSlot);
  console.log('PASS local ROM: installed slot readback, kit/profile preservation, byte-identical update package');
}
console.log('PASS device update: read-only requests, old firmware, bounds, retries, stale chunks, corruption, cancellation, disconnect, capacity and real protocol bridge when supplied');
