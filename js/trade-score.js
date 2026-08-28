// ── ScalpClock Trade Performance System — pure scoring/analytics core ───────
// No DOM access. Loaded by journal.html and dashboard.html so the exact same
// code computes the Trade Score, Trader Score, tags, and insights everywhere
// they're shown (mirrors the js/orb-engine.js pattern used elsewhere in this
// repo — same module runs in the browser and could run under node require()
// for tests).
//
// Every score/insight here is derived only from fields the member actually
// entered or from raw trade data (price/time/P&L) already stored. Nothing is
// invented: if a required input is missing, the relevant item/insight says so
// plainly instead of guessing. This is a self-coaching tool, not financial
// advice, and it never rewards a trade simply for being profitable.
(function (global) {
  'use strict';

  var VERSION = 'v1.0';

  // ── small utilities ────────────────────────────────────────────────────
  function num(v) { return (v === null || v === undefined || v === '') ? null : Number(v); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round(v) { return Math.round(v * 10) / 10; }
  function isCall(dir) { return (dir || '').toLowerCase() === 'calls'; }
  function isPut(dir) { return (dir || '').toLowerCase() === 'puts'; }

  // Extract ET hour/minute from an ISO timestamp without any timezone library.
  function etParts(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
    });
    var parts = fmt.formatToParts(d).reduce(function (acc, p) { acc[p.type] = p.value; return acc; }, {});
    return { hour: parseInt(parts.hour, 10), minute: parseInt(parts.minute, 10), weekday: parts.weekday };
  }

  function timeBucket(iso) {
    var p = etParts(iso);
    if (!p) return null;
    var mins = p.hour * 60 + p.minute;
    if (mins < 9 * 60 + 30) return 'Pre-Market';
    if (mins < 10 * 60) return 'First 30 Min (9:30–10:00 ET)';
    if (mins < 11 * 60) return '10:00–11:00 ET';
    if (mins < 12 * 60) return '11:00–12:00 ET';
    if (mins < 16 * 60) return 'Afternoon (12:00 ET+)';
    return 'After Hours';
  }

  function dayOfWeek(iso) {
    var p = etParts(iso);
    return p ? p.weekday : null;
  }

  function holdMinutes(trade) {
    if (!trade.opened_at || !trade.closed_at) return null;
    var a = new Date(trade.opened_at).getTime(), b = new Date(trade.closed_at).getTime();
    if (isNaN(a) || isNaN(b) || b < a) return null;
    return Math.round((b - a) / 60000);
  }

  // ── auto tags (Step 7) ─────────────────────────────────────────────────
  // Only objective, derivable-from-explicit-input tags. Emotional tags are
  // mirrored from trade.emotions (which the member picked directly) — never
  // inferred from behavior.
  function autoTags(trade) {
    var tags = [];
    if (trade.symbol) tags.push(trade.symbol.toUpperCase());
    if (isCall(trade.direction)) { tags.push('Calls'); tags.push('Long'); }
    if (isPut(trade.direction)) { tags.push('Puts'); tags.push('Short'); }
    if (trade.source_setup === 'orb') tags.push('ORB');
    if (trade.strategy) tags.push(trade.strategy);
    if (trade.market_trend === 'with') tags.push('With Trend');
    if (trade.market_trend === 'against') tags.push('Against Trend');
    var vwapOk = trade.vwap_position === 'above' ? isCall(trade.direction) : trade.vwap_position === 'below' ? isPut(trade.direction) : false;
    if (vwapOk) tags.push('VWAP Confirmed');
    var tb = timeBucket(trade.opened_at || trade.closed_at);
    if (tb === 'First 30 Min (9:30–10:00 ET)' || tb === '10:00–11:00 ET') tags.push('Morning Trade');
    if (tb === '11:00–12:00 ET' || tb === 'Afternoon (12:00 ET+)') tags.push('Midday Trade');
    (trade.emotions || []).forEach(function (e) { if (tags.indexOf(e) === -1) tags.push(e); });
    (trade.tags || []).forEach(function (t) { if (tags.indexOf(t) === -1) tags.push(t); }); // preserve any manual tags already saved
    return tags;
  }

  // ── ScalpClock Trade Score — Step 2 ────────────────────────────────────
  // Every item is worth a fixed share of its category. Items whose input is
  // genuinely optional (not every trade is ORB-based, not every trade has a
  // logged VWAP read) are "not applicable" and get full credit — they don't
  // penalize a trade for a field that doesn't apply. Items that represent a
  // core discipline habit ScalpClock always asks for (was risk defined, was
  // a stop used, was the exit reason logged, etc.) score 0 with a plain
  // reason when left blank, because leaving them blank IS the signal.
  function scoreTrade(trade) {
    var t = trade || {};
    var dirIsCall = isCall(t.direction);
    var categories = [];

    // -- Setup Quality (25) — 5 items x 5 --------------------------------
    var setupItems = [];
    setupItems.push(scoreItem('Traded with the overall market trend', 5, (function () {
      if (t.market_trend === 'with') return { earned: 5, reason: 'Marked as trading with the trend.' };
      if (t.market_trend === 'neutral') return { earned: 3, reason: 'Marked as a neutral/no-clear-trend setup.' };
      if (t.market_trend === 'against') return { earned: 0, reason: 'Marked as trading against the prevailing trend.' };
      return { earned: 5, reason: 'Market trend not recorded for this trade — full credit given, not held against you.' };
    })()));
    setupItems.push(scoreItem('Setup quality grade', 5, (function () {
      if (t.setup_grade === 'A') return { earned: 5, reason: 'Self-graded an A-quality setup.' };
      if (t.setup_grade === 'B') return { earned: 3.3, reason: 'Self-graded a B-quality setup.' };
      if (t.setup_grade === 'C') return { earned: 1.7, reason: 'Self-graded a C-quality setup.' };
      return { earned: 5, reason: 'No setup grade recorded — full credit given, not held against you.' };
    })()));
    setupItems.push(scoreItem('Traded on the correct side of VWAP', 5, (function () {
      if (t.vwap_position !== 'above' && t.vwap_position !== 'below') return { earned: 5, reason: 'VWAP position not recorded — full credit given, not held against you.' };
      var ok = t.vwap_position === 'above' ? dirIsCall : !dirIsCall;
      return ok
        ? { earned: 5, reason: 'Traded on the side of VWAP that matched the trade direction.' }
        : { earned: 0, reason: 'Traded on the wrong side of VWAP for the direction taken.' };
    })()));
    setupItems.push(scoreItem('Aligned with ORB direction', 5, (function () {
      if (t.source_setup !== 'orb' || !t.orb_direction) return { earned: 5, reason: 'Not an ORB-based trade — this check doesn’t apply, full credit given.' };
      var match = t.orb_direction === 'bull' ? dirIsCall : !dirIsCall;
      return match
        ? { earned: 5, reason: 'Direction matched the ORB Signal Engine’s read.' }
        : { earned: 0, reason: 'Direction taken didn’t match the ORB Signal Engine’s read at the time.' };
    })()));
    setupItems.push(scoreItem('Entry confirmation present', 5, (function () {
      if (t.entry_confirmation === true) return { earned: 5, reason: 'Entry confirmation was noted before entering.' };
      if (t.entry_confirmation === false) return { earned: 0, reason: 'No entry confirmation noted before entering.' };
      return { earned: 5, reason: 'Entry confirmation not recorded — full credit given, not held against you.' };
    })()));
    categories.push({ key: 'setup', label: 'Setup Quality', cap: 25, earned: sumItems(setupItems, 25), items: setupItems });

    // -- Risk Management (25) — 4 items x 6.25 ---------------------------
    var riskItems = [];
    var hasPlannedRisk = num(t.planned_risk) !== null;
    var hasPlannedStop = num(t.planned_stop) !== null;
    riskItems.push(scoreItem('Defined risk before entry', 6.25, (hasPlannedRisk || hasPlannedStop)
      ? { earned: 6.25, reason: 'Risk was defined before entering (planned $ risk and/or stop).' }
      : { earned: 0, reason: 'No planned risk or stop-loss was recorded before entering.' }));
    riskItems.push(scoreItem('Stop-loss used', 6.25, hasPlannedStop
      ? { earned: 6.25, reason: 'A stop-loss level was planned.' }
      : { earned: 0, reason: 'No stop-loss level was recorded.' }));
    riskItems.push(scoreItem('Planned risk amount is internally consistent', 6.25, (function () {
      if (!hasPlannedRisk || !hasPlannedStop || num(t.entry_price) === null) return { earned: 6.25, reason: 'Not enough data to cross-check planned $ risk — full credit given, not held against you.' };
      var implied = Math.abs(num(t.entry_price) - num(t.planned_stop)) * (num(t.contracts) || 1) * 100;
      if (implied <= 0) return { earned: 6.25, reason: 'Not enough data to cross-check planned $ risk — full credit given, not held against you.' };
      var diffPct = Math.abs(num(t.planned_risk) - implied) / implied;
      return diffPct <= 0.3
        ? { earned: 6.25, reason: 'Planned $ risk lines up with your entry/stop distance.' }
        : { earned: 2.5, reason: 'Planned $ risk ($' + round(num(t.planned_risk)) + ') doesn’t match what your entry/stop distance implies (~$' + round(implied) + ') — double-check your numbers next time.' };
    })()));
    riskItems.push(scoreItem('Actual loss stayed within planned risk', 6.25, (function () {
      var pnl = num(t.pnl);
      if (pnl === null || pnl >= 0 || !hasPlannedRisk) return { earned: 6.25, reason: pnl !== null && pnl >= 0 ? 'Trade was profitable — nothing to check here.' : 'Not enough data to check — full credit given, not held against you.' };
      var loss = Math.abs(pnl);
      return loss <= num(t.planned_risk) * 1.15
        ? { earned: 6.25, reason: 'Loss stayed within your planned risk.' }
        : { earned: 0, reason: 'Actual loss ($' + round(loss) + ') exceeded your planned risk ($' + round(num(t.planned_risk)) + ').' };
    })()));
    categories.push({ key: 'risk', label: 'Risk Management', cap: 25, earned: sumItems(riskItems, 25), items: riskItems });

    // -- Entry Discipline (15) — 3 items x 5 ------------------------------
    var entryItems = [];
    entryItems.push(scoreItem('Followed a documented strategy', 5, t.strategy
      ? { earned: 5, reason: 'Trade was tagged with a specific strategy (' + t.strategy + ').' }
      : { earned: 0, reason: 'No strategy was selected for this trade.' }));
    entryItems.push(scoreItem('Entry near the planned entry price', 5, (function () {
      var planned = num(t.planned_entry), actual = num(t.entry_price);
      if (planned === null || actual === null || planned === 0) return { earned: 5, reason: 'No planned entry price recorded — full credit given, not held against you.' };
      var diffPct = Math.abs(actual - planned) / planned * 100;
      if (diffPct <= 1) return { earned: 5, reason: 'Entered within 1% of the planned entry price.' };
      if (diffPct <= 3) return { earned: 3, reason: 'Entered ' + round(diffPct) + '% away from the planned entry price.' };
      return { earned: 0, reason: 'Entered ' + round(diffPct) + '% away from the planned entry price — a possible chase.' };
    })()));
    var negEntryEmotions = ['FOMO', 'Impulsive'];
    var hasNegEntryEmotion = (t.emotions || []).some(function (e) { return negEntryEmotions.indexOf(e) !== -1; });
    entryItems.push(scoreItem('No FOMO / impulsive entry tagged', 5, hasNegEntryEmotion
      ? { earned: 0, reason: 'FOMO or Impulsive was tagged as part of this trade’s emotional state.' }
      : { earned: 5, reason: 'No FOMO or impulsive-entry tag on this trade.' }));
    categories.push({ key: 'entry', label: 'Entry Discipline', cap: 15, earned: sumItems(entryItems, 15), items: entryItems });

    // -- Exit Discipline (15) — 3 items x 5 -------------------------------
    var exitItems = [];
    exitItems.push(scoreItem('Followed the planned target/exit', 5, (function () {
      var target = num(t.planned_target), entry = num(t.entry_price), exit = num(t.exit_price);
      if (target === null || entry === null || exit === null || target === entry) return { earned: 5, reason: 'No planned target recorded — full credit given, not held against you.' };
      var progress = dirIsCall ? (exit - entry) / (target - entry) : (entry - exit) / (entry - target);
      if (progress >= 0.9) return { earned: 5, reason: 'Reached (or exceeded) the planned target.' };
      if (progress >= 0.4) return { earned: 3, reason: 'Exited before reaching the full planned target — possibly cut the winner early.' };
      return { earned: 1, reason: 'Exited well short of the planned target.' };
    })()));
    exitItems.push(scoreItem('Loss stayed within the planned stop distance', 5, (function () {
      var pnl = num(t.pnl);
      if (!hasPlannedStop) return { earned: 5, reason: 'No planned stop recorded — full credit given, not held against you.' };
      if (pnl === null || pnl >= 0) return { earned: 5, reason: 'Trade was profitable — the stop was never needed.' };
      var entry = num(t.entry_price), stop = num(t.planned_stop);
      if (entry === null) return { earned: 5, reason: 'Not enough data to check — full credit given, not held against you.' };
      var plannedLossPct = Math.abs(entry - stop) / entry;
      var actualLossPct = Math.abs(num(t.pnl_pct) || 0) / 100;
      if (!actualLossPct) return { earned: 5, reason: 'Not enough data to check — full credit given, not held against you.' };
      return actualLossPct <= plannedLossPct * 1.15
        ? { earned: 5, reason: 'Loss stayed within the planned stop distance.' }
        : { earned: 0, reason: 'Price moved further against the position than the planned stop distance before exiting.' };
    })()));
    exitItems.push(scoreItem('Exit reason recorded', 5, t.exit_reason
      ? { earned: 5, reason: 'An exit reason was logged.' }
      : { earned: 0, reason: 'No exit reason was recorded for this trade.' }));
    categories.push({ key: 'exit', label: 'Exit Discipline', cap: 15, earned: sumItems(exitItems, 15), items: exitItems });

    // -- Risk/Reward (10) — single metric ---------------------------------
    var rr = plannedRR(t);
    var rrItem;
    if (rr === null) {
      rrItem = scoreItem('Planned risk/reward', 10, { earned: 3, reason: 'No planned stop and target on file — can’t verify your planned risk/reward. Log both next time to earn full credit here.' });
    } else if (rr >= 2) rrItem = scoreItem('Planned risk/reward', 10, { earned: 10, reason: 'Planned reward was at least 2x the planned risk (' + round(rr) + 'R).' });
    else if (rr >= 1.5) rrItem = scoreItem('Planned risk/reward', 10, { earned: 8, reason: 'Planned reward was ' + round(rr) + 'x the planned risk.' });
    else if (rr >= 1) rrItem = scoreItem('Planned risk/reward', 10, { earned: 5, reason: 'Planned reward roughly matched planned risk (' + round(rr) + 'R).' });
    else rrItem = scoreItem('Planned risk/reward', 10, { earned: 2, reason: 'Planned reward was less than the planned risk (' + round(rr) + 'R).' });
    categories.push({ key: 'rr', label: 'Risk/Reward', cap: 10, earned: rrItem.earned, items: [rrItem] });

    // -- Emotional Discipline (10) -----------------------------------------
    var emotions = t.emotions || [];
    var NEG = { 'FOMO': 1, 'Revenge Trade': 1, 'Greedy': 1, 'Impulsive': 1 };
    var negCount = emotions.filter(function (e) { return NEG[e]; }).length;
    var hesitant = emotions.indexOf('Hesitant') !== -1;
    var emoEarned, emoReason;
    if (!emotions.length) { emoEarned = 5; emoReason = 'No emotional state logged for this trade.'; }
    else if (negCount >= 2) { emoEarned = 0; emoReason = 'Multiple negative emotional tags on this trade (' + emotions.filter(function (e) { return NEG[e]; }).join(', ') + ').'; }
    else if (negCount === 1) { emoEarned = 4; emoReason = 'One negative emotional tag on this trade.'; }
    else if (hesitant) { emoEarned = 7; emoReason = 'Traded while feeling hesitant.'; }
    else { emoEarned = 10; emoReason = 'Positive/neutral emotional state logged (' + emotions.join(', ') + ').'; }
    categories.push({ key: 'emotion', label: 'Emotional Discipline', cap: 10, earned: emoEarned, items: [scoreItem('Emotional state', 10, { earned: emoEarned, reason: emoReason })] });

    var total = clamp(Math.round(categories.reduce(function (s, c) { return s + c.earned; }, 0)), 0, 100);
    return { version: VERSION, total: total, grade: gradeFor(total), categories: categories };
  }

  // Keep item/category earned values at full precision internally — only the
  // final trade total is rounded (below). Rounding each item first and then
  // summing can drift a category slightly above its own cap (e.g. four
  // 6.25-point items each rounding up to 6.3 would sum to 25.2/25).
  function scoreItem(label, cap, res) { return { label: label, cap: cap, earned: res.earned, reason: res.reason }; }
  function sumItems(items) { return items.reduce(function (s, i) { return s + i.earned; }, 0); }

  function plannedRR(t) {
    var entry = num(t.planned_entry) !== null ? num(t.planned_entry) : num(t.entry_price);
    var stop = num(t.planned_stop), target = num(t.planned_target);
    if (entry === null || stop === null || target === null) return null;
    var risk = Math.abs(entry - stop), reward = Math.abs(target - entry);
    if (risk <= 0) return null;
    return reward / risk;
  }

  function gradeFor(total) {
    if (total >= 90) return { letter: 'A+', label: 'Excellent' };
    if (total >= 80) return { letter: 'A', label: 'Strong' };
    if (total >= 70) return { letter: 'B', label: 'Good' };
    if (total >= 60) return { letter: 'C', label: 'Needs Improvement' };
    return { letter: 'D', label: 'Poor Discipline' };
  }

  // ── ScalpClock Trader Score — Step 3 ───────────────────────────────────
  // Rolling average of each trade's own Trade Score over the last 30 days
  // (or the last 50 closed trades if there aren't enough in 30 days), with a
  // small consistency adjustment and an overtrading penalty. Averaging over
  // many trades is itself what keeps a single trade from swinging the score.
  var TRADER_SCORE_MIN_TRADES = 5;
  var TRADER_SCORE_WINDOW = 50;

  function recentWindow(closedScoredTrades) {
    var sorted = closedScoredTrades.slice().sort(function (a, b) { return new Date(b.closed_at) - new Date(a.closed_at); });
    var cutoff = Date.now() - 30 * 86400000;
    var byDate = sorted.filter(function (t) { return new Date(t.closed_at).getTime() >= cutoff; });
    return byDate.length >= TRADER_SCORE_MIN_TRADES ? byDate : sorted.slice(0, TRADER_SCORE_WINDOW);
  }

  function stdev(nums) {
    if (nums.length < 2) return 0;
    var mean = nums.reduce(function (a, b) { return a + b; }, 0) / nums.length;
    var variance = nums.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0) / nums.length;
    return Math.sqrt(variance);
  }

  function traderScoreFromWindow(window) {
    if (!window.length) return null;
    var scores = window.map(function (t) { return t.trade_score; }).filter(function (s) { return s !== null && s !== undefined; });
    if (!scores.length) return null;
    var base = scores.reduce(function (a, b) { return a + b; }, 0) / scores.length;
    var sd = stdev(scores);
    var adj = sd < 15 ? 3 : sd > 30 ? -3 : 0;
    return clamp(Math.round(base + adj), 0, 100);
  }

  function traderLevel(score) {
    if (score >= 90) return 'Elite Discipline';
    if (score >= 80) return 'Disciplined Trader';
    if (score >= 70) return 'Developing Trader';
    if (score >= 60) return 'Building Consistency';
    return 'Early Stage';
  }

  function computeTraderScore(closedTrades) {
    var scored = (closedTrades || []).filter(function (t) { return t.trade_score !== null && t.trade_score !== undefined && t.closed_at; });
    if (scored.length < TRADER_SCORE_MIN_TRADES) {
      return { available: false, sampleSize: scored.length, minRequired: TRADER_SCORE_MIN_TRADES };
    }
    var sorted = scored.slice().sort(function (a, b) { return new Date(b.closed_at) - new Date(a.closed_at); });
    var window = recentWindow(sorted);
    var current = traderScoreFromWindow(window);
    var priorPool = sorted.slice(window.length, window.length + window.length);
    var prior = priorPool.length >= 3 ? traderScoreFromWindow(priorPool) : null;

    var now = Date.now();
    var last7 = sorted.filter(function (t) { return now - new Date(t.closed_at).getTime() <= 7 * 86400000; });
    var last30 = sorted.filter(function (t) { return now - new Date(t.closed_at).getTime() <= 30 * 86400000; });
    var prev30 = sorted.filter(function (t) {
      var age = now - new Date(t.closed_at).getTime();
      return age > 30 * 86400000 && age <= 60 * 86400000;
    });

    var trend = 'Stable';
    if (prior !== null) {
      if (current - prior >= 3) trend = 'Improving';
      else if (current - prior <= -3) trend = 'Declining';
    }

    return {
      available: true,
      score: current,
      level: traderLevel(current),
      trend: trend,
      sampleSize: window.length,
      windowDays: window === sorted.filter(function (t) { return now - new Date(t.closed_at).getTime() <= 30 * 86400000; }) ? 30 : null,
      thisWeekAvg: last7.length ? round(last7.reduce(function (s, t) { return s + t.trade_score; }, 0) / last7.length) : null,
      last30Avg: last30.length ? round(last30.reduce(function (s, t) { return s + t.trade_score; }, 0) / last30.length) : null,
      prev30Avg: prev30.length ? round(prev30.reduce(function (s, t) { return s + t.trade_score; }, 0) / prev30.length) : null,
    };
  }

  // ── group-by analytics helper (Step 6 + Step 10) ───────────────────────
  function groupStats(trades, keyFn) {
    var groups = {};
    trades.forEach(function (t) {
      var key = keyFn(t);
      if (key === null || key === undefined) return;
      if (!groups[key]) groups[key] = { key: key, trades: [] };
      groups[key].trades.push(t);
    });
    return Object.keys(groups).map(function (k) {
      var g = groups[k], n = g.trades.length;
      var wins = g.trades.filter(function (t) { return (t.pnl || 0) > 0; }).length;
      var totalPnl = g.trades.reduce(function (s, t) { return s + (t.pnl || 0); }, 0);
      var rValues = g.trades.map(tradeR).filter(function (r) { return r !== null; });
      var avgR = rValues.length ? rValues.reduce(function (a, b) { return a + b; }, 0) / rValues.length : null;
      var holds = g.trades.map(holdMinutes).filter(function (h) { return h !== null; });
      var avgHold = holds.length ? Math.round(holds.reduce(function (a, b) { return a + b; }, 0) / holds.length) : null;
      return { key: k, count: n, winRate: round(wins / n * 100), totalPnl: round(totalPnl), avgPnl: round(totalPnl / n), avgR: avgR !== null ? round(avgR) : null, avgHoldMinutes: avgHold };
    });
  }

  // realized R multiple: actual $ P&L divided by the planned $ risk, when known.
  function tradeR(t) {
    var pnl = num(t.pnl), risk = num(t.planned_risk);
    if (pnl === null || !risk) return null;
    return pnl / risk;
  }

  // ── My Best Edge — Step 6 ───────────────────────────────────────────────
  var EDGE_MIN_BASIC = 10, EDGE_MIN_STRONG = 20;
  function bestEdge(closedTrades) {
    var n = closedTrades.length;
    if (n < EDGE_MIN_BASIC) return { available: false, sampleSize: n, minRequired: EDGE_MIN_BASIC };

    function topOf(groups) {
      var eligible = groups.filter(function (g) { return g.count >= 3; });
      if (!eligible.length) return null;
      eligible.sort(function (a, b) { return b.winRate - a.winRate || b.count - a.count; });
      return eligible[0];
    }

    var byTicker = topOf(groupStats(closedTrades, function (t) { return t.symbol || null; }));
    var byTime = topOf(groupStats(closedTrades, function (t) { return timeBucket(t.opened_at || t.closed_at); }));
    var bySetup = topOf(groupStats(closedTrades, function (t) { return t.strategy || null; }));
    var byDay = topOf(groupStats(closedTrades, function (t) { return dayOfWeek(t.opened_at || t.closed_at); }));
    var byDirection = topOf(groupStats(closedTrades, function (t) { return isCall(t.direction) ? 'Calls / Long' : isPut(t.direction) ? 'Puts / Short' : null; }));

    var candidates = [byTicker && { dim: 'Ticker', v: byTicker }, byTime && { dim: 'Time of Day', v: byTime }, bySetup && { dim: 'Setup', v: bySetup }, byDay && { dim: 'Day of Week', v: byDay }, byDirection && { dim: 'Direction', v: byDirection }].filter(Boolean);
    candidates.sort(function (a, b) { return b.v.winRate - a.v.winRate; });

    return {
      available: true,
      strong: n >= EDGE_MIN_STRONG,
      sampleSize: n,
      top: candidates[0] || null,
      byTicker: byTicker, byTime: byTime, bySetup: bySetup, byDay: byDay, byDirection: byDirection,
    };
  }

  // ── What You're Doing Right / What To Improve — Steps 4 & 5 ────────────
  var INSIGHT_MIN_TRADES = 10;
  function insights(closedTrades) {
    var n = closedTrades.length;
    if (n < INSIGHT_MIN_TRADES) {
      return { available: false, sampleSize: n, minRequired: INSIGHT_MIN_TRADES, doingRight: [], improve: [] };
    }
    var doingRight = [], improve = [];

    // With-trend vs against-trend win rate
    var withTrend = closedTrades.filter(function (t) { return t.market_trend === 'with'; });
    var againstTrend = closedTrades.filter(function (t) { return t.market_trend === 'against'; });
    if (withTrend.length >= 5 && againstTrend.length >= 3) {
      var wtWin = withTrend.filter(function (t) { return (t.pnl || 0) > 0; }).length / withTrend.length * 100;
      var atWin = againstTrend.filter(function (t) { return (t.pnl || 0) > 0; }).length / againstTrend.length * 100;
      if (wtWin - atWin >= 10) doingRight.push({ text: 'You perform best when trading with the trend.', data: 'With-trend win rate ' + round(wtWin) + '% vs. against-trend ' + round(atWin) + '% (' + withTrend.length + ' vs. ' + againstTrend.length + ' trades).' });
      else if (atWin - wtWin >= 10) improve.push({ issue: 'Trades against the market trend have a lower win rate.', data: 'Against-trend win rate ' + round(atWin) + '% vs. with-trend ' + round(wtWin) + '% (' + againstTrend.length + ' vs. ' + withTrend.length + ' trades).', suggestion: 'Before entering, note whether the setup goes with or against the broader trend — and weigh against-trend setups more carefully.', link: { href: '/learn-options-trading/technical-analysis/how-to-identify-trend-reversals', label: 'Review: Identifying Trend Reversals' } });
    }

    // Best time-of-day quality bucket
    var byTime = groupStats(closedTrades, function (t) { return timeBucket(t.opened_at || t.closed_at); }).filter(function (g) { return g.count >= 5; });
    if (byTime.length) {
      byTime.sort(function (a, b) { return b.winRate - a.winRate; });
      var bestT = byTime[0];
      if (bestT.winRate >= 55) doingRight.push({ text: 'Your highest-quality trades happen during ' + bestT.key + '.', data: bestT.winRate + '% win rate across ' + bestT.count + ' trades in that window.' });
      byTime.sort(function (a, b) { return a.winRate - b.winRate; });
      var worstT = byTime[0];
      if (worstT.key !== bestT.key && worstT.winRate <= 40 && worstT.count >= 5) improve.push({ issue: 'Lower win rate during ' + worstT.key + '.', data: worstT.winRate + '% win rate across ' + worstT.count + ' trades in that window.', suggestion: 'Consider being more selective (or sitting out) during this window.', link: null });
    }

    // Best setup
    var bySetup = groupStats(closedTrades, function (t) { return t.strategy || null; }).filter(function (g) { return g.count >= 5; });
    if (bySetup.length) {
      bySetup.sort(function (a, b) { return b.winRate - a.winRate; });
      var bestS = bySetup[0];
      if (bestS.winRate >= 55) doingRight.push({ text: 'Your best-performing setup is ' + bestS.key + '.', data: bestS.winRate + '% win rate across ' + bestS.count + ' trades.' });
    }

    // VWAP confirmation
    var vwapConfirmed = closedTrades.filter(function (t) { return t.vwap_position === 'above' ? isCall(t.direction) : t.vwap_position === 'below' ? isPut(t.direction) : false; });
    var vwapNot = closedTrades.filter(function (t) { return (t.vwap_position === 'above' || t.vwap_position === 'below') && vwapConfirmed.indexOf(t) === -1; });
    if (vwapConfirmed.length >= 5 && vwapNot.length >= 3) {
      var vcWin = vwapConfirmed.filter(function (t) { return (t.pnl || 0) > 0; }).length / vwapConfirmed.length * 100;
      var vnWin = vwapNot.filter(function (t) { return (t.pnl || 0) > 0; }).length / vwapNot.length * 100;
      if (vcWin - vnWin >= 10) doingRight.push({ text: 'You are more profitable when you wait for VWAP confirmation.', data: 'VWAP-confirmed win rate ' + round(vcWin) + '% vs. ' + round(vnWin) + '% without.' });
    }

    // Risk-management trend: current 30 avg trade_score for the risk category vs previous 30
    var scored = closedTrades.filter(function (t) { return t.trade_score_breakdown && t.trade_score_breakdown.categories; });
    if (scored.length >= 20) {
      var sorted = scored.slice().sort(function (a, b) { return new Date(a.closed_at) - new Date(b.closed_at); });
      var recent30 = sorted.slice(-30), prior30 = sorted.slice(-60, -30);
      if (prior30.length >= 10) {
        var riskCat = function (arr) { var vals = arr.map(function (t) { var c = t.trade_score_breakdown.categories.filter(function (c) { return c.key === 'risk'; })[0]; return c ? c.earned : null; }).filter(function (v) { return v !== null; }); return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : null; };
        var r30 = riskCat(recent30), p30 = riskCat(prior30);
        if (r30 !== null && p30 !== null && p30 > 0) {
          var pctChange = (r30 - p30) / p30 * 100;
          if (pctChange >= 10) doingRight.push({ text: 'You have improved your risk management by ' + round(pctChange) + '% compared with your previous 30 trades.', data: 'Risk Management score averaged ' + round(r30) + '/25 recently vs. ' + round(p30) + '/25 before.' });
        }
      }
    }

    // Average win vs average loss
    var wins = closedTrades.filter(function (t) { return (t.pnl || 0) > 0; });
    var losses = closedTrades.filter(function (t) { return (t.pnl || 0) < 0; });
    if (wins.length >= 5 && losses.length >= 5) {
      var avgWin = wins.reduce(function (s, t) { return s + t.pnl; }, 0) / wins.length;
      var avgLoss = Math.abs(losses.reduce(function (s, t) { return s + t.pnl; }, 0) / losses.length);
      if (avgLoss > avgWin) improve.push({ issue: 'Average loss exceeds average win.', data: 'Average winner: $' + round(avgWin) + '. Average loser: -$' + round(avgLoss) + '.', suggestion: 'Review your stop-loss and profit-taking strategy so a typical loss doesn’t outweigh a typical win.', link: { href: '/scalpchart?tab=replay', label: 'Practice in Replay' } });
    }

    // Trade frequency after 11am
    var afternoon = closedTrades.filter(function (t) { var b = timeBucket(t.opened_at || t.closed_at); return b === '11:00–12:00 ET' || b === 'Afternoon (12:00 ET+)'; });
    if (n >= 15 && afternoon.length / n >= 0.5) improve.push({ issue: 'You are taking a large share of your trades after 11:00 AM.', data: round(afternoon.length / n * 100) + '% of your logged trades (' + afternoon.length + ' of ' + n + ') opened after 11:00 AM ET.', suggestion: 'If your data above shows morning trades performing better, consider weighting your trading toward the morning session.', link: null });

    // FOMO frequency in the most recent 20
    var recent20 = closedTrades.slice().sort(function (a, b) { return new Date(b.closed_at) - new Date(a.closed_at); }).slice(0, 20);
    var fomoCount = recent20.filter(function (t) { return (t.emotions || []).indexOf('FOMO') !== -1; }).length;
    if (fomoCount >= 3) improve.push({ issue: 'FOMO was tagged on several of your recent trades.', data: 'FOMO was tagged on ' + fomoCount + ' of your last ' + recent20.length + ' trades.', suggestion: 'Before entering, re-check the pre-trade checklist — specifically whether the reason for entry existed before you saw the move.', link: { href: '/learn-options-trading/psychology', label: 'Review: Trading Psychology guides' } });

    // Increased frequency after a loss (same-day, next trade opened quickly after a loss closes)
    var afterLossFast = 0, afterLossTotal = 0;
    var byDate = closedTrades.slice().sort(function (a, b) { return new Date(a.closed_at) - new Date(b.closed_at); });
    for (var i = 1; i < byDate.length; i++) {
      var prev = byDate[i - 1], cur = byDate[i];
      if ((prev.pnl || 0) >= 0 || !prev.closed_at || !cur.opened_at) continue;
      afterLossTotal++;
      var gapMin = (new Date(cur.opened_at).getTime() - new Date(prev.closed_at).getTime()) / 60000;
      if (gapMin >= 0 && gapMin < 5) afterLossFast++;
    }
    if (afterLossTotal >= 5 && afterLossFast / afterLossTotal >= 0.4) improve.push({ issue: 'Your trade frequency increases quickly after a losing trade.', data: afterLossFast + ' of your last ' + afterLossTotal + ' post-loss trades were opened within 5 minutes of the prior loss closing.', suggestion: 'Consider a short mandatory pause after a loss before entering the next trade.', link: { href: '/learn-options-trading/psychology/controlling-emotions-while-trading', label: 'Review: Controlling Emotions While Trading' } });

    return { available: true, sampleSize: n, doingRight: doingRight, improve: improve };
  }

  // ── Overtrading detection — Step 11 ─────────────────────────────────────
  function overtrading(allTrades, opts) {
    opts = opts || {};
    var dailyLimit = opts.dailyLimit || null;
    var byDay = {};
    allTrades.forEach(function (t) {
      var iso = t.opened_at || t.created_at;
      if (!iso) return;
      var p = etParts(iso);
      if (!p) return;
      var d = new Date(iso);
      var key = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
      byDay[key] = (byDay[key] || 0) + 1;
    });
    var days = Object.keys(byDay).sort();
    var todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    var todayCount = byDay[todayKey] || 0;
    var priorDays = days.filter(function (d) { return d !== todayKey; }).slice(-30);
    var avg = priorDays.length >= 5 ? priorDays.reduce(function (s, d) { return s + byDay[d]; }, 0) / priorDays.length : null;

    var flagged = false, message = null;
    if (avg !== null && todayCount >= avg * 2 && todayCount >= 3) {
      flagged = true;
      message = 'Your trade frequency today is significantly above your recent average.';
    }
    return {
      todayCount: todayCount,
      avgDaily: avg !== null ? round(avg) : null,
      flagged: flagged,
      message: message,
      dailyLimit: dailyLimit,
      limitReached: dailyLimit ? todayCount >= dailyLimit : false,
    };
  }

  var api = {
    VERSION: VERSION,
    timeBucket: timeBucket,
    dayOfWeek: dayOfWeek,
    holdMinutes: holdMinutes,
    autoTags: autoTags,
    scoreTrade: scoreTrade,
    gradeFor: gradeFor,
    computeTraderScore: computeTraderScore,
    traderLevel: traderLevel,
    groupStats: groupStats,
    tradeR: tradeR,
    bestEdge: bestEdge,
    insights: insights,
    overtrading: overtrading,
    plannedRR: plannedRR,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.TradeScoreEngine = api;
  }
})(typeof window !== 'undefined' ? window : this);
