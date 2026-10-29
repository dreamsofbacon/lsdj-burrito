// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's screen on the page (FM-1_983 and newer): the 160x144 picture its LCD shows, the
// effects panels included, read over the link (firmware/lsdj_link.h SCREEN_INFO / SCREEN_ROW).
// View only. The firmware hashes each 8-row band; only bands whose hash changed are read again,
// a row at a time (its colours + 4-bit indices), so a cursor move costs a few rows.
export const W = 160, H = 144, BANDS = 18, BAND_ROWS = 8;

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

/* Which bands to read again: those whose hash differs from the one last read (all at first). */
export const changedBands = (known, hashes) => hashes.map((h, b) => b).filter(b => known[b] !== hashes[b]);

export class ScreenMirror {
  /* link: lsdj/link.js Link. canvas: 160x144. active(): poll now? (tab shown, nothing else busy).
     onSupport(ok): told once whether the firmware has the screen (false: before FM-1_983). */
  constructor(link, canvas, {active = () => true, onSupport = () => {}, every = 100} = {}) {
    Object.assign(this, {link, canvas, active, onSupport, every});
    this.known = new Array(BANDS).fill(null);
    this.ctx = canvas.getContext('2d');
    this.img = this.ctx.createImageData(W, H);
    this.stats = {infos: 0, rows: 0, skipped: 0, frames: 0};
    this.gen = 0; this.running = false;   // gen: a stop (or a new start) ends the loop and round under way
  }
  start() { if (this.running) return; this.running = true; this.loop(++this.gen); }
  stop() { this.running = false; this.gen++; clearTimeout(this.timer); }
  async loop(gen) {
    while (gen === this.gen && !this.link.closed) {
      if (this.active()) {
        try { if (await this.step() === false) { this.stop(); return; } }
        catch { /* a missed reply: next round */ }
      }
      if (gen !== this.gen) return;
      await new Promise(r => { this.timer = setTimeout(r, this.every); });
    }
    if (gen === this.gen) this.running = false;
  }
  /* One round: the hashes, then the changed bands' rows. false: the firmware has no screen. */
  async step() {
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
