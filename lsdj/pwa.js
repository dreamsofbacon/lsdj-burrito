// SPDX-License-Identifier: GPL-3.0-only
// Installable app: registers the offline copy (sw.js) and shows "Install app" in the top bar when
// the browser offers it (Chrome / Edge; on iPhone and iPad: Share › Add to Home Screen).
const btn = document.getElementById('install-app');
let offer = null;

if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname)))
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));

addEventListener('beforeinstallprompt', e => { e.preventDefault(); offer = e; if (btn) btn.hidden = false; });
addEventListener('appinstalled', () => { offer = null; if (btn) btn.hidden = true; });
if (btn) btn.onclick = async () => {
  if (!offer) return;
  offer.prompt();
  await offer.userChoice.catch(() => {});
  offer = null; btn.hidden = true;
};
