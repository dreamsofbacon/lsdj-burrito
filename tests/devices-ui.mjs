// SPDX-License-Identifier: GPL-3.0-only
// Several FM-1s plugged in at once (mocked; no device is touched): Connect lists them all, paired by who answers
// (they share a port name), the list switches, a moved effect goes to the FM-1 it was moved on, plugging and
// pulling one not in use changes only the list, a pulled cable reconnects to the same FM-1 only, and Follow
// switches to the FM-1 being played, but stays while the one in use is played or two others are at once.
import {OP, le32} from '../lsdj/link.js';
import {unpackSettings, packSettings} from '../lsdj/fx-model.js';

const $ = id => document.getElementById(id);
const assert = (v, message) => { if (!v) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (check()) return; await sleep(50); }
  throw Error(message);
}
function fm1(n, title) {
  const d = {n, title, page: 1, lives: 0, infos: 0, fxSets: [], silent: false, settings: 0x5a000000, screens: 0, themes: 0, delay: 0};
  const fx = Array(68).fill(0);
  fx[36] = 5; fx[37] = 2; fx[42] = 0xf2; fx[43] = 70; fx[38] = 1;
  d.input = {id: `in-${n}`, name: 'FM-1', state: 'connected', onmidimessage: null};
  d.output = {id: `out-${n}`, name: 'FM-1', state: 'connected', send(message) {
    if (this.state !== 'connected') throw new DOMException('The port is not connected', 'InvalidStateError');
    if (d.silent) return;
    const op = message[4];
    const send = (data = [], status = 0) => (d.delay ? f => setTimeout(f, d.delay) : queueMicrotask)(() => d.input.onmidimessage?.({
      data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7]}));
    if (op === OP.INFO) {
      d.infos++; const info = Array(35).fill(0); info[0] = 1;
      [...'FM-1_981'].forEach((c, i) => info[1 + i] = c.charCodeAt(0));
      [...title].forEach((c, i) => info[9 + i] = c.charCodeAt(0));
      return send(info);
    }
    if (op === OP.FX_GET) return send(fx);
    if (op === OP.FX_SET) { d.fxSets.push(message); return send(); }
    if (op === OP.SETTINGS_GET) return send(le32(d.settings));
    if (op === OP.THEME_GET) { d.themes++; return send(Array(16).fill(0)); }
    if (op >= OP.SCREEN_INFO && op <= OP.SCREEN_FRAME) d.screens++;
    if (op === OP.LIVE) { d.lives++; return send([d.page, 1, 120, 0, 0, 0, 0, ...fx]); }
    return send([], 1);
  }};
  return d;
}
export async function runDevicesUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  const A = fm1(1, 'LSDj-AAA'), B = fm1(2, 'LSDj-BBB'), C = fm1(3, 'LSDj-CCC');
  const access = new EventTarget();
  /* the inputs in another order than the outputs: paired by who answers, not by place or name */
  access.inputs = new Map([['c', C.input], ['b', B.input], ['a', A.input]]);
  access.outputs = new Map([['a', A.output], ['b', B.output], ['c', C.output]]);
  const plug = (d, state) => {
    d.input.state = d.output.state = state;
    for (const port of [d.input, d.output]) { const e = new Event('statechange'); e.port = port; access.dispatchEvent(e); }
  };
  const device = () => $('device').textContent;
  const using = d => document.body.classList.contains('connected') && device().includes(d.title);
  const options = () => [...$('dev-pick').options].filter(o => o.value !== '').map(o => o.textContent);
  const pick = d => { const s = $('stage-pick'); s.value = [...s.options].find(o => o.textContent.includes(d.title)).value; s.dispatchEvent(new Event('change')); };
  try { localStorage.removeItem('lsdj-burrito-follow'); localStorage.removeItem('lsdj-burrito-screens'); } catch {}
  try {
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true, value: async () => access});
    await $('connect-btn').onclick();
    assert(using(A), `connected to the first: ${device()}`);
    await until(() => options().length === 3, `all three listed: ${options()}`);
    assert(options().every((t, i) => t.includes([A, B, C][i].title)) && !$('stage-pick').hidden && !$('follow-btn').hidden, `the list: ${options()}`);

    // 1. switch: the poll goes to the new one only (Follow off: the others are not asked)
    pick(B);
    await until(() => using(B), `switched to B: ${device()}`);
    const a0 = A.lives, c0 = C.lives; await sleep(1200);
    assert(B.lives > 2 && A.lives === a0 && C.lives === c0, `only B polled: A ${A.lives - a0}, B ${B.lives}, C ${C.lives - c0}`);

    // 2. an effect moved just before a switch goes to B, not to A
    const slider = document.querySelector('#live-sec .fx-ctl input[type=range]');
    const bSets = B.fxSets.length, aSets = A.fxSets.length;
    slider.value = String(+slider.value === 50 ? 51 : 50); slider.dispatchEvent(new Event('input'));
    pick(A);
    await until(() => using(A), `switched to A: ${device()}`);
    assert(B.fxSets.length === bSets + 1 && A.fxSets.length === aSets, `the moved effect went to B (${B.fxSets.length - bSets}), none to A (${A.fxSets.length - aSets})`);

    // 3. pulling and plugging one not in use: the list only
    plug(C, 'disconnected');
    await until(() => options().length === 2, `C gone from the list: ${options()}`);
    assert(using(A), 'still on A');
    plug(C, 'connected');
    await until(() => options().length === 3, `C back: ${options()}`);
    assert(using(A), 'still on A');

    // 4. the one in use pulled: lost; another one plugged in meanwhile is not taken; A back: reconnects to A
    plug(A, 'disconnected');
    await until(() => !document.body.classList.contains('connected'), `A lost: ${device()}`);
    plug(C, 'disconnected'); plug(C, 'connected');
    await sleep(4500);
    assert(!document.body.classList.contains('connected'), `not connected to another FM-1: ${device()}`);
    plug(A, 'connected');
    await until(() => using(A), `reconnected to A: ${device()}`);

    // 5. Follow: B played (its page changes) while A is quiet: the page goes to B
    $('stage-follow').click();
    assert($('stage-follow').getAttribute('aria-pressed') === 'true', 'Follow on');
    await sleep(1800);   /* A quiet */
    B.page = 2;
    await until(() => using(B), `followed to B: ${device()}`, 4000);

    // 6. tolerance: B (in use) and C played at once: stays on B
    await sleep(2600);   /* past the hold after a switch */
    let playing = true;
    const play = async (d, every) => { while (playing) { d.page = d.page === 1 ? 2 : 1; await sleep(every); } };
    const both = [play(B, 400), play(C, 400)];
    await sleep(3500);
    assert(using(B), `stays on B while it is played too: ${device()}`);
    playing = false; await Promise.all(both);
    // two others played at once (A and C) while B is quiet: stays; then only A: goes to A
    await sleep(1800);
    playing = true;
    const two = [play(A, 350), play(C, 350)];
    await sleep(3000);
    assert(using(B), `stays on B while two others are played at once: ${device()}`);
    playing = false; await Promise.all(two);
    await sleep(1800);   /* both quiet again */
    A.page = A.page === 1 ? 2 : 1;
    await until(() => using(A), `then only A played: followed to A: ${device()}`, 4000);
    $('stage-follow').click();

    // 7. switching back: what the page knew shows at once (no THEME_GET first), then it is read again: A's
    // theme changed meanwhile on the FM-1 shows
    pick(B); await until(() => using(B), `to B: ${device()}`);
    const s = unpackSettings(A.settings); s.theme = (s.theme + 1) % 4; A.settings = packSettings(s);
    const themesBefore = A.themes; A.delay = 60;   /* as a real FM-1 answers (~50 ms) */
    pick(A); await until(() => using(A), `back to A: ${device()}`);
    assert(A.themes === themesBefore, 'back on A before reading its colours again');
    await until(() => document.querySelector('#settings-form select[data-key="theme"]')?.value === String(s.theme), "A's new theme read again"); A.delay = 0;

    // 8. All screens: a tile per FM-1, the one in use lit; the others' screens asked over their own links; a click switches
    $('screens-all').click();
    await until(() => document.querySelectorAll('#screens-grid .screen-tile').length === 3 && !$('screens-grid').hidden, 'three tiles');
    assert(document.querySelectorAll('#screens-grid .screen-tile.on').length === 1 && document.querySelector('.screen-tile.on').textContent.includes(A.title), 'A lit');
    const b0 = B.screens, c1 = C.screens;
    await until(() => B.screens > b0 && C.screens > c1, `B and C screens asked: ${B.screens - b0}, ${C.screens - c1}`);
    [...document.querySelectorAll('.screen-tile')].find(t => t.textContent.includes(C.title)).click();
    await until(() => using(C) && document.querySelector('.screen-tile.on')?.textContent.includes(C.title), `a click on C's screen: ${device()}`);
    $('screens-all').click();
    assert($('screens-grid').hidden, 'back to one screen');
    await sleep(800); const a2 = A.screens, b2 = B.screens; await sleep(1500);
    assert(A.screens === a2 && B.screens === b2, `the others' screens no longer asked: ${A.screens - a2}, ${B.screens - b2}`);
    return 'PASS several FM-1s: listed (paired by who answers), switching (pending effect to the right one), plug/pull of others, reconnect to the same one only, Follow (and its tolerance), switching back at once (read again after), All screens (tiles, the others screens, click to switch)';
  } finally {
    try { localStorage.removeItem('lsdj-burrito-follow'); } catch {}
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor);
    else delete navigator.requestMIDIAccess;
  }
}
