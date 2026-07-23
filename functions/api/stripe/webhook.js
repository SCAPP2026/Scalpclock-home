const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';
const GA4_MEASUREMENT_ID = 'G-M4F7X9HDDW'; // same public ID used by gtag.js on every page

// Server-side GA4 event via the Measurement Protocol. Best-effort — never
// throws, so a missing/misconfigured GA4_API_SECRET or an analytics-side
// outage can never block a real billing event from completing.
async function sendGA4Event(env, clientId, name, params) {
  if (!env.GA4_API_SECRET) return;
  try {
    await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${GA4_MEASUREMENT_ID}&api_secret=${env.GA4_API_SECRET}`,
      {
        method: 'POST',
        body: JSON.stringify({
          // Falls back to a fresh random client_id (not tied to any real
          // visitor) when the checkout session has no ga_client_id — still
          // records the conversion in GA4's totals, just without session
          // attribution back to the original visit.
          client_id: clientId || crypto.randomUUID(),
          events: [{ name, params }],
        }),
      }
    );
  } catch (e) {
    console.error('GA4 event failed:', name, e.message);
  }
}

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body      = await request.text();
  const sigHeader = request.headers.get('stripe-signature');

  if (!sigHeader || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response('Missing signature', { status: 400 });
  }

  const valid = await verifyStripeSignature(body, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return new Response('Invalid signature', { status: 400 });
  }

  const event = JSON.parse(body);

  switch (event.type) {

    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId  = session.client_reference_id;
      const isFounding = session.metadata?.founding_member === 'true';

      console.log('Checkout completed:', session.customer_email, 'subscription:', session.subscription, 'founding:', isFounding);

      if (userId && env.SUPABASE_SERVICE_ROLE_KEY) {
        // All new subscriptions start with a trial period, so mark 'trial'
        // customer.subscription.updated will promote to 'pro' when trial ends
        const hasPromo = Array.isArray(session.discounts) && session.discounts.length > 0;
        const patch = {
          id:             userId,
          plan:           'trial',
          stripe_sub_id:  session.subscription || null,
        };
        if (hasPromo) patch.promo_redeemed = true;
        if (isFounding) patch.founding_member = true;

        await upsertProfile(userId, patch, env.SUPABASE_SERVICE_ROLE_KEY);
      }

      // Record the claim — this is what actually decrements the live
      // "spots remaining" count (functions/api/founding-status.js counts
      // rows in this table). checkout.js already re-verified eligibility
      // server-side before creating this session, so no need to re-check
      // the cap here — just record it.
      if (isFounding && env.SUPABASE_SERVICE_ROLE_KEY) {
        await recordFoundingMember(userId, session.subscription, env.SUPABASE_SERVICE_ROLE_KEY);
      }

      // Referral attribution — checked for EVERY paying user, not just
      // founders, since the referred person doesn't need to be a founder
      // themselves, only signed up via one's link.
      if (userId && env.SUPABASE_SERVICE_ROLE_KEY) {
        await recordReferralIfAttributed(userId, env.SUPABASE_SERVICE_ROLE_KEY);
      }

      // Real conversion tracking. Fired server-side (not from the client
      // after Stripe redirect) because a user can close the tab, get
      // interrupted by their bank's 3DS challenge, etc. between paying and
      // returning to /success — client-side purchase events silently miss
      // exactly the sessions most worth measuring accurately.
      await sendGA4Event(env, session.metadata?.ga_client_id, 'purchase', {
        transaction_id: session.id,
        value:          session.amount_total != null ? session.amount_total / 100 : undefined,
        currency:       session.currency ? session.currency.toUpperCase() : 'USD',
        items: [{
          item_id:   isFounding ? 'founding_member' : 'pro',
          item_name: isFounding ? 'Founding Member' : 'Pro',
        }],
      });
      break;
    }

    case 'customer.subscription.updated': {
      const sub    = event.data.object;
      const userId = sub.metadata?.user_id;

      console.log('Subscription updated:', sub.id, 'status:', sub.status, 'user:', userId);

      if (userId && env.SUPABASE_SERVICE_ROLE_KEY) {
        let plan;
        if (sub.status === 'trialing')   plan = 'trial';
        else if (sub.status === 'active') plan = 'pro';
        else if (sub.status === 'past_due' || sub.status === 'unpaid') plan = 'expired';
        else if (sub.status === 'canceled') plan = 'free';

        if (plan) {
          await upsertProfile(userId, { id: userId, plan }, env.SUPABASE_SERVICE_ROLE_KEY);
        }
      }
      break;
    }

    case 'customer.subscription.trial_will_end': {
      const sub = event.data.object;
      console.log('Trial ending soon for customer:', sub.customer,
        'trial ends:', new Date(sub.trial_end * 1000).toISOString());
      break;
    }

    case 'customer.subscription.deleted': {
      const sub    = event.data.object;
      const userId = sub.metadata?.user_id;
      console.log('Subscription cancelled:', sub.id, sub.customer, 'user:', userId);

      if (userId && env.SUPABASE_SERVICE_ROLE_KEY) {
        await upsertProfile(userId, { id: userId, plan: 'expired' }, env.SUPABASE_SERVICE_ROLE_KEY);
      }
      break;
    }

    case 'invoice.payment_failed': {
      const inv    = event.data.object;
      const userId = inv.subscription_details?.metadata?.user_id;
      console.log('Payment failed:', inv.customer_email, inv.id, 'user:', userId);

      if (userId && env.SUPABASE_SERVICE_ROLE_KEY) {
        await upsertProfile(userId, { id: userId, plan: 'expired' }, env.SUPABASE_SERVICE_ROLE_KEY);
        await setReferralStatus(userId, 'inactive', env.SUPABASE_SERVICE_ROLE_KEY);
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      const inv    = event.data.object;
      const userId = inv.subscription_details?.metadata?.user_id;
      console.log('Payment succeeded:', inv.customer_email, inv.id, 'user:', userId, 'amount_paid:', inv.amount_paid);

      if (userId && env.SUPABASE_SERVICE_ROLE_KEY) {
        // Resumes the dashboard's "active" display after a prior failure —
        // does not itself gate commission creation.
        await setReferralStatus(userId, 'active', env.SUPABASE_SERVICE_ROLE_KEY);

        // $0 trial invoices must never create a commission.
        if (inv.amount_paid > 0) {
          await createReferralCommission(userId, inv.id, env.SUPABASE_SERVICE_ROLE_KEY);
        }
      }
      break;
    }

  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// Update Supabase auth app_metadata — no profiles table needed, service role bypasses RLS.
// Fetches the current app_metadata first and merges client-side rather than trusting
// the admin API to deep-merge on our behalf — a plan-only patch (e.g. trial→pro on
// customer.subscription.updated) must never silently drop founding_member/stripe_sub_id
// that an earlier event already set.
async function upsertProfile(userId, patch, serviceKey) {
  try {
    let existing = {};
    try {
      const getRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (getRes.ok) {
        const userData = await getRes.json();
        existing = (userData?.user?.app_metadata || userData?.app_metadata) || {};
      }
    } catch (e) {
      console.error('Failed to fetch existing app_metadata:', e.message);
    }

    const appMeta = { ...existing };
    if (patch.plan          !== undefined) appMeta.plan          = patch.plan;
    if (patch.stripe_sub_id !== undefined) appMeta.stripe_sub_id = patch.stripe_sub_id;
    if (patch.promo_redeemed !== undefined) appMeta.promo_redeemed = patch.promo_redeemed;
    if (patch.founding_member !== undefined) appMeta.founding_member = patch.founding_member;

    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method:  'PUT',
      headers: {
        apikey:         serviceKey,
        Authorization:  `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ app_metadata: appMeta }),
    });
    console.log('Auth user updated for:', userId, 'app_metadata:', JSON.stringify(appMeta), 'status:', r.status);
    if (!r.ok) {
      const text = await r.text();
      console.error('Auth update error:', text);
    }
  } catch (e) {
    console.error('Failed to update auth user:', e.message);
  }
}

// Unambiguous alphabet (no 0/O/1/I/L confusion) for founder referral codes.
function generateReferralCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

// Insert-only — no upsert/uniqueness needed since each checkout.session.completed
// event fires once per new subscription. This row is purely what
// functions/api/founding-status.js counts to compute spots remaining. Also
// assigns the referral program's founder_number (a DB column default pulling
// from a Postgres sequence — race-safe under concurrent webhook deliveries,
// no count-then-increment) and a unique referral_code.
async function recordFoundingMember(userId, subscriptionId, serviceKey) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateReferralCode();
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/founding_members`, {
        method:  'POST',
        headers: {
          apikey:         serviceKey,
          Authorization:  `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          Prefer:         'return=representation',
        },
        body: JSON.stringify({
          user_id:                userId || null,
          stripe_subscription_id: subscriptionId || null,
          referral_code:          code,
        }),
      });
      if (r.ok) {
        const rows = await r.json().catch(() => []);
        const row  = Array.isArray(rows) ? rows[0] : null;
        console.log('Founding member recorded for:', userId, 'referral_code:', code, 'founder_number:', row?.founder_number);
        return;
      }
      const text = await r.text();
      // referral_code is UNIQUE — a collision is vanishingly rare with a
      // 7-char/32-symbol code, but retry with a fresh code rather than fail
      // the whole checkout completion over it.
      if (r.status === 409 && attempt < 2) {
        console.warn('referral_code collision, retrying:', text);
        continue;
      }
      console.error('founding_members insert error:', r.status, text);
      return;
    } catch (e) {
      console.error('Failed to record founding member:', e.message);
      return;
    }
  }
}

// If this newly-paying user signed up via a founder's referral link/code
// (captured client-side at signup into user_metadata.referred_by_code — see
// login.html), record the referral now, at verified payment, rather than
// trusting user_metadata at signup time (it's client-writable, so it isn't
// safe to treat as commission-bearing truth until real money has moved).
async function recordReferralIfAttributed(referredUserId, serviceKey) {
  try {
    const getRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${referredUserId}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!getRes.ok) return;
    const userData = await getRes.json();
    const userMeta = (userData?.user?.user_metadata || userData?.user_metadata) || {};
    const code = userMeta.referred_by_code;
    if (!code || typeof code !== 'string') return;

    const founderRes = await fetch(
      `${SUPABASE_URL}/rest/v1/founding_members?referral_code=eq.${encodeURIComponent(code)}&select=user_id`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    const founders   = await founderRes.json().catch(() => []);
    const referrerId = Array.isArray(founders) && founders[0]?.user_id;
    if (!referrerId) { console.warn('Referral code not found:', code); return; }

    if (referrerId === referredUserId) {
      console.warn('Self-referral blocked for user:', referredUserId);
      return;
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/referrals`, {
      method:  'POST',
      headers: {
        apikey:         serviceKey,
        Authorization:  `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        // referred_user_id is UNIQUE — a subscriber can only ever be
        // attributed to one referrer, ever. A redelivered webhook (or any
        // other double-fire) silently no-ops here instead of erroring.
        // return=representation (not minimal) so we can tell a genuine new
        // insert apart from a suppressed duplicate — only a genuine insert
        // should fire a notification/milestone check below.
        Prefer:         'resolution=ignore-duplicates,return=representation',
      },
      body: JSON.stringify({
        referrer_id:      referrerId,
        referred_user_id: referredUserId,
        referral_code:    code,
      }),
    });
    if (!insertRes.ok) {
      const text = await insertRes.text();
      console.error('referrals insert error:', insertRes.status, text);
      return;
    }
    const inserted = await insertRes.json().catch(() => []);
    if (!Array.isArray(inserted) || inserted.length === 0) return; // duplicate, already recorded
    console.log('Referral recorded:', referrerId, '->', referredUserId, 'code:', code);

    await createNotification(referrerId, 'new_referral', '🎉 New Referral', 'Someone just joined ScalpClock through your link.', serviceKey);
    await maybeNotifyMilestone(referrerId, serviceKey);
  } catch (e) {
    console.error('recordReferralIfAttributed failed:', e.message);
  }
}

// Flips a referred subscriber's referral row between active/inactive on
// payment success/failure — display-only, does not gate commission logic
// (commissions simply stop being created when payments stop succeeding).
async function setReferralStatus(referredUserId, status, serviceKey) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/referrals?referred_user_id=eq.${referredUserId}`, {
      method:  'PATCH',
      headers: {
        apikey:         serviceKey,
        Authorization:  `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer:         'return=minimal',
      },
      body: JSON.stringify({ status }),
    });
    if (!r.ok) {
      const text = await r.text();
      console.error('referrals status update error:', r.status, text);
    }
  } catch (e) {
    console.error('setReferralStatus failed:', e.message);
  }
}

// Reads the CURRENT commission rate at the moment of payment (never stored
// on the referral row itself) so existing referrals automatically jump from
// $1.00 to $1.99/mo the instant the 500th founding spot fills — no backfill
// needed. Returns null (meaning: create no commission) if the program is
// disabled or settings can't be read — fails closed.
async function getCurrentCommissionRate(serviceKey) {
  try {
    const settingsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_program_settings?id=eq.1&select=*`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    const rows     = await settingsRes.json().catch(() => []);
    const settings = Array.isArray(rows) ? rows[0] : null;
    if (!settings || settings.referral_program_enabled === false) return null;

    // Same live-COUNT idiom as functions/api/founding-status.js.
    const countRes = await fetch(`${SUPABASE_URL}/rest/v1/founding_members?select=id`, {
      headers: {
        apikey:        serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer:        'count=exact',
        Range:         '0-0',
      },
    });
    const range   = countRes.headers.get('content-range'); // "0-0/N"
    const claimed = range ? (parseInt(range.split('/')[1], 10) || 0) : 0;

    return claimed >= settings.founding_member_limit
      ? settings.commission_rate_post_cap
      : settings.commission_rate_pre_cap;
  } catch (e) {
    console.error('getCurrentCommissionRate failed:', e.message);
    return null;
  }
}

// Creates one referral_commissions row for a successful recurring payment.
// stripe_invoice_id is UNIQUE, so Stripe's at-least-once webhook redelivery
// can never double-pay the same invoice.
async function createReferralCommission(referredUserId, invoiceId, serviceKey) {
  try {
    const refRes = await fetch(
      `${SUPABASE_URL}/rest/v1/referrals?referred_user_id=eq.${referredUserId}&select=referrer_id`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    const refs       = await refRes.json().catch(() => []);
    const referrerId = Array.isArray(refs) && refs[0]?.referrer_id;
    if (!referrerId) return; // this subscriber wasn't referred by anyone

    const rate = await getCurrentCommissionRate(serviceKey);
    if (rate == null) return;

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/referral_commissions`, {
      method:  'POST',
      headers: {
        apikey:         serviceKey,
        Authorization:  `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        // return=representation so a genuine insert is distinguishable from
        // a suppressed duplicate (Stripe webhook redelivery) — only a
        // genuine insert should fire a notification below.
        Prefer:         'resolution=ignore-duplicates,return=representation',
      },
      body: JSON.stringify({
        referrer_id:       referrerId,
        subscriber_id:     referredUserId,
        stripe_invoice_id: invoiceId,
        amount:            rate,
      }),
    });
    if (!insertRes.ok) {
      const text = await insertRes.text();
      console.error('referral_commissions insert error:', insertRes.status, text);
      return;
    }
    const inserted = await insertRes.json().catch(() => []);
    if (!Array.isArray(inserted) || inserted.length === 0) return; // duplicate invoice, already recorded
    console.log('Commission recorded:', referrerId, 'for', referredUserId, '$' + rate);

    await createNotification(referrerId, 'commission', '💰 Commission Earned', `You earned $${Number(rate).toFixed(2)} from a referral.`, serviceKey);
  } catch (e) {
    console.error('createReferralCommission failed:', e.message);
  }
}

// Fire-and-forget in-app notification. Best-effort — a failure here must
// never break referral/commission recording itself (called after the write
// it's reporting on has already succeeded).
async function createNotification(userId, type, title, body, serviceKey) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
      method:  'POST',
      headers: {
        apikey:         serviceKey,
        Authorization:  `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer:         'return=minimal',
      },
      body: JSON.stringify({ user_id: userId, type, title, body }),
    });
    if (!r.ok) console.error('notifications insert error:', r.status, await r.text());
  } catch (e) {
    console.error('createNotification failed:', e.message);
  }
}

const MILESTONE_THRESHOLDS = [1, 5, 10, 25];

// Same live-COUNT-via-Range idiom as founding-status.js/getCurrentCommissionRate.
async function countActiveReferrals(referrerId, serviceKey) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/referrals?referrer_id=eq.${referrerId}&status=eq.active&select=id`,
    {
      headers: {
        apikey:        serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer:        'count=exact',
        Range:         '0-0',
      },
    }
  );
  const range = r.headers.get('content-range'); // "0-0/N"
  return range ? (parseInt(range.split('/')[1], 10) || 0) : 0;
}

// Fires once, the moment a referrer's active-referral count exactly crosses
// a threshold — checked right after a new referral insert.
async function maybeNotifyMilestone(referrerId, serviceKey) {
  try {
    const count = await countActiveReferrals(referrerId, serviceKey);
    if (MILESTONE_THRESHOLDS.includes(count)) {
      await createNotification(
        referrerId,
        'milestone',
        '🏅 Milestone Unlocked',
        `You've reached ${count} active referral${count === 1 ? '' : 's'}!`,
        serviceKey
      );
    }
  } catch (e) {
    console.error('maybeNotifyMilestone failed:', e.message);
  }
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts    = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const sigs     = sigHeader.match(/v1=([a-f0-9]+)/g)?.map(s => s.slice(3)) ?? [];
  const timestamp = parts.t;
  if (!timestamp || sigs.length === 0) return false;

  const encoder  = new TextEncoder();
  const key      = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );

  const signed   = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${payload}`));
  const expected = Array.from(new Uint8Array(signed)).map(b => b.toString(16).padStart(2, '0')).join('');

  return sigs.some(s => s === expected);
}
