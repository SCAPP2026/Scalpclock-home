// Pre-market / extended-hours summary for ScalpCharts.
//
//   GET /api/premarket?symbol=SPY
//
// Previous close, after-hours, today's pre-market range (high/low/last/VWAP/
// volume), the gap, and — once the bell rings — gap-fill and pre-market
// high/low breaks. Built from Alpaca IEX 1-minute bars + the latest IEX trade.
// No fallback numbers: provider errors come back as { ok:false, error }.
import { marketSession, prevTradingDay } from '../lib/market-intel.js';
import { summarizePremarket } from '../lib/premarket.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const ALPACA = 'https://data.alpaca.markets/v2/stocks';
const SYM_RE = /^[A-Z]{1,5}(\.[A-Z])?$/;

export async function onRequest(context) {
  const { env, request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || 'SPY').toUpperCase().trim();
  if (!SYM_RE.test(symbol)) return json({ ok: false, error: 'Invalid symbol.' }, 0, 400);

  const nowMs = Date.now();
  const session = marketSession(nowMs);
  const ttl = session.state === 'closed' ? 300 : 20;
  const cache = caches.default;
  const key = new Request(new URL(`/api/premarket?symbol=${symbol}&v=1`, url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  if (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET) return json({ ok: false, error: 'Market data provider is not configured.' }, 0);
  const headers = { 'APCA-API-KEY-ID': env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET };
  // From mid-afternoon of the previous session: covers its close, after-hours and today.
  const prev = prevTradingDay(session.refDate);
  const start = `${prev}T18:00:00Z`;

  let bars, trade = null;
  try {
    [bars, trade] = await Promise.all([
      fetchBars(symbol, start, headers),
      fetchLatestTrade(symbol, headers).catch(() => null),
    ]);
  } catch (e) {
    return json({ ok: false, error: `Market data provider error: ${e.message}` }, 0);
  }
  const body = { ...summarizePremarket({ symbol, bars, nowMs, trade }), asOf: new Date(nowMs).toISOString() };
  const res = json(body, ttl);
  context.waitUntil(cache.put(key, res.clone()));
  return res;
}

async function fetchBars(symbol, start, headers) {
  const out = [];
  let token = null;
  for (let page = 0; page < 4; page++) {
    const qs = new URLSearchParams({ timeframe: '1Min', start, limit: '10000', sort: 'asc', feed: 'iex', adjustment: 'split' });
    if (token) qs.set('page_token', token);
    const res = await fetch(`${ALPACA}/${encodeURIComponent(symbol)}/bars?${qs}`, { headers });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`non-JSON response (HTTP ${res.status})`); }
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    for (const b of data.bars || []) out.push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
    token = data.next_page_token || null;
    if (!token) break;
  }
  return out;
}

async function fetchLatestTrade(symbol, headers) {
  const res = await fetch(`${ALPACA}/${encodeURIComponent(symbol)}/trades/latest?feed=iex`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  return d.trade ? { p: d.trade.p, t: Date.parse(d.trade.t) } : null;
}

function json(data, ttl, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': ttl > 0 ? `public, max-age=${ttl}` : 'no-store' },
  });
}
