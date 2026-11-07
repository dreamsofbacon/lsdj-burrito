// SPDX-License-Identifier: GPL-3.0-only
// The virtual FM-1's front: where every control sits (true to the device, in a landscape and a phone
// layout) and its picture, drawn here instead of with fm1-emu's built-in panel. The geometry follows the
// FM-1 itself (161.5 x 96.5 mm) as measured for the Hortator simulator (GPL-3.0, refs/hortator/web/sim/
// layout.js). Which control is which comes from fm1-emu's own panel (ui.panel_hit), so the ids the
// emulator expects stay right.

// Control ids (as the emulator's key matrix): 0 OCT-, 1 OCT+, 2..7 FX SEL ENV LFO EDIT GLO,
// 8..13 HOME SAVE ARP SEQ PLAY REC, 14..40 the keys F3..G5. Knobs (fm1-emu's order): 0 SELECT,
// 1 PRESETS, 2 ALGORITHM, 3..6 KNOB1..4, 7 MASTER (the volume pot).
export const BUTTONS = ['OCT-', 'OCT+', 'FX', 'SEL', 'ENV', 'LFO', 'EDIT', 'GLO',
  'HOME', 'SAVE', 'ARP', 'SEQ', 'PLAY', 'REC'];
export const KNOBS = ['SELECT', 'PRESETS', 'ALGORITHM', 'KNOB1', 'KNOB2', 'KNOB3', 'KNOB4', 'MASTER'];
const UPPER_SILK = ['OP1', 'OP2', 'OP3', 'OP4', 'OP5', 'OP6', 'PIT', 'GLO', 'MONO', 'POLY', ''];
const KEY0 = 14, KEYS = 27;
const isBlack = k => [1, 3, 5, 8, 10].includes(k % 12);   // F3 = 0: F# G# A# C# D#
const BLACKS = [...Array(KEYS).keys()].filter(isBlack);

/* fm1-emu's panel: each control's box, checked against the FM-1's 14 buttons, 27 keys and 8 knobs. */
export function scanControls(ui) {
  ui.panel_board(0);
  const W = ui.panel_width(), H = ui.panel_height(), box = new Map();
  for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
    const id = ui.panel_hit(x, y);
    if (id < 0) continue;
    const b = box.get(id) || [x, y, x, y];
    b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
    box.set(id, b);
  }
  const keys = [], buttons = [];
  for (const [id, b] of box) {
    if (id >= 100 + KEY0 && id < 100 + KEY0 + KEYS) keys.push([id - 100, b]);
    else if (id >= 100 && id < 100 + KEY0) buttons.push([id - 100, b]);
  }
  const knobs = [...Array(8).keys()].filter(i => box.has(i));
  if (keys.length !== KEYS || buttons.length !== KEY0 || knobs.length !== 8)
    throw Error(`The emulator's panel has ${keys.length} keys, ${buttons.length} buttons and ${knobs.length} knobs, not the FM-1's 27, 14 and 8.`);
  // Keys left to right are F3..G5 in order, black keys raised (fm1-emu draws them higher).
  keys.sort((a, b) => a[1][0] - b[1][0]);
  const ys = keys.map(([, b]) => b[1] + b[3]), middle = (Math.min(...ys) + Math.max(...ys)) / 2;
  keys.forEach(([id, b], k) => {
    if (id !== KEY0 + k) throw Error('The emulator\'s keys are not in F3..G5 order.');
    if ((b[1] + b[3] < middle) !== isBlack(k)) throw Error('The emulator\'s raised keys are not the black keys.');
  });
  return {keys: keys.map(([id]) => id), buttons: buttons.map(([id]) => id).sort((a, b) => a - b)};
}

// ---- layouts: design-size boxes [x, y, w, h]
const knob = (cx, cy, d) => ({cx, cy, d});
function keybed(x0, y0, width, wW, wH, bW, bH, gapY) {
  const whites = [...Array(KEYS).keys()].filter(k => !isBlack(k)), step = width / whites.length, out = {};
  whites.forEach((k, i) => { out[KEY0 + k] = [x0 + i * step + (step - wW) / 2, y0 + bH + gapY, wW, wH]; });
  for (let k = 0; k < KEYS; k++) if (isBlack(k)) {
    const left = whites.indexOf(k - 1);
    out[KEY0 + k] = [x0 + (left + 1) * step - bW / 2, y0, bW, bH];
  }
  return out;
}
function buttonRows(rows, x0, y0, size, step, rowStep) {
  const out = {};
  rows.forEach((r, j) => r.forEach((id, i) => { out[id] = [x0 + i * step, y0 + j * rowStep, size, size]; }));
  return out;
}
const TOP = [2, 3, 4, 5, 6, 7], BOTTOM = [8, 9, 10, 11, 12, 13];
export const LAYOUTS = {
  landscape: {
    W: 1000, H: 620, R: 44,
    trays: [[52, 262, 196, 64, 16], [572, 158, 394, 156, 18], [40, 336, 920, 262, 26, 'bed']],
    bezel: [270, 36, 268, 268], lcd: [284, 50, 240, 240],
    knobs: {7: knob(95, 108, 50), 0: knob(195, 108, 50), 1: knob(95, 214, 50), 2: knob(195, 214, 50),
      3: knob(632, 108, 44), 4: knob(731, 108, 44), 5: knob(830, 108, 44), 6: knob(929, 108, 44)},
    ctl: {...buttonRows([TOP, BOTTOM], 588, 174, 52, 62, 68),
      0: [66, 275, 76, 38], 1: [158, 275, 76, 38], ...keybed(60, 350, 880, 47, 122, 44, 100, 14)},
  },
  portrait: {     // phones held upright: the screen on top, OCT- / OCT+ end the button rows
    W: 420, H: 812, R: 34,
    trays: [[14, 450, 392, 128, 16], [10, 590, 400, 212, 20, 'bed']],
    bezel: [76, 20, 268, 268], lcd: [90, 34, 240, 240],
    knobs: {7: knob(60, 336, 44), 0: knob(160, 336, 44), 1: knob(260, 336, 44), 2: knob(360, 336, 44),
      3: knob(60, 414, 40), 4: knob(160, 414, 40), 5: knob(260, 414, 40), 6: knob(360, 414, 40)},
    ctl: {...buttonRows([[...TOP, 0], [...BOTTOM, 1]], 25, 462, 46, 54, 58),
      ...keybed(16, 598, 388, 23, 104, 22, 88, 6)},
  },
};

/* The control under design point (x, y): 0..7 a knob, 100 + id a key or button, -1 nothing. */
export function hitTest(L, x, y) {
  for (const [i, k] of Object.entries(L.knobs))
    if ((x - k.cx) ** 2 + (y - k.cy) ** 2 <= (k.d / 2 + 6) ** 2) return Number(i);
  for (const [id, [bx, by, bw, bh]] of Object.entries(L.ctl))
    if (x >= bx - 2 && x <= bx + bw + 2 && y >= by - 2 && y <= by + bh + 2) return 100 + Number(id);
  return -1;
}

// ---- LSDj's Game Boy buttons on the FM-1 (button mode; src/gb_port.c gp_input_keys, F3 = key 0)
export const LSDJ_KEYS = {0: 'left', 2: 'left', 3: 'up', 5: 'up', 4: 'down', 6: 'right', 7: 'right',
  11: 'SELECT', 12: 'START', 24: 'B', 26: 'A'};
// What every other control does with LSDj (handoff/docs/GUIDE.md, quick actions). '' = not used.
export const LSDJ_BUTTONS = {0: 'OCTAVE -', 1: 'OCTAVE +', 2: 'MASTER FX', 3: '', 4: '', 5: '', 6: 'TEMPO',
  7: 'SETTINGS', 8: 'NOTE MODE', 9: 'SAVE SONGS', 10: 'CUE ROW', 11: 'LIVE/SONG', 12: 'START', 13: 'SELECT'};
export const LSDJ_KNOBS = {0: 'FX PAGE', 1: 'UP/DOWN', 2: 'LEFT/RIGHT', 3: 'EFFECT 1', 4: 'EFFECT 2',
  5: 'EFFECT 3', 6: 'EFFECT 4', 7: 'VOLUME'};
export const FX_MUTES = {7: 'PU1', 9: 'PU2', 11: 'WAV', 12: 'NOI'};   // C4..F4 with FX open
export const PAGE_LIGHTS = {8: 'SONG', 10: 'CHAIN', 13: 'PHRASE', 15: 'INSTR', 17: 'TABLE', 20: 'GROOVE'};
const SHORT = {SELECT: 'SL', START: 'ST', SONG: 'SNG', CHAIN: 'CHN', PHRASE: 'PHR', INSTR: 'INS',
  TABLE: 'TBL', GROOVE: 'GRV'};   // on the phone layout's narrow keys

/* How bright a light looks, 0..1. The FM-1 scans its lights across 11 columns, so the emulator's
   levels are on-time averages: a fully lit key reads about 0.09 and a soft one (page lights) about
   0.014. Scaled so full is full and soft stays clearly visible. */
export const LED_FULL = 0.088;
export function ledLevel(v) {
  const b = Math.min(1, Math.max(0, v || 0) / LED_FULL);
  return b < 0.03 ? 0 : b ** 0.45;
}

// ---- the picture
const C = {body: '#5c5f64', bodyLo: '#4b4e53', edge: '#6d7075', tray: '#36383c', bed: '#2b2d30',
  cap: '#46484c', capTop: '#55585c', key: '#3f4145', keyTop: '#4d5054', silk: '#d9dadc',
  slit: '#7d8085', lit: '#ffffff', play: '#59e36f', tag: '#f2b84b', tagInk: '#1b1b1b',
  mute: '#7cc8ff', unused: '#8a8d92'};
export const FONT = '"DotGothic16", ui-monospace, monospace';

function rrect(g, x, y, w, h, r) {
  g.beginPath(); g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}
function arrow(g, cx, cy, s, dir) {
  const a = {up: -Math.PI / 2, down: Math.PI / 2, left: Math.PI, right: 0}[dir];
  g.save(); g.translate(cx, cy); g.rotate(a);
  g.beginPath(); g.moveTo(s, 0); g.lineTo(-s * 0.7, -s * 0.8); g.lineTo(-s * 0.7, s * 0.8); g.closePath(); g.fill();
  g.restore();
}
function tag(g, text, cx, cy, size, colour = C.tag) {
  g.font = `${size}px ${FONT}`;
  const w = text.length > 1 ? g.measureText(text).width + size * 0.6 : size * 1.25, h = size * 1.25;
  g.fillStyle = colour; rrect(g, cx - w / 2, cy - h / 2, w, h, size * 0.3); g.fill();
  g.fillStyle = C.tagInk;
  if (['up', 'down', 'left', 'right'].includes(text)) arrow(g, cx, cy, size * 0.42, text);
  else { g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, cx, cy + size * 0.06); }
}

/* Draw the whole front into g (a 2D context sized L.W*S x L.H*S). The screen and the knobs are
   separate 3D parts; the front leaves a dark well where each sits.
   s: {leds: Float32Array(41), pressed: Set of ids, lsdj: show LSDj's buttons} */
export function drawFace(g, L, S, s) {
  g.setTransform(S, 0, 0, S, 0, 0);
  g.clearRect(0, 0, L.W, L.H);
  // body: brushed grey, lighter at the top edge
  const body = g.createLinearGradient(0, 0, 0, L.H);
  body.addColorStop(0, C.edge); body.addColorStop(0.04, C.body); body.addColorStop(1, C.bodyLo);
  g.fillStyle = body; rrect(g, 0, 0, L.W, L.H, L.R); g.fill();
  for (const [x, y, w, h, r, bed] of L.trays) {
    g.fillStyle = bed ? C.bed : C.tray; rrect(g, x, y, w, h, r); g.fill();
    g.save(); rrect(g, x, y, w, h, r); g.clip();
    g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 6; rrect(g, x - 2, y - 2, w + 4, h + 4, r + 2); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 2; rrect(g, x + 1, y + 2, w - 2, h - 2, r); g.stroke();
    g.restore();
  }
  // screen bezel (the LCD itself is its own part, drawn over this)
  const [bx, by, bw, bh] = L.bezel;
  g.fillStyle = '#0e0e10'; rrect(g, bx, by, bw, bh, 22); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 2; rrect(g, bx + 1, by + 1, bw - 2, bh - 2, 21); g.stroke();
  // knob wells and labels
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  for (const [i, k] of Object.entries(L.knobs)) {
    g.fillStyle = 'rgba(0,0,0,.28)'; g.beginPath(); g.arc(k.cx, k.cy + 2, k.d / 2 + 5, 0, Math.PI * 2); g.fill();
    g.fillStyle = C.silk; g.font = `${L.W > 600 ? 15 : 11}px ${FONT}`;
    g.fillText(KNOBS[i], k.cx, k.cy - k.d / 2 - (L.W > 600 ? 12 : 8));
    if (s.lsdj) tag(g, LSDJ_KNOBS[i], k.cx, k.cy + k.d / 2 + (L.W > 600 ? 15 : 9), L.W > 600 ? 12 : 8);
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  }
  const leds = s.leds || new Float32Array(41), small = L.W < 600;
  for (const [idText, [x, y, w, h]] of Object.entries(L.ctl)) {
    const id = Number(idText), down = s.pressed?.has(id), led = ledLevel(leds[id]);
    const sink = down ? 2 : 0;
    if (id >= KEY0) {               // a silicone key: a pill with its light slit
      const k = id - KEY0;
      g.fillStyle = 'rgba(0,0,0,.45)'; rrect(g, x, y + 4, w, h, w / 2); g.fill();
      const grad = g.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, down ? C.key : C.keyTop); grad.addColorStop(1, down ? '#36383b' : C.key);
      g.fillStyle = grad; rrect(g, x, y + sink, w, h, w / 2); g.fill();
      g.strokeStyle = 'rgba(255,255,255,.10)'; g.lineWidth = 1.5; rrect(g, x + 1, y + 1 + sink, w - 2, h - 2, w / 2); g.stroke();
      const sw = Math.max(3, w * 0.1), sy = y + h * 0.2 + sink, sh = h * 0.6;
      if (led > 0.02) {
        g.save(); g.shadowColor = `rgba(255,255,255,${0.9 * led})`; g.shadowBlur = 12 * led;
        g.fillStyle = `rgba(255,255,255,${0.35 + 0.65 * led})`; rrect(g, x + (w - sw) / 2, sy, sw, sh, sw / 2); g.fill();
        g.restore();
      } else { g.fillStyle = C.slit; rrect(g, x + (w - sw) / 2, sy, sw, sh, sw / 2); g.fill(); }
      const silk = UPPER_SILK[BLACKS.indexOf(k)], page = s.lsdj && PAGE_LIGHTS[k];
      g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      if (page) {                   // the LSDj screen this black key's light shows
        g.fillStyle = 'rgba(255,255,255,.85)'; g.font = `${small ? 8 : 11}px ${FONT}`;
        g.fillText(small ? SHORT[page] : page, x + w / 2, y + h - (small ? 4 : 6) + sink);
      } else if (!small && silk) {
        g.fillStyle = 'rgba(217,218,220,.55)'; g.font = `10px ${FONT}`;
        g.fillText(silk, x + w / 2, y + h - 6 + sink);
      }
      if (s.lsdj && FX_MUTES[k]) tag(g, FX_MUTES[k], x + w / 2, y + h - (small ? 10 : 17) + sink, small ? 8 : 12, C.mute);
      if (s.lsdj && LSDJ_KEYS[k]) tag(g, small ? SHORT[LSDJ_KEYS[k]] || LSDJ_KEYS[k] : LSDJ_KEYS[k], x + w / 2, y + (small ? 11 : 16) + sink, small ? 9 : 13);
    } else {                        // a button: its label lights up
      g.fillStyle = 'rgba(0,0,0,.45)'; rrect(g, x, y + 3, w, h, 9); g.fill();
      const grad = g.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, down ? C.cap : C.capTop); grad.addColorStop(1, C.cap);
      g.fillStyle = grad; rrect(g, x, y + sink, w, h, 9); g.fill();
      g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1.5; rrect(g, x + 1, y + 1 + sink, w - 2, h - 2, 8); g.stroke();
      const on = led > 0.02, colour = id === 12 ? C.play : C.lit;
      g.save();
      if (on) { g.shadowColor = colour; g.shadowBlur = 10 * led; }
      g.fillStyle = on ? colour : '#a7aaae'; g.globalAlpha = on ? 0.55 + 0.45 * led : 1;
      g.font = `${small ? 11 : id > 1 && BUTTONS[id].length > 3 ? 13 : 14}px ${FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(BUTTONS[id], x + w / 2, y + h / 2 + sink + 1);
      g.restore();
      if (s.lsdj) tag(g, LSDJ_BUTTONS[id] || 'NOT USED', x + w / 2, y + h + (small ? 7 : 9), small ? 7.5 : 10.5,
        LSDJ_BUTTONS[id] ? C.tag : C.unused);
    }
  }
}

/* What a frame changes in the front's picture (lit levels in 16 steps, pressed controls). */
export function faceKey(leds, pressed, lsdj) {
  let k = lsdj ? 'L' : '';
  for (let i = 0; i < 41; i++) k += ((ledLevel(leds?.[i]) * 15) | 0).toString(16);
  return k + [...pressed].sort((a, b) => a - b).join(',');
}
