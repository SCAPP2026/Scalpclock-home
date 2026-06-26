export async function onRequest(context) {
  const { env, request } = context;

  const KEY_ID = env.ALPACA_KEY_ID;
  const SECRET = env.ALPACA_SECRET;

  const url = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || 'SPY').toUpperCase();
  const timeframe = url.searchParams.get('tf') || '5Min';

  const headers = {
    'APCA-API-KEY-ID': KEY_ID,
    'APCA-API-SECRET-KEY': SECRET,
  };

  const now = new Date();
  const start = new Date(now.getTime() - 6 * 60 * 60 * 1000); // 6 hours ago
  const startISO = start.toISOString();

  try {
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${symbol}/bars?timeframe=${timeframe}&start=${startISO}&limit=100&feed=iex`,
      { headers }
    );
    const data = await res.json();

    const candles = (data.bars || []).map(b => ({
      time: b.t,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));

    return new Response(JSON.stringify({ symbol, candles }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
