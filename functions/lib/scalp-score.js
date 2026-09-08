// ── Scalp Opportunity Score — centralized 100-point scoring engine ─────────
// PURE FUNCTIONS ONLY: no fetch, no `env`, no Supabase, no Date.now() side
// effects beyond what's passed in. This is deliberate — it's what makes
// no-look-ahead-bias a structural property instead of a discipline to
// remember: computeScalpScore() can only ever see data the caller already
// fetched "as of now," and unit tests can exercise it with synthetic bar
// data with zero network/Alpaca dependency (see functions/lib/__tests__/
// scalp-score.test.js).
//
// signals.js's existing calcRSI/calcVWAP/calcVolSurge/fetchNewsTickers/
// getSignal() are NOT reimplemented here — this module consumes their
// OUTPUT as input. See signals.js's per-symbol loop for how the two compose.
import {
  CATEGORY_WEIGHTS, TOTAL_POSSIBLE, RVOL_BUCKETS, LIQUIDITY, SETUPS,
  NO_SETUP_SCORE_CEILING, OVEREXTENSION, CONFIDENCE_CATEGORY_THRESHOLD_PCT,
  CONFIDENCE_LABELS, ENGINE_VERSION, DISCLAIMER,
} from './scalp-score-catalog.js';
import { classifyBreakoutCandle, evaluateRetest, findSwingPoints } from './breakout-retest.js';

if (Object.values(CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0) !== 100) {
  // Fails loudly rather than silently producing scores that don't add to
  // 100 — a caught mistake here is cheap, a silently-wrong live score isn't.
  throw new Error('scalp-score-catalog: CATEGORY_WEIGHTS must sum to 100');
}

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, v));
}

// ── A. Liquidity (15) ────────────────────────────────────────────────────
function scoreLiquidity({ price, avgDollarVol }) {
  const max = CATEGORY_WEIGHTS.liquidity;
  if (price == null || price < LIQUIDITY.MIN_PRICE || avgDollarVol == null) {
    return { points: 0, max, note: 'Insufficient liquidity data.' };
  }
  if (avgDollarVol < LIQUIDITY.MIN_DOLLAR_VOL_FLOOR) {
    return { points: 0, max, note: `Avg $ volume below the ${LIQUIDITY.MIN_DOLLAR_VOL_FLOOR.toLocaleString()} floor.` };
  }
  const span = LIQUIDITY.MIN_DOLLAR_VOL_FULL - LIQUIDITY.MIN_DOLLAR_VOL_FLOOR;
  const frac = clamp((avgDollarVol - LIQUIDITY.MIN_DOLLAR_VOL_FLOOR) / span, 0, 1);
  return { points: Math.round(frac * max), max, note: `Avg $ volume ≈ $${Math.round(avgDollarVol).toLocaleString()}/day.` };
}

// ── B. Relative Volume (15) ──────────────────────────────────────────────
// RVOL = current volume / expected volume for this time of day. `bars15`
// is the same intraday series signals.js already fetched for RSI/VWAP — no
// new API call. Baseline is estimated from that same series' own bars at
// the same time-of-day bucket on prior days (falls back gracefully to the
// flat-average volSurge already computed by signals.js if too few prior
// days are present — same graceful-fallback spirit as signals.js's own
// screener/fallback-universe pattern).
function estimateTimeOfDayBaseline(bars15, timeOfDayMinutes, bucketMinutes = 15) {
  if (!Array.isArray(bars15) || !bars15.length || timeOfDayMinutes == null) return null;
  const sameBucket = [];
  for (const b of bars15) {
    const d = new Date(b.t);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (Math.abs(mins - timeOfDayMinutes) < bucketMinutes) sameBucket.push(b.v);
  }
  if (sameBucket.length < 2) return null; // not enough history yet — caller falls back
  return sameBucket.reduce((a, b) => a + b, 0) / sameBucket.length;
}

function scoreRelativeVolume({ bars15, latestVolume, timeOfDayMinutes, fallbackVolSurge }) {
  const max = CATEGORY_WEIGHTS.relativeVolume;
  const baseline = estimateTimeOfDayBaseline(bars15, timeOfDayMinutes);
  let rvol;
  let methodology;
  if (baseline && baseline > 0 && latestVolume != null) {
    rvol = latestVolume / baseline;
    methodology = 'time-of-day-adjusted';
  } else if (fallbackVolSurge != null) {
    // Graceful fallback: signals.js's calcVolSurge (flat trailing average),
    // not time-of-day adjusted — documented as such, never silently passed
    // off as the real baseline.
    rvol = fallbackVolSurge;
    methodology = 'flat-trailing-average-fallback';
  } else {
    return { points: 0, max, note: 'No volume baseline available yet.', rvol: null, methodology: null };
  }
  const bucket = RVOL_BUCKETS.find(b => rvol < b.max) || RVOL_BUCKETS[RVOL_BUCKETS.length - 1];
  const [lo, hi] = bucket.points;
  // Linear interpolation within the matched bucket's point range for a
  // smoother score than a hard step function.
  const prevMax = RVOL_BUCKETS[RVOL_BUCKETS.indexOf(bucket) - 1]?.max ?? 0;
  const span = bucket.max === Infinity ? 1 : Math.max(bucket.max - prevMax, 0.0001);
  const frac = bucket.max === Infinity ? 1 : clamp((rvol - prevMax) / span, 0, 1);
  const points = Math.round(lo + (hi - lo) * frac);
  return { points: clamp(points, 0, max), max, note: `RVOL ${rvol.toFixed(2)}× (${methodology}).`, rvol: Number(rvol.toFixed(2)), methodology };
}

// ── C. Momentum (15) ─────────────────────────────────────────────────────
// Favors ACCELERATING momentum over exhausted momentum — computed from the
// same recentBars slice signals.js already has (RSI at "now" vs RSI a few
// bars back → slope), not a new bar fetch.
function calcRSISeries(closes, period = 14) {
  // Same math as signals.js's calcRSI, generalized to return the RSI value
  // at EVERY index >= period (not just the final one) so a slope can be
  // computed — kept local rather than importing signals.js's private
  // calcRSI to avoid coupling a pure lib module to an onRequest handler.
  if (closes.length < period + 1) return [];
  const out = [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function scoreMomentum({ bars15 }) {
  const max = CATEGORY_WEIGHTS.momentum;
  if (!Array.isArray(bars15) || bars15.length < 20) {
    return { points: Math.round(max * 0.3), max, note: 'Not enough bars yet for a momentum read.', accelerating: null };
  }
  const closes = bars15.map(b => b.c);
  const rsiSeries = calcRSISeries(closes);
  const lastIdx = rsiSeries.length - 1;
  const lookback = 4; // ~1 hour on 15-min bars
  const rsiNow = rsiSeries[lastIdx];
  const rsiPrior = rsiSeries[Math.max(0, lastIdx - lookback)];
  if (rsiNow == null || rsiPrior == null) {
    return { points: Math.round(max * 0.3), max, note: 'RSI not yet stable enough for a slope read.', accelerating: null };
  }
  const levelScore = Math.abs(rsiNow - 50) * 2; // 0-100, distance from neutral
  const slope = rsiNow - rsiPrior;
  const dir = rsiNow >= 50 ? 1 : -1;
  const accelerating = slope * dir > 0; // momentum moving further in its own direction
  // Accelerating momentum is boosted; momentum that peaked and is now fading
  // (exhausted) is penalized — this is the spec's explicit requirement that
  // a move from 30 minutes ago that's now fading should not rank as if it
  // were still building.
  const accelFactor = accelerating ? 1.15 : 0.75;
  const points = clamp(Math.round((levelScore / 100) * max * accelFactor), 0, max);
  return {
    points, max,
    note: accelerating
      ? `RSI ${rsiNow.toFixed(0)}, accelerating in its own direction.`
      : `RSI ${rsiNow.toFixed(0)}, momentum fading from ${rsiPrior.toFixed(0)} — treated as exhausted, not fresh.`,
    accelerating, rsiNow: Number(rsiNow.toFixed(1)),
  };
}

// ── D. VWAP (10) ─────────────────────────────────────────────────────────
// A reclaim/rejection SEQUENCE (crossed VWAP and held) scores substantially
// higher than a simple "currently above/below" snapshot, per spec — this
// requires walking bars15 bar-by-bar rather than just the latest vwapDist.
function scoreVWAPSequence({ bars15, vwapSeries, vwapDist }) {
  const max = CATEGORY_WEIGHTS.vwap;
  if (vwapDist == null || !Array.isArray(bars15) || bars15.length < 6 || !Array.isArray(vwapSeries)) {
    return { points: Math.round(max * 0.4), max, note: 'VWAP sequence not available — using simple position only.', sequence: 'simple' };
  }
  // Look at the last few bars' close-vs-vwap relationship to detect a
  // recent cross that has since held (reclaim/rejection) vs. one that's
  // just now happening vs. no cross at all recently (steady position).
  const n = Math.min(6, bars15.length, vwapSeries.length);
  const recent = bars15.slice(-n);
  const vwapRecent = vwapSeries.slice(-n);
  const above = recent.map((b, i) => vwapRecent[i] != null && b.c > vwapRecent[i]);
  const lastAbove = above[above.length - 1];
  let crossedIdx = -1;
  for (let i = above.length - 1; i > 0; i--) {
    if (above[i] !== above[i - 1]) { crossedIdx = i; break; }
  }
  const barsHeldSincecross = crossedIdx >= 0 ? (above.length - 1 - crossedIdx) : null;

  if (crossedIdx >= 0 && barsHeldSincecross >= 1 && barsHeldSincecross <= 3) {
    // A real reclaim (was below, now above, held) or rejection (was above,
    // now below, held) in the last few bars — the strongest VWAP setup.
    const points = lastAbove ? max : max; // full weight either direction, direction handled by caller's tone
    return {
      points, max,
      note: lastAbove
        ? `VWAP reclaim held for ${barsHeldSincecross} bar(s) — stronger than a simple above-VWAP read.`
        : `VWAP rejection held for ${barsHeldSincecross} bar(s) — stronger than a simple below-VWAP read.`,
      sequence: lastAbove ? 'reclaim' : 'rejection',
    };
  }
  // No recent confirmed cross — fall back to simple distance-based scoring,
  // same shape as signals.js's existing vwapDist check but as points not a
  // binary flag.
  const distScore = clamp(Math.abs(vwapDist) * 12, 0, max * 0.6);
  return { points: Math.round(distScore), max, note: `${vwapDist > 0 ? 'Above' : 'Below'} VWAP by ${Math.abs(vwapDist).toFixed(2)}% (no recent reclaim/rejection sequence).`, sequence: 'simple' };
}

// ── E. Market Structure (15) ─────────────────────────────────────────────
// Reuses classifyBreakoutCandle/evaluateRetest (ported from js/orb-engine.js
// — see functions/lib/breakout-retest.js's header comment) against a
// detected SWING high/low rather than an opening-range high/low. Breakout +
// retest scores substantially higher than a raw, unconfirmed breakout.
function scoreMarketStructure({ bars15, volSurge }) {
  const max = CATEGORY_WEIGHTS.marketStructure;
  if (!Array.isArray(bars15) || bars15.length < 12) {
    return { points: Math.round(max * 0.3), max, note: 'Not enough bars yet to read market structure.', structure: null };
  }
  const candles = bars15.map(b => ({ open: b.o, high: b.h, low: b.l, close: b.c }));
  const { swingHigh, swingLow } = findSwingPoints(candles);

  // Higher-highs/higher-lows vs lower-highs/lower-lows over the recent
  // window — same counting approach as orbsignalengine.html's scoreTrend.
  const win = candles.slice(-6);
  let hh = 0, hl = 0, lh = 0, ll = 0;
  for (let i = 1; i < win.length; i++) {
    if (win[i].high > win[i - 1].high) hh++; else lh++;
    if (win[i].low > win[i - 1].low) hl++; else ll++;
  }
  const structureNet = (hh + hl) - (lh + ll);
  const trendDir = structureNet >= 0 ? 'bull' : 'bear';
  const baseScore = clamp(50 + Math.abs(structureNet) * 8, 0, 100);

  let breakoutState = null;
  const last = candles[candles.length - 1];
  const prev = candles.slice(0, -1);
  if (swingHigh && prev.length) {
    const b = classifyBreakoutCandle(last, swingHigh.price, swingLow ? swingLow.price : swingHigh.price * 0.98, 'long');
    if (b.confirmed) breakoutState = { dir: 'long', level: swingHigh.price, bodyRatio: b.bodyRatio, retest: null };
  }
  if (!breakoutState && swingLow && prev.length) {
    const b = classifyBreakoutCandle(last, swingHigh ? swingHigh.price : swingLow.price * 1.02, swingLow.price, 'short');
    if (b.confirmed) breakoutState = { dir: 'short', level: swingLow.price, bodyRatio: b.bodyRatio, retest: null };
  }

  // Cheap retest check: did any of the last 2 bars retest the SAME level
  // and hold, after the breakout bar itself? This is a lightweight,
  // single-pass approximation (not the full stateful ORBEngine machine,
  // which tracks this across an entire session) — adequate for a per-
  // request snapshot score rather than a live session state machine.
  if (breakoutState) {
    const invalidation = breakoutState.dir === 'long'
      ? (swingLow ? swingLow.price : breakoutState.level * 0.98)
      : (swingHigh ? swingHigh.price : breakoutState.level * 1.02);
    for (const c of candles.slice(-3, -1)) {
      const r = evaluateRetest(c, breakoutState.level, breakoutState.dir, invalidation);
      if (r.outcome === 'CONFIRMED') { breakoutState.retest = 'confirmed'; break; }
      if (r.outcome === 'FAILED') { breakoutState.retest = 'failed'; break; }
    }
  }

  let points, note, structure;
  if (breakoutState && breakoutState.retest === 'confirmed') {
    points = max; // strongest structural setup — breakout + confirmed retest
    structure = breakoutState.dir === 'long' ? SETUPS.BREAKOUT_RETEST : SETUPS.BREAKDOWN_RETEST;
    note = `${structure} confirmed at ${breakoutState.level.toFixed(2)}.`;
  } else if (breakoutState && breakoutState.retest !== 'failed') {
    points = Math.round(max * 0.75); // confirmed breakout, retest not yet resolved
    structure = breakoutState.dir === 'long' ? 'Breakout (unretested)' : 'Breakdown (unretested)';
    note = `${structure} at ${breakoutState.level.toFixed(2)} — no retest confirmation yet.`;
  } else if (breakoutState && breakoutState.retest === 'failed') {
    points = Math.round(max * 0.2);
    structure = 'Failed breakout';
    note = 'A breakout attempt reclaimed back through its level — treated as failed, not confirmed.';
  } else {
    points = Math.round((baseScore / 100) * max * 0.6); // plain trend structure, no breakout event
    structure = trendDir === 'bull' ? 'Uptrend structure' : 'Downtrend structure';
    note = trendDir === 'bull' ? 'Higher highs/higher lows, no confirmed breakout yet.' : 'Lower highs/lower lows, no confirmed breakdown yet.';
  }

  return { points: clamp(points, 0, max), max, note, structure, trendDir, breakoutState };
}

// ── F. Catalyst (10) ─────────────────────────────────────────────────────
// Wraps signals.js's existing real news-catalyst check (fetchNewsTickers).
// "Unknown" (no news either way) scores neutral, per spec — never fabricate
// a catalyst, never over-penalize its absence.
function scoreCatalyst({ hasNews }) {
  const max = CATEGORY_WEIGHTS.catalyst;
  if (hasNews == null) {
    return { points: Math.round(max * 0.5), max, note: 'Catalyst: Unknown (no news-feed match either way).', catalyst: 'Unknown' };
  }
  if (hasNews) {
    return { points: max, max, note: 'Recent news coverage found for this ticker.', catalyst: 'Present' };
  }
  return { points: Math.round(max * 0.5), max, note: 'No recent news coverage found — not penalized for it.', catalyst: 'None detected' };
}

// ── G. Options Quality (10) ──────────────────────────────────────────────
// Consumes an already-fetched options snapshot (see functions/api/options.js
// / pickCandidateContracts) — this function does NOT fetch options data
// itself, by design, so it can be called for a bounded top-N set of symbols
// without turning a 220-symbol scan into 220 extra CBOE fetches.
function scoreOptionsQuality({ optionsSnapshot }) {
  const max = CATEGORY_WEIGHTS.optionsQuality;
  if (!optionsSnapshot) {
    return { points: null, max, note: 'Options liquidity not evaluated for this symbol yet.', evaluated: false };
  }
  const { callVolume = 0, putVolume = 0, callOI = 0, putOI = 0, bestContract = null } = optionsSnapshot;
  const totalVol = callVolume + putVolume;
  const totalOI = callOI + putOI;
  let points = 0;
  if (totalVol > 5000) points += max * 0.4;
  else if (totalVol > 500) points += max * 0.2;
  if (totalOI > 20000) points += max * 0.3;
  else if (totalOI > 2000) points += max * 0.15;
  if (bestContract && bestContract.spreadPct != null) {
    if (bestContract.spreadPct < 0.05) points += max * 0.3;
    else if (bestContract.spreadPct < 0.15) points += max * 0.15;
  }
  return {
    points: clamp(Math.round(points), 0, max), max, evaluated: true,
    note: `Chain volume ${totalVol.toLocaleString()}, OI ${totalOI.toLocaleString()}.`,
  };
}

// ── H. Setup Quality (10) ────────────────────────────────────────────────
// Classifies a single named setup from the other categories' sub-results,
// then the aggregator applies applySetupCeiling() as a hard cap — a strong
// ticker with NO_CONFIRMED_SETUP must not out-rank a weaker one that has a
// real setup, regardless of raw momentum.
function classifySetup({ marketStructure, vwapResult, momentum }) {
  if (marketStructure.structure === SETUPS.BREAKOUT_RETEST || marketStructure.structure === SETUPS.BREAKDOWN_RETEST) {
    return marketStructure.structure;
  }
  if (vwapResult.sequence === 'reclaim') return SETUPS.VWAP_RECLAIM;
  if (vwapResult.sequence === 'rejection') return SETUPS.VWAP_REJECTION;
  if (marketStructure.breakoutState && marketStructure.breakoutState.retest !== 'failed') {
    return marketStructure.breakoutState.dir === 'long' ? SETUPS.HIGH_OF_DAY_BREAK : SETUPS.LOW_OF_DAY_BREAKDOWN;
  }
  if (momentum.accelerating && momentum.points >= momentum.max * 0.6) return SETUPS.MOMENTUM_CONTINUATION;
  return SETUPS.NO_CONFIRMED_SETUP;
}

function scoreSetupQuality(setup) {
  const max = CATEGORY_WEIGHTS.setupQuality;
  if (setup === SETUPS.NO_CONFIRMED_SETUP) {
    return { points: Math.round(max * 0.2), max, note: 'No confirmed setup — this alone caps the overall score.' };
  }
  if (setup === SETUPS.BREAKOUT_RETEST || setup === SETUPS.BREAKDOWN_RETEST) {
    return { points: max, max, note: `${setup} — structurally confirmed setup.` };
  }
  return { points: Math.round(max * 0.65), max, note: `${setup} — a real but less-confirmed setup than breakout+retest.` };
}

// ── Confidence — tracked SEPARATELY from the 0-100 opportunity score ────
function computeConfidence(breakdown) {
  let agreeing = 0;
  for (const key of Object.keys(CATEGORY_WEIGHTS)) {
    const cat = breakdown[key];
    if (cat && cat.points != null && cat.max > 0 && cat.points / cat.max >= CONFIDENCE_CATEGORY_THRESHOLD_PCT) agreeing++;
  }
  const label = (CONFIDENCE_LABELS.find(l => agreeing >= l.min) || CONFIDENCE_LABELS[CONFIDENCE_LABELS.length - 1]).label;
  return { agreeing, of: Object.keys(CATEGORY_WEIGHTS).length, label };
}

// ── Main entry point ─────────────────────────────────────────────────────
export function computeScalpScore(input) {
  const {
    symbol, price, avgDollarVol, bars15 = [], vwapSeries = null, vwapDist,
    latestVolume, timeOfDayMinutes, fallbackVolSurge, hasNews, optionsSnapshot,
    tone, // 'buy' | 'sell' — from signals.js's existing getSignal(), used only to label direction
  } = input;

  const liquidity = scoreLiquidity({ price, avgDollarVol });
  const relativeVolume = scoreRelativeVolume({ bars15, latestVolume, timeOfDayMinutes, fallbackVolSurge });
  const momentum = scoreMomentum({ bars15 });
  const vwapResult = scoreVWAPSequence({ bars15, vwapSeries, vwapDist });
  const marketStructure = scoreMarketStructure({ bars15, volSurge: fallbackVolSurge });
  const catalyst = scoreCatalyst({ hasNews });
  const optionsQuality = scoreOptionsQuality({ optionsSnapshot });

  const setup = classifySetup({ marketStructure, vwapResult, momentum });
  const setupQuality = scoreSetupQuality(setup);

  const breakdown = {
    liquidity, relativeVolume, momentum,
    marketStructure, vwap: vwapResult, catalyst, optionsQuality, setupQuality,
  };

  // optionsQuality may be un-evaluated (points: null) when no options
  // snapshot was fetched for this symbol (bounded top-N scoping, see
  // functions/lib/scalp-score.js's header comment) — treated as "not yet
  // counted" rather than zero, so a ticker isn't unfairly penalized purely
  // because it wasn't in this request's top-N options-fetch set.
  let rawTotal = 0, countedMax = 0;
  for (const cat of Object.values(breakdown)) {
    if (cat.points == null) continue;
    rawTotal += cat.points;
    countedMax += cat.max;
  }
  const score = countedMax > 0 ? Math.round((rawTotal / countedMax) * 100) : 0;

  const cappedScore = setup === SETUPS.NO_CONFIRMED_SETUP ? Math.min(score, NO_SETUP_SCORE_CEILING) : score;

  const confidence = computeConfidence(breakdown);

  const overextended =
    (vwapDist != null && Math.abs(vwapDist) > OVEREXTENSION.VWAP_DIST_PCT_WARN) &&
    !(marketStructure.breakoutState && marketStructure.breakoutState.retest === 'confirmed');

  return {
    symbol,
    score: clamp(cappedScore, 0, 100),
    scoreUncapped: clamp(score, 0, 100),
    direction: tone === 'sell' ? 'PUT' : 'CALL',
    setup,
    confidence: confidence.label,
    confidenceDetail: `${confidence.agreeing}/${confidence.of} categories agree`,
    overextended,
    breakdown,
    engineVersion: ENGINE_VERSION,
    disclaimer: DISCLAIMER,
  };
}
