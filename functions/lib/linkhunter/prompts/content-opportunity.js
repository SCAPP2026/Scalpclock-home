// Phase 23 — ContentOpportunityService prompt (Phase 15). Consumed by a
// later-phase endpoint that clusters existing prospects/opportunities by
// topic and asks what new ScalpClock asset would attract the most links.
// Written now alongside the other prompt modules since Phase 23 groups all
// prompts together; the clustering/aggregation logic that calls this lands
// with Phase 15's build.
import { SCALPCLOCK_CONTEXT } from './prospect-analysis.js';

export function buildContentOpportunityPrompt({ clusterTopic, sampleReasons, existingAssets }) {
  const assetList = existingAssets.map((a) => `- "${a.title}" (${a.asset_type})`).join('\n');
  const reasons = sampleReasons.slice(0, 20).map((r) => `- ${r}`).join('\n');

  const system = `You are the content-opportunity engine for LinkHunter, ScalpClock's legitimate backlink-prospecting tool. ${SCALPCLOCK_CONTEXT}

A cluster of prospects/opportunities all touch the same topic, and none of ScalpClock's EXISTING assets fully covers it. Decide whether a genuinely useful NEW free asset (a calculator, tool, guide, etc.) would plausibly attract links from this cluster, and if so, propose one concrete asset.

Existing assets (do not suggest something that duplicates one of these):
${assetList}

Respond with ONLY a single JSON object, no markdown fences, no commentary:
{
  "worth_building": <true/false>,
  "suggested_title": "<specific asset title, or null>",
  "asset_type": "<one of TOOL, GUIDE, CALCULATOR, DATA, STUDY, CHECKLIST, GLOSSARY, INFOGRAPHIC, VIDEO, OTHER, or null>",
  "suggested_slug": "<a plausible /tools/... or /learn-... URL slug, or null>",
  "reasoning": "<1-2 sentences>"
}`;

  const prompt = `Topic cluster: ${clusterTopic}

Sample opportunity reasons from prospects in this cluster:
${reasons || '(none provided)'}

Return the JSON object.`;

  return { system, prompt };
}
