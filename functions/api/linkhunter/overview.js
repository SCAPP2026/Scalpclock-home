// GET /api/linkhunter/overview — Phase 12/25 dashboard stats + leaderboard.
import { withAdmin, json, sbSelectWithCount, sbSelect } from '../../lib/linkhunter/supabase.js';

export const onRequest = withAdmin(async ({ env }) => {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const [
      prospectsTotal,
      qualified,
      opportunitiesTotal,
      outreachDrafted,
      outreachApproved,
      outreachSent,
      responses,
      backlinksAcquired,
      backlinksLost,
      leaderboard,
    ] = await Promise.all([
      countOf('prospects', '', serviceKey),
      countOf('prospects', '&status=eq.QUALIFIED', serviceKey),
      countOf('opportunities', '', serviceKey),
      countOf('outreach', '&status=eq.DRAFT', serviceKey),
      countOf('outreach', '&status=eq.APPROVED', serviceKey),
      countOf('outreach', '&status=eq.SENT', serviceKey),
      countOf('outreach', '&status=eq.RESPONDED', serviceKey),
      countOf('backlinks', '&status=eq.ACTIVE', serviceKey),
      countOf('backlinks', '&status=eq.LOST', serviceKey),
      sbSelect('opportunities', 'select=id,opportunity_type,opportunity_score,recommended_asset,status,prospects(domain,contact_email)&order=opportunity_score.desc.nullslast&limit=10', serviceKey),
    ]);

    const conversionRate = outreachSent > 0 ? Math.round((backlinksAcquired / outreachSent) * 1000) / 10 : 0;

    return json({
      prospects: prospectsTotal,
      qualified,
      opportunities: opportunitiesTotal,
      outreachDrafted,
      outreachApproved,
      outreachSent,
      responses,
      backlinksAcquired,
      backlinksLost,
      conversionRate,
      leaderboard,
    });
  } catch (e) {
    console.error('linkhunter overview failed:', e.message);
    return json({ error: 'Failed to load overview' }, 500);
  }
});

async function countOf(table, extraFilter, serviceKey) {
  const { count } = await sbSelectWithCount(table, `select=id${extraFilter}&limit=1`, serviceKey);
  return count;
}
