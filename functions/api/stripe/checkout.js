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

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization:   `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const session = await res.json();

  if (!res.ok) {
    console.error('Stripe error:', session.error);
    return json({ error: session.error?.message || 'Stripe checkout failed' }, 502);
  }

  return json({ url: session.url }, 200);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
