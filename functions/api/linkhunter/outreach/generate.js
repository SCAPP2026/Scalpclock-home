// POST /api/linkhunter/outreach/generate — body { opportunity_id,
// campaign_id? }. Phase 10 OutreachGenerator: drafts a personalized email
// from the opportunity's context. Always lands as status DRAFT -- nothing
// here ever sends anything (Phase 11 human-approval gate is a separate,
// later step).
import { withAdmin, json, sbSelect, sbInsert } from '../../../lib/linkhunter/supabase.js';
import { checkAndIncrement } from '../../../lib/linkhunter/rate-limit.js';
import { callClaude } from '../../../lib/linkhunter/ai.js';
import { buildOutreachGenerationPrompt } from '../../../lib/linkhunter/prompts/outreach-generation.js';
import { parseAiJson, validateOutreachDraft } from '../../../lib/linkhunter/validation.js';

export const onRequest = withAdmin(async ({ request, env }) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Outreach generation is not configured yet' }, 500);
  if (!env.LINKHUNTER_KV) return json({ error: 'LinkHunter is not configured yet (missing LINKHUNTER_KV)' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const opportunityId = parseInt(body?.opportunity_id, 10);
  if (!Number.isInteger(opportunityId)) return json({ error: 'opportunity_id is required' }, 400);

  const aiLimit = await checkAndIncrement(env.LINKHUNTER_KV, 'ai_generation');
  if (!aiLimit.allowed) return json({ error: `Daily AI-generation limit reached (${aiLimit.limit}/day)` }, 429);

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const [opportunity] = await sbSelect('opportunities', `id=eq.${opportunityId}&select=*`, serviceKey);
    if (!opportunity) return json({ error: 'Opportunity not found' }, 404);
    const [prospect] = await sbSelect('prospects', `id=eq.${opportunity.prospect_id}&select=*`, serviceKey);
    if (!prospect) return json({ error: 'Prospect not found' }, 404);

    let asset = null;
    if (opportunity.recommended_asset) {
      const assets = await sbSelect('content_assets', `title=eq.${encodeURIComponent(opportunity.recommended_asset)}&select=*`, serviceKey);
      asset = assets[0] || null;
    }

    const { system, prompt } = buildOutreachGenerationPrompt({ prospect, opportunity, asset });
    const text = await callClaude(env, { system, prompt, maxTokens: 700 });
    const raw = parseAiJson(text);
    const validated = validateOutreachDraft(raw);
    if (!validated.ok) return json({ error: `AI draft failed validation: ${validated.errors.join(', ')}` }, 502);

    const rows = await sbInsert('outreach', {
      prospect_id: prospect.id,
      opportunity_id: opportunity.id,
      campaign_id: Number.isInteger(parseInt(body.campaign_id, 10)) ? parseInt(body.campaign_id, 10) : null,
      contact_name: prospect.contact_name,
      contact_email: prospect.contact_email,
      subject: validated.value.subject,
      body: validated.value.body,
      status: 'DRAFT',
    }, serviceKey);

    return json({ outreach: rows[0] }, 201);
  } catch (e) {
    console.error('outreach generate failed:', e.message);
    return json({ error: 'Outreach generation failed' }, 500);
  }
});
