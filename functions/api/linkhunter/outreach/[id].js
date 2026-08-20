// PATCH /api/linkhunter/outreach/:id — edit a draft (subject/body/notes),
// reject it, or mark do-not-contact (Phase 11's Edit/Reject/Do Not Contact
// buttons). Approving is a separate endpoint (approve.js) so the
// DRAFT -> APPROVED transition has one, auditable entry point; sending is
// its own endpoint too and is the only place status can ever become SENT --
// this route explicitly refuses to set SENT directly, so the approval gate
// can't be bypassed by just PATCHing the status.
import { withAdmin, json, sbUpdate, sbSelect } from '../../../lib/linkhunter/supabase.js';
import { OUTREACH_STATUSES } from '../../../lib/linkhunter/validation.js';

export const onRequest = withAdmin(async ({ request, env, params }) => {
  if (request.method !== 'PATCH') return json({ error: 'Method not allowed' }, 405);
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id)) return json({ error: 'Invalid outreach id' }, 400);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const update = {};

  if (body.subject !== undefined) update.subject = String(body.subject).slice(0, 300);
  if (body.body !== undefined) update.body = String(body.body).slice(0, 8000);
  if (body.notes !== undefined) update.notes = body.notes ? String(body.notes).slice(0, 5000) : null;
  if (body.contact_email !== undefined) update.contact_email = body.contact_email || null;
  if (body.contact_name !== undefined) update.contact_name = body.contact_name || null;
  if (body.follow_up_at !== undefined) update.follow_up_at = body.follow_up_at || null;
  if (body.response_status !== undefined) update.response_status = body.response_status ? String(body.response_status).slice(0, 100) : null;

  if (body.status !== undefined) {
    if (body.status === 'SENT') return json({ error: 'Use POST /outreach/:id/send to send outreach, not PATCH' }, 400);
    if (body.status === 'APPROVED') return json({ error: 'Use POST /outreach/:id/approve to approve outreach, not PATCH' }, 400);
    if (!OUTREACH_STATUSES.includes(body.status)) return json({ error: 'Invalid status' }, 400);
    update.status = body.status;
    // Editing a draft's content should drop any prior approval so a changed
    // email can't ride through on someone else's sign-off.
    if (body.status === 'DRAFT') update.approved_by_user = null;
  }

  if (body.reject === true) {
    update.status = 'CLOSED';
    update.notes = update.notes ?? 'Rejected by admin.';
  }

  if (!Object.keys(update).length && body.do_not_contact !== true) {
    return json({ error: 'No valid fields to update' }, 400);
  }

  try {
    if (Object.keys(update).length) {
      const rows = await sbUpdate('outreach', `id=eq.${id}`, update, serviceKey);
      if (!rows.length) return json({ error: 'Not found' }, 404);
    }

    if (body.do_not_contact === true) {
      const [existing] = await sbSelect('outreach', `id=eq.${id}&select=prospect_id`, serviceKey);
      if (!existing) return json({ error: 'Not found' }, 404);
      await sbUpdate('outreach', `id=eq.${id}`, { status: 'CLOSED' }, serviceKey, { returnRows: false });
      await sbUpdate('prospects', `id=eq.${existing.prospect_id}`, { status: 'DO_NOT_CONTACT' }, serviceKey, { returnRows: false });
    }

    const [final] = await sbSelect('outreach', `id=eq.${id}&select=*`, serviceKey);
    return json({ outreach: final });
  } catch (e) {
    console.error('outreach patch failed:', e.message);
    return json({ error: 'Failed to update outreach' }, 500);
  }
});
