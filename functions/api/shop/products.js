// GET /api/shop/products — public merch catalog for /shop, read live from the
// Printify store. Cached at the edge for 5 minutes so browsing the shop never
// hammers Printify's API (and a product edit in Printify shows up within
// minutes, no deploy needed).

import { isConfigured, listProducts, SHIP_COUNTRIES } from '../../lib/printify.js';

function json(data, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache },
  });
}

export async function onRequestGet({ env }) {
  if (!isConfigured(env)) {
    return json({ configured: false, products: [], countries: SHIP_COUNTRIES });
  }
  try {
    const products = await listProducts(env);
    return json(
      { configured: true, products, countries: SHIP_COUNTRIES },
      200,
      'public, max-age=60, s-maxage=300'
    );
  } catch (e) {
    console.error('shop products failed:', e.message);
    return json({ configured: true, products: [], countries: SHIP_COUNTRIES, error: 'Could not load products right now.' }, 502);
  }
}
