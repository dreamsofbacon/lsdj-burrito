// node tests/page-theme.mjs: every preset theme gives the page readable colours.
import {pageColours} from '../lsdj/page-theme.js';
import {PRESETS, THEMES} from '../lsdj/fx-model.js';
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const cr = (a, b) => { const x = lum(hex(a)), y = lum(hex(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const need = [['--ink', '--card', 4.5], ['--ink', '--bg', 4.5], ['--muted', '--card', 4.5], ['--muted', '--bg', 3],
  ['--accent', '--card', 3], ['--accent-ink', '--accent', 4.5], ['--top-ink', '--top', 4.5],
  ['--hi-ink', '--hi', 4.5], ['--ok', '--card', 4.5], ['--warn', '--card', 4.5], ['--bad', '--card', 4.5]];
let n = 0, worst = {};
PRESETS.forEach((p, i) => {
  if (!p) return;
  const v = pageColours(p); n++;
  for (const [a, b, min] of need) {
    const c = cr(v[a], v[b]);
    if (c < min) throw Error(`${THEMES[i]}: ${a} on ${b} contrast ${c.toFixed(2)} < ${min}`);
    const k = `${a}/${b}`; if (!worst[k] || c < worst[k][0]) worst[k] = [+c.toFixed(2), THEMES[i]];
  }
});
console.log('lowest:', JSON.stringify(worst));
console.log(`PASS page theme: ${n} presets readable`);
