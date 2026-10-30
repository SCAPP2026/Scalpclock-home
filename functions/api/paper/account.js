// GET /api/paper/account — the signed-in member's paper account: cash,
// positions marked to market, total equity, and recent fills. Creates the
// account ($25,000) on first visit, and settles any expired options at
// intrinsic value before returning.
import {
  json, preflight, verifyUser, rpc, select, stockQuotes, optionChain,
  optionMark, isExpired, intrinsic, marketIsOpen,
} from '../../lib/paper.js';

export async function onRequest(context) {
  const { env, request } = context;
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Paper trading is not configured yet' }, 500);

  const user = await verifyUser(request);
  if (!user) return json({ error: 'Sign in to use paper trading' }, 401);

  try {
    let account = await rpc(env, 'paper_ensure_account', { p_user: user.id });
    let positions = await select(env, 'paper_positions', `user_id=eq.${user.id}&order=opened_at.asc`);

    // Live quotes for every stock and every option underlying held.
    const stockSyms = positions.map(p => p.underlying);
    const quotes = await stockQuotes(env, stockSyms);
    const chains = {};
    for (const u of new Set(positions.filter(p => p.asset_class === 'option').map(p => p.underlying))) {
      chains[u] = await optionChain(u);
    }

    // Settle expired options at intrinsic value off the underlying's price.
    let settled = 0;
    for (const p of positions) {
      if (p.asset_class !== 'option' || !isExpired(p.expiry)) continue;
      const under = quotes[p.underlying]?.price ?? chains[p.underlying]?.underlying ?? null;
      const value = +intrinsic(p.option_type, Number(p.strike), under).toFixed(2);
      await rpc(env, 'paper_execute', {
        p_user: user.id, p_asset_class: 'option', p_symbol: p.symbol, p_underlying: p.underlying,
        p_option_type: p.option_type, p_strike: p.strike, p_expiry: p.expiry,
        p_side: 'sell', p_qty: p.qty, p_price: value,
        p_note: value > 0 ? `Expired in the money — settled at intrinsic $${value}` : 'Expired worthless',
      });
      settled++;
    }
    if (settled) {
      account = await rpc(env, 'paper_ensure_account', { p_user: user.id });
      positions = await select(env, 'paper_positions', `user_id=eq.${user.id}&order=opened_at.asc`);
    }

    let marketValue = 0;
    const marked = positions.map(p => {
      const qty = Number(p.qty), cost = Number(p.avg_cost);
      const mult = p.asset_class === 'option' ? 100 : 1;
      let mark = null;
      if (p.asset_class === 'stock') {
        mark = quotes[p.symbol]?.price ?? null;
      } else {
        mark = optionMark(chains[p.underlying]?.get(p.symbol));
      }
      const value = mark != null ? mark * qty * mult : cost * qty * mult;
      marketValue += value;
      return {
        symbol: p.symbol, assetClass: p.asset_class, underlying: p.underlying,
        optionType: p.option_type, strike: p.strike != null ? Number(p.strike) : null, expiry: p.expiry,
        qty, avgCost: cost, mark,
        marketValue: +value.toFixed(2),
        unrealizedPnl: mark != null ? +((mark - cost) * qty * mult).toFixed(2) : null,
        underlyingPrice: quotes[p.underlying]?.price ?? null,
      };
    });

    const fills = await select(env, 'paper_fills',
      `user_id=eq.${user.id}&order=created_at.desc&limit=50&select=symbol,asset_class,underlying,option_type,strike,expiry,side,qty,price,notional,realized_pnl,note,created_at`);
    const realized = await select(env, 'paper_fills', `user_id=eq.${user.id}&side=eq.sell&select=realized_pnl`);

    const cash = Number(account.cash);
    const startingCash = Number(account.starting_cash);
    const equity = cash + marketValue;
    return json({
      cash: +cash.toFixed(2),
      startingCash,
      equity: +equity.toFixed(2),
      totalPnl: +(equity - startingCash).toFixed(2),
      realizedPnl: +realized.reduce((s, f) => s + Number(f.realized_pnl || 0), 0).toFixed(2),
      positions: marked,
      fills,
      settled,
      marketOpen: marketIsOpen(),
    });
  } catch (e) {
    return json({ error: e.message || 'Could not load your paper account' }, 400);
  }
}
