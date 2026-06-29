// Fetch live bid/ask for a specific option contract via Polygon
// Query params: symbol (e.g. SPY), strike (e.g. 450), expiry (e.g. 2026-07-18), type (call|put)
export async function onRequest(context) {
  const { env, request } = context;
  const url    = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
  const strike = url.searchParams.get('strike');
  const expiry = url.searchParams.get('expiry'); // YYYY-MM-DD
  const ctype  = (url.searchParams.get('type') || 'call').toLowerCase();
  const KEY    = env.MASSIVE_API_KEY;

  if (!KEY)    return json({ error: 'No Polygon key configured' }, 503);
  if (!symbol || !strike || !expiry) return json({ error: 'Missing symbol, strike, or expiry' }, 400);

  // Build the Polygon option ticker: O:SPY260718C00450000
  const [yr, mo, dy] = expiry.split('-');
  const shortYr = yr.slice(2);
  const strikePadded = String(Math.round(parseFloat(strike) * 1000)).padStart(8, '0');
  const typeChar = ctype === 'put' ? 'P' : 'C';
  const optionTicker = `O:${symbol}${shortYr}${mo}${dy}${typeChar}${strikePadded}`;

  try {
    // Snapshot gives bid/ask/last/greeks in one call
    const res = await fetch(
      `https://api.polygon.io/v2/snapshot/locale/us/markets/options/${encodeURIComponent(optionTicker)}?apiKey=${KEY}`
    );
    const data = await res.json();

    if (!data.results) {
      const status = data.status || 'UNKNOWN';
      const msg = status === 'NOT_AUTHORIZED' ? 'Options data not authorized — check API key tier'
                : status === 'NOT_FOUND'      ? 'Contract not found — verify strike and expiry'
                : status === 'TOO_MANY_REQUESTS' ? 'Rate limit — try again shortly'
                : `No data returned (${status})`;
      return json({ error: msg, ticker: optionTicker, apiStatus: status }, 404);
    }

    const r   = data.results;
    const day = r.day || {};
    const q   = r.last_quote || {};
    const g   = r.greeks || {};
    const mkt = r.market_status || null; // 'open' | 'closed' | 'extended-hours'

    const bid  = q.bid  ?? day.close ?? null;
    const ask  = q.ask  ?? day.close ?? null;
    const mid  = (bid !== null && ask !== null) ? +((bid + ask) / 2).toFixed(2) : (day.close ?? null);
    const last = day.close ?? mid;

    return json({
      ticker: optionTicker,
      symbol, strike: parseFloat(strike), expiry, type: ctype,
      bid, ask, mid, last,
      volume:       day.volume ?? null,
      openInterest: r.open_interest ?? null,
      marketStatus: mkt,
      iv:           r.implied_volatility != null ? +(r.implied_volatility * 100).toFixed(1) : null,
      delta:        g.delta ?? null,
      gamma:        g.gamma ?? null,
      theta:        g.theta ?? null,
      vega:         g.vega  ?? null,
      change:       day.change ?? null,
      changePct:    day.change_percent ?? null,
    });

  } catch (e) {
    return json({ error: e.message, ticker: optionTicker }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
