// Phase 5 + Phase 8 — deterministic scoring formulas. The AI is only ever
// asked for the individual, judgment-based *sub-scores* the spec
// describes (topic relevance, editorial legitimacy, etc); the actual
// weighted formulas that combine them into relevance_score, quality_score,
// and opportunity_score are computed here, server-side, so they're
// auditable and never silently drift based on how the model feels that day.
import { clampScore } from './validation.js';

/** Phase 5 — Relevance Score: Topic 40% / Content 25% / Audience overlap 20%
 * / ScalpClock asset relevance 15%. Each input is an AI-estimated 0-100
 * sub-score; this function only does the weighting + clamping. */
export function computeRelevanceScore({ topic_relevance, content_relevance, audience_overlap, asset_relevance }) {
  const t = clampScore(topic_relevance) ?? 0;
  const c = clampScore(content_relevance) ?? 0;
  const a = clampScore(audience_overlap) ?? 0;
  const r = clampScore(asset_relevance) ?? 0;
  return clampScore(t * 0.40 + c * 0.25 + a * 0.20 + r * 0.15);
}

/** Phase 5 — Quality Score: the spec lists six equally-weighted factors
 * with no stated weighting, so this averages them. */
export function computeQualityScore({ site_quality, content_quality, organic_visibility, editorial_legitimacy, relevant_audience, outbound_link_behavior }) {
  const factors = [site_quality, content_quality, organic_visibility, editorial_legitimacy, relevant_audience, outbound_link_behavior]
    .map((v) => clampScore(v) ?? 0);
  return clampScore(factors.reduce((s, v) => s + v, 0) / factors.length);
}

/** Phase 8 — Opportunity Score: relevance 30% / site quality 20% /
 * audience overlap 20% / editorial acceptance likelihood 15% / asset
 * usefulness 10% / contactability 5%. */
export function computeOpportunityScore({ relevanceScore, siteQualityScore, audienceOverlap, editorialAcceptanceLikelihood, assetUsefulness, contactabilityScore }) {
  const rel = clampScore(relevanceScore) ?? 0;
  const qual = clampScore(siteQualityScore) ?? 0;
  const aud = clampScore(audienceOverlap) ?? 0;
  const edit = clampScore(editorialAcceptanceLikelihood) ?? 0;
  const asset = clampScore(assetUsefulness) ?? 0;
  const contact = clampScore(contactabilityScore) ?? 0;
  return clampScore(rel * 0.30 + qual * 0.20 + aud * 0.20 + edit * 0.15 + asset * 0.10 + contact * 0.05);
}

/** Deterministic, not AI-estimated: whether there's actually someone to
 * contact. Feeds the 5% "contactability" slice of the opportunity score. */
export function computeContactabilityScore(prospect) {
  if (prospect?.contact_email) return 100;
  if (prospect?.contact_name || prospect?.contact_url) return 50;
  return 0;
}

/** Phase 8 — display band. Never represented as an official Google/Bing
 * metric anywhere in the UI copy that uses this. */
export function opportunityScoreBand(score) {
  if (score == null) return null;
  if (score >= 90) return 'Excellent';
  if (score >= 80) return 'High';
  if (score >= 70) return 'Good';
  if (score >= 60) return 'Possible';
  return 'Low priority';
}
