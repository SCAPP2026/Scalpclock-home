// GET /api/linkhunter/outreach — Phase 12 dashboard filters (status +
// free-text response_status), joined with prospect/opportunity display
// fields.
import { withAdmin, json, sbSelectWithCount } from '../../lib/linkhunter/supabase.js';
import { OUTREACH_STATUSES } from '../../lib/linkhunter/validation.js';

export const onRequest = withAdmin(async ({ request, env }) => {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const params = new URL(request.url).searchParams;
  const filters = [];

  const status = params.get('status');
  if (status && OUTREACH_STATUSES.includes(status)) filters.push(`status=eq.${status}`);

  const responseStatus = params.get('response_status');
  if (responseStatus) filters.push(`response_status=eq.${encodeURIComponent(responseStatus)}`);

  const campaignId = params.get('campaign_id');
  if (campaignId) filters.push(`campaign_id=eq.${parseInt(campaignId, 10) || 0}`);

  const page = Math.max(1, parseInt(params.get('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('page_size') || '25', 10)));
  const from = (page - 1) * pageSize;

  try {
    const query = `select=*,prospects(domain,url),opportunities(opportunity_type,recommended_asset,opportunity_score)&order=created_at.desc&limit=${pageSize}&offset=${from}${filters.length ? '&' + filters.join('&') : ''}`;
    const { rows, count } = await sbSelectWithCount('outreach', query, env.SUPABASE_SERVICE_ROLE_KEY);
    return json({ outreach: rows, total: count, page, pageSize });
  } catch (e) {
    console.error('outreach list failed:', e.message);
    return json({ error: 'Failed to load outreach' }, 500);
  }
});
