// SPDX-License-Identifier: GPL-3.0-only
// lsdj/link.js: one request at a time, and a set made while playing (a kill, a knob, the crossfader) goes before
// the reads already waiting, never into the middle of the one under way (node tests/link-priority.mjs).
import assert from 'node:assert/strict';
import {Link, OP} from '../lsdj/link.js';

const input = {onmidimessage: null}, sent = [];
let inFlight = 0;
const output = {send(m) {
  sent.push(m[4]); inFlight++;
  assert.equal(inFlight, 1, 'one request on the link at a time');
  const data = m[4] === OP.LIVE ? Array(80).fill(0) : m[4] === OP.SONG_ROWS ? [m[5], ...Array(64).fill(0xff)] : [0, 0, 0, 0];
  const reply = [0xf0, 0x7d, 0x47, 0x53, m[4], 0, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7];
  setTimeout(() => { inFlight--; input.onmidimessage?.({data: reply}); }, 20);
}};
const link = new Link(input, output);
const done = Promise.all([link.live(), link.songRows(0), link.settingsGet(), link.muteSet(1, 0), link.fxSet([0, 0]), link.volumeSet(64)]);
await done;
assert.deepEqual(sent, [OP.LIVE, OP.MUTE_SET, OP.FX_SET, OP.VOLUME_SET, OP.SONG_ROWS, OP.SETTINGS_GET],
  `the LIVE under way first, then the sets in order, then the waiting reads: ${sent.map(o => o.toString(16))}`);
/* a failed request doesn't stop the queue */
const realSend = output.send;
output.send = m => { if (m[4] === OP.STORE) throw Error('cable'); realSend(m); };
await assert.rejects(link.store(), /cable/);
await link.settingsGet();
link.close();
console.log('link-priority: PASS (one at a time; sets before waiting reads, in order; a failed request lets the next go)');
