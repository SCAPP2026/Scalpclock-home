-- ScalpClock: Scalp Opportunity Engine — Milestone 1 schema
-- Run ONCE in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- Same convention as signal_history_setup.sql: a handoff/reference script,
-- not auto-applied by any deploy (this repo has no migration-file runner).
--
-- ADDITIVE ONLY. This script must never break signal-performance.js's
-- existing query (`select=symbol,tone,snapshot_price,eval_price,result,
-- snapshot_at,eval_at`) or the existing
-- (symbol, tone, snapshot_date) unique index on signal_history — both are
-- read/relied on by the live /signals page today. Every change below is a
-- new nullable column or a brand-new table; nothing existing is dropped,
-- renamed, or made non-nullable.

-- 1. Extend signal_history with the new score fields ------------------------
alter table signal_history add column if not exists score            numeric;
alter table signal_history add column if not exists score_breakdown  jsonb;
alter table signal_history add column if not exists confidence       text;
alter table signal_history add column if not exists setup            text;
alter table signal_history add column if not exists engine_version   text;
alter table signal_history add column if not exists current_status   text
  check (current_status in ('developing','confirmed','active','invalidated','expired') or current_status is null);

comment on column signal_history.engine_version is
  'Which scoring-model version produced score/score_breakdown for this row. '
  'Exists so a future re-tuning of the 8-category weights never gets silently '
  'blended with backtest stats from a prior weighting era.';

-- 2. signal_outcomes_detail — multi-horizon MFE/MAE tracking -----------------
-- One row per (signal, horizon) — different cardinality than signal_history
-- (which is evaluated once, ~20h later, against a single price), so this is
-- a new table rather than new columns.
create table if not exists signal_outcomes_detail (
  id                 bigint generated always as identity primary key,
  signal_history_id  bigint not null references signal_history(id) on delete cascade,
  horizon_type       text not null check (horizon_type in ('fixed','mfe','mae')),
  horizon_minutes    integer,             -- null for mfe/mae rows (running max/min, not a fixed horizon)
  price_at_horizon   numeric,
  return_pct         numeric,
  recorded_at        timestamptz not null default now()
);

create index if not exists signal_outcomes_detail_sh_id_idx
  on signal_outcomes_detail (signal_history_id);

alter table signal_outcomes_detail enable row level security;
drop policy if exists "Public read access" on signal_outcomes_detail;
create policy "Public read access" on signal_outcomes_detail
  for select using (true);

-- 3. signal_lifecycle_events — status TRANSITIONS over time ------------------
-- Logging transitions (not just current state) lets a future backtest ask
-- "how long did signals typically stay in developing before invalidating"
-- without having needed to poll at exactly the right moment.
create table if not exists signal_lifecycle_events (
  id                 bigint generated always as identity primary key,
  signal_history_id  bigint not null references signal_history(id) on delete cascade,
  status             text not null check (status in ('developing','confirmed','active','invalidated','expired')),
  occurred_at        timestamptz not null default now(),
  detail             jsonb
);

create index if not exists signal_lifecycle_events_sh_id_idx
  on signal_lifecycle_events (signal_history_id);

alter table signal_lifecycle_events enable row level security;
drop policy if exists "Public read access" on signal_lifecycle_events;
create policy "Public read access" on signal_lifecycle_events
  for select using (true);

-- 4. Cron: outcomes-detail evaluation ----------------------------------------
-- Runs more frequently than the once-daily signals-eval job (every 10 min,
-- 14:35-20:05 UTC covers 9:35 AM-3:55 PM ET with margin either side of the
-- 9:30-4:00 ET session) so MFE/MAE and fixed-horizon (5/10/15/30min) returns
-- get recorded while a signal's outcome is still unfolding, not just once
-- ~20h later. Reuses the SAME shared-secret cron-auth pattern as the
-- existing signals-eval/signals-snapshot jobs — no new auth mechanism.
select cron.schedule(
  'signals-outcomes-detail',
  '*/10 14-20 * * 1-5',
  $$
  select net.http_post(
    url := 'https://scalpclock.com/api/signals-outcomes-detail',
    headers := jsonb_build_object('x-cron-secret', 'HkoCCcNzbkXqgLKiUZQujf_LbA_GrzhD')
  );
  $$
);

-- To check jobs are registered:      select * from cron.job;
-- To check run history:              select * from cron.job_run_details order by start_time desc limit 20;
-- To remove this job if needed:      select cron.unschedule('signals-outcomes-detail');
