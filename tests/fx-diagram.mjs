// SPDX-License-Identifier: GPL-3.0-only
// lsdj/fx-diagram.js: the wiring follows the effects setup (lit, grey, sends, LFO to the cutoff).
import assert from 'node:assert/strict';
import {unpackFx} from '../lsdj/fx-model.js';
import {fxDiagram} from '../lsdj/fx-diagram.js';

const words = () => { const b = Array(68).fill(0); b[37] = 2; b[38] = 1; b[42] = 0xf2;
  return Array.from({length: 17}, (_, i) => (b[4 * i] | b[4 * i + 1] << 8 | b[4 * i + 2] << 16 | b[4 * i + 3] << 24) >>> 0); };
const count = (svg, re) => (svg.match(re) || []).length;

let fx = unpackFx(words());
let svg = fxDiagram(fx);
assert.match(svg, /^<svg class="fxd"/);
assert.equal(count(svg, /<g class="row"/g), 4);                 // four channels, nothing grey
assert.equal(count(svg, /class="blk on"/g), 0);                 // a clean setup: nothing lit
assert.match(svg, /mix 0: off/);
for (const name of ['PU1', 'PU2', 'WAV', 'NOI', 'DRIVE', 'FILTER', 'LO-FI', 'LFO', 'ECHO', 'COMP', 'OUT']) assert.ok(svg.includes(name), name);

fx.ch[1].type = 1; fx.ch[1].cutoff = 0x40; fx.ch[1].send = 0x20; fx.q[1].lfoDepth = 9; fx.q[1].lfoDest = 0;
fx.ch[2].drive = 8; fx.q[2].dist = 3; fx.echo.mix = 80; fx.comp = 0x30;
svg = fxDiagram(fx, {mute: 1});
assert.match(svg, /<g class="row muted" data-ch="0">/);       // PU1 muted
assert.match(svg, /LP 64/); assert.match(svg, /FUZZ 8/); assert.match(svg, /send 32/);
assert.equal(count(svg, /class="send"/g), 1);                   // one send, the echo on: solid
assert.equal(count(svg, /class="mod"/g), 1);                    // LFO to the cutoff
assert.match(svg, /MIX 80/); assert.match(svg, />48</);
assert.match(svg, /aria-label="Effects wiring\. PU1 muted; PU2; WAV; NOI\. Echo on, compressor on\."/);

fx.fxOff = 4;                                                   // WAV dry
svg = fxDiagram(fx);
assert.match(svg, /<g class="row dry" data-ch="2">/);
fx.echo.mix = 0;
assert.match(fxDiagram(fx), /class="send idle"/);               // a send into a silent echo: dashed
fx.bypass = 1;
assert.match(fxDiagram(fx), /^<svg class="fxd bypass"[\s\S]*ALL FX OFF/);
console.log('PASS FX wiring: rows, lit blocks, mutes, dry channels, sends, LFO to the cutoff, echo, compressor, All FX off');

/* both directions, the phone's narrower one, and every block naming its page */
import {pageFor} from '../lsdj/fx-diagram.js';
fx = unpackFx(words()); fx.ch[3].drive = 5; fx.echo.mix = 10;
const v = fxDiagram(fx), h = fxDiagram(fx, {layout: 'h'}), vc = fxDiagram(fx, {compact: true});
assert.match(v, /data-layout="v" viewBox="0 0 600 /); assert.match(h, /data-layout="h" viewBox="0 0 720 /); assert.match(vc, /data-layout="vc" viewBox="0 0 420 /);
for (const svg of [v, h, vc]) {
  assert.equal(count(svg, /data-go="(drive|filter|lofi|lfo)" data-ch="[0-3]"/g), 16);   // four per channel
  assert.equal(count(svg, /data-go="echo"/g), 1); assert.equal(count(svg, /data-go="comp"/g), 1);
  assert.equal(count(svg, /role="button" tabindex="0"/g), 18);
  assert.match(svg, /aria-label="Drive NOI: SOFT 5\. Open its page"/);
  assert.equal(count(svg, /<g class="row/g), 4);
}
assert.match(vc, />MIX 10</); assert.match(vc, />FB 0</);           // the phone's echo: a line each
assert.match(h, /MIX 10 FB 0/);
assert.deepEqual(['drive', 'filter', 'lofi', 'lfo', 'echo', 'comp'].map(g => pageFor(g)), ['DRIVE', 'FILTER', 'LO-FI', 'LFO', 'ECHO', 'MASTER']);
assert.deepEqual(['drive', 'comp'].map(g => pageFor(g, true)), ['TONE', 'TONE']);
assert.ok(!/<text[^>]*>[^<]*["<>&][^<]*<\/text>/.test(v));             // text escaped
console.log('PASS FX wiring directions: upright, across, phone; every block opens its page (data-go), keyboard reachable');
