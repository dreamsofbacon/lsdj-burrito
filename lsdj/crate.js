// SPDX-License-Identifier: GPL-3.0-only
// The DJ crate: things to load onto a deck's FM-1 (lsdj/crate-ui.js). An item holds a .sav, an LSDj ROM (all its
// kits), or both: the ROM is installed first, then the .sav sent. The list is kept in this browser (localStorage
// 'dj-crate'); the files themselves in its file library (kit-library.js: ROMs as 'rom', shared with Sets, and saves
// as 'sav'), each once. Never uploaded, never in the offline copy.
import {parseSav, SAV_SIZE} from './lsdj-sav.js';
import {validateRom} from './lsdj-rom.js';
import {lsdjVersion, versionText} from './lsdj-sets.js';

export const KEY = 'dj-crate';

/* a file's kind from its bytes: 'sav' | 'rom' | null */
export function fileKind(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  if (bytes.length === SAV_SIZE) { try { parseSav(bytes); return 'sav'; } catch { return null; } }
  try { validateRom(bytes); return 'rom'; } catch { return null; }
}

const idOk = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
/* the stored list (JSON text) -> items {id, name, rom, sav, added}; anything broken is left out */
export function loadItems(text) {
  let list;
  try { list = JSON.parse(text || '[]'); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.filter(i => i && typeof i.id === 'string' && (idOk(i.rom) || idOk(i.sav)))
    .map(i => ({id: i.id, name: String(i.name || 'Untitled').slice(0, 60), rom: idOk(i.rom) ? i.rom : null,
      sav: idOk(i.sav) ? i.sav : null, added: +i.added || 0}));
}
export const saveItems = items => JSON.stringify(items.map(({id, name, rom, sav, added}) => ({id, name, rom, sav, added})));

let seq = 0;
const newId = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;
/* a new item at the end; rom / sav: library ids. The same pair twice is kept once. */
export function addItem(items, {name, rom = null, sav = null}) {
  if (!rom && !sav) return items;
  if (items.some(i => i.rom === rom && i.sav === sav)) return items;
  return [...items, {id: newId(), name: String(name || 'Untitled').slice(0, 60), rom, sav, added: Date.now()}];
}
export const removeItem = (items, id) => items.filter(i => i.id !== id);
export const renameItem = (items, id, name) => items.map(i => i.id === id ? {...i, name: String(name || i.name).slice(0, 60)} : i);
/* a ROM-only item and a .sav-only item become one pair (in the first one's place) */
export function pairItems(items, a, b) {
  const x = items.find(i => i.id === a), y = items.find(i => i.id === b);
  if (!x || !y || x === y) return items;
  const rom = x.rom || y.rom, sav = x.sav || y.sav;
  if (!rom || !sav || (x.rom && y.rom) || (x.sav && y.sav)) return items;
  const name = x.rom ? `${y.name} on ${x.name}` : `${x.name} on ${y.name}`;
  return items.filter(i => i !== y).map(i => i === x ? {...i, name: name.slice(0, 60), rom, sav} : i);
}
/* library ids no item uses any more (only saves are removed: ROMs are shared with Sets) */
export const unusedSaves = (items, before) => [...new Set(before.map(i => i.sav).filter(Boolean))].filter(s => !items.some(i => i.sav === s));

/* a card's text: {kinds, songs: [names], open, version, missing} from the library's bytes (by id) */
export function describe(item, bytesOf) {
  const out = {kinds: [item.rom && 'LSDj', item.sav && '.sav'].filter(Boolean), songs: [], open: null, version: null, missing: false};
  if (item.sav) {
    const b = bytesOf(item.sav);
    if (!b) out.missing = true;
    else try { const s = parseSav(b); out.songs = s.songs.map(x => x.name || '(no name)'); out.open = s.active; } catch { out.missing = true; }
  }
  if (item.rom) {
    const b = bytesOf(item.rom);
    if (!b) out.missing = true; else out.version = versionText(lsdjVersion(b));
  }
  return out;
}
