// SPDX-License-Identifier: GPL-3.0-only
// My FM-1 on the virtual FM-1 (the emulator with its emulated USB cable): it connects, Perform reads and
// writes the virtual unit both ways, the instrument stands in the Screen panel, and Stop says so.
// Needs a firmware with LSDj in it from a private local server (never published):
//   http://127.0.0.1:8778/lsdj.fwsc   (no device is touched)
import {turnVirtual} from '../emulator/app.js';

const $ = id => document.getElementById(id);
const assert = (v, message) => { if (!v) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, ms = 20000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (check()) return; await sleep(100); }
  throw Error(message);
}
const values = () => [...document.querySelectorAll('#live-sec .fx-ctl input[type=range], #live-sec .fx-ctl select')].map(i => i.value).join();
let step = '';
export async function runVirtualUiTests() {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`stuck at: ${step} | device: ${$('device').textContent} | emulator: ${$('emu-status').textContent} ${$('emu-stats').textContent}`)), 240000); });
  try { return await Promise.race([virtualUi(), limit]); } finally { clearTimeout(timer); }
}
async function virtualUi() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a local preview');
  const bytes = new Uint8Array(await (await fetch('http://127.0.0.1:8778/lsdj.fwsc')).arrayBuffer());
  const t = new DataTransfer(); t.items.add(new File([bytes], 'lsdj-test.fwsc'));
  $('emu-file').files = t.files; $('emu-file').dispatchEvent(new Event('change'));
  location.hash = '#connect'; await sleep(300);
  const device = () => $('device').textContent;
  assert(!$('virtual-btn').disabled, 'Use the virtual FM-1 is on once there is a firmware');
  const started = Date.now();
  step = 'connecting'; await $('virtual-btn').onclick();
  assert(/Connected to the virtual FM-1/.test(device()) && /FM-1_\d+/.test(device()), `connected: ${device()}`);
  const bootS = ((Date.now() - started) / 1000).toFixed(0);
  assert($('live-sec').getAttribute('aria-disabled') === 'false', 'Perform on');
  assert(/virtual FM-1/.test($('stage-dev').textContent), $('stage-dev').textContent);
  assert($('virtual-mount').contains($('emu-view')) && !$('virtual-box').hidden && $('fm1-screen-box').hidden, 'the instrument in the Screen panel');
  // page -> FM-1: a slider moved on the page holds after the live poll reads the FM-1 back
  step = 'page to FM-1'; location.hash = '#live-sec'; await sleep(500);
  const crush = document.querySelector('.fx-ctl[data-key="crush"][data-ch="0"] input');
  assert(crush, 'PU1 crush slider');
  crush.value = 100; crush.dispatchEvent(new Event('input'));
  await sleep(3500);
  assert(crush.value === '100', `the FM-1 kept the page's crush: ${crush.value}`);
  // FM-1 -> page: KNOB3 turned on the virtual FM-1 moves a control on the page
  step = 'FM-1 to page'; const before = values();
  turnVirtual(4, 20);
  await until(() => values() !== before, 'a knob turned on the virtual FM-1 shows on the page', 8000);
  // the screen only, and back
  $('virtual-view').click();
  assert($('emu-view').hidden && !$('emu-lcd').hidden, 'screen only');
  $('virtual-view').click();
  assert(!$('emu-view').hidden && $('emu-lcd').hidden, 'instrument again');
  // Pause keeps the link (the poll waits), Resume carries on: Perform still reads the FM-1
  step = 'pause'; $('emu-pause').click();
  await until(() => /Paused/.test($('emu-status').textContent), `paused: ${$('emu-status').textContent}`, 3000);
  await sleep(2500);
  assert(/Connected to the virtual FM-1/.test(device()), `still connected while paused: ${device()}`);
  $('emu-pause').click();
  await until(() => /Emulating/.test($('emu-status').textContent), `resumed: ${$('emu-status').textContent}`, 3000);
  const resumed = values(); turnVirtual(4, -20);
  await until(() => values() !== resumed, 'after Resume a knob turned on the virtual FM-1 shows on the page', 8000);
  // Stop on Try it: the page says the virtual FM-1 stopped; the instrument goes back to Try it
  step = 'stop'; $('emu-stop').click();
  await until(() => /virtual FM-1 stopped/.test(device()), `stopped: ${device()}`, 5000);
  assert($('live-sec').getAttribute('aria-disabled') === 'true', 'Perform off');
  assert($('emulator-sec').contains($('emu-view')) && $('virtual-box').hidden, 'the instrument back in Try it');
  return `PASS virtual FM-1: connects over emulated USB (${bootS} s), Perform both ways, screen-only view, Stop`;
}
