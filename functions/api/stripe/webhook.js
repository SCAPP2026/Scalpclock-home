const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';

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

      console.log('Checkout completed:', session.customer_email, 'subscription:', session.subscription);

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

        await upsertProfile(userId, patch, env.SUPABASE_SERVICE_ROLE_KEY);
      }
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

// Update Supabase auth app_metadata — no profiles table needed, service role bypasses RLS
async function upsertProfile(userId, patch, serviceKey) {
  try {
    const appMeta = {};
    if (patch.plan          !== undefined) appMeta.plan          = patch.plan;
    if (patch.stripe_sub_id !== undefined) appMeta.stripe_sub_id = patch.stripe_sub_id;
    if (patch.promo_redeemed !== undefined) appMeta.promo_redeemed = patch.promo_redeemed;

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
