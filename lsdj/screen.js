// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's screen on the page (FM-1_983 and newer): the 160x144 picture its LCD shows, the
// effects panels included, read over the link (firmware/lsdj_link.h). View only. The firmware
// hashes each 8-row band; only bands whose hash changed are read again.
//   FM-1_985+, USB: one SCREEN_SYNC carries the hashes the page holds; the FM-1 answers with its
//   own and then sends the changed rows by itself (SCREEN_PIXELS, packed), no request per row.
//   FM-1_990+, USB: that SYNC also asks the FM-1 to push: it then sends each new picture by itself (a
//   SCREEN_FRAME with the bands that changed, then their rows) with no request, so the page keeps up
//   with the FM-1 (a round trip per picture could not at 30 a second). The page renews the push every
//   PUSH_MS (sooner when rows were lost: the SYNC carries the hashes it holds, so they come again).
//   FM-1_983/984, or Bluetooth: SCREEN_INFO, then SCREEN_ROW a row at a time.
export const W = 160, H = 144, BANDS = 18, BAND_ROWS = 8;
const ROW_GAP_MS = 120;   // sync: no row for this long = the rest was lost (read again next round);
                          // FM-1_988 sends rows back to back (985-987: one a main-loop pass, 300 ms)
const PUSH_MS = 1000, PUSH_RETRY_MS = 100;   // FM-1_990: renew the push (it lasts 3 s); after a loss

/* RGB565 (as the LCD) -> [r, g, b] */
export const rgb = c => [Math.round((c >> 11) * 255 / 31), Math.round((c >> 5 & 63) * 255 / 63), Math.round((c & 31) * 255 / 31)];

/* A SCREEN_ROW reply's data -> {row, px: 160 RGB565 values}, or null if it is malformed */
export function decodeRow(d) {
  if (!d || d.length < 2) return null;
  const n = d[1];
  if (d.length !== 2 + 2 * n + W / 2 || n < 1 || n > 16 || d[0] >= H) return null;
  const colors = Array.from({length: n}, (_, k) => d[2 + 2 * k] | d[3 + 2 * k] << 8);
  const px = new Uint16Array(W), at = 2 + 2 * n;
  for (let x = 0; x < W; x++) {
    const k = d[at + (x >> 1)] >> (4 * (x & 1)) & 15;
    if (k >= n) return null;
    px[x] = colors[k];
  }
  return {row: d[0], px};
}

/* A whole SCREEN_PIXELS message (F0 7D 'G' 'S' 28 status round bits F7) -> {row, round, px} ({row,
   round, px: null} for a row of more than 16 colours), or null if it is malformed. The bits: 7 to a
   byte, lowest first: u8 row, 4 bits colours - 1, colours x u16 RGB565, 160 indices of 0-4 bits. */
export function decodePixels(m) {
  const n = m?.length ?? 0;
  if (n < 10 || m[0] !== 0xF0 || m[4] !== 0x28 || m[n - 1] !== 0xF7) return null;
  let i = 7, acc = 0, bits = 0;
  const take = w => {
    while (bits < w) { if (i >= n - 1 || m[i] > 127) throw 0; acc |= m[i++] << bits; bits += 7; }
    const v = acc & ((1 << w) - 1); acc >>>= w; bits -= w; return v;
  };
  try {
    const row = take(8), round = m[6];
    if (row >= H) return null;
    if (m[5] === 2) return i === n - 1 ? {row, round, px: null} : null;
    if (m[5] !== 0) return null;
    const np = take(4) + 1, w = np > 8 ? 4 : np > 4 ? 3 : np > 2 ? 2 : np > 1 ? 1 : 0;
    const colors = Array.from({length: np}, () => take(16));
    const px = new Uint16Array(W);
    for (let x = 0; x < W; x++) {
      const k = w ? take(w) : 0;
      if (k >= np) return null;
      px[x] = colors[k];
    }
    return i === n - 1 ? {row, round, px} : null;
  } catch { return null; }
}

/* A SCREEN_FRAME message (FM-1_990: F0 7D 'G' 'S' 29 00 round bits F7) -> {round, shown, bands, hashes},
   or null if it is malformed. The bits as SCREEN_PIXELS: u32 shown, 18 bits bands, 18 x u16 hashes. */
export function decodeFrame(m) {
  const n = m?.length ?? 0;
  if (n < 10 || m[0] !== 0xF0 || m[4] !== 0x29 || m[5] !== 0 || m[n - 1] !== 0xF7) return null;
  let i = 7, acc = 0, bits = 0;
  const take = w => {
    while (bits < w) { if (i >= n - 1 || m[i] > 127) throw 0; acc += m[i++] * 2 ** bits; bits += 7; }
    const v = acc % 2 ** w; acc = Math.floor(acc / 2 ** w); bits -= w; return v;
  };
  try {
    const shown = take(16) + take(16) * 65536, bands = take(16) + take(2) * 65536;
    const hashes = Array.from({length: BANDS}, () => take(16));
    return i === n - 1 ? {round: m[6], shown, bands, hashes} : null;
  } catch { return null; }
}

/* Which bands to read again: those whose hash differs from the one last read (all at first). */
export const changedBands = (known, hashes) => hashes.map((h, b) => b).filter(b => known[b] !== hashes[b]);

export class ScreenMirror {
  /* link: lsdj/link.js Link. canvas: 160x144. active(): poll now? (tab shown, nothing else busy).
     onSupport(ok): told once whether the firmware has the screen (false: before FM-1_983).
     every: ms between rounds when nothing changed (and between row-by-row rounds).
     clock(): the window whose timers to use, one on screen (a hidden window's timers are slowed;
     the canvas may be in a pop-out window while the page is behind, lsdj/popout.js).
     push: the FM-1 sends new pictures by itself (FM-1_990 and newer). */
  constructor(link, canvas, {active = () => true, onSupport = () => {}, every = 100, clock = () => globalThis, push = false} = {}) {
    Object.assign(this, {link, canvas, active, onSupport, every, clock, push});
    this.known = new Array(BANDS).fill(null);
    this.ctx = canvas.getContext('2d');
    this.img = this.ctx.createImageData(W, H);
    this.stats = {infos: 0, rows: 0, skipped: 0, frames: 0, syncs: 0, lost: 0, shown: 0, settled: 0, fm1Shown: null};
    this.shownAt = -1e9;
    this.miss = new Array(BANDS).fill(0);   // rounds in a row a band lost rows   // sync: the rows go into img; the canvas gets img a round at a time (present)
    this.gen = 0; this.running = false;   // gen: a stop (or a new start) ends the loop and round under way
    this.sync = !link.slow && typeof link.screenSync === 'function';   // try SCREEN_SYNC (USB); false once the FM-1 says no
    this.round = 0;
  }
  /* a timer on the clock's window; the returned function cancels it */
  after(ms, f) {
    const w = this.clock() || globalThis, id = w.setTimeout(f, ms);
    return () => w.clearTimeout(id);
  }
  start() { if (this.running) return; this.running = true; this.loop(++this.gen); }
  stop() {
    this.running = false; this.gen++; this.cancel?.(); this.cancelGap?.(); this.soon = false;
    if (this.cur) { this.finish(this.cur); this.cur = null; }
    this.present();
    if (this.link.onPixels === this.onPixels) this.link.onPixels = null;
    this.wake?.();
  }
  async loop(gen) {
    while (gen === this.gen && !this.link.closed) {
      let wait = this.every;
      if (this.active()) {
        try {
          const r = await this.step();
          if (r === false) { this.stop(); return; }
          if (r === 'more') wait = 0;   // rows came: look again at once
          else if (typeof r === 'number') wait = r;   // pushing: renew then
        } catch { /* a missed reply: next round */ }
      }
      if (gen !== this.gen) return;
      await new Promise(r => { this.wakeNow = r; this.cancel = this.after(wait, r); });
      this.wakeNow = null;
    }
    if (gen === this.gen) this.running = false;
  }
  /* One round. false: the firmware has no screen; 'more': rows were read; true: nothing changed. */
  async step() {
    if (this.sync && this.push) {
      const r = await this.stepPush();
      if (r !== null) return r;
      this.push = false;
    }
    if (this.sync) {
      const r = await this.stepSync();
      if (r !== null) return r;
      this.sync = false;   // FM-1_983/984 (or no streaming here): a row at a time from now on
    }
    return this.stepRows();
  }
  /* FM-1_985+: SCREEN_SYNC, then the rows the FM-1 sends. null: SCREEN_SYNC not here. */
  async stepSync() {
    const gen = this.gen, round = this.round = (this.round + 1) & 127;
    const got = new Set(), arrived = new Map();   // rows with pixels; every row that came (null: skipped)
    let expect = null, lastRow = -1, done, cancelGap = () => {};
    const finished = new Promise(r => { done = r; });
    const gap = () => { cancelGap(); cancelGap = this.after(ROW_GAP_MS, done); };
    this.wake = done;
    this.onPixels = m => {
      const p = decodePixels(m);
      if (!p || p.round !== round) return;   // a late row from an earlier round: not counted
      this.stats.rows++;
      arrived.set(p.row, p.px);
      if (p.px) got.add(p.row); else this.stats.skipped++;
      if (expect) { gap(); if (p.row === lastRow) done(); }
    };
    this.link.onPixels = this.onPixels;
    try {
      const info = await this.link.screenSync(this.known, round);
      if (this.supported === undefined && info) { this.supported = true; this.onSupport(true); }
      if (!info) return null;
      this.stats.syncs++; this.stats.fm1Shown = info.shown;   // the pictures the FM-1 has put on its LCD
      expect = [];
      for (let b = 0; b < BANDS; b++) if (info.bands >> b & 1) expect.push(b);
      // Nothing changed since the last round: the rows it brought were all one frame. Show it now.
      // (Rows come over a few frames, so while the screen changes img can hold two; held back.)
      if (!expect.length) { if (this.unshown) { this.stats.settled++; this.present(); } return true; }
      lastRow = expect[expect.length - 1] * BAND_ROWS + BAND_ROWS - 1;
      if (!got.has(lastRow)) { gap(); await finished; }
      if (gen !== this.gen) return true;
      for (const b of expect) {
        let all = true, came = true;
        for (let y = b * BAND_ROWS; y < (b + 1) * BAND_ROWS; y++) { if (!got.has(y)) all = false; if (!arrived.has(y)) came = false; }
        // a band whose rows all came goes into the picture (a skipped row keeps its old pixels); one
        // that lost rows stays as it was, not half new, and is read again next round. Losing rows a
        // second round in a row (a lossy link): the rows that came go in anyway, so it gets there.
        this.miss[b] = came ? 0 : this.miss[b] + 1;
        if (came || this.miss[b] >= 2) for (let y = b * BAND_ROWS; y < (b + 1) * BAND_ROWS; y++) { const px = arrived.get(y); if (px) this.put({row: y, px}); }
        if (all) this.known[b] = info.hashes[b]; else this.stats.lost++;   // read again next round
      }
      this.stats.frames++;
      this.unshown = true; this.present();   // a round done: on the canvas at once (whole bands only)
      return 'more';
    } finally {
      cancelGap();
      if (this.link.onPixels === this.onPixels) this.link.onPixels = null;
    }
  }
  /* FM-1_990+, USB: SCREEN_SYNC with the push bit; the FM-1's pictures then come by themselves (onPush).
     The ms until the next renewal, or null: SCREEN_SYNC not here. */
  async stepPush() {
    this.onPixels = this.onPush; this.link.onPixels = this.onPush;
    const round = ((this.cur ? this.cur.round : this.round) + 1) & 127;
    this.begin({round, bands: null, hashes: null});
    this.lostSince = false;
    const info = await this.link.screenSync(this.known, round, true);
    if (this.supported === undefined && info) { this.supported = true; this.onSupport(true); }
    if (!info) return null;
    this.stats.syncs++; this.stats.fm1Shown = info.shown;
    const c = this.cur;
    if (c.round === round && c.bands === null) {
      c.bands = info.bands; c.hashes = info.hashes;
      if (!info.bands && this.unshown) { this.stats.settled++; this.present(); }
      this.check(c);
    }
    return this.lostSince ? PUSH_RETRY_MS : PUSH_MS;
  }
  /* a pushed message: a SCREEN_FRAME starts a picture, SCREEN_PIXELS rows fill it */
  onPush = m => {
    if (m[4] === 0x29) {
      const f = decodeFrame(m);
      if (!f) return;
      this.stats.fm1Shown = f.shown;
      this.begin({round: f.round, bands: f.bands, hashes: f.hashes});
      this.check(this.cur);
      return;
    }
    const p = decodePixels(m), c = this.cur;
    if (!p || !c || c.done || p.round !== c.round) return;   // a late row: not counted
    this.stats.rows++;
    c.rows.set(p.row, p.px);
    if (!p.px) this.stats.skipped++;
    this.check(c);
  };
  /* a new picture: the last one ends with what came of it */
  begin(c) {
    if (this.cur) this.finish(this.cur);
    c.rows = new Map(); this.cur = c;
  }
  /* all its rows here: show it; else wait (ROW_GAP_MS without a row: the rest was lost) */
  check(c) {
    if (c.done || c.bands === null) return;
    for (let b = 0; b < BANDS; b++)
      if (c.bands >> b & 1) for (let y = b * BAND_ROWS; y < (b + 1) * BAND_ROWS; y++) if (!c.rows.has(y)) {
        this.cancelGap?.(); this.cancelGap = this.after(ROW_GAP_MS, () => this.finish(c));
        return;
      }
    this.finish(c);
  }
  finish(c) {
    if (c.done) return;
    c.done = true; this.cancelGap?.();
    if (!c.bands) return;   // nothing changed (null: its SYNC never answered)
    for (let b = 0; b < BANDS; b++) {
      if (!(c.bands >> b & 1)) continue;
      let all = true, came = true;
      for (let y = b * BAND_ROWS; y < (b + 1) * BAND_ROWS; y++) { if (!c.rows.get(y)) all = false; if (!c.rows.has(y)) came = false; }
      // as stepSync: a band that lost rows stays as it was (the second time in a row: what came goes in)
      this.miss[b] = came ? 0 : this.miss[b] + 1;
      if (came || this.miss[b] >= 2) for (let y = b * BAND_ROWS; y < (b + 1) * BAND_ROWS; y++) { const px = c.rows.get(y); if (px) this.put({row: y, px}); }
      if (all) this.known[b] = c.hashes[b];
      else { this.stats.lost++; this.lostSince = true; this.renewSoon(); }   // the FM-1 counts it as here: ask again
    }
    this.stats.frames++;
    this.unshown = true; this.present();
  }
  /* rows lost: renew the push in PUSH_RETRY_MS, not PUSH_MS (the SYNC carries the hashes held) */
  renewSoon() {
    if (!this.wakeNow || this.soon) return;
    const wake = this.wakeNow; this.cancel?.(); this.soon = true;
    this.cancel = this.after(PUSH_RETRY_MS, () => { this.soon = false; wake(); });
  }
  /* FM-1_983/984 or Bluetooth: the hashes, then the changed bands' rows one request each. */
  async stepRows() {
    const gen = this.gen;
    const info = await this.link.screenInfo();
    if (this.supported === undefined) { this.supported = !!info; this.onSupport(this.supported); }
    if (!info) return false;
    this.stats.infos++; this.stats.fm1Shown = info.shown;
    const bands = changedBands(this.known, info.hashes);
    for (const b of bands) {
      if (gen !== this.gen || !this.active()) return true;   // the rest next time (their hashes still differ)
      for (let y = b * BAND_ROWS; y < (b + 1) * BAND_ROWS; y++) {
        const row = decodeRow(await this.link.screenRow(y));
        this.stats.rows++;
        if (row?.row === y) this.put(row); else this.stats.skipped++;   // more than 16 colours: the old row stays
      }
      this.known[b] = info.hashes[b];
      this.ctx.putImageData(this.img, 0, 0);
    }
    if (bands.length) this.stats.frames++;
    return true;
  }
  now() { return typeof performance === 'object' ? performance.now() : Date.now(); }
  /* the rows read so far onto the canvas at once */
  present() {
    if (!this.unshown) return;
    this.unshown = false; this.shownAt = this.now(); this.stats.shown++;
    this.ctx.putImageData(this.img, 0, 0);
  }
  put({row, px}) {
    const d = this.img.data;
    for (let x = 0; x < W; x++) {
      const [r, g, b] = rgb(px[x]), o = 4 * (row * W + x);
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  /* the picture as RGB565 (tests) */
  pixels() {
    const d = this.img.data, out = new Uint16Array(W * H);
    for (let i = 0; i < W * H; i++) out[i] = (Math.round(d[4 * i] * 31 / 255) << 11) | (Math.round(d[4 * i + 1] * 63 / 255) << 5) | Math.round(d[4 * i + 2] * 31 / 255);
    return out;
  }
}
