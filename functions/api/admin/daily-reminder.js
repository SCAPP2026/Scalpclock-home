// Founding Member daily reminder email — admin-triggered (not an automated
// cron, by deliberate choice: a human reviews/clicks send each day, at
// least for now). GET lists who would receive it + when it last went out;
// POST actually sends via Resend. Same admin-verification pattern as
// functions/api/admin/referrals.js — see that file's comment for why every
// admin endpoint re-verifies the caller's token against Supabase rather
// than trusting a client-sent flag.
const SUPABASE_URL  = 'https://fnuqxiflqqejjttxymbz.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZudXF4aWZscXFlamp0dHh5bWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzMxODksImV4cCI6MjA5ODAwOTE4OX0.XE1-LPW0043gRFEAl9onCahkmpQ8BMAAtGkF9FqJLiY';
const FROM_EMAIL = 'ScalpClock <admin@scalpclock.com>';
const REMINDER_TYPE = 'daily_reminder';
// KV key for "last sent" display only — reuses the same binding as
// Sampson X's rate limits (CHART_FEEDBACK_KV), a different key prefix, no
// new manual Cloudflare binding needed.
const LAST_SENT_KEY = 'daily_reminder:last_sent';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Not configured' }, 500);

  const admin = await verifyAdmin(request);
  if (!admin) return json({ error: 'Forbidden' }, 403);

  if (request.method === 'GET')  return handlePreview(env);
  if (request.method === 'POST') return handleSend(env);
  return json({ error: 'Method not allowed' }, 405);
}

// Founding Members with a real linked email, minus anyone who's
// unsubscribed from this specific email type.
async function getRecipients(serviceKey) {
  const [foundersRes, unsubRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/founding_members?select=founder_number,user_id&user_id=not.is.null`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
    fetch(`${SUPABASE_URL}/rest/v1/email_unsubscribes?type=eq.${REMINDER_TYPE}&select=email`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }),
  ]);
  const founders = await foundersRes.json().catch(() => []);
  const unsubs   = await unsubRes.json().catch(() => []);
  const unsubbed = new Set((Array.isArray(unsubs) ? unsubs : []).map(u => u.email.toLowerCase()));

  // auth.users isn't exposed via the public REST API -- fetch each user's
  // email via the Admin API, same pattern webhook.js/activate.js already
  // use for upsertProfile's fetch-then-merge.
  const users = await Promise.all((Array.isArray(founders) ? founders : []).map(async (f) => {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${f.user_id}`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (!r.ok) return null;
      const u = await r.json();
      const email = (u.email || u.user?.email || '').toLowerCase();
      if (!email) return null;
      const firstName = u.user_metadata?.first_name || u.user?.user_metadata?.first_name || '';
      return { founderNumber: f.founder_number, email, firstName };
    } catch (e) {
      return null;
    }
  }));

  return users.filter(u => u && !unsubbed.has(u.email));
}

async function handlePreview(env) {
  try {
    const recipients = await getRecipients(env.SUPABASE_SERVICE_ROLE_KEY);
    let lastSent = null;
    if (env.CHART_FEEDBACK_KV) lastSent = await env.CHART_FEEDBACK_KV.get(LAST_SENT_KEY);
    return json({ recipients, count: recipients.length, lastSent });
  } catch (e) {
    console.error('daily-reminder preview failed:', e.message);
    return json({ error: 'Failed to load recipients' }, 500);
  }
}

async function handleSend(env) {
  if (!env.RESEND_API_KEY) return json({ error: 'RESEND_API_KEY not configured' }, 500);

  let recipients;
  try {
    recipients = await getRecipients(env.SUPABASE_SERVICE_ROLE_KEY);
  } catch (e) {
    return json({ error: 'Failed to load recipients' }, 500);
  }
  if (!recipients.length) return json({ error: 'No recipients to send to' }, 400);

  const results = await Promise.all(recipients.map(async (r) => {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: r.email,
          subject: '🔥 Your Daily Trading System is waiting',
          html: buildEmailHtml(r),
        }),
      });
      if (!res.ok) {
        const detail = await res.text();
        console.error('Resend send failed for', r.email, detail);
        return { email: r.email, ok: false };
      }
      return { email: r.email, ok: true };
    } catch (e) {
      console.error('Resend send threw for', r.email, e.message);
      return { email: r.email, ok: false };
    }
  }));

  if (env.CHART_FEEDBACK_KV) {
    await env.CHART_FEEDBACK_KV.put(LAST_SENT_KEY, new Date().toISOString());
  }

  const sent = results.filter(r => r.ok).length;
  return json({ ok: true, sent, failed: results.length - sent, results });
}

function buildEmailHtml(recipient) {
  const name = recipient.firstName || 'Founder';
  const unsubUrl = `https://scalpclock.com/api/unsubscribe?email=${encodeURIComponent(recipient.email)}&type=${REMINDER_TYPE}`;
  // NOTE: recurring commercial email should include a physical mailing
  // address in the footer (CAN-SPAM) -- add VSLLC's mailing address below
  // once you have one to publish. Flagged, not fabricated.
  return `
  <div style="font-family:-apple-system,Segoe UI,Inter,sans-serif;max-width:480px;margin:0 auto;background:#070b10;color:#dde8f5;padding:32px 24px;border-radius:16px;">
    <div style="font-family:Rajdhani,sans-serif;font-weight:700;font-size:1.3rem;color:#eef3f0;margin-bottom:4px;">Scalp<em style="color:#16d97e;font-style:normal;">Clock</em></div>
    <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;color:#16d97e;font-weight:700;margin-bottom:20px;">Founding Member Reminder</div>
    <p style="font-size:1rem;line-height:1.6;">Hey ${escapeHtml(name)},</p>
    <p style="font-size:1rem;line-height:1.6;">Today's a good day to run your <strong>Daily Trading System</strong> — prepare, read the market, confirm your setup, and log your plan. It only takes a few minutes, and every day you show up builds your streak and your discipline.</p>
    <p style="font-size:1rem;line-height:1.6;">Consistency is what actually separates traders who improve from traders who don't. You don't need a win today — you need a rep.</p>
    <div style="text-align:center;margin:28px 0;">
      <a href="https://scalpclock.com/daily-system" style="background:#16d97e;color:#04140F;font-family:Rajdhani,sans-serif;font-weight:700;padding:14px 28px;border-radius:10px;text-decoration:none;display:inline-block;">Start Today's Session →</a>
    </div>
    <p style="font-size:.85rem;color:#8aa4c0;line-height:1.6;">As a Founding Member, you've also got Sampson X (your AI trading coach) if you want to talk through a concept before you trade — <a href="https://scalpclock.com/sampson-x" style="color:#16d97e;">ask Sampson X →</a></p>
    <hr style="border:none;border-top:1px solid #1e2d42;margin:28px 0 16px;">
    <p style="font-size:.72rem;color:#5a7292;line-height:1.6;">You're receiving this because you're a ScalpClock Founding Member. <a href="${unsubUrl}" style="color:#5a7292;">Unsubscribe from this daily reminder</a> — you'll still get essential account/billing emails. ScalpClock is a product of VSLLC.</p>
  </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
}

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
