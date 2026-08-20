# LinkHunter AI — Launch Checklist

Status as of this build pass. Checked items are done and verified in this
session; unchecked items are deliberate manual/config steps that need a
human with dashboard access, or genuinely later-phase work.

## Build audit

- [x] **Lint** — no linter is configured in this repo (no `package.json`,
      no ESLint config); `node --check` run against every new `.js` file
      (backend + every inline `<script>` in the new admin pages) instead —
      all pass.
- [x] **Type checking** — not applicable; this repo has no TypeScript
      toolchain, all LinkHunter code is plain JS matching the existing
      repo convention.
- [x] **Unit tests** — `tests/linkhunter-scoring.test.js` (35 checks:
      scoring formulas, AI-output validation, URL/email/enum checks) and
      `tests/linkhunter-robots.test.js` (8 checks: robots.txt compliance,
      including fail-open behavior when robots.txt is unreachable).
- [x] **Integration test** — `tests/linkhunter-pipeline.test.js` (9 checks)
      drives the real Discovery → Prospect → Opportunity pipeline against
      a mocked fetch (robots.txt, page content, Anthropic, Supabase),
      including a deliberately-invalid AI-generated opportunity to confirm
      Phase 24 validation actually rejects it rather than writing garbage.
- [x] **Full repo test suite** — all 82 checks across
      `tests/options-direction.test.js` (pre-existing) and the three new
      LinkHunter test files pass together (`node tests/*.test.js`).
- [x] **Production build** — no build step in this repo (static HTML +
      Cloudflare Pages Functions); nothing to compile.
- [x] **No broken routes** — all 8 `/admin/linkhunter/*` pages exist and
      link only to real, implemented API endpoints. All 16
      `/api/linkhunter/*` Functions match the routes their pages call.
- [x] **No exposed secrets** — grepped every new file for hardcoded
      service-role/Anthropic/Resend keys; only the pre-existing public
      Supabase anon key (already shipped client-side elsewhere in this
      repo) appears literally, matching the existing convention.
- [x] **No broken existing ScalpClock features** — `sitemap.xml`
      regenerates identically before/after (new admin pages are correctly
      excluded via their `noindex` meta tag, same mechanism the sitemap
      generator already used for `admin-referrals.html`); no existing file
      outside `admin/linkhunter/`, `functions/api/linkhunter/`,
      `functions/lib/linkhunter/`, and `supabase/linkhunter_*.sql` was
      modified except `wrangler.toml` (additive KV binding + secrets
      documentation) and `_headers` (additive cache rule).
- [x] **Authentication** — every `/api/linkhunter/*` route re-verifies the
      caller's Supabase JWT server-side and requires
      `app_metadata.is_admin === true`, identical to the existing
      `admin-referrals` pattern; the client-side check is UI-only and
      never trusted.
- [x] **Database migrations** — applied to production
      (`fnuqxiflqqejjttxymbz`): `linkhunter_core_schema` (6 tables + RLS,
      zero policies, service-role-only access),
      `linkhunter_pin_trigger_search_path` (security-advisor fix), and
      `linkhunter_backlink_cron` (pg_cron job). Verified via
      `list_tables` and `get_advisors` — zero new security findings beyond
      the intentional/documented "RLS enabled, no policy" ones.
- [x] **API error handling** — every route validates its inputs, returns
      typed JSON errors with correct status codes, and never lets an
      unhandled exception leak a stack trace to the client (all wrapped in
      try/catch with a generic message + server-side `console.error`).
- [ ] **Mobile / desktop responsiveness** — built with the same flex-wrap,
      relative-width patterns as the rest of the light-theme admin UI
      (`admin-referrals.html`), but **not visually verified in a real
      browser** in this session (no browser available). Recommend a quick
      manual pass on a phone-width viewport before considering this done.

## Manual configuration still required (cannot be done from this session)

1. **Bind `LINKHUNTER_KV` in the Cloudflare Pages dashboard** (Settings →
   Functions → KV namespace bindings) — the namespace itself was created
   (`11782ac4ba8744d9939b254e6a1cbb74`) and is in `wrangler.toml` for local
   dev, but production Pages deployments need the dashboard binding too,
   same as `CHART_FEEDBACK_KV` already required.
2. **Set `LINKHUNTER_CRON_SECRET`** in Cloudflare Pages env vars (Production
   *and* Preview) to `HG-pe_PqOMtoDHfFDfwk6MGdmsrd0E1v` — the pg_cron job is
   already live in Supabase and will call
   `/api/linkhunter/backlinks/verify` every 6 hours; until this secret is
   set, those calls will get a harmless 403.
3. **Optional — outreach sending:** set `RESEND_API_KEY` and
   `LINKHUNTER_FROM_EMAIL` to enable `POST /outreach/:id/send`. Until set,
   that endpoint returns a clear "not configured" error rather than
   failing silently or fabricating a send. No provider was chosen for you —
   this needs an explicit decision (Resend was picked as a simple,
   REST-only fit for this repo's fetch-based style; swap the one function
   in `outreach/[id]/send.js` if a different provider is preferred).
4. **Optional — real discovery/SEO-metrics sources:** LinkHunter currently
   runs in manual seed-URL discovery mode (no Google CSE/Bing/SerpApi key)
   and leaves `domain_authority`/`organic_traffic_estimate` as
   admin-entered fields (no Moz/Ahrefs/SEMrush key). Nothing is fabricated
   in their place. Wiring a real provider is additive — the discovery and
   scoring services were written provider-agnostic so a new source module
   can be dropped in without changing the endpoint contracts.
5. **Grant yourself LinkHunter admin access** if you don't already have
   `is_admin` set — same one-time step documented in
   `supabase/referral_phase3_setup.sql`, not LinkHunter-specific.

## Feature coverage vs. the master spec

Implemented and live: architecture doc, admin shell + nav, full DB schema,
prospect discovery (seed-URL mode), website quality scoring, opportunity
engine, asset matching, opportunity scoring, contact management (manual),
AI outreach generation, human approval gate (Draft → Review → Approved →
Send, send is the only route that can mark SENT), outreach dashboard,
backlink verification (manual + scheduled), lost-link monitor, campaigns,
content assets + content-gap suggestions, topic clustering, search/filter,
CSV export, rate limiting with a usage dashboard, AI-prompt separation
(`functions/lib/linkhunter/prompts/`), AI-output validation, security
(admin-only + re-verified server-side + audit-friendly logging via
`console.error` on every failure path).

Explicitly out of scope / not built, per the spec's own prohibitions:
automated mass-sending, blog-comment/forum/profile spam, link farms, PBNs,
purchased links, fake websites, mass guest-post generation, and anything
that bypasses the human-approval gate before an email goes out.

Not built in this pass (would need product/API decisions this session
doesn't have authority to make on your behalf): a real search-API
discovery source, a real SEO-metrics provider, and a chosen outreach email
provider (all three are additive, not architectural, changes on top of
what's here).
