// Pre-market + extended-hours summary for one symbol (ScalpCharts).
// Pure: takes 1-minute bars and an optional latest trade, returns what
// happened between the previous close and now. Session boundaries and the
// holiday calendar come from market-intel.js so both pages agree.
//
// IEX caveat: Alpaca's free feed is IEX only. IEX prints in the pre-market
// are thin (often nothing before 8 AM ET), so every figure here is "what
// traded on IEX", and the response says so. Nothing is estimated.
import { splitSessions, marketSession, prevTradingDay, round, etParts } from './market-intel.js';

function hiLoAt(bars) {
  let h = -Infinity, l = Infinity, hAt = null, lAt = null, v = 0, pv = 0;
  for (const b of bars) {
    if (b.h > h) { h = b.h; hAt = b.t; }
    if (b.l < l) { l = b.l; lAt = b.t; }
    v += b.v || 0; pv += ((b.h + b.l + b.c) / 3) * (b.v || 0);
  }
  return { h, l, hAt, lAt, v, vwap: v ? pv / v : null };
}
const pct = (a, b) => (a != null && b) ? round(((a - b) / b) * 100, 2) : null;
function hhmm(ms) { const e = etParts(ms); return `${e.hh}:${String(e.mm).padStart(2, '0')}`; }

/** Summarise one extended segment (pre-market or after-hours). */
function segment(bars, ref) {
  if (!bars || !bars.length) return null;
  const s = hiLoAt(bars);
  const last = bars[bars.length - 1];
  return {
    open: round(bars[0].o), high: round(s.h), low: round(s.l), last: round(last.c),
    volume: s.v, vwap: round(s.vwap), bars: bars.length,
    firstAt: bars[0].t, lastAt: last.t, highAt: s.hAt, lowAt: s.lAt,
    changePct: pct(last.c, ref),
  };
}

/**
 * bars:  1-min bars {t,o,h,l,c,v}, ascending, covering the previous session
 *        through now.
 * trade: optional {p, t} latest IEX trade.
 */
export function summarizePremarket({ symbol, bars, nowMs, trade = null }) {
  const session = marketSession(nowMs);
  const day = session.refDate;
  const prev = prevTradingDay(day);
  const s = splitSessions(bars);
  const prevReg = s[prev]?.reg || [];
  const prevClose = prevReg.length ? prevReg[prevReg.length - 1].c : null;

  const afterHours = segment(s[prev]?.post, prevClose);
  const preBars = s[day]?.pre || [];
  const premarket = segment(preBars, prevClose);
  const reg = s[day]?.reg || [];

  // "Now" price: during pre-market a fresh trade beats the last bar close.
  let last = null, lastAt = null;
  if (session.state === 'premarket' && trade && trade.t >= Date.parse(`${day}T00:00:00Z`)) { last = trade.p; lastAt = trade.t; }
  else if (premarket) { last = premarket.last; lastAt = premarket.lastAt; }

  const out = {
    ok: true, symbol, session: { state: session.state, label: session.label, date: day, prevDate: prev },
    prevClose: round(prevClose), afterHours, premarket, last: round(last), lastAt,
    gap: null, open: null, regular: null, read: [],
    feed: 'IEX',
    note: 'Extended-hours prints from the IEX exchange only (via Alpaca). IEX pre-market trading is thin — often nothing before 8:00 AM ET — so the range shown is what traded on IEX, not the whole market.',
  };

  if (premarket && prevClose) {
    const ref = last ?? premarket.last;
    const g = ref - prevClose;
    out.gap = {
      pts: round(g), pct: pct(ref, prevClose),
      dir: Math.abs(g / prevClose) < 0.001 ? 'flat' : g > 0 ? 'up' : 'down',
      basis: reg.length ? 'open' : 'indicated',
    };
  }

  if (reg.length) {
    const r = hiLoAt(reg);
    const o = reg[0].o;
    out.open = round(o);
    const gapPts = prevClose != null ? o - prevClose : null;
    out.gap = prevClose != null ? {
      pts: round(gapPts), pct: pct(o, prevClose),
      dir: Math.abs(gapPts / prevClose) < 0.001 ? 'flat' : gapPts > 0 ? 'up' : 'down', basis: 'open',
    } : out.gap;
    // Gap fill: the first regular-session bar that trades back through the previous close.
    let filledAt = null;
    if (out.gap && out.gap.dir !== 'flat') {
      for (const b of reg) {
        if ((out.gap.dir === 'up' && b.l <= prevClose) || (out.gap.dir === 'down' && b.h >= prevClose)) { filledAt = b.t; break; }
      }
    }
    // First break of the pre-market high / low after the open.
    let pmhBreakAt = null, pmlBreakAt = null;
    if (premarket) {
      for (const b of reg) {
        if (!pmhBreakAt && b.h > premarket.high) pmhBreakAt = b.t;
        if (!pmlBreakAt && b.l < premarket.low) pmlBreakAt = b.t;
      }
    }
    out.regular = {
      high: round(r.h), low: round(r.l), last: round(reg[reg.length - 1].c),
      gapFilled: filledAt != null, gapFilledAt: filledAt,
      pmhBreakAt, pmlBreakAt,
    };
  }

  out.read = readOut(out);
  return out;
}

/** Short, rule-based lines for the panel. Educational, not advice. */
export function readOut(o) {
  const lines = [];
  const pc = o.prevClose;
  if (!o.premarket) {
    lines.push(o.session.state === 'premarket'
      ? 'No IEX pre-market trades yet today. IEX pre-market activity usually starts around 8:00 AM ET.'
      : 'No IEX pre-market trades were recorded for this session.');
  }
  if (o.gap && pc != null) {
    const sz = Math.abs(o.gap.pct);
    const size = sz >= 1 ? 'large' : sz >= 0.4 ? 'moderate' : sz >= 0.1 ? 'small' : 'no real';
    const verb = o.gap.basis === 'open' ? 'Opened' : 'Indicated';
    if (o.gap.dir === 'flat') lines.push(`${verb} roughly flat to the previous close of ${pc.toFixed(2)}.`);
    else lines.push(`${verb} ${o.gap.pct > 0 ? '+' : ''}${o.gap.pct.toFixed(2)}% vs the ${pc.toFixed(2)} close — a ${size} gap ${o.gap.dir}.`);
  }
  if (o.premarket) {
    const p = o.premarket;
    lines.push(`Pre-market range ${p.low.toFixed(2)}–${p.high.toFixed(2)} (high at ${hhmm(p.highAt)}, low at ${hhmm(p.lowAt)} ET) on ${p.volume.toLocaleString('en-US')} IEX shares.`);
  }
  if (o.regular) {
    const r = o.regular;
    if (o.gap && o.gap.dir !== 'flat') {
      lines.push(r.gapFilled
        ? `Gap filled at ${hhmm(r.gapFilledAt)} ET — price traded back to the previous close.`
        : `Gap still open — the previous close at ${pc.toFixed(2)} has not been revisited.`);
    }
    if (o.premarket) {
      if (r.pmhBreakAt && r.pmlBreakAt) lines.push(`Both pre-market extremes have broken (high at ${hhmm(r.pmhBreakAt)}, low at ${hhmm(r.pmlBreakAt)} ET) — the pre-market range is no longer in play.`);
      else if (r.pmhBreakAt) lines.push(`Pre-market high ${o.premarket.high.toFixed(2)} broke at ${hhmm(r.pmhBreakAt)} ET — buyers took out the overnight ceiling.`);
      else if (r.pmlBreakAt) lines.push(`Pre-market low ${o.premarket.low.toFixed(2)} broke at ${hhmm(r.pmlBreakAt)} ET — sellers took out the overnight floor.`);
      else lines.push(`Still inside the pre-market range — ${o.premarket.high.toFixed(2)} and ${o.premarket.low.toFixed(2)} are the lines to watch.`);
    }
  } else if (o.premarket && o.session.state === 'premarket') {
    lines.push(`Watch the pre-market high ${o.premarket.high.toFixed(2)} and low ${o.premarket.low.toFixed(2)} after the 9:30 open — a break of either is the first tell.`);
  }
  if (o.afterHours && pc != null) {
    lines.push(`After-hours on ${o.session.prevDate}: ${o.afterHours.low.toFixed(2)}–${o.afterHours.high.toFixed(2)}, last ${o.afterHours.last.toFixed(2)} (${o.afterHours.changePct > 0 ? '+' : ''}${o.afterHours.changePct.toFixed(2)}%).`);
  }
  return lines;
}
