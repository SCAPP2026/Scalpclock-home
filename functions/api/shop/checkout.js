// POST /api/shop/checkout — turns a merch cart into a one-time Stripe Checkout
// Session. No account needed (guest checkout).
//
// The browser only sends product/variant ids + quantities. Names, prices and
// shipping are all re-read from Printify here, so a tampered cart can never
// change what the customer is charged. Fulfillment happens in
// functions/api/stripe/webhook.js once Stripe confirms payment
// (metadata.kind === 'merch').

import {
  isConfigured, resolveShopId, getRawProduct, shippingCents,
  SHIP_COUNTRIES, MAX_CART_LINES, MAX_LINE_QTY,
} from '../../lib/printify.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestPost({ env, request }) {
  if (!isConfigured(env) || !env.STRIPE_SECRET_KEY) {
    return json({ error: 'The shop is not open yet.' }, 503);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }

  const country = String(body.country || 'US').toUpperCase();
  if (!SHIP_COUNTRIES.some(c => c.code === country)) {
    return json({ error: 'We don\'t ship to that country yet.' }, 400);
  }

  // Normalize + merge duplicate lines.
  const merged = new Map();
  for (const it of Array.isArray(body.items) ? body.items : []) {
    const productId = String(it?.product_id || '');
    const variantId = Number(it?.variant_id);
    const quantity  = Math.floor(Number(it?.quantity));
    if (!/^[a-f0-9]{24}$/i.test(productId) || !Number.isInteger(variantId) || !(quantity >= 1)) {
      return json({ error: 'Your cart has an invalid item. Please remove it and try again.' }, 400);
    }
    const key = `${productId}:${variantId}`;
    const prev = merged.get(key);
    merged.set(key, { productId, variantId, quantity: (prev?.quantity || 0) + quantity });
  }
  const items = [...merged.values()];
  if (!items.length) return json({ error: 'Your cart is empty.' }, 400);
  if (items.length > MAX_CART_LINES) return json({ error: `A single order can hold up to ${MAX_CART_LINES} different items.` }, 400);
  if (items.some(i => i.quantity > MAX_LINE_QTY)) return json({ error: `Maximum ${MAX_LINE_QTY} of any one item per order.` }, 400);

  try {
    const shopId = await resolveShopId(env);
    const products = new Map();
    const lines = [];
    for (const it of items) {
      if (!products.has(it.productId)) {
        products.set(it.productId, await getRawProduct(env, shopId, it.productId));
      }
      const product = products.get(it.productId);
      const variant = (product.variants || []).find(v => v.id === it.variantId);
      if (product.visible === false || !variant || !variant.is_enabled || !(variant.price > 0)) {
        return json({ error: `"${product.title}" is no longer available in that option. Please remove it from your cart.` }, 409);
      }
      if (variant.is_available === false) {
        return json({ error: `"${product.title} — ${variant.title}" is out of stock right now.` }, 409);
      }
      lines.push({ product, variant, variantId: variant.id, quantity: it.quantity });
    }

    const shipping = await shippingCents(env, lines, country);

    const origin = new URL(request.url).origin;
    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('payment_method_types[0]', 'card'); // card = paid at completion, so the webhook can fulfill immediately
    params.set('success_url', `${origin}/shop?order=success`);
    params.set('cancel_url',  `${origin}/shop?order=cancelled`);
    params.set('shipping_address_collection[allowed_countries][0]', country);
    params.set('phone_number_collection[enabled]', 'true');
    params.set('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
    params.set('shipping_options[0][shipping_rate_data][display_name]', 'Standard shipping');
    params.set('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(shipping));
    params.set('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'usd');
    params.set('metadata[kind]', 'merch');
    params.set('payment_intent_data[metadata][kind]', 'merch');
    const gaClientId = typeof body.ga_client_id === 'string' ? body.ga_client_id.slice(0, 100) : '';
    if (gaClientId) params.set('metadata[ga_client_id]', gaClientId);

    lines.forEach(({ product, variant, quantity }, i) => {
      const p = `line_items[${i}]`;
      const image =
        (product.images || []).find(img => (img.variant_ids || []).includes(variant.id))?.src ||
        product.images?.[0]?.src;
      params.set(`${p}[quantity]`, String(quantity));
      params.set(`${p}[price_data][currency]`, 'usd');
      params.set(`${p}[price_data][unit_amount]`, String(variant.price));
      params.set(`${p}[price_data][product_data][name]`, `${product.title} — ${variant.title}`.slice(0, 250));
      if (image) params.set(`${p}[price_data][product_data][images][0]`, image);
      // The webhook reads these back from Stripe to build the Printify order.
      params.set(`${p}[price_data][product_data][metadata][printify_product_id]`, product.id);
      params.set(`${p}[price_data][product_data][metadata][printify_variant_id]`, String(variant.id));
    });

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const session = await res.json();
    if (!res.ok || !session.url) {
      console.error('shop checkout: Stripe error:', JSON.stringify(session.error || session));
      return json({ error: 'Could not start checkout. Please try again.' }, 502);
    }
    return json({ url: session.url });
  } catch (e) {
    console.error('shop checkout failed:', e.message);
    if (e.userFacing) return json({ error: e.message }, 400);
    return json({ error: 'Could not start checkout. Please try again.' }, 502);
  }
}
