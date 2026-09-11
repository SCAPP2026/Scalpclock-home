// Captures signup-time country/region from Cloudflare's edge geolocation
// (derived from the visitor's real connecting IP, not client-reported) and
// stamps it on the new user's public.profiles row via the record_signup_geo
// RPC. Called fire-and-forget from login.html right after sb.auth.signUp()
// returns a user id — see [[project_scalpclock]] for why this can't just be
// the client's own profiles.upsert: RLS requires auth.uid()=id, which
// doesn't hold yet for a not-yet-email-confirmed signup with no session.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Not configured' }, 500);

  let user_id;
  try {
    ({ user_id } = await request.json());
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!user_id || !UUID_RE.test(user_id)) return json({ error: 'Valid user_id required' }, 400);

  // request.cf is populated by Cloudflare at the edge for every request —
  // real geolocation of the actual connecting IP, can't be spoofed by the
  // client body.
  const cf = request.cf || {};
  const country = typeof cf.country === 'string' ? cf.country.slice(0, 8) : null;
  const region = typeof cf.region === 'string' ? cf.region.slice(0, 100) : null;

  if (!country && !region) return json({ ok: true, skipped: 'no geo data' }, 200);

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_signup_geo`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_user_id: user_id, p_country: country, p_region: region }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      return json({ error: 'RPC failed: ' + err }, 502);
    }
    return json({ ok: true }, 200);
  } catch (e) {
    return json({ error: 'Failed to record signup geo' }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
