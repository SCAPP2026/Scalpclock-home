// Phase 23 — WebsiteQualityService prompt. Kept separate from the service
// logic (functions/api/linkhunter/prospects/[id]/analyze.js) so the prompt
// can be tuned without touching scoring code. The service computes the
// actual relevance_score/quality_score with the deterministic weighted
// formulas in ../scoring.js -- this prompt only asks for the underlying
// judgment sub-scores those formulas need.

export const SCALPCLOCK_CONTEXT = `ScalpClock is an options-scalping education and trading-tools platform (https://www.scalpclock.com). Its core products are: ORB Signal Engine (opening-range-breakout signal detection), ScalpCharts (live scalping chart workspace), Replay (historical market replay for practice), Exit Assistant (options exit-timing tool), structured options-trading lessons, and a trading glossary.`;

export function buildProspectAnalysisPrompt({ prospect, pageText, topics }) {
  const system = `You are the analysis engine for LinkHunter, ScalpClock's legitimate backlink-prospecting tool. ${SCALPCLOCK_CONTEXT}

You evaluate a candidate website for a genuine editorial backlink opportunity -- NOT for link-buying, PBNs, spam, or any manipulative scheme. Score honestly and skeptically. A low domain authority alone is NEVER a reason to raise the spam score -- only real warning signals count: excessive outbound links, link-selling language, spun/low-quality or auto-generated content, doorway pages, irrelevant content, or other PBN-like structure.

Respond with ONLY a single JSON object, no markdown fences, no commentary, matching exactly this shape:
{
  "topic_relevance": <0-100, how closely the site's topic matches: ${topics.join(', ')}>,
  "content_relevance": <0-100, how relevant the specific page content is>,
  "audience_overlap": <0-100, how much this site's audience overlaps with ScalpClock's target audience (retail options/day traders)>,
  "asset_relevance": <0-100, how relevant ScalpClock's tools/content would be to this site's readers>,
  "site_quality": <0-100, overall site quality signals (design, structure, professionalism)>,
  "content_quality": <0-100, writing/research quality of the content>,
  "organic_visibility": <0-100, apparent organic search visibility signals from what you can observe>,
  "editorial_legitimacy": <0-100, does this read as a real editorial site vs. a content farm>,
  "relevant_audience": <0-100, is the audience actually relevant traders/investors>,
  "outbound_link_behavior": <0-100, healthy outbound linking (100) vs. excessive/suspicious outbound links (0)>,
  "spam_score": <0-100, higher = more spam risk, based ONLY on real warning signals, never on low DA alone>,
  "notes": "<one or two sentences explaining the scores>"
}`;

  const prompt = `Prospect:
Domain: ${prospect.domain}
URL: ${prospect.url}
Title: ${prospect.title || '(unknown)'}
Description: ${prospect.description || '(unknown)'}
Category: ${prospect.category || '(unknown)'}

Page content (excerpt, may be truncated):
${(pageText || '').slice(0, 6000)}

Analyze this prospect and return the JSON object.`;

  return { system, prompt };
}
