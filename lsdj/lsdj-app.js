// SPDX-License-Identifier: GPL-3.0-only
import {validateRom, identifyRom, listKits, planRom, romFromSlot, BANK, SLOT_MAX_BANKS} from './lsdj-rom.js';
import {loadTemplate, prepareLsdjFirmware} from './lsdj-firmware.js';
import {selectFirmware, installing, clearPreparedFirmware, setPreparingFirmware} from './install-ui.js';

const $ = id => document.getElementById(id);
const say = (text, cls = '') => { $('rom-info').textContent = text; $('rom-info').className = cls; };
let rom = null, template = null, metadata = null, versions = [], generation = 0, busy = false;
let loading = false, currentPlan = null;
let downloadUrl = null;
let reading = null, fromDevice = false;
const selected = () => [...$('rom-kits').querySelectorAll('input:checked')].map(el => Number(el.value));

function clearDownload() {
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    say('ROM options changed. Prepare the firmware again.', 'warn');
  }
  downloadUrl = null;
  $('rom-actions').hidden = true;
  $('rom-download').hidden = true;
  $('rom-download').removeAttribute('href');
  $('rom-download').removeAttribute('download');
}
function updatePlan() {
  clearDownload();
  clearPreparedFirmware();
  currentPlan = null;
  if (!rom || !metadata) return updateControls();
  try {
    const p = planRom(rom, selected(), metadata.cartridge_capacity);
    currentPlan = p;
    const excess = Math.max(0, Math.ceil((p.needed - p.capacity) / BANK));
    const cannotFit = excess > p.kept;
    $('rom-budget').textContent = `Uses ${Math.ceil(p.needed / 1024)} of ${Math.floor(p.capacity / 1024)} KiB ` +
      `(${p.codeBanks} program banks + ${p.kept} kit banks). ` +
      (p.omitted.length ? `Omitted banks: ${p.omitted.map(k => k.bank.toString(16).toUpperCase().padStart(2, '0')).join(', ')}: songs using these kits lose those samples. ` : '') +
      (p.fits ? 'Fits.' : fromDevice ? 'The installed LSDj does not fit this update. Nothing will be dropped; choose your original ROM file to pick a different set of kits.' :
        cannotFit ? 'The required program/data alone exceeds this template. Removing kits cannot make this ROM fit. Choose a smaller compatible ROM.' :
        `Deselect at least ${excess} kit ${excess === 1 ? 'bank' : 'banks'} to fit. No kits are removed automatically.`);
    $('rom-budget').className = p.fits ? 'hint' : 'warn';
  } catch (err) { say(err.message, 'bad'); }
  updateControls();
}
$('rom-experimental').onchange = updatePlan;
$('rom-kits').onchange = updatePlan;
function updateControls() {
  const blocked = busy || installing() || !!reading;
  $('rom').disabled = blocked;
  $('rom-device').disabled = blocked;
  $('rom-cancel').hidden = !reading;
  $('rom-experimental').disabled = blocked || loading || !currentPlan;
  $('rom-kits').disabled = blocked || loading || !currentPlan || fromDevice;
  $('rom-build').disabled = blocked || loading || !currentPlan?.fits || !$('rom-experimental').checked;
  $('rom-step').setAttribute('aria-busy', String(loading || busy));
  $('rom-next').textContent = installing() ? 'Wait for the current installation to finish.' :
    reading ? 'Reading LSDj from the FM-1. Nothing is written to it; you can cancel safely.' :
    busy ? 'Preparing and checking the firmware…' :
    loading ? 'Checking your ROM…' :
    !rom ? 'Step 1: choose your LSDj .gb file, or read it from your FM-1.' :
    !currentPlan ? 'Step 1: fix the problem below, then choose the file again.' :
    !currentPlan.fits ? 'Step 2: untick kits until everything fits.' :
    downloadUrl ? 'Step 4: install it, download it, or try it in the virtual FM-1 first.' :
    !$('rom-experimental').checked ? 'Step 3: back up your songs, then tick the box to prepare.' :
    'Step 3: ready to prepare. Nothing is installed yet.';
  // lsdj/ui.js moves through the install steps from this
  document.dispatchEvent(new CustomEvent('rom-state', {detail: {ready: !!currentPlan, fits: !!currentPlan?.fits,
    prepared: !!downloadUrl, working: busy || loading || !!reading}}));
}
document.addEventListener('firmware-install-state', updateControls);
async function chooseRom(file, device = false) {
  const seq = ++generation;
  fromDevice = device;
  rom = template = metadata = null;
  loading = !!file;
  const legend = document.createElement('legend');
  legend.textContent = 'Sample kits (all selected initially)';
  $('rom-kits').replaceChildren(legend); $('rom-budget').textContent = '';
  $('rom-experimental').checked = false;
  updatePlan();
  if (!file) return say('');
  try {
    if (file.size > BANK * SLOT_MAX_BANKS) throw Error('ROM is larger than the supported 2 MiB limit.');
    say(device ? 'Reading installed LSDj from the FM-1. No writes or uploads...' : 'Checking ROM and loading the ROM-free template...');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (seq !== generation) return;
    if (device && reading.signal.aborted) throw Error('Cartridge read cancelled.');
    validateRom(bytes);
    const response = await fetch('lsdj/versions.json', {cache: 'no-store', signal: AbortSignal.timeout(20000)});
    if (!response.ok) throw Error(`Version catalogue unavailable (${response.status}).`);
    const catalog = await response.json();
    if (!Array.isArray(catalog) || catalog.some(v => !v || typeof v !== 'object'))
      throw Error('Invalid version catalogue. Reload the page or choose the file again to retry.');
    const info = await identifyRom(bytes, catalog);
    if (seq !== generation) return;
    const loaded = await loadTemplate();
    if (seq !== generation) return;
    if (device && reading.signal.aborted) throw Error('Cartridge read cancelled.');
    const kits = listKits(bytes);
    planRom(bytes, kits.map(k => k.bank), loaded.metadata.cartridge_capacity);
    rom = bytes; versions = catalog; ({template, metadata} = loaded);
    say(`${file.name} (${info.title}): ${info.tested ? 'a tested LSDj build' :
      info.sameProgram ? 'a tested LSDj program with different samples' : 'an untested LSDj build'}. ` +
      (info.cursorProfile ? 'Effects follow the cursor. ' :
        'Cursor-following FX unavailable for this program: FX targets ALL channels. ') +
      (device ? 'All installed kits are kept. ' : '') +
      (!info.globalChecksumValid ? 'Its checksum is out of date; the firmware gets a corrected one. ' : ''),
      info.cursorProfile ? 'ok' : 'warn');
    for (const kit of kits) {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.value = String(kit.bank); input.checked = true;
      label.append(input, ` Bank ${kit.bank.toString(16).toUpperCase().padStart(2, '0')}: ${kit.name || '(unnamed kit)'}`);
      $('rom-kits').append(label, document.createElement('br'));
    }
    if (!kits.length) {
      const note = document.createElement('p');
      note.textContent = 'No sample-kit banks were recognized. All required program/data banks are preserved.';
      $('rom-kits').append(note);
    }
    updatePlan();
  } catch (err) {
    if (seq === generation) {
      rom = template = metadata = currentPlan = null;
      $('rom').value = '';
      say(err.name === 'TimeoutError' ? 'ROM checking timed out. Choose the same file again to retry.' :
        `${err.message}${device ? ' Read again or choose your original ROM to retry.' : ' Choose the file again to retry.'}`, 'bad');
    }
  } finally {
    if (seq === generation) { loading = false; updateControls(); }
  }
}
$('rom').onchange = e => {
  if (busy || installing() || reading) return;
  return chooseRom(e.target.files[0]);
};
$('rom-cancel').onclick = () => reading?.abort();
$('rom-device').onclick = async () => {
  if (busy || installing() || reading) return;
  reading = new AbortController();
  const signal = reading.signal, progress = $('rom-read-progress');
  progress.hidden = false; progress.max = 1; progress.value = 0;
  $('rom').value = '';
  setPreparingFirmware(true);
  try {
    await chooseRom({name: 'Installed LSDj', size: 0, arrayBuffer: async () => {
      const {readInstalledCartridge} = await import('./app.js');
      const slot = await readInstalledCartridge((n, total) => {
        progress.max = total; progress.value = n;
        say(`Reading installed LSDj: ${n.toLocaleString()} / ${total.toLocaleString()} bytes. No device writes.`);
      }, signal);
      if (signal.aborted) throw Error('Cartridge read cancelled.');
      return romFromSlot(slot).buffer;
    }}, true);
  } finally {
    reading = null; progress.hidden = true;
    setPreparingFirmware(false); updateControls();
  }
};
updateControls();
$('rom-build').onclick = async () => {
  if (!rom || !template || busy || loading || reading || installing()) return;
  const seq = generation, keep = selected();
  busy = true; updatePlan();
  setPreparingFirmware(true); updateControls();
  try {
    const result = await prepareLsdjFirmware(rom, keep, template, metadata,
      {versions, experimental: $('rom-experimental').checked});
    if (seq !== generation) return;
    const name = `lsdj-burrito-${result.product}-experimental.fwsc`;
    selectFirmware(result.bytes, name, true);
    downloadUrl = URL.createObjectURL(new Blob([result.bytes], {type: 'application/octet-stream'}));
    $('rom-download').href = downloadUrl; $('rom-download').download = name; $('rom-download').hidden = false;
    $('rom-actions').hidden = false;
    say(`Prepared ${result.product}; checks passed. ` +
      (result.info.cursorProfile ? '' : 'Cursor-following FX unavailable: FX targets ALL channels. ') +
      `The file contains your LSDj: keep it private. SHA-256 ${result.sha256}`, 'ok');
  } catch (err) { say(err.message, 'bad'); }
  finally {
    busy = false;
    setPreparingFirmware(false); updateControls();
  }
};
