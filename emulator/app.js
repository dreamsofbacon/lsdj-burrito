// SPDX-License-Identifier: GPL-3.0-only
import {getSelectedFirmware, getFirmwareSelection, installing} from '../lsdj/install-ui.js';
import {firmwareForEmulator, loadRuntime, KEY_IDS} from './core.js';
import {createPanel} from './panel.js';
import {readSave, writeSave, FTL_LO, FTL_N, SECTOR} from './save-flash.js';
import {confirmSaveImport} from '../lsdj/save-file.js';

const $ = id => document.getElementById(id);
const say = (text, cls = 'hint') => { $('emu-status').textContent = text; $('emu-status').className = cls; };
let wasm, ui, panel, panelPromise, audio, node, gain, bootTimer;
let fileGeneration = 0;
let generation = 0, phase = 'idle', file = null, current = null, front = true;   // flat (front) view by default
let timing = null;
let songs = null, songsName = '', lastFirmware = null;   // a .sav to start with; what the last start ran
let snapshotRequest = 0; const snapshotWaiters = new Map();
let state = {keys: new Set(), enc: new Int32Array(7), pot: 900};
/* The virtual FM-1 for My FM-1 (lsdj/app.js): a USB cable plugged in at boot (the wasm built with
   vendor/fm1-emu-usb.patch), and a MIDI input / output pair on it, shaped like Web MIDI ports, for the
   page's Link. usb: this run has the cable; booted: resolves when the firmware runs. */
let usb = false, bootedWait = null;
const virtualIn = {id: 'virtual-fm1', name: 'Virtual FM-1', state: 'disconnected', onmidimessage: null};
const virtualOut = {id: 'virtual-fm1', name: 'Virtual FM-1', state: 'disconnected',
  send(bytes) { if (usb && phase === 'running') send({type: 'usb', bytes: Uint8Array.from(bytes)}); }};
function fromUsb(out) {   /* what the FM-1 sent: SysEx to its F7, anything else by its status */
  for (let i = 0; i < out.length;) {
    let j = i + 1;
    if (out[i] === 0xF0) { while (j < out.length && out[j] !== 0xF7) j++; j++; }
    else if (out[i] < 0xF8) j = i + ([0xC0, 0xD0].includes(out[i] & 0xF0) ? 2 : 3);
    virtualIn.onmidimessage?.({data: out.subarray(i, j)}); i = j;
  }
}
function virtualState(on) {
  const was = virtualIn.state;
  virtualIn.state = virtualOut.state = on ? 'connected' : 'disconnected';
  if (was !== virtualIn.state) document.dispatchEvent(new CustomEvent('virtual-fm1', {detail: {connected: on}}));
}
const owners = new Map();
const send = message => node?.port.postMessage(message);
const lcdContext = $('emu-lcd').getContext('2d');
const lcdImage = lcdContext.createImageData(240, 240);
function draw(frame) {
  panel?.draw(frame, state);
  if (frame?.lcd) {
    for (let i = 0; i < frame.lcd.length; i++) {
      const p = frame.lcd[i], at = i * 4;
      lcdImage.data[at] = (p >>> 11) * 255 / 31;
      lcdImage.data[at + 1] = (p >>> 5 & 63) * 255 / 63;
      lcdImage.data[at + 2] = (p & 31) * 255 / 31;
      lcdImage.data[at + 3] = 255;
    }
    lcdContext.putImageData(lcdImage, 0, 0);
  }
}
function buttons() {
  const loading = phase === 'loading', running = phase === 'running', paused = phase === 'paused';
  const selected = getFirmwareSelection();
  $('emu-file').disabled = loading;
  $('emu-start').disabled = loading || !file || installing();
  $('emu-selected').disabled = loading || installing() || !selected;
  $('emu-selection').textContent = selected ?
    `Prepared firmware: ${selected.name} (${selected.product}).` :
    'No prepared firmware yet: prepare one in Install, or choose a .fwsc file.';
  $('emu-pause').disabled = !running && !paused;
  $('emu-pause').textContent = paused ? 'Resume' : 'Pause';
  $('emu-stop').disabled = phase === 'idle';
  $('emu-clock').disabled = phase !== 'idle';
  $('emu-sav-export').disabled = phase !== 'running' && phase !== 'paused';
  $('emu-sav-file').disabled = loading;
  document.dispatchEvent(new CustomEvent('virtual-fm1-firmware'));   /* My FM-1's Use the virtual FM-1 */
}
function setKey(source, id, down) {
  if (phase !== 'running' && down) return;
  const previous = new Set(owners.values());
  if (down) owners.set(source, id); else owners.delete(source);
  state.keys = new Set(owners.values());
  for (const key of previous) if (!state.keys.has(key)) send({type: 'key', id: key, down: false});
  for (const key of state.keys) if (!previous.has(key)) send({type: 'key', id: key, down: true});
  draw();
}
function releaseAll() {
  for (const id of state.keys) send({type: 'key', id, down: false});
  owners.clear(); state.keys.clear(); draw();
}
function turn(index, clicks) {
  if (phase !== 'running') return;
  state.enc[index] += clicks;
  send({type: 'enc', enc: ui.panel_enc_id(index), clicks}); draw();
}
function pot(delta) {
  if (phase !== 'running') return;
  state.pot = Math.max(0, Math.min(1023, Math.round(state.pot + delta)));
  send({type: 'pot', value: state.pot}); draw();
}
const keydown = e => {
  const id = KEY_IDS[e.code];
  if (id === undefined || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault(); setKey(e.code, id, true);
};
const keyup = e => {
  if (KEY_IDS[e.code] === undefined) return;
  e.preventDefault(); setKey(e.code, 0, false);
};
async function closeMachine() {
  clearTimeout(bootTimer); releaseAll();
  virtualState(false); usb = false;
  send({type: 'cancel-boot'});
  if (node) { node.port.onmessage = null; node.disconnect(); node.port.close(); node = null; }
  gain?.disconnect(); gain = null;
  const old = audio; audio = null;
  if (old && old.state !== 'closed') await old.close();
}
async function stop(message = 'Stopped. Virtual songs/settings were discarded; no physical device was changed.', cls = 'hint') {
  const seq = ++generation; ++fileGeneration; phase = 'idle'; buttons();
  bootedWait?.reject(Error(message)); bootedWait = null;
  try { await closeMachine(); }
  catch (error) { if (seq === generation) say(`Emulator shutdown failed: ${error.message}`, 'bad'); return; }
  if (seq === generation) say(message, cls);
}
function fail(error) { void stop(`Emulator stopped: ${error.message || error}`, 'bad'); }
async function ensurePanel() {
  if (!panelPromise) panelPromise = (async () => {
    if (!wasm) wasm = await loadRuntime();
    if (!ui) ui = (await WebAssembly.instantiate(wasm, {env: {fm1_jit_compile: () => 0}})).instance.exports;
    panel = await createPanel($('emu-view'), ui, {key: setKey, turn, pot, keydown, keyup, releaseAll}, fail);
    panel.angle(Number($('emu-tilt').value), Number($('emu-yaw').value)); panel.front(front); panel.lsdj($('emu-lsdj').checked);
  })().catch(error => { panelPromise = null; throw error; });
  await panelPromise;
  draw();
}
async function start(bytes, name, {withUsb = false} = {}) {
  if (installing()) throw Error('Wait for the physical firmware installation to finish.');
  if (phase === 'loading') throw Error('The virtual FM-1 is already starting.');
  const checked = firmwareForEmulator(bytes);
  if (phase !== 'idle' && !confirm('Restart the virtual FM-1? Unsaved virtual songs and settings will be discarded.')) return;
  const seq = ++generation;
  phase = 'loading'; buttons(); say('Loading the local FM-1 emulator...');
  try {
    await closeMachine();
    if (seq !== generation) return;
    audio = new AudioContext({sampleRate: 44100, latencyHint: 'playback'});
    await audio.resume();
    if (audio.sampleRate !== 44100) throw Error('This emulator requires 44100 Hz browser audio.');
    const context = audio;
    usb = withUsb;
    await ensurePanel();
    if (seq !== generation) return;
    await context.audioWorklet.addModule(new URL('vendor/worklet.js', import.meta.url));
    if (seq !== generation) return;
    node = new AudioWorkletNode(context, 'fm1', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]});
    gain = context.createGain(); gain.gain.value = Number($('emu-volume').value) / 100;
    node.connect(gain); gain.connect(context.destination);
    node.onprocessorerror = () => { if (seq === generation) fail('Audio/emulator processor failed. Stop and retry.'); };
    current = {product: checked.product, name};
    state = {keys: new Set(), enc: new Int32Array(7), pot: 900}; owners.clear(); draw();
    $('emu-stats').textContent = ''; delete $('emu-view').dataset.emulatedMs;
    timing = null;
    node.port.onmessage = e => {
      const m = e.data;
      if (seq !== generation || m.seq !== seq) return;
      if (m.type === 'error') { fail(m.message); return; }
      if (m.type === 'snapshot') { snapshotWaiters.get(m.request)?.(m); snapshotWaiters.delete(m.request); return; }
      if (m.type === 'usb-out') { fromUsb(m.bytes); return; }
      if (m.type === 'booted') {
        clearTimeout(bootTimer);
        if (m.board !== 0) { fail('This view supports FM-1 firmware only.'); return; }
        phase = 'running'; buttons(); send({type: 'pot', value: state.pot});
        if (usb) virtualState(true);
        bootedWait?.resolve(); bootedWait = null;
        say(`Emulating ${current.product} from ${current.name}${songs ? `, with the songs from ${songsName}` : ''}. This is virtual hardware, not a hardware validation.`, 'ok');
        if (document.hidden) $('emu-pause').click();
        else panel.canvas.focus({preventScroll: true});
      } else if (m.type === 'frame') {
        draw(m);
        $('emu-view').dataset.emulatedMs = String(m.ms);
        if (m.halted) { fail(`The emulated CPU halted (code ${m.halted}).`); return; }
        const now = performance.now();
        if (!timing) timing = {wall: now, emulated: m.ms};
        if (now - timing.wall >= 1000) {
          const speed = Math.round((m.ms - timing.emulated) / (now - timing.wall) * 100);
          $('emu-stats').textContent = `${(m.ms / 1000).toFixed(1)} s emulated | ${speed}% real-time | ` +
            `${m.short} short audio buffers | ${m.jit?.failed || 0} JIT fallbacks. ` +
            (speed < 90 ? 'Below real-time: audio/timing may be inaccurate on this computer.' : '');
          timing = {wall: now, emulated: m.ms};
        }
      }
    };
    bootTimer = setTimeout(() => { if (seq === generation) fail('Firmware initialization timed out.'); }, 30000);
    lastFirmware = {bytes: checked.bytes.slice(), name};
    send({type: 'boot', seq, wasm, package: checked.bytes.buffer, mhz: Number($('emu-clock').value), jit: true,
      flashPatch: songs ? saveRegion(songs) : undefined, usb});
  } catch (error) { if (seq === generation) await stop(error.message, 'bad'); }
}
$('emu-file').onchange = e => {
  ++fileGeneration;
  file = e.target.files[0] || null;
  buttons();
  if (file) say(`${file.name} selected. Start runs it only in the virtual FM-1.`);
};
$('emu-start').onclick = async () => {
  if (!file || phase === 'loading') return;
  try {
    if (file.size > 2 * 1024 * 1024) throw Error('Choose an FM-1 package no larger than 2 MiB.');
    const chosen = file, seq = ++fileGeneration;
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    if (seq !== fileGeneration) return;
    await start(bytes, chosen.name);
  } catch (error) { say(error.message, 'bad'); }
};
$('emu-selected').onclick = async () => {
  try { const selected = getSelectedFirmware(); await start(selected.bytes, selected.name); }
  catch (error) { say(error.message, 'bad'); }
};
$('emu-stop').onclick = () => void stop();
$('emu-pause').onclick = async () => {
  if (!audio || !['running', 'paused'].includes(phase)) return;
  const seq = generation, context = audio, pausing = phase === 'running';
  $('emu-pause').disabled = true;
  try {
    releaseAll();
    if (pausing) await context.suspend(); else await context.resume();
    if (seq !== generation || audio !== context) return;
    if (pausing) { phase = 'paused'; say('Paused. Virtual memory is retained until Stop or reload.'); }
    if (usb) virtualState(!pausing);
    else { timing = null; phase = 'running'; say(`Emulating ${current.product}.`, 'ok'); }
    buttons();
  } catch (error) { if (seq === generation) fail(error); }
};
$('emu-volume').oninput = () => { if (gain) gain.gain.value = Number($('emu-volume').value) / 100; };
$('emu-zoom').onclick = () => {
  $('emu-lcd').hidden = !$('emu-lcd').hidden;
  $('emu-zoom').setAttribute('aria-expanded', String(!$('emu-lcd').hidden));
};
$('emu-tilt').oninput = $('emu-yaw').oninput = () => panel?.angle(Number($('emu-tilt').value), Number($('emu-yaw').value));
$('emu-front').onclick = () => {
  front = !front; panel?.front(front);
  $('emu-front').setAttribute('aria-pressed', String(front)); $('emu-front').textContent = front ? 'Angled view' : 'Front view';
};
document.addEventListener('visibilitychange', () => {
  releaseAll();
  if (document.hidden && phase === 'running') $('emu-pause').click();
});
window.addEventListener('blur', releaseAll);
document.addEventListener('firmware-selection-state', buttons);
document.addEventListener('firmware-install-state', () => {
  if (installing() && phase !== 'idle') void stop('Emulator stopped to free resources for the physical firmware installation.');
  buttons();
});
buttons();

// ---- LSDj's buttons drawn on the keys
$('emu-lsdj').onchange = () => panel?.lsdj($('emu-lsdj').checked);

// ---- LSDj songs (.sav): start the virtual FM-1 with them, or save what it holds
function saveRegion(save) {
  const flash = new Uint8Array(FTL_LO + FTL_N * SECTOR).fill(0xFF);
  writeSave(flash, save);
  return {offset: FTL_LO, bytes: flash.slice(FTL_LO).buffer};
}
$('emu-sav-file').onchange = async e => {
  const chosen = e.target.files[0];
  e.target.value = '';
  if (!chosen) return;
  try {
    if (chosen.size > 131072 + 16) throw Error(`${chosen.name} is not an LSDj save (128 KiB).`);
    const save = confirmSaveImport(new Uint8Array(await chosen.arrayBuffer()), chosen.name,
      text => confirm(text.replace('on the FM-1', 'in the virtual FM-1')));
    if (!save) return;
    songs = save; songsName = chosen.name;
    if (phase === 'running' || phase === 'paused') {
      if (!lastFirmware) return;
      await start(lastFirmware.bytes, lastFirmware.name);
    } else say(`${chosen.name} will be loaded when the virtual FM-1 starts.`);
  } catch (error) { say(error.message, 'bad'); }
};
function snapshot() {
  return new Promise((resolve, reject) => {
    const request = ++snapshotRequest;
    const timer = setTimeout(() => { snapshotWaiters.delete(request); reject(Error('The virtual FM-1 did not answer.')); }, 5000);
    snapshotWaiters.set(request, m => { clearTimeout(timer); resolve(m); });
    send({type: 'snapshot', seq: generation, request});
  });
}
$('emu-sav-export').onclick = async () => {
  try {
    const m = await snapshot();
    if (m.unavailable || !m.flash) throw Error(m.error || 'The virtual FM-1 is busy writing; try again in a moment.');
    const save = readSave(new Uint8Array(m.flash));
    if (!save) throw Error('Nothing saved yet: press SAVE on the virtual FM-1 first (LSDj saves its songs there).');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([save], {type: 'application/octet-stream'}));
    a.download = `lsdj-burrito-virtual-${new Date().toISOString().slice(0, 10)}.sav`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    say('Saved the songs from the virtual FM-1 (as of its last SAVE).', 'ok');
  } catch (error) { say(error.message, 'bad'); }
};

// ---- a MIDI keyboard plays the virtual FM-1 (its MIDI input, as the TRS socket)
const midiInputs = new Set();
function listenMidi(access) {
  for (const input of access.inputs.values()) {
    if (midiInputs.has(input)) continue;
    midiInputs.add(input);
    input.onmidimessage = e => {
      if (phase !== 'running' || e.data[0] === 0xFE) return;   // (active sensing: not needed)
      send({type: 'midi', bytes: Array.from(e.data)});
    };
  }
  const names = [...access.inputs.values()].map(i => i.name);
  $('emu-midi-status').textContent = names.length ? `MIDI in: ${names.join(', ')}` : 'No MIDI keyboard found. Plug one in; it is picked up when it connects.';
}
if (navigator.requestMIDIAccess) {
  $('emu-midi').hidden = false;
  $('emu-midi').onclick = async () => {
    try {
      const access = await navigator.requestMIDIAccess();
      $('emu-midi').disabled = true;
      listenMidi(access);
      access.onstatechange = () => listenMidi(access);
    } catch (error) { $('emu-midi-status').textContent = `MIDI not available: ${error.message}`; }
  };
}

// ---- the virtual FM-1 in My FM-1 (lsdj/app.js): Perform, Songs, Colours and Settings over emulated USB
/* Start the virtual FM-1 with a USB cable (restarting one without it), with the prepared firmware, else the
   .fwsc chosen here, else the last one run; resolves {input, output} once its firmware runs. */
export async function startVirtual() {
  if (usb && phase === 'running') return {input: virtualIn, output: virtualOut};
  if (usb && phase === 'paused') { $('emu-pause').click(); return {input: virtualIn, output: virtualOut}; }
  let fw = getFirmwareSelection() ? getSelectedFirmware() : null;
  if (!fw && file) fw = {bytes: new Uint8Array(await file.arrayBuffer()), name: file.name};
  if (!fw && lastFirmware) fw = lastFirmware;
  if (!fw) throw Error('No firmware for the virtual FM-1 yet: prepare one in Install (or choose a .fwsc file in Try it).');
  const booted = new Promise((resolve, reject) => { bootedWait = {resolve, reject}; });
  booted.catch(() => {});
  await start(fw.bytes, fw.name, {withUsb: true});
  if (!usb) { bootedWait = null; throw Error('The virtual FM-1 was not restarted.'); }   /* the restart was cancelled */
  await booted;
  return {input: virtualIn, output: virtualOut};
}
export const virtualRunning = () => usb && phase === 'running';
export const virtualFirmware = () => !!(getFirmwareSelection() || file || lastFirmware);
/* The instrument (and the enlarged screen) shown somewhere else: Perform's Screen panel; null puts them back */
const home = {view: null, lcd: null};
export function mountVirtual(box) {
  const view = $('emu-view'), lcd = $('emu-lcd');
  if (!home.view) { home.view = view.previousElementSibling; home.lcd = lcd.previousElementSibling; }
  view.classList.toggle('fill', !!box);
  if (box) { box.append(view, lcd); return; }
  home.view.after(view); home.lcd.after(lcd);
  lcd.hidden = true; $('emu-zoom').setAttribute('aria-expanded', 'false');
}
export const stopVirtual = () => stop();
/* an encoder of the virtual FM-1 turned (enc as fm1-emu numbers them: 0 SELECT, 2-5 KNOB1-4) */
export function turnVirtual(enc, clicks) { if (phase === 'running') send({type: 'enc', enc, clicks}); }
