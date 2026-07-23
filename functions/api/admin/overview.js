// Admin-only aggregate stats for the referral program's fraud-review
// dashboard (admin-referrals.html). Every admin endpoint re-verifies the
// caller server-side against Supabase rather than trusting a client-sent
// flag — app_metadata.is_admin is service-role-only to write, but a client
// could still lie about its own value in a request body, so this always
// asks Supabase directly what the token's real app_metadata says.
const SUPABASE_URL  = 'https://fnuqxiflqqejjttxymbz.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZudXF4aWZscXFlamp0dHh5bWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzMxODksImV4cCI6MjA5ODAwOTE4OX0.XE1-LPW0043gRFEAl9onCahkmpQ8BMAAtGkF9FqJLiY';

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Not configured' }, 500);

  const isAdmin = await verifyAdmin(request);
  if (!isAdmin) return json({ error: 'Forbidden' }, 403);

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  const [founders, active, inactive, commissions, recentCommissions] = await Promise.all([
    countRows('founding_members', '', serviceKey),
    countRows('referrals', '&status=eq.active', serviceKey),
    countRows('referrals', '&status=eq.inactive', serviceKey),
    sumCommissions(serviceKey),
    recentCommissionsList(serviceKey),
  ]);

  return json({
    founders,
    activeReferrals: active,
    inactiveReferrals: inactive,
    commissionCount: commissions.count,
    commissionTotal: commissions.total,
    recentCommissions,
  });
}

// Most recent 50 commissions, joined in JS with founder_number (read-only —
// admin-referrals.html shows this as a plain audit list, no edit action).
async function recentCommissionsList(serviceKey) {
  try {
    const [commRes, foundersRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/referral_commissions?select=id,referrer_id,amount,created_at&order=created_at.desc&limit=50`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/founding_members?select=user_id,founder_number`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      ),
    ]);
    const rows     = await commRes.json().catch(() => []);
    const founders = await foundersRes.json().catch(() => []);
    const numberByUserId = new Map((Array.isArray(founders) ? founders : []).map(f => [f.user_id, f.founder_number]));
    return (Array.isArray(rows) ? rows : []).map(c => ({
      id:            c.id,
      founderNumber: numberByUserId.get(c.referrer_id) ?? null,
      amount:        c.amount,
      createdAt:     c.created_at,
    }));
  } catch (e) {
    console.error('recentCommissionsList failed:', e.message);
    return [];
  }
}

// Verifies the request's bearer token against Supabase directly (the
// standard server-side way to validate a client-supplied Supabase JWT) and
// checks the REAL app_metadata Supabase returns — never trusts anything the
// client itself claims about its own admin status.
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

async function countRows(table, filter, serviceKey) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id${filter}`, {
      headers: {
        apikey:        serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer:        'count=exact',
        Range:         '0-0',
      },
    });
    const range = r.headers.get('content-range');
    return range ? (parseInt(range.split('/')[1], 10) || 0) : 0;
  } catch (e) {
    console.error(`countRows(${table}) failed:`, e.message);
    return 0;
  }
}

async function sumCommissions(serviceKey) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/referral_commissions?select=amount`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    const rows = await r.json().catch(() => []);
    if (!Array.isArray(rows)) return { count: 0, total: 0 };
    const total = rows.reduce((s, row) => s + Number(row.amount || 0), 0);
    return { count: rows.length, total };
  } catch (e) {
    console.error('sumCommissions failed:', e.message);
    return { count: 0, total: 0 };
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
