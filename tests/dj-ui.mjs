// SPDX-License-Identifier: GPL-3.0-only
// Perform's DJ layout in the browser (mocked: two FM-1s and a TX-6 as MIDI ports; no device is touched). Run in a
// fresh local preview in real time (not a virtual-time browser): the deck clocks are timed.
//   Effects | DJ switches the layout; each deck takes an FM-1; Play sends Start and clocks to that FM-1 only, at the
//   deck's tempo; the second deck starts on the first's bar; Sync takes the master's tempo; a stem kill mutes;
//   the DJ filter sets all four channels' filters; Perform › Clock goes off; the TX-6 preset: a track button
//   starts / stops its deck, the crossfader sets its two channel volumes (CC 7).
import {OP, crc32} from '../lsdj/link.js';
import {djState, rememberSav} from '../lsdj/dj-ui.js';
import {addToCrate} from '../lsdj/crate-ui.js';
import {unpackFx, unpackSettings, packSettings, PRESETS, unpackMidi} from '../lsdj/fx-model.js';
import {pageColours} from '../lsdj/page-theme.js';
import {crossfade, offset} from '../lsdj/dj.js';

const $ = id => document.getElementById(id);
const assert = (v, message) => { if (!v) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (check()) return; await sleep(50); }
  throw Error(message);
}
/* a save with only its header filled in (names, versions, the open song, the block table): what a deck reads */
function fakeSave(songs, active) {
  const s = new Uint8Array(0x20000);
  s[0x813e] = 0x6a; s[0x813f] = 0x6b; s[0x8140] = active ?? 0xff; s.fill(0xff, 0x8141, 0x8200);
  let b = 0;
  for (const x of songs) {
    [...x.name].forEach((c, i) => s[0x8000 + x.slot * 8 + i] = c.charCodeAt(0)); s[0x8100 + x.slot] = x.version;
    s.fill(x.slot, 0x8141 + b, 0x8141 + b + x.blocks); b += x.blocks;
  }
  return s;
}
function fm1(n, title, fw = 'FM-1_997') {
  const d = {n, title, midi: [], fxSets: [], mutes: [], levels: [], seqs: [], mapReads: [], screens: 0, level: 127, seq: 0,
    settings: packSettings({...unpackSettings(0x5a000000), theme: n % PRESETS.length}),   /* each its own theme */
    infos: 0, reads: 0, begins: 0, importing: null, save: fakeSave([{slot: 0, name: 'TECHNO', version: 2, blocks: 10}], 0),
    midiWord: (0x4D000000 | 1 | 8 | 1 << 17) >>> 0, midiSets: [], sync: 5, syncSets: [], dev2: true};   /* MIDI: CLOCK IN ALL, TRANSPORT ON, PC CUE ON; LSDj SYNC KEYBD */
  const fx = Array(68).fill(0);
  fx[36] = 5; fx[37] = 2; fx[42] = 0xf2; fx[38] = 1;
  d.input = Object.assign(new EventTarget(), {id: `in-${n}`, name: 'FM-1', state: 'connected', onmidimessage: null});
  d.output = {id: `out-${n}`, name: 'FM-1', state: 'connected', send(message, ts) {
    if (message[0] !== 0xf0) { const m = [...message]; m.ts = ts; d.midi.push(m); return; }   /* ts: when it plays */
    const op = message[4], body = [];
    for (let i = 5; i + 1 < message.length - 1; i += 2) body.push(message[i] | (message[i + 1] & 1) << 7);
    const send = (data = [], status = 0) => queueMicrotask(() => d.input.onmidimessage?.({
      data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7]}));
    if (op === OP.INFO) { d.infos++; const info = Array(35).fill(0); info[0] = 1; [...fw].forEach((c, i) => info[1 + i] = c.charCodeAt(0)); [...title].forEach((c, i) => info[9 + i] = c.charCodeAt(0));
      const crc = crc32(d.save); [0, 8, 16, 24].forEach((s, i) => info[29 + i] = (crc >>> s) & 255); return send(info); }
    if (op === OP.READ) { const off = body[0] | body[1] << 8 | body[2] << 16 | body[3] << 24; d.reads++; return send([...d.save.subarray(off, off + 128)]); }
    /* a .sav sent (Songs › Send, the crate): taken whole at COMMIT */
    if (op === OP.ABORT) { d.importing = null; return send(); }
    if (op === OP.BEGIN) { d.importing = new Uint8Array(0x20000); d.begins++; return send(); }
    if (op === OP.CHUNK) { const off = body[0] | body[1] << 8 | body[2] << 16 | body[3] << 24; d.importing?.set(body.slice(4, 132), off); return send(); }
    if (op === OP.COMMIT) { if (d.importing) { d.save = d.importing; d.importing = null; } return send(); }
    if (op === OP.FX_GET) return send(fx);
    if (op === OP.FX_SET) { d.fxSets.push(body); return send(); }
    if (op === OP.MUTE_SET) { d.mutes.push(body[0]); return send(); }
    if (op === OP.SETTINGS_GET) return send([0, 8, 16, 24].map(s => (d.settings >>> s) & 255));
    if (op >= OP.SCREEN_INFO && op <= OP.SCREEN_FRAME) d.screens++;   /* (no screen here: the deck says so) */
    if (op === OP.THEME_GET) return send(Array(16).fill(0));
    const dj = fw >= 'FM-1_998' ? [0x82, 5, 5, 5, 5, 2, 2, 2, 2, d.sync, d.seq, d.level] : [];
    if (op === OP.MIDI_GET) return send([0, 8, 16, 24].map(s => (d.midiWord >>> s) & 255));
    if (op === OP.MIDI_SET) { d.midiWord = (body[0] | body[1] << 8 | body[2] << 16 | body[3] << 24) >>> 0; d.midiSets.push(d.midiWord); return send(); }
    if (op === OP.SYNC_SET && fw >= 'FM-1_998' && d.dev2) { if (d.playing) return send([], 2); d.syncSets.push(body[0]); d.sync = body[0]; return send(); }
    if (op === OP.LIVE) return send([1, 1, 120, 0, d.mutes.at(-1) || 0, 0, d.playing || 0, ...fx, ...dj]);   /* d.playing: the channels playing (a bit each) */
    if (fw >= 'FM-1_998' && op === OP.VOLUME_SET) { d.levels.push(body[0]); d.level = body[0]; return send(); }
    if (fw >= 'FM-1_998' && op === OP.SEQ_SET) { d.seqs.push(body[0]); d.seq = body[0]; return send(); }
    if (fw >= 'FM-1_998' && op === OP.SONG_ROWS) { d.mapReads.push(body[0]); return send([body[0], ...Array.from({length: 64}, (_, i) => i % 4 ? 0xFF : (body[0] + i / 4) & 0x3F)]); }
    return send([], 1);
  }};
  return d;
}
function tx6() {
  const t = {sent: []};
  t.input = Object.assign(new EventTarget(), {id: 'tx6-in', name: 'TX-6', state: 'connected'});
  t.output = {id: 'tx6-out', name: 'TX-6', state: 'connected', send(m) { t.sent.push([...m]); }};
  t.play = bytes => { const e = new Event('midimessage'); e.data = Uint8Array.from(bytes); t.input.dispatchEvent(e); };
  return t;
}
/* Rows: row 10 (hex) starts the second column, level with row 00 */
const rowsShown0Top = map => { const r = [...map.querySelectorAll('.dj-maprow')]; return Math.abs(r[0].getBoundingClientRect().top - r[16].getBoundingClientRect().top) < 2 && r[16].getBoundingClientRect().left > r[0].getBoundingClientRect().left; };
const choose = (select, value) => { select.value = value; select.dispatchEvent(new Event('change')); };
const clocks = d => d.midi.filter(m => m[0] === 0xf8).length;

export async function runDjUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  const A = fm1(1, 'LSDj-AAA'), B = fm1(2, 'LSDj-BBB', 'FM-1_998'), T = tx6();
  const access = new EventTarget();
  access.inputs = new Map([['a', A.input], ['b', B.input], ['t', T.input]]);
  const AB = {sent: []};
  AB.output = {id: 'ab-out', name: 'Arduinoboy', state: 'connected', send(m) { AB.sent.push([...m]); }};
  access.outputs = new Map([['a', A.output], ['b', B.output], ['t', T.output], ['ab', AB.output]]);
  for (const k of ['lsdj-burrito-stage', 'dj-mixer', 'dj-mixer-in', 'dj-mixer-out', 'dj-mixer-map', 'dj-bpm', 'dj-learned', 'dj-view-0', 'dj-view-1', 'dj-whole', 'dj-theme', 'dj-ab-ch']) try { localStorage.removeItem(k); } catch {}
  try {
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true, value: async () => access});
    await $('connect-btn').onclick();
    await until(() => $('stage-pick').options.length >= 2, 'both FM-1s listed');

    // 1. the layout switch
    document.querySelector('#stage-mode [data-mode="dj"]').click();
    assert(document.body.classList.contains('dj') && getComputedStyle($('pan-dj')).display !== 'none', 'DJ layout shown');
    assert(getComputedStyle($('pan-chans')).display === 'none', 'the effects panels hidden');
    const [pickA, pickB] = [...document.querySelectorAll('.dj-deck h4 select')];
    await until(() => ['fm1:out-1', 'fm1:out-2', 'gear:tx6-out'].every(v => [...pickA.options].some(o => o.value === v)),
      `deck choices: both FM-1s and other MIDI gear: ${[...pickA.options].map(o => o.value)}`);

    // 2. decks: A on FM-1 A, B on FM-1 B; Perform › Clock on 'page' goes off when a deck starts
    choose($('sync-mode'), 'page');
    choose(pickA, 'fm1:out-1'); choose(pickB, 'fm1:out-2');
    await until(() => djState().decks[0].fx && djState().decks[1].fx, 'each deck read its FM-1\'s effects');

    // 2b. DJ colours: the page and the DJ panel in a theme of their own (Midnight); FM-1 decks keep their FM-1's colours
    const midnight = pageColours(PRESETS[6]), deckBox = [...document.querySelectorAll('.dj-deck')][0];
    choose(document.querySelector('select[aria-label="DJ colours"]'), '6');
    assert(document.body.style.getPropertyValue('--bg') === midnight['--bg'] && $('pan-dj').style.getPropertyValue('--bg') === midnight['--bg'],
      `the page and the DJ panel in Midnight: ${document.body.style.getPropertyValue('--bg')}`);
    assert(getComputedStyle(document.body).backgroundColor !== '' && $('pan-dj').classList.contains('dj-themed'), 'the DJ panel themed');
    await until(() => deckBox.classList.contains('themed'), 'deck A in its FM-1\'s colours');
    assert(deckBox.style.getPropertyValue('--bg') !== midnight['--bg'] && getComputedStyle(deckBox).getPropertyValue('--bg').trim() === deckBox.style.getPropertyValue('--bg'),
      `deck A keeps its FM-1's colours under the DJ colours: ${deckBox.style.getPropertyValue('--bg')}`);
    A.midi.length = B.midi.length = 0;
    const play = i => [...document.querySelectorAll('.dj-deck')][i].querySelector('.dj-play').click();
    play(0);
    assert($('sync-mode').value === 'off', `Perform › Clock off: ${$('sync-mode').value}`);
    await sleep(1000);
    /* Perform › Clock's Stop first (it was running), then the deck's Start and its clocks */
    const fa = A.midi.findIndex(m => m[0] === 0xfa);
    assert(fa >= 0 && !A.midi.slice(fa).some(m => m[0] === 0xfc) && clocks(A) >= 40 && clocks(A) <= 56, `A: Start, ~48 clocks in 1 s at 120: ${A.midi.slice(0, 3)}, ${clocks(A)}`);
    assert(!B.midi.some(m => m[0] === 0xfa || m[0] === 0xf8), `B: no Start or clocks yet: ${B.midi}`);
    const gapA = [...document.querySelectorAll('.dj-deck')][0].querySelector('.dj-gap').textContent;
    assert(/in sync/.test(gapA), `A started with the master: in sync: ${gapA}`);

    // 3. B at 126 starts on A's (the master's) next bar, at its own tempo; Sync: back to 120
    const deckB = djState().decks[1];
    const bpmB = [...document.querySelectorAll('.dj-deck')][1].querySelector('.dj-bpm-in');
    bpmB.value = '126'; bpmB.dispatchEvent(new Event('change'));
    assert(deckB.bpm === 126, 'B at 126');
    play(1);
    await until(() => B.midi.some(m => m[0] === 0xfa), 'B started', 3000);
    const at = B.midi.find(m => m[0] === 0xfa).ts, onMaster = djState().master.clock.phase(at);
    const fromBar = Math.min(onMaster % 96, 96 - (onMaster % 96));
    assert(fromBar < 0.5, `B's Start is timed on the master's bar: master at ${onMaster.toFixed(2)} clocks then`);
    await sleep(1000);
    assert(Math.abs(deckB.clock.phase() / djState().decks[0].clock.phase() - 1) > 0, 'B runs at its own tempo');
    [...document.querySelectorAll('.dj-deck')][1].querySelector('.dj-sync').click();   /* Sync */
    assert(deckB.bpm === 120, `Sync: the master's tempo: ${deckB.bpm}`);

    // 3b. Sync is a lock (Colin: flaky, and nothing on a stopped deck): lit; B pushed off the bar comes back by
    // itself; a new master tempo is followed; on a stopped deck it takes the tempo at once; typing a tempo lets go
    const deckBEl0 = () => [...document.querySelectorAll('.dj-deck')][1];
    const syncB = () => deckBEl0().querySelector('.dj-sync');
    assert(deckB.synced && syncB().classList.contains('on') && syncB().textContent === 'SYNC', 'Sync lit while on');
    const barGap = () => offset(deckB.clock.phase(), djState().master.clock.phase());
    await until(() => Math.abs(barGap()) < 0.75, `B on the master's bar: ${barGap()}`, 4000);
    deckB.clock.bend(1.6); await sleep(400); deckB.clock.bend(1);   /* pushed off, as a drift would */
    assert(Math.abs(barGap()) > 2, `B pushed off the bar: ${barGap()}`);
    await until(() => Math.abs(barGap()) < 0.75, `locked: back on the master's bar by itself: ${barGap()}`, 5000);
    const masterIn = document.querySelector('.dj-mixer .dj-bpm-in');
    masterIn.value = '124'; masterIn.dispatchEvent(new Event('change'));
    await until(() => deckB.bpm === 124 && deckB.clock.bpm === 124, `the master to 124: B follows: ${deckB.bpm}`, 1000);
    masterIn.value = '120'; masterIn.dispatchEvent(new Event('change'));
    await until(() => deckB.bpm === 120, 'back to 120', 1000);
    syncB().click();
    assert(!deckB.synced && !syncB().classList.contains('on'), 'Sync again: off');
    deckBEl0().querySelector('.dj-play').click();   /* B stopped */
    assert(!deckB.clock.running, 'B stopped');
    const bpmB0 = deckBEl0().querySelector('.dj-bpm-in');
    bpmB0.value = '131'; bpmB0.dispatchEvent(new Event('change'));
    syncB().click();
    assert(deckB.synced && deckB.bpm === 120 && bpmB0.value === '120', `Sync on a stopped deck: the master's tempo at once: ${deckB.bpm}`);
    bpmB0.value = '125'; bpmB0.dispatchEvent(new Event('change'));
    assert(!deckB.synced && !syncB().classList.contains('on') && deckB.bpm === 125, 'typing a tempo lets go of Sync');
    bpmB0.value = '120'; bpmB0.dispatchEvent(new Event('change'));
    deckBEl0().querySelector('.dj-play').click();   /* B playing again, on the master's bar */
    await until(() => deckB.clock.running, 'B playing again', 3000);

    // 4. a stem kill (NOI on A, now) and the DJ filter (A to low-pass): sent to A only
    const killNoi = [...document.querySelectorAll('.dj-deck')][0].querySelectorAll('.dj-kill')[3];
    killNoi.click();
    await until(() => A.mutes.at(-1) === 8, `NOI muted on A: ${A.mutes}`);
    assert(B.mutes.length === 0, 'B untouched');
    const filt = document.querySelectorAll('.dj-mixer .dj-filter')[0];   /* deck A's FILTER, on its mixer strip */
    filt.value = '-40'; filt.dispatchEvent(new Event('input'));
    await until(() => A.fxSets.length > 0, 'the filter sent');
    const words = []; const b = A.fxSets.at(-1); for (let i = 0; i < b.length; i += 4) words.push((b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0);
    const sent = unpackFx(words);
    assert(sent.ch.every(c => c.type === 1 && c.cutoff < 60), `all four channels low-pass: ${JSON.stringify(sent.ch.map(c => [c.type, c.cutoff]))}`);
    const knob = filt.closest('.dj-knob');
    assert(filt.isConnected && parseFloat(knob.style.getPropertyValue('--deg')) < -80, `the knob turned left, not redrawn: ${knob.style.getPropertyValue('--deg')}`);
    /* the knob dragged up: towards high-pass */
    const kr = knob.getBoundingClientRect(), kx = kr.left + kr.width / 2, ky = kr.top + kr.height / 2;
    knob.dispatchEvent(new PointerEvent('pointerdown', {clientX: kx, clientY: ky, pointerId: 1, bubbles: true}));
    knob.dispatchEvent(new PointerEvent('pointermove', {clientX: kx, clientY: ky - 100, pointerId: 1, bubbles: true}));
    knob.dispatchEvent(new PointerEvent('pointerup', {clientX: kx, clientY: ky - 100, pointerId: 1, bubbles: true}));
    assert(djState().decks[0].filter > 0 && +filt.value === djState().decks[0].filter, `knob dragged up: high-pass ${djState().decks[0].filter}`);
    filt.value = '0'; filt.dispatchEvent(new Event('input'));

    // 4a. the pitch fader: the deck's tempo against the master's (+4 %: 124.8); a double-click: the master's again
    const pitchB = [...document.querySelectorAll('.dj-deck')][1].querySelector('.dj-pitch');
    pitchB.value = '400'; pitchB.dispatchEvent(new Event('input'));
    assert(djState().decks[1].bpm === 124.8 && !djState().decks[1].synced, `pitch +4 %: B at 124.8: ${djState().decks[1].bpm}`);
    await until(() => /\+4\.00 %/.test([...document.querySelectorAll('.dj-deck')][1].querySelector('.dj-pitch-txt').textContent), 'the display: +4.00 %', 1000);
    pitchB.dispatchEvent(new MouseEvent('dblclick'));
    assert(djState().decks[1].bpm === 120, `double-click: the master's tempo: ${djState().decks[1].bpm}`);

    // 4a'. the jog wheel: turned clockwise, deck A runs faster while it turns, then back; anticlockwise, slower
    location.hash = '#live-sec'; await sleep(300);   /* (shown: the wheel has a size) */
    const deckA0 = djState().decks[0], jogA = [...document.querySelectorAll('.dj-deck')][0].querySelector('.dj-jogwheel');
    const jr = jogA.getBoundingClientRect(), jx = jr.left + jr.width / 2, jy = jr.top + jr.height / 2, rad = jr.width * 0.4;
    const jogAt = deg => ({clientX: jx + rad * Math.cos(deg * Math.PI / 180), clientY: jy + rad * Math.sin(deg * Math.PI / 180), pointerId: 1, bubbles: true});
    jogA.dispatchEvent(new PointerEvent('pointerdown', jogAt(-90)));
    jogA.dispatchEvent(new PointerEvent('pointermove', jogAt(-60)));
    assert(deckA0.clock.factor > 1 && deckA0.nudging, `jog clockwise: faster: ${deckA0.clock.factor}`);
    await sleep(250);
    assert(deckA0.clock.factor === 1 && !deckA0.nudging, `jog stopped turning: back to its tempo: ${deckA0.clock.factor}`);
    jogA.dispatchEvent(new PointerEvent('pointermove', jogAt(-90)));
    assert(deckA0.clock.factor < 1, `jog anticlockwise: slower: ${deckA0.clock.factor}`);
    jogA.dispatchEvent(new PointerEvent('pointerup', jogAt(-90)));
    assert(deckA0.clock.factor === 1, 'let go: back to its tempo');

    // 4a''. stopped on the FM-1 itself: once A's FM-1 has played and then says twice running that nothing plays,
    // the page stops deck A too (the jog and beat lights with it); while it plays, nothing changes
    A.playing = 0x0f;
    await sleep(1300);
    assert(deckA0.clock.running && deckA0.seenPlaying, `A playing on its FM-1: the deck runs on: ${deckA0.clock.running}`);
    A.playing = 0;   /* (stopped with its own buttons) */
    await until(() => !deckA0.clock.running, 'stopped on the FM-1: deck A stops', 3000);
    assert(/stopped on the FM-1/.test(document.querySelector('.dj-status').textContent), `said: ${document.querySelector('.dj-status').textContent}`);
    assert(djState().decks[1].clock.running, 'B plays on, untouched');
    play(0);   /* A again, for the rest */
    await until(() => deckA0.clock.running, 'A playing again', 3000);
    await sleep(1300);
    assert(deckA0.clock.running, 'a deck the FM-1 has not played on yet is not stopped (LSDj takes a moment to start)');

    // 4b. 0.9.98 on B: no mixer, so the crossfader sets B's volume (VOLUME_SET); Hold (SEQ_SET)
    const want = x => Math.round(crossfade(x, djState().mixer.curve)[1] * 127);
    await until(() => B.level === want(0.5), `B's volume from the crossfader in the middle: ${B.levels}, want ${want(0.5)}`);
    const xf0 = document.querySelector('.dj-xfader');
    xf0.value = '0'; xf0.dispatchEvent(new Event('input'));
    await until(() => B.level === want(0), `crossfader to A: B's volume ${want(0)}: ${B.levels}`);
    xf0.value = '500'; xf0.dispatchEvent(new Event('input'));
    await until(() => B.level === want(0.5), `back to the middle: ${B.levels}`);
    assert(B.levels.length < 12, `one request at a time, the latest value: ${B.levels}`);
    const deckBEl = [...document.querySelectorAll('.dj-deck')][1];
    const hold = [...deckBEl.querySelectorAll('button')].find(b => b.textContent === 'Hold');
    assert(hold && !hold.disabled, 'B: Hold on 0.9.98');
    assert([...document.querySelectorAll('.dj-deck')][0].querySelector('button[title="Needs 0.9.98 on the FM-1"]')?.disabled, 'A (0.9.97): Hold off, with a note');
    hold.click();
    await until(() => B.seqs.at(-1) === 1, `Hold: SEQ_SET live: ${B.seqs}`);
    assert(!document.querySelector('.dj-map, .dj-maprow') && !B.mapReads.length, 'Screen first: no row map, SONG_ROWS not read');

    // 4c. each deck: its own FM-1's screen, asked on that FM-1's link (these fakes have none: the deck says so),
    // and its own FM-1's theme colours
    await until(() => A.screens > 0 && B.screens > 0, `each deck asks its own FM-1 for its screen: A ${A.screens}, B ${B.screens}`, 4000);
    const decksEl = [...document.querySelectorAll('.dj-deck')];
    await until(() => decksEl.every(e => /did not send its screen/.test(e.textContent)), 'no screen on these fakes: each deck says so', 4000);
    const accent = d => pageColours(PRESETS[unpackSettings(d.settings).theme])['--accent'];
    await until(() => decksEl.every(e => e.classList.contains('themed')), 'both decks themed', 4000);
    assert(decksEl[0].style.getPropertyValue('--accent') === accent(A) && decksEl[1].style.getPropertyValue('--accent') === accent(B) && accent(A) !== accent(B),
      `each deck in its FM-1's colours: ${decksEl.map(e => e.style.getPropertyValue('--accent'))} want ${accent(A)} ${accent(B)}`);

    // 4c2. the deck labels: the FM-1's songs from its save's header (READs: LSDj keeps playing); a .sav sent from this
    // page names the deck, "(changed since)" once the FM-1's save no longer matches; INFO (a sum over the whole save
    // on the FM-1) is not asked while the header stays the same
    const labelOf = e => [e.querySelector('.dj-label-file').textContent, e.querySelector('.dj-label-song').textContent];
    await until(() => decksEl.every(e => labelOf(e)[1] === 'Song TECHNO .02 · 1 song · 95 % free'), `labels: ${decksEl.map(e => labelOf(e).join(' / '))}`, 7000);
    assert(labelOf(decksEl[0])[0] === 'Its own songs', `nothing sent to A from here: ${labelOf(decksEl[0])}`);
    const readsSent = B.reads, infosSent = B.infos;
    rememberSav('out-2', 'techno-set.sav', crc32(B.save));
    await until(() => B.reads >= readsSent + 4 && B.infos > infosSent, 'read again after the send, INFO once', 7000); await sleep(200);
    await until(() => labelOf(decksEl[1])[0] === 'techno-set.sav', `B named after the .sav sent to it: ${labelOf(decksEl[1])}`, 7000);
    const infos0 = B.infos, reads0 = B.reads;
    await sleep(5600);
    assert(B.infos === infos0 && B.reads > reads0, `the header read again (${B.reads - reads0} READs), INFO not asked (${B.infos - infos0})`);
    B.save = fakeSave([{slot: 0, name: 'TECHNO', version: 3, blocks: 10}, {slot: 1, name: 'HOUSE', version: 0, blocks: 6}], 1);
    await until(() => labelOf(decksEl[1]).join(' / ') === 'techno-set.sav (changed since) / Song HOUSE .00 · 2 songs · 92 % free',
      `B's save changed: ${labelOf(decksEl[1])}`, 7000);

    // 4d. Screen | Rows: A (0.9.97) has no Rows; B shows its song row map, a click cues that row; back to Screen
    const viewBtn = (e, t) => [...e.querySelectorAll('.dj-view button')].find(b => b.textContent === t);
    assert(viewBtn(decksEl[0], 'Rows')?.disabled && viewBtn(decksEl[0], 'Screen')?.classList.contains('on'), 'A (0.9.97): Rows off, Screen on');
    /* the view box and the deck keep their size whichever view shows (Perform shown, to measure) */
    location.hash = '#live-sec'; await sleep(300);
    const boxSize = e => { const r = e.querySelector('.dj-view-box').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), Math.round(e.getBoundingClientRect().height)].join(); };
    const sizeScreen = boxSize(decksEl[1]);
    viewBtn(decksEl[1], 'Rows').click();
    await until(() => decksEl[1].querySelectorAll('.dj-maprow').length === 64, 'B: Rows shows 64 song rows (4 blocks, one a poll)', 6000);
    assert(B.mapReads.join().startsWith('0,16,32,48'), `one 16-row block a request, in order: ${B.mapReads}`);
    assert(boxSize(decksEl[1]) === sizeScreen, `the same size on Rows as on Screen (box w,h, deck h): ${boxSize(decksEl[1])} vs ${sizeScreen}`);
    const map = decksEl[1].querySelector('.dj-map');
    /* columns of 16 rows (row 10 level with row 00, to its right); four fit here, or the rest sideways */
    assert(rowsShown0Top(map) && (map.scrollWidth > map.clientWidth || map.querySelectorAll('.dj-maprow')[48].getBoundingClientRect().right <= map.getBoundingClientRect().right + 1), `columns of 16 rows: ${map.scrollWidth} / ${map.clientWidth}`);
    assert(viewBtn(decksEl[1], 'Rows').classList.contains('on') && !decksEl[1].querySelector('.dj-screen'), 'B: Rows on, no screen');
    const rowsShown = [...decksEl[1].querySelectorAll('.dj-maprow')];
    assert(/^00 00 -- -- --/.test(rowsShown[0].textContent.replace(/(..)(?=.)/g, '$1 ')), `row 00: chain 00 in PU1: ${rowsShown[0].textContent}`);
    B.midi.length = 0;
    rowsShown[2].click();
    assert(B.midi.some(m => m[0] === 0xc0 && m[1] === 2), `a click on row 02 cues it (program change 2): ${B.midi}`);
    viewBtn(decksEl[1], 'Screen').click();
    const reads = B.mapReads.length, shots = B.screens;
    await sleep(1200);
    assert(!decksEl[1].querySelector('.dj-maprow') && B.mapReads.length === reads && B.screens > shots, `back to Screen: no rows read (${B.mapReads.length - reads}), the screen asked again (${B.screens - shots})`);
    B.midi.length = 0;

    // 4e. Tap pressed quickly: the tempo follows, and the layout is not redrawn (each tap redrew both decks, their
    // rows and the mixer, and froze Colin's page); then Whole BPM: every tempo snaps to a whole number
    const tapBtn = () => [...document.querySelectorAll('.dj-mixer button')].find(b => b.textContent === 'TAP');
    const kept = [tapBtn(), ...document.querySelectorAll('.dj-deck-body > *')];
    for (let i = 0; i < 16; i++) { tapBtn().click(); await sleep(i % 2 ? 230 : 270); }
    const tapped = djState().master.bpm, big = () => document.querySelector('.dj-mixer .dj-bpm.big').textContent;
    assert(tapped > 225 && tapped < 255, `16 taps 250 ms apart: about 240 BPM: ${tapped}`);
    assert(kept.every(e => e.isConnected), 'taps: nothing redrawn but the numbers');
    await until(() => big() === tapped.toFixed(1), `the master readout follows: ${big()} vs ${tapped}`, 1000);
    const wholeBox = [...document.querySelectorAll('.dj-mixer label')].find(l => /Whole BPM/.test(l.textContent)).querySelector('input');
    wholeBox.click();
    assert(djState().master.whole && Number.isInteger(djState().master.bpm) && djState().decks.every(d => Number.isInteger(d.bpm)), `Whole BPM: master and decks whole: ${djState().master.bpm}, ${djState().decks.map(d => d.bpm)}`);
    await until(() => !big().includes('.'), `the readout without a point: ${big()}`, 1000);
    const bpmInB = [...document.querySelectorAll('.dj-deck')][1].querySelector('.dj-bpm-in');
    assert(bpmInB.step === '1', `deck tempo box in steps of 1: ${bpmInB.step}`);
    bpmInB.value = '127.6'; bpmInB.dispatchEvent(new Event('change'));
    assert(djState().decks[1].bpm === 128 && bpmInB.value === '128', `typed 127.6: 128: ${djState().decks[1].bpm} (${bpmInB.value})`);
    for (let i = 0; i < 4; i++) { tapBtn().click(); await sleep(310); }
    assert(Number.isInteger(djState().master.bpm), `Whole BPM: a tapped tempo is whole: ${djState().master.bpm}`);
    [...document.querySelectorAll('.dj-mixer label')].find(l => /Whole BPM/.test(l.textContent)).querySelector('input').click();
    assert(!djState().master.whole, 'Whole BPM off again');
    for (const i of document.querySelectorAll('.dj-bpm-in')) { i.value = '120'; i.dispatchEvent(new Event('change')); }   /* back to 120 for the rest */

    // 5. the TX-6: its track 1 button stops deck A; the crossfader sets its channel 1 and 2 volumes
    const mixerSel = document.querySelector('.dj-mixer select[aria-label="Mixer"]');
    choose(mixerSel, 'tx6');
    choose(document.querySelector('.dj-mixer select[aria-label="Mixer MIDI in"]'), 'tx6-in');
    choose(document.querySelector('.dj-mixer select[aria-label="Mixer MIDI out"]'), 'tx6-out');
    T.play([0xb0, 25, 127]); T.play([0xb0, 25, 0]);
    assert(!djState().decks[0].clock.running && A.midi.some(m => m[0] === 0xfc), 'track 1 button: deck A stopped');
    const xf = document.querySelector('.dj-xfader');
    xf.value = '1000'; xf.dispatchEvent(new Event('input'));
    const vol = ch => T.sent.filter(m => m[0] === (0xb0 | (ch - 1)) && m[1] === 7).at(-1)?.[2];
    assert(vol(1) === 0 && vol(2) === 127, `crossfader to B: ch 1 ${vol(1)}, ch 2 ${vol(2)}`);
    T.play([0xb0, 1, 64]);
    assert(Math.abs(djState().mixer.faders[1] - 64 / 127) < 1e-9, 'fader 1 mirrored');
    /* a fader moved fast (200 messages): the meter follows, the mixer panel is not rebuilt */
    const head = document.querySelector('.dj-mixer > h4');
    for (let i = 0; i < 200; i++) T.play([0xb0, 1, i & 127]);
    const meterA = document.querySelector('.dj-meter span');
    assert(head.isConnected && xf.isConnected, 'mixer messages: the panel not rebuilt');
    assert(Math.abs(parseFloat(meterA.style.getPropertyValue('--v')) - (199 & 127) / 127) < 0.01, `the meter follows: ${meterA.style.getPropertyValue('--v')}`);
    T.play([0xb0, 1, 64]);
    await until(() => B.level === 127, `with a mixer, B's own volume full again: ${B.levels}`);

    // 6. back to Effects: the effects panels again; the FM-1s at full volume
    xf.value = '250'; xf.dispatchEvent(new Event('input'));
    choose(mixerSel, 'none');
    await until(() => B.level === want(0.25) && want(0.25) < 127, `no mixer again: B's volume from the crossfader: ${B.levels}`);
    document.querySelector('#stage-mode [data-mode="fx"]').click();
    assert(!document.body.classList.contains('dj') && getComputedStyle($('pan-chans')).display !== 'none', 'Effects layout back');
    assert(!document.body.style.getPropertyValue('--bg'), 'the Effects layout: the page\'s own colours again');
    document.querySelector('#stage-mode [data-mode="dj"]').click();
    assert(document.body.style.getPropertyValue('--bg') === pageColours(PRESETS[6])['--bg'], 'DJ again: its colours again');
    choose(document.querySelector('select[aria-label="DJ colours"]'), 'page');
    assert(!document.body.style.getPropertyValue('--bg') && !$('pan-dj').classList.contains('dj-themed'), 'Page colours: the DJ colours gone');
    document.querySelector('#stage-mode [data-mode="fx"]').click();
    await until(() => B.level === 127, `the Effects layout: B at full volume: ${B.levels}`);

    // 7. an ArduinoBoy deck: listed for each MIDI output; normal speed at the start; the speed notes on channel 16;
    //    the clock, Start and Stop; the FM-1-only controls hidden; no row cue
    document.querySelector('#stage-mode [data-mode="dj"]').click();
    await until(() => [...pickA.options].some(o => o.value === 'ab:ab-out'), `the ArduinoBoy choice: ${[...pickA.options].map(o => o.value)}`);
    choose(pickA, 'ab:ab-out');
    const deckA = [...document.querySelectorAll('.dj-deck')][0], dA = djState().decks[0];
    assert(dA.kind === 'ab' && AB.sent.length === 2 && AB.sent[0].join() === '159,50,100' && AB.sent[1].join() === '143,50,0',
      `ArduinoBoy: normal speed sent on ch 16: ${JSON.stringify(AB.sent)}`);
    const speeds = () => [...deckA.querySelectorAll('[aria-label="Deck A: LSDj speed"] button')];
    assert(speeds().length === 4 && speeds()[0].classList.contains('on'), 'four speeds, Normal lit');
    speeds()[1].click();
    assert(AB.sent.at(-2).join() === '159,51,100' && dA.abSpeed === 1 && speeds()[1].classList.contains('on'), `half speed: note 51, lit: ${AB.sent.at(-2)}`);
    choose(deckA.querySelector('select[aria-label="ArduinoBoy MIDI channel"]'), '3');
    assert(AB.sent.at(-2).join() === '146,51,100', `channel 3: the speed sent again there: ${AB.sent.at(-2)}`);
    assert(!deckA.querySelector('.dj-kill') && !deckA.querySelector('.dj-view-box') && deckA.querySelector('.dj-label').hidden && !/Cue row/.test(deckA.textContent),
      'no kills, screen, rows, label or Cue row on an ArduinoBoy deck');
    assert(dA.filterBy === 'mixer' && dA.throwBy === 'mixer', 'its filter and throws by the mixer');
    AB.sent.length = 0;
    play(0);
    /* (it starts on the master's next bar) */
    await until(() => AB.sent[0]?.[0] === 0xfa && AB.sent.filter(m => m[0] === 0xf8).length >= 20, `Play: Start and clocks to the ArduinoBoy: ${AB.sent.slice(0, 2)}, ${AB.sent.length}`, 4000);
    play(0);
    assert(AB.sent.at(-1)[0] === 0xfc, `Stop: ${AB.sent.at(-1)}`);
    choose(pickA, '');
    try { localStorage.removeItem('dj-ab-ch'); } catch {}

    // 8. the crate: a .sav loads onto deck A's FM-1 while deck B plays on (its clocks keep coming, nothing else goes
    //    to it); Grab B copies B's songs into the crate while it plays
    try { localStorage.removeItem('dj-crate'); } catch {}
    choose(pickA, 'fm1:out-1');
    await until(() => djState().decks[0].fx, 'deck A on FM-1 A again');
    const dB = djState().decks[1];
    if (!dB.clock?.running) play(1);
    await until(() => clocks(B) > 0, 'deck B playing');
    const friday = fakeSave([{slot: 0, name: 'HOUSE', version: 2, blocks: 5}], 0);
    await addToCrate({name: 'Friday', sav: friday});
    const crate = document.querySelector('.dj-crate');
    const card = () => [...crate.querySelectorAll('.crate-card')].find(c => c.querySelector('.crate-name').value === 'Friday');
    await until(() => card() && /HOUSE/.test(card().textContent), `the card shows its song: ${crate.textContent}`);
    const cardBtn = text => [...card().querySelectorAll('button')].find(b => b.textContent === text);
    assert(cardBtn('Load A') && cardBtn('Load B'), 'Load A and Load B on the card');
    const realConfirm = window.confirm, bSend = B.output.send;
    window.confirm = () => true;
    try {
      const bOps = [];
      B.output.send = (m, ts) => { if (m[0] === 0xf0) bOps.push(m[4]); return bSend(m, ts); };
      const ticksBefore = clocks(B);
      cardBtn('Load A').click();
      await until(() => crc32(A.save) === crc32(friday), 'FM-1 A has the crate\'s songs', 20000);
      await until(() => /Deck A has "Friday"/.test(crate.textContent), `the crate says so: ${crate.querySelector('.crate-status').textContent}`);
      await until(() => clocks(B) > ticksBefore + 20 && dB.clock.running, `deck B kept playing: ${ticksBefore} -> ${clocks(B)}`, 3000);
      assert(!bOps.some(op => [OP.BEGIN, OP.CHUNK, OP.COMMIT, OP.ABORT].includes(op)), `nothing of the load went to B: ${[...new Set(bOps)]}`);
      const bTs = B.midi.filter(m => m[0] === 0xf8).map(m => m.ts).filter(Number.isFinite);
      const gap = Math.max(...bTs.slice(1).map((t, i) => t - bTs[i]));
      assert(gap < 40, `deck B's clocks evenly spaced during the load (one each 20.8 ms at 120): the widest gap ${gap.toFixed(1)} ms`);
      /* Grab B: a copy of B's songs as a new card; B keeps its songs and keeps playing */
      const bBegins = B.begins;
      [...crate.querySelectorAll('.crate-top button')].find(b => b.textContent === 'Grab B').click();
      await until(() => [...crate.querySelectorAll('.crate-card')].some(c => /TECHNO/.test(c.textContent)), `Grab B: B's songs in the crate: ${crate.textContent}`, 20000);
      assert(B.begins === bBegins && dB.clock.running, 'B: nothing written, still playing');
    } finally { window.confirm = realConfirm; B.output.send = bSend; }
    try { localStorage.removeItem('dj-crate'); } catch {}

    // 9. deck B's FM-1 drops off USB while playing and comes back: the deck empties, then takes it back by itself,
    //    playing again; both are in the Log
    assert(dB.clock?.running && dB.key === 'out-2', 'deck B playing on FM-1 B');
    const port = (p, state) => { p.state = state; const e = new Event('statechange'); e.port = p; access.dispatchEvent(e); };
    access.inputs.delete('b'); access.outputs.delete('b'); port(B.input, 'disconnected'); port(B.output, 'disconnected');
    await until(() => !dB.key && dB.gone?.key === 'out-2', `deck B empties and remembers its FM-1: ${dB.key}`, 6000);
    access.inputs.set('b', B.input); access.outputs.set('b', B.output); port(B.input, 'connected'); port(B.output, 'connected');
    await until(() => dB.key === 'out-2' && dB.clock?.running, `deck B takes its FM-1 back, playing: ${dB.key} ${dB.clock?.running}`, 8000);
    const log = document.querySelector('.dj-log');
    log.open = true; log.dispatchEvent(new Event('toggle'));
    const logged = log.querySelector('.dj-log-text').textContent;
    assert(/Deck B: its FM-1 \(out-2\) went away while playing/.test(logged) && /Deck B: its FM-1 \(out-2\) is back/.test(logged) && /disconnected/.test(logged),
      `the Log has it: ${logged}`);
    log.open = false;

    // 10. each deck sets its FM-1 up for the page's clock by itself (0.9.98-dev.2): the MIDI settings it needs
    // (CLOCK IN, TRANSPORT, PC CUE; CLOCK OUT kept) and LSDj's SYNC to KEYBD while stopped; what it can't, on the
    // deck's warning strip
    document.querySelector('#stage-mode [data-mode="dj"]').click();
    const warnB = () => [...document.querySelectorAll('.dj-deck')][1].querySelector('.dj-warn');
    const logNow = () => { const l = document.querySelector('.dj-log'); l.open = true; l.dispatchEvent(new Event('toggle')); const t = l.querySelector('.dj-log-text').textContent; l.open = false; return t; };
    B.midiWord = (0x4D000000 | 3 | 1 << 15) >>> 0;   /* CLOCK IN TRS, TRANSPORT OFF, PC CUE OFF, CLOCK OUT USB */
    B.sync = 3; B.dev2 = true; B.playing = 0; B.midiSets.length = 0; B.syncSets.length = 0;
    choose(pickB, ''); choose(pickB, 'fm1:out-2');
    await until(() => B.midiSets.length === 1, 'deck B sets its FM-1\'s MIDI settings');
    const mB = unpackMidi(B.midiSets[0]);
    assert(mB.clockIn === 1 && mB.transport === 1 && mB.pcCue === 1 && mB.clockOut === 1, `CLOCK IN ALL, TRANSPORT ON, PC CUE ON, CLOCK OUT kept: ${JSON.stringify(mB)}`);
    await until(() => B.syncSets.join() === '5' && B.sync === 5, `LSDj's SYNC MIDI -> KEYBD: ${B.syncSets}`, 4000);
    await sleep(1200);
    assert(B.syncSets.length === 1 && B.midiSets.length === 1 && warnB().hidden, `once each, no warning: ${B.syncSets} ${B.midiSets.length} ${warnB().textContent}`);
    const logB = logNow();
    assert(/Deck B: set the FM-1's CLOCK IN to ALL, TRANSPORT ON, PC CUE ON/.test(logB) && /Deck B: set LSDj's SYNC from MIDI to KEYBD/.test(logB), `logged: ${logB.slice(-400)}`);
    /* SYNC = LSDJ with CLOCK OUT on: that FM-1 leads; left as it is, said on the strip */
    B.sync = 1;
    await until(() => !warnB().hidden && /CLOCK OUT on/.test(warnB().textContent), `LSDJ + CLOCK OUT: the warning: ${warnB().textContent}`, 3000);
    assert(B.syncSets.length === 1, 'LSDJ with CLOCK OUT on: not changed');
    /* 0.9.98-dev.1 (no SYNC_SET) with SYNC = MIDI: nothing set, the strip says how */
    B.dev2 = false; B.sync = 3; B.midiWord = (0x4D000000 | 1 | 8 | 1 << 17) >>> 0;
    choose(pickB, ''); choose(pickB, 'fm1:out-2');
    await until(() => !warnB().hidden && /SYNC is MIDI: set it to KEYBD/.test(warnB().textContent), `dev.1, SYNC MIDI: the warning: ${warnB().textContent}`, 3000);
    assert(B.syncSets.length === 1 && B.midiSets.length === 1, 'dev.1: nothing more sent');
    /* fixed by hand on LSDj: the strip goes */
    B.sync = 5;
    await until(() => warnB().hidden, 'SYNC KEYBD: the strip goes', 3000);
    B.dev2 = true;
    play(1);
    document.querySelector('#stage-mode [data-mode="fx"]').click();
    djState().decks.forEach(d => d.clock?.stop());
    return 'PASS DJ layout: switch, decks on FM-1s, Start and clocks per deck, the next bar, its own tempo, Sync (a lock: lit, keeps the bar, follows the master, on a stopped deck, lets go when typed), stem kill, DJ filter, Perform › Clock off, 0.9.98 (crossfader to FM-1 volume, Hold), DJ colours (the page and panel; FM-1 decks keep theirs), each deck its FM-1 colours, its label (the .sav sent, the open song, changed since), Screen | Rows (screen, song row map, click to cue), Tap quickly (no redraw), Whole BPM, TX-6 button and crossfader, fader mirrored, full volume after, an ArduinoBoy deck (speed notes, its channel, Start and clocks, FM-1 controls hidden), the crate (a .sav onto deck A while B plays on, untouched; Grab B), an FM-1 pulled and back (the deck takes it back, playing; the Log), stopped on the FM-1 (the deck stops too), each deck sets its FM-1 up (MIDI settings, LSDj SYNC to KEYBD; the warning strip)';
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor); else delete navigator.requestMIDIAccess;
  }
}

/* for a look at the layout (screenshots; never in the suite): the DJ layout on two mocked FM-1s and a mocked
   ArduinoBoy port, left in place */
export async function djDemo() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const A = fm1(1, 'LSDj-AAA', 'FM-1_998'), B = fm1(2, 'LSDj-BBB', 'FM-1_998');
  const access = new EventTarget();
  access.inputs = new Map([['a', A.input], ['b', B.input]]);
  access.outputs = new Map([['a', A.output], ['b', B.output], ['ab', {id: 'ab-out', name: 'Arduinoboy', state: 'connected', send() {}}]]);
  Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true, value: async () => access});
  await $('connect-btn').onclick();
  await until(() => $('stage-pick').options.length >= 2, 'both FM-1s listed');
  location.hash = '#live-sec';
  document.querySelector('#stage-mode [data-mode="dj"]').click();
  const [pickA, pickB] = [...document.querySelectorAll('.dj-deck h4 select')];
  await until(() => [...pickA.options].some(o => o.value === 'fm1:out-2'), 'deck choices');
  choose(pickA, 'fm1:out-1'); choose(pickB, 'fm1:out-2');
  await until(() => djState().decks.every(d => d.fx), 'the decks read their FM-1s');
  [...document.querySelectorAll('.dj-deck')][1].querySelector('.dj-view button:nth-child(2)').click();   /* B: Rows */
  [...document.querySelectorAll('.dj-deck')][0].querySelector('.dj-play').click();
  await sleep(1500);
  return 'demo';
}
