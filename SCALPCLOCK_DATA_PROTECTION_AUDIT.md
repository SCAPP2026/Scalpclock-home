# ScalpClock — Member Data & Progress Protection Audit

Generated from live inspection of the production Supabase project
(`fnuqxiflqqejjttxymbz`) and the application source in this repo. This is a
factual snapshot of **where member progress actually lives today**, not a
proposal — it exists so that any future change (Skill Score included) can be
checked against ground truth instead of assumption.

Two findings below are flagged **[NEEDS DECISION]** because they directly
affect how a new Skill Score feature should be designed. Everything else is
descriptive.

---

## 1. Storage map — what's server-side vs. device-only

| Data type | Where it actually lives | Server-side (survives device loss)? |
|---|---|---|
| Account / plan / trial status | `auth.users.app_metadata` (`plan`, `stripe_sub_id`, `founding_member`) | ✅ Yes |
| Founding Member record | `public.founding_members` table (`user_id`, `founder_number`, `referral_code`, `stripe_subscription_id`) | ✅ Yes |
| Referral program config | `public.referral_program_settings` (singleton row) | ✅ Yes |
| Referral relationships | `public.referrals` (referrer_id, referred_user_id, status) | ✅ Yes (table exists, **currently 0 rows** — see §4) |
| Referral commissions | `public.referral_commissions` (referrer_id, subscriber_id, stripe_invoice_id, amount) | ✅ Yes (table exists, **currently 0 rows** — see §4) |
| Trade journal entries (the real journal, written by `journal.html`) | `public.trades` table — full schema: symbol, direction, entry/exit price, pnl, contracts, strike, expiry, notes, tags, emotions, strategy, setup_grade, ORB fields, `trade_score`, `trade_score_breakdown` | ✅ Yes |
| Weekly trade reviews | `public.trade_weekly_reviews` — `trader_score`, `trader_score_prev`, win_rate, best/worst trade, biggest_mistake, improvement_goal | ✅ Yes (table exists, **currently 0 rows** — feature likely not yet actively populated) |
| Journal preferences (e.g. daily limit) | `public.profiles.journal_settings` (jsonb) | ✅ Yes |
| **Learn Hub progress**: lessons done, badges, XP, streak, quiz-first-try count | `public.profiles.learn_progress` (jsonb: `{done[], badges[], xp, streakDate, streakCount, quizFirstTry}`) — synced from `learn.html` and `journal.html` | ✅ Yes, **but only for logged-in users** |
| Learn Hub progress for anonymous/logged-out visitors | `localStorage` keys `sc_lessons_done`, `sc_earned_badges`, `sc_learn_xp`, `sc_streak_date`, `sc_streak_count`, `sc_quiz_first_try` | ❌ Device-only |
| **Replay progress/XP/streak** (scalpchart.html) | `localStorage` keys `sc_replay_xp`, `sc_replay_correct`, `sc_replay_quiz_total`, `sc_replay_streak`, `sc_replay_progress` | ❌ **Device-only, no cloud sync found anywhere in the codebase** |
| **ORB Signal Engine's own trade ledger** | `localStorage` key `sc_orb_trade_ledger` (separate from the real journal — see §3) | ❌ Device-only |
| ORB Signal Engine visit counter | `public.orb_engine_visits` (anonymous, no `user_id` column — a site-wide counter, not per-member history) | ✅ Yes, but **not per-user** |
| Dashboard's onboarding/login streak | `localStorage` keys `sc_last_login`, `sc_streak`, `sc_onboarding_done`, `sc_onboarding_dismissed` | ❌ Device-only, and **a different key/counter than Learn Hub's streak** — see §3 |
| Signal accuracy history | `public.signal_history` (site-wide, no `user_id` — not member-specific) | ✅ Yes, but **not per-user** |

**Read this table plainly:** anything marked "device-only" cannot be protected by a database backup, because it isn't in the database. If a member clears their browser, uses a different device, or reinstalls, that data is already gone today — independent of any redesign. The protection rules in the brief apply fully to everything server-side; for device-only data, "preserve it" means *don't touch the localStorage keys or their read/write logic*, since there is no other copy to fall back on.

---

## 2. How progress is calculated, displayed, read, and written

### Learn Hub (learn.html)
- **Calculated**: `levelFromXP()` derives level from cumulative XP against an `xpForLevel()` curve; streak via `getStreak()`/`bumpStreak()` comparing today/yesterday date strings.
- **Displayed**: XP bar, level title, streak flame, badge wall — all read from the `LS` (localStorage) helper functions (`getXP`, `getDone`, `getEarned`, `getStreak`).
- **Written**: `markDone()`, `addXP()`, `earnBadge()`, `bumpStreak()` write to localStorage immediately (instant UI feedback), then `pushProgressToCloud()` upserts the full snapshot to `profiles.learn_progress` for logged-in users.
- **Cloud sync direction**: on login/page load, `syncProgressFromCloud()` pulls `profiles.learn_progress` and **union-merges** it into localStorage — arrays are merged via `Set`, numeric values take `Math.max(local, cloud)`. This is already non-destructive by design: it cannot lose progress from either the device or the account, and cannot decrease XP/streak. This existing merge logic is the correct pattern to preserve and reuse for any new sync code.
- **APIs/writes**: only client-side Supabase JS calls (`sb.from('profiles').upsert(...)`) — no Cloudflare Function currently mutates `learn_progress`.

### Journal (journal.html)
- **Reads/writes** `public.trades` directly (insert/update/delete), scoped with `.eq('user_id', _uid)` on every mutation.
- Also reads/writes the **same** `profiles.learn_progress` XP/badges fields as learn.html (confirmed via its own comment: "same XP/badge storage learn.html uses") — so Learn and Journal share one gamification record, not two.
- Journal-specific settings (e.g. daily entry limit) live in `profiles.journal_settings`, separate jsonb column.

### Dashboard (dashboard.html)
- **Reads** `trades` (status, pnl, symbol, closed_at, trade_score) for stats — read-only, does not write to `trades`.
- Has its **own**, separate onboarding/streak localStorage keys (`sc_last_login`, `sc_streak`) that are not the same keys Learn Hub uses (`sc_streak_date`, `sc_streak_count`) — see §3.

### ORB Signal Engine (orbsignalengine.html)
- Maintains its own local `sc_orb_trade_ledger` and a `sc_pending_trade` handoff key.
- Does **not** write to `public.trades` directly — a trade only becomes a permanent journal record if/when the user takes the "pending trade" handoff into Journal, where `journal.html` inserts it.
- No per-user ORB history table exists in Supabase today. `orb_engine_visits` is anonymous and site-wide.

### Founding Member / Referrals
- `founding_members.referral_code` is generated at signup and is the durable source of truth for a member's referral link.
- `referrals` and `referral_commissions` tables exist with the right shape to track attribution and payouts, but both currently have **0 rows** in production — see §4.
- Founding status gating in the frontend checks `auth.users.app_metadata.founding_member === true` (referrals.html, founders.html) — **not** the `founding_members` table directly. These two must stay in sync; prior sessions' work already added fetch-then-merge patching of `app_metadata` specifically to avoid one overwriting the other.

---

## 3. [NEEDS DECISION] Two divergent, unsynced streak systems

Dashboard tracks a login streak using `sc_last_login` / `sc_streak`. Learn Hub
tracks a lesson streak using `sc_streak_date` / `sc_streak_count`. These are
**different keys with no shared logic** — a member can see two different
streak numbers depending on which page they're looking at, and neither
currently syncs to the other or to the cloud (dashboard's streak isn't in
`profiles.learn_progress` at all).

This is a pre-existing inconsistency, not something introduced by any recent
change. Per the golden rule ("never make an existing member start over"), I
have **not** touched either streak system or attempted to merge them — doing
so unilaterally risks changing a visible number for existing members, which
the brief explicitly forbids. Flagging for a decision: should these stay
separate (dashboard = login streak, Learn = lesson streak, clearly labeled as
different things), or should they be unified — and if unified, which number
wins for members who currently have two different values?

## 4. [NEEDS DECISION] Referral tables are empty; Trade Score / Trader Score already exists

- `referrals` (0 rows) and `referral_commissions` (0 rows) are live, correctly
  shaped tables, but nothing has been inserted into them yet in production.
  Before building anything referral-related, confirm whether this is expected
  (feature not fully wired end-to-end yet) or a bug (something should be
  writing to these and isn't). I have not attempted to backfill or "fix" this
  — it needs a decision, not an assumption.
- **The requested "Skill Score" already substantially exists**: `trades.trade_score`
  (0-100, per-trade, with a `trade_score_breakdown` jsonb) and
  `trade_weekly_reviews.trader_score` / `trader_score_prev` (a rolling,
  previous-vs-current trader-level score) were built in a prior session
  (commit `8bb4a41`, "Add ScalpClock Trade Performance System: Trade Score,
  Trader Score, insights, and ORB/Replay integration"). Before implementing a
  new, separate "ScalpClock Skill Score™," this needs to be resolved with the
  user: is Skill Score a **rename/rebrand** of the existing Trader Score, an
  **extension** of it (e.g. folding in Learn Hub XP/streak alongside trading
  performance), or a genuinely **separate, third** metric? Building a new
  parallel score without answering this risks exactly the kind of confusing,
  redundant system the protection brief is trying to prevent — and risks
  members seeing two different "score" numbers that mean different things.

---

## 5. Row Level Security

`list_tables` confirms **RLS is enabled on every table** in the `public`
schema, including all member-progress tables (`profiles`, `trades`,
`trade_weekly_reviews`, `founding_members`, `referrals`,
`referral_commissions`). This is a real, verified safeguard — not assumed.

## 6. What this audit did NOT do, on purpose

I did not query or export actual member rows (real `auth.users` emails,
`app_metadata`, or individual `profiles`/`trades` content). One such query
was in fact blocked by this environment's own permission controls when
attempted. Beyond that, pulling real member PII wasn't necessary to produce
this structural audit, and there is no migration happening in this session
that would justify it. The schema-level facts above (table/column names,
row counts, code paths) are sufficient to document the architecture
accurately. If/when a real migration is planned, take the actual backup at
that time (see below), scoped to only what that migration touches.

## 7. Backup procedure (to run immediately before any future migration)

Not run in this session (no migration is happening yet — see §6). When one
is planned:

1. Supabase dashboard → Database → Backups: production projects on Supabase
   have automatic daily backups; confirm a recent one exists before
   proceeding, and note its timestamp.
2. For an explicit pre-migration snapshot of just the member-progress tables,
   export `profiles`, `trades`, `trade_weekly_reviews`, `founding_members`,
   `referrals`, `referral_commissions` (e.g. via `pg_dump --table=... ` or
   the Supabase SQL editor's CSV export) to a file kept outside the repo.
3. Run `SCALPCLOCK_PROGRESS_INTEGRITY_CHECK.mjs snapshot` (see companion
   script) for a representative set of test/real account IDs **before** the
   change, and again **after**, then diff.

## 8. Golden rule, restated against what's actually true today

> Change the UI. Do not change the history.

Concretely, for any future change touching these systems:
- Never write to `profiles.learn_progress`, `trades`, `trade_weekly_reviews`,
  or `founding_members` with anything other than an additive
  upsert/insert that preserves existing field values (mirror the existing
  `syncProgressFromCloud()` union-merge pattern in learn.html).
- Never introduce a migration that recalculates and overwrites `xp`,
  `streakCount`, `done`, `badges`, `trade_score`, or `trader_score` for
  existing rows. New calculations (like Skill Score) get **new** fields or a
  **new** table, computed from existing data as a read-only input, never
  replacing it.
- If a member has no data for a new metric yet, show "Complete more
  training to unlock your Skill Score" — never backfill a fabricated
  historical value.
