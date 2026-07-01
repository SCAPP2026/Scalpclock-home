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
    // Latest trade gives the most recent execution price — no bar-close lag
    const [tradeRes, quoteRes] = await Promise.all([
      fetch(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/trades/latest?feed=iex`, { headers }),
      fetch(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=iex`, { headers }),
    ]);

    const tradeData = tradeRes.ok ? await tradeRes.json() : null;
    const quoteData = quoteRes.ok ? await quoteRes.json() : null;

    const price  = tradeData?.trade?.p ?? null;
    const ts     = tradeData?.trade?.t ?? null;
    const bid    = quoteData?.quote?.bp ?? null;
    const ask    = quoteData?.quote?.ap ?? null;
    // Mid-point of bid/ask as a cross-check when available
    const mid    = (bid && ask) ? +((bid + ask) / 2).toFixed(2) : null;

    if (!price) {
      return json({ error: `No trade data for ${symbol}` }, 404);
    }

    return json({ symbol, price, mid, bid, ask, ts });
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
