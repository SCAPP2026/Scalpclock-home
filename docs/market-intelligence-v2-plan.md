# Market Intelligence v2 — audit and build plan (2026-11-10)

Source spec: "CLAUDE MASTER BUILD INSTRUCTIONS — ScalpClock Market Intelligence & Daily Options Decision Engine" (16 phases).
This file covers spec steps 1–3: audit, reusable parts, plan, and paid data.

## 1. What already exists (shipped 2026-10-09)

`/market-intelligence` — free, no login. 93/93 unit tests pass (`node tests/market-intel.test.mjs`).

| File | Role |
|---|---|
| `functions/api/market-intel.js` | Core endpoint. Alpaca IEX daily + 5-min bars and latest trades for SPY/QQQ/IWM. Edge-cached 20s open / 300s closed. No fallback numbers. |
| `functions/lib/market-intel.js` | Pure analysis: ET session/holiday/early-close calendar, EMA/SMA/RSI/ATR/VWAP, relative volume, trend per timeframe, levels, 8-part scoring, call/put/no-trade scenarios, outlooks. |
| `functions/lib/market-intel-calendar.js` | FRED catalyst calendar (CPI, PPI, PCE, jobs, claims, GDP, retail sales, yields), FOMC dates hardcoded through 2027-12-08, impact tags, post-release market reaction. |
| `functions/api/market-intel-movers.js` | Top holdings moving each ETF (weights refreshed weekly by GitHub Action). |
| `functions/api/options.js` | CBOE delayed chain → per-ETF IV, put/call volume and OI (aggregates only). |
| `functions/lib/paper.js` | CBOE chain reader that avoids the 1102 CPU limit; `/api/paper/chain` serves per-expiry contracts. |

Other systems the new phases plug into:
- **Journal**: `public.trades` (symbol, direction, entry/exit, pnl, contracts, strike, expiry, notes, tags, strategy, setup_grade, trade_score…), written only by `journal.html`.
- **XP/badges**: `profiles.learn_progress` jsonb + localStorage `sc_learn_xp`, union-merge sync (`syncJournalXP` in journal.html).
- **Admin**: `functions/api/admin/*` verify `app_metadata.is_admin` server-side.
- **Subscription**: `profiles.plan` / `tier` written by the Stripe webhook; client paywalls in signals/scalpchart/exitassistant.

## 2. Spec coverage

| Phase | Status | Gap |
|---|---|---|
| 1 Dashboard | Mostly done | 50 **EMA** (currently 50-day SMA), intraday 50 EMA, explicit "Real-time (IEX)" / "Delayed" / "End of day" badge per field, overnight high/low. |
| 2 Catalysts | Mostly done | Consensus estimates and auctions not available from free sources (kept as DATA UNAVAILABLE); geopolitical/news impact tagging is not reliable without a paid news feed. |
| 3 Trend engine | Partial | 3-state bias → 5-state (STRONG BULLISH … STRONG BEARISH); add higher-high/higher-low structure detection and "what invalidates this". |
| 4 Levels | Mostly done | Classic pivots (P/R1/R2/S1/S2), overnight levels, **member-saved levels** (new table) and push to ScalpCharts. |
| 5 Options intelligence | Aggregates only | Full chain browser per expiry with bid/ask/mid/spread/IV/Δ/Γ/Θ/V/vol/OI; unusual-activity flags (vol/OI, wide spread, illiquid). CBOE file has these fields. OI *change* needs a daily snapshot we store ourselves. |
| 6 Call vs put score | Different model | Replace ±8 component score with the spec's 100-point **separate** bull and bear scores, missing data shown as reduced coverage (no redistribution), thresholds/weights configurable. |
| 7 Contract selector | Missing | New. |
| 8 Entry confirmation | Partial (static checklist) | State machine: developing → confirmed → invalidated → expired, triggered by 5-min close events. |
| 9 Risk + Exit Assistant | Missing here | Position/risk calculator, daily limits (saved per member), hand-off to Exit Assistant and journal. |
| 10 Daily briefing | Partial (outlooks) | Generated + **saved** daily (premarket and intraday snapshots), archive, "What would change the outlook?". |
| 11 Journal | Exists separately | Additive nullable columns on `trades` (setup, evidence score at entry, rules_followed, entry/exit time) + MI stats view. No changes to existing rows. |
| 12 XP | Missing here | New XP events/badges, additive only, same union-merge sync. |
| 13 Data layer | Single provider, inline | Provider-independent adapter with the standard record shape (instrument, type, value, ts, provider, timeliness, quality). |
| 14 Admin | Missing | `admin-market-intel.html`: provider health, last update, errors, weights/thresholds, enabled instruments. |
| 15 Gating | Page is free by earlier decision | Needs a decision (see §4). |
| 16 Tests | Good base | Extend unit + browser tests per phase; run integrity check before/after each migration. |

## 3. Build order

- **A. Engine** (no DB): data adapter, 50 EMA, pivots, structure detection, 5-state trend, 100-point bull/bear scoring, confirmation state machine. Tests first.
- **B. Options**: chain browser, liquidity/unusual flags, contract selector and comparison. Daily OI snapshot table.
- **C. Member features** (additive migrations, backup + integrity check): saved levels, risk settings, briefings archive, journal columns, XP events.
- **D. Admin + gating**: admin page, config table for weights/thresholds, server-side entitlement check.

## 4. Data and licensing (needs owner action)

- **Alpaca IEX (current)**: free tier, one exchange only. Alpaca's market-data terms must be checked for showing data to *paying* third parties; a redistribution/display agreement is commonly required for commercial display.
- **CBOE delayed quotes (current)**: public website JSON, not a licensed feed. Fine for prototyping; not a basis for a paid product without a license.
- **Licensed options for members** (quote needed — commercial display pricing is negotiated, not list price): Polygon.io (Massive) business plans, Tradier market data, ThetaData, Intrinio, Cboe DataShop/LiveVol. Each adds OPRA vendor/display fees for real-time.
- **Economic consensus**: Trading Economics or similar paid API; otherwise consensus stays DATA UNAVAILABLE.
- **FRED**: free, attribution shown — fine.

Until a licensed feed is in place, everything stays labeled with its true source and delay.

## 5. Status (2026-11-12)

**Phase A shipped.** Evidence Engine (`functions/lib/market-intel-evidence.js`): separate 100-point bull/bear scores over eight weighted checks, five-state condition, setup label (CALL/PUT SETUP DEVELOPING, CONFIRMATION REQUIRED, NO TRADE, MARKET TOO VOLATILE, INSUFFICIENT DATA), entry-confirmation state machine on 5-minute closes, reasons and invalidation. Free build also gained classic pivots (P/R1/S1/R2/S2), overnight high/low and the daily 50 EMA.

**Gating decided: Evidence Engine is PRO.** `/api/market-intel` strips `PRO_FIELDS` (`publicBody`); `/api/market-intel-pro` verifies the Supabase token server-side (`functions/lib/entitlement.js`: plan not free/expired, or admin) and serves them from the same cached build (`loadCoreBody`). Locked view shows no numbers. The rest of the page stays free.

**Known gap:** the options-liquidity check (5 pts) has no data source wired — reading the full CBOE chain in this endpoint risks the 1102 CPU limit. It shows "No data" and caps coverage at 95.

Tests: `tests/market-intel-evidence.test.mjs` (46), browser access states in `tests/levels-premarket.browser.test.mjs`.

**Still open:** B (options chain browser, contract selector, OI snapshots), C (member features — additive migrations with backup + integrity check), D (admin page, configurable weights), and the provider-independent data adapter (spec 13).
