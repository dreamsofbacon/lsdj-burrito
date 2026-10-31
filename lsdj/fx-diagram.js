// SPDX-License-Identifier: GPL-3.0-only
// The effects' wiring as the firmware runs it (firmware/lsdj_fx.h lsdj_fx_mix / lsdj_fx_chan),
// drawn live and upright, one column per channel as on LSDj's song screen (PU1 PU2 WAV NOI):
// each channel runs down DRIVE -> FILTER -> LO-FI (crush, decimate) -> LFO (volume / pan; to the
// cutoff it moves the filter), into the mix along the bottom; each channel's send, taken after its
// chain, feeds the one shared ECHO on the right, whose return joins the mix; then the COMPRESSOR
// and out. What is on is lit; a muted channel, a dry one (Channel FX off) and All FX off are
// greyed. Pure: returns SVG text.
import {CHANNELS} from './fx-model.js';

const num = v => String(v & 255);   // decimal, as the page's controls show values
const FILTER = ['', 'LP', 'HP', 'BP', 'NOTCH', 'LP24'], DIST = ['SOFT', 'HARD', 'FOLD', 'FUZZ'], DEST = ['CUT', 'VOL', 'PAN'];
const CX = [58, 168, 278, 388], BOX_W = 100, BOX_H = 28, TOP0 = 34, STEP = 40, WIRE0 = 30;
const SEND_Y = 200, ECHO_X = 448, ECHO_W = 146, MIX_Y = 240, OUT_X = 278, W = 600, H = 342;

function box(x, y, w, title, value, on, extra = '') {
  return `<g class="blk${on ? ' on' : ''}"${extra}><rect class="box" x="${x}" y="${y}" width="${w}" height="${BOX_H}" rx="5"/>` +
    `<text x="${x + 6}" y="${y + 12}">${title}</text><text class="sub" x="${x + 6}" y="${y + 24}">${value}</text></g>`;
}

/* fx: unpackFx(...) (with .freeze from LIVE); live: {mute} (bit per channel, from LIVE) */
export function fxDiagram(fx, {mute = 0} = {}) {
  const parts = [], echoOn = fx.echo.mix > 0, echoMid = ECHO_X + ECHO_W / 2, rows = [];
  for (let c = 0; c < 4; c++) {
    const ch = fx.ch[c], q = fx.q[c], cx = CX[c], x = cx - BOX_W / 2, top = k => TOP0 + k * STEP;
    const muted = (mute >> c) & 1, dry = (fx.fxOff >> c) & 1;
    const cls = muted ? ' muted' : dry ? ' dry' : '';
    const say = muted ? 'muted' : dry ? 'dry (Channel FX off)' : '';
    rows.push(`${CHANNELS[c]}${say ? ' ' + say : ''}`);
    let g = `<g class="row${cls}" data-ch="${c}"><line class="wire" x1="${cx}" y1="${WIRE0}" x2="${cx}" y2="${MIX_Y}"/>`;
    g += `<text class="ch" x="${cx}" y="14" text-anchor="middle">${CHANNELS[c]}</text>`;
    if (say) g += `<text class="sub why" x="${cx}" y="26" text-anchor="middle">${muted ? 'MUTED' : 'DRY'}</text>`;
    g += box(x, top(0), BOX_W, 'DRIVE', ch.drive ? `${DIST[q.dist] || ''} ${num(ch.drive)}` : 'off', !!ch.drive);
    g += box(x, top(1), BOX_W, 'FILTER', ch.type ? `${FILTER[ch.type]} ${num(ch.cutoff)}${q.warm ? ' W' : ''}` : 'off', !!ch.type);
    g += box(x, top(2), BOX_W, 'LO-FI', ch.crush || ch.decim ? `CR ${num(ch.crush)} DC ${num(ch.decim)}` : 'off', !!(ch.crush || ch.decim));
    g += box(x, top(3), BOX_W, 'LFO', q.lfoDepth ? `${DEST[q.lfoDest] || ''} ${num(q.lfoDepth)}` : 'off', !!q.lfoDepth);
    if (q.lfoDepth && q.lfoDest === 0) {   // to the cutoff: it moves the filter (a loop up the right side)
      const r = x + BOX_W, y3 = top(3) + BOX_H / 2, y1 = top(1) + BOX_H / 2;
      g += `<path class="mod" d="M${r} ${y3} C ${r + 9} ${y3}, ${r + 9} ${y1}, ${r} ${y1}"/>`;
    }
    if (ch.send) {
      g += `<path class="send${echoOn ? '' : ' idle'}" d="M${cx} ${SEND_Y} H ${ECHO_X}"/><circle class="tap" cx="${cx}" cy="${SEND_Y}" r="3"/>` +
        `<text class="sub" x="${cx + 5}" y="${SEND_Y - 5}">send ${num(ch.send)}</text>`;
    }
    parts.push(g + '</g>');
  }
  const e = fx.echo;
  const echo = box(ECHO_X, SEND_Y - BOX_H / 2, ECHO_W, 'ECHO (shared)',
    echoOn ? `MIX ${num(e.mix)} FB ${num(e.feedback)}${e.mode ? ' PING' : ''}${fx.freeze ? ' FRZ' : ''}` : 'mix 0: off', echoOn);
  const compTop = MIX_Y + 16;
  const comp = box(OUT_X - BOX_W / 2, compTop, BOX_W, 'COMP', fx.comp ? num(fx.comp) : 'off', !!fx.comp);
  const bus = `<line class="wire" x1="${CX[0]}" y1="${MIX_Y}" x2="${echoMid}" y2="${MIX_Y}"/>` +
    `<line class="wire${echoOn ? '' : ' idle'}" x1="${echoMid}" y1="${SEND_Y + BOX_H / 2}" x2="${echoMid}" y2="${MIX_Y}"/>` +
    `<line class="wire" x1="${OUT_X}" y1="${MIX_Y}" x2="${OUT_X}" y2="${compTop}"/>` +
    `<line class="wire" x1="${OUT_X}" y1="${compTop + BOX_H}" x2="${OUT_X}" y2="${compTop + BOX_H + 16}"/>` +
    `<text x="${OUT_X}" y="${compTop + BOX_H + 30}" text-anchor="middle">OUT</text>`;
  const off = fx.bypass ? `<text class="alloff" x="${W / 2}" y="${H - 6}" text-anchor="middle">ALL FX OFF: dry, mutes still apply</text>` : '';
  const label = `Effects wiring. ${rows.join('; ')}. Echo ${echoOn ? 'on' : 'off'}, compressor ${fx.comp ? 'on' : 'off'}` +
    (fx.bypass ? '. All FX off.' : '.');
  return `<svg class="fxd${fx.bypass ? ' bypass' : ''}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">` +
    `<g class="chain">${parts.join('')}${echo}${bus}${comp}</g>${off}</svg>`;
}
