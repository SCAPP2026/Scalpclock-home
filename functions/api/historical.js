const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || 'SPY').toUpperCase().replace(/[^A-Z.\-\^]/g, '').slice(0, 10);
  const interval = url.searchParams.get('interval') || '1d';
  const range = url.searchParams.get('range') || '1y';
  const period1 = url.searchParams.get('period1');
  const period2 = url.searchParams.get('period2');

  if (!symbol) return json({ error: 'Symbol required' }, 400);

  const VALID_INTERVALS = new Set(['1m','2m','5m','15m','30m','60m','1h','1d','5d','1wk','1mo']);
  const VALID_RANGES    = new Set(['1d','5d','1mo','3mo','6mo','1y','2y','5y','10y','ytd','max']);

  if (!VALID_INTERVALS.has(interval)) return json({ error: 'Invalid interval' }, 400);
  if (!period1 && !VALID_RANGES.has(range)) return json({ error: 'Invalid range' }, 400);

  const base = 'https://query1.finance.yahoo.com/v8/finance/chart';
  const qs = period1
    ? `?interval=${interval}&period1=${period1}&period2=${period2 || Math.floor(Date.now() / 1000)}&includePrePost=false`
    : `?interval=${interval}&range=${range}&includePrePost=false`;
  const yahooUrl = `${base}/${encodeURIComponent(symbol)}${qs}`;

  try {
    const res = await fetch(yahooUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com/',
      },
    });

    if (!res.ok) {
      console.error('Yahoo Finance status:', res.status);
      return json({ error: `Data provider returned ${res.status}` }, 502);
    }

    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) {
      return json({ error: data.chart?.error?.description || 'Symbol not found or no data' }, 404);
    }

    const timestamps = result.timestamp || [];
    const q    = result.indicators?.quote?.[0] || {};
    const meta = result.meta || {};
    const isDaily = ['1d', '5d', '1wk', '1mo'].includes(interval);

    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
      if (o == null || h == null || l == null || c == null || isNaN(o + h + l + c)) continue;

      let time;
      if (isDaily) {
        const d = new Date(timestamps[i] * 1000);
        time = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      } else {
        time = timestamps[i];
      }

      candles.push({
        time,
        open:   +o.toFixed(2),
        high:   +h.toFixed(2),
        low:    +l.toFixed(2),
        close:  +c.toFixed(2),
        volume: v || 0,
      });
    }

    return json({
      symbol,
      interval,
      candles,
      meta: {
        currency: meta.currency || 'USD',
        exchange: meta.exchangeName || '',
        name:     meta.longName || symbol,
      },
    });
  } catch (e) {
    console.error('historical error:', e.message);
    return json({ error: 'Failed to retrieve market data' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
