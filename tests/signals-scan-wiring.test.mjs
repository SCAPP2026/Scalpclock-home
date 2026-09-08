/**
 * Wiring smoke test for the market-SCAN path (no ?symbol=) — confirms the
 * ranked calls/puts arrays still have their legacy shape plus the new
 * scalpScore field, and that the scan doesn't throw across a small
 * multi-symbol universe. Run with: node tests/signals-scan-wiring.test.mjs
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

// One overbought "SPY"-like symbol (feeds marketPulse) and a couple of
// oversold movers so the scan actually produces calls/puts candidates
// rather than an all-Hold universe.
const SYMS = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA'];
const barsBySym = {
  SPY:  makeBars(60, { basePrice: 500, trend: 0.02 }),
  QQQ:  makeBars(60, { basePrice: 400, trend: 0.02 }),
  AAPL: makeBars(60, { basePrice: 200, trend: -0.3 }), // pushes RSI low -> Calls candidate
  TSLA: makeBars(60, { basePrice: 250, trend: 0.3 }),  // pushes RSI high -> Puts candidate
  NVDA: makeBars(60, { basePrice: 120, trend: -0.35 }),
};
const dayBarsBySym = Object.fromEntries(SYMS.map(s => [s, makeBars(8, { basePrice: 100, trend: 2, vol: 40_000_000 })]));

const realFetch = global.fetch;
global.fetch = async (url) => {
  const u = String(url);
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/v2/clock')) return json({ is_open: true });
  if (u.includes('/screener/stocks/most-actives')) return json({ most_actives: [] });
  if (u.includes('/screener/stocks/movers')) return json({ gainers: [], losers: [] });
  if (u.includes('/bars/latest')) {
    const bars = {};
    for (const s of SYMS) bars[s] = { c: barsBySym[s].at(-1).c, v: barsBySym[s].at(-1).v };
    return json({ bars });
  }
  if (u.includes('timeframe=15Min')) {
    const bars = {};
    for (const s of SYMS) bars[s] = barsBySym[s];
    return json({ bars });
  }
  if (u.includes('timeframe=1Day')) {
    const bars = {};
    for (const s of SYMS) bars[s] = dayBarsBySym[s];
    return json({ bars });
  }
  return json({});
};

const context = {
  env: { ALPACA_KEY_ID: 'test', ALPACA_SECRET: 'test' },
  request: new Request('https://scalpclock.com/api/signals?range=day'),
};

try {
  const res = await onRequest(context);
  const data = await res.json();

  assert(res.status === 200, `HTTP 200 (got ${res.status})`);
  for (const field of ['marketOpen', 'asOf', 'range', 'universeSize', 'scannedCount', 'source', 'calls', 'puts', 'marketPulse']) {
    assert(field in data, `legacy top-level field "${field}" present`);
  }
  assert(Array.isArray(data.calls) && Array.isArray(data.puts), 'calls/puts are arrays');

  const allCandidates = [...data.calls, ...data.puts];
  console.log(`\n  ${allCandidates.length} candidate(s) surfaced: ${allCandidates.map(c => `${c.symbol}(${c.tone})`).join(', ') || '(none)'}`);
  assert(allCandidates.length > 0, 'at least one candidate surfaced from the synthetic universe (sanity check the scan actually ran)');

  for (const c of allCandidates) {
    for (const field of ['symbol', 'name', 'ok', 'price', 'changePct', 'rsi', 'vwap', 'vwapDist', 'volSurge', 'tone', 'signal', 'conviction']) {
      assert(field in c, `${c.symbol}: legacy field "${field}" present`);
    }
    assert('scalpScore' in c, `${c.symbol}: new scalpScore field present`);
    if (c.scalpScore) {
      assert(typeof c.scalpScore.score === 'number', `${c.symbol}: scalpScore.score is a number (${c.scalpScore.score})`);
    }
  }
} catch (e) {
  console.error('FATAL:', e.stack);
  failed++;
} finally {
  global.fetch = realFetch;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
