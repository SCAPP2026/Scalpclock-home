# LinkHunter AI — Architecture Report

Status: **Phase 1 — inspection complete, awaiting approval before any implementation.**

## 1. Existing ScalpClock Stack (as found)

| Layer | Finding |
|---|---|
| Hosting | Cloudflare Pages, static build (`pages_build_output_dir = "."` in `wrangler.toml`), no build step |
| Frontend | Hand-written HTML/CSS/JS. No framework (no React/Vue/etc.), no bundler, no `package.json`, no npm dependencies at all. Each page is a self-contained `.html` file with inline `<style>` and `<script>`. |
| Shared styling | `css/theme-light.css` — CSS custom properties (`--bg`, `--text`, `--panel`, `--line`, `--green-ink`, `--green-soft`, `--disp`/`--body`/`--mono` fonts, `--r-card`, `--shadow-sm`, etc.). Fonts: Google Fonts Rajdhani (display), Inter (body), JetBrains Mono (mono/data). Pages reuse these vars in per-page `<style>` blocks rather than a component library. |
| Backend | Cloudflare Pages Functions — plain JS files under `functions/`, file-based routing (`functions/api/foo.js` → `/api/foo`, `functions/api/admin/overview.js` → `/api/admin/overview`, `functions/r/[code].js` → `/r/:code`). No Express/Hono/framework; each file exports `onRequest(context)`. Pages Functions does support local ES-module imports with automatic bundling, though the repo doesn't currently use that. |
| Database | Supabase (Postgres). No migration-file tooling — `/supabase/*.sql` are hand-run, idempotent "setup" scripts (SQL editor), not an applied-migration history. Server-side functions talk to Supabase via raw `fetch()` to its REST endpoint (`/rest/v1/...`) using the **service role key** (`env.SUPABASE_SERVICE_ROLE_KEY`, a Cloudflare Pages secret — never shipped client-side). Client-side pages use `@supabase/supabase-js` (loaded from a CDN `<script>` tag, UMD build — no npm install) with the public anon key for auth only. |
| Auth | Supabase Auth (email/password, `login.html`). Admin gating is a two-layer pattern used consistently (see `admin-referrals.html` + `functions/api/admin/*.js`): (1) client checks `session.user.app_metadata.is_admin === true` to decide whether to render the admin UI or a "denied" view; (2) **every** admin API re-verifies independently — takes the `Authorization: Bearer <token>` header, calls Supabase `/auth/v1/user` with it, and checks the *real* `app_metadata.is_admin` Supabase returns. The client is never trusted to self-report admin status. `app_metadata` is service-role-only to write, so this is a legitimate authorization check. |
| Existing admin UI | `/admin-referrals.html` is the direct precedent for LinkHunter's admin area: single static page, deny/allow view toggle, stat cards, data tables, `authedFetch()` helper that attaches the bearer token. |
| Rate limiting | One existing example: `functions/api/chart-feedback.js` uses a Cloudflare **KV namespace** (`CHART_FEEDBACK_KV`, bound in `wrangler.toml` + the Pages dashboard) to track per-user daily and global monthly counters for a paid AI call. Same pattern is the natural fit for LinkHunter's discovery/AI/verification caps. |
| Existing AI integration | `chart-feedback.js` calls the Anthropic Messages API directly via `fetch('https://api.anthropic.com/v1/messages', ...)` with `x-api-key: env.ANTHROPIC_API_KEY` (a Cloudflare secret) and `model: 'claude-sonnet-5'`. System prompt is a plain string constant in the same file. This is the template for all LinkHunter AI calls (outreach generation, quality/opportunity analysis, asset matching). |
| Payments | Stripe, via `functions/api/stripe/*.js` (checkout, webhook, promo validation, activation). Not directly relevant to LinkHunter but confirms the "server-side fetch to a REST API using an `env` secret" convention used everywhere in this repo. |
| Market/external data | Alpaca (primary), Polygon, Finnhub, FMP, Benzinga, NewsAPI, TradingEconomics — all optional, keyed via `env.*_KEY`, silently skipped if unset. No SEO/backlink data provider (Moz, Ahrefs, SEMrush, Hunter.io, etc.) is currently integrated anywhere in the repo. |
| Routing/redirects | `_redirects` (Cloudflare Pages redirect/rewrite rules) and clean-URL directory routing (e.g. `/blog/category/*`). Cloudflare Pages serves `/admin/linkhunter/dashboard.html` at the clean URL `/admin/linkhunter/dashboard` automatically — no extra config needed for that. |
| Headers | `_headers` sets `Cache-Control: no-store` on authenticated/sensitive pages (`/login`, `/settings`, `/admin-referrals`, etc.) — no CSP is set anywhere, so inline `<script>`/`<style>` is unrestricted. New LinkHunter pages should get the same `no-store` treatment added. |
| Testing | No test runner (no Jest/Vitest/etc. installed — there's no `package.json` in the repo at all). `tests/*.test.js` are plain Node scripts with a hand-rolled `assert()`, run directly via `node tests/foo.test.js`. No CI step currently executes them automatically (CI only purges cache and regenerates the sitemap on push to `main`). |
| CI | Two GitHub Actions workflows: cache purge after deploy, and sitemap regeneration on HTML changes. |

## 2. Proposed LinkHunter Architecture

Reuse everything above as-is; no new framework, bundler, or hosting is introduced.

- **Pages**: new static HTML files under `/admin/linkhunter/` — `dashboard.html`, `prospects.html`, `opportunities.html`, `outreach.html`, `backlinks.html`, `campaigns.html`, `content-assets.html`, `settings.html`. Each follows the `admin-referrals.html` template: deny/allow view, `css/theme-light.css` variables, a shared LinkHunter side/top nav partial (duplicated per page, same as the rest of the site — no templating engine exists to share it otherwise).
- **APIs**: new Functions under `functions/api/linkhunter/` mirroring `functions/api/admin/` — every route re-verifies the bearer token against Supabase and requires `app_metadata.is_admin === true` before touching data. CORS/JSON helpers copied from the existing admin functions for consistency.
- **Shared server logic**: Pages Functions supports bundled local imports, so business logic (scoring services, prompt builders, validators) lives under `functions/lib/linkhunter/*.js` and is imported by the route handlers — this is what satisfies the spec's "separate services" and "separate prompts" requirements without introducing a build step. Plain JS (matching the rest of the repo — no TypeScript toolchain exists here, so `/lib/linkhunter/prompts/*.ts` becomes `functions/lib/linkhunter/prompts/*.js`).
- **Database**: new Supabase tables exactly as specified (`prospects`, `opportunities`, `outreach`, `backlinks`, `campaigns`, `content_assets`), added via a new hand-run script `supabase/linkhunter_setup.sql` (same convention as `signal_history_setup.sql`) — RLS enabled on every table, **no public policies** (this is internal tooling only; all reads/writes go through Functions using the service role key, same as the referral admin tables).
- **AI**: reuses the existing `ANTHROPIC_API_KEY` secret and the `claude-sonnet-5` fetch pattern from `chart-feedback.js` for: quality/relevance scoring rationale, opportunity generation, outreach drafting, asset matching, content-gap analysis. All AI JSON output gets validated server-side (Phase 24) before it ever reaches the database.
- **Rate limiting**: a new KV namespace (e.g. `LINKHUNTER_KV`), bound the same way `CHART_FEEDBACK_KV` is, tracking per-day/per-month counters for discovery runs, AI generation calls, contact discovery, and backlink verification.
- **Discovery/contact-data sources**: the spec explicitly forbids scraping in violation of ToS/robots and requires "configurable sources/APIs." The repo has **no existing SEO or backlink data provider**, and I have no API keys for one. This needs a decision before Phase 4/5/9 can be implemented for real (see "Open questions" below) — the discovery/scoring services will be built provider-agnostic (one adapter module per source) so they work with whatever the user decides on, and can start with a manual-entry-only + user-configured search API mode if no paid provider is chosen yet.

## 3. Database Changes

Six new tables exactly per the spec (`prospects`, `opportunities`, `outreach`, `backlinks`, `campaigns`, `content_assets`), plus indexes on `status`, `domain`, foreign keys, and a `created_at`/`updated_at` trigger pattern (checking if the repo already has an `updated_at` trigger convention to reuse before inventing a new one). No changes to existing tables.

## 4. API Changes

Purely additive: new routes under `/api/linkhunter/*` only, per the spec's Phase 21 list. No existing route is modified.

## 5. External APIs Required (none currently configured)

- **Backlink/SEO metrics** (domain authority, organic traffic estimate, spam score) — e.g. Moz API, Ahrefs API, SEMrush, or similar. None currently available.
- **Discovery / search** — a search API (e.g. Google Custom Search, Bing Search API, SerpApi) to find candidate pages per topic, respecting robots.txt for any direct fetch of discovered pages.
- **Contact discovery** — optional (e.g. Hunter.io) for finding publicly listed business contact emails; can also be manual-entry-only initially.
- **AI** — already available (`ANTHROPIC_API_KEY`).

## 6. Security Considerations

- Every `/api/linkhunter/*` route re-verifies the caller's Supabase JWT server-side and requires `app_metadata.is_admin === true` — identical to the existing admin pattern, never trusting a client-supplied flag.
- All service-role Supabase access and all third-party API keys stay in Cloudflare Pages env secrets, never in client-side code.
- No outreach email is ever sent automatically — enforced both in the UI (approval gate) and server-side (the `/outreach/:id/send` endpoint rejects anything not in `APPROVED` status).
- Rate limiting via KV on every expensive/external-facing operation (discovery, AI generation, contact discovery, verification) to prevent runaway cost or abuse.
- AI output is schema-validated before being written to the database (scores clamped 0–100, URLs/emails validated, enum fields checked against the allowed status/type lists).
- New tables get RLS enabled with no public policies (admin-tool data isn't meant to be publicly readable, unlike e.g. `signal_history`).

## 7. Implementation Phases (mapped onto the master spec, unchanged in order)

1. This report (done).
2. Admin shell + nav + auth gating for `/admin/linkhunter/*` (no real data yet).
3. Database migration script + apply it.
4–10. Discovery → quality scoring → opportunity engine → asset matching → opportunity score → contact discovery → outreach generation, each as its own `functions/lib/linkhunter/*.js` service with unit tests, wired to real DB tables incrementally.
11–12. Human approval workflow + outreach dashboard.
13–14. Backlink verification + lost-link monitor (Supabase `pg_cron` + `pg_net`, same mechanism as `signal_history`'s cron jobs).
15–19. Content-asset opportunity engine, campaigns, topic clustering, search/filter, CSV export.
20–24. Security/rate-limiting hardening pass, AI output validation pass.
25. Dashboard visual polish.
26–27. ScalpClock-specific tuning (asset list, seed topics/searches).
28–30. Test suite, launch checklist, final audit.

Each phase will be implemented, tested, and reported individually — not all at once — per the master spec's explicit instruction.
