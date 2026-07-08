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
    return json({ error: `Internal error: ${e && e.message}` }, 500);
  }
}

async function handleWaitlist(env, request) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Waitlist not configured' }, 500);
  }

  let email;
  try {
    ({ email } = await request.json());
  } catch {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }

  email = (email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return json({ error: 'Please enter a valid email address.' }, 400);
  }

  return json({
    debug: true,
    hasKey: !!env.SUPABASE_SERVICE_ROLE_KEY,
    keyLen: (env.SUPABASE_SERVICE_ROLE_KEY || '').length,
    email,
  }, 200);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
