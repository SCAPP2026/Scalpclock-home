// GET /api/linkhunter/usage — Phase 22: "Display remaining usage to
// administrators." Read-only snapshot of today's LINKHUNTER_KV counters.
import { withAdmin, json } from '../../lib/linkhunter/supabase.js';
import { getUsageSnapshot } from '../../lib/linkhunter/rate-limit.js';

export const onRequest = withAdmin(async ({ request, env }) => {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!env.LINKHUNTER_KV) return json({ error: 'LinkHunter is not configured yet (missing LINKHUNTER_KV)' }, 500);
  const usage = await getUsageSnapshot(env.LINKHUNTER_KV);
  return json({ usage });
});
