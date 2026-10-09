// Market Intelligence Center — core endpoint for SPY / QQQ / IWM.
//
//   GET /api/market-intel
//
// One response carries everything the page needs except the movers module
// (see market-intel-movers.js): per-ETF facts and indicators, cross-ETF
// comparison, support/resistance, bias scoring, calls/puts/no-trade
// scenarios, the three outlooks and the catalyst calendar.
//
// Data: Alpaca IEX feed (same keys every other market endpoint here uses).
// IEX is real-time but is ONE exchange — prices are genuine trades, volume
// is a small slice of the consolidated tape. The response says so in
// `dataNotes` and the page labels it; nothing here is called "live SIP".
//
// Failure policy: if the provider is down the response is {ok:false, error}.
// There are no fallback numbers anywhere in this file.
import { ETFS, marketSession } from '../lib/market-intel.js';
import { buildCalendar } from '../lib/market-intel-calendar.js';
import { buildCoreResponse } from '../lib/market-intel-response.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const ALPACA = 'https://data.alpaca.markets/v2/stocks';
const DAY = 24 * 3600 * 1000;
const CALENDAR_TTL = 30 * 60;   // seconds

export async function onRequest(context) {
  const { env, request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: CORS });

  const nowMs = Date.now();
  const session = marketSession(nowMs);
  // Open market → short cache so many viewers share one upstream fetch.
  const ttl = session.state === 'closed' ? 300 : 20;

  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/market-intel?v=1', request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  if (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET) {
    return json({ ok: false, error: 'Market data provider is not configured.', asOf: new Date(nowMs).toISOString(), session }, 0);
  }
  const headers = { 'APCA-API-KEY-ID': env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET };
  const warnings = [];

  let daily, intraday, trades;
  try {
    [daily, intraday, trades] = await Promise.all([
      fetchBars('1Day', new Date(nowMs - 640 * DAY).toISOString().slice(0, 10), headers),
      fetchBars('5Min', new Date(nowMs - 10 * DAY).toISOString(), headers),
      fetchLatestTrades(headers).catch(e => { warnings.push(`Latest-trade lookup failed (${e.message}); using the most recent bar close instead.`); return {}; }),
    ]);
  } catch (e) {
    return json({ ok: false, error: `Market data provider error: ${e.message}`, asOf: new Date(nowMs).toISOString(), session }, 0);
  }

  // Calendar is slow-moving and FRED-heavy — cached on its own clock.
  const calendar = await cachedCalendar(cache, request, env, nowMs).catch(e => {
    warnings.push(`Catalyst calendar failed to load: ${e.message}`);
    return null;
  });
  const body = buildCoreResponse({ daily, intraday, trades, calendar, nowMs, warnings });
  if (!body.ok) return json(body, 0);
  const res = json(body, ttl);
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function cachedCalendar(cache, request, env, nowMs) {
  const key = new Request(new URL('/api/__market-intel-calendar?v=1', request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const cal = await buildCalendar({ fredKey: env.FRED_API_KEY, nowMs });
  // Don't pin a failed FRED fetch for the full TTL.
  const ttl = cal.status.fred.configured && !cal.status.fred.ok ? 120 : CALENDAR_TTL;
  await cache.put(key, new Response(JSON.stringify(cal), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` } }));
  return cal;
}

// Multi-symbol bars, paginated. Returns { SPY:[{t(ms),o,h,l,c,v}], ... }.
async function fetchBars(timeframe, start, headers) {
  const out = Object.fromEntries(ETFS.map(s => [s, []]));
  let token = null;
  for (let page = 0; page < 6; page++) {
    const qs = new URLSearchParams({
      symbols: ETFS.join(','), timeframe, start, limit: '10000', sort: 'asc', feed: 'iex', adjustment: 'split',
    });
    if (token) qs.set('page_token', token);
    const res = await fetch(`${ALPACA}/bars?${qs}`, { headers });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`${timeframe} bars: non-JSON response (HTTP ${res.status})`); }
    if (!res.ok) throw new Error(`${timeframe} bars: ${data.message || `HTTP ${res.status}`}`);
    for (const [sym, bars] of Object.entries(data.bars || {})) {
      if (!out[sym]) continue;
      for (const b of bars) out[sym].push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
    }
    token = data.next_page_token || null;
    if (!token) break;
  }
  return out;
}

async function fetchLatestTrades(headers) {
  const res = await fetch(`${ALPACA}/trades/latest?symbols=${ETFS.join(',')}&feed=iex`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const out = {};
  for (const [sym, t] of Object.entries(data.trades || {})) out[sym] = { p: t.p, t: Date.parse(t.t) };
  return out;
}

function json(data, ttl) {
  return new Response(JSON.stringify(data), {
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'Cache-Control': ttl > 0 ? `public, max-age=${ttl}` : 'no-store',
    },
  });
}
