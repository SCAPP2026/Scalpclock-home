// Phases 5, 6, 7, 8 — the core prospect-analysis pipeline: fetch the page,
// run WebsiteQualityService (relevance/quality/spam), then OpportunityEngine
// (which folds in AssetMatchingService's recommended_asset pick), then
// compute each opportunity's deterministic opportunity_score. Shared by
// POST /api/linkhunter/opportunities/generate.
import { fetchPageForAnalysis } from './fetch-page.js';
import { callClaude } from './ai.js';
import { buildProspectAnalysisPrompt } from './prompts/prospect-analysis.js';
import { buildOpportunityAnalysisPrompt } from './prompts/opportunity-analysis.js';
import { parseAiJson, validateQualityAnalysis, validateOpportunity, clampScore } from './validation.js';
import { computeRelevanceScore, computeQualityScore, computeOpportunityScore, computeContactabilityScore } from './scoring.js';
import { sbSelect, sbUpdate, sbInsert } from './supabase.js';

export const DEFAULT_TOPICS = [
  'options trading', 'options scalping', 'day trading', 'opening range breakout', 'ORB strategy',
  'stock trading education', 'trading psychology', 'technical analysis', 'options education',
  'trading tools', 'fintech', 'retail trading', 'trading calculators', 'stock market education',
];

/** Runs the full analysis pipeline for one prospect: fetch -> quality score
 * -> opportunity generation -> persist. Returns a summary of what happened;
 * throws only on infrastructure errors (DB/AI unreachable), never on a
 * merely-low-quality prospect -- that's a valid, expected outcome. */
export async function runProspectAnalysis(prospectId, { env, serviceKey, topics = DEFAULT_TOPICS }) {
  const [prospect] = await sbSelect('prospects', `id=eq.${prospectId}&select=*`, serviceKey);
  if (!prospect) throw new Error('Prospect not found');

  const page = await fetchPageForAnalysis(prospect.url);
  if (!page.ok) {
    await sbUpdate('prospects', `id=eq.${prospectId}`, { notes: appendNote(prospect.notes, `Analysis skipped: ${page.error}`) }, serviceKey, { returnRows: false });
    return { analyzed: false, reason: page.error, opportunitiesCreated: 0 };
  }

  // 1. WebsiteQualityService (Phase 5)
  const qa = buildProspectAnalysisPrompt({ prospect, pageText: page.text, topics });
  const qaText = await callClaude(env, { system: qa.system, prompt: qa.prompt, maxTokens: 700 });
  const qaRaw = parseAiJson(qaText);

  const relevance_score = computeRelevanceScore(qaRaw);
  const quality_score = computeQualityScore(qaRaw);
  const spamCheck = validateQualityAnalysis({ relevance_score, quality_score, spam_score: qaRaw.spam_score, notes: qaRaw.notes });
  if (!spamCheck.ok) throw new Error(`AI quality analysis failed validation: ${spamCheck.errors.join(', ')}`);

  const updatedProspect = await sbUpdate('prospects', `id=eq.${prospectId}`, {
    title: prospect.title || page.title,
    description: prospect.description || page.description,
    relevance_score: spamCheck.value.relevance_score,
    quality_score: spamCheck.value.quality_score,
    spam_score: spamCheck.value.spam_score,
    status: prospect.status === 'NEW' ? 'REVIEW' : prospect.status,
    notes: appendNote(prospect.notes, spamCheck.value.notes),
  }, serviceKey);
  const finalProspect = updatedProspect?.[0] || prospect;

  // 2. OpportunityEngine + AssetMatchingService (Phases 6 + 7)
  const assets = await sbSelect('content_assets', 'select=title,asset_type,description,url', serviceKey);
  const oa = buildOpportunityAnalysisPrompt({ prospect: finalProspect, pageText: page.text, assets });
  const oaText = await callClaude(env, { system: oa.system, prompt: oa.prompt, maxTokens: 1500 });
  const oaRaw = parseAiJson(oaText);
  const candidates = Array.isArray(oaRaw.opportunities) ? oaRaw.opportunities : [];

  const contactability = computeContactabilityScore(finalProspect);
  let created = 0;
  for (const candidate of candidates) {
    const validated = validateOpportunity(candidate);
    if (!validated.ok) continue; // never write a malformed AI opportunity, just skip it

    const opportunity_score = computeOpportunityScore({
      relevanceScore: validated.value.relevance_score,
      siteQualityScore: finalProspect.quality_score,
      audienceOverlap: clampScore(candidate.audience_overlap),
      editorialAcceptanceLikelihood: clampScore(candidate.editorial_acceptance_likelihood),
      assetUsefulness: clampScore(candidate.asset_usefulness),
      contactabilityScore: contactability,
    });

    await sbInsert('opportunities', {
      prospect_id: prospectId,
      ...validated.value,
      opportunity_score,
    }, serviceKey, { returnRows: false });
    created += 1;
  }

  return { analyzed: true, opportunitiesCreated: created, prospect: finalProspect };
}

function appendNote(existing, addition) {
  if (!addition) return existing || null;
  const stamped = `[${new Date().toISOString().slice(0, 10)}] ${addition}`;
  return existing ? `${existing}\n${stamped}` : stamped;
}
