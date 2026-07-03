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
      const isTrial = session.subscription
        && session.metadata?.trial_type === '7_day_free';
      console.log(
        isTrial ? 'Trial started:' : 'New subscription:',
        session.customer_email,
        session.subscription
      );

      // Update user profile: set plan=pro and mark promo if discount applied
      const userId   = session.client_reference_id;
      const hasPromo = Array.isArray(session.discounts) && session.discounts.length > 0;
      if (userId && env.SUPABASE_SERVICE_KEY) {
        const patch = { plan: 'pro' };
        if (hasPromo) patch.promo_redeemed = true;
        try {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
            method:  'PATCH',
            headers: {
              apikey:         env.SUPABASE_SERVICE_KEY,
              Authorization:  `Bearer ${env.SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
              Prefer:         'return=minimal',
            },
            body: JSON.stringify(patch),
          });
          console.log('Profile updated for user:', userId, 'patch:', JSON.stringify(patch), 'status:', r.status);
        } catch (e) {
          console.error('Failed to update profile:', e.message);
        }
      }
      break;
    }

    case 'customer.subscription.trial_will_end': {
      // Fires 3 days before trial ends — good hook for a reminder email
      const sub = event.data.object;
      console.log(
        'Trial ending soon for customer:',
        sub.customer,
        'trial ends:',
        new Date(sub.trial_end * 1000).toISOString()
      );
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const wasTrialing = event.data.previous_attributes?.status === 'trialing';
      const nowActive   = sub.status === 'active';
      if (wasTrialing && nowActive) {
        console.log('Trial converted to paid subscription:', sub.id, sub.customer);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub    = event.data.object;
      const userId = sub.metadata?.user_id;
      console.log('Subscription cancelled:', sub.id, sub.customer, 'user:', userId);
      if (userId && env.SUPABASE_SERVICE_KEY) {
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
            method:  'PATCH',
            headers: {
              apikey:         env.SUPABASE_SERVICE_KEY,
              Authorization:  `Bearer ${env.SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
              Prefer:         'return=minimal',
            },
            body: JSON.stringify({ plan: 'free' }),
          });
        } catch (e) {
          console.error('Failed to reset plan on cancel:', e.message);
        }
      }
      break;
    }

    case 'invoice.payment_failed': {
      const inv = event.data.object;
      console.log('Payment failed:', inv.customer_email, inv.id);
      break;
    }

  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
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
