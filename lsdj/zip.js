// SPDX-License-Identifier: GPL-3.0-only
// A ZIP of a few files, stored (no compression), for "Export all": one download holding
// separate files. files: [{name, bytes: Uint8Array}]. Returns the archive's bytes.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b) { let c = ~0; for (const v of b) c = CRC[(c ^ v) & 255] ^ (c >>> 8); return ~c >>> 0; }

export function zipStore(files, when = new Date()) {
  const enc = new TextEncoder(), parts = [], central = [];
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  let offset = 0;
  for (const {name, bytes} of files) {
    const n = enc.encode(name), crc = crc32(bytes);
    const head = new DataView(new ArrayBuffer(30));
    [[0, 0x04034B50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4],
     [18, bytes.length, 4], [22, bytes.length, 4], [26, n.length, 2], [28, 0, 2]]
      .forEach(([at, v, size]) => size === 4 ? head.setUint32(at, v, true) : head.setUint16(at, v, true));
    const dir = new DataView(new ArrayBuffer(46));
    [[0, 0x02014B50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4],
     [20, bytes.length, 4], [24, bytes.length, 4], [28, n.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2],
     [38, 0, 4], [42, offset, 4]]
      .forEach(([at, v, size]) => size === 4 ? dir.setUint32(at, v, true) : dir.setUint16(at, v, true));
    parts.push(new Uint8Array(head.buffer), n, bytes);
    central.push(new Uint8Array(dir.buffer), n);
    offset += 30 + n.length + bytes.length;
  }
  const dirSize = central.reduce((s, p) => s + p.length, 0), end = new DataView(new ArrayBuffer(22));
  [[0, 0x06054B50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, dirSize, 4], [16, offset, 4], [20, 0, 2]]
    .forEach(([at, v, size]) => size === 4 ? end.setUint32(at, v, true) : end.setUint16(at, v, true));
  const all = [...parts, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0; for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}
