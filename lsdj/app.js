// SPDX-License-Identifier: GPL-3.0-only
// The page: connect to the FM-1's running LSDJ Burrito firmware (lsdj/link.js)
// for live effects, songs, colours and settings. Never writes firmware.
import {Link, midiPorts, LinkError, SAVE_SIZE} from './link.js';
import {confirmSaveImport} from './save-file.js';
import {connectBleMidi} from './ble-midi.js';
import {setBeforeInstall, installing, usbMidiUnavailable} from './install-ui.js';
import {CHANNELS, PAGES, PARAM, paramGet, paramSet, valueText, channelSummary, unpackFx, packFx, PRESETS, THEMES, COLOR_NAMES, toHex, fromHex,
        SETTINGS, unpackSettings, packSettings, MIDI_SETTINGS, MIDI_CC_MAP, unpackMidi, packMidi} from './fx-model.js';

const $ = id => document.getElementById(id);
const say = (id, text, cls = 'hint') => { const el = $(id); el.textContent = text; el.className = cls; };
const enable = on => ['live-sec', 'songs-sec', 'theme-sec', 'settings-sec'].forEach(id => $(id).setAttribute('aria-disabled', on ? 'false' : 'true'));

let midi = null;   // the MIDI options (null: firmware without them)
let link = null, ports = null, fx = null, settings = null, theme = PRESETS[0].slice(), poll = null, busy = false, touched = 0, ble = null;

/* ---------- connect ---------- */
async function connectTo(input, output, how = 'USB') {
  link?.close(); link = new Link(input, output, {slow: how === 'Bluetooth'});
  if (how !== 'Bluetooth') { ble?.close(); ble = null; }
  try {
    const info = await link.info();
    if (info.protocol !== 1) throw new LinkError(`This page speaks link version 1; the FM-1 speaks ${info.protocol}. Update the page or the firmware.`);
    say('device', `Connected over ${how}: ${info.firmware} running ${info.title || 'a game'}` + (info.liveKnown ? '' : ' (live data needs LSDj 9.3.9)'), 'ok');
    showBluetooth(how);
    fx = unpackFx(await link.fxGet());
    settings = unpackSettings(await link.settingsGet());
    { const w = await link.midiGet(); midi = w === null ? null : unpackMidi(w); }
    theme = await link.themeGet();
    buildFx(); buildSettings(); buildTheme(); enable(true);
    clearInterval(poll); poll = setInterval(tick, how === 'Bluetooth' ? 500 : 250);
  } catch (e) { enable(false); say('device', e.message, 'bad'); }
}
$('connect-btn').onclick = async () => {
  const unavailable = usbMidiUnavailable();
  if (unavailable) return say('device', unavailable, 'warn');
  try {
    ports = await midiPorts();
    if (ports.input && ports.output) return connectTo(ports.input, ports.output);
    if (!ports.ins.length) return say('device', 'No MIDI devices found. Check the USB cable (a data cable) and that the FM-1 is on.', 'bad');
    const pick = $('port-pick'); pick.hidden = false; pick.replaceChildren(new Option('Choose the FM-1…', ''));
    ports.ins.forEach((p, i) => pick.append(new Option(p.name, i)));
    say('device', 'The FM-1 was not recognised by name: choose its MIDI port.', 'warn');
  } catch (e) { say('device', e.name === 'SecurityError' || e.name === 'NotAllowedError' ? 'MIDI access was blocked. Allow it (with SysEx) for this page.' : e.message, 'bad'); }
};
if (usbMidiUnavailable()) {
  $('connect-btn').disabled = true;
  say('device', usbMidiUnavailable(), 'warn');
}
/* Bluetooth: the FM-1 with BLUETOOTH = DEVICE (Settings) shows up as "LSDJ Burrito" */
if (navigator.bluetooth) $('connect-ble').hidden = false;
$('connect-ble').onclick = async () => {
  try {
    ble?.close();
    ble = await connectBleMidi();
    ble.ondisconnected(() => { clearInterval(poll); enable(false); say('device', 'Bluetooth disconnected. Connect again when the FM-1 is near.', 'warn'); });
    await connectTo(ble.input, ble.output, 'Bluetooth');
  } catch (e) {
    if (e.name === 'NotFoundError') return say('device', 'No FM-1 chosen. Turn on BLUETOOTH: DEVICE in the FM-1\'s settings (GLO), then try again.', 'warn');
    say('device', e.message, 'bad');
  }
};
/* The FM-1's Bluetooth, as reported over the link */
async function showBluetooth(how) {
  const el = $('bt-status');
  try {
    const bt = await link.bluetooth();
    if (!bt) { el.textContent = 'This firmware has no Bluetooth.'; return; }
    el.textContent = `Bluetooth: ${bt.state}` + (bt.error ? ` (${bt.error})` : '') +
      (bt.state === 'connected' ? ` · packets in ${bt.packetsIn}, out ${bt.packetsOut}` : '') +
      (how === 'Bluetooth' ? ' · Songs move slower over Bluetooth than over USB.' : '');
  } catch { el.textContent = ''; }
}
$('port-pick').onchange = e => {
  const i = +e.target.value, input = ports.ins[i];
  const output = ports.outs.find(o => o.name === input.name) || ports.outs[i];
  if (input && output) connectTo(input, output);
};

/* ---------- live effects ----------
   One channel at a time (it follows the FM-1's cursor unless a channel is picked),
   in cards that are the FM-1's effects pages, each control named with the knob that
   plays it there. Two or three choices: buttons; more: a list; ranges: a slider.
   A control the FM-1 just changed flashes. */
let editCh = null, followCursor = true, cursorCh = 0, lastLive = null, bpm = 120, sendTimer = null;
const controls = [];   // {key, where, el, set(v)}
const curCh = () => followCursor ? cursorCh : editCh;
function changed() {
  touched = Date.now();
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => link.fxSet(packFx(fx)).catch(e => say('fx-status', e.message, 'bad')), 80);
}
function control(key) {
  const p = PARAM[key], wrap = document.createElement('div'), c = () => curCh();
  wrap.className = 'fx-ctl'; wrap.dataset.key = key;
  const out = document.createElement('output');
  let input, set;
  if (p.choices && p.choices.length <= 3) {          // a toggle: one button per choice
    input = document.createElement('div'); input.className = 'seg'; input.setAttribute('role', 'radiogroup');
    const btns = p.choices.map((name, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = name; b.setAttribute('role', 'radio');
      if (p.live) b.disabled = true;                 // freeze: shown, set on the FM-1 (hold FX + D5)
      b.onclick = () => { paramSet(fx, key, c(), i); set(i); changed(); };
      input.append(b); return b;
    });
    set = v => btns.forEach((b, i) => { b.classList.toggle('on', i === v); b.setAttribute('aria-checked', i === v); });
  } else if (p.choices) {                            // a list
    input = document.createElement('select');
    p.choices.forEach((name, i) => input.append(new Option(name, i)));
    input.onchange = () => { paramSet(fx, key, c(), +input.value); changed(); refresh(); };
    set = v => { if (document.activeElement !== input) input.value = v; };
  } else {                                           // a range
    input = document.createElement('input'); input.type = 'range'; input.min = 0; input.max = 127;
    input.oninput = () => { paramSet(fx, key, c(), +input.value); out.textContent = valueText(fx, key, c(), bpm); changed(); };
    set = v => { if (document.activeElement !== input) input.value = v; };
  }
  input.setAttribute('aria-label', p.name);
  wrap.append(input, out);
  const item = {key, where: p.where, set: v => { set(v); out.textContent = valueText(fx, key, c(), bpm); }, wrap};
  controls.push(item);
  return wrap;
}
function buildFx() {
  controls.length = 0;
  const box = $('fx-pages'); box.replaceChildren();
  PAGES.forEach((pg, i) => {
    if (pg.v2 && !fx.v2) return;                     // the new pages need alpha 66
    const card = document.createElement('div'); card.className = 'fx-card'; card.dataset.page = i;
    const perCh = pg.knobs.some(([w]) => w === 'ch' || w === 'q' || w === 'flags');
    card.innerHTML = `<h3>${pg.name}<span class="fx-who">${perCh ? '' : 'all channels'}</span><span class="fx-onfm1">on the FM-1's knobs</span></h3>`;
    pg.knobs.forEach(([where, key], k) => {
      const row = document.createElement('div'); row.className = 'fx-row';
      const p = PARAM[key];
      row.innerHTML = `<span class="knob">K${k + 1}</span><span class="fx-name">${p.name}${(where === 'comp' || where === 'echo') && perCh ? ' <small>(all)</small>' : ''}</span>`;
      row.append(control(key)); card.append(row);
    });
    box.append(card);
  });
  const tabs = $('fx-channels'); tabs.replaceChildren();
  const follow = document.createElement('button'); follow.type = 'button'; follow.id = 'fx-follow'; follow.textContent = 'Follow FM-1 cursor';
  follow.onclick = () => { followCursor = true; refresh(); };
  tabs.append(follow);
  CHANNELS.forEach((name, c) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chan'; b.dataset.ch = c;
    b.innerHTML = `<b>${name}</b><small></small>`;
    b.onclick = () => { followCursor = false; editCh = c; refresh(); };
    tabs.append(b);
  });
  refresh();
}
/* Everything shown from fx (and the live state): values, the channel, which page is on the FM-1. */
function refresh(hot = []) {
  if (!fx) return;
  const c = curCh();
  controls.forEach(it => it.set(paramGet(fx, it.key, c)));
  document.querySelectorAll('#fx-channels .chan').forEach(b => {
    const n = +b.dataset.ch;
    b.classList.toggle('on', n === c); b.classList.toggle('cursor', n === cursorCh);
    const tags = [];
    if (lastLive && (lastLive.mute >> n) & 1) tags.push('muted');
    if (lastLive && (lastLive.playing >> n) & 1) tags.push('▶');
    b.querySelector('small').textContent = [channelSummary(fx, n), ...tags].join(' · ');
  });
  $('fx-follow').classList.toggle('on', followCursor);
  $('fx-editing').innerHTML = `Editing <b>${CHANNELS[c]}</b>` + (followCursor ? ' <span class="hint">(the channel under the FM-1\'s cursor)</span>' : ' <span class="hint">(picked here)</span>');
  document.querySelectorAll('#fx-pages .fx-card').forEach(card => card.classList.toggle('fm1', lastLive && +card.dataset.page === lastLive.page));
  hot.forEach(key => {
    document.querySelectorAll(`#fx-pages .fx-ctl[data-key="${key}"]`).forEach(el => {
      const row = el.closest('.fx-row'); row.classList.remove('hot'); void row.offsetWidth; row.classList.add('hot');
    });
  });
}
/* what changed between two setups, for the channel shown (and the shared effects) */
function changedKeys(a, b, c) {
  if (!a || !b) return [];
  return Object.keys(PARAM).filter(k => k !== 'freeze' && (PARAM[k].where !== 'q' || b.v2) && paramGet(a, k, c) !== paramGet(b, k, c));
}
async function tick() {
  if (!link || busy || document.hidden) return;
  try {
    const l = await link.live();
    const live = unpackFx(l.fx);
    live.freeze = l.freeze; cursorCh = l.cursor < 4 ? l.cursor : cursorCh; bpm = l.bpm;
    let hot = [];
    if (Date.now() - touched > 1000) {   /* not while the user is moving a control */
      hot = changedKeys(fx, live, curCh());
      fx = live;
    } else fx.freeze = l.freeze;
    lastLive = l;
    refresh(hot);
    $('live-badges').innerHTML = `<span class="badge">${PAGES[live.page]?.name || ''}</span><span class="badge">${l.bpm} BPM</span>` +
      (l.freeze ? '<span class="badge on">FROZEN</span>' : '');
  } catch (e) { /* a missed poll: try again on the next */ }
}
$('fx-keep').onclick = () => run('fx-status', async () => { await link.fxSet(packFx(fx)); await link.store(); say('fx-status', 'Kept on the FM-1.', 'ok'); });

/* ---------- songs ---------- */
async function run(statusId, fn) {
  if (installing()) return say(statusId, 'Wait for the firmware installation to finish.', 'warn');
  if (busy) return; busy = true;
  const buttons = [...document.querySelectorAll('section:not(#rom-step):not(#install-sec):not(#emulator-sec) button')];
  const disabled = buttons.map(b => b.disabled);
  buttons.forEach(b => b.disabled = true);
  try { await fn(); } catch (e) { say(statusId, e.message, 'bad'); }
  finally { busy = false; buttons.forEach((b, i) => b.disabled = disabled[i]); $('save-progress').hidden = true; }
}
const progress = () => { const p = $('save-progress'); p.hidden = false; p.value = 0; return (n, t) => { p.max = t; p.value = n; }; };
$('export').onclick = () => run('save-status', async () => {
  say('save-status', 'Reading songs from the FM-1…');
  const bytes = await link.exportSave(progress());
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], {type: 'application/octet-stream'})); a.download = 'lsdj.sav'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  say('save-status', 'Exported lsdj.sav.', 'ok');
});
$('import-pick').onclick = () => $('import').click();
$('import').onchange = e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  run('save-status', async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const payload = confirmSaveImport(bytes, file.name, message => confirm(message));
    if (!payload) return say('save-status', 'Import cancelled. Nothing was sent.');
    const note = bytes.length > SAVE_SIZE ? ' The final 16 bytes were excluded with your confirmation; the original file is unchanged.' : '';
    say('save-status', 'Sending songs to the FM-1…' + note);
    await link.importSave(payload, progress());
    say('save-status', `Imported ${file.name}. LSDj restarted with it.${note}`, 'ok');
  });
};

/* ---------- colours ---------- */
function buildTheme() {
  const pick = $('theme-preset'); pick.replaceChildren(new Option('the current custom theme', -1));
  THEMES.forEach((n, i) => { if (PRESETS[i]) pick.append(new Option(n, i)); });   // every preset (not Custom)
  pick.onchange = () => { if (+pick.value >= 0) { theme = PRESETS[+pick.value].slice(); drawColors(); } };
  drawColors();
}
function drawColors() {
  const box = $('theme-colors'); box.replaceChildren();
  COLOR_NAMES.forEach((n, i) => {
    const l = document.createElement('label'), c = document.createElement('input');
    c.type = 'color'; c.value = toHex(theme[i]); c.oninput = () => { theme[i] = fromHex(c.value); preview(); };
    l.append(n, c); box.append(l);
  });
  preview();
}
function preview() {   /* a sketch of LSDj's song screen with the effects panel, in the theme */
  const cv = $('theme-preview'), g = cv.getContext('2d'), col = i => toHex(theme[i]);
  g.fillStyle = col(3); g.fillRect(0, 0, 160, 96);
  g.font = '8px monospace'; g.textBaseline = 'top';
  g.fillStyle = col(0); g.fillText('FILTER WAV 1/4', 1, 0);
  const vals = ['08', 'LP', '40', '00'], lv = [2, 9, 6, 0];
  for (let k = 0; k < 4; k++) {
    const x = 24 + 24 * k;
    if (k === 2) { g.fillStyle = col(6); g.globalAlpha = .2; g.fillRect(x - 4, 8, 24, 80); g.globalAlpha = 1; }
    g.fillStyle = k === 0 ? col(1) : col(3); if (k === 0) g.fillRect(x, 16, 16, 8);
    g.fillStyle = k === 0 ? col(3) : col(0); g.fillText(vals[k], x + 1, 16);
    for (let i = 0; i < 8; i++) {
      const y = 80 - i * 8;
      if (i < lv[k]) { g.fillStyle = col(1); g.fillRect(x, y, 16, 7); } else { g.fillStyle = col(0); g.fillText('--', x + 1, y); }
    }
  }
  g.fillStyle = col(1); g.fillRect(0, 88, 120, 8); g.fillStyle = col(3); g.fillText('K1 DRIVE 08', 1, 88);
  g.fillStyle = col(2); g.fillRect(128, 0, 32, 96); g.fillStyle = col(0); g.fillText('PU1', 132, 0);
}
$('theme-send').onclick = () => run('theme-status', async () => {
  await link.themeSet(theme);
  settings.theme = 7; await link.settingsSet(packSettings(settings)); buildSettings();
  await link.store();
  say('theme-status', 'Sent: the FM-1 now uses THEME: CUSTOM.', 'ok');
});

/* ---------- settings and backup ---------- */
function selects(box, list, obj) {
  list.forEach(s => {
    const l = document.createElement('label'), sel = document.createElement('select');
    s.choices.forEach((c, i) => sel.append(new Option(c, i))); sel.value = obj[s.key];
    sel.onchange = () => { obj[s.key] = +sel.value; };
    l.append(s.name, sel); box.append(l);
  });
}
function buildSettings() {
  const box = $('settings-form'); box.replaceChildren();
  selects(box, SETTINGS, settings);
  const mbox = $('midi-form'); mbox.replaceChildren();
  $('midi-sec').hidden = !midi;
  if (midi) selects(mbox, MIDI_SETTINGS, midi);
}
$('cc-map').replaceChildren(...MIDI_CC_MAP.map(([cc, what]) => { const tr = document.createElement('tr'); tr.insertCell().textContent = 'CC ' + cc; tr.insertCell().textContent = what; return tr; }));
$('settings-apply').onclick = () => run('settings-status', async () => {
  await link.settingsSet(packSettings(settings));
  if (midi) await link.midiSet(packMidi(midi));
  await link.store();
  say('settings-status', 'Applied and kept on the FM-1.', 'ok');
});
$('backup').onclick = () => run('settings-status', async () => {
  const data = {format: 'lsdj-burrito-backup', version: 1, settings: await link.settingsGet(), fx: await link.fxGet(), theme: await link.themeGet()};
  const m = await link.midiGet(); if (m !== null) data.midi = m;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], {type: 'application/json'})); a.download = 'lsdj-burrito-backup.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  say('settings-status', 'Backup saved (settings, effects, custom colours). Songs: use Export in Songs.', 'ok');
});
$('restore-pick').onclick = () => $('restore').click();
$('restore').onchange = e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  run('settings-status', async () => {
    const d = JSON.parse(await file.text());
    if (d.format !== 'lsdj-burrito-backup' || d.version !== 1 || !Array.isArray(d.fx) || d.fx.length !== 11 || !Array.isArray(d.theme) || d.theme.length !== 8)
      throw new LinkError('This is not an LSDJ Burrito backup.');
    unpackSettings(d.settings); unpackFx(d.fx);   /* checks */
    if (d.midi !== undefined) unpackMidi(d.midi);   /* checks */
    await link.themeSet(d.theme); await link.settingsSet(d.settings); await link.fxSet(d.fx);
    if (d.midi !== undefined && midi) await link.midiSet(d.midi);
    await link.store();
    settings = unpackSettings(d.settings); fx = unpackFx(d.fx); theme = d.theme;
    if (d.midi !== undefined && midi) midi = unpackMidi(d.midi);
    buildSettings(); buildFx(); drawColors();
    say('settings-status', `Restored ${file.name} and kept it on the FM-1.`, 'ok');
  });
};

/* Installing firmware restarts the FM-1: the page lets go of it first */
setBeforeInstall(async () => {
  if (busy) throw new LinkError('A song or settings operation is running. Wait for it to finish before installing firmware.');
  clearInterval(poll); poll = null;
  link?.close(); link = null; ble?.close(); ble = null;
  enable(false); say('device', 'Disconnected for the install. Connect again when it is done.', 'hint');
});
