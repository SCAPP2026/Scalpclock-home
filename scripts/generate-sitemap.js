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

// Non-content directories to skip when walking the repo for HTML pages.
const SKIP_DIRS = new Set([
  ".git", ".github", ".githooks", ".claude", ".wrangler",
  "css", "js", "functions", "tests", "scripts", "node_modules",
  "Scalpclock-home", // stale nested clone, not served
]);

// Per-page priority/changefreq overrides, keyed by URL path (no leading
// slash, "index" for a directory's own index.html — e.g. "blog" for
// blog/index.html, "blog/category" for any /blog/category/* page). Anything
// not listed here falls back to DEFAULT_META, so a brand-new page — root or
// nested — still gets a sane entry without editing this file.
const PAGE_META = {
  index: { priority: "1.0", changefreq: "daily" },
  learn: { priority: "0.9", changefreq: "daily" },
  scalpchart: { priority: "0.8", changefreq: "daily" },
  pricing: { priority: "0.8", changefreq: "weekly" },
  blog: { priority: "0.8", changefreq: "weekly" },
  "blog/category": { priority: "0.6", changefreq: "weekly" },
  exitassistant: { priority: "0.7", changefreq: "weekly" },
  about: { priority: "0.7", changefreq: "monthly" },
  faq: { priority: "0.6", changefreq: "monthly" },
  login: { priority: "0.5", changefreq: "monthly" },
  terms: { priority: "0.3", changefreq: "yearly" },
  privacy: { priority: "0.3", changefreq: "yearly" },
};
const DEFAULT_META = { priority: "0.5", changefreq: "monthly" };
const BLOG_POST_META = { priority: "0.6", changefreq: "monthly" };

function metaFor(urlKey) {
  if (PAGE_META[urlKey]) return PAGE_META[urlKey];
  if (urlKey.startsWith("blog/category/")) return PAGE_META["blog/category"];
  if (urlKey.startsWith("blog/")) return BLOG_POST_META;
  return DEFAULT_META;
}

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

// Recursively finds every *.html file under `dir`, skipping SKIP_DIRS.
// Returns paths relative to ROOT with forward slashes (posix-style),
// regardless of OS, so they match how URLs and _redirects are written.
function findHtmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...findHtmlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      out.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  }
  return out;
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
  const files = findHtmlFiles(ROOT); // e.g. "index.html", "blog/index.html", "blog/category/faq.html"

  const pages = [];
  for (const file of files) {
    // "index.html" -> "", "blog/index.html" -> "blog", "about.html" -> "about"
    const withoutExt = file.replace(/\.html$/, "");
    const isDirIndex = withoutExt !== "index" && withoutExt.endsWith("/index");
    const urlKey = withoutExt === "index" || isDirIndex
      ? withoutExt.slice(0, -"index".length).replace(/\/$/, "")
      : withoutExt;
    if (redirectSources.has(urlKey || "index")) continue; // aliased/redirected away

    const html = fs.readFileSync(path.join(ROOT, file), "utf8");
    if (isNoindex(html)) continue;

    // Nested directory indexes (e.g. blog/index.html) are served by Cloudflare
    // Pages at a trailing-slash URL — a bare "/blog" request 308s to "/blog/".
    // Emit the URL that actually resolves 200 so it matches each page's own
    // canonical tag instead of pointing at a redirect.
    const urlPath = urlKey ? (isDirIndex ? `/${urlKey}/` : `/${urlKey}`) : "/";
    const meta = metaFor(urlKey || "index");
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
