const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST')   return new Response('Method not allowed', { status: 405 });

  let session_id;
  try {
    ({ session_id } = await request.json());
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!session_id || !session_id.startsWith('cs_')) {
    return json({ error: 'Valid session_id required' }, 400);
  }

  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe not configured' }, 500);

  // Verify the session directly with Stripe
  let session;
  try {
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${session_id}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    session = await r.json();
    if (!r.ok) return json({ error: session.error?.message || 'Stripe session fetch failed' }, 502);
  } catch (e) {
    return json({ error: 'Could not reach Stripe' }, 502);
  }

  // Only activate for completed sessions
  if (session.status !== 'complete') {
    return json({ error: 'Session not completed', status: session.status }, 400);
  }

  const userId = session.client_reference_id;
  if (!userId) return json({ error: 'No user ID on session — checkout was initiated without auth' }, 400);

  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured in Cloudflare env' }, 500);

  const isFounding = session.metadata?.founding_member === 'true';

  try {
    // Fetch existing app_metadata first and merge — this call can race with the
    // checkout.session.completed webhook, and neither write should be able to
    // clobber a field (like founding_member) the other just set.
    let existing = {};
    try {
      const getRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      });
      if (getRes.ok) {
        const userData = await getRes.json();
        existing = (userData?.user?.app_metadata || userData?.app_metadata) || {};
      }
    } catch (e) {
      console.error('Failed to fetch existing app_metadata:', e.message);
    }

    const appMeta = { ...existing, plan: 'trial', stripe_sub_id: session.subscription || null };
    if (isFounding) appMeta.founding_member = true;

    const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method:  'PUT',
      headers: {
        apikey:         env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization:  `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ app_metadata: appMeta }),
    });
    if (!r.ok) {
      const text = await r.text();
      console.error('Supabase auth update failed:', text);
      return json({ error: 'Failed to activate plan', detail: text }, 500);
    }
  } catch (e) {
    return json({ error: 'Supabase unreachable', detail: e.message }, 502);
  }

  return json({ ok: true, plan: 'trial' });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
