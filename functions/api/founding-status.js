// Public status for the Founding Member promotion — how many of the 500
// spots are claimed, and whether the offer is still active (both the cap
// and the 2026-09-30 cutoff). Used by the homepage banner, pricing page,
// and countdown section. Also the same eligibility check checkout.js
// re-runs server-side before honoring the discounted price, so this file
// exports the shared logic rather than duplicating it.
const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';

// Single kill switch for the whole promotion. Flip to false to end it
// immediately — every homepage/pricing element that renders the offer
// reads `active` from this endpoint, so nothing else needs to change.
// (checkout.js re-declares this same constant — see the comment there
// for why it's duplicated rather than imported.)
const ACTIVE_OVERRIDE = true;
const CAP = 500;
const CUTOFF = '2026-09-30T23:59:59Z';

export async function getFoundingStatus(serviceKey) {
  let claimed = 0;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/founding_members?select=id`, {
      headers: {
        apikey:        serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer:        'count=exact',
        Range:         '0-0',
      },
    });
    const range = res.headers.get('content-range'); // "0-0/N"
    if (range) claimed = parseInt(range.split('/')[1], 10) || 0;
  } catch (e) {
    console.error('founding-status count failed:', e.message);
  }
  const remaining = Math.max(0, CAP - claimed);
  const active    = ACTIVE_OVERRIDE && remaining > 0 && Date.now() < new Date(CUTOFF).getTime();

  // Referral program's current commission rate — read fresh from
  // referral_program_settings (not hardcoded) so the referral dashboard
  // shows the real rate rather than a duplicated client-side constant. This
  // is a separate config source from CAP above on purpose: CAP gates the
  // founding-tier *pricing* promotion, founding_member_limit gates the
  // referral *commission* rate — they default to the same 500 today, but
  // are independently adjustable.
  let currentReferralRate = null, referralProgramEnabled = false;
  try {
    const settingsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_program_settings?id=eq.1&select=*`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    const rows = await settingsRes.json().catch(() => []);
    const settings = Array.isArray(rows) ? rows[0] : null;
    if (settings) {
      referralProgramEnabled = settings.referral_program_enabled === true;
      currentReferralRate = claimed >= settings.founding_member_limit
        ? settings.commission_rate_post_cap
        : settings.commission_rate_pre_cap;
    }
  } catch (e) {
    console.error('founding-status referral rate lookup failed:', e.message);
  }

  return { claimed, remaining, cap: CAP, cutoff: CUTOFF, active, currentReferralRate, referralProgramEnabled };
}

export async function onRequest(context) {
  const { env } = context;
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Not configured' }, 200);
  }
  const status = await getFoundingStatus(env.SUPABASE_SERVICE_ROLE_KEY);
  return json(status, 200);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':                'public, s-maxage=30, stale-while-revalidate=15',
    },
  });
}
