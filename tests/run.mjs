// SPDX-License-Identifier: GPL-3.0-only
// Every Node test (node tests/run.mjs): each file in its own process, a line each, a non-zero exit if any fails.
// The *-ui.mjs and fx-shot.mjs files run in a local preview page, not here.
import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(dir).filter(f => f.endsWith('.mjs') && f !== 'run.mjs' && !f.endsWith('-ui.mjs') && f !== 'fx-shot.mjs').sort();
let failed = 0;
for (const f of files) {
  const t = Date.now(), r = spawnSync(process.execPath, [f], {cwd: dir, encoding: 'utf8', timeout: 300000});
  const ok = r.status === 0;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f.padEnd(22)} ${((Date.now() - t) / 1000).toFixed(1)} s`);
  if (!ok) { failed++; console.log((r.stdout + r.stderr).trim().split('\n').slice(-15).map(l => '     ' + l).join('\n')); }
}
console.log(`${files.length - failed} of ${files.length} passed`);
process.exit(failed ? 1 : 0);
