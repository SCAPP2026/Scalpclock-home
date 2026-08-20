// Phase 4/5/6 — fetches a candidate page for discovery/analysis, always
// checking robots.txt first (see robots.js), with sane size/time limits so
// one bad URL can't hang or blow up a Function invocation.
import { isAllowedByRobots, LINKHUNTER_USER_AGENT } from './robots.js';

const MAX_HTML_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 8000;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMeta(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  return {
    title: titleMatch ? titleMatch[1].trim().slice(0, 300) : null,
    description: descMatch ? descMatch[1].trim().slice(0, 500) : null,
  };
}

/** Fetches `url` for discovery/analysis if (and only if) robots.txt allows
 * it. Returns { ok, title, description, text, error }. Never throws --
 * every failure mode is reported back so callers can record it on the
 * prospect rather than crash the whole discovery/analysis batch. */
export async function fetchPageForAnalysis(url) {
  const allowed = await isAllowedByRobots(url);
  if (!allowed) return { ok: false, error: 'Disallowed by robots.txt' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': LINKHUNTER_USER_AGENT, Accept: 'text/html' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return { ok: false, error: `Non-HTML content-type: ${contentType}` };

    const reader = res.body?.getReader();
    let html = '';
    if (reader) {
      const decoder = new TextDecoder();
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        html += decoder.decode(value, { stream: true });
        if (bytes > MAX_HTML_BYTES) { reader.cancel(); break; }
      }
    } else {
      html = await res.text();
    }

    const { title, description } = extractMeta(html);
    return { ok: true, title, description, text: stripHtml(html).slice(0, 20000) };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'Timed out' : e.message };
  } finally {
    clearTimeout(timeout);
  }
}
