// SPDX-License-Identifier: GPL-3.0-only
// Sounds for a kit, in the browser: decode any sound file the browser can open (WAV, AIFF, MP3...), mix it to
// mono and resample it to LSDj's 11468 Hz (5734 Hz for half speed) with the Web Audio API; play a kit sample
// back. The kit maths (normalise, trim, 4-bit, building the bank) is lsdj-kit.js.
import {SAMPLE_RATE} from './lsdj-kit.js';

/* a sound file -> {pcm: Float32Array at rate, seconds}. pitch: semitones up (shorter) or down. */
export async function decodeSound(bytes, {halfSpeed = false, pitch = 0} = {}) {
  const ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
  let buf;
  try { buf = await ctx.decodeAudioData(bytes.slice().buffer); }
  catch { throw Error('This browser can\'t open that sound file. Try a WAV.'); }
  finally { ctx.close?.(); }
  const rate = halfSpeed ? SAMPLE_RATE / 2 : SAMPLE_RATE, speed = 2 ** (pitch / 12);
  const length = Math.max(1, Math.ceil(buf.duration * rate / speed));
  /* OfflineAudioContext can't run below 3000 Hz in some browsers: render at twice the rate and take every other */
  const factor = rate < 8000 ? 2 : 1;
  const off = new OfflineAudioContext(1, length * factor, rate * factor);
  const src = off.createBufferSource();
  src.buffer = buf; src.playbackRate.value = speed;
  src.connect(off.destination); src.start();
  const out = (await off.startRendering()).getChannelData(0);
  const pcm = factor === 1 ? out.slice() : Float32Array.from({length}, (_, i) => out[i * 2]);
  return {pcm, seconds: length / rate};
}

/* play 4-bit values (as LSDj would) */
let player = null;
export function playNibbles(nibbles, {halfSpeed = false} = {}) {
  player?.stop?.();
  const ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
  const step = halfSpeed ? 2 : 1;
  const b = ctx.createBuffer(1, nibbles.length * step, SAMPLE_RATE);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (nibbles[Math.floor(i / step)] - 7.5) / 7.5 * 0.5;
  const s = ctx.createBufferSource();
  s.buffer = b; s.connect(ctx.destination); s.start();
  s.onended = () => ctx.close();
  player = s;
}
