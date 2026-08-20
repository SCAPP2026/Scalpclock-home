-- ScalpClock: LinkHunter AI — Phase 3 (core schema)
-- Already applied to production (fnuqxiflqqejjttxymbz). Kept here as the
-- reference/handoff copy, same convention as this repo's other setup
-- scripts -- re-running is safe (every statement is idempotent).
-- This repo has no migration-file convention (Supabase tables are created ad hoc
-- via the dashboard), so this file is a handoff/reference script, not something
-- auto-applied by any deploy. See supabase/signal_history_setup.sql and
-- supabase/referral_program_setup.sql for the established pattern this follows.
--
-- Prerequisites before running: none. LinkHunter reuses the existing admin
-- mechanism (auth.users.raw_app_meta_data.is_admin = true, already granted
-- via referral_phase3_setup.sql's admin-grant snippet) -- no new admin flag,
-- no new Cloudflare env vars, no extensions.
--
-- Access model: every LinkHunter table is internal admin tooling, not
-- user-facing data. RLS is enabled with ZERO policies on every table below
-- (deliberately, same as founding_members was originally) -- all reads and
-- writes go through functions/api/linkhunter/*.js using the Supabase
-- service-role key, which bypasses RLS entirely and independently
-- re-verifies the caller's own admin status per request. There is no
-- anon/authenticated-role policy on any of these tables, so a leaked anon
-- key can never read or write LinkHunter data directly.

-- 0. Shared updated_at trigger -------------------------------------------------
-- No table in this repo currently auto-maintains updated_at; every
-- LinkHunter table needs it (records get mutated through their status
-- lifecycle, e.g. NEW -> QUALIFIED -> CONTACTED), so one shared trigger
-- function is defined once and reused by all six tables below.
create or replace function linkhunter_set_updated_at()
returns trigger
language plpgsql
set search_path = '' -- pins the search_path so this can't be hijacked by a same-named function in another schema
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 1. prospects ------------------------------------------------------------------
create table if not exists prospects (
  id                       bigint generated always as identity primary key,
  domain                   text not null,
  url                      text not null unique, -- dedup key; discovery must upsert on conflict
  site_name                text,
  title                    text,
  description              text,
  category                 text,
  country                  text,
  language                 text,
  domain_authority         numeric check (domain_authority is null or (domain_authority >= 0 and domain_authority <= 100)),
  organic_traffic_estimate bigint check (organic_traffic_estimate is null or organic_traffic_estimate >= 0),
  relevance_score          numeric check (relevance_score is null or (relevance_score >= 0 and relevance_score <= 100)),
  quality_score            numeric check (quality_score is null or (quality_score >= 0 and quality_score <= 100)),
  spam_score               numeric check (spam_score is null or (spam_score >= 0 and spam_score <= 100)),
  contact_name             text,
  contact_email            text,
  contact_role             text,
  contact_url              text,
  discovery_source         text,
  status                   text not null default 'NEW'
                             check (status in ('NEW','REVIEW','QUALIFIED','REJECTED','CONTACTED','RESPONDED','LINK_ACQUIRED','DO_NOT_CONTACT')),
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists prospects_domain_idx on prospects (domain);
create index if not exists prospects_status_idx on prospects (status);
create index if not exists prospects_category_idx on prospects (category);

drop trigger if exists set_updated_at on prospects;
create trigger set_updated_at before update on prospects
  for each row execute function linkhunter_set_updated_at();

alter table prospects enable row level security;

-- 2. opportunities ----------------------------------------------------------------
-- status values aren't enumerated in the product spec (unlike outreach/backlinks
-- below), so this stays free text with an app-layer default of 'NEW' rather than
-- a check constraint inventing values the spec never defined.
create table if not exists opportunities (
  id                     bigint generated always as identity primary key,
  prospect_id            bigint not null references prospects (id) on delete cascade,
  opportunity_type       text not null
                           check (opportunity_type in ('RESOURCE_LINK','EDITORIAL_MENTION','TOOL_CITATION','GUEST_CONTRIBUTION','PODCAST','INTERVIEW','NEWSLETTER','PARTNERSHIP','BROKEN_LINK','CONTENT_GAP','OTHER')),
  target_page            text,
  target_article         text,
  target_url             text,
  reason                 text,
  recommended_asset      text,
  relevance_score        numeric check (relevance_score is null or (relevance_score >= 0 and relevance_score <= 100)),
  opportunity_score      numeric check (opportunity_score is null or (opportunity_score >= 0 and opportunity_score <= 100)),
  personalization_notes  text,
  suggested_anchor       text,
  status                 text not null default 'NEW',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists opportunities_prospect_idx on opportunities (prospect_id);
create index if not exists opportunities_status_idx on opportunities (status);
create index if not exists opportunities_type_idx on opportunities (opportunity_type);

drop trigger if exists set_updated_at on opportunities;
create trigger set_updated_at before update on opportunities
  for each row execute function linkhunter_set_updated_at();

alter table opportunities enable row level security;

-- 3. campaigns ----------------------------------------------------------------
-- Created before outreach/backlinks below since both reference it.
-- status values aren't enumerated in the product spec -- free text, default 'ACTIVE'.
create table if not exists campaigns (
  id               bigint generated always as identity primary key,
  name             text not null,
  description      text,
  target_category  text,
  target_asset     text,
  status           text not null default 'ACTIVE',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists campaigns_status_idx on campaigns (status);

drop trigger if exists set_updated_at on campaigns;
create trigger set_updated_at before update on campaigns
  for each row execute function linkhunter_set_updated_at();

alter table campaigns enable row level security;

-- 4. outreach ----------------------------------------------------------------
-- approved_by_user references auth.users directly (the admin who clicked
-- Approve), same FK style as the rest of this repo uses for user_id columns.
create table if not exists outreach (
  id               bigint generated always as identity primary key,
  prospect_id      bigint not null references prospects (id) on delete cascade,
  opportunity_id   bigint references opportunities (id) on delete set null,
  campaign_id      bigint references campaigns (id) on delete set null,
  contact_name     text,
  contact_email    text,
  subject          text,
  body             text,
  status           text not null default 'DRAFT'
                     check (status in ('DRAFT','APPROVED','SENT','FOLLOW_UP','RESPONDED','DECLINED','NO_RESPONSE','CLOSED')),
  approved_by_user uuid references auth.users (id),
  sent_at          timestamptz,
  follow_up_at     timestamptz,
  response_status  text,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists outreach_prospect_idx on outreach (prospect_id);
create index if not exists outreach_campaign_idx on outreach (campaign_id);
create index if not exists outreach_status_idx on outreach (status);

drop trigger if exists set_updated_at on outreach;
create trigger set_updated_at before update on outreach
  for each row execute function linkhunter_set_updated_at();

alter table outreach enable row level security;

-- 5. backlinks ----------------------------------------------------------------
-- link_type isn't enumerated in the product spec -- free text (e.g. 'editorial',
-- 'resource_page', 'guest_post' etc., set by whoever records the verification).
create table if not exists backlinks (
  id             bigint generated always as identity primary key,
  prospect_id    bigint not null references prospects (id) on delete cascade,
  source_url     text not null,
  target_url     text not null,
  anchor_text    text,
  rel_attribute  text,
  first_seen     timestamptz not null default now(),
  last_verified  timestamptz,
  status         text not null default 'ACTIVE'
                   check (status in ('ACTIVE','LOST','NOFOLLOW','REDIRECT','REMOVED')),
  link_type      text,
  notes          text
);
create index if not exists backlinks_prospect_idx on backlinks (prospect_id);
create index if not exists backlinks_status_idx on backlinks (status);
-- Same source/target pair shouldn't be recorded twice by repeated verification runs.
create unique index if not exists backlinks_source_target_idx on backlinks (source_url, target_url);

alter table backlinks enable row level security;

-- 6. content_assets ----------------------------------------------------------------
create table if not exists content_assets (
  id                bigint generated always as identity primary key,
  title             text not null unique, -- keeps the seed insert below idempotent on re-run
  url               text,
  asset_type        text not null
                      check (asset_type in ('TOOL','GUIDE','CALCULATOR','DATA','STUDY','CHECKLIST','GLOSSARY','INFOGRAPHIC','VIDEO','OTHER')),
  description       text,
  target_keywords   text[],
  linkability_score numeric check (linkability_score is null or (linkability_score >= 0 and linkability_score <= 100)),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists content_assets_type_idx on content_assets (asset_type);

drop trigger if exists set_updated_at on content_assets;
create trigger set_updated_at before update on content_assets
  for each row execute function linkhunter_set_updated_at();

alter table content_assets enable row level security;

-- 7. Seed ScalpClock's existing linkable assets (Phase 7 / Phase 26 asset list) ----
insert into content_assets (title, url, asset_type, description)
values
  ('ORB Signal Engine', '/orbsignalengine', 'TOOL', 'Real-time opening-range-breakout signal detection tool.'),
  ('ScalpCharts', '/scalpchart', 'TOOL', 'Live scalping chart workspace with pattern overlays.'),
  ('Replay', '/scalpchart?tab=replay', 'TOOL', 'Historical market replay tool for practicing setups.'),
  ('Exit Assistant', '/exitassistant', 'TOOL', 'Options exit-timing assistant.'),
  ('Options Learning Lessons', '/learn-options-trading', 'GUIDE', 'Structured options-trading lesson library.'),
  ('Trading Glossary', '/learn-options-trading', 'GLOSSARY', 'Options and trading terminology reference.')
on conflict (title) do nothing;

-- To verify after running:
--   select count(*) from prospects;
--   select id, name, status from campaigns;
--   select title, asset_type from content_assets order by created_at;
