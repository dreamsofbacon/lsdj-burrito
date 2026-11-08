// SPDX-License-Identifier: GPL-3.0-only
// lsdj/dj.js: the DJ layout's maths (node tests/dj.mjs).
import assert from 'node:assert/strict';
import {BEAT, BAR, position, offset, syncBend, nextOn, crossfade, level, djFilter, tapper, clockMeter, SYNC_MAX_BEND, SYNC_MIN_MS} from '../lsdj/dj.js';
import {PPQN} from '../lsdj/midiclock.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

/* where in the bar */
assert.equal(BEAT, 24); assert.equal(BAR, 96);
assert.deepEqual(position(0), {bar: 0, beat: 0, frac: 0});
assert.deepEqual(position(96 + 36), {bar: 1, beat: 1, frac: 0.5});
assert.equal(position(null), null);
assert.deepEqual(position(-5), {bar: 0, beat: 0, frac: 0}, 'before the first clock: the start');

/* how far from the master, half a bar either way */
assert.equal(offset(10, 10), 0);
assert.equal(offset(10, 16), 6, 'behind by a row');
assert.equal(offset(16, 10), -6, 'ahead by a row');
assert.equal(offset(95, 1), 2, 'across the bar line');
assert.equal(offset(1, 95), -2);
assert.equal(offset(0, 48), -48, 'half a bar: either way, one answer');
assert.equal(offset(1000 * BAR + 3, 7), 4, 'bars apart do not matter');
assert.equal(offset(null, 3), null);

/* Sync: a bend that makes up the gap, gently */
{ assert.deepEqual(syncBend(0, 120), {factor: 1, ms: 0});
  const clock = 60000 / (120 * PPQN);
  for (const gap of [1, 6, -6, 47, -48]) {
    const {factor, ms} = syncBend(gap, 120);
    assert.ok(ms >= SYNC_MIN_MS && Math.abs(factor - 1) <= SYNC_MAX_BEND + 1e-9, `gap ${gap}: within the limits`);
    assert.ok(near((factor - 1) * ms / clock, gap, 1e-6), `gap ${gap}: made up exactly`);
    assert.equal(Math.sign(factor - 1), Math.sign(gap), 'behind: faster; ahead: slower');
  } }

/* the master's next beat / bar */
{ const clock = 60000 / (120 * PPQN);
  assert.ok(near(nextOn(90, 120, 1000), 1000 + 6 * clock));
  assert.ok(near(nextOn(96 * 3, 120, 1000), 1000), 'on the bar: now');
  assert.ok(near(nextOn(30, 120, 0, BEAT), 18 * clock), 'the next beat');
  assert.equal(nextOn(null, 120, 50), 50, 'no master: now'); }

/* crossfader */
assert.deepEqual(crossfade(0, 'linear'), [1, 0]); assert.deepEqual(crossfade(1, 'linear'), [0, 1]);
{ const [a, b] = crossfade(0.5); assert.ok(near(a * a + b * b, 1), 'smooth: constant power'); assert.ok(near(a, b)); }
assert.deepEqual(crossfade(0.5, 'cut'), [1, 1]); assert.deepEqual(crossfade(0, 'cut'), [1, 0]); assert.deepEqual(crossfade(1, 'cut'), [0, 1]);
assert.deepEqual(crossfade(-3, 'linear'), [1, 0], 'clamped');
assert.equal(level(1), 127); assert.equal(level(0), 0); assert.equal(level(2), 127);

/* DJ filter: off in the middle, LP closing to the left, HP opening to the right */
assert.deepEqual(djFilter(0), {type: 0, cutoff: 0, reso: 0}); assert.deepEqual(djFilter(2), {type: 0, cutoff: 0, reso: 0});
{ const l1 = djFilter(-10), l2 = djFilter(-60), r1 = djFilter(10), r2 = djFilter(63);
  assert.ok(l1.type === 1 && l2.type === 1 && l1.cutoff > l2.cutoff, 'left: low-pass, darker further');
  assert.ok(r1.type === 2 && r2.type === 2 && r1.cutoff < r2.cutoff && r2.cutoff === 127, 'right: high-pass, thinner further');
  assert.equal(djFilter(-64).cutoff, 0);
  for (const v of [-64, -30, 5, 63, 200, -200]) { const f = djFilter(v); assert.ok(f.cutoff >= 0 && f.cutoff <= 127 && f.reso >= 0 && f.reso <= 127); } }

/* tap tempo */
{ const t = tapper();
  assert.equal(t.tap(0), null);
  assert.equal(t.tap(500), 120);
  t.tap(1000); assert.equal(t.tap(1500), 120);
  assert.equal(t.tap(4000), null, 'a long pause starts over');
  assert.equal(t.tap(4400), 150); }

/* an outside clock's tempo */
{ const m = clockMeter(), clock = 60000 / (128 * PPQN); let r = null;
  for (let i = 0; i <= 24; i++) r = m.feed(i * clock);
  assert.equal(r, 128);
  assert.equal(m.feed(24 * clock + 2000), null, 'stopped: starts over'); }

console.log('PASS DJ maths: bar position, offset to the master, Sync bend, next beat / bar, crossfader curves, DJ filter, tap tempo, clock tempo');
