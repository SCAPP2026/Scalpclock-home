const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    return await handleValidatePromo(env, request);
  } catch (e) {
    console.error('validate-promo fatal:', e);
    return json({ valid: false, error: `Internal error: ${e.message}` }, 500);
  }
}

async function handleValidatePromo(env, request) {
  let code, userId;
  try {
    ({ code, userId } = await request.json());
  } catch (e) {
    return json({ valid: false, error: 'Invalid request body' }, 400);
  }

  if (!code || typeof code !== 'string') {
    return json({ valid: false, error: 'No code provided' }, 400);
  }

  // Check if this user already redeemed a promo
  if (userId && env.SUPABASE_SERVICE_KEY) {
    try {
      const sbRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=promo_redeemed`,
        {
          headers: {
            apikey:         env.SUPABASE_SERVICE_KEY,
            Authorization:  `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );
      if (sbRes.ok) {
        const rows = await sbRes.json();
        if (rows?.[0]?.promo_redeemed === true) {
          return json({
            valid: false,
            error: 'You have already redeemed your free month.',
            alreadyRedeemed: true,
          });
        }
      }
    } catch (e) {
      console.error('Supabase promo check failed:', e.message);
    }
  }

  // Validate the code with Stripe
  const stripeRes = await fetch(
    `https://api.stripe.com/v1/promotion_codes?code=${encodeURIComponent(code.trim().toUpperCase())}&active=true&limit=1`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );

  const data = await stripeRes.json();

  if (!stripeRes.ok) {
    console.error('Stripe promo lookup error:', data.error);
    return json({ valid: false, error: 'Could not validate code. Please try again.' }, 502);
  }

  const promo = data.data?.[0];

  if (!promo) {
    return json({ valid: false, error: 'Invalid or expired promotion code.' });
  }

  const coupon = promo.coupon;
  let discountText = '';
  if (coupon.percent_off === 100 && coupon.duration === 'once') {
    discountText = 'First month FREE';
  } else if (coupon.percent_off) {
    discountText = `${coupon.percent_off}% off`;
    if (coupon.duration === 'once')            discountText += ' your first month';
    else if (coupon.duration === 'repeating')  discountText += ` for ${coupon.duration_in_months} months`;
    else                                       discountText += ' forever';
  } else if (coupon.amount_off) {
    discountText = `$${(coupon.amount_off / 100).toFixed(2)} off`;
    if (coupon.duration === 'once') discountText += ' your first month';
  }

  return json({
    valid:       true,
    promoId:     promo.id,
    discountText,
    percentOff:  coupon.percent_off || null,
    amountOff:   coupon.amount_off  || null,
    duration:    coupon.duration,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
