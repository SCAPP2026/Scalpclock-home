// Options chain stats — sourced from CBOE's free delayed-quotes chain
// (no API key, ~15-20min delayed). Previously used Polygon's options
// snapshot, but that requires a paid entitlement the configured key
// doesn't have (403 NOT_AUTHORIZED for every symbol). CBOE's chain is
// the same free source already used successfully by /api/option-price.
export async function onRequest(context) {
  const { request } = context;
  const url    = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || 'SPY').toUpperCase().replace(/[^A-Z]/g, '');

  if (!symbol) return json({ error: 'symbol required' }, 400);

  try {
    const res = await fetch(
      `https://cdn.cboe.com/api/global/delayed_quotes/options/${symbol}.json`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScalpClock/1.0)' } }
    );
    if (!res.ok) return json({ symbol, noData: true }, 200);

    const raw       = await res.json();
    const underlying = raw?.data?.current_price ?? null;
    const rawOpts    = raw?.data?.options ?? [];
    if (!rawOpts.length) return json({ symbol, noData: true }, 200);

    const parsed = rawOpts.map(o => parseContract(o, symbol)).filter(Boolean);
    if (!parsed.length) return json({ symbol, noData: true }, 200);

    const now      = new Date();
    const inTwoWks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    // Near-term contracts only
    let opts = parsed.filter(o => o.expiryDate >= now && o.expiryDate <= inTwoWks);
    if (opts.length < 10) opts = parsed.slice(0, 100);

    const calls = opts.filter(o => o.type === 'call');
    const puts  = opts.filter(o => o.type === 'put');

    // Volumes & OI
    const callVol = calls.reduce((s, o) => s + (o.volume || 0), 0);
    const putVol  = puts.reduce((s,  o) => s + (o.volume || 0), 0);
    const callOI  = calls.reduce((s, o) => s + (o.openInterest || 0), 0);
    const putOI   = puts.reduce((s,  o) => s + (o.openInterest || 0), 0);
    const pcRatio = callVol > 0 ? +(putVol / callVol).toFixed(2) : null;

    // ATM greeks — options closest to the live underlying price
    const midStrike = underlying || medianOf(opts.map(o => o.strike));

    const withGreeks = opts
      .map(o => ({ ...o, dist: Math.abs(o.strike - midStrike) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 8);

    function avg(arr) {
      const vals = arr.filter(v => v !== null && v !== undefined && v !== 0);
      return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
    }

    const atmCalls = withGreeks.filter(o => o.type === 'call');
    const greeks = {
      delta: fmt(avg(atmCalls.map(o => o.delta)), 3),
      gamma: fmt(avg(withGreeks.map(o => o.gamma)), 4),
      theta: fmt(avg(withGreeks.map(o => o.theta)), 3),
      vega:  fmt(avg(withGreeks.map(o => o.vega)),  3),
    };

    // IV stats (CBOE reports iv as a decimal, e.g. 0.29 = 29%; 0 means no quote)
    const ivs = opts.map(o => o.iv).filter(v => v);
    ivs.sort((a,b)=>a-b);
    const avgIV = avg(ivs);
    const medIV = ivs[Math.floor(ivs.length/2)];
    const ivPct = avgIV ? +(avgIV * 100).toFixed(1) : null;

    const minIV = ivs[0], maxIV = ivs[ivs.length-1];
    const ivRank = (avgIV && maxIV !== minIV)
      ? Math.round(((avgIV - minIV) / (maxIV - minIV)) * 100) : null;

    const ivCrushWarning = avgIV && medIV && avgIV > medIV * 1.35;

    // Unusual flow: day volume ≥ 1.8x open interest and volume > 50
    const unusual = opts
      .filter(o => (o.volume || 0) > 50 && (o.openInterest || 0) > 0 && o.volume / o.openInterest >= 1.8)
      .map(o => ({
        type:   o.type,
        strike: o.strike,
        expiry: o.expiry,
        volume: o.volume,
        oi:     o.openInterest,
        ratio:  +(o.volume / o.openInterest).toFixed(1),
        iv:     o.iv ? +(o.iv * 100).toFixed(1) : null,
      }))
      .sort((a,b) => b.ratio - a.ratio)
      .slice(0, 6);

    return json({
      symbol,
      greeks,
      iv: ivPct,
      ivRank,
      ivCrushWarning: !!ivCrushWarning,
      callVolume: callVol,
      putVolume:  putVol,
      callOI, putOI, pcRatio,
      unusualFlow: unusual,
      midStrike,
      contractsScanned: opts.length,
      source: 'cboe-delayed',
    });

  } catch (e) {
    return json({ error: e.message, symbol }, 500);
  }
}

// CBOE option tickers are OCC-style: {SYMBOL}{YYMMDD}{C|P}{strike*1000, 8 digits}
function parseContract(o, symbol) {
  const rest = o.option?.slice(symbol.length);
  if (!rest || rest.length < 15) return null;

  const yy = rest.slice(0, 2), mm = rest.slice(2, 4), dd = rest.slice(4, 6);
  const typeChar = rest[6];
  const strike   = parseInt(rest.slice(7), 10) / 1000;
  if (!['C', 'P'].includes(typeChar) || Number.isNaN(strike)) return null;

  const expiry     = `20${yy}-${mm}-${dd}`;
  const expiryDate = new Date(expiry);

  return {
    type: typeChar === 'C' ? 'call' : 'put',
    strike, expiry, expiryDate,
    volume:       o.volume        ?? 0,
    openInterest: o.open_interest ?? 0,
    iv:           o.iv            ?? null,
    delta:        o.delta         ?? null,
    gamma:        o.gamma         ?? null,
    theta:        o.theta         ?? null,
    vega:         o.vega          ?? null,
  };
}

function medianOf(nums) {
  const s = [...nums].sort((a,b)=>a-b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function fmt(val, decimals) {
  return val != null ? +val.toFixed(decimals) : null;
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
