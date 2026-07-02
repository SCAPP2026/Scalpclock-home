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
      const sub = event.data.object;
      console.log('Subscription cancelled:', sub.id, sub.customer);
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
