// SPDX-License-Identifier: GPL-3.0-only
// The firmware's data, as the page sees it. Mirrors firmware/lsdj_fx_ui.h
// (lsdj_fx_pack: 11 words), firmware/lsdj_settings.h (one word) and
// firmware/lsdj_theme.h (8 RGB565 colours).

export const CHANNELS = ['PU1', 'PU2', 'WAV', 'NOI'];
export const CH_PARAMS = [   // per channel, in the packed order
  {key: 'type', name: 'Filter', choices: ['Off', 'Low-pass', 'High-pass', 'Band-pass']},
  {key: 'cutoff', name: 'Cutoff'}, {key: 'reso', name: 'Resonance'}, {key: 'drive', name: 'Drive'},
  {key: 'crush', name: 'Crush'}, {key: 'decim', name: 'Decimate'}, {key: 'send', name: 'Echo send'}];
export const ECHO_PARAMS = [
  {key: 'time', name: 'Time'}, {key: 'feedback', name: 'Feedback'}, {key: 'mix', name: 'Mix'},
  {key: 'sync', name: 'Sync', choices: ['Free', 'Tempo']}, {key: 'mode', name: 'Mode', choices: ['Mono', 'Ping-pong']},
  {key: 'tone', name: 'Tone'}, {key: 'wobble', name: 'Wobble'}];
export const PAGES = ['FILTER', 'LO-FI', 'ECHO', 'ECHO MORE'];
const MARK = 0xF2;

const bytesOf = words => { const b = new Uint8Array(44); words.forEach((w, i) => { for (let j = 0; j < 4; j++) b[4 * i + j] = (w >>> (8 * j)) & 255; }); return b; };
const wordsOf = b => Array.from({length: 11}, (_, i) => (b[4 * i] | b[4 * i + 1] << 8 | b[4 * i + 2] << 16 | b[4 * i + 3] << 24) >>> 0);

export function unpackFx(words) {
  const b = bytesOf(words);
  if (b[42] !== MARK) throw Error('Not an effects setup from this firmware.');
  const ch = CHANNELS.map((_, c) => Object.fromEntries(CH_PARAMS.map((p, i) => [p.key, b[c * 7 + i]])));
  const echo = Object.fromEntries(ECHO_PARAMS.map((p, i) => [p.key, b[28 + i]]));
  return {ch, echo, fxOff: b[35], target: b[36], page: b[38] & 3};
}
export function packFx(fx) {
  const b = new Uint8Array(44);
  fx.ch.forEach((c, ci) => CH_PARAMS.forEach((p, i) => { b[ci * 7 + i] = c[p.key] & 127; }));
  ECHO_PARAMS.forEach((p, i) => { b[28 + i] = fx.echo[p.key] & 127; });
  b[35] = fx.fxOff & 15; b[36] = fx.target; b[37] = 1; b[38] = fx.page & 3; b[42] = MARK;
  return wordsOf(b);
}

export const THEMES = ['Classic', 'Pocket', 'Sunset', 'Ice', 'Bacon', 'Virtual', 'Midnight', 'Custom',
  'White Grey', 'Black Green', 'Black', 'Orange', 'Purple', 'White Blue', 'White Green'];   // the last 7: the FM-1 colourways
export const CUSTOM_THEME = 7;
export const PRESETS = [   // gb[4] (lightest first), text, dark, accent, empty bar
  [0xE7DA, 0x9D50, 0x5308, 0x18E3, 0xFFFF, 0x18E3, 0xFD20, 0x4208],
  [0xFFFF, 0xAD55, 0x52AA, 0x0000, 0xFFFF, 0x0000, 0xFD20, 0x4208],
  [0xFFBA, 0xD42E, 0x786D, 0x2087, 0xFFFF, 0x2087, 0x07FF, 0x4208],
  [0xDFFF, 0x6E9C, 0x3274, 0x1108, 0xFFFF, 0x1108, 0xF81F, 0x4208],
  [0xFF9B, 0xF48C, 0xA226, 0x3082, 0xFFFF, 0x3082, 0x07E0, 0x4208],
  [0xF800, 0xA800, 0x5000, 0x0000, 0xFFFF, 0x0000, 0x07FF, 0x4208],
  [0xB71F, 0x5C19, 0x29CF, 0x0843, 0xFFFF, 0x0843, 0xFD20, 0x4208],
  null,   // 7: Custom
  [0xE6FA, 0xBDB5, 0x4229, 0x2966, 0xFFFF, 0x2966, 0xDA63, 0x4208],
  [0x8E99, 0x6D95, 0x4229, 0x2104, 0xFFFF, 0x2104, 0xDA63, 0x4208],
  [0x94F4, 0x630C, 0x3186, 0x18E3, 0xFFFF, 0x18E3, 0xDA63, 0x4208],
  [0xE369, 0xBA24, 0x6123, 0x18E3, 0xFFFF, 0x18E3, 0x7677, 0x4208],
  [0xDD7A, 0xC417, 0x9B56, 0x51ED, 0xFFFF, 0x51ED, 0xDA63, 0x4208],
  [0xEF5C, 0xC618, 0x5371, 0x320A, 0xFFFF, 0x320A, 0xDA63, 0x4208],
  [0xEF5C, 0xAEB9, 0x7657, 0x4B8D, 0xFFFF, 0x4B8D, 0xDA63, 0x4208]];
export const COLOR_NAMES = ['Lightest', 'Light', 'Dark', 'Darkest', 'Text', 'Box dark', 'Accent', 'Empty bar'];

export const toHex = c => '#' + [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31]
  .map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
export const fromHex = h => { const v = parseInt(h.slice(1), 16), r = v >> 16, g = (v >> 8) & 255, b = v & 255;
  return (Math.round(r * 31 / 255) << 11) | (Math.round(g * 63 / 255) << 5) | Math.round(b * 31 / 255); };

export const SETTINGS = [
  {key: 'knobsSwapped', bits: [0, 1], name: 'PRESETS knob', choices: ['Up/Down', 'Left/Right']},
  {key: 'presetsRev', bits: [1, 1], name: 'PRESETS direction', choices: ['Normal', 'Reversed']},
  {key: 'algoRev', bits: [2, 1], name: 'ALGO direction', choices: ['Normal', 'Reversed']},
  {key: 'playIsSelect', bits: [3, 1], name: 'PLAY / REC', choices: ['PLAY = Start', 'PLAY = Select']},
  {key: 'selectKey', bits: [4, 2], name: 'Extra Select key', choices: ['Off', 'F#5', 'D#5']},
  {key: 'meter', bits: [6, 1], name: 'CPU meter', choices: ['Off', 'On']},
  {key: 'theme', bits: [7, 3], hi: 12, name: 'Theme', choices: THEMES},   // hi: the value's top bit (themes 8+)
  {key: 'popup', bits: [13, 2], name: 'Pop-up time (effects panel, messages)', choices: ['1.5 s', '3 s', '5 s', '10 s']},
  {key: 'bluetooth', bits: [10, 2], name: 'Bluetooth', choices: ['Off', 'Device']}];
/* The MIDI options (firmware/lsdj_midi.h, one word with 'M' on top; save-store record 16). */
const CH16 = Array.from({length: 16}, (_, i) => `Channel ${i + 1}`);
export const MIDI_SETTINGS = [
  {key: 'clockIn', bits: [0, 3], name: 'Clock in', choices: ['Off', 'All', 'USB', 'TRS', 'Bluetooth']},
  {key: 'transport', bits: [3, 1], name: 'Transport (Start/Stop)', choices: ['Off', 'On']},
  {key: 'delay', bits: [4, 2], name: 'Sync delay', choices: ['100 ms', '75 ms', '50 ms']},
  {key: 'noteIn', bits: [6, 5], name: 'Note in (SYNC KEYBD)', choices: ['Off', 'All', ...CH16]},
  {key: 'ccFx', bits: [11, 4], name: 'CC to effects', choices: ['Off', ...Array.from({length: 13}, (_, i) => `Channels ${i + 1}-${i + 4}`)]},
  {key: 'clockOut', bits: [15, 2], name: 'Clock out (SYNC LSDJ)', choices: ['Off', 'USB', 'Bluetooth', 'USB + Bluetooth']},
  {key: 'pcCue', bits: [17, 1], name: 'Program change cues row', choices: ['Off', 'On']}];
/* CC -> effects (lsdj_midi_cc_apply): per channel, and the echo on any of the four */
export const MIDI_CC_MAP = [
  [70, 'Filter type (0-31 off, 32-63 LP, 64-95 HP, 96-127 BP)'], [71, 'Resonance'], [74, 'Cutoff'], [75, 'Drive'],
  [76, 'Crush'], [77, 'Decimate'], [91, 'Echo send'], [80, 'Channel FX on (64+)'], [81, 'Mute (64+)'],
  [12, 'Echo time'], [13, 'Echo feedback'], [14, 'Echo mix'], [15, 'Echo tone'], [16, 'Echo wobble'],
  [17, 'Echo sync (64+)'], [18, 'Echo ping-pong (64+)'], [19, 'Freeze (64+)']];
export function unpackMidi(v) {
  if (v >>> 24 !== 0x4D) throw Error('Not a MIDI options word from this firmware.');
  return Object.fromEntries(MIDI_SETTINGS.map(s => [s.key, (v >>> s.bits[0]) & ((1 << s.bits[1]) - 1)]));
}
export function packMidi(o) {
  let v = 0x4D000000;
  for (const s of MIDI_SETTINGS) v |= (o[s.key] & ((1 << s.bits[1]) - 1)) << s.bits[0];
  return v >>> 0;
}
export function unpackSettings(v) {
  if (v >>> 24 !== 0x5A) throw Error('Not a settings word from this firmware.');
  return Object.fromEntries(SETTINGS.map(s => [s.key, ((v >>> s.bits[0]) & ((1 << s.bits[1]) - 1)) | (s.hi ? ((v >>> s.hi) & 1) << s.bits[1] : 0)]));
}
export function packSettings(o) {
  let v = 0x5A000000;
  for (const s of SETTINGS) {
    v |= (o[s.key] & ((1 << s.bits[1]) - 1)) << s.bits[0];
    if (s.hi) v |= ((o[s.key] >> s.bits[1]) & 1) << s.hi;
  }
  return v >>> 0;
}
