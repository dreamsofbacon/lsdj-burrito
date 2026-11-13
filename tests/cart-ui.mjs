// SPDX-License-Identifier: GPL-3.0-only
// The crate's cart maker in the browser (lsdj/cart-maker.js and its worker), with made-up files only: run in a fresh
// local preview (rt_check.html?m=cart-ui&s=runCartUiTests). Files go in through the picker as a person's would; each
// song shows its kits and status; a missing kit left silent; a cart made and added (a stand-in for the crate).
import {openCartMaker, cartMakerState} from '../lsdj/cart-maker.js';
import {kitSlots} from '../lsdj/lsdj-kit.js';
import {parseSav, buildSav, writeLsdsng, SAV_SIZE} from '../lsdj/lsdj-sav.js';
import {kitOf, lsdj, song, blank, prj} from './lsdj-fixtures.mjs';
import {clearLibrary} from '../lsdj/kit-library.js';

const assert = (v, m) => { if (!v) throw Error(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(f, m, ms = 8000) { for (const end = Date.now() + ms; Date.now() < end;) { if (f()) return; await sleep(50); } throw Error(m); }

export async function runCartUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  await clearLibrary();
  try { localStorage.removeItem('cart-built'); } catch {}
  const added = [];
  await openCartMaker({addToCrate: async c => { added.push(c); }, cap: 400000});
  const p = document.querySelector('.cart-maker');
  assert(p && !p.hidden, 'the panel opens');
  await until(() => /Drop songs here/.test(p.textContent), 'empty: says what to drop');

  const KA = kitOf('ALPHA', [4, 5], true, 1), KB = kitOf('BRAVO', [3, 3, 3], true, 7), KX = kitOf('XTRA', [6], true, 11);
  const rom = lsdj('9.3.9', [KA, KB]);
  const sA = song([{ins: 0, k1: 0}], [0x10, 0x20]), sB = song([{ins: 0, k1: 1}], [0x30]);
  const sX = song([{ins: 0, k1: 3}], [0x10]), sLost = song([{ins: 0, k1: 6}], [0x10]);
  const sav = buildSav(blank(), sA, [{slot: 0, name: 'ALPHASNG', song: sA}, {slot: 1, name: 'BRAVOSNG', song: sB}], 0);
  const footer = new Uint8Array(SAV_SIZE + 16); footer.set(sav);
  const dt = new DataTransfer();
  for (const [name, bytes] of [['mine.gb', rom], ['set.sav', footer], ['proj.lsdprj', prj('PROJ', sX, [KX])], ['lost.lsdsng', writeLsdsng({name: 'LOST', song: sLost})], ['readme.txt', new Uint8Array(4)]])
    dt.items.add(new File([bytes], name));
  const input = p.querySelector('input[type=file]:not([webkitdirectory])');
  input.files = dt.files; input.dispatchEvent(new Event('change'));
  await until(() => p.querySelectorAll('.cm-table tr').length === 5, `four songs listed: ${p.querySelectorAll('.cm-table tr').length - 1}`);
  const row = n => [...p.querySelectorAll('.cm-table tr')].find(r => r.querySelector('b.mono')?.textContent === n);
  assert(/kits found/.test(row('ALPHASNG').textContent) && /kits found/.test(row('PROJ').textContent), 'saved songs and the project: kits found');
  assert(/its own kits/.test(row('PROJ').textContent) && /proj\.lsdprj kit 1/.test(row('PROJ').textContent), 'the project plays its own kit');
  assert(/kit missing/.test(row('LOST').textContent), 'LOST: its kit is missing');
  assert(/LSDj-v9|mine\.gb/.test(p.querySelector('.cm-side').textContent), 'build with the LSDj added');

  /* LOST's kit left silent: no longer missing */
  const pick = row('LOST').querySelector('.cm-kitpick');
  pick.value = 'none'; pick.dispatchEvent(new Event('change'));
  await until(() => /left silent/.test(row('LOST')?.textContent ?? '') && !/kit missing/.test(row('LOST').textContent), 'LOST: left silent, not missing');
  /* BRAVOSNG out: the cart holds ALPHA and XTRA only */
  const t = row('BRAVOSNG').querySelector('input[type=checkbox]'); t.checked = false; t.dispatchEvent(new Event('change'));
  await until(() => /3 of 4 songs ticked/.test(p.textContent), 'three ticked');
  const name = p.querySelector('.cm-name'); name.value = 'Friday'; name.dispatchEvent(new Event('input'));
  await until(() => [...p.querySelectorAll('.cm-side button')].some(b => b.textContent === 'Make the cart'), 'one cart planned');
  /* its own name, a colour (a swatch, then any colour) and a picture */
  assert(p.querySelector('.cm-cartname').placeholder === 'Friday', `the Name box's name as its default: ${p.querySelector('.cm-cartname').placeholder}`);
  const own = p.querySelector('.cm-cartname'); own.value = 'Friday Night'; own.dispatchEvent(new Event('input'));
  p.querySelector('.cm-cart .cart-swatch[data-color=teal]').click();
  await until(() => p.querySelector('.cm-cart .cm-label')?.dataset.color === 'teal', 'teal');
  assert(p.querySelector('.cm-cartname').value === 'Friday Night', 'its name kept through a redraw');
  const anyColour = p.querySelector('.cm-cart .cart-custom'); anyColour.value = '#123456'; anyColour.dispatchEvent(new Event('change'));
  await until(() => p.querySelector('.cm-cart .cm-label')?.style.getPropertyValue('--lab') === '#123456', 'any colour');
  const cv = Object.assign(document.createElement('canvas'), {width: 600, height: 300});
  const g = cv.getContext('2d'); g.fillStyle = '#e04'; g.fillRect(0, 0, 600, 300);
  const png = await new Promise(r => cv.toBlob(r, 'image/png')), pt = new DataTransfer();
  pt.items.add(new File([png], 'art.png', {type: 'image/png'}));
  const fileIn = p.querySelector('.cm-cart .cart-label-edit input[type=file]'); fileIn.files = pt.files; fileIn.dispatchEvent(new Event('change'));
  await until(() => p.querySelector('.cm-cart .cm-label img'), 'the picture shown');
  assert([...p.querySelectorAll('.cm-cart .cart-pic-acts button')].some(b => b.textContent === 'No picture'), 'No picture offered');
  [...p.querySelectorAll('.cm-side button')].find(b => b.textContent === 'Make the cart').click();
  await until(() => [...p.querySelectorAll('.cm-side button')].some(b => b.textContent === 'Add to the crate'), 'made', 15000);
  [...p.querySelectorAll('.cm-side button')].find(b => b.textContent === 'Add to the crate').click();
  await until(() => added.length === 1 && /In the crate/.test(p.textContent), 'added to the crate', 8000);
  const c = added[0];
  assert(c.name === 'Friday Night', `its own name: ${c.name}`);
  assert(c.color === '#123456', `its colour: ${c.color}`);
  assert(c.img instanceof Uint8Array && c.img[0] === 0xFF && c.img[1] === 0xD8 && c.img.length <= 96 * 1024, `its picture, small (JPEG): ${c.img?.length}`);
  { const bmp = await createImageBitmap(new Blob([c.img], {type: 'image/jpeg'}));
    assert(bmp.width === 240 && bmp.height === 120, `made small, its shape kept: ${bmp.width}x${bmp.height}`); }
  assert(kitSlots(c.rom).filter(s => !s.empty).map(s => s.kit.name).sort().join() === 'ALPHA,XTRA', 'its LSDj: only the kits played');
  assert(parseSav(c.sav).songs.map(s => s.name).sort().join() === 'ALPHASNG,LOST,PROJ', 'its songs');
  assert(cartMakerState().open, 'the panel stays open');
  p.querySelector('.cm-close').click();
  assert(p.hidden, 'closed');
  await clearLibrary();
  return 'PASS cart maker: picked files (a save with a footer, .lsdprj with its own kit, .lsdsng, an LSDj, others skipped), each song\'s kits and status, a kit left silent, a song unticked, a named cart (its own name, any colour, a picture made small) made in the worker and added with only the kits played';
}
