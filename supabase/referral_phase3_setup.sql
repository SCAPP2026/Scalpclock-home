-- ScalpClock: Founding Member Referral Program (Phase 3)
-- Run this ONCE in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- Requires Phase 1's referral_program_setup.sql to have already been run
-- (founding_members.founder_number/referral_code, referrals, referral_commissions).
--
-- Prerequisites before running: none. No new Cloudflare env vars.

-- 1. notifications ------------------------------------------------------------
-- In-app only (no email/push provider). One row per event: a new referral
-- landed, a commission was earned, or a milestone was crossed.
create table if not exists notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  type       text not null check (type in ('new_referral','commission','milestone')),
  title      text not null,
  body       text not null,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on notifications (user_id, read);

alter table notifications enable row level security;
drop policy if exists "Owner read own notifications" on notifications;
create policy "Owner read own notifications" on notifications
  for select using (auth.uid() = user_id);
drop policy if exists "Owner update own notifications" on notifications;
create policy "Owner update own notifications" on notifications
  for update using (auth.uid() = user_id);

-- 2. leaderboard_view -----------------------------------------------------------
-- Anonymized aggregate only: founder_number + active referral count, nothing
-- else. Postgres views run with the OWNER's privileges by default (not the
-- querying role's), so this can safely read across the RLS-locked
-- founding_members/referrals tables while exposing zero PII (no user_id, no
-- email) to the anon role.
create or replace view leaderboard_view as
select fm.founder_number,
       count(r.id) filter (where r.status = 'active') as active_referrals
from founding_members fm
left join referrals r on r.referrer_id = fm.user_id
group by fm.founder_number
having count(r.id) filter (where r.status = 'active') > 0
order by active_referrals desc
limit 50;

grant select on leaderboard_view to anon;

-- 3. Realtime -------------------------------------------------------------------
-- Lets referrals.html push live updates instead of only polling.
alter publication supabase_realtime add table referrals, referral_commissions, notifications;

-- 4. Grant yourself admin access -------------------------------------------------
-- Run this SEPARATELY with your own email (not part of the block above).
-- This is the only way to become an admin -- there's no signup flow for it.
--
-- update auth.users set raw_app_meta_data = raw_app_meta_data || '{"is_admin": true}'::jsonb
--   where email = 'you@example.com';

-- To verify after running:
--   select * from leaderboard_view;
--   select count(*) from notifications;
--   select raw_app_meta_data from auth.users where email = 'you@example.com';
