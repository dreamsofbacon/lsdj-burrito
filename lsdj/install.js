// SPDX-License-Identifier: GPL-3.0-only
// Installing an LSDJ Burrito .fwsc from the page (after GameDude's
// install-firmware.js), with the FM-1's own USB updater, as M-UPGRADE does:
//   1. the running firmware reads parts of the package and stages M-VAVE's
//      update loader (nothing is changed before the page says "success");
//   2. the FM-1 restarts into the loader, which reads the whole firmware and
//      writes it; 3. it restarts into the new firmware, which must report the
//      package's version.
// From step 2 on the FM-1 starts into the loader every time until a write has
// finished, so an interrupted install is finished by installing again: the
// page finds the loader and serves the same file (resume).
import {Updater, UPGRADE, STAGE_DONE, WRITE_DONE, isFm1} from '../vendor/fm1ota.js';
import {Package, logicalImage} from '../vendor/fm1pkg.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class InstallError extends Error {
  constructor(msg, {resumable = false} = {}) { super(msg); this.resumable = resumable; }
}

/* A .fwsc file -> {product, version, burrito, image}; throws (nothing installed) unless it is a whole, valid
   FM-1 package: every CRC in it checks, and it has the FM-1's layout. */
export function checkPackage(bytes) {
  let p;
  try { p = new Package(bytes); } catch (e) { throw new InstallError(`This is not a valid FM-1 firmware file (${e.message}). Nothing was installed.`); }
  const product = p.product;
  if (!/^FM-1_\d{3}$/.test(product)) throw new InstallError(`This firmware is for "${product}", not the FM-1. Nothing was installed.`);
  if (p.appBase !== 0x4000 || p.appOff !== 0x4120 || p.flashSize !== 0x93000)
    throw new InstallError('This FM-1 firmware has an unknown layout. Nothing was installed.');
  const version = +product.slice(5);
  return {product, version, burrito: version >= 955 && version <= 999, image: logicalImage(bytes)};
}

/* Install (or finish an interrupted install of) pkg. onStep(phase, detail): 'found', 'stage', 'loader',
   'write', 'restart', 'done'; onProgress(bytes, total) during the write. Resolves the identity the FM-1
   reports afterwards. */
export async function install(access, pkg, {log = () => {}, onStep = () => {}, onProgress = () => {}, Transport = Updater} = {}) {
  const up = new Transport(access, log);
  let dev = await up.findAny(isFm1);
  if (!dev) throw new InstallError('No FM-1 found. Connect it with a USB data cable, close M-UPGRADE and other MIDI apps, and try again. Nothing was installed.');
  onStep('found', dev.id.text);
  try {
    if (dev.id.model === 'FM-1') {
      // step 1: the running firmware stages the loader; nothing is committed without our "success"
      onStep('stage');
      if (!dev.link.send(UPGRADE)) throw new InstallError('The FM-1 went away before the update started. Nothing was installed.');
      const s1 = await up.serve(dev.link, pkg.image, STAGE_DONE, 15000);
      dev.link.close();
      if (!s1.finished) throw new InstallError('The FM-1 stopped preparing the update. Nothing was installed: it is still running its firmware.');
      onStep('loader');
      await sleep(1500);
      dev = await up.waitForAny((id) => id.model === 'ota-FM-1', 30000);
      if (!dev) throw new InstallError('The FM-1 did not come back in update mode. Unplug and replug the USB cable, then press Install again: it will finish the update.', {resumable: true});
    } else log('The FM-1 is in update mode (an install that was cut off): finishing it.');
    // step 2: the loader reads everything and writes it
    onStep('write');
    dev.link.drain();
    if (!dev.link.send(UPGRADE)) throw new InstallError('The FM-1 went away before the write started. Replug it and press Install again.', {resumable: true});
    const s2 = await up.serve(dev.link, pkg.image, WRITE_DONE, 60000, onProgress);
    dev.link.close();
    if (!s2.finished)
      throw new InstallError(`The write stopped after ${s2.served} parts${s2.lost ? ' (the FM-1 was disconnected)' : ''}. ` +
        'The FM-1 stays in update mode: keep it powered, replug the USB cable if needed, and press Install again with the same file to finish.', {resumable: true});
    // step 3: the new firmware must say who it is
    onStep('restart');
    await sleep(2000);
    const back = await up.waitForAny((id) => id.model === 'FM-1', 40000);
    if (!back) throw new InstallError('The write finished, but the FM-1 did not report back. Check its screen; if it shows nothing, replug it and press Install again.', {resumable: true});
    back.link.close();
    if (back.id.text !== pkg.product) throw new InstallError(`The FM-1 now reports ${back.id.text}, not ${pkg.product}. Press Install again.`, {resumable: true});
    onStep('done', back.id.text);
    return back.id.text;
  } finally { dev?.link?.close?.(); }
}
