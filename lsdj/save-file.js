// SPDX-License-Identifier: GPL-3.0-only
import {LinkError, SAVE_SIZE} from './link.js';

export function confirmSaveImport(bytes, fileName, confirmImport) {
  if (!(bytes instanceof Uint8Array)) throw new LinkError('Expected save-file bytes.');
  const extra = bytes.length - SAVE_SIZE;
  if (extra !== 0 && extra !== 16)
    throw new LinkError(`An LSDj save is 128 KiB (${SAVE_SIZE} bytes); ${fileName} is ${bytes.length}. ` +
      'Only raw saves or saves with exactly 16 extra trailing bytes are supported.');

  const warning = extra ? `\n\nThis file has 16 extra trailing bytes. Their format has not been verified. ` +
    `Import ONLY the first ${SAVE_SIZE} bytes and exclude the final 16 bytes? ` +
    'Use this only if those first bytes are the raw LSDj save, not a file with a leading header. ' +
    'Your original file will not be changed.' : '';
  if (!confirmImport(`Replace the songs on the FM-1 with ${fileName}? Export first if you want to keep them.${warning}`))
    return null;
  return bytes.slice(0, SAVE_SIZE);
}
