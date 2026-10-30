// Shared helpers for /api/paper/* — the members' paper trading account.
//
// Every fill is priced HERE, server-side, from live quotes; the client only
// says what and how much. Stocks fill against Alpaca's IEX quote (buy at the
// ask, sell at the bid). Options fill against CBOE's free delayed chain —
// ~15-20 min delayed, the same source /api/option-price uses, because the
// configured Alpaca/Polygon keys have no options entitlement. The page tells
// members options quotes are delayed.
//
// Writes go through the paper_* Postgres functions (supabase/
// paper_trading_setup.sql) with the service role, so cash + position updates
// are one atomic transaction. Members can only SELECT their own rows.
import { etParts, marketSession } from './market-intel.js';

export const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';
// Public anon key — same one already shipped client-side across the site.
// Used only as the `apikey` header on the /auth/v1/user verification call.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZudXF4aWZscXFlamp0dHh5bWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzMxODksImV4cCI6MjA5ODAwOTE4OX0.XE1-LPW0043gRFEAl9onCahkmpQ8BMAAtGkF9FqJLiY';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS });
}

// Returns the Supabase user for a valid Bearer token, else null.
export async function verifyUser(request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.id ? u : null;
}

function serviceHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Calls a paper_* Postgres function. Throws an Error carrying the database's
// own message (e.g. "Not enough buying power ...") so the page can show it.
export async function rpc(env, fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: serviceHeaders(env), body: JSON.stringify(args),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error(body?.message || `${fn} failed`);
    err.code = body?.code;
    throw err;
  }
  return body;
}

export async function select(env, table, query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: serviceHeaders(env) });
  if (!r.ok) throw new Error(`Could not read ${table}`);
  return r.json();
}

// True only during the regular session (9:30-4:00 ET, holiday/early-close aware).
export function marketIsOpen(nowMs = Date.now()) {
  return marketSession(nowMs).state === 'regular';
}

const SYMBOL_RE = /^[A-Z]{1,5}(\.[A-Z])?$/;
export function cleanSymbol(s) {
  const sym = String(s || '').trim().toUpperCase();
  return SYMBOL_RE.test(sym) ? sym : null;
}

// OCC contract symbol as CBOE formats it (no "O:" prefix):
// SPY261016C00580000 -> { underlying, expiry, type, strike }
const OCC_RE = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
export function parseOcc(contract) {
  const m = OCC_RE.exec(String(contract || '').trim().toUpperCase());
  if (!m) return null;
  return {
    contract: m[0],
    underlying: m[1],
    expiry: `20${m[2]}-${m[3]}-${m[4]}`,
    type: m[5] === 'C' ? 'call' : 'put',
    strike: parseInt(m[6], 10) / 1000,
  };
}

// Has this option stopped trading? True once its expiry date is past in ET,
// or on expiry day after the regular session has ended.
export function isExpired(expiry, nowMs = Date.now()) {
  const et = etParts(nowMs);
  if (expiry < et.date) return true;
  if (expiry > et.date) return false;
  const state = marketSession(nowMs).state;
  return (state === 'afterhours' || state === 'closed') && et.minutes >= 12 * 60;
}

function alpacaHeaders(env) {
  return { 'APCA-API-KEY-ID': env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET };
}

// { SYM: { price, bid, ask } } from Alpaca IEX snapshots, one request.
export async function stockQuotes(env, symbols) {
  const out = {};
  const list = [...new Set(symbols)].filter(Boolean);
  if (!list.length) return out;
  const r = await fetch(
    `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${encodeURIComponent(list.join(','))}&feed=iex`,
    { headers: alpacaHeaders(env) },
  );
  if (!r.ok) return out;
  const data = await r.json();
  for (const [sym, snap] of Object.entries(data || {})) {
    const price = snap?.latestTrade?.p ?? snap?.dailyBar?.c ?? null;
    const bid = snap?.latestQuote?.bp || null;
    const ask = snap?.latestQuote?.ap || null;
    const prevClose = snap?.prevDailyBar?.c ?? null;
    out[sym] = { price, bid, ask, prevClose };
  }
  return out;
}

// Price a stock fill. IEX quotes can be empty or absurdly wide (IEX is a
// small slice of volume), so fall back to the last trade when the quote is
// missing or the spread is more than 1% of price.
export function stockFillPrice(q, side) {
  if (!q?.price) return null;
  const { price, bid, ask } = q;
  const quoteOk = bid && ask && ask >= bid && (ask - bid) / price <= 0.01;
  if (!quoteOk) return price;
  return side === 'buy' ? ask : bid;
}

// CBOE delayed chain for one underlying. Returns a view over the raw file:
//   underlying          — price CBOE reports, or null
//   expiries()          — sorted expiry dates (YYYY-MM-DD)
//   near(expiry, price, n) — about n contracts either side of `price` for one expiry
//   get(contract)       — one contract, or null
// Contracts look like {contract, expiry, type, strike, bid, ask, last, iv, delta, volume, openInterest}.
//
// The file is 1.5–6 MB for busy tickers (SPY, TSLA, AAPL), and parsing all of
// it blows the Worker CPU limit (Cloudflare error 1102). CBOE sorts records by
// expiry, then strike, so we binary-search the raw text and only parse the
// records a request needs. If the file isn't in that order we fall back to a
// single scan of every contract symbol.
export async function optionChain(symbol) {
  const r = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${symbol}.json`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScalpClock/1.0)' },
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!r.ok) return null;
  const text = await r.text().catch(() => '');
  return chainView(text, symbol);
}

const KEY = '"option"';

// The record whose "option" key is at or after `pos`: key offset, end of the
// contract string, and the contract symbol.
function recordAt(text, pos) {
  const i = text.indexOf(KEY, pos);
  if (i === -1) return null;
  const q1 = text.indexOf('"', i + KEY.length);
  const q2 = q1 === -1 ? -1 : text.indexOf('"', q1 + 1);
  if (q2 === -1) return null;
  return { i, end: q2 + 1, contract: text.slice(q1 + 1, q2) };
}

// Offset `lo` such that the first record at/after `lo` is the first one in
// [lo, hi) where after(parsedContract) is true. `after` must be monotone over
// the file's order.
function firstWhere(text, lo, hi, after) {
  while (lo < hi) {
    const mid = lo + ((hi - lo) >>> 1);
    const r = recordAt(text, mid);
    if (!r || r.i >= hi || after(parseOcc(r.contract))) hi = mid;
    else lo = r.end;
  }
  return lo;
}

function recordToContract(text, keyPos, symbol) {
  // Records are flat objects, so the nearest braces bound the record.
  const start = text.lastIndexOf('{', keyPos);
  const end = text.indexOf('}', keyPos);
  if (start === -1 || end === -1) return null;
  let o;
  try { o = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  const p = parseOcc(o.option);
  if (!p || p.underlying !== symbol) return null;
  return {
    contract: p.contract, expiry: p.expiry, type: p.type, strike: p.strike,
    bid: o.bid ?? null, ask: o.ask ?? null, last: o.last_trade_price ?? null,
    iv: o.iv ?? null, delta: o.delta ?? null,
    volume: o.volume ?? 0, openInterest: o.open_interest ?? 0,
  };
}

export function chainView(text, symbol) {
  const priceAt = text.lastIndexOf('"current_price"');
  const m = priceAt === -1 ? null : /^"current_price"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(text.slice(priceAt, priceAt + 48));
  const underlying = m ? Number(m[1]) : null;

  // One {expiry, start, end} per expiry, found by binary search. null if the
  // file isn't grouped by expiry the way we expect.
  let blocks;
  function getBlocks() {
    if (blocks !== undefined) return blocks;
    const out = [];
    let r = recordAt(text, 0);
    while (r) {
      const p = parseOcc(r.contract);
      if (!p || p.underlying !== symbol || (out.length && p.expiry <= out[out.length - 1].expiry)) return (blocks = null);
      const end = firstWhere(text, r.end, text.length, q => !q || q.expiry > p.expiry);
      out.push({ expiry: p.expiry, start: r.i, end });
      r = recordAt(text, end);
    }
    return (blocks = out);
  }

  // Fallback: every record's symbol and offset, in one pass.
  let index;
  function getIndex() {
    if (index) return index;
    index = [];
    let r = recordAt(text, 0);
    while (r) {
      const p = parseOcc(r.contract);
      if (p && p.underlying === symbol) index.push({ ...p, at: r.i });
      r = recordAt(text, r.end);
    }
    return index;
  }

  function expiries() {
    const b = getBlocks();
    if (b) return b.map(x => x.expiry);
    return [...new Set(getIndex().map(x => x.expiry))].sort();
  }

  function near(expiry, price, n) {
    const b = getBlocks();
    let positions = [];
    if (b) {
      const blk = b.find(x => x.expiry === expiry);
      if (!blk) return [];
      const p = price == null ? blk.start
        : firstWhere(text, blk.start, blk.end, q => !q || q.expiry > expiry || q.strike >= price);
      for (let q = p, k = 0; k < n; k++) {
        q = text.lastIndexOf(KEY, q - 1);
        if (q < blk.start) break;
        positions.unshift(q);
      }
      for (let r = recordAt(text, p), k = 0; r && r.i < blk.end && k < n; k++, r = recordAt(text, r.end)) {
        positions.push(r.i);
      }
    } else {
      const rows = getIndex().filter(x => x.expiry === expiry).sort((a, c) => a.strike - c.strike);
      let atm = rows.findIndex(x => price != null && x.strike >= price);
      if (atm === -1) atm = price == null ? 0 : rows.length;
      positions = rows.slice(Math.max(0, atm - n), atm + n).map(x => x.at);
    }
    return positions.map(pos => recordToContract(text, pos, symbol)).filter(Boolean);
  }

  const cache = new Map();
  function get(contract) {
    if (cache.has(contract)) return cache.get(contract);
    const k = text.indexOf(`"${contract}"`);
    const keyPos = k === -1 ? -1 : text.lastIndexOf(KEY, k);
    const out = keyPos === -1 ? null : recordToContract(text, keyPos, symbol);
    const hit = out && out.contract === contract ? out : null;
    cache.set(contract, hit);
    return hit;
  }

  return { underlying, expiries, near, get };
}

export function optionMark(c) {
  if (!c) return null;
  if (c.bid != null && c.ask != null && c.ask > 0) return +((c.bid + c.ask) / 2).toFixed(2);
  return c.last ?? null;
}

export function intrinsic(type, strike, underlyingPrice) {
  if (underlyingPrice == null) return 0;
  return Math.max(0, type === 'call' ? underlyingPrice - strike : strike - underlyingPrice);
}
