// SPDX-License-Identifier: GPL-3.0-only
// lsdj/gamepad.js: the buttons a controller holds, as Game Boy bits, and when they are sent (node tests/gamepad.mjs).
import assert from 'node:assert/strict';
import {GB, padMask, padName, startGamepad, RESEND_MS, DEFAULT_MAP, cleanMap, isDefaultMap, assign, loadMap, saveMap, inputName, heldInputs} from '../lsdj/gamepad.js';

const pad = (pressed = [], axes = [0, 0, 0, 0], id = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)') =>
  ({id, connected: true, mapping: 'standard', axes, buttons: Array.from({length: 17}, (_, i) => ({pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0}))});

/* the layout */
assert.equal(padMask(pad()), 0);
assert.equal(padMask(pad([0])), GB.A); assert.equal(padMask(pad([3])), GB.A);   /* bottom, top */
assert.equal(padMask(pad([1])), GB.B); assert.equal(padMask(pad([2])), GB.B);   /* right, left */
assert.equal(padMask(pad([8])), GB.SELECT); assert.equal(padMask(pad([9])), GB.START);
assert.equal(padMask(pad([12])), GB.UP); assert.equal(padMask(pad([13])), GB.DOWN);
assert.equal(padMask(pad([14])), GB.LEFT); assert.equal(padMask(pad([15])), GB.RIGHT);
assert.equal(padMask(pad([], [0.9, -0.8])), GB.RIGHT | GB.UP);                  /* the left stick */
assert.equal(padMask(pad([], [0.3, 0.2])), 0);                                  /* not past half way */
assert.equal(padMask(pad([0, 9, 15])), GB.A | GB.START | GB.RIGHT);
assert.equal(padMask({...pad([0]), connected: false}), 0); assert.equal(padMask(null), 0);
assert.equal(padMask({connected: true, buttons: [0.9, 0], axes: []}), GB.A);   /* plain numbers (old browsers) */
assert.equal(padName(pad()), 'Xbox Wireless Controller');
assert.equal(padName({id: '054c-0ce6-DualSense Wireless Controller'}), 'DualSense Wireless Controller');

/* sending: at once on a change, held buttons every RESEND_MS, the release once, nothing while idle */
{
  let t = 0, tickFn, pads = [], sent = [], statuses = [];
  const nav = {getGamepads: () => pads};
  const stop = startGamepad({send: async m => { sent.push([t, m]); }, status: s => statuses.push(s), nav, now: () => t,
                             every: f => { tickFn = f; return 1; }, cancel: () => {}});
  const run = async ms => { for (let i = 0; i < ms; i += 16) { t += 16; tickFn(); await Promise.resolve(); await Promise.resolve(); } };
  await run(100);
  assert.deepEqual(sent, [], 'no controller: nothing sent');
  assert.match(statuses.at(-1), /connect one/);
  pads = [pad()]; await run(100);
  assert.deepEqual(sent, [], 'a controller, nothing held: nothing sent');
  assert.match(statuses.at(-1), /Xbox Wireless Controller\. It plays LSDj/);
  pads = [pad([0])]; await run(32);
  assert.deepEqual(sent.map(s => s[1]), [GB.A], 'A at once');
  await run(1000);
  const held = sent.filter(s => s[1] === GB.A);
  assert.ok(held.length >= 1000 / RESEND_MS - 1 && held.length <= 1000 / RESEND_MS + 2, `A again while held: ${held.length}`);
  for (let i = 2; i < held.length; i++) assert.ok(held[i][0] - held[i - 1][0] >= RESEND_MS && held[i][0] - held[i - 1][0] < RESEND_MS + 40);
  pads = [pad()]; await run(500);
  assert.equal(sent.at(-1)[1], 0); assert.equal(sent.filter(s => s[1] === 0).length, 1, 'the release once');
  pads = [pad([12]), pad([0])]; await run(32);
  assert.equal(sent.at(-1)[1], GB.UP | GB.A, 'two controllers together');
  stop(); await Promise.resolve(); await Promise.resolve();
  assert.equal(sent.at(-1)[1], 0, 'stop lets go');
}
/* a device that is not a standard controller (a stick resting off centre): never used */
{ let tickFn, sent = [], s = '';
  const odd = {...pad([0], [-1, 1]), mapping: '', id: 'Some USB Joystick'};
  startGamepad({send: async m => { sent.push(m); }, status: x => s = x, nav: {getGamepads: () => [odd]}, now: () => 0,
                every: f => { tickFn = f; return 1; }, cancel: () => {}});
  for (let i = 0; i < 5; i++) { tickFn(); await Promise.resolve(); }
  assert.deepEqual(sent, []); assert.match(s, /Some USB Joystick is not a standard game controller/); }
/* a busy link: waits; a failed send is tried again */
{
  let t = 0, tickFn, ok = false, sent = [], fail = 1;
  startGamepad({send: async m => { sent.push(m); if (fail-- > 0) throw Error('busy'); }, nav: {getGamepads: () => [pad([1])]},
                canSend: () => ok, now: () => t, every: f => { tickFn = f; return 1; }, cancel: () => {}});
  for (let i = 0; i < 5; i++) { t += 16; tickFn(); await Promise.resolve(); }
  assert.deepEqual(sent, [], 'not while the page uses the link');
  ok = true;
  for (let i = 0; i < 6; i++) { t += 16; tickFn(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
  assert.deepEqual(sent.slice(0, 2), [GB.B, GB.B], 'a failed send tried again');
}
/* no Gamepad API */
{ let s = ''; startGamepad({send: async () => {}, status: x => s = x, nav: {}, every: () => 1, cancel: () => {}});
  assert.match(s, /does not read controllers/); }
/* remapping: names, maps checked, a slot set / cleared, saved in the browser, a custom map in use, capture */
assert.equal(inputName('b9'), 'Menu / Start / Options'); assert.equal(inputName('a1-'), 'Left stick up');
assert.equal(inputName('a3+'), 'Right stick down'); assert.equal(inputName('b20'), 'Button 20'); assert.equal(inputName('x'), '');
assert.deepEqual(cleanMap(null), {...DEFAULT_MAP}); assert.ok(isDefaultMap(cleanMap({})));
assert.deepEqual(cleanMap({A: ['b4', 'zz', 'b5', 'b6'], B: 'no'}).A, ['b4', 'b5']);            /* bad codes out, two at most */
assert.deepEqual(cleanMap({A: ['b4']}).B, DEFAULT_MAP.B);
{ let m = assign(DEFAULT_MAP, 'START', 1, 'b5');                                                /* START: Menu and RB */
  assert.deepEqual(m.START, ['b9', 'b5']); assert.ok(!isDefaultMap(m));
  m = assign(m, 'START', 0, null); assert.deepEqual(m.START, ['b5']);                          /* Menu off */
  m = assign(m, 'A', 1, 'b0'); assert.deepEqual(m.A, ['b0']);                                  /* the same input twice: once */
  m = assign(m, 'SELECT', 1, 'b5'); assert.deepEqual(m.SELECT, ['b8', 'b5']);                  /* RB presses START and SELECT */
  assert.equal(padMask(pad([5]), m), GB.START | GB.SELECT); assert.equal(padMask(pad([9]), m), 0);
  assert.equal(padMask(pad([], [0, 0, 0.9, 0]), assign(m, 'RIGHT', 1, 'a2+')), GB.RIGHT);     /* the right stick */
  const store = new Map(), st = {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k)};
  saveMap(m, st); assert.deepEqual(loadMap(st), m);
  saveMap(DEFAULT_MAP, st); assert.equal(store.size, 0, 'the default: nothing kept');
  store.set('lsdj-burrito-pad-map', '{bad'); assert.ok(isDefaultMap(loadMap(st)));
  assert.ok(isDefaultMap(loadMap({getItem: () => { throw Error('blocked'); }}))); }
assert.deepEqual(heldInputs(pad([4], [0.2, -0.9, 0.8, 0])), ['b4', 'a1-', 'a2+']);              /* a resting stick is not taken */
{ let t = 0, tickFn, pads = [pad([0])], sent = [], got = [];
  const stop = startGamepad({send: async m => { sent.push(m); }, nav: {getGamepads: () => pads}, now: () => t, getMap: () => DEFAULT_MAP,
                             every: f => { tickFn = f; return 1; }, cancel: () => {}});
  const run = async n => { for (let i = 0; i < n; i++) { t += 16; tickFn(); await Promise.resolve(); await Promise.resolve(); } };
  await run(3); assert.equal(sent.at(-1), GB.A);
  stop.capture(c => got.push(c)); await run(3);
  assert.equal(sent.at(-1), 0, 'capturing: the FM-1 gets nothing'); assert.deepEqual(got, [], 'A was already held: not taken');
  pads = [pad([0, 6])]; await run(2); assert.deepEqual(got, ['b6'], 'LT newly pressed: taken');
  pads = [pad([6])]; await run(3); assert.equal(sent.at(-1) & GB.A, 0);
  pads = [pad([0])]; await run(3); assert.equal(sent.at(-1), GB.A, 'after the capture: playing again');
  stop.capture(c => got.push(c)); stop.cancelCapture(); pads = [pad([0, 7])]; await run(3); assert.deepEqual(got, ['b6'], 'cancelled'); }
console.log('PASS gamepad: layout (Xbox A/Y -> A, B/X -> B, d-pad and stick), names, sent at once, held every 200 ms, released once, busy link, retries, remapping (names, slots, saved, two Game Boy buttons on one input, capture)');
