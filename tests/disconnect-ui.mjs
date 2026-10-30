// SPDX-License-Identifier: GPL-3.0-only
// My FM-1 notices a lost FM-1: the cable pulled (Web MIDI statechange), a port gone without an event
// (the live poll checks), or no answers (LOST_POLLS polls in a row); it connects again by itself when
// the port comes back. A mocked FM-1 (no device is touched).
import {OP, le32} from '../lsdj/link.js';

const $ = id => document.getElementById(id);
const assert = (v, message) => { if (!v) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, tries = 160) {
  for (let n = 0; n < tries; n++) { if (check()) return; await sleep(50); }
  throw Error(message);
}
export async function runDisconnectUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  const access = new EventTarget();
  const input = {id: 'in-1', name: 'FM-1 test', state: 'connected'};
  let silent = false, infos = 0, lives = 0;
  const bytes = Array(68).fill(0);
  bytes[36] = 5; bytes[37] = 2; bytes[42] = 0xf2; bytes[43] = 70; bytes[38] = 1;
  const output = {id: 'out-1', name: 'FM-1 test', state: 'connected', send(message) {
    if (this.state !== 'connected') throw new DOMException('The port is not connected', 'InvalidStateError');
    const op = message[4];
    const send = (data = [], status = 0) => queueMicrotask(() => input.onmidimessage?.({
      data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7]}));
    if (silent) return;
    if (op === OP.INFO) { infos++; const info = Array(35).fill(0); info[0] = 1; [...'FM-1_981'].forEach((c, i) => info[1 + i] = c.charCodeAt(0)); return send(info); }
    if (op === OP.FX_GET) return send(bytes);
    if (op === OP.SETTINGS_GET) return send(le32(0x5a000000));
    if (op === OP.THEME_GET) return send(Array(16).fill(0));
    if (op === OP.LIVE) { lives++; return send([0, 1, 120, 0, 0, 0, 0, ...bytes]); }
    return send([], 1);   // MIDI options, the screen: not on this firmware
  }};
  access.inputs = new Map([['in', input]]); access.outputs = new Map([['out', output]]);
  const plug = state => {
    input.state = output.state = state;
    for (const port of [input, output]) { const e = new Event('statechange'); e.port = port; access.dispatchEvent(e); }
  };
  const device = () => $('device').textContent;
  const isConnected = () => document.body.classList.contains('connected') && $('live-sec').getAttribute('aria-disabled') === 'false';
  try {
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true, value: async () => access});
    assert(!$('fm1-screen-rate'), 'no screen draw line');
    await $('connect-btn').onclick();
    assert(isConnected() && /Connected over USB/.test(device()), device());
    await until(() => lives > 2, 'the live poll runs');

    // 1. the cable pulled: Web MIDI says so
    plug('disconnected');
    assert(!isConnected() && /was disconnected/.test(device()), `unplugged: ${device()}`);
    assert(/Not connected/.test($('conn-chip').textContent), 'chip: not connected');
    const after = lives; await sleep(1200);
    assert(lives === after, 'no polling while disconnected');

    // 2. plugged in again: connects by itself
    const before = infos;
    plug('connected');
    await until(() => isConnected(), `reconnected by itself: ${device()}`);
    assert(infos > before && /Connected over USB/.test(device()), device());

    // 3. a port gone without an event: the poll sees it
    input.state = 'disconnected';
    await until(() => !isConnected(), `port state seen by the poll: ${device()}`);
    assert(/was disconnected/.test(device()), device());
    plug('connected');
    await until(() => isConnected(), 'reconnected after the poll saw it');

    // 4. no answers: lost after a few polls, ports still there
    silent = true;
    await until(() => !isConnected(), `stopped answering: ${device()}`, 200);
    assert(/stopped answering/.test(device()), device());
    silent = false;
    await $('connect-btn').onclick();
    assert(isConnected(), `Connect again: ${device()}`);

    // 5. still there but not answering when it comes back: says so, stays disconnected
    plug('disconnected'); silent = true; plug('connected');
    await until(() => /did not answer/.test(device()), `back but silent: ${device()}`, 300);
    assert(!isConnected(), 'not connected while silent');
    silent = false;
    await $('connect-btn').onclick();
    assert(isConnected(), 'connected at the end');
    return 'PASS disconnect browser: unplugged (statechange), port gone (poll), no answers (4 polls), reconnects by itself, says when it comes back silent, no screen draw line';
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor);
    else delete navigator.requestMIDIAccess;
  }
}
