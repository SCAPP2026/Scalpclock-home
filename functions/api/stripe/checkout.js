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

  try {
    return await handleCheckout(env, request);
  } catch (e) {
    console.error('Checkout fatal:', e);
    return json({ error: `Internal error: ${e.message}` }, 500);
  }
}

async function handleCheckout(env, request) {
  let tier, billing, trial, promoId, userId;
  try {
    ({ tier, billing, trial, promoId, userId } = await request.json());
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

  const isTrialSession = trial === true && tier === 'pro';
  const origin         = new URL(request.url).origin;

  const successUrl = `${origin}/success?session_id={CHECKOUT_SESSION_ID}` +
    (isTrialSession ? '&trial=1' : '');

  const params = new URLSearchParams({
    'line_items[0][price]':    priceId,
    'line_items[0][quantity]': '1',
    mode:                      'subscription',
    success_url:               successUrl,
    cancel_url:                `${origin}/pricing`,
  });

  // Stripe rejects a session that sets both `discounts` and
  // `allow_promotion_codes` — pre-apply the code the user already
  // validated on-site; otherwise let them enter one manually at checkout.
  if (promoId) {
    params.set('discounts[0][promotion_code]', promoId);
  } else {
    params.set('allow_promotion_codes', 'true');
  }

  if (isTrialSession) {
    params.set('subscription_data[trial_period_days]', '7');
    params.set('payment_method_collection', 'always');
  }

  // Pass userId so webhook can update profile on completion
  if (userId) {
    params.set('client_reference_id', userId);
    params.set('subscription_data[metadata][user_id]', userId);
  }

  let res;
  try {
    res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
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
