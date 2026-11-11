// 5-Day Level Map — support and resistance from the last five completed
// sessions, for the Market Intelligence Center and ScalpCharts.
//
//   GET /api/market-levels                 → SPY, QQQ, IWM
//   GET /api/market-levels?symbols=AAPL    → up to 3 tickers
//
// The map only changes when a session closes, so it is built once per
// completed session and kept in the edge cache (keyed on that session's
// date — it rebuilds itself automatically after each close). The live price
// is placed on it per request, so support/resistance roles and distances
// stay current through the day.
//
// Data: Alpaca IEX 5-minute bars. No fallback numbers: a symbol that cannot
// be built comes back as { ok:false, error }.
import { marketSession, isTradingDay, prevTradingDay } from '../lib/market-intel.js';
import { build5DayMap, applyPrice } from '../lib/levels-5day.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const ALPACA = 'https://data.alpaca.markets/v2/stocks';
const DAY = 24 * 3600 * 1000;
const SYM_RE = /^[A-Z]{1,5}(\.[A-Z])?$/;
const MAP_VERSION = 1;

/** The most recent session that has closed — the map's cache key. */
export function lastCompletedSession(nowMs) {
  const s = marketSession(nowMs);
  return (isTradingDay(s.etDate) && s.regularOver) ? s.etDate : prevTradingDay(s.etDate);
}

export async function onRequest(context) {
  const { env, request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: CORS });

  const url = new URL(request.url);
  const symbols = [...new Set((url.searchParams.get('symbols') || 'SPY,QQQ,IWM')
    .toUpperCase().split(',').map(s => s.trim()).filter(Boolean))].slice(0, 3);
  if (!symbols.length || symbols.some(s => !SYM_RE.test(s))) return json({ ok: false, error: 'Invalid symbols.' }, 0, 400);

  const nowMs = Date.now();
  const session = marketSession(nowMs);
  const asOfSession = lastCompletedSession(nowMs);
  // Whole response (map + live price) is shared briefly across viewers.
  const ttl = session.state === 'closed' ? 300 : 20;
  const cache = caches.default;
  const respKey = new Request(new URL(`/api/market-levels?symbols=${symbols.join(',')}&v=${MAP_VERSION}`, url).toString());
  const hit = await cache.match(respKey);
  if (hit) return hit;

  if (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET) return json({ ok: false, error: 'Market data provider is not configured.' }, 0);
  const headers = { 'APCA-API-KEY-ID': env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET };

  // 1. Maps: from the day cache, building any that are missing.
  const maps = {};
  const missing = [];
  await Promise.all(symbols.map(async sym => {
    const k = mapKey(url, sym, asOfSession);
    const m = await cache.match(k);
    if (m) maps[sym] = await m.json(); else missing.push(sym);
  }));
  if (missing.length) {
    let bars;
    try { bars = await fetchBars(missing, new Date(nowMs - 16 * DAY).toISOString(), headers); }
    catch (e) { return json({ ok: false, error: `Market data provider error: ${e.message}` }, 0); }
    for (const sym of missing) {
      const map = build5DayMap({ symbol: sym, bars: bars[sym] || [], nowMs });
      maps[sym] = map;
      // Only good maps are pinned for the day; a failure retries on the next request.
      if (map.ok) context.waitUntil(cache.put(mapKey(url, sym, asOfSession), new Response(JSON.stringify(map), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
      })));
    }
  }

  // 2. Live price on top.
  const trades = await fetchLatestTrades(symbols, headers).catch(() => ({}));
  const out = symbols.map(sym => {
    const m = maps[sym];
    if (!m || !m.ok) return m || { symbol: sym, ok: false, error: 'No data.' };
    const t = trades[sym];
    // Only trust a trade printed after the map's last session (otherwise it is the same close).
    const live = t && t.t > Date.parse(m.window.to + 'T20:00:00Z') ? t : null;
    return applyPrice(m, live ? live.p : null, live ? live.t : null);
  });

  const body = {
    ok: out.some(x => x.ok), asOf: new Date(nowMs).toISOString(), session, asOfSession,
    nextRebuild: 'After the next regular-session close (4:00 PM ET).',
    feed: 'IEX',
    note: 'Built from Alpaca IEX 5-minute bars, regular session (9:30–4:00 ET) only. IEX is one exchange: prices are real trades, volume is an IEX slice, so the volume profile shows where IEX volume traded.',
    symbols: out,
  };
  const res = json(body, ttl);
  if (body.ok) context.waitUntil(cache.put(respKey, res.clone()));
  return res;
}

function mapKey(url, sym, date) {
  return new Request(new URL(`/api/__levels5?sym=${sym}&d=${date}&v=${MAP_VERSION}`, url).toString());
}

async function fetchBars(symbols, start, headers) {
  const out = Object.fromEntries(symbols.map(s => [s, []]));
  let token = null;
  for (let page = 0; page < 6; page++) {
    const qs = new URLSearchParams({ symbols: symbols.join(','), timeframe: '5Min', start, limit: '10000', sort: 'asc', feed: 'iex', adjustment: 'split' });
    if (token) qs.set('page_token', token);
    const res = await fetch(`${ALPACA}/bars?${qs}`, { headers });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`non-JSON response (HTTP ${res.status})`); }
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    for (const [sym, bars] of Object.entries(data.bars || {})) {
      if (!out[sym]) continue;
      for (const b of bars) out[sym].push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
    }
    token = data.next_page_token || null;
    if (!token) break;
  }
  return out;
}

async function fetchLatestTrades(symbols, headers) {
  const res = await fetch(`${ALPACA}/trades/latest?symbols=${symbols.join(',')}&feed=iex`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const out = {};
  for (const [sym, t] of Object.entries(data.trades || {})) out[sym] = { p: t.p, t: Date.parse(t.t) };
  return out;
}

function json(data, ttl, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': ttl > 0 ? `public, max-age=${ttl}` : 'no-store' },
  });
}
