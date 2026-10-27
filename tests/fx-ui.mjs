// SPDX-License-Identifier: GPL-3.0-only
import {OP, le32} from '../lsdj/link.js';
import {unpackFx, packFx} from '../lsdj/fx-model.js';

const $ = id => document.getElementById(id);
const assert = (v, message) => { if (!v) throw Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  for (let n = 0; n < 80; n++) { if (check()) return; await sleep(50); }
  throw Error(message);
}
export async function runFxUiTests() {
  assert(['localhost', '127.0.0.1'].includes(location.hostname), 'Use a fresh local preview, never a real device');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'requestMIDIAccess');
  const input = {name: 'FM-1 test'}, ops = [];
  let bytes = Array(68).fill(0), writes = 0, cursor = 0, firmware = 'FM-1_975', muteSent = null;
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
    if (op === OP.LIVE) return send([bytes[38], cursor, 120, 0, 0, 0, 0, ...bytes]);
    if (op === OP.MUTE_SET) { muteSent = args; return send(); }
    if ([OP.STORE, OP.THEME_SET, OP.SETTINGS_SET].includes(op)) return send();
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
    assert(headings.join(',') === 'MASTER,ECHO,ECHO MOD,FILTER,DRIVE,LFO,LO-FI', 'Master pages first, then channel pages');
    assert([...document.querySelectorAll('#fx-master-pages .fx-card')].map(c => c.dataset.page).join() === '0,5,6', 'Shared pages in Master');
    assert([...document.querySelectorAll('#fx-pagebar [data-page]')].map(b => b.dataset.page).join() === '1,2,3,4', 'Page bar: channel pages only');
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
      OP.THEME_GET, OP.THEME_SET, OP.MIDI_GET, OP.BLUETOOTH, OP.LIVE, OP.STORE].includes(op)), 'Only simulated settings operations');
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
    firmware = 'FM-1_975';
    return 'PASS FX browser: matching pages, one master switch across four selected channels, LIVE state, 17/11-word backups and old firmware gating';
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'requestMIDIAccess', descriptor);
    else delete navigator.requestMIDIAccess;
  }
}
