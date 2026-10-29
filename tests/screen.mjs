// SPDX-License-Identifier: GPL-3.0-only
// lsdj/screen.js: rows decoded (colours + 4-bit indices), only changed bands read again, a row
// with too many colours keeps the old one, firmware without the screen, a stop mid-round.
// (The firmware's side: tests/lsdj_link.c; both together: harness/link_page_test.mjs.)
import assert from 'node:assert/strict';
import {decodeRow, changedBands, rgb, ScreenMirror, W, H, BANDS} from '../lsdj/screen.js';

/* a row as the firmware sends it (firmware/lsdj_link.h SCREEN_ROW); null: more than 16 colours */
function encodeRow(px, y) {
  const pal = [], ix = new Uint8Array(W / 2);
  for (let x = 0; x < W; x++) {
    let k = pal.indexOf(px[y * W + x]);
    if (k < 0) { if (pal.length === 16) return null; k = pal.push(px[y * W + x]) - 1; }
    ix[x >> 1] |= k << (4 * (x & 1));
  }
  return Uint8Array.from([y, pal.length, ...pal.flatMap(c => [c & 255, c >> 8]), ...ix]);
}
const bandHash = (px, b) => { let h = 0; for (let i = b * 8 * W; i < (b + 1) * 8 * W; i++) h = (h * 31 + px[i]) >>> 0; return h & 0xFFFF; };
function fakeLink(px, {supported = true} = {}) {
  const l = {closed: false, rows: 0, infos: 0, px,
    async screenInfo() { l.infos++; return supported ? {shown: l.infos, hashes: Array.from({length: BANDS}, (_, b) => bandHash(l.px, b))} : null; },
    async screenRow(y) { l.rows++; return encodeRow(l.px, y); }};
  return l;
}
const canvas = () => ({getContext: () => ({createImageData: (w, h) => ({data: new Uint8ClampedArray(4 * w * h)}), putImageData() { this.puts = (this.puts || 0) + 1; }})});
// an LSDj-like picture: 4 shades in 8x8 cells, plus a few panel colours
const SHADES = [0xFFFF, 0xAD55, 0x52AA, 0x0000], PANEL = [0xFD20, 0x9CD3];
const pic = Uint16Array.from({length: W * H}, (_, i) => SHADES[((i % W >> 3) + (i / W >> 3)) % 4]);
for (let x = 0; x < 40; x++) pic[3 * W + x] = PANEL[x & 1];

// decodeRow / rgb
assert.deepEqual(rgb(0xFFFF), [255, 255, 255]); assert.deepEqual(rgb(0xF800), [255, 0, 0]); assert.deepEqual(rgb(0x07E0), [0, 255, 0]);
{ const r = decodeRow(encodeRow(pic, 3)); assert.equal(r.row, 3); assert.deepEqual([...r.px], [...pic.subarray(3 * W, 4 * W)]); }
assert.equal(decodeRow(new Uint8Array(10)), null);                           // wrong length
assert.equal(decodeRow(Uint8Array.from([200, 1, 0, 0, ...new Uint8Array(80)])), null);   // row past the end
assert.equal(decodeRow(Uint8Array.from([0, 1, 0, 0, ...new Uint8Array(80).fill(0x11)])), null);   // index 1 of 1 colour
assert.deepEqual(changedBands([1, 2, 3], [1, 9, 3]), [1]);
assert.deepEqual(changedBands(new Array(3).fill(null), [0, 0, 0]), [0, 1, 2]);

// the first round reads every row; the picture comes out exact
const link = fakeLink(pic.slice()), m = new ScreenMirror(link, canvas());
assert.equal(await m.step(), true);
assert.equal(link.rows, H); assert.deepEqual([...m.pixels()], [...pic]);
// nothing changed: no rows
await m.step(); assert.equal(link.rows, H);
// one pixel in band 5: that band's 8 rows only
link.px[5 * 8 * W + 2 * W + 100] = 0xF800;
await m.step(); assert.equal(link.rows, H + 8); assert.equal(m.pixels()[5 * 8 * W + 2 * W + 100], 0xF800);
// a row with 17 colours: skipped (the old row stays), not read again until the band changes
for (let x = 0; x < 17; x++) link.px[10 * W + x] = 0x0841 * (x + 1);
await m.step(); assert.equal(m.stats.skipped, 1); assert.equal(m.pixels()[10 * W], pic[10 * W]);
await m.step(); assert.equal(link.rows, H + 16);
// stopped half way: the bands not read stay unknown and are read next round
{ const l = fakeLink(pic.slice()); let n = 0;
  const s = new ScreenMirror(l, canvas(), {active: () => ++n < 4});
  await s.step(); assert.equal(l.rows, 24);   // 3 bands, then not active
  n = -1e9; await s.step(); assert.deepEqual([...s.pixels()], [...pic]); }
// firmware before FM-1_983: told once, step says no
{ let told = []; const s = new ScreenMirror(fakeLink(pic, {supported: false}), canvas(), {onSupport: ok => told.push(ok)});
  assert.equal(await s.step(), false); assert.deepEqual(told, [false]); }
// the loop: runs while active, stops on stop() and when the link closes
{ const l = fakeLink(pic.slice()), s = new ScreenMirror(l, canvas(), {every: 5});
  s.start(); await new Promise(r => setTimeout(r, 60)); s.stop();
  const seen = l.infos; assert.ok(seen >= 2, `${seen} rounds`);
  await new Promise(r => setTimeout(r, 30)); assert.equal(l.infos, seen); }
console.log('PASS screen: rows decoded exactly, only changed bands read, 17-colour row kept, stop mid-round, older firmware');
