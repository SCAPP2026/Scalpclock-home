// Market Intelligence — bull/bear evidence engine (spec phases 3, 6 and 8).
//
// Pure, like market-intel.js: no network, no clock. Takes an analyzeEtf()
// result plus the raw 5-minute bars and returns
//   - two independent 100-point scores (bullish evidence, bearish evidence)
//   - a five-state condition (STRONG BULLISH … STRONG BEARISH)
//   - a setup label (CALL SETUP DEVELOPING, NO TRADE, …)
//   - an entry-confirmation state for each side, driven by 5-minute closes
//
// Missing data is never redistributed: a category without data scores 0 on
// both sides and lowers `coverage`, which lowers what we are willing to say.
// The weights and thresholds are starting points — they have NOT been
// back-tested, and the UI says so.
import { marketSession, splitSessions, emaSeries, findPivots, round } from './market-intel.js';

export const DEFAULT_EVIDENCE_CONFIG = {
  weights: {
    vwap: 15, ema: 15, structure: 15, volume: 15, levels: 15, breadth: 10, momentum: 10, liquidity: 5,
  },
  // Score bands (inclusive lower bounds).
  bands: { strong: 80, favorable: 65, mixed: 50 },
  // Below this much data coverage we only say INSUFFICIENT DATA.
  minCoverage: 60,
  // A setup needs its side to lead by at least this many points.
  minLead: 20,
  // High-impact release this close (minutes) → MARKET TOO VOLATILE.
  eventLockMinutes: 60,
  // Today's range this many daily ATRs wide → MARKET TOO VOLATILE.
  rangeAtrLimit: 1.5,
  // A confirmation older than this many minutes is treated as expired.
  confirmWindowMin: 30,
  // No new confirmations after this ET time (minutes after midnight).
  lastEntryMinutes: 15 * 60 + 45,
};

const MIN = 60 * 1000;
const RTH_OPEN = 9 * 60 + 30;

export function bandLabel(score, cfg = DEFAULT_EVIDENCE_CONFIG) {
  if (score >= cfg.bands.strong) return 'Strong evidence';
  if (score >= cfg.bands.favorable) return 'Favorable evidence';
  if (score >= cfg.bands.mixed) return 'Mixed evidence';
  return 'Weak evidence';
}

/**
 * Regular-session 5-minute bars for the last few sessions up to and including
 * `refDate`, flattened, with a running per-session VWAP on every bar. EMAs are
 * computed across sessions (the way most charts draw them) so they exist from
 * the first bar of the day.
 */
export function intradaySeries(intradayRaw, refDate, sessionsBack = 4) {
  const sessions = splitSessions(intradayRaw);
  const dates = Object.keys(sessions).filter(d => d <= refDate && sessions[d].reg.length).sort().slice(-sessionsBack);
  const bars = [];
  for (const d of dates) {
    let pv = 0, vol = 0;
    for (const b of sessions[d].reg) {
      if (b.v) { pv += ((b.h + b.l + b.c) / 3) * b.v; vol += b.v; }
      bars.push({ ...b, date: d, vwap: vol > 0 ? pv / vol : null });
    }
  }
  const closes = bars.map(b => b.c);
  const e9 = emaSeries(closes, 9), e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50);
  bars.forEach((b, i) => { b.e9 = e9[i] ?? null; b.e20 = e20[i] ?? null; b.e50 = e50[i] ?? null; });
  const today = bars.filter(b => b.date === refDate);
  return { bars, today, dates };
}

/**
 * Swing structure from fractal pivots. Compares the last two swing highs and
 * the last two swing lows.
 */
export function priceStructure(bars, span = 2) {
  const piv = findPivots(bars, span);
  const highs = piv.filter(p => p.kind === 'high'), lows = piv.filter(p => p.kind === 'low');
  if (highs.length < 2 || lows.length < 2) {
    return { kind: 'insufficient', hh: null, hl: null, lastHigh: highs.at(-1) || null, lastLow: lows.at(-1) || null,
      text: 'Not enough completed swings yet to read structure.' };
  }
  const [h1, h2] = highs.slice(-2), [l1, l2] = lows.slice(-2);
  const hh = h2.price > h1.price, hl = l2.price > l1.price;
  const lh = h2.price < h1.price, ll = l2.price < l1.price;
  const kind = hh && hl ? 'uptrend' : lh && ll ? 'downtrend' : 'mixed';
  const f = v => round(v);
  const text = kind === 'uptrend' ? `Higher highs (${f(h1.price)} → ${f(h2.price)}) and higher lows (${f(l1.price)} → ${f(l2.price)}).`
    : kind === 'downtrend' ? `Lower highs (${f(h1.price)} → ${f(h2.price)}) and lower lows (${f(l1.price)} → ${f(l2.price)}).`
    : `Swings disagree: highs ${f(h1.price)} → ${f(h2.price)}, lows ${f(l1.price)} → ${f(l2.price)}.`;
  return { kind, hh, hl, lh, ll, lastHigh: h2, lastLow: l2, text };
}

/** Classic floor-trader pivots from the previous session's H/L/C. */
export function classicPivots(prev) {
  if (!prev || prev.h == null || prev.l == null || prev.c == null) return null;
  const P = (prev.h + prev.l + prev.c) / 3, R = prev.h - prev.l;
  return { P: round(P), R1: round(2 * P - prev.l), S1: round(2 * P - prev.h), R2: round(P + R), S2: round(P - R) };
}

/**
 * @param {object} a
 * @param {object} a.e          analyzeEtf() result
 * @param {Array}  a.all        all analyzeEtf() results
 * @param {Array}  a.intradayRaw raw 5-minute bars for this symbol
 * @param {number} a.nowMs
 * @param {Array|null} a.events calendar events or null when unavailable
 * @param {object|null} a.liquidity { spreadPct, openInterest, volume } of the near-ATM contract, or null
 * @param {object} [a.config]
 */
export function scoreEvidence({ e, all, intradayRaw, nowMs, events, liquidity = null, config = DEFAULT_EVIDENCE_CONFIG }) {
  const cfg = { ...DEFAULT_EVIDENCE_CONFIG, ...config, weights: { ...DEFAULT_EVIDENCE_CONFIG.weights, ...(config.weights || {}) } };
  const W = cfg.weights;
  const session = marketSession(nowMs);
  const { today, bars } = intradaySeries(intradayRaw || [], e.refDate);
  const last = bars.at(-1) || null;
  const cats = [];
  // bull/bear are fractions 0..1 of the category weight.
  const add = (key, label, bull, bear, dataOk, reason, source) => cats.push({
    key, label, weight: W[key], dataOk,
    bull: dataOk ? round(W[key] * bull, 1) : 0, bear: dataOk ? round(W[key] * bear, 1) : 0,
    reason, source,
  });

  // 1. VWAP positioning — above/below, and whether the last 3 closes held.
  if (e.vwap == null || e.price == null) add('vwap', 'VWAP positioning', 0, 0, false, 'No session VWAP yet (the regular session has not traded).', 'calculated');
  else {
    const d = e.vwapDistPct;
    const last3 = today.slice(-3);
    const held = last3.length === 3 && last3.every(b => b.vwap != null && b.c > b.vwap);
    const lost = last3.length === 3 && last3.every(b => b.vwap != null && b.c < b.vwap);
    const bull = d > 0.05 ? (held ? 1 : 2 / 3) : 0, bear = d < -0.05 ? (lost ? 1 : 2 / 3) : 0;
    add('vwap', 'VWAP positioning', bull, bear, true,
      `Price ${e.price} is ${Math.abs(d).toFixed(2)}% ${d >= 0 ? 'above' : 'below'} VWAP ${e.vwap}.`
      + (held ? ' The last three 5-minute closes all held above it.' : lost ? ' The last three 5-minute closes all stayed below it.' : Math.abs(d) <= 0.05 ? ' That is effectively at VWAP — neither side is in control.' : ' It has not held on every recent close.'),
      'calculated');
  }

  // 2. EMA alignment on the 5-minute chart (9 / 20 / 50).
  if (!last || last.e9 == null || last.e20 == null || last.e50 == null) add('ema', 'EMA alignment (5-min 9/20/50)', 0, 0, false, 'Not enough 5-minute bars for the 50 EMA.', 'calculated');
  else {
    const p = e.price ?? last.c;
    const bull = ((p > last.e9) + (last.e9 > last.e20) + (last.e20 > last.e50)) / 3;
    const bear = ((p < last.e9) + (last.e9 < last.e20) + (last.e20 < last.e50)) / 3;
    add('ema', 'EMA alignment (5-min 9/20/50)', bull, bear, true,
      `Price ${p}, 9 EMA ${round(last.e9)}, 20 EMA ${round(last.e20)}, 50 EMA ${round(last.e50)}. `
      + (bull === 1 ? 'Fully stacked bullish.' : bear === 1 ? 'Fully stacked bearish.' : 'Not fully stacked either way.'),
      'calculated');
  }

  // 3. Price structure (higher highs / higher lows on today's 5-minute bars).
  const struct = priceStructure(today.length >= 10 ? today : bars.slice(-40));
  if (struct.kind === 'insufficient') add('structure', 'Price structure', 0, 0, false, struct.text, 'calculated');
  else add('structure', 'Price structure',
    struct.kind === 'uptrend' ? 1 : (struct.hh || struct.hl) && !(struct.lh && struct.ll) ? 0.4 : 0,
    struct.kind === 'downtrend' ? 1 : (struct.lh || struct.ll) && !(struct.hh && struct.hl) ? 0.4 : 0,
    true, struct.text, 'calculated');

  // 4. Volume confirmation — relative volume in the direction of the session move.
  const sinceOpen = e.perf ? e.perf.sinceOpen : null;
  if (e.rvol == null || sinceOpen == null) add('volume', 'Volume confirmation', 0, 0, false, 'Relative volume is not available yet this session.', 'calculated');
  else {
    const dir = sinceOpen > 0.1 ? 1 : sinceOpen < -0.1 ? -1 : 0;
    const f = e.rvol >= 1.2 ? 1 : e.rvol >= 1.0 ? 0.5 : 0;
    add('volume', 'Volume confirmation', dir > 0 ? f : 0, dir < 0 ? f : 0, true,
      `Relative volume ${e.rvol}× (IEX-only, ${e.rvolBasis}); price ${sinceOpen >= 0 ? '+' : ''}${sinceOpen}% since the open. `
      + (dir === 0 ? 'No meaningful move since the open for volume to confirm.' : f === 1 ? 'Above-average participation behind the move.' : f ? 'About normal participation.' : 'Light participation — moves like this fail more often.'),
      'calculated');
  }

  // 5. Support/resistance reaction.
  if (e.price == null || e.prevDayHigh == null) add('levels', 'Support/resistance reaction', 0, 0, false, 'Missing price or the previous-day range.', 'calculated');
  else {
    const near = role => e.levels.filter(l => l.role === role && l.distPct != null).sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct))[0] || null;
    const res = near('resistance'), sup = near('support');
    const bullPos = e.price > e.prevDayHigh ? 2 / 3 : e.price > e.prevClose ? 1 / 3 : 0;
    const bearPos = e.price < e.prevDayLow ? 2 / 3 : e.price < e.prevClose ? 1 / 3 : 0;
    const bullRoom = !res || Math.abs(res.distPct) >= 0.25 ? 1 / 3 : 0;
    const bearRoom = !sup || Math.abs(sup.distPct) >= 0.25 ? 1 / 3 : 0;
    add('levels', 'Support/resistance reaction', bullPos + (bullPos ? bullRoom : 0), bearPos + (bearPos ? bearRoom : 0), true,
      `${e.price > e.prevDayHigh ? `Above yesterday's high ${e.prevDayHigh}` : e.price < e.prevDayLow ? `Below yesterday's low ${e.prevDayLow}` : `Inside yesterday's range ${e.prevDayLow}–${e.prevDayHigh}`}, `
      + `${e.price >= e.prevClose ? 'above' : 'below'} the previous close ${e.prevClose}. `
      + `Nearest resistance ${res ? `${res.label} ${res.price} (${Math.abs(res.distPct)}% away)` : 'none mapped'}; nearest support ${sup ? `${sup.label} ${sup.price} (${Math.abs(sup.distPct)}% away)` : 'none mapped'}.`,
      'calculated');
  }

  // 6. Market breadth — proxy: do the other two ETFs move the same way?
  // NYSE/Nasdaq advance-decline data is not in our feed, and the UI says so.
  const others = all.filter(x => x.symbol !== e.symbol && x.changePct != null);
  if (e.changePct == null || others.length < 2) add('breadth', 'Market breadth (cross-ETF proxy)', 0, 0, false, 'Need all three ETFs to compare.', 'calculated');
  else {
    const up = others.filter(o => o.changePct > 0.1).length, dn = others.filter(o => o.changePct < -0.1).length;
    add('breadth', 'Market breadth (cross-ETF proxy)', up / 2, dn / 2, true,
      `${others.map(o => `${o.symbol} ${o.changePct > 0 ? '+' : ''}${o.changePct}%`).join(', ')}. True advance/decline breadth is not in our data feed, so this uses the other two ETFs as a stand-in.`,
      'calculated');
  }

  // 7. Momentum — 5-minute RSI(14), falling back to daily.
  const r = e.rsiIntraday ?? e.rsiDaily;
  if (r == null) add('momentum', 'Momentum (RSI 14)', 0, 0, false, 'Not enough bars for RSI.', 'calculated');
  else {
    const bull = r >= 55 && r < 75 ? 1 : r >= 75 ? 0.5 : r >= 50 ? 0.3 : 0;
    const bear = r <= 45 && r > 25 ? 1 : r <= 25 ? 0.5 : r <= 50 ? 0.3 : 0;
    add('momentum', 'Momentum (RSI 14)', bull, bear, true,
      `${e.rsiIntraday != null ? '5-minute' : 'Daily'} RSI ${r}.${r >= 75 ? ' Stretched — late call entries risk buying the top.' : r <= 25 ? ' Stretched — late put entries risk selling the bottom.' : ''}`,
      'calculated');
  }

  // 8. Options liquidity — same for both sides; it says whether the trade is
  // practical, not which way it goes.
  if (!liquidity || liquidity.spreadPct == null) add('liquidity', 'Options liquidity', 0, 0, false, 'Near-the-money contract quotes not available.', 'delayed');
  else {
    const ok = liquidity.spreadPct <= 5 && (liquidity.openInterest ?? 0) >= 500;
    const fair = liquidity.spreadPct <= 10;
    const f = ok ? 1 : fair ? 0.5 : 0;
    add('liquidity', 'Options liquidity', f, f, true,
      `Nearest-expiry at-the-money contracts: spread ${liquidity.spreadPct}% of mid, open interest ${liquidity.openInterest ?? 'n/a'}, volume ${liquidity.volume ?? 'n/a'} (CBOE delayed).`,
      'delayed');
  }

  const bull = Math.round(cats.reduce((s, c) => s + c.bull, 0));
  const bear = Math.round(cats.reduce((s, c) => s + c.bear, 0));
  const coverage = cats.filter(c => c.dataOk).reduce((s, c) => s + c.weight, 0);
  const missing = cats.filter(c => !c.dataOk).map(c => c.label);

  // Five-state condition.
  const net = bull - bear;
  const condition = coverage < cfg.minCoverage ? 'INSUFFICIENT DATA'
    : bull >= cfg.bands.strong && net >= 40 ? 'STRONG BULLISH'
    : bull >= cfg.bands.favorable && net >= cfg.minLead ? 'BULLISH'
    : bear >= cfg.bands.strong && -net >= 40 ? 'STRONG BEARISH'
    : bear >= cfg.bands.favorable && -net >= cfg.minLead ? 'BEARISH'
    : 'NEUTRAL';

  // Volatility locks.
  const soonEvent = (events || []).filter(ev => ev.impact === 'high' && ev.ts != null && ev.ts > nowMs && ev.ts - nowMs <= cfg.eventLockMinutes * MIN)
    .sort((a, b) => a.ts - b.ts)[0] || null;
  const dayRange = e.dayHigh != null && e.dayLow != null ? e.dayHigh - e.dayLow : null;
  const wideRange = dayRange != null && e.atrDaily ? dayRange >= cfg.rangeAtrLimit * e.atrDaily : false;

  let setup, setupWhy;
  if (coverage < cfg.minCoverage) { setup = 'INSUFFICIENT DATA'; setupWhy = `Only ${coverage}/100 points of evidence have data (missing: ${missing.join(', ')}).`; }
  else if (soonEvent) { setup = 'MARKET TOO VOLATILE'; setupWhy = `${soonEvent.name} is due within ${cfg.eventLockMinutes} minutes — spreads and whipsaw risk usually jump around releases.`; }
  else if (wideRange) { setup = 'MARKET TOO VOLATILE'; setupWhy = `Today's range (${round(dayRange)}) is already ${round(dayRange / e.atrDaily, 1)}× a normal day (ATR ${e.atrDaily}).`; }
  else if (session.state !== 'regular') { setup = 'NO TRADE'; setupWhy = `${session.label}. This is a read of the last session to prepare with — setups are only evaluated while the regular session is open.`; }
  else if (bull < cfg.bands.mixed && bear < cfg.bands.mixed) { setup = 'NO TRADE'; setupWhy = 'Both sides have weak evidence.'; }
  else if (bull >= cfg.bands.favorable && net >= cfg.minLead) { setup = 'CALL SETUP DEVELOPING'; setupWhy = `Bullish evidence ${bull} leads bearish ${bear} by ${net} points.`; }
  else if (bear >= cfg.bands.favorable && -net >= cfg.minLead) { setup = 'PUT SETUP DEVELOPING'; setupWhy = `Bearish evidence ${bear} leads bullish ${bull} by ${-net} points.`; }
  else { setup = 'CONFIRMATION REQUIRED'; setupWhy = `Bullish ${bull} vs bearish ${bear}: one side needs to clearly take over before a setup forms.`; }

  const confirmation = {
    call: confirmState('call', { today, e, struct, cats, nowMs, session, cfg, liquidity }),
    put: confirmState('put', { today, e, struct, cats, nowMs, session, cfg, liquidity }),
  };

  // Reasons and invalidation for the leading side.
  const lead = net > 0 ? 'bull' : net < 0 ? 'bear' : null;
  const reasons = lead ? cats.filter(c => c.dataOk && c[lead] >= c.weight * 0.5).map(c => c.reason) : [];
  const invalidation = lead === 'bull' ? [
    e.vwap != null ? `A 5-minute close back below VWAP (${e.vwap}).` : 'Price failing to hold above VWAP once it forms.',
    struct.lastLow ? `A break of the last swing low (${round(struct.lastLow.price)}) — that ends the higher-low pattern.` : 'A lower low on the 5-minute chart.',
    'RSI rolling over below 50 while price stalls.',
    'SPY, QQQ and IWM stop moving together.',
  ] : lead === 'bear' ? [
    e.vwap != null ? `A 5-minute close back above VWAP (${e.vwap}).` : 'Price reclaiming VWAP once it forms.',
    struct.lastHigh ? `A break of the last swing high (${round(struct.lastHigh.price)}) — that ends the lower-high pattern.` : 'A higher high on the 5-minute chart.',
    'RSI turning back above 50 while price stalls.',
    'SPY, QQQ and IWM stop moving together.',
  ] : ['No side leads, so there is no outlook to invalidate yet.'];

  return {
    symbol: e.symbol,
    bull, bear, coverage, missing,
    bullBand: bandLabel(bull, cfg), bearBand: bandLabel(bear, cfg),
    condition, setup, setupWhy,
    categories: cats, reasons, invalidation,
    structure: { kind: struct.kind, text: struct.text },
    ema5m: last ? { e9: round(last.e9), e20: round(last.e20), e50: round(last.e50) } : null,
    confirmation,
    config: { weights: W, bands: cfg.bands, minCoverage: cfg.minCoverage, minLead: cfg.minLead },
    disclaimer: 'Evidence scores are a transparent checklist, not a probability. Weights and thresholds are preliminary and have not been back-tested. Nothing here recommends a specific contract.',
  };
}

/**
 * Entry confirmation for one side, from today's completed 5-minute bars.
 *
 * Trigger (calls): a 5-minute CLOSE above the higher of the last swing high
 * and the opening-range high, while above VWAP, on volume at least the
 * average of the prior 10 bars. Puts mirror it. An indicator cross alone
 * never confirms.
 *
 * States: developing → confirmed → invalidated (close back through the
 * broken level or VWAP) | expired (window passed, or too late in the day).
 */
export function confirmState(side, { today, e, struct, cats, nowMs, session, cfg, liquidity }) {
  const up = side === 'call';
  const cat = k => cats.find(c => c.key === k);
  const sideKey = up ? 'bull' : 'bear';
  const met = k => { const c = cat(k); return !c || !c.dataOk ? null : c[sideKey] >= c.weight * 0.6; };
  const lastBar = today.at(-1) || null;

  const checklist = [
    { key: 'structure', label: up ? 'Price establishes bullish structure (higher highs and higher lows)' : 'Price establishes bearish structure (lower highs and lower lows)', met: struct.kind === 'insufficient' ? null : struct.kind === (up ? 'uptrend' : 'downtrend') },
    { key: 'vwap', label: up ? 'Price holds or reclaims VWAP' : 'Price loses or rejects VWAP', met: lastBar && lastBar.vwap != null ? (up ? lastBar.c > lastBar.vwap : lastBar.c < lastBar.vwap) : null },
    { key: 'ema', label: up ? '9 EMA above 20 EMA (5-min) supports the move' : '9 EMA below 20 EMA (5-min) supports the move', met: lastBar && lastBar.e9 != null && lastBar.e20 != null ? (up ? lastBar.e9 > lastBar.e20 : lastBar.e9 < lastBar.e20) : null },
    { key: 'defend', label: up ? 'Buyers defend support' : 'Sellers defend resistance', met: defended(today, up) },
    { key: 'volume', label: up ? 'Volume confirms the breakout' : 'Volume confirms the breakdown', met: null },
    { key: 'breadth', label: 'Broader market is supportive', met: met('breadth') },
    { key: 'liquidity', label: 'Options contract has adequate liquidity', met: liquidity && liquidity.spreadPct != null ? met('liquidity') : null },
  ];

  if (session.state !== 'regular' && !session.regularOver) {
    return { state: 'none', label: 'Waiting for the open', detail: 'Confirmation is only evaluated on regular-session 5-minute closes.', checklist, trigger: null };
  }

  // Walk the session looking for the most recent trigger.
  let trigger = null;
  for (let i = 3; i < today.length; i++) {
    const b = today[i];
    if (b.vwap == null) continue;
    const prior = today.slice(0, i);
    const piv = findPivots(prior, 2).filter(p => p.kind === (up ? 'high' : 'low'));
    const swing = piv.length ? piv.at(-1).price : null;
    const or = prior.filter(x => x.minutes < RTH_OPEN + 15);
    const orComplete = prior.some(x => x.minutes >= RTH_OPEN + 15);
    const orLvl = orComplete && or.length ? (up ? Math.max(...or.map(x => x.h)) : Math.min(...or.map(x => x.l))) : null;
    const cands = [swing, orLvl].filter(v => v != null);
    if (!cands.length) continue;
    const level = up ? Math.max(...cands) : Math.min(...cands);
    const avgVol = prior.slice(-10).reduce((s, x) => s + (x.v || 0), 0) / Math.min(10, prior.length);
    const crossed = up ? (b.c > level && prior.at(-1).c <= level) : (b.c < level && prior.at(-1).c >= level);
    const vwapOk = up ? b.c > b.vwap : b.c < b.vwap;
    if (crossed && vwapOk && (b.v || 0) >= avgVol) {
      trigger = { index: i, t: b.t, minutes: b.minutes, close: round(b.c), level: round(level),
        levelName: level === swing ? 'last swing ' + (up ? 'high' : 'low') : 'opening-range ' + (up ? 'high' : 'low'),
        volRatio: round(avgVol ? b.v / avgVol : null, 2) };
    }
  }
  const volItem = checklist.find(c => c.key === 'volume');
  if (trigger) volItem.met = true;

  const fmtT = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} ET`;
  if (!trigger) {
    const late = session.state === 'regular' && lastBar && lastBar.minutes >= cfg.lastEntryMinutes;
    if (session.regularOver || late) return { state: 'expired', label: 'Setup expired', detail: 'No confirmation before the late-session cutoff.', checklist, trigger: null };
    return { state: 'developing', label: 'Developing', detail: up
      ? 'Waiting for a 5-minute close above the last swing high or opening-range high, above VWAP, on at least average volume.'
      : 'Waiting for a 5-minute close below the last swing low or opening-range low, below VWAP, on at least average volume.', checklist, trigger: null };
  }

  // After the trigger: invalidated by a close back through the level or VWAP.
  const after = today.slice(trigger.index + 1);
  const fail = after.find(b => up ? (b.c < trigger.level || (b.vwap != null && b.c < b.vwap)) : (b.c > trigger.level || (b.vwap != null && b.c > b.vwap)));
  const trigText = `5-minute close ${trigger.close} ${up ? 'above' : 'below'} the ${trigger.levelName} (${trigger.level}) at ${fmtT(trigger.minutes)}, volume ${trigger.volRatio}× the prior 10-bar average.`;
  if (fail) return { state: 'invalidated', label: 'Entry conditions invalidated', detail: `${trigText} Then a 5-minute close at ${round(fail.c)} (${fmtT(fail.minutes)}) went back ${up ? 'below' : 'above'} the level or VWAP.`, checklist, trigger };
  const ageMin = (nowMs - (trigger.t + 5 * MIN)) / MIN;
  if (ageMin > cfg.confirmWindowMin || session.regularOver) return { state: 'expired', label: 'Setup expired', detail: `${trigText} That was ${Math.round(ageMin)} minutes ago — the entry window has passed. Wait for a fresh setup instead of chasing.`, checklist, trigger };
  return { state: 'confirmed', label: 'Confirmation received', detail: trigText, checklist, trigger };
}

// Did price test a support (resistance) in the last 6 bars and close back away from it?
// Uses VWAP and the 20 EMA as the dynamic levels being defended.
function defended(today, up) {
  const w = today.slice(-6);
  if (w.length < 3) return null;
  return w.some(b => {
    const lvls = [b.vwap, b.e20].filter(v => v != null);
    return lvls.some(l => up ? (b.l <= l * 1.0005 && b.c > l) : (b.h >= l * 0.9995 && b.c < l));
  });
}
