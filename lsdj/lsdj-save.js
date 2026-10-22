// SPDX-License-Identifier: GPL-3.0-only
// LSDj .sav export/import over USB-MIDI (firmware/lsdj_sysex.h).
// `link` is a vendor/fm1ota.js Link: send(bytes) -> bool, read(ms) -> packet|null, drain().
import {crc32} from './lsdj-rom.js';

export const SAVE_SIZE = 131072;
const CHUNK = 128, OP = {info: 1, read: 2, begin: 3, chunk: 4, commit: 5, abort: 6};
const STATUS = ['ok', 'The FM-1 rejected the request.', 'The FM-1 is busy with another save transfer.',
  'The save did not arrive intact (CRC mismatch). Your previous song was kept.',
  'The FM-1 could not write its flash. Your previous song was kept.'];

const pack = bytes => { const out = []; for (const b of bytes) out.push(b & 127, b >> 7); return out; };
const le32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];

export function request(op, data = []) { return [0xf0, 0x7d, 71, 83, op, ...pack(data), 0xf7]; }

// Returns the reply's data bytes, null if the packet isn't our reply.
export function reply(packet, op) {
  if (!packet || packet.length < 7 || packet[0] !== 0xf0 || packet[1] !== 0x7d || packet[2] !== 71 || packet[3] !== 83 || packet[4] !== op) return null;
  if (packet.at(-1) !== 0xf7 || (packet.length - 7) % 2 || packet.slice(1, -1).some(b => b > 127)) throw Error('Malformed reply from the FM-1.');
  if (packet[5]) throw Error(STATUS[packet[5]] ?? 'The FM-1 returned an unknown error.');
  const out = new Uint8Array((packet.length - 7) / 2);
  for (let i = 0; i < out.length; i++) {
    if (packet[7 + 2 * i] > 1) throw Error('Malformed reply from the FM-1.');
    out[i] = packet[6 + 2 * i] | packet[7 + 2 * i] << 7;
  }
  return out;
}

async function exchange(link, op, data, {timeout = 1000, tries = 3} = {}) {
  const msg = request(op, data);
  for (let attempt = 0; attempt < tries; attempt++) {
    link.drain();
    if (!link.send(msg)) throw Error('USB disconnected.');
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const got = reply(await link.read(Math.max(1, Math.min(100, end - Date.now()))), op);
      if (got) return got;
    }
  }
  throw Error('The FM-1 did not answer. Is the LSDj firmware installed and the USB cable connected?');
}

const u32 = (b, i) => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;

export async function saveInfo(link) {
  const d = await exchange(link, OP.info);
  if (d.length !== 9) throw Error('Malformed reply from the FM-1.');
  return {size: u32(d, 0), crc: u32(d, 4), importing: !!d[8]};
}

// Reads LSDj's save memory as it is right now (including unsaved edits).
export async function exportSave(link, progress = () => {}) {
  // LSDj keeps running while we read, so check the snapshot against a fresh
  // CRC afterwards and read again if the song changed meanwhile.
  for (let attempt = 0; attempt < 3; attempt++) {
    const info = await saveInfo(link);
    if (info.size !== SAVE_SIZE) throw Error('Unexpected save size on the FM-1.');
    const out = new Uint8Array(info.size);
    for (let off = 0; off < info.size; off += CHUNK) {
      const d = await exchange(link, OP.read, le32(off));
      if (d.length !== CHUNK) throw Error('Malformed reply from the FM-1.');
      out.set(d, off); progress(off + CHUNK, info.size);
    }
    if (crc32(out) === (await saveInfo(link)).crc) return out;
  }
  throw Error('The song kept changing during export. Stop playback and export again.');
}

export function checkSav(bytes) {
  if (bytes.length !== SAVE_SIZE) throw Error('LSDj saves are exactly 128 KiB (131072 bytes).');
  if (bytes[0x813e] !== 0x6a || bytes[0x813f] !== 0x6b) throw Error('This file is not an LSDj save (no "jk" marker).');
}

// Replaces the FM-1's songs with `bytes`. The FM-1 stores the current song to
// flash first, so a failed or interrupted import leaves it unchanged.
export async function importSave(link, bytes, progress = () => {}) {
  checkSav(bytes);
  const crc = crc32(bytes);
  // BEGIN and COMMIT each write all 32 save blocks to flash: allow time for it.
  await exchange(link, OP.begin, [...le32(bytes.length), ...le32(crc)], {timeout: 20000, tries: 1});
  try {
    for (let off = 0; off < bytes.length; off += CHUNK) {
      await exchange(link, OP.chunk, [...le32(off), ...bytes.subarray(off, off + CHUNK)]);
      progress(off + CHUNK, bytes.length);
    }
    await exchange(link, OP.commit, [], {timeout: 20000, tries: 1});
  } catch (e) {
    try { await exchange(link, OP.abort, [], {tries: 1}); } catch {}
    throw e;
  }
  // COMMIT only succeeds after the FM-1 checked the CRC itself. No re-read here:
  // LSDj restarts with the import and may touch its save memory straight away.
  return {size: bytes.length, crc};
}
