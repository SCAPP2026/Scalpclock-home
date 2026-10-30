// POST /api/paper/order — place a market order in the member's paper account.
// Body: { assetClass:'stock', symbol, side:'buy'|'sell', qty }
//    or { assetClass:'option', contract:'SPY261016C00580000', side, qty }
// The fill price is always looked up here from live quotes — the client
// never sends a price. Long-only: sells must close something already held.
import {
  json, preflight, verifyUser, rpc, cleanSymbol, parseOcc, stockQuotes,
  stockFillPrice, optionChain, marketIsOpen, isExpired,
} from '../../lib/paper.js';

const MAX_STOCK_QTY = 100000;
const MAX_OPTION_QTY = 500;

export async function onRequest(context) {
  const { env, request } = context;
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Paper trading is not configured yet' }, 500);

  const user = await verifyUser(request);
  if (!user) return json({ error: 'Sign in to use paper trading' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body' }, 400); }
  const side = body?.side;
  const qty = Number(body?.qty);
  if (side !== 'buy' && side !== 'sell') return json({ error: 'Side must be buy or sell' }, 400);
  if (!Number.isInteger(qty) || qty <= 0) return json({ error: 'Quantity must be a whole number above 0' }, 400);

  if (!marketIsOpen()) {
    return json({ error: 'The market is closed. Paper orders fill during regular hours (9:30 AM – 4:00 PM ET).' }, 400);
  }

  try {
    if (body.assetClass === 'stock') {
      const symbol = cleanSymbol(body.symbol);
      if (!symbol) return json({ error: 'Enter a valid ticker symbol' }, 400);
      if (qty > MAX_STOCK_QTY) return json({ error: `Max ${MAX_STOCK_QTY.toLocaleString()} shares per order` }, 400);
      const q = (await stockQuotes(env, [symbol]))[symbol];
      const price = stockFillPrice(q, side);
      if (!price) return json({ error: `No live quote for ${symbol} right now` }, 400);
      const result = await rpc(env, 'paper_execute', {
        p_user: user.id, p_asset_class: 'stock', p_symbol: symbol, p_underlying: symbol,
        p_option_type: null, p_strike: null, p_expiry: null,
        p_side: side, p_qty: qty, p_price: +price.toFixed(4),
      });
      return json({ ok: true, symbol, side, qty, price, ...result });
    }

    if (body.assetClass === 'option') {
      const p = parseOcc(body.contract);
      if (!p) return json({ error: 'Invalid option contract' }, 400);
      if (qty > MAX_OPTION_QTY) return json({ error: `Max ${MAX_OPTION_QTY} contracts per order` }, 400);
      if (isExpired(p.expiry)) return json({ error: 'That contract has expired' }, 400);
      const chain = await optionChain(p.underlying);
      const c = chain?.get(p.contract);
      if (!c) return json({ error: `No quote for ${p.contract} right now` }, 400);
      const price = side === 'buy' ? c.ask : c.bid;
      if (side === 'buy' && !(price > 0)) return json({ error: 'No ask price for that contract right now' }, 400);
      const result = await rpc(env, 'paper_execute', {
        p_user: user.id, p_asset_class: 'option', p_symbol: p.contract, p_underlying: p.underlying,
        p_option_type: p.type, p_strike: p.strike, p_expiry: p.expiry,
        p_side: side, p_qty: qty, p_price: price ?? 0,
      });
      return json({ ok: true, contract: p.contract, side, qty, price: price ?? 0, delayed: true, ...result });
    }

    return json({ error: 'assetClass must be stock or option' }, 400);
  } catch (e) {
    return json({ error: e.message || 'Order failed' }, 400);
  }
}
