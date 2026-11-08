// SPDX-License-Identifier: GPL-3.0-only
// Songs & kits › FM-1 list (mocked FM-1s; no device is touched): Search finds the FM-1s plugged in; with several,
// the buttons say choose one; choosing one connects to it, and the list shows it.
import {fm1} from './devices-ui.mjs';

const $ = id => document.getElementById(id);
const assert = (v, message) => { if (!v) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (check()) return; await sleep(50); }
  throw Error(message);
}
export async function runSongsDevUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  const A = fm1(1, 'LSDj-AAA'), B = fm1(2, 'LSDj-BBB');
  const access = new EventTarget();
  access.inputs = new Map([['a', A.input], ['b', B.input]]);
  access.outputs = new Map([['a', A.output], ['b', B.output]]);
  const sel = $('st-dev'), status = () => $('st-status').textContent;
  const labels = () => [...sel.options].map(o => o.textContent);
  const choose = v => { sel.value = v; sel.dispatchEvent(new Event('change')); };
  const using = d => document.body.classList.contains('connected') && $('device').textContent.includes(d.title);
  try {
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true, value: async () => access});
    location.hash = '#songtools';
    assert(sel && labels().join('|') === 'No FM-1 connected|Search for FM-1s (USB)', `the list at first: ${labels()}`);

    // 1. Search with two plugged in: both listed, none taken
    choose('scan');
    await until(() => /2 FM-1s found: choose one/.test(status()), `asks to choose: ${status()}`);
    assert(labels().some(t => t.includes(A.title)) && labels().some(t => t.includes(B.title)) && labels()[0] === 'Choose an FM-1…', `both listed: ${labels()}`);
    assert(!document.body.classList.contains('connected'), 'not connected to either');

    // 2. a button that needs the FM-1 says choose one
    [...document.querySelectorAll('#songtools button')].find(b => b.textContent === 'Read songs from the FM-1').click();
    await until(() => /Several FM-1s are plugged in/.test(status()), `Read says choose: ${status()}`);

    // 3. choosing B connects to B; the list shows it
    choose([...sel.options].find(o => o.textContent.includes(B.title)).value);
    await until(() => using(B) && /Reading and sending use FM-1 2: LSDj-BBB/.test(status()), `uses B: ${status()} / ${$('device').textContent}`);
    assert(sel.selectedOptions[0].textContent.includes(B.title) && labels()[0] !== 'Choose an FM-1…', `B shown: ${labels()}`);

    // 4. then A
    choose([...sel.options].find(o => o.textContent.includes(A.title)).value);
    await until(() => using(A) && sel.selectedOptions[0].textContent.includes(A.title), `uses A: ${$('device').textContent}`);
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor); else delete navigator.requestMIDIAccess;
  }
  return 'Songs & kits FM-1 list: search, choose one of several, switch';
}
