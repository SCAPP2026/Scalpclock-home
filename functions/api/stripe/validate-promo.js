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

  let code, userId;
  try {
    ({ code, userId } = await request.json());
  } catch {
    return json({ valid: false, error: 'Invalid request' }, 400);
  }

  if (!code || typeof code !== 'string') {
    return json({ valid: false, error: 'No code provided' }, 400);
  }

  // If we have a userId, check if this user already redeemed a promo
  if (userId) {
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=promo_redeemed`,
      {
        headers: {
          apikey:        env.SUPABASE_SERVICE_KEY || '',
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY || ''}`,
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
  }

  // Validate the code with Stripe
  const res = await fetch(
    `https://api.stripe.com/v1/promotion_codes?code=${encodeURIComponent(code.trim().toUpperCase())}&active=true&limit=1`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );

  const data = await res.json();

  if (!res.ok) {
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
    if (coupon.duration === 'once')       discountText += ' your first month';
    else if (coupon.duration === 'repeating') discountText += ` for ${coupon.duration_in_months} months`;
    else discountText += ' forever';
  } else if (coupon.amount_off) {
    discountText = `$${(coupon.amount_off / 100).toFixed(2)} off`;
    if (coupon.duration === 'once') discountText += ' your first month';
  }

  return json({
    valid:        true,
    promoId:      promo.id,
    discountText,
    percentOff:   coupon.percent_off || null,
    amountOff:    coupon.amount_off  || null,
    duration:     coupon.duration,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
