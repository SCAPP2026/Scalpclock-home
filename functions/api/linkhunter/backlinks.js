// GET /api/linkhunter/backlinks — list, filterable by status/prospect
// (Phase 13/14 dashboard: "Lost Backlinks" view uses ?status=LOST).
import { withAdmin, json, sbSelectWithCount } from '../../lib/linkhunter/supabase.js';
import { BACKLINK_STATUSES } from '../../lib/linkhunter/validation.js';

export const onRequest = withAdmin(async ({ request, env }) => {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const params = new URL(request.url).searchParams;
  const filters = [];
  const status = params.get('status');
  if (status && BACKLINK_STATUSES.includes(status)) filters.push(`status=eq.${status}`);
  const prospectId = params.get('prospect_id');
  if (prospectId) filters.push(`prospect_id=eq.${parseInt(prospectId, 10) || 0}`);

  try {
    const query = `select=*,prospects(domain,url)&order=first_seen.desc&limit=100${filters.length ? '&' + filters.join('&') : ''}`;
    const { rows, count } = await sbSelectWithCount('backlinks', query, env.SUPABASE_SERVICE_ROLE_KEY);
    return json({ backlinks: rows, total: count });
  } catch (e) {
    console.error('backlinks list failed:', e.message);
    return json({ error: 'Failed to load backlinks' }, 500);
  }
});
