// SPDX-License-Identifier: GPL-3.0-only
// A DJ deck's effects panel (lsdj/dj-ui.js puts one beside each deck: a drawer, a column, or its own window). The
// FM-1's effects pages as on its knobs (fx-model.js pagesForFx: FILTER, DRIVE, LFO, LO-FI, ECHO, ECHO MOD, REVERB,
// MASTER), one page at a time; an effect for each channel gets four sliders (PU1 PU2 WAV NOI), a shared one a
// single slider, a choice a menu. It changes that deck's own FM-1 (set), and follows its knobs (refresh).
import {CHANNELS, PARAM, pagesForFx, paramGet, valueText, effectActive} from './fx-model.js';

const PER_CHANNEL = new Set(['ch', 'q', 'flags', 'rvch']);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter(k => k != null)); return e; };

/* name: "Deck A"; get() -> the deck's effects ({...unpackFx, reverb}) or null; set(key, c, v); fw() -> the
   firmware's number; page / onPage: the page shown (kept by the caller); actions: extra header buttons */
export function fxPanel({name, get, set, fw = () => Infinity, page = 1, onPage = () => {}, actions = []}) {
  const tabs = el('div', {className: 'seg dj-fx-pages', role: 'tablist', ariaLabel: `${name} effects pages`});
  const body = el('div', {className: 'dj-fx-body'});
  const note = el('p', {className: 'hint dj-fx-note'});
  const root = el('div', {className: 'dj-fx-panel'},
    el('div', {className: 'dj-fx-head'}, el('b', {textContent: `${name} · FX`}), ...actions), tabs, body, note);
  let holding = false, built = '';
  root.addEventListener('pointerdown', () => { holding = true; });
  /* (the pointer may be let go in another window, or over another element) */
  const letGo = () => { holding = false; };
  root.addEventListener('pointerup', letGo); root.addEventListener('pointercancel', letGo);
  root.addEventListener('lostpointercapture', letGo);

  const pages = fx => pagesForFx(fx, fw()).map((p, i) => ({...p, i})).filter(p => !p.rv || fx.reverb);
  function build() {
    const fx = get();
    if (!fx) {
      tabs.replaceChildren(); body.replaceChildren();
      note.textContent = 'Choose an FM-1 for this deck to see and change its effects.'; note.hidden = false;
      built = ''; return;
    }
    note.hidden = true;
    const list = pages(fx);
    if (!list.some(p => p.i === page)) page = list[0]?.i ?? 0;
    tabs.replaceChildren(...list.map(p => el('button', {type: 'button', textContent: p.name, role: 'tab',
      className: p.i === page ? 'on' : '', ariaSelected: String(p.i === page),
      onclick: () => { page = p.i; onPage(page); build(); }})));
    const pg = list.find(p => p.i === page);
    body.replaceChildren(...(pg?.knobs || []).filter(Boolean).filter(([, key]) => PARAM[key]).map(([, key]) => row(key)));
    built = `${fx.v3}${fx.reverb ? 1 : 0}${page}`;
    refresh();
  }
  /* one effect: its name, then a control for each channel (or one) with its value */
  function row(key) {
    const p = PARAM[key], chans = PER_CHANNEL.has(p.where) ? CHANNELS.map((_, c) => c) : [0];
    const cells = chans.map(c => {
      const id = `${name}-${key}-${c}`.replace(/\W+/g, '-');
      const label = chans.length > 1 ? CHANNELS[c] : '';
      const input = p.choices
        ? el('select', {id, onchange: () => set(key, c, +input.value)}, ...p.choices.map((t, v) => new Option(t, v)))
        : el('input', {id, type: 'range', min: 0, max: 127, oninput: () => { set(key, c, +input.value); show(); }});
      input.setAttribute('aria-label', `${name} ${p.name}${label ? ' ' + label : ''}`);
      const out = el('output', {className: 'mono', htmlFor: id});
      const cell = el('label', {className: 'dj-fx-cell'}, label ? el('span', {className: 'dj-fx-ch', textContent: label}) : null, input, out);
      const show = () => { const fx = get(); if (fx) out.textContent = valueText(fx, key, c); };
      cell.update = fx => {
        const v = paramGet(fx, key, c);
        if (!holding && input.ownerDocument.activeElement !== input && +input.value !== v) input.value = v;
        out.textContent = valueText(fx, key, c);
        cell.classList.toggle('idle', !effectActive(fx, key, c));
      };
      return cell;
    });
    const r = el('div', {className: `dj-fx-row${chans.length > 1 ? ' chans' : ''}`}, el('span', {className: 'dj-fx-name', textContent: p.name}), ...cells);
    r.update = fx => cells.forEach(c => c.update(fx));
    return r;
  }
  /* the values again (the FM-1's knobs moved, or the deck's filter or a throw): only what changed is redrawn */
  function refresh() {
    const fx = get();
    if (!fx || built !== `${fx.v3}${fx.reverb ? 1 : 0}${page}`) { if (!holding) build(); return; }
    body.querySelectorAll('.dj-fx-row').forEach(r => r.update(fx));
  }
  build();
  return {el: root, refresh, rebuild: build};
}
