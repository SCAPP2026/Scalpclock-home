// POST /api/linkhunter/opportunities/generate — body { prospect_id }.
// Runs the full Phase 5/6/7/8 pipeline (quality scoring -> opportunity
// generation -> asset matching -> opportunity scoring) for one prospect.
import { withAdmin, json } from '../../../lib/linkhunter/supabase.js';
import { checkAndIncrement } from '../../../lib/linkhunter/rate-limit.js';
import { runProspectAnalysis } from '../../../lib/linkhunter/pipeline.js';

export const onRequest = withAdmin(async ({ request, env }) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Opportunity generation is not configured yet' }, 500);
  if (!env.LINKHUNTER_KV) return json({ error: 'LinkHunter is not configured yet (missing LINKHUNTER_KV)' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const prospectId = parseInt(body?.prospect_id, 10);
  if (!Number.isInteger(prospectId)) return json({ error: 'prospect_id is required' }, 400);

  const analysisLimit = await checkAndIncrement(env.LINKHUNTER_KV, 'website_analysis');
  if (!analysisLimit.allowed) return json({ error: `Daily website-analysis limit reached (${analysisLimit.limit}/day)` }, 429);
  const aiLimit = await checkAndIncrement(env.LINKHUNTER_KV, 'ai_generation');
  if (!aiLimit.allowed) return json({ error: `Daily AI-generation limit reached (${aiLimit.limit}/day)` }, 429);

  try {
    const result = await runProspectAnalysis(prospectId, { env, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY });
    return json(result);
  } catch (e) {
    console.error('opportunity generation failed:', e.message);
    if (e.message === 'Prospect not found') return json({ error: e.message }, 404);
    return json({ error: 'Opportunity generation failed' }, 500);
  }
});
