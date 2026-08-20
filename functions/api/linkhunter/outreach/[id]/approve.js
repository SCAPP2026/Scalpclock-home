// POST /api/linkhunter/outreach/:id/approve — Phase 11's DRAFT -> APPROVED
// transition. The only route that can set APPROVED, and it always records
// which admin did it (approved_by_user), so /send has something real to
// check before it's ever allowed to fire.
import { withAdmin, json, sbSelect, sbUpdate } from '../../../../lib/linkhunter/supabase.js';

export const onRequest = withAdmin(async ({ request, env, params }, user) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id)) return json({ error: 'Invalid outreach id' }, 400);

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const [existing] = await sbSelect('outreach', `id=eq.${id}&select=id,status`, serviceKey);
    if (!existing) return json({ error: 'Not found' }, 404);
    if (existing.status !== 'DRAFT') return json({ error: `Cannot approve outreach in status ${existing.status} -- only DRAFT can be approved` }, 409);

    const rows = await sbUpdate('outreach', `id=eq.${id}`, {
      status: 'APPROVED',
      approved_by_user: user.id,
    }, serviceKey);
    return json({ outreach: rows[0] });
  } catch (e) {
    console.error('outreach approve failed:', e.message);
    return json({ error: 'Failed to approve outreach' }, 500);
  }
});
