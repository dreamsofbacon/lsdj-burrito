// SPDX-License-Identifier: GPL-3.0-only
// lsdj/mixers.js: mixer presets, MIDI learn (node tests/mixers.mjs).
import assert from 'node:assert/strict';
import {PRESETS, preset, readMidi, actionFor, out, learnRule, saveLearned, loadLearned} from '../lsdj/mixers.js';

/* messages */
assert.deepEqual(readMidi([0xB0, 7, 100]), {type: 'cc', ch: 1, num: 7, v: 100});
assert.deepEqual(readMidi([0x95, 60, 0]), {type: 'note', ch: 6, num: 60, v: 0});
assert.deepEqual(readMidi([0x81, 60, 64]), {type: 'note', ch: 2, num: 60, v: 0}, 'note off: 0');
assert.deepEqual(readMidi([0xC6, 3]), {type: 'pc', ch: 7, num: 3, v: 127});
assert.equal(readMidi([0xF8]), null); assert.equal(readMidi(null), null);

/* every preset well formed; unknown id: no mixer */
assert.deepEqual(PRESETS.map(p => p.id), ['none', 'tx6', 'sidekick', 'generic', 'learn']);
assert.equal(preset('nope').id, 'none');
for (const p of PRESETS) assert.ok(p.name && p.channels > 0 && Array.isArray(p.in));

/* TX-6: controller mode in (decks on tracks 3 and 5) */
{ const p = preset('tx6'), map = [3, 5], a = m => actionFor(p, readMidi(m), map);
  assert.deepEqual(a([0xB0, 3, 127]), {act: 'fader', ch: 3, deck: 0, v: 1});
  assert.deepEqual(a([0xB0, 1, 0]), {act: 'fader', ch: 1, deck: null, v: 0}, 'a fader not on a deck: still shown');
  assert.deepEqual(a([0xB0, 11, 0]), {act: 'filter', ch: 5, deck: 1, v: -64});
  assert.deepEqual(a([0xB0, 9, 64]), {act: 'filter', ch: 3, deck: 0, v: 0});
  assert.equal(a([0xB0, 7, 64]), null, 'a filter knob of a track no deck is on: nothing');
  assert.deepEqual(a([0xB0, 27, 127]), {act: 'start', ch: 3, deck: 0, v: 1});
  assert.equal(a([0xB0, 27, 0]), null, 'a button let go: nothing');
  assert.equal(a([0xB1, 3, 127]), null, 'another channel: not the TX-6');
  /* out: its own CCs */
  assert.deepEqual(out(p, 'fader', 3, 1), [[0xB2, 7, 127]]);
  assert.deepEqual(out(p, 'fader', 6, 0.5), [[0xB5, 7, 64]]);
  assert.deepEqual(out(p, 'filter', 1, -64), [[0xB0, 74, 0]]);
  assert.deepEqual(out(p, 'fx', 2, 1), [[0xB1, 91, 127]]);
  assert.deepEqual(out(p, 'play'), [[0xB6, 46, 127]]);
  assert.deepEqual(out(p, 'tempo', -2), [[0xB6, 47, 62]]);
  assert.deepEqual(out(p, 'tempo', 500), [[0xB6, 47, 127]], 'clamped'); }

/* K.O.-sidekick: two channels, the fx button held */
{ const p = preset('sidekick'), a = m => actionFor(p, readMidi(m));
  assert.deepEqual(a([0xB1, 7, 127]), {act: 'fader', ch: 2, deck: 1, v: 1});
  assert.deepEqual(a([0xB0, 14, 127]), {act: 'echo', ch: 1, deck: 0, v: 1});
  assert.deepEqual(a([0xB0, 14, 0]), {act: 'echo', ch: 1, deck: 0, v: 0}, 'a hold: the release counts');
  assert.deepEqual(a([0xB1, 3, 127]), {act: 'cue', ch: 2, deck: 1, v: 1});
  assert.deepEqual(out(p, 'fader', 2, 0), [[0xB1, 7, 0]]);
  assert.deepEqual(out(p, 'play'), [], 'no transport: nothing'); }

/* generic: PLAY and STOP both the master button */
{ const p = preset('generic');
  assert.deepEqual(actionFor(p, readMidi([0xB0, 41, 127])), {act: 'play', v: 1});
  assert.deepEqual(actionFor(p, readMidi([0xB0, 17, 127])), {act: 'filter', ch: 2, deck: 1, v: 63}); }

/* no mixer: nothing in, nothing out */
assert.equal(actionFor(preset('none'), readMidi([0xB0, 7, 1])), null);
assert.deepEqual(out(preset('none'), 'fader', 1, 1), []);

/* MIDI learn: a knob for deck B's filter, a button for deck A's start, a note for the crossfader... */
{ const knob = learnRule(readMidi([0xB3, 20, 37]), {act: 'filter', deck: 1});
  assert.deepEqual(knob, {type: 'cc', ch: 4, num: 20, act: 'filter', deck: 1});
  const btn = learnRule(readMidi([0x90, 36, 127]), {act: 'start', deck: 0});
  assert.ok(btn.press && !btn.hold);
  const hold = learnRule(readMidi([0xB0, 50, 127]), {act: 'echo', deck: 1}, [0]);
  assert.ok(hold.press && hold.hold, 'a CC sending only 0 / 127 is a button');
  const xf = learnRule(readMidi([0xB0, 8, 10]), {act: 'xfader'});
  const learned = loadLearned(saveLearned([knob, btn, hold, xf, null, {bad: 1}]));
  assert.equal(learned.length, 4, 'saved and read back; junk left out');
  const p = preset('learn'), a = m => actionFor(p, readMidi(m), [1, 2], learned);
  assert.deepEqual(a([0xB3, 20, 0]), {act: 'filter', deck: 1, v: -64});
  assert.deepEqual(a([0x90, 36, 100]), {act: 'start', deck: 0, v: 1});
  assert.equal(a([0x90, 36, 0]), null);
  assert.deepEqual(a([0xB0, 50, 0]), {act: 'echo', deck: 1, v: 0});
  assert.deepEqual(a([0xB0, 8, 127]), {act: 'xfader', v: 1});
  assert.deepEqual(loadLearned('{not json'), []); }

console.log('PASS mixers: MIDI messages, presets (TX-6, K.O.-sidekick, generic, none), actions in, messages out, MIDI learn');
