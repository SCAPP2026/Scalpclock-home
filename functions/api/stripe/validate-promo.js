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
    console.error('validate-promo fatal:', e.message, e.stack);
    return json({ valid: false, error: `Internal error: ${e.message}` }, 500);
  }
}

async function stripeGet(path, env) {
  const res  = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
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

  const normalizedCode = code.trim().toUpperCase();

  // Check Supabase: has this user already redeemed?
  if (userId && env.SUPABASE_SERVICE_KEY) {
    try {
      const sbRes  = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=promo_redeemed`,
        {
          headers: {
            apikey:         env.SUPABASE_SERVICE_KEY,
            Authorization:  `Bearer ${env.SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );
      const sbData = await sbRes.json();
      console.log('Supabase result:', JSON.stringify(sbData));

      if (sbRes.ok && sbData?.[0]?.promo_redeemed === true) {
        return json({
          valid: false,
          error: 'You have already redeemed your free month.',
          alreadyRedeemed: true,
        });
      }
    } catch (e) {
      console.error('Supabase check failed:', e.message);
    }
  }

  // 1. Look up the promotion code
  const promoLookup = await stripeGet(
    `/promotion_codes?code=${encodeURIComponent(normalizedCode)}&active=true&limit=1`,
    env
  );
  console.log('Stripe promo lookup status:', promoLookup.status, 'data:', JSON.stringify(promoLookup.data));

  if (!promoLookup.ok) {
    return json({ valid: false, error: 'Could not reach Stripe. Try again.' }, 502);
  }

  const promoList = promoLookup.data?.data;
  if (!Array.isArray(promoList) || promoList.length === 0) {
    return json({ valid: false, error: 'Invalid or expired promotion code.' });
  }

  const promo = promoList[0];
  console.log('Promo object:', JSON.stringify(promo));

  // 2. Resolve coupon — may be a full object or just an ID string
  let coupon = null;
  if (promo.coupon && typeof promo.coupon === 'object') {
    coupon = promo.coupon;
    console.log('Coupon already expanded:', JSON.stringify(coupon));
  } else if (typeof promo.coupon === 'string') {
    // Stripe returned just the coupon ID — fetch it explicitly
    const couponLookup = await stripeGet(`/coupons/${promo.coupon}`, env);
    console.log('Coupon fetch status:', couponLookup.status, 'data:', JSON.stringify(couponLookup.data));
    if (couponLookup.ok) coupon = couponLookup.data;
  }

  if (!coupon || typeof coupon !== 'object') {
    console.error('Could not resolve coupon for promo:', promo.id, 'coupon field:', promo.coupon);
    return json({ valid: false, error: 'Promotion code is not valid. Please contact support.' });
  }

  // 3. Build response fields
  const percentOff     = coupon.percent_off       ?? null;
  const amountOff      = coupon.amount_off        ?? null;
  const duration       = coupon.duration          ?? null;
  const durationMonths = coupon.duration_in_months ?? null;
  const maxRedemptions = promo.max_redemptions    ?? null;
  const redeemedCount  = promo.times_redeemed     ?? 0;
  const expiresAt      = promo.expires_at         ?? null;

  let discountText = '';
  if (percentOff === 100 && duration === 'once') {
    discountText = 'First month FREE';
  } else if (percentOff) {
    discountText = `${percentOff}% off`;
    if (duration === 'once')            discountText += ' your first month';
    else if (duration === 'repeating')  discountText += ` for ${durationMonths} months`;
    else                                discountText += ' forever';
  } else if (amountOff) {
    discountText = `$${(amountOff / 100).toFixed(2)} off`;
    if (duration === 'once') discountText += ' your first month';
  }

  return json({
    valid:          true,
    promoId:        promo.id,
    code:           promo.code,
    discountText,
    percentOff,
    amountOff,
    duration,
    durationMonths,
    maxRedemptions,
    redeemedCount,
    expiresAt,
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
