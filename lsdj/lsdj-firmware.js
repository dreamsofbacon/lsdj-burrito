// SPDX-License-Identifier: GPL-3.0-only
// Put the user's trimmed LSDj into the public LSDj firmware template.
// The template has no ROM in it; the result never leaves this computer.
import {Package} from '../vendor/fm1pkg.js?v=20261013';
import {patchTemplate} from '../rom-firmware.js';
import {buildSlot, parseSlot} from './lsdj-rom.js';

export async function loadTemplate(fetcher = fetch) {
  const get = async (path, as) => {
    const r = await fetcher(path, {cache: 'no-store', signal: AbortSignal.timeout(20000)});
    if (!r.ok) throw Error('The LSDj firmware template could not be downloaded. Run tools/lsdj_template.py first.');
    return as === 'json' ? r.json() : new Uint8Array(await r.arrayBuffer());
  };
  const metadata = await get('lsdj/template.json', 'json');
  return {metadata, template: await get('lsdj/' + metadata.package)};
}

export async function prepareLsdjFirmware(rom, keepKits, template, metadata) {
  if (metadata.lsdj_slot !== 1) throw Error('This is not an LSDj firmware template.');
  const {slot, stored, kept} = buildSlot(rom, keepKits, metadata.cartridge_capacity);
  const result = await patchTemplate(slot, template, metadata);
  // Read the slot back out of the finished package, as the firmware will.
  const pkg = new Package(result.bytes), off = pkg.appOff + metadata.cartridge_offset;
  const back = parseSlot(pkg.dec.subarray(off, off + metadata.cartridge_capacity), metadata.cartridge_capacity);
  if (back.error || back.stored !== stored || back.kits !== kept) throw Error('LSDj slot verification failed. Nothing was prepared.');
  return {...result, stored, kept, slotBytes: slot.length};
}
