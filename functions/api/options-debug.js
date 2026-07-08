export async function onRequest(context) {
  const { env } = context;
  const KEY = env.MASSIVE_API_KEY;
  if (!KEY) return new Response(JSON.stringify({ error: 'no key' }));

  const res = await fetch(`https://api.polygon.io/v3/snapshot/options/AAPL?limit=5&apiKey=${KEY}`);
  const text = await res.text();
  return new Response(JSON.stringify({ status: res.status, body: text.slice(0, 800) }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
