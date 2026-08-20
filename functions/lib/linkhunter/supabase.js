// Shared Supabase REST helpers for functions/api/linkhunter/*.js.
// Same pattern as functions/api/admin/*.js: every caller re-verifies the
// bearer token against Supabase and requires app_metadata.is_admin === true
// before touching data; all reads/writes use the service-role key, which
// bypasses RLS (LinkHunter tables have zero RLS policies -- service-role
// access from these Functions is the only way in).

export const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';
export const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZudXF4aWZscXFlamp0dHh5bWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzMxODksImV4cCI6MjA5ODAwOTE4OX0.XE1-LPW0043gRFEAl9onCahkmpQ8BMAAtGkF9FqJLiY';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** Re-verifies the caller's Supabase JWT for real and checks the REAL
 * app_metadata Supabase returns -- never trusts a client-sent flag. Returns
 * the user object on success, or null. */
export async function verifyAdmin(request) {
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

/** Wraps a handler so every linkhunter route gets consistent OPTIONS
 * handling + admin verification without repeating the boilerplate. */
export function withAdmin(handler) {
  return async (context) => {
    const { request } = context;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!context.env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Not configured' }, 500);
    const user = await verifyAdmin(request);
    if (!user) return json({ error: 'Forbidden' }, 403);
    return handler(context, user);
  };
}

const restHeaders = (serviceKey, extra = {}) => ({
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  ...extra,
});

export async function sbSelect(table, query, serviceKey) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: restHeaders(serviceKey),
  });
  if (!r.ok) throw new Error(`sbSelect(${table}) failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function sbSelectWithCount(table, query, serviceKey) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: restHeaders(serviceKey, { Prefer: 'count=exact' }),
  });
  if (!r.ok) throw new Error(`sbSelectWithCount(${table}) failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  const range = r.headers.get('content-range');
  const count = range ? parseInt(range.split('/')[1], 10) || 0 : rows.length;
  return { rows, count };
}

export async function sbInsert(table, body, serviceKey, { returnRows = true, onConflict } = {}) {
  const url = onConflict
    ? `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`
    : `${SUPABASE_URL}/rest/v1/${table}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: restHeaders(serviceKey, {
      'Content-Type': 'application/json',
      Prefer: returnRows ? 'return=representation' : 'return=minimal',
    }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbInsert(${table}) failed: ${r.status} ${await r.text()}`);
  return returnRows ? r.json() : null;
}

export async function sbUpdate(table, filter, body, serviceKey, { returnRows = true } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: restHeaders(serviceKey, {
      'Content-Type': 'application/json',
      Prefer: returnRows ? 'return=representation' : 'return=minimal',
    }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbUpdate(${table}) failed: ${r.status} ${await r.text()}`);
  return returnRows ? r.json() : null;
}

export async function sbUpsert(table, body, onConflict, serviceKey) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: 'POST',
    headers: restHeaders(serviceKey, {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbUpsert(${table}) failed: ${r.status} ${await r.text()}`);
  return r.json();
}
