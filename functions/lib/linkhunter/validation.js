// Phase 24 — AI output validation. Every value the AI generates gets
// checked here before it's allowed anywhere near a database write. AI
// output is never trusted directly, regardless of how the prompt asked it
// to format things.

export const PROSPECT_STATUSES = ['NEW', 'REVIEW', 'QUALIFIED', 'REJECTED', 'CONTACTED', 'RESPONDED', 'LINK_ACQUIRED', 'DO_NOT_CONTACT'];
export const OPPORTUNITY_TYPES = ['RESOURCE_LINK', 'EDITORIAL_MENTION', 'TOOL_CITATION', 'GUEST_CONTRIBUTION', 'PODCAST', 'INTERVIEW', 'NEWSLETTER', 'PARTNERSHIP', 'BROKEN_LINK', 'CONTENT_GAP', 'OTHER'];
export const OUTREACH_STATUSES = ['DRAFT', 'APPROVED', 'SENT', 'FOLLOW_UP', 'RESPONDED', 'DECLINED', 'NO_RESPONSE', 'CLOSED'];
export const BACKLINK_STATUSES = ['ACTIVE', 'LOST', 'NOFOLLOW', 'REDIRECT', 'REMOVED'];
export const ASSET_TYPES = ['TOOL', 'GUIDE', 'CALCULATOR', 'DATA', 'STUDY', 'CHECKLIST', 'GLOSSARY', 'INFOGRAPHIC', 'VIDEO', 'OTHER'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

export function isValidUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isValidEmail(value) {
  return typeof value === 'string' && EMAIL_RE.test(value) && value.length <= 254;
}

export function isOneOf(value, allowed) {
  return typeof value === 'string' && allowed.includes(value);
}

/** Strips markdown code fences (```json ... ```) that models sometimes wrap
 * structured output in, then parses. Throws on malformed JSON rather than
 * silently returning something wrong. */
export function parseAiJson(text) {
  const stripped = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(stripped);
}

/** Validates one AI-generated opportunity object against the schema before
 * it's allowed into the opportunities table. Returns { ok, value, errors }. */
export function validateOpportunity(raw) {
  const errors = [];
  if (!isOneOf(raw?.opportunity_type, OPPORTUNITY_TYPES)) errors.push('invalid opportunity_type');
  if (raw?.target_url != null && raw.target_url !== '' && !isValidUrl(raw.target_url)) errors.push('invalid target_url');
  const relevance_score = raw?.relevance_score != null ? clampScore(raw.relevance_score) : null;
  const opportunity_score = raw?.opportunity_score != null ? clampScore(raw.opportunity_score) : null;
  if (raw?.relevance_score != null && relevance_score === null) errors.push('invalid relevance_score');
  if (raw?.opportunity_score != null && opportunity_score === null) errors.push('invalid opportunity_score');
  if (raw?.reason != null && typeof raw.reason !== 'string') errors.push('invalid reason');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      opportunity_type: raw.opportunity_type,
      target_page: typeof raw.target_page === 'string' ? raw.target_page.slice(0, 500) : null,
      target_article: typeof raw.target_article === 'string' ? raw.target_article.slice(0, 500) : null,
      target_url: raw.target_url || null,
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 2000) : null,
      recommended_asset: typeof raw.recommended_asset === 'string' ? raw.recommended_asset.slice(0, 300) : null,
      relevance_score,
      opportunity_score,
      personalization_notes: typeof raw.personalization_notes === 'string' ? raw.personalization_notes.slice(0, 2000) : null,
      suggested_anchor: typeof raw.suggested_anchor === 'string' ? raw.suggested_anchor.slice(0, 300) : null,
    },
  };
}

/** Validates AI-generated quality/relevance/spam scores + reasoning for a
 * prospect. Returns { ok, value, errors }. */
export function validateQualityAnalysis(raw) {
  const errors = [];
  const relevance_score = clampScore(raw?.relevance_score);
  const quality_score = clampScore(raw?.quality_score);
  const spam_score = clampScore(raw?.spam_score);
  if (relevance_score === null) errors.push('invalid relevance_score');
  if (quality_score === null) errors.push('invalid quality_score');
  if (spam_score === null) errors.push('invalid spam_score');

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      relevance_score,
      quality_score,
      spam_score,
      notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 2000) : null,
    },
  };
}

/** Validates an AI-generated outreach draft. Returns { ok, value, errors }. */
export function validateOutreachDraft(raw) {
  const errors = [];
  if (typeof raw?.subject !== 'string' || !raw.subject.trim()) errors.push('missing subject');
  if (typeof raw?.body !== 'string' || raw.body.trim().length < 40) errors.push('missing/too-short body');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      subject: raw.subject.slice(0, 300),
      body: raw.body.slice(0, 8000),
    },
  };
}
