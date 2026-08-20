// POST /api/linkhunter/outreach/:id/send — Phase 11's final, human-gated
// step. Only ever sends outreach that is already APPROVED (never DRAFT,
// never anything else) -- this is the one and only place status can become
// SENT. No transactional email provider is configured in this repo yet
// (RESEND_API_KEY), so this returns a clear "not configured" error rather
// than silently no-oping or fabricating a send; wiring a real provider is a
// deliberate later step, not something to invent credentials for here.
import { withAdmin, json, sbSelect, sbUpdate } from '../../../../lib/linkhunter/supabase.js';

const RESEND_API_URL = 'https://api.resend.com/emails';

export const onRequest = withAdmin(async ({ request, env, params }) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id)) return json({ error: 'Invalid outreach id' }, 400);

  if (!env.RESEND_API_KEY || !env.LINKHUNTER_FROM_EMAIL) {
    return json({ error: 'Outreach sending is not configured yet -- set RESEND_API_KEY and LINKHUNTER_FROM_EMAIL to enable it' }, 500);
  }

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const [existing] = await sbSelect('outreach', `id=eq.${id}&select=*`, serviceKey);
    if (!existing) return json({ error: 'Not found' }, 404);
    if (existing.status !== 'APPROVED') return json({ error: `Cannot send outreach in status ${existing.status} -- it must be APPROVED first` }, 409);
    if (!existing.approved_by_user) return json({ error: 'Outreach has no recorded approver -- refusing to send' }, 409);
    if (!existing.contact_email) return json({ error: 'No contact_email on this outreach -- add one before sending' }, 400);

    const sendRes = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.LINKHUNTER_FROM_EMAIL,
        to: existing.contact_email,
        subject: existing.subject,
        text: existing.body,
      }),
    });

    if (!sendRes.ok) {
      const text = await sendRes.text().catch(() => '');
      console.error('outreach send provider error:', sendRes.status, text);
      return json({ error: 'Email provider rejected the send' }, 502);
    }

    const rows = await sbUpdate('outreach', `id=eq.${id}`, {
      status: 'SENT',
      sent_at: new Date().toISOString(),
    }, serviceKey);
    await sbUpdate('prospects', `id=eq.${existing.prospect_id}`, { status: 'CONTACTED' }, serviceKey, { returnRows: false });

    return json({ outreach: rows[0] });
  } catch (e) {
    console.error('outreach send failed:', e.message);
    return json({ error: 'Failed to send outreach' }, 500);
  }
});
