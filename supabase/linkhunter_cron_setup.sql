-- ScalpClock: LinkHunter AI — Phase 14 (scheduled lost-link monitor)
-- Run this ONCE in the Supabase SQL Editor, after linkhunter_setup.sql.
-- Same idempotent hand-run convention as supabase/signal_history_setup.sql.
--
-- Prerequisite before running:
--   In Cloudflare Pages (Settings -> Environment variables, both Production
--   AND Preview), add: LINKHUNTER_CRON_SECRET = HG-pe_PqOMtoDHfFDfwk6MGdmsrd0E1v
--   (a random secret generated for this purpose -- already filled in below
--   too, so no value needs to be invented or copied by hand).

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Re-verifies a batch of ACTIVE backlinks every 6 hours (functions/api/linkhunter/backlinks/verify.js's
-- cron-sweep mode, CRON_BATCH_SIZE=25 per run) and flips any that
-- disappeared to LOST. cron.schedule() upserts by job name, so re-running
-- this script is safe.
select cron.schedule(
  'linkhunter-backlink-verify',
  '0 */6 * * *',
  $$
  select net.http_post(
    url := 'https://scalpclock.com/api/linkhunter/backlinks/verify',
    headers := jsonb_build_object(
      'x-cron-secret', 'HG-pe_PqOMtoDHfFDfwk6MGdmsrd0E1v',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To check the job is registered:
--   select * from cron.job where jobname = 'linkhunter-backlink-verify';
-- To check run history:
--   select * from cron.job_run_details order by start_time desc limit 20;
-- To remove it if needed:
--   select cron.unschedule('linkhunter-backlink-verify');
