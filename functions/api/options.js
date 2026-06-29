export async function onRequest(context) {
  const { env, request } = context;
  const url    = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || 'SPY').toUpperCase();
  const KEY    = env.MASSIVE_API_KEY;

  if (!KEY) return json({ error: 'No Polygon key configured', symbol }, 503);

  try {
    const res = await fetch(
      `https://api.polygon.io/v3/snapshot/options/${symbol}?limit=250&sort=expiration_date&order=asc&apiKey=${KEY}`
    );
    const data = await res.json();

    if (!data.results?.length) return json({ symbol, noData: true }, 200);

    const now      = new Date();
    const inTwoWks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    // Near-term contracts only
    let opts = data.results.filter(o => {
      const exp = new Date(o.details?.expiration_date);
      return exp >= now && exp <= inTwoWks;
    });
    if (opts.length < 10) opts = data.results.slice(0, 100);

    const calls = opts.filter(o => o.details?.contract_type === 'call');
    const puts  = opts.filter(o => o.details?.contract_type === 'put');

    // Volumes & OI
    const callVol = calls.reduce((s, o) => s + (o.day?.volume || 0), 0);
    const putVol  = puts.reduce((s,  o) => s + (o.day?.volume || 0), 0);
    const callOI  = calls.reduce((s, o) => s + (o.open_interest || 0), 0);
    const putOI   = puts.reduce((s,  o) => s + (o.open_interest || 0), 0);
    const pcRatio = callVol > 0 ? +(putVol / callVol).toFixed(2) : null;

    // ATM greeks — use options with greeks closest to mid-strike
    const strikes = [...new Set(opts.map(o => o.details?.strike_price).filter(Boolean))].sort((a,b)=>a-b);
    const midStrike = strikes[Math.floor(strikes.length / 2)] || 0;

    const withGreeks = opts
      .filter(o => o.greeks)
      .map(o => ({ ...o, dist: Math.abs((o.details?.strike_price || 0) - midStrike) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 8);

    function avg(arr) {
      const vals = arr.filter(Boolean);
      return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
    }

    const atmCalls = withGreeks.filter(o => o.details?.contract_type === 'call');
    const greeks = {
      delta: fmt(avg(atmCalls.map(o => o.greeks?.delta)), 3),
      gamma: fmt(avg(withGreeks.map(o => o.greeks?.gamma)), 4),
      theta: fmt(avg(withGreeks.map(o => o.greeks?.theta)), 3),
      vega:  fmt(avg(withGreeks.map(o => o.greeks?.vega)),  3),
    };

    // IV stats
    const ivs = opts.map(o => o.implied_volatility).filter(Boolean);
    ivs.sort((a,b)=>a-b);
    const avgIV = avg(ivs);
    const medIV = ivs[Math.floor(ivs.length/2)];
    const ivPct = avgIV ? +(avgIV * 100).toFixed(1) : null;

    // IV Rank: where current IV sits in today's observed range
    const minIV = ivs[0], maxIV = ivs[ivs.length-1];
    const ivRank = (avgIV && maxIV !== minIV)
      ? Math.round(((avgIV - minIV) / (maxIV - minIV)) * 100) : null;

    // IV Crush: avg IV significantly above median → elevated, event risk
    const ivCrushWarning = avgIV && medIV && avgIV > medIV * 1.35;

    // Unusual flow: day volume ≥ 1.8x open interest and volume > 50
    const unusual = opts
      .filter(o => {
        const vol = o.day?.volume || 0;
        const oi  = o.open_interest || 0;
        return vol > 50 && oi > 0 && vol / oi >= 1.8;
      })
      .map(o => ({
        type:   o.details?.contract_type,
        strike: o.details?.strike_price,
        expiry: o.details?.expiration_date,
        volume: o.day?.volume,
        oi:     o.open_interest,
        ratio:  +(o.day?.volume / o.open_interest).toFixed(1),
        iv:     o.implied_volatility ? +(o.implied_volatility * 100).toFixed(1) : null,
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
    });

  } catch (e) {
    return json({ error: e.message, symbol }, 500);
  }
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
      'Cache-Control': 'no-store',
    },
  });
}
