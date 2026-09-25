-- ScalpClock: Email unsubscribe tracking (for the Founding Member daily
-- reminder email, functions/api/admin/daily-reminder.js).
-- Already applied directly via Supabase MCP on 2026-09-25 -- this file is a
-- handoff/reference script, matching this repo's convention (see
-- referral_program_setup.sql), not something auto-applied by any deploy.
--
-- One row per (email, type) that has opted out. Checked before sending any
-- recurring email of that type -- never re-send to an unsubscribed address.

create table if not exists email_unsubscribes (
  id         bigint generated always as identity primary key,
  email      text not null,
  type       text not null default 'daily_reminder',
  created_at timestamptz not null default now(),
  unique(email, type)
);

alter table email_unsubscribes enable row level security;
-- No policies -- service-role only (same lockdown pattern as founding_members).
-- functions/api/unsubscribe.js is the only writer, using the service role key.

-- To verify after running:
--   select * from email_unsubscribes order by created_at desc;
