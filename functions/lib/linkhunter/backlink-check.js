// Phase 13/14 — actually checks whether a link exists on a live page,
// rather than ever assuming one does because outreach was sent. Fetches
// source_url fresh and looks for a real <a> tag pointing at target_url (or
// anything on the target's host, if target_url is only a bare domain).
import { LINKHUNTER_USER_AGENT } from './robots.js';

const FETCH_TIMEOUT_MS = 8000;

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

/** Returns { httpStatus, found, anchorText, relAttribute, error }. `found`
 * is only ever true when a real <a href> pointing at target_url's host (or
 * exact URL) was located in the fetched HTML. */
export async function checkBacklink(sourceUrl, targetUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(sourceUrl, {
      headers: { 'User-Agent': LINKHUNTER_USER_AGENT, Accept: 'text/html' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const httpStatus = res.status;
    if (!res.ok) return { httpStatus, found: false, anchorText: null, relAttribute: null };

    const html = await res.text();
    const targetHost = hostOf(targetUrl);
    const anchorRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRe.exec(html))) {
      const [full, href, innerHtml] = match;
      const isMatch = href === targetUrl || (targetHost && hostOf(new URL(href, sourceUrl).toString()) === targetHost);
      if (!isMatch) continue;

      const relMatch = full.match(/rel=["']([^"']+)["']/i);
      const anchorText = innerHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || null;
      return { httpStatus, found: true, anchorText, relAttribute: relMatch ? relMatch[1] : null };
    }
    return { httpStatus, found: false, anchorText: null, relAttribute: null };
  } catch (e) {
    return { httpStatus: null, found: false, anchorText: null, relAttribute: null, error: e.name === 'AbortError' ? 'Timed out' : e.message };
  } finally {
    clearTimeout(timeout);
  }
}
