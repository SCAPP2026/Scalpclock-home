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

  // /stock/earnings gives real actual/estimate EPS but only the fiscal
  // *quarter-end* date in `period` — not the date the company actually
  // reported (companies report weeks after quarter-end). /calendar/earnings
  // has the real report date + bmo/amc timing, but on this API plan it
  // returns zero rows for any *past* date range (verified directly — even an
  // unfiltered historical window comes back empty), so it can't be used to
  // recover the true report date. Instead, findReaction() below scans Alpaca
  // daily bars across the plausible post-quarter-end reporting window and
  // treats the single largest one-day move as the report day — real earnings
  // reactions are reliably the biggest outlier in that window, so this finds
  // both a much more accurate report date AND the actual reaction size,
  // without needing the report date up front.
  const today = new Date().toISOString().slice(0, 10);

  const histRes = await fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${symbol}&token=${env.FINNHUB_KEY}`);
  const hist    = await histRes.json().catch(() => []);
  if (!Array.isArray(hist) || !hist.length) return json(out, 200);

  const pastQuarters = hist
    .filter(q => q.period && q.period < today && q.actual != null)
    .sort((a, b) => b.period.localeCompare(a.period));

  if (!pastQuarters.length) return json(out, 200);
  const quarter = pastQuarters[0];

  const estimate = quarter.estimate ?? null;
  const actual   = quarter.actual ?? null;
  const surprisePercent = quarter.surprisePercent ?? ((estimate != null && actual != null && estimate !== 0)
    ? Number((((actual - estimate) / Math.abs(estimate)) * 100).toFixed(4))
    : null);

  const entry = {
    period:          quarter.period,
    epsEstimate:     estimate,
    epsActual:       actual,
    surprisePercent,
    priceMovePercent: null,
  };

  if (env.ALPACA_KEY_ID && env.ALPACA_SECRET) {
    const reaction = await findReaction(env, symbol, quarter.period);
    if (reaction) {
      entry.priceMovePercent = reaction.pct;
      entry.period = reaction.date; // the actual report day, not just the quarter-end
    }
  }

  out.lastEarnings = entry;
  return json(out, 200);
}

// Scans daily closes from quarter-end through ~65 days later (reporting lag
// is almost always inside that window) and returns the single largest
// one-day % move — a strong proxy for the real earnings-reaction day when
// the exact report date/timing isn't available.
async function findReaction(env, symbol, quarterEndDate) {
  const headers = {
    'APCA-API-KEY-ID':     env.ALPACA_KEY_ID,
    'APCA-API-SECRET-KEY': env.ALPACA_SECRET,
  };
  const start = quarterEndDate;
  const end   = new Date(new Date(quarterEndDate).getTime() + 65 * 86400000).toISOString().slice(0, 10);

  try {
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${start}&end=${end}&limit=100&sort=asc&feed=iex`,
      { headers }
    );
    const data = await res.json();
    const bars = data.bars || [];
    if (bars.length < 2) return null;

    let best = null;
    for (let i = 1; i < bars.length; i++) {
      const before = bars[i - 1].c;
      const after  = bars[i].c;
      if (!before) continue;
      const pct = ((after - before) / before) * 100;
      if (!best || Math.abs(pct) > Math.abs(best.pct)) {
        best = { pct: Number(pct.toFixed(2)), date: bars[i].t.slice(0, 10) };
      }
    }
    return best;
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
