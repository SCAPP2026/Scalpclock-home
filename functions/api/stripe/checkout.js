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

// Same kill switch, cap, and cutoff as functions/api/founding-status.js —
// duplicated rather than imported so this file has zero cross-file
// dependency risk for billing-critical code. Keep all three in sync.
const FOUNDING_ACTIVE_OVERRIDE = true;
const FOUNDING_CAP    = 500;
const FOUNDING_CUTOFF = '2026-12-01T23:59:59Z';

// Returns { active, reason } instead of a bare boolean so the caller can show
// the specific "spots are full" copy the cap case needs, rather than a single
// generic "offer has ended" message for every reason it might be inactive.
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
    return { active: false, reason: 'lookup_failed' }; // fail closed — never grant the discount if we can't verify eligibility
  }
  if (!FOUNDING_ACTIVE_OVERRIDE) return { active: false, reason: 'killed' };
  if ((FOUNDING_CAP - claimed) <= 0) return { active: false, reason: 'cap' };
  if (Date.now() >= new Date(FOUNDING_CUTOFF).getTime()) return { active: false, reason: 'cutoff' };
  return { active: true, reason: null };
}

const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';

// Non-terminal Stripe subscription statuses — a subscription in any of
// these states is still "live" in Stripe and should be fixed up (payment
// method updated, retried, or explicitly cancelled) rather than shadowed by
// a brand new one for the same user.
const BLOCKING_STATUSES = new Set(['trialing', 'active', 'past_due', 'unpaid']);

// Searches Stripe directly for any subscription tied to this user, rather
// than trusting Supabase's cached app_metadata.stripe_sub_id -- that pointer
// can go stale (webhook race, manual fix, migration bug, ...) and a stale
// pointer here means this guard silently checks the wrong subscription and
// lets a duplicate through. Every checkout session this app creates sets
// subscription_data[metadata][user_id], so a Stripe-side search is the
// authoritative source regardless of what Supabase currently has on file.
// (Stripe's Search API is eventually consistent -- typically indexed within
// seconds, occasionally longer -- same tradeoff the old lookup had anyway.)
async function findBlockingSubscription(userId, stripeSecretKey) {
  if (!stripeSecretKey) return null;
  try {
    const query = `metadata['user_id']:'${userId}'`;
    const searchRes = await fetch(
      `https://api.stripe.com/v1/subscriptions/search?query=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${stripeSecretKey}` } }
    );
    if (!searchRes.ok) return null;
    const { data: subs } = await searchRes.json();
    if (!Array.isArray(subs) || subs.length === 0) return null;

    const blocking = subs.find(sub => BLOCKING_STATUSES.has(sub.status));
    if (!blocking) return null;

    return blocking.status === 'trialing' || blocking.status === 'active'
      ? 'You already have an active subscription on this account.'
      : 'Your existing subscription has a payment issue rather than being cancelled. Email support@scalpclock.com to update your payment method — please don’t create a new subscription, as it won’t cancel the old one.';
  } catch (e) {
    console.error('findBlockingSubscription failed:', e.message);
    return null; // fail open — never block checkout over an internal lookup error
  }
}

async function handleCheckout(env, request) {
  let tier, billing, trial, promoId, userId, gaClientId, source, referredByCode;
  try {
    ({ tier, billing, trial, promoId, userId, gaClientId, source, referredByCode } = await request.json());
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const isFounding = tier === 'founding_member';

  // A checkout session with no userId can never be linked back to a Supabase
  // account (activate.js and the webhook both require client_reference_id to
  // set app_metadata.plan). Without this gate, a user who pays before they're
  // signed in gets charged but their account never unlocks — they land back
  // on /dashboard's session check, which bounces them to /login, and it reads
  // as "I paid and now I can't log in." Fail closed instead of silently
  // taking payment for an account we can't activate.
  if (!userId) {
    return json({ error: 'Please sign in or create a free account first, then choose your plan.' }, 400);
  }

  // Block creating a second Stripe subscription for a user who already has
  // one on file. Without this, a user whose account reads 'expired' (e.g.
  // trial-end renewal charge failed or is still being retried by Stripe)
  // could repurchase from /pricing and end up with two live subscriptions
  // for the same account — the original keeps running in Stripe and the
  // dashboard/app_metadata only ever tracks one stripe_sub_id, so the first
  // one silently orphans instead of being cancelled. Only blocks on
  // non-terminal statuses; a genuinely canceled/incomplete_expired prior
  // subscription must not block a fresh signup.
  {
    const blockMsg = await findBlockingSubscription(userId, env.STRIPE_SECRET_KEY);
    if (blockMsg) return json({ error: blockMsg }, 409);
  }

  // Re-check eligibility server-side — never trust the client's claim that
  // the offer is still active. A cached page or a direct API call after
  // the 500th spot (or past the cutoff date) must not still get $1.99/mo.
  if (isFounding) {
    if (!env.SUPABASE_SERVICE_ROLE_KEY) {
      return json({ error: 'Founding Member offer is not available right now.' }, 400);
    }
    const { active: stillActive, reason } = await isFoundingOfferActive(env.SUPABASE_SERVICE_ROLE_KEY);
    if (!stillActive) {
      const message = reason === 'cap'
        ? 'Founding Member spots are full. The first 500 Founders have already claimed the $1.99 lifetime Founder rate.'
        : 'The Founding Member offer has ended.';
      return json({ error: message }, 400);
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

  // Trials were removed sitewide in 2026-09, then reintroduced (2026-09-21)
  // as an explicit CUSTOMER CHOICE on top of the founding_member tier only
  // — Pro checkout stays trial-less regardless of what's sent (isFounding
  // gates that below). There are now two distinct ways to become a Founding
  // Member, both hitting this same tier: the Founding Member card charges
  // $1.99 immediately (trial:false — the pricing.html/index.html CTA still
  // hardcodes this), and the Free card's "Start 3-Day Free Trial" button
  // sends trial:true. Trusting the client's `trial` flag here is safe
  // (unlike the 2026-08 bug that removed this) because the 500-cap is
  // enforced atomically in webhook.js regardless of trial choice — a
  // trial claims its Founder slot at conversion, a non-trial claims it
  // immediately, but neither can ever bypass the cap.
  const FOUNDING_TRIAL_DAYS = 3;
  const isTrialSession = isFounding && trial === true;
  const origin          = new URL(request.url).origin;

  const successUrl = `${origin}/success?session_id={CHECKOUT_SESSION_ID}` +
    (isTrialSession ? '&trial=1' : '') +
    (isFounding ? '&founding=1' : '');

  // Tags the cancel redirect with which tier was abandoned so pricing.html
  // can fire the matching founder_checkout_cancelled / pro_checkout_cancelled
  // analytics event (Phase 14) — purely a query param for client-side
  // tracking, never trusted for anything security- or billing-relevant.
  const cancelUrl = `${origin}/pricing?checkout_cancelled=${isFounding ? 'founding_member' : 'pro'}`;

  const params = new URLSearchParams({
    'line_items[0][price]':    priceId,
    'line_items[0][quantity]': '1',
    mode:                      'subscription',
    success_url:               successUrl,
    cancel_url:                cancelUrl,
  });

  // Card is required upfront (not deferred) so Stripe can auto-charge the
  // $1.99 the moment the trial ends without a second checkout step — the
  // Founder slot itself is NOT claimed here (see webhook.js's
  // invoice.payment_succeeded handler); this only affects billing.
  if (isTrialSession) {
    params.set('subscription_data[trial_period_days]', String(FOUNDING_TRIAL_DAYS));
    params.set('payment_method_collection', 'always');
  }

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

  // Session-level metadata is always present on the checkout.session.completed
  // webhook payload (unlike subscription_data metadata, which needs the
  // subscription itself). The webhook and activate.js both read this instead
  // of re-deriving trial status, so there is exactly one place (here) that
  // decides whether a session has a trial.
  params.set('metadata[trial]', isTrialSession ? '1' : '0');

  // Pass userId so webhook can update profile on completion
  if (userId) {
    params.set('client_reference_id', userId);
    params.set('subscription_data[metadata][user_id]', userId);
  }

  // GA4 client_id (from the browser's _ga cookie, if present) so the
  // webhook can attribute the eventual `purchase` event back to the
  // visitor's actual acquisition/session data instead of firing as an
  // anonymous server-side event. Best-effort — checkout must never fail
  // because analytics attribution is missing.
  if (gaClientId && /^[\w.-]{1,80}$/.test(gaClientId)) {
    params.set('metadata[ga_client_id]', gaClientId);
  }

  // Referral attribution: normally captured once at signup into
  // user_metadata.referred_by_code (see login.html + webhook.js's
  // recordReferralIfAttributed). This is the fallback path for a visitor
  // who already had an account before ever seeing a referral link -- the
  // scalpclock_ref cookie set by /r/CODE is forwarded from checkout too, so
  // the webhook can still attribute at the moment they actually pay.
  // Session-level metadata (not subscription_data) so it's directly present
  // on the checkout.session.completed payload without a second Stripe call
  // -- same reasoning as trial/founding_member/ga_client_id above. Only
  // sanitized codes reach Stripe metadata; an invalid one is silently
  // dropped rather than erroring the checkout.
  if (referredByCode && /^[A-Za-z0-9]{1,12}$/.test(referredByCode)) {
    params.set('metadata[referred_by_code]', referredByCode.toUpperCase());
  }

  if (isFounding) {
    // Session-level metadata is always present in the checkout.session.completed
    // webhook payload (unlike line items, which need expansion) — this is what
    // the webhook uses to know to record the claim.
    params.set('metadata[founding_member]', 'true');
    params.set('subscription_data[metadata][founding_member]', 'true');
  }

  // Explicit plan_type + acquisition source on every session, independent of
  // the founding_member flag above — lets the Phase 13 recovery report (see
  // functions/api/admin/pricing-recovery.js) identify which checkout surface
  // a purchase came through (pricing page vs. an in-app paywall) without
  // having to infer it. `source` is caller-supplied, sanitized to a small
  // known allowlist so an arbitrary client value can't pollute metadata.
  const ALLOWED_SOURCES = new Set(['pricing_page', 'signals_paywall', 'dashboard_paywall', 'settings_upgrade', 'homepage']);
  const safeSource = ALLOWED_SOURCES.has(source) ? source : 'unknown';
  params.set('metadata[plan_type]', isFounding ? 'founding_member' : 'pro');
  params.set('metadata[source]', safeSource);
  params.set('metadata[checkout_version]', 'founder-guard-v1');

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
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
