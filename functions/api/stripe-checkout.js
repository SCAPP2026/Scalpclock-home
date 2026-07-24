export async function onRequestPost(context) {
  const { env, request } = context;
  const STRIPE_KEY = env.STRIPE_KEY;
  const STRIPE_PRODUCT_ID = env.STRIPE_PRODUCT_ID;

  if (!STRIPE_KEY || !STRIPE_PRODUCT_ID) {
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const authHeader = { Authorization: `Bearer ${STRIPE_KEY}` };

  // Look up the active price for this product
  const pricesRes = await fetch(
    `https://api.stripe.com/v1/prices?product=${STRIPE_PRODUCT_ID}&active=true&limit=1`,
    { headers: authHeader }
  );
  const pricesData = await pricesRes.json();
  const price = pricesData.data?.[0];

  if (!price) {
    return new Response(JSON.stringify({ error: 'No active price found for this product' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const origin = new URL(request.url).origin;
  const mode = price.recurring ? 'subscription' : 'payment';

  const body = new URLSearchParams({
    mode,
    'payment_method_types[]': 'card',
    'line_items[0][price]': price.id,
    'line_items[0][quantity]': '1',
    success_url: `${origin}/dashboard?upgraded=1`,
    cancel_url: `${origin}/dashboard`,
  });

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      ...authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const session = await res.json();

  if (session.error) {
    return new Response(JSON.stringify({ error: session.error.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  return new Response(JSON.stringify({ url: session.url }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
