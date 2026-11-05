// SPDX-License-Identifier: GPL-3.0-only
// lsdj/gamepad.js: the buttons a controller holds, as Game Boy bits, and when they are sent (node tests/gamepad.mjs).
import assert from 'node:assert/strict';
import {GB, padMask, padName, startGamepad, RESEND_MS} from '../lsdj/gamepad.js';

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
console.log('PASS gamepad: layout (Xbox A/Y -> A, B/X -> B, d-pad and stick), names, sent at once, held every 200 ms, released once, busy link, retries');
