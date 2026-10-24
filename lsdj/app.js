// SPDX-License-Identifier: GPL-3.0-only
// The page: connect to the FM-1's running LSDJ Burrito firmware (lsdj/link.js)
// for live effects, songs, colours and settings. Never writes firmware.
import {Link, midiPorts, LinkError, SAVE_SIZE} from './link.js';
import {connectBleMidi} from './ble-midi.js';
import {CHANNELS, CH_PARAMS, ECHO_PARAMS, PAGES, unpackFx, packFx, PRESETS, THEMES, COLOR_NAMES, toHex, fromHex,
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
  try {
    ports = await midiPorts();
    if (ports.input && ports.output) return connectTo(ports.input, ports.output);
    if (!ports.ins.length) return say('device', 'No MIDI devices found. Check the USB cable (a data cable) and that the FM-1 is on.', 'bad');
    const pick = $('port-pick'); pick.hidden = false; pick.replaceChildren(new Option('Choose the FM-1…', ''));
    ports.ins.forEach((p, i) => pick.append(new Option(p.name, i)));
    say('device', 'The FM-1 was not recognised by name: choose its MIDI port.', 'warn');
  } catch (e) { say('device', e.name === 'SecurityError' || e.name === 'NotAllowedError' ? 'MIDI access was blocked. Allow it (with SysEx) for this page.' : e.message, 'bad'); }
};
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

/* ---------- live effects ---------- */
function slider(value, onInput) {
  const td = document.createElement('td'), r = document.createElement('input'), o = document.createElement('output');
  r.type = 'range'; r.min = 0; r.max = 127; r.value = value;
  o.textContent = value.toString(16).toUpperCase().padStart(2, '0');
  r.oninput = () => { o.textContent = (+r.value).toString(16).toUpperCase().padStart(2, '0'); onInput(+r.value); };
  td.append(r, o); td._set = v => { if (document.activeElement !== r) { r.value = v; o.textContent = v.toString(16).toUpperCase().padStart(2, '0'); } };
  return td;
}
function choice(list, value, onInput) {
  const td = document.createElement('td'), s = document.createElement('select');
  list.forEach((c, i) => s.append(new Option(c, i))); s.value = value;
  s.onchange = () => onInput(+s.value);
  td.append(s); td._set = v => { if (document.activeElement !== s) s.value = v; };
  return td;
}
let cells = {}, sendTimer = null;
function changed() {
  touched = Date.now();
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => link.fxSet(packFx(fx)).catch(e => say('fx-status', e.message, 'bad')), 80);
}
function buildFx() {
  cells = {};
  const t = $('fx-table'); t.replaceChildren();
  const head = t.insertRow(); head.append(document.createElement('th'));
  CHANNELS.forEach((c, i) => { const th = document.createElement('th'); th.id = 'ch-head-' + i; th.textContent = c; head.append(th); });
  CH_PARAMS.forEach(p => {
    const tr = t.insertRow(); const th = document.createElement('th'); th.textContent = p.name; tr.append(th);
    CHANNELS.forEach((_, c) => {
      const set = v => { fx.ch[c][p.key] = v; changed(); };
      const td = p.choices ? choice(p.choices, fx.ch[c][p.key], set) : slider(fx.ch[c][p.key], set);
      td.dataset.ch = c; tr.append(td); cells[`ch${c}.${p.key}`] = td;
    });
  });
  const e = $('echo-table'); e.replaceChildren();
  ECHO_PARAMS.forEach(p => {
    const tr = e.insertRow(); const th = document.createElement('th'); th.textContent = p.name; tr.append(th);
    const set = v => { fx.echo[p.key] = v; changed(); };
    const td = p.choices ? choice(p.choices, fx.echo[p.key], set) : slider(fx.echo[p.key], set);
    tr.append(td); cells[`echo.${p.key}`] = td;
  });
}
async function tick() {
  if (!link || busy || document.hidden) return;
  try {
    const l = await link.live();
    const live = unpackFx(l.fx);
    if (Date.now() - touched > 1000) {   /* not while the user is moving a slider */
      fx = live;
      CHANNELS.forEach((_, c) => CH_PARAMS.forEach(p => cells[`ch${c}.${p.key}`]?._set(fx.ch[c][p.key])));
      ECHO_PARAMS.forEach(p => cells[`echo.${p.key}`]?._set(fx.echo[p.key]));
    }
    document.querySelectorAll('#fx-table th[id^=ch-head], #fx-table td').forEach(el => {
      const c = el.id ? +el.id.slice(8) : +el.dataset.ch; el.classList.toggle('cur', c === l.cursor);
    });
    CHANNELS.forEach((name, c) => {
      const tags = [((live.fxOff >> c) & 1) && 'dry', ((l.mute >> c) & 1) && 'muted', ((l.playing >> c) & 1) && '▶'].filter(Boolean);
      $('ch-head-' + c).textContent = name + (tags.length ? ' · ' + tags.join(' ') : '');
    });
    $('live-badges').innerHTML = `<span class="badge">${PAGES[l.page] || ''}</span><span class="badge">${l.bpm} BPM</span>` +
      (l.freeze ? '<span class="badge on">FROZEN</span>' : '');
  } catch (e) { /* a missed poll: try again on the next */ }
}
$('fx-keep').onclick = () => run('fx-status', async () => { await link.fxSet(packFx(fx)); await link.store(); say('fx-status', 'Kept on the FM-1.', 'ok'); });

/* ---------- songs ---------- */
async function run(statusId, fn) {
  if (busy) return; busy = true;
  document.querySelectorAll('section button').forEach(b => b.disabled = true);
  try { await fn(); } catch (e) { say(statusId, e.message, 'bad'); }
  finally { busy = false; document.querySelectorAll('section button').forEach(b => b.disabled = false); $('save-progress').hidden = true; }
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
    if (bytes.length !== SAVE_SIZE) throw new LinkError(`An LSDj save is 128 KiB (${SAVE_SIZE} bytes); ${file.name} is ${bytes.length}.`);
    if (!confirm(`Replace the songs on the FM-1 with ${file.name}? Export first if you want to keep them.`)) return say('save-status', 'Import cancelled.');
    say('save-status', 'Sending songs to the FM-1…');
    await link.importSave(bytes, progress());
    say('save-status', `Imported ${file.name}. LSDj restarted with it.`, 'ok');
  });
};

/* ---------- colours ---------- */
function buildTheme() {
  const pick = $('theme-preset'); pick.replaceChildren(new Option('the current custom theme', -1));
  THEMES.slice(0, 7).forEach((n, i) => pick.append(new Option(n, i)));
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
