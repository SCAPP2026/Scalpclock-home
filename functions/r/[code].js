// /r/<code> — a founder's short referral link. Validates the code, sets the
// attribution cookie, and redirects to the public landing page. Cloudflare
// Pages' [param] filename convention maps this file to /r/:code, exposed as
// context.params.code.
//
// /join?ref=<code> is the other entry point required by the program spec —
// it reuses this exact cookie via a small snippet in login.html rather than
// duplicating this lookup, see login.html + the "/join /login 302" rule in
// _redirects.
const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';
const DEFAULT_COOKIE_DAYS = 60;

export async function onRequest(context) {
  const { env, params } = context;
  const rawCode = (params.code || '').toString();
  const code    = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

  if (!code || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return Response.redirect(new URL('/founders', context.request.url), 302);
  }

  try {
    const founderRes = await fetch(
      `${SUPABASE_URL}/rest/v1/founding_members?referral_code=eq.${encodeURIComponent(code)}&select=user_id`,
      {
        headers: {
          apikey:        env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const founders = await founderRes.json().catch(() => []);
    const valid    = Array.isArray(founders) && founders.length > 0;

    // Unknown/mistyped codes still land on the landing page — just without
    // an attribution cookie — rather than showing a raw error for what's
    // meant to be a friendly marketing link.
    if (!valid) {
      return Response.redirect(new URL('/founders', context.request.url), 302);
    }

    const cookieDays = await getCookieDays(env.SUPABASE_SERVICE_ROLE_KEY);
    const maxAge = cookieDays * 24 * 60 * 60;

    const headers = new Headers();
    headers.set('Location', new URL('/founders', context.request.url).toString());
    headers.append('Set-Cookie', `scalpclock_ref=${code}; Max-Age=${maxAge}; Path=/; SameSite=Lax`);
    return new Response(null, { status: 302, headers });
  } catch (e) {
    console.error('/r/[code] failed:', e.message);
    return Response.redirect(new URL('/founders', context.request.url), 302);
  }
}

async function getCookieDays(serviceKey) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/referral_program_settings?id=eq.1&select=referral_cookie_days`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    );
    const rows = await res.json().catch(() => []);
    return (Array.isArray(rows) && rows[0]?.referral_cookie_days) || DEFAULT_COOKIE_DAYS;
  } catch {
    return DEFAULT_COOKIE_DAYS;
  }
}
