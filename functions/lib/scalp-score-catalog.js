// ── Scalp Opportunity Score — weight/threshold catalog ──────────────────────
// Pure constants only, no logic. Imported by BOTH the live scorer
// (functions/lib/scalp-score.js) and anything that needs to describe the
// scoring model to a human (the /scalp-opportunity-score methodology page,
// via functions/api/scalp-score-methodology.js, and the admin debug panel) —
// so public-facing copy can never drift out of sync with production math.
//
// Bump ENGINE_VERSION any time a weight or threshold below changes. This
// value is written onto every signal_history row (see signals-snapshot.js)
// specifically so a future backtest report never silently blends outcomes
// scored under an old weighting with outcomes scored under a new one.
export const ENGINE_VERSION = 'scalp-v1-8cat';

// Every category's point value here MUST sum to 100 — enforced at runtime
// by scalp-score.js (throws in dev if this drifts, since a silent mismatch
// would corrupt every downstream score).
export const CATEGORY_WEIGHTS = {
  liquidity:       15,
  relativeVolume:  15,
  momentum:        15,
  marketStructure: 15,
  vwap:            10,
  catalyst:        10,
  optionsQuality:  10,
  setupQuality:    10,
};

export const TOTAL_POSSIBLE = Object.values(CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0);

// Relative-volume bucket table from the spec — RVOL is (latest bar volume) /
// (a same-time-of-day historical baseline), NOT a flat trailing average.
// See scoreRelativeVolume() for how the baseline itself is estimated.
export const RVOL_BUCKETS = [
  { max: 0.80, points: [0, 2] },
  { max: 1.00, points: [3, 5] },
  { max: 1.50, points: [6, 8] },
  { max: 2.00, points: [9, 11] },
  { max: 3.00, points: [12, 14] },
  { max: Infinity, points: [15, 15] },
];

// Liquidity thresholds. IMPORTANT: these are computed from Alpaca's free IEX
// feed only (IEX trades/quotes), NOT full consolidated SIP market volume —
// any UI surfacing a liquidity score or dollar-volume figure derived from
// this must say so explicitly, not just in a code comment. See
// scoreLiquidity()'s returned `disclaimer` field.
export const LIQUIDITY = {
  MIN_PRICE: 5,               // matches signals.js's existing MIN_PRICE floor
  MIN_DOLLAR_VOL_FULL: 25_000_000,   // avg daily $ volume for full 15/15
  MIN_DOLLAR_VOL_FLOOR: 1_500_000,   // below this, liquidity scores 0
  IEX_ONLY_DISCLAIMER:
    'Volume and liquidity figures are based on Alpaca’s free IEX feed ' +
    '(one exchange’s trades/quotes), not full consolidated U.S. market volume.',
};

// Setup Quality enum. "No Confirmed Setup" is a hard ceiling applied in
// scalp-score.js's applySetupCeiling(), not just a low point value here —
// per the spec, a strong-momentum ticker with no confirmed setup must not
// out-rank a weaker-momentum ticker that has one.
export const SETUPS = {
  ORB_BREAKOUT:            'ORB Breakout',
  ORB_BREAKDOWN:           'ORB Breakdown',
  BREAKOUT_RETEST:         'Breakout + Retest',
  BREAKDOWN_RETEST:        'Breakdown + Retest',
  VWAP_RECLAIM:            'VWAP Reclaim',
  VWAP_REJECTION:          'VWAP Rejection',
  SUPPORT_BOUNCE:          'Support Bounce',
  RESISTANCE_REJECTION:    'Resistance Rejection',
  HIGH_OF_DAY_BREAK:       'High-of-Day Break',
  LOW_OF_DAY_BREAKDOWN:    'Low-of-Day Breakdown',
  MOMENTUM_CONTINUATION:   'Momentum Continuation',
  CONSOLIDATION_BREAKOUT:  'Consolidation Breakout',
  NO_CONFIRMED_SETUP:      'No Confirmed Setup',
};

// A ticker whose final setup is NO_CONFIRMED_SETUP gets its total score
// capped at this value regardless of how strong the other 7 categories
// scored — see applySetupCeiling() in scalp-score.js.
export const NO_SETUP_SCORE_CEILING = 55;

// Overextension: how far beyond VWAP (in %) counts as "extended" before a
// legitimate continuation setup is required to avoid a score penalty.
export const OVEREXTENSION = {
  VWAP_DIST_PCT_WARN: 2.5,
  RSI_EXTREME_HIGH: 85,
  RSI_EXTREME_LOW: 15,
};

// Confidence is a SEPARATE measure from the 100-point score — how many of
// the 8 categories independently clear a "meaningful signal" bar. Never
// blended into the numeric score itself.
export const CONFIDENCE_CATEGORY_THRESHOLD_PCT = 0.6; // category scores >= 60% of its own max count as "agreeing"
export const CONFIDENCE_LABELS = [
  { min: 6, label: 'High' },
  { min: 4, label: 'Moderate' },
  { min: 0, label: 'Low' },
];

export const DISCLAIMER =
  'Educational analysis, not personalized financial advice. This score identifies ' +
  'potential opportunities — it does not predict outcomes or guarantee a ' +
  'profitable trade. See /scalp-opportunity-score and /trading-education-disclaimer.';
