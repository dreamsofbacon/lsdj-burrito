// SPDX-License-Identifier: GPL-3.0-only
// Perform's DJ layout: mixers as data (node tests/mixers.mjs). A preset says what the mixer's controls do on the page
// (input: MIDI from the mixer -> an action) and how the page sets the mixer (output: an action -> MIDI to it).
// The audio always goes through the mixer; the page never needs it. Channels below are 1-16 as mixers print them.
//   Teenage Engineering TX-6 (teenage.engineering/guides/tx-6, "midi reference"): it takes CCs on channels 1-6
//     (track n): 7 volume, 74 filter, 91 FX I send, 94 aux II send; channel 7: 46 start/stop toggle, 47 tempo
//     relative (64 = 0). In controller mode it sends on channel 1: faders CC 1-6, upper / middle / lower knobs
//     CC 7-12 / 13-18 / 19-24, track buttons CC 25-30 (0 / 127). (unverified: whether it mixes in controller mode,
//     its MIDI clock)
//   Teenage Engineering K.O.-sidekick EP-136 (teenage.engineering/guides/ep-136, "midi note map"): channels 1-2
//     (ch 1 / ch 2): it takes CC 7 fader, CC 1 fx amount; its controller mode sends CC 7 fader, CC 14 fx button,
//     CC 3 cue button, CC 22-24 EQ. (unverified: its MIDI clock; no crossfader)
//   Generic: a fader box laid out like a Korg nanoKONTROL2's CC mode (faders CC 0-7, knobs CC 16-23, S / M / R
//     buttons CC 32-39 / 48-55 / 64-71, PLAY CC 41, STOP CC 42, channel 1) (unverified against Korg's guide).
//   Pioneer DJM, Allen & Heath Xone: no built-in map yet (their MIDI lists couldn't be checked): MIDI learn.
// Actions (deck: 0 = A, 1 = B; ch: the mixer channel):
//   in:  fader {ch, v 0-1}, xfader {v}, filter {deck, v -64..63}, echo {deck, v 0-1}, reverb {deck, v 0-1},
//        start {deck} (a press), cue {deck} (a press), play (a press: master Play / Stop), tempo {delta bpm}
//   out: fader (ch, v 0-1), filter (ch, v -64..63), fx (ch, v 0-1), play (), tempo (delta)

/* a MIDI message -> {type: 'cc'|'note'|'pc', ch 1-16, num, v 0-127} or null */
export function readMidi(data) {
  if (!data || data.length < 2) return null;
  const s = data[0] & 0xF0, ch = (data[0] & 15) + 1;
  if (s === 0xB0 && data.length >= 3) return {type: 'cc', ch, num: data[1], v: data[2]};
  if (s === 0x90 && data.length >= 3) return {type: 'note', ch, num: data[1], v: data[2]};
  if (s === 0x80 && data.length >= 3) return {type: 'note', ch, num: data[1], v: 0};
  if (s === 0xC0) return {type: 'pc', ch, num: data[1], v: 127};
  return null;
}
const cc = (ch, num, v) => [0xB0 | (ch - 1), num & 127, Math.max(0, Math.min(127, Math.round(v)))];
const unit = v => v / 127, bipolar = v => Math.max(-64, Math.min(63, v - 64));
const deckOf = (map, ch) => { const d = map.indexOf(ch); return d < 0 ? null : d; };

/* in: one rule per control: {type, ch, num (or nums: a run, one per channel 1..), act, ...}; press: only v >= 64 */
function rules(list) { return list; }
export const PRESETS = [
  {id: 'none', name: 'No MIDI mixer (on-screen)', channels: 2, verified: true, in: [], out: null},
  {id: 'tx6', name: 'Teenage Engineering TX-6', channels: 6, verified: false,
    note: 'Its controller mode sends the faders, knobs and track buttons; the page sets its volume, filter and FX send for each track.',
    in: rules([
      {type: 'cc', ch: 1, nums: [1, 2, 3, 4, 5, 6], act: 'fader'},
      {type: 'cc', ch: 1, nums: [7, 8, 9, 10, 11, 12], act: 'filter'},
      {type: 'cc', ch: 1, nums: [13, 14, 15, 16, 17, 18], act: 'echo'},
      {type: 'cc', ch: 1, nums: [19, 20, 21, 22, 23, 24], act: 'reverb'},
      {type: 'cc', ch: 1, nums: [25, 26, 27, 28, 29, 30], act: 'start', press: true}]),
    out: {fader: (ch, v) => [cc(ch, 7, v * 127)], filter: (ch, v) => [cc(ch, 74, v + 64)], fx: (ch, v) => [cc(ch, 91, v * 127)],
          play: () => [cc(7, 46, 127)], tempo: d => [cc(7, 47, 64 + Math.max(-64, Math.min(63, Math.round(d))))]}},
  {id: 'sidekick', name: 'Teenage Engineering K.O.–sidekick', channels: 2, verified: false,
    note: 'Two channels; it has no crossfader, so the page\'s crossfader sets its two faders.',
    in: rules([
      {type: 'cc', chs: [1, 2], num: 7, act: 'fader'},
      {type: 'cc', chs: [1, 2], num: 14, act: 'echo', press: true, hold: true},
      {type: 'cc', chs: [1, 2], num: 3, act: 'cue', press: true}]),
    out: {fader: (ch, v) => [cc(ch, 7, v * 127)], fx: (ch, v) => [cc(ch, 1, v * 127)]}},
  {id: 'generic', name: 'Generic fader box (nanoKONTROL2 layout)', channels: 8, verified: false,
    note: 'Faders 1-2: decks A and B, knob 1-2: DJ filter, S: start, M: echo throw (hold), R: cue; PLAY / STOP: master.',
    in: rules([
      {type: 'cc', ch: 1, nums: [0, 1], act: 'fader'},
      {type: 'cc', ch: 1, nums: [16, 17], act: 'filter'},
      {type: 'cc', ch: 1, nums: [32, 33], act: 'start', press: true},
      {type: 'cc', ch: 1, nums: [48, 49], act: 'echo', press: true, hold: true},
      {type: 'cc', ch: 1, nums: [64, 65], act: 'cue', press: true},
      {type: 'cc', ch: 1, num: 41, act: 'play', press: true},
      {type: 'cc', ch: 1, num: 42, act: 'play', press: true}]),
    out: null},
  {id: 'learn', name: 'My mixer (MIDI learn)', channels: 6, verified: true, in: [], out: null,
    note: 'For Pioneer DJM, Allen & Heath Xone and any other mixer or controller: press Learn, move a control, then click what it should do.'},
];
export const preset = id => PRESETS.find(p => p.id === id) || PRESETS[0];

/* A mixer message -> an action {act, ch?, deck?, v?} or null. map: the mixer channel of each deck ([A, B], 1-based),
   learned: the rules MIDI learn made (same form). Knob and fader values become 0-1, a filter -64..63; a button
   press is v 1, a release (for a hold) v 0. */
export function actionFor(p, msg, map = [1, 2], learned = []) {
  if (!msg) return null;
  for (const r of [...(p.in || []), ...learned]) {
    if (r.type !== msg.type) continue;
    let ch;   /* the mixer channel this control belongs to (a run of numbers, or one rule on several channels) */
    if (r.nums) { const i = r.nums.indexOf(msg.num); if (i < 0 || r.ch !== msg.ch) continue; ch = i + 1; }
    else if (r.chs) { if (r.num !== msg.num || !r.chs.includes(msg.ch)) continue; ch = msg.ch; }
    else { if (r.num !== msg.num || r.ch !== msg.ch) continue; ch = r.mixCh ?? null; }
    const on = msg.v >= 64;
    if (r.press && !on && !r.hold) return null;
    const a = {act: r.act};
    if (ch != null) a.ch = ch;
    if (r.deck != null) a.deck = r.deck; else if (ch != null) a.deck = deckOf(map, ch);
    if (['fader', 'xfader', 'echo', 'reverb'].includes(r.act)) a.v = r.press ? (on ? 1 : 0) : unit(msg.v);
    else if (r.act === 'filter') a.v = bipolar(msg.v);
    else if (r.act === 'tempo') a.v = bipolar(msg.v);
    else a.v = on ? 1 : 0;
    if (['filter', 'echo', 'reverb', 'start', 'cue'].includes(r.act) && a.deck == null) return null;   /* not a deck's */
    return a;
  }
  return null;
}
/* the messages that set the mixer (empty when it can't): out(p, 'fader', ch, v) ... */
export function out(p, what, ...args) {
  const f = p.out?.[what];
  return f ? f(...args) : [];
}

/* MIDI learn: a message moved -> a rule for the chosen action ({act, deck} or {act: 'xfader'} ...); a button
   (note, or a CC that only sent 0 / 127) is a press. Kept by the page in localStorage as JSON. */
export function learnRule(msg, action, seen = []) {
  if (!msg) return null;
  const vals = new Set([...seen, msg.v]);
  const button = msg.type !== 'cc' || [...vals].every(v => v === 0 || v === 127);
  const r = {type: msg.type, ch: msg.ch, num: msg.num, act: action.act};
  if (action.deck != null) r.deck = action.deck;
  if (action.mixCh != null) r.mixCh = action.mixCh;
  if (button && ['start', 'cue', 'play', 'echo', 'reverb'].includes(action.act)) { r.press = true; if (action.act === 'echo' || action.act === 'reverb') r.hold = true; }
  return r;
}
export function saveLearned(list) { return JSON.stringify(list.filter(r => r && r.type && r.act)); }
export function loadLearned(text) {
  try { const l = JSON.parse(text || '[]'); return Array.isArray(l) ? l.filter(r => r && typeof r.num === 'number' && typeof r.act === 'string') : []; }
  catch { return []; }
}
