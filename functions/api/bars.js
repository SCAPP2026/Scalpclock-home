export async function onRequest(context) {
  const { env, request } = context;

  const KEY_ID = env.ALPACA_KEY_ID;
  const SECRET = env.ALPACA_SECRET;

  const url = new URL(request.url);
  // Treat as a plain string — do not JSON.parse the symbol
  const rawSymbol  = url.searchParams.get('symbol') || 'SPY';
  const timeframe  = url.searchParams.get('tf') || '5Min';
  const hours      = Math.min(720, Math.max(1, parseInt(url.searchParams.get('hours') || '8', 10)));

  const headers = {
    'APCA-API-KEY-ID':     KEY_ID,
    'APCA-API-SECRET-KEY': SECRET,
  };

  const now      = new Date();
  const startISO = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();

  // Option symbols arrive as "O:SOFI260702P00017000" (OCC/Polygon format).
  // Extract the underlying ticker so we can fetch stock bars for RSI/ATR/velocity.
  // OCC format after stripping O: → underlying(≤6 chars) + YYMMDD + C/P + strike(8 digits)
  const isOption   = rawSymbol.startsWith('O:');
  const isPut      = isOption && /\d{6}P\d+$/.test(rawSymbol.slice(2));
  // e.g. "O:SOFI260702P00017000" → underlying = "SOFI"
  const stockSym   = isOption
    ? (rawSymbol.slice(2).match(/^([A-Z]{1,6})\d{6}[CP]\d+$/) || [])[1] || rawSymbol.slice(2)
    : rawSymbol.toUpperCase();

  try {
    const stockUrl = 'https://data.alpaca.markets/v2/stocks/'
      + encodeURIComponent(stockSym)
      + '/bars'
      + `?timeframe=${encodeURIComponent(timeframe)}`
      + `&start=${encodeURIComponent(startISO)}`
      + '&limit=100&feed=iex';

    const res  = await fetch(stockUrl, { headers });
    const data = await res.json();

    const candles = (data.bars ?? []).map(b => ({
      time:   b.t,
      open:   b.o,
      high:   b.h,
      low:    b.l,
      close:  b.c,
      volume: b.v,
    }));

    return new Response(JSON.stringify({ symbol: stockSym, isOption, isPut, candles }), {
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'no-store',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
