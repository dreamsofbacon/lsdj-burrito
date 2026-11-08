// SPDX-License-Identifier: GPL-3.0-only
// Install's kit tools (as LSDj Patcher): per kit Save .kit, Replace with a .kit, Rename, Clear; into an empty kit
// slot Add a .kit or Make a kit from your own sounds. Every change makes a new copy of the user's ROM in this
// page (lsdj-app.js replaceRom), never the original file; checksums are fixed. "Songs that use it" comes from
// the songs open in Songs and kits (songs-ui.js). Kit maths: lsdj-kit.js; sound decoding: wav-kit.js.
import {kitSlots, kitFile, putKit, clearKit, renameKit, buildKit, sampleNibbles, kitSampleNibbles, parseKit, KitError,
  BANK, MAX_SAMPLES, MAX_SAMPLE_SPACE} from './lsdj-kit.js';

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };
const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
function download(bytes, name) {
  const a = el('a', {href: URL.createObjectURL(new Blob([bytes], {type: 'application/octet-stream'})), download: name});
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const pick = (accept) => new Promise(resolve => {
  const i = el('input', {type: 'file', accept});
  i.onchange = () => resolve(i.files[0] || null);
  i.click();
});
const bytesOf = async f => new Uint8Array(await f.arrayBuffer());

/* ctx: {rom(), replace(newRom, message), say(text, cls), rotate()} (lsdj-app.js) */
export function kitButtons(bank, ctx) {
  const b = (text, title, fn) => el('button', {type: 'button', className: 'kit-tool', textContent: text, title, onclick: async e => {
    e.preventDefault();
    try { await fn(); } catch (err) { ctx.say(err.message, 'bad'); }
  }});
  const name = () => parseKit(ctx.rom().subarray(bank * BANK, (bank + 1) * BANK))?.name || 'kit';
  return el('span', {className: 'kit-tools'},
    b('Save', 'Save this kit as a .kit file (LSDj Patcher can open it)', () => download(kitFile(ctx.rom(), bank), `${name().trim() || 'kit'}.kit`)),
    b('Replace…', 'Put a .kit file here instead', async () => {
      const f = await pick('.kit'); if (!f) return;
      ctx.replace(putKit(ctx.rom(), bank, await bytesOf(f)), `Bank ${hex(bank)} now holds ${f.name}.`);
    }),
    b('Rename', 'Rename the kit (6 letters)', () => {
      const n = prompt('Kit name (up to 6 letters, numbers, - or space):', name()); if (n == null) return;
      ctx.replace(renameKit(ctx.rom(), bank, n), `Renamed bank ${hex(bank)}.`);
    }),
    b('Edit…', 'Change its samples (add your own sounds, rename, remove)', () => openKitEditor(ctx, bank)),
    b('Clear', 'Make this an empty kit slot', () => {
      if (!confirm(`Clear ${name()}? Songs that use it will play nothing there. (Your ROM file isn't changed.)`)) return;
      ctx.replace(clearKit(ctx.rom(), bank), `Bank ${hex(bank)} is now an empty kit slot.`);
    }));
}
/* the line under the kit list: empty slots and what can go in them */
export function emptySlotTools(ctx) {
  const empty = kitSlots(ctx.rom()).filter(s => s.empty);
  const first = () => { const s = kitSlots(ctx.rom()).find(x => x.empty); if (!s) throw new KitError('No empty kit slot left: clear or replace a kit.'); return s.bank; };
  return el('p', {className: 'kit-empty'},
    `${empty.length} empty kit slot${empty.length === 1 ? '' : 's'}. `,
    el('button', {type: 'button', textContent: 'Add a .kit…', disabled: !empty.length, onclick: async () => {
      try { const f = await pick('.kit'); if (!f) return; const bank = first(); ctx.replace(putKit(ctx.rom(), bank, await bytesOf(f)), `Added ${f.name} in bank ${hex(bank)}.`); }
      catch (err) { ctx.say(err.message, 'bad'); }
    }}), ' ',
    el('button', {type: 'button', textContent: 'Make a kit from sounds…', disabled: !empty.length, onclick: () => { try { openKitEditor(ctx, first(), true); } catch (err) { ctx.say(err.message, 'bad'); } }}));
}

/* ---- the kit editor: up to 15 samples from sound files (or kept from the kit), each with a name, volume, pitch
   and trim; a space meter; play; then into the ROM or saved as a .kit ---- */
export function openKitEditor(ctx, bank, fresh = false) {
  const old = fresh ? null : parseKit(ctx.rom().subarray(bank * BANK, (bank + 1) * BANK));
  const oldBank = ctx.rom().slice(bank * BANK, (bank + 1) * BANK);
  /* a sample: {name, from: 'kit' | file name, nibbles (kept kit samples) or pcm (+ settings)} */
  const samples = (old?.samples ?? []).map(s => ({name: s.name.replace(/-+$/, ''), from: 'kit', nibbles: kitSampleNibbles(oldBank, s.index)}));
  let kitName = old?.name ?? 'MYKIT', halfSpeed = false, wav = null;
  const dlg = el('dialog', {className: 'kit-editor'});
  const meter = el('progress', {max: MAX_SAMPLE_SPACE}), space = el('span', {className: 'hint'}), list = el('div'), msg = el('p', {className: 'hint', role: 'status'});
  const nibblesOf = s => s.nibbles ?? sampleNibbles(s.pcm, {volumeDb: s.volumeDb, trim: s.trim, dither: s.dither});
  const bytes = () => samples.reduce((t, s) => t + nibblesOf(s).length / 2, 0);
  const build = () => buildKit({name: kitName, samples: samples.map(s => ({name: s.name, nibbles: nibblesOf(s)})), rotate: ctx.rotate()});
  const sound = async () => (wav ??= await import('./wav-kit.js'));
  function draw() {
    list.replaceChildren();
    samples.forEach((s, i) => {
      const num = (label, key, min, max, step = 1) => el('label', {className: 'kit-num'}, label + ' ',
        el('input', {type: 'number', min, max, step, value: s[key], onchange: e => { s[key] = Number(e.target.value); draw(); }}));
      list.append(el('div', {className: 'kit-sample'},
        el('input', {value: s.name, maxLength: 3, size: 4, title: 'Sample name (3 letters)', onchange: e => { s.name = e.target.value.toUpperCase(); }}),
        el('span', {className: 'hint', textContent: `${s.from} · ${(nibblesOf(s).length / 11468).toFixed(2)} s`}),
        s.pcm ? num('Volume dB', 'volumeDb', -24, 12) : null, s.pcm ? num('Trim', 'trim', 0, 999) : null,
        s.pcm ? el('label', {className: 'kit-num'}, el('input', {type: 'checkbox', checked: s.dither, onchange: e => { s.dither = e.target.checked; draw(); }}), ' Dither') : null,
        el('button', {type: 'button', textContent: '▶', title: 'Play as LSDj will', onclick: async () => (await sound()).playNibbles(nibblesOf(s), {halfSpeed})}),
        el('button', {type: 'button', textContent: '↑', title: 'Move up', disabled: !i, onclick: () => { [samples[i - 1], samples[i]] = [samples[i], samples[i - 1]]; draw(); }}),
        el('button', {type: 'button', textContent: '✕', title: 'Remove', onclick: () => { samples.splice(i, 1); draw(); }})));
    });
    const used = bytes();
    meter.value = Math.min(used, MAX_SAMPLE_SPACE);
    space.textContent = ` ${used} of ${MAX_SAMPLE_SPACE} bytes (${(used * 2 / (halfSpeed ? 5734 : 11468)).toFixed(2)} s)` + (used > MAX_SAMPLE_SPACE ? ': too long, trim or remove samples' : '');
    space.className = used > MAX_SAMPLE_SPACE ? 'bad' : 'hint';
    add.disabled = samples.length >= MAX_SAMPLES;
  }
  const add = el('button', {type: 'button', textContent: 'Add sounds…', onclick: () => {
    const i = el('input', {type: 'file', accept: 'audio/*,.wav,.aif,.aiff', multiple: true});
    i.onchange = async () => {
      try {
        for (const f of [...i.files].slice(0, MAX_SAMPLES - samples.length)) {
          const file = await bytesOf(f), {pcm} = await (await sound()).decodeSound(file, {halfSpeed});
          samples.push({name: f.name.replace(/\.[^.]*$/, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'SMP', from: f.name, file, pcm, volumeDb: 0, trim: 0, dither: true});
        }
        msg.textContent = ''; draw();
      } catch (err) { msg.textContent = err.message; msg.className = 'bad'; }
    };
    i.click();
  }});
  const done = (fn) => () => { try { fn(); dlg.close(); dlg.remove(); } catch (err) { msg.textContent = err.message; msg.className = 'bad'; } };
  dlg.append(
    el('h3', {textContent: fresh ? `New kit in bank ${hex(bank)}` : `Edit ${old?.name || 'kit'} (bank ${hex(bank)})`}),
    el('p', {className: 'hint', textContent: 'Up to 15 samples at 11468 Hz, 4-bit, as LSDj plays them. Each sound is normalised and its silence trimmed; Trim takes 32-sample steps off the end. Your files never leave this page.'}),
    el('div', {className: 'row'},
      el('label', {}, 'Kit name ', el('input', {value: kitName, maxLength: 6, size: 7, onchange: e => { kitName = e.target.value.toUpperCase(); }})),
      el('label', {className: 'check'}, el('input', {type: 'checkbox', onchange: async e => {
        halfSpeed = e.target.checked;
        try { for (const s of samples) if (s.file) s.pcm = (await (await sound()).decodeSound(s.file, {halfSpeed})).pcm; msg.textContent = ''; }
        catch (err) { msg.textContent = err.message; msg.className = 'bad'; }
        draw();
      }}), el('span', {textContent: ' Half speed: twice as long, lower quality (set the instrument\'s SPEED to 0.5X in LSDj)'}))),
    list, el('div', {className: 'row'}, add), el('p', {}, meter, space), msg,
    el('div', {className: 'row'},
      el('button', {type: 'button', className: 'primary', textContent: 'Put it in my LSDj', onclick: done(() => ctx.replace(putKit(ctx.rom(), bank, build()), `Bank ${hex(bank)} now holds ${kitName}.`))}),
      el('button', {type: 'button', textContent: 'Save as .kit', onclick: () => { try { download(build(), `${kitName.trim() || 'kit'}.kit`); } catch (err) { msg.textContent = err.message; msg.className = 'bad'; } }}),
      el('button', {type: 'button', textContent: 'Cancel', onclick: () => { dlg.close(); dlg.remove(); }})));
  document.body.append(dlg);
  draw();
  dlg.showModal();
  return dlg;
}
