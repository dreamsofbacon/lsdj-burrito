// SPDX-License-Identifier: GPL-3.0-only
// Perform's wiring: a block opens its effects page (channel pages in Channels, MASTER and the echo in
// Master) with its channel's controls marked; Enter does the same; the Columns / Rows toggle redraws
// and is kept. A mocked FM-1_989 (no device is touched).
import {OP, le32} from '../lsdj/link.js';

const $ = id => document.getElementById(id);
const assert = (v, message) => { if (!v) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, tries = 80) {
  for (let n = 0; n < tries; n++) { if (check()) return; await sleep(50); }
  throw Error(message);
}
export async function runWiringUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  let kept = null;
  try { kept = localStorage.getItem('wiring-direction'); localStorage.removeItem('wiring-direction'); } catch { /* none */ }
  const input = {name: 'FM-1 test'}, bytes = Array(68).fill(0);
  bytes[36] = 5; bytes[37] = 2; bytes[42] = 0xf2; bytes[43] = 70; bytes[38] = 1;
  const output = {name: 'FM-1 test', send(message) {
    const op = message[4];
    const send = (data = [], status = 0) => queueMicrotask(() => input.onmidimessage?.({
      data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7]}));
    if (op === OP.INFO) { const info = Array(35).fill(0); info[0] = 1; [...'FM-1_989'].forEach((c, i) => info[1 + i] = c.charCodeAt(0)); return send(info); }
    if (op === OP.FX_GET) return send(bytes);
    if (op === OP.SETTINGS_GET) return send(le32(0x5a000000));
    if (op === OP.THEME_GET) return send(Array(16).fill(0));
    if (op === OP.FEAT_GET) return send(le32(0x460001CE));
    if (op === OP.LIVE) return send([1, 1, 120, 0, 0, 0, 0, ...bytes, 0x82]);   // the FM-1 on FILTER
    return send([], 1);
  }};
  const blk = (go, ch) => document.querySelector(`#fx-diagram [data-go="${go}"]${ch == null ? '' : `[data-ch="${ch}"]`}`);
  const shownName = () => document.querySelector('#fx-pages .fx-card.shown h3')?.firstChild.textContent;
  try {
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true,
      value: async () => ({inputs: new Map([['test', input]]), outputs: new Map([['test', output]])})});
    await $('connect-btn').onclick();
    location.hash = '#live-sec';
    await until(() => blk('drive', 2), 'the wiring drawn');
    assert(document.querySelector('#fx-diagram svg').dataset.layout === 'v', 'upright by default');
    assert($('wire-dir').querySelector('[data-dir="v"]').classList.contains('on'), 'Columns lit');
    await until(() => shownName() === 'FILTER', `follows the FM-1: ${shownName()}`);

    // a channel block: its page shown in Channels, not following the FM-1, its channel marked
    blk('drive', 2).dispatchEvent(new MouseEvent('click', {bubbles: true}));
    assert(shownName() === 'DRIVE', `DRIVE shown: ${shownName()}`);
    assert(!$('fx-page-follow').classList.contains('on'), 'no longer follows the FM-1 page');
    const picked = [...document.querySelectorAll('#fx-pages .fx-card.shown .fx-ctl.picked')];
    assert(picked.length && picked.every(el => el.dataset.ch === '2'), `WAV's controls marked: ${picked.map(e => e.dataset.ch)}`);
    await sleep(700);   // the poll does not take the page back
    assert(shownName() === 'DRIVE', `stays on DRIVE: ${shownName()}`);
    for (const [go, name] of [['filter', 'FILTER'], ['lofi', 'LO-FI'], ['lfo', 'LFO']]) {
      blk(go, 0).dispatchEvent(new MouseEvent('click', {bubbles: true}));
      assert(shownName() === name, `${go}: ${shownName()}`);
    }
    // the shared ones: in Master (FM-1_981 and newer)
    blk('echo').dispatchEvent(new MouseEvent('click', {bubbles: true}));
    const echoCard = document.querySelector('#fx-master-pages .fx-card.picked');
    assert(echoCard?.querySelector('h3').firstChild.textContent === 'ECHO', 'echo: the ECHO card in Master');
    blk('comp').dispatchEvent(new MouseEvent('click', {bubbles: true}));
    assert([...document.querySelectorAll('#fx-master-pages .fx-card.picked')].some(c => c.querySelector('h3').firstChild.textContent === 'MASTER'), 'comp: MASTER');
    // the keyboard: Enter on a focused block
    blk('drive', 1).focus();
    blk('drive', 1).dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    assert(shownName() === 'DRIVE', `Enter opens DRIVE: ${shownName()}`);
    // FM-1 page: following again
    $('fx-page-follow').onclick();
    await until(() => shownName() === 'FILTER', 'back to the FM-1 page');

    // the toggle: Rows, kept in this browser, still opens pages; Columns again
    $('wire-dir').querySelector('[data-dir="h"]').click();
    assert(document.querySelector('#fx-diagram svg').dataset.layout === 'h', 'across');
    assert($('pan-wire').dataset.size === '900x420', 'its own window shaped for rows');
    let stored = null; try { stored = localStorage.getItem('wiring-direction'); } catch { /* blocked */ }
    assert(stored === 'h', `kept: ${stored}`);
    blk('lofi', 3).dispatchEvent(new MouseEvent('click', {bubbles: true}));
    assert(shownName() === 'LO-FI', `rows: LO-FI ${shownName()}`);
    $('wire-dir').querySelector('[data-dir="v"]').click();
    assert(document.querySelector('#fx-diagram svg').dataset.layout === 'v' && $('pan-wire').dataset.size === '700x620', 'upright again');
    // the drawing stays put between polls when nothing changed (keyboard focus kept)
    const svg = document.querySelector('#fx-diagram svg'); await sleep(700);
    assert(document.querySelector('#fx-diagram svg') === svg, 'not redrawn while unchanged');
    return 'PASS wiring browser: blocks open DRIVE / FILTER / LO-FI / LFO (channel marked), ECHO and MASTER in Master, Enter, FM-1 page again, Columns / Rows kept, not redrawn when unchanged';
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor);
    else delete navigator.requestMIDIAccess;
    try { if (kept === null) localStorage.removeItem('wiring-direction'); else localStorage.setItem('wiring-direction', kept); } catch { /* none */ }
  }
}
