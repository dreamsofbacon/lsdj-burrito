// SPDX-License-Identifier: GPL-3.0-only
// The effects' wiring as the firmware runs it (firmware/lsdj_fx.h lsdj_fx_mix / lsdj_fx_chan),
// drawn live: per channel DRIVE -> FILTER -> LO-FI (crush, decimate) -> LFO (volume / pan; to the
// cutoff it moves the filter), into the mix; each channel's send, taken after its chain, feeds the
// one shared ECHO, whose return joins the mix; then the COMPRESSOR and out. What is on is lit;
// a muted channel, a dry one (Channel FX off) and All FX off are greyed. Pure: returns SVG text.
import {CHANNELS} from './fx-model.js';

const num = v => String(v & 255);   // decimal, as the page's controls show values
const FILTER = ['', 'LP', 'HP', 'BP', 'NOTCH', 'LP24'], DIST = ['SOFT', 'HARD', 'FOLD', 'FUZZ'], DEST = ['CUT', 'VOL', 'PAN'];
const ROW0 = 30, ROW = 44, BOX_W = 80, BOX_H = 28, X = [60, 150, 240, 330], SEND_X = 440, MIX_X = 610;

function box(x, y, w, title, value, on, extra = '') {
  return `<g class="blk${on ? ' on' : ''}"${extra}><rect class="box" x="${x}" y="${y}" width="${w}" height="${BOX_H}" rx="5"/>` +
    `<text x="${x + 6}" y="${y + 12}">${title}</text><text class="sub" x="${x + 6}" y="${y + 24}">${value}</text></g>`;
}

/* fx: unpackFx(...) (with .freeze from LIVE); live: {mute} (bit per channel, from LIVE) */
export function fxDiagram(fx, {mute = 0} = {}) {
  const parts = [], echoOn = fx.echo.mix > 0, echoY = ROW0 + 4 * ROW, rows = [];
  for (let c = 0; c < 4; c++) {
    const ch = fx.ch[c], q = fx.q[c], y = ROW0 + c * ROW, top = y - BOX_H / 2;
    const muted = (mute >> c) & 1, dry = (fx.fxOff >> c) & 1;
    const cls = muted ? ' muted' : dry ? ' dry' : '';
    const say = muted ? 'muted' : dry ? 'dry (Channel FX off)' : '';
    rows.push(`${CHANNELS[c]}${say ? ' ' + say : ''}`);
    let g = `<g class="row${cls}" data-ch="${c}"><line class="wire" x1="52" y1="${y}" x2="${MIX_X}" y2="${y}"/>`;
    g += `<text class="ch" x="4" y="${y + 4}">${CHANNELS[c]}</text>`;
    if (say) g += `<text class="sub why" x="4" y="${y + 16}">${muted ? 'MUTED' : 'DRY'}</text>`;
    g += box(X[0], top, BOX_W, 'DRIVE', ch.drive ? `${DIST[q.dist] || ''} ${num(ch.drive)}` : 'off', !!ch.drive);
    g += box(X[1], top, BOX_W, 'FILTER', ch.type ? `${FILTER[ch.type]} ${num(ch.cutoff)}${q.warm ? ' W' : ''}` : 'off', !!ch.type);
    g += box(X[2], top, BOX_W, 'LO-FI', ch.crush || ch.decim ? `CR ${num(ch.crush)} DC ${num(ch.decim)}` : 'off', !!(ch.crush || ch.decim));
    g += box(X[3], top, BOX_W, 'LFO', q.lfoDepth ? `${DEST[q.lfoDest] || ''} ${num(q.lfoDepth)}` : 'off', !!q.lfoDepth);
    if (q.lfoDepth && q.lfoDest === 0)   // to the cutoff: it moves the filter
      g += `<path class="mod" d="M${X[3] + 20} ${top} C ${X[3]} ${top - 10}, ${X[1] + 60} ${top - 10}, ${X[1] + 40} ${top}"/>`;
    if (ch.send) {
      g += `<path class="send${echoOn ? '' : ' idle'}" d="M${SEND_X} ${y} V ${echoY}"/><circle class="tap" cx="${SEND_X}" cy="${y}" r="3"/>` +
        `<text class="sub" x="${SEND_X + 6}" y="${y - 4}">send ${num(ch.send)}</text>`;
    }
    parts.push(g + '</g>');
  }
  const e = fx.echo;
  const echo = box(SEND_X + 20, echoY - BOX_H / 2, 120, 'ECHO (shared)',
    echoOn ? `MIX ${num(e.mix)} FB ${num(e.feedback)}${e.mode ? ' PING' : ''}${fx.freeze ? ' FRZ' : ''}` : 'mix 0: off', echoOn);
  const comp = box(MIX_X + 12, ROW0 + 1.5 * ROW - BOX_H / 2, 76, 'COMP', fx.comp ? num(fx.comp) : 'off', !!fx.comp);
  const bus = `<line class="wire" x1="${MIX_X}" y1="${ROW0}" x2="${MIX_X}" y2="${echoY}"/>` +
    `<line class="wire${echoOn ? '' : ' idle'}" x1="${SEND_X + 140}" y1="${echoY}" x2="${MIX_X}" y2="${echoY}"/>` +
    `<line class="wire" x1="${MIX_X}" y1="${ROW0 + 1.5 * ROW}" x2="${MIX_X + 12}" y2="${ROW0 + 1.5 * ROW}"/>` +
    `<line class="wire" x1="${MIX_X + 88}" y1="${ROW0 + 1.5 * ROW}" x2="716" y2="${ROW0 + 1.5 * ROW}"/>` +
    `<text x="${MIX_X + 92}" y="${ROW0 + 1.5 * ROW - 6}">OUT</text>`;
  const off = fx.bypass ? `<text class="alloff" x="${SEND_X - 20}" y="${ROW0 + 4 * ROW + 30}">ALL FX OFF: dry, mutes still apply</text>` : '';
  const label = `Effects wiring. ${rows.join('; ')}. Echo ${echoOn ? 'on' : 'off'}, compressor ${fx.comp ? 'on' : 'off'}` +
    (fx.bypass ? '. All FX off.' : '.');
  return `<svg class="fxd${fx.bypass ? ' bypass' : ''}" viewBox="0 0 720 ${ROW0 + 4 * ROW + 40}" role="img" aria-label="${label}">` +
    `<g class="chain">${parts.join('')}${echo}${bus}${comp}</g>${off}</svg>`;
}
