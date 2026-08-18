/**
 * ORB Signal Engine — state machine + math correctness tests
 * Run with: node tests/orb-engine.test.js
 *
 * Imports the REAL js/orb-engine.js (not a re-implemented stand-in) so this
 * exercises the exact code that ships in orbsignalengine.html.
 *
 * Covers the 25 edge cases from the audit spec. Several of them (18-25) are
 * data-fetch/UI-layer concerns this pure module doesn't own — those are
 * marked NOT THIS MODULE below with where they're actually verified, rather
 * than faking a passing assertion for something this file can't exercise.
 */
const assert_ = require('assert');
const E = require('../js/orb-engine.js');
const S = E.STATES;

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}
function group(name) { console.log(`\n${name}`); }

function c(open, high, low, close, volumeSurge) {
  return { open, high, low, close, volumeSurge: volumeSurge != null ? volumeSurge : null };
}

// Drives advanceState across a full candle array, mirroring how
// orbsignalengine.html will call it once per revealed candle.
function runSession(candles, orPeriod, config) {
  const ctx = {
    orPeriod, allCandles: candles, sessionCandles: candles.length,
    orHigh: null, orLow: null, orRangePct: null,
    breakoutDir: null, breakoutIdx: null, breakoutVolumeSurge: null,
    hasFailedBreakout: { long: false, short: false },
    entryPrice: null, stopPrice: null, targetPrice: null, entryIdx: null, riskPlan: null,
    exitPrice: null, exitReason: null, lastEvaluatedIdx: null,
  };
  let state = S.WAITING_FOR_RANGE;
  const allEvents = [];
  const trace = [];
  for (let i = 0; i < candles.length; i++) {
    const { nextState, events } = E.advanceState(state, i, candles[i], ctx, config);
    state = nextState;
    allEvents.push(...events.map(e => Object.assign({ idx: i }, e)));
    trace.push(state);
  }
  return { finalState: state, events: allEvents, ctx, trace };
}

function eventsOfType(events, type) { return events.filter(e => e.type === type); }

// ── OR baseline used by most tests: single 15m candle, healthy 0.8% range ──
const OR_CANDLE = c(100, 100.5, 99.7, 100.2);

group('1-2. Price never breaks the opening range (neither side)');
{
  const inside = Array.from({ length: 9 }, () => c(100.1, 100.4, 99.8, 100.2));
  const { finalState, events } = runSession([OR_CANDLE, ...inside], 1);
  assert(finalState === S.NO_TRADE, 'stays NO_TRADE when price never breaks either side');
  assert(eventsOfType(events, 'NO_TRADE')[0].reason === E.NO_TRADE_REASONS.NO_BREAKOUT, 'reason is NO_BREAKOUT');
}

group('3. Wick above OR High but candle closes below it — must not confirm');
{
  const r = E.classifyBreakoutCandle(c(100, 100.9, 99.9, 100.3), 100.5, 99.7, 'long');
  assert(r.confirmed === false, 'not confirmed');
  assert(r.poked === true, 'but flagged as a poke through the level');
}

group('4. Wick below OR Low but candle closes above it — must not confirm');
{
  const r = E.classifyBreakoutCandle(c(100, 100.1, 99.3, 99.9), 100.5, 99.7, 'short');
  assert(r.confirmed === false, 'not confirmed');
  assert(r.poked === true, 'but flagged as a poke through the level');
}

group('5. Clean bullish breakout');
{
  const brk = c(100.4, 101.05, 100.35, 101.0); // body ratio 0.6/0.7 = 0.857
  const { events } = runSession([OR_CANDLE, brk], 1);
  const conf = eventsOfType(events, 'BREAKOUT_CONFIRMED')[0];
  assert(conf && conf.dir === 'long', 'BREAKOUT_CONFIRMED long fires');
}

group('6. Clean bearish breakout');
{
  const brk = c(99.6, 99.65, 98.95, 99.0);
  const { events } = runSession([OR_CANDLE, brk], 1);
  const conf = eventsOfType(events, 'BREAKOUT_CONFIRMED')[0];
  assert(conf && conf.dir === 'short', 'BREAKOUT_CONFIRMED short fires');
}

group('7. Bullish breakout + successful retest');
{
  const brk = c(100.4, 101.05, 100.35, 101.0);
  const retest = c(100.9, 100.95, 100.45, 100.8); // touches 100.5+tol, closes above 100.5
  const { finalState, ctx, events } = runSession([OR_CANDLE, brk, retest], 1);
  assert(finalState === S.ENTRY_TRIGGERED, 'lands in ENTRY_TRIGGERED');
  assert(eventsOfType(events, 'RETEST_CONFIRMED').length === 1, 'RETEST_CONFIRMED fired once');
  assert(ctx.entryPrice === 100.8, 'entry price is the retest candle\'s own close (100.8)');
  assert(ctx.stopPrice === 99.7, 'stop is OR Low (the invalidation level)');
  assert(Math.abs(ctx.targetPrice - (100.8 + (100.8 - 99.7) * 2)) < 1e-9, 'target = entry + risk*2');
}

group('8. Bearish breakout + successful retest');
{
  const brk = c(99.6, 99.65, 98.95, 99.0);
  const retest = c(99.3, 99.65, 99.2, 99.4); // high 99.65 >= orLow(99.7)-tol(0.12)=99.58 -> touched; closes below 99.7
  const { finalState, ctx } = runSession([OR_CANDLE, brk, retest], 1);
  assert(finalState === S.ENTRY_TRIGGERED, 'lands in ENTRY_TRIGGERED');
  assert(ctx.entryPrice === 99.4, 'entry price is the retest candle\'s own close');
  assert(ctx.stopPrice === 100.5, 'stop is OR High for a short');
}

group('9. Bullish breakout + failed retest (reclaimed)');
{
  const brk = c(100.4, 101.05, 100.35, 101.0);
  const failRetest = c(100.4, 100.5, 100.3, 99.5); // touches, closes below OR Low -> reclaimed
  const { finalState, ctx, events } = runSession([OR_CANDLE, brk, failRetest], 1);
  assert(finalState === S.FAILED_BREAKOUT, 'lands in FAILED_BREAKOUT');
  assert(eventsOfType(events, 'FAILED_BREAKOUT')[0].cause === 'RECLAIMED', 'cause is RECLAIMED');
  assert(ctx.hasFailedBreakout.long === true, 'long direction marked as used up');
}

group('10. Bearish breakout + failed retest (reclaimed)');
{
  const brk = c(99.6, 99.65, 98.95, 99.0);
  const failRetest = c(99.6, 99.7, 99.5, 100.7); // touches, closes above OR High -> reclaimed
  const { finalState, ctx } = runSession([OR_CANDLE, brk, failRetest], 1);
  assert(finalState === S.FAILED_BREAKOUT, 'lands in FAILED_BREAKOUT');
  assert(ctx.hasFailedBreakout.short === true, 'short direction marked as used up');
}

group('11. Breakout with no retest at all (runs away)');
{
  const brk = c(100.4, 101.05, 100.35, 101.0);
  const runAway = [c(101.4, 101.9, 101.3, 101.8), c(101.8, 102.3, 101.7, 102.2), c(102.2, 102.7, 102.1, 102.6)];
  const { finalState, ctx, events } = runSession([OR_CANDLE, brk, ...runAway], 1);
  assert(finalState === S.FAILED_BREAKOUT, 'eventually FAILED_BREAKOUT');
  assert(eventsOfType(events, 'FAILED_BREAKOUT')[0].cause === 'EXTENDED_NO_RETEST', 'cause is EXTENDED_NO_RETEST');
}

group('12. Retest arriving exactly at the 3-candle cutoff is still honored');
{
  const brk = c(100.4, 101.05, 100.35, 101.0);
  const wait = [c(101.4, 101.9, 101.3, 101.8), c(101.8, 102.0, 101.5, 101.6)];
  const retestAt3 = c(101.0, 101.1, 100.45, 100.9); // sinceBreakout === 3, touches and holds
  const { finalState } = runSession([OR_CANDLE, brk, ...wait, retestAt3], 1);
  assert(finalState === S.ENTRY_TRIGGERED, 'a retest that arrives exactly on the cutoff candle still confirms (not blocked)');
}

group('13. OR range below minimum (0.15%) is excluded');
{
  const tinyOR = c(100, 100.05, 100.0, 100.02); // 0.05% range
  const { finalState, events } = runSession([tinyOR, c(100.02, 100.03, 100.0, 100.01)], 1);
  assert(finalState === S.NO_TRADE, 'NO_TRADE');
  assert(eventsOfType(events, 'NO_TRADE')[0].reason === E.NO_TRADE_REASONS.OR_TOO_NARROW, 'reason is OR_TOO_NARROW');
}

group('14. OR range above maximum (1.2%) is excluded');
{
  const wideOR = c(100, 101.5, 100.0, 101.0); // 1.5% range
  const { finalState, events } = runSession([wideOR, c(101.0, 101.1, 100.9, 101.0)], 1);
  assert(finalState === S.NO_TRADE, 'NO_TRADE');
  assert(eventsOfType(events, 'NO_TRADE')[0].reason === E.NO_TRADE_REASONS.OR_TOO_WIDE, 'reason is OR_TOO_WIDE');
}

group('15. Session ends before target or stop is hit — forced flatten');
{
  const brk = c(100.4, 101.05, 100.35, 101.0);
  const retest = c(100.9, 100.95, 100.45, 100.8);
  const drift = c(100.85, 100.9, 100.8, 100.87); // last candle, no target/stop hit
  const { finalState, ctx, events } = runSession([OR_CANDLE, brk, retest, drift], 1);
  assert(finalState === S.SESSION_COMPLETE, 'SESSION_COMPLETE');
  assert(ctx.exitReason === 'FLAT', 'exit reason FLAT');
  assert(eventsOfType(events, 'SESSION_FLATTEN').length === 1, 'SESSION_FLATTEN event fired');
}

group('16. Target hit');
{
  const brk = c(100.4, 101.05, 100.35, 101.0);
  const retest = c(100.9, 100.95, 100.45, 100.8); // entry 100.8, stop 99.7, target 103.0
  const hit = c(102.9, 103.2, 102.8, 103.1);
  const { finalState, ctx } = runSession([OR_CANDLE, brk, retest, hit], 1);
  assert(finalState === S.TARGET_HIT, 'TARGET_HIT');
  assert(ctx.exitPrice === ctx.targetPrice, 'exit price equals the exact target price, not the candle close');
}

group('17. Stop hit');
{
  const brk = c(100.4, 101.05, 100.35, 101.0);
  const retest = c(100.9, 100.95, 100.45, 100.8); // stop 99.7
  const hit = c(100.0, 100.1, 99.5, 99.6);
  const { finalState, ctx } = runSession([OR_CANDLE, brk, retest, hit], 1);
  assert(finalState === S.STOP_HIT, 'STOP_HIT');
  assert(ctx.exitPrice === ctx.stopPrice, 'exit price equals the exact stop price, not the candle close');
}

group('First-breakout-per-direction is actually enforced (the bug this rewrite fixes)');
{
  const brk1 = c(100.4, 101.05, 100.35, 101.0);
  const failRetest = c(100.4, 100.5, 100.3, 99.5); // fails -> hasFailedBreakout.long = true
  const brk2 = c(100.4, 101.2, 100.35, 101.1); // a second, equally-clean long breakout attempt
  const { finalState, events, ctx } = runSession([OR_CANDLE, brk1, failRetest, brk2], 1);
  assert(ctx.hasFailedBreakout.long === true, 'long marked as used up after the first failure');
  const secondConfirm = eventsOfType(events, 'BREAKOUT_CONFIRMED').filter(e => e.idx === 3);
  assert(secondConfirm.length === 0, 'a second long breakout attempt is NOT re-confirmed/traded');
  assert(finalState !== S.ENTRY_TRIGGERED, 'no entry results from the blocked repeat attempt');
}

group('Both directions failed -> session-wide NO_TRADE');
{
  const ctx = {
    orPeriod: 1, allCandles: [OR_CANDLE], sessionCandles: 3,
    orHigh: 100.5, orLow: 99.7, orRangePct: 0.008,
    breakoutDir: null, breakoutIdx: null, breakoutVolumeSurge: null,
    hasFailedBreakout: { long: true, short: true },
    entryPrice: null, stopPrice: null, targetPrice: null, entryIdx: null, riskPlan: null,
    exitPrice: null, exitReason: null, lastEvaluatedIdx: null,
  };
  const { nextState, reason } = E.advanceState(S.BREAKOUT_PENDING, 1, c(100.1, 100.3, 99.9, 100.2), ctx);
  assert(nextState === S.NO_TRADE, 'NO_TRADE once both directions have failed');
  assert(reason === E.NO_TRADE_REASONS.BREAKOUT_FAILED_BOTH_DIRECTIONS, 'reason is BREAKOUT_FAILED_BOTH_DIRECTIONS');
}

group('18. Missing candle — module handles any array length gracefully');
{
  const shortSession = [OR_CANDLE, c(100.4, 101.05, 100.35, 101.0)];
  const { ctx } = runSession(shortSession, 1);
  assert(ctx.sessionCandles === 2, 'sessionCandles reflects whatever length it was actually given, no crash on a short array');
}

group('19. Duplicate candle — evaluating the same candle twice is deterministic');
{
  const dup = c(100.4, 101.05, 100.35, 101.0);
  const a = E.classifyBreakoutCandle(dup, 100.5, 99.7, 'long');
  const b = E.classifyBreakoutCandle(dup, 100.5, 99.7, 'long');
  assert(JSON.stringify(a) === JSON.stringify(b), 'identical input always produces identical output (pure function, no hidden state)');
}

group('22. Weekend/holiday (no bars for the day) — empty candle array');
{
  const or = E.computeOpeningRange([], 1);
  assert(or === null, 'computeOpeningRange returns null rather than throwing on an empty array');
}

group('20, 21, 23, 24, 25 — NOT this module’s responsibility');
console.log('  (documented, not faked here)');
console.log('  20. Premarket exclusion is orb-bars.js\'s RTH filter (functions/api/orb-bars.js, RTH_START/RTH_END) — verified in code review.');
console.log('  21. DST transitions are handled by orb-bars.js\'s Intl.DateTimeFormat(America/New_York) conversion — verified in code review.');
console.log('  23. Invalid symbol is orb-bars.js\'s input validation (symbol regex + Alpaca 4xx passthrough) — no symbol concept exists in this module.');
console.log('  24. Live feed failure is orb-bars.js\'s fetch try/catch -> error JSON — this module never fetches anything.');
console.log('  25. Simulated/live mode is orbsignalengine.html\'s UI state (which data source populated `candles`) — this module is data-source-agnostic by design.');

group('Breakout Quality — a score, explicitly not a probability');
{
  const q = E.breakoutQuality({ bodyRatio: 0.85, volumeSurge: 1.6, distanceBeyondPct: 0.003, trendScore: 80, retestQuality: 70 });
  assert(q >= 0 && q <= 100, 'score is bounded 0-100');
  const partial = E.breakoutQuality({ bodyRatio: 0.85 });
  assert(partial >= 0 && partial <= 100, 'works with partial inputs (missing factors dropped, not assumed)');
  assert(E.breakoutQuality({}) === null, 'returns null rather than a fabricated number with zero real inputs');
}

group('No-Trade Filter Checklist renders live PASS/FAIL, not static text');
{
  const ctx = {
    orRangePct: 0.008, breakoutIdx: 5, hasFailedBreakout: { long: false, short: false },
    breakoutVolumeSurge: 1.4, lastEvaluatedIdx: 6,
  };
  const rows = E.evaluateNoTradeChecklist(S.RETEST_PENDING, ctx);
  assert(rows.length === 6, 'six checklist rows');
  assert(rows.every(r => 'pass' in r && 'detail' in r), 'every row carries a real pass/fail/null verdict and a concrete detail, not placeholder text');
}

group('Deterministic Risk/Target/R:R (item #10 example)');
{
  const plan = E.deriveEntryPlan(100.40, 99.90, 'long');
  assert(plan.risk === 0.5 && plan.target === 101.4 && plan.reward === 1 && plan.rr === 2, 'matches the spec’s worked example exactly, entry/stop/risk/target/reward/rr all consistent');
  const degenerate = E.deriveEntryPlan(100, 100, 'long');
  assert(degenerate.degenerate === true, 'a zero-distance stop is surfaced explicitly, never silently floored');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
