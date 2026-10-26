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
    $('rom-budget').textContent = `${p.codeBanks} required program/data banks + ${p.kept} selected kit banks: ` +
      `${p.needed.toLocaleString()} / ${p.capacity.toLocaleString()} bytes. ` +
      (p.omitted.length ? `Omitted banks: ${p.omitted.map(k => k.bank.toString(16).toUpperCase().padStart(2, '0')).join(', ')}. Songs using these kits will lose those samples. ` : 'All kits preserved. ') +
      (p.fits ? 'Fits.' : fromDevice ? 'The installed cartridge does not fit this update. Nothing will be dropped; use your original ROM to choose a different kit set explicitly.' :
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
    reading ? 'Reading installed LSDj. No device writes; you may cancel safely.' :
    busy ? 'Preparing and verifying the private package...' :
    loading ? 'Checking your ROM and loading the template. You can choose another file while waiting.' :
    !rom ? 'Step 1: choose your LSDj .gb file, or connect and read installed LSDj.' :
    !currentPlan ? 'Resolve the ROM/template error above, then choose the file again.' :
    !currentPlan.fits ? 'Step 2: resolve the capacity warning above.' :
    !$('rom-experimental').checked ? 'Step 3: read and accept the experimental/backup acknowledgement to enable preparation.' :
    downloadUrl ? 'Step 4: download the private package, preview it in Virtual FM-1, or explicitly install it below.' :
    'Ready: prepare firmware. This does not install anything.';
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
    say(`${file.name} (${info.title}): ${info.tested ? 'exact ROM has prior host-test evidence' :
      info.sameProgram ? 'program banks match a tested ROM; sample content differs' : 'unverified program build'}. ` +
      'This generic firmware template is experimental, not hardware-validated. ' +
      (info.cursorProfile ? 'Cursor-following FX enabled (verified 9.3.9 program); channel highlight stays off. ' :
        'Cursor-following FX unavailable for this program: FX targets ALL channels. ') +
      (device ? 'All currently installed kit banks are preserved; previously omitted kits cannot be recovered. Songs/settings are separate: back them up before installation. ' : '') +
      (!info.globalChecksumValid ? 'The source global checksum is stale; the prepared ROM checksum will be recalculated. ' : '') +
      'No files are uploaded.', 'warn');
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
    say(`Prepared ${result.product}; package checks passed. SHA-256: ${result.sha256}. ` +
      (result.info.cursorProfile ? 'Cursor-following FX enabled; no channel highlight. ' :
        'Cursor-following FX unavailable: FX targets ALL channels. ') +
      'Download for M-UPGRADE or use the separate USB installer below. Nothing has been sent to the device. ' +
      'The package contains your ROM: keep it private.', 'ok');
  } catch (err) { say(err.message, 'bad'); }
  finally {
    busy = false;
    setPreparingFirmware(false); updateControls();
  }
};
