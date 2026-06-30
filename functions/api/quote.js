// REST quote fallback: Finnhub → Polygon, with 3-second cache deduplication.

export async function onRequest(context) {
  const { env, request } = context;

  const symbol = new URL(request.url).searchParams.get('symbol') || 'SPY';
  const sym    = symbol.toUpperCase();

  const cacheKey = new Request(`https://scalpclock-quote-cache.internal/${sym}`);
  const cache    = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const FINNHUB_KEY = env.FINNHUB_KEY;
  const POLYGON_KEY = env.POLYGON_KEY;

  let price  = null;
  let source = null;

  if (FINNHUB_KEY && !price) {
    try {
      const r = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${FINNHUB_KEY}`,
      );
      if (r.ok) {
        const d = await r.json();
        if (d.c && d.c > 0) { price = d.c; source = 'finnhub'; }
      }
    } catch (_) {}
  }

  if (POLYGON_KEY && !price) {
    try {
      const r = await fetch(
        `https://api.polygon.io/v2/last/trade/${encodeURIComponent(sym)}?apiKey=${POLYGON_KEY}`,
      );
      if (r.ok) {
        const d = await r.json();
        if (d.results?.p) { price = d.results.p; source = 'polygon'; }
      }
    } catch (_) {}
  }

  if (!price) {
    return new Response(JSON.stringify({ error: 'no quote available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const body = JSON.stringify({ symbol: sym, price, source, timestamp: Date.now() });
  const resp = new Response(body, {
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               's-maxage=3, max-age=3',
    },
  });

  context.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}
