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

// Insert-only — no upsert/uniqueness needed since each checkout.session.completed
// event fires once per new subscription. This row is purely what
// functions/api/founding-status.js counts to compute spots remaining.
async function recordFoundingMember(userId, subscriptionId, serviceKey) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/founding_members`, {
      method:  'POST',
      headers: {
        apikey:         serviceKey,
        Authorization:  `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer:         'return=minimal',
      },
      body: JSON.stringify({
        user_id:                userId || null,
        stripe_subscription_id: subscriptionId || null,
      }),
    });
    console.log('Founding member recorded for:', userId, 'status:', r.status);
    if (!r.ok) {
      const text = await r.text();
      console.error('founding_members insert error:', text);
    }
  } catch (e) {
    console.error('Failed to record founding member:', e.message);
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
