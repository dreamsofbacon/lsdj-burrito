// SPDX-License-Identifier: GPL-3.0-only
// The DJ crate (Perform › DJ, under the decks): saves and LSDj ROMs to load onto one deck's FM-1 while the other
// deck plays on. A .sav goes over that FM-1's link (only it pauses, as Songs › Send does). An LSDj is installed on
// that FM-1 alone (install.js installOn: nothing is sent to the other FM-1s, the other decks' gear or the mixer),
// then a paired .sav follows. lsdj/crate.js holds the list; the files stay in this browser (kit-library.js).
import {KEY, fileKind, loadItems, saveItems, addItem, removeItem, renameItem, pairItems, unusedSaves, describe} from './crate.js';
import {libraryFiles, addToLibrary, removeFromLibrary} from './kit-library.js';
import {listKits} from './lsdj-rom.js';
import {loadTemplate, prepareLsdjFirmware} from './lsdj-firmware.js';
import {installOn, checkPackage} from './install.js';
import {installing, setInstallTarget} from './install-ui.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const btn = (text, onclick, props = {}) => el('button', {type: 'button', textContent: text, onclick, ...props});
const store = {get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* this visit */ } }};

/* app.js: access() -> MIDIAccess, ports(key) -> {input, output} port ids, otherPorts(key) -> every other FM-1's port
   ids, release(key) (the page lets go of that FM-1), rescan() -> [{key, title}] the FM-1s found, readSave(key, pr),
   readRom(key, pr), sendSave(key, bytes, name, pr), info(key) -> the link's INFO, volumeFull(key).
   dj-ui.js: decks() -> [{i, name, kind, key}], stop(i) (its clock, Play, Sync), assign(i, key), avoid(i) -> the
   other decks' and the mixer's port ids, loading(i, text | null, done, total). */
let app = {}, dj = {};
export function setCrateHooks(a, d) { app = {...app, ...a}; dj = {...dj, ...d}; }

let items = loadItems(store.get(KEY, '[]')), files = new Map(), root = null, statusEl = null, busyDeck = -1, pairFrom = null;
const save = () => store.set(KEY, saveItems(items));
const say = (text, cls = 'hint') => { if (statusEl) { statusEl.textContent = text; statusEl.className = `${cls} crate-status`; } };
async function refreshFiles() { files = new Map((await libraryFiles()).map(f => [f.id, f])); }
const bytesOf = id => files.get(id)?.bytes || null;

/* a ROM and/or a save (bytes) -> a crate item; used by Songs & kits and Sets too */
export async function addToCrate({name, rom = null, sav = null}) {
  const r = rom ? await addToLibrary('rom', `${name}.gb`, rom) : null;
  const s = sav ? await addToLibrary('sav', `${name}.sav`, sav) : null;
  items = addItem(items, {name, rom: r?.id || null, sav: s?.id || null});
  save(); await refreshFiles(); draw();
}

async function openFiles(list) {
  for (const f of list) {
    const bytes = new Uint8Array(await f.arrayBuffer()), kind = fileKind(bytes), name = f.name.replace(/\.(sav|gbc?)$/i, '');
    if (!kind) { say(`${f.name} is neither an LSDj save nor an LSDj ROM.`, 'warn'); continue; }
    await addToCrate({name, [kind]: bytes});
  }
}

const fm1Decks = () => (dj.decks?.() || []).filter(d => d.kind === 'fm1' && d.key != null);
async function grab(d, withRom) {
  if (busyDeck >= 0) return;
  busyDeck = d.i; draw();
  try {
    const sav = await app.readSave(d.key, (n, t) => dj.loading?.(d.i, 'Copying its songs…', n, t));
    const rom = withRom ? await app.readRom(d.key, (n, t) => dj.loading?.(d.i, 'Copying its LSDj…', n, t)) : null;
    const title = (await app.info?.(d.key).catch(() => null))?.title;
    await addToCrate({name: `Deck ${d.name}${title ? ` ${title}` : ''} ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`, rom, sav});
    say(`Deck ${d.name}'s ${withRom ? 'LSDj and songs are' : 'songs are'} in the crate.`, 'ok');
  } catch (e) { say(`Deck ${d.name}: ${e.message}`, 'bad'); }
  finally { busyDeck = -1; dj.loading?.(d.i, null); draw(); }
}

/* the firmware for a crate ROM, with all its kits (as Install starts) */
async function prepare(rom) {
  const r = await fetch('lsdj/versions.json', {cache: 'no-store', signal: AbortSignal.timeout(20000)});
  if (!r.ok) throw Error(`Version catalogue unavailable (${r.status}).`);
  const versions = await r.json(), {template, metadata} = await loadTemplate();
  try {
    return await prepareLsdjFirmware(rom, listKits(rom).map(k => k.bank), template, metadata, {versions, experimental: true});
  } catch (e) {
    if (/only \d+ are available/.test(e.message)) throw Error('This LSDj with all its kits is too big for the FM-1. Prepare it in Install, leaving some kits out.');
    throw e;
  }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

/* item -> deck i: one FM-1 stops and takes it; the other deck carries on */
export async function loadOnto(id, i) {
  const item = items.find(x => x.id === id), d = (dj.decks?.() || [])[i];
  if (!item || !d) return;
  if (d.kind !== 'fm1' || d.key == null) return say(`Deck ${d.name}: choose an FM-1 for it first.`, 'warn');
  if (busyDeck >= 0 || installing()) return say('Another FM-1 is loading. Wait for it to finish.', 'warn');
  await refreshFiles();
  const rom = item.rom && bytesOf(item.rom), sav = item.sav && bytesOf(item.sav);
  if ((item.rom && !rom) || (item.sav && !sav)) return say(`${item.name}: its file is no longer in this browser. Add it again.`, 'bad');
  const what = rom ? `install this LSDj on deck ${d.name}'s FM-1 (about a minute; it restarts)${sav ? ', then replace its songs' : ''}`
    : `replace deck ${d.name}'s songs`;
  if (!confirm(`Load "${item.name}": ${what}?\n\nDeck ${d.name} stops; the other deck keeps playing. ` +
    (rom ? 'This firmware is experimental and may not start or sound right. Keep the cable in and this tab open until it says done. ' : '') +
    'Back up its songs first (Grab) if you want to keep them.')) return;
  busyDeck = i; draw();
  const show = (text, n, t) => { dj.loading?.(i, text, n, t); say(`Deck ${d.name}: ${text}`, 'hint'); };
  const leave = e => { e.preventDefault(); e.returnValue = ''; };
  let wake = null;
  try {
    if (!rom) {
      dj.stop?.(i);
      show('Sending the songs…');
      await app.sendSave(d.key, sav, item.name, (n, t) => show('Sending the songs…', n, t));
      say(`Deck ${d.name} has "${item.name}".`, 'ok');
      return;
    }
    show('Preparing the firmware…');
    const pkg = await prepare(rom);
    const target = app.ports(d.key);
    if (!target) throw Error('That FM-1 went away. Nothing was installed.');
    const avoid = [...app.otherPorts(d.key), ...(dj.avoid?.(i) || [])];
    const others = new Set((await app.rescan()).map(x => x.key).filter(k => k !== d.key));
    await app.volumeFull?.(d.key);   /* it comes back at full volume whatever happens */
    dj.stop?.(i); dj.assign?.(i, '');
    app.release(d.key);
    addEventListener('beforeunload', leave);
    try { wake = await navigator.wakeLock?.request('screen'); } catch { wake = null; }
    setInstallTarget(d.key);
    const names = {found: 'Found its FM-1', stage: 'Preparing the update (nothing changed yet)', loader: 'Restarting into update mode',
      write: 'Writing the firmware: keep the cable in', restart: 'Written. Restarting', done: 'Installed'};
    const r = await installOn(app.access(), checkPackage(pkg.bytes), {target, avoid, onStep: s => show(`${names[s]}…`), onProgress: (n, t) => show(names.write + '…', n, t)});
    setInstallTarget(null);
    /* the restarted FM-1: the one found now that wasn't there before */
    await wait(1500);
    const fresh = (await app.rescan()).filter(x => !others.has(x.key));
    const back = r.confirmed && fresh.length === 1 ? fresh[0] : null;
    if (!back) {
      say(`Installed ${r.id}, but the page can't tell which FM-1 restarted${r.confirmed ? '' : ' (another FM-1 was unplugged meanwhile)'}. ` +
        `Choose it for deck ${d.name}${sav ? ', then load the songs' : ''}.`, 'warn');
      return;
    }
    dj.assign?.(i, back.key);
    if (sav) {
      show('Sending the songs…');
      await app.sendSave(back.key, sav, item.name, (n, t) => show('Sending the songs…', n, t));
    }
    say(`Deck ${d.name} has "${item.name}" (${r.id}).`, 'ok');
  } catch (e) {
    setInstallTarget(null);
    say(`Deck ${d.name}: ${e.message}`, e.resumable ? 'warn' : 'bad');
  } finally {
    removeEventListener('beforeunload', leave);
    try { await wake?.release(); } catch { /* gone */ }
    busyDeck = -1; dj.loading?.(i, null); draw();
    document.dispatchEvent(new Event('firmware-install-state'));
  }
}

/* drag a card onto a deck (dj-ui.js calls this from the deck's drop) */
export const CRATE_TYPE = 'application/x-burrito-crate';
export function dropOnDeck(e, i) {
  const id = e.dataTransfer?.getData(CRATE_TYPE);
  if (!id) return false;
  e.preventDefault();
  void loadOnto(id, i);
  return true;
}

function card(item) {
  const t = describe(item, bytesOf), decks = fm1Decks();
  const name = el('input', {type: 'text', value: item.name, className: 'crate-name', maxLength: 60,
    onchange: () => { items = renameItem(items, item.id, name.value.trim()); save(); }});
  name.setAttribute('aria-label', 'Name');
  const songs = t.missing ? 'Its file is no longer in this browser.' : t.songs.length ? t.songs.join(', ') : item.sav ? 'No songs saved' : '';
  const canPair = pairFrom && pairFrom !== item.id && (() => { const o = items.find(x => x.id === pairFrom); return o && !!o.rom !== !!item.rom && !!o.sav !== !!item.sav; })();
  const c = el('div', {className: `crate-card${pairFrom === item.id ? ' pairing' : ''}`, draggable: true,
    ondragstart: e => { e.dataTransfer.setData(CRATE_TYPE, item.id); e.dataTransfer.effectAllowed = 'copy'; }},
    el('div', {className: 'crate-kinds'}, ...t.kinds.map(k => el('span', {className: 'crate-kind', textContent: k})),
      t.version ? el('span', {className: 'hint', textContent: ` LSDj ${t.version}`}) : null),
    name,
    el('p', {className: 'hint crate-songs', textContent: songs, title: songs}),
    el('div', {className: 'crate-acts'},
      ...decks.map(d => btn(`Load ${d.name}`, () => void loadOnto(item.id, d.i), {disabled: busyDeck >= 0 || t.missing,
        title: `${item.rom ? 'Install this LSDj on' : 'Send these songs to'} deck ${d.name}'s FM-1; the other deck keeps playing`})),
      canPair ? btn('Pair here', () => { items = pairItems(items, pairFrom, item.id); pairFrom = null; save(); draw(); }, {className: 'on'})
        : !(item.rom && item.sav) ? btn(pairFrom === item.id ? 'Cancel' : 'Pair', () => { pairFrom = pairFrom === item.id ? null : item.id; draw(); },
          {title: item.rom ? 'Pair this LSDj with a .sav: then press Pair here on the .sav' : 'Pair this .sav with an LSDj: then press Pair here on the LSDj'}) : null,
      btn('✕', async () => {
        if (!confirm(`Take "${item.name}" out of the crate?`)) return;
        const before = items; items = removeItem(items, item.id); save();
        for (const s of unusedSaves(items, before)) await removeFromLibrary(s);
        await refreshFiles(); draw();
      }, {title: 'Take it out of the crate', ariaLabel: `Remove ${item.name}`})));
  return c;
}

function draw() {
  if (!root) return;
  const decks = fm1Decks();
  const pick = el('input', {type: 'file', accept: '.sav,.gb,.gbc', multiple: true, hidden: true,
    onchange: async () => { await openFiles([...pick.files]); pick.value = ''; }});
  const withRom = el('input', {type: 'checkbox', checked: store.get('dj-crate-rom', '0') === '1',
    onchange: () => store.set('dj-crate-rom', withRom.checked ? '1' : '0')});
  root.replaceChildren(
    el('div', {className: 'crate-top'},
      el('strong', {textContent: 'Crate'}),
      btn('Open files…', () => pick.click(), {title: 'An LSDj save (.sav) or LSDj ROM (.gb): kept in this browser only'}), pick,
      ...decks.map(d => btn(`Grab ${d.name}`, () => void grab(d, withRom.checked), {disabled: busyDeck >= 0,
        title: `Put deck ${d.name}'s songs${withRom.checked ? ' and LSDj' : ''} in the crate (a copy; the FM-1 keeps playing)`})),
      decks.length ? el('label', {className: 'hint'}, withRom, ' with its LSDj') : null),
    /* (no scrollbar: a swipe, or the mouse wheel, moves the cards sideways) */
    items.length ? el('div', {className: 'crate-list', onwheel: e => {
      const l = e.currentTarget;
      if (l.scrollWidth > l.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { l.scrollLeft += e.deltaY; e.preventDefault(); }
    }}, ...items.map(card))
      : el('p', {className: 'hint', textContent: 'Empty. Open a .sav or LSDj ROM, grab a deck\'s songs, or use "Add to crate" in Songs & kits or Sets. Then drag a card onto a deck, or press Load.'}),
    statusEl = el('p', {className: 'hint crate-status', role: 'status', textContent: statusEl?.textContent || ''}));
}

export async function mountCrate(box) {
  root = box;
  await refreshFiles();
  draw();
  document.addEventListener('kit-library', () => void refreshFiles().then(draw));
}
export const crateRedraw = () => draw();
