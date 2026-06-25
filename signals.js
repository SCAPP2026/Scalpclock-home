// ScalpClock live signal engine (Cloudflare Pages Function)
// Real market data from Yahoo Finance, server-side (no CORS, key-free).
// RSI ported from the proven Wilder's-smoothing logic in hustleos-trading-bot/strategy.py.
// Cached ~12s via the edge cache so it stays fast and light. This replaces the old Math.random fakery.

const TICKERS = ["SPY", "QQQ", "TSLA", "NVDA", "IWM", "AAPL"];
const NAMES = {
  SPY: "S&P 500 ETF",
  QQQ: "Nasdaq 100 ETF",
  TSLA: "Tesla",
  NVDA: "Nvidia",
  IWM: "Russell 2000 ETF",
  AAPL: "Apple",
};
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const CACHE_SECONDS = 12;

// Wilder's-smoothing RSI. Returns 0..100. Direct port of strategy.py calculate_rsi.
function calcRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  const deltas = [];
  for (let i = 1; i < prices.length; i++) deltas.push(prices[i] - prices[i - 1]);
  const gains = deltas.map((d) => Math.max(d, 0));
  const losses = deltas.map((d) => Math.max(-d, 0));
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

// Map RSI to the options-direction signal ScalpClock uses (calls / puts / hold) with conviction.
function signalFrom(rsi) {
  if (rsi <= 20) return { dir: "BUY CALLS", conviction: "HARD", tone: "buy" };
  if (rsi < 30) return { dir: "BUY CALLS", conviction: "", tone: "buy" };
  if (rsi >= 80) return { dir: "BUY PUTS", conviction: "HARD", tone: "sell" };
  if (rsi > 70) return { dir: "BUY PUTS", conviction: "", tone: "sell" };
  return { dir: "HOLD", conviction: "", tone: "hold" };
}

function plainEnglish(rsi, tone) {
  if (tone === "buy")
    return `RSI ${rsi} is oversold. Selling looks exhausted and price is stretched to the downside, so a bounce is the higher-odds move. Calls favored.`;
  if (tone === "sell")
    return `RSI ${rsi} is overbought. Buyers are stretched up here and momentum is fading, so a pullback is the higher-odds move. Puts favored.`;
  return `RSI ${rsi} is neutral. No clean edge right now. Wait for a stretch toward 30 (calls) or 70 (puts).`;
}

// Rough US market-session check in Eastern time (covers EST/EDT via fixed offsets is unreliable,
// so we use Intl to read the wall-clock hour in America/New_York).
function marketOpen(now) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const day = parts.weekday;
  const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  const weekday = !["Sat", "Sun"].includes(day);
  return weekday && mins >= 570 && mins < 960; // 9:30 to 16:00 ET
}

async function fetchTicker(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=5m&range=1d`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, cf: { cacheTtl: CACHE_SECONDS } });
    if (!r.ok) throw new Error(`yahoo ${r.status}`);
    const j = await r.json();
    const res = j.chart && j.chart.result && j.chart.result[0];
    if (!res) throw new Error("no result");
    const closes = ((res.indicators.quote[0] || {}).close || []).filter((x) => x != null);
    const meta = res.meta || {};
    const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : closes[closes.length - 1];
    const prev = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
    const changePct = prev ? ((price - prev) / prev) * 100 : 0;
    const rsi = calcRSI(closes);
    const sig = signalFrom(rsi);
    return {
      symbol: sym,
      name: NAMES[sym] || sym,
      price: price != null ? Math.round(price * 100) / 100 : null,
      changePct: Math.round(changePct * 100) / 100,
      rsi,
      signal: sig.dir,
      conviction: sig.conviction,
      tone: sig.tone,
      explain: plainEnglish(rsi, sig.tone),
      ok: true,
    };
  } catch (e) {
    return { symbol: sym, name: NAMES[sym] || sym, ok: false, error: String(e) };
  }
}

export async function onRequestGet(context) {
  const { request } = context;
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/signals", request.url).toString(), request);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const now = new Date();
  const tickers = await Promise.all(TICKERS.map(fetchTicker));
  const body = JSON.stringify({
    asOf: now.toISOString(),
    marketOpen: marketOpen(now),
    source: "Yahoo Finance",
    indicator: "RSI(14), Wilder's smoothing, 5m bars",
    tickers,
  });
  const resp = new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
      "access-control-allow-origin": "*",
    },
  });
  context.waitUntil(cache.put(cacheKey, resp.clone()));
  return resp;
}
