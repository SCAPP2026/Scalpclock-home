// GET /api/paper/chain?symbol=SPY[&expiry=YYYY-MM-DD] — option chain for the
// paper trading ticket: available expiries, plus calls/puts for one expiry
// limited to the strikes nearest the money. Quotes are CBOE delayed.
import { json, preflight, cleanSymbol, optionChain, stockQuotes, isExpired } from '../../lib/paper.js';

const STRIKES_EACH_SIDE = 12;
// Records to load either side of the money: calls + puts, with a little slack.
const RECORDS_EACH_SIDE = 2 * (STRIKES_EACH_SIDE + 2);

export async function onRequest(context) {
  const { env, request } = context;
  if (request.method === 'OPTIONS') return preflight();
  const url = new URL(request.url);
  const symbol = cleanSymbol(url.searchParams.get('symbol'));
  if (!symbol) return json({ error: 'Enter a valid ticker symbol' }, 400);

  // Same answer for everyone for 30s — serve repeats from the edge cache.
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(`${url.origin}/api/paper/chain?symbol=${symbol}&expiry=${url.searchParams.get('expiry') || ''}`);
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }

  const chain = await optionChain(symbol);
  const expiries = (chain?.expiries() || []).filter(e => !isExpired(e)).slice(0, 40);
  if (!expiries.length) return json({ error: `No options found for ${symbol}` }, 404);

  const live = (await stockQuotes(env, [symbol]))[symbol]?.price ?? null;
  const underlying = live ?? chain.underlying;

  const expiry = expiries.includes(url.searchParams.get('expiry')) ? url.searchParams.get('expiry') : expiries[0];

  const forExp = chain.near(expiry, underlying, RECORDS_EACH_SIDE);
  const strikes = [...new Set(forExp.map(c => c.strike))].sort((a, b) => a - b);
  let atm = 0;
  if (underlying != null) {
    atm = strikes.reduce((best, s, i) => Math.abs(s - underlying) < Math.abs(strikes[best] - underlying) ? i : best, 0);
  }
  const near = strikes.slice(Math.max(0, atm - STRIKES_EACH_SIDE), atm + STRIKES_EACH_SIDE + 1);

  const pick = (type, strike) => {
    const c = forExp.find(x => x.type === type && x.strike === strike);
    return c ? { contract: c.contract, bid: c.bid, ask: c.ask, last: c.last, iv: c.iv, delta: c.delta, volume: c.volume, openInterest: c.openInterest } : null;
  };
  const rows = near.map(strike => ({ strike, call: pick('call', strike), put: pick('put', strike) }));

  const res = json({ symbol, underlying, expiry, expiries, rows, delayed: true },
    200, { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=30' });
  if (cache) context.waitUntil?.(cache.put(cacheKey, res.clone()).catch(() => {}));
  return res;
}
