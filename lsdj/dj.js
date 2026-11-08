// SPDX-License-Identifier: GPL-3.0-only
// Perform's DJ layout: the maths, no page or MIDI (lsdj/dj-ui.js draws it; node tests/dj.mjs).
// Positions are in MIDI clocks (24 a beat, LSDj steps are sixteenths: 6 clocks a row), a bar is 4 beats.
//   - where a deck is in the bar, and how far it is from the master (wrapped to half a bar either way);
//   - Sync: the master's tempo, then a short speed-up or slow-down that closes the gap (a bend, never a jump:
//     LSDj on MIDI clock plays every clock it gets, so the page can only change how fast they come);
//   - the next beat or bar on the master, to start or kill on;
//   - crossfader curves, the DJ filter (one knob: low-pass to the left, high-pass to the right, off in the middle),
//     tap tempo.
import {PPQN, clampBpm} from './midiclock.js';

export const BEAT = PPQN, BAR = 4 * PPQN;
export const NUDGE = 0.04;              /* nudge: 4 % faster or slower while held */
export const SYNC_MAX_BEND = 0.08;      /* Sync never plays more than 8 % off the tempo */
export const SYNC_MIN_MS = 400;         /* ... and takes at least this long */

const mod = (a, n) => ((a % n) + n) % n;
/* clocks -> {bar, beat (0-3), frac (0-1 through the beat)}; null stays null */
export function position(clocks) {
  if (clocks == null) return null;
  const c = Math.max(0, clocks);
  return {bar: Math.floor(c / BAR), beat: Math.floor(mod(c, BAR) / BEAT), frac: mod(c, BEAT) / BEAT};
}
/* how many clocks the deck is behind the master (negative: ahead), wrapped to -BAR/2 .. BAR/2 */
export function offset(deck, master, unit = BAR) {
  if (deck == null || master == null) return null;
  const d = mod(master - deck, unit);
  return d >= unit / 2 ? d - unit : d;
}
/* Sync: the bend that closes `gap` clocks (offset()) at `bpm`: {factor, ms}; factor 1 when already there. */
export function syncBend(gap, bpm) {
  if (!gap) return {factor: 1, ms: 0};
  const clock = 60000 / (clampBpm(bpm) * PPQN);
  let ms = Math.max(SYNC_MIN_MS, Math.abs(gap) * clock / SYNC_MAX_BEND);
  return {factor: 1 + gap * clock / ms, ms};
}
/* the time of the master's next beat or bar (unit clocks) after `now`, given its phase now and tempo */
export function nextOn(masterPhase, bpm, now, unit = BAR) {
  if (masterPhase == null) return now;
  const clock = 60000 / (clampBpm(bpm) * PPQN), left = mod(-masterPhase, unit);
  return now + (left < 1e-9 || unit - left < 1e-9 ? 0 : left) * clock;
}

/* crossfader x 0 (all A) .. 1 (all B) -> [gain A, gain B] 0..1 */
export const CURVES = ['smooth', 'linear', 'cut'];
export function crossfade(x, curve = 'smooth') {
  const v = Math.min(1, Math.max(0, +x || 0));
  if (curve === 'linear') return [1 - v, v];
  if (curve === 'cut') return [v < 1 ? 1 : 0, v > 0 ? 1 : 0];   /* scratch style: both until the very end */
  return [Math.cos(v * Math.PI / 2), Math.sin(v * Math.PI / 2)];   /* constant power */
}
/* a 0..1 gain -> the FM-1's 0..127 */
export const level = g => Math.round(Math.min(1, Math.max(0, g)) * 127);

/* The DJ filter, one knob -64..63 (0 off) -> each channel's filter {type, cutoff, reso}: to the left low-pass with
   the cutoff coming down, to the right high-pass with it going up. Type numbers as fx-model.js (1 LP, 2 HP).
   reso: a little bite as it closes. A dead zone of ±2 around the middle is off. */
export function djFilter(k) {
  const v = Math.max(-64, Math.min(63, Math.round(+k || 0)));
  if (Math.abs(v) <= 2) return {type: 0, cutoff: 0, reso: 0};
  if (v < 0) return {type: 1, cutoff: Math.round(127 * (1 + v / 64) ** 1.5), reso: Math.round(-v / 64 * 40)};
  return {type: 2, cutoff: Math.round(127 * (v / 63) ** 0.75), reso: Math.round(v / 63 * 40)};
}

/* Tap tempo: tap(t) with each tap's time (ms) -> the tempo from the last 2..8 taps, or null; a gap over 2 s starts
   over. */
export function tapper() {
  let taps = [];
  return {
    tap(t) {
      if (taps.length && t - taps.at(-1) > 2000) taps = [];
      taps.push(t); if (taps.length > 8) taps.shift();
      if (taps.length < 2) return null;
      return clampBpm(Math.round(60000 * (taps.length - 1) / (taps.at(-1) - taps[0]) * 10) / 10);
    },
    reset() { taps = []; },
  };
}

/* the tempo of an outside clock (another device, a mixer, a DAW): feed(t) at each 0xF8 -> the tempo over the last
   beat (24 clocks), or null until there is one; a gap over 1 s starts over */
export function clockMeter() {
  let ts = [];
  return {
    feed(t) {
      if (ts.length && t - ts.at(-1) > 1000) ts = [];
      ts.push(t); if (ts.length > PPQN + 1) ts.shift();
      if (ts.length < PPQN + 1) return null;
      return Math.round(60000 / (ts.at(-1) - ts[0]) * 10) / 10;
    },
    reset() { ts = []; },
  };
}
