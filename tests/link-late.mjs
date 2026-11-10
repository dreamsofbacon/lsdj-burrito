// SPDX-License-Identifier: GPL-3.0-only
// A LIVE answered late (after its request gave up) must not be taken as the answer to the next LIVE: it carries
// what was true before (Colin's flaky DJ mutes: an old mute mask). The next LIVE waits for it and drops it.
import assert from 'node:assert/strict';
import {Link, OP} from '../lsdj/link.js';

const input = {onmidimessage: null};
let mute = 8, delays = [1700, 1000, 0];   /* the first LIVE answered 1.7 s late (its timeout: 1.5 s), the next slowly too */
const output = {send(m) {
  if (m[4] !== OP.LIVE) return;
  const data = [1, 1, 120, 0, mute, 0, 0, ...Array(68).fill(0)];   /* what is true now */
  const reply = [0xf0, 0x7d, 0x47, 0x53, OP.LIVE, 0, ...data.flatMap(b => [b & 127, b >> 7]), 0xf7];
  setTimeout(() => input.onmidimessage?.({data: reply}), delays.shift() ?? 0);
}};
const link = new Link(input, output);
await assert.rejects(link.live(), /did not answer/);   /* asked while NOI was muted; gave up */
mute = 0;                                                /* NOI unmuted meanwhile */
const l = await link.live();
assert.equal(l.mute, 0, 'the next LIVE gets its own answer, not the late one (which said NOI muted)');
const l2 = await link.live();
assert.equal(l2.mute, 0);
/* a LIVE lost for good: the next one waits at most LIVE_DRAIN_MS, then asks */
delays = [1e9, 0];
await assert.rejects(link.live(), /did not answer/);
const t0 = Date.now(); await link.live();
assert.ok(Date.now() - t0 < 1500, `a lost reply holds the next LIVE up at most a moment: ${Date.now() - t0} ms`);
link.close();
console.log('link-late: PASS (a late LIVE reply dropped, not taken as the next one; a lost one holds up the next at most 1 s)');
