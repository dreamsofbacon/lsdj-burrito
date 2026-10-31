// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {firmwareForEmulator, loadRuntime, KEY_IDS} from '../emulator/core.js';
import {jitImports} from '../emulator/vendor/jit.js';
import {prepareLsdjFirmware} from '../lsdj/lsdj-firmware.js';
import {listKits, planRom, BANK, SLOT_HEADER} from '../lsdj/lsdj-rom.js';
import {scanControls, LAYOUTS, hitTest, LSDJ_KEYS, BUTTONS} from '../emulator/face.js';
import {readSave, writeSave, FTL_LO, FTL_N, SECTOR} from '../emulator/save-flash.js';

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

// The front: fm1-emu's panel has the FM-1's controls in order; every control of both layouts is hit where it is drawn.
{
  const ui = (await WebAssembly.instantiate(wasm, {env: {fm1_jit_compile: () => 0}})).instance.exports;
  const scan = scanControls(ui);
  assert.deepEqual(scan.keys, [...Array(27).keys()].map(k => 14 + k));
  assert.deepEqual(scan.buttons, [...Array(14).keys()]);
  assert.equal(BUTTONS[12], 'PLAY'); assert.equal(BUTTONS[9], 'SAVE');
  for (const [name, L] of Object.entries(LAYOUTS)) {
    assert.equal(Object.keys(L.ctl).length, 41, name);
    for (const [id, [x, y, w, h]] of Object.entries(L.ctl)) {
      assert.equal(hitTest(L, x + w / 2, y + h / 2), 100 + Number(id), `${name} control ${id}`);
      assert.ok(x >= 0 && y >= 0 && x + w <= L.W && y + h <= L.H, `${name} control ${id} on the body`);
    }
    for (const [i, k] of Object.entries(L.knobs)) assert.equal(hitTest(L, k.cx, k.cy), Number(i), `${name} knob ${i}`);
    assert.equal(hitTest(L, L.lcd[0] + 120, L.lcd[1] + 120), -1, `${name} screen`);
  }
  // LSDj's buttons on the keys: the keyboard shortcuts press keys that carry the same tag.
  const tagOf = {ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', KeyZ: 'B', KeyX: 'A', Enter: 'START', ShiftLeft: 'SELECT'};
  for (const [code, label] of Object.entries(tagOf)) assert.equal(LSDJ_KEYS[KEY_IDS[code] - 14], label, code);
}
// Songs in the save store: written as the firmware's store, read back; the settings records stay.
{
  const flash = new Uint8Array(FTL_LO + FTL_N * SECTOR + 4096).fill(0xFF), save = new Uint8Array(131072);
  for (let i = 0; i < save.length; i++) save[i] = (i * 7 + (i >> 9)) & 255;
  assert.equal(readSave(flash), null);
  writeSave(flash, save);
  assert.deepEqual(readSave(flash), save);
  // a settings record (as the firmware appends one) survives a new save
  const at = FTL_LO + 16 + 33 * 16, dv = new DataView(flash.buffer);
  flash.set([0x5E, 16, 0xFF, 0xFF], at); dv.setUint32(at + 4, 99, true); dv.setUint32(at + 8, 0x1234, true);
  const crc = bytes => { let c = ~0x5EED >>> 0; for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; } return ~c >>> 0; };
  dv.setUint32(at + 12, crc(flash.subarray(at, at + 12)), true);
  const other = save.map(v => v ^ 0x55);
  writeSave(flash, other);
  assert.deepEqual(readSave(flash), other);
  const kept = [...Array(255).keys()].map(i => FTL_LO + 16 + i * 16).find(o => flash[o] === 0x5E);
  assert.ok(kept && flash[kept + 1] === 16 && dv.getUint32(kept + 8, true) === 0x1234, 'MIDI record kept');
  flash[FTL_LO + SECTOR + 5] ^= 1;                    // a damaged block is not handed out
  assert.notDeepEqual(readSave(flash), other);
  assert.throws(() => writeSave(flash, new Uint8Array(100)), /131072/);
}
const template = new Uint8Array(readFileSync(new URL('../lsdj/fm1-lsdj-template.fwsc', import.meta.url)));
const seconds = Number(process.env.EMULATOR_SMOKE_SECONDS || 3);
assert.ok(Number.isInteger(seconds) && seconds >= 3 && seconds <= 30);
const input = template.slice(), checked = firmwareForEmulator(input);
input.fill(0);
assert.deepEqual(checked.bytes, template, 'emulator receives an independent firmware snapshot');

for (const path of process.argv.slice(2)) {
  let bytes = new Uint8Array(readFileSync(path)), kitsKept = "";
  if (/\.gb$/i.test(path)) {
    const meta = JSON.parse(readFileSync(new URL('../lsdj/template.json', import.meta.url)));
    const kits = listKits(bytes);
    // Explicit test fixture selection, not automatic kit removal in the user interface:
    // the first kits that fit (FM-1_991: by their real length; a stock LSDj 9.3.9 fits all 21).
    const keep = [];
    for (const k of kits) if (planRom(bytes, [...keep, k.bank], meta.cartridge_capacity).fits) keep.push(k.bank); else break;
    kitsKept = `${keep.length} of ${kits.length} kits`;
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
  console.log(`PASS actual firmware ${firmware.product}: ${frames} audio frames, ${lit} LCD pixels, input accepted, CPU not halted${kitsKept ? ", " + kitsKept : ""} (not audible/hardware validation)`);
  console.log(`Runtime: ${seconds}s, peak audio ${peak.toFixed(4)}, ${jit.regions} JIT regions, ${(jit.bytes / 1048576).toFixed(1)} MiB JIT modules, ${(x.memory.buffer.byteLength / 1048576).toFixed(1)} MiB WASM memory`);
}
console.log('PASS emulator: pinned assets, runtime integrity/errors, package rejection, immutable firmware snapshot, front controls (both layouts, LSDj tags) and the save store');
