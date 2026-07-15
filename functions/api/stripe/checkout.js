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

// Same cap/cutoff logic as functions/api/founding-status.js — duplicated
// rather than imported so this file has zero cross-file dependency risk
// for billing-critical code. Keep both in sync if the cap/date changes.
const FOUNDING_CAP    = 500;
const FOUNDING_CUTOFF = '2026-09-30T23:59:59Z';

async function isFoundingOfferActive(serviceKey) {
  let claimed = 0;
  try {
    const res = await fetch('https://fnuqxiflqqejjttxymbz.supabase.co/rest/v1/founding_members?select=id', {
      headers: {
        apikey:        serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer:        'count=exact',
        Range:         '0-0',
      },
    });
    const range = res.headers.get('content-range'); // "0-0/N"
    if (range) claimed = parseInt(range.split('/')[1], 10) || 0;
  } catch (e) {
    console.error('founding offer count failed:', e.message);
    return false; // fail closed — never grant the discount if we can't verify eligibility
  }
  return (FOUNDING_CAP - claimed) > 0 && Date.now() < new Date(FOUNDING_CUTOFF).getTime();
}

async function handleCheckout(env, request) {
  let tier, billing, trial, promoId, userId;
  try {
    ({ tier, billing, trial, promoId, userId } = await request.json());
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const isFounding = tier === 'founding_member';

  // Re-check eligibility server-side — never trust the client's claim that
  // the offer is still active. A cached page or a direct API call after
  // the 500th spot (or past the cutoff date) must not still get $1.99/mo.
  if (isFounding) {
    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: 'Founding Member offer is not available right now.' }, 400);
    }
    const stillActive = await isFoundingOfferActive(env.SUPABASE_SERVICE_ROLE_KEY);
    if (!stillActive) {
      return json({ error: 'The Founding Member offer has ended.' }, 400);
    }
  }

  const PRICES = {
    pro_monthly:            env.STRIPE_PRICE_PRO_MONTHLY,
    pro_annual:             env.STRIPE_PRICE_PRO_ANNUAL,
    founding_member_monthly: env.STRIPE_PRICE_FOUNDING,
  };

  const priceId = PRICES[`${tier}_${billing}`];
  if (!priceId) {
    return json({ error: `No price configured for ${tier}/${billing}` }, 400);
  }

  const isTrialSession = trial === true && (tier === 'pro' || isFounding);
  const origin          = new URL(request.url).origin;

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
  // Founding Member pricing is already the discount — no stacking with
  // separate promo codes.
  if (isFounding) {
    // no-op — leave both discount params unset
  } else if (promoId) {
    params.set('discounts[0][promotion_code]', promoId);
  } else {
    params.set('allow_promotion_codes', 'true');
  }

  if (isTrialSession) {
    params.set('subscription_data[trial_period_days]', '5');
    params.set('payment_method_collection', 'always');
  }

  // Pass userId so webhook can update profile on completion
  if (userId) {
    params.set('client_reference_id', userId);
    params.set('subscription_data[metadata][user_id]', userId);
  }

  if (isFounding) {
    // Session-level metadata is always present in the checkout.session.completed
    // webhook payload (unlike line items, which need expansion) — this is what
    // the webhook uses to know to record the claim.
    params.set('metadata[founding_member]', 'true');
    params.set('subscription_data[metadata][founding_member]', 'true');
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
