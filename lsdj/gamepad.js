// SPDX-License-Identifier: GPL-3.0-only
// A game controller on this page plays LSDj on the FM-1 (0.9.97 and newer): the browser's Gamepad API, sent to the
// FM-1 as the Game Boy buttons held (link op PAD_SET, firmware/lsdj_link.h). Any controller the browser sees works:
// USB, or Bluetooth paired to this computer or phone. The FM-1 lets go of the buttons by itself half a second after
// the last message, so a closed tab or a pulled cable never leaves a button held.
// Which controller plays can be chosen (the page's Controller list), and each controller has its own buttons
// (Controller buttons): a map is, for each Game Boy button, the controller inputs that press it: 'b<n>' a button,
// 'a<n>+' / 'a<n>-' an axis past half way, 'h<n>u|d|l|r' a d-pad the browser reports as a "hat" on axis n.

export const GB = {A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128};
export const GB_ORDER = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'A', 'B', 'START', 'SELECT'];
export const SLOTS = 2;         // inputs a Game Boy button can have
export const RESEND_MS = 200;   // held buttons again this often (the FM-1 keeps them 500 ms)
const DEAD = 0.5;               // an axis this far from where it rests: a direction
const CAPTURE = 0.7;            // ... and further, to be taken when remapping
const OFF_CENTRE = 0.3;         // an axis resting further out than this (a trigger, a worn stick) counts from its rest
const HAT_REST = 1.05;          // a hat reads -1..1 when pressed and above this (Chrome: 9/7) when let go
const MAPS_KEY = 'lsdj-burrito-pad-maps';   // {controller id: map}
const OLD_KEY = 'lsdj-burrito-pad-map';     // the one map of the first remap page (standard controllers)
const PICK_KEY = 'lsdj-burrito-pad-pick';   // the chosen controller's id, '' any controller

/* The browser's "standard" layout: 0 bottom (Xbox A), 1 right (B), 2 left (X), 3 top (Y), 8 View / Back / Share,
   9 Menu / Start / Options, 12-15 d-pad up, down, left, right; axes 0 and 1 the left stick. Bottom and top are A,
   right and left are B, so either thumb position works. */
export const DEFAULT_MAP = Object.freeze({UP: ['b12', 'a1-'], DOWN: ['b13', 'a1+'], LEFT: ['b14', 'a0-'], RIGHT: ['b15', 'a0+'],
  A: ['b0', 'b3'], B: ['b1', 'b2'], START: ['b9'], SELECT: ['b8']});
/* A controller without the standard layout: a starting guess (its d-pad if it has one, the first stick, buttons 1
   and 2 A and B, 9 and 10 SELECT and START), to be set with Controller buttons. */
export function genericMap(hat = -1) {
  const h = d => hat >= 0 ? [`h${hat}${d}`] : [];
  return {UP: [...h('u'), 'a1-'], DOWN: [...h('d'), 'a1+'], LEFT: [...h('l'), 'a0-'], RIGHT: [...h('r'), 'a0+'],
          A: ['b0'], B: ['b1'], START: ['b9'], SELECT: ['b8']};
}
/* The map a controller starts with (info: {standard, hat}) */
export const defaultMapFor = info => !info || info.standard !== false ? DEFAULT_MAP : genericMap(info.hat ?? -1);

const BUTTON_NAMES = ['A / Cross (bottom)', 'B / Circle (right)', 'X / Square (left)', 'Y / Triangle (top)', 'LB / L1', 'RB / R1',
  'LT / L2', 'RT / R2', 'View / Back / Share', 'Menu / Start / Options', 'Left stick press', 'Right stick press',
  'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home / Guide'];
const AXIS_NAMES = [['Left stick left', 'Left stick right'], ['Left stick up', 'Left stick down'],
  ['Right stick left', 'Right stick right'], ['Right stick up', 'Right stick down']];
const HAT_NAMES = {u: 'up', d: 'down', l: 'left', r: 'right'};
const CODE = /^(?:b(\d{1,2})|a(\d{1,2})([+-])|h(\d{1,2})([udlr]))$/;

/* "b9" -> "Menu / Start / Options", "a1-" -> "Left stick up"; on a controller without the standard layout the
   numbers as Windows' game controller settings count them: "b3" -> "Button 4", "a1-" -> "Axis 2 −" */
export function inputName(code, standard = true) {
  const m = CODE.exec(code || '');
  if (!m) return '';
  if (m[1] !== undefined) return (standard && BUTTON_NAMES[+m[1]]) || `Button ${+m[1] + 1}`;
  if (m[2] !== undefined) return (standard && AXIS_NAMES[+m[2]]?.[m[3] === '+' ? 1 : 0]) || `Axis ${+m[2] + 1} ${m[3] === '+' ? '+' : '−'}`;
  return `D-pad ${HAT_NAMES[m[5]]}`;
}
const down = b => !!b && (typeof b === 'object' ? b.pressed || b.value > 0.5 : b > 0.5);
/* A hat's directions now: '' let go, else 'u', 'ur', 'r', ... (-1 up, then clockwise in sevenths) */
export function hatDirs(v) {
  if (typeof v !== 'number' || !(Math.abs(v) <= HAT_REST)) return '';
  return ['u', 'ur', 'r', 'dr', 'd', 'dl', 'l', 'ul'][((Math.round((v + 1) * 3.5) % 8) + 8) % 8];
}
/* What a controller looks like at rest, taken when it is first seen: each axis's rest, the axes that are hats.
   (The browser shows a controller only once a button is pressed, so the sticks are let go then.) */
export function calibrate(gp, cal = null) {
  const axes = gp?.axes || [];
  if (!cal) cal = {rest: axes.map(v => (typeof v === 'number' && Math.abs(v) > OFF_CENTRE && Math.abs(v) <= 1 ? v : 0)), hats: new Set()};
  axes.forEach((v, i) => { if (typeof v === 'number' && Math.abs(v) > HAT_REST) cal.hats.add(i); });
  return cal;
}
export const firstHat = cal => (cal?.hats?.size ? Math.min(...cal.hats) : -1);
const isHat = (cal, i, v) => !!cal?.hats?.has(i) || Math.abs(v) > HAT_REST;
/* Is input code held on gp */
function held(gp, code, cal) {
  const m = CODE.exec(code);
  if (!m) return false;
  if (m[1] !== undefined) return down(gp.buttons?.[+m[1]]);
  if (m[4] !== undefined) { const v = gp.axes?.[+m[4]]; return isHat(cal, +m[4], v ?? 0) && hatDirs(v).includes(m[5]); }
  const i = +m[2], v = gp.axes?.[i] ?? 0;
  if (isHat(cal, i, v)) return false;
  const d = v - (cal?.rest?.[i] ?? 0);
  return m[3] === '+' ? d > DEAD : d < -DEAD;
}
/* A map checked and completed: every Game Boy button, at most SLOTS valid codes each (else the default's). */
export function cleanMap(map, def = DEFAULT_MAP) {
  const out = {};
  for (const k of GB_ORDER) {
    const v = map && Array.isArray(map[k]) ? map[k].filter(c => typeof c === 'string' && CODE.test(c)).slice(0, SLOTS) : null;
    out[k] = v ?? def[k].slice();
  }
  return out;
}
export const isDefaultMap = (map, def = DEFAULT_MAP) => GB_ORDER.every(k => JSON.stringify(cleanMap(map, def)[k]) === JSON.stringify(cleanMap(def)[k]));
/* Put code into gb's slot (0 or 1), and take it off every other Game Boy button (one input, one button: so moving
   the bottom button to B stops it pressing A). null clears the slot. */
export function assign(map, gb, slot, code, def = DEFAULT_MAP) {
  const m = cleanMap(map, def), list = m[gb].slice();
  while (list.length <= slot) list.push(null);
  list[slot] = code;
  m[gb] = list.filter((c, i) => c && list.indexOf(c) === i);
  if (code) for (const k of GB_ORDER) if (k !== gb) m[k] = m[k].filter(c => c !== code);
  return m;
}
/* The Game Boy buttons that also had code, before it moved to gb */
export const takenFrom = (map, gb, code) => (code ? GB_ORDER.filter(k => k !== gb && (map?.[k] || []).includes(code)) : []);

/* Saved in this browser (localStorage), as a viewer's own preference; any failure gives the defaults. */
function readJson(store, key) { try { const s = store?.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; } }
/* Every controller's own map, by its id */
export function loadMaps(store = globalThis.localStorage) {
  const o = readJson(store, MAPS_KEY);
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
}
/* The map of a controller (info: {id, standard, hat}); a standard controller not set yet starts from the map of the
   first remap page, if one was kept */
export function mapFor(maps, info, store = globalThis.localStorage) {
  const def = defaultMapFor(info);
  const own = info?.id ? maps?.[info.id] : null;
  return cleanMap(own ?? (info?.standard !== false ? readJson(store, OLD_KEY) : null), def);
}
/* Keep a controller's map (the default: forgotten) */
export function saveMap(maps, info, map, store = globalThis.localStorage) {
  const out = {...maps};
  if (isDefaultMap(map, defaultMapFor(info))) delete out[info.id]; else out[info.id] = cleanMap(map, defaultMapFor(info));
  try {
    if (Object.keys(out).length) store?.setItem(MAPS_KEY, JSON.stringify(out)); else store?.removeItem(MAPS_KEY);
    if (info.standard !== false) store?.removeItem(OLD_KEY);   /* (now kept by id) */
  } catch { /* (private window) */ }
  return out;
}
export function loadPick(store = globalThis.localStorage) { try { return store?.getItem(PICK_KEY) || ''; } catch { return ''; } }
export function savePick(id, store = globalThis.localStorage) { try { if (id) store?.setItem(PICK_KEY, id); else store?.removeItem(PICK_KEY); } catch { /* */ } }

/* The Game Boy buttons a controller holds, by map */
export function padMask(gp, map = DEFAULT_MAP, cal = null) {
  if (!gp || gp.connected === false) return 0;
  let m = 0;
  for (const k of GB_ORDER) if ((map[k] || []).some(c => held(gp, c, cal))) m |= GB[k];
  return m;
}
/* The inputs held now, firmly (for remapping, and the page's "pressed now") */
export function heldInputs(gp, cal = null) {
  if (!gp) return [];
  const out = [];
  (gp.buttons || []).forEach((b, i) => { if (down(b)) out.push(`b${i}`); });
  (gp.axes || []).forEach((v, i) => {
    if (typeof v !== 'number') return;
    if (isHat(cal, i, v)) { for (const d of hatDirs(v)) out.push(`h${i}${d}`); return; }
    const d = v - (cal?.rest?.[i] ?? 0);
    if (d > CAPTURE) out.push(`a${i}+`); else if (d < -CAPTURE) out.push(`a${i}-`);
  });
  return out;
}
/* "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)" -> "Xbox Wireless Controller" */
export const padName = gp => (gp?.id || 'Game controller').replace(/\s*\((?:STANDARD GAMEPAD|Vendor:)[^)]*\)\s*$/i, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '') || 'Game controller';

/* Watch the controllers and send their buttons: on every change at once, and while held every RESEND_MS.
   send(mask) -> Promise (the link); canSend() false while the page uses the link for something long (an install);
   status(text) for the line on the page; getPick() the chosen controller's id ('' every controller connected, with
   the standard layout or not: their axes count from where they rest, so a stick resting off centre holds nothing);
   getMap(info) the map of a
   controller (info: {id, name, standard, hat}); onPads(list, used) when the controllers or the one playing change;
   onHeld(codes, info) the inputs held on it, when they change. Returns stop(), with
   stop.capture(cb): the next input newly pressed on the controller playing goes to cb(code, info) instead of the
   FM-1 (nothing is sent meanwhile), and stop.cancelCapture(). */
export function startGamepad({send, status = () => {}, canSend = () => true, getMap = () => DEFAULT_MAP, getPick = () => '',
                              onPads = () => {}, onHeld = () => {}, nav = globalThis.navigator,
                              now = () => performance.now(), every = (f, ms) => setInterval(f, ms), cancel = clearInterval,
                              visible = () => typeof document === 'undefined' || !document.hidden}) {
  let last = 0, sentAt = -Infinity, inflight = false, shown = '', stopped = false, capture = null, before = null;
  let padsSig = null, heldSig = null, used = [];
  const cals = new Map();   /* index|id -> calibrate() */
  const say = t => { if (t !== shown) { shown = t; status(t); } };
  const calOf = p => { const k = `${p.index}|${p.id}`; const c = calibrate(p, cals.get(k)); cals.set(k, c); return c; };
  const infoOf = p => ({id: p.id, name: padName(p), standard: p.mapping === 'standard', index: p.index ?? 0, hat: firstHat(calOf(p))});
  const pads = () => [...(nav?.getGamepads?.() || [])].filter(p => p && p.connected !== false);
  const tick = () => {
    if (stopped) return;
    const all = visible() ? pads() : [];
    const pick = getPick() || '', chosen = pick ? all.filter(p => p.id === pick) : [];
    used = chosen.length ? chosen : all;
    const infos = all.map(infoOf), u = used.length ? infoOf(used[0]) : null;
    const sig = JSON.stringify([infos, u?.id ?? null, u?.index ?? null]);
    if (sig !== padsSig) { padsSig = sig; onPads(infos, u); }
    const named = u ? `${u.name}${used.length > 1 ? ` and ${used.length - 1} more` : ''}` : '';
    say(!nav?.getGamepads ? 'Game controller: this browser does not read controllers.'
      : u && pick && !chosen.length ? `Game controller: the one chosen is not connected, so ${named} play${used.length > 1 ? '' : 's'} LSDj on the FM-1.`
      : u ? `Game controller: ${named}. It plays LSDj on the FM-1.${used.some(p => p.mapping !== 'standard')
        ? ` ${used.length > 1 ? 'One has' : 'It has'} no standard layout: check its buttons below (Pressed now shows what it sends).` : ''}`
      : 'Game controller: none seen yet. Connect one (USB, or Bluetooth to this device) and press a button on it: browsers show a controller only after a button press.');
    const now_ = used.flatMap(p => heldInputs(p, calOf(p)));
    const hs = JSON.stringify([now_, u?.id ?? null]);
    if (hs !== heldSig) { heldSig = hs; onHeld([...new Set(now_)], u); }
    let mask = 0;
    if (capture) {   /* remapping: an input that was not already held when the capture began */
      const set = new Set(now_);
      if (!before) before = new Set();
      for (const c of before) if (!set.has(c)) before.delete(c);   /* let go: may be taken next time */
      const got = [...set].find(c => !before.has(c));
      if (got) { const cb = capture; capture = null; before = null; cb(got, u); }
    } else {
      mask = used.reduce((m, p) => m | padMask(p, getMap(infoOf(p)), calOf(p)), 0);
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
    capture = cb; before = new Set(used.flatMap(p => heldInputs(p, calOf(p)))); };
  stop.cancelCapture = () => { capture = null; before = null; };
  stop.refresh = () => { padsSig = null; heldSig = null; tick(); };   /* the pick changed: at once */
  return stop;
}
