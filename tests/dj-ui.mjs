// SPDX-License-Identifier: GPL-3.0-only
// Perform's DJ layout in the browser (mocked: two FM-1s and a TX-6 as MIDI ports; no device is touched). Run in a
// fresh local preview in real time (not a virtual-time browser): the deck clocks are timed.
//   Effects | DJ switches the layout; each deck takes an FM-1; Play sends Start and clocks to that FM-1 only, at the
//   deck's tempo; the second deck starts on the first's bar; Sync takes the master's tempo; a stem kill mutes;
//   the DJ filter sets all four channels' filters; Perform › Clock goes off; the TX-6 preset: a track button
//   starts / stops its deck, the crossfader sets its two channel volumes (CC 7).
import {OP} from '../lsdj/link.js';
import {djState} from '../lsdj/dj-ui.js';
import {unpackFx, unpackSettings, packSettings, PRESETS} from '../lsdj/fx-model.js';
import {pageColours} from '../lsdj/page-theme.js';
import {crossfade} from '../lsdj/dj.js';

const $ = id => document.getElementById(id);
const assert = (v, message) => { if (!v) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (check()) return; await sleep(50); }
  throw Error(message);
}
function fm1(n, title, fw = 'FM-1_997') {
  const d = {n, title, midi: [], fxSets: [], mutes: [], levels: [], seqs: [], mapReads: [], screens: 0, level: 127, seq: 0,
    settings: packSettings({...unpackSettings(0x5a000000), theme: n % PRESETS.length})};   /* each its own theme */
  const fx = Array(68).fill(0);
  fx[36] = 5; fx[37] = 2; fx[42] = 0xf2; fx[38] = 1;
  d.input = Object.assign(new EventTarget(), {id: `in-${n}`, name: 'FM-1', state: 'connected', onmidimessage: null});
  d.output = {id: `out-${n}`, name: 'FM-1', state: 'connected', send(message, ts) {
    if (message[0] !== 0xf0) { const m = [...message]; m.ts = ts; d.midi.push(m); return; }   /* ts: when it plays */
    const op = message[4], body = [];
    for (let i = 5; i + 1 < message.length - 1; i += 2) body.push(message[i] | (message[i + 1] & 1) << 7);
    const send = (data = [], status = 0) => queueMicrotask(() => d.input.onmidimessage?.({
      data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7]}));
    if (op === OP.INFO) { const info = Array(35).fill(0); info[0] = 1; [...fw].forEach((c, i) => info[1 + i] = c.charCodeAt(0)); [...title].forEach((c, i) => info[9 + i] = c.charCodeAt(0)); return send(info); }
    if (op === OP.FX_GET) return send(fx);
    if (op === OP.FX_SET) { d.fxSets.push(body); return send(); }
    if (op === OP.MUTE_SET) { d.mutes.push(body[0]); return send(); }
    if (op === OP.SETTINGS_GET) return send([0, 8, 16, 24].map(s => (d.settings >>> s) & 255));
    if (op >= OP.SCREEN_INFO && op <= OP.SCREEN_FRAME) d.screens++;   /* (no screen here: the deck says so) */
    if (op === OP.THEME_GET) return send(Array(16).fill(0));
    const dj = fw >= 'FM-1_998' ? [0x82, 5, 5, 5, 5, 2, 2, 2, 2, 3, d.seq, d.level] : [];
    if (op === OP.LIVE) return send([1, 1, 120, 0, d.mutes.at(-1) || 0, 0, 0, ...fx, ...dj]);
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
  access.outputs = new Map([['a', A.output], ['b', B.output], ['t', T.output]]);
  for (const k of ['lsdj-burrito-stage', 'dj-mixer', 'dj-mixer-in', 'dj-mixer-out', 'dj-mixer-map', 'dj-bpm', 'dj-learned', 'dj-view-0', 'dj-view-1']) try { localStorage.removeItem(k); } catch {}
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
    A.midi.length = B.midi.length = 0;
    const play = i => [...document.querySelectorAll('.dj-deck')][i].querySelector('.dj-row button').click();
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
    [...document.querySelectorAll('.dj-deck')][1].querySelectorAll('.dj-row button')[1].click();   /* Sync */
    assert(deckB.bpm === 120, `Sync: the master's tempo: ${deckB.bpm}`);

    // 4. a stem kill (NOI on A, now) and the DJ filter (A to low-pass): sent to A only
    const killNoi = [...document.querySelectorAll('.dj-deck')][0].querySelectorAll('.dj-kill')[3];
    killNoi.click();
    await until(() => A.mutes.at(-1) === 8, `NOI muted on A: ${A.mutes}`);
    assert(B.mutes.length === 0, 'B untouched');
    const filt = [...document.querySelectorAll('.dj-deck')][0].querySelector('.dj-filter');
    filt.value = '-40'; filt.dispatchEvent(new Event('input'));
    await until(() => A.fxSets.length > 0, 'the filter sent');
    const words = []; const b = A.fxSets.at(-1); for (let i = 0; i < b.length; i += 4) words.push((b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0);
    const sent = unpackFx(words);
    assert(sent.ch.every(c => c.type === 1 && c.cutoff < 60), `all four channels low-pass: ${JSON.stringify(sent.ch.map(c => [c.type, c.cutoff]))}`);
    filt.value = '0'; filt.dispatchEvent(new Event('input'));

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
    assert(map.scrollWidth > map.clientWidth && rowsShown0Top(map), 'columns of 16 rows, more sideways');
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
    await until(() => B.level === 127, `with a mixer, B's own volume full again: ${B.levels}`);

    // 6. back to Effects: the effects panels again; the FM-1s at full volume
    xf.value = '250'; xf.dispatchEvent(new Event('input'));
    choose(mixerSel, 'none');
    await until(() => B.level === want(0.25) && want(0.25) < 127, `no mixer again: B's volume from the crossfader: ${B.levels}`);
    document.querySelector('#stage-mode [data-mode="fx"]').click();
    assert(!document.body.classList.contains('dj') && getComputedStyle($('pan-chans')).display !== 'none', 'Effects layout back');
    await until(() => B.level === 127, `the Effects layout: B at full volume: ${B.levels}`);
    djState().decks.forEach(d => d.clock?.stop());
    return 'PASS DJ layout: switch, decks on FM-1s, Start and clocks per deck, the next bar, its own tempo, Sync, stem kill, DJ filter, Perform › Clock off, 0.9.98 (crossfader to FM-1 volume, Hold), each deck its FM-1 colours and Screen | Rows (screen, song row map, click to cue), TX-6 button and crossfader, fader mirrored, full volume after';
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor); else delete navigator.requestMIDIAccess;
  }
}
