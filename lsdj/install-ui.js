// SPDX-License-Identifier: GPL-3.0-only
// The page's Install section (lsdj/install.js does the work). Safeguards:
// the file is checked whole before anything is sent; the install only starts
// with this tab in front, keeps the screen awake, warns if the tab is hidden
// or closed meanwhile; an install that is cut off is finished by pressing
// Install again with the same file (the FM-1 waits in update mode).
import {checkPackage, install, InstallError} from './install.js';

const $ = (id) => document.getElementById(id);
const say = (text, cls = 'hint') => { const el = $('fw-status'); el.textContent = text; el.className = cls; };
const log = (text) => { const el = $('fw-log'); el.textContent += `${new Date().toLocaleTimeString()}  ${text}\n`; };
let pkg = null, fileName = '', busy = false, wake = null;
export const installing = () => busy;
export let beforeInstall = async () => {};   // the page closes its own link to the FM-1 first (app.js sets it)
export function setBeforeInstall(f) { beforeInstall = f; }

$('fw-file').onchange = async (e) => {
  const f = e.target.files[0]; pkg = null; $('fw-install').disabled = true; $('fw-info').textContent = '';
  if (!f) return;
  fileName = f.name;
  try {
    pkg = checkPackage(new Uint8Array(await f.arrayBuffer()));
    $('fw-info').textContent = `${f.name}: ${pkg.product}` + (pkg.burrito ? ` (LSDJ Burrito alpha ${pkg.version - 900})` : ' (not an LSDJ Burrito build)');
    $('fw-info').className = pkg.burrito ? 'ok' : 'warn';
    $('fw-install').disabled = false;
    say('Ready. Keep this tab in front and the USB cable in until it says done.');
  } catch (err) { $('fw-info').textContent = err.message; $('fw-info').className = 'bad'; }
};

const onHidden = () => {
  if (!busy) return;
  if (document.hidden) { document.title = 'Installing - keep this tab open'; log('The tab went to the background (the install keeps going; bring it back to watch).'); }
  else document.title = "Dreamy_bacon's LSDJ Burrito";
};
document.addEventListener('visibilitychange', onHidden);
window.addEventListener('beforeunload', (e) => { if (busy) { e.preventDefault(); e.returnValue = ''; } });

$('fw-install').onclick = async () => {
  if (!pkg || busy) return;
  if (document.hidden) return say('Bring this tab to the front first.', 'warn');
  if (!pkg.burrito && !confirm(`${fileName} is ${pkg.product}, not an LSDJ Burrito build. Install it anyway?`)) return;
  if (!confirm(`Install ${pkg.product} on the FM-1?\n\nKeep the USB cable in and this tab open until it says done (about a minute). If it is cut off, the FM-1 waits in update mode: press Install again with the same file to finish.`)) return;
  busy = true; $('fw-install').disabled = true; $('fw-file').disabled = true;
  const bar = $('fw-progress'); bar.hidden = false; bar.value = 0; bar.max = 1;
  try { wake = await navigator.wakeLock?.request('screen'); } catch (_) { wake = null; }
  try {
    await beforeInstall();
    let access;
    try { access = await navigator.requestMIDIAccess({sysex: true}); }
    catch (_) { throw new InstallError('MIDI access was blocked. Allow it (with SysEx) for this page, then press Install again. Nothing was installed.'); }
    const names = {found: 'Found the FM-1', stage: 'Preparing the update (nothing is changed yet)', loader: 'The FM-1 is restarting into update mode',
                   write: 'Writing the firmware: keep the cable in', restart: 'Written. The FM-1 is restarting', done: 'Done'};
    const id = await install(access, pkg, {
      log,
      onStep: (s, d) => { log(names[s] + (d ? `: ${d}` : '')); if (s !== 'done') say(names[s] + '…', s === 'write' ? 'warn' : 'hint'); },
      onProgress: (b, t) => { bar.max = t; bar.value = b; }
    });
    bar.value = bar.max;
    say(`Installed: the FM-1 now runs ${id}.`, 'ok');
  } catch (err) {
    log('Stopped: ' + err.message);
    say(err.message, err.resumable ? 'warn' : 'bad');
  } finally {
    busy = false; $('fw-install').disabled = !pkg; $('fw-file').disabled = false;
    document.title = "Dreamy_bacon's LSDJ Burrito";
    try { await wake?.release(); } catch (_) {}
    wake = null;
  }
};
