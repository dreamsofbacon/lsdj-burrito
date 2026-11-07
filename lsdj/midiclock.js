// SPDX-License-Identifier: GPL-3.0-only
// MIDI sync from this page to the FM-1s (any firmware: no change needed). Each FM-1 already follows MIDI clock over
// USB: GLO › MIDI › CLOCK IN (ALL or USB), TRANSPORT (Start / Stop press LSDj's START) and SYNC DELAY (the FM-1 plays
// 50-100 ms behind the clock, which also smooths out the browser's timing). LSDj's PROJECT › SYNC must be MIDI.
//   startClock: the page is the clock. A tempo, Start / Stop / Continue, and 24 clocks a beat to every target, sent
//     with Web MIDI timestamps a little ahead (LOOKAHEAD_MS), so a busy page doesn't make the tempo wobble. The
//     scheduler is woken by a Worker: browsers slow a hidden tab's timers to once a second, not a Worker's messages.
//   startRelay: one FM-1 leads (LSDj SYNC = LSDJ, CLOCK OUT USB) and the page passes its clock and Start / Stop on to
//     the others as they arrive. The followers play a SYNC DELAY behind the leader.
// A target is anything with send(data, timestamp) (a Web MIDI output); one whose send throws is dropped. A target
// added with {timed: false} ignores timestamps (the virtual FM-1's output): it gets each message when it is due.
export const PPQN = 24;
export const CLOCK = 0xF8, START = 0xFA, CONTINUE = 0xFB, STOP = 0xFC;
export const MIN_BPM = 40, MAX_BPM = 295;   /* LSDj's tempo range */
export const LOOKAHEAD_MS = 100;            /* clocks are scheduled this far ahead */
export const WAKE_MS = 25;                  /* the scheduler wakes this often */
export const START_LEAD_MS = 20;            /* Start goes out this far ahead, so every target gets it in time */
export const clampBpm = bpm => Math.min(MAX_BPM, Math.max(MIN_BPM, Number.isFinite(+bpm) ? +bpm : 120));
export const clockMs = bpm => 60000 / (clampBpm(bpm) * PPQN);

/* A timer that keeps running in a hidden tab: a Worker posting every ms; setInterval if there are no Workers. */
export function workerTimer(f, ms, {Worker: W = globalThis.Worker, Blob: B = globalThis.Blob, URL: U = globalThis.URL} = {}) {
  if (W && B && U?.createObjectURL) {
    try {
      const url = U.createObjectURL(new B([`setInterval(() => postMessage(0), ${ms | 0});`], {type: 'text/javascript'}));
      const w = new W(url);
      w.onmessage = () => f();
      return () => { w.terminate(); U.revokeObjectURL?.(url); };
    } catch { /* fall back */ }
  }
  const id = setInterval(f, ms);
  return () => clearInterval(id);
}

/* targets: Map target -> {timed}. ts undefined: now, to all; else only the timed ones, scheduled at ts. */
function sendAll(targets, data, ts) {
  for (const [t, o] of [...targets]) {
    if (ts !== undefined && !o.timed) continue;
    try { if (ts === undefined) t.send(data); else t.send(data, ts); } catch { targets.delete(t); }
  }
}
function sendUntimed(targets, data) {
  for (const [t, o] of [...targets]) { if (o.timed) continue; try { t.send(data); } catch { targets.delete(t); } }
}
const asMap = targets => new Map([...targets].map(t => [t, {timed: true}]));

/* The page as the clock. Returns {start, stop, cont, setTempo, addTarget, removeTarget, running, bpm, ticks, close}.
   now: the clock Web MIDI timestamps use (performance.now); timer(f, ms) -> cancel (workerTimer). */
export function startClock({bpm = 120, targets = [], now = () => performance.now(), timer = workerTimer,
                            lookahead = LOOKAHEAD_MS, onState = () => {}} = {}) {
  const outs = asMap(targets);
  let tempo = clampBpm(bpm), running = false, nextAt = 0, ticks = 0, closed = false;
  let due = [];   /* [at, byte] scheduled for the timed targets, not yet sent to the untimed ones */
  const flush = t => {
    let i = 0;
    while (i < due.length && due[i][0] <= t) sendUntimed(outs, [due[i++][1]]);
    if (i) due = due.slice(i);
  };
  const emit = (byte, at) => { sendAll(outs, [byte], at); due.push([at, byte]); };
  const pump = () => {
    if (!running || closed) return;
    const t = now(), period = clockMs(tempo);
    if (nextAt < t - period) { nextAt = t; }   /* the page was frozen: carry on from now, never a burst of clocks */
    while (nextAt < t + lookahead) { emit(CLOCK, nextAt); nextAt += period; ticks++; }
    flush(t);
  };
  const cancel = timer(pump, WAKE_MS);
  const begin = byte => {
    if (closed) return;
    const at = now() + START_LEAD_MS;
    if (byte === START) ticks = 0;
    running = true; nextAt = at;
    emit(byte, at);
    pump(); onState(true);
  };
  return {
    start() { if (!running) begin(START); },
    cont() { if (!running) begin(CONTINUE); },
    stop() {
      if (closed) return;
      const was = running; running = false; due = [];
      sendAll(outs, [STOP]);   /* at once; the few clocks already scheduled only keep the tempo */
      if (was) onState(false);
    },
    setTempo(b) { tempo = clampBpm(b); pump(); return tempo; },
    addTarget(t, {timed = true} = {}) { if (t) outs.set(t, {timed}); },   /* joins at the next clock (Start: next start) */
    removeTarget(t) { outs.delete(t); },
    get running() { return running; },
    get bpm() { return tempo; },
    get ticks() { return ticks; },                 /* clocks since Start: ticks / PPQN beats */
    close() { if (closed) return; if (running) this.stop(); closed = true; cancel(); outs.clear(); },
  };
}

/* One FM-1 leads: feed(data) every message from the leader's input; clock and Start / Continue / Stop go on to the
   targets at once (anything else stays). Returns {feed, addTarget, removeTarget, close}. */
export function startRelay({targets = []} = {}) {
  const outs = asMap(targets);
  let closed = false;
  return {
    feed(data) {
      if (closed || !data?.length) return false;
      const b = data[0];
      if (b !== CLOCK && b !== START && b !== CONTINUE && b !== STOP) return false;
      sendAll(outs, [b]);
      return true;
    },
    addTarget(t, {timed = true} = {}) { if (t) outs.set(t, {timed}); },
    removeTarget(t) { outs.delete(t); },
    close() { closed = true; outs.clear(); },
  };
}
