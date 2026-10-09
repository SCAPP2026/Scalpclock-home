/**
 * Market Intelligence Center — calculation + response tests.
 * Run with: node tests/market-intel.test.mjs
 *
 * Imports the REAL modules the endpoints use. Indicator maths is checked two
 * ways: against hand-worked numbers, and against an independent naive
 * recomputation over recorded Alpaca IEX bars
 * (tests/fixtures/market-intel-bars.json, captured 2026-10-09). "Replaying"
 * the fixture at different clock times exercises the regular / premarket /
 * closed / stale / missing-data paths without any network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../functions/lib/market-intel.js';
import * as C from '../functions/lib/market-intel-calendar.js';
import { buildCoreResponse } from '../functions/lib/market-intel-response.js';
import { quoteFromSnapshot } from '../functions/api/market-intel-movers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/market-intel-bars.json'), 'utf8'));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}
const near = (a, b, tol = 0.011) => a != null && b != null && Math.abs(a - b) <= tol;
function group(name) { console.log(`\n${name}`); }
const at = iso => Date.parse(iso);
// Fixture as it would have looked at `nowMs` (drop bars that had not printed yet).
function replay(nowMs, { drop = [] } = {}) {
  const daily = {}, intraday = {};
  for (const s of M.ETFS) {
    const today = M.etParts(nowMs).date;
    daily[s] = drop.includes(s) ? [] : FIX.daily[s].filter(b => M.etParts(b.t + 12 * 3600e3).date <= today && b.t <= nowMs);
    intraday[s] = drop.includes(s) ? [] : FIX.intraday[s].filter(b => b.t + 5 * 60e3 <= nowMs);
  }
  return { daily, intraday };
}
const noCal = { events: [], macro: null, status: { fomc: { ok: true, through: 'x' }, fred: { ok: false, configured: false, errors: [] }, consensus: 'unavailable — x', fedSpeeches: { link: '#' } } };

group('Trading calendar (NYSE holidays, Eastern Time)');
{
  const h26 = ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'];
  assert(h26.every(d => !M.isTradingDay(d)), 'all ten 2026 NYSE holidays are closed (incl. Good Friday Apr 3, July 4 observed Fri Jul 3)');
  assert([...M.nyseHolidays(2026)].sort().join() === h26.join(), '2026 holiday list has exactly those ten dates');
  const h27 = ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'];
  assert([...M.nyseHolidays(2027)].sort().join() === h27.join(), '2027 list: Juneteenth observed Fri Jun 18, July 4 observed Mon Jul 5, Christmas observed Fri Dec 24');
  assert(M.isTradingDay('2021-12-31') && !M.nyseHolidays(2022).has('2021-12-31'), "New Year's Day on a Saturday (2022) is not observed the Friday before");
  assert(!M.isTradingDay('2026-10-10') && !M.isTradingDay('2026-10-11'), 'weekends are closed');
  assert(M.isTradingDay('2026-10-12'), 'Columbus Day is a normal trading day');
  assert(M.closeMinutes('2026-11-27') === 780 && M.closeMinutes('2026-12-24') === 780 && M.closeMinutes('2026-10-09') === 960, '1:00 PM close the day after Thanksgiving and on Christmas Eve');
  assert(M.nextTradingDay('2026-11-25') === '2026-11-27' && M.prevTradingDay('2026-10-12') === '2026-10-09', 'next/previous trading day skip holidays and weekends');
}

group('Market session state');
{
  const s = iso => M.marketSession(at(iso));
  assert(s('2026-10-09T13:29:00Z').state === 'premarket', '9:29 AM ET (EDT) is premarket');
  assert(s('2026-10-09T13:30:00Z').state === 'regular', '9:30 AM ET is the regular session');
  assert(s('2026-10-09T19:59:00Z').state === 'regular' && s('2026-10-09T20:00:00Z').state === 'afterhours', '4:00 PM ET flips to after-hours');
  assert(s('2026-10-10T00:00:00Z').state === 'closed', '8:00 PM ET is closed');
  assert(s('2026-10-09T07:59:00Z').state === 'closed' && s('2026-10-09T08:00:00Z').state === 'premarket', 'premarket starts at 4:00 AM ET');
  assert(s('2026-12-15T14:29:00Z').state === 'premarket' && s('2026-12-15T14:30:00Z').state === 'regular', 'winter (EST): the open is 14:30 UTC, not 13:30');
  const sat = s('2026-10-10T15:00:00Z');
  assert(sat.state === 'closed' && sat.refDate === '2026-10-09' && sat.nextOpenDate === '2026-10-12', 'Saturday: describes Friday, next open Monday');
  const early = s('2026-10-09T06:00:00Z');
  assert(early.refDate === '2026-10-08' && early.nextOpenDate === '2026-10-09', '2 AM on a trading day still describes yesterday, next open is today');
  const hol = s('2026-11-26T16:00:00Z');
  assert(hol.state === 'closed' && hol.refDate === '2026-11-25' && hol.nextOpenDate === '2026-11-27', 'Thanksgiving: closed, next open Friday');
  assert(s('2026-11-27T18:30:00Z').state === 'afterhours' && s('2026-11-27T17:59:00Z').state === 'regular', 'half day: regular session ends 1:00 PM ET');
}

group('Indicator maths (hand-worked)');
{
  assert(M.sma([1, 2, 3, 4, 5], 3) === 4 && M.sma([1, 2], 3) === null, 'SMA(3) of 1..5 = 4; null when too few values');
  // EMA(3), k=0.5: seed SMA(1,2,3)=2 → 4*.5+2*.5=3 → 5*.5+3*.5=4
  assert(M.ema([1, 2, 3, 4, 5], 3) === 4, 'EMA(3) of 1..5 = 4 (SMA-seeded)');
  assert(M.rsi(Array.from({ length: 20 }, (_, i) => i), 14) === 100, 'RSI of a straight rise = 100');
  assert(near(M.rsi(Array.from({ length: 20 }, (_, i) => 100 - i), 14), 0), 'RSI of a straight fall = 0');
  assert(M.rsi([1, 2, 3], 14) === null, 'RSI null without 15 closes');
  // typical prices 10 and 20, volumes 100 and 300 → (1000+6000)/400 = 17.5
  assert(M.vwap([{ h: 11, l: 9, c: 10, v: 100 }, { h: 21, l: 19, c: 20, v: 300 }]) === 17.5, 'VWAP weights typical price by volume');
  assert(M.vwap([{ h: 1, l: 1, c: 1, v: 0 }]) === null, 'VWAP null with zero volume');
  assert(near(M.pearson([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 1, 1e-9) && near(M.pearson([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1, 1e-9), 'Pearson: +1 for lockstep, −1 for mirror');
  assert(M.pearson([1, 2], [1, 2]) === null, 'Pearson null with too few points');
  // TR: bar1 = max(2, |12-10|, |10-10|)=2 ; constant 2 → ATR 2
  const bars = Array.from({ length: 16 }, () => ({ h: 12, l: 10, c: 10 }));
  assert(M.atr(bars, 14) === 2, 'ATR(14) of constant 2-point ranges = 2');
  const z = M.clusterZones([{ price: 100, date: 'a' }, { price: 100.2, date: 'b' }, { price: 105, date: 'c' }], 0.35);
  assert(z.length === 2 && z[0].touches === 2 && z[0].lo === 100 && z[0].hi === 100.2, 'pivots within tolerance merge into one zone');
  const chain = M.clusterZones([100, 100.3, 100.6, 100.9, 1012e-1].map(p => ({ price: p, date: 'x' })), 0.35);
  assert(chain.every(c => (c.hi - c.lo) / c.lo * 100 <= 0.7 + 1e-9), 'evenly spaced pivots cannot chain into one over-wide zone');
}

group('Fixture: independent recomputation (Oct 8 2026, 3:30 PM ET)');
{
  const now = at('2026-10-08T19:30:00Z');
  const { daily, intraday } = replay(now);
  const e = M.analyzeEtf({ symbol: 'SPY', daily: daily.SPY, intraday: intraday.SPY, trade: null, nowMs: now });
  const dated = FIX.daily.SPY.map(b => ({ ...b, date: M.etParts(b.t + 12 * 3600e3).date }));
  const hist = dated.filter(b => b.date < '2026-10-08');
  const prev = hist.at(-1);
  assert(e.refDate === '2026-10-08' && e.prevCloseDate === prev.date && e.prevClose === prev.c, 'previous close is the prior session\'s close');
  assert(e.prevDayHigh === prev.h && e.prevDayLow === prev.l, "previous day's high/low match the raw bar");
  const closes = [...hist.map(b => b.c), e.price];
  const naive = n => closes.slice(-n).reduce((s, v) => s + v, 0) / n;
  assert(near(e.ma.dailySma50, naive(50)) && near(e.ma.dailySma200, naive(200)), '50- and 200-day SMA match a naive average (incl. the live bar)');
  const reg = intraday.SPY.filter(b => { const p = M.etParts(b.t); return p.date === '2026-10-08' && p.minutes >= 570 && p.minutes < 960; });
  assert(reg.length === e.sessionBars && reg.length > 60, `regular-session bar count matches (${reg.length})`);
  let pv = 0, v = 0; for (const b of reg) { pv += (b.h + b.l + b.c) / 3 * b.v; v += b.v; }
  assert(near(e.vwap, pv / v), 'VWAP matches a naive Σ(typical×vol)/Σvol');
  assert(e.dayHigh === Math.max(...reg.map(b => b.h)) && e.dayLow === Math.min(...reg.map(b => b.l)), "day's high/low come from regular-session bars only");
  const or = reg.filter(b => M.etParts(b.t).minutes < 585);
  assert(e.openingRangeHigh === Math.max(...or.map(b => b.h)) && e.openingRangeLow === Math.min(...or.map(b => b.l)), 'opening range = first 15 minutes');
  assert(near(e.changePct, (e.price / prev.c - 1) * 100), 'day change % is vs the previous close');
  const wk = hist.filter(b => b.date >= '2026-09-28' && b.date <= '2026-10-02');
  assert(e.prevWeek.high === Math.max(...wk.map(b => b.h)) && e.prevWeek.low === Math.min(...wk.map(b => b.l)), "previous week's high/low (Sep 28–Oct 2)");
  const sep = hist.filter(b => b.date.startsWith('2026-09'));
  assert(e.prevMonth.key === '2026-09' && e.prevMonth.high === Math.max(...sep.map(b => b.h)) && e.prevMonth.low === Math.min(...sep.map(b => b.l)), "previous month's high/low (September)");
  assert(e.rvol > 0 && /prior \d sessions/.test(e.rvolBasis), 'relative volume is measured against prior sessions at the same time of day');
  assert(e.levels.every(l => l.lo <= l.hi && ['support', 'resistance', 'pivot'].includes(l.role) && l.why && l.confirm && l.invalidate), 'every level has a role, a reason, a confirmation and an invalidation');
  assert(e.levels.filter(l => l.role === 'support').every(l => l.hi < e.price) && e.levels.filter(l => l.role === 'resistance').every(l => l.lo > e.price), 'support is below price, resistance above');
  const all = M.ETFS.map(s => M.analyzeEtf({ symbol: s, daily: daily[s], intraday: intraday[s], trade: null, nowMs: now }));
  const cmp = M.compareEtfs(all);
  const ret = sym => { const c = FIX.daily[sym].map(b => ({ d: M.etParts(b.t + 12 * 3600e3).date, c: b.c })).filter(x => x.d < '2026-10-08'); return c.slice(1).map((x, i) => x.c / c[i].c - 1).slice(-20); };
  assert(near(cmp.correlations[0].d20, M.pearson(ret('SPY'), ret('QQQ'))), 'SPY/QQQ 20-day correlation matches a naive recomputation');
  assert(cmp.correlations.every(c => c.d20 > 0.3 && c.d20 <= 1 && c.intraday != null), 'correlations are in a sane range and intraday is populated mid-session');
  assert(cmp.performance.day.rows.length === 3 && cmp.performance.day.leader !== cmp.performance.day.laggard, 'day leader and laggard identified');
}

group('Bias scoring rules');
{
  const now = at('2026-10-08T19:30:00Z');
  const base = (symbol, over = {}) => ({
    symbol, price: 101, priceTs: now - 60e3, changePct: 1, vwap: 100, vwapDistPct: 1, rsiIntraday: 60, rsiDaily: 60,
    rvol: 1.5, rvolBasis: 'vs. prior sessions', prevDayHigh: 100.5, prevDayLow: 98, atrPct: 1,
    openingRangeHigh: 100.4, openingRangeLow: 99.8,
    trend: { intraday: { dir: 'bullish' }, daily: { dir: 'bullish' }, weekly: { dir: 'bullish' }, monthly: { dir: 'neutral' } },
    levels: [{ role: 'resistance', distPct: -1.2, label: 'R', price: 102.2, lo: 102.2, hi: 102.2 }, { role: 'support', distPct: 0.5, label: 'S', price: 100.5, lo: 100.5, hi: 100.5 }],
    ...over,
  });
  const bull = [base('SPY', { changePct: 1.6 }), base('QQQ'), base('IWM')];
  const s = M.scoreEtf(bull[0], bull, { nowMs: now, events: [] });
  assert(s.bias === 'bullish' && s.total === 7 && s.components.length === 8, 'seven aligned components → bullish, +7 of 8');
  assert(s.confidence === 'High', 'full agreement, fresh data, regular session → High confidence');
  assert(s.components.find(c => c.key === 'catalyst').score === 0, 'the catalyst component never adds direction');
  assert(!/%/.test(s.confidence) && /not a back-tested probability/.test(s.disclaimer), 'confidence is a level, never a percentage');

  const ev = [{ name: 'CPI inflation report', ts: now + 3 * 3600e3, impact: 'high' }];
  const sEv = M.scoreEtf(bull[0], bull, { nowMs: now, events: ev });
  assert(sEv.bias === 'bullish' && sEv.confidence === 'Medium' && sEv.eventRisk.name === 'CPI inflation report', 'a high-impact release within 24h lowers confidence one step');
  assert(M.scoreEtf(bull[0], bull, { nowMs: now, events: [{ name: 'x', ts: now + 30 * 3600e3, impact: 'high' }] }).confidence === 'High', 'an event 30h away does not');

  const sNull = M.scoreEtf(bull[0], bull, { nowMs: now, events: null });
  assert(!sNull.components.find(c => c.key === 'catalyst').dataOk, 'calendar failure is reported as missing data, not as "no events"');

  const stale = bull.map(b => ({ ...b, priceTs: now - 20 * 60e3 }));
  assert(M.scoreEtf(stale[0], stale, { nowMs: now, events: [] }).confidence === 'Medium', 'a trade older than 15 minutes lowers confidence');

  const blank = sym => base(sym, { vwap: null, vwapDistPct: null, rsiIntraday: null, rsiDaily: null, rvol: null, changePct: null, prevDayHigh: null, trend: { intraday: { dir: 'unknown' }, daily: { dir: 'unknown' }, weekly: { dir: 'unknown' }, monthly: { dir: 'unknown' } }, levels: [] });
  const empty = [blank('SPY'), blank('QQQ'), blank('IWM')];
  const sE = M.scoreEtf(empty[0], empty, { nowMs: now, events: null });
  assert(sE.bias === 'neutral' && sE.confidence === 'Low' && sE.total === 0, 'no data → neutral, Low confidence (never a guess)');

  const mixed = [base('SPY', { changePct: 0.3, vwapDistPct: -0.3, rsiIntraday: 40, rvol: 0.6 }), base('QQQ', { changePct: -0.6 }), base('IWM', { changePct: 0.2 })];
  const sM = M.scoreEtf(mixed[0], mixed, { nowMs: now, events: [] });
  assert(sM.bias === 'neutral', 'contradictory evidence → neutral');
  const sc = M.buildScenarios(mixed[0], sM, mixed, { nowMs: now });
  assert(sc.lean === 'no-trade' && sc.noTrade.checks.find(c => c.label === 'Volume is light').active && sc.noTrade.checks.find(c => c.label === 'The three ETFs disagree').active, 'mixed + light volume + divergence → no-trade with the right flags lit');
  const scB = M.buildScenarios(bull[0], s, bull, { nowMs: now });
  assert(scB.lean === 'calls' && scB.calls.needs.length >= 3 && scB.calls.invalidation && scB.puts.invalidation, 'bullish + clean conditions → calls lean, both sides still carry an invalidation');
  assert(/does not pick a strike/.test(scB.note) && /cheap premium is never a reason/.test(scB.note), 'scenario note separates the ETF read from contract selection');
  const closed = M.buildScenarios(bull[0], M.scoreEtf(bull[0], bull, { nowMs: at('2026-10-10T15:00:00Z'), events: [] }), bull, { nowMs: at('2026-10-10T15:00:00Z') });
  assert(closed.lean === 'no-trade', 'market closed → always no-trade');
}

group('Response assembly: session and failure modes');
{
  const live = at('2026-10-08T19:30:00Z');
  const r = buildCoreResponse({ ...replay(live), trades: {}, calendar: noCal, nowMs: live });
  assert(r.ok && r.session.state === 'regular' && r.etfs.length === 3 && r.refreshSeconds === 30, 'regular session: three ETFs, 30s refresh');
  assert(r.etfs.every(e => e.score && e.scenarios && e.chart.daily.length && e.chart.intraday.length && !('_dailyCloses' in e)), 'each ETF carries score, scenarios and chart data; internals stripped');
  assert(r.stale === false, 'bars within 15 minutes → not stale');
  assert(JSON.stringify(r).length < 400000, 'payload stays compact');

  const staleNow = live + 25 * 60e3;
  const rs = buildCoreResponse({ ...replay(live), trades: {}, calendar: noCal, nowMs: staleNow });
  assert(rs.stale === true && rs.warnings.some(w => /stale/.test(w)), 'no trade for 25 minutes during market hours → flagged stale');

  const pre = at('2026-10-09T12:45:00Z');
  const rp = buildCoreResponse({ ...replay(pre), trades: {}, calendar: noCal, nowMs: pre });
  const spy = rp.etfs[0];
  assert(rp.session.state === 'premarket' && spy.vwap === null && spy.dayHigh === null && spy.openingRangeHigh === null, 'premarket: VWAP, day range and opening range are null, not carried over from yesterday');
  assert(spy.prevCloseDate === '2026-10-08' && spy.premarketHigh != null, 'premarket: change is vs yesterday\'s close; premarket range comes from premarket bars');
  assert(spy.scenarios.lean === 'no-trade' && spy.score.confidence !== 'High', 'premarket: no directional lean, confidence capped');

  const sat = at('2026-10-10T15:00:00Z');
  const rc = buildCoreResponse({ ...replay(sat), trades: {}, calendar: noCal, nowMs: sat });
  assert(rc.session.state === 'closed' && rc.refreshSeconds === 300 && rc.etfs[0].refDate === '2026-10-09' && rc.stale === false, 'weekend: describes Friday, slow refresh, not flagged stale');

  const rm = buildCoreResponse({ ...replay(live, { drop: ['IWM'] }), trades: {}, calendar: noCal, nowMs: live });
  const iwm = rm.etfs.find(e => e.symbol === 'IWM');
  assert(rm.ok && iwm.price === null && iwm.vwap === null && iwm.levels.length === 0 && iwm.score.bias === 'neutral', 'one ETF missing: its numbers are null and its bias neutral');
  assert(rm.warnings.some(w => /IWM/.test(w)) && rm.etfs[0].score.components.find(c => c.key === 'relative').dataOk === false, 'missing ETF is warned about and removes the cross-ETF components for the others');

  const rn = buildCoreResponse({ ...replay(live, { drop: M.ETFS }), trades: {}, calendar: noCal, nowMs: live });
  assert(rn.ok === false && /no bars/.test(rn.error) && !rn.etfs, 'provider returned nothing → ok:false with an error, no placeholder numbers');

  const rk = buildCoreResponse({ ...replay(live), trades: {}, calendar: null, nowMs: live });
  assert(rk.ok && rk.calendar === null && rk.outlooks.daily.calNote === 'Catalyst calendar unavailable.', 'calendar failure does not take the page down; it is labelled unavailable');

  const withTrade = buildCoreResponse({ ...replay(live), trades: { SPY: { p: 777.77, t: live - 2000 } }, calendar: noCal, nowMs: live });
  assert(withTrade.etfs[0].price === 777.77 && withTrade.etfs[0].priceTs === live - 2000, 'latest trade overrides the last bar close when present');
}

group('Catalyst calendar');
{
  const now = at('2026-10-09T14:00:00Z');
  const cal = await C.buildCalendar({ fredKey: undefined, nowMs: now });
  assert(cal.status.fred.configured === false && cal.events.every(e => e.category === 'fed'), 'no FRED key → FOMC schedule only, and it says FRED is not configured');
  const next = cal.events[0];
  assert(next.date === '2026-10-28' && next.timeLabel === '2:00 PM ET' && next.ts === at('2026-10-28T18:00:00Z'), 'next FOMC decision: Oct 28 2026, 2:00 PM ET (18:00 UTC in EDT)');
  assert(cal.events.every(e => e.readings.every(r => r.consensus === null)), 'consensus is always null (unavailable), never invented');
  assert(C.etToMs('2026-12-09', 14 * 60) === at('2026-12-09T19:00:00Z') && C.etToMs('2026-03-18', 14 * 60) === at('2026-03-18T18:00:00Z'), 'ET→UTC conversion handles EST and EDT');

  // FRED mocked: verify event construction without touching the network.
  const realFetch = globalThis.fetch;
  const monthly = (start, n, f) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(2026, 8 - i, 1)); return { date: d.toISOString().slice(0, 10), value: String(f(i)) }; });
  globalThis.fetch = async (url) => {
    const u = new URL(url), p = u.pathname.replace('/fred/', ''), sid = u.searchParams.get('series_id');
    let body;
    if (p === 'series/observations') {
      if (sid === 'CPIAUCSL') body = { observations: monthly(0, 30, i => 330 - i) };           // +1/mo
      else if (sid === 'PAYEMS') body = { observations: monthly(0, 30, i => 160000 - i * 150) };
      else if (sid === 'UNRATE') body = { observations: [{ date: '2026-09-01', value: '4.3' }, { date: '2026-08-01', value: '.' }, { date: '2026-07-01', value: '4.2' }] };
      else if (sid === 'DGS10') body = { observations: [{ date: '2026-10-08', value: '4.10' }, { date: '2026-10-07', value: '4.05' }] };
      else if (sid === 'DGS2') body = { observations: [{ date: '2026-10-08', value: '3.60' }] };
      else return new Response(JSON.stringify({ error_code: 400, error_message: 'Bad Request. The series does not exist.' }), { status: 400 });
    } else if (p === 'series/release') body = { releases: [{ id: sid === 'CPIAUCSL' ? 10 : sid === 'PAYEMS' ? 50 : 99, name: sid, link: 'https://example.gov/' + sid }] };
    else if (p === 'release/dates') {
      const id = u.searchParams.get('release_id');
      body = { release_dates: id === '10' ? [{ date: '2026-09-11' }, { date: '2026-10-14' }] : id === '50' ? [{ date: '2026-09-04' }, { date: '2026-10-02' }, { date: '2026-11-06' }] : [] };
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const c2 = await C.buildCalendar({ fredKey: 'test', nowMs: now });
    const cpi = c2.events.find(e => e.id === 'cpi-2026-10-14');
    assert(cpi && cpi.status === 'upcoming' && cpi.timeLabel === '8:30 AM ET' && cpi.ts === at('2026-10-14T12:30:00Z'), 'upcoming CPI: date from FRED, 8:30 AM ET');
    const yoy = cpi.readings.find(r => /CPI, year over year/.test(r.label));
    assert(yoy.actual === null && near(yoy.previous, (330 / 318 - 1) * 100, 0.06) && yoy.previousPeriod === 'Sep 2026', 'upcoming event: actual is null, previous = latest published YoY');
    const jobs = c2.events.find(e => e.id === 'jobs-2026-10-02');
    const pay = jobs.readings.find(r => /payrolls/.test(r.label)), un = jobs.readings.find(r => /Unemployment/.test(r.label));
    assert(jobs.status === 'released' && pay.actual === 150 && pay.previous === 150 && un.actual === 4.3 && un.previous === 4.2, 'released jobs report: actual + previous from FRED; "." observations skipped');
    assert(!c2.events.find(e => e.id === 'cpi-2026-09-11'), 'releases older than the window are dropped');
    assert(c2.status.fred.ok && c2.status.fred.errors.length > 0 && c2.status.fred.errors.every(x => /FRED/.test(x)), 'a failing series is reported in status, the rest still load');
    assert(c2.macro.yields.tenYear === 4.1 && near(c2.macro.yields.tenYearChange1d, 0.05) && near(c2.macro.yields.spread2s10s, 0.5), 'macro snapshot: 10y, 1-day change and 2s10s spread');
    assert(/not shown/.test(c2.macro.fedExpectations), 'rate-cut odds are declared unavailable rather than estimated');
  } finally { globalThis.fetch = realFetch; }

  // Reaction measurement on synthetic 5-minute bars around a 10:00 AM release.
  const t0 = C.etToMs('2026-10-08', 10 * 60);
  const bar = (min, c) => ({ t: t0 + min * 60e3, c, o: c, h: c, l: c, v: 1 });
  const bars = { SPY: [bar(-5, 100), bar(0, 100.5), bar(25, 101), bar(355, 102)], QQQ: [] };
  const rx = C.measureReaction(t0, bars, t0 + 24 * 3600e3);
  assert(rx.bySymbol.SPY.initialPct === 1 && near(rx.bySymbol.SPY.laterPct, 0.99) && rx.bySymbol.QQQ.initialPct === null, 'reaction: +1% in the first 30 min, then to the close; null where there are no bars');
  assert(C.measureReaction(t0, { SPY: [] }, t0 + 1e6) === null, 'no bars at all → reaction is null, not zero');
  assert(C.measureReaction(t0, bars, t0 + 10 * 60e3) === null, 'reaction is not reported before 30 minutes have passed');
}

group('Movers: snapshot → change vs previous close');
{
  const reg = M.marketSession(at('2026-10-09T15:00:00Z'));
  const snap = { dailyBar: { t: '2026-10-09T04:00:00Z', c: 101 }, prevDailyBar: { t: '2026-10-08T04:00:00Z', c: 100 }, latestTrade: { p: 102, t: '2026-10-09T14:59:00Z' } };
  assert(quoteFromSnapshot(snap, reg).changePct === 2, 'regular session: latest trade vs previous close');
  const pre = M.marketSession(at('2026-10-09T12:00:00Z'));
  const snapPre = { dailyBar: { t: '2026-10-08T04:00:00Z', c: 100 }, prevDailyBar: { t: '2026-10-07T04:00:00Z', c: 90 }, latestTrade: { p: 100.5, t: '2026-10-08T23:00:00Z' } };
  const q = quoteFromSnapshot(snapPre, pre);
  assert(q.changePct === null && /No trades yet/.test(q.note), 'premarket with no trade today: change is null, not yesterday\'s move');
  assert(quoteFromSnapshot({ ...snapPre, latestTrade: { p: 101, t: '2026-10-09T11:30:00Z' } }, pre).changePct === 1, 'premarket trade today: measured against yesterday\'s close');
  const sat = M.marketSession(at('2026-10-10T15:00:00Z'));
  assert(quoteFromSnapshot({ ...snap, latestTrade: { p: 150, t: '2026-10-09T23:50:00Z' } }, sat).changePct === 1, 'market closed: uses the regular-session close, ignoring late after-hours prints');
  assert(quoteFromSnapshot(undefined, reg).changePct === null, 'missing snapshot → null');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
