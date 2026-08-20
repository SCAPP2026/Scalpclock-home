// GET /api/linkhunter/opportunities — list with filters/sort (Phase 18),
// joined with the parent prospect's domain/status for the Opportunities
// leaderboard view.
import { withAdmin, json, sbSelectWithCount } from '../../lib/linkhunter/supabase.js';
import { OPPORTUNITY_TYPES } from '../../lib/linkhunter/validation.js';

export const onRequest = withAdmin(async ({ request, env }) => {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const params = new URL(request.url).searchParams;
  const filters = [];

  const status = params.get('status');
  if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);

  const type = params.get('opportunity_type');
  if (type && OPPORTUNITY_TYPES.includes(type)) filters.push(`opportunity_type=eq.${type}`);

  const minScore = params.get('min_score');
  if (minScore) filters.push(`opportunity_score=gte.${Number(minScore) || 0}`);

  const page = Math.max(1, parseInt(params.get('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('page_size') || '25', 10)));
  const from = (page - 1) * pageSize;

  try {
    // PostgREST embedded-resource syntax pulls the parent prospect's
    // display fields in the same round trip.
    const query = `select=*,prospects(domain,url,status,contact_email)&order=opportunity_score.desc.nullslast&limit=${pageSize}&offset=${from}${filters.length ? '&' + filters.join('&') : ''}`;
    const { rows, count } = await sbSelectWithCount('opportunities', query, env.SUPABASE_SERVICE_ROLE_KEY);
    return json({ opportunities: rows, total: count, page, pageSize });
  } catch (e) {
    console.error('opportunities list failed:', e.message);
    return json({ error: 'Failed to load opportunities' }, 500);
  }
});
