// Anonymous visit counter for the ORB Signal Engine. Called once per page
// load (fire-and-forget from the client, never blocks or surfaces errors to
// the user) so "how many visitors have used this" is a real, queryable
// number instead of a guess -- see supabase orb_engine_visits table.
const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ ok: false, error: 'not configured' }, 200);
  }

  try {
    const body = await request.json().catch(() => ({}));
    const mode = body.mode === 'live' ? 'live' : body.mode === 'sim' ? 'sim' : null;
    const symbol = typeof body.symbol === 'string'
      ? body.symbol.toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10) || null
      : null;
    if (!mode) return json({ error: 'mode required' }, 400);

    const res = await fetch(`${SUPABASE_URL}/rest/v1/orb_engine_visits`, {
      method: 'POST',
      headers: {
        apikey:         env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization:  `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer:         'return=minimal',
      },
      body: JSON.stringify({ mode, symbol }),
    });

    if (!res.ok) {
      console.error('orb-visit insert failed:', res.status, await res.text().catch(() => ''));
      return json({ ok: false }, 200);
    }
    return json({ ok: true }, 200);
  } catch (e) {
    console.error('orb-visit fatal:', e.message);
    return json({ ok: false }, 200);
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
