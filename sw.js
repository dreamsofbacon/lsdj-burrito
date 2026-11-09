// SPDX-License-Identifier: GPL-3.0-only
// Offline copy for the installed app (lsdj/pwa.js registers it). Online, every file comes from the
// network as usual, so updates show at once; each answer is also kept, and when the network is
// gone the kept copy is used. FILES is the whole site (tests/pwa.mjs checks it matches), stored on
// install so everything works offline from the start. No ROM or song is ever stored here.
/* One cache per site: the live page and the dev page (/lsdj-burrito-dev/) share dreamsofbacon.github.io,
   so each keeps its own and only ever clears its own older ones (and the first, unnamed burrito-v1). */
const SCOPE = self.registration.scope, CACHE = 'burrito-v2 ' + SCOPE;
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'manifest-dev.webmanifest', 'favicon.ico', 'LICENSE',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
  'licenses/Apache-2.0.txt', 'licenses/GPL-3.0.txt', 'licenses/MIT-Peanut-GB.txt', 'licenses/OFL-IBM-Plex.txt', 'licenses/OFL-Silkscreen.txt',
  'fonts/Silkscreen-Regular-Latin.woff2', 'fonts/IBMPlexSans-Regular-Latin1.woff2', 'fonts/IBMPlexSans-SemiBold-Latin1.woff2', 'fonts/IBMPlexSans-Bold-Latin1.woff2',
  'fonts/IBMPlexMono-Regular-Latin1.woff2', 'fonts/IBMPlexMono-SemiBold-Latin1.woff2',
  'lsdj/app.js', 'lsdj/fx-diagram.js', 'lsdj/fx-model.js', 'lsdj/gamepad.js', 'lsdj/install-ui.js', 'lsdj/install.js', 'lsdj/link.js',
  'lsdj/lsdj-app.js', 'lsdj/lsdj-firmware.js', 'lsdj/lsdj-rom.js', 'lsdj/midiclock.js', 'lsdj/dj.js', 'lsdj/dj-ui.js', 'lsdj/mixers.js', 'lsdj/crate.js', 'lsdj/crate-ui.js', 'lsdj/conn-log.js', 'lsdj/page-theme.js', 'lsdj/popout.js', 'lsdj/pwa.js',
  'lsdj/save-file.js', 'lsdj/screen.js', 'lsdj/ui.js', 'lsdj/zip.js',
  'lsdj/lsdj-sav.js', 'lsdj/lsdj-kit.js', 'lsdj/lsdj-usage.js', 'lsdj/songs-ui.js', 'lsdj/kits-ui.js', 'lsdj/wav-kit.js',
  'lsdj/lsdj-sets.js', 'lsdj/kit-library.js', 'lsdj/sets-ui.js',
  'lsdj/template.json', 'lsdj/versions.json', 'lsdj/fm1-lsdj-template.fwsc', 'lsdj/fm1-lsdj-template-source.zip',
  'vendor/fm1ota.js', 'vendor/fm1pkg.js',
  'emulator/app.js', 'emulator/core.js', 'emulator/panel.js', 'emulator/face.js', 'emulator/save-flash.js', 'emulator/upstream.json',
  'emulator/vendor/fonts/DotGothic16-subset.woff', 'emulator/vendor/fonts/OFL.txt',
  'emulator/vendor/LICENSE-fm1-emu.txt', 'emulator/vendor/LICENSE-three.txt', 'emulator/vendor/fm1-emu-usb.patch', 'emulator/vendor/fm1_web.wasm',
  'emulator/vendor/jit.js', 'emulator/vendor/three.core.min.js', 'emulator/vendor/three.module.min.js', 'emulator/vendor/worklet.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, {cache: 'reload'})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  const mine = k => k !== CACHE && (k.endsWith(' ' + SCOPE) || (k === 'burrito-v1' && !SCOPE.includes('/lsdj-burrito-dev/')));
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(mine).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || req.headers.has('range')) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(async () => (await caches.match(req, {ignoreSearch: true})) ||
    (req.mode === 'navigate' && await caches.match('index.html')) || Response.error()));
});
