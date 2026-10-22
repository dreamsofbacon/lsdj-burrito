// SPDX-License-Identifier: GPL-3.0-only
// web/lsdj.html: choose ROM -> pick kits -> install; save export/import; restore.
import {requestMidiSession, releaseMidiSession} from '../midi-session.js?v=session1';
import {installFirmware} from '../install-firmware.js?v=fm1current2';
import {restoreOriginal} from '../restore-firmware.js?v=fm1current2';
import {Updater} from '../vendor/fm1ota.js?v=fm1current2';
import {identifyRom, listKits, sparsePack, slotBytes, BANK} from './lsdj-rom.js';
import {loadTemplate, prepareLsdjFirmware} from './lsdj-firmware.js';
import {exportSave, importSave, checkSav} from './lsdj-save.js';

const $ = id => document.getElementById(id);
let rom = null, info = null, kits = [], tpl = null, busy = false;

const log = m => { const p = $('log'); p.textContent += m + '\n'; p.scrollTop = p.scrollHeight; };
const say = (id, text, cls = '') => { const el = $(id); el.textContent = text; el.className = cls; };
const enable = (id, on) => $(id).setAttribute('aria-disabled', on ? 'false' : 'true');

const versions = fetch('lsdj/versions.json', {cache: 'no-store'}).then(r => r.json()).catch(() => []);
const template = loadTemplate().then(t => (tpl = t)).catch(e => { log(e.message); return null; });

function chosen() { return kits.filter(k => $('kit-' + k.bank).checked).map(k => k.bank); }
function update() {
  const ready = !!rom && (info?.tested || $('untested-ok').checked);
  enable('kit-step', !!rom);
  if (!rom) return enable('install-step', false);
  const cap = tpl?.metadata.cartridge_capacity;
  const stored = sparsePack(rom, chosen()).storage.length / BANK, used = slotBytes(stored);
  $('space').max = cap || used; $('space').value = used;
  const fits = !cap || used <= cap;
  say('space-info', cap
    ? `${chosen().length} of ${kits.length} kits · ${(used / 1024).toFixed(0)} of ${(cap / 1024).toFixed(0)} KiB` + (fits ? '' : ' — too many kits, remove some')
    : 'The firmware template is missing, so space can\'t be checked. Run tools/lsdj_template.py first.', fits ? 'hint' : 'bad');
  enable('install-step', ready && fits && !!tpl && !busy);
  $('install').disabled = !(ready && fits && tpl && !busy);
}

$('rom').onchange = async e => {
  rom = null; info = null; kits = []; $('kits').replaceChildren(); $('untested').hidden = true; $('untested-ok').checked = false;
  const file = e.target.files[0]; if (!file) return update();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    info = await identifyRom(bytes, await versions); rom = bytes; kits = listKits(rom);
    say('rom-info', `${info.title} — ${info.tested ? 'tested on FM-1' : 'not tested on FM-1 yet'} · ${kits.length} kits`, info.tested ? 'ok' : 'warn');
    $('untested').hidden = info.tested;
    for (const k of kits) {
      const label = document.createElement('label'), box = document.createElement('input');
      box.type = 'checkbox'; box.id = 'kit-' + k.bank; box.onchange = update;
      label.append(box, k.name || `bank ${k.bank.toString(16)}`); $('kits').append(label);
    }
    await template; fitMost();
  } catch (err) { say('rom-info', err.message, 'bad'); update(); }
};
$('untested-ok').onchange = update;

function fitMost() {
  const cap = tpl?.metadata.cartridge_capacity ?? Infinity, keep = [];
  for (const k of kits) {
    const stored = sparsePack(rom, [...keep, k.bank]).storage.length / BANK;
    $('kit-' + k.bank).checked = slotBytes(stored) <= cap && (keep.push(k.bank), true);
  }
  update();
}
$('kits-all').onclick = fitMost;
$('kits-none').onclick = () => { kits.forEach(k => ($('kit-' + k.bank).checked = false)); update(); };

function confirmGeneric(identity) {
  return Promise.resolve(confirm(`An FM-1 update loader (${identity}) is already running. Continue only if the connected instrument is an FM-1.`));
}
async function midi() {
  if (!window.isSecureContext || !navigator.requestMIDIAccess) throw Error('Open this page in Chrome or Edge on localhost (tools/serve.py).');
  const access = await requestMidiSession();
  if (access.sysexEnabled === false) throw Error('Allow MIDI/SysEx access for this page, then retry.');
  return access;
}
async function run(statusId, fn) {
  if (busy) return; busy = true; update();
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  try { await fn(); }
  catch (e) { say(statusId, e.name === 'NotAllowedError' ? 'MIDI access was blocked. Allow it for this page and retry.' : e.message, 'bad'); log('Error: ' + e.message); }
  finally { await releaseMidiSession(); busy = false; for (const b of document.querySelectorAll('button')) b.disabled = false; update(); }
}

$('install').onclick = () => run('install-status', async () => {
  say('install-status', 'Preparing firmware with your LSDj…');
  const prepared = await prepareLsdjFirmware(rom, chosen(), tpl.template, tpl.metadata);
  log(`Prepared ${prepared.product}: ${prepared.stored} banks, ${prepared.kept} kits, sha256 ${prepared.sha256}`);
  say('install-status', 'Allow MIDI access, then keep the FM-1 connected…');
  const product = await installFirmware(await midi(), prepared.install, m => { log(m); say('install-status', m); }, {confirmGeneric});
  say('install-status', `Installed (${product}). LSDj starts on the FM-1.`, 'ok');
});

// The running LSDj firmware identifies as the template's product.
async function lsdjLink() {
  const access = await midi(), product = tpl?.metadata.product;
  const dev = await new Updater(access, log).findAny(id => id.model === 'FM-1' && (!product || id.text === product));
  if (!dev) throw Error('No FM-1 running the LSDj firmware found. Check the USB data cable and close other MIDI apps.');
  return dev;
}
function progress(id) { const p = $(id); p.hidden = false; p.value = 0; return (n, total) => { p.max = total; p.value = n; }; }

$('export').onclick = () => run('save-status', async () => {
  const dev = await lsdjLink();
  try {
    say('save-status', 'Reading songs from the FM-1…');
    const bytes = await exportSave(dev.link, progress('save-progress'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], {type: 'application/octet-stream'})); a.download = 'lsdj.sav'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    say('save-status', 'Exported lsdj.sav.', 'ok');
  } finally { await dev.link.close(); }
});

$('import-pick').onclick = () => $('import').click();
$('import').onchange = e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  run('save-status', async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    checkSav(bytes);
    if (!confirm(`Replace the songs on the FM-1 with ${file.name}? Export first if you want to keep them.`)) return say('save-status', 'Import cancelled.');
    const dev = await lsdjLink();
    try {
      say('save-status', 'Sending songs to the FM-1…');
      await importSave(dev.link, bytes, progress('save-progress'));
      say('save-status', `Imported ${file.name}. LSDj restarted with it.`, 'ok');
    } finally { await dev.link.close(); }
  });
};

// The user brings M-VAVE's V15 file; restoreOriginal() verifies it before any MIDI access.
$('restore').onclick = () => $('restore-file').click();
$('restore-file').onchange = e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  if (!confirm('Restore the official FM-1 V15 firmware? LSDj will be removed; export your songs first.')) return;
  run('restore-status', async () => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const product = await restoreOriginal(await midi(), bytes, m => { log(m); say('restore-status', m); }, {confirmGeneric});
    say('restore-status', `Restored (${product}).`, 'ok');
  });
};

template.then(() => update());
