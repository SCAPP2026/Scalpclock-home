// POST /api/linkhunter/prospects/discover — Phase 4 discovery.
//
// This repo has no configured search-API key (Google CSE / Bing / SerpApi),
// so discovery runs in "seed URL" mode: an admin submits a batch of
// candidate URLs (found manually, from a CSV, or from whatever search
// tool they used outside this system) plus the topic/source they came
// from, and this endpoint does the actual prospecting work -- robots.txt
// check, fetch, dedup, metadata extraction, insert as a NEW prospect.
// When a search-API key is added later, a new source module can call the
// same per-URL logic below without changing this endpoint's contract.
import { withAdmin, json, sbSelect, sbInsert } from '../../../lib/linkhunter/supabase.js';
import { fetchPageForAnalysis } from '../../../lib/linkhunter/fetch-page.js';
import { checkAndIncrement } from '../../../lib/linkhunter/rate-limit.js';
import { isValidUrl } from '../../../lib/linkhunter/validation.js';

const MAX_URLS_PER_RUN = 25;

export const onRequest = withAdmin(async ({ request, env }) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!env.LINKHUNTER_KV) return json({ error: 'LinkHunter is not configured yet (missing LINKHUNTER_KV)' }, 500);
  const limitCheck = await checkAndIncrement(env.LINKHUNTER_KV, 'discovery');
  if (!limitCheck.allowed) return json({ error: `Daily discovery limit reached (${limitCheck.limit}/day)` }, 429);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const urls = Array.isArray(body?.urls) ? body.urls.filter(isValidUrl) : [];
  if (!urls.length) return json({ error: 'Provide at least one valid URL in "urls"' }, 400);
  if (urls.length > MAX_URLS_PER_RUN) return json({ error: `Max ${MAX_URLS_PER_RUN} URLs per discovery run` }, 400);

  const topic = typeof body.topic === 'string' ? body.topic.slice(0, 200) : null;
  const source = typeof body.source === 'string' ? body.source.slice(0, 200) : 'manual';
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

  const results = [];
  for (const url of urls) {
    results.push(await discoverOne(url, { topic, source, serviceKey }));
  }

  const created = results.filter((r) => r.status === 'created').length;
  const duplicates = results.filter((r) => r.status === 'duplicate').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  return json({ created, duplicates, skipped, results });
});

async function discoverOne(url, { topic, source, serviceKey }) {
  const domain = safeHostname(url);
  if (!domain) return { url, status: 'skipped', reason: 'Unparseable URL' };

  const existing = await sbSelect('prospects', `url=eq.${encodeURIComponent(url)}&select=id`, serviceKey);
  if (existing.length) return { url, status: 'duplicate' };

  const page = await fetchPageForAnalysis(url);
  if (!page.ok) return { url, status: 'skipped', reason: page.error };

  try {
    const rows = await sbInsert('prospects', {
      url, domain, title: page.title, description: page.description,
      category: topic, discovery_source: source,
    }, serviceKey);
    return { url, status: 'created', prospect: rows[0] };
  } catch (e) {
    if (String(e.message).includes('duplicate key')) return { url, status: 'duplicate' };
    return { url, status: 'skipped', reason: 'Insert failed' };
  }
}

function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return null; }
}
