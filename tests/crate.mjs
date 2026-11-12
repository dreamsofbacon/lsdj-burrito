// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import {fileKind, loadItems, saveItems, addItem, removeItem, renameItem, pairItems, unusedSaves, describe, recolorItem, moveItem, viewItems} from '../lsdj/crate.js';
import {SAV_SIZE, SONG_SIZE, BLOCK_COUNT, buildSav, parseSav, songBytes, withOpenSong} from '../lsdj/lsdj-sav.js';
import {BANK, crc32} from '../lsdj/lsdj-rom.js';

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
{ /* a save with an emulator's / flash cart's 16-byte clock footer: still a save, read as its first 128 KiB */
  const withFooter = new Uint8Array(SAV_SIZE + 16); withFooter.set(sav); withFooter.set([0x5e, 0x1a, 0x3b, 0x67, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255], SAV_SIZE);
  assert.equal(fileKind(withFooter), 'sav');
  const p = parseSav(withFooter);
  assert.equal(p.bytes.length, SAV_SIZE); assert.deepEqual(p.songs.map(x => x.name), ['BEATS']);
  assert.equal(fileKind(new Uint8Array(SAV_SIZE + 17)), null, 'other sizes: not a save');
}
{ /* LSDj 3.1.5 to 4.1.0 name themselves "LSDJ": still an LSDj ROM */
  const old = rom.slice(); old.fill(0, 0x134, 0x144); old.set(new TextEncoder().encode('LSDJ'), 0x134);
  let s = 0; for (let i = 0x134; i < 0x14d; i++) s = (s - old[i] - 1) & 255; old[0x14d] = s;
  assert.equal(fileKind(old), 'rom');
  const not = rom.slice(); not.set(new TextEncoder().encode('GBMOD      '), 0x134);
  let t = 0; for (let i = 0x134; i < 0x14d; i++) t = (t - not[i] - 1) & 255; not[0x14d] = t;
  assert.equal(fileKind(not), null, 'another program: not LSDj');
}

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
{
  const t = describe({rom: R, sav: S}, id => lib[id]);
  assert.deepEqual([t.kinds, t.songs, t.open, t.version, t.missing, t.kits], [['LSDj', '.sav'], ['BEATS'], 0, '9.3.9', false, []]);
  assert.deepEqual(t.songList, [{slot: 0, name: 'BEATS', blocks: 1}]);
  assert.equal(t.free, BLOCK_COUNT - 1);
  assert.equal(t.crc, crc32(sav), 'the save\'s checksum, as the FM-1 reports it (the deck badge)');
}
assert.equal(describe({sav: S2}, id => lib[id]).missing, true);

/* colours, your own order, search and sort */
{
  let list = ['Opener', 'closer', 'Breakdown'].reduce((l, n, k) => addItem(l, {name: n, sav: String(k).repeat(64).slice(0, 64).replace(/./g, 'abc'[k])}), []);
  list = list.map((it, k) => ({...it, added: 100 + k}));
  assert.ok(list.every(i => i.color === 'grey'));
  list = recolorItem(list, list[1].id, 'teal');
  assert.equal(list[1].color, 'teal');
  assert.equal(recolorItem(list, list[1].id, 'plaid')[1].color, 'grey', 'only known colours');
  assert.equal(loadItems(saveItems(list))[1].color, 'teal', 'kept');
  assert.deepEqual(moveItem(list, list[2].id, 0).map(i => i.name), ['Breakdown', 'Opener', 'closer']);
  assert.deepEqual(moveItem(list, list[0].id, 9).map(i => i.name), ['closer', 'Breakdown', 'Opener']);
  assert.deepEqual(viewItems(list, {sort: 'name'}).map(i => i.name), ['Breakdown', 'closer', 'Opener']);
  assert.deepEqual(viewItems(list, {sort: 'newest'}).map(i => i.name), ['Breakdown', 'closer', 'Opener']);
  assert.deepEqual(viewItems(list, {query: 'OPEN'}).map(i => i.name), ['Opener']);
  assert.deepEqual(viewItems(list, {query: 'acid'}, i => i.name === 'closer' ? 'ACIDLINE' : '').map(i => i.name), ['closer'], 'by a song\'s name');
  assert.deepEqual(viewItems(list).map(i => i.name), ['Opener', 'closer', 'Breakdown'], 'your order');
}

/* straight into a chosen song: that song in the working area, opened; the saved songs untouched */
{
  const song = n => new Uint8Array(SONG_SIZE).map((_, k) => (k * n + n) & 0x7f);
  const two = buildSav(sav, song(9), [{slot: 0, name: 'ONE', song: song(3)}, {slot: 1, name: 'TWO', song: song(5)}], 0);
  const opened = withOpenSong(two, 1), p = parseSav(opened);
  assert.equal(p.active, 1);
  assert.deepEqual(opened.subarray(0, SONG_SIZE), song(5), 'TWO in the working area');
  assert.deepEqual(opened.subarray(SONG_SIZE), two.subarray(SONG_SIZE).map((b, k) => k === 0x140 ? 1 : b), 'nothing else changed but the open slot');
  assert.deepEqual(songBytes(p, 0), song(3));
  assert.throws(() => withOpenSong(two, 7), /No song in slot 7/);
}
console.log('crate: PASS (file kinds (a save with a 16-byte footer, LSDJ 3.x-4.1), items, pairing, saved list, card text, colours, your order, search and sort, a chosen song opened)');
