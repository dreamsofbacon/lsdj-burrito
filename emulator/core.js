// SPDX-License-Identifier: GPL-3.0-only
import {checkPackage} from '../lsdj/install.js';
import {sha256hex} from '../vendor/fm1pkg.js';

export function firmwareForEmulator(bytes) {
  if (!(bytes instanceof Uint8Array)) throw Error('Choose an FM-1 .fwsc package.');
  const checked = checkPackage(bytes);
  return {bytes: bytes.slice(), product: checked.product};
}

export async function loadRuntime(fetcher = fetch) {
  const get = async path => {
    const response = await fetcher(new URL(path, import.meta.url), {signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw Error(`Emulator asset unavailable (${response.status}): ${path}`);
    return response;
  };
  const metadata = await (await get('upstream.json')).json();
  const wasm = await (await get('vendor/fm1_web.wasm')).arrayBuffer();
  if (await sha256hex(wasm) !== metadata.fm1Emu.wasmSha256)
    throw Error('FM-1 emulator runtime integrity check failed.');
  return wasm;
}

// FM-1 matrix IDs, not Game Boy button bits. These press the firmware's own keys.
export const KEY_IDS = {
  ArrowLeft: 14, ArrowRight: 21, ArrowUp: 17, ArrowDown: 18,
  KeyZ: 38, KeyX: 40, Enter: 26, ShiftLeft: 25, ShiftRight: 25
};
