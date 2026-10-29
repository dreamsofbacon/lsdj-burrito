// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import {PAGES, PAGES_978, LEGACY_PAGES, pagesForFx, firmwareNumber, unpackFx, packFx, paramGet, paramSet, channelSummary,
        FEATURES, FEATURE_DEFAULTS, packFeatures, unpackFeatures, MIDI_CC_MAP, THEMES} from '../lsdj/fx-model.js';

const setup = (layout, page, n = 17) => {
  const b = Array(4 * n).fill(0);
  b[35] = 6; b[36] = 5; b[37] = layout; b[38] = page; b[42] = 0xf2;
  return Array.from({length: n}, (_, i) => (b[4 * i] | b[4 * i + 1] << 8 | b[4 * i + 2] << 16 | b[4 * i + 3] << 24) >>> 0);
};
assert.deepEqual(PAGES.map(p => p.name), ['MASTER', 'FILTER', 'DRIVE', 'LFO', 'LO-FI', 'ECHO', 'ECHO MOD']);
/* FM-1_979: echo send on FILTER K2 (next to Channel FX), filter type on LO-FI K3; 975-978 the other way round */
assert.deepEqual(PAGES.map(p => p.knobs.map(k => k?.[1] ?? null)), [
  ['allFxOn', 'comp', null, null], ['fxOn', 'send', 'cutoff', 'reso'],
  ['drive', 'dist', 'warm', null], ['lfoRate', 'lfoDepth', 'lfoShape', 'lfoDest'],
  ['crush', 'decim', 'type', null], ['time', 'feedback', 'mix', 'tone'], ['wobble', 'sync', 'mode', 'freeze']
]);
assert.deepEqual(PAGES_978.map(p => p.knobs.map(k => k?.[1] ?? null))[1], ['fxOn', 'type', 'cutoff', 'reso']);
assert.deepEqual(PAGES_978.map(p => p.knobs.map(k => k?.[1] ?? null))[4], ['crush', 'decim', 'send', null]);
for (const pages of [PAGES, PAGES_978]) {
  const keys = pages.flatMap(p => p.knobs.filter(Boolean).map(k => k[1]));
  assert.equal(keys.length, new Set(keys).size);
}
assert.equal(firmwareNumber('FM-1_979'), 979); assert.equal(firmwareNumber('FM-1_978'), 978); assert.equal(firmwareNumber('GameDude'), 0);
{ const v3 = unpackFx(setup(2, 1));
  assert.equal(pagesForFx(v3, 979), PAGES); assert.equal(pagesForFx(v3, 980), PAGES); assert.equal(pagesForFx(v3, 978), PAGES_978);
  assert.equal(pagesForFx(v3, 975), PAGES_978); assert.equal(pagesForFx(v3), PAGES); }
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
/* The feature switches (firmware/lsdj_feat.h): the defaults are the firmware's, every value round-trips,
   unknown bits and values are refused. */
assert.equal(packFeatures(FEATURE_DEFAULTS), 0x460001CE);
assert.deepEqual(unpackFeatures(0x460001CE), FEATURE_DEFAULTS);
for (const f of FEATURES) for (let v = 0; v < f.choices.length; v++) {
  const o = {...FEATURE_DEFAULTS, [f.key]: v};
  assert.deepEqual(unpackFeatures(packFeatures(o)), o);
}
assert.equal(FEATURES.find(f => f.key === 'fxTheme').choices.length, THEMES.length + 1);
assert.throws(() => unpackFeatures(0x4D0001CE), /Not a feature/);
assert.throws(() => unpackFeatures(0x460001CE | 1 << 16), /Unknown/);
assert.throws(() => unpackFeatures(0x460001CE | (THEMES.length + 1) << 9), /Unknown/);
/* The CC map: every CC the firmware takes (firmware/lsdj_midi.h lsdj_midi_cc_num), once */
assert.deepEqual(MIDI_CC_MAP.map(m => m[0]).sort((a, b) => a - b),
  [70, 71, 74, 75, 76, 77, 91, 80, 81, 12, 13, 14, 15, 16, 17, 18, 19, 72, 73, 78, 79, 82, 83, 20].sort((a, b) => a - b));
assert.ok(MIDI_CC_MAP.every(m => m[2] === 'channel' || m[2] === 'shared'));
console.log('PASS FX model: seven-page mapping (979 and 975-978), global bypass/settings roundtrip, 11/17-word legacy layouts, invalid data, feature switches, CC map');
