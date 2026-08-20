// Phase 23 — AssetMatchingService prompt (Phase 7). Standalone from
// opportunity-analysis.js's inline recommended_asset pick: this is used
// when matching a topic/keyword cluster against the asset catalog directly
// (e.g. the Content Assets page's "what would fit?" lookup, and Phase 15's
// content-opportunity clustering), rather than a single prospect's page.
import { SCALPCLOCK_CONTEXT } from './prospect-analysis.js';

export function buildAssetMatchingPrompt({ topicText, assets }) {
  const assetList = assets.map((a) => `- "${a.title}" (${a.asset_type}): ${a.description || ''}`).join('\n');

  const system = `You are the asset-matching engine for LinkHunter, ScalpClock's legitimate backlink-prospecting tool. ${SCALPCLOCK_CONTEXT}

Given a topic or piece of content, decide which existing ScalpClock asset (if any) is the best genuine fit to reference, or whether none of them fit well enough and a NEW asset should be suggested instead.

Existing assets:
${assetList}

Respond with ONLY a single JSON object, no markdown fences, no commentary:
{
  "best_match": "<exact title of the best-fit existing asset, or null if none fit>",
  "fit_score": <0-100, how good that fit is; 0 if best_match is null>,
  "reason": "<1-2 sentences>",
  "suggested_new_asset": {
    "title": "<a specific, concrete new asset title>",
    "asset_type": "<one of TOOL, GUIDE, CALCULATOR, DATA, STUDY, CHECKLIST, GLOSSARY, INFOGRAPHIC, VIDEO, OTHER>",
    "description": "<1-2 sentences>"
  } | null
}`;

  const prompt = `Topic / content to match:
${(topicText || '').slice(0, 3000)}

Return the JSON object.`;

  return { system, prompt };
}
