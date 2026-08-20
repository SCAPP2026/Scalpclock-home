// Phase 22 — conservative, configurable rate limiting for every
// expensive/external-facing LinkHunter operation, using the same Cloudflare
// KV counter pattern as functions/api/chart-feedback.js
// (CHART_FEEDBACK_KV's daily/monthly caps). LinkHunter uses its own
// namespace (LINKHUNTER_KV) since it's independent of the chart-feedback
// budget.

// Conservative defaults -- deliberately low since discovery/AI/verification
// calls all cost real money or hit third-party rate limits. Admins can see
// remaining usage via GET /api/linkhunter/settings (Phase 25 dashboard).
export const LIMITS = {
  discovery:          { daily: 20,  label: 'Prospect discovery runs' },
  website_analysis:   { daily: 100, label: 'Website quality analyses' },
  ai_generation:      { daily: 100, label: 'AI generation calls (opportunities/outreach/assets)' },
  contact_discovery:  { daily: 50,  label: 'Contact discovery lookups' },
  backlink_verify:    { daily: 200, label: 'Backlink verification checks' },
};

function todayKey(kind) {
  const today = new Date().toISOString().slice(0, 10);
  return `${kind}:${today}`;
}

/** Checks + increments the daily counter for `kind`. Returns
 * { allowed, used, limit } -- callers must check `allowed` before doing the
 * expensive work, and only call this once they're actually about to do it
 * (not speculatively) to keep the counter honest. */
export async function checkAndIncrement(kv, kind) {
  const limit = LIMITS[kind];
  if (!limit) throw new Error(`Unknown rate-limit kind: ${kind}`);
  const key = todayKey(kind);
  const current = parseInt((await kv.get(key)) || '0', 10);
  if (current >= limit.daily) {
    return { allowed: false, used: current, limit: limit.daily };
  }
  await kv.put(key, String(current + 1), { expirationTtl: 60 * 60 * 48 });
  return { allowed: true, used: current + 1, limit: limit.daily };
}

/** Read-only usage snapshot for the Settings page -- does not increment. */
export async function getUsageSnapshot(kv) {
  const entries = await Promise.all(
    Object.entries(LIMITS).map(async ([kind, limit]) => {
      const used = parseInt((await kv.get(todayKey(kind))) || '0', 10);
      return [kind, { used, limit: limit.daily, label: limit.label }];
    })
  );
  return Object.fromEntries(entries);
}
