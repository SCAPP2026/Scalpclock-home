-- ScalpClock Phase 2: Recent Signal Performance
-- Run this ONCE in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- This repo has no migration-file convention (Supabase tables are created ad hoc
-- via the dashboard), so this file is a handoff/reference script, not something
-- auto-applied by any deploy.
--
-- Prerequisites before running:
--   1. In Cloudflare Pages (Settings -> Environment variables, both Production
--      AND Preview), add: SIGNALS_CRON_SECRET = HkoCCcNzbkXqgLKiUZQujf_LbA_GrzhD
--      (a random secret generated for this purpose -- already filled in below
--      too, so no value needs to be invented or copied by hand).
--   2. Nothing else -- this script enables pg_cron/pg_net itself.

-- 1. Table -------------------------------------------------------------------
create table if not exists signal_history (
  id             bigint generated always as identity primary key,
  symbol         text not null,
  tone           text not null check (tone in ('buy', 'sell')),
  conviction     text,
  snapshot_price numeric not null,
  snapshot_at    timestamptz not null default now(),
  snapshot_date  date generated always as ((snapshot_at at time zone 'utc')::date) stored,
  eval_price     numeric,
  eval_at        timestamptz,
  result         text check (result in ('win', 'loss', 'flat'))
);

-- Prevents duplicate rows if the snapshot cron ever fires twice in one day
-- for the same symbol+direction.
create unique index if not exists signal_history_symbol_tone_date_idx
  on signal_history (symbol, tone, snapshot_date);

-- Public read access for the /signals page (service-role key is used for all
-- writes from the Cloudflare Functions, so this is read-only for anon).
-- CREATE POLICY has no IF NOT EXISTS variant, so drop-then-create for
-- idempotency if this script is ever re-run.
alter table signal_history enable row level security;
drop policy if exists "Public read access" on signal_history;
create policy "Public read access" on signal_history
  for select using (true);

-- 2. Extensions ----------------------------------------------------------------
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- 3. Scheduled jobs --------------------------------------------------------------
-- The secret below must exactly match SIGNALS_CRON_SECRET in Cloudflare Pages
-- (see prerequisite #1 above) -- if you generate your own instead of using the
-- pre-filled one, change it in BOTH places. Times are UTC; 14:40/14:45 UTC
-- lands safely after the 9:30 AM ET open in both EST (UTC-5) and EDT (UTC-4).
-- Eval runs 5 minutes before snapshot so a given day's run evaluates the PRIOR
-- day's snapshot (>20h old) before writing today's new snapshot.
-- cron.schedule() upserts by job name, so re-running this script is safe.

select cron.schedule(
  'signals-eval-daily',
  '40 14 * * 1-5',
  $$
  select net.http_post(
    url := 'https://scalpclock.com/api/signals-eval',
    headers := jsonb_build_object('x-cron-secret', 'HkoCCcNzbkXqgLKiUZQujf_LbA_GrzhD')
  );
  $$
);

select cron.schedule(
  'signals-snapshot-daily',
  '45 14 * * 1-5',
  $$
  select net.http_post(
    url := 'https://scalpclock.com/api/signals-snapshot',
    headers := jsonb_build_object('x-cron-secret', 'HkoCCcNzbkXqgLKiUZQujf_LbA_GrzhD')
  );
  $$
);

-- To check the jobs are registered:
--   select * from cron.job;
-- To check run history:
--   select * from cron.job_run_details order by start_time desc limit 20;
-- To remove a job if needed:
--   select cron.unschedule('signals-snapshot-daily');
