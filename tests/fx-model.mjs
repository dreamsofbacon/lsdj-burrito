// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import {PAGES, LEGACY_PAGES, pagesForFx, unpackFx, packFx, paramGet, paramSet, channelSummary} from '../lsdj/fx-model.js';

const setup = (layout, page, n = 17) => {
  const b = Array(4 * n).fill(0);
  b[35] = 6; b[36] = 5; b[37] = layout; b[38] = page; b[42] = 0xf2;
  return Array.from({length: n}, (_, i) => (b[4 * i] | b[4 * i + 1] << 8 | b[4 * i + 2] << 16 | b[4 * i + 3] << 24) >>> 0);
};
assert.deepEqual(PAGES.map(p => p.name), ['MASTER', 'FILTER', 'DRIVE', 'LFO', 'LO-FI', 'ECHO', 'ECHO MOD']);
assert.deepEqual(PAGES.map(p => p.knobs.map(k => k?.[1] ?? null)), [
  ['allFxOn', 'comp', null, null], ['fxOn', 'type', 'cutoff', 'reso'],
  ['drive', 'dist', 'warm', null], ['lfoRate', 'lfoDepth', 'lfoShape', 'lfoDest'],
  ['crush', 'decim', 'send', null], ['time', 'feedback', 'mix', 'tone'], ['wobble', 'sync', 'mode', 'freeze']
]);
const keys = PAGES.flatMap(p => p.knobs.filter(Boolean).map(k => k[1]));
assert.equal(keys.length, new Set(keys).size);
for (let page = 0; page < 7; page++) {
  const fx = unpackFx(setup(2, page));
  assert.equal(pagesForFx(fx), PAGES);
  for (let c = 0; c < 4; c++) {
    fx.ch[c].cutoff = 80; fx.q[c].warm = 40; fx.echo.mix = 90; fx.comp = 70;
    const original = structuredClone(fx);
    paramSet(fx, 'allFxOn', c, 0);
    assert.equal(paramGet(fx, 'allFxOn', (c + 1) % 4), 0);
    assert.match(channelSummary(fx, c), /All FX off/);
    const roundtrip = unpackFx(packFx(fx));
    assert.deepEqual(roundtrip, {...original, bypass: 1});
    paramSet(fx, 'allFxOn', c, 1);
    assert.deepEqual(fx, original);
  }
}
for (const n of [11, 17]) {
  for (let p = 0; p < (n === 11 ? 4 : 6); p++) {
    const words = setup(1, p, n), fx = unpackFx(words);
    assert.equal(pagesForFx(fx), LEGACY_PAGES);
    assert.equal(fx.page, n === 11 ? [0, 3, 4, 5][p] : p);
    assert.equal(fx.bypass, 0);
    assert.throws(() => paramSet(fx, 'allFxOn', 0, 0), /requires FM-1_975/);
    assert.deepEqual(packFx(fx), words);
  }
}
for (const malformed of [[], setup(2, 7), setup(2, 0, 11), [...setup(2, 0), 0]]) assert.throws(() => unpackFx(malformed));
const badFlag = setup(2, 0); badFlag[9] |= 2 << 24;
assert.throws(() => unpackFx(badFlag), /master effects/);
const oldKnobs = setup(1, 5); oldKnobs[10] |= 5;
assert.equal(unpackFx(oldKnobs).page, 0);
console.log('PASS FX model: exact seven-page mapping, global bypass/settings roundtrip, 11/17-word legacy layouts, invalid data');
