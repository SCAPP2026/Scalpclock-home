// ── ORB Signal Engine — pure decision core ──────────────────────────────────
// No DOM access. Same module runs in the browser (orbsignalengine.html) and
// in tests/orb-engine.test.js via require(), so the tests exercise the exact
// code that ships, not a re-implemented stand-in (see js/qrcode-generator.js
// for the module.exports pattern this mirrors).
//
// Every threshold below is a STRATEGY RULE this engine enforces, not a
// statistically-validated fact — ScalpClock has not backtested these exact
// numbers against its own trade history yet. Copy anywhere in the UI/docs
// describing these must say "strategy rule", never "historically".
(function (global) {
  'use strict';

  var ORB_STRATEGY_VERSION = 'v1.0';

  var CONFIG = {
    BODY_STRENGTH_MIN: 0.35,        // breakout candle body must be >= 35% of its high-low range
    RETEST_TOLERANCE_PCT: 0.0012,   // retest zone = level +/- 0.12% of level
    NO_BREAKOUT_CUTOFF_CANDLES: 8,  // candles after OR is set with no breakout -> NO_TRADE
    EXTENDED_NO_RETEST_CANDLES: 3,  // candles past a confirmed breakout with no retest touch -> that direction's attempt fails
    OR_RANGE_MIN_PCT: 0.0015,       // 0.15% of price — below this, the range is excluded as too tight
    OR_RANGE_MAX_PCT: 0.012,        // 1.2% of price — above this, the range is excluded as too wide
  };

  var STATES = {
    WAITING_FOR_RANGE: 'WAITING_FOR_RANGE',
    RANGE_FORMING: 'RANGE_FORMING',
    RANGE_COMPLETE: 'RANGE_COMPLETE',
    BREAKOUT_PENDING: 'BREAKOUT_PENDING',
    RETEST_PENDING: 'RETEST_PENDING',
    RETEST_TESTING: 'RETEST_TESTING',
    RETEST_CONFIRMED: 'RETEST_CONFIRMED',
    ENTRY_TRIGGERED: 'ENTRY_TRIGGERED',
    TARGET_HIT: 'TARGET_HIT',
    STOP_HIT: 'STOP_HIT',
    FAILED_BREAKOUT: 'FAILED_BREAKOUT',
    NO_TRADE: 'NO_TRADE',
    SESSION_COMPLETE: 'SESSION_COMPLETE',
  };

  var NO_TRADE_REASONS = {
    OR_TOO_NARROW: 'OR_TOO_NARROW',
    OR_TOO_WIDE: 'OR_TOO_WIDE',
    NO_BREAKOUT: 'NO_BREAKOUT',
    BREAKOUT_FAILED_BOTH_DIRECTIONS: 'BREAKOUT_FAILED_BOTH_DIRECTIONS',
    SESSION_ENDED: 'SESSION_ENDED',
  };

  // States that are one-tick announcements — the NEXT call to advanceState
  // normalizes them forward before doing anything else that candle. This
  // keeps each of the 12 states genuinely distinct and displayable without
  // needing two separate ticks for things that happen on the same candle
  // (e.g. a retest-hold candle IS the entry candle — its close is the entry
  // price — so RETEST_CONFIRMED and ENTRY_TRIGGERED are emitted together;
  // TRANSIENT_ADVANCE only governs what the *next* candle starts from).
  var TRANSIENT_ADVANCE = {
    RANGE_COMPLETE: STATES.BREAKOUT_PENDING,
    FAILED_BREAKOUT: STATES.BREAKOUT_PENDING,
    TARGET_HIT: STATES.SESSION_COMPLETE,
    STOP_HIT: STATES.SESSION_COMPLETE,
  };

  function computeOpeningRange(allCandles, orPeriod) {
    var seg = allCandles.slice(0, orPeriod);
    if (!seg.length) return null;
    var orHigh = seg[0].high, orLow = seg[0].low;
    for (var i = 1; i < seg.length; i++) {
      if (seg[i].high > orHigh) orHigh = seg[i].high;
      if (seg[i].low < orLow) orLow = seg[i].low;
    }
    var rangeAbs = orHigh - orLow;
    var rangePct = orLow > 0 ? rangeAbs / orLow : 0;
    return { orHigh: orHigh, orLow: orLow, rangeAbs: rangeAbs, rangePct: rangePct };
  }

  function classifyOpeningRangeQuality(rangePct, config) {
    config = config || CONFIG;
    if (rangePct < config.OR_RANGE_MIN_PCT) return 'TOO_NARROW';
    if (rangePct > config.OR_RANGE_MAX_PCT) return 'TOO_WIDE';
    return 'OK';
  }

  // A breakout CONFIRMS only on a close beyond the level with a strong body —
  // a wick-only poke through the level never confirms on its own.
  function classifyBreakoutCandle(candle, orHigh, orLow, dir, config) {
    config = config || CONFIG;
    var bodyRatio = Math.abs(candle.close - candle.open) / Math.max(candle.high - candle.low, 0.0001);
    if (dir === 'long') {
      if (candle.close <= orHigh) return { confirmed: false, poked: candle.high > orHigh, bodyRatio: bodyRatio };
      var strongLong = candle.close > candle.open && bodyRatio >= config.BODY_STRENGTH_MIN;
      return { confirmed: strongLong, poked: true, bodyRatio: bodyRatio };
    } else {
      if (candle.close >= orLow) return { confirmed: false, poked: candle.low < orLow, bodyRatio: bodyRatio };
      var strongShort = candle.close < candle.open && bodyRatio >= config.BODY_STRENGTH_MIN;
      return { confirmed: strongShort, poked: true, bodyRatio: bodyRatio };
    }
  }

  // Has this candle tested `level` (within tolerance), and if so, held
  // (continuation), failed (reclaimed past the invalidation level), or is it
  // still undecided (touched but closed between the two)?
  function evaluateRetest(candle, level, dir, invalidationLevel, tolerancePct) {
    tolerancePct = tolerancePct != null ? tolerancePct : CONFIG.RETEST_TOLERANCE_PCT;
    var tol = level * tolerancePct;
    if (dir === 'long') {
      var touchedLong = candle.low <= level + tol;
      if (!touchedLong) return { outcome: 'NONE' };
      if (candle.close > level) return { outcome: 'CONFIRMED' };
      if (candle.close < invalidationLevel) return { outcome: 'FAILED' };
      return { outcome: 'TESTING' };
    } else {
      var touchedShort = candle.high >= level - tol;
      if (!touchedShort) return { outcome: 'NONE' };
      if (candle.close < level) return { outcome: 'CONFIRMED' };
      if (candle.close > invalidationLevel) return { outcome: 'FAILED' };
      return { outcome: 'TESTING' };
    }
  }

  // Deterministic entry plan. Risk is ALWAYS abs(entry-stop) — no silent
  // floor substitution. If risk is 0 (a degenerate stop), that's surfaced
  // explicitly via `degenerate: true` rather than papered over.
  function deriveEntryPlan(entryPrice, stopPrice, dir, rMultiple) {
    rMultiple = rMultiple || 2;
    var risk = Math.abs(entryPrice - stopPrice);
    var degenerate = risk <= 0;
    var target = dir === 'long' ? entryPrice + risk * rMultiple : entryPrice - risk * rMultiple;
    var reward = Math.abs(target - entryPrice);
    return {
      entry: entryPrice, stop: stopPrice, risk: risk, target: target, reward: reward,
      rr: risk > 0 ? reward / risk : null,
      degenerate: degenerate,
    };
  }

  // Setup-quality score for a SPECIFIC breakout/retest event (0-100), frozen
  // at the moment it's computed — distinct from any ongoing/continuous
  // market-read score a caller may show elsewhere. Explicitly a quality
  // score, never framed as a win probability. Any input left null is
  // dropped from the weighted average rather than assumed.
  function breakoutQuality(input) {
    input = input || {};
    var parts = [];
    if (input.bodyRatio != null) parts.push({ w: 25, v: clamp((input.bodyRatio - 0.2) / 0.8 * 100) });
    if (input.volumeSurge != null) parts.push({ w: 20, v: clamp((input.volumeSurge - 0.5) * 55) });
    if (input.distanceBeyondPct != null) parts.push({ w: 15, v: clamp(input.distanceBeyondPct * 4000) });
    if (input.trendScore != null) parts.push({ w: 20, v: clamp(input.trendScore) });
    if (input.retestQuality != null) parts.push({ w: 20, v: clamp(input.retestQuality) });
    var totalW = 0, sum = 0;
    for (var i = 0; i < parts.length; i++) { totalW += parts[i].w; sum += parts[i].w * parts[i].v; }
    if (!totalW) return null;
    return Math.round(clamp(sum / totalW));
  }

  function clamp(v) { return Math.max(0, Math.min(100, v)); }

  // ── Live PASS/FAIL read of the No-Trade Filter Checklist against actual
  // session state, replacing what used to be static UI text. `pass: null`
  // means "not determinable yet" (rendered as a dash, not a false FAIL).
  function evaluateNoTradeChecklist(state, ctx, config) {
    config = config || CONFIG;
    var knowsOR = ctx.orRangePct != null;
    var rows = [];

    rows.push({
      key: 'OR_RANGE_SIZE', label: 'Opening Range Size',
      pass: !knowsOR ? null : (ctx.orRangePct >= config.OR_RANGE_MIN_PCT && ctx.orRangePct <= config.OR_RANGE_MAX_PCT),
      detail: !knowsOR ? 'Opening range not set yet.' : (ctx.orRangePct * 100).toFixed(2) + '% of price.',
    });

    rows.push({
      key: 'BREAKOUT_QUALITY', label: 'Breakout Quality',
      pass: ctx.breakoutIdx == null ? null : true,
      detail: ctx.breakoutIdx == null ? 'No confirmed breakout yet.' : 'Close-beyond-level + strong body confirmed at breakout.',
    });

    var usedUpAttempt = ctx.hasFailedBreakout.long || ctx.hasFailedBreakout.short;
    rows.push({
      key: 'FIRST_BREAKOUT_PER_DIRECTION', label: 'First Breakout Per Direction',
      pass: !usedUpAttempt,
      detail: usedUpAttempt ? 'A breakout attempt in one direction already failed this session — that side is done.' : 'No repeat breakout attempts yet.',
    });

    var retestFailed = state === STATES.NO_TRADE && ctx.breakoutIdx == null && usedUpAttempt;
    rows.push({
      key: 'RETEST_TIMING', label: 'Retest Timing',
      pass: ctx.breakoutIdx == null ? null : !retestFailed,
      detail: ctx.breakoutIdx == null ? 'No breakout to retest yet.' : (retestFailed ? 'Retest never confirmed in time.' : 'Within the retest window.'),
    });

    rows.push({
      key: 'VOLUME_CONFIRMATION', label: 'Volume Confirmation (informational only)',
      pass: ctx.breakoutVolumeSurge == null ? null : ctx.breakoutVolumeSurge >= 1.0,
      detail: ctx.breakoutVolumeSurge == null ? 'No volume data for this breakout yet.' : 'Breakout candle volume vs. 20-candle average: ' + ctx.breakoutVolumeSurge.toFixed(2) + '×. Does not block entry — shown for context only.',
    });

    var extended = ctx.breakoutIdx != null && ctx.lastEvaluatedIdx != null &&
      (ctx.lastEvaluatedIdx - ctx.breakoutIdx) >= config.EXTENDED_NO_RETEST_CANDLES;
    rows.push({
      key: 'EXTENDED_MOVE', label: 'Extended Move',
      pass: ctx.breakoutIdx == null ? null : !extended,
      detail: ctx.breakoutIdx == null ? 'No breakout yet.' : (extended ? 'Price has run ' + config.EXTENDED_NO_RETEST_CANDLES + '+ candles past breakout with no retest.' : 'Still within the retest window.'),
    });

    return rows;
  }

  // ── Core state machine ──────────────────────────────────────────────────
  // `ctx` is mutable, caller-owned session bookkeeping (mirrors what the old
  // module-level `let` variables in orbsignalengine.html tracked individually
  // — bundled into one object here so it can be constructed fresh per test
  // case). Shape:
  //   { orPeriod, allCandles, sessionCandles,
  //     orHigh, orLow, orRangePct,
  //     breakoutDir, breakoutIdx, breakoutVolumeSurge,
  //     hasFailedBreakout: { long: bool, short: bool },
  //     entryPrice, stopPrice, targetPrice, entryIdx, riskPlan,
  //     exitPrice, exitReason, lastEvaluatedIdx }
  function advanceState(state, idx, candle, ctx, config) {
    config = config || CONFIG;
    ctx.lastEvaluatedIdx = idx;
    var events = [];
    var reason = null;

    if (TRANSIENT_ADVANCE[state]) state = TRANSIENT_ADVANCE[state];

    // ---- Range forming / complete ----
    if (idx < ctx.orPeriod - 1) {
      return { nextState: STATES.RANGE_FORMING, events: events, reason: reason };
    }
    if (idx === ctx.orPeriod - 1) {
      var or = computeOpeningRange(ctx.allCandles, ctx.orPeriod);
      ctx.orHigh = or.orHigh; ctx.orLow = or.orLow; ctx.orRangePct = or.rangePct;
      var quality = classifyOpeningRangeQuality(or.rangePct, config);
      events.push({ type: 'OR_SET', orHigh: or.orHigh, orLow: or.orLow, rangePct: or.rangePct, quality: quality });
      if (quality !== 'OK') {
        reason = quality === 'TOO_NARROW' ? NO_TRADE_REASONS.OR_TOO_NARROW : NO_TRADE_REASONS.OR_TOO_WIDE;
        events.push({ type: 'NO_TRADE', reason: reason });
        return { nextState: STATES.NO_TRADE, events: events, reason: reason };
      }
      return { nextState: STATES.RANGE_COMPLETE, events: events, reason: reason };
    }

    // ---- Watching for a breakout ----
    if (state === STATES.BREAKOUT_PENDING) {
      if (!ctx.hasFailedBreakout.long) {
        var bLong = classifyBreakoutCandle(candle, ctx.orHigh, ctx.orLow, 'long', config);
        if (bLong.confirmed) {
          ctx.breakoutDir = 'long'; ctx.breakoutIdx = idx; ctx.breakoutVolumeSurge = candle.volumeSurge != null ? candle.volumeSurge : null;
          events.push({ type: 'BREAKOUT_CONFIRMED', dir: 'long', price: candle.close, bodyRatio: bLong.bodyRatio });
          return { nextState: STATES.RETEST_PENDING, events: events, reason: reason };
        } else if (bLong.poked) {
          events.push({ type: 'WEAK_BREAK', dir: 'long', bodyRatio: bLong.bodyRatio });
        }
      }
      if (!ctx.hasFailedBreakout.short) {
        var bShort = classifyBreakoutCandle(candle, ctx.orHigh, ctx.orLow, 'short', config);
        if (bShort.confirmed) {
          ctx.breakoutDir = 'short'; ctx.breakoutIdx = idx; ctx.breakoutVolumeSurge = candle.volumeSurge != null ? candle.volumeSurge : null;
          events.push({ type: 'BREAKOUT_CONFIRMED', dir: 'short', price: candle.close, bodyRatio: bShort.bodyRatio });
          return { nextState: STATES.RETEST_PENDING, events: events, reason: reason };
        } else if (bShort.poked) {
          events.push({ type: 'WEAK_BREAK', dir: 'short', bodyRatio: bShort.bodyRatio });
        }
      }

      if (idx === ctx.sessionCandles - 1) {
        reason = NO_TRADE_REASONS.SESSION_ENDED;
        events.push({ type: 'NO_TRADE', reason: reason });
        return { nextState: STATES.NO_TRADE, events: events, reason: reason };
      }
      if (ctx.hasFailedBreakout.long && ctx.hasFailedBreakout.short) {
        reason = NO_TRADE_REASONS.BREAKOUT_FAILED_BOTH_DIRECTIONS;
        events.push({ type: 'NO_TRADE', reason: reason });
        return { nextState: STATES.NO_TRADE, events: events, reason: reason };
      }
      var sinceRangeSet = idx - (ctx.orPeriod - 1);
      if (sinceRangeSet >= config.NO_BREAKOUT_CUTOFF_CANDLES) {
        reason = NO_TRADE_REASONS.NO_BREAKOUT;
        events.push({ type: 'NO_TRADE', reason: reason });
        return { nextState: STATES.NO_TRADE, events: events, reason: reason };
      }
      return { nextState: STATES.BREAKOUT_PENDING, events: events, reason: reason };
    }

    // ---- Watching for / evaluating a retest ----
    if (state === STATES.RETEST_PENDING || state === STATES.RETEST_TESTING) {
      var dir = ctx.breakoutDir;
      var level = dir === 'long' ? ctx.orHigh : ctx.orLow;
      var invalidation = dir === 'long' ? ctx.orLow : ctx.orHigh;
      var r = evaluateRetest(candle, level, dir, invalidation, config.RETEST_TOLERANCE_PCT);
      var sinceBreakout = idx - ctx.breakoutIdx;

      if (r.outcome === 'CONFIRMED') {
        var entryPrice = candle.close;
        var stopPrice = invalidation;
        var plan = deriveEntryPlan(entryPrice, stopPrice, dir);
        ctx.entryPrice = entryPrice; ctx.stopPrice = stopPrice; ctx.targetPrice = plan.target;
        ctx.entryIdx = idx; ctx.riskPlan = plan;
        events.push({ type: 'RETEST_CONFIRMED', dir: dir, price: candle.close });
        events.push({ type: 'ENTRY_TRIGGERED', dir: dir, entry: entryPrice, stop: stopPrice, target: plan.target, risk: plan.risk, reward: plan.reward, rr: plan.rr });
        return { nextState: STATES.ENTRY_TRIGGERED, events: events, reason: reason };
      }
      if (r.outcome === 'FAILED') {
        ctx.hasFailedBreakout[dir] = true;
        events.push({ type: 'FAILED_BREAKOUT', dir: dir, cause: 'RECLAIMED', price: candle.close });
        ctx.breakoutDir = null; ctx.breakoutIdx = null; ctx.breakoutVolumeSurge = null;
        return { nextState: STATES.FAILED_BREAKOUT, events: events, reason: reason };
      }
      if (r.outcome === 'TESTING') {
        events.push({ type: 'RETEST_TESTING', dir: dir, price: candle.close });
        return { nextState: STATES.RETEST_TESTING, events: events, reason: reason };
      }
      // outcome === 'NONE' — still waiting for price to come back.
      // The extension cutoff is checked first: it's the more specific,
      // actionable reason, and takes priority over the generic "session
      // ended" cause on the rare candle where both conditions are true at
      // once (e.g. a breakout with no retest exactly 3 candles before the
      // session's last candle).
      if (sinceBreakout >= config.EXTENDED_NO_RETEST_CANDLES) {
        ctx.hasFailedBreakout[dir] = true;
        events.push({ type: 'FAILED_BREAKOUT', dir: dir, cause: 'EXTENDED_NO_RETEST', price: candle.close });
        ctx.breakoutDir = null; ctx.breakoutIdx = null; ctx.breakoutVolumeSurge = null;
        return { nextState: STATES.FAILED_BREAKOUT, events: events, reason: reason };
      }
      if (idx === ctx.sessionCandles - 1) {
        ctx.hasFailedBreakout[dir] = true;
        events.push({ type: 'FAILED_BREAKOUT', dir: dir, cause: 'SESSION_ENDED', price: candle.close });
        ctx.breakoutDir = null; ctx.breakoutIdx = null; ctx.breakoutVolumeSurge = null;
        reason = NO_TRADE_REASONS.SESSION_ENDED;
        events.push({ type: 'NO_TRADE', reason: reason });
        return { nextState: STATES.NO_TRADE, events: events, reason: reason };
      }
      return { nextState: STATES.RETEST_PENDING, events: events, reason: reason };
    }

    // ---- In an active, entry-triggered position ----
    if (state === STATES.ENTRY_TRIGGERED) {
      var tDir = ctx.breakoutDir;
      var hit = null;
      if (tDir === 'long') {
        if (candle.high >= ctx.targetPrice) hit = 'TARGET_HIT';
        else if (candle.low <= ctx.stopPrice) hit = 'STOP_HIT';
      } else {
        if (candle.low <= ctx.targetPrice) hit = 'TARGET_HIT';
        else if (candle.high >= ctx.stopPrice) hit = 'STOP_HIT';
      }
      if (hit) {
        var exitPrice = hit === 'TARGET_HIT' ? ctx.targetPrice : ctx.stopPrice;
        ctx.exitPrice = exitPrice; ctx.exitReason = hit;
        events.push({ type: hit, dir: tDir, price: exitPrice });
        return { nextState: STATES[hit], events: events, reason: reason };
      }
      if (idx === ctx.sessionCandles - 1) {
        ctx.exitPrice = candle.close; ctx.exitReason = 'FLAT';
        events.push({ type: 'SESSION_FLATTEN', dir: tDir, price: candle.close });
        return { nextState: STATES.SESSION_COMPLETE, events: events, reason: reason };
      }
      return { nextState: STATES.ENTRY_TRIGGERED, events: events, reason: reason };
    }

    // ---- Terminal states just persist ----
    if (state === STATES.NO_TRADE || state === STATES.SESSION_COMPLETE) {
      return { nextState: state, events: events, reason: reason };
    }

    // Fallback — should not be reached with a well-formed ctx/state.
    return { nextState: state, events: events, reason: reason };
  }

  var api = {
    ORB_STRATEGY_VERSION: ORB_STRATEGY_VERSION,
    CONFIG: CONFIG,
    STATES: STATES,
    NO_TRADE_REASONS: NO_TRADE_REASONS,
    computeOpeningRange: computeOpeningRange,
    classifyOpeningRangeQuality: classifyOpeningRangeQuality,
    classifyBreakoutCandle: classifyBreakoutCandle,
    evaluateRetest: evaluateRetest,
    deriveEntryPlan: deriveEntryPlan,
    breakoutQuality: breakoutQuality,
    evaluateNoTradeChecklist: evaluateNoTradeChecklist,
    advanceState: advanceState,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.ORBEngine = api;
  }
})(typeof window !== 'undefined' ? window : this);
