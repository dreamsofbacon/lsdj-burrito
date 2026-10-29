// SPDX-License-Identifier: GPL-3.0-only
// lsdj/zip.js: "Export all" holds each file whole, by name, with its CRC; read back here (and,
// with python3 on the path, by Python's zipfile too).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {zipStore, crc32} from '../lsdj/zip.js';

assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
const files = [
  {name: 'lsdj.sav', bytes: Uint8Array.from({length: 131072}, (_, i) => (i * 31 + 7) & 255)},
  {name: 'lsdj-installed.gb', bytes: Uint8Array.from({length: 65536}, (_, i) => i & 255)},
  {name: 'lsdj-burrito-effects.json', bytes: new TextEncoder().encode('{"format":"lsdj-burrito-fx"}')}];
const zip = zipStore(files, new Date(2026, 9, 28, 12, 30, 10));
const v = new DataView(zip.buffer), dec = new TextDecoder();
/* the end record, then the central directory, then each local header and its data */
const end = zip.length - 22;
assert.equal(v.getUint32(end, true), 0x06054B50);
assert.equal(v.getUint16(end + 10, true), 3);
let at = v.getUint32(end + 16, true);
for (const f of files) {
  assert.equal(v.getUint32(at, true), 0x02014B50);
  const n = v.getUint16(at + 28, true), local = v.getUint32(at + 42, true);
  assert.equal(dec.decode(zip.subarray(at + 46, at + 46 + n)), f.name);
  assert.equal(v.getUint32(at + 16, true), crc32(f.bytes));
  assert.equal(v.getUint32(local, true), 0x04034B50);
  assert.equal(v.getUint16(local + 8, true), 0);                     // stored
  const ln = v.getUint16(local + 26, true), size = v.getUint32(local + 18, true);
  assert.deepEqual(zip.subarray(local + 30 + ln, local + 30 + ln + size), f.bytes);
  at += 46 + n;
}
try {
  const dir = mkdtempSync(join(tmpdir(), 'zip-')), path = join(dir, 'all.zip');
  writeFileSync(path, zip);
  const out = execFileSync('python3', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(" ".join(z.namelist()))', path]).toString().trim();
  assert.equal(out, files.map(f => f.name).join(' '));
  rmSync(dir, {recursive: true});
} catch (e) { if (e.code !== 'ENOENT') throw e; console.log('(no python3: skipped the zipfile check)'); }
console.log('PASS zip: three files stored whole, names, CRCs, directory; Python reads it');
