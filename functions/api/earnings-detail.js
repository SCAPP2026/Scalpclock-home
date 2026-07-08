// On-demand earnings detail for a single ticker — fetched only when a user
// expands a specific earnings card, not bulk for the whole calendar.
// Combines: last quarter's EPS beat/miss (Finnhub) + the stock's actual
// price reaction to it (Alpaca daily bars).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url    = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
  if (!symbol) return json({ error: 'symbol required' }, 400);

  try {
    return await handleDetail(env, symbol);
  } catch (e) {
    console.error('earnings-detail fatal:', e.message);
    return json({ symbol, error: `Internal error: ${e.message}` }, 200);
  }
}

async function handleDetail(env, symbol) {
  const out = { symbol, lastEarnings: null };

  if (!env.FINNHUB_KEY) return json(out, 200);

  const histRes = await fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${symbol}&token=${env.FINNHUB_KEY}`);
  const hist    = await histRes.json().catch(() => []);
  if (!Array.isArray(hist) || !hist.length) return json(out, 200);

  const today = new Date().toISOString().slice(0, 10);
  const past  = hist
    .filter(q => q.period && q.period < today)
    .sort((a, b) => b.period.localeCompare(a.period));

  if (!past.length) return json(out, 200);
  const last = past[0];

  const entry = {
    period:          last.period,
    epsEstimate:     last.estimate ?? null,
    epsActual:       last.actual   ?? null,
    surprisePercent: last.surprisePercent ?? null,
    priceMovePercent: null,
  };

  if (env.ALPACA_KEY_ID && env.ALPACA_SECRET) {
    entry.priceMovePercent = await priceReaction(env, symbol, last.period);
  }

  out.lastEarnings = entry;
  return json(out, 200);
}

async function priceReaction(env, symbol, periodDate) {
  const headers = {
    'APCA-API-KEY-ID':     env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': env.ALPACA_SECRET,
  };
  const start = new Date(new Date(periodDate).getTime() - 6 * 86400000).toISOString().slice(0, 10);
  const end   = new Date(new Date(periodDate).getTime() + 6 * 86400000).toISOString().slice(0, 10);

  try {
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${start}&end=${end}&limit=20&sort=asc&feed=iex`,
      { headers }
    );
    const data  = await res.json();
    const bars  = data.bars || [];
    if (bars.length < 2) return null;

    // Closest trading day at/before the report, and the next trading day after.
    let beforeIdx = -1;
    for (let i = 0; i < bars.length; i++) {
      const d = bars[i].t.slice(0, 10);
      if (d <= periodDate) beforeIdx = i;
    }
    if (beforeIdx === -1 || beforeIdx + 1 >= bars.length) return null;

    const before = bars[beforeIdx].c;
    const after  = bars[beforeIdx + 1].c;
    if (!before) return null;

    return Number((((after - before) / before) * 100).toFixed(2));
  } catch {
    return null;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=3600' },
  });
}
