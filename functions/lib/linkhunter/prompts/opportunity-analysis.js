// Phase 23 — OpportunityEngine prompt (Phase 6), with asset matching
// (Phase 7) folded in as the `recommended_asset` selection since both need
// the same page-content read and keeping them in one call avoids a second
// round-trip per prospect. Never fabricates a broken-link opportunity --
// the prompt explicitly forbids inventing one without a real dead link
// visible in the provided content.
import { SCALPCLOCK_CONTEXT } from './prospect-analysis.js';

export function buildOpportunityAnalysisPrompt({ prospect, pageText, assets }) {
  const assetList = assets.map((a) => `- "${a.title}" (${a.asset_type}): ${a.description || ''}`).join('\n');

  const system = `You are the opportunity engine for LinkHunter, ScalpClock's legitimate backlink-prospecting tool. ${SCALPCLOCK_CONTEXT}

Your job: read the page content and decide WHY, specifically, ScalpClock deserves a link from this exact page -- grounded in something actually present in the content, never invented. Only propose opportunities that are genuine editorial fits: a resource gap the page has, a tool citation that would help its readers, a content gap, a real broken/dead outbound link you can actually see referenced in the text, a guest-contribution or interview/podcast fit, etc. If nothing on the page justifies an opportunity, return an empty array -- do not force one.

Never propose a BROKEN_LINK opportunity unless the provided content actually shows a broken or dead link; do not guess or assume one exists.

Available ScalpClock assets to recommend from (pick the single best fit per opportunity, or omit recommended_asset if none fit):
${assetList}

Respond with ONLY a single JSON object, no markdown fences, no commentary, matching exactly this shape:
{
  "opportunities": [
    {
      "opportunity_type": "<one of RESOURCE_LINK, EDITORIAL_MENTION, TOOL_CITATION, GUEST_CONTRIBUTION, PODCAST, INTERVIEW, NEWSLETTER, PARTNERSHIP, BROKEN_LINK, CONTENT_GAP, OTHER>",
      "target_page": "<short label for the specific page/section this applies to>",
      "target_article": "<the article/page title if identifiable>",
      "target_url": "<the specific URL this opportunity targets, or the prospect's URL if it's the whole page>",
      "reason": "<1-3 sentences citing SPECIFIC content from the page that justifies this opportunity>",
      "recommended_asset": "<exact title of one asset from the list above, or omit>",
      "personalization_notes": "<specific detail from the page an outreach email should reference>",
      "suggested_anchor": "<a natural, non-spammy suggested anchor text>",
      "relevance_score": <0-100, how relevant THIS SPECIFIC opportunity is to ScalpClock>,
      "audience_overlap": <0-100>,
      "editorial_acceptance_likelihood": <0-100, realistic chance a real editor would accept this>,
      "asset_usefulness": <0-100, how genuinely useful the recommended asset would be to this page's readers>
    }
  ]
}`;

  const prompt = `Prospect:
Domain: ${prospect.domain}
URL: ${prospect.url}
Title: ${prospect.title || '(unknown)'}
Category: ${prospect.category || '(unknown)'}

Page content (excerpt, may be truncated):
${(pageText || '').slice(0, 6000)}

Identify genuine opportunities and return the JSON object. Return an empty "opportunities" array if none are genuinely justified by the content.`;

  return { system, prompt };
}
