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

  // Use the calendar endpoint (not /stock/earnings) for history too: /stock/earnings
  // only returns the fiscal *quarter-end* date in `period`, not the actual report
  // date — companies report weeks after quarter-end, so using `period` as the report
  // date pointed the price-reaction lookup at a random ordinary trading day near
  // quarter-end instead of the real earnings-day move. /calendar/earnings?symbol=
  // gives the real report `date` plus `hour` (bmo/amc), which we also need to pick
  // the correct before/after trading day below.
  const today = new Date().toISOString().slice(0, 10);
  const from  = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);

  const calRes  = await fetch(`https://finnhub.io/api/v1/calendar/earnings?symbol=${symbol}&from=${from}&to=${today}&token=${env.FINNHUB_KEY}`);
  const calData = await calRes.json().catch(() => null);
  const cal     = Array.isArray(calData?.earningsCalendar) ? calData.earningsCalendar : [];

  const past = cal
    .filter(e => e.date && e.date < today && e.epsActual != null)
    .sort((a, b) => b.date.localeCompare(a.date));

  if (!past.length) return json(out, 200);
  const last = past[0];

  const estimate = last.epsEstimate ?? null;
  const actual   = last.epsActual ?? null;
  const surprisePercent = (estimate != null && actual != null && estimate !== 0)
    ? Number((((actual - estimate) / Math.abs(estimate)) * 100).toFixed(4))
    : null;

  const entry = {
    period:          last.date,
    epsEstimate:     estimate,
    epsActual:       actual,
    surprisePercent,
    priceMovePercent: null,
  };

  if (env.ALPACA_KEY_ID && env.ALPACA_SECRET) {
    entry.priceMovePercent = await priceReaction(env, symbol, last.date, last.hour);
  }

  out.lastEarnings = entry;
  return json(out, 200);
}

async function priceReaction(env, symbol, reportDate, hour) {
  const headers = {
    'APCA-API-KEY-ID':     env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': env.ALPACA_SECRET,
  };
  const start = new Date(new Date(reportDate).getTime() - 6 * 86400000).toISOString().slice(0, 10);
  const end   = new Date(new Date(reportDate).getTime() + 6 * 86400000).toISOString().slice(0, 10);

  try {
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${start}&end=${end}&limit=20&sort=asc&feed=iex`,
      { headers }
    );
    const data  = await res.json();
    const bars  = data.bars || [];
    if (bars.length < 2) return null;

    // Trading day matching the report date if the market was open that day,
    // else the nearest trading day at/before it.
    let onIdx = -1, beforeIdx = -1;
    for (let i = 0; i < bars.length; i++) {
      const d = bars[i].t.slice(0, 10);
      if (d === reportDate) onIdx = i;
      if (d <= reportDate) beforeIdx = i;
    }
    const reportIdx = onIdx !== -1 ? onIdx : beforeIdx;
    if (reportIdx === -1) return null;

    let before, after;
    if (hour === 'bmo') {
      // Reported before the open: the reaction is priced in overnight, so the
      // gap shows up between the PRIOR close and the report day's own close.
      if (reportIdx - 1 < 0) return null;
      before = bars[reportIdx - 1].c;
      after  = bars[reportIdx].c;
    } else {
      // Reported after the close (or unknown timing): the reaction shows up
      // between the report day's close and the NEXT trading day's close.
      if (reportIdx + 1 >= bars.length) return null;
      before = bars[reportIdx].c;
      after  = bars[reportIdx + 1].c;
    }
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
