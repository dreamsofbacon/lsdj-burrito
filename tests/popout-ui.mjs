// SPDX-License-Identifier: GPL-3.0-only
// Perform: panels in their own windows (lsdj/popout.js) still work the FM-1 through the page's
// one link, and come back when their window closes. A mocked FM-1 (no device is touched).
import {OP, le32} from '../lsdj/link.js';
import {unpackFx} from '../lsdj/fx-model.js';
import {docs, isOut} from '../lsdj/popout.js';

const $ = id => document.getElementById(id);
const assert = (v, message) => { if (!v) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, tries = 80) {
  for (let n = 0; n < tries; n++) { if (check()) return; await sleep(50); }
  throw Error(message);
}
export const runPopoutUiTests = () => popoutTest('chans');
export const runPopoutScreenUiTests = () => popoutTest('screen');
async function popoutTest(which) {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  const input = {name: 'FM-1 test'};
  let bytes = Array(68).fill(0), writes = 0;
  bytes[36] = 5; bytes[37] = 2; bytes[42] = 0xf2; bytes[43] = 70; bytes[38] = 1;
  const output = {name: 'FM-1 test', send(message) {
    const op = message[4], args = [];
    for (let i = 5; i < message.length - 1; i += 2) args.push(message[i] | message[i + 1] << 7);
    const send = (data = [], status = 0) => queueMicrotask(() => input.onmidimessage?.({
      data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7]}));
    if (op === OP.INFO) { const info = Array(35).fill(0); info[0] = 1; [...'FM-1_989'].forEach((c, i) => info[1 + i] = c.charCodeAt(0)); return send(info); }
    if (op === OP.FX_GET) return send(bytes);
    if (op === OP.FX_SET) { bytes = args; writes++; return send(); }
    if (op === OP.SETTINGS_GET) return send(le32(0x5a000000));
    if (op === OP.THEME_GET) return send(Array(16).fill(0));
    if (op === OP.FEAT_GET) return send(le32(0x460001CE));
    if (op === OP.MIDI_GET) return send([], 1);
    if (op === OP.LIVE) return send([bytes[38], 1, 120, 0, 0, 0, 0, ...bytes, 0x82]);
    if ([OP.STORE, OP.MUTE_SET].includes(op)) return send();
    if (op === OP.SCREEN_SYNC) {   // every band new each time asked: every row one colour, blue
      const round = args[40];
      send([...le32(1), ...Array(18).fill([7, 0]).flat(), ...le32(0x3FFFF)]);
      for (let y = 0; y < 144; y++) {
        const v = y | 0x001F << 12;
        queueMicrotask(() => input.onmidimessage?.({data: [0xf0, 0x7d, 0x47, 0x53, OP.SCREEN_PIXELS, 0, round, v & 127, v >> 7 & 127, v >> 14 & 127, v >> 21 & 127, 0xf7]}));
      }
      return;
    }
    throw Error(`Unexpected device operation ${op}`);
  }};
  const read = () => unpackFx(Array.from({length: bytes.length / 4}, (_, i) =>
    (bytes[4 * i] | bytes[4 * i + 1] << 8 | bytes[4 * i + 2] << 16 | bytes[4 * i + 3] << 24) >>> 0));
  const wins = [];
  const realOpen = window.open;
  try {
    window.open = (...a) => { const w = realOpen.apply(window, a); if (w) wins.push(w); return w; };
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true,
      value: async () => ({inputs: new Map([['test', input]]), outputs: new Map([['test', output]])})});
    await $('connect-btn').onclick();
    location.hash = '#live-sec'; await sleep(100);
    assert(document.body.classList.contains('perform'), 'Perform: body.perform when connected on the Perform tab');
    const name = which === 'screen' ? 'screen' : 'chans', panel = which === 'screen' ? 'pan-screen' : 'pan-chans';
    $(panel).querySelector('.pop').click();
    await until(() => isOut(name), `${name} popped out (${$('fx-status')?.textContent})`);
    const pop = wins.at(-1).document;
    assert(!document.getElementById(panel) && pop.getElementById(panel) && document.body.classList.contains(`pop-${name}`), 'the panel moved into the window');
    assert(pop.querySelector('style') && pop.body.classList.contains('connected'), 'the window has the page styles and state');
    assert(docs().length === 2, `two documents: ${docs().length}`);
    if (which === 'chans') {   /* the channels in their own window: sliders send, the live poll reaches it */
      const w = writes, r = pop.querySelector('.fx-ctl[data-key="cutoff"][data-ch="1"] input');
      r.value = '33'; r.oninput();
      await until(() => writes > w, 'a slider in the window sends');
      assert(read().ch[1].cutoff === 33, `PU2 cutoff from the window: ${read().ch[1].cutoff}`);
      await until(() => pop.querySelector('#fx-channels [data-ch="1"]').classList.contains('cursor'), 'the live poll updates the window (cursor on PU2)');
    } else {   /* the screen in its own window keeps drawing, also with Perform out of sight */
      const cv = pop.getElementById('fm1-screen'), px = () => cv.getContext('2d').getImageData(80, 140, 1, 1).data;
      cv.getContext('2d').clearRect(0, 0, 160, 144);
      await until(() => px()[2] === 255 && px()[3] === 255, `the screen draws in its window (${px().join()})`);
      location.hash = '#songs-sec'; await sleep(150);
      cv.getContext('2d').clearRect(0, 0, 160, 144);
      await until(() => px()[3] === 255, 'a screen in its own window keeps drawing while Perform is out of sight');
      location.hash = '#live-sec';
    }
    /* closing the window brings the panel back */
    wins.forEach(w => w.close());
    await until(() => !isOut(name), 'the panel back after its window closes', 60);
    assert($(panel).closest('#live-sec') && !document.body.classList.contains(`pop-${name}`), 'back in place');
    { const w = writes, r = document.querySelector('.fx-ctl[data-key="cutoff"][data-ch="3"] input');
      r.value = '44'; r.oninput(); await until(() => writes > w, 'back on the page, still sending'); }
    return `PASS Perform pop-out (${which === 'screen' ? 'the screen: draws in its window, also with Perform out of sight' : 'the channels: page styles, sliders send, the live poll reaches it'}); closing brings it back`;
  } finally {
    window.open = realOpen;
    wins.forEach(w => { try { w.close(); } catch {} });
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor);
    else delete navigator.requestMIDIAccess;
  }
}
