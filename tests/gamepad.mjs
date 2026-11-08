// SPDX-License-Identifier: GPL-3.0-only
// lsdj/gamepad.js: the buttons a controller holds, as Game Boy bits, and when they are sent (node tests/gamepad.mjs).
import assert from 'node:assert/strict';
import {GB, padMask, padName, startGamepad, RESEND_MS, DEFAULT_MAP, cleanMap, isDefaultMap, assign, takenFrom, loadMaps, mapFor, saveMap, loadPick, savePick,
  inputName, heldInputs, genericMap, defaultMapFor, calibrate, recentre, rawInputs, hatDirs, firstHat} from '../lsdj/gamepad.js';

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
  assert.match(statuses.at(-1), /none seen yet/);
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
/* a device without the standard layout (a stick resting off centre): used like any other; its rest is its centre,
   so nothing is held until a button is pressed; its d-pad as a hat */
{ let tickFn, sent = [], s = '', pick = '', lists = [], helds = [];
  const HAT_REST = 9 / 7;
  const odd = {...pad([], [-1, 1, 0, 0, 0, 0, 0, 0, 0, HAT_REST]), mapping: '', id: 'Some USB Joystick (Vendor: 0079 Product: 0006)', index: 1};
  const xbox = {...pad(), index: 0};
  let pads = [odd];
  const stop = startGamepad({send: async m => { sent.push(m); }, status: x => s = x, nav: {getGamepads: () => pads}, now: () => 0,
                getPick: () => pick, getMap: info => defaultMapFor(info), onPads: (l, u) => lists.push([l, u]), onHeld: (c, u) => helds.push(c),
                every: f => { tickFn = f; return 1; }, cancel: () => {}});
  const run = async n => { for (let i = 0; i < n; i++) { tickFn(); await Promise.resolve(); await Promise.resolve(); } };
  await run(5);
  assert.deepEqual(sent, [], 'resting off centre: nothing held');
  assert.match(s, /Some USB Joystick\. It plays LSDj on the FM-1\. It has no standard layout: check its buttons/);
  assert.equal(lists.at(-1)[0][0].name, 'Some USB Joystick'); assert.equal(lists.at(-1)[0][0].standard, false);
  assert.equal(lists.at(-1)[0][0].hat, 9, 'the hat found'); assert.equal(lists.at(-1)[1].id, odd.id, 'playing without being chosen');
  odd.buttons[0] = {pressed: true, value: 1}; await run(3);
  assert.equal(sent.at(-1), GB.A, 'button 1 is A, the off-centre stick holds nothing');
  pick = odd.id; stop.refresh(); await run(3);
  assert.match(s, /Some USB Joystick\. It plays LSDj/); assert.equal(lists.at(-1)[1].id, odd.id);
  assert.equal(sent.at(-1), GB.A, 'chosen: the same');
  odd.buttons[0] = {pressed: false, value: 0}; odd.axes[9] = -1; await run(3);
  assert.equal(sent.at(-1), GB.UP, 'the hat up'); assert.deepEqual(helds.at(-1), ['h9u']);
  odd.axes[9] = -3 / 7; await run(3); assert.equal(sent.at(-1), GB.RIGHT, 'the hat right');
  odd.axes[9] = -5 / 7; await run(3); assert.equal(sent.at(-1), GB.UP | GB.RIGHT, 'the hat up-right');
  odd.axes[9] = HAT_REST; odd.axes[0] = 0; await run(3); assert.equal(sent.at(-1), GB.RIGHT, 'the stick pushed right from its rest (-1)');
  odd.axes[0] = -1; await run(3); assert.equal(sent.at(-1), 0);
  /* chosen: only that one plays, a standard controller beside it does not */
  pads = [xbox, odd]; xbox.buttons[1] = {pressed: true, value: 1}; await run(3); assert.equal(sent.at(-1), 0, 'only the chosen one');
  pick = ''; stop.refresh(); await run(3); assert.equal(sent.at(-1), GB.B, 'any: both (the Xbox one holds B)');
  assert.match(s, /Xbox Wireless Controller and 1 more\. It plays/);
  pick = 'Gone pad'; stop.refresh(); await run(3); assert.match(s, /the one chosen is not connected, so Xbox Wireless Controller and 1 more play LSDj/);
  stop(); }
/* rest, hats, names */
assert.equal(hatDirs(-1), 'u'); assert.equal(hatDirs(1 / 7), 'd'); assert.equal(hatDirs(1), 'ul'); assert.equal(hatDirs(9 / 7), ''); assert.equal(hatDirs(undefined), '');
{ const c = calibrate({axes: [0.05, -1, 9 / 7]}); assert.deepEqual(c.rest, [0, -1, 0]); assert.deepEqual([...c.hats], [2]); assert.equal(firstHat(c), 2); }
assert.equal(inputName('b3', false), 'Button 4'); assert.equal(inputName('a1-', false), 'Axis 2 −'); assert.equal(inputName('h9l'), 'D-pad left');
assert.deepEqual(genericMap(9).UP, ['h9u', 'a1-']); assert.deepEqual(genericMap().UP, ['a1-']);
assert.equal(defaultMapFor({standard: true}), DEFAULT_MAP); assert.deepEqual(defaultMapFor({standard: false, hat: 9}), genericMap(9));
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
assert.equal(inputName('a3+'), 'Right stick down'); assert.equal(inputName('b20'), 'Button 21'); assert.equal(inputName('x'), '');
assert.deepEqual(cleanMap(null), {...DEFAULT_MAP}); assert.ok(isDefaultMap(cleanMap({})));
assert.deepEqual(cleanMap({A: ['b4', 'zz', 'b5', 'b6'], B: 'no'}).A, ['b4', 'b5']);            /* bad codes out, two at most */
assert.deepEqual(cleanMap({A: ['b4']}).B, DEFAULT_MAP.B);
{ let m = assign(DEFAULT_MAP, 'START', 1, 'b5');                                                /* START: Menu and RB */
  assert.deepEqual(m.START, ['b9', 'b5']); assert.ok(!isDefaultMap(m));
  m = assign(m, 'START', 0, null); assert.deepEqual(m.START, ['b5']);                          /* Menu off */
  m = assign(m, 'A', 1, 'b0'); assert.deepEqual(m.A, ['b0']);                                  /* the same input twice: once */
  assert.deepEqual(takenFrom(m, 'SELECT', 'b5'), ['START']);
  m = assign(m, 'SELECT', 1, 'b5'); assert.deepEqual(m.SELECT, ['b8', 'b5']); assert.deepEqual(m.START, []);   /* RB moves to SELECT */
  assert.equal(padMask(pad([5]), m), GB.SELECT); assert.equal(padMask(pad([9]), m), 0);
  /* swap A and B: the bottom button to B takes it off A, the right one to A takes it off B */
  { let s = assign(DEFAULT_MAP, 'B', 0, 'b0'); s = assign(s, 'A', 0, 'b1');
    assert.equal(padMask(pad([0]), s), GB.B, 'bottom: B only'); assert.equal(padMask(pad([1]), s), GB.A, 'right: A only'); }
  assert.equal(padMask(pad([], [0, 0, 0.9, 0]), assign(m, 'RIGHT', 1, 'a2+')), GB.RIGHT);     /* the right stick */
  /* kept per controller, in this browser */
  const store = new Map(), st = {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k)};
  const xb = {id: 'Xbox', standard: true}, joy = {id: 'Joy', standard: false, hat: 9};
  let maps = saveMap({}, xb, m, st); assert.deepEqual(mapFor(loadMaps(st), xb, st), m);
  assert.ok(isDefaultMap(mapFor(loadMaps(st), {id: 'DualSense', standard: true}, st)), 'another controller: its own');
  maps = saveMap(maps, joy, assign(genericMap(9), 'A', 0, 'b2', genericMap(9)), st);
  assert.deepEqual(mapFor(loadMaps(st), joy, st).A, ['b2']); assert.deepEqual(mapFor(loadMaps(st), joy, st).UP, ['h9u', 'a1-']);
  maps = saveMap(maps, xb, DEFAULT_MAP, st); maps = saveMap(maps, joy, genericMap(9), st);
  assert.equal(store.size, 0, 'the defaults: nothing kept');
  store.set('lsdj-burrito-pad-map', JSON.stringify(m)); assert.deepEqual(mapFor(loadMaps(st), xb, st), m, 'the first remap page\'s map carried over');
  assert.ok(isDefaultMap(mapFor(loadMaps(st), joy, st), genericMap(9)), '... for standard controllers only');
  store.set('lsdj-burrito-pad-maps', '{bad'); assert.deepEqual(loadMaps(st), {});
  assert.deepEqual(loadMaps({getItem: () => { throw Error('blocked'); }}), {});
  savePick('Joy', st); assert.equal(loadPick(st), 'Joy'); savePick('', st); assert.equal(loadPick(st), ''); }
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
/* an axis "button" held when the browser first showed the pad: taken as its rest, then let go to the middle: after
   SETTLE_MS there it rests at the middle, and pressing it reads again */
{ const gp = {axes: [1, 0]}; let c = calibrate(gp, null, 0);
  assert.equal(c.rest[0], 1);
  gp.axes[0] = 0; c = calibrate(gp, c, 100); c = calibrate(gp, c, 500); assert.equal(c.rest[0], 1, 'not yet');
  c = calibrate(gp, c, 800); assert.equal(c.rest[0], 0, 'settled');
  gp.axes[0] = 1; assert.deepEqual(heldInputs(gp, c), ['a0+']);
  /* a trigger resting at -1 stays so */
  const tr = {axes: [-1]}; let d = calibrate(tr, null, 0); d = calibrate(tr, d, 5000); assert.equal(d.rest[0], -1);
  /* Re-centre: where everything is now (hats kept) */
  const rc = recentre({axes: [0.6, -1, 9 / 7]}, {rest: [0, 0, 0], hats: new Set([2])});
  assert.deepEqual(rc.rest, [0.6, -1, 0]); assert.ok(rc.hats.has(2));
  /* a pressure button part way: taken when remapping only */
  const pb = {buttons: [{pressed: false, value: 0.4}], axes: []};
  assert.deepEqual(heldInputs(pb), []); assert.deepEqual(heldInputs(pb, null, true), ['b0']);
  /* the raw view */
  assert.deepEqual(rawInputs({buttons: [{pressed: true, value: 0}, {pressed: false, value: 0.333}], axes: [0.1234, 9 / 7]}, {rest: [0, 0], hats: new Set([1])}),
    {buttons: [1, 0.33], axes: [0.12, 1.29], rest: [0, 0], hats: [1]}); }
{ let tickFn, raws = [], pads = [{...pad(), axes: [1, 0, 0, 0], id: 'Odd', mapping: ''}];
  const stop = startGamepad({send: async () => {}, nav: {getGamepads: () => pads}, now: () => 0, onRaw: r => raws.push(r),
                             every: f => { tickFn = f; return 1; }, cancel: () => {}});
  tickFn(); assert.equal(raws.at(-1).rest[0], 1);
  pads[0].axes[0] = 0; stop.recentre(); assert.equal(raws.at(-1).rest[0], 0, 'Re-centre from the page'); stop(); }
/* several FM-1s: each controller plays its own target; one mask per target; a target no controller plays any more
   gets 0 once; a busy target waits without holding up the others; stop lets go everywhere */
{ let t = 0, tickFn, sent = [], targets = {0: 'a', 1: 'b'}, busyB = false;
  const pads = [{...pad([0]), index: 0}, {...pad([12]), index: 1, id: 'Other Pad (STANDARD GAMEPAD)'}];
  const stop = startGamepad({send: async (m, k) => { sent.push([k, m]); }, nav: {getGamepads: () => pads}, now: () => t,
    getTarget: info => targets[info.index] ?? null, canSend: k => !(k === 'b' && busyB),
    every: f => { tickFn = f; return 1; }, cancel: () => {}});
  const run = async ms => { for (let i = 0; i < ms; i += 16) { t += 16; tickFn(); await Promise.resolve(); await Promise.resolve(); } };
  await run(32);
  assert.deepEqual(sent.slice(0, 2).sort(), [['a', GB.A], ['b', GB.UP]], `each to its own FM-1: ${JSON.stringify(sent)}`);
  targets[1] = 'a'; sent = []; await run(32);
  assert.ok(sent.some(([k, m]) => k === 'a' && m === (GB.A | GB.UP)) && sent.some(([k, m]) => k === 'b' && m === 0), `both on a; b let go: ${JSON.stringify(sent)}`);
  targets[1] = 'b'; busyB = true; sent = []; await run(64);
  assert.ok(sent.every(([k]) => k === 'a') && sent.some(([, m]) => m === GB.A), `b busy: a still sent: ${JSON.stringify(sent)}`);
  busyB = false; await run(32);
  assert.ok(sent.some(([k, m]) => k === 'b' && m === GB.UP), 'b when free');
  targets[0] = null; sent = []; await run(32);
  assert.deepEqual(sent.filter(([k]) => k === 'a'), [['a', 0]], 'a controller set to Nothing: its FM-1 let go once');
  stop(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(sent.at(-1), ['b', 0], 'stop lets go'); }
console.log('PASS gamepad: layout (Xbox A/Y -> A, B/X -> B, d-pad and stick), names, several FM-1s (a target each), sent at once, held every 200 ms, released once, busy link, retries, choosing a controller, controllers without the standard layout (rest, hat d-pad), remapping (names, slots, a button moves, kept per controller, capture), settling, re-centre, pressure buttons, raw view');
