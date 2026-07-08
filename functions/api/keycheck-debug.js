export async function onRequest(context) {
  const { env } = context;
  return new Response(JSON.stringify({
    FMP_KEY: !!env.FMP_KEY,
    FINNHUB_KEY: !!env.FINNHUB_KEY,
    MASSIVE_API_KEY: !!env.MASSIVE_API_KEY,
  }), { headers: { 'Content-Type': 'application/json' } });
}
