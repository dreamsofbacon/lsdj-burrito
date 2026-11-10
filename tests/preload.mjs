// SPDX-License-Identifier: GPL-3.0-only
// index.html's modulepreload links name exactly the modules its module scripts import at start (node tests/preload.mjs).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, dirname, normalize, relative} from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(join(root, 'index.html'), 'utf8');
const entries = [...html.matchAll(/<script type="module" src="([^"]+)"/g)].map(m => m[1]);
const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map(m => m[1]);
const seen = new Set(), todo = [...entries];
while (todo.length) {
  const f = todo.shift();
  if (seen.has(f)) continue;
  seen.add(f);
  for (const m of readFileSync(join(root, f), 'utf8').matchAll(/^\s*import\s(?:[^;]*?from\s+)?'(\.[^']+)'/gm))
    todo.push(relative(root, normalize(join(root, dirname(f), m[1]))).split('\\').join('/'));
}
const want = [...seen].filter(f => !entries.includes(f)).sort();
assert.equal(new Set(preloaded).size, preloaded.length, 'no module preloaded twice');
assert.deepEqual([...preloaded].sort(), want, 'modulepreload must list every module imported at start (and nothing else)');
console.log(`PASS preload: ${want.length} modules preloaded for ${entries.length} entry scripts`);
