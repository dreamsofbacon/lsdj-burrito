// SPDX-License-Identifier: GPL-3.0-only
// lsdj/link.js and firmware 0.9.98's DJ link (node tests/link-dj.mjs): LIVE read at every length the
// firmware has sent (11 effect words, 17, + battery, + the 0.9.98 bytes), VOLUME_SET, SEQ_SET and SONG_ROWS,
// and what older firmware (status 1) gives. A pretend FM-1; no device.
import assert from 'node:assert/strict';
import {Link, OP} from '../lsdj/link.js';

function fake(answer) {
  const sent = [];
  const input = {onmidimessage: null};
  const output = {send(m) {
    const op = m[4], body = [];
    for (let i = 5; i + 1 < m.length - 1; i += 2) body.push(m[i] | (m[i + 1] & 1) << 7);
    sent.push({op, body});
    const [status, data] = answer(op, body);
    queueMicrotask(() => input.onmidimessage({data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7]}));
  }};
  return {link: new Link(input, output), sent};
}
const head = [2, 3, 170, 0, 5, 1, 0xF];   /* page, cursor, bpm 170, mute, freeze, playing */
const fx = n => Array.from({length: 4 * n}, (_, i) => i & 255);

/* LIVE: each length */
for (const [name, d, words, batt] of [
  ['before alpha 66', [...head, ...fx(11)], 11, null],
  ['alpha 66', [...head, ...fx(17)], 17, null],
  ['FM-1_979: battery', [...head, ...fx(17), 0x82], 17, {bars: 2, usb: true}],
]) {
  const {link} = fake(() => [0, d]);
  const l = await link.live();
  assert.equal(l.bpm, 170, name); assert.equal(l.fx.length, words, name); assert.deepEqual(l.battery, batt, name);
  assert.equal(l.rows, null, `${name}: no rows`); assert.equal(l.sync, null); assert.equal(l.level, null);
}
{ const {link} = fake(() => [0, [...head, ...fx(17), 0x03, 3, 7, 11, 15, 0x10, 0x11, 0xFF, 0x13, 3, 1, 100]]);
  const l = await link.live();
  assert.equal(l.fx.length, 17, '0.9.98: still 17 effect words'); assert.equal(l.fx[16], (64 | 65 << 8 | 66 << 16 | 67 << 24) >>> 0);
  assert.deepEqual(l.battery, {bars: 3, usb: false});
  assert.deepEqual(l.rows, [3, 7, 11, 15]); assert.deepEqual(l.songRows, [0x10, 0x11, null, 0x13]);
  assert.equal(l.sync, 'midi'); assert.equal(l.live, true); assert.equal(l.level, 100); }
{ const {link} = fake(() => [0, [...head, ...fx(17), 0xFF, ...Array(11).fill(0xFF)]]);
  const l = await link.live();
  assert.deepEqual(l.rows, [null, null, null, null], 'unknown addresses: null'); assert.equal(l.sync, null); assert.equal(l.live, null); assert.equal(l.level, null); }

/* VOLUME_SET, SEQ_SET, SONG_ROWS */
{ const song = Array.from({length: 1024}, (_, i) => i % 5 ? i & 0x7F : 0xFF);
  const {link, sent} = fake((op, b) => op === OP.SONG_ROWS ? [0, [b[0], ...Array.from({length: 64}, (_, i) => b[0] * 4 + i < 1024 ? song[b[0] * 4 + i] : 0xFF)]] : [0, []]);
  assert.equal(await link.volumeSet(64), true); assert.deepEqual(sent.at(-1), {op: OP.VOLUME_SET, body: [64]});
  await link.volumeSet(300); assert.deepEqual(sent.at(-1).body, [127], 'clamped');
  await link.volumeSet(-3); assert.deepEqual(sent.at(-1).body, [0]);
  assert.equal(await link.seqSet(true), true); assert.deepEqual(sent.at(-1), {op: OP.SEQ_SET, body: [1]});
  const rows = await link.songRows(0x20);
  assert.equal(rows.length, 16); assert.deepEqual(rows[0], [128, 129, 130, 131].map(i => i % 5 ? i & 0x7F : null));
  assert.deepEqual(rows[15], [188, 189, 190, 191].map(i => i % 5 ? i & 0x7F : null));
  assert.deepEqual(sent.at(-1), {op: OP.SONG_ROWS, body: [0x20]}); }
{ const {link} = fake(() => [1, []]);   /* 0.9.97 and older */
  assert.equal(await link.volumeSet(10), false); assert.equal(await link.seqSet(false), false); assert.equal(await link.songRows(0), null); }
/* SYNC_SET (0.9.98-dev.2): KEYBD 5, MIDI 3; 'playing' (status 2), 'no' (status 1: older firmware, unknown LSDj) */
{ let status = 0;
  const {link, sent} = fake(() => [status, []]);
  assert.equal(await link.syncSet('keybd'), 'ok'); assert.deepEqual(sent.at(-1), {op: OP.SYNC_SET, body: [5]});
  assert.equal(await link.syncSet('midi'), 'ok'); assert.deepEqual(sent.at(-1), {op: OP.SYNC_SET, body: [3]});
  status = 2; assert.equal(await link.syncSet('keybd'), 'playing');
  status = 1; assert.equal(await link.syncSet('keybd'), 'no');
  await assert.rejects(link.syncSet('lsdj'), /KEYBD or MIDI only/); }

console.log('PASS link DJ: LIVE at every length (11 / 17 words, battery, 0.9.98 rows, song rows, SYNC, SEQ, volume), VOLUME_SET, SEQ_SET, SONG_ROWS, SYNC_SET (ok, playing, no), older firmware');
