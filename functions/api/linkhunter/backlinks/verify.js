// POST /api/linkhunter/backlinks/verify — Phase 13 (manual entry) + Phase
// 14 (scheduled lost-link monitor), one endpoint per the spec's API list.
//
// Two ways in:
//   1. Admin bearer token + { prospect_id, source_url, target_url? } ->
//      checks ONE page right now and upserts the result. A prospect is
//      only ever marked LINK_ACQUIRED here, after the source page is
//      actually verified to contain the link -- never just because
//      outreach was sent.
//   2. x-cron-secret header (no admin token) -> re-verifies a batch of
//      existing ACTIVE backlinks and flips any that disappeared to LOST.
//      Intended to be called by a Supabase pg_cron job, same pattern as
//      functions/api/signals-eval.js.
import { json, verifyAdmin, sbSelect, sbUpsert, sbUpdate } from '../../../lib/linkhunter/supabase.js';
import { checkAndIncrement } from '../../../lib/linkhunter/rate-limit.js';
import { checkBacklink } from '../../../lib/linkhunter/backlink-check.js';
import { isValidUrl } from '../../../lib/linkhunter/validation.js';

const CRON_BATCH_SIZE = 25;
const DEFAULT_TARGET = 'https://www.scalpclock.com';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Not configured' }, 500);

  const cronSecret = request.headers.get('x-cron-secret');
  if (env.LINKHUNTER_CRON_SECRET && cronSecret === env.LINKHUNTER_CRON_SECRET) {
    return handleCronSweep(env);
  }

  const user = await verifyAdmin(request);
  if (!user) return json({ error: 'Forbidden' }, 403);
  return handleManualVerify(request, env);
}

async function handleManualVerify(request, env) {
  if (!env.LINKHUNTER_KV) return json({ error: 'LinkHunter is not configured yet (missing LINKHUNTER_KV)' }, 500);
  const limit = await checkAndIncrement(env.LINKHUNTER_KV, 'backlink_verify');
  if (!limit.allowed) return json({ error: `Daily backlink-verification limit reached (${limit.limit}/day)` }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { prospect_id, source_url } = body || {};
  const target_url = body?.target_url || DEFAULT_TARGET;
  if (!isValidUrl(source_url)) return json({ error: 'A valid source_url is required' }, 400);
  if (!isValidUrl(target_url)) return json({ error: 'Invalid target_url' }, 400);
  const prospectId = parseInt(prospect_id, 10);
  if (!Number.isInteger(prospectId)) return json({ error: 'prospect_id is required' }, 400);

  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const result = await checkBacklink(source_url, target_url);

  if (result.found) {
    const rows = await sbUpsert('backlinks', {
      prospect_id: prospectId,
      source_url,
      target_url,
      anchor_text: result.anchorText,
      rel_attribute: result.relAttribute,
      last_verified: new Date().toISOString(),
      status: result.relAttribute?.includes('nofollow') ? 'NOFOLLOW' : 'ACTIVE',
    }, 'source_url,target_url', serviceKey);
    await sbUpdate('prospects', `id=eq.${prospectId}`, { status: 'LINK_ACQUIRED' }, serviceKey, { returnRows: false });
    return json({ found: true, backlink: rows[0] });
  }

  const existing = await sbSelect('backlinks', `source_url=eq.${encodeURIComponent(source_url)}&target_url=eq.${encodeURIComponent(target_url)}&select=id,status`, serviceKey);
  if (existing.length && existing[0].status === 'ACTIVE') {
    await sbUpdate('backlinks', `id=eq.${existing[0].id}`, { status: 'LOST', last_verified: new Date().toISOString() }, serviceKey, { returnRows: false });
    return json({ found: false, message: 'Link was previously active but is no longer present -- marked LOST', httpStatus: result.httpStatus });
  }

  return json({ found: false, message: 'No link found on that page', httpStatus: result.httpStatus, error: result.error || null });
}

async function handleCronSweep(env) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const active = await sbSelect('backlinks', `status=eq.ACTIVE&select=id,source_url,target_url&order=last_verified.asc.nullsfirst&limit=${CRON_BATCH_SIZE}`, serviceKey);

  let stillActive = 0, lost = 0;
  for (const link of active) {
    const result = await checkBacklink(link.source_url, link.target_url);
    if (result.found) {
      await sbUpdate('backlinks', `id=eq.${link.id}`, {
        last_verified: new Date().toISOString(),
        anchor_text: result.anchorText,
        rel_attribute: result.relAttribute,
        status: result.relAttribute?.includes('nofollow') ? 'NOFOLLOW' : 'ACTIVE',
      }, serviceKey, { returnRows: false });
      stillActive += 1;
    } else {
      await sbUpdate('backlinks', `id=eq.${link.id}`, { status: 'LOST', last_verified: new Date().toISOString() }, serviceKey, { returnRows: false });
      lost += 1;
    }
  }

  return json({ ok: true, checked: active.length, stillActive, lost });
}
