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
  const debug = url.searchParams.get('debug') === '1';

  try {
    return await handleDetail(env, symbol, debug);
  } catch (e) {
    console.error('earnings-detail fatal:', e.message);
    return json({ symbol, error: `Internal error: ${e.message}` }, 200);
  }
}

async function handleDetail(env, symbol, debug) {
  const out = { symbol, lastEarnings: null };

  if (!env.FINNHUB_KEY) return json(out, 200);

  // /stock/earnings gives real actual/estimate EPS but only the fiscal
  // *quarter-end* date in `period` — not the date the company actually
  // reported (companies report weeks after quarter-end). Using `period`
  // directly as the report date pointed the price-reaction lookup at a
  // random ordinary trading day near quarter-end instead of the real
  // earnings-day move.
  //
  // /calendar/earnings has the real report `date` + `hour` (bmo/amc), but
  // its `symbol=` filter returns an empty result on this API plan (verified
  // via ?debug=1 — status 200, earningsCalendar: []), so instead of filtering
  // server-side we fetch a date-bounded *unfiltered* calendar window (just
  // after the known quarter-end, when this company would plausibly have
  // reported) and filter for the symbol ourselves.
  const today = new Date().toISOString().slice(0, 10);

  const histRes = await fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${symbol}&token=${env.FINNHUB_KEY}`);
  const hist    = await histRes.json().catch(() => []);
  if (!Array.isArray(hist) || !hist.length) return json(out, 200);

  const pastQuarters = hist
    .filter(q => q.period && q.period < today && q.actual != null)
    .sort((a, b) => b.period.localeCompare(a.period));

  if (!pastQuarters.length) return json(out, 200);
  const quarter = pastQuarters[0];

  // Reporting lag is almost always within ~10 weeks of quarter-end.
  const calFrom = quarter.period;
  const calTo   = new Date(new Date(quarter.period).getTime() + 70 * 86400000).toISOString().slice(0, 10);
  const calRes  = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${calFrom}&to=${calTo}&token=${env.FINNHUB_KEY}`);
  const calData = await calRes.json().catch(() => null);
  const cal     = Array.isArray(calData?.earningsCalendar) ? calData.earningsCalendar : [];
  const match   = cal.find(e => e.symbol === symbol);

  if (debug) {
    return json({ symbol, DEBUG: true, quarter, calFrom, calTo, calCount: cal.length, match }, 200);
  }

  const reportDate = match?.date && match.date < today ? match.date : quarter.period;
  const hour       = match?.hour || null;

  const estimate = quarter.estimate ?? null;
  const actual   = quarter.actual ?? null;
  const surprisePercent = quarter.surprisePercent ?? ((estimate != null && actual != null && estimate !== 0)
    ? Number((((actual - estimate) / Math.abs(estimate)) * 100).toFixed(4))
    : null);

  const entry = {
    period:          reportDate,
    epsEstimate:     estimate,
    epsActual:       actual,
    surprisePercent,
    priceMovePercent: null,
  };

  if (env.ALPACA_KEY_ID && env.ALPACA_SECRET) {
    entry.priceMovePercent = await priceReaction(env, symbol, reportDate, hour);
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
