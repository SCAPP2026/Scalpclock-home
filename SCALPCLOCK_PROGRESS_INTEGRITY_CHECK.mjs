#!/usr/bin/env node
// Snapshot-and-diff tool for verifying that a migration/redesign did not
// alter existing member progress. See SCALPCLOCK_DATA_PROTECTION_AUDIT.md
// for the full data map this script is built against.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... node SCALPCLOCK_PROGRESS_INTEGRITY_CHECK.mjs snapshot before.json user-id-1 user-id-2 ...
//   ...deploy / migrate here...
//   SUPABASE_SERVICE_ROLE_KEY=... node SCALPCLOCK_PROGRESS_INTEGRITY_CHECK.mjs snapshot after.json user-id-1 user-id-2 ...
//   node SCALPCLOCK_PROGRESS_INTEGRITY_CHECK.mjs diff before.json after.json
//
// The diff step needs no credentials — it only reads the two JSON files.
// Requires Node 18+ (built-in fetch).

const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';

const TRADE_HISTORICAL_FIELDS = [
  'symbol', 'direction', 'entry_price', 'exit_price', 'pnl', 'pnl_pct',
  'status', 'opened_at', 'closed_at', 'contracts', 'strike', 'expiry',
  'notes', 'exit_reason', 'source_setup', 'strategy', 'setup_grade',
  'market_trend', 'vwap_position', 'entry_confirmation', 'orb_direction',
  'orb_score', 'breakout_level', 'planned_entry', 'planned_stop',
  'planned_target', 'planned_risk', 'emotions', 'tags',
];

async function sbFetch(path, serviceKey) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function snapshotUser(userId, serviceKey) {
  const [profile, authUser, trades, weeklyReviews, founding, referralsOut, referralsIn, commissions] = await Promise.all([
    sbFetch(`/rest/v1/profiles?id=eq.${userId}&select=*`, serviceKey),
    sbFetch(`/auth/v1/admin/users/${userId}`, serviceKey).catch((e) => ({ error: String(e) })),
    sbFetch(`/rest/v1/trades?user_id=eq.${userId}&select=*&order=opened_at.asc`, serviceKey),
    sbFetch(`/rest/v1/trade_weekly_reviews?user_id=eq.${userId}&select=*&order=week_start.asc`, serviceKey),
    sbFetch(`/rest/v1/founding_members?user_id=eq.${userId}&select=*`, serviceKey),
    sbFetch(`/rest/v1/referrals?referrer_id=eq.${userId}&select=*`, serviceKey),
    sbFetch(`/rest/v1/referrals?referred_user_id=eq.${userId}&select=*`, serviceKey),
    sbFetch(`/rest/v1/referral_commissions?referrer_id=eq.${userId}&select=*`, serviceKey),
  ]);
  return {
    userId,
    plan: authUser?.app_metadata?.plan ?? null,
    foundingMemberFlag: authUser?.app_metadata?.founding_member ?? null,
    stripeSubId: authUser?.app_metadata?.stripe_sub_id ?? null,
    profile: profile?.[0] ?? null,
    trades,
    weeklyReviews,
    founding: founding?.[0] ?? null,
    referralsAsReferrer: referralsOut,
    referralsAsReferred: referralsIn,
    commissions,
  };
}

async function cmdSnapshot(outFile, userIds) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('Set SUPABASE_SERVICE_ROLE_KEY in the environment first.');
  if (!userIds.length) throw new Error('Pass at least one user id to snapshot.');
  const snapshot = { takenAt: new Date().toISOString(), users: {} };
  for (const id of userIds) {
    process.stdout.write(`snapshotting ${id}... `);
    snapshot.users[id] = await snapshotUser(id, serviceKey);
    console.log('ok');
  }
  await import('node:fs').then((fs) => fs.promises.writeFile(outFile, JSON.stringify(snapshot, null, 2)));
  console.log(`wrote ${outFile}`);
}

function flag(list, level, msg) { list.push({ level, msg }); }

function diffUser(userId, before, after) {
  const findings = [];
  if (!after) { flag(findings, 'CRITICAL', 'User present before, missing entirely after.'); return findings; }

  // --- plan / founding / subscription ---
  if (before.plan && ['pro', 'trial'].includes(before.plan) && !['pro', 'trial'].includes(after.plan)) {
    flag(findings, 'CRITICAL', `plan regressed from '${before.plan}' to '${after.plan}'.`);
  }
  if (before.foundingMemberFlag === true && after.foundingMemberFlag !== true) {
    flag(findings, 'CRITICAL', 'founding_member flag was true before, not true after.');
  }
  if (before.stripeSubId && before.stripeSubId !== after.stripeSubId) {
    flag(findings, 'CRITICAL', `stripe_sub_id changed: ${before.stripeSubId} -> ${after.stripeSubId}`);
  }
  if (before.founding && !after.founding) {
    flag(findings, 'CRITICAL', 'founding_members row disappeared.');
  } else if (before.founding && after.founding) {
    for (const f of ['founder_number', 'referral_code', 'stripe_subscription_id']) {
      if (before.founding[f] !== after.founding[f]) {
        flag(findings, 'CRITICAL', `founding_members.${f} changed: ${before.founding[f]} -> ${after.founding[f]}`);
      }
    }
  }

  // --- learn_progress (XP, streak, badges, lessons done, quiz) ---
  const lpBefore = before.profile?.learn_progress || {};
  const lpAfter  = after.profile?.learn_progress || {};
  if ((lpBefore.xp || 0) > (lpAfter.xp || 0)) {
    flag(findings, 'CRITICAL', `XP decreased: ${lpBefore.xp} -> ${lpAfter.xp}`);
  }
  if ((lpBefore.streakCount || 0) > (lpAfter.streakCount || 0)) {
    flag(findings, 'CRITICAL', `Streak decreased: ${lpBefore.streakCount} -> ${lpAfter.streakCount}`);
  }
  const doneBefore = new Set(lpBefore.done || []);
  const doneAfter  = new Set(lpAfter.done || []);
  for (const d of doneBefore) if (!doneAfter.has(d)) flag(findings, 'CRITICAL', `Lesson completion lost: '${d}' was done, no longer marked done.`);
  const badgesBefore = new Set(lpBefore.badges || []);
  const badgesAfter  = new Set(lpAfter.badges || []);
  for (const b of badgesBefore) if (!badgesAfter.has(b)) flag(findings, 'CRITICAL', `Badge lost: '${b}' was earned, no longer present.`);
  if ((lpBefore.quizFirstTry || 0) > (lpAfter.quizFirstTry || 0)) {
    flag(findings, 'WARN', `quizFirstTry decreased: ${lpBefore.quizFirstTry} -> ${lpAfter.quizFirstTry}`);
  }

  // --- trades (the real journal) ---
  const tradesAfterById = new Map((after.trades || []).map((t) => [t.id, t]));
  for (const t of before.trades || []) {
    const match = tradesAfterById.get(t.id);
    if (!match) { flag(findings, 'CRITICAL', `Trade journal entry deleted: id=${t.id} symbol=${t.symbol} opened_at=${t.opened_at}`); continue; }
    for (const f of TRADE_HISTORICAL_FIELDS) {
      const bv = JSON.stringify(t[f]), av = JSON.stringify(match[f]);
      if (bv !== av) flag(findings, 'CRITICAL', `Trade ${t.id} field '${f}' changed: ${bv} -> ${av}`);
    }
    if (JSON.stringify(t.trade_score) !== JSON.stringify(match.trade_score)) {
      flag(findings, 'INFO', `Trade ${t.id} trade_score changed (${t.trade_score} -> ${match.trade_score}) — may be an intentional recompute; verify.`);
    }
  }
  if ((before.trades || []).length > (after.trades || []).length) {
    flag(findings, 'WARN', `Trade count decreased: ${before.trades.length} -> ${after.trades.length}`);
  }

  // --- weekly reviews ---
  const reviewsAfterByWeek = new Map((after.weeklyReviews || []).map((r) => [r.week_start, r]));
  for (const r of before.weeklyReviews || []) {
    if (!reviewsAfterByWeek.has(r.week_start)) flag(findings, 'CRITICAL', `Weekly review for week ${r.week_start} disappeared.`);
  }

  // --- referrals / commissions ---
  const refKey = (r) => `${r.referrer_id}:${r.referred_user_id}`;
  const refsAfter = new Set((after.referralsAsReferrer || []).map(refKey));
  for (const r of before.referralsAsReferrer || []) {
    if (!refsAfter.has(refKey(r))) flag(findings, 'CRITICAL', `Referral attribution lost: referrer=${r.referrer_id} referred=${r.referred_user_id}`);
  }
  const commAfter = new Set((after.commissions || []).map((c) => c.stripe_invoice_id));
  for (const c of before.commissions || []) {
    if (!commAfter.has(c.stripe_invoice_id)) flag(findings, 'CRITICAL', `Referral commission record disappeared: invoice=${c.stripe_invoice_id} amount=${c.amount}`);
  }

  return findings;
}

async function cmdDiff(beforeFile, afterFile) {
  const fs = await import('node:fs');
  const before = JSON.parse(await fs.promises.readFile(beforeFile, 'utf8'));
  const after  = JSON.parse(await fs.promises.readFile(afterFile, 'utf8'));
  let critical = 0, warn = 0, info = 0;
  for (const userId of Object.keys(before.users)) {
    const findings = diffUser(userId, before.users[userId], after.users[userId]);
    if (!findings.length) { console.log(`\n${userId}: OK, no changes to protected fields.`); continue; }
    console.log(`\n${userId}:`);
    for (const f of findings) {
      console.log(`  [${f.level}] ${f.msg}`);
      if (f.level === 'CRITICAL') critical++;
      else if (f.level === 'WARN') warn++;
      else info++;
    }
  }
  console.log(`\n--- summary: ${critical} CRITICAL, ${warn} WARN, ${info} INFO ---`);
  if (critical > 0) {
    console.log('STOP: critical findings mean existing member progress changed. Do not proceed with deployment — restore and investigate per the rollback requirement.');
    process.exitCode = 1;
  }
}

const [, , cmd, ...args] = process.argv;
try {
  if (cmd === 'snapshot') await cmdSnapshot(args[0], args.slice(1));
  else if (cmd === 'diff') await cmdDiff(args[0], args[1]);
  else {
    console.log('Usage:\n  node SCALPCLOCK_PROGRESS_INTEGRITY_CHECK.mjs snapshot <out.json> <userId...>\n  node SCALPCLOCK_PROGRESS_INTEGRITY_CHECK.mjs diff <before.json> <after.json>');
    process.exitCode = 1;
  }
} catch (e) {
  console.error('ERROR:', e.message);
  process.exitCode = 1;
}
