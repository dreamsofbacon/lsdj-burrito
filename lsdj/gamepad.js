// SPDX-License-Identifier: GPL-3.0-only
// A game controller on this page plays LSDj on the FM-1 (0.9.97 and newer): the browser's Gamepad API, sent to the
// FM-1 as the Game Boy buttons held (link op PAD_SET, firmware/lsdj_link.h). Any controller the browser sees works:
// USB, or Bluetooth paired to this computer or phone. The FM-1 lets go of the buttons by itself half a second after
// the last message, so a closed tab or a pulled cable never leaves a button held.

export const GB = {A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128};
export const RESEND_MS = 200;   // held buttons again this often (the FM-1 keeps them 500 ms)
const DEAD = 0.5;               // the stick past half way: a direction

const down = b => !!b && (typeof b === 'object' ? b.pressed || b.value > 0.5 : b > 0.5);

/* The Game Boy buttons a controller holds. The browser's "standard" layout: 0 bottom (Xbox A), 1 right (B),
   2 left (X), 3 top (Y), 8 View / Back / Share, 9 Menu / Start / Options, 12-15 d-pad up, down, left, right; axes
   0 and 1 the left stick. Bottom and top are A, right and left are B, so either thumb position works. */
export function padMask(gp) {
  if (!gp || gp.connected === false) return 0;
  const b = i => down(gp.buttons?.[i]), ax = i => gp.axes?.[i] ?? 0;
  let m = 0;
  if (b(0) || b(3)) m |= GB.A;
  if (b(1) || b(2)) m |= GB.B;
  if (b(8)) m |= GB.SELECT;
  if (b(9)) m |= GB.START;
  if (b(12) || ax(1) < -DEAD) m |= GB.UP;
  if (b(13) || ax(1) > DEAD) m |= GB.DOWN;
  if (b(14) || ax(0) < -DEAD) m |= GB.LEFT;
  if (b(15) || ax(0) > DEAD) m |= GB.RIGHT;
  return m;
}
/* "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)" -> "Xbox Wireless Controller" */
export const padName = gp => (gp?.id || 'Game controller').replace(/\s*\((?:STANDARD GAMEPAD|Vendor:)[^)]*\)\s*$/i, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '') || 'Game controller';

/* Watch the controllers and send their buttons: on every change at once, and while held every RESEND_MS.
   send(mask) -> Promise (the link); canSend() false while the page uses the link for something long (an install);
   status(text) for the line on the page. Returns stop(). */
export function startGamepad({send, status = () => {}, canSend = () => true, nav = globalThis.navigator,
                              now = () => performance.now(), every = (f, ms) => setInterval(f, ms), cancel = clearInterval,
                              visible = () => typeof document === 'undefined' || !document.hidden}) {
  let last = 0, sentAt = -Infinity, inflight = false, shown = '', stopped = false;
  const say = t => { if (t !== shown) { shown = t; status(t); } };
  /* Only controllers the browser maps to the standard layout (Xbox, PlayStation, Switch Pro and most others): other
     devices it lists (joysticks, wheels, some USB gear) can rest with a stick off centre, which would hold an arrow. */
  const pads = () => [...(nav?.getGamepads?.() || [])].filter(p => p && p.connected !== false);
  const tick = () => {
    if (stopped) return;
    const all = visible() ? pads() : [], list = all.filter(p => p.mapping === 'standard'), other = all.filter(p => p.mapping !== 'standard');
    const mask = list.reduce((m, p) => m | padMask(p), 0);
    say(!nav?.getGamepads ? 'Game controller: this browser does not read controllers.'
      : list.length ? `Game controller: ${padName(list[0])}${list.length > 1 ? ` and ${list.length - 1} more` : ''}. It plays LSDj on the FM-1.`
      : other.length ? `Game controller: ${padName(other[0])} is not a standard game controller, so it is not used.`
      : 'Game controller: connect one (USB, or Bluetooth to this device) and press a button.');
    if (inflight || !canSend()) return;
    const t = now();
    if (mask === last && !(mask && t - sentAt >= RESEND_MS)) return;
    inflight = true; last = mask; sentAt = t;
    Promise.resolve().then(() => send(mask)).catch(() => { last = -1; }).finally(() => { inflight = false; });
  };
  const id = every(tick, 16);
  tick();
  return () => { stopped = true; cancel(id); if (last > 0) Promise.resolve().then(() => send(0)).catch(() => {}); };
}
