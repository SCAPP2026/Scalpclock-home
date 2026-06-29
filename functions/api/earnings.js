// Earnings calendar — returns this week + next week's earnings
// Sources: Finnhub (primary), FMP (fallback)
export async function onRequest(context) {
  const { env, request } = context;
  const url    = new URL(request.url);
  const symbol = url.searchParams.get('symbol'); // optional — filter to one ticker

  // Date range: today through next 10 trading days
  const today = new Date();
  const from  = fmt(today);
  const to    = fmt(new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000));

  const [finn, fmp] = await Promise.allSettled([
    fetchFinnhub(env.FINNHUB_KEY, from, to),
    fetchFMP(env.FMP_KEY, from, to),
  ]);

  let items = [];

  if (finn.status === 'fulfilled' && finn.value.length) {
    items = finn.value;
  } else if (fmp.status === 'fulfilled' && fmp.value.length) {
    items = fmp.value;
  }

  // Filter to specific symbol if requested
  if (symbol) {
    const sym = symbol.toUpperCase();
    items = items.filter(e => e.symbol === sym);
  }

  // Deduplicate by symbol+date
  const seen = new Set();
  items = items.filter(e => {
    const key = `${e.symbol}|${e.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by date then symbol
  items.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));

  return json({ from, to, count: items.length, earnings: items });
}

async function fetchFinnhub(key, from, to) {
  if (!key) return [];
  const res  = await fetch(
    `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${key}`
  );
  const data = await res.json();
  return (data.earningsCalendar || []).map(e => ({
    symbol:            e.symbol,
    company:           e.symbol, // Finnhub doesn't return name in calendar
    date:              e.date,
    time:              e.hour === 'bmo' ? 'pre-market' : e.hour === 'amc' ? 'after-close' : 'unknown',
    epsEstimate:       e.epsEstimate ?? null,
    epsActual:         e.epsActual   ?? null,
    revenueEstimate:   e.revenueEstimate ?? null,
    source:            'finnhub',
  }));
}

async function fetchFMP(key, from, to) {
  if (!key) return [];
  const res  = await fetch(
    `https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${key}`
  );
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map(e => ({
    symbol:          e.symbol,
    company:         e.symbol,
    date:            e.date,
    time:            e.time === 'bmo' ? 'pre-market' : e.time === 'amc' ? 'after-close' : 'unknown',
    epsEstimate:     e.epsEstimated ?? null,
    epsActual:       e.eps          ?? null,
    revenueEstimate: e.revenueEstimated ?? null,
    source:          'fmp',
  }));
}

function fmt(d) {
  return d.toISOString().split('T')[0];
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'max-age=1800', // cache 30 min — earnings don't change often
    },
  });
}
