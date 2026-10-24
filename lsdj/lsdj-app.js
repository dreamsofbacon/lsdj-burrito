// SPDX-License-Identifier: GPL-3.0-only
// index.html: checks a user's LSDj ROM against the tested versions. Writes
// nothing to any device: installing from the page is switched off.
import {identifyRom, listKits} from './lsdj-rom.js';

const $ = id => document.getElementById(id);
const say = (text, cls = '') => { const el = $('rom-info'); el.textContent = text; el.className = cls; };
const versions = fetch('lsdj/versions.json', {cache: 'no-store'}).then(r => r.json()).catch(() => []);

$('rom').onchange = async e => {
  const file = e.target.files[0]; if (!file) return say('');
  try {
    const rom = new Uint8Array(await file.arrayBuffer());
    const info = await identifyRom(rom, await versions);
    say(`${info.title}: ${info.tested ? 'tested on the FM-1' : 'not tested on the FM-1 yet'} (${listKits(rom).length} sample kits)`,
        info.tested ? 'ok' : 'warn');
  } catch (err) { say(err.message, 'bad'); }
};
