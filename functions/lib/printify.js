// Shared Printify helpers for the merch shop (functions/api/shop/*.js and the
// merch branch of functions/api/stripe/webhook.js).
//
// Printify is the source of truth for the catalog: titles, images, variants
// and retail prices all come from the products published in the Printify
// store, so adding/editing merch never needs a code change here.
//
// Env:
//   PRINTIFY_API_TOKEN — personal access token (Printify → Account →
//                        Connections → API tokens)
//   PRINTIFY_SHOP_ID   — optional when the account has exactly one shop

const API = 'https://api.printify.com/v1';

// Countries the shop ships to. Checkout is restricted to the one the customer
// picks in the cart so the shipping charge always matches the destination.
export const SHIP_COUNTRIES = [
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'AU', name: 'Australia' },
];

export const MAX_CART_LINES = 10;
export const MAX_LINE_QTY   = 10;

export function isConfigured(env) {
  return !!env.PRINTIFY_API_TOKEN;
}

async function printify(env, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization:  `Bearer ${env.PRINTIFY_API_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent':   'ScalpClock-Shop', // Printify rejects requests without one
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Printify ${init.method || 'GET'} ${path} → ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function resolveShopId(env) {
  if (env.PRINTIFY_SHOP_ID) return String(env.PRINTIFY_SHOP_ID).trim();
  const shops = await printify(env, '/shops.json');
  if (Array.isArray(shops) && shops.length === 1) return String(shops[0].id);
  // Never guess between several stores — orders would land in the wrong one.
  throw new Error(`PRINTIFY_SHOP_ID is required (account has ${Array.isArray(shops) ? shops.length : 0} shops)`);
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// Trims a raw Printify product down to what the storefront needs. Only
// enabled variants are exposed, and option values no enabled variant uses are
// dropped so the picker never offers a combination that can't be bought.
export function publicProduct(p) {
  const variants = (p.variants || [])
    .filter(v => v.is_enabled && v.price > 0)
    .map(v => ({
      id:        v.id,
      title:     v.title,
      price:     v.price, // cents
      options:   v.options || [],
      available: v.is_available !== false,
    }));
  if (!variants.length) return null;

  const usedValues = new Set(variants.flatMap(v => v.options));
  const options = (p.options || [])
    .map(o => ({
      name:   o.name,
      type:   o.type,
      values: (o.values || [])
        .filter(val => usedValues.has(val.id))
        .map(val => ({ id: val.id, title: val.title, color: val.colors?.[0] || null })),
    }))
    .filter(o => o.values.length);

  const enabledIds = new Set(variants.map(v => v.id));
  const images = (p.images || [])
    .filter(img => !img.variant_ids?.length || img.variant_ids.some(id => enabledIds.has(id)))
    .sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0))
    .map(img => ({ src: img.src, variant_ids: (img.variant_ids || []).filter(id => enabledIds.has(id)) }));

  const prices = variants.map(v => v.price);
  return {
    id:          p.id,
    title:       p.title,
    description: stripHtml(p.description),
    images,
    options,
    variants,
    min_price:   Math.min(...prices),
    max_price:   Math.max(...prices),
  };
}

export async function listProducts(env) {
  const shopId = await resolveShopId(env);
  const out = [];
  // Printify caps a page at 50 products; 4 pages (200 products) is far more
  // than a merch shelf needs and keeps this well under the subrequest limit.
  for (let page = 1; page <= 4; page++) {
    const res = await printify(env, `/shops/${shopId}/products.json?limit=50&page=${page}`);
    for (const p of res.data || []) {
      if (p.visible === false) continue;
      const pub = publicProduct(p);
      if (pub) out.push(pub);
    }
    if (!res.last_page || page >= res.last_page) break;
  }
  return out;
}

export async function getRawProduct(env, shopId, productId) {
  return printify(env, `/shops/${shopId}/products/${encodeURIComponent(productId)}.json`);
}

// Standard shipping for a cart, in cents, from Printify's own per-provider
// rate tables. Items from the same print provider ship together: the most
// expensive "first item" rate is charged once and every other unit pays its
// "additional item" rate — the same way Printify bills the order.
//
// lines: [{ product (raw Printify product), variantId, quantity }]
export async function shippingCents(env, lines, country) {
  const tables = new Map(); // "blueprint:provider" → shipping profiles
  const groups = new Map(); // print provider id → [{ first, additional }] per unit

  for (const { product, variantId, quantity } of lines) {
    const key = `${product.blueprint_id}:${product.print_provider_id}`;
    if (!tables.has(key)) {
      const res = await printify(
        env,
        `/catalog/blueprints/${product.blueprint_id}/print_providers/${product.print_provider_id}/shipping.json`
      );
      tables.set(key, res.profiles || []);
    }
    const profiles = tables.get(key).filter(pr => (pr.variant_ids || []).includes(variantId));
    const profile =
      profiles.find(pr => (pr.countries || []).includes(country)) ||
      profiles.find(pr => (pr.countries || []).includes('REST_OF_THE_WORLD'));
    if (!profile) {
      const err = new Error(`"${product.title}" can't be shipped to ${country}`);
      err.userFacing = true;
      throw err;
    }
    const unit = {
      first:      profile.first_item?.cost ?? 0,
      additional: profile.additional_items?.cost ?? profile.first_item?.cost ?? 0,
    };
    const provider = product.print_provider_id;
    if (!groups.has(provider)) groups.set(provider, []);
    for (let i = 0; i < quantity; i++) groups.get(provider).push(unit);
  }

  let total = 0;
  for (const units of groups.values()) {
    units.sort((a, b) => b.first - a.first);
    total += units[0].first;
    for (const u of units.slice(1)) total += u.additional;
  }
  return total;
}

// Sends a paid order to Printify for fulfillment. Whether it then goes
// straight to production or waits for approval is controlled by the store's
// own "Order approval" setting in Printify — deliberately not forced here.
export async function createOrder(env, { externalId, lineItems, address }) {
  const shopId = await resolveShopId(env);
  return printify(env, `/shops/${shopId}/orders.json`, {
    method: 'POST',
    body: JSON.stringify({
      external_id:                externalId,
      label:                      `SC-${externalId.slice(-8).toUpperCase()}`,
      line_items:                 lineItems,
      shipping_method:            1, // standard
      send_shipping_notification: true, // Printify emails tracking to the customer
      address_to:                 address,
    }),
  });
}
