// Regular-session 15-minute bars for the ORB Signal Engine — one trading day
// (09:30-16:00 ET) per request, normalized to {time:"HH:MM", open, high, low, close, volume}.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const RTH_START = '09:30';
const RTH_END = '16:00';

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const KEY_ID = env.ALPACA_KEY_ID;
  const SECRET = env.ALPACA_SECRET;
  if (!KEY_ID || !SECRET) return json({ error: 'API keys not configured' }, 500);

  const url = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || 'SPY').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
  if (!symbol) return json({ error: 'Symbol required' }, 400);

  const todayET = etDateString(new Date());
  let date = url.searchParams.get('date') || todayET;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'Invalid date — use YYYY-MM-DD' }, 400);
  if (date > todayET) return json({ error: 'Date is in the future' }, 400);

  // Request a 2-day UTC window starting at the target date — wide enough to
  // cover the full ET session (which can spill into the next UTC day)
  // without pulling in unrelated prior/future sessions.
  const endDate = new Date(date + 'T00:00:00Z');
  endDate.setUTCDate(endDate.getUTCDate() + 2);
  const endStr = endDate.toISOString().slice(0, 10);

  const alpacaUrl = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`
    + `?timeframe=15Min&start=${date}&end=${endStr}&limit=1000&sort=asc&feed=iex`;

  try {
    const res = await fetch(alpacaUrl, {
      headers: { 'APCA-API-KEY-ID': KEY_ID, 'APCA-API-SECRET-KEY': SECRET },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return json({ error: err.message || `Market data provider returned ${res.status}` }, 400);
    }

    const data = await res.json();
    const bars = data.bars || [];

    const candles = bars
      .map(b => {
        const et = etParts(b.t);
        return { et, open: +b.o.toFixed(2), high: +b.h.toFixed(2), low: +b.l.toFixed(2), close: +b.c.toFixed(2), volume: b.v || 0 };
      })
      .filter(c => c.et.date === date && c.et.time >= RTH_START && c.et.time < RTH_END)
      .map(c => ({ time: c.et.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));

    if (!candles.length) {
      return json({ error: `No regular-session bars found for ${symbol} on ${date} — market may have been closed, or the date is too far in the past for this feed.` }, 404);
    }

    const maxAge = date === todayET ? 15 : 3600;
    return json({ symbol, date, candles }, 200, maxAge);

  } catch (e) {
    console.error('orb-bars error:', e.message);
    return json({ error: 'Failed to retrieve market data — please try again.' }, 500);
  }
}

// Timezone-safe ET date/time split for a UTC bar timestamp, DST-aware via Intl.
function etParts(isoTs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(isoTs))) map[p.type] = p.value;
  const hh = map.hour === '24' ? '00' : map.hour;
  return { date: `${map.year}-${map.month}-${map.day}`, time: `${hh}:${map.minute}` };
}

function etDateString(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

function json(data, status = 200, maxAge = 15) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json',
      'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=60`,
    },
  });
}
