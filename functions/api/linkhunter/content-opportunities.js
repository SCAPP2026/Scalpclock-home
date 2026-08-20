// GET /api/linkhunter/content-opportunities — Phase 15/17: groups
// opportunities into topic clusters (by the parent prospect's category) and
// surfaces clusters where no existing asset is a good match (recommended_asset
// is null on 3+ opportunities), i.e. candidates for a genuinely new
// ScalpClock asset.
// POST /api/linkhunter/content-opportunities — { topic } runs the
// ContentOpportunityService AI check for one cluster and returns a
// suggestion; nothing is auto-created in content_assets, an admin adds it
// manually from the Content Assets page if they like the suggestion.
import { withAdmin, json, sbSelect } from '../../lib/linkhunter/supabase.js';
import { checkAndIncrement } from '../../lib/linkhunter/rate-limit.js';
import { callClaude } from '../../lib/linkhunter/ai.js';
import { buildContentOpportunityPrompt } from '../../lib/linkhunter/prompts/content-opportunity.js';
import { parseAiJson } from '../../lib/linkhunter/validation.js';

const MIN_CLUSTER_SIZE = 3;

export const onRequest = withAdmin(async ({ request, env }) => {
  if (request.method === 'GET') return handleClusters(env);
  if (request.method === 'POST') return handleSuggest(request, env);
  return json({ error: 'Method not allowed' }, 405);
});

async function handleClusters(env) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    // Phase 17 — all prospects grouped by topical cluster (category).
    const prospects = await sbSelect('prospects', 'select=id,category', serviceKey);
    const clusterCounts = new Map();
    for (const p of prospects) {
      const key = p.category || 'Uncategorized';
      clusterCounts.set(key, (clusterCounts.get(key) || 0) + 1);
    }
    const clusters = [...clusterCounts.entries()]
      .map(([topic, count]) => ({ topic, prospectCount: count }))
      .sort((a, b) => b.prospectCount - a.prospectCount);

    // Phase 15 — same clusters, but only where opportunities exist without
    // a matched asset (recommended_asset is null), i.e. a real gap.
    const gapOpportunities = await sbSelect(
      'opportunities',
      'select=reason,prospects(category)&recommended_asset=is.null',
      serviceKey
    );
    const gapCounts = new Map();
    const gapReasons = new Map();
    for (const o of gapOpportunities) {
      const key = o.prospects?.category || 'Uncategorized';
      gapCounts.set(key, (gapCounts.get(key) || 0) + 1);
      if (!gapReasons.has(key)) gapReasons.set(key, []);
      if (o.reason) gapReasons.get(key).push(o.reason);
    }
    const contentGaps = [...gapCounts.entries()]
      .filter(([, count]) => count >= MIN_CLUSTER_SIZE)
      .map(([topic, count]) => ({ topic, opportunityCount: count, sampleReasons: gapReasons.get(topic).slice(0, 5) }))
      .sort((a, b) => b.opportunityCount - a.opportunityCount);

    return json({ clusters, contentGaps });
  } catch (e) {
    console.error('content-opportunities clusters failed:', e.message);
    return json({ error: 'Failed to load clusters' }, 500);
  }
}

async function handleSuggest(request, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Content-opportunity analysis is not configured yet' }, 500);
  if (!env.LINKHUNTER_KV) return json({ error: 'LinkHunter is not configured yet (missing LINKHUNTER_KV)' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const topic = typeof body?.topic === 'string' ? body.topic.slice(0, 200) : null;
  if (!topic) return json({ error: 'topic is required' }, 400);

  const aiLimit = await checkAndIncrement(env.LINKHUNTER_KV, 'ai_generation');
  if (!aiLimit.allowed) return json({ error: `Daily AI-generation limit reached (${aiLimit.limit}/day)` }, 429);

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const [existingAssets, opportunities] = await Promise.all([
      sbSelect('content_assets', 'select=title,asset_type', serviceKey),
      sbSelect('opportunities', `select=reason,prospects!inner(category)&prospects.category=eq.${encodeURIComponent(topic)}&recommended_asset=is.null&limit=20`, serviceKey),
    ]);
    const sampleReasons = opportunities.map((o) => o.reason).filter(Boolean);

    const { system, prompt } = buildContentOpportunityPrompt({ clusterTopic: topic, sampleReasons, existingAssets });
    const text = await callClaude(env, { system, prompt, maxTokens: 400 });
    const suggestion = parseAiJson(text);

    return json({ topic, suggestion });
  } catch (e) {
    console.error('content-opportunity suggest failed:', e.message);
    return json({ error: 'Content-opportunity analysis failed' }, 500);
  }
}
