#!/usr/bin/env node
/**
 * Generates /sitemap.xml by scanning the repo root for public *.html pages.
 *
 * A page is "public" (included in the sitemap) unless:
 *   - its <meta name="robots" ...> tag contains "noindex", or
 *   - it is the source of a redirect in _redirects (i.e. a duplicate/alias URL).
 *
 * That means new pages are picked up automatically the next time this runs —
 * no manual list to maintain. lastmod is taken from each file's most recent
 * git commit date so it reflects real content changes, not deploy time.
 *
 * Usage:
 *   node scripts/generate-sitemap.js          # write sitemap.xml
 *   node scripts/generate-sitemap.js --check  # exit 1 if sitemap.xml is stale (CI)
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DOMAIN = "https://scalpclock.com";
const OUT_FILE = path.join(ROOT, "sitemap.xml");

// Per-page priority/changefreq overrides. Anything not listed here falls back
// to DEFAULT_META below, so a brand-new page still gets a sane entry.
const PAGE_META = {
  index: { priority: "1.0", changefreq: "daily" },
  learn: { priority: "0.9", changefreq: "daily" },
  scalpchart: { priority: "0.8", changefreq: "daily" },
  pricing: { priority: "0.8", changefreq: "weekly" },
  exitassistant: { priority: "0.7", changefreq: "weekly" },
  about: { priority: "0.7", changefreq: "monthly" },
  faq: { priority: "0.6", changefreq: "monthly" },
  login: { priority: "0.5", changefreq: "monthly" },
  terms: { priority: "0.3", changefreq: "yearly" },
  privacy: { priority: "0.3", changefreq: "yearly" },
};
const DEFAULT_META = { priority: "0.5", changefreq: "monthly" };

function readRedirectSources() {
  const file = path.join(ROOT, "_redirects");
  if (!fs.existsSync(file)) return new Set();
  const sources = new Set();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [from] = trimmed.split(/\s+/);
    if (from) sources.add(from.replace(/^\//, "").replace(/\.html$/, ""));
  }
  return sources;
}

function isNoindex(html) {
  const match = html.match(/<meta\s+name=["']robots["']\s+content=["']([^"']*)["']/i);
  return !!match && /noindex/i.test(match[1]);
}

function lastmodFor(file) {
  try {
    const date = execFileSync(
      "git",
      ["log", "-1", "--format=%cd", "--date=short", "--", file],
      { cwd: ROOT, encoding: "utf8" }
    ).trim();
    if (date) return date;
  } catch (_) {
    // git unavailable or file untracked — fall through to mtime
  }
  return fs.statSync(path.join(ROOT, file)).mtime.toISOString().slice(0, 10);
}

function escapeXml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  }[c]));
}

function collectPublicPages() {
  const redirectSources = readRedirectSources();
  const files = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"));

  const pages = [];
  for (const file of files) {
    const basename = path.basename(file, ".html");
    if (redirectSources.has(basename)) continue; // aliased/redirected away

    const html = fs.readFileSync(path.join(ROOT, file), "utf8");
    if (isNoindex(html)) continue;

    const urlPath = basename === "index" ? "/" : `/${basename}`;
    const meta = PAGE_META[basename] || DEFAULT_META;
    pages.push({
      loc: `${DOMAIN}${urlPath}`,
      lastmod: lastmodFor(file),
      changefreq: meta.changefreq,
      priority: meta.priority,
    });
  }

  // Highest priority first, then alphabetical, for a stable/readable diff.
  pages.sort((a, b) => b.priority - a.priority || a.loc.localeCompare(b.loc));
  return pages;
}

function renderSitemap(pages) {
  const urls = pages
    .map(
      (p) => `  <url>
    <loc>${escapeXml(p.loc)}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

function main() {
  const pages = collectPublicPages();
  if (pages.length === 0) {
    console.error("No public pages found — refusing to write an empty sitemap.");
    process.exit(1);
  }

  const xml = renderSitemap(pages);
  const checkOnly = process.argv.includes("--check");

  if (checkOnly) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : "";
    if (current !== xml) {
      console.error(
        "sitemap.xml is out of date. Run `node scripts/generate-sitemap.js` and commit the result."
      );
      process.exit(1);
    }
    console.log(`sitemap.xml is up to date (${pages.length} pages).`);
    return;
  }

  fs.writeFileSync(OUT_FILE, xml);
  console.log(`Wrote sitemap.xml with ${pages.length} pages:`);
  for (const p of pages) console.log(`  ${p.loc} (lastmod ${p.lastmod})`);
}

main();
