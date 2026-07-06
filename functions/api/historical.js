const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const KEY_ID = env.ALPACA_KEY_ID;
  const SECRET = env.ALPACA_SECRET;

  if (!KEY_ID || !SECRET) return json({ error: 'API keys not configured' }, 500);

  const url = new URL(request.url);
  const symbol   = (url.searchParams.get('symbol') || 'SPY').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
  const interval = url.searchParams.get('interval') || '1d';
  const range    = url.searchParams.get('range')    || '1y';
  const period1  = url.searchParams.get('period1');
  const period2  = url.searchParams.get('period2');

  if (!symbol) return json({ error: 'Symbol required' }, 400);

  const TIMEFRAME_MAP = {
    '1m':'1Min','2m':'2Min','5m':'5Min','15m':'15Min','30m':'30Min',
    '60m':'1Hour','1h':'1Hour','1d':'1Day','5d':'1Day','1wk':'1Week','1mo':'1Month',
  };
  const timeframe = TIMEFRAME_MAP[interval] || '1Day';
  const isDaily   = ['1d','5d','1wk','1mo'].includes(interval);

  const RANGE_DAYS = {
    '1d':2,'5d':8,'1mo':35,'3mo':95,'6mo':185,'1y':370,'2y':735,'5y':1830,'10y':3660,'ytd':370,'max':3660,
  };

  let startDate, endDate;
  if (period1) {
    startDate = new Date(Number(period1) * 1000).toISOString().slice(0, 10);
    endDate   = period2 ? new Date(Number(period2) * 1000).toISOString().slice(0, 10)
                        : new Date().toISOString().slice(0, 10);
  } else {
    const days = RANGE_DAYS[range] || 370;
    endDate   = new Date().toISOString().slice(0, 10);
    startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  }

  const headers = {
    'APCA-API-KEY-ID':     KEY_ID,
    'APCA-API-SECRET-KEY': SECRET,
  };

  // Alpaca limits to 1000 bars per page — paginate if needed
  let allBars = [];
  let pageToken = null;

  try {
    do {
      let alpacaUrl = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`
        + `?timeframe=${timeframe}&start=${startDate}&end=${endDate}&limit=1000&sort=asc&feed=iex`;
      if (pageToken) alpacaUrl += `&page_token=${encodeURIComponent(pageToken)}`;

      const res  = await fetch(alpacaUrl, { headers });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return json({ error: err.message || `Market data provider returned ${res.status}` }, 502);
      }

      const data = await res.json();
      const bars = data.bars || [];
      allBars = allBars.concat(bars);
      pageToken = data.next_page_token || null;

      // Safety cap — replay only needs ~1000 daily bars max
      if (allBars.length >= 1000) break;

    } while (pageToken);

    if (!allBars.length) {
      return json({ error: 'No data found for this symbol or date range.' }, 404);
    }

    const candles = allBars.map(b => {
      const d = new Date(b.t);
      const time = isDaily
        ? `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`
        : Math.floor(d.getTime() / 1000);
      return {
        time,
        open:   +b.o.toFixed(2),
        high:   +b.h.toFixed(2),
        low:    +b.l.toFixed(2),
        close:  +b.c.toFixed(2),
        volume: b.v || 0,
      };
    });

    return json({
      symbol,
      interval,
      candles,
      meta: { currency: 'USD', exchange: 'ALPACA', name: symbol },
    });

  } catch (e) {
    console.error('historical error:', e.message);
    return json({ error: 'Failed to retrieve market data — please try again.' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
    },
  });
}
