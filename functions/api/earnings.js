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

  const [finn, fmp, names] = await Promise.allSettled([
    fetchFinnhub(env.FINNHUB_KEY, from, to),
    fetchFMP(env.FMP_KEY, from, to),
    fetchSymbolNames(env.FINNHUB_KEY),
  ]);

  if (url.searchParams.get('debug') === '1') {
    const byDay = (arr) => {
      const c = {};
      for (const e of arr) c[e.date] = (c[e.date] || 0) + 1;
      return c;
    };
    return json({
      DEBUG: true, from, to,
      finn: { status: finn.status, count: finn.status === 'fulfilled' ? finn.value.length : null, error: finn.status === 'rejected' ? String(finn.reason) : null, byDay: finn.status === 'fulfilled' ? byDay(finn.value) : null },
      fmp:  { status: fmp.status,  count: fmp.status  === 'fulfilled' ? fmp.value.length  : null, error: fmp.status  === 'rejected' ? String(fmp.reason)  : null, byDay: fmp.status  === 'fulfilled' ? byDay(fmp.value)  : null },
    });
  }

  let items = [];

  if (finn.status === 'fulfilled' && finn.value.length) {
    items = finn.value;
  } else if (fmp.status === 'fulfilled' && fmp.value.length) {
    items = fmp.value;
  }

  const nameMap = names.status === 'fulfilled' ? names.value : {};
  if (Object.keys(nameMap).length) {
    items = items.map(e => ({ ...e, company: nameMap[e.symbol] || e.symbol }));
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

// Finnhub's full US symbol list includes a company name (`description`) per
// ticker. It's a big response (~1-2MB, thousands of rows), so it's cached at
// the edge for 24h rather than fetched on every /api/earnings request.
async function fetchSymbolNames(key) {
  if (!key) return {};

  const cacheKey = new Request('https://scalpclock.com/__cache__/finnhub-us-symbol-names');
  const cache    = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return await cached.json();

  const res  = await fetch(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${key}`);
  const data = await res.json();
  if (!Array.isArray(data)) return {};

  const map = {};
  for (const s of data) {
    if (s.symbol && s.description) map[s.symbol] = titleCase(s.description);
  }

  const cacheResponse = new Response(JSON.stringify(map), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' },
  });
  await cache.put(cacheKey, cacheResponse);

  return map;
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bLlc\b/g, 'LLC').replace(/\bLp\b/g, 'LP')
    .replace(/\bInc\b/g, 'Inc').replace(/\bCorp\b/g, 'Corp')
    .replace(/\bPlc\b/g, 'PLC').replace(/\bEtf\b/g, 'ETF')
    .replace(/\bReit\b/g, 'REIT').replace(/\bAdr\b/g, 'ADR')
    .replace(/\bUsa\b/g, 'USA').replace(/\bU\.s\.\b/g, 'U.S.');
}

async function fetchFinnhub(key, from, to) {
  if (!key) return [];
  const res  = await fetch(
    `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${key}`
  );
  const data = await res.json();
  return (data.earningsCalendar || []).map(e => ({
    symbol:            e.symbol,
    company:           e.symbol, // filled in from fetchSymbolNames when available
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
