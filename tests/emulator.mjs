// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {firmwareForEmulator, loadRuntime, KEY_IDS} from '../emulator/core.js';
import {jitImports} from '../emulator/vendor/jit.js';
import {prepareLsdjFirmware} from '../lsdj/lsdj-firmware.js';
import {listKits, planRom, BANK, SLOT_HEADER} from '../lsdj/lsdj-rom.js';

const base = new URL('../emulator/', import.meta.url);
const metadata = JSON.parse(readFileSync(new URL('upstream.json', base)));
for (const [file, hash] of Object.entries(metadata.assets)) {
  assert.equal(createHash('sha256').update(readFileSync(new URL(`vendor/${file}`, base))).digest('hex'), hash, file);
}
const wasm = readFileSync(new URL('vendor/fm1_web.wasm', base));
const fakeFetch = async url => url.pathname.endsWith('upstream.json')
  ? {ok: true, json: async () => metadata}
  : {ok: true, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)};
assert.equal((await loadRuntime(fakeFetch)).byteLength, wasm.length);
await assert.rejects(loadRuntime(async () => ({ok: false, status: 503})), /asset unavailable/);
await assert.rejects(loadRuntime(async url => url.pathname.endsWith('upstream.json')
  ? {ok: true, json: async () => metadata}
  : {ok: true, arrayBuffer: async () => new ArrayBuffer(8)}), /integrity/);
assert.throws(() => firmwareForEmulator(new Uint8Array(100)), /not a valid FM-1/);
assert.equal(KEY_IDS.KeyX, 40); assert.equal(KEY_IDS.ArrowLeft, 14);
const template = new Uint8Array(readFileSync(new URL('../lsdj/fm1-lsdj-template.fwsc', import.meta.url)));
const seconds = Number(process.env.EMULATOR_SMOKE_SECONDS || 3);
assert.ok(Number.isInteger(seconds) && seconds >= 3 && seconds <= 30);
const input = template.slice(), checked = firmwareForEmulator(input);
input.fill(0);
assert.deepEqual(checked.bytes, template, 'emulator receives an independent firmware snapshot');

for (const path of process.argv.slice(2)) {
  let bytes = new Uint8Array(readFileSync(path));
  if (/\.gb$/i.test(path)) {
    const meta = JSON.parse(readFileSync(new URL('../lsdj/template.json', import.meta.url)));
    const kits = listKits(bytes);
    const required = planRom(bytes, [], meta.cartridge_capacity).codeBanks;
    // Explicit test fixture selection, not automatic kit removal in the user interface.
    const keep = kits.slice(0, Math.floor((meta.cartridge_capacity - SLOT_HEADER) / BANK) - required).map(k => k.bank);
    bytes = (await prepareLsdjFirmware(bytes, keep, template, meta, {experimental: true})).bytes;
  }
  const firmware = firmwareForEmulator(bytes);
  let x;
  const jit = {regions: 0, bytes: 0, failed: 0, compileMs: 0, compileMaxMs: 0};
  x = (await WebAssembly.instantiate(wasm, {env: jitImports(() => x, jit)})).instance.exports;
  x.fm1_jit(1, 16); x.fm1_ahead(1024);
  const ptr = x.fm1_alloc(bytes.length);
  new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
  assert.equal(x.fm1_boot_fwsc(ptr, bytes.length, 0, 0, 240), 0);
  assert.equal(x.fm1_board(), 0);
  let frames = 0, peak = 0;
  for (let n = 0; n < seconds * 44100; n += 128) {
    frames += x.fm1_render(128, 50_000_000);
    for (const sample of new Float32Array(x.memory.buffer, x.fm1_out_l(), 128)) {
      assert.ok(Number.isFinite(sample), 'audio samples must be finite');
      peak = Math.max(peak, Math.abs(sample));
    }
  }
  const lit = new Uint16Array(x.memory.buffer, x.fm1_lcd(), 240 * 240).reduce((n, p) => n + (p !== 0), 0);
  assert.equal(x.fm1_halted(), 0, 'actual firmware CPU must not halt');
  assert.ok(frames >= 2 * 44100, `Only ${frames} audio frames`);
  assert.ok(lit >= 1000, `Only ${lit} lit LCD pixels`);
  x.fm1_key(KEY_IDS.ArrowRight, 1);
  for (let n = 0; n < 4410; n += 128) x.fm1_render(128, 50_000_000);
  x.fm1_key(KEY_IDS.ArrowRight, 0);
  assert.equal(x.fm1_halted(), 0);
  console.log(`PASS actual firmware ${firmware.product}: ${frames} audio frames, ${lit} LCD pixels, input accepted, CPU not halted (not audible/hardware validation)`);
  console.log(`Runtime: ${seconds}s, peak audio ${peak.toFixed(4)}, ${jit.regions} JIT regions, ${(jit.bytes / 1048576).toFixed(1)} MiB JIT modules, ${(x.memory.buffer.byteLength / 1048576).toFixed(1)} MiB WASM memory`);
}
console.log('PASS emulator: pinned assets, runtime integrity/errors, package rejection and immutable firmware snapshot');
