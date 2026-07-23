// Real (not fabricated) entry/stop/target/probability levels for the
// locked "Premium Trade Plan" teaser on the public /signals preview.
//
// Reuses the exact calc model already live in exitassistant.html (ported
// verbatim from its `atr`, `velocity`, `volTrend`, `probability` functions —
// see that file, lines ~3487-3596) rather than inventing new math. `rsi` and
// `vwap` are passed in from the caller's already-fetched /api/signals entry
// so this endpoint only needs one extra fetch: 1-min bars for atr/velocity/
// volTrend, via the existing /api/bars function.
//
// `probability`'s BASE table is calibrated for OPTION PREMIUM % targets
// (10/20/30/50), not stock price % moves — so this endpoint intentionally
// keeps that framing (a 20% option-premium target zone) rather than
// reframing target/probability as a stock-price percentage, which would
// silently misapply the calibration. Entry/stop are expressed in the
// underlying's price, which is how options entries are normally described
// ("buy calls if it reclaims $X, stop below $Y").
export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  const symbol = (url.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z.\-]/g, '').slice(0, 10);
  const price  = Number(url.searchParams.get('price'));
  const rsi    = Number(url.searchParams.get('rsi'));
  const vwapRaw = url.searchParams.get('vwap');
  const vwap   = vwapRaw != null && vwapRaw !== '' ? Number(vwapRaw) : null;
  const tone   = url.searchParams.get('tone') === 'sell' ? 'sell' : 'buy';

  if (!symbol || !price || !Number.isFinite(price)) {
    return json({ error: 'symbol and price required' }, 400);
  }

  try {
    const barsRes = await fetch(new URL(`/api/bars?symbol=${encodeURIComponent(symbol)}&tf=1Min`, request.url));
    const barsData = await barsRes.json().catch(() => null);
    const candles = Array.isArray(barsData?.candles) ? barsData.candles : [];

    if (candles.length < 15) {
      return json({ symbol, error: 'Not enough recent bar data to compute a trade plan.' }, 200);
    }

    const atrVal = atr(candles);
    const vel    = velocity(candles);
    const vt     = volTrend(candles);
    const rsiVal = Number.isFinite(rsi) ? rsi : 50;

    const isPut  = tone === 'sell';
    const effVel = isPut ? -vel : vel;

    const stop = Number((isPut ? price + atrVal * 1.5 : price - atrVal * 1.5).toFixed(2));
    const entryZone = Number((vwap && Number.isFinite(vwap) ? vwap : price).toFixed(2));

    const TARGET_PCT = 20; // representative option-premium target, matches probability()'s BASE table
    const prob = probability(TARGET_PCT, rsiVal, effVel, atrVal, vt);

    return json({
      symbol,
      entryZone,
      stop,
      targetPct: TARGET_PCT,
      probability: Number(prob.toFixed(3)),
      tone,
      disclaimer: 'Educational estimate based on live price action — not financial advice.',
    }, 200);
  } catch (e) {
    return json({ symbol, error: 'Could not compute a trade plan right now.' }, 200);
  }
}

// ── Ported verbatim from exitassistant.html (~lines 3487-3596) ────────────
function velocity(bars, n = 5) {
  if (bars.length < n + 1) return 0;
  const sl = bars.slice(-n);
  return (sl[sl.length - 1].close - sl[0].close) / n;
}

function atr(bars, period = 14) {
  if (bars.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const c = bars[i], p = bars[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const sl = trs.slice(-period);
  return sl.reduce((a, b) => a + b, 0) / sl.length;
}

function volTrend(bars, n = 6) {
  if (bars.length < n + 1) return 0;
  const half = Math.floor(n / 2);
  const sl = bars.slice(-n);
  const ev = sl.slice(0, half).reduce((a, b) => a + b.volume, 0) / half;
  const lv = sl.slice(half).reduce((a, b) => a + b.volume, 0) / half;
  return ev > 0 ? (lv - ev) / ev : 0;
}

function probability(targetPct, rsiVal, vel, atrVal, vt) {
  const BASE = { 10: 0.54, 20: 0.27, 30: 0.13, 50: 0.05 };
  let p = BASE[targetPct] ?? 0.05;

  if      (rsiVal <= 25) p *= 1.80;
  else if (rsiVal <= 35) p *= 1.40;
  else if (rsiVal <= 48) p *= 1.15;
  else if (rsiVal <= 58) p *= 1.00;
  else if (rsiVal <= 68) p *= 0.75;
  else if (rsiVal <= 76) p *= 0.45;
  else                   p *= 0.20;

  const a = atrVal || 0.01;
  if      (vel > a * 0.6)   p *= 1.45;
  else if (vel > a * 0.25)  p *= 1.15;
  else if (vel > 0)         p *= 0.85;
  else if (vel > -a * 0.25) p *= 0.50;
  else                      p *= 0.20;

  if      (vt > 0.30)  p *= 1.25;
  else if (vt > 0.05)  p *= 1.08;
  else if (vt > -0.15) p *= 0.92;
  else                 p *= 0.72;

  return Math.min(0.97, Math.max(0.01, p));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, s-maxage=20, stale-while-revalidate=10',
    },
  });
}
