// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's screen on the page (FM-1_983 and newer): the 160x144 picture its LCD shows, the
// effects panels included, read over the link (firmware/lsdj_link.h). View only. The firmware
// hashes each 8-row band; only bands whose hash changed are read again.
//   FM-1_985+, USB: one SCREEN_SYNC carries the hashes the page holds; the FM-1 answers with its
//   own and then sends the changed rows by itself (SCREEN_PIXELS, packed), no request per row.
//   FM-1_983/984, or Bluetooth: SCREEN_INFO, then SCREEN_ROW a row at a time.
export const W = 160, H = 144, BANDS = 18, BAND_ROWS = 8;
const ROW_GAP_MS = 300;   // sync: no row for this long = the rest was lost (read again next round)

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

/* Which bands to read again: those whose hash differs from the one last read (all at first). */
export const changedBands = (known, hashes) => hashes.map((h, b) => b).filter(b => known[b] !== hashes[b]);

export class ScreenMirror {
  /* link: lsdj/link.js Link. canvas: 160x144. active(): poll now? (tab shown, nothing else busy).
     onSupport(ok): told once whether the firmware has the screen (false: before FM-1_983).
     every: ms between rounds when nothing changed (and between row-by-row rounds). */
  constructor(link, canvas, {active = () => true, onSupport = () => {}, every = 100} = {}) {
    Object.assign(this, {link, canvas, active, onSupport, every});
    this.known = new Array(BANDS).fill(null);
    this.ctx = canvas.getContext('2d');
    this.img = this.ctx.createImageData(W, H);
    this.stats = {infos: 0, rows: 0, skipped: 0, frames: 0, syncs: 0, lost: 0};
    this.gen = 0; this.running = false;   // gen: a stop (or a new start) ends the loop and round under way
    this.sync = !link.slow && typeof link.screenSync === 'function';   // try SCREEN_SYNC (USB); false once the FM-1 says no
    this.round = 0;
  }
  start() { if (this.running) return; this.running = true; this.loop(++this.gen); }
  stop() {
    this.running = false; this.gen++; clearTimeout(this.timer);
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
        } catch { /* a missed reply: next round */ }
      }
      if (gen !== this.gen) return;
      await new Promise(r => { this.timer = setTimeout(r, wait); });
    }
    if (gen === this.gen) this.running = false;
  }
  /* One round. false: the firmware has no screen; 'more': rows were read; true: nothing changed. */
  async step() {
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
    const got = new Set();
    let expect = null, lastRow = -1, done, timer;
    const finished = new Promise(r => { done = r; });
    const gap = () => { clearTimeout(timer); timer = setTimeout(done, ROW_GAP_MS); };
    this.wake = done;
    this.onPixels = m => {
      const p = decodePixels(m);
      if (!p || p.round !== round) return;   // a late row from an earlier round: not counted
      this.stats.rows++;
      if (p.px) { this.put(p); got.add(p.row); this.dirty(); } else this.stats.skipped++;
      if (expect) { gap(); if (p.row === lastRow) done(); }
    };
    this.link.onPixels = this.onPixels;
    try {
      const info = await this.link.screenSync(this.known, round);
      if (this.supported === undefined && info) { this.supported = true; this.onSupport(true); }
      if (!info) return null;
      this.stats.syncs++;
      expect = [];
      for (let b = 0; b < BANDS; b++) if (info.bands >> b & 1) expect.push(b);
      if (!expect.length) return true;
      lastRow = expect[expect.length - 1] * BAND_ROWS + BAND_ROWS - 1;
      if (!got.has(lastRow)) { gap(); await finished; }
      if (gen !== this.gen) return true;
      for (const b of expect) {
        let all = true;
        for (let y = b * BAND_ROWS; y < (b + 1) * BAND_ROWS; y++) if (!got.has(y)) all = false;
        if (all) this.known[b] = info.hashes[b]; else this.stats.lost++;   // read again next round
      }
      this.stats.frames++;
      return 'more';
    } finally {
      clearTimeout(timer);
      if (this.link.onPixels === this.onPixels) this.link.onPixels = null;
      this.flush();
    }
  }
  /* FM-1_983/984 or Bluetooth: the hashes, then the changed bands' rows one request each. */
  async stepRows() {
    const gen = this.gen;
    const info = await this.link.screenInfo();
    if (this.supported === undefined) { this.supported = !!info; this.onSupport(this.supported); }
    if (!info) return false;
    this.stats.infos++;
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
  /* the canvas follows the rows as they come, at most once a display frame */
  dirty() {
    if (this.pending) return;
    this.pending = true;
    const f = () => this.flush();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(f); else setTimeout(f, 16);
  }
  flush() { this.pending = false; this.ctx.putImageData(this.img, 0, 0); }
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
