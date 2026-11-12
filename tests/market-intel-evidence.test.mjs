/**
 * Evidence Engine (PRO) + entitlement tests.
 * Run with: node tests/market-intel-evidence.test.mjs
 *
 * Replays the recorded IEX fixture (tests/fixtures/market-intel-bars.json)
 * through the REAL buildCoreResponse → scoreEvidence path. No network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../functions/lib/market-intel.js';
import { buildCoreResponse, publicBody, PRO_FIELDS } from '../functions/lib/market-intel-response.js';
import { scoreEvidence, classicPivots, priceStructure, bandLabel, DEFAULT_EVIDENCE_CONFIG } from '../functions/lib/market-intel-evidence.js';
import { hasProAccess, checkPro } from '../functions/lib/entitlement.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/market-intel-bars.json'), 'utf8'));
let passed = 0, failed = 0;
function assert(cond, label) { if (cond) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ FAIL: ${label}`); failed++; } }
const at = iso => Date.parse(iso);
function body(nowMs, extra = {}) {
  const daily = {}, intraday = {}, today = M.etParts(nowMs).date;
  for (const s of M.ETFS) {
    daily[s] = FIX.daily[s].filter(b => M.etParts(b.t + 12 * 3600e3).date <= today && b.t <= nowMs);
    intraday[s] = FIX.intraday[s].filter(b => b.t + 5 * 60e3 <= nowMs);
  }
  return buildCoreResponse({ daily, intraday, trades: {}, calendar: null, nowMs, ...extra });
}
const REG = at('2026-10-08T19:30:00Z'), PRE = at('2026-10-09T12:45:00Z'), OPEN = at('2026-10-09T13:41:00Z');

console.log('\nEntitlement');
assert(!hasProAccess(null), 'no user → no access');
assert(!hasProAccess({ id: 'u', app_metadata: {} }), 'no plan → treated as free');
assert(!hasProAccess({ id: 'u', app_metadata: { plan: 'free' } }), 'free → no access');
assert(!hasProAccess({ id: 'u', app_metadata: { plan: 'expired' } }), 'expired → no access');
for (const plan of ['pro', 'elite', 'trial', 'founding']) assert(hasProAccess({ id: 'u', app_metadata: { plan } }), `${plan} → access`);
assert(hasProAccess({ id: 'u', app_metadata: { plan: 'free', is_admin: true } }), 'admin → access');
{
  const req = h => ({ headers: { get: k => (k === 'Authorization' ? h : null) } });
  const fake = user => async () => ({ ok: !!user, json: async () => user });
  assert((await checkPro(req(null), fake(null))).status === 'anon', 'no token → anon (no network call needed)');
  assert((await checkPro(req('Bearer bad'), fake(null))).status === 'anon', 'rejected token → anon');
  assert((await checkPro(req('Bearer x'), fake({ id: 'u', app_metadata: { plan: 'free' } }))).status === 'free', 'valid free user → free');
  assert((await checkPro(req('Bearer x'), fake({ id: 'u', app_metadata: { plan: 'pro' } }))).status === 'pro', 'valid pro user → pro');
  assert((await checkPro(req('Bearer x'), async () => { throw new Error('down'); })).status === 'anon', 'Supabase down → fails closed');
}

console.log('\nFree endpoint never leaks PRO fields');
{
  const full = body(REG);
  assert(full.etfs.every(e => e.evidence), 'full build carries evidence for every ETF');
  const pub = publicBody(full);
  assert(pub.etfs.every(e => PRO_FIELDS.every(k => !(k in e))), 'publicBody strips every PRO field');
  assert(JSON.stringify(pub).indexOf('"bull"') === -1, 'no bull/bear scores anywhere in the public JSON');
  assert(full.etfs.every(e => 'evidence' in e), 'publicBody does not mutate the cached full body');
  assert(publicBody({ ok: false, error: 'x' }).error === 'x', 'error bodies pass through');
}

console.log('\nScores');
for (const [name, ms] of [['regular', REG], ['premarket', PRE], ['just after open', OPEN]]) {
  for (const e of body(ms).etfs) {
    const v = e.evidence;
    const sumBull = v.categories.reduce((s, c) => s + c.bull, 0), sumBear = v.categories.reduce((s, c) => s + c.bear, 0);
    const ok = v.bull >= 0 && v.bull <= 100 && v.bear >= 0 && v.bear <= 100
      && Math.abs(Math.round(sumBull) - v.bull) <= 0 && Math.abs(Math.round(sumBear) - v.bear) <= 0
      && v.categories.every(c => c.bull <= c.weight + 1e-9 && c.bear <= c.weight + 1e-9)
      && v.categories.filter(c => !c.dataOk).every(c => c.bull === 0 && c.bear === 0);
    assert(ok, `${name} ${e.symbol}: scores 0–100, sum of categories, capped by weight, missing = 0 (bull ${v.bull} / bear ${v.bear})`);
  }
}
{
  const w = DEFAULT_EVIDENCE_CONFIG.weights;
  assert(Object.values(w).reduce((a, b) => a + b, 0) === 100, 'weights add up to 100');
  const v = body(REG).etfs[0].evidence;
  assert(v.coverage === 100 - w.liquidity && v.missing.includes('Options liquidity'), 'no liquidity feed → coverage 95, listed as missing (not filled in)');
  const pre = body(PRE).etfs[0].evidence;
  assert(pre.setup === 'NO TRADE' && /Premarket/.test(pre.setupWhy), 'premarket → NO TRADE (setups only during the regular session)');
  assert(pre.confirmation.call.state === 'none' && pre.confirmation.put.state === 'none', 'premarket → confirmation waits for the open');
  assert(!pre.categories.find(c => c.key === 'vwap').dataOk, 'premarket → no session VWAP yet, marked missing');
}
{
  const spy = body(REG).etfs.find(e => e.symbol === 'SPY').evidence;
  assert(spy.bear > spy.bull && /BEAR/.test(spy.condition), `10/08 3:30 PM SPY (below VWAP, lower lows) reads bearish (${spy.bull}/${spy.bear}, ${spy.condition})`);
  assert(spy.invalidation.some(x => /above VWAP/.test(x)), 'bearish lead → invalidation says reclaiming VWAP');
}
{
  const liq = { SPY: { spreadPct: 2, openInterest: 5000, volume: 1000 } };
  const v = body(REG, { liquidity: liq }).etfs.find(e => e.symbol === 'SPY').evidence;
  const c = v.categories.find(c => c.key === 'liquidity');
  assert(c.dataOk && c.bull === c.weight && c.bear === c.weight && v.coverage === 100, 'liquid contract (when supplied) → full points to both sides, coverage 100');
}
{
  const v = body(REG).etfs[0].evidence;
  const ev = [{ name: 'CPI', impact: 'high', ts: REG + 20 * 60e3 }];
  const e = body(REG).etfs[0];
  const locked = scoreEvidence({ e: { ...e }, all: body(REG).etfs, intradayRaw: FIX.intraday.SPY.filter(b => b.t + 5 * 60e3 <= REG), nowMs: REG, events: ev });
  assert(locked.setup === 'MARKET TOO VOLATILE' && /CPI/.test(locked.setupWhy), 'high-impact release within 60 min → MARKET TOO VOLATILE');
  assert(v.setup !== 'MARKET TOO VOLATILE' || /range/.test(v.setupWhy), 'without the release it is not event-locked');
}

console.log('\nHelpers');
{
  const p = classicPivots({ h: 110, l: 100, c: 105 });
  assert(p.P === 105 && p.R1 === 110 && p.S1 === 100 && p.R2 === 115 && p.S2 === 95, 'classic pivots P/R1/S1/R2/S2');
  assert(classicPivots(null) === null, 'no previous day → no pivots');
  const up = [100, 102, 101, 104, 103, 106, 105, 108, 107].map((c, i) => ({ h: c + 0.5, l: c - 0.5, c, t: i }));
  assert(priceStructure(up, 1).kind === 'uptrend', 'zig-zag up → uptrend');
  const dn = up.map(b => ({ ...b, h: 200 - b.l, l: 200 - b.h }));
  assert(priceStructure(dn, 1).kind === 'downtrend', 'zig-zag down → downtrend');
  assert(bandLabel(85) === 'Strong evidence' && bandLabel(65) === 'Favorable evidence' && bandLabel(50) === 'Mixed evidence' && bandLabel(10) === 'Weak evidence', 'score bands');
}

console.log('\nNew levels in the free build');
{
  const spy = body(OPEN).etfs.find(e => e.symbol === 'SPY');
  const keys = new Set(spy.levels.map(l => l.key));
  assert(['pivot', 'r1', 's1', 'r2', 's2'].every(k => keys.has(k)), 'classic pivots are on the level list');
  assert(keys.has('ema50') && spy.ma.dailyEma50 != null, 'daily 50 EMA level present');
  assert(keys.has('onh') && keys.has('onl') && spy.overnightHigh >= spy.premarketHigh, 'overnight high/low present and contain the premarket range');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
