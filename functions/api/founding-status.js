// Public status for the Founding Member promotion — how many of the 500
// spots are claimed, and whether the offer is still active (both the cap
// and the 2026-09-30 cutoff). Used by the homepage banner, pricing page,
// and countdown section. Also the same eligibility check checkout.js
// re-runs server-side before honoring the discounted price, so this file
// exports the shared logic rather than duplicating it.
const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';
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
  const active    = remaining > 0 && Date.now() < new Date(CUTOFF).getTime();
  return { claimed, remaining, cap: CAP, cutoff: CUTOFF, active };
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
