// SPDX-License-Identifier: GPL-3.0-only
// The page in the connected FM-1's theme: its 8 colours (fx-model.js PRESETS order: 4 LSDj
// shades lightest first, text, box dark, accent, empty bar) become the page's colour tokens.
// LSDj draws on the lightest shade with the darkest, so the page does too. Every pair the
// page relies on is checked for contrast and pushed toward the text colour if too faint.
// The result is kept in this browser (index.html applies it before the page draws).

const KEY = 'burrito.pageColours', OFF = 'burrito.pageTheme';
const rgb = c => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const css = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
/* c, moved toward `to` until it reaches `min` contrast against `on` (+0.1: colours get rounded) */
function readable(c, on, to, min) {
  for (let t = 0; t <= 1; t += 0.05) { const m = mix(c, to, t); if (contrast(m, on) >= min + 0.1) return m; }
  return to;
}
const BLACK = [0, 0, 0], WHITE = [255, 255, 255];

export function pageColours(theme) {
  const [g0, g1, g2, g3, , , accent] = theme.map(rgb);
  // As on the FM-1: the darkest shade behind, the lightest for text, the title row a light bar.
  const bg = g3;
  let lift = 0.2;   // cards: a step toward the next shade, if text still reads on them
  const card = () => mix(g3, g2, lift);
  const dark = lum(bg) < 0.18, away = dark ? WHITE : BLACK;
  let ink = readable(g0, card(), away, 7);
  while (lift > 0 && contrast(ink, card()) < 7.1) { lift -= 0.05; ink = readable(g0, card(), away, 7); }
  const c = card();
  // the theme accent; if it vanishes on the background, the theme's own lighter shades
  const acc = [accent, g1, g0].find(x => contrast(x, c) >= 3.1 && contrast(x, bg) >= 3.1) || readable(accent, c, ink, 3);
  const top = g0, topInk = readable(g3, top, contrast(top, BLACK) > contrast(top, WHITE) ? BLACK : WHITE, 7);
  const status = dark ? [[124, 195, 156], [224, 168, 74], [242, 134, 126]] : [[47, 111, 79], [154, 91, 0], [179, 38, 30]];
  const vars = {
    '--bg': bg, '--card': c, '--card2': mix(g3, g2, Math.max(0, lift) / 2),
    '--ink': ink, '--muted': readable(g1, c, ink, 4.5), '--line': mix(g3, g2, 0.6),
    '--accent': acc, '--accent-ink': contrast(acc, BLACK) >= contrast(acc, WHITE) ? BLACK : WHITE,
    '--ok': readable(status[0], c, ink, 4.5), '--warn': readable(status[1], c, ink, 4.5),
    '--bad': readable(status[2], c, ink, 4.5), '--top': top, '--top-ink': topInk,
    '--hi': acc, '--hi-ink': contrast(acc, BLACK) >= contrast(acc, WHITE) ? BLACK : WHITE
  };
  const out = {'color-scheme': dark ? 'dark' : 'light'};
  for (const [k, v] of Object.entries(vars)) out[k] = css(v);
  return out;
}

const root = globalThis.document?.documentElement;
const NAMES = Object.keys(pageColours(Array(8).fill(0)));
function set(vars) {
  if (!root) return;
  NAMES.forEach(k => root.style.removeProperty(k));
  Object.entries(vars || {}).forEach(([k, v]) => root.style.setProperty(k, v));
}
const store = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
export const matching = () => { try { return localStorage.getItem(OFF) !== 'off'; } catch { return true; } };

/* the FM-1's current theme (8 colours), or null: back to the page's own colours */
let last = null;
export function showDeviceTheme(theme) {
  if (theme) last = theme;
  if (!matching() || !last) return;
  const vars = pageColours(last);
  set(vars); store(KEY, JSON.stringify(vars));
}
export function setMatching(on) {
  store(OFF, on ? null : 'off');
  if (on) showDeviceTheme(null);
  else { set(null); store(KEY, null); }
}
