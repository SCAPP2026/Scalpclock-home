// Fetch live bid/ask for a specific option contract via Polygon
// Query params: symbol (e.g. SPY), strike (e.g. 450), expiry (e.g. 2026-07-18), type (call|put)
export async function onRequest(context) {
  const { env, request } = context;
  const url    = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
  const strike = url.searchParams.get('strike');
  const expiry = url.searchParams.get('expiry'); // YYYY-MM-DD
  const ctype  = (url.searchParams.get('type') || 'call').toLowerCase();
  const KEY    = env.POLYGON_KEY;

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

    if (data.status === 'NOT_FOUND' || !data.results) {
      return json({ error: 'Contract not found', ticker: optionTicker }, 404);
    }

    const r   = data.results;
    const day = r.day || {};
    const q   = r.last_quote || {};
    const g   = r.greeks || {};

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
