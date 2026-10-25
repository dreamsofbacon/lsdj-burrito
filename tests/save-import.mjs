// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {confirmSaveImport} from '../lsdj/save-file.js';
import {Link, LinkError, SAVE_SIZE, OP, CHUNK, rd32, crc32} from '../lsdj/link.js';

async function check(bytes) {
  const original = bytes.slice(), extra = bytes.length - SAVE_SIZE;
  let prompts = 0;
  const confirm = accepted => message => {
    prompts++;
    assert.match(message, /Replace the songs/);
    if (extra) {
      assert.match(message, /16 extra trailing bytes/);
      assert.match(message, /ONLY the first 131072 bytes/);
      assert.match(message, /format has not been verified/);
      assert.match(message, /original file will not be changed/);
    } else assert.doesNotMatch(message, /extra trailing bytes/);
    return accepted;
  };
  assert.equal(confirmSaveImport(bytes, 'test.sav', confirm(false)), null);
  const payload = confirmSaveImport(bytes, 'test.sav', confirm(true));
  assert.equal(prompts, 2);
  assert.equal(payload.length, SAVE_SIZE);
  assert.deepEqual(payload, original.subarray(0, SAVE_SIZE));
  assert.deepEqual(bytes, original);
  assert.notEqual(payload.buffer, bytes.buffer);

  const received = new Uint8Array(SAVE_SIZE), ops = [], progress = [];
  const fake = {
    async req(op, data = []) {
      ops.push(op);
      if (op === OP.BEGIN) {
        assert.equal(rd32(data, 0), SAVE_SIZE);
        assert.equal(rd32(data, 4), crc32(payload));
      }
      if (op === OP.CHUNK) {
        const offset = rd32(data, 0);
        assert.equal(data.length, CHUNK + 4);
        assert.ok(offset + CHUNK <= SAVE_SIZE);
        received.set(data.slice(4), offset);
      }
      return {status: 0, tries: 1};
    }
  };
  if (extra) {
    await assert.rejects(Link.prototype.importSave.call(fake, bytes), LinkError);
    assert.equal(ops.length, 0, 'transport refuses an untrimmed file without sending anything');
  }
  await Link.prototype.importSave.call(fake, payload, (n, total) => progress.push([n, total]));
  assert.deepEqual(received, original.subarray(0, SAVE_SIZE));
  assert.equal(ops[0], OP.ABORT);
  assert.equal(ops[1], OP.BEGIN);
  assert.equal(ops.at(-1), OP.COMMIT);
  assert.equal(ops.filter(op => op === OP.CHUNK).length, SAVE_SIZE / CHUNK);
  assert.deepEqual(progress.at(-1), [SAVE_SIZE, SAVE_SIZE]);
  assert.deepEqual(bytes, original);
}

const synthetic = Uint8Array.from({length: SAVE_SIZE + 16}, (_, i) => (i * 7 + (i >>> 8)) & 255);
await check(synthetic.subarray(0, SAVE_SIZE));
await check(synthetic);
const offsetBuffer = new Uint8Array(SAVE_SIZE + 32);
offsetBuffer.set(synthetic, 8);
await check(offsetBuffer.subarray(8, 8 + synthetic.length));
for (const size of [0, SAVE_SIZE - 1, SAVE_SIZE + 1, SAVE_SIZE + 15, SAVE_SIZE + 17, SAVE_SIZE * 2]) {
  assert.throws(() => confirmSaveImport(new Uint8Array(size), 'bad.sav', () => {
    assert.fail('Invalid size must be rejected before confirmation');
  }), LinkError);
}
for (const path of process.argv.slice(2)) {
  await check(new Uint8Array(readFileSync(path)));
  console.log('PASS local save: confirmed prefix import; original unchanged; exact simulated transfer');
}
console.log('PASS save imports: raw, extra-16 opt-in, cancellation, invalid lengths, view offsets, CRC and 131072-byte transfer');
