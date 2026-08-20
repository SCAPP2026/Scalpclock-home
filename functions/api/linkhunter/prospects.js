// GET /api/linkhunter/prospects — search/filter/sort (Phase 18)
// POST /api/linkhunter/prospects — manual single-prospect add (Phase 9's
// "allow the user to manually add a contact" extends naturally to allowing
// a manually-added prospect too, e.g. from a CSV-seed workflow).
import { withAdmin, json, sbSelectWithCount, sbInsert } from '../../lib/linkhunter/supabase.js';
import { PROSPECT_STATUSES, isValidUrl } from '../../lib/linkhunter/validation.js';

const SORT_COLUMNS = {
  newest: 'created_at.desc',
  quality: 'quality_score.desc.nullslast',
  relevance: 'relevance_score.desc.nullslast',
  recently_contacted: 'updated_at.desc',
};

export const onRequest = withAdmin(async ({ request, env }) => {
  if (request.method === 'GET') return handleList(request, env);
  if (request.method === 'POST') return handleCreate(request, env);
  return json({ error: 'Method not allowed' }, 405);
});

async function handleList(request, env) {
  const params = new URL(request.url).searchParams;
  const filters = [];

  const status = params.get('status');
  if (status && PROSPECT_STATUSES.includes(status)) filters.push(`status=eq.${status}`);

  const category = params.get('category');
  if (category) filters.push(`category=eq.${encodeURIComponent(category)}`);

  const country = params.get('country');
  if (country) filters.push(`country=eq.${encodeURIComponent(country)}`);

  const language = params.get('language');
  if (language) filters.push(`language=eq.${encodeURIComponent(language)}`);

  const minQuality = params.get('min_quality');
  if (minQuality) filters.push(`quality_score=gte.${Number(minQuality) || 0}`);

  const minRelevance = params.get('min_relevance');
  if (minRelevance) filters.push(`relevance_score=gte.${Number(minRelevance) || 0}`);

  const hasContact = params.get('has_contact');
  if (hasContact === 'true') filters.push('contact_email=not.is.null');
  if (hasContact === 'false') filters.push('contact_email=is.null');

  const q = params.get('q');
  if (q) filters.push(`or=(domain.ilike.*${encodeURIComponent(q)}*,title.ilike.*${encodeURIComponent(q)}*)`);

  const sortKey = params.get('sort') || 'newest';
  const order = SORT_COLUMNS[sortKey] || SORT_COLUMNS.newest;

  const page = Math.max(1, parseInt(params.get('page') || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(params.get('page_size') || '25', 10)));
  const from = (page - 1) * pageSize;

  try {
    const query = `select=*&order=${order}&limit=${pageSize}&offset=${from}${filters.length ? '&' + filters.join('&') : ''}`;
    const { rows, count } = await sbSelectWithCount('prospects', query, env.SUPABASE_SERVICE_ROLE_KEY);
    return json({ prospects: rows, total: count, page, pageSize });
  } catch (e) {
    console.error('prospects list failed:', e.message);
    return json({ error: 'Failed to load prospects' }, 500);
  }
}

async function handleCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { url, domain, site_name, title, description, category, country, language, discovery_source, notes } = body || {};
  if (!isValidUrl(url)) return json({ error: 'A valid url is required' }, 400);

  const resolvedDomain = domain || safeHostname(url);
  if (!resolvedDomain) return json({ error: 'Could not resolve a domain for that URL' }, 400);

  try {
    const rows = await sbInsert('prospects', {
      url, domain: resolvedDomain, site_name: site_name || null, title: title || null,
      description: description || null, category: category || null, country: country || null,
      language: language || null, discovery_source: discovery_source || 'manual', notes: notes || null,
    }, env.SUPABASE_SERVICE_ROLE_KEY);
    return json({ prospect: rows[0] }, 201);
  } catch (e) {
    if (String(e.message).includes('duplicate key')) return json({ error: 'That URL is already a prospect' }, 409);
    console.error('prospect create failed:', e.message);
    return json({ error: 'Failed to create prospect' }, 500);
  }
}

function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return null; }
}
