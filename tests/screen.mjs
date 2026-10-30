// SPDX-License-Identifier: GPL-3.0-only
// lsdj/screen.js: rows decoded (colours + 4-bit indices), only changed bands read again, a row
// with too many colours keeps the old one, firmware without the screen, a stop mid-round;
// FM-1_985's SCREEN_SYNC: packed rows sent by the FM-1, lost and late rows, fallback.
// (The firmware's side: tests/lsdj_link.c; both together: harness/link_page_test.mjs.)
import assert from 'node:assert/strict';
import {decodeRow, decodePixels, decodeFrame, changedBands, rgb, ScreenMirror, W, H, BANDS} from '../lsdj/screen.js';

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
const ROW_GAP = 120;   // lsdj/screen.js ROW_GAP_MS
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

/* ---------- FM-1_985: SCREEN_SYNC + SCREEN_PIXELS ---------- */
/* a SCREEN_PIXELS message as the firmware builds it (firmware/lsdj_link.h lsdj_link_screen_pixels) */
function encodePixels(px, y, round) {
  const pal = [], k = [];
  for (let x = 0; x < W; x++) {
    let i = pal.indexOf(px[y * W + x]);
    if (i < 0) {
      if (pal.length === 16) return Uint8Array.from([0xF0, 0x7D, 0x47, 0x53, 0x28, 2, round & 127, y & 127, y >> 7, 0xF7]);
      i = pal.push(px[y * W + x]) - 1;
    }
    k.push(i);
  }
  const out = [0xF0, 0x7D, 0x47, 0x53, 0x28, 0, round & 127];
  let acc = 0, bits = 0;
  const put = (v, w) => { acc |= v << bits; bits += w; while (bits >= 7) { out.push(acc & 127); acc >>>= 7; bits -= 7; } };
  const np = pal.length, w = np > 8 ? 4 : np > 4 ? 3 : np > 2 ? 2 : np > 1 ? 1 : 0;
  put(y, 8); put(np - 1, 4); for (const c of pal) put(c, 16);
  if (w) for (const i of k) put(i, w);
  if (bits) out.push(acc & 127);
  out.push(0xF7);
  return Uint8Array.from(out);
}
{ const m = encodePixels(pic, 3, 5), r = decodePixels(m);
  assert.equal(r.row, 3); assert.equal(r.round, 5); assert.deepEqual([...r.px], [...pic.subarray(3 * W, 4 * W)]);
  assert.equal(m.length, 7 + Math.ceil((8 + 4 + 6 * 16 + 160 * 3) / 7) + 1);   // 6 colours: 3 bits a pixel
  const one = new Uint16Array(W * H).fill(0x1234), r1 = decodePixels(encodePixels(one, 140, 0));
  assert.equal(r1.row, 140); assert.ok(r1.px.every(c => c === 0x1234)); assert.equal(encodePixels(one, 140, 0).length, 7 + 4 + 1);
  const many = pic.slice(); for (let x = 0; x < 17; x++) many[x] = 0x0841 * (x + 1);
  assert.deepEqual(decodePixels(encodePixels(many, 0, 9)), {row: 0, round: 9, px: null});
  assert.equal(decodePixels(Uint8Array.from([...m.slice(0, m.length - 2), 0xF7])), null);   // short
  assert.equal(decodePixels(Uint8Array.from([...m.slice(0, m.length - 1), 0, 0xF7])), null);   // a byte too many
  const bad = m.slice(); bad[9] = 0x80; assert.equal(decodePixels(bad), null);
  assert.equal(decodePixels(Uint8Array.from([0xF0, 0x7D, 0x47, 0x53, 0x28, 0, 0, 0x7F, 0x7F, 0xF7])), null); }   // row 255

/* the FM-1 side: hashes, the bands that differ, then their rows by themselves (some lost on request;
   extra: messages sent before the rows, e.g. a late row from an earlier round) */
function syncLink(px, {supported = true} = {}) {
  const l = {closed: false, px, syncs: 0, sent: 0, onPixels: null, lose: new Set(), extra: [],
    async screenSync(known, round) {
      l.syncs++;
      if (!supported) return null;
      const hashes = Array.from({length: BANDS}, (_, b) => bandHash(l.px, b));
      let bands = 0; hashes.forEach((h, b) => { if (known[b] == null || known[b] !== h) bands |= 1 << b; });
      const extra = l.extra; l.extra = [];
      setTimeout(() => {
        for (const e of extra) l.onPixels?.(e);
        for (let y = 0; y < H; y++) if (bands >> (y >> 3) & 1) {
          l.sent++;
          if (!l.lose.has(y)) l.onPixels?.(encodePixels(l.px, y, round));
        }
      }, 1);
      return {shown: l.syncs, hashes, bands};
    },
    async screenInfo() { throw new Error('row by row not expected'); },
    async screenRow() { throw new Error('row by row not expected'); }};
  return l;
}
{ const l = syncLink(pic.slice()), told = [], m = new ScreenMirror(l, canvas(), {onSupport: ok => told.push(ok)});
  assert.equal(await m.step(), 'more'); assert.equal(l.sent, H); assert.deepEqual([...m.pixels()], [...pic]); assert.deepEqual(told, [true]);
  assert.equal(await m.step(), true); assert.equal(l.sent, H);   // nothing changed: no rows, one request
  l.px[5 * 8 * W + 2 * W + 100] = 0xF800;
  assert.equal(await m.step(), 'more'); assert.equal(l.sent, H + 8); assert.equal(m.pixels()[5 * 8 * W + 2 * W + 100], 0xF800);
  // a lost row: that band is read again next round
  l.px[7 * 8 * W + 3] = 0x07E0; l.lose.add(7 * 8 + 1);
  assert.equal(await m.step(), 'more'); assert.equal(m.stats.lost, 1); assert.equal(l.sent, H + 16);
  l.lose.clear(); assert.equal(await m.step(), 'more'); assert.equal(l.sent, H + 24); assert.equal(m.pixels()[7 * 8 * W + 3], 0x07E0);
  assert.equal(await m.step(), true);
  // the very last row lost: the gap (300 ms with no row) ends the round
  l.px[H * W - 1] = 0x001F; l.lose.add(H - 1);
  const t0 = Date.now(); assert.equal(await m.step(), 'more'); assert.ok(Date.now() - t0 >= 100, 'waited for the gap');
  l.lose.clear(); await m.step(); assert.equal(m.pixels()[H * W - 1], 0x001F); assert.equal(await m.step(), true);
  // a late row from an earlier round: not painted, not counted
  const stale = pic.slice(); stale.fill(0xF81F, 0, W);
  l.px[2 * W] = 0x1111; l.extra.push(encodePixels(stale, 0, m.round));   // m.round: the round just finished
  assert.equal(await m.step(), 'more'); assert.equal(m.pixels()[0], pic[0]); assert.equal(m.pixels()[2 * W], 0x1111); }
// FM-1_983/984: SCREEN_SYNC answers no -> a row at a time from then on
{ const l = fakeLink(pic.slice()); let syncs = 0; l.screenSync = async () => { syncs++; return null; };
  const m = new ScreenMirror(l, canvas());
  assert.equal(await m.step(), true); assert.equal(l.rows, H); assert.deepEqual([...m.pixels()], [...pic]);
  await m.step(); assert.equal(syncs, 1); }
// Bluetooth (a slow link): never asks for SCREEN_SYNC
{ const l = fakeLink(pic.slice()); l.slow = true; l.screenSync = async () => { throw new Error('not over Bluetooth'); };
  const m = new ScreenMirror(l, canvas()); assert.equal(await m.step(), true); assert.equal(l.rows, H); }
// the loop with sync: rows, then idle rounds; stop() ends it and lets go of the link
{ const l = syncLink(pic.slice()), m = new ScreenMirror(l, canvas(), {every: 5});
  m.start(); await new Promise(r => setTimeout(r, 60)); m.stop();
  assert.ok(l.syncs >= 2); assert.deepEqual([...m.pixels()], [...pic]); assert.equal(l.onPixels, null);
  const seen = l.syncs; await new Promise(r => setTimeout(r, 30)); assert.equal(l.syncs, seen); }
// the canvas gets whole rounds, not rows as they come, each as soon as it is done (FM-1_988 page; 987
// held changing rounds back up to 50 ms); a band that lost rows stays old; the FM-1's own picture count
{ const l = syncLink(pic.slice()), m = new ScreenMirror(l, canvas());
  const puts = () => m.ctx.puts || 0;
  assert.equal(await m.step(), 'more'); assert.equal(puts(), 1, 'the first round is shown');
  assert.equal(m.stats.fm1Shown, l.syncs, "the FM-1's pictures shown (SYNC's count)");
  l.px[3 * 8 * W] = 0xF800;
  assert.equal(await m.step(), 'more'); assert.equal(puts(), 2, 'the next round at once');
  assert.equal(await m.step(), true); assert.equal(puts(), 2, 'nothing new: not drawn again');
  l.px[4 * 8 * W] = 0x07E0;
  assert.equal(await m.step(), 'more'); assert.equal(puts(), 3);
  // a band with a lost row keeps all its old pixels (not half new), then comes whole
  const before = m.pixels().slice();
  for (let y = 6 * 8; y < 7 * 8; y++) l.px[y * W + 9] = 0x001F;
  l.lose.add(6 * 8 + 5);
  assert.equal(await m.step(), 'more');
  assert.deepEqual([...m.pixels().subarray(6 * 8 * W, 7 * 8 * W)], [...before.subarray(6 * 8 * W, 7 * 8 * W)], 'the band stays old');
  l.lose.clear(); assert.equal(await m.step(), 'more');
  for (let y = 6 * 8; y < 7 * 8; y++) assert.equal(m.pixels()[y * W + 9], 0x001F);
  m.stop(); }
/* ---------- FM-1_990: the FM-1 pushes each new picture (SCREEN_FRAME, then its rows) ---------- */
/* a SCREEN_FRAME as the firmware builds it (firmware/lsdj_link.h lsdj_link_push_frame) */
function encodeFrame(round, shown, bands, hashes) {
  const out = [0xF0, 0x7D, 0x47, 0x53, 0x29, 0, round & 127];
  let acc = 0, bits = 0;
  const put = (v, w) => { acc |= v << bits; bits += w; while (bits >= 7) { out.push(acc & 127); acc >>>= 7; bits -= 7; } };
  put(shown & 0xFFFF, 16); put(shown >>> 16, 16); put(bands & 0xFFFF, 16); put(bands >>> 16, 2);
  for (const h of hashes) put(h, 16);
  if (bits) out.push(acc & 127);
  out.push(0xF7);
  return Uint8Array.from(out);
}
{ const hs = Array.from({length: BANDS}, (_, b) => b * 3001 & 0xFFFF), m = encodeFrame(127, 70000, 1 << 17 | 1 << 9, hs);
  assert.equal(m.length, 57);   // = tests/lsdj_link.c
  assert.deepEqual(decodeFrame(m), {round: 127, shown: 70000, bands: 1 << 17 | 1 << 9, hashes: hs});
  assert.equal(decodeFrame(Uint8Array.from([...m.slice(0, m.length - 2), 0xF7])), null);
  const bad = m.slice(); bad[5] = 1; assert.equal(decodeFrame(bad), null); }
/* the FM-1 side, pushing: a SYNC with push sets what the page will hold; picture() pushes a new one */
function pushLink(px) {
  const l = syncLink(px), sync = l.screenSync;
  Object.assign(l, {pushes: 0, held: null, round: 0, dropFrame: false,
    async screenSync(known, round, push) {
      const r = await sync(known, round);
      if (push) { l.pushes++; l.held = r.hashes.slice(); l.round = round; }
      return r;
    },
    picture() {   // = board.c screen_push: the bands that changed since what was sent, then their rows
      const hashes = Array.from({length: BANDS}, (_, b) => bandHash(l.px, b));
      let bands = 0; hashes.forEach((h, b) => { if (h !== l.held[b]) bands |= 1 << b; });
      if (!bands) return;
      const round = l.round = (l.round + 1) & 127;
      hashes.forEach((h, b) => { if (bands >> b & 1) l.held[b] = h; });
      if (!l.dropFrame) l.onPixels?.(encodeFrame(round, 1000 + round, bands, hashes));
      for (let y = 0; y < H; y++) if (bands >> (y >> 3) & 1) { l.sent++; if (!l.lose.has(y)) l.onPixels?.(encodePixels(l.px, y, round)); }
    }});
  return l;
}
{ const l = pushLink(pic.slice()), m = new ScreenMirror(l, canvas(), {push: true});
  const wait = ms => new Promise(r => setTimeout(r, ms));
  assert.equal(await m.step(), 1000); await wait(5);   // one SYNC with push; renew in a second
  assert.equal(l.pushes, 1); assert.deepEqual([...m.pixels()], [...pic]);
  // new pictures come by themselves: no SYNC, each shown as soon as its rows are in
  const puts = () => m.ctx.puts || 0, p0 = puts();
  l.px[5 * 8 * W + 2 * W + 100] = 0xF800; l.picture();
  assert.equal(m.pixels()[5 * 8 * W + 2 * W + 100], 0xF800); assert.equal(puts(), p0 + 1); assert.equal(m.stats.fm1Shown, 1000 + l.round);
  l.px[9 * 8 * W] = 0x07E0; l.px[17 * 8 * W + 7 * W + 159] = 0x001F; l.picture();
  assert.equal(m.pixels()[9 * 8 * W], 0x07E0); assert.equal(m.pixels()[H * W - 1], 0x001F); assert.equal(puts(), p0 + 2);
  assert.equal(l.syncs, 1); assert.equal(l.sent, H + 8 + 16);
  // a lost row: that band stays old, the next renewal comes soon and brings it
  l.px[7 * 8 * W + 3] = 0xF81F; l.lose.add(7 * 8 + 1); l.picture(); l.lose.clear();
  await wait(ROW_GAP + 20);
  assert.equal(m.pixels()[7 * 8 * W + 3], pic[7 * 8 * W + 3]); assert.equal(m.stats.lost, 1);
  assert.equal(await m.step(), 1000); await wait(5);
  assert.equal(m.pixels()[7 * 8 * W + 3], 0xF81F); assert.equal(l.syncs, 2);
  // a lost SCREEN_FRAME: its rows are a round the page does not know (not painted); the next SYNC brings it
  l.px[2 * 8 * W] = 0x1234; l.dropFrame = true; l.picture(); l.dropFrame = false;
  assert.equal(m.pixels()[2 * 8 * W], pic[2 * 8 * W]);
  // a newer picture still comes (bands it does not bring stay as they were)
  l.px[3 * 8 * W] = 0x4321; l.picture(); assert.equal(m.pixels()[3 * 8 * W], 0x4321);
  await m.step(); await wait(5); assert.equal(m.pixels()[2 * 8 * W], 0x1234, 'the SYNC carried the old hash: sent again');
  m.stop(); assert.equal(l.onPixels, null); }
// the loop pushing: renews once a second, at once (100 ms) after a loss
{ const l = pushLink(pic.slice()), m = new ScreenMirror(l, canvas(), {push: true, every: 5});
  m.start(); await new Promise(r => setTimeout(r, 50));
  assert.equal(l.syncs, 1, 'one SYNC, then the FM-1 pushes');
  l.px[4 * 8 * W] = 0xF800; l.lose.add(4 * 8); l.picture(); l.lose.clear();
  await new Promise(r => setTimeout(r, ROW_GAP + 150));
  assert.equal(l.syncs, 2, 'renewed soon after the loss'); assert.equal(m.pixels()[4 * 8 * W], 0xF800);
  m.stop(); }
// FM-1 before 990 (SYNC but no push): never pushed, so the page asks round by round as before (app.js
// sets push only for FM-1_990 and newer); with push on and no SYNC at all: row by row
{ const l = fakeLink(pic.slice()); l.screenSync = async () => null; const m = new ScreenMirror(l, canvas(), {push: true});
  assert.equal(await m.step(), true); assert.equal(m.push, false); assert.equal(m.sync, false); assert.deepEqual([...m.pixels()], [...pic]); }
console.log('PASS screen: rows decoded exactly, only changed bands read, 17-colour row kept, stop mid-round, older firmware; sync: packed rows, lost / late rows, fallback, loop; whole rounds shown at once, a band missing rows stays old, the FM-1 picture count; push (990): frames by themselves, lost rows / frame, renewals');
