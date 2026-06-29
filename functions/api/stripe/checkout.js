const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // DEBUG: remove after diagnosis
  return json({ debug: true, method: request.method, hasSecret: !!env.STRIPE_SECRET_KEY, hasMonthly: !!env.STRIPE_PRICE_PRO_MONTHLY, hasAnnual: !!env.STRIPE_PRICE_PRO_ANNUAL }, 200);

  try {
    return await handleCheckout(env, request);
  } catch (e) {
    console.error('Checkout fatal:', e);
    return json({ error: `Internal error: ${e.message}` }, 500);
  }
}

async function handleCheckout(env, request) {
  let tier, billing;
  try {
    ({ tier, billing } = await request.json());
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const PRICES = {
    pro_monthly:   env.STRIPE_PRICE_PRO_MONTHLY,
    pro_annual:    env.STRIPE_PRICE_PRO_ANNUAL,
    elite_monthly: env.STRIPE_PRICE_ELITE_MONTHLY,
    elite_annual:  env.STRIPE_PRICE_ELITE_ANNUAL,
  };

  const priceId = PRICES[`${tier}_${billing}`];
  if (!priceId) {
    return json({ error: `No price configured for ${tier}/${billing}` }, 400);
  }

  const origin = new URL(request.url).origin;

  const body = new URLSearchParams({
    'line_items[0][price]':    priceId,
    'line_items[0][quantity]': '1',
    mode:                      'subscription',
    success_url:               `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:                `${origin}/pricing`,
    allow_promotion_codes:     'true',
  });

  let res;
  try {
    res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization:   `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
  } catch (fetchErr) {
    return json({ error: `Stripe fetch failed: ${fetchErr.message}` }, 502);
  }

  let session;
  try {
    session = await res.json();
  } catch (parseErr) {
    return json({ error: `Stripe response parse failed: ${parseErr.message}`, status: res.status }, 502);
  }

  if (!res.ok) {
    console.error('Stripe error:', session.error);
    return json({ error: session.error?.message || 'Stripe checkout failed', stripe_status: res.status }, 502);
  }

  return json({ url: session.url }, 200);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
