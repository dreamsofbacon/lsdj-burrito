// SPDX-License-Identifier: GPL-3.0-only
import {OP, le32} from '../lsdj/link.js';
import {unpackFx, packFx} from '../lsdj/fx-model.js';

const $ = id => document.getElementById(id);
const assert = (v, message) => { if (!v) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, tries = 80) {
  for (let n = 0; n < tries; n++) { if (check()) return; await sleep(50); }
  throw Error(message);
}
export async function runFxUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  const input = {name: 'FM-1 test'}, ops = [];
  let bytes = Array(68).fill(0), writes = 0, cursor = 0, firmware = 'FM-1_975', muteSent = null, liveMute = 0, featWord = 0x460001CE, featSets = 0;
  bytes[36] = 5; bytes[37] = 2; bytes[42] = 0xf2; bytes[43] = 70;
  bytes[2] = 40; bytes[30] = 80; bytes[35] = 4;
  const output = {name: 'FM-1 test', send(message) {
    const op = message[4], args = [];
    for (let i = 5; i < message.length - 1; i += 2) args.push(message[i] | message[i + 1] << 7);
    ops.push(op);
    const send = (data = [], status = 0) => queueMicrotask(() => input.onmidimessage?.({
      data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7]
    }));
    if (op === OP.INFO) {
      const info = Array(35).fill(0); info[0] = 1;
      [...firmware].forEach((c, i) => info[1 + i] = c.charCodeAt(0));
      return send(info);
    }
    if (op === OP.FX_GET) return send(bytes);
    if (op === OP.FX_SET) { bytes = args; writes++; return send(); }
    if (op === OP.SETTINGS_GET) return send(le32(0x5a000000));
    if (op === OP.THEME_GET) return send(Array(16).fill(0));
    if (op === OP.MIDI_GET || op === OP.BLUETOOTH) return send([], 1);
    if (op === OP.LIVE) return send([bytes[38], cursor, 120, 0, liveMute, 0, 0, ...bytes, ...(firmware >= 'FM-1_979' ? [0x82] : [])]);
    if (op === OP.FEAT_GET) return firmware >= 'FM-1_979' ? send(le32(featWord)) : send([], 1);
    if (op === OP.FEAT_SET) { featWord = (args[0] | args[1] << 8 | args[2] << 16 | args[3] << 24) >>> 0; featSets++; return send(); }
    if (op === OP.MUTE_SET) { muteSent = args; return send(); }
    if ([OP.STORE, OP.THEME_SET, OP.SETTINGS_SET].includes(op)) return send();
    /* the screen (FM-1_983+): every row one colour, red (RGB565 0xF800) */
    if (op === OP.SCREEN_INFO) return firmware >= 'FM-1_983' ? send([...le32(1), ...Array(36).fill(7)]) : send([], 1);
    if (op === OP.SCREEN_ROW) return send([args[0], 1, 0x00, 0xF8, ...Array(80).fill(0)]);
    /* FM-1_985: SCREEN_SYNC, then the changed bands' rows by themselves, every row one colour, blue (0x001F) */
    if (op === OP.SCREEN_SYNC) {
      if (firmware < 'FM-1_985') return send([], 1);
      const force = args[0] | args[1] << 8 | args[2] << 16, round = args[40];
      let bands = 0; for (let b = 0; b < 18; b++) if (force >> b & 1 || (args[4 + 2 * b] | args[5 + 2 * b] << 8) !== 7) bands |= 1 << b;
      send([...le32(1), ...Array(18).fill([7, 0]).flat(), ...le32(bands)]);
      for (let y = 0; y < 144; y++) if (bands >> (y >> 3) & 1) {   // u8 row, 4 bits 0 (one colour), u16 colour: 28 bits
        const v = y | 0x001F << 12;
        queueMicrotask(() => input.onmidimessage?.({data: [0xf0, 0x7d, 0x47, 0x53, OP.SCREEN_PIXELS, 0, round, v & 127, v >> 7 & 127, v >> 14 & 127, v >> 21 & 127, 0xf7]}));
      }
      return;
    }
    throw Error(`Unexpected device operation ${op}`);
  }};
  const read = () => unpackFx(Array.from({length: bytes.length / 4}, (_, i) =>
    (bytes[4 * i] | bytes[4 * i + 1] << 8 | bytes[4 * i + 2] << 16 | bytes[4 * i + 3] << 24) >>> 0));
  const radio = (key, value) => document.querySelectorAll(`[data-key="${key}"] [role="radio"]`)[value];
  const backup = () => ({format: 'lsdj-burrito-backup', version: 1, settings: 0x5a000000, fx: packFx(read()), theme: Array(8).fill(0)});
  const restore = data => $('restore').onchange({target: {files: [new File([JSON.stringify(data)], 'fx-test.json')], value: ''}});
  try {
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true,
      value: async () => ({inputs: new Map([['test', input]]), outputs: new Map([['test', output]])})});
    await $('connect-btn').onclick();
    assert($('device').textContent.includes('Connected'), $('device').textContent);
    const headings = [...document.querySelectorAll('.fx-card h3')].map(h => h.firstChild.textContent);
    assert(headings.join(',') === 'MASTER,FILTER,DRIVE,LFO,LO-FI,ECHO,ECHO MOD', 'MASTER first, then channel pages with the echo');
    assert([...document.querySelectorAll('#fx-master-pages .fx-card')].map(c => c.dataset.page).join() === '0', 'Only MASTER in Master');
    assert([...document.querySelectorAll('#fx-pagebar [data-page]')].map(b => b.dataset.page).join() === '1,2,3,4,5,6', 'Page bar: channel pages and echo');
    assert(!$('fx-master').hidden && document.querySelectorAll('#fx-mutes button:disabled').length === 4, '975: mutes shown, not settable');
    assert(document.querySelectorAll('[data-key="allFxOn"]').length === 1, 'One All FX switch');
    assert(document.querySelector('[data-page="0"] .fx-who').textContent === 'all channels', 'Master scope');
    assert(document.querySelector('[data-page="1"] .fx-row .fx-name').textContent === 'Channel FX', 'FILTER K1');
    assert(document.querySelectorAll('[data-page="2"] .fx-row').length === 3, 'Unused K4 omitted');
    const original = read();
    for (let c = 0; c < 4; c++) {
      document.querySelector(`#fx-channels [data-ch="${c}"]`).click();
      const before = writes; radio('allFxOn', 0).click();
      await until(() => writes > before, 'All FX write');
      assert(JSON.stringify(read()) === JSON.stringify({...original, bypass: 1}), 'Only global bypass changes');
      assert($('fx-master-status').textContent.includes('OFF: dry output'), 'Immediate bypass status');
      const onBefore = writes; radio('allFxOn', 1).click();
      await until(() => writes > onBefore, 'All FX restore write');
      assert(JSON.stringify(read()) === JSON.stringify(original), 'All FX settings restored');
    }
    $('fx-follow').click(); cursor = 2; bytes[38] = 6; bytes[39] = 1;
    await until(() => radio('allFxOn', 0).getAttribute('aria-checked') === 'true', 'LIVE master switch reflection');
    assert($('live-badges').textContent.includes('ALL FX OFF'), 'LIVE bypass badge');
    assert(document.querySelector('[data-page="6"]').classList.contains('fm1'), 'ECHO MOD active-page badge');
    const newBackup = backup(), beforeRestore = writes;
    restore(newBackup);
    await until(() => $('settings-status').textContent.includes('Restored fx-test.json'), '17-word backup restore');
    assert(writes === beforeRestore + 1 && bytes[39] === 1, 'Restore preserves bypass');
    assert(document.querySelectorAll('#fx-master-status').length === 1, 'No duplicate status after rebuild');
    bytes[37] = 1; bytes[39] = 0; bytes[38] = 5;
    await $('connect-btn').onclick();
    assert(!document.querySelector('[data-key="allFxOn"]'), 'Older firmware has no fake All FX switch');
    assert($('fx-master-status').textContent.includes('require FM-1_975'), 'Old firmware explanation');
    assert(document.querySelector('[data-page="1"] h3').textContent.startsWith('TONE'), 'Old page ordering');
    const oldBefore = writes;
    restore(newBackup);
    await until(() => $('settings-status').textContent.includes('requires FM-1_975'), 'Reject new backup on older firmware');
    assert(writes === oldBefore, 'Incompatible restore sends no FX writes');
    bytes = bytes.slice(0, 44); bytes[38] = 3; bytes[43] = 0;
    await $('connect-btn').onclick();
    assert(document.querySelectorAll('.fx-card').length === 4, '11-word firmware keeps four pages');
    const legacy = backup(); restore(legacy);
    await until(() => $('settings-status').textContent.includes('Restored fx-test.json'), '11-word backup restore');
    assert(ops.every(op => [OP.INFO, OP.FX_GET, OP.FX_SET, OP.SETTINGS_GET, OP.SETTINGS_SET,
      OP.THEME_GET, OP.THEME_SET, OP.MIDI_GET, OP.BLUETOOTH, OP.LIVE, OP.STORE, OP.SCREEN_INFO, OP.SCREEN_SYNC].includes(op)), 'Only simulated settings operations');
    assert(ops.filter(op => op === OP.SCREEN_INFO).length <= 3 && ops.filter(op => op === OP.SCREEN_SYNC).length <= 3, 'older firmware: the screen asked about once per connection');
    bytes = packFx({...read(), v2: true, v3: true, bypass: 0, page: 1}).flatMap(le32);
    firmware = 'FM-1_977';
    await $('connect-btn').onclick();
    assert(document.querySelectorAll('#fx-mutes button:disabled').length === 0, '977: mutes settable');
    document.querySelector('#fx-mutes [data-mute="1"]').click();
    await until(() => muteSent, 'MUTE_SET sent');
    assert(muteSent.join() === '2,0', `PU2 muted, freeze off: ${muteSent}`);
    assert(!document.querySelector('#fx-mutes [data-mute="1"]').classList.contains('on'), 'PU2 shown muted');
    muteSent = null; radio('freeze', 1).click();
    await until(() => muteSent, 'Freeze sent');
    assert(muteSent.join() === '2,1', `Freeze keeps the mutes: ${muteSent}`);
    /* FM-1_979: echo send on FILTER K2, the filter type on LO-FI K3; FX and lights; FX panel colours;
       the wiring; a muted channel greyed with why; the battery */
    assert(document.querySelectorAll('[data-page="1"] .fx-row .fx-name')[1].textContent === 'Filter', '977: FILTER K2 is still the filter type');
    firmware = 'FM-1_979';
    await $('connect-btn').onclick();
    assert([...document.querySelectorAll('[data-page="1"] .fx-row .fx-name')].map(n => n.textContent).join() === 'Channel FX,Echo send,Cutoff,Resonance', '979: FILTER K2 = Echo send');
    assert([...document.querySelectorAll('[data-page="4"] .fx-row .fx-name')].map(n => n.textContent).join() === 'Crush,Decimate,Filter', '979: LO-FI K3 = filter type');
    assert(!$('feat-sec').hidden && $('feat-form').querySelectorAll('select').length === 9, 'FX and lights: nine switches (FX theme in Colours)');
    { const names = [...$('settings-form').querySelectorAll('select')].map(s => s.dataset.key), fxt = $('settings-form').querySelector('select[data-key="fxTheme"]');
      assert(names[names.indexOf('theme') + 1] === 'fxTheme', `FX panel colours right under Theme: ${names}`);
      assert(fxt.value === '0' && fxt.options.length > 90, 'FX panel colours: Match by default'); }
    assert($('fx-diagram').querySelector('svg.fxd') && $('fx-diagram').querySelectorAll('g.row').length === 4, 'Wiring drawn');
    liveMute = 1; cursor = 0; $('fx-follow').click();
    await until(() => !$('fx-muted').hidden, 'Muted notice');
    assert($('fx-muted').textContent.startsWith('PU1 is muted') && $('fx-pages').classList.contains('muted'), 'PU1 muted: notice and grey');
    assert($('fx-diagram').querySelector('g.row.muted[data-ch="0"]'), 'Wiring: PU1 muted');
    assert($('live-badges').textContent.includes('USB power'), 'Battery badge');
    liveMute = 0;
    await until(() => $('fx-muted').hidden, 'Notice gone when PU1 plays');
    const wrap = $('feat-form').querySelector('select[data-key="pageWrap"]'); wrap.value = '1'; wrap.onchange();
    $('settings-apply').onclick();
    await until(() => $('settings-status').textContent.includes('Applied'), 'Settings applied');
    assert(featWord === (0x460001CE | 1) >>> 0, `FEAT_SET with PAGE WRAP on: ${featWord.toString(16)}`);
    { const sets = featSets, fxt = $('settings-form').querySelector('select[data-key="fxTheme"]');
      fxt.value = '11'; fxt.onchange(); $('settings-apply').onclick();
      await until(() => featSets > sets, 'FX theme sent');
      assert(((featWord >>> 9) & 127) === 11 && (featWord & 1), `FX THEME = the 11th theme, PAGE WRAP kept: ${featWord.toString(16)}`); }
    assert([...document.querySelectorAll('#fx-master-pages .fx-row .fx-name')].map(n => n.textContent).join() === 'All FX,Compressor', '979: MASTER K3 / K4 blank');
    /* FM-1_980: MASTER K3 / K4 = echo mix and time, the same values as on ECHO (moving one moves the other) */
    firmware = 'FM-1_980';
    await $('connect-btn').onclick();
    assert([...document.querySelectorAll('#fx-master-pages .fx-row .fx-name')].map(n => n.textContent).join() === 'All FX,Compressor,Mix,Time', '980: MASTER echo mix, time');
    { const twins = [...document.querySelectorAll('.fx-ctl[data-key="mix"] input[type="range"]')];
      assert(twins.length === 2, `echo mix on MASTER and ECHO: ${twins.length}`);
      twins[0].value = '77'; twins[0].oninput();
      assert(twins[1].value === '77', `the ECHO page's mix follows: ${twins[1].value}`); }
    assert([...document.querySelectorAll('#fx-master-pages .fx-card')].map(c => c.dataset.page).join() === '0', '980: only MASTER in Master');
    assert(!$('settings-form').querySelector('select[data-key="autosave"]'), '980: no Autosave');
    /* FM-1_981: ECHO and ECHO MOD in the Master box; Autosave first in Settings (every minute by default) */
    firmware = 'FM-1_981';
    await $('connect-btn').onclick();
    assert([...document.querySelectorAll('#fx-master-pages .fx-card')].map(c => c.dataset.page).join() === '0,5,6', '981: MASTER, ECHO, ECHO MOD in Master');
    assert(![...document.querySelectorAll('#fx-pages .fx-card')].some(c => c.dataset.page === '5' || c.dataset.page === '6'), '981: no echo with the channel effects');
    { const first = $('settings-form').querySelector('select');
      assert(first.dataset.key === 'autosave' && first.value === '1', `981: Autosave first, every minute: ${first.dataset.key} ${first.value}`);
      assert($('feat-form').querySelectorAll('select').length === 9, 'FX and lights: still nine switches');
      const sets = featSets; first.value = '0'; first.onchange(); $('settings-apply').onclick();
      await until(() => featSets > sets, 'Autosave sent');
      assert((featWord >>> 16 & 3) === 1, `Autosave off: stored 1 (XOR 1): ${featWord.toString(16)}`); }
    /* the FM-1's screen above Effects: before FM-1_983 a note; FM-1_983 draws it */
    await until(() => !$('fm1-screen-note').hidden, '981: the screen note');
    assert($('fm1-screen-box').hidden && /FM-1_983 or newer.*FM-1_981/.test($('fm1-screen-note').textContent), `981: ${$('fm1-screen-note').textContent}`);
    firmware = 'FM-1_983';
    await $('connect-btn').onclick();
    const px = () => $('fm1-screen').getContext('2d').getImageData(80, 140, 1, 1).data;
    await until(() => px()[0] === 255 && px()[1] === 0 && px()[3] === 255, `983: the screen drawn (${px().join()})`);
    assert(!$('fm1-screen-box').hidden && $('fm1-screen-note').hidden, '983: the screen shown, no note');
    { const n = ops.filter(o => o === OP.SCREEN_ROW).length; $('fx-screen').open = false; await sleep(400); const m = ops.filter(o => o === OP.SCREEN_INFO).length;
      await sleep(400); assert(ops.filter(o => o === OP.SCREEN_INFO).length === m && n >= 144, `folded away: no more reads (${n} rows)`); $('fx-screen').open = true; }
    /* FM-1_985: one SCREEN_SYNC, the rows come by themselves (no SCREEN_ROW requests) */
    firmware = 'FM-1_985';
    { const rowsBefore = ops.filter(o => o === OP.SCREEN_ROW).length;
      await $('connect-btn').onclick();
      await until(() => px()[2] === 255 && px()[0] === 0 && px()[3] === 255, `985: the screen drawn from the rows sent (${px().join()})`);
      assert(ops.filter(o => o === OP.SCREEN_ROW).length === rowsBefore && ops.includes(OP.SCREEN_SYNC), '985: no row requests');
      const syncs = ops.filter(o => o === OP.SCREEN_SYNC).length; await sleep(300);
      const more = ops.filter(o => o === OP.SCREEN_SYNC).length - syncs;
      assert(more >= 2 && more <= 8, `985: nothing changed: a look every 50 ms or so (${more} in 300 ms)`); }
    firmware = 'FM-1_975';
    return 'PASS FX browser: matching pages (975-978, 979, 980 echo on MASTER, 981 echo in Master), FM-1 screen (983, 985 sync, note before), autosave, one master switch across four selected channels, LIVE state, 17/11-word backups, old firmware gating, FX and lights, FX colours, wiring, muted notice, battery';
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor);
    else delete navigator.requestMIDIAccess;
  }
}

/* Songs tab exports: effects alone, and "Export all" as one .zip of separate files. A mocked FM-1
   whose firmware cannot read its cartridge back: the .zip says so and holds the other two. */
export async function runExportUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  const realUrl = URL.createObjectURL, input = {name: 'FM-1 test'}, saved = [];
  const fxBytes = Array.from({length: 17}, (_, i) => i === 9 ? 0x00010205 : i === 10 ? 0x00F20000 : 0).flatMap(le32);   // target CUR, layout 2, page 1, mark
  const output = {name: 'FM-1 test', send(message) {
    const op = message[4], args = [];
    for (let i = 5; i < message.length - 1; i += 2) args.push(message[i] | message[i + 1] << 7);
    const send = (data = [], status = 0) => queueMicrotask(() => input.onmidimessage?.({
      data: [0xf0, 0x7d, 0x47, 0x53, op, status, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7]}));
    if (op === OP.INFO) { const info = Array(35).fill(0); info[0] = 1; [...'FM-1_979'].forEach((c, i) => info[1 + i] = c.charCodeAt(0)); return send(info); }
    if (op === OP.FX_GET) return send(fxBytes);
    if (op === OP.SETTINGS_GET) return send(le32(0x5a000000));
    if (op === OP.THEME_GET) return send(Array(16).fill(0));
    if (op === OP.FEAT_GET) return send(le32(0x460001CE));
    if (op === OP.MIDI_GET || op === OP.BLUETOOTH || op === OP.CART_INFO) return send([], 1);
    if (op === OP.READ) { const off = args[0] | args[1] << 8 | args[2] << 16; return send(Array.from({length: 128}, (_, i) => (off + i) & 255)); }
    if (op === OP.LIVE) return send([1, 0, 120, 0, 0, 0, 0, ...fxBytes, 0xFF]);
    if (op === OP.FX_SET || op === OP.STORE) return send();
    throw Error(`Unexpected device operation ${op}`);
  }};
  try {
    URL.createObjectURL = blob => { saved.push(blob); return realUrl.call(URL, blob); };
    HTMLAnchorElement.prototype.click = function () { saved[saved.length - 1].fileName = this.download; };
    Object.defineProperty(navigator, 'requestMIDIAccess', {configurable: true,
      value: async () => ({inputs: new Map([['test', input]]), outputs: new Map([['test', output]])})});
    await $('connect-btn').onclick();
    $('export-fx').onclick();
    await until(() => $('save-status').textContent.includes('Exported the effects'), 'Effects exported');
    const fxFile = JSON.parse(await saved.at(-1).text());
    assert(saved.at(-1).fileName === 'lsdj-burrito-effects.json' && fxFile.format === 'lsdj-burrito-fx' && fxFile.firmware === 'FM-1_979' &&
      fxFile.fx.length === 17 && unpackFx(fxFile.fx).v3, 'Effects file');
    $('export-all').onclick();
    await until(() => $('save-status').textContent.includes('in one .zip'), 'Export all', 400);
    const zip = new Uint8Array(await saved.at(-1).arrayBuffer());
    assert(/^lsdj-burrito-FM-1_979-\d{4}-\d\d-\d\d\.zip$/.test(saved.at(-1).fileName), saved.at(-1).fileName);
    const names = new TextDecoder().decode(zip);
    assert(names.includes('lsdj.sav') && names.includes('lsdj-burrito-effects.json') && !names.includes('lsdj-installed.gb'), 'Two files without readback');
    assert($('save-status').className === 'warn' && $('save-status').textContent.includes('installed LSDj was left out'), 'Says why the ROM is missing');
    assert(zip.length > 131072 && zip[30 + 'lsdj.sav'.length + 200] === 200, 'Songs stored whole');
    return 'PASS exports: effects file, Export all as a .zip of separate files (readback unavailable: left out, said)';
  } finally {
    URL.createObjectURL = realUrl; delete HTMLAnchorElement.prototype.click;
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor);
    else delete navigator.requestMIDIAccess;
  }
}
