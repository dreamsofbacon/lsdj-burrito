// SPDX-License-Identifier: GPL-3.0-only
// A game controller on this page plays LSDj on the FM-1 (0.9.97 and newer): the browser's Gamepad API, sent to the
// FM-1 as the Game Boy buttons held (link op PAD_SET, firmware/lsdj_link.h). Any controller the browser sees works:
// USB, or Bluetooth paired to this computer or phone. The FM-1 lets go of the buttons by itself half a second after
// the last message, so a closed tab or a pulled cable never leaves a button held.
// The controls can be remapped (the page's Controller buttons): a map is, for each Game Boy button, the controller
// inputs that press it: 'b<n>' a button, 'a<n>+' / 'a<n>-' a stick axis past half way.

export const GB = {A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128};
export const GB_ORDER = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'START', 'SELECT'];
export const SLOTS = 2;         // inputs a Game Boy button can have
export const RESEND_MS = 200;   // held buttons again this often (the FM-1 keeps them 500 ms)
const DEAD = 0.5;               // the stick past half way: a direction
const CAPTURE = 0.7;            // ... and further, to be taken when remapping (a resting stick never is)
const STORE_KEY = 'lsdj-burrito-pad-map';

/* The browser's "standard" layout: 0 bottom (Xbox A), 1 right (B), 2 left (X), 3 top (Y), 8 View / Back / Share,
   9 Menu / Start / Options, 12-15 d-pad up, down, left, right; axes 0 and 1 the left stick. Bottom and top are A,
   right and left are B, so either thumb position works. */
export const DEFAULT_MAP = Object.freeze({UP: ['b12', 'a1-'], DOWN: ['b13', 'a1+'], LEFT: ['b14', 'a0-'], RIGHT: ['b15', 'a0+'],
  A: ['b0', 'b3'], B: ['b1', 'b2'], START: ['b9'], SELECT: ['b8']});
const BUTTON_NAMES = ['A / Cross (bottom)', 'B / Circle (right)', 'X / Square (left)', 'Y / Triangle (top)', 'LB / L1', 'RB / R1',
  'LT / L2', 'RT / R2', 'View / Back / Share', 'Menu / Start / Options', 'Left stick press', 'Right stick press',
  'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home / Guide'];
const AXIS_NAMES = [['Left stick left', 'Left stick right'], ['Left stick up', 'Left stick down'],
  ['Right stick left', 'Right stick right'], ['Right stick up', 'Right stick down']];
const CODE = /^(?:b(\d{1,2})|a(\d)([+-]))$/;

/* "b9" -> "Menu / Start / Options", "a1-" -> "Left stick up" */
export function inputName(code) {
  const m = CODE.exec(code || '');
  if (!m) return '';
  if (m[1] !== undefined) return BUTTON_NAMES[+m[1]] ?? `Button ${m[1]}`;
  return AXIS_NAMES[+m[2]]?.[m[3] === '+' ? 1 : 0] ?? `Axis ${m[2]} ${m[3]}`;
}
const down = b => !!b && (typeof b === 'object' ? b.pressed || b.value > 0.5 : b > 0.5);
/* Is input code held on gp (threshold for the axes) */
function held(gp, code, dead = DEAD) {
  const m = CODE.exec(code);
  if (!m) return false;
  if (m[1] !== undefined) return down(gp.buttons?.[+m[1]]);
  const v = gp.axes?.[+m[2]] ?? 0;
  return m[3] === '+' ? v > dead : v < -dead;
}
/* A map checked and completed: every Game Boy button, at most SLOTS valid codes each (else the default's). */
export function cleanMap(map) {
  const out = {};
  for (const k of GB_ORDER) {
    const v = map && Array.isArray(map[k]) ? map[k].filter(c => typeof c === 'string' && CODE.test(c)).slice(0, SLOTS) : null;
    out[k] = v ?? DEFAULT_MAP[k].slice();
  }
  return out;
}
export const isDefaultMap = map => GB_ORDER.every(k => JSON.stringify(cleanMap(map)[k]) === JSON.stringify(DEFAULT_MAP[k]));
/* Saved in this browser (localStorage), as a viewer's own preference; any failure gives the default. */
export function loadMap(store = globalThis.localStorage) {
  try { const s = store?.getItem(STORE_KEY); return cleanMap(s ? JSON.parse(s) : null); } catch { return cleanMap(null); }
}
export function saveMap(map, store = globalThis.localStorage) {
  try { if (isDefaultMap(map)) store?.removeItem(STORE_KEY); else store?.setItem(STORE_KEY, JSON.stringify(cleanMap(map))); } catch { /* (private window) */ }
}
/* Put code into gb's slot (0 or 1); the same input leaves any other slot of that button. null clears the slot. */
export function assign(map, gb, slot, code) {
  const m = cleanMap(map), list = m[gb].slice();
  while (list.length <= slot) list.push(null);
  list[slot] = code;
  m[gb] = list.filter((c, i) => c && list.indexOf(c) === i);
  return m;
}

/* The Game Boy buttons a controller holds, by map */
export function padMask(gp, map = DEFAULT_MAP) {
  if (!gp || gp.connected === false) return 0;
  let m = 0;
  for (const k of GB_ORDER) if ((map[k] || []).some(c => held(gp, c))) m |= GB[k];
  return m;
}
/* The inputs held now, firmly (for remapping) */
export function heldInputs(gp) {
  if (!gp) return [];
  const out = [];
  (gp.buttons || []).forEach((b, i) => { if (down(b)) out.push(`b${i}`); });
  (gp.axes || []).forEach((v, i) => { if (v > CAPTURE) out.push(`a${i}+`); else if (v < -CAPTURE) out.push(`a${i}-`); });
  return out;
}
/* "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)" -> "Xbox Wireless Controller" */
export const padName = gp => (gp?.id || 'Game controller').replace(/\s*\((?:STANDARD GAMEPAD|Vendor:)[^)]*\)\s*$/i, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '') || 'Game controller';

/* Watch the controllers and send their buttons: on every change at once, and while held every RESEND_MS.
   send(mask) -> Promise (the link); canSend() false while the page uses the link for something long (an install);
   status(text) for the line on the page; getMap() the map in use. Returns stop(), with
   stop.capture(cb): the next input newly pressed goes to cb(code) instead of the FM-1 (nothing is sent meanwhile),
   and stop.cancelCapture(). */
export function startGamepad({send, status = () => {}, canSend = () => true, getMap = () => DEFAULT_MAP, nav = globalThis.navigator,
                              now = () => performance.now(), every = (f, ms) => setInterval(f, ms), cancel = clearInterval,
                              visible = () => typeof document === 'undefined' || !document.hidden}) {
  let last = 0, sentAt = -Infinity, inflight = false, shown = '', stopped = false, capture = null, before = null;
  const say = t => { if (t !== shown) { shown = t; status(t); } };
  /* Only controllers the browser maps to the standard layout (Xbox, PlayStation, Switch Pro and most others): other
     devices it lists (joysticks, wheels, some USB gear) can rest with a stick off centre, which would hold an arrow. */
  const pads = () => [...(nav?.getGamepads?.() || [])].filter(p => p && p.connected !== false);
  const tick = () => {
    if (stopped) return;
    const all = visible() ? pads() : [], list = all.filter(p => p.mapping === 'standard'), other = all.filter(p => p.mapping !== 'standard');
    say(!nav?.getGamepads ? 'Game controller: this browser does not read controllers.'
      : list.length ? `Game controller: ${padName(list[0])}${list.length > 1 ? ` and ${list.length - 1} more` : ''}. It plays LSDj on the FM-1.`
      : other.length ? `Game controller: ${padName(other[0])} is not a standard game controller, so it is not used.`
      : 'Game controller: connect one (USB, or Bluetooth to this device) and press a button.');
    let mask = 0;
    if (capture) {   /* remapping: an input that was not already held when the capture began */
      const now_ = new Set(list.flatMap(heldInputs));
      if (!before) before = new Set();
      for (const c of before) if (!now_.has(c)) before.delete(c);   /* let go: may be taken next time */
      const got = [...now_].find(c => !before.has(c));
      if (got) { const cb = capture; capture = null; before = null; cb(got); }
    } else {
      const map = getMap();
      mask = list.reduce((m, p) => m | padMask(p, map), 0);
    }
    if (inflight || !canSend()) return;
    const t = now();
    if (mask === last && !(mask && t - sentAt >= RESEND_MS)) return;
    inflight = true; last = mask; sentAt = t;
    Promise.resolve().then(() => send(mask)).catch(() => { last = -1; }).finally(() => { inflight = false; });
  };
  const id = every(tick, 16);
  tick();
  const stop = () => { stopped = true; cancel(id); if (last > 0) Promise.resolve().then(() => send(0)).catch(() => {}); };
  stop.capture = cb => {   /* what is held now is not taken (it was pressed before the click) */
    capture = cb; before = new Set(pads().filter(p => p.mapping === 'standard').flatMap(heldInputs)); };
  stop.cancelCapture = () => { capture = null; before = null; };
  return stop;
}
