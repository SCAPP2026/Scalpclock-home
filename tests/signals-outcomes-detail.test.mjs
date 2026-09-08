/**
 * functions/api/signals-outcomes-detail.js — wiring smoke test with mocked
 * fetch (Supabase REST + Alpaca latest-bars). No live credentials needed.
 * Run with: node tests/signals-outcomes-detail.test.mjs
 */
import { onRequest } from '../functions/api/signals-outcomes-detail.js';

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

const CRON_SECRET = 'test-secret';
const baseEnv = {
  SIGNALS_CRON_SECRET: CRON_SECRET,
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  ALPACA_KEY_ID: 'test', ALPACA_SECRET: 'test',
};

function req(headers = {}) {
  return new Request('https://scalpclock.com/api/signals-outcomes-detail', { headers });
}

// ── 1. Rejects without the correct cron secret ──────────────────────────────
{
  const res = await onRequest({ env: baseEnv, request: req({}) });
  assert(res.status === 401, `missing secret -> 401 (got ${res.status})`);
}
{
  const res = await onRequest({ env: baseEnv, request: req({ 'x-cron-secret': 'wrong' }) });
  assert(res.status === 401, `wrong secret -> 401 (got ${res.status})`);
}

// ── 2. Not configured -> soft 200, not a hard failure ───────────────────────
{
  const res = await onRequest({ env: { SIGNALS_CRON_SECRET: CRON_SECRET }, request: req({ 'x-cron-secret': CRON_SECRET }) });
  const data = await res.json();
  assert(res.status === 200 && data.error === 'Not configured', 'missing Supabase/Alpaca env -> soft 200 "Not configured"');
}

// ── 3. No snapshots today -> 0 processed, no crash ──────────────────────────
{
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/rest/v1/signal_history')) return new Response(JSON.stringify([]), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  };
  const res = await onRequest({ env: baseEnv, request: req({ 'x-cron-secret': CRON_SECRET }) });
  const data = await res.json();
  global.fetch = realFetch;
  assert(res.status === 200 && data.ok === true && data.processed === 0 && data.note, `no rows today -> ok:true, processed:0, note present (got ${JSON.stringify(data)})`);
}

// ── 4. Real insert/update flow with synthetic rows ──────────────────────────
{
  const realFetch = global.fetch;
  const posted = [];
  const patched = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = opts?.method || 'GET';
    if (u.includes('/rest/v1/signal_history') && method === 'GET') {
      // One signal snapshotted 12 minutes ago (buy, NVDA) — crosses the 5
      // and 10-min fixed horizons, not yet 15/30.
      return new Response(JSON.stringify([
        { id: 101, symbol: 'NVDA', tone: 'buy', snapshot_price: 100, snapshot_at: new Date(Date.now() - 12 * 60000).toISOString() },
      ]), { status: 200 });
    }
    if (u.includes('/v2/stocks/bars/latest')) {
      return new Response(JSON.stringify({ bars: { NVDA: { c: 103 } } }), { status: 200 });
    }
    if (u.includes('/rest/v1/signal_outcomes_detail') && method === 'GET') {
      return new Response(JSON.stringify([]), { status: 200 }); // no existing detail rows yet
    }
    if (u.includes('/rest/v1/signal_outcomes_detail') && method === 'POST') {
      const body = JSON.parse(opts.body);
      posted.push(...body);
      return new Response(JSON.stringify(body.map((b, i) => ({ ...b, id: 900 + i }))), { status: 201 });
    }
    if (method === 'PATCH') {
      patched.push({ url: u, body: JSON.parse(opts.body) });
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const res = await onRequest({ env: baseEnv, request: req({ 'x-cron-secret': CRON_SECRET }) });
  const data = await res.json();
  global.fetch = realFetch;

  assert(res.status === 200 && data.ok === true, `insert flow -> ok:true (got ${JSON.stringify(data)})`);
  assert(data.signalsChecked === 1, `signalsChecked === 1 (got ${data.signalsChecked})`);

  const fixed5 = posted.find(p => p.horizon_type === 'fixed' && p.horizon_minutes === 5);
  const fixed10 = posted.find(p => p.horizon_type === 'fixed' && p.horizon_minutes === 10);
  const fixed15 = posted.find(p => p.horizon_type === 'fixed' && p.horizon_minutes === 15);
  const mfe = posted.find(p => p.horizon_type === 'mfe');
  const mae = posted.find(p => p.horizon_type === 'mae');

  assert(!!fixed5, '5-minute fixed-horizon row inserted (12min elapsed >= 5)');
  assert(!!fixed10, '10-minute fixed-horizon row inserted (12min elapsed >= 10)');
  assert(!fixed15, '15-minute fixed-horizon row NOT inserted yet (12min elapsed < 15)');
  assert(!!mfe && Math.abs(mfe.return_pct - 3) < 0.01, `mfe row inserted with +3% favorable excursion (got ${mfe?.return_pct})`);
  assert(!!mae && Math.abs(mae.return_pct - 3) < 0.01, `mae row inserted with +3% (first observation, mfe===mae initially) (got ${mae?.return_pct})`);
  assert(fixed5.return_pct === 3, `fixed-horizon return_pct is raw (not direction-adjusted): +3% (got ${fixed5.return_pct})`);
}

// ── 5. Update path: a more-extreme MFE observation updates, not duplicates ──
{
  const realFetch = global.fetch;
  const patched = [];
  const posted = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    const method = opts?.method || 'GET';
    if (u.includes('/rest/v1/signal_history') && method === 'GET') {
      return new Response(JSON.stringify([
        { id: 101, symbol: 'NVDA', tone: 'buy', snapshot_price: 100, snapshot_at: new Date(Date.now() - 12 * 60000).toISOString() },
      ]), { status: 200 });
    }
    if (u.includes('/v2/stocks/bars/latest')) {
      return new Response(JSON.stringify({ bars: { NVDA: { c: 108 } } }), { status: 200 }); // now +8%, more favorable than the prior +3% mfe
    }
    if (u.includes('/rest/v1/signal_outcomes_detail') && method === 'GET') {
      return new Response(JSON.stringify([
        { id: 900, signal_history_id: 101, horizon_type: 'fixed', horizon_minutes: 5, return_pct: 3 },
        { id: 901, signal_history_id: 101, horizon_type: 'fixed', horizon_minutes: 10, return_pct: 3 },
        { id: 902, signal_history_id: 101, horizon_type: 'mfe', return_pct: 3 },
        { id: 903, signal_history_id: 101, horizon_type: 'mae', return_pct: 3 },
      ]), { status: 200 });
    }
    if (u.includes('/rest/v1/signal_outcomes_detail') && method === 'POST') {
      const body = JSON.parse(opts.body);
      posted.push(...body);
      return new Response(JSON.stringify(body.map((b, i) => ({ ...b, id: 950 + i }))), { status: 201 });
    }
    if (method === 'PATCH') {
      patched.push({ url: u, body: JSON.parse(opts.body) });
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const res = await onRequest({ env: baseEnv, request: req({ 'x-cron-secret': CRON_SECRET }) });
  const data = await res.json();
  global.fetch = realFetch;

  assert(res.status === 200 && data.updated === 1, `MFE update path -> updated:1 (got ${JSON.stringify(data)})`);
  assert(patched.length === 1 && patched[0].url.includes('id=eq.902'), `PATCH targeted the mfe row (id=902), not mae (got ${patched.map(p=>p.url)})`);
  assert(patched[0].body.return_pct === 8, `mfe updated to the new, more-favorable +8% (got ${patched[0]?.body?.return_pct})`);
  assert(posted.length === 0, 'no duplicate rows inserted for fixed-5/10 or mae (mae did not improve, fixed horizons already existed)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
