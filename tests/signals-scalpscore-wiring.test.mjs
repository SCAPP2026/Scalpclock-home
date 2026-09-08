/**
 * End-to-end wiring smoke test: calls the REAL functions/api/signals.js
 * onRequest handler (not a re-implementation) with `fetch` mocked to return
 * synthetic Alpaca-shaped responses, and confirms:
 *   1. The response still contains every legacy field (regression guard).
 *   2. A new `scalpScore` field is attached with a valid 0-100 score.
 * No network/Alpaca credentials needed — this is what makes it runnable here.
 * Run with: node tests/signals-scalpscore-wiring.test.mjs
 */
import { onRequest } from '../functions/api/signals.js';

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

function makeBars(n, { basePrice = 100, trend = 0.05, vol = 800000, startISO } = {}) {
  const bars = [];
  let price = basePrice;
  const base = new Date(startISO || '2026-09-08T13:30:00Z');
  for (let i = 0; i < n; i++) {
    const open = price;
    price = price + trend + Math.sin(i) * 0.05;
    const close = price;
    const high = Math.max(open, close) + 0.1;
    const low = Math.min(open, close) - 0.1;
    const t = new Date(base.getTime() + i * 15 * 60000).toISOString();
    bars.push({ t, o: open, h: high, l: low, c: close, v: vol });
  }
  return bars;
}

const SYMBOL = 'NVDA';
const bars15 = makeBars(60, { trend: 0.08 });
const dayBars = makeBars(8, { basePrice: 90, trend: 2, vol: 40_000_000 }); // daily bars, big $ volume

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });

  if (u.includes('/v2/clock')) return json({ is_open: true });
  if (u.includes('/screener/stocks')) return json({ most_actives: [], gainers: [], losers: [] });
  if (u.includes('/bars/latest')) {
    return json({ bars: { [SYMBOL]: { c: bars15[bars15.length - 1].c, v: bars15[bars15.length - 1].v } } });
  }
  if (u.includes('timeframe=15Min')) return json({ bars: { [SYMBOL]: bars15 } });
  if (u.includes('timeframe=1Day')) return json({ bars: { [SYMBOL]: dayBars } });
  // Polygon/Finnhub news — env keys are unset in this test, so signals.js
  // never actually calls these (fetchNewsTickers short-circuits to
  // Promise.resolve(null) per-source when the key is missing), but return
  // something harmless just in case.
  return json({});
};

const context = {
  env: { ALPACA_KEY_ID: 'test', ALPACA_SECRET: 'test' }, // no MASSIVE_API_KEY/FINNHUB_KEY -> news check no-ops
  request: new Request(`https://scalpclock.com/api/signals?symbol=${SYMBOL}&range=day`),
};

try {
  const res = await onRequest(context);
  const data = await res.json();

  console.log('\nResponse (single-symbol lookup):');
  console.log(JSON.stringify({ ...data, result: { ...data.result, scalpScore: '(see below)' } }, null, 2));

  assert(res.status === 200, `HTTP 200 (got ${res.status})`);
  assert(data.result != null, 'result object present');
  const r = data.result || {};

  // Legacy fields — regression guard. If any of these go missing or change
  // shape, the wiring change broke something it shouldn't have.
  for (const field of ['symbol', 'ok', 'price', 'changePct', 'rsi', 'vwap', 'vwapDist', 'volSurge', 'lowLiquidity', 'tone', 'signal', 'conviction', 'explain', 'confluence', 'hasNews']) {
    assert(field in r, `legacy field "${field}" still present`);
  }
  assert(r.symbol === SYMBOL, 'symbol matches request');
  assert(typeof data.sampsonX === 'string' && data.sampsonX.length > 0, 'sampsonX string still present');

  // New field.
  assert('scalpScore' in r, 'new scalpScore field present');
  if (r.scalpScore) {
    assert(typeof r.scalpScore.score === 'number' && r.scalpScore.score >= 0 && r.scalpScore.score <= 100, `scalpScore.score is a valid 0-100 number (got ${r.scalpScore.score})`);
    assert(typeof r.scalpScore.breakdown === 'object', 'scalpScore.breakdown present');
    assert(['CALL', 'PUT'].includes(r.scalpScore.direction), `scalpScore.direction is CALL/PUT (got ${r.scalpScore.direction})`);
    console.log(`\n  scalpScore summary: ${r.scalpScore.score}/100, setup="${r.scalpScore.setup}", confidence=${r.scalpScore.confidence}`);
  } else {
    console.error('  scalpScore is null — synthetic data may not have produced a valid tone (buy/sell), check sig.tone upstream');
  }
} catch (e) {
  console.error('FATAL:', e.stack);
  failed++;
} finally {
  global.fetch = realFetch;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
