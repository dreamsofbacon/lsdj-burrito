// SPDX-License-Identifier: GPL-3.0-only
// installOn (the DJ crate): the unchanged install() runs on one FM-1 while others stay plugged in. Pretend FM-1s
// on pretend MIDI ports answer the identity query, stage, restart into update mode (new ports), write and restart
// (new ports again), as the FM-1's USB updater does. Nothing may ever be sent to an avoided port.
import assert from 'node:assert/strict';
import {install, installOn, accessWithout} from '../lsdj/install.js';
import {pack7, unpack7, HS_QUERY, STAGE_DONE, WRITE_DONE} from '../vendor/fm1ota.js';

const PRODUCT = 'FM-1_537000998';
let nextId = 1;
const access = {inputs: new Map(), outputs: new Map()};

function identity(text) {
  const d = [0, 0x59, 0x11, 0, 0, 0, ...[...text.padEnd(27, '\0')].map(c => c.charCodeAt(0)), 0];
  return [0xf0, ...pack7(d), 0xf7];
}
function request(addr, len) {
  const u = [0, 0x59, 0x30, 15, 0, 0, 0, addr & 255, addr >>> 8 & 255, addr >>> 16 & 255, addr >>> 24, len & 255, len >>> 8 & 255, 0];
  u.push(~u.slice(6).reduce((n, b) => n + b, 0) & 255);
  return [0xf0, ...pack7(u), 0xf7];
}
const isSuccess = m => { const u = unpack7(m.slice(1, -1)); return u[1] === 0x59 && u[2] === 0x30 && String.fromCharCode(...u.slice(14, 21)) === 'success'; };
const later = (f, ms = 1) => setTimeout(f, ms);

/* one pretend FM-1: mode 'app' | 'ota'; every message sent to any of its ports is kept in .got */
function fm1(name, text) {
  const dev = {name, text, mode: text.startsWith('ota') ? 'ota' : 'app', got: [], ports: null, upgraded: false};
  dev.plug = () => {
    const input = {id: `in${nextId}`, name: dev.name, state: 'connected', listeners: new Set(), onmidimessage: null,
      open: async () => {}, addEventListener(t, f) { this.listeners.add(f); }, removeEventListener(t, f) { this.listeners.delete(f); }};
    const output = {id: `out${nextId++}`, name: dev.name, state: 'connected', open: async () => {}, send: m => { dev.got.push(m); dev.hear(m); }};
    const emit = data => later(() => { if (input.state !== 'connected') return; const ev = {data}; input.listeners.forEach(f => f(ev)); input.onmidimessage?.(ev); });
    dev.ports = {input, output, emit};
    access.inputs.set(input.id, input); access.outputs.set(output.id, output);
  };
  dev.unplug = () => {
    if (!dev.ports) return;
    for (const p of [dev.ports.input, dev.ports.output]) p.state = 'disconnected';
    access.inputs.delete(dev.ports.input.id); access.outputs.delete(dev.ports.output.id);
    dev.ports = null;
  };
  dev.hear = m => {
    const {emit} = dev.ports;
    if (m.join() === HS_QUERY.join()) return emit(identity(dev.text));
    if (m.length === 6 && m[1] === 0x22) {   /* UPGRADE: read some, then ask for success */
      const done = dev.mode === 'app' ? STAGE_DONE : WRITE_DONE;
      emit(request(0, 256)); later(() => emit(request(done, 8)), 5);
      return;
    }
    if (isSuccess(m)) {   /* the update loader's "success": restart, on new ports */
      if (dev.mode === 'app') { dev.unplug(); dev.text = 'ota-FM-1_1'; dev.mode = 'ota'; later(dev.plug, 300); }
      else { dev.unplug(); dev.text = PRODUCT; dev.mode = 'app'; dev.upgraded = true; later(dev.plug, 300); }
    }
  };
  dev.plug();
  return dev;
}
const pkg = {product: PRODUCT, image: new Uint8Array(4096).fill(7)};
const reset = () => { access.inputs.clear(); access.outputs.clear(); };
const ids = d => ({input: d.ports.input.id, output: d.ports.output.id});
const avoidOf = (...ds) => ds.flatMap(d => [d.ports.input.id, d.ports.output.id]);

/* the view: avoided ports are gone from it; new ports show up */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), b = fm1('FM-1', 'FM-1_996');
  const view = accessWithout(access, avoidOf(b));
  assert.deepEqual([...view.inputs.keys()], [a.ports.input.id]);
  const c = fm1('FM-1', 'FM-1_996');
  assert.deepEqual([...view.outputs.keys()], [a.ports.output.id, c.ports.output.id]);
}

/* why: the normal install refuses with two FM-1s plugged in (and that stays so) */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), b = fm1('FM-1', 'FM-1_996');
  await assert.rejects(install(access, pkg), /More than one FM-1/);
  assert.equal(a.upgraded || b.upgraded, false);
}

/* deck A's FM-1 is updated; B (playing) never hears a byte */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), b = fm1('FM-1', 'FM-1_996');
  const steps = [];
  const r = await installOn(access, pkg, {target: ids(a), avoid: avoidOf(b), onStep: s => steps.push(s)});
  assert.deepEqual(r, {id: PRODUCT, confirmed: true});
  assert.equal(a.upgraded, true);
  assert.deepEqual(b.got, [], 'nothing is sent to the other FM-1');
  assert.deepEqual(steps, ['found', 'stage', 'loader', 'write', 'restart', 'done']);
  assert.equal(b.text, 'FM-1_996');
}

/* the chosen ports aren't the FM-1 that answers: nothing installed, no UPGRADE sent */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), b = fm1('FM-1', 'FM-1_996');
  await assert.rejects(installOn(access, pkg, {target: {input: 'gone-in', output: 'gone-out'}, avoid: avoidOf(b)}), /different FM-1.*Nothing was installed/);
  assert.equal(a.upgraded, false);
  assert.ok(a.got.every(m => m.join() === HS_QUERY.join()), 'only asked who it is');
  assert.deepEqual(b.got, []);
}

/* the other FM-1 not avoided: the install's own guard refuses */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), b = fm1('FM-1', 'FM-1_996');
  await assert.rejects(installOn(access, pkg, {target: ids(a), avoid: []}), /More than one FM-1/);
  assert.equal(a.upgraded || b.upgraded, false);
}

/* an FM-1 already in update mode: left for Install */
{
  reset();
  const o = fm1('FM-1', 'ota-FM-1_1'), b = fm1('FM-1', 'FM-1_996');
  await assert.rejects(installOn(access, pkg, {target: ids(o), avoid: avoidOf(b)}), /update mode.*Nothing was installed/);
  assert.equal(o.got.filter(m => m.length === 6).length, 0, 'no UPGRADE');
}

/* the target among the avoided ports, or none: refused before anything is sent */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996');
  await assert.rejects(installOn(access, pkg, {target: ids(a), avoid: avoidOf(a)}), /in use elsewhere/);
  await assert.rejects(installOn(access, pkg, {avoid: []}), /No FM-1 chosen/);
  assert.deepEqual(a.got, []);
}

/* the other FM-1 unplugged during the install: done, but not confirmed as deck A's */
{
  reset();
  const a = fm1('FM-1', 'FM-1_996'), b = fm1('FM-1', 'FM-1_996');
  const r = await installOn(access, pkg, {target: ids(a), avoid: avoidOf(b), onStep: s => { if (s === 'write') b.unplug(); }});
  assert.deepEqual(r, {id: PRODUCT, confirmed: false});
  assert.deepEqual(b.got, []);
}
console.log('install-target: PASS (the targeted install: only the chosen FM-1 hears anything; the normal install unchanged)');
