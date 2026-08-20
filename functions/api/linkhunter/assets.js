// GET /api/linkhunter/assets — list ScalpClock's linkable content assets
// (Phase 7's catalog). POST /api/linkhunter/assets — add a new one, e.g.
// after Phase 15's content-opportunity engine surfaces a gap worth filling.
import { withAdmin, json, sbSelect, sbInsert } from '../../lib/linkhunter/supabase.js';
import { ASSET_TYPES, clampScore } from '../../lib/linkhunter/validation.js';

export const onRequest = withAdmin(async ({ request, env }) => {
  if (request.method === 'GET') return handleList(env);
  if (request.method === 'POST') return handleCreate(request, env);
  return json({ error: 'Method not allowed' }, 405);
});

async function handleList(env) {
  try {
    const assets = await sbSelect('content_assets', 'select=*&order=created_at.asc', env.SUPABASE_SERVICE_ROLE_KEY);
    return json({ assets });
  } catch (e) {
    console.error('assets list failed:', e.message);
    return json({ error: 'Failed to load assets' }, 500);
  }
}

async function handleCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const { title, url, asset_type, description, target_keywords } = body || {};
  if (!title || typeof title !== 'string') return json({ error: 'title is required' }, 400);
  if (!ASSET_TYPES.includes(asset_type)) return json({ error: 'Invalid asset_type' }, 400);

  try {
    const rows = await sbInsert('content_assets', {
      title: title.slice(0, 300),
      url: url ? String(url).slice(0, 500) : null,
      asset_type,
      description: description ? String(description).slice(0, 2000) : null,
      target_keywords: Array.isArray(target_keywords) ? target_keywords.map((k) => String(k).slice(0, 100)).slice(0, 30) : null,
      linkability_score: body.linkability_score != null ? clampScore(body.linkability_score) : null,
    }, env.SUPABASE_SERVICE_ROLE_KEY);
    return json({ asset: rows[0] }, 201);
  } catch (e) {
    if (String(e.message).includes('duplicate key')) return json({ error: 'An asset with that title already exists' }, 409);
    console.error('asset create failed:', e.message);
    return json({ error: 'Failed to create asset' }, 500);
  }
}
