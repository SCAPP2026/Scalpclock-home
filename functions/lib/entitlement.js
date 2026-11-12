// Server-side plan check for PRO features.
//
// Same rule the paywalled pages use client-side (scalpchart.html,
// exitassistant.html): a signed-in user whose app_metadata.plan is anything
// other than 'free' or 'expired' has access — that covers pro, elite, trial
// and founding members, whose plan the Stripe webhook / activation flow sets.
// Admins always have access. The token is verified with Supabase on every
// call; nothing the browser sends about its own plan is trusted.
const SUPABASE_URL  = 'https://fnuqxiflqqejjttxymbz.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZudXF4aWZscXFlamp0dHh5bWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzMxODksImV4cCI6MjA5ODAwOTE4OX0.XE1-LPW0043gRFEAl9onCahkmpQ8BMAAtGkF9FqJLiY';

const NO_ACCESS = new Set(['free', 'expired']);

/** Pure: does this Supabase user object have PRO access? */
export function hasProAccess(user) {
  if (!user || !user.id) return false;
  const meta = user.app_metadata || {};
  if (meta.is_admin === true) return true;
  const plan = meta.plan || 'free';
  return !NO_ACCESS.has(plan);
}

/**
 * Verify the request's bearer token. Returns
 *   { status: 'anon' }                       no / invalid token
 *   { status: 'free', user }                 signed in, no PRO plan
 *   { status: 'pro', user }                  PRO access
 */
export async function checkPro(request, fetchImpl = fetch) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return { status: 'anon' };
  try {
    const r = await fetchImpl(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${token}` } });
    if (!r.ok) return { status: 'anon' };
    const user = await r.json();
    return { status: hasProAccess(user) ? 'pro' : 'free', user };
  } catch (e) {
    console.error('checkPro failed:', e.message);
    return { status: 'anon' };
  }
}
