// SPDX-License-Identifier: GPL-3.0-only
// The page: connect to the FM-1's running LSDJ Burrito firmware (lsdj/link.js)
// for live effects, songs, colours and settings. Never writes firmware.
import {Link, midiPorts, LinkError, SAVE_SIZE} from './link.js';
import {confirmSaveImport} from './save-file.js';
import {showDeviceTheme, setMatching, matching} from './page-theme.js';
import {setBeforeInstall, installing, usbMidiUnavailable} from './install-ui.js';
import {CHANNELS, pagesForFx, PARAM, paramGet, paramSet, valueText, channelSummary, unpackFx, packFx, PRESETS, THEMES, COLOR_NAMES, toHex, fromHex,
        SETTINGS, unpackSettings, packSettings, MIDI_SETTINGS, MIDI_CC_MAP, unpackMidi, packMidi, CUSTOM_THEME, isMasterPage,
        firmwareNumber, FEATURES, unpackFeatures, packFeatures} from './fx-model.js';
import {fxDiagram, pageFor} from './fx-diagram.js';
import {zipStore} from './zip.js';
import {romFromSlot} from './lsdj-rom.js';
import {ScreenMirror} from './screen.js';
import {popOut, onPopChange, isOut, docs, seen, anyVisible, visibleWindow} from './popout.js';

/* by id or selector, in the page and in the panels' own windows (lsdj/popout.js) */
const $ = id => { for (const d of docs()) { const el = d.getElementById(id); if (el) return el; } return null; };
const $$ = sel => docs().flatMap(d => [...d.querySelectorAll(sel)]);
const say = (id, text, cls = 'hint') => { const el = $(id); el.textContent = text; el.className = cls; };
const enable = on => {
  ['live-sec', 'songs-sec', 'theme-sec', 'settings-sec'].forEach(id => $(id).setAttribute('aria-disabled', on ? 'false' : 'true'));
  document.dispatchEvent(new CustomEvent('device-state', {detail: {connected: on}}));   // lsdj/ui.js: layout
};

let midi = null;   // the MIDI options (null: firmware without them)
let features = null;   // the feature switches, SETTINGS / FX+LIGHTS (null: firmware before FM-1_979)
let fwId = '', fwNum = 0;   // the firmware: "FM-1_979", 979
let link = null, ports = null, fx = null, settings = null, theme = PRESETS[0].slice(), busy = false, touched = 0;
let connected = false;
let mirror = null;   // the FM-1's screen above Effects (lsdj/screen.js)

/* ---------- connect ---------- */
async function connectTo(input, output, how = 'USB') {
  if (busy || installing()) return;
  connected = false;
  mirror?.stop(); mirror = null;
  link?.close(); link = new Link(input, output);
  try {
    const info = await link.info();
    if (info.protocol !== 1) throw new LinkError(`This page speaks link version 1; the FM-1 speaks ${info.protocol}. Update the page or the firmware.`);
    fwId = info.firmware; fwNum = firmwareNumber(info.firmware);
    muteOk = fwNum >= 977;   // MUTE_SET: FM-1_977 and newer
    say('device', `Connected over ${how}: ${info.firmware} running ${info.title || 'a game'}` + (info.liveKnown ? '' : ' (live data needs LSDj 9.3.9)'), 'ok');
    $('stage-dev').textContent = `· ${info.firmware} over ${how}`;
    fx = unpackFx(await link.fxGet());
    settings = unpackSettings(await link.settingsGet());
    { const w = await link.midiGet(); midi = w === null ? null : unpackMidi(w); }
    { const w = fwNum >= 979 ? await link.featGet() : null; features = w === null ? null : unpackFeatures(w); }
    theme = await link.themeGet(); customTheme = theme.slice();
    buildFx(); buildSettings(); buildTheme(); enable(true);
    pageTheme();
    connected = true; lostAt = 0; missed = 0;
    watchPorts(ports?.access);
    startPoll(250);
    startMirror(how);
  } catch (e) { enable(false); say('device', e.message, 'bad'); }
}
/* ---------- a lost FM-1 ----------
   Web MIDI says when the FM-1's port goes (the cable pulled, the FM-1 turned off); the live poll
   also checks the ports, and LOST_POLLS unanswered polls in a row count as lost too. Then the page
   goes back to Not connected, and connects again by itself when the FM-1's port comes back. */
const LOST_POLLS = 4;
let missed = 0, lostAt = 0, watching = null, reconnecting = false;
const samePort = (a, b) => !!a && !!b && (a === b || (a.id != null && a.id === b.id));
const portGone = () => [link?.input, link?.output].some(p => p?.state === 'disconnected');
function lost(message) {
  if (!connected || installing()) return;
  connected = false; lostAt = Date.now(); missed = 0;
  stopPoll(); mirror?.stop(); mirror = null; link?.close();
  enable(false); say('device', message, 'warn');
}
const UNPLUGGED = 'The FM-1 was disconnected. Plug it in again: the page connects by itself (or press Connect).';
function onPortChange(e) {
  const p = e.port;
  if (!p) return;
  if (p.state === 'disconnected' && connected && (samePort(p, link?.input) || samePort(p, link?.output))) return lost(UNPLUGGED);
  if (p.state === 'connected' && !connected && lostAt) reconnect();
}
function watchPorts(access) {
  if (access === watching || !access?.addEventListener) return;   // test doubles may have no events
  watching?.removeEventListener('statechange', onPortChange);
  watching = access; access.addEventListener('statechange', onPortChange);
}
/* the FM-1's input and output come back one after the other, and it may still be starting: try a few times */
async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  try {
    for (const wait of [300, 1000, 2500]) {
      await new Promise(r => setTimeout(r, wait));
      if (connected || !lostAt || busy || installing()) return;
      await connectUsbQuietly();
      if (connected) return;
    }
    if (!connected) say('device', 'The FM-1 is back but did not answer. Is LSDJ Burrito running? Press Connect to try again.', 'warn');
  } finally { reconnecting = false; }
}
$('connect-btn').onclick = async () => {
  if (busy || installing()) return;
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
$('port-pick').onchange = e => {
  const i = +e.target.value, input = ports.ins[i];
  const output = ports.outs.find(o => o.name === input.name) || ports.outs[i];
  if (input && output) connectTo(input, output);
};

/* ---------- live effects (Perform) ----------
   The FM-1's effects pages as cards. A channel page is a row per knob and a column per channel
   (PU1 PU2 WAV NOI), so all four play at once; a control shared by all channels sits once under
   the four. Each control is named with the knob that plays it there. Two or three choices:
   buttons; more: a list; ranges: a slider. A control the FM-1 just changed flashes. */
let cursorCh = 0, lastLive = null, bpm = 120, sendTimer = null;
/* The page the FM-1 shows (LIVE; a master page while FX is held there), the channel page it showed
   last, the mutes and whether this firmware takes them from the page (FM-1_977 and newer). */
let fm1Page = null, lastChPage = null, mute = 0, muteOk = false, muteTouched = 0;
/* the channel page shown: the FM-1's, unless one is picked here */
let followPage = true, pickPage = 0;
const shownPage = () => followPage ? (lastChPage ?? fx.page) : pickPage;
/* per channel (its own value for each of the four) or one for all */
const perChannel = key => PARAM[key].where === 'ch' || PARAM[key].where === 'q' || key === 'fxOn';
/* mutes and freeze: live only, through MUTE_SET */
function sendMute(freeze = fx.freeze ? 1 : 0) {
  if (!muteOk || busy || installing()) return;
  muteTouched = Date.now();
  link.muteSet(mute, freeze).catch(e => say('fx-status', e.message, 'bad'));
}
const controls = [];   // {key, ch, wrap, set(v)}
function changed() {
  if (busy || installing()) return;
  touched = Date.now();
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    sendTimer = null;
    link.fxSet(packFx(fx)).catch(e => say('fx-status', e.message, 'bad'));
  }, 80);
}
/* one control for one channel (ch: 0-3; a shared control uses 0) */
function control(key, ch) {
  const p = PARAM[key], wrap = document.createElement('div');
  wrap.className = 'fx-ctl'; wrap.dataset.key = key;
  if (perChannel(key)) { wrap.dataset.ch = ch; wrap.dataset.chn = CHANNELS[ch]; }
  const out = document.createElement('output');
  const focused = el => el.ownerDocument.activeElement === el;   // the panel may be in its own window
  let input, set;
  if (p.choices && p.choices.length <= 3) {          // a toggle: one button per choice
    input = document.createElement('div'); input.className = 'seg'; input.setAttribute('role', 'radiogroup');
    const btns = p.choices.map((name, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = name; b.setAttribute('role', 'radio');
      if (p.live && !muteOk) b.disabled = true;      // freeze: set from the page with FM-1_977 and newer
      b.onclick = () => {
        if (p.live) { fx.freeze = i; set(i); sendMute(i); refresh(); return; }
        paramSet(fx, key, ch, i); set(i); changed(); refresh();
      };
      input.append(b); return b;
    });
    set = v => btns.forEach((b, i) => { b.classList.toggle('on', i === v); b.setAttribute('aria-checked', i === v); });
  } else if (p.choices) {                            // a list
    input = document.createElement('select');
    p.choices.forEach((name, i) => input.append(new Option(name, i)));
    input.onchange = () => { paramSet(fx, key, ch, +input.value); changed(); refresh(); };
    set = v => { if (!focused(input)) input.value = v; };
  } else {                                           // a range
    input = document.createElement('input'); input.type = 'range'; input.min = 0; input.max = 127;
    input.oninput = () => {
      paramSet(fx, key, ch, +input.value); out.textContent = valueText(fx, key, ch, bpm); changed();
      /* the same knob elsewhere (980: echo on MASTER), for the same channel */
      controls.forEach(it => { if (it.key === key && it.ch === ch && it.wrap !== wrap) it.set(+input.value); });
    };
    set = v => { if (!focused(input)) input.value = v; };
  }
  input.setAttribute('aria-label', perChannel(key) ? `${p.name} ${CHANNELS[ch]}` : p.name);
  wrap.append(input, out);
  const item = {key, ch, set: v => { set(v); out.textContent = valueText(fx, key, ch, bpm); }, wrap};
  controls.push(item);
  return wrap;
}
function buildFx() {
  controls.length = 0;
  const box = $('fx-pages'); box.replaceChildren();
  const masterBox = $('fx-master-pages'); masterBox.replaceChildren();
  $('fx-master').hidden = !fx.v3;   // FM-1_975 and newer: shared pages apart
  pagesForFx(fx, fwNum).forEach((pg, i) => {
    if (pg.v2 && !fx.v2) return;                     // the new pages need alpha 66
    const card = document.createElement('div'); card.className = 'fx-card'; card.dataset.page = i;
    const perCh = pg.knobs.some(slot => slot && perChannel(slot[1]));
    if (perCh) card.classList.add('matrix');
    card.innerHTML = `<h3>${pg.name}<span class="fx-who">${perCh ? '' : 'all channels'}</span><span class="fx-onfm1">on the FM-1's knobs</span></h3>`;
    pg.knobs.forEach((slot, k) => {
      if (!slot) return;
      const [where, key] = slot;
      const row = document.createElement('div'); row.className = 'fx-row';
      const p = PARAM[key];
      row.innerHTML = `<span class="knob">K${k + 1}</span><span class="fx-name">${p.name}${(where === 'comp' || where === 'echo') && perCh ? ' <small>(all)</small>' : ''}</span>`;
      if (perCh && perChannel(key)) CHANNELS.forEach((n, c) => row.append(control(key, c)));
      else { const w = control(key, 0); if (perCh) w.classList.add('shared'); row.append(w); }
      card.append(row);
    });
    (isMasterPage(fx, i, fwNum) ? masterBox : box).append(card);
  });
  const mutes = $('fx-mutes'); mutes.replaceChildren();
  CHANNELS.forEach((name, n) => {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.mute = n; b.textContent = name;
    b.disabled = !muteOk; b.title = muteOk ? `Mute or play ${name}` : 'Muting from this page needs FM-1_977 or newer (C4-F4 on the FM-1\'s MASTER page)';
    b.onclick = () => { mute ^= 1 << n; sendMute(); refresh(); };
    mutes.append(b);
  });
  const bar = $('fx-pagebar'); bar.replaceChildren();
  const pageFollow = document.createElement('button'); pageFollow.type = 'button'; pageFollow.id = 'fx-page-follow'; pageFollow.textContent = 'FM-1 page';
  pageFollow.title = 'Show the page the FM-1 is on'; pageFollow.onclick = () => { followPage = true; refresh(); };
  bar.append(pageFollow);
  box.querySelectorAll('.fx-card').forEach(card => {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.page = card.dataset.page;
    b.textContent = card.querySelector('h3').firstChild.textContent;
    b.onclick = () => { followPage = false; pickPage = +card.dataset.page; refresh(); };
    bar.append(b);
  });
  /* the column heads: the channel, what is on, under the cursor, playing */
  const head = $('fx-channels'); head.replaceChildren(document.createElement('div'), document.createElement('div'));
  CHANNELS.forEach((name, c) => {
    const d = document.createElement('div'); d.className = 'chan'; d.dataset.ch = c;
    d.innerHTML = `<b>${name}</b><small></small>`;
    head.append(d);
  });
  refresh();
}
/* Everything shown from fx (and the live state): values, the page, the cursor, mutes. */
function refresh(hot = []) {
  if (!fx) return;
  controls.forEach(it => it.set(paramGet(fx, it.key, it.ch)));
  $('fx-master-status').textContent = fx.v3
    ? (fx.bypass ? 'All FX OFF: dry output. Settings are kept; MASTER K1 turns them back on.' : '')
    : 'Older firmware layout: the MASTER page and All FX switch require FM-1_975 or newer.';
  const cards = $$('#fx-pages .fx-card');
  const want = cards.some(card => +card.dataset.page === shownPage()) ? shownPage() : +(cards[0]?.dataset.page ?? 0);
  cards.forEach(card => card.classList.toggle('shown', +card.dataset.page === want));
  $('fx-page-follow').classList.toggle('on', followPage);
  const onFm1 = fm1Page ?? fx.page;
  $$('#fx-pagebar [data-page]').forEach(b => {
    b.classList.toggle('on', +b.dataset.page === want);
    b.classList.toggle('fm1', !!lastLive && +b.dataset.page === onFm1);
  });
  $$('#fx-mutes [data-mute]').forEach(b => {
    const playing = !((mute >> +b.dataset.mute) & 1);
    b.classList.toggle('on', playing); b.setAttribute('aria-pressed', String(playing));
  });
  $$('#fx-channels .chan').forEach(d => {
    const n = +d.dataset.ch, tags = [];
    if ((mute >> n) & 1) tags.push('muted');
    if (lastLive && (lastLive.playing >> n) & 1) tags.push('▶');
    d.querySelector('small').textContent = [channelSummary(fx, n), ...tags].join(' · ');
  });
  /* the column under the FM-1's cursor marked; a muted channel's column grey (still adjustable), as the FM-1 does */
  $$('#pan-chans [data-ch]').forEach(el => {
    const n = +el.dataset.ch;
    el.classList.toggle('cursor', !!lastLive && n === cursorCh);
    el.classList.toggle('muted', !!((mute >> n) & 1));
  });
  const silent = CHANNELS.filter((n, c) => (mute >> c) & 1);
  $('fx-muted').hidden = !silent.length;
  if (silent.length) $('fx-muted').textContent = `${silent.join(', ')} muted: changes are kept, but you won't hear them until ${silent.length > 1 ? 'they play' : 'it plays'} again ` +
    `(Master${muteOk ? '' : ' needs FM-1_977'}, or C4-F4 on the FM-1's MASTER page).`;
  drawWiring();
  $$('#live-sec .fx-card, .pop-body .fx-card').forEach(card => card.classList.toggle('fm1', !!lastLive && +card.dataset.page === onFm1));
  hot.forEach(key => {
    $$(`.fx-ctl[data-key="${key}"]`).forEach(el => {
      const row = el.closest('.fx-row'); row.classList.remove('hot'); void row.offsetWidth; row.classList.add('hot');
    });
  });
}
/* ---------- the wiring (lsdj/fx-diagram.js) ----------
   Upright (a column per channel) or across (a row per channel), the choice kept in this browser;
   narrower on a phone. A block opens the effects page it is on, with its channel marked. */
const PHONE = '(max-width:700px), (max-height:480px) and (pointer:coarse)';
let wireDir = 'v', lastWiring = '';
try { if (localStorage.getItem('wiring-direction') === 'h') wireDir = 'h'; } catch { /* storage blocked: upright */ }
function drawWiring() {
  if (!fx) return;
  const box = $('fx-diagram');
  const svg = fxDiagram(fx, {mute, layout: wireDir, compact: wireDir === 'v' && !isOut('wire') && matchMedia(PHONE).matches});
  if (svg !== lastWiring || !box.firstChild) { box.innerHTML = svg; lastWiring = svg; }   // the same: keep keyboard focus
  $$('#wire-dir [data-dir]').forEach(b => { const on = b.dataset.dir === wireDir; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
  $('pan-wire').dataset.size = wireDir === 'h' ? '900x420' : '700x620';   // its own window: shaped to fit
}
matchMedia(PHONE).addEventListener?.('change', drawWiring);
$$('#wire-dir [data-dir]').forEach(b => {
  b.onclick = () => {
    wireDir = b.dataset.dir;
    try { localStorage.setItem('wiring-direction', wireDir); } catch { /* not kept: fine */ }
    drawWiring();
  };
});
/* a block: its page, shown and brought into view (the channel's controls flash) */
function openFromWiring(blk) {
  if (!fx || !blk?.dataset.go) return;
  const ch = blk.dataset.ch === undefined ? null : +blk.dataset.ch;
  const name = pageFor(blk.dataset.go, !fx.v3);
  const i = pagesForFx(fx, fwNum).findIndex(pg => pg.name === name);
  if (i < 0) return;
  const master = isMasterPage(fx, i, fwNum);
  if (!master) { followPage = false; pickPage = i; refresh(); }
  const card = $(master ? 'fx-master-pages' : 'fx-pages')?.querySelector(`.fx-card[data-page="${i}"]`);
  if (!card) return;
  const panel = card.closest('.panel') || card;
  if (panel.ownerDocument !== document) panel.ownerDocument.defaultView.focus();   // in its own window
  else if (!(document.body.classList.contains('perform') && matchMedia('(min-width:900px) and (min-height:440px) and (orientation:landscape)').matches))
    panel.scrollIntoView({behavior: 'smooth', block: 'start'});   // the stage shows every panel already
  const flash = el => { el.classList.remove('picked'); void el.offsetWidth; el.classList.add('picked'); };
  const ctls = ch == null ? [] : [...card.querySelectorAll(`.fx-ctl[data-ch="${ch}"]`)];
  (ctls.length ? ctls : [card]).forEach(flash);
  const first = ctls[0]?.querySelector('input, select, button') || card.querySelector('input, select, button');
  first?.focus({preventScroll: true});
}
$('fx-diagram').addEventListener('click', e => openFromWiring(e.target.closest?.('[data-go]')));
$('fx-diagram').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const blk = e.target.closest?.('[data-go]'); if (!blk) return;
  e.preventDefault(); openFromWiring(blk);
});
/* the phone's quick links: one panel each */
$$('#stage-nav [data-to]').forEach(b => { b.onclick = () => $(b.dataset.to)?.scrollIntoView({behavior: 'smooth', block: 'start'}); });
/* what changed between two setups (every channel, and the shared effects) */
function changedKeys(a, b) {
  if (!a || !b) return [];
  return Object.keys(PARAM).filter(k => k !== 'freeze' && (PARAM[k].where !== 'q' || b.v2) &&
    [0, 1, 2, 3].some(c => paramGet(a, k, c) !== paramGet(b, k, c)));
}
async function tick() {
  if (!link || busy || !anyVisible()) return;
  if (portGone()) return lost(UNPLUGGED);
  try {
    if (++ticks % 8 === 0) await followThemeSetting();
    const l = await link.live();
    const live = unpackFx(l.fx);
    live.freeze = l.freeze; cursorCh = l.cursor < 4 ? l.cursor : cursorCh; bpm = l.bpm;
    fm1Page = l.page < pagesForFx(live, fwNum).length ? l.page : live.page;
    if (!isMasterPage(live, fm1Page, fwNum)) lastChPage = fm1Page;
    if (Date.now() - muteTouched > 1000) mute = l.mute & 15;
    let hot = [];
    if (Date.now() - touched > 1000) {   /* not while the user is moving a control */
      hot = changedKeys(fx, live);
      fx = live;
    } else if (Date.now() - muteTouched > 1000) fx.freeze = l.freeze;
    lastLive = l; missed = 0;
    refresh(hot);
    const bat = l.battery;   // {bars, usb} or null (lsdj/link.js)
    $('live-badges').innerHTML = `<span class="badge">${pagesForFx(live, fwNum)[fm1Page]?.name || ''}</span><span class="badge">${l.bpm} BPM</span>` +
      (live.bypass ? '<span class="badge">ALL FX OFF</span>' : '') +
      (l.freeze ? '<span class="badge on">FROZEN</span>' : '') +
      (bat ? `<span class="badge" title="The FM-1's battery (3 bars: full)">${bat.usb ? 'USB power' : 'Battery ' + '▮'.repeat(bat.bars) + '▯'.repeat(3 - bat.bars)}</span>` : '');
  } catch (e) {   /* a missed poll: try again on the next; LOST_POLLS in a row: the FM-1 is gone */
    if (portGone()) lost(UNPLUGGED);
    else if (e.cause === 'timeout' && ++missed >= LOST_POLLS) lost('The FM-1 stopped answering. Check the cable and that LSDJ Burrito is running, then press Connect.');
  }
}
/* The live poll: one after another, timed by a window on screen (the page, or one of its own
   windows while the page is behind: a hidden window's timers are slowed down) */
let pollGen = 0;
function startPoll(ms) {
  const gen = ++pollGen;
  const next = () => { if (gen === pollGen) visibleWindow().setTimeout(step, ms); };
  const step = () => { if (gen === pollGen) tick().finally(next); };
  next();
}
const stopPoll = () => { pollGen++; };
/* ---------- the FM-1's screen (FM-1_983 and newer) ----------
   Read only while it can be seen (Perform shown, or the screen in its own window, on screen) and
   no other device operation runs; it shares the link with the live poll above. */
function startMirror(how) {
  const box = $('fm1-screen-box'), note = $('fm1-screen-note'), canvas = $('fm1-screen');
  box.hidden = false; note.hidden = true;
  mirror = new ScreenMirror(link, canvas, {every: 33, clock: visibleWindow,
    push: fwNum >= 990,   // FM-1_990: the FM-1 sends each new picture by itself
    active: () => connected && !busy && !installing() && seen(canvas) && (isOut('screen') || !$('live-sec').hidden),
    onSupport: ok => {
      box.hidden = !ok; note.hidden = ok;
      if (!ok) note.textContent = `The FM-1's screen shows here with FM-1_983 or newer (this FM-1 runs ${fwId}).`;
    }});
  mirror.start();
}
/* ⇱: a panel in its own window (lsdj/popout.js) */
document.querySelectorAll('#live-sec .panel[data-pop] .pop').forEach(b => {
  const panel = b.closest('.panel');
  b.onclick = () => {
    const [w, h] = (panel.dataset.size || '800x500').split('x').map(Number);
    if (!popOut(panel.dataset.pop, panel, {title: panel.dataset.title, width: w, height: h}))
      say('fx-status', 'The browser blocked the new window: allow pop-ups for this page.', 'warn');
  };
});
onPopChange(() => { if (fx) refresh(); });
$('fx-help-btn').onclick = () => $('fx-help').showModal();
$('fx-keep').onclick = () => run('fx-status', async () => { await link.fxSet(packFx(fx)); await link.store(); say('fx-status', 'Kept on the FM-1.', 'ok'); });

/* ---------- songs ---------- */
async function run(statusId, fn) {
  if (installing()) return say(statusId, 'Wait for the firmware installation to finish.', 'warn');
  if (busy) return; busy = true;
  const buttons = $$('section:not(#rom-step):not(#install-sec):not(#emulator-sec) button, .pop-body button');
  const disabled = buttons.map(b => b.disabled);
  buttons.forEach(b => b.disabled = true);
  try { await fn(); } catch (e) { say(statusId, e.message, 'bad'); }
  finally { busy = false; buttons.forEach((b, i) => b.disabled = disabled[i]); $('save-progress').hidden = true; }
}
/* Not connected: connect over USB as the Connect button does, when the FM-1 is found by name. */
async function connectUsbQuietly() {
  if (connected || busy || installing() || usbMidiUnavailable()) return;
  try {
    ports = await midiPorts();
    if (ports.input && ports.output) await connectTo(ports.input, ports.output);
  } catch { /* MIDI blocked or unavailable: the message below says what to do */ }
}
export async function readInstalledCartridge(progress, signal) {
  await connectUsbQuietly();
  if (!link || !connected) throw new LinkError('No FM-1 found over USB. Turn it on and plug it in with a data cable, or connect to the running FM-1 in My FM-1 (choose its MIDI port), then try Read from my FM-1 again.');
  if (busy || installing() || sendTimer) throw new LinkError('Wait for the current device operation to finish.');
  const active = link;
  busy = true;
  // Lock all physical controls while leaving the cartridge Cancel button available.
  const controls = $$('section:not(#rom-step):not(#install-sec):not(#emulator-sec) button, section:not(#rom-step):not(#install-sec):not(#emulator-sec) input, section:not(#rom-step):not(#install-sec):not(#emulator-sec) select, .pop-body button, .pop-body input, .pop-body select');
  const disabled = controls.map(el => el.disabled);
  controls.forEach(el => el.disabled = true);
  try {
    const slot = await active.exportCartridge(progress, signal);
    if (link !== active || !connected) throw new LinkError('The connected device changed. Read its cartridge again.');
    return slot;
  } finally {
    busy = false;
    controls.forEach((el, i) => el.disabled = disabled[i]);
  }
}
const progress = () => { const p = $('save-progress'); p.hidden = false; p.value = 0; return (n, t) => { p.max = t; p.value = n; }; };
/* a file to this computer */
function download(bytes, name, type = 'application/octet-stream') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], {type})); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const stamp = () => new Date().toISOString().slice(0, 10);
/* The three exports (each its own file): songs, the installed LSDj (read back from the FM-1:
   FM-1_974 and newer web-installed builds), the effects setup. Nothing is written to the FM-1. */
async function songsFile() {
  say('save-status', 'Reading songs from the FM-1…');
  return {name: 'lsdj.sav', bytes: await link.exportSave(progress())};
}
async function romFile() {
  say('save-status', 'Reading the installed LSDj from the FM-1 (no device writes)…');
  const rom = romFromSlot(await link.exportCartridge(progress()));
  return {name: 'lsdj-installed.gb', bytes: rom};
}
async function fxFile() {
  const data = {format: 'lsdj-burrito-fx', version: 1, firmware: fwId, fx: await link.fxGet()};
  return {name: 'lsdj-burrito-effects.json', bytes: new TextEncoder().encode(JSON.stringify(data, null, 1))};
}
$('export').onclick = () => run('save-status', async () => {
  const f = await songsFile(); download(f.bytes, f.name);
  say('save-status', 'Exported lsdj.sav.', 'ok');
});
$('export-rom').onclick = () => run('save-status', async () => {
  const f = await romFile(); download(f.bytes, f.name);
  say('save-status', 'Exported lsdj-installed.gb: the LSDj installed on the FM-1, for your own use. Kit banks left out at install are empty in it.', 'ok');
});
$('export-fx').onclick = () => run('save-status', async () => {
  const f = await fxFile(); download(f.bytes, f.name, 'application/json');
  say('save-status', 'Exported the effects setup (all pages, every channel).', 'ok');
});
$('export-all').onclick = () => run('save-status', async () => {
  const files = [await songsFile(), await fxFile()];
  let note = '';
  try { files.splice(1, 0, await romFile()); }
  catch (e) { note = ` The installed LSDj was left out: ${e.message}`; }
  download(zipStore(files), `lsdj-burrito-${fwId || 'fm1'}-${stamp()}.zip`, 'application/zip');
  say('save-status', `Exported ${files.map(f => f.name).join(', ')} in one .zip.${note}`, note ? 'warn' : 'ok');
});
$('import-fx-pick').onclick = () => $('import-fx').click();
$('import-fx').onchange = e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  run('save-status', async () => {
    let d; try { d = JSON.parse(await file.text()); } catch { throw new LinkError('This is not an effects file.'); }
    const words = d.format === 'lsdj-burrito-fx' && d.version === 1 ? d.fx : d.format === 'lsdj-burrito-backup' && d.version === 1 ? d.fx : null;
    if (!Array.isArray(words) || ![11, 17].includes(words.length)) throw new LinkError('This is not an LSDJ Burrito effects file.');
    const loaded = unpackFx(words);
    if (loaded.v3 && !fx.v3) throw new LinkError('These effects need FM-1_975 or newer firmware.');
    await link.fxSet(words); await link.store();
    fx = unpackFx(await link.fxGet()); buildFx();
    say('save-status', `Loaded the effects from ${file.name} and kept them on the FM-1.`, 'ok');
  });
};
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
  if (settings.theme !== CUSTOM_THEME && PRESETS[settings.theme]) {   // start from the theme the FM-1 shows
    pick.value = settings.theme; theme = PRESETS[settings.theme].slice();
  }
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
/* The page in the FM-1's own theme (lsdj/page-theme.js). The FM-1 can change THEME in its own
   settings (GLO), so the setting is read again every couple of seconds. */
let customTheme = null, deviceThemeId = -1, ticks = 0;
function pageTheme(id = settings.theme) {
  deviceThemeId = id;
  const colours = id === CUSTOM_THEME ? customTheme : PRESETS[id];
  if (colours) showDeviceTheme(colours);
}
async function followThemeSetting() {
  const id = unpackSettings(await link.settingsGet()).theme;
  if (id === deviceThemeId) return;
  if (id === CUSTOM_THEME) customTheme = await link.themeGet();
  settings.theme = id;
  const sel = document.querySelector('#settings-form select[data-key="theme"]');
  if (sel && document.activeElement !== sel) sel.value = id;
  pageTheme(id);
}
$('page-theme').checked = matching();
$('page-theme').onchange = () => { setMatching($('page-theme').checked); if ($('page-theme').checked && connected) pageTheme(); };
$('theme-send').onclick = () => run('theme-status', async () => {
  await link.themeSet(theme);
  settings.theme = 7; await link.settingsSet(packSettings(settings)); buildSettings();
  await link.store();
  customTheme = theme.slice(); pageTheme();
  say('theme-status', 'Sent: the FM-1 now uses THEME: CUSTOM.', 'ok');
});

/* ---------- settings and backup ---------- */
function selects(box, list, obj) {
  list.forEach(s => {
    const l = document.createElement('label'), sel = document.createElement('select');
    s.choices.forEach((c, i) => sel.append(new Option(c, i))); sel.value = obj[s.key];
    sel.dataset.key = s.key;
    sel.onchange = () => { obj[s.key] = +sel.value; };
    l.append(s.name, sel); box.append(l);
  });
}
function buildSettings() {
  const box = $('settings-form'); box.replaceChildren();
  selects(box, SETTINGS, settings);
  if (features) {   // FX panel colours (FM-1_979: FX THEME) right under Theme, as on the FM-1 (SETTINGS / DISPLAY)
    const tmp = document.createElement('div'), theme = box.querySelector('select[data-key="theme"]')?.parentElement;
    selects(tmp, FEATURES.filter(f => f.key === 'fxTheme'), features);
    if (theme) theme.after(...tmp.children); else box.append(...tmp.children);
    if (fwNum >= 981) {   // AUTOSAVE first, as on the FM-1's SETTINGS page
      const as = document.createElement('div');
      selects(as, FEATURES.filter(f => f.key === 'autosave'), features);
      box.prepend(...as.children);
    }
    if (fwNum >= 989) {   // SCREEN RATE under CPU meter, as on the FM-1 (SETTINGS / DISPLAY)
      const sr = document.createElement('div'), meter = box.querySelector('select[data-key="meter"]')?.parentElement;
      selects(sr, FEATURES.filter(f => f.key === 'screenRate'), features);
      if (meter) meter.after(...sr.children); else box.append(...sr.children);
    }
  }
  const mbox = $('midi-form'); mbox.replaceChildren();
  $('midi-sec').hidden = !midi;
  if (midi) selects(mbox, MIDI_SETTINGS, midi);
  const fbox = $('feat-form'); fbox.replaceChildren();
  $('feat-sec').hidden = !features;
  if (features) selects(fbox, FEATURES.filter(f => f.key !== 'fxTheme' && f.key !== 'autosave' && f.key !== 'screenRate'), features);
}
/* The CC map: per channel, then the shared ones */
{
  const rows = [];
  for (const [scope, title] of [['channel', 'Per channel (PU1 on the first CC FX channel, PU2 the next, then WAV, NOI)'], ['shared', 'Shared (any of the four channels)']]) {
    const th = document.createElement('tr'), cell = document.createElement('th'); cell.colSpan = 2; cell.textContent = title; th.append(cell); rows.push(th);
    for (const [cc, what] of MIDI_CC_MAP.filter(m => m[2] === scope)) {
      const tr = document.createElement('tr'); tr.insertCell().textContent = 'CC ' + cc; tr.insertCell().textContent = what; rows.push(tr);
    }
  }
  $('cc-map').replaceChildren(...rows);
}
$('settings-apply').onclick = () => run('settings-status', async () => {
  await link.settingsSet(packSettings(settings));
  if (midi) await link.midiSet(packMidi(midi));
  if (features) await link.featSet(packFeatures(features));
  await link.store();
  pageTheme();
  say('settings-status', 'Applied and kept on the FM-1.', 'ok');
});
$('backup').onclick = () => run('settings-status', async () => {
  const data = {format: 'lsdj-burrito-backup', version: 1, settings: await link.settingsGet(), fx: await link.fxGet(), theme: await link.themeGet()};
  const m = await link.midiGet(); if (m !== null) data.midi = m;
  if (features) data.features = await link.featGet();
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
    if (d.format !== 'lsdj-burrito-backup' || d.version !== 1 || !Array.isArray(d.fx) || ![11, 17].includes(d.fx.length) || !Array.isArray(d.theme) || d.theme.length !== 8)
      throw new LinkError('This is not an LSDJ Burrito backup.');
    unpackSettings(d.settings);
    const restoredFx = unpackFx(d.fx);
    if (restoredFx.v3 && !fx.v3) throw new LinkError('This effects backup requires FM-1_975 or newer firmware.');
    if (d.midi !== undefined) unpackMidi(d.midi);   /* checks */
    if (d.features !== undefined) unpackFeatures(d.features);
    await link.themeSet(d.theme); await link.settingsSet(d.settings); await link.fxSet(d.fx);
    if (d.midi !== undefined && midi) await link.midiSet(d.midi);
    if (d.features !== undefined && features) await link.featSet(d.features);
    await link.store();
    settings = unpackSettings(d.settings); fx = unpackFx(await link.fxGet()); theme = d.theme;
    if (d.midi !== undefined && midi) midi = unpackMidi(d.midi);
    if (d.features !== undefined && features) features = unpackFeatures(d.features);
    buildSettings(); buildFx(); drawColors();
    customTheme = d.theme.slice(); pageTheme();
    say('settings-status', `Restored ${file.name} and kept it on the FM-1.`, 'ok');
  });
};

/* Installing firmware restarts the FM-1: the page lets go of it first */
setBeforeInstall(async () => {
  if (busy) throw new LinkError('A song or settings operation is running. Wait for it to finish before installing firmware.');
  stopPoll();
  link?.close(); link = null;
  connected = false; lostAt = 0;
  enable(false); say('device', 'Disconnected for the install. Connect again when it is done.', 'hint');
});
