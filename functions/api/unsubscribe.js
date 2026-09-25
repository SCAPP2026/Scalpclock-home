// Public, no-auth unsubscribe link for recurring emails (currently just the
// Founding Member daily reminder, functions/api/admin/daily-reminder.js).
// GET /api/unsubscribe?email=foo@bar.com&type=daily_reminder
//
// Deliberately no signed/HMAC token here — the worst case of someone
// guessing another person's email and unsubscribing them from a low-stakes
// motivational reminder is not worth the complexity of a signing scheme;
// this mirrors how most real-world list-unsubscribe links work in practice.
const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';
const ALLOWED_TYPES = new Set(['daily_reminder']);

export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const email = (url.searchParams.get('email') || '').trim().toLowerCase();
  const type = url.searchParams.get('type') || 'daily_reminder';

  if (!email || !email.includes('@') || !ALLOWED_TYPES.has(type)) {
    return html('Invalid unsubscribe link. Email support@scalpclock.com and we\'ll remove you by hand.', 400);
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return html('Something went wrong on our end — email support@scalpclock.com and we\'ll remove you by hand.', 500);
  }

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/email_unsubscribes`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates',
      },
      body: JSON.stringify({ email, type }),
    });
  } catch (e) {
    console.error('unsubscribe insert failed:', e.message);
    return html('Something went wrong on our end — email support@scalpclock.com and we\'ll remove you by hand.', 500);
  }

  return html(`You're unsubscribed from ${type === 'daily_reminder' ? 'the daily reminder email' : 'this email'}. You'll still get essential account/billing emails.`, 200);
}

function html(message, status) {
  return new Response(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Unsubscribed — ScalpClock</title><meta name="robots" content="noindex"></head><body style="font-family:system-ui,sans-serif;background:#070b10;color:#dde8f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center;"><div style="max-width:420px;"><h1 style="font-size:1.3rem;">ScalpClock</h1><p>${message}</p><a href="/" style="color:#16d97e;">Back to ScalpClock →</a></div></body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
