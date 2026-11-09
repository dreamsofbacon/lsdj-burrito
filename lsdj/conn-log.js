// SPDX-License-Identifier: GPL-3.0-only
// What happened to the FM-1 connections, kept for reading afterwards (the status lines change too fast to read
// mid-set): the last LOG_MAX events with their times, in this browser only (localStorage), shown in the DJ layout.
// A 'conn-log' event says when it changed.
const KEY = 'lsdj-burrito-conn-log', LOG_MAX = 80;
let entries = (() => { try { const l = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(l) ? l.slice(-LOG_MAX) : []; } catch { return []; } })();
let last = '', lastAt = 0;
export function logEvent(text) {
  text = String(text || '').trim();
  if (!text) return;
  const t = Date.now();
  if (text === last && t - lastAt < 2000) return;   /* the same line again at once: once */
  last = text; lastAt = t;
  entries.push({t, text});
  if (entries.length > LOG_MAX) entries = entries.slice(-LOG_MAX);
  try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* this visit only */ }
  try { document.dispatchEvent(new Event('conn-log')); } catch { /* no page */ }
}
export const logEntries = () => entries.slice();
export function clearLog() {
  entries = []; last = '';
  try { localStorage.removeItem(KEY); } catch { /* this visit only */ }
  try { document.dispatchEvent(new Event('conn-log')); } catch { /* no page */ }
}
const two = n => String(n).padStart(2, '0');
export const logTime = t => { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
export const logText = () => entries.map(e => `${logTime(e.t)}  ${e.text}`).join('\n');
