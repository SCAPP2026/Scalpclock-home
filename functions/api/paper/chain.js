// GET /api/paper/chain?symbol=SPY[&expiry=YYYY-MM-DD] — option chain for the
// paper trading ticket: available expiries, plus calls/puts for one expiry
// limited to the strikes nearest the money. Quotes are CBOE delayed.
import { json, preflight, cleanSymbol, optionChain, stockQuotes, isExpired } from '../../lib/paper.js';

const STRIKES_EACH_SIDE = 12;

export async function onRequest(context) {
  const { env, request } = context;
  if (request.method === 'OPTIONS') return preflight();
  const url = new URL(request.url);
  const symbol = cleanSymbol(url.searchParams.get('symbol'));
  if (!symbol) return json({ error: 'Enter a valid ticker symbol' }, 400);

  const chain = await optionChain(symbol);
  if (!chain || !chain.contracts.length) return json({ error: `No options found for ${symbol}` }, 404);

  const live = (await stockQuotes(env, [symbol]))[symbol]?.price ?? null;
  const underlying = live ?? chain.underlying;

  const contracts = chain.contracts.filter(c => !isExpired(c.expiry));
  const expiries = [...new Set(contracts.map(c => c.expiry))].sort().slice(0, 40);
  const expiry = expiries.includes(url.searchParams.get('expiry')) ? url.searchParams.get('expiry') : expiries[0];

  const forExp = contracts.filter(c => c.expiry === expiry);
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

  return json({ symbol, underlying, expiry, expiries, rows, delayed: true },
    200, { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=30' });
}
