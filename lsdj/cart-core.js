// SPDX-License-Identifier: GPL-3.0-only
// The crate's cart maker, without the page: songs from .sav / .lsdsng / .lsdprj files and LSDj ROMs / .kit files in;
// each song matched to the kits it plays (lsdj-sets.js resolveSongs: the LSDj it was made with, or a project's own
// kits); carts planned (every sample in as many carts as it takes, or one cart with the most-played kits) and built
// (an LSDj holding only the kits and samples the songs play, and a .sav). Pure: runs in a worker (cart-worker.js),
// so the DJ decks never wait for it, and in node (tests/cart.mjs). The user's files are never changed.
import {parseSav, songBytes, readLsdsng, readLsdprj, savBody, SAV_SIZE, SavError} from './lsdj-sav.js';
import {kitSlots, parseKit, isKitBank, BANK} from './lsdj-kit.js';
import {validateRom} from './lsdj-rom.js';
import * as S from './lsdj-sets.js';

const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
const sha = async b => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(x => x.toString(16).padStart(2, '0')).join('');

/* songs: [{id, group, from, name, nameBytes, version, song}]; roms / kitFiles as resolveSongs takes them (library: from
   this browser's LSDj files; files: dropped here); picks: the kit picks a project's own kits make; template: the first
   .sav's bytes (its LSDj settings go into the carts) */
export const newState = () => ({songs: [], libRoms: [], fileRoms: [], kitFiles: [], picks: {}, rules: {}, template: null, built: new Set(), seq: 0});
const roms = st => { const m = new Map(); for (const r of [...st.libRoms, ...st.fileRoms]) if (!st.built.has(r.id)) m.set(r.id, r); return [...m.values()]; };
const romEntry = (id, name, rom) => ({id, name, rom, slots: kitSlots(rom), version: S.lsdjVersion(rom)});

/* this browser's LSDj and .kit files ([{id, kind, name, bytes}]); built: the ids of carts made here (not sources) */
export function setLibrary(st, files, built = []) {
  st.built = new Set(built);
  st.libRoms = files.filter(f => f.kind === 'rom').map(f => { try { return romEntry(f.id, f.name, f.bytes); } catch { return null; } }).filter(r => r?.slots.length);
  st.kitFiles = [...st.kitFiles.filter(k => k.project), ...files.filter(f => f.kind === 'kit' && isKitBank(f.bytes)).map(f => ({id: f.id, name: f.name, bank: f.bytes.subarray(0, BANK)}))];
}

/* files dropped in: [{name, bytes}] -> {songs, roms: [{id, name, bytes}] (to keep in the library), kits (same), skipped:
   [{name, why}]} */
export async function addFiles(st, files) {
  const out = {songs: 0, roms: [], kits: [], skipped: []};
  for (const {name, bytes} of files) {
    const ext = (/\.[^.]+$/.exec(name)?.[0] ?? '').toLowerCase(), group = `f${st.seq++}`;
    const add = s => { st.songs.push({id: `${group}:${st.songs.length}`, group, from: name, ...s}); out.songs++; };
    try {
      if (ext === '.lsdprj') {
        const p = readLsdprj(bytes), id = `${group}:${st.songs.length}`;
        add({name: p.name, nameBytes: p.nameBytes, version: p.version, song: p.song});
        const {map, rule} = S.projectKits(p.song, p.kits);
        p.kits.forEach((bank, i) => st.kitFiles.push({id: `${group}k${i}`, name: `${name} kit ${i + 1}`, bank, project: true}));
        for (const [n, i] of map) st.picks[`${id}:${n}`] = `kit:${group}k${i}`;
        st.rules[id] = rule;
      } else if (ext === '.lsdsng') {
        const s = readLsdsng(bytes); add({name: s.name, nameBytes: s.nameBytes, version: s.version, song: s.song});
      } else if (ext === '.sav' || savBody(bytes).length === SAV_SIZE) {
        const sav = parseSav(bytes.slice());
        st.template ??= sav.bytes;
        for (const s of sav.songs) {
          try { add({slot: s.slot, name: s.name, nameBytes: sav.bytes.slice(0x8000 + s.slot * 8, 0x8008 + s.slot * 8), version: s.version, song: songBytes(sav, s.slot)}); }
          catch (e) { if (!(e instanceof SavError)) throw e; out.skipped.push({name: `${name} ${s.name}`, why: e.message}); }
        }
      } else if (ext === '.kit' || (bytes.length === BANK && isKitBank(bytes))) {
        if (!isKitBank(bytes)) throw new SavError('not an LSDj .kit file');
        const id = await sha(bytes.subarray(0, BANK));
        st.kitFiles.push({id, name, bank: bytes.slice(0, BANK)}); out.kits.push({id, name, bytes: bytes.slice(0, BANK)});
      } else if (['.gb', '.gbc'].includes(ext)) {
        validateRom(bytes);
        const r = romEntry(await sha(bytes), name, bytes);
        if (!r.slots.length) throw new SavError('an LSDj with no kit slots');
        st.fileRoms.push(r); out.roms.push({id: r.id, name, bytes});
      } else out.skipped.push({name, why: 'not a song, project, save, LSDj or kit'});
    } catch (e) { out.skipped.push({name, why: e.message}); }
  }
  return out;
}

/* what the panel shows. req: {ticked: [ids] | null (all), choices: {madeWith, kitPick}, baseId, plan: 'split' | 'most'}
   -> {songs: [{id, name, from, blocks, made, madeAuto, kits: [{number, name, source, missing}], rule, status}],
       roms: [{id, name, version, kits}], baseId, plans: [{songs, kits, kib, blocks, over, lost}], capacity} */
export function view(st, req, capacity) {
  const list = roms(st), choices = {madeWith: req.choices?.madeWith ?? {}, kitPick: {...st.picks, ...(req.choices?.kitPick ?? {})}};
  const resolved = S.resolveSongs(st.songs, list, st.kitFiles, choices);
  const byId = new Map(st.songs.map(x => [x.id, x]));
  for (const r of resolved) { const s = byId.get(r.id); r.blocks = s.blocks ??= S.blocksOf(r.song); }
  const newest = [...list].sort((a, b) => S.compareVersions(b.version ?? [0], a.version ?? [0]))[0];
  const baseId = list.some(r => r.id === req.baseId) ? req.baseId : newest?.id ?? null;
  const songs = resolved.map(r => {
    const rule = st.rules[r.id] ?? null;
    const silent = n => choices.kitPick[`${r.id}:${n}`] === 'none';   /* (left silent on purpose: not missing) */
    const status = r.missing.some(n => !silent(n)) ? 'missing' : rule === 'guess' ? 'check' : 'ok';
    return {id: r.id, name: r.name, from: byId.get(r.id).from, blocks: r.blocks, made: r.rom?.id ?? null, madeAuto: r.auto, rule, status,
      kits: r.kits.map(k => ({number: k.number, name: k.name, source: k.source?.label ?? null, missing: !k.bank && !silent(k.number), silent: silent(k.number), samples: k.samples.size}))};
  });
  const out = {songs, roms: list.map(r => ({id: r.id, name: r.name, version: S.versionText(r.version), kits: r.slots.filter(s => !s.empty).length,
      slots: r.slots.filter(s => !s.empty).map(s => ({number: s.number, name: s.kit.name}))})),
    kitFiles: st.kitFiles.filter(k => !k.project).map(k => ({id: k.id, name: k.name})), baseId, plans: [], capacity};
  const ticked = req.ticked ? new Set(req.ticked) : null, picked = resolved.filter(r => !ticked || ticked.has(r.id));
  const base = list.find(r => r.id === baseId);
  if (!base || !picked.length) return out;
  const ctx = S.setContext(base.rom, capacity);
  const plans = req.plan === 'most' ? [S.planMost(picked, ctx)] : S.planSplit(picked, ctx);
  st.last = {plans, ctx};
  out.plans = plans.map(p => ({songs: p.entries.map(e => e.name), kits: p.kits.size, kib: Math.ceil(p.bytes / 1024), blocks: p.blocks,
    over: !!p.over, lost: (p.lost ?? []).map(l => `${l.song}: kit ${hex(l.kit)}`), leftOut: (p.leftOut ?? []).map(e => e.name)}));
  return out;
}

/* the carts of the last view: [{rom, sav, report, songs, kits, kib, fits, warnings}] */
export function build(st, titles = []) {
  const {plans, ctx} = st.last ?? {};
  if (!plans?.length) throw new SavError('Nothing to build: tick some songs and choose an LSDj to build with.');
  return plans.map((p, i) => {
    const b = S.buildSet(p, ctx, st.template), title = titles[i] ?? `Cart ${i + 1}`;
    return {title, rom: b.rom, sav: b.sav, report: S.setReport(b, title, ctx), songs: b.songs.map(s => s.name), kits: b.kits.length,
      kib: Math.ceil(b.plan.needed / 1024), fits: b.plan.fits, warnings: b.warnings};
  });
}
