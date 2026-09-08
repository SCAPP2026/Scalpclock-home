/**
 * functions/api/stripe/checkout.js — server-side plan validation tests.
 * Verifies (per the pricing/checkout hardening spec):
 *   - the server maps a plan identifier to a real, env-configured Stripe
 *     Price ID — the client can never choose an arbitrary price
 *   - invalid plan identifiers are rejected
 *   - Founding Member checkout is refused server-side when the offer isn't
 *     actually active, even if a client claims otherwise, and no Stripe
 *     session is created in that case
 *   - Founding Member sessions never get a trial, regardless of client input
 *   - plan_type/source/checkout_version metadata is set correctly
 * All Stripe/Supabase calls are mocked — no live credentials or network.
 * Run with: node tests/stripe-checkout.test.mjs
 */
import { onRequest } from '../functions/api/stripe/checkout.js';

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_fake',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key',
  STRIPE_PRICE_PRO_MONTHLY: 'price_PRO_MONTHLY_REAL',
  STRIPE_PRICE_PRO_ANNUAL: 'price_PRO_ANNUAL_REAL',
  STRIPE_PRICE_FOUNDING: 'price_FOUNDING_REAL',
};

function req(body) {
  return new Request('https://scalpclock.com/api/stripe/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

function mockFetch({ foundingClaimed = 10, stripeCapture = null, subSearchResults = [] } = {}) {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('founding_members?select=id')) {
      return new Response('[]', { status: 200, headers: { 'Content-Range': `0-0/${foundingClaimed}` } });
    }
    if (u.includes('subscriptions/search')) {
      return new Response(JSON.stringify({ data: subSearchResults }), { status: 200 });
    }
    if (u.includes('checkout/sessions') && opts?.method === 'POST') {
      if (stripeCapture) stripeCapture.push(new URLSearchParams(opts.body));
      return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/fake', id: 'cs_test_fake' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
}

const realFetch = global.fetch;

// ── 1. Missing userId -> 400, no Stripe call ────────────────────────────
{
  const stripeCapture = [];
  global.fetch = mockFetch({ stripeCapture });
  const res = await onRequest({ env: ENV, request: req({ tier: 'pro', billing: 'monthly' }) });
  const data = await res.json();
  global.fetch = realFetch;
  assert(res.status === 400, `missing userId -> 400 (got ${res.status})`);
  assert(stripeCapture.length === 0, 'no Stripe session created when userId is missing');
}

// ── 2. Invalid/unknown tier -> 400, no Stripe call, no price leaked ─────
{
  const stripeCapture = [];
  global.fetch = mockFetch({ stripeCapture });
  const res = await onRequest({ env: ENV, request: req({ tier: 'super_secret_free_plan', billing: 'monthly', userId: 'u1' }) });
  const data = await res.json();
  global.fetch = realFetch;
  assert(res.status === 400, `invalid tier -> 400 (got ${res.status})`);
  assert(stripeCapture.length === 0, 'no Stripe session created for an invalid tier');
  assert(!JSON.stringify(data).includes('price_'), 'error response does not leak any Stripe price ID');
}

// ── 3. Client cannot smuggle an arbitrary price — server always uses its own env-configured Price ID ──
{
  const stripeCapture = [];
  global.fetch = mockFetch({ stripeCapture, foundingClaimed: 10 });
  const res = await onRequest({ env: ENV, request: req({
    tier: 'pro', billing: 'monthly', trial: true, userId: 'u1',
    // Attempted injection: a client-supplied price/priceId should be fully ignored.
    price: 1.99, priceId: 'price_ATTACKER_CONTROLLED', amount: 199,
  }) });
  assert(res.status === 200, `pro checkout succeeds (got ${res.status})`);
  const sentParams = stripeCapture[0];
  global.fetch = realFetch;
  assert(sentParams.get('line_items[0][price]') === ENV.STRIPE_PRICE_PRO_MONTHLY, `Stripe session uses the real env-configured Pro price (got ${sentParams.get('line_items[0][price]')})`);
  assert(sentParams.get('line_items[0][price]') !== 'price_ATTACKER_CONTROLLED', 'client-supplied priceId is never used');
}

// ── 4. Founding Member checkout uses the real Founding price, forces no trial ──
{
  const stripeCapture = [];
  global.fetch = mockFetch({ stripeCapture, foundingClaimed: 10 }); // well under cap -> active
  const res = await onRequest({ env: ENV, request: req({
    tier: 'founding_member', billing: 'monthly', userId: 'u2',
    trial: true, // attempted injection: client claims it wants a trial
  }) });
  assert(res.status === 200, `founding checkout succeeds when active (got ${res.status})`);
  const sentParams = stripeCapture[0];
  global.fetch = realFetch;
  assert(sentParams.get('line_items[0][price]') === ENV.STRIPE_PRICE_FOUNDING, `uses the real Founding price ID (got ${sentParams.get('line_items[0][price]')})`);
  assert(sentParams.get('subscription_data[trial_period_days]') === null, 'Founding session never gets trial_period_days, even if the client requests trial:true');
  assert(sentParams.get('metadata[trial]') === '0', 'metadata[trial] is forced to 0 for Founding regardless of client input');
  assert(sentParams.get('metadata[founding_member]') === 'true', 'metadata[founding_member]=true is set');
  assert(sentParams.get('metadata[plan_type]') === 'founding_member', 'metadata[plan_type]=founding_member is set');
}

// ── 5. Founding Member checkout is REFUSED server-side when spots are full, even if client believes it's available ──
{
  const stripeCapture = [];
  global.fetch = mockFetch({ stripeCapture, foundingClaimed: 500 }); // at cap
  const res = await onRequest({ env: ENV, request: req({ tier: 'founding_member', billing: 'monthly', userId: 'u3' }) });
  const data = await res.json();
  global.fetch = realFetch;
  assert(res.status === 400, `founding checkout rejected when cap is reached (got ${res.status})`);
  assert(/full/i.test(data.error || ''), `error message explains spots are full (got "${data.error}")`);
  assert(stripeCapture.length === 0, 'no Stripe session is EVER created once the Founding cap is reached, regardless of client request');
}

// ── 6. Pro checkout metadata includes source + checkout_version ────────
{
  const stripeCapture = [];
  global.fetch = mockFetch({ stripeCapture });
  await onRequest({ env: ENV, request: req({ tier: 'pro', billing: 'monthly', trial: true, userId: 'u4', source: 'signals_paywall' }) });
  const sentParams = stripeCapture[0];
  global.fetch = realFetch;
  assert(sentParams.get('metadata[plan_type]') === 'pro', 'metadata[plan_type]=pro for a Pro checkout');
  assert(sentParams.get('metadata[source]') === 'signals_paywall', `metadata[source] passes through an allowlisted value (got ${sentParams.get('metadata[source]')})`);
  assert(sentParams.get('metadata[checkout_version]') === 'founder-guard-v1', 'metadata[checkout_version] is set');
}

// ── 7. Unrecognized `source` values are sanitized, not passed through raw ──
{
  const stripeCapture = [];
  global.fetch = mockFetch({ stripeCapture });
  await onRequest({ env: ENV, request: req({ tier: 'pro', billing: 'monthly', trial: true, userId: 'u5', source: '<script>evil</script>' }) });
  const sentParams = stripeCapture[0];
  global.fetch = realFetch;
  assert(sentParams.get('metadata[source]') === 'unknown', `an unrecognized/unsafe source value falls back to "unknown" (got ${sentParams.get('metadata[source]')})`);
}

// ── 8. Blocking an existing active subscription still works (regression) ──
{
  const stripeCapture = [];
  global.fetch = mockFetch({ stripeCapture, subSearchResults: [{ status: 'active' }] });
  const res = await onRequest({ env: ENV, request: req({ tier: 'pro', billing: 'monthly', userId: 'u6' }) });
  const data = await res.json();
  global.fetch = realFetch;
  assert(res.status === 409, `existing active subscription blocks a new checkout -> 409 (got ${res.status})`);
  assert(stripeCapture.length === 0, 'no duplicate Stripe session created when the user already has an active subscription');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
