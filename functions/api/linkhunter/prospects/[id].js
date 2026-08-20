// GET /api/linkhunter/prospects/:id — single prospect + its opportunities
// and backlinks, for the Prospects detail view.
// PATCH /api/linkhunter/prospects/:id — status transitions, manual contact
// entry (Phase 9's "allow the user to manually add a contact"), notes.
import { withAdmin, json, sbSelect, sbUpdate } from '../../../lib/linkhunter/supabase.js';
import { PROSPECT_STATUSES, isValidEmail, isValidUrl, clampScore } from '../../../lib/linkhunter/validation.js';

export const onRequest = withAdmin(async ({ request, env, params }) => {
  const id = parseInt(params.id, 10);
  if (!Number.isInteger(id)) return json({ error: 'Invalid prospect id' }, 400);

  if (request.method === 'GET') return handleGet(id, env);
  if (request.method === 'PATCH') return handlePatch(request, id, env);
  return json({ error: 'Method not allowed' }, 405);
});

async function handleGet(id, env) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const [prospects, opportunities, backlinks] = await Promise.all([
      sbSelect('prospects', `id=eq.${id}&select=*`, serviceKey),
      sbSelect('opportunities', `prospect_id=eq.${id}&select=*&order=opportunity_score.desc.nullslast`, serviceKey),
      sbSelect('backlinks', `prospect_id=eq.${id}&select=*`, serviceKey),
    ]);
    if (!prospects.length) return json({ error: 'Not found' }, 404);
    return json({ prospect: prospects[0], opportunities, backlinks });
  } catch (e) {
    console.error('prospect get failed:', e.message);
    return json({ error: 'Failed to load prospect' }, 500);
  }
}

async function handlePatch(request, id, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const update = {};
  if (body.status !== undefined) {
    if (!PROSPECT_STATUSES.includes(body.status)) return json({ error: 'Invalid status' }, 400);
    update.status = body.status;
  }
  if (body.contact_name !== undefined) update.contact_name = body.contact_name ? String(body.contact_name).slice(0, 200) : null;
  if (body.contact_role !== undefined) update.contact_role = body.contact_role ? String(body.contact_role).slice(0, 200) : null;
  if (body.contact_email !== undefined) {
    if (body.contact_email && !isValidEmail(body.contact_email)) return json({ error: 'Invalid contact_email' }, 400);
    update.contact_email = body.contact_email || null;
  }
  if (body.contact_url !== undefined) {
    if (body.contact_url && !isValidUrl(body.contact_url)) return json({ error: 'Invalid contact_url' }, 400);
    update.contact_url = body.contact_url || null;
  }
  if (body.notes !== undefined) update.notes = body.notes ? String(body.notes).slice(0, 5000) : null;
  if (body.category !== undefined) update.category = body.category ? String(body.category).slice(0, 100) : null;
  if (body.domain_authority !== undefined) update.domain_authority = clampScore(body.domain_authority);
  if (body.organic_traffic_estimate !== undefined) {
    const n = Number(body.organic_traffic_estimate);
    update.organic_traffic_estimate = Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  }

  if (!Object.keys(update).length) return json({ error: 'No valid fields to update' }, 400);

  try {
    const rows = await sbUpdate('prospects', `id=eq.${id}`, update, env.SUPABASE_SERVICE_ROLE_KEY);
    if (!rows.length) return json({ error: 'Not found' }, 404);
    return json({ prospect: rows[0] });
  } catch (e) {
    console.error('prospect patch failed:', e.message);
    return json({ error: 'Failed to update prospect' }, 500);
  }
}
