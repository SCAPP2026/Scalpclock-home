-- ScalpClock: Founding Member Referral Program (Phase 1)
-- Run this ONCE in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- This repo has no migration-file convention (Supabase tables are created ad hoc
-- via the dashboard), so this file is a handoff/reference script, not something
-- auto-applied by any deploy.
--
-- Prerequisites before running: none. No new Cloudflare env vars, no extensions,
-- no cron -- Phase 1 has no scheduled job, everything is driven by the existing
-- Stripe webhook.

-- 1. Extend founding_members ------------------------------------------------
-- founder_number: race-safe under concurrent webhook deliveries because it's
-- a column DEFAULT pulling from a Postgres sequence, not app-level
-- count-then-increment logic.
create sequence if not exists founding_member_number_seq;

alter table founding_members
  add column if not exists founder_number integer
    not null default nextval('founding_member_number_seq') unique,
  add column if not exists referral_code text unique;

-- founding_members already has RLS enabled with zero policies (intentionally
-- locked to service-role-only when it was created). The referral dashboard
-- needs a founder to read their OWN row (code, founder_number) directly —
-- add a narrow owner-scoped SELECT policy rather than opening the whole table.
drop policy if exists "Owner read own founding row" on founding_members;
create policy "Owner read own founding row" on founding_members
  for select using (auth.uid() = user_id);

-- 2. referrals ----------------------------------------------------------------
-- One row per successful referral relationship. Created at the REFERRED
-- user's first successful checkout (not at signup) -- see webhook.js. A
-- subscriber can only ever be attributed to one referrer, ever (unique
-- constraint), which also doubles as the fraud guard against re-attribution.
create table if not exists referrals (
  id               bigint generated always as identity primary key,
  referrer_id      uuid not null,          -- founding_members.user_id
  referred_user_id uuid not null unique,
  referral_code    text not null,
  status           text not null default 'active'
                     check (status in ('active','inactive')),
  created_at       timestamptz not null default now()
);
create index if not exists referrals_referrer_idx on referrals (referrer_id);

alter table referrals enable row level security;
drop policy if exists "Owner read own referrals" on referrals;
create policy "Owner read own referrals" on referrals
  for select using (auth.uid() = referrer_id);

-- 3. referral_commissions ------------------------------------------------------
-- One row per successful recurring invoice payment from a referred
-- subscriber. stripe_invoice_id is unique so Stripe's at-least-once webhook
-- redelivery can never double-pay a commission for the same invoice.
create table if not exists referral_commissions (
  id                bigint generated always as identity primary key,
  referrer_id       uuid not null,
  subscriber_id     uuid not null,
  stripe_invoice_id text not null unique,
  amount            numeric not null,
  created_at        timestamptz not null default now()
);
create index if not exists referral_commissions_referrer_idx on referral_commissions (referrer_id);

alter table referral_commissions enable row level security;
drop policy if exists "Owner read own commissions" on referral_commissions;
create policy "Owner read own commissions" on referral_commissions
  for select using (auth.uid() = referrer_id);

-- 4. referral_program_settings (single row, config never hardcoded) -----------
-- $1.00/mo while founding spots are still open, $1.99/mo once all 500 are
-- claimed. The rate is looked up fresh at EVERY commission event (not stored
-- on the referral row), so existing referrals jump to $1.99 automatically
-- the moment the 500th spot fills -- no backfill/migration needed.
create table if not exists referral_program_settings (
  id                       int primary key default 1 check (id = 1),
  founding_member_limit    int not null default 500,
  commission_rate_pre_cap  numeric not null default 1.00,
  commission_rate_post_cap numeric not null default 1.99,
  referral_cookie_days     int not null default 60,
  referral_program_enabled boolean not null default true
);
insert into referral_program_settings (id) values (1) on conflict (id) do nothing;

-- To verify after running:
--   select founder_number, referral_code from founding_members order by founder_number;
--   select * from referral_program_settings;
