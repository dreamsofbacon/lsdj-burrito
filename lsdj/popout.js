// SPDX-License-Identifier: GPL-3.0-only
// Pop-out panels: a part of the page moves into its own browser window (a second monitor, a
// projector) and back. The panel's own elements move, so their handlers keep working and the
// main page keeps the one link to the FM-1. Closing the window puts the panel back.

const out = new Map();   // name -> {win, el, slot, timer}
const listeners = new Set();
const changed = () => listeners.forEach(f => { try { f(); } catch {} });

/* copy what styles the main page onto a popup: stylesheets once, then the theme colours
   (inline on <html>, lsdj/page-theme.js) and the body classes (connected, …) as they change */
function syncLook(doc) {
  doc.documentElement.setAttribute('style', document.documentElement.getAttribute('style') || '');
  const keep = [...doc.body.classList].filter(c => c === 'popped');
  doc.body.className = [...document.body.classList].filter(c => !c.startsWith('pop-')).concat(keep).join(' ');
}
new MutationObserver(() => out.forEach(p => { if (!p.win.closed) syncLook(p.win.document); }))
  .observe(document.documentElement, {attributes: true, attributeFilter: ['style'], subtree: false});
new MutationObserver(() => out.forEach(p => { if (!p.win.closed) syncLook(p.win.document); }))
  .observe(document.body, {attributes: true, attributeFilter: ['class']});

/* name: a short id ("screen"); el: the panel; title: the window title.
   Returns false when the browser blocked the window (it needs a click). */
export function popOut(name, el, {title = name, width = 640, height = 480} = {}) {
  const was = out.get(name);
  if (was && !was.win.closed) { was.win.focus(); return true; }
  const win = window.open('', `fm1-${name}`, `popup,width=${width},height=${height}`);
  if (!win) return false;
  const doc = win.document;
  doc.open();
  doc.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title></head>' +
    '<body class="popped"><div class="pop-bar"><b></b><span class="pop-gap"></span><button type="button" data-pop-full>Full screen</button><button type="button" data-pop-back>Bring back</button></div><div class="pop-body"></div></body></html>');
  doc.close();
  doc.title = `${title} · LSDJ Burrito`;
  doc.querySelector('.pop-bar b').textContent = title;
  document.querySelectorAll('style').forEach(s => doc.head.append(doc.importNode(s, true)));
  syncLook(doc);
  const slot = document.createComment(`pop-out: ${name}`);
  el.before(slot);
  doc.querySelector('.pop-body').append(doc.adoptNode(el));
  const p = {win, el, slot};
  out.set(name, p);
  doc.querySelector('[data-pop-back]').onclick = () => bringBack(name);
  doc.querySelector('[data-pop-full]').onclick = () => {
    if (doc.fullscreenElement) doc.exitFullscreen(); else doc.documentElement.requestFullscreen?.().catch(() => {});
  };
  win.addEventListener('pagehide', () => bringBack(name));
  doc.addEventListener('visibilitychange', changed);
  p.timer = setInterval(() => { if (win.closed) bringBack(name); }, 1000);   // in case pagehide was missed
  document.body.classList.add(`pop-${name}`);
  changed();
  return true;
}

/* put a panel back where it was and close its window */
export function bringBack(name) {
  const p = out.get(name);
  if (!p) return;
  out.delete(name);
  clearInterval(p.timer);
  p.slot.replaceWith(document.adoptNode(p.el));
  document.body.classList.remove(`pop-${name}`);
  try { if (!p.win.closed) p.win.close(); } catch {}
  changed();
}

export const isOut = name => out.has(name);
/* every open document: the page's and the popups' (for lookups of panels that moved) */
export const docs = () => [document, ...[...out.values()].filter(p => !p.win.closed).map(p => p.win.document)];
/* is this element in a document someone can see? */
export const seen = el => !!el && !el.ownerDocument.hidden && el.isConnected;
/* is any of the page or its popups on screen? */
export const anyVisible = () => docs().some(d => !d.hidden);
/* a window on screen, for timers: a hidden window's timers are slowed down by the browser */
export const visibleWindow = () => (docs().find(d => !d.hidden)?.defaultView) || window;
/* called when a panel goes out or back, or a popup is shown or hidden */
export const onPopChange = f => { listeners.add(f); return () => listeners.delete(f); };

window.addEventListener('pagehide', () => [...out.keys()].forEach(bringBack));
