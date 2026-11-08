// SPDX-License-Identifier: GPL-3.0-only
// The user's LSDj files (.gb) and .kit files, remembered in this browser (IndexedDB) so song sets can use their
// kits without picking the files again. On this computer only: never uploaded, never in the offline copy
// (sw.js). Each file is kept once (by SHA-256). Without storage (a private window), it lasts for the visit.
// Changes are announced with a 'kit-library' event.
const DB = 'burrito-kits', STORE = 'files';
let memory = new Map(), db = null, ready = null;

function open() {
  if (ready) return ready;
  ready = new Promise(resolve => {
    /* storage that never answers (blocked, or a test browser) leaves the library in memory for this visit */
    const late = setTimeout(resolve, 5000);
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, {keyPath: 'id'});
      req.onsuccess = () => { clearTimeout(late); db = req.result; resolve(); };
      req.onerror = () => { clearTimeout(late); resolve(); };
    } catch { clearTimeout(late); resolve(); }
  }).then(async () => {
    if (!db) return;
    const all = await tx('readonly', s => s.getAll()).catch(() => []);
    for (const f of all) memory.set(f.id, f);
  });
  return ready;
}
function tx(mode, f) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode), r = f(t.objectStore(STORE));
    t.oncomplete = () => resolve(r?.result); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
}
const announce = () => document.dispatchEvent(new CustomEvent('kit-library'));
const hashOf = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

/* [{id, kind: 'rom' | 'kit', name, bytes, added}], oldest first */
export async function libraryFiles() {
  await open();
  return [...memory.values()].sort((a, b) => a.added - b.added);
}
/* adds a file (kept once) -> its entry */
export async function addToLibrary(kind, name, bytes) {
  await open();
  const id = await hashOf(bytes);
  if (memory.has(id)) return memory.get(id);
  const entry = {id, kind, name, bytes: bytes.slice(), added: Date.now()};
  memory.set(id, entry);
  if (db) await tx('readwrite', s => s.put(entry)).catch(() => {});
  announce();
  return entry;
}
export async function removeFromLibrary(id) {
  await open();
  memory.delete(id);
  if (db) await tx('readwrite', s => s.delete(id)).catch(() => {});
  announce();
}
export async function clearLibrary() {
  await open();
  memory = new Map();
  if (db) await tx('readwrite', s => s.clear()).catch(() => {});
  announce();
}
export {hashOf};
