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
    headers: {
      Authorization:    `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2023-10-16',
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  console.log(`Stripe GET ${path} → ${res.status}:`, JSON.stringify(data));
  return { ok: res.ok, status: res.status, data };
}

async function handleValidatePromo(env, request) {
  let code, userId;
  try {
    ({ code, userId } = await request.json());
  } catch {
    return json({ valid: false, error: 'Invalid request body' }, 400);
  }

  if (!code || typeof code !== 'string') {
    return json({ valid: false, error: 'No code provided' }, 400);
  }

  const normalizedCode = code.trim().toUpperCase();

  // ── Supabase: block repeat redemption ───────────────────────────────────
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
      console.log('Supabase promo_redeemed:', JSON.stringify(sbData));
      if (sbRes.ok && sbData?.[0]?.promo_redeemed === true) {
        return json({ valid: false, error: 'You have already redeemed your free month.', alreadyRedeemed: true });
      }
    } catch (e) {
      console.error('Supabase check error:', e.message);
    }
  }

  // ── Step 1: list promotion codes by code string ─────────────────────────
  const listResult = await stripeGet(
    `/promotion_codes?code=${encodeURIComponent(normalizedCode)}&limit=5`,
    env
  );

  if (!listResult.ok) {
    return json({ valid: false, error: `Stripe error ${listResult.status}. Please try again.` }, 502);
  }

  const promoList = listResult.data?.data;
  if (!Array.isArray(promoList) || promoList.length === 0) {
    return json({ valid: false, error: 'Promotion code not found.' });
  }

  // Find an active one (don't filter at API level so we can give a better error if inactive)
  const promo = promoList.find(p => p.active !== false) ?? promoList[0];
  console.log('Selected promo:', JSON.stringify(promo));

  if (!promo.active) {
    return json({ valid: false, error: 'This promotion code has expired or is no longer active.' });
  }

  // ── Step 2: fetch promo by ID with coupon expanded ───────────────────────
  // (list endpoint may omit the coupon object in newer API versions)
  const detailResult = await stripeGet(
    `/promotion_codes/${promo.id}?expand[]=coupon`,
    env
  );

  const detail = detailResult.ok ? detailResult.data : promo;
  console.log('Promo detail:', JSON.stringify(detail));

  // ── Step 3: resolve the coupon / discount descriptor ────────────────────
  let coupon = null;

  if (detail.coupon && typeof detail.coupon === 'object') {
    coupon = detail.coupon;
    console.log('Coupon from detail.coupon:', JSON.stringify(coupon));
  } else if (typeof detail.coupon === 'string') {
    const cr = await stripeGet(`/coupons/${detail.coupon}`, env);
    if (cr.ok) { coupon = cr.data; console.log('Coupon fetched by ID:', JSON.stringify(coupon)); }
  }

  // Newer Stripe format: discount info may live under detail.promotion
  if (!coupon && detail.promotion && typeof detail.promotion === 'object') {
    coupon = detail.promotion;
    console.log('Using detail.promotion as coupon:', JSON.stringify(coupon));
  }

  // ── Step 4: if still no coupon object, try fetching the coupon list ─────
  if (!coupon) {
    console.warn('Could not resolve coupon. Promo detail keys:', Object.keys(detail));
    return json({
      valid: false,
      error: 'Could not retrieve discount details. Please contact support.',
      _debug: { promoId: promo.id, detailKeys: Object.keys(detail), promotionField: detail.promotion },
    });
  }

  // ── Step 5: build response ───────────────────────────────────────────────
  const percentOff     = coupon.percent_off       ?? null;
  const amountOff      = coupon.amount_off        ?? null;
  const duration       = coupon.duration          ?? null;
  const durationMonths = coupon.duration_in_months ?? null;
  const maxRedemptions = promo.max_redemptions    ?? detail.max_redemptions ?? null;
  const redeemedCount  = promo.times_redeemed     ?? detail.times_redeemed  ?? 0;
  const expiresAt      = promo.expires_at         ?? detail.expires_at      ?? null;

  let discountText = 'Discount applied';
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
