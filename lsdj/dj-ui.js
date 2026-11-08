// SPDX-License-Identifier: GPL-3.0-only
// Perform's DJ layout: two decks (A, B) and a mixer strip between them (the maths: lsdj/dj.js; mixers: lsdj/mixers.js;
// clocks: lsdj/midiclock.js). app.js mounts it and gives it the FM-1s (setDjHooks).
//   A deck is an FM-1 plugged in, or any other MIDI output (a drum machine, a DAW...). The page clocks each deck
//   itself, at its own tempo (LSDj PROJECT › SYNC = MIDI, GLO › MIDI › CLOCK IN = ALL or USB, TRANSPORT ON): Sync
//   matches the master's tempo and closes the gap to its bar by a short bend; nudge bends while held; Play starts on
//   the master's next bar. The master is a clock on this page (tempo, tap, Play / Stop) or one heard on a MIDI input
//   (a mixer, a DAW, an FM-1 with SYNC = LSDJ and CLOCK OUT = USB): its tempo and bar are followed.
//   FM-1 decks also get: stem kills (the channel mutes, now or on the next bar), the DJ filter (all four channels'
//   filters on one knob) and echo / reverb throws (sends up while held), or the mixer's own filter and FX send for
//   that channel (a choice per control), and a song-row cue (MIDI program change: GLO › MIDI › PC CUE on).
//   The mixer: a preset (mixers.js) or MIDI learn. Its controls drive the decks; the page's faders and crossfader
//   set its channel volumes when it takes them. Without a mixer the crossfader sets each FM-1's volume (0.9.98:
//   VOLUME_SET, times the MASTER knob; put back to full when the deck is emptied, the mixer changes or the layout
//   closes). 0.9.98 also gives: Hold (LSDj's live mode: each channel loops its chain), a SYNC check, and beat lights
//   from the FM-1's own phrase rows when this page isn't clocking it.
//   Each FM-1 deck shows, as chosen (Screen | Rows): its FM-1's screen (as Perform › Screen; FM-1_983 and newer),
//   on that FM-1's link, or (0.9.98) the song row map: click a row to cue it.
import {startClock, clampBpm, PPQN, CLOCK, START, CONTINUE, STOP} from './midiclock.js';
import {BAR, BEAT, NUDGE, position, offset, syncBend, nextOn, crossfade, CURVES, djFilter, tapper, clockMeter} from './dj.js';
import {PRESETS, preset, readMidi, actionFor, out, learnRule, saveLearned, loadLearned} from './mixers.js';
import {unpackFx, packFx, unpackReverb, packReverb, packReverbSends, CHANNELS, firmwareNumber, unpackSettings, PRESETS as THEME_COLOURS, CUSTOM_THEME} from './fx-model.js';
import {pageColours} from './page-theme.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const store = {get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* this visit */ } }};
const NAMES = ['A', 'B'];
/* app.js: devices() -> [{key, label, fw}] (the FM-1s plugged in), linkFor(key) -> a Link or null, access() -> MIDIAccess
   or null, outputFor(key) -> the FM-1's MIDI output, takeClock() (Perform › Clock goes off: two clocks would fight),
   screen(key, link, canvas, onSupport) -> a started screen mirror ({stop}) on that link, or null */
let hooks = {devices: () => [], linkFor: () => null, access: () => null, outputFor: () => null, takeClock: () => {}, screen: () => null};
export function setDjHooks(h) { hooks = {...hooks, ...h}; }

const now = () => performance.now();
/* whole: Whole BPM (kept in this browser): every tempo set here snaps to a whole number (tap, typing, the mixer's +/-) */
const master = {bpm: clampBpm(+store.get('dj-bpm', 120)), clock: null, source: 'page', ext: null, tap: tapper(),
  whole: store.get('dj-whole', '0') === '1'};
/* a tempo as set here: whole, or to a tenth */
const tempoOf = b => { const c = clampBpm(b); return master.whole ? Math.round(c) : Math.round(c * 10) / 10; };
const bpmText = b => master.whole ? String(Math.round(b)) : b.toFixed(1);
if (master.whole) master.bpm = tempoOf(master.bpm);
const mixer = {id: store.get('dj-mixer', 'none'), inId: store.get('dj-mixer-in', ''), outId: store.get('dj-mixer-out', ''),
  map: JSON.parse(store.get('dj-mixer-map', '[1,2]')), learned: loadLearned(store.get('dj-learned', '[]')), learning: null,
  xfader: 0.5, curve: store.get('dj-curve', 'smooth'), faders: {}, input: null, note: ''};
const decks = [0, 1].map(i => ({i, key: '', kind: '', bpm: master.bpm, clock: null, live: null, fx: null, rv: null, base: null,
  kill: 0, killOnBar: store.get('dj-killbar', '0') === '1', filter: 0, filterBy: 'fm1', throwBy: 'fm1', row: 0, sendTimer: 0, ui: null,
  level: null, levelSent: 127, levelBusy: false, scr: null, scrLink: null, scrOk: true,
  view: store.get(`dj-view-${i}`, 'screen'), map: null, mapFrom: -1, mapAt: 0, mapFill: null}));
let root = null, ticker = 0, polling = 0, shown = false;
/* the deck's FM-1 firmware number (998: 0.9.98), 0 for other gear */
const fwOf = d => d.kind === 'fm1' ? firmwareNumber(hooks.devices().find(x => x.key === d.key)?.fw) || 0 : 0;
const hex2 = n => n.toString(16).toUpperCase().padStart(2, '0');

/* ---------- the master clock ---------- */
function masterClock() {
  if (!master.clock) master.clock = startClock({bpm: master.bpm, targets: []});   /* a reference: no targets */
  return master.clock;
}
/* the master's position (clocks since its Start) and tempo now, from this page's clock or the one heard */
function masterNow(t = now()) {
  if (master.source === 'page') return {phase: master.clock?.phase(t) ?? null, bpm: master.bpm};
  const e = master.ext;
  if (!e?.running) return {phase: null, bpm: e?.bpm || master.bpm};
  const b = e.bpm || master.bpm;
  return {phase: e.ticks + Math.min(1, (t - e.lastAt) * b * PPQN / 60000), bpm: b};
}
/* A tempo change updates the numbers only (the readout, by tick; the box, here), never the whole layout: Tap
   pressed quickly redrew both decks, their rows and the mixer on every tap and could freeze the page. */
function setMasterBpm(b) {
  master.bpm = tempoOf(b); store.set('dj-bpm', String(master.bpm));
  master.clock?.setTempo(master.bpm);
  const i = mixer.ui?.bpmIn;
  if (i && i.ownerDocument.activeElement !== i) i.value = master.bpm;
}
function setWhole(on) {
  master.whole = on; store.set('dj-whole', on ? '1' : '0');
  setMasterBpm(master.bpm);
  decks.forEach(d => setDeckBpm(d, d.bpm));
  draw();   /* the boxes' steps */
}
function masterPlay() {
  if (master.source !== 'page') { mixerSend('play'); return; }   /* an outside master: ask it (a mixer that takes it) */
  const c = masterClock();
  if (c.running) { c.stop(); decks.forEach(d => d.clock?.running && d.clock.stop()); draw(); return; }
  const at = now() + 60;
  c.start(at);
  decks.forEach(d => { if (d.key) { deckClock(d).setTempo(d.bpm); if (!d.clock.running) d.clock.start(at); } });
  draw();
}
/* an outside master on a MIDI input: its clocks counted, its tempo measured */
function hearMaster(e) {
  const b = e.data?.[0], ext = master.ext;
  if (!ext) return;
  if (b === CLOCK) { ext.ticks++; ext.lastAt = e.timeStamp || now(); const v = ext.meter.feed(ext.lastAt); if (v) ext.bpm = v; }
  else if (b === START) { ext.running = true; ext.ticks = 0; ext.lastAt = e.timeStamp || now(); ext.meter.reset(); }
  else if (b === CONTINUE) ext.running = true;
  else if (b === STOP) ext.running = false;
}
function setSource(v) {
  if (master.ext?.input) master.ext.input.removeEventListener?.('midimessage', hearMaster);
  master.ext = null; master.source = 'page';
  if (v && v !== 'page') {
    const input = [...(hooks.access()?.inputs?.values() || [])].find(p => p.id === v);
    if (input) {
      master.source = v; master.ext = {input, ticks: 0, lastAt: 0, running: false, bpm: 0, meter: clockMeter()};
      input.open?.().catch?.(() => {});
      input.addEventListener?.('midimessage', hearMaster);
      master.clock?.stop();
    }
  }
  draw();
}

/* ---------- decks ---------- */
const deckOut = d => d.kind === 'fm1' ? hooks.outputFor(d.key) : [...(hooks.access()?.outputs?.values() || [])].find(p => p.id === d.key) || null;
function deckClock(d) {
  if (!d.clock) {
    const o = deckOut(d);
    d.clock = startClock({bpm: d.bpm, targets: o ? [o] : []});
    hooks.takeClock();
  }
  return d.clock;
}
async function assign(d, value) {
  d.clock?.stop(); d.clock?.close(); d.clock = null;
  if (d.kind === 'fm1' && d.levelSent !== 127) void fullVolume(d.key);   /* the FM-1 leaving the deck: full volume again */
  d.key = ''; d.kind = ''; d.live = null; d.fx = null; d.rv = null; d.base = null; d.kill = 0; d.filter = 0;
  d.level = null; d.levelSent = 127; d.scrOk = true; d.themeAt = 0; d.map = null; d.mapFrom = -1; d.mapFill = null;
  paintDeck(d, null);
  if (value) { const [kind, ...k] = value.split(':'); d.kind = kind; d.key = k.join(':'); }
  draw();
  if (d.kind !== 'fm1') return;
  applyVolumes();
  const l = hooks.linkFor(d.key);
  if (!l) return;
  try {   /* its effects, to put back after a filter or a throw */
    d.fx = unpackFx(await l.fxGet());
    if (firmwareNumber(hooks.devices().find(x => x.key === d.key)?.fw) >= 997) {
      const w = await l.reverbGet(); d.rv = w === null ? null : unpackReverb(w, await l.reverbSendsGet());
    }
    d.base = structuredClone({ch: d.fx.ch, echo: d.fx.echo, rv: d.rv});
  } catch (e) { say(`Deck ${NAMES[d.i]}: ${e.message}`); }
  await deckTheme(d, l);
  draw();
}
function deckPlay(d) {
  if (!d.key) return;
  const c = deckClock(d);
  if (c.running) { c.stop(); draw(); return; }
  c.setTempo(d.bpm);
  const m = masterNow();
  if (m.phase == null && master.source === 'page') { const at = now() + 60; masterClock().start(at); c.start(at); }
  else c.start(nextOn(m.phase, m.bpm, now()));   /* on the master's next bar */
  draw();
}
function deckSync(d) {
  if (!d.clock?.running) return say(`Deck ${NAMES[d.i]} isn't playing: Play starts it on the master's bar.`);
  const t = now(), m = masterNow(t);
  d.bpm = m.bpm; d.clock.setTempo(d.bpm);
  if (m.phase == null) return draw();
  const {factor, ms} = syncBend(offset(d.clock.phase(t), m.phase), d.bpm);
  if (factor !== 1) { d.clock.bend(factor); setTimeout(() => d.clock?.bend(1), ms); }
  draw();
}
const nudge = (d, dir) => { if (d.clock?.running) d.clock.bend(dir ? 1 + dir * NUDGE : 1); };
function setDeckBpm(d, b) {   /* (the numbers only, as setMasterBpm) */
  d.bpm = tempoOf(b); d.clock?.setTempo(d.bpm);
  const i = d.ui?.bpmIn;
  if (i && i.ownerDocument.activeElement !== i) i.value = d.bpm;
}

/* FM-1 sends, coalesced (a knob turned quickly sends at most every 60 ms) */
function pushFx(d) {
  if (d.sendTimer) return;
  d.sendTimer = setTimeout(async () => {
    d.sendTimer = 0;
    const l = hooks.linkFor(d.key);
    if (!l || !d.fx) return;
    try { await l.fxSet(packFx(d.fx)); if (d.rv) { await l.reverbSet(packReverb(d.rv)); if (d.rv.rvSend) await l.reverbSendsSet(packReverbSends(d.rv)); } }
    catch (e) { say(`Deck ${NAMES[d.i]}: ${e.message}`); }
  }, 60);
}
function deckFilter(d, v) {
  d.filter = v;
  if (d.filterBy === 'mixer') { const ch = mixer.map[d.i]; if (ch) mixerSend('filter', ch, v); }
  else if (d.fx && d.base) {
    const f = djFilter(v);
    d.fx.ch.forEach((c, n) => Object.assign(c, f.type ? f : {type: d.base.ch[n].type, cutoff: d.base.ch[n].cutoff, reso: d.base.ch[n].reso}));
    pushFx(d);
  }
  drawDeck(d);
}
/* a throw: the deck's sends all the way up while held (the effect's mix up if it was silent), then back */
function deckThrow(d, what, on) {
  if (d.throwBy === 'mixer') { const ch = mixer.map[d.i]; if (ch) mixerSend('fx', ch, on ? 1 : 0); return; }
  if (!d.fx || !d.base) return;
  if (what === 'echo') {
    d.fx.ch.forEach((c, n) => { c.send = on ? 127 : d.base.ch[n].send; });
    d.fx.echo.mix = on && !d.base.echo.mix ? 64 : d.base.echo.mix;
  } else if (d.rv?.rvSend && d.base.rv) {
    d.rv.rvSend = on ? [127, 127, 127, 127] : d.base.rv.rvSend.slice();
    d.rv.rvMix = on && !d.base.rv.rvMix ? 64 : d.base.rv.rvMix;
  } else return say('Reverb throws need 0.9.97 on that FM-1.');
  pushFx(d);
}
async function setKill(d, mask) {
  const l = hooks.linkFor(d.key);
  if (!l) return;
  d.kill = mask;
  try { await l.muteSet(mask, d.live?.freeze ? 1 : 0); } catch (e) { say(`Deck ${NAMES[d.i]}: ${e.message}`); }
  drawDeck(d);
}
function kill(d, c) {
  const mask = (d.live?.mute ?? d.kill) ^ (1 << c);
  const m = masterNow();
  if (!d.killOnBar || m.phase == null) return void setKill(d, mask);
  setTimeout(() => void setKill(d, mask), Math.max(0, nextOn(m.phase, m.bpm, now()) - now()));
}
/* a song row cue: program change n on channel 1 (the FM-1 takes any; GLO › MIDI › PC CUE must be ON) */
function cueRow(d) {
  const o = deckOut(d);
  if (!o) return;
  try { o.send([0xC0, d.row & 127]); say(`Deck ${NAMES[d.i]}: row ${d.row.toString(16).toUpperCase().padStart(2, '0')} cued (FM-1: GLO › MIDI › PC CUE on).`); }
  catch (e) { say(e.message); }
}
/* 0.9.98: the FM-1's volume from this page (VOLUME_SET, times its MASTER knob). v: 0..1, null: full again. The
   latest value goes, one request at a time, so a fast crossfader never queues up. */
function deckLevel(d, v) {
  if (d.kind !== 'fm1' || fwOf(d) < 998) return;
  d.level = v == null ? null : Math.round(Math.max(0, Math.min(1, v)) * 127);
  void sendLevel(d);
}
async function sendLevel(d) {
  if (d.levelBusy) return;
  d.levelBusy = true;
  const key = d.key;
  try {
    for (let want = d.level ?? 127; want !== d.levelSent && d.key === key; want = d.level ?? 127) {
      const l = hooks.linkFor(key);
      if (!l || !(await l.volumeSet(want))) break;
      d.levelSent = want;
    }
  } catch (e) { say(`Deck ${NAMES[d.i]}: ${e.message}`); }
  finally { d.levelBusy = false; }
}
async function fullVolume(key) {
  try { await hooks.linkFor(key)?.volumeSet(127); } catch { /* gone: it is full at its next power on */ }
}
/* the crossfader sets the FM-1s' volumes only without a MIDI mixer; otherwise they are full */
function applyVolumes() {
  const g = crossfade(mixer.xfader, mixer.curve);
  decks.forEach((d, i) => deckLevel(d, mixer.id === 'none' ? g[i] : null));
}
/* 0.9.98: LSDj's live mode (Hold: each channel loops its chain until another is cued), or song mode */
async function deckHold(d) {
  const l = hooks.linkFor(d.key);
  if (!l) return;
  const on = !d.live?.live;
  try {
    if (!(await l.seqSet(on))) return say(`Deck ${NAMES[d.i]}: this FM-1 can't switch LSDj's live mode (it needs LSDj 9.3.9).`);
    if (d.live) d.live.live = on;
    say(`Deck ${NAMES[d.i]}: ${on ? 'held: LSDj live mode, each channel loops its chain' : 'song mode again'}.`);
  } catch (e) { say(`Deck ${NAMES[d.i]}: ${e.message}`); }
  drawDeck(d);
}
/* each FM-1 deck in its FM-1's colours (its THEME setting; CUSTOM: its own colours), as the page takes the theme of
   the FM-1 in use (page-theme.js). Read when the deck is chosen and every so often after (a theme changed on it). */
const THEME_VARS = Object.keys(pageColours(Array(8).fill(0)));
async function deckTheme(d, l) {
  d.themeAt = now();
  try {
    const id = unpackSettings(await l.settingsGet()).theme;
    const colours = id === CUSTOM_THEME ? await l.themeGet() : THEME_COLOURS[id];
    if (d.kind === 'fm1' && hooks.linkFor(d.key) === l) paintDeck(d, colours ? pageColours(colours) : null);
  } catch { /* the colours stay as they are */ }
}
function paintDeck(d, vars) {
  const box = d.ui?.box;
  if (!box) return;
  THEME_VARS.forEach(k => box.style.removeProperty(k));
  if (vars) Object.entries(vars).forEach(([k, v]) => box.style.setProperty(k, v));
  box.classList.toggle('themed', !!vars);
}
/* each FM-1 deck's screen, while the DJ layout shows: a mirror on the deck's FM-1 link, started again when that
   link changes (another FM-1 taken into use, a watcher started or ended), stopped when the deck is emptied */
function deckScreen(d) {
  const want = shown && d.kind === 'fm1' && deckView(d) === 'screen' && d.ui?.screen ? hooks.linkFor(d.key) : null;
  if (want === d.scrLink && (!want || d.scr || !d.scrOk)) return;   /* (no screen on its firmware: not asked again) */
  d.scr?.stop(); d.scr = null; d.scrLink = want;
  if (want && !d.scrOk) { d.scrOk = true; drawDeck(d); }   /* a new try: the canvas on the page again (it draws only when seen) */
  if (want) d.scr = hooks.screen(d.key, want, d.ui.screen, ok => { if (d.scrOk !== ok) { d.scrOk = ok; drawDeck(d); } });
}
/* a deck shows its FM-1's screen or its song row map (Rows, 0.9.98), as chosen (kept in this browser) */
const hasRows = d => fwOf(d) >= 998;
const deckView = d => d.view === 'rows' && hasRows(d) ? 'rows' : 'screen';
function setView(d, v) {
  d.view = v; store.set(`dj-view-${d.i}`, v);
  drawDeck(d); deckScreen(d);
  if (v === 'rows') { const l = hooks.linkFor(d.key); if (l) void readMap(d, l).then(() => drawMap(d), () => {}); }
}
/* 0.9.98: MAP_ROWS song rows from just before where the deck plays (4x LSDj's screen: the page's advantage is
   showing more, and touch), in columns of MAP_COL; read again when it moves on or every few seconds */
const MAP_ROWS = 64, MAP_COL = 16;
async function readMap(d, l) {
  const rows = (d.live?.songRows || []).filter((r, c) => r != null && (d.live.playing >> c) & 1);
  const at = rows.length ? Math.min(...rows) : d.row;
  /* kept while the playing row stays in the first column and the read is fresh; else read again, one SONG_ROWS
     block (16 rows) a poll, so a crossfader's VOLUME_SETs never wait behind four reads */
  const fresh = d.map && at >= d.mapFrom && at < d.mapFrom + MAP_COL - 2 && now() - d.mapAt < 4000;
  if (!fresh && !d.mapFill) d.mapFill = {from: Math.max(0, Math.min(256 - MAP_ROWS, at - 2)), rows: []};
  const f = d.mapFill;
  if (!f) return;
  const part = await l.songRows(f.from + f.rows.length);
  if (d.mapFill !== f) return;
  if (!part) { d.mapFill = null; return; }
  f.rows.push(...part);
  if (f.rows.length >= MAP_ROWS || !d.map) { d.map = f.rows.slice(); d.mapFrom = f.from; }   /* (a first read shows as it comes; a move, when whole) */
  if (f.rows.length >= MAP_ROWS) { d.mapAt = now(); d.mapFill = null; }
}
/* each FM-1 deck's LIVE, a few times a second: its own tempo, what plays, its mutes (0.9.98: rows, SYNC, mode) */
async function poll() {
  for (const d of decks) {
    deckScreen(d);
    if (d.kind !== 'fm1') continue;
    const l = hooks.linkFor(d.key);
    if (!l) continue;
    try {
      d.live = await l.live();
      if (d.live.level != null && !d.levelBusy) d.levelSent = d.live.level;
      if (d.live.level != null && d.levelSent !== (d.level ?? 127)) void sendLevel(d);   /* power cycled, or another page */
      if (now() - (d.themeAt || 0) > 8000) await deckTheme(d, l);
      if (deckView(d) === 'rows') { await readMap(d, l); drawMap(d); }   /* (read only while the rows show) */
    } catch { d.live = null; }
  }
}

/* ---------- the mixer ---------- */
function mixerPorts() {
  const a = hooks.access();
  return {ins: [...(a?.inputs?.values() || [])], outs: [...(a?.outputs?.values() || [])]};
}
function mixerSend(what, ...args) {
  const o = mixerPorts().outs.find(p => p.id === mixer.outId);
  if (!o) return false;
  const msgs = out(preset(mixer.id), what, ...args);
  try { msgs.forEach(m => o.send(m)); } catch { return false; }
  return msgs.length > 0;
}
function hearMixer(e) {
  const msg = readMidi(e.data);
  if (!msg) return;
  if (mixer.learning) {   /* MIDI learn: this control does the action chosen */
    const r = learnRule(msg, mixer.learning, mixer.learning.seen || []);
    mixer.learned = mixer.learned.filter(x => !(x.type === r.type && x.ch === r.ch && x.num === r.num)).concat(r);
    store.set('dj-learned', saveLearned(mixer.learned));
    mixer.note = `Learned: ${msg.type.toUpperCase()} ${msg.num} on channel ${msg.ch} → ${actName(mixer.learning)}.`;
    mixer.learning = null; draw(); return;
  }
  const a = actionFor(preset(mixer.id), msg, mixer.map, mixer.id === 'learn' ? mixer.learned : []);
  if (a) act(a);
}
function act(a) {
  const d = a.deck != null ? decks[a.deck] : null;
  switch (a.act) {
  case 'fader': if (a.ch != null) mixer.faders[a.ch] = a.v; break;
  case 'xfader': setXfader(a.v); break;
  case 'filter': if (d) deckFilter(d, a.v); break;
  case 'echo': case 'reverb': if (d) deckThrow(d, a.act, a.v >= 0.5); break;
  case 'start': if (d) deckPlay(d); break;
  case 'cue': if (d) cueRow(d); break;
  case 'play': masterPlay(); break;
  case 'tempo': setMasterBpm(master.bpm + (master.whole ? Math.sign(a.v) * Math.max(1, Math.round(Math.abs(a.v))) : a.v)); break;   /* (whole: a step of 1 at least) */
  }
  if (['start', 'cue', 'play'].includes(a.act)) drawMixer();   /* a press: Play / Stop may change */
  else mixerNumbers();   /* a fader, a knob, an encoder: many a second, the numbers only */
}
/* the crossfader: the mixer's two deck channels when it takes volumes; else (no mixer) each FM-1's volume, 0.9.98 */
function setXfader(v) {
  mixer.xfader = v;
  const g = crossfade(v, mixer.curve);
  let sent = false;
  if (mixer.id !== 'none') decks.forEach((d, i) => { const ch = mixer.map[i]; if (ch) sent = mixerSend('fader', ch, g[i]) || sent; });
  applyVolumes();
  const fm1s = decks.filter(d => d.kind === 'fm1');
  mixer.note = mixer.id === 'none'
    ? (fm1s.length && fm1s.every(d => fwOf(d) >= 998) ? 'Without a MIDI mixer the crossfader sets each FM-1\'s volume (times its MASTER knob).'
      : 'Without a MIDI mixer the crossfader sets each FM-1\'s volume: that needs 0.9.98 on the FM-1s.')
    : sent ? '' : 'This mixer doesn\'t take its volumes from the page: the crossfader shows here only.';
  mixerNumbers();   /* (dragged: the numbers only, never the slider itself) */
}
function setMixerIn(id) {
  mixer.input?.removeEventListener?.('midimessage', hearMixer);
  mixer.inId = id; store.set('dj-mixer-in', id);
  mixer.input = mixerPorts().ins.find(p => p.id === id) || null;
  mixer.input?.open?.().catch?.(() => {});
  mixer.input?.addEventListener?.('midimessage', hearMixer);
}
const ACTIONS = [{act: 'xfader'}, {act: 'play'}, {act: 'tempo'}, ...[0, 1].flatMap(deck => ['start', 'cue', 'filter', 'echo', 'reverb'].map(act => ({act, deck}))),
  ...[0, 1].map(deck => ({act: 'fader', deck, mixCh: deck + 1}))];
function actName(a) {
  const n = {xfader: 'Crossfader', play: 'Master Play / Stop', tempo: 'Master tempo (relative)', start: 'Play / Stop', cue: 'Cue row',
    filter: 'DJ filter', echo: 'Echo throw', reverb: 'Reverb throw', fader: 'Fader'}[a.act];
  return a.deck != null ? `Deck ${NAMES[a.deck]}: ${n}` : n;
}

/* ---------- drawing ---------- */
let statusEl = null;
const say = text => { if (statusEl) statusEl.textContent = text; };
function sel(options, value, onchange, label) {
  const s = el('select', {onchange: () => onchange(s.value)});
  if (label) s.setAttribute('aria-label', label);
  options.forEach(([v, t, dis]) => { const o = new Option(t, v); o.disabled = !!dis; s.append(o); });
  s.value = value; return s;
}
const btn = (text, onclick, props = {}) => el('button', {type: 'button', textContent: text, onclick, ...props});
function holdBtn(text, down, up, props = {}) {
  const b = el('button', {type: 'button', textContent: text, ...props});
  b.onpointerdown = e => { b.setPointerCapture?.(e.pointerId); b.classList.add('on'); down(); };
  b.onpointerup = b.onpointercancel = () => { b.classList.remove('on'); up(); };
  b.onkeydown = e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { b.classList.add('on'); down(); } };
  b.onkeyup = e => { if (e.key === ' ' || e.key === 'Enter') { b.classList.remove('on'); up(); } };
  return b;
}
function deckChoices() {
  const fm1s = hooks.devices().map(d => [`fm1:${d.key}`, d.label]);
  const fm1Outs = new Set(hooks.devices().map(d => hooks.outputFor(d.key)?.id));
  const gear = mixerPorts().outs.filter(p => !fm1Outs.has(p.id) && p.id !== mixer.outId).map(p => [`gear:${p.id}`, `${p.name} (MIDI)`]);
  return [['', 'Empty'], ...fm1s, ...gear];
}
function drawDeck(d) {
  const u = d.ui;
  if (!u) return;
  const fm1 = d.kind === 'fm1', fw = firmwareNumber(hooks.devices().find(x => x.key === d.key)?.fw);
  u.body.replaceChildren();
  if (!d.key) { u.body.append(el('p', {className: 'hint', textContent: 'Choose an FM-1 or another MIDI device for this deck.'})); return; }
  const running = !!d.clock?.running;
  const bpmIn = el('input', {type: 'number', min: 40, max: 295, step: master.whole ? 1 : 0.1, value: d.bpm, className: 'dj-bpm-in', onchange: () => setDeckBpm(d, +bpmIn.value)});
  u.bpmIn = bpmIn;
  bpmIn.setAttribute('aria-label', `Deck ${NAMES[d.i]} tempo`);
  u.bpm = el('div', {className: 'dj-bpm'});
  u.phase = el('div', {className: 'dj-phase', ariaHidden: 'true'}, ...[0, 1, 2, 3].map(() => el('span')));
  u.gap = el('div', {className: 'dj-gap hint'});
  u.body.append(
    el('div', {className: 'dj-tempo'}, u.bpm, el('label', {}, 'BPM ', bpmIn)),
    u.phase, u.gap,
    el('div', {className: 'dj-row'},
      btn(running ? '■ Stop' : '▶ Play', () => deckPlay(d), {className: running ? 'on' : '', title: 'Starts on the master\'s next bar'}),
      btn('Sync', () => deckSync(d), {title: 'The master\'s tempo, then catch up to its bar'}),
      holdBtn('− nudge', () => nudge(d, -1), () => nudge(d, 0), {title: 'Slower while held'}),
      holdBtn('nudge +', () => nudge(d, 1), () => nudge(d, 0), {title: 'Faster while held'})));
  if (fm1) {
    const mask = d.live?.mute ?? d.kill;
    const kills = CHANNELS.map((n, c) => btn(n, () => kill(d, c), {className: `dj-kill${(mask >> c) & 1 ? ' killed' : ''}`, title: `Mute or play ${n}`}));
    const onBar = el('input', {type: 'checkbox', checked: d.killOnBar, onchange: () => { d.killOnBar = onBar.checked; store.set('dj-killbar', onBar.checked ? '1' : '0'); }});
    u.body.append(el('div', {className: 'dj-row dj-kills'}, ...kills, el('label', {className: 'hint'}, onBar, ' on the bar')));
  }
  const filt = el('input', {type: 'range', min: -64, max: 63, value: d.filter, className: 'dj-filter', oninput: () => deckFilter(d, +filt.value)});
  filt.ondblclick = () => { filt.value = 0; deckFilter(d, 0); };
  filt.setAttribute('aria-label', `Deck ${NAMES[d.i]} DJ filter: low-pass left, high-pass right`);
  const by = (k) => sel([['fm1', 'FM-1', !fm1], ['mixer', 'mixer', !preset(mixer.id).out]], d[k], v => { d[k] = v; }, 'Whose effect');
  u.body.append(
    el('div', {className: 'dj-row'}, el('span', {className: 'hint', textContent: 'LP'}), filt, el('span', {className: 'hint', textContent: 'HP'}), by('filterBy')),
    el('div', {className: 'dj-row'},
      holdBtn('Echo throw', () => deckThrow(d, 'echo', true), () => deckThrow(d, 'echo', false)),
      holdBtn('Reverb throw', () => deckThrow(d, 'reverb', true), () => deckThrow(d, 'reverb', false), {disabled: fm1 && d.throwBy === 'fm1' && fw < 997}),
      by('throwBy')));
  if (fm1) {
    const row = el('input', {type: 'text', value: d.row.toString(16).toUpperCase().padStart(2, '0'), size: 3, maxLength: 2, className: 'mono',
      onchange: () => { d.row = Math.min(127, parseInt(row.value, 16) || 0); }});
    row.setAttribute('aria-label', 'Song row (hex)');
    const has98 = fw >= 998, held = !!d.live?.live;
    u.body.append(el('div', {className: 'dj-row'}, el('label', {}, 'Row ', row), btn('Cue row', () => cueRow(d), {title: 'Plays that song row at the next bar (FM-1: PC CUE on)'}),
      u.hold = btn(held ? 'Held' : 'Hold', () => void deckHold(d), {disabled: !has98, className: held ? 'on' : '',
        title: has98 ? 'LSDj live mode: each channel loops its chain until you cue another. Again: song mode.' : 'Needs 0.9.98 on the FM-1'}),
      has98 ? null : el('span', {className: 'hint', textContent: 'Hold and Rows need 0.9.98.'})));
    /* Screen | Rows: the FM-1's screen, or the song row map (click a row to cue it) */
    const view = deckView(d);
    const viewBtn = (v, text, title, disabled = false) => btn(text, () => setView(d, v),
      {className: view === v ? 'on' : '', disabled, title, ariaPressed: String(view === v)});
    u.body.append(el('div', {className: 'seg dj-view', role: 'group', ariaLabel: `Deck ${NAMES[d.i]}: show`},
      viewBtn('screen', 'Screen', "The FM-1's screen"),
      viewBtn('rows', 'Rows', has98 ? 'The song rows: click one to cue it at the next bar' : 'Needs 0.9.98 on the FM-1', !has98)));
    /* one fixed-size box for both views (index.html .dj-view-box: its size and shape are CSS variables), so the
       deck never changes size when switching */
    const box = el('div', {className: `dj-view-box ${view}`});
    u.map = null; u.rowIn = row;
    if (view === 'rows') { u.map = el('div', {className: 'dj-map mono', role: 'group', ariaLabel: `Deck ${NAMES[d.i]} song rows`}); box.append(u.map); drawMap(d); }
    else box.append(d.scrOk ? u.screen
      : el('p', {className: 'hint dj-view-note', textContent: fw >= 983 ? 'This FM-1 did not send its screen. Choose the deck again to retry.' : `This FM-1's screen shows here with FM-1_983 or newer (it runs ${fw ? `FM-1_${fw}` : 'older firmware'}).`}));
    u.body.append(box);
    u.info = el('p', {className: 'hint dj-info'});
    u.body.append(u.info);
  }
}
/* the song row map: 16 rows, a chain per channel (-- empty); the rows playing marked; a click cues that row
   (a program change: rows 00-7F only) */
function drawMap(d) {
  const u = d.ui;
  if (!u?.map) return;
  if (!d.map) { u.map.replaceChildren(el('span', {className: 'hint', textContent: 'Reading the song…'})); return; }
  const at = d.live?.songRows || [], playing = d.live?.playing || 0;
  u.map.replaceChildren(...d.map.map((chains, i) => {
    const r = d.mapFrom + i, here = chains.map((c, ch) => (playing >> ch) & 1 && at[ch] === r);
    /* a tap cues it; only the map is redrawn (its scroll stays) */
    const b = btn('', () => { d.row = r; cueRow(d); if (u.rowIn) u.rowIn.value = hex2(r); drawMap(d); },
      {className: `dj-maprow${here.some(Boolean) ? ' here' : ''}${r === d.row ? ' cued' : ''}${chains.every(c => c == null) ? ' empty' : ''}`,
      disabled: r > 127, title: r > 127 ? 'A program change cues rows 00–7F only' : `Cue row ${hex2(r)}`});
    b.append(el('b', {textContent: hex2(r)}), ...chains.map((c, ch) => el('span', {className: here[ch] ? 'on' : '', textContent: c == null ? '--' : hex2(c)})));
    return b;
  }));
}
function drawMixer() {
  if (!root) return;
  const m = root.querySelector('.dj-mixer'), p = preset(mixer.id), ports = mixerPorts();
  const portSel = (list, v, f, label) => sel([['', 'None'], ...list.map(x => [x.id, x.name])], v, f, label);
  const xf = el('input', {type: 'range', min: 0, max: 1000, value: Math.round(mixer.xfader * 1000), className: 'dj-xfader', oninput: () => setXfader(+xf.value / 1000)});
  xf.setAttribute('aria-label', 'Crossfader');
  xf.ondblclick = () => { xf.value = 500; setXfader(0.5); };
  const g = crossfade(mixer.xfader, mixer.curve);
  const chSel = i => sel(Array.from({length: p.channels}, (_, c) => [String(c + 1), `ch ${c + 1}`]), String(mixer.map[i] || i + 1),
    v => { mixer.map[i] = +v; store.set('dj-mixer-map', JSON.stringify(mixer.map)); }, `Deck ${NAMES[i]}'s mixer channel`);
  const meterParts = [0, 1].map(() => ({bar: el('span'), src: el('small')}));
  const meters = meterParts.map((x, i) => el('div', {className: 'dj-meter'}, el('b', {textContent: NAMES[i]}), x.bar, x.src));
  const note = el('p', {className: 'hint'});
  const source = sel([['page', 'This page'], ...ports.ins.map(x => [x.id, `Clock from ${x.name}`])], master.source, setSource, 'Master clock');
  const mb = masterNow();
  const bpmIn = el('input', {type: 'number', min: 40, max: 295, step: master.whole ? 1 : 0.1, value: master.source === 'page' ? master.bpm : (mb.bpm || ''), disabled: master.source !== 'page',
    onchange: () => setMasterBpm(+bpmIn.value), className: 'dj-bpm-in'});
  bpmIn.setAttribute('aria-label', 'Master tempo');
  const big = el('div', {className: 'dj-bpm big', textContent: mb.bpm ? bpmText(mb.bpm) : '—'});
  const whole = el('input', {type: 'checkbox', checked: master.whole, onchange: () => setWhole(whole.checked)});
  mixer.ui = {bpmIn, big, xf, meters: meterParts, note};
  const running = master.source === 'page' ? !!master.clock?.running : !!master.ext?.running;
  m.replaceChildren(...[
    el('h4', {textContent: 'Master'}),
    big,
    el('div', {className: 'dj-row'}, el('label', {}, 'BPM ', bpmIn),
      btn('Tap', () => { const b = master.tap.tap(now()); if (b) setMasterBpm(b); }, {disabled: master.source !== 'page', title: 'Tap in time'}),
      el('label', {className: 'hint', title: 'Every tempo set here snaps to a whole number: Tap, typing, the decks, the mixer\'s tempo control'}, whole, ' Whole BPM')),
    el('div', {className: 'dj-row'}, btn(running ? '■ Stop all' : '▶ Play all', masterPlay, {className: running ? 'on' : ''}), source),
    el('h4', {textContent: 'Mixer'}),
    sel(PRESETS.map(x => [x.id, x.name + (x.verified ? '' : ' (unverified)')]), mixer.id, v => { mixer.id = v; store.set('dj-mixer', v); setXfader(mixer.xfader); draw(); }, 'Mixer'),
    p.id === 'none' ? null : el('div', {className: 'dj-row'}, el('label', {}, 'From ', portSel(ports.ins, mixer.inId, setMixerIn, 'Mixer MIDI in')),
      el('label', {}, 'To ', portSel(ports.outs, mixer.outId, v => { mixer.outId = v; store.set('dj-mixer-out', v); }, 'Mixer MIDI out'))),
    p.id === 'none' ? null : el('div', {className: 'dj-row'}, el('label', {}, 'A on ', chSel(0)), el('label', {}, 'B on ', chSel(1))),
    p.note ? el('p', {className: 'hint', textContent: p.note}) : null,
    el('div', {className: 'dj-meters'}, ...meters),
    el('div', {className: 'dj-row dj-xrow'}, el('b', {textContent: 'A'}), xf, el('b', {textContent: 'B'})),
    el('div', {className: 'dj-row'}, sel(CURVES.map(c => [c, {smooth: 'Smooth fade', linear: 'Linear', cut: 'Cut (scratch)'}[c]]), mixer.curve,
      v => { mixer.curve = v; store.set('dj-curve', v); setXfader(mixer.xfader); }, 'Crossfader curve')),
    p.id === 'learn' ? learnBox() : null,
    note].filter(Boolean));
  mixerNumbers();
}
/* the mixer's moving parts only (faders, crossfader, the note): a mixer sends many messages a second, and the
   page's own crossfader is being dragged, so these never rebuild the panel */
function mixerNumbers() {
  const u = mixer.ui;
  if (!u?.xf) return;
  const g = crossfade(mixer.xfader, mixer.curve);
  u.meters.forEach((x, i) => {
    const f = mixer.faders[mixer.map[i]];
    x.bar.style.setProperty('--v', (f ?? g[i]).toFixed(3));
    x.src.textContent = f != null ? 'fader' : 'xfade';
  });
  const v = String(Math.round(mixer.xfader * 1000));
  if (u.xf.value !== v) u.xf.value = v;   /* (dragged here: already that value) */
  u.note.textContent = mixer.note; u.note.hidden = !mixer.note;
}
function learnBox() {
  const pick = sel(ACTIONS.map((a, i) => [String(i), actName(a)]), '0', () => {}, 'Action to learn');
  return el('div', {className: 'dj-learn'},
    el('div', {className: 'dj-row'}, pick, btn(mixer.learning ? 'Move a control…' : 'Learn', () => {
      mixer.learning = mixer.learning ? null : {...ACTIONS[+pick.value]};
      mixer.note = mixer.learning ? `Move the control for ${actName(mixer.learning)} on your mixer.` : ''; drawMixer();
    }, {className: mixer.learning ? 'on' : ''}), btn('Forget all', () => { mixer.learned = []; store.set('dj-learned', '[]'); drawMixer(); }, {disabled: !mixer.learned.length})),
    el('ul', {className: 'hint dj-learned'}, ...mixer.learned.map(r => el('li', {textContent: `${r.type.toUpperCase()} ${r.num} ch ${r.ch} → ${actName(r)}`}))));
}
function draw() {
  if (!root) return;
  decks.forEach(d => {
    d.ui.pick.replaceChildren(...deckChoices().map(([v, t]) => new Option(t, v)));
    d.ui.pick.value = d.key ? `${d.kind}:${d.key}` : '';
    drawDeck(d);
    deckScreen(d);
  });
  drawMixer();
}
/* the moving parts, 20 times a second: tempo readouts, beat lights, the gap to the master, what the FM-1 says */
function tick() {
  const t = now(), m = masterNow(t);
  if (mixer.ui?.big) { const s = m.bpm ? bpmText(m.bpm) : '—'; if (mixer.ui.big.textContent !== s) mixer.ui.big.textContent = s; }   /* the master's tempo */
  decks.forEach(d => {
    const u = d.ui;
    if (!u?.bpm) return;
    const ph = d.clock?.phase(t) ?? null, pos = position(ph);
    /* not clocked by this page: the FM-1's own phrase row (0.9.98; a phrase is a bar, 4 rows a beat), as last polled */
    const own = ph == null ? fm1Row(d) : null;
    u.bpm.textContent = own != null ? String(d.live.bpm) : bpmText(d.bpm * (d.clock?.factor || 1));
    [...u.phase.children].forEach((s, b) => s.classList.toggle('on', pos ? pos.beat === b : own != null && (own >> 2) === b));
    const gap = offset(ph, m.phase);
    u.gap.textContent = gap != null ? (Math.abs(gap) < 0.5 ? 'in sync with the master' : `${gap > 0 ? 'behind' : 'ahead'} by ${(Math.abs(gap) / 6).toFixed(1)} rows`)
      : own != null ? `playing on its own clock · row ${hex2(own)} of the phrase` : d.clock?.running ? 'no master' : 'stopped';
    if (u.info) u.info.textContent = !d.live ? '' : [`On the FM-1: ${d.live.bpm} BPM · playing ${CHANNELS.filter((n, c) => (d.live.playing >> c) & 1).join(' ') || 'nothing'}`,
      d.live.level != null && d.live.level < 127 ? `volume ${Math.round(d.live.level / 1.27)} % from this page` : '', syncNote(d)].filter(Boolean).join(' · ');
    if (u.hold && d.live?.live != null) { u.hold.textContent = d.live.live ? 'Held' : 'Hold'; u.hold.classList.toggle('on', d.live.live); }
  });
}
/* the first playing channel's phrase row, from LIVE (0.9.98), or null */
function fm1Row(d) {
  const l = d.live;
  if (!l?.rows) return null;
  const c = [0, 1, 2, 3].find(c => (l.playing >> c) & 1 && l.rows[c] != null);
  return c == null ? null : l.rows[c] & 15;
}
/* 0.9.98: LSDj's SYNC said plainly when it won't follow this page's clock */
function syncNote(d) {
  const s = d.live?.sync;
  if (s === 'lsdj') return 'LSDj SYNC is LSDJ: it sends a clock and won\'t follow this page. PROJECT › SYNC = MIDI (or KEYBD), or choose it as the master clock.';
  return '';
}

/* Perform's DJ panel (index.html #dj-root): built once; the decks and mixer drawn again when things change */
export function mountDj(box) {
  root = box;
  statusEl = el('p', {className: 'hint dj-status', role: 'status'});
  const deckBox = d => {
    const pick = el('select', {onchange: () => void assign(d, pick.value)});
    pick.setAttribute('aria-label', `Deck ${NAMES[d.i]}`);
    const body = el('div', {className: 'dj-deck-body'});
    const screen = el('canvas', {width: 160, height: 144, className: 'dj-screen', role: 'img', ariaLabel: `Deck ${NAMES[d.i]}: the FM-1's screen`});
    const box = el('section', {className: 'dj-deck', ariaLabel: `Deck ${NAMES[d.i]}`}, el('h4', {}, `Deck ${NAMES[d.i]} `, pick), body);
    d.ui = {pick, body, screen, box};
    return box;
  };
  box.replaceChildren(el('div', {className: 'dj-grid'}, deckBox(decks[0]), el('section', {className: 'dj-mixer', ariaLabel: 'Master and mixer'}), deckBox(decks[1])),
    statusEl,
    el('p', {className: 'hint', textContent: 'Each deck follows this page\'s clock at its own tempo. On each FM-1: LSDj PROJECT › SYNC = MIDI (or KEYBD with 0.9.97), GLO › MIDI › CLOCK IN = ALL or USB, TRANSPORT ON; for Cue row and Rows, PC CUE ON. The audio goes through your mixer as usual; without one, the crossfader sets each FM-1\'s volume (0.9.98).'}));
  if (mixer.inId) setMixerIn(mixer.inId);
  draw();
}
/* the DJ layout shown or hidden: the readouts and FM-1 polls run only while it shows */
export function djShown(on) {
  clearInterval(ticker); clearInterval(polling); ticker = polling = 0;
  shown = on;
  decks.forEach(deckScreen);   /* the screens run only while the layout shows */
  if (!on) { decks.forEach(d => deckLevel(d, null)); return; }   /* the Effects layout: the FM-1s at full volume */
  applyVolumes();
  draw();
  ticker = setInterval(tick, 50);
  polling = setInterval(() => void poll(), 400);
}
/* the FM-1s plugged in changed: the choices follow; a deck whose FM-1 went away is emptied */
export function djDevicesChanged() {
  for (const d of decks) if (d.kind === 'fm1' && !hooks.devices().some(x => x.key === d.key)) void assign(d, '');
  draw();
}
export const djState = () => ({master, mixer, decks});
