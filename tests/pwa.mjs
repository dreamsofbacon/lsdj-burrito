// SPDX-License-Identifier: GPL-3.0-only
// The installable app: the manifest and its icons, and sw.js storing exactly the site's files
// (everything but tests/, README.md and .nojekyll), so a new file can't be left out of offline use.
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, relative} from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const m = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
assert.equal(m.display, 'standalone'); assert.equal(m.scope, './'); assert.ok(m.start_url.startsWith('./'));
const pngSize = f => { const b = readFileSync(join(root, f)); assert.equal(b.toString('latin1', 1, 4), 'PNG', f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
for (const i of m.icons) assert.deepEqual(pngSize(i.src), i.sizes.split('x').map(Number), i.src);
for (const s of [192, 512]) assert.ok(m.icons.some(i => i.sizes === `${s}x${s}` && !i.purpose), `a ${s}px icon`);
assert.ok(m.icons.some(i => i.purpose === 'maskable'));

const html = readFileSync(join(root, 'index.html'), 'utf8');
assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
assert.match(html, /<script type="module" src="lsdj\/pwa\.js"><\/script>/);
assert.match(html, /id="install-app"[^>]* hidden/);

const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const listed = [...sw.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(x => x[1]).filter(f => f !== './');
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [relative(root, p).split('\\').join('/')]; });
const site = walk(root).filter(f => !/^(\.git\/|tests\/)/.test(f) && !['README.md', '.nojekyll', 'sw.js'].includes(f)).sort();
assert.deepEqual([...listed].sort(), site, 'sw.js FILES must list every site file');
console.log(`PASS installable app: manifest, ${m.icons.length} icons, offline copy of all ${site.length} site files`);
