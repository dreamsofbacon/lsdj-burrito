// SPDX-License-Identifier: GPL-3.0-only
import {getSelectedFirmware, getFirmwareSelection, installing} from '../lsdj/install-ui.js';
import {firmwareForEmulator, loadRuntime, KEY_IDS} from './core.js';
import {createPanel} from './panel.js';

const $ = id => document.getElementById(id);
const say = (text, cls = 'hint') => { $('emu-status').textContent = text; $('emu-status').className = cls; };
let wasm, ui, panel, panelPromise, audio, node, gain, bootTimer;
let fileGeneration = 0;
let generation = 0, phase = 'idle', file = null, current = null, front = false;
let timing = null;
let state = {keys: new Set(), enc: new Int32Array(7), pot: 900};
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
    `Available to preview: ${selected.name} (${selected.product}). This does not change an already running virtual FM-1.` :
    'No prepared/installer package available. Prepare firmware above, select an installer package, or choose a separate local file here.';
  $('emu-pause').disabled = !running && !paused;
  $('emu-pause').textContent = paused ? 'Resume' : 'Pause';
  $('emu-stop').disabled = phase === 'idle';
  $('emu-clock').disabled = phase !== 'idle';
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
  send({type: 'cancel-boot'});
  if (node) { node.port.onmessage = null; node.disconnect(); node.port.close(); node = null; }
  gain?.disconnect(); gain = null;
  const old = audio; audio = null;
  if (old && old.state !== 'closed') await old.close();
}
async function stop(message = 'Stopped. Virtual songs/settings were discarded; no physical device was changed.', cls = 'hint') {
  const seq = ++generation; ++fileGeneration; phase = 'idle'; buttons();
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
    panel.angle(Number($('emu-tilt').value), Number($('emu-yaw').value)); panel.front(front);
  })().catch(error => { panelPromise = null; throw error; });
  await panelPromise;
  draw();
}
async function start(bytes, name) {
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
      if (m.type === 'booted') {
        clearTimeout(bootTimer);
        if (m.board !== 0) { fail('This view supports FM-1 firmware only.'); return; }
        phase = 'running'; buttons(); send({type: 'pot', value: state.pot});
        say(`Emulating ${current.product} from ${current.name}. This is virtual hardware, not a hardware validation.`, 'ok');
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
    send({type: 'boot', seq, wasm, package: checked.bytes.buffer, mhz: Number($('emu-clock').value), jit: true});
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
