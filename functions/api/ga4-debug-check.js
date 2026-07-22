// TEMPORARY diagnostic — confirms GA4_API_SECRET is set correctly using
// Google's official validation endpoint (validates only, never records real
// data). Not wired to any billing logic. Delete after use.
// (redeploy nudge)
const GA4_MEASUREMENT_ID = 'G-M4F7X9HDDW';

export async function onRequest(context) {
  const { env } = context;
  if (!env.GA4_API_SECRET) {
    return json({ ok: false, error: 'GA4_API_SECRET is not set in this environment.' }, 200);
  }
  try {
    const res = await fetch(
      `https://www.google-analytics.com/debug/mp/collect?measurement_id=${GA4_MEASUREMENT_ID}&api_secret=${env.GA4_API_SECRET}`,
      {
        method: 'POST',
        body: JSON.stringify({
          client_id: 'debug-check.' + Date.now(),
          events: [{ name: 'purchase', params: { transaction_id: 'debug_test', value: 9.99, currency: 'USD' } }],
        }),
      }
    );
    const result = await res.json();
    return json({ ok: true, secretConfigured: true, validationResult: result }, 200);
  } catch (e) {
    return json({ ok: false, error: e.message }, 200);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
