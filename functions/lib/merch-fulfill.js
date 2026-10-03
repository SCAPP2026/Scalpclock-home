// Merch fulfillment: turns a paid Stripe Checkout Session created by
// functions/api/shop/checkout.js into a Printify order. Called only from the
// Stripe webhook's checkout.session.completed branch (metadata.kind==='merch').
//
// Idempotent across webhook retries: the Printify order id is stamped onto
// the Stripe PaymentIntent's metadata after a successful create, and checked
// before every attempt, so a retried event never produces a second order.

import { createOrder } from './printify.js';

const STRIPE = 'https://api.stripe.com/v1';
const ALERT_FROM = 'ScalpClock <admin@scalpclock.com>';
const ALERT_TO   = 'admin@scalpclock.com';

async function stripe(env, path, init = {}) {
  const res = await fetch(`${STRIPE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(init.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${path} → ${res.status} ${data?.error?.message || ''}`);
  return data;
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: 'Customer', last: '-' };
  if (parts.length === 1) return { first: parts[0], last: '-' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

// Returns { status: 'created' | 'duplicate' | 'unpaid', orderId? }.
// Throws on any failure so the webhook can answer non-2xx and Stripe retries.
export async function fulfillMerchOrder(env, session) {
  if (session.payment_status !== 'paid') return { status: 'unpaid' };

  const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  if (piId) {
    const pi = await stripe(env, `/payment_intents/${piId}`);
    if (pi.metadata?.printify_order_id) {
      return { status: 'duplicate', orderId: pi.metadata.printify_order_id };
    }
  }

  const li = await stripe(env, `/checkout/sessions/${session.id}/line_items?limit=100&expand[]=data.price.product`);
  const lineItems = (li.data || []).map(row => ({
    product_id: row.price?.product?.metadata?.printify_product_id,
    variant_id: Number(row.price?.product?.metadata?.printify_variant_id),
    quantity:   row.quantity,
  }));
  if (!lineItems.length || lineItems.some(l => !l.product_id || !Number.isInteger(l.variant_id))) {
    throw new Error('session line items are missing Printify ids');
  }

  // Stripe moved shipping_details under collected_information in newer API
  // versions; the webhook payload follows the account's version, so read both.
  const ship = session.collected_information?.shipping_details || session.shipping_details;
  const addr = ship?.address;
  if (!addr?.line1 || !addr?.country) throw new Error('session has no shipping address');
  const { first, last } = splitName(ship.name || session.customer_details?.name);

  const order = await createOrder(env, {
    externalId: session.id,
    lineItems,
    address: {
      first_name: first,
      last_name:  last,
      email:      session.customer_details?.email || '',
      phone:      session.customer_details?.phone || '',
      country:    addr.country,
      region:     addr.state || '',
      address1:   addr.line1,
      address2:   addr.line2 || '',
      city:       addr.city || '',
      zip:        addr.postal_code || '',
    },
  });

  if (piId) {
    try {
      await stripe(env, `/payment_intents/${piId}`, {
        method: 'POST',
        body: new URLSearchParams({ 'metadata[printify_order_id]': String(order.id) }).toString(),
      });
    } catch (e) {
      // Order exists but the marker didn't stick — say so loudly, since a
      // retry of this event could now create a second Printify order.
      console.error('MERCH: could not stamp printify_order_id on', piId, '-', e.message);
    }
  }
  return { status: 'created', orderId: order.id };
}

// A customer has paid but the order did not reach Printify — the shop owner
// has to know. Best-effort; never throws.
export async function alertMerchFailure(env, session, message) {
  if (!env.RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    ALERT_FROM,
        to:      ALERT_TO,
        subject: '⚠️ Merch order paid but NOT sent to Printify',
        text:
          `A shop order was paid in Stripe but could not be created in Printify.\n\n` +
          `Stripe session: ${session.id}\n` +
          `Customer: ${session.customer_details?.email || 'unknown'}\n` +
          `Amount: ${(session.amount_total / 100).toFixed(2)} ${String(session.currency || '').toUpperCase()}\n` +
          `Error: ${message}\n\n` +
          `Stripe will retry automatically. If this keeps arriving, place the order by hand in Printify ` +
          `(or refund it in Stripe).`,
      }),
    });
  } catch (e) {
    console.error('merch failure alert not sent:', e.message);
  }
}
