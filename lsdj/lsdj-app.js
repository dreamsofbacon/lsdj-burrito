// SPDX-License-Identifier: GPL-3.0-only
import {identifyRom, listKits, planRom, BANK, SLOT_MAX_BANKS} from './lsdj-rom.js';
import {loadTemplate, prepareLsdjFirmware} from './lsdj-firmware.js';
import {selectFirmware, installing, clearPreparedFirmware, setPreparingFirmware} from './install-ui.js';

const $ = id => document.getElementById(id);
const say = (text, cls = '') => { $('rom-info').textContent = text; $('rom-info').className = cls; };
let rom = null, template = null, metadata = null, versions = [], generation = 0, busy = false;
let downloadUrl = null;
const selected = () => [...$('rom-kits').querySelectorAll('input:checked')].map(el => Number(el.value));

function clearDownload() {
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    say('ROM options changed. Prepare the firmware again.', 'warn');
  }
  downloadUrl = null;
  $('rom-download').hidden = true;
}
function updatePlan() {
  clearDownload();
  clearPreparedFirmware();
  $('rom-build').disabled = true;
  if (!rom || !metadata) return;
  try {
    const p = planRom(rom, selected(), metadata.cartridge_capacity);
    $('rom-budget').textContent = `${p.codeBanks} required program/data banks + ${p.kept} selected kit banks: ` +
      `${p.needed.toLocaleString()} / ${p.capacity.toLocaleString()} bytes. ` +
      (p.omitted.length ? `Omitted banks: ${p.omitted.map(k => k.bank.toString(16).toUpperCase().padStart(2, '0')).join(', ')}. Songs using these kits will lose those samples. ` : 'All kits preserved. ') +
      (p.fits ? 'Fits.' : 'Does not fit. Deselect kits; program/data banks cannot be removed.');
    $('rom-budget').className = p.fits ? 'hint' : 'warn';
    $('rom-build').disabled = busy || installing() || !p.fits || !$('rom-experimental').checked;
  } catch (err) { say(err.message, 'bad'); }
}
$('rom-experimental').onchange = updatePlan;
$('rom-kits').onchange = updatePlan;
function updateControls() {
  $('rom').disabled = $('rom-experimental').disabled = $('rom-kits').disabled = busy || installing();
  $('rom-build').disabled = busy || installing() || !rom || !metadata ||
    !planRom(rom, selected(), metadata.cartridge_capacity).fits || !$('rom-experimental').checked;
}
document.addEventListener('firmware-install-state', updateControls);
$('rom').onchange = async e => {
  if (busy || installing()) return;
  const seq = ++generation, file = e.target.files[0];
  rom = template = metadata = null;
  const legend = document.createElement('legend');
  legend.textContent = 'Sample kits (all selected initially)';
  $('rom-kits').replaceChildren(legend); $('rom-budget').textContent = '';
  $('rom-experimental').checked = false;
  updatePlan();
  if (!file) return say('');
  try {
    if (file.size > BANK * SLOT_MAX_BANKS) throw Error('ROM is larger than the supported 2 MiB limit.');
    say('Checking ROM and loading the ROM-free template...');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const response = await fetch('lsdj/versions.json', {cache: 'no-store', signal: AbortSignal.timeout(20000)});
    if (!response.ok) throw Error(`Version catalogue unavailable (${response.status}).`);
    const catalog = await response.json();
    const info = await identifyRom(bytes, catalog);
    const loaded = await loadTemplate();
    if (seq !== generation) return;
    rom = bytes; versions = catalog; ({template, metadata} = loaded);
    say(`${info.title}: ${info.tested ? 'exact ROM has prior host-test evidence' :
      info.sameProgram ? 'program banks match a tested ROM; sample content differs' : 'unverified program build'}. ` +
      'This generic firmware template is experimental, not hardware-validated. ' +
      (!info.globalChecksumValid ? 'The source global checksum is stale; the prepared ROM checksum will be recalculated. ' : '') +
      'No files are uploaded.', 'warn');
    for (const kit of listKits(rom)) {
      const label = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.value = String(kit.bank); input.checked = true;
      label.append(input, ` Bank ${kit.bank.toString(16).toUpperCase().padStart(2, '0')}: ${kit.name || '(unnamed kit)'}`);
      $('rom-kits').append(label, document.createElement('br'));
    }
    updatePlan();
  } catch (err) {
    if (seq === generation) {
      $('rom').value = '';
      say(err.message, 'bad');
    }
  }
};
$('rom-build').onclick = async () => {
  if (!rom || !template || busy || installing()) return;
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
    say(`Prepared ${result.product}; package checks passed. SHA-256: ${result.sha256}. ` +
      'Download for M-UPGRADE or use the separate USB installer below. Nothing has been sent to the device. ' +
      'The package contains your ROM: keep it private.', 'ok');
  } catch (err) { say(err.message, 'bad'); }
  finally {
    busy = false;
    setPreparingFirmware(false); updateControls();
  }
};
