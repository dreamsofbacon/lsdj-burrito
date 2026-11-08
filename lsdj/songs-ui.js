// SPDX-License-Identifier: GPL-3.0-only
// The page's "Songs and kits" section. Open a .sav (a file, or the songs read from the FM-1) to:
//   - see which kit samples each song plays, and which songs play each sample;
//   - manage its songs: save one as .lsdsng, add .lsdsng songs, rename, delete; then download the .sav or send
//     it to the FM-1 (the FM-1's own import, as Songs › Import).
// Kit names come from the user's own LSDj: the one chosen in Install, a ROM file chosen here, or the one on the
// FM-1. Nothing is uploaded; works without an FM-1. Install's kit list shows the same ('songs-usage' event).
// The parsing is lsdj-sav.js, lsdj-kit.js, lsdj-usage.js (tested in node).
import {parseSav, songBytes, buildSav, readLsdsng, writeLsdsng, nameBytes, nameText, SavError, SAV_SIZE, SLOTS, BLOCK_COUNT} from './lsdj-sav.js';
import {kitSlots} from './lsdj-kit.js';
import {kitUsage, usageAcross, romFit, bestRom} from './lsdj-usage.js';
import {mountSetsUi, rememberRom} from './sets-ui.js';

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const hex = n => n.toString(16).toUpperCase().padStart(2, '0');

/* the open save: its bytes (as LSDj would read them), its songs (song null: damaged), the kit slots */
const state = {sav: null, from: '', items: [], edited: false, slots: null, romFrom: '', romChosen: false};
/* app.js: readSave(progress) -> .sav bytes, sendSave(bytes, progress), readRom(progress) -> ROM bytes (each fails
   with a clear message when no FM-1 is connected or another operation is running) */
let hooks = {readSave: null, sendSave: null, readRom: null, cartInfo: null};
export function setSongsHooks(h) { hooks = {...hooks, ...h}; }
export const songsState = () => state;

/* a progress bar for one FM-1 operation; hidden again afterwards */
async function withProgress(fn) {
  const p = $('st-progress'); p.hidden = false; p.value = 0;
  try { return await fn((n, t) => { p.max = t; p.value = n; }); } finally { p.hidden = true; }
}
const say = (text, cls = 'hint') => { const s = $('st-status'); if (s) { s.textContent = text; s.className = cls; } };

/* names as LSDj shows them; a kit the ROM doesn't have is said plainly */
export function kitLabel(slots, n) {
  if (!slots) return `Kit ${hex(n)}`;
  const s = slots[n];
  if (!s) return `Kit ${hex(n)} (not in this LSDj)`;
  return s.empty ? `Kit ${hex(n)} (empty in this LSDj)` : s.kit.name || `Kit ${hex(n)}`;
}
export function sampleLabel(slots, n, i) {
  const smp = slots?.[n]?.kit?.samples.find(x => x.index === i);
  return smp ? smp.name.replace(/-+$/, '') || `#${i + 1}` : `#${i + 1}`;
}
/* the songs the report covers: every readable song, and the working song when no saved song is open */
export function reportSongs(sav, items) {
  const list = items.filter(s => s.song).map(s => ({name: s.name, song: s.song}));
  if (sav.active == null && sav.working.some(b => b)) list.unshift({name: 'UNSAVED', song: sav.working, working: true});
  return list;
}
/* bank -> {used: [songs], maybe: [songs]} for Install's kit list, from the kit numbers in that ROM */
export function usageByBank(rom, usage) {
  const out = new Map();
  if (!rom || !usage) return out;
  for (const s of kitSlots(rom)) {
    const m = usage.get(s.number), used = new Set(), maybe = new Set();
    if (m) for (const e of m.values()) { e.songs.forEach(x => used.add(x)); e.maybe.forEach(x => maybe.add(x)); }
    used.forEach(x => maybe.delete(x));
    out.set(s.bank, {used: [...used], maybe: [...maybe]});
  }
  return out;
}
export const currentUsage = () => state.sav ? usageAcross(reportSongs(state.sav, state.items)) : null;

/* ---- the song list ---- */
function itemsOf(sav) {
  return sav.songs.map(s => {
    let song = null;
    try { song = songBytes(sav, s.slot); } catch (e) { if (!(e instanceof SavError)) throw e; }
    return {slot: s.slot, name: s.name || `SLOT ${s.slot}`, nameBytes: sav.bytes.slice(0x8000 + s.slot * 8, 0x8008 + s.slot * 8), version: s.version, song, blocks: s.blocks};
  });
}
/* after a change: the save built again from the list (damaged songs left out), read back */
function rebuild() {
  const keep = state.items.filter(s => s.song);
  const bytes = buildSav(state.sav.bytes, state.sav.working, keep, state.sav.active);
  const sav = parseSav(bytes);
  state.items = itemsOf(sav); state.sav = sav; state.edited = true;
}
function download(bytes, name) {
  const a = el('a', {href: URL.createObjectURL(new Blob([bytes], {type: 'application/octet-stream'})), download: name});
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const fileName = s => `${(s.name || 'song').trim().replace(/[^A-Za-z0-9 _-]/g, '_') || 'song'}.lsdsng`;

function drawSongs(box) {
  const sav = state.sav, used = BLOCK_COUNT - sav.freeBlocks;
  const t = el('table', {className: 'st-table'});
  t.append(el('tr', {}, el('th', {textContent: 'Song'}), el('th', {textContent: 'Size'}), el('th', {textContent: 'Kit samples it plays'}), el('th')));
  const rows = reportSongs(sav, state.items);
  const unsaved = rows.find(r => r.working);
  if (unsaved) t.append(el('tr', {}, el('td', {className: 'mono', textContent: 'UNSAVED'}), el('td', {className: 'hint', textContent: 'open in LSDj'}), samplesCell(unsaved.song), el('td')));
  for (const s of state.items) {
    const btn = (text, title, fn) => el('button', {type: 'button', textContent: text, title, onclick: () => guard(fn)});
    const actions = el('td', {className: 'st-actions'});
    if (s.song) actions.append(
      btn('Save', 'Save this song as an .lsdsng file', () => download(writeLsdsng({nameBytes: s.nameBytes, version: s.version, song: s.song}), fileName(s))),
      btn('Rename', 'Rename (up to 8 letters and numbers)', () => {
        const n = prompt('New name (up to 8 letters and numbers):', s.name); if (n == null) return;
        s.nameBytes = nameBytes(n); s.name = nameText(s.nameBytes); rebuild(); draw(); say(`Renamed to ${s.name}.`, 'ok');
      }));
    actions.append(btn('Delete', 'Take this song out of the save', () => {
      if (!confirm(`Delete ${s.name} from this save? (The file you opened isn't changed.)`)) return;
      state.items = state.items.filter(x => x !== s); rebuild(); draw(); say(`Deleted ${s.name}.`, 'ok');
    }));
    t.append(el('tr', {}, el('td', {className: 'mono', textContent: s.name + (sav.active === s.slot ? ' (open in LSDj)' : '')}),
      el('td', {className: 'hint', textContent: `${s.blocks} block${s.blocks === 1 ? '' : 's'}`}),
      s.song ? samplesCell(s.song) : el('td', {className: 'bad', textContent: 'Damaged in this file: LSDj can\'t open it either. Sending or downloading leaves it out.'}),
      actions));
  }
  box.append(el('h3', {className: 'subhead', textContent: `${state.items.length} song${state.items.length === 1 ? '' : 's'} in ${state.from}${state.edited ? ' (changed here)' : ''}`}),
    el('p', {className: 'hint', textContent: `${used} of ${BLOCK_COUNT} blocks used, ${sav.freeBlocks} free; ${state.items.length} of ${SLOTS} song slots.`}), t);
}
function samplesCell(song) {
  const cell = el('td'), slots = state.slots, {kits} = kitUsage(song);
  if (!kits.size) cell.append(el('span', {className: 'hint', textContent: 'none'}));
  for (const [k, u] of [...kits].sort((a, b) => a[0] - b[0])) {
    const sure = [...u.samples].sort((a, b) => a - b).map(i => sampleLabel(slots, k, i));
    const maybe = [...u.maybe].sort((a, b) => a - b).map(i => sampleLabel(slots, k, i));
    cell.append(el('div', {}, el('b', {textContent: kitLabel(slots, k) + ': '}), sure.join(', '),
      maybe.length ? el('span', {className: 'hint', textContent: `${sure.length ? '; ' : ''}maybe ${maybe.join(', ')}`}) : null));
  }
  return cell;
}
function drawKits(box) {
  const slots = state.slots, across = currentUsage();
  const kt = el('table', {className: 'st-table'});
  kt.append(el('tr', {}, el('th', {textContent: 'Kit'}), el('th', {textContent: 'Sample'}), el('th', {textContent: 'Songs that play it'})));
  for (const [k, m] of [...across].sort((a, b) => a[0] - b[0]))
    [...m].sort((a, b) => a[0] - b[0]).forEach(([i, e], row) => kt.append(el('tr', {},
      el('td', {textContent: row ? '' : kitLabel(slots, k)}), el('td', {textContent: sampleLabel(slots, k, i)}),
      el('td', {}, [...e.songs].join(', '), e.maybe.size ? el('span', {className: 'hint', textContent: `${e.songs.size ? '; ' : ''}maybe ${[...e.maybe].join(', ')}`}) : null))));
  if (across.size) box.append(el('h3', {className: 'subhead', textContent: 'Samples and the songs that play them'}), kt);
  if (slots) {
    const unused = slots.filter(s => !s.empty && !across.has(s.number)).map(s => s.kit.name || `Kit ${hex(s.number)}`);
    if (unused.length) box.append(el('p', {className: 'hint', textContent: `Kits none of these songs play: ${unused.join(', ')}. ` +
      'Install can leave them out to make room (songs you keep elsewhere may still need them).'}));
  }
  box.append(el('p', {className: 'hint', textContent: '"Maybe": a chain transpose or the instrument\'s table can change which sample plays.'}));
}
function draw() {
  const box = $('st-report');
  if (!box) return;
  box.replaceChildren();
  drawNeed();
  for (const id of ['st-add', 'st-download', 'st-send']) $(id).disabled = !state.sav;
  if (!state.sav) return;
  if (state.needs) box.append(el('p', {className: 'warn', textContent: `These are ${state.needs.title}'s songs. Their kits are in ${state.needs.title}'s LSDj, not in the .sav: ` +
    `install ${state.needs.title}'s LSDj on the FM-1 first, then press Send to the FM-1 (it checks the FM-1 has that LSDj).`}));
  drawSongs(box); drawKits(box);
}
/* asks for the LSDj the songs were made with when it's needed: none chosen yet, or the one chosen lacks kits
   the songs play (made with another LSDj, or with kits of their own) */
const kitList = ms => [...new Set(ms.map(m => m.kit))].map(k => `${kitLabel(state.slots, k)} (${[...new Set(ms.filter(m => m.kit === k).flatMap(m => m.songs))].join(', ')})`).join('; ');
function drawNeed() {
  const p = $('st-rom'), usage = currentUsage();
  const kits = usage ? [...usage.keys()].sort((a, b) => a - b) : [];
  if (!state.slots) {
    p.className = state.sav && kits.length ? 'warn' : 'hint';
    p.textContent = state.sav && kits.length
      ? `These songs play kits ${kits.map(hex).join(', ')}. Choose the LSDj they were made with (a .gb file, or read it from the FM-1) to see kit and sample names and check they're all there.`
      : 'Kit names come from your LSDj: choose it here or in Install, or read it from the FM-1.';
    return;
  }
  const fit = usage ? romFit(state.slots, usage) : null;
  p.className = fit && !fit.ok ? 'warn' : 'hint';
  p.textContent = `Kit names from ${state.romFrom}. ` + (!fit ? '' :
    fit.ok ? `It has every kit these songs play.` :
    `It doesn't have kits these songs play: ${kitList(fit.kits)}. They were probably made with another LSDj ` +
    '(other kits, or the same kits in another order) or with kits of their own: choose that LSDj (you can pick several .gb files; the page uses the one that fits best). ' +
    'Installing this one, those songs play nothing there.') +
    (fit?.empty.length ? ` Some notes play sample slots their kit leaves empty (silent in LSDj too): ${kitList(fit.empty)}.` : '');
}
const missingKits = fit => { const n = new Set(fit.kits.map(m => m.kit)).size; return n ? `${n} kit${n === 1 ? '' : 's'} missing` : 'every kit is there'; };
/* several .gb files: each checked against the songs; the best fit is used */
export function probeRoms(roms) {
  const usage = currentUsage();
  const list = roms.map(r => ({...r, slots: kitSlots(r.rom)})).filter(r => r.slots.length);
  if (!list.length) throw new SavError('None of these files has LSDj sample kits.');
  const {best, fits} = usage ? bestRom(list, usage) : {best: list[0], fits: []};
  useRom(best.rom, best.name);
  if (fits.length > 1) say(`Checked ${fits.length} files: ${best.name} fits best` +
    ` (${missingKits(best.fit)}). ` + fits.slice(1).map(f => `${f.name}: ${missingKits(f.fit)}`).join('; ') + '.', best.fit.ok ? 'ok' : 'warn');
  else say(`Kit names from ${best.name}.`, 'ok');
}
function announce() {
  draw();
  document.dispatchEvent(new CustomEvent('songs-usage', {detail: {usage: currentUsage()}}));
}

/* ---- opening ---- */
/* needs: for a song set's .sav, {title, dataCrc: async () -> the set LSDj's slot data CRC} (sets-ui.js) */
export function openSave(bytes, from, needs = null) {
  if (bytes.length === SAV_SIZE + 16) bytes = bytes.subarray(0, SAV_SIZE);   /* (as Songs › Import, which asks first) */
  const sav = parseSav(bytes.slice());
  Object.assign(state, {sav, from, items: itemsOf(sav), edited: false, needs});
  announce();
  const bad = state.items.filter(s => !s.song).length;
  say(`Opened ${from}: ${sav.songs.length} song${sav.songs.length === 1 ? '' : 's'}` + (bad ? `, ${bad} damaged.` : '.'), bad ? 'warn' : 'ok');
}
/* "Send to the FM-1": asks first; a set's songs (needs: {title, dataCrc}, sets-ui.js) only after checking the
   FM-1 has that set's LSDj, which holds their kits (a .sav holds no samples) */
export async function sendOpenSave() {
  if (!state.sav) throw new SavError('Open a .sav first.');
  if (!confirm('Replace the songs on the FM-1 with these? Export them first (Songs › Back up) if you want to keep them.')) return false;
  const n = state.needs;
  if (n) {
    let info = null, why = '';
    try { say('Checking which LSDj the FM-1 has…'); info = await hooks.cartInfo(); } catch (e) { why = e.message; }
    if (!info || info.dataCrc !== await n.dataCrc()) {
      const text = info ? `The FM-1 has a different LSDj installed, not ${n.title}'s.` : `Couldn't check which LSDj the FM-1 has (${why}).`;
      say(`${text} ${n.title}'s songs play the kits in ${n.title}'s LSDj (a .sav holds no samples): install it first ` +
        `(Install ${n.title}'s LSDj, then Install on the FM-1), then send the songs.`, 'bad');
      if (!confirm(`${text}\n\n${n.title}'s songs play the kits in ${n.title}'s own LSDj; a .sav holds no samples. ` +
        `With another LSDj their kit notes play the wrong samples or none.\n\nSend the songs anyway?`)) return false;
    }
  }
  say('Sending songs to the FM-1…');
  await withProgress(pr => hooks.sendSave(state.sav.bytes, pr));
  say('Sent. LSDj restarted with these songs.', 'ok');
  return true;
}
/* chosen: picked here (a file or the FM-1's), which a ROM chosen later in Install doesn't replace */
export function useRom(rom, from, chosen = true) {
  state.slots = rom ? kitSlots(rom) : null; state.romFrom = from; state.romChosen = chosen;
  announce();
}
export async function addLsdsng(files) {
  const added = [];
  for (const f of files) {
    const s = readLsdsng(new Uint8Array(await f.arrayBuffer()));
    if (state.items.length >= SLOTS) throw new SavError(`A save holds ${SLOTS} songs; ${f.name} and the rest were not added.`);
    const item = {slot: null, name: s.name, nameBytes: s.nameBytes, version: s.version, song: s.song};
    const before = state.items;
    state.items = [...before, item];
    try { rebuild(); } catch (e) { state.items = before; throw e; }
    added.push(s.name);
  }
  draw(); announce();
  say(`Added ${added.join(', ')}.`, 'ok');
}

async function guard(fn) { try { await fn(); } catch (e) { say(e.message, 'bad'); } }
export function mountSongsUi(root) {
  const file = (accept, multiple, f) => {
    const i = el('input', {type: 'file', accept, multiple, hidden: true});
    i.onchange = () => { const x = [...i.files]; i.value = ''; if (x.length) guard(() => f(x)); };
    return i;
  };
  const savIn = file('.sav', false, async ([f]) => openSave(new Uint8Array(await f.arrayBuffer()), f.name));
  const romIn = file('.gb,.gbc', true, async fs => {
    const roms = await Promise.all(fs.map(async f => {
      if (f.size % 0x4000 || f.size > 0x200000) throw new SavError(`${f.name} isn't an LSDj ROM (.gb).`);
      return {name: f.name, rom: new Uint8Array(await f.arrayBuffer())};
    }));
    probeRoms(roms);
    for (const r of roms) if (kitSlots(r.rom).length) await rememberRom(r.rom, r.name);
  });
  const songIn = file('.lsdsng', true, addLsdsng);
  const b = (text, fn, props = {}) => el('button', {type: 'button', textContent: text, onclick: () => guard(fn), ...props});
  root.replaceChildren(
    el('p', {className: 'hint', textContent: 'Which kit samples your songs play, and which songs play each sample; save songs one by one, add, rename or delete them. Works on a .sav file without the FM-1. Nothing is uploaded.'}),
    el('div', {className: 'row'},
      b('Open a .sav…', () => savIn.click()), savIn,
      b('Read songs from the FM-1', async () => { say('Reading songs from the FM-1…'); openSave(await withProgress(hooks.readSave), 'the FM-1'); }),
      b('Add .lsdsng songs…', () => songIn.click(), {id: 'st-add', disabled: true}), songIn,
      b('Download .sav', () => download(state.sav.bytes, 'lsdj.sav'), {id: 'st-download', disabled: true}),
      b('Send to the FM-1', sendOpenSave, {id: 'st-send', disabled: true})),
    el('div', {className: 'row'},
      b('Choose your LSDj (.gb)…', () => romIn.click(), {title: 'Pick one, or several: the one that fits these songs best is used'}), romIn,
      b('Read LSDj from the FM-1', async () => { say('Reading the installed LSDj from the FM-1 (no writes)…'); const rom = await withProgress(hooks.readRom); useRom(rom, 'the LSDj on the FM-1'); await rememberRom(rom, 'LSDj read from the FM-1'); say('Kit names read from the FM-1.', 'ok'); })),
    el('p', {id: 'st-rom', className: 'hint'}),
    el('progress', {id: 'st-progress', value: 0, max: 1, hidden: true}),
    el('p', {id: 'st-status', className: 'hint', role: 'status'}),
    el('div', {id: 'st-report'}),
    el('div', {id: 'st-sets', className: 'sets'}));
  mountSetsUi($('st-sets'));
  document.addEventListener('install-rom', e => { if (e.detail?.rom && !state.romChosen) useRom(e.detail.rom, `the LSDj chosen in Install (${e.detail.name})`, false); });
  draw();
}
