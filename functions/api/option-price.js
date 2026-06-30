// Fetch live options data from CBOE delayed quotes (no API key required)
// Query params: symbol (e.g. SPY), strike (e.g. 744), expiry (YYYY-MM-DD), type (call|put)
// Returns: bid, ask, mid, greeks (delta/gamma/theta/vega), iv, oi, market status
export async function onRequest(context) {
  const { request } = context;
  const url    = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
  const strike = parseFloat(url.searchParams.get('strike'));
  const expiry = url.searchParams.get('expiry'); // YYYY-MM-DD
  const ctype  = (url.searchParams.get('type') || 'call').toLowerCase();

  if (!symbol || !strike || !expiry) {
    return json({ error: 'Missing symbol, strike, or expiry' }, 400);
  }

  const [yr, mo, dy] = expiry.split('-');
  const shortYr     = yr.slice(2);
  const typeChar    = ctype === 'put' ? 'P' : 'C';
  // OCC option ticker (CBOE format, no O: prefix): e.g. SPY260717P00744000
  const strikePadded = String(Math.round(strike * 1000)).padStart(8, '0');
  const targetTicker = `${symbol}${shortYr}${mo}${dy}${typeChar}${strikePadded}`;

  // Fetch full options chain from CBOE CDN (15–20 min delayed, free)
  let raw;
  try {
    const res = await fetch(
      `https://cdn.cboe.com/api/global/delayed_quotes/options/${symbol}.json`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScalpClock/1.0)' } }
    );
    if (!res.ok) {
      return json({ error: `CBOE returned HTTP ${res.status} for ${symbol}`, ticker: targetTicker }, 502);
    }
    raw = await res.json();
  } catch (e) {
    return json({ error: `CBOE fetch failed: ${e.message}`, ticker: targetTicker }, 502);
  }

  const chainData  = raw?.data;
  const underlying = chainData?.current_price ?? null;
  const opts       = chainData?.options ?? [];

  if (!opts.length) {
    return json({ error: `No options chain found for ${symbol}`, ticker: targetTicker }, 404);
  }

  // 1. Try exact match first
  let match = opts.find(o => o.option === targetTicker);

  // 2. Fall back to nearest strike on same expiry + type
  if (!match) {
    const prefix = `${symbol}${shortYr}${mo}${dy}${typeChar}`;
    const candidates = opts.filter(o => o.option.startsWith(prefix));

    if (!candidates.length) {
      // Find what expiries are actually available and suggest the nearest
      const expiryKey  = `${shortYr}${mo}${dy}`;
      const typePrefix = `${symbol}`;
      const available  = [...new Set(
        opts
          .filter(o => o.option.startsWith(typePrefix) && o.option[symbol.length + 6] === typeChar)
          .map(o => o.option.slice(symbol.length, symbol.length + 6))
      )].sort();
      const nearestExp = available.reduce((best, e) =>
        Math.abs(parseInt(e) - parseInt(expiryKey)) < Math.abs(parseInt(best) - parseInt(expiryKey)) ? e : best,
        available[0] || expiryKey
      );
      return json({
        error: `No ${ctype} options found for ${symbol} expiring ${expiry}`,
        ticker: targetTicker,
        suggestion: nearestExp
          ? `Try expiry 20${nearestExp.slice(0,2)}-${nearestExp.slice(2,4)}-${nearestExp.slice(4,6)}`
          : 'Check expiry date — options expire on weekdays only',
        availableExpiries: available.slice(0, 10).map(e =>
          `20${e.slice(0,2)}-${e.slice(2,4)}-${e.slice(4,6)}`
        ),
      }, 404);
    }

    match = candidates.reduce((best, o) => {
      const s    = parseInt(o.option.slice(-8)) / 1000;
      const bStr = parseInt(best.option.slice(-8)) / 1000;
      return Math.abs(s - strike) < Math.abs(bStr - strike) ? o : best;
    });
  }

  // Bid/ask/mid
  const bid  = match.bid  ?? null;
  const ask  = match.ask  ?? null;
  const mid  = (bid !== null && ask !== null) ? +((bid + ask) / 2).toFixed(2) : null;
  const last = match.last_trade_price ?? mid;

  // Market status — infer from how stale the last trade is
  const lastTradeAt = match.last_trade_time ? new Date(match.last_trade_time) : null;
  const msSinceTrade = lastTradeAt ? Date.now() - lastTradeAt.getTime() : Infinity;
  const marketStatus = msSinceTrade < 12 * 60 * 1000 ? 'open' : 'closed';

  // Matched strike (may differ from requested if we found nearest)
  const matchedStrike = parseInt(match.option.slice(-8)) / 1000;

  return json({
    ticker: `O:${targetTicker}`,
    matchedTicker: match.option,
    symbol,
    strike:        matchedStrike,
    requestedStrike: strike,
    expiry, type: ctype,
    bid, ask, mid, last,
    volume:        match.volume        ?? null,
    openInterest:  match.open_interest ?? null,
    marketStatus,
    iv:    match.iv    != null ? +(match.iv * 100).toFixed(2) : null, // convert to %
    delta: match.delta ?? null,
    gamma: match.gamma ?? null,
    theta: match.theta ?? null,
    vega:  match.vega  ?? null,
    change:    match.change          ?? null,
    changePct: match.percent_change  ?? null,
    underlying,    // live underlying price from CBOE
    source: 'cboe-delayed',
    dataAge: lastTradeAt ? Math.round(msSinceTrade / 60000) + 'min' : null,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
    },
  });
}
