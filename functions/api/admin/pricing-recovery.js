// Phase 13 of the pricing/checkout hardening work: a read-only admin report
// identifying customers who purchased the $9.99 Pro plan at a time when the
// $1.99 Founding Member offer was genuinely available — so the business
// owner can review and decide whether to reach out. This endpoint NEVER
// modifies a subscription or downgrades/upgrades anyone; it only surfaces
// information for manual review, per the task's explicit "do not
// automatically downgrade or modify paying customers" requirement.
//
// verifyAdmin() duplicated from functions/api/admin/overview.js rather than
// imported — same "zero cross-file dependency risk for billing/admin-
// critical code" reasoning already used throughout this codebase's Stripe
// functions (see checkout.js's own comment on this pattern).
const SUPABASE_URL  = 'https://fnuqxiflqqejjttxymbz.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZudXF4aWZscXFlamp0dHh5bWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzMxODksImV4cCI6MjA5ODAwOTE4OX0.XE1-LPW0043gRFEAl9onCahkmpQ8BMAAtGkF9FqJLiY';

// Same constants as checkout.js / founding-status.js — duplicated for the
// same billing-critical isolation reason. Keep all in sync.
const FOUNDING_CAP    = 500;
const FOUNDING_CUTOFF = '2026-09-30T23:59:59Z';
// Founding Member offer's actual launch — before this date, "Founder was
// available" is meaningless (the offer didn't exist yet), so those Pro
// purchases are never flagged as a possible accidental $9.99 purchase.
const FOUNDING_LAUNCH = '2026-07-14T00:00:00Z';

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.STRIPE_SECRET_KEY) return json({ error: 'Not configured' }, 500);

  const isAdmin = await verifyAdmin(request);
  if (!isAdmin) return json({ error: 'Forbidden' }, 403);

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const [proSubs, founders] = await Promise.all([
      listProSubscriptions(env.STRIPE_SECRET_KEY, env),
      listAllFoundingMembers(serviceKey),
    ]);

    // Sorted ascending so a running count of "founders claimed as of time T"
    // can be computed with a single pass per subscription below, rather than
    // filtering the whole array per row.
    const founderTimestamps = founders.map(f => new Date(f.created_at).getTime()).sort((a, b) => a - b);
    function foundersClaimedAsOf(unixSeconds) {
      const t = unixSeconds * 1000;
      let count = 0;
      for (const ts of founderTimestamps) { if (ts <= t) count++; else break; }
      return count;
    }

    const rows = proSubs.map(sub => {
      const createdSec = sub.created;
      const claimedAtSignup = foundersClaimedAsOf(createdSec);
      const launched = createdSec * 1000 >= new Date(FOUNDING_LAUNCH).getTime();
      const beforeCutoff = createdSec * 1000 < new Date(FOUNDING_CUTOFF).getTime();
      const founderAvailableAtSignup = launched && beforeCutoff && claimedAtSignup < FOUNDING_CAP;

      return {
        customerId:       sub.customer?.id || sub.customer,
        email:            sub.customer?.email || null,
        signupDate:       new Date(createdSec * 1000).toISOString(),
        selectedPlan:     'pro',
        actualStripePrice: sub.items?.data?.[0]?.price?.id || null,
        actualStripePriceAmount: sub.items?.data?.[0]?.price?.unit_amount != null
          ? (sub.items.data[0].price.unit_amount / 100).toFixed(2) : null,
        founderAvailableAtSignup,
        founderSpotsRemainingAtSignup: launched && beforeCutoff ? Math.max(0, FOUNDING_CAP - claimedAtSignup) : null,
        // Only present for checkouts created after the metadata[source]
        // field was added (see checkout.js) — older subscriptions predate
        // it and honestly show "unknown" rather than a guessed value.
        checkoutSource:   sub.metadata?.source || 'unknown',
        subscriptionStatus: sub.status,
      };
    });

    // Flagged = the actual list the business owner most likely wants to
    // review first: real Pro subscribers who signed up while Founding was
    // demonstrably available. Full `rows` is still returned for completeness.
    const flagged = rows.filter(r => r.founderAvailableAtSignup);

    return json({ generatedAt: new Date().toISOString(), totalProSubscriptions: rows.length, flaggedCount: flagged.length, flagged, all: rows }, 200);
  } catch (e) {
    console.error('pricing-recovery fatal:', e.message);
    return json({ error: e.message }, 500);
  }
}

async function listProSubscriptions(stripeSecretKey, env) {
  const priceIds = [env.STRIPE_PRICE_PRO_MONTHLY, env.STRIPE_PRICE_PRO_ANNUAL].filter(Boolean);
  const results = [];
  for (const priceId of priceIds) {
    let startingAfter = null;
    for (let page = 0; page < 10; page++) { // hard cap — 1000 subs per price is far beyond this app's current scale
      const url = new URL('https://api.stripe.com/v1/subscriptions');
      url.searchParams.set('price', priceId);
      url.searchParams.set('status', 'all');
      url.searchParams.set('limit', '100');
      url.searchParams.set('expand[]', 'data.customer');
      if (startingAfter) url.searchParams.set('starting_after', startingAfter);
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${stripeSecretKey}` } });
      if (!res.ok) { console.error('Stripe list subscriptions failed:', res.status, await res.text().catch(() => '')); break; }
      const data = await res.json();
      results.push(...(data.data || []));
      if (!data.has_more || !data.data?.length) break;
      startingAfter = data.data[data.data.length - 1].id;
    }
  }
  return results;
}

async function listAllFoundingMembers(serviceKey) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/founding_members?select=id,created_at`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    const data = await res.json().catch(() => []);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('listAllFoundingMembers failed:', e.message);
    return [];
  }
}

async function verifyAdmin(request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return false;
    const user = await r.json();
    return user?.app_metadata?.is_admin === true;
  } catch (e) {
    console.error('verifyAdmin failed:', e.message);
    return false;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
