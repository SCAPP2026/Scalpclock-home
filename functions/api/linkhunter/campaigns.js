// GET /api/linkhunter/campaigns — list with prospect/outreach counts.
// POST /api/linkhunter/campaigns — create (Phase 16). Prospect-matching
// (auto-assigning matching prospects to a campaign by target_category) runs
// as a simple category match at read time via the campaign's target_category
// rather than a separate background job -- there's no queue/worker
// infrastructure in this repo to run one.
import { withAdmin, json, sbSelect, sbInsert } from '../../lib/linkhunter/supabase.js';

export const onRequest = withAdmin(async ({ request, env }) => {
  if (request.method === 'GET') return handleList(env);
  if (request.method === 'POST') return handleCreate(request, env);
  return json({ error: 'Method not allowed' }, 405);
});

async function handleList(env) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const campaigns = await sbSelect('campaigns', 'select=*&order=created_at.desc', serviceKey);
    const withCounts = await Promise.all(campaigns.map(async (c) => {
      const [outreachRows, matchingProspects] = await Promise.all([
        sbSelect('outreach', `campaign_id=eq.${c.id}&select=id,status`, serviceKey),
        c.target_category
          ? sbSelect('prospects', `category=eq.${encodeURIComponent(c.target_category)}&select=id`, serviceKey)
          : Promise.resolve([]),
      ]);
      return {
        ...c,
        outreachCount: outreachRows.length,
        sentCount: outreachRows.filter((o) => o.status === 'SENT').length,
        matchingProspectCount: matchingProspects.length,
      };
    }));
    return json({ campaigns: withCounts });
  } catch (e) {
    console.error('campaigns list failed:', e.message);
    return json({ error: 'Failed to load campaigns' }, 500);
  }
}

async function handleCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const { name, description, target_category, target_asset } = body || {};
  if (!name || typeof name !== 'string') return json({ error: 'name is required' }, 400);

  try {
    const rows = await sbInsert('campaigns', {
      name: name.slice(0, 200),
      description: description ? String(description).slice(0, 2000) : null,
      target_category: target_category ? String(target_category).slice(0, 100) : null,
      target_asset: target_asset ? String(target_asset).slice(0, 300) : null,
    }, env.SUPABASE_SERVICE_ROLE_KEY);
    return json({ campaign: rows[0] }, 201);
  } catch (e) {
    console.error('campaign create failed:', e.message);
    return json({ error: 'Failed to create campaign' }, 500);
  }
}
