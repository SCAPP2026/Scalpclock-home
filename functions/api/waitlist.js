const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  try {
    return await handleWaitlist(env, request);
  } catch (e) {
    console.error('Waitlist fatal:', e && e.stack || e);
    // Cloudflare's edge replaces the body of Worker-returned 5xx responses
    // with its own generic error page, so client-facing failures use 200
    // with an error field instead — the frontend branches on data.ok, not
    // on HTTP status.
    return json({ error: `Internal error: ${e && e.message}` }, 200);
  }
}

async function handleWaitlist(env, request) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Waitlist not configured' }, 200);
  }

  let email, source;
  try {
    ({ email, source } = await request.json());
  } catch {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }

  email = (email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/maintenance_waitlist?on_conflict=email`, {
    method: 'POST',
    headers: {
      apikey:         env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization:  `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer:         'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify({ email, source: source || 'maintenance_waitlist' }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('Waitlist insert failed:', res.status, detail);
    return json({ error: 'Could not save your email. Please try again.' }, 200);
  }

  return json({ ok: true }, 200);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
