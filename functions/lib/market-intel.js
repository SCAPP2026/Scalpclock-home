// Market Intelligence Center — pure calculation module (SPY / QQQ / IWM).
//
// No network, no env, no Date.now(): every function takes its inputs
// explicitly so tests/market-intel.test.mjs can run this exact code against
// recorded bars. functions/api/market-intel.js owns fetching + caching and
// calls into here.
//
// Three kinds of output are kept distinct all the way to the UI:
//   FACT        — a number straight from a provider (price, bar high, yield)
//   CALCULATED  — arithmetic on facts (VWAP, EMA, correlation, RVOL)
//   INTERPRETATION — a rule-based reading of the above (bias, scenarios)
// Interpretations are rules of thumb, never probabilities — nothing here has
// been back-tested, so no output is expressed as a win rate or a percentage
// confidence.

export const ETFS = ['SPY', 'QQQ', 'IWM'];
export const ETF_NAMES = {
  SPY: 'S&P 500 ETF',
  QQQ: 'Nasdaq-100 ETF',
  IWM: 'Russell 2000 ETF',
};

const MIN = 60 * 1000;

// ── Eastern Time helpers ────────────────────────────────────────────────────
const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short',
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function etParts(ms) {
  const p = {};
  for (const part of ET_FMT.formatToParts(new Date(ms))) p[part.type] = part.value;
  const hh = +p.hour, mm = +p.minute;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    y: +p.year, m: +p.month, d: +p.day,
    hh, mm, minutes: hh * 60 + mm, dow: DOW[p.weekday],
  };
}

function pad(n) { return String(n).padStart(2, '0'); }
function ymd(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }
// Day-of-week for a calendar date (timezone-free: uses UTC noon).
function dowOf(dateStr) { return new Date(dateStr + 'T12:00:00Z').getUTCDay(); }
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function nthWeekday(y, m, dow, n) {
  const first = dowOf(ymd(y, m, 1));
  return ymd(y, m, 1 + ((dow - first + 7) % 7) + (n - 1) * 7);
}
function lastWeekday(y, m, dow) {
  const lastDay = new Date(Date.UTC(y, m, 0, 12)).getUTCDate();
  const last = dowOf(ymd(y, m, lastDay));
  return ymd(y, m, lastDay - ((last - dow + 7) % 7));
}
// Anonymous Gregorian algorithm → Easter Sunday; Good Friday is two days before.
function goodFriday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return addDays(ymd(y, month, day), -2);
}
// Fixed-date holidays: Saturday → observed Friday, Sunday → observed Monday.
// NYSE Rule 7.2 exception: New Year's Day on a Saturday is NOT observed on
// the preceding Friday (that Friday is in the prior year).
function observed(dateStr, { skipSaturday = false } = {}) {
  const dow = dowOf(dateStr);
  if (dow === 6) return skipSaturday ? null : addDays(dateStr, -1);
  if (dow === 0) return addDays(dateStr, 1);
  return dateStr;
}
const holidayCache = new Map();
export function nyseHolidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const list = [
    observed(ymd(y, 1, 1), { skipSaturday: true }),
    nthWeekday(y, 1, 1, 3),      // Martin Luther King Jr. Day
    nthWeekday(y, 2, 1, 3),      // Washington's Birthday
    goodFriday(y),
    lastWeekday(y, 5, 1),        // Memorial Day
    observed(ymd(y, 6, 19)),     // Juneteenth
    observed(ymd(y, 7, 4)),      // Independence Day
    nthWeekday(y, 9, 1, 1),      // Labor Day
    nthWeekday(y, 11, 4, 4),     // Thanksgiving
    observed(ymd(y, 12, 25)),    // Christmas
  ].filter(Boolean);
  const set = new Set(list);
  holidayCache.set(y, set);
  return set;
}
export function isTradingDay(dateStr) {
  const dow = dowOf(dateStr);
  if (dow === 0 || dow === 6) return false;
  return !nyseHolidays(+dateStr.slice(0, 4)).has(dateStr);
}
// 1:00 PM ET closes: the day after Thanksgiving and Christmas Eve, when
// those fall on a trading day. (Other one-off early closes the exchange
// announces year by year are not modelled.)
export function closeMinutes(dateStr) {
  const y = +dateStr.slice(0, 4);
  if (dateStr === addDays(nthWeekday(y, 11, 4, 4), 1)) return 13 * 60;
  if (dateStr === ymd(y, 12, 24)) return 13 * 60;
  return 16 * 60;
}
export function nextTradingDay(dateStr) {
  let d = addDays(dateStr, 1);
  for (let i = 0; i < 12 && !isTradingDay(d); i++) d = addDays(d, 1);
  return d;
}
export function prevTradingDay(dateStr) {
  let d = addDays(dateStr, -1);
  for (let i = 0; i < 12 && !isTradingDay(d); i++) d = addDays(d, -1);
  return d;
}

const PRE_OPEN = 4 * 60, RTH_OPEN = 9 * 60 + 30, POST_CLOSE = 20 * 60;

/** Where are we in the trading day? All times Eastern. */
export function marketSession(nowMs) {
  const et = etParts(nowMs);
  const trading = isTradingDay(et.date);
  const close = closeMinutes(et.date);
  let state = 'closed';
  if (trading) {
    if (et.minutes >= PRE_OPEN && et.minutes < RTH_OPEN) state = 'premarket';
    else if (et.minutes >= RTH_OPEN && et.minutes < close) state = 'regular';
    else if (et.minutes >= close && et.minutes < POST_CLOSE) state = 'afterhours';
  }
  // refDate: the session the dashboard describes. From 4:00 AM on a trading
  // day that is today; otherwise it is the most recent trading day.
  const refDate = (trading && et.minutes >= PRE_OPEN) ? et.date : prevTradingDay(et.date);
  const nextOpenDate = (trading && et.minutes < RTH_OPEN) ? et.date : nextTradingDay(et.date);
  const LABELS = {
    premarket: 'Premarket', regular: 'Regular session',
    afterhours: 'After-hours', closed: 'Market closed',
  };
  return {
    state, label: LABELS[state], etDate: et.date, etMinutes: et.minutes,
    refDate, nextOpenDate,
    earlyClose: trading && close < 16 * 60,
    regularOver: trading && et.minutes >= close,
  };
}

// ── Indicators ──────────────────────────────────────────────────────────────
export function round(v, dp = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
export function sma(values, n) {
  if (!values || values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}
// Standard EMA seeded with the SMA of the first n values.
export function emaSeries(values, n) {
  if (!values || values.length < n) return [];
  const k = 2 / (n + 1);
  const out = new Array(values.length).fill(null);
  let e = 0;
  for (let i = 0; i < n; i++) e += values[i];
  e /= n;
  out[n - 1] = e;
  for (let i = n; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
export function ema(values, n) {
  const s = emaSeries(values, n);
  return s.length ? s[s.length - 1] : null;
}
// Wilder RSI.
export function rsi(closes, n = 14) {
  if (!closes || closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}
export function atr(bars, n = 14) {
  if (!bars || bars.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)));
  }
  let a = 0;
  for (let i = 0; i < n; i++) a += trs[i];
  a /= n;
  for (let i = n; i < trs.length; i++) a = (a * (n - 1) + trs[i]) / n;
  return a;
}
// Volume-weighted average price on typical price (H+L+C)/3.
export function vwap(bars) {
  let pv = 0, vol = 0;
  for (const b of bars || []) {
    if (!b.v) continue;
    pv += ((b.h + b.l + b.c) / 3) * b.v;
    vol += b.v;
  }
  return vol > 0 ? pv / vol : null;
}
export function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}
const pct = (a, b) => (a != null && b) ? ((a - b) / b) * 100 : null;

// ── Bar bucketing ───────────────────────────────────────────────────────────
/** Daily bars → add the ET calendar date each one belongs to. */
export function tagDaily(bars) {
  return (bars || []).map(b => ({ ...b, date: etParts(b.t + 12 * 60 * MIN).date }))
    .sort((a, b) => a.t - b.t);
}
/** 5-minute bars → { 'YYYY-MM-DD': { pre:[], reg:[], post:[] } } by ET session. */
export function splitSessions(bars) {
  const out = {};
  for (const b of bars || []) {
    const et = etParts(b.t);
    if (!isTradingDay(et.date)) continue;
    const close = closeMinutes(et.date);
    const day = out[et.date] || (out[et.date] = { pre: [], reg: [], post: [] });
    const bar = { ...b, minutes: et.minutes };
    if (et.minutes >= PRE_OPEN && et.minutes < RTH_OPEN) day.pre.push(bar);
    else if (et.minutes >= RTH_OPEN && et.minutes < close) day.reg.push(bar);
    else if (et.minutes >= close && et.minutes < POST_CLOSE) day.post.push(bar);
  }
  for (const d of Object.values(out)) for (const k of ['pre', 'reg', 'post']) d[k].sort((a, b) => a.t - b.t);
  return out;
}
function hiLo(bars) {
  if (!bars || !bars.length) return { high: null, low: null };
  let high = -Infinity, low = Infinity;
  for (const b of bars) { if (b.h > high) high = b.h; if (b.l < low) low = b.l; }
  return { high, low };
}
// ISO-week key (Monday start) and month key for grouping daily bars.
function weekKey(dateStr) {
  const dow = dowOf(dateStr);
  return addDays(dateStr, -((dow + 6) % 7));
}
function groupBars(daily, keyFn) {
  const groups = [];
  let cur = null;
  for (const b of daily) {
    const k = keyFn(b.date);
    if (!cur || cur.key !== k) {
      cur = { key: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, first: b.date, last: b.date };
      groups.push(cur);
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l);
      cur.c = b.c; cur.v += b.v || 0; cur.last = b.date;
    }
  }
  return groups;
}
export const toWeekly = daily => groupBars(daily, weekKey);
export const toMonthly = daily => groupBars(daily, d => d.slice(0, 7));

// ── Swing levels → reaction zones ───────────────────────────────────────────
/** Fractal pivots: a high (low) with `span` lower highs (higher lows) each side. */
export function findPivots(bars, span = 2) {
  const out = [];
  for (let i = span; i < bars.length - span; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= span; j++) {
      if (bars[i].h <= bars[i - j].h || bars[i].h <= bars[i + j].h) isHigh = false;
      if (bars[i].l >= bars[i - j].l || bars[i].l >= bars[i + j].l) isLow = false;
    }
    if (isHigh) out.push({ price: bars[i].h, kind: 'high', t: bars[i].t, date: bars[i].date });
    if (isLow) out.push({ price: bars[i].l, kind: 'low', t: bars[i].t, date: bars[i].date });
  }
  return out;
}
/** Cluster pivots that sit within `tolPct` of each other into zones. */
export function clusterZones(pivots, tolPct) {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const zones = [];
  for (const p of sorted) {
    const z = zones[zones.length - 1];
    // Chain only while the zone stays narrow — otherwise a run of evenly
    // spaced pivots would merge into one uselessly wide band.
    if (z && (p.price - z.hi) / z.hi * 100 <= tolPct && (p.price - z.lo) / z.lo * 100 <= tolPct * 2) {
      z.hi = p.price; z.touches++; z.dates.push(p.date);
    } else {
      zones.push({ lo: p.price, hi: p.price, touches: 1, dates: [p.date] });
    }
  }
  return zones;
}

// ── Per-ETF analysis ────────────────────────────────────────────────────────
const TESTING_PCT = 0.15;

function trendFromMAs(price, fast, slow, labelFast, labelSlow) {
  if (price == null || fast == null || slow == null) {
    return { dir: 'unknown', reason: `Not enough bars for ${labelFast}/${labelSlow}.` };
  }
  if (price > fast && fast > slow) return { dir: 'bullish', reason: `Price above ${labelFast}, and ${labelFast} above ${labelSlow}.` };
  if (price < fast && fast < slow) return { dir: 'bearish', reason: `Price below ${labelFast}, and ${labelFast} below ${labelSlow}.` };
  return { dir: 'neutral', reason: `Price and ${labelFast}/${labelSlow} are not stacked in one direction.` };
}

/**
 * @param {object} a
 * @param {string} a.symbol
 * @param {Array}  a.daily    raw daily bars {t,o,h,l,c,v}
 * @param {Array}  a.intraday raw 5-minute bars incl. extended hours
 * @param {object|null} a.trade latest trade {p, t(ms)}
 * @param {number} a.nowMs
 */
export function analyzeEtf({ symbol, daily: rawDaily, intraday, trade, nowMs }) {
  const session = marketSession(nowMs);
  const daily = tagDaily(rawDaily);
  const sessions = splitSessions(intraday);
  const ref = session.refDate;
  const today = sessions[ref] || { pre: [], reg: [], post: [] };
  const missing = [];

  // Completed daily history = everything before the reference session.
  const hist = daily.filter(b => b.date < ref);
  const refDaily = daily.find(b => b.date === ref) || null;
  const prev = hist[hist.length - 1] || null;
  const prevClose = prev ? prev.c : null;
  if (!prev) missing.push('previous close');

  // Price: latest trade when we have one, else the last bar we know about.
  const lastReg = today.reg[today.reg.length - 1] || null;
  const regClose = (session.state === 'afterhours' || session.state === 'closed')
    ? (lastReg ? lastReg.c : (refDaily ? refDaily.c : null)) : null;
  let price = trade && trade.p ? trade.p : null;
  let priceTs = trade && trade.t ? trade.t : null;
  if (price == null) {
    const lastBar = [...today.pre, ...today.reg, ...today.post].pop();
    if (lastBar) { price = lastBar.c; priceTs = lastBar.t + 5 * MIN; }
    else if (refDaily) { price = refDaily.c; priceTs = null; }
    missing.push('latest trade');
  }

  // Regular-hours change is always measured against the prior session's close.
  const changeBase = (session.state === 'closed' || session.state === 'afterhours') && regClose != null ? regClose : price;
  const change = (changeBase != null && prevClose != null) ? changeBase - prevClose : null;
  const changePct = pct(changeBase, prevClose);
  const extChange = regClose != null && price != null ? price - regClose : null;
  const extChangePct = regClose != null ? pct(price, regClose) : null;

  const day = hiLo(today.reg);
  const pre = hiLo(today.pre);
  const openPrice = today.reg.length ? today.reg[0].o : null;
  const sessionVwap = vwap(today.reg);
  if (session.state === 'regular' && sessionVwap == null) missing.push('session VWAP');

  // Opening range = first 15 minutes of the regular session (three 5m bars).
  const orBars = today.reg.filter(b => b.minutes < RTH_OPEN + 15);
  const orComplete = today.reg.some(b => b.minutes >= RTH_OPEN + 15) || session.regularOver;
  const or = orBars.length && orComplete ? hiLo(orBars) : { high: null, low: null };

  // Moving averages. Daily ones use completed sessions plus the live price as
  // the current (still-forming) bar, which is how a chart draws them intraday.
  const dCloses = hist.map(b => b.c);
  const dLive = (session.state === 'regular' || session.state === 'premarket') && price != null
    ? [...dCloses, price]
    : (refDaily ? [...dCloses, refDaily.c] : dCloses);
  const iCloses = today.reg.map(b => b.c);
  const ma = {
    dailyEma9: round(ema(dLive, 9)), dailyEma20: round(ema(dLive, 20)),
    dailySma50: round(sma(dLive, 50)), dailySma200: round(sma(dLive, 200)),
    intradayEma9: round(ema(iCloses, 9)), intradayEma20: round(ema(iCloses, 20)),
  };
  if (ma.dailySma200 == null) missing.push('200-day SMA');

  // Relative volume — like-for-like on the same (IEX) feed.
  let rvol = null, rvolBasis = null;
  const priorDates = Object.keys(sessions).filter(d => d < ref && sessions[d].reg.length).sort();
  const todayVol = today.reg.reduce((s, b) => s + (b.v || 0), 0);
  if (today.reg.length && priorDates.length >= 2) {
    const cutoff = lastReg.minutes;
    const priors = priorDates.map(d => sessions[d].reg.filter(b => b.minutes <= cutoff).reduce((s, b) => s + (b.v || 0), 0)).filter(v => v > 0);
    if (priors.length >= 2) {
      rvol = todayVol / (priors.reduce((s, v) => s + v, 0) / priors.length);
      rvolBasis = `vs. the same time of day over the prior ${priors.length} sessions`;
    }
  }
  const vol20 = sma(hist.map(b => b.v || 0), 20);
  const lastFullVol = prev ? prev.v : null;

  // Trend by timeframe.
  const weekly = toWeekly(daily), monthly = toMonthly(daily);
  const wCloses = weekly.map(w => w.c), mCloses = monthly.map(m => m.c);
  if (price != null && wCloses.length) wCloses[wCloses.length - 1] = price;
  if (price != null && mCloses.length) mCloses[mCloses.length - 1] = price;
  const trend = {
    intraday: today.reg.length >= 20
      ? trendFromMAs(price, ma.intradayEma9, ma.intradayEma20, '5-min 9 EMA', '5-min 20 EMA')
      : { dir: 'unknown', reason: today.reg.length ? 'Fewer than 20 five-minute bars so far this session.' : 'Regular session has no bars yet.' },
    daily: trendFromMAs(price, ma.dailyEma20, ma.dailySma50, 'daily 20 EMA', '50-day SMA'),
    weekly: trendFromMAs(price, sma(wCloses, 10), sma(wCloses, 30), '10-week SMA', '30-week SMA'),
    monthly: trendFromMAs(price, sma(mCloses, 6), sma(mCloses, 10), '6-month SMA', '10-month SMA'),
  };
  const dirs = Object.values(trend).map(t => t.dir);
  const bulls = dirs.filter(d => d === 'bullish').length, bears = dirs.filter(d => d === 'bearish').length;
  const overall = bulls - bears >= 2 ? 'bullish' : bears - bulls >= 2 ? 'bearish' : 'neutral';

  // Momentum.
  const rsiIntraday = today.reg.length >= 15 ? rsi(iCloses, 14) : null;
  const rsiDaily = rsi(dLive, 14);
  const atrDaily = atr(hist, 14);

  // Higher-timeframe reference levels (completed periods only).
  const curWeek = weekKey(ref), curMonth = ref.slice(0, 7);
  const prevWeek = [...weekly].reverse().find(w => w.key < curWeek) || null;
  const prevMonth = [...monthly].reverse().find(m => m.key < curMonth) || null;
  const thisWeek = weekly.find(w => w.key === curWeek) || null;
  const thisMonth = monthly.find(m => m.key === curMonth) || null;

  // Recent closes for the intraday cross test ("breaking" a level).
  const recent = today.reg.slice(-4).map(b => b.c);

  const levels = buildLevels({
    price, recent, prev, pre, or, day, sessionVwap, ma, prevWeek, prevMonth, hist, atrDaily,
  });

  // Returns for the comparison module.
  const closeAgo = n => (hist.length >= n ? hist[hist.length - n].c : null);
  const perf = {
    day: round(changePct, 2),
    week: round(pct(changeBase, closeAgo(5)), 2),
    month: round(pct(changeBase, closeAgo(21)), 2),
    quarter: round(pct(changeBase, closeAgo(63)), 2),
    sinceOpen: round(pct(changeBase, openPrice), 2),
  };

  const high20 = hist.length >= 20 ? Math.max(...hist.slice(-20).map(b => b.h)) : null;
  const low20 = hist.length >= 20 ? Math.min(...hist.slice(-20).map(b => b.l)) : null;

  return {
    symbol, name: ETF_NAMES[symbol] || symbol,
    price: round(price), priceTs,
    prevClose: round(prevClose), prevCloseDate: prev ? prev.date : null,
    change: round(change), changePct: round(changePct),
    regClose: round(regClose), extChange: round(extChange), extChangePct: round(extChangePct),
    open: round(openPrice), dayHigh: round(day.high), dayLow: round(day.low),
    premarketHigh: round(pre.high), premarketLow: round(pre.low),
    openingRangeHigh: round(or.high), openingRangeLow: round(or.low),
    vwap: round(sessionVwap),
    vwapDistPct: round(pct(price, sessionVwap), 2),
    ma, rvol: round(rvol, 2), rvolBasis,
    volumeToday: today.reg.length ? todayVol : null,
    volumePrevDay: lastFullVol, volumeAvg20: round(vol20, 0),
    rsiIntraday: round(rsiIntraday, 1), rsiDaily: round(rsiDaily, 1),
    atrDaily: round(atrDaily), atrPct: round(atrDaily && price ? atrDaily / price * 100 : null, 2),
    trend: { ...trend, overall },
    levels, perf,
    high20: round(high20), low20: round(low20),
    prevDayHigh: prev ? round(prev.h) : null, prevDayLow: prev ? round(prev.l) : null,
    prevWeek: prevWeek ? { high: round(prevWeek.h), low: round(prevWeek.l), close: round(prevWeek.c), from: prevWeek.first, to: prevWeek.last } : null,
    prevMonth: prevMonth ? { high: round(prevMonth.h), low: round(prevMonth.l), close: round(prevMonth.c), key: prevMonth.key } : null,
    thisWeek: thisWeek ? { high: round(thisWeek.h), low: round(thisWeek.l) } : null,
    thisMonth: thisMonth ? { high: round(thisMonth.h), low: round(thisMonth.l) } : null,
    refDate: ref, sessionBars: today.reg.length, premarketBars: today.pre.length,
    dailyBars: daily.length, missing,
    // Kept for cross-ETF maths, stripped before the response is serialised.
    _dailyCloses: hist.map(b => ({ date: b.date, c: b.c })),
    _intradayCloses: today.reg.map(b => ({ t: b.t, c: b.c })),
  };
}

function levelStatus(price, lo, hi, recent) {
  if (price == null) return { status: 'unknown', distPct: null };
  const mid = (lo + hi) / 2;
  const distPct = pct(price, mid);
  const inside = price >= lo * (1 - TESTING_PCT / 100) && price <= hi * (1 + TESTING_PCT / 100);
  const was = recent && recent.length >= 2 ? recent[0] : null;
  if (!inside && was != null) {
    if (was < lo && price > hi) return { status: 'breaking above', distPct };
    if (was > hi && price < lo) return { status: 'breaking below', distPct };
  }
  if (inside) return { status: 'testing', distPct };
  return { status: price > hi ? 'above' : 'below', distPct };
}

function buildLevels({ price, recent, prev, pre, or, day, sessionVwap, ma, prevWeek, prevMonth, hist, atrDaily }) {
  const out = [];
  const add = (key, label, tf, value, why, lo, hi) => {
    if (value == null && lo == null) return;
    const zLo = lo != null ? lo : value, zHi = hi != null ? hi : value;
    const st = levelStatus(price, zLo, zHi, recent);
    const role = st.status === 'testing' ? 'pivot' : (price != null && price > zHi ? 'support' : 'resistance');
    out.push({
      key, label, timeframe: tf,
      price: round((zLo + zHi) / 2), lo: round(zLo), hi: round(zHi), isZone: zHi > zLo,
      why, role, status: st.status, distPct: round(st.distPct, 2),
      ...levelPlaybook(role, label),
    });
  };
  if (prev) {
    add('pdh', "Previous day's high", 'daily', prev.h, 'Yesterday\'s buyers ran out of steam here. Many traders mark it, so a move through it often attracts attention.');
    add('pdl', "Previous day's low", 'daily', prev.l, 'Yesterday\'s sellers ran out of steam here. Losing it means today is trading below everything from yesterday.');
    add('pdc', 'Previous close', 'daily', prev.c, 'The line between green and red on the day — above it the ETF is up, below it it is down.');
  }
  add('pmh', 'Premarket high', 'intraday', pre.high, 'The highest price before the opening bell. Often tested in the first hour.');
  add('pml', 'Premarket low', 'intraday', pre.low, 'The lowest price before the opening bell. Often tested in the first hour.');
  add('orh', 'Opening range high (first 15 min)', 'intraday', or.high, 'The top of the first 15 minutes of trading. A break above it is the classic opening-range breakout trigger.');
  add('orl', 'Opening range low (first 15 min)', 'intraday', or.low, 'The bottom of the first 15 minutes of trading. A break below it is the classic opening-range breakdown trigger.');
  add('hod', "Today's high", 'intraday', day.high, 'The highest price so far this session.');
  add('lod', "Today's low", 'intraday', day.low, 'The lowest price so far this session.');
  add('vwap', 'VWAP', 'intraday', sessionVwap, 'The average price paid today, weighted by volume. Above it, the average buyer today is in profit; below it, the average buyer is losing.');
  add('ema9', 'Daily 9 EMA', 'daily', ma.dailyEma9, 'A fast trend line. In a strong trend, pullbacks often stall near it.');
  add('ema20', 'Daily 20 EMA', 'daily', ma.dailyEma20, 'About one month of trading. A common pullback area in a healthy trend.');
  add('sma50', '50-day SMA', 'daily', ma.dailySma50, 'A widely watched medium-term trend line.');
  add('sma200', '200-day SMA', 'daily', ma.dailySma200, 'The most widely watched long-term trend line.');
  if (prevWeek) {
    add('pwh', "Previous week's high", 'weekly', prevWeek.h, 'Last week\'s ceiling. Clearing it means this week is making progress beyond last week.');
    add('pwl', "Previous week's low", 'weekly', prevWeek.l, 'Last week\'s floor. Losing it means this week is trading below all of last week.');
  }
  if (prevMonth) {
    add('pmoh', "Previous month's high", 'monthly', prevMonth.h, 'Last month\'s ceiling — a bigger-picture reference.');
    add('pmol', "Previous month's low", 'monthly', prevMonth.l, 'Last month\'s floor — a bigger-picture reference.');
  }
  // Repeated reaction zones from daily swing highs/lows over ~4 months.
  if (hist.length >= 30 && price != null) {
    const window = hist.slice(-90);
    const tol = Math.max(0.35, atrDaily ? (atrDaily / price) * 100 * 0.25 : 0.35);
    const zones = clusterZones(findPivots(window, 2), tol).filter(z => z.touches >= 2);
    const above = zones.filter(z => z.lo > price).sort((a, b) => a.lo - b.lo).slice(0, 2);
    const below = zones.filter(z => z.hi < price).sort((a, b) => b.hi - a.hi).slice(0, 2);
    const at = zones.filter(z => z.lo <= price && z.hi >= price).slice(0, 1);
    [...above, ...below, ...at].forEach((z, i) => add(
      `zone${i}`, `Reaction zone (${z.touches} swing turns)`, 'daily', null,
      `Price has turned in this area ${z.touches} times in the last ${window.length} sessions (${z.dates.slice(-3).join(', ')}). Treat it as an area, not an exact line.`,
      z.lo, z.hi,
    ));
  }
  return out.sort((a, b) => b.price - a.price);
}

function levelPlaybook(role, label) {
  if (role === 'resistance') return {
    confirm: `A 5-minute candle closing above it on above-average volume, then holding above it on the first pullback.`,
    invalidate: `Price pokes above and closes back below it (a failed breakout), or it is rejected without ever closing above.`,
  };
  if (role === 'support') return {
    confirm: `Price pulls back to it, holds, and buyers step in — a 5-minute candle closing back up off the level.`,
    invalidate: `A 5-minute candle closing below it on above-average volume, then failing to reclaim it.`,
  };
  return {
    confirm: `Wait for price to leave the level: a decisive 5-minute close away from it shows which side won.`,
    invalidate: `Price chops back and forth through it — the level is not being respected right now.`,
  };
}

// ── Cross-ETF comparison ────────────────────────────────────────────────────
function dailyReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push({ date: closes[i].date, r: closes[i].c / closes[i - 1].c - 1 });
  return out;
}
function alignedCorr(ra, rb, n) {
  const mapB = new Map(rb.map(x => [x.date ?? x.t, x.r]));
  const xs = [], ys = [];
  for (const x of ra.slice(-n)) {
    const k = x.date ?? x.t;
    if (mapB.has(k)) { xs.push(x.r); ys.push(mapB.get(k)); }
  }
  return xs.length >= Math.min(n, 10) * 0.8 ? pearson(xs, ys) : null;
}

export function compareEtfs(etfs) {
  const by = Object.fromEntries(etfs.map(e => [e.symbol, e]));
  const pairs = [['SPY', 'QQQ'], ['SPY', 'IWM'], ['QQQ', 'IWM']].filter(([a, b]) => by[a] && by[b]);
  const dRet = Object.fromEntries(etfs.map(e => [e.symbol, dailyReturns(e._dailyCloses)]));
  const iRet = Object.fromEntries(etfs.map(e => {
    const c = e._intradayCloses, out = [];
    for (let i = 1; i < c.length; i++) out.push({ t: c[i].t, r: c[i].c / c[i - 1].c - 1 });
    return [e.symbol, out];
  }));
  const correlations = pairs.map(([a, b]) => {
    const c20 = alignedCorr(dRet[a], dRet[b], 20);
    const c60 = alignedCorr(dRet[a], dRet[b], 60);
    const ci = iRet[a].length >= 12 ? alignedCorr(iRet[a], iRet[b], iRet[a].length) : null;
    return {
      pair: `${a}/${b}`, a, b,
      d20: round(c20, 2), d60: round(c60, 2), intraday: round(ci, 2),
      change: c20 != null && c60 != null ? round(c20 - c60, 2) : null,
    };
  });

  const periods = ['day', 'week', 'month', 'quarter'];
  const performance = {};
  for (const p of periods) {
    const rows = etfs.map(e => ({ symbol: e.symbol, pct: e.perf[p] })).filter(r => r.pct != null);
    rows.sort((x, y) => y.pct - x.pct);
    performance[p] = { rows, leader: rows[0]?.symbol ?? null, laggard: rows.length > 1 ? rows[rows.length - 1].symbol : null };
  }

  const dayDirs = etfs.map(e => (e.changePct == null ? 0 : e.changePct > 0.1 ? 1 : e.changePct < -0.1 ? -1 : 0));
  const allUp = dayDirs.every(d => d === 1), allDown = dayDirs.every(d => d === -1);
  const breakout = etfs.map(e => ({
    symbol: e.symbol,
    abovePrevHigh: e.price != null && e.prevDayHigh != null ? e.price > e.prevDayHigh : null,
    belowPrevLow: e.price != null && e.prevDayLow != null ? e.price < e.prevDayLow : null,
    above20dHigh: e.price != null && e.high20 != null ? e.price > e.high20 : null,
    below20dLow: e.price != null && e.low20 != null ? e.price < e.low20 : null,
    aboveVwap: e.price != null && e.vwap != null ? e.price > e.vwap : null,
  }));
  const upBreaks = breakout.filter(b => b.abovePrevHigh).map(b => b.symbol);
  const downBreaks = breakout.filter(b => b.belowPrevLow).map(b => b.symbol);

  // Interpretations — each one says what was observed, then what it MAY mean.
  const reads = [];
  const chg = s => by[s]?.changePct;
  const have = ETFS.every(s => chg(s) != null);
  if (have) {
    if (allUp) reads.push({ tone: 'bullish', title: 'All three are rising together', text: 'SPY, QQQ and IWM are all up on the day. When large caps, tech and small caps rise together the move has broad participation, which is generally sturdier than one group moving alone.' });
    else if (allDown) reads.push({ tone: 'bearish', title: 'All three are falling together', text: 'SPY, QQQ and IWM are all down on the day. Selling across large caps, tech and small caps at once points to broad pressure rather than a problem in one corner of the market.' });
    else reads.push({ tone: 'neutral', title: 'The three are not moving together', text: `Day change — SPY ${fmtPct(chg('SPY'))}, QQQ ${fmtPct(chg('QQQ'))}, IWM ${fmtPct(chg('IWM'))}. A split like this means the market does not agree with itself, which usually calls for more caution on a directional trade.` });

    const qs = chg('QQQ') - chg('SPY');
    if (Math.abs(qs) >= 0.25) reads.push({
      tone: 'neutral',
      title: qs > 0 ? 'QQQ is leading SPY' : 'QQQ is lagging SPY',
      text: qs > 0
        ? `QQQ is ahead of SPY by ${round(qs, 2)} percentage points today. That usually means large technology stocks are doing more of the lifting than the rest of the S&P 500.`
        : `QQQ is behind SPY by ${round(-qs, 2)} percentage points today. That usually means large technology stocks are a drag while other sectors hold up better.`,
    });
    const is = chg('IWM') - chg('SPY');
    if (chg('SPY') > 0.1 && chg('QQQ') > 0.1 && chg('IWM') < -0.1) reads.push({ tone: 'bearish', title: 'Small caps are not confirming', text: 'SPY and QQQ are up while IWM is down. That can indicate uneven participation — a rally carried by a small number of large companies — which is a reason for caution, not a sell signal by itself.' });
    else if (Math.abs(is) >= 0.4) reads.push({
      tone: 'neutral',
      title: is > 0 ? 'Small caps are outperforming' : 'Small caps are underperforming',
      text: is > 0
        ? `IWM is ahead of SPY by ${round(is, 2)} percentage points. Small-cap strength often goes with risk appetite broadening out beyond the mega-caps.`
        : `IWM is behind SPY by ${round(-is, 2)} percentage points. Small caps are more sensitive to interest rates and credit, so weakness here can show stress the big indexes are hiding.`,
    });
  }
  if (upBreaks.length === 3) reads.push({ tone: 'bullish', title: "All three are above yesterday's high", text: 'A breakout that all three ETFs share is confirmed by the others — stronger evidence than one ETF breaking out alone.' });
  else if (upBreaks.length > 0) reads.push({ tone: 'neutral', title: `Isolated breakout: ${upBreaks.join(', ')}`, text: `Only ${upBreaks.join(' and ')} ${upBreaks.length > 1 ? 'are' : 'is'} above yesterday's high. A breakout the other ETFs have not confirmed is more likely to stall — worth waiting to see if the others follow.` });
  if (downBreaks.length === 3) reads.push({ tone: 'bearish', title: "All three are below yesterday's low", text: 'A breakdown shared by all three ETFs is confirmed by the others — stronger evidence than one ETF breaking down alone.' });
  else if (downBreaks.length > 0) reads.push({ tone: 'neutral', title: `Isolated breakdown: ${downBreaks.join(', ')}`, text: `Only ${downBreaks.join(' and ')} ${downBreaks.length > 1 ? 'are' : 'is'} below yesterday's low. The others have not confirmed the weakness yet.` });

  const falling = correlations.filter(c => c.change != null && c.change <= -0.15);
  if (falling.length) reads.push({ tone: 'neutral', title: 'Correlation is loosening', text: `${falling.map(c => c.pair).join(', ')}: the 20-day correlation is noticeably lower than the 60-day. The ETFs have been moving together less than usual, so one confirming another carries a little less weight right now.` });

  return {
    correlations, performance, breakout, reads,
    agreement: allUp ? 'all-up' : allDown ? 'all-down' : 'mixed',
    note: 'Correlation measures how closely two ETFs have moved together. It does not show that one causes the other, and it can change quickly.',
    lookback: 'Daily-return correlation over 20 and 60 sessions; intraday uses 5-minute returns from today\'s regular session.',
  };
}
function fmtPct(v) { return v == null ? 'n/a' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`; }

// ── Bias + confidence ───────────────────────────────────────────────────────
const HIGH_IMPACT_WINDOW_H = 24;

/**
 * Transparent, rule-based scoring. Eight components, each -1 / 0 / +1.
 * `events` = upcoming calendar items [{name, ts(ms), impact}] or null if the
 * calendar could not be loaded.
 */
export function scoreEtf(e, all, { nowMs, events }) {
  const session = marketSession(nowMs);
  const others = all.filter(x => x.symbol !== e.symbol);
  const c = [];
  const push = (key, label, score, reason, dataOk = true, learn = null) => c.push({ key, label, score, reason, dataOk, learn });

  // 1. Trend alignment
  const t = e.trend;
  const known = ['intraday', 'daily', 'weekly', 'monthly'].filter(k => t[k].dir !== 'unknown');
  const up = known.filter(k => t[k].dir === 'bullish'), dn = known.filter(k => t[k].dir === 'bearish');
  push('trend', 'Trend alignment',
    up.length - dn.length >= 2 ? 1 : dn.length - up.length >= 2 ? -1 : 0,
    known.length
      ? `Bullish on: ${up.join(', ') || 'none'}. Bearish on: ${dn.join(', ') || 'none'}. (${4 - known.length ? `${4 - known.length} timeframe(s) lack data.` : 'All four timeframes measured.'})`
      : 'No timeframe has enough bars to measure.',
    known.length >= 3,
    'A trade in the direction of several timeframes at once has the bigger trend behind it. Fighting the higher timeframe is one of the most common beginner mistakes.');

  // 2. VWAP position
  if (e.vwap == null) push('vwap', 'VWAP position', 0, 'No session VWAP yet — the regular session has not produced bars.', false);
  else {
    const d = e.vwapDistPct;
    push('vwap', 'VWAP position', d > 0.05 ? 1 : d < -0.05 ? -1 : 0,
      `Price ${e.price} is ${Math.abs(d).toFixed(2)}% ${d >= 0 ? 'above' : 'below'} VWAP ${e.vwap}.`, true,
      'VWAP is the average price paid today. Above it, today\'s average buyer is winning and dips tend to get bought; below it, the opposite. A cross of VWAP is a change in who is in control intraday.');
  }

  // 3. Momentum
  const r = e.rsiIntraday ?? e.rsiDaily;
  const rLabel = e.rsiIntraday != null ? '5-minute RSI(14)' : 'daily RSI(14)';
  if (r == null) push('momentum', 'Momentum', 0, 'Not enough bars for RSI.', false);
  else push('momentum', 'Momentum', r >= 55 ? 1 : r <= 45 ? -1 : 0,
    `${rLabel} is ${r}. Above 55 leans bullish, below 45 leans bearish, in between is no clear push.${r >= 75 ? ' Above 75 is stretched — late entries carry more pullback risk.' : r <= 25 ? ' Below 25 is stretched — late entries carry more bounce risk.' : ''}`, true,
    'Momentum measures how one-sided recent price changes have been. Strong momentum supports a move, but very high or very low readings also mean the move is extended.');

  // 4. Volume confirmation
  if (e.rvol == null) push('volume', 'Volume confirmation', 0, 'Relative volume is not available yet for this session.', false);
  else {
    const dir = e.changePct == null ? 0 : Math.sign(e.changePct);
    const confirmed = e.rvol >= 1.2 && Math.abs(e.changePct ?? 0) > 0.1;
    push('volume', 'Volume confirmation', confirmed ? dir : 0,
      `Relative volume is ${e.rvol}× ${e.rvolBasis} (IEX exchange volume only). ${confirmed ? 'Above 1.2× with price moving — the move has participation.' : e.rvol < 0.8 ? 'Below 0.8× — light participation; moves on thin volume fail more often.' : 'Near normal — volume is not adding or removing conviction.'}`, true,
      'A breakout on heavy volume means many traders agree with it. A breakout on light volume has fewer participants behind it and is easier to reverse.');
  }

  // 5. Support / resistance position
  if (e.price == null || e.prevDayHigh == null) push('levels', 'Support & resistance', 0, 'Missing price or previous-day range.', false);
  else {
    const s = e.price > e.prevDayHigh ? 1 : e.price < e.prevDayLow ? -1 : 0;
    const res = nearest(e.levels, 'resistance'), sup = nearest(e.levels, 'support');
    const tight = res && Math.abs(res.distPct) < 0.2;
    push('levels', 'Support & resistance', s,
      `${s > 0 ? `Above yesterday's high (${e.prevDayHigh}).` : s < 0 ? `Below yesterday's low (${e.prevDayLow}).` : `Inside yesterday's range (${e.prevDayLow}–${e.prevDayHigh}).`}`
      + ` Nearest resistance: ${res ? `${res.label} ${fmtZone(res)}` : 'none above'}. Nearest support: ${sup ? `${sup.label} ${fmtZone(sup)}` : 'none below'}.`
      + (tight ? ' Price is pressed right under resistance — calls bought here have little room before the level.' : ''), true,
      'Buying calls directly beneath resistance means the trade needs a breakout just to start working. Many traders wait for the break and a successful retest instead.');
  }

  // 6. Relative strength
  const oc = others.map(o => o.changePct).filter(v => v != null);
  if (e.changePct == null || oc.length < 2) push('relative', 'Relative strength', 0, 'Need all three ETFs to compare.', false);
  else {
    const diff = e.changePct - (oc[0] + oc[1]) / 2;
    push('relative', 'Relative strength', diff > 0.25 ? 1 : diff < -0.25 ? -1 : 0,
      `${e.symbol} ${fmtPct(e.changePct)} vs. the other two averaging ${fmtPct((oc[0] + oc[1]) / 2)} (${diff >= 0 ? '+' : ''}${diff.toFixed(2)} pts).`, true,
      'The strongest ETF on an up day is usually the better place to look for calls; the weakest on a down day is usually the better place to look for puts.');
  }

  // 7. Confirmation from the other two
  if (e.changePct == null || oc.length < 2) push('confirmation', 'Confirmation from the other ETFs', 0, 'Need all three ETFs to compare.', false);
  else {
    const sign = v => (v > 0.1 ? 1 : v < -0.1 ? -1 : 0);
    const mine = sign(e.changePct);
    const agree = mine !== 0 && oc.every(v => sign(v) === mine);
    push('confirmation', 'Confirmation from the other ETFs', agree ? mine : 0,
      agree ? `${others.map(o => o.symbol).join(' and ')} are moving the same way as ${e.symbol} today.`
        : `${others.map(o => `${o.symbol} ${fmtPct(o.changePct)}`).join(', ')} — not all moving with ${e.symbol} (${fmtPct(e.changePct)}).`, true,
      'When one ETF moves and the others do not follow, the move is isolated. Moves that all three share tend to be more reliable.');
  }

  // 8. Catalyst — never adds direction (we do not predict data releases);
  //    an imminent high-impact event lowers confidence instead.
  let eventRisk = null;
  if (events == null) push('catalyst', 'Catalyst check', 0, 'The catalyst calendar could not be loaded, so scheduled event risk is unknown.', false);
  else {
    eventRisk = events.filter(ev => ev.impact === 'high' && ev.ts != null && ev.ts > nowMs && ev.ts - nowMs <= HIGH_IMPACT_WINDOW_H * 3600 * 1000)
      .sort((a, b) => a.ts - b.ts)[0] || null;
    push('catalyst', 'Catalyst check', 0,
      eventRisk ? `${eventRisk.name} is scheduled within the next ${HIGH_IMPACT_WINDOW_H} hours. Releases like this can reverse the market in seconds, so confidence is reduced.`
        : `No high-impact scheduled release in the next ${HIGH_IMPACT_WINDOW_H} hours on the calendar we track.`, true,
      'Good economic news can sink stocks and bad news can lift them — it depends on what it means for interest rates and what was already priced in. That is why this tool never scores a release as bullish or bearish in advance.');
  }

  const total = c.reduce((s, x) => s + x.score, 0);
  const bias = total >= 3 ? 'bullish' : total <= -3 ? 'bearish' : 'neutral';
  const sign = bias === 'bullish' ? 1 : bias === 'bearish' ? -1 : 0;
  const agree = c.filter(x => sign !== 0 && x.score === sign).length;
  const against = c.filter(x => sign !== 0 && x.score === -sign).length;
  const missing = c.filter(x => !x.dataOk).length;

  const LEVELS = ['Low', 'Medium', 'High'];
  let lvl = sign === 0 ? 0 : (agree >= 5 && against === 0) ? 2 : (agree >= 4 && against <= 1) || (agree >= 3 && against === 0) ? 1 : 0;
  const why = [];
  if (sign === 0) why.push('The components do not agree on a direction, so the assessment is neutral.');
  else why.push(`${agree} of 8 components point ${bias}; ${against} point the other way.`);
  const downgrade = reason => { if (lvl > 0) lvl--; why.push(reason); };
  if (eventRisk) downgrade(`${eventRisk.name} is due soon.`);
  if (missing >= 2) downgrade(`${missing} components are missing data.`);
  const ageMin = e.priceTs ? (nowMs - e.priceTs) / MIN : null;
  if (session.state === 'regular' && (ageMin == null || ageMin > 15)) downgrade('The latest trade is more than 15 minutes old.');
  if (session.state !== 'regular') {
    if (lvl > 1) lvl = 1;
    why.push(`${session.label}: this reflects the most recent regular session and will be re-evaluated at the next open.`);
  }

  return {
    symbol: e.symbol, bias, total, max: c.length,
    confidence: LEVELS[lvl], confidenceWhy: why,
    components: c,
    eventRisk: eventRisk ? { name: eventRisk.name, ts: eventRisk.ts } : null,
    disclaimer: 'Rule-based reading of the listed evidence. It is not a back-tested probability and not a prediction.',
  };
}

function nearest(levels, role) {
  const list = levels.filter(l => l.role === role && l.distPct != null);
  if (!list.length) return null;
  return list.reduce((best, l) => (Math.abs(l.distPct) < Math.abs(best.distPct) ? l : best));
}
function fmtZone(l) { return l.isZone ? `${l.lo}–${l.hi}` : `${l.price}`; }

// ── Calls / Puts / No-trade scenarios ───────────────────────────────────────
export function buildScenarios(e, score, all, { nowMs }) {
  const session = marketSession(nowMs);
  const others = all.filter(x => x.symbol !== e.symbol).map(x => x.symbol);
  const res = nearest(e.levels, 'resistance'), sup = nearest(e.levels, 'support');
  const R = res ? `${res.label} (${fmtZone(res)})` : null;
  const S = sup ? `${sup.label} (${fmtZone(sup)})` : null;
  const vw = e.vwap != null ? `VWAP (${e.vwap})` : 'VWAP once the session opens';

  const calls = {
    title: 'Calls scenario',
    needs: [
      `Price holding above ${vw}.`,
      R ? `A 5-minute close above ${R}, then a pullback that holds above it.` : 'No resistance level is mapped above price — look for a higher low on the 5-minute chart instead.',
      'Volume on the breakout candle above the recent average.',
      `${others.join(' and ')} also pushing higher rather than fading.`,
    ],
    invalidation: sup ? `A 5-minute close back below ${S}${e.vwap != null ? ` or below ${vw}` : ''}.` : `A 5-minute close back below ${vw}.`,
    risks: [],
  };
  const puts = {
    title: 'Puts scenario',
    needs: [
      `Price holding below ${vw}.`,
      S ? `A 5-minute close below ${S}, then a bounce that fails beneath it.` : 'No support level is mapped below price — look for a lower high on the 5-minute chart instead.',
      'Volume on the breakdown candle above the recent average.',
      `${others.join(' and ')} also pushing lower rather than bouncing.`,
    ],
    invalidation: res ? `A 5-minute close back above ${R}${e.vwap != null ? ` or above ${vw}` : ''}.` : `A 5-minute close back above ${vw}.`,
    risks: [],
  };
  if (res && Math.abs(res.distPct) < 0.25) calls.risks.push(`Resistance is only ${Math.abs(res.distPct).toFixed(2)}% away — calls bought here need a breakout just to start working.`);
  if (sup && Math.abs(sup.distPct) < 0.25) puts.risks.push(`Support is only ${Math.abs(sup.distPct).toFixed(2)}% away — puts bought here need a breakdown just to start working.`);
  if (e.rsiIntraday != null && e.rsiIntraday >= 75) calls.risks.push(`5-minute RSI is ${e.rsiIntraday} — the move is stretched; chasing raises pullback risk.`);
  if (e.rsiIntraday != null && e.rsiIntraday <= 25) puts.risks.push(`5-minute RSI is ${e.rsiIntraday} — the move is stretched; chasing raises bounce risk.`);
  if (e.trend.daily.dir === 'bearish') calls.risks.push('The daily trend is bearish — calls would be a counter-trend trade.');
  if (e.trend.daily.dir === 'bullish') puts.risks.push('The daily trend is bullish — puts would be a counter-trend trade.');

  // No-trade conditions, each evaluated against current data.
  const checks = [];
  const chk = (label, active, detail) => checks.push({ label, active: !!active, detail });
  const disagree = score.components.find(x => x.key === 'confirmation')?.score === 0 && e.changePct != null;
  chk('Market is not in the regular session', session.state !== 'regular', `${session.label}. Extended-hours prices are thin and levels set there are less reliable.`);
  chk('Price is stuck to VWAP', e.vwapDistPct != null && Math.abs(e.vwapDistPct) < 0.05, e.vwapDistPct != null ? `Price is ${Math.abs(e.vwapDistPct).toFixed(2)}% from VWAP — neither side is in control.` : 'VWAP not available yet.');
  chk('The three ETFs disagree', disagree, disagree ? 'The other two ETFs are not confirming this one\'s direction.' : 'The other two ETFs are moving the same way.');
  chk('Volume is light', e.rvol != null && e.rvol < 0.8, e.rvol != null ? `Relative volume ${e.rvol}× — thin participation.` : 'Relative volume not available yet.');
  chk('A high-impact release is close', !!score.eventRisk, score.eventRisk ? `${score.eventRisk.name} is due within 24 hours.` : 'Nothing high-impact on the tracked calendar in the next 24 hours.');
  chk('Price is extended from VWAP', e.vwapDistPct != null && e.atrPct != null && Math.abs(e.vwapDistPct) > e.atrPct * 0.75, e.vwapDistPct != null && e.atrPct != null ? `Price is ${Math.abs(e.vwapDistPct).toFixed(2)}% from VWAP; a normal full day's range is about ${e.atrPct}%.` : 'Not measurable yet.');
  chk('Opening range is still forming', session.state === 'regular' && e.openingRangeHigh == null, 'The first 15 minutes are not finished — the opening range is not set.');
  chk('Evidence is mixed', score.bias === 'neutral', `Component score ${score.total > 0 ? '+' : ''}${score.total} of ±${score.max}${score.bias === 'neutral' ? ': no clear lean.' : `: leans ${score.bias}.`}`);
  const active = checks.filter(x => x.active);

  const lean = active.some(x => x.label === 'Market is not in the regular session') ? 'no-trade'
    : score.bias === 'neutral' || active.length >= 3 ? 'no-trade'
    : score.bias === 'bullish' ? 'calls' : 'puts';
  const leanText = {
    calls: 'Conditions currently lean toward investigating a calls setup — if the confirmation steps below actually happen.',
    puts: 'Conditions currently lean toward investigating a puts setup — if the confirmation steps below actually happen.',
    'no-trade': 'Conditions currently favour waiting. A setup needs the no-trade flags below to clear first.',
  }[lean];

  return {
    lean, leanText, calls, puts,
    noTrade: { title: 'No-trade scenario', checks, activeCount: active.length },
    note: 'This describes the underlying ETF only. It does not pick a strike or expiry, and it does not account for the option\'s price, spread, implied volatility or time decay. A cheap premium is never a reason to take a contract.',
  };
}

// ── Daily / Weekly / Monthly outlook ────────────────────────────────────────
export function buildOutlooks(etfs, scores, comparison, { nowMs, events, macro }) {
  const session = marketSession(nowMs);
  const by = Object.fromEntries(etfs.map(e => [e.symbol, e]));
  const sc = Object.fromEntries(scores.map(s => [s.symbol, s]));
  const DAY = 24 * 3600 * 1000;
  const upcoming = (fromMs, toMs) => (events || []).filter(ev => ev.ts != null && ev.ts >= fromMs && ev.ts <= toMs).sort((a, b) => a.ts - b.ts);
  const calNote = events == null ? 'Catalyst calendar unavailable.' : null;

  const perEtf = (fn) => ETFS.filter(s => by[s]).map(s => ({ symbol: s, ...fn(by[s], sc[s]) }));
  const lvl = (e, key) => e.levels.find(l => l.key === key);

  const daily = {
    key: 'daily', title: 'Daily outlook',
    horizon: session.state === 'regular' ? 'Rest of today\'s session' : `Next session (${session.nextOpenDate})`,
    etfs: perEtf((e, s) => {
      const res = nearest(e.levels, 'resistance'), sup = nearest(e.levels, 'support');
      return {
        bias: s.bias, confidence: s.confidence,
        evidence: [
          `Previous session: high ${e.prevDayHigh ?? 'n/a'}, low ${e.prevDayLow ?? 'n/a'}, close ${e.prevClose ?? 'n/a'}.`,
          e.premarketHigh != null ? `Premarket range: ${e.premarketLow}–${e.premarketHigh} (IEX trades only).` : 'Premarket range: unavailable (no IEX premarket bars for this session).',
          e.vwap != null ? `Price ${e.price} vs VWAP ${e.vwap} (${fmtPct(e.vwapDistPct)}).` : 'VWAP: not available until the regular session trades.',
          e.openingRangeHigh != null ? `Opening range (first 15 min): ${e.openingRangeLow}–${e.openingRangeHigh}.` : 'Opening range: not set yet.',
          `Daily 9 EMA ${e.ma.dailyEma9 ?? 'n/a'}, 20 EMA ${e.ma.dailyEma20 ?? 'n/a'}.`,
        ],
        bullish: res ? `Holds above VWAP and closes a 5-minute candle above ${res.label} (${fmtZone(res)}).` : 'Holds above VWAP and keeps making higher lows.',
        bearish: sup ? `Stays below VWAP and closes a 5-minute candle below ${sup.label} (${fmtZone(sup)}).` : 'Stays below VWAP and keeps making lower highs.',
        neutral: res && sup ? `Chops between ${fmtZone(sup)} and ${fmtZone(res)} without a clean break.` : 'Chops around VWAP without direction.',
        changes: 'A decisive 5-minute close through the nearest level, a VWAP cross that holds, or a scheduled release.',
      };
    }),
    catalysts: upcoming(nowMs - 12 * 3600 * 1000, nowMs + 1.5 * DAY),
    calNote,
  };

  const weekly = {
    key: 'weekly', title: 'Weekly outlook', horizon: 'This week',
    etfs: perEtf((e) => {
      const t = e.trend.weekly;
      return {
        bias: t.dir === 'unknown' ? 'neutral' : t.dir, confidence: null,
        evidence: [
          `Weekly trend: ${t.dir}. ${t.reason}`,
          e.prevWeek ? `Previous week (${e.prevWeek.from} → ${e.prevWeek.to}): high ${e.prevWeek.high}, low ${e.prevWeek.low}, close ${e.prevWeek.close}.` : 'Previous week: unavailable.',
          e.thisWeek ? `This week so far: ${e.thisWeek.low}–${e.thisWeek.high}.` : 'This week has not traded yet.',
          `5-session change ${fmtPct(e.perf.week)}. Daily RSI(14) ${e.rsiDaily ?? 'n/a'}.`,
          `Daily 20 EMA ${e.ma.dailyEma20 ?? 'n/a'}, 50-day SMA ${e.ma.dailySma50 ?? 'n/a'}.`,
        ],
        bullish: e.prevWeek ? `A daily close above last week's high (${e.prevWeek.high}) would show continuation.` : 'n/a',
        bearish: e.prevWeek ? `A daily close below last week's low (${e.prevWeek.low}) would show a reversal lower.` : 'n/a',
        neutral: e.prevWeek ? `Staying inside last week's range (${e.prevWeek.low}–${e.prevWeek.high}) is consolidation.` : 'n/a',
        changes: 'A daily close outside last week\'s range, or losing/reclaiming the daily 20 EMA.',
      };
    }),
    leadership: comparison.performance.week,
    catalysts: upcoming(nowMs, nowMs + 7 * DAY),
    calNote,
  };

  const monthly = {
    key: 'monthly', title: 'Monthly outlook', horizon: 'This month',
    etfs: perEtf((e) => {
      const t = e.trend.monthly;
      return {
        bias: t.dir === 'unknown' ? 'neutral' : t.dir, confidence: null,
        evidence: [
          `Monthly trend: ${t.dir}. ${t.reason}`,
          e.prevMonth ? `Previous month (${e.prevMonth.key}): high ${e.prevMonth.high}, low ${e.prevMonth.low}, close ${e.prevMonth.close}.` : 'Previous month: unavailable.',
          `50-day SMA ${e.ma.dailySma50 ?? 'n/a'}; 200-day SMA ${e.ma.dailySma200 ?? 'unavailable (needs 200 sessions of history)'}.`,
          `21-session change ${fmtPct(e.perf.month)}; 63-session change ${fmtPct(e.perf.quarter)}.`,
        ],
        bullish: e.prevMonth ? `Holding above the 50-day SMA and closing above last month's high (${e.prevMonth.high}).` : 'n/a',
        bearish: e.prevMonth ? `Closing below last month's low (${e.prevMonth.low}) or losing the 50-day SMA.` : 'n/a',
        neutral: e.prevMonth ? `Ranging between ${e.prevMonth.low} and ${e.prevMonth.high}.` : 'n/a',
        changes: 'A weekly close outside last month\'s range, a 50/200-day SMA break, or a shift in the inflation and Fed picture below.',
      };
    }),
    leadership: comparison.performance.month,
    macro: macro || null,
    catalysts: upcoming(nowMs, nowMs + 31 * DAY),
    calNote,
  };

  return { daily, weekly, monthly };
}

/** Drop internal fields before serialising. */
export function publicEtf(e) {
  const { _dailyCloses, _intradayCloses, ...rest } = e;
  return rest;
}
