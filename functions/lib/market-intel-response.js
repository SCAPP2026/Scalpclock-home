// Market Intelligence Center — assembles the /api/market-intel response body
// from already-fetched inputs. Pure (no network, no clock) so the endpoint
// and tests/market-intel*.test.mjs build responses through the same code.
import {
  ETFS, analyzeEtf, compareEtfs, scoreEtf, buildScenarios, buildOutlooks,
  publicEtf, marketSession, etParts,
} from './market-intel.js';
import { measureReaction } from './market-intel-calendar.js';

const DAY = 24 * 3600 * 1000;

/**
 * @param {object} a
 * @param {Object<string,Array>} a.daily     { SPY:[{t,o,h,l,c,v}], ... }
 * @param {Object<string,Array>} a.intraday  5-minute bars, same shape
 * @param {Object<string,{p,t}>} a.trades    latest trade per symbol (may be {})
 * @param {object|null} a.calendar           buildCalendar() result, or null if it failed
 * @param {number} a.nowMs
 * @param {string[]} [a.warnings]
 */
export function buildCoreResponse({ daily, intraday, trades, calendar, nowMs, warnings = [] }) {
  const session = marketSession(nowMs);
  const asOf = new Date(nowMs).toISOString();
  const events = calendar ? calendar.events : null;

  const etfs = ETFS.map(symbol => analyzeEtf({
    symbol, daily: daily[symbol] || [], intraday: intraday[symbol] || [],
    trade: (trades || {})[symbol] || null, nowMs,
  }));
  if (etfs.every(e => e.price == null)) {
    return { ok: false, error: 'The provider returned no bars for SPY, QQQ or IWM.', asOf, session };
  }
  for (const e of etfs) {
    if (e.price == null) warnings.push(`${e.symbol}: the provider returned no price data, so its figures are unavailable.`);
    else if (e.dailyBars < 200) warnings.push(`${e.symbol}: only ${e.dailyBars} daily bars of history — the 200-day average is unavailable.`);
  }

  const comparison = compareEtfs(etfs);
  const scores = etfs.map(e => scoreEtf(e, etfs, { nowMs, events }));
  const scenarios = etfs.map((e, i) => buildScenarios(e, scores[i], etfs, { nowMs }));
  const outlooks = buildOutlooks(etfs, scores, comparison, { nowMs, events, macro: calendar ? calendar.macro : null });

  // Actual market reaction for anything released inside the intraday window.
  const calEvents = calendar ? calendar.events.map(ev => ({
    ...ev,
    reaction: ev.status === 'released' && nowMs - ev.ts < 9 * DAY ? measureReaction(ev.ts, intraday, nowMs) : null,
  })) : null;

  const newest = Math.max(...etfs.map(e => e.priceTs || 0));
  const ageMin = newest ? (nowMs - newest) / 60000 : null;
  const stale = session.state === 'regular' && (ageMin == null || ageMin > 15);
  if (stale) warnings.push('The newest trade is more than 15 minutes old during market hours — treat prices as stale.');

  return {
    ok: true, asOf, session, stale,
    refreshSeconds: session.state === 'closed' ? 300 : 30,
    dataNotes: {
      provider: 'Alpaca Market Data — IEX feed',
      timeliness: 'Real-time trades from the IEX exchange only (not the consolidated tape, and not delayed).',
      volume: 'Volume figures are IEX-only — roughly a few percent of total US volume. Relative volume compares IEX with IEX, so it is still like-for-like.',
      extendedHours: 'Premarket and after-hours bars exist only when IEX traded; quiet symbols can show gaps.',
      indicators: 'Moving averages, VWAP, RSI, ATR, correlation and relative volume are calculated by ScalpClock from those bars.',
    },
    etfs: etfs.map((e, i) => ({
      ...publicEtf(e),
      score: scores[i],
      scenarios: scenarios[i],
      chart: chartData(daily[e.symbol] || [], intraday[e.symbol] || [], session.refDate),
    })),
    comparison, outlooks,
    calendar: calendar ? { events: calEvents, status: calendar.status } : null,
    macro: calendar ? calendar.macro : null,
    warnings,
  };
}

function chartData(daily, intraday, refDate) {
  const d = daily.slice(-130).map(b => ({ time: etParts(b.t + 12 * 3600 * 1000).date, open: b.o, high: b.h, low: b.l, close: b.c }));
  // Reference session plus the one before it, so the intraday chart is never
  // empty before the open.
  const dates = [...new Set(intraday.map(b => etParts(b.t).date))].filter(x => x <= refDate).slice(-2);
  const i = intraday.filter(b => dates.includes(etParts(b.t).date))
    .map(b => ({ time: Math.floor(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
  return { daily: d, intraday: i, intradayDates: dates };
}
