// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import {fileKind, loadItems, saveItems, addItem, removeItem, renameItem, pairItems, unusedSaves, describe} from '../lsdj/crate.js';
import {SAV_SIZE, BLOCK_COUNT} from '../lsdj/lsdj-sav.js';
import {BANK} from '../lsdj/lsdj-rom.js';

/* a set-up save with one song "BEATS" in slot 0, and a small LSDj ROM header (no real LSDj: users bring their own) */
const sav = (() => {
  const b = new Uint8Array(SAV_SIZE); b[0x813e] = 0x6a; b[0x813f] = 0x6b; b[0x8140] = 0;
  b.fill(0xff, 0x8141, 0x8141 + BLOCK_COUNT); b[0x8141] = 0;
  b.set(new TextEncoder().encode('BEATS'), 0x8000);
  return b;
})();
const rom = (() => {
  const r = new Uint8Array(4 * BANK); r.set(new TextEncoder().encode('LSDj-v9.3.9'), 0x134);
  r[0x147] = 0x1b; r[0x148] = 1; r[0x149] = 4;
  let s = 0; for (let i = 0x134; i < 0x14d; i++) s = (s - r[i] - 1) & 255; r[0x14d] = s;
  return r;
})();
assert.equal(fileKind(sav), 'sav');
assert.equal(fileKind(rom), 'rom');
assert.equal(fileKind(new Uint8Array(SAV_SIZE)), null, 'a save LSDj never set up');
assert.equal(fileKind(new Uint8Array(100)), null);
assert.equal(fileKind('x'), null);

const R = 'a'.repeat(64), S = 'b'.repeat(64), S2 = 'c'.repeat(64);
let items = addItem([], {name: 'My LSDj', rom: R});
items = addItem(items, {name: 'Friday set', sav: S});
items = addItem(items, {name: 'again', sav: S});
assert.equal(items.length, 2, 'the same file twice is kept once');
assert.equal(addItem(items, {name: 'nothing'}), items);
const [r, s] = items;
items = pairItems(items, r.id, s.id);
assert.equal(items.length, 1);
assert.deepEqual([items[0].rom, items[0].sav, items[0].name], [R, S, 'Friday set on My LSDj']);
assert.equal(pairItems(items, items[0].id, items[0].id), items);
{ /* two saves can't pair */
  const two = addItem(addItem([], {name: 'a', sav: S}), {name: 'b', sav: S2});
  assert.equal(pairItems(two, two[0].id, two[1].id), two);
}
items = renameItem(items, items[0].id, 'Opener');
assert.equal(items[0].name, 'Opener');
const back = loadItems(saveItems(items));
assert.deepEqual(back, items);
assert.deepEqual(loadItems('nonsense'), []);
assert.deepEqual(loadItems('[{"id":"x","rom":"nothex"},{"id":"y","sav":"' + S + '","name":5}]').map(i => [i.id, i.name, i.rom]), [['y', '5', null]]);
const before = items;
items = removeItem(items, items[0].id);
assert.deepEqual(items, []);
assert.deepEqual(unusedSaves(items, before), [S], 'its save can go; the ROM stays (Sets shares it)');

const lib = {[R]: rom, [S]: sav};
assert.deepEqual(describe({rom: R, sav: S}, id => lib[id]), {kinds: ['LSDj', '.sav'], songs: ['BEATS'], open: 0, version: '9.3.9', missing: false});
assert.equal(describe({sav: S2}, id => lib[id]).missing, true);
console.log('crate: PASS (file kinds, items, pairing, saved list, card text)');
