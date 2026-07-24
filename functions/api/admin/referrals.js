// Admin-only referral list + manual fraud-review override for
// admin-referrals.html. See overview.js for why every admin endpoint
// re-verifies the caller's token against Supabase rather than trusting a
// client-sent flag.
const SUPABASE_URL  = 'https://fnuqxiflqqejjttxymbz.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZudXF4aWZscXFlamp0dHh5bWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzMxODksImV4cCI6MjA5ODAwOTE4OX0.XE1-LPW0043gRFEAl9onCahkmpQ8BMAAtGkF9FqJLiY';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Not configured' }, 500);

  const isAdmin = await verifyAdmin(request);
  if (!isAdmin) return json({ error: 'Forbidden' }, 403);

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (request.method === 'GET') return handleList(serviceKey);
  if (request.method === 'PATCH') return handlePatch(request, serviceKey);
  return json({ error: 'Method not allowed' }, 405);
}

async function handleList(serviceKey) {
  try {
    const [refsRes, foundersRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/referrals?select=id,referrer_id,referred_user_id,status,created_at&order=created_at.desc&limit=200`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/founding_members?select=user_id,founder_number`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      ),
    ]);
    const refs     = await refsRes.json().catch(() => []);
    const founders = await foundersRes.json().catch(() => []);
    const numberByUserId = new Map((Array.isArray(founders) ? founders : []).map(f => [f.user_id, f.founder_number]));

    const referrals = (Array.isArray(refs) ? refs : []).map(r => ({
      id:              r.id,
      founderNumber:   numberByUserId.get(r.referrer_id) ?? null,
      referredUserId:  r.referred_user_id,
      status:          r.status,
      createdAt:       r.created_at,
    }));

    return json({ referrals });
  } catch (e) {
    console.error('handleList failed:', e.message);
    return json({ error: 'Failed to load referrals' }, 500);
  }
}

async function handlePatch(request, serviceKey) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const { id, status } = body || {};
  if (!id || !['active', 'inactive'].includes(status)) {
    return json({ error: 'id and status (active|inactive) required' }, 400);
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/referrals?id=eq.${encodeURIComponent(id)}`, {
      method:  'PATCH',
      headers: {
        apikey:         serviceKey,
        Authorization:  `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer:         'return=minimal',
      },
      body: JSON.stringify({ status }),
    });
    if (!r.ok) {
      const text = await r.text();
      console.error('admin referral status update error:', r.status, text);
      return json({ error: 'Update failed' }, 500);
    }
    return json({ ok: true });
  } catch (e) {
    console.error('handlePatch failed:', e.message);
    return json({ error: 'Update failed' }, 500);
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
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
