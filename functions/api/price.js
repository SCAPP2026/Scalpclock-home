// Returns the latest trade price for a symbol via Alpaca IEX feed.
// Much fresher than bar data — use this for the live price display.
export async function onRequest(context) {
  const { env, request } = context;
  const KEY_ID = env.ALPACA_KEY_ID;
  const SECRET = env.ALPACA_SECRET;

  const url    = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') || 'SPY').toUpperCase();

  const headers = {
    'APCA-API-KEY-ID':     KEY_ID,
    'APCA-API-SECRET-KEY': SECRET,
  };

  try {
    // Fetch trade, quote, and last 2 daily bars in parallel for changePct
    const [tradeRes, quoteRes, dailyRes] = await Promise.all([
      fetch(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=iex`, { headers }),
      fetch(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=iex`, { headers }),
      fetch(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&limit=2&sort=desc&feed=iex`, { headers }),
    ]);

    const tradeData = tradeRes.ok ? await tradeRes.json() : null;
    const quoteData = quoteRes.ok ? await quoteRes.json() : null;
    const dailyData = dailyRes.ok ? await dailyRes.json() : null;

    const price  = tradeData?.trade?.p ?? null;
    const ts     = tradeData?.trade?.t ?? null;
    const bid    = quoteData?.quote?.bp ?? null;
    const ask    = quoteData?.quote?.ap ?? null;
    const mid    = (bid && ask) ? +((bid + ask) / 2).toFixed(2) : null;

    // Previous session close for % change calculation
    const dailyBars = dailyData?.bars ?? [];
    const prevClose = dailyBars.length >= 2 ? dailyBars[1].c : (dailyBars.length === 1 ? dailyBars[0].c : null);
    const changePct = (price && prevClose) ? +((price - prevClose) / prevClose * 100).toFixed(2) : null;

    if (!price) {
      return json({ error: `No trade data for ${symbol}` }, 404);
    }

    return json({ symbol, price, mid, bid, ask, ts, changePct, prevClose });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      // Very short cache — this is a live price endpoint
      'Cache-Control':               'public, s-maxage=3, stale-while-revalidate=2',
    },
  });
}
