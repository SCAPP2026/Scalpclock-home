// ── Breakout/retest primitives — ported verbatim from js/orb-engine.js ──────
// (classifyBreakoutCandle, evaluateRetest, clamp — see that file's comments
// for full context on why a wick-only poke never confirms a breakout on its
// own). Copied rather than imported across the functions/ boundary so this
// Cloudflare Pages Function has zero dependency on a browser-facing static
// asset's bundling — if js/orb-engine.js's logic ever changes, mirror the
// change here deliberately, don't let them silently diverge.
//
// Generalized use here: js/orb-engine.js always calls these with the OPENING
// RANGE high/low as the level. This module's caller (scalp-score.js's
// Market Structure category) instead passes a detected SWING high/low —
// the functions themselves are level-agnostic, they just need "a level and
// its invalidation level," so no logic changes were needed to reuse them
// for general swing breakout+retest instead of only opening-range breakout.

const RETEST_TOLERANCE_PCT = 0.0012; // retest zone = level +/- 0.12% of level

export function clamp(v) {
  return Math.max(0, Math.min(100, v));
}

// A breakout CONFIRMS only on a close beyond the level with a strong body —
// a wick-only poke through the level never confirms on its own.
export function classifyBreakoutCandle(candle, levelHigh, levelLow, dir, bodyStrengthMin = 0.35) {
  const bodyRatio = Math.abs(candle.close - candle.open) / Math.max(candle.high - candle.low, 0.0001);
  if (dir === 'long') {
    if (candle.close <= levelHigh) return { confirmed: false, poked: candle.high > levelHigh, bodyRatio };
    const strongLong = candle.close > candle.open && bodyRatio >= bodyStrengthMin;
    return { confirmed: strongLong, poked: true, bodyRatio };
  } else {
    if (candle.close >= levelLow) return { confirmed: false, poked: candle.low < levelLow, bodyRatio };
    const strongShort = candle.close < candle.open && bodyRatio >= bodyStrengthMin;
    return { confirmed: strongShort, poked: true, bodyRatio };
  }
}

// Has this candle tested `level` (within tolerance), and if so, held
// (continuation), failed (reclaimed past the invalidation level), or is it
// still undecided (touched but closed between the two)?
export function evaluateRetest(candle, level, dir, invalidationLevel, tolerancePct = RETEST_TOLERANCE_PCT) {
  const tol = level * tolerancePct;
  if (dir === 'long') {
    const touchedLong = candle.low <= level + tol;
    if (!touchedLong) return { outcome: 'NONE' };
    if (candle.close > level) return { outcome: 'CONFIRMED' };
    if (candle.close < invalidationLevel) return { outcome: 'FAILED' };
    return { outcome: 'TESTING' };
  } else {
    const touchedShort = candle.high >= level - tol;
    if (!touchedShort) return { outcome: 'NONE' };
    if (candle.close < level) return { outcome: 'CONFIRMED' };
    if (candle.close > invalidationLevel) return { outcome: 'FAILED' };
    return { outcome: 'TESTING' };
  }
}

// Setup-quality score for a SPECIFIC breakout/retest event (0-100), frozen
// at the moment it's computed. Never framed as a win probability. Any input
// left null is dropped from the weighted average rather than assumed.
export function breakoutQuality(input = {}) {
  const parts = [];
  if (input.bodyRatio != null) parts.push({ w: 25, v: clamp((input.bodyRatio - 0.2) / 0.8 * 100) });
  if (input.volumeSurge != null) parts.push({ w: 20, v: clamp((input.volumeSurge - 0.5) * 55) });
  if (input.distanceBeyondPct != null) parts.push({ w: 15, v: clamp(input.distanceBeyondPct * 4000) });
  if (input.trendScore != null) parts.push({ w: 20, v: clamp(input.trendScore) });
  if (input.retestQuality != null) parts.push({ w: 20, v: clamp(input.retestQuality) });
  let totalW = 0, sum = 0;
  for (const p of parts) { totalW += p.w; sum += p.w * p.v; }
  if (!totalW) return null;
  return Math.round(clamp(sum / totalW));
}

// ── Swing high/low detection — genuinely new, no prior implementation to
// reuse. A simple, explainable fractal method: bar i is a swing high if its
// high is the max within a window of `lookback` bars on each side (symmetric
// for swing low). Returns the MOST RECENT confirmed swing high/low, or null
// if the series is too short or perfectly flat.
export function findSwingPoints(bars, lookback = 3) {
  if (!Array.isArray(bars) || bars.length < lookback * 2 + 3) {
    return { swingHigh: null, swingLow: null };
  }
  let swingHigh = null, swingLow = null;
  // Walk from most-recent backward so we return the LATEST confirmed swing,
  // skipping the last `lookback` bars since a swing needs bars on both sides
  // to be confirmed (a swing "at the current candle" isn't confirmed yet).
  for (let i = bars.length - 1 - lookback; i >= lookback; i--) {
    const bar = bars[i];
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].high >= bar.high) isHigh = false;
      if (bars[j].low <= bar.low) isLow = false;
    }
    if (isHigh && swingHigh == null) swingHigh = { price: bar.high, index: i };
    if (isLow && swingLow == null) swingLow = { price: bar.low, index: i };
    if (swingHigh && swingLow) break;
  }
  return { swingHigh, swingLow };
}
