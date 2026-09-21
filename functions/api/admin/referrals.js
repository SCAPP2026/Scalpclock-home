// Admin-only referral list + manual fraud-review override for
// admin-referrals.html. See overview.js for why every admin endpoint
// re-verifies the caller's token against Supabase rather than trusting a
// client-sent flag.
const SUPABASE_URL  = 'https://fnuqxiflqqejjttxymbz.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZudXF4aWZscXFlamp0dHh5bWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzMxODksImV4cCI6MjA5ODAwOTE4OX0.XE1-LPW0043gRFEAl9onCahkmpQ8BMAAtGkF9FqJLiY';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Not configured' }, 500);

  const admin = await verifyAdmin(request);
  if (!admin) return json({ error: 'Forbidden' }, 403);

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (request.method === 'GET') return handleList(serviceKey);
  if (request.method === 'PATCH') return handlePatch(request, serviceKey);
  if (request.method === 'POST') return handleRecordPayout(request, serviceKey, admin.id);
  return json({ error: 'Method not allowed' }, 405);
}

async function handleList(serviceKey) {
  try {
    const [refsRes, foundersRes, commissionsRes, payoutsRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/referrals?select=id,referrer_id,referred_user_id,status,created_at&order=created_at.desc&limit=200`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/founding_members?select=user_id,founder_number`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/referral_commissions?select=referrer_id,amount`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/referral_payouts?select=referrer_id,amount`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      ),
    ]);
    const refs        = await refsRes.json().catch(() => []);
    const founders     = await foundersRes.json().catch(() => []);
    const commissions  = await commissionsRes.json().catch(() => []);
    const payouts       = await payoutsRes.json().catch(() => []);
    const numberByUserId = new Map((Array.isArray(founders) ? founders : []).map(f => [f.user_id, f.founder_number]));

    const referrals = (Array.isArray(refs) ? refs : []).map(r => ({
      id:              r.id,
      founderNumber:   numberByUserId.get(r.referrer_id) ?? null,
      referredUserId:  r.referred_user_id,
      status:          r.status,
      createdAt:       r.created_at,
    }));

    // Per-referrer balance: every Founding Member gets a row, even ones with
    // zero commissions/payouts yet, so the admin can see everyone eligible
    // to receive a payout, not just those with existing activity.
    const earnedByReferrer = sumByReferrer(commissions);
    const paidByReferrer   = sumByReferrer(payouts);
    const referrers = (Array.isArray(founders) ? founders : []).map(f => {
      const totalEarned = earnedByReferrer.get(f.user_id) || 0;
      const totalPaid    = paidByReferrer.get(f.user_id) || 0;
      return {
        referrerId:     f.user_id,
        founderNumber:  f.founder_number,
        totalEarned,
        totalPaid,
        pendingBalance: totalEarned - totalPaid,
      };
    }).sort((a, b) => b.pendingBalance - a.pendingBalance);

    return json({ referrals, referrers });
  } catch (e) {
    console.error('handleList failed:', e.message);
    return json({ error: 'Failed to load referrals' }, 500);
  }
}

function sumByReferrer(rows) {
  const map = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    map.set(row.referrer_id, (map.get(row.referrer_id) || 0) + Number(row.amount || 0));
  }
  return map;
}

// Records a manual payout (PayPal/Venmo/bank transfer/etc. sent outside the
// app) as its own ledger row — never mutates or deletes a commission row,
// matching the accrual-ledger pattern referral_commissions already uses.
// Pending balance is always (sum of commissions) - (sum of payouts),
// computed fresh in handleList rather than stored/cached anywhere.
async function handleRecordPayout(request, serviceKey, adminId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const { referrer_id, amount, method, note } = body || {};
  const amountNum = Number(amount);
  if (!referrer_id || !Number.isFinite(amountNum) || amountNum <= 0) {
    return json({ error: 'referrer_id and a positive amount are required' }, 400);
  }

  try {
    // Confirm referrer_id is a real Founding Member before recording money
    // against it -- refuses to create a payout row for an arbitrary/typo'd
    // user id.
    const founderCheck = await fetch(
      `${SUPABASE_URL}/rest/v1/founding_members?select=user_id&user_id=eq.${encodeURIComponent(referrer_id)}`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    const founderRows = await founderCheck.json().catch(() => []);
    if (!Array.isArray(founderRows) || founderRows.length === 0) {
      return json({ error: 'referrer_id is not a Founding Member' }, 400);
    }

    const r = await fetch(`${SUPABASE_URL}/rest/v1/referral_payouts`, {
      method:  'POST',
      headers: {
        apikey:         serviceKey,
        Authorization:  `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer:         'return=representation',
      },
      body: JSON.stringify({
        referrer_id,
        amount: amountNum,
        method: method || null,
        note:   note || null,
        created_by: adminId,
      }),
    });
    if (!r.ok) {
      const text = await r.text();
      console.error('record payout insert error:', r.status, text);
      return json({ error: 'Insert failed' }, 500);
    }
    const [row] = await r.json();
    return json({ ok: true, payout: row });
  } catch (e) {
    console.error('handleRecordPayout failed:', e.message);
    return json({ error: 'Insert failed' }, 500);
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

// Returns the verified admin's user object (so callers can read .id for
// created_by, etc.) or null if not a real, currently-admin user. Kept as
// one function rather than a separate isAdmin/getUserId pair so there's
// only one place that re-verifies the token against Supabase.
async function verifyAdmin(request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const user = await r.json();
    return user?.app_metadata?.is_admin === true ? user : null;
  } catch (e) {
    console.error('verifyAdmin failed:', e.message);
    return null;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
