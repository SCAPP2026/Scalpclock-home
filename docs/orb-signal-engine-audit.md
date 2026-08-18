# ORB Signal Engine — Audit & Correction

**Date:** 2026-08-18
**Strategy version shipped:** `ORB v1.0` (first versioned release — no prior version existed to compare against)
**Scope:** `orbsignalengine.html`, new `js/orb-engine.js`, new `tests/orb-engine.test.js`

## Why this pass happened

The ORB Signal Engine had a working replay UI, but several of its own displayed rules were not actually enforced by the underlying code, and the state machine was implicit rather than explicit. This document is the record of what was inspected, what was actually wrong (versus what was already correct), what was changed, and what the engine still cannot claim.

## Removed

- The old inline breakout/retest/entry decision logic embedded directly in `evaluate()` — replaced by delegating every decision to `js/orb-engine.js`.
- The static, unenforced No-Trade Filter Checklist (`<ul class="rules">` of plain text) — replaced by a live-computed `PASS`/`FAIL` list (`ORBEngine.evaluateNoTradeChecklist`).
- The silent risk-floor in the 2R target calculation (`Math.max(abs(entry-stop), entry*0.0008)`) — risk is now always exactly `abs(entry - stop)`.
- The "your Pro data feed" phrasing (appeared nowhere else on the site, leftover from the originally pasted-in tool, misleadingly implied a paid-plan gate on a tool that's free for everyone).
- The `optType` (CALL/PUT)-as-primary-label framing — direction is now labeled `BULLISH ORB` / `BEARISH ORB` first, with `Options Bias: CALLS/PUTS` as a secondary line.

## Corrected (real bugs found and fixed)

1. **"First breakout per direction" was not enforced.** After a failed breakout, the old code reset straight back to `WATCH_BREAKOUT` with no memory of the failure — a second breakout attempt in the *same* direction could still be traded, directly contradicting the checklist's own displayed rule. Fixed via `ctx.hasFailedBreakout.{long,short}`, checked before a new breakout attempt in `advanceState()`. Covered by the "First-breakout-per-direction is actually enforced" test.
2. **"No entries 3+ candles past breakout with no retest" was not enforced.** The old `checkExtension()` only logged a warning toast; it never blocked `enterTrade()`. Fixed: once `EXTENDED_NO_RETEST_CANDLES` (3) candles pass with no retest touch, that direction is marked failed (`FAILED_BREAKOUT`, cause `EXTENDED_NO_RETEST`) and can no longer trade.
3. **Target wasn't deterministic against the displayed Stop.** `risk = Math.max(abs(entry-stop), entry*0.0008)` meant Target could be computed from a *larger* synthetic risk than the Stop actually shown. Fixed: `deriveEntryPlan()` always uses `risk = abs(entry - stop)` exactly; a zero-distance stop is surfaced as `degenerate: true` instead of silently floored.
4. **A real precedence bug found by the new test suite itself**, not present in the old code (introduced and then fixed during this rewrite): when a breakout's 3-candle extension cutoff and the session's last candle land on the same tick, the engine checked "session ended" first and reported the generic `SESSION_ENDED` reason instead of the more specific, more useful `EXTENDED_NO_RETEST`. Reordered so the more specific cause wins.
5. **A staleness bug found via live headless-browser testing** (not caught by the unit tests, which construct fresh `ctx` per case): `breakoutVolumeSurge` wasn't cleared alongside `breakoutDir`/`breakoutIdx` when a breakout failed, so the No-Trade Checklist's "Volume Confirmation" row could show a stale `PASS`/`FAIL` from an already-failed, no-longer-relevant breakout attempt instead of resetting to "not applicable yet." Fixed by clearing it in the same three places `breakoutDir`/`breakoutIdx` are cleared.

## Already correct (verified, not changed)

- Session/DST handling in `orb-bars.js` (`Intl.DateTimeFormat('America/New_York')`) — correct before this pass.
- 26 × 15-minute bars = 390 minutes = the full 09:30–16:00 ET regular session — correct before this pass.
- A wick alone through OR High/Low never confirmed a breakout — the close-beyond-level + body-ratio ≥ 35% check already prevented this.
- The Range selector (15m/30m/60m) already fed `orPeriod` into the real OR calculation — not cosmetic.
- No "BUY CALL"/"BUY PUT"/"Confidence: X%" language existed anywhere in the file — a prior pass had already softened this to "BIAS CONFIRMED" wording, though the underlying `optType`-as-primary-label *structure* still needed the fix described above.

## Added

- **12-state machine** (`js/orb-engine.js`, `ORBEngine.STATES`): `WAITING_FOR_RANGE, RANGE_FORMING, RANGE_COMPLETE, BREAKOUT_PENDING, RETEST_PENDING, RETEST_TESTING, RETEST_CONFIRMED, ENTRY_TRIGGERED, TARGET_HIT, STOP_HIT, FAILED_BREAKOUT, NO_TRADE, SESSION_COMPLETE` — displayed live as "ORB Status" in the phase pill.
- **`FAILED_BREAKOUT`** as a real, distinct, tracked-per-direction state.
- **`NO_TRADE` reasons** (`OR_TOO_NARROW`, `OR_TOO_WIDE`, `NO_BREAKOUT`, `BREAKOUT_FAILED_BOTH_DIRECTIONS`, `SESSION_ENDED`), surfaced in a first-class "Why No Trade?" card.
- **Live No-Trade Filter Checklist** — 6 rows (`Opening Range Size`, `Breakout Quality`, `First Breakout Per Direction`, `Retest Timing`, `Volume Confirmation [informational only]`, `Extended Move`), each showing a real `PASS`/`FAIL`/`—` computed from actual session state.
- **Setup Plan card rebuilt**: Direction, Options Bias (secondary), Current Price, Potential Entry (live retest zone) vs. Confirmed Entry (fixed once triggered) vs. Current Price as three distinct rows, Stop + "Why this stop?" explainer, Risk, Target, Reward, R:R, Retest Zone (with the tolerance formula shown), Breakout Quality.
- **Breakout Quality (0–100)** — a one-time score of the specific breakout/retest event (body strength, volume surge, distance beyond the level, trend alignment), frozen at breakout time. Explicitly labeled a *setup-quality score*, never a win probability. Kept separate from the pre-existing, continuous 6-factor "Orb Score" gauge (a different, ongoing market-read, unrelated to this event-scoped metric).
- **Setup Summary Card** — appears once a retest confirms: direction, OR High/Low, breakout/retest times, entry/stop/target/risk/reward/R:R, Setup Quality.
- **Session Context strip** — NYSE session window, Opening Range window, current replay time, time remaining, status. All times come from `times[]`, which is already ET (real sessions via `orb-bars.js`'s `Intl` conversion; simulated sessions start at 09:30 by construction) — never the visitor's local clock.
- **Mode banner** — `SIMULATION MODE` (amber) vs. `LIVE MARKET DATA — Alpaca IEX real-time feed` (green), replacing the ambiguous "Pro data feed" phrase.
- **Short deterministic disclaimer** directly under the action row, plus a **9-point "How ORB Works" expandable**.
- **Client-side trade ledger** (`sc_orb_trade_ledger` in `localStorage`) — one record per resolved session with every field: symbol, date, OR High/Low/range%, breakout direction/time/price, retest time/price, entry, stop, target, exit, result, R multiple, breakout volume surge, breakout quality, strategy version.

## Strategy Rules (exact formulas, all in `js/orb-engine.js`)

| Rule | Value | Note |
|---|---|---|
| Breakout body strength | `bodyRatio >= 0.35` | body / (high−low) of the breakout candle |
| Retest tolerance | `level × 0.0012` (0.12%) | retest zone = OR level ± tolerance |
| No-breakout cutoff | 8 candles after OR set | beyond this with no breakout → `NO_TRADE` |
| Extended-no-retest cutoff | 3 candles after breakout | beyond this with no retest touch → that direction fails |
| OR range floor | 0.15% of price | below this → excluded, `OR_TOO_NARROW` |
| OR range ceiling | 1.2% of price | above this → excluded, `OR_TOO_WIDE` |
| Target | `entry + risk × 2` (long) / `entry − risk × 2` (short) | `risk = abs(entry − stop)`, always, no floor |

**These are strategy rules this engine enforces, not statistically-validated facts.** ScalpClock has not backtested these exact thresholds against its own trade history. All copy referring to them says "strategy rule," never "historically."

## Data Source

`functions/api/orb-bars.js` calls Alpaca's `/v2/stocks/{symbol}/bars` with `feed=iex`. This is Alpaca's free-tier real-time feed — **genuinely live, not delayed** — but reflects trades on the **IEX exchange only**, not the full consolidated SIP tape. Thinly-traded symbols may show gaps or thinner coverage than a consolidated feed would. Today's date uses 15-minute bars filtered to 09:30–16:00 ET via `Intl.DateTimeFormat('America/New_York')` (DST-safe). The mode banner and live-data copy on the page now state this precisely instead of the previous ambiguous "Pro data feed" wording.

## Backtesting

**Client-side only**, per an explicit scope decision made before implementation: the site's one existing backend precedent (`signal_history` table, used by the separate Scalp Signals RSI/VWAP feature) is the wrong shape for this (no entry/stop/target/R fields) and resolves asynchronously via a next-day cron job — structurally mismatched to ORB, which resolves each trade synchronously in-browser the moment target/stop is hit.

The trade ledger (`sc_orb_trade_ledger`) lives in `localStorage`, scoped to one browser/device. Every "sample size" or win-rate figure shown anywhere in this tool is **this device's history only** — never a cross-user or site-wide claim. If the sample is too small, the UI says so explicitly rather than showing a number.

## Known Limitations

- Trade ledger and Signal History are per-device (localStorage) — clearing browser storage loses the history, and there is no cross-device or cross-user aggregation.
- The Range selector offers only 15m/30m/60m opening-range windows, not an arbitrary custom period.
- Volume confirmation on a breakout is informational only (shown in the checklist) — it does not gate entry. This was an explicit "optional" requirement, not implemented as a hard filter.
- Breakout Quality's `trendScore` input comes from the existing multi-factor Orb Score module's trend sub-score; if that module hasn't computed a value yet (very early in a session) the Breakout Quality score is computed from fewer inputs and is less precise.
- No real backtest has been run against these exact v1.0 rules — the thresholds are documented design choices, not the output of statistical validation.

## Test Results

`node tests/orb-engine.test.js` — **50 passed, 0 failed.**

Covers 18 of the 25 edge cases from the original audit spec as real behavioral assertions against the actual shipped module (imported via `require()`, not re-implemented). The remaining 7 (premarket exclusion, DST transitions, weekend/holiday gaps, invalid symbol, live feed failure, simulated/live mode mismatch, and part of "duplicate candle") are data-fetch or UI-layer concerns this pure decision module doesn't own — each is documented in the test file with exactly where it's actually verified (`orb-bars.js` code review, or the live headless-Chromium pass) instead of being faked as a passing assertion here.

Also verified live via headless Chromium: a full simulated session stepped through `RANGE_COMPLETE → BREAKOUT_PENDING → RETEST_PENDING → ENTRY_TRIGGERED → STOP_HIT → SESSION_COMPLETE` with zero console/runtime errors, correct deterministic Entry/Stop/Risk/Target/Reward/R:R display, a correctly-populated Setup Summary Card, and a correct trade-ledger write to `localStorage`. A separate run was stepped until it produced a real `NO_TRADE` outcome, confirming the "Why No Trade?" card and live checklist render correctly for that path too.
