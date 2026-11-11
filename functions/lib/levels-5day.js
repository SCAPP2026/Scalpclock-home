// 5-Day Level Map — support and resistance from the last five COMPLETED
// regular sessions. Pure functions; the endpoint (functions/api/market-levels.js)
// does the fetching and caching.
//
// Every level comes from something that actually printed in those five
// sessions: a swing turn on the 15-minute chart, a day's high or low, the
// 5-day extremes, the volume profile (point of control, value-area edges,
// high-volume nodes), the 5-day anchored VWAP or the last close. Nearby
// candidates merge into one level, and its strength score is built from how
// many independent reasons agree plus how many times price actually came back
// to it and was turned away. Nothing is estimated or back-filled.
import { etParts, splitSessions, marketSession, round } from './market-intel.js';

export const WINDOW_DAYS = 5;
const MIN_REG_BARS = 10;            // a session with fewer 5-min bars is treated as missing

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayLabel(date) { return DOW_SHORT[new Date(date + 'T12:00:00Z').getUTCDay()]; }

/** 5-min bars → 15-min bars (same ET session bucket). Input bars carry `minutes` and `date`. */
export function to15(bars) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const key = b.date + ':' + Math.floor(b.minutes / 15);
    if (!cur || cur.key !== key) {
      cur = { key, t: b.t, date: b.date, minutes: Math.floor(b.minutes / 15) * 15, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v || 0;
    }
  }
  return out.map(({ key, ...rest }) => rest);
}

/** Which sessions are finished as of nowMs (today counts only after its close). */
export function completedDates(sessions, nowMs) {
  const s = marketSession(nowMs);
  return Object.keys(sessions)
    .filter(d => sessions[d].reg.length >= MIN_REG_BARS)
    .filter(d => d < s.etDate || (d === s.etDate && s.regularOver))
    .sort();
}

/** Volume-at-price from 5-min bars, each bar's volume spread evenly across its range. */
export function volumeProfile(bars, binSize) {
  if (!bars.length || !(binSize > 0)) return null;
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
  const base = Math.floor(lo / binSize) * binSize;
  const n = Math.max(1, Math.ceil((hi - base) / binSize) + 1);
  const vol = new Array(n).fill(0);
  for (const b of bars) {
    const v = b.v || 0;
    if (!v) continue;
    const i0 = Math.max(0, Math.floor((b.l - base) / binSize));
    const i1 = Math.min(n - 1, Math.floor((b.h - base) / binSize));
    const share = v / (i1 - i0 + 1);
    for (let i = i0; i <= i1; i++) vol[i] += share;
  }
  const total = vol.reduce((a, x) => a + x, 0);
  if (!total) return null;
  let poc = 0;
  for (let i = 1; i < n; i++) if (vol[i] > vol[poc]) poc = i;
  // Value area: grow outward from the POC, always taking the heavier side, until 70% of volume.
  let a = poc, z = poc, acc = vol[poc];
  while (acc < total * 0.7 && (a > 0 || z < n - 1)) {
    const up = z < n - 1 ? vol[z + 1] : -1, dn = a > 0 ? vol[a - 1] : -1;
    if (up >= dn) { z++; acc += vol[z]; } else { a--; acc += vol[a]; }
  }
  const mid = i => base + (i + 0.5) * binSize;
  // High-volume nodes: local peaks (bigger than both neighbours on each side, 2 deep) carrying ≥ 60% of the POC.
  const hvn = [];
  for (let i = 2; i < n - 2; i++) {
    if (i === poc) continue;
    if (vol[i] >= vol[poc] * 0.6 && vol[i] > vol[i - 1] && vol[i] > vol[i - 2] && vol[i] >= vol[i + 1] && vol[i] >= vol[i + 2]) hvn.push(mid(i));
  }
  return {
    base, binSize, vol, total,
    poc: mid(poc), vah: base + (z + 1) * binSize, val: base + a * binSize, hvn,
  };
}

/** Merge candidate prices that sit within `tol` of each other. */
export function mergeCandidates(cands, tol) {
  const sorted = [...cands].sort((a, b) => a.price - b.price);
  const out = [];
  for (const c of sorted) {
    const z = out[out.length - 1];
    if (z && c.price - z.hi <= tol && c.price - z.lo <= tol * 2) {
      z.hi = c.price; z.items.push(c);
    } else {
      out.push({ lo: c.price, hi: c.price, items: [c] });
    }
  }
  return out;
}

/**
 * How price behaved around a band: separate visits (runs of 15-min bars whose
 * range overlapped the band), and how many of those visits ended with price
 * leaving on the same side it arrived from — i.e. the level held.
 */
export function visitStats(bars15, lo, hi) {
  const sideOf = p => (p > hi ? 1 : p < lo ? -1 : 0);
  let visits = 0, held = 0, broke = 0, lastDate = null, inVisit = false, fromSide = 0, lastSide = 0;
  for (const b of bars15) {
    const touch = b.l <= hi && b.h >= lo;
    if (touch) {
      if (!inVisit) { visits++; inVisit = true; fromSide = lastSide; }
      lastDate = b.date;
    } else if (inVisit) {
      // A bar that no longer overlaps the band closes the visit; which side it left on decides held/broke.
      inVisit = false;
      const exit = sideOf(b.c);
      if (fromSide && exit) { if (exit === fromSide) held++; else broke++; }
    }
    const s = sideOf(b.c);
    if (s) lastSide = s;
  }
  return { visits, held, broke, lastDate };
}

const WEIGHTS = {
  swing: 10, dayHigh: 12, dayLow: 12, high5: 20, low5: 20,
  poc: 22, vah: 12, val: 12, hvn: 12, vwap5: 10, prevClose: 10,
};

/** Score a merged level 0–100 from its reasons and how price behaved there. */
export function scoreLevel({ items, stats, lastSessionDate }) {
  let swings = 0, s = 0;
  const seen = new Set();
  for (const it of items) {
    if (it.type === 'swing') { if (swings < 3) s += WEIGHTS.swing; swings++; continue; }
    if (seen.has(it.type)) continue;          // one day-high per level is enough evidence
    seen.add(it.type);
    s += WEIGHTS[it.type] || 0;
  }
  s += Math.min(32, stats.held * 8);
  if (stats.lastDate && stats.lastDate === lastSessionDate) s += 8;
  return Math.max(0, Math.min(100, Math.round(s)));
}
export function tierOf(score) { return score >= 75 ? 'major' : score >= 50 ? 'strong' : 'minor'; }

/** Support / resistance / testing relative to a price, with a tolerance. */
export function roleAt(level, price, tol) {
  if (price == null) return null;
  if (price > level.hi + tol * 0.25) return 'support';
  if (price < level.lo - tol * 0.25) return 'resistance';
  return 'testing';
}

function structureOf(days) {
  if (days.length < 3) return { label: 'Not enough sessions', tone: 'neutral', hh: 0, hl: 0, lh: 0, ll: 0 };
  let hh = 0, hl = 0, lh = 0, ll = 0;
  for (let i = 1; i < days.length; i++) {
    if (days[i].high > days[i - 1].high) hh++; else lh++;
    if (days[i].low > days[i - 1].low) hl++; else ll++;
  }
  const n = days.length - 1, need = Math.ceil(n * 0.75);
  if (hh >= need && hl >= need) return { label: 'Uptrend — higher highs and higher lows', tone: 'bullish', hh, hl, lh, ll };
  if (lh >= need && ll >= need) return { label: 'Downtrend — lower highs and lower lows', tone: 'bearish', hh, hl, lh, ll };
  if (lh >= need && hl >= need) return { label: 'Coiling — lower highs and higher lows', tone: 'neutral', hh, hl, lh, ll };
  if (hh >= need && ll >= need) return { label: 'Expanding — wider swings both ways', tone: 'neutral', hh, hl, lh, ll };
  return { label: 'Rotating — no clean sequence of highs and lows', tone: 'neutral', hh, hl, lh, ll };
}

const SOURCE_ORDER = ['high5', 'low5', 'poc', 'dayHigh', 'dayLow', 'vah', 'val', 'hvn', 'vwap5', 'prevClose', 'swing'];
/** Reasons, most important first; repeated 15m swing turns collapse into one line. */
export function describeSources(items) {
  const out = [];
  const sorted = [...items].sort((a, b) => SOURCE_ORDER.indexOf(a.type) - SOURCE_ORDER.indexOf(b.type));
  const seen = new Set();
  for (const it of sorted) {
    if (it.type === 'swing') continue;
    const s = sourceLabel(it);
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  const hs = items.filter(it => it.type === 'swing' && it.kind === 'high').length;
  const ls = items.filter(it => it.type === 'swing' && it.kind === 'low').length;
  if (hs) out.push(hs > 1 ? `${hs} swing highs (15m)` : 'Swing high (15m)');
  if (ls) out.push(ls > 1 ? `${ls} swing lows (15m)` : 'Swing low (15m)');
  return out;
}
function sourceLabel(it) {
  switch (it.type) {
    case 'swing': return it.kind === 'high' ? `15m swing high (${dayLabel(it.date)})` : `15m swing low (${dayLabel(it.date)})`;
    case 'dayHigh': return `${dayLabel(it.date)} high`;
    case 'dayLow': return `${dayLabel(it.date)} low`;
    case 'high5': return '5-day high';
    case 'low5': return '5-day low';
    case 'poc': return 'Volume POC';
    case 'vah': return 'Value-area high';
    case 'val': return 'Value-area low';
    case 'hvn': return 'High-volume node';
    case 'vwap5': return '5-day VWAP';
    case 'prevClose': return 'Last close';
    default: return it.type;
  }
}

/**
 * Build the map for one symbol.
 *   bars:  5-min bars {t,o,h,l,c,v} covering at least the last 6 sessions
 *   price: latest trade (optional — falls back to the last completed close)
 */
export function build5DayLevels({ symbol, bars, nowMs, price = null, priceTs = null }) {
  const map = build5DayMap({ symbol, bars, nowMs });
  return map.ok ? applyPrice(map, price, priceTs) : map;
}

/**
 * The price-independent part: everything that only changes when a session
 * closes. The endpoint caches this for the day; applyPrice() then places the
 * live price on it on every request.
 */
export function build5DayMap({ symbol, bars, nowMs }) {
  const sessions = splitSessions(bars);
  const dates = completedDates(sessions, nowMs);
  if (dates.length < 2) return { symbol, ok: false, error: 'Not enough completed sessions in the data.' };
  const win = dates.slice(-WINDOW_DAYS);
  const priorDate = dates.length > win.length ? dates[dates.length - win.length - 1] : null;

  const days = win.map((date, i) => {
    const reg = sessions[date].reg;
    let h = -Infinity, l = Infinity, v = 0, pv = 0, hiAt = null, loAt = null;
    for (const b of reg) {
      if (b.h > h) { h = b.h; hiAt = b.t; }
      if (b.l < l) { l = b.l; loAt = b.t; }
      v += b.v || 0; pv += ((b.h + b.l + b.c) / 3) * (b.v || 0);
    }
    const prevDate = i > 0 ? win[i - 1] : priorDate;
    const prevClose = prevDate ? sessions[prevDate].reg[sessions[prevDate].reg.length - 1].c : null;
    const o = reg[0].o, c = reg[reg.length - 1].c;
    return {
      date, label: dayLabel(date), open: o, high: h, low: l, close: c, volume: v,
      vwap: v ? pv / v : null, hiAt, loAt,
      changePct: prevClose ? ((c - prevClose) / prevClose) * 100 : null,
      rangePct: ((h - l) / l) * 100,
      closeLoc: h > l ? (c - l) / (h - l) : 0.5,          // 0 = closed on the low, 1 = on the high
      bars5: reg,
    };
  });

  const all5 = days.flatMap(d => d.bars5);
  const bars15 = to15(all5.map(b => ({ ...b, date: etParts(b.t).date })));
  const last = days[days.length - 1];
  const refPrice = last.close;            // level selection is anchored to the last close
  const atr15 = bars15.reduce((a, b) => a + (b.h - b.l), 0) / bars15.length;
  const tol = Math.max(refPrice * 0.0006, atr15 * 0.3);

  // ── candidates ──
  const cands = [];
  // Swing turns on the 15-min chart, two bars either side.
  for (let i = 2; i < bars15.length - 2; i++) {
    const b = bars15[i];
    let isH = true, isL = true;
    for (let j = 1; j <= 2; j++) {
      if (b.h <= bars15[i - j].h || b.h <= bars15[i + j].h) isH = false;
      if (b.l >= bars15[i - j].l || b.l >= bars15[i + j].l) isL = false;
    }
    if (isH) cands.push({ type: 'swing', kind: 'high', price: b.h, date: b.date, t: b.t });
    if (isL) cands.push({ type: 'swing', kind: 'low', price: b.l, date: b.date, t: b.t });
  }
  let hi5 = days[0], lo5 = days[0];
  for (const d of days) {
    cands.push({ type: 'dayHigh', kind: 'high', price: d.high, date: d.date });
    cands.push({ type: 'dayLow', kind: 'low', price: d.low, date: d.date });
    if (d.high > hi5.high) hi5 = d;
    if (d.low < lo5.low) lo5 = d;
  }
  cands.push({ type: 'high5', kind: 'high', price: hi5.high, date: hi5.date });
  cands.push({ type: 'low5', kind: 'low', price: lo5.low, date: lo5.date });
  cands.push({ type: 'prevClose', price: last.close, date: last.date });

  const profile = volumeProfile(all5, Math.max(0.01, tol / 2));
  if (profile) {
    cands.push({ type: 'poc', price: profile.poc });
    cands.push({ type: 'vah', price: profile.vah });
    cands.push({ type: 'val', price: profile.val });
    for (const p of profile.hvn) cands.push({ type: 'hvn', price: p });
  }
  let v5 = 0, pv5 = 0;
  for (const b of all5) { v5 += b.v || 0; pv5 += ((b.h + b.l + b.c) / 3) * (b.v || 0); }
  const vwap5 = v5 ? pv5 / v5 : null;
  if (vwap5) cands.push({ type: 'vwap5', price: vwap5 });

  // ── merge + score ──
  let levels = mergeCandidates(cands, tol * 1.5).map(z => {
    // Keep a band a little wider than a single print so "touches" are realistic.
    const lo = z.lo, hi = z.hi;
    const stats = visitStats(bars15, lo - tol / 2, hi + tol / 2);
    const score = scoreLevel({ items: z.items, stats, lastSessionDate: last.date });
    const kinds = new Set(z.items.filter(it => it.kind).map(it => it.kind));
    const types = [...new Set(z.items.map(it => it.type))];
    const sources = describeSources(z.items);
    return {
      price: round((lo + hi) / 2), lo: round(lo), hi: round(hi), isZone: hi - lo >= 0.01,
      score, tier: tierOf(score), types, sources,
      madeHighs: kinds.has('high'), madeLows: kinds.has('low'),
      visits: stats.visits, held: stats.held, broke: stats.broke, lastTouched: stats.lastDate,
    };
  });

  // Keep the meaningful ones, but never drop the nearest level on either side.
  const nearestIdx = role => {
    let best = -1;
    levels.forEach((l, i) => {
      if (roleAt(l, refPrice, tol) !== role) return;
      const d = Math.abs(l.price - refPrice);
      if (best < 0 || d < Math.abs(levels[best].price - refPrice)) best = i;
    });
    return best;
  };
  const keepIdx = new Set([nearestIdx('support'), nearestIdx('resistance')].filter(i => i >= 0));
  // The window's own extremes always stay: they frame the whole map.
  levels.forEach((l, i) => { if (l.types.includes('high5') || l.types.includes('low5')) keepIdx.add(i); });
  const ranked = levels.map((l, i) => ({ l, i })).sort((a, b) => b.l.score - a.l.score);
  for (const { l, i } of ranked) { if (keepIdx.size >= 10) break; if (l.score >= 30) keepIdx.add(i); }
  levels = levels.filter((_, i) => keepIdx.has(i)).sort((a, b) => b.price - a.price);

  const structure = structureOf(days);
  return {
    symbol, ok: true,
    window: { from: win[0], to: last.date, sessions: win.length },
    lastClose: round(last.close),
    tolerance: round(tol, 3),
    high5: { price: round(hi5.high), date: hi5.date }, low5: { price: round(lo5.low), date: lo5.date },
    vwap5: round(vwap5),
    profile: profile ? {
      poc: round(profile.poc), vah: round(profile.vah), val: round(profile.val),
      // A compact histogram for drawing (≤ 48 rows).
      rows: compressProfile(profile, 48),
    } : null,
    structure,
    days: days.map(({ bars5, ...d }) => ({
      ...d, open: round(d.open), high: round(d.high), low: round(d.low), close: round(d.close),
      vwap: round(d.vwap), changePct: round(d.changePct, 2), rangePct: round(d.rangePct, 2), closeLoc: round(d.closeLoc, 2),
    })),
    bars15: bars15.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })),
    levels,
  };
}

/** Place a price on a cached map: roles, distances, role reversals, nearest levels, read-out. */
export function applyPrice(map, price = null, priceTs = null) {
  const refPrice = price ?? map.lastClose;
  const tol = map.tolerance;
  const levels = map.levels.map(l => {
    const role = roleAt(l, refPrice, tol);
    return {
      ...l, role,
      distPct: round(((l.price - refPrice) / refPrice) * 100, 2),
      flipped: (role === 'support' && l.madeHighs && !l.madeLows) ? 'resistance→support'
        : (role === 'resistance' && l.madeLows && !l.madeHighs) ? 'support→resistance' : null,
    };
  });
  const supports = levels.filter(l => l.role === 'support');
  const resists = levels.filter(l => l.role === 'resistance');
  const nS = supports[0] || null;                           // levels are sorted high→low
  const nR = resists[resists.length - 1] || null;
  const hi5 = map.high5.price, lo5 = map.low5.price;
  const rangePos = hi5 > lo5 ? (refPrice - lo5) / (hi5 - lo5) : null;
  return {
    ...map, levels,
    refPrice: round(refPrice), refPriceTs: priceTs, refIsLive: price != null,
    rangePos: rangePos == null ? null : round(Math.max(0, Math.min(1, rangePos)), 3),
    nearestSupport: nS ? nS.price : null,
    nearestResistance: nR ? nR.price : null,
    playbook: playbook({ symbol: map.symbol, refPrice, nS, nR, supports, resists, structure: map.structure, rangePos, hi5, lo5 }),
  };
}

function compressProfile(p, maxRows) {
  const n = p.vol.length;
  const step = Math.max(1, Math.ceil(n / maxRows));
  const rows = [];
  for (let i = 0; i < n; i += step) {
    let v = 0; for (let k = i; k < Math.min(n, i + step); k++) v += p.vol[k];
    rows.push({ lo: round(p.base + i * p.binSize), hi: round(p.base + Math.min(n, i + step) * p.binSize), v: Math.round(v) });
  }
  return rows;
}

function f2(v) { return v.toFixed(2); }
function lvlTxt(l) { return l.isZone ? `${f2(l.lo)}–${f2(l.hi)}` : f2(l.price); }
function why(l) { return `${l.tier} · ${l.sources.slice(0, 2).join(', ')}${l.held ? ` · held ${l.held}×` : ''}`; }

/** Plain-English, rule-based reading. Educational — never a recommendation. */
export function playbook({ symbol, refPrice, nS, nR, supports, resists, structure, rangePos, hi5, lo5 }) {
  const out = [];
  if (rangePos != null) {
    const pos = rangePos >= 0.8 ? 'near the top' : rangePos <= 0.2 ? 'near the bottom' : rangePos >= 0.55 ? 'in the upper half' : rangePos <= 0.45 ? 'in the lower half' : 'in the middle';
    out.push({ tone: 'neutral', title: `${symbol} is ${pos} of its 5-day range`, text: `The last five sessions ran from ${f2(lo5)} to ${f2(hi5)}. ${structure.label}.` });
  }
  if (nR) {
    const nextR = resists.length > 1 ? resists[resists.length - 2] : null;
    out.push({ tone: 'bearish', title: `Overhead: ${lvlTxt(nR)} (${(((nR.price - refPrice) / refPrice) * 100).toFixed(2)}% away)`, text: `${why(nR)}. Sellers have to be absorbed here first.${nextR ? ` A 15-minute close above it puts ${lvlTxt(nextR)} next in line.` : ' Above it, price would be at a fresh 5-day high with no level from this window overhead.'}` });
  } else {
    out.push({ tone: 'bullish', title: 'No 5-day resistance overhead', text: `Price is above every level from the last five sessions — it is trading at a fresh 5-day high. Prior levels below become the reference.` });
  }
  if (nS) {
    const nextS = supports.length > 1 ? supports[1] : null;
    out.push({ tone: 'bullish', title: `Underneath: ${lvlTxt(nS)} (${(((nS.price - refPrice) / refPrice) * 100).toFixed(2)}% away)`, text: `${why(nS)}. Buyers defended this area before.${nextS ? ` A 15-minute close below it opens ${lvlTxt(nextS)}.` : ' Below it there is no level from this window — price would be making a new 5-day low.'}` });
  } else {
    out.push({ tone: 'bearish', title: 'No 5-day support underneath', text: 'Price is below every level from the last five sessions — it is trading at a fresh 5-day low.' });
  }
  const flips = [...supports, ...resists].filter(l => l.flipped);
  if (flips.length) {
    const f = flips.sort((a, b) => Math.abs(a.price - refPrice) - Math.abs(b.price - refPrice))[0];
    out.push({ tone: 'neutral', title: `Role reversal at ${lvlTxt(f)}`, text: f.flipped === 'resistance→support'
      ? 'This area capped price earlier in the window and price is now above it. Old resistance often gets retested as support.'
      : 'This area held price up earlier in the window and price is now below it. Old support often gets retested as resistance.' });
  }
  return out;
}
