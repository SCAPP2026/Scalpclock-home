// ── ScalpClock Daily Trading System — pure scoring/streak/challenge core ────
// No DOM access, no localStorage access — mirrors js/trade-score.js's design
// exactly (same module runs in the browser or under node require() for
// tests; the host page owns all storage I/O and passes plain data in).
//
// This measures PROCESS, never profitability: a losing trade that followed
// every step scores 10/10, a winning trade that skipped confirmation scores
// low. Never call this a prediction or a signal.
(function (global) {
  'use strict';

  var VERSION = 'v1.0';
  var DAILY_XP_CAP = 100;

  // Fixed per-step XP, per the product spec — summed only for steps actually
  // completed, then capped so no combination of steps can exceed the daily max.
  var STEP_XP = {
    preMarket:      10,
    bias:           10,
    levels:         10,
    openingRange:   10,
    confirmation:   15,
    tradePlan:      15,
    journal:        10,
    dailyReview:    10,
    noTradeBonus:    5,
  };

  function bool(v) { return v === true; }

  // ── 10-point Daily Score — process/discipline only, never profitability ──
  // `steps` shape:
  //   { preMarket, biasSet, levelsMarked, openingRangeRecorded,
  //     confirmVWAP, confirmVolume, noTrade,
  //     tradePlan: { stop, target, maxRisk } | null,
  //     journaled }
  // When `noTrade` is true, the three trade-plan items (stop/target/risk)
  // get full credit automatically — there's no trade to define them for,
  // and the spec explicitly wants a disciplined no-trade day to be able to
  // score 10/10, not be penalized for having nothing to plan.
  function scoreDay(steps) {
    steps = steps || {};
    var noTrade = bool(steps.noTrade);
    var plan = steps.tradePlan || null;

    var items = [
      { key: 'preMarket',    label: 'Pre-market plan',            earned: bool(steps.preMarket) },
      { key: 'structure',    label: 'Identified market structure', earned: !!steps.biasSet },
      { key: 'levels',       label: 'Marked levels',               earned: bool(steps.levelsMarked) },
      { key: 'openingRange', label: 'Waited for opening range',    earned: bool(steps.openingRangeRecorded) },
      { key: 'vwap',         label: 'Confirmed VWAP',              earned: bool(steps.confirmVWAP) },
      { key: 'volume',       label: 'Confirmed volume',            earned: bool(steps.confirmVolume) },
      { key: 'stop',         label: 'Defined stop',                earned: noTrade ? true : !!(plan && plan.stop != null) },
      { key: 'target',       label: 'Defined target',              earned: noTrade ? true : !!(plan && plan.target != null) },
      { key: 'riskRules',    label: 'Followed risk rules',         earned: noTrade ? true : !!(plan && plan.maxRisk != null) },
      { key: 'journal',      label: 'Completed journal',           earned: bool(steps.journaled) },
    ];

    var total = items.reduce(function (n, it) { return n + (it.earned ? 1 : 0); }, 0);
    var grade = total >= 8 ? { label: 'Excellent Discipline' }
              : total >= 6 ? { label: 'Needs Improvement' }
              :              { label: 'Review Before Trading Again' };

    return { version: VERSION, total: total, max: 10, grade: grade, items: items };
  }

  // ── XP for the session, summed only for completed steps, capped at 100 ──
  // `completed` is an array of STEP_XP keys the session actually finished.
  function xpForSteps(completed) {
    completed = completed || [];
    var total = completed.reduce(function (n, key) {
      return n + (STEP_XP[key] || 0);
    }, 0);
    return Math.min(DAILY_XP_CAP, total);
  }

  // ── Streak — completing the Daily System, never tied to placing a trade.
  // Pure date-string comparison, deliberately mirroring learn.html's
  // bumpStreak() exactly so the two streaks behave identically even though
  // they're tracked under separate keys (host page owns the keys/storage).
  //   today, lastDate: 'YYYY-MM-DD' strings
  //   currentCount: number already stored
  // Returns the count to store; `incremented` tells the caller whether this
  // call actually changed anything (so XP/badges aren't double-awarded on
  // a page reload the same day).
  function computeStreak(today, lastDate, currentCount) {
    currentCount = currentCount || 0;
    if (lastDate === today) return { count: currentCount, incremented: false };
    var y = yesterdayOf(today);
    var count = lastDate === y ? currentCount + 1 : 1;
    return { count: count, incremented: true };
  }

  function yesterdayOf(todayStr) {
    var d = new Date(todayStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  // ── Daily challenge — day-of-week prompt, no trading required to engage.
  // `date` is a plain Date (or anything `new Date(date).getDay()` accepts).
  var CHALLENGES = [
    'Markets are closed — review one trade from last week and note what you’d do differently.', // Sun
    'Identify yesterday’s high and low.',                                                        // Mon
    'Determine whether QQQ is above or below VWAP right now.',                                        // Tue
    'Find today’s opening-range high and low.',                                                   // Wed
    'Identify the strongest support level on your primary watchlist symbol.',                          // Thu
    'Review your best trade of the week — what made it work?',                                         // Fri
    'Markets are closed — plan one thing you’ll watch for on Monday.',                             // Sat
  ];
  function dailyChallenge(date) {
    var day = new Date(date).getDay(); // 0=Sun..6=Sat
    return { text: CHALLENGES[day], xp: 10 };
  }

  var api = {
    VERSION: VERSION,
    DAILY_XP_CAP: DAILY_XP_CAP,
    STEP_XP: STEP_XP,
    scoreDay: scoreDay,
    xpForSteps: xpForSteps,
    computeStreak: computeStreak,
    dailyChallenge: dailyChallenge,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.DailySystemScore = api;
  }
})(typeof window !== 'undefined' ? window : this);
