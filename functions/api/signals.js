export async function onRequest(context) {
  const { env } = context;
  const KEY_ID = env.ALPACA_KEY_ID;
  const SECRET = env.ALPACA_SECRET;

  // Top 20 highest-volume options tickers — 15-min RSI signals
  const SYMBOLS = [
    'SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META',
    'NVDA', 'TSLA', 'AMD', 'NFLX', 'COIN', 'PLTR', 'SOFI', 'ARM',
    'GLD', 'BAC', 'CVX', 'HOOD',
  ];

  const NAMES = {
    SPY:  'S&P 500 ETF',       QQQ:  'Nasdaq 100 ETF',
    IWM:  'Russell 2000 ETF',  AAPL: 'Apple',
    MSFT: 'Microsoft',         AMZN: 'Amazon',
    GOOGL: 'Alphabet',         META: 'Meta Platforms',
    NVDA: 'Nvidia',            TSLA: 'Tesla',
    AMD:  'Advanced Micro',    NFLX: 'Netflix',
    COIN: 'Coinbase',          PLTR: 'Palantir',
    SOFI: 'SoFi Technologies', ARM:  'Arm Holdings',
    GLD:  'SPDR Gold ETF',     BAC:  'Bank of America',
    CVX:  'Chevron',           HOOD: 'Robinhood Markets',
  };

  const hdrs = {
    'APCA-API-KEY-ID':     KEY_ID,
    'APCA-API-SECRET-KEY': SECRET,
  };
  const BASE    = 'https://data.alpaca.markets/v2';
  const symList = SYMBOLS.join(',');

  const now     = new Date();
  const startISO = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const prevISO  = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const todayStr = now.toISOString().slice(0, 10);

  async function safeJson(res) {
    try { return await res.json(); } catch { return {}; }
  }

  let marketOpen = false;
  let allBars = {}, latestBars = {}, prevCloseBars = {};

  // Multi-symbol bars endpoints paginate when the combined row count exceeds
  // `limit` — with 20 symbols that happens well before every symbol gets
  // enough bars for RSI(14), so we must follow next_page_token or some
  // symbols silently come back empty.
  async function fetchAllBars(url, maxPages = 6) {
    const merged = {};
    let pageToken = null;
    for (let i = 0; i < maxPages; i++) {
      const pageUrl = pageToken ? `${url}&page_token=${encodeURIComponent(pageToken)}` : url;
      const res  = await fetch(pageUrl, { headers: hdrs });
      const data = await safeJson(res);
      const bars = data.bars || {};
      for (const sym of Object.keys(bars)) {
        (merged[sym] = merged[sym] || []).push(...bars[sym]);
      }
      pageToken = data.next_page_token || null;
      if (!pageToken) break;
    }
    return merged;
  }

  const [clockRes, latestRes, bars15, barsDay] = await Promise.all([
    fetch('https://paper-api.alpaca.markets/v2/clock', { headers: hdrs }),
    fetch(`${BASE}/stocks/bars/latest?symbols=${symList}&feed=iex`, { headers: hdrs }),
    fetchAllBars(`${BASE}/stocks/bars?symbols=${symList}&timeframe=15Min&start=${startISO}&limit=10000&feed=iex&sort=asc`),
    fetchAllBars(`${BASE}/stocks/bars?symbols=${symList}&timeframe=1Day&start=${prevISO}&limit=1000&feed=iex&sort=asc`),
  ]);

  try {
    const clock = await safeJson(clockRes);
    marketOpen = clock.is_open || false;
  } catch(e) { console.error('clock error:', e.message); }

  allBars = bars15;

  try {
    const data = await safeJson(latestRes);
    latestBars = data.bars || {};
  } catch(e) { console.error('latest error:', e.message); }

  prevCloseBars = barsDay;

  function calcRSI(bars, period = 14) {
    const closes = bars.map(b => b.c);
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gains += d; else losses -= d;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    }
    return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  function calcVWAP(bars) {
    const todayBars = bars.filter(b => b.t.startsWith(todayStr));
    if (todayBars.length === 0) return null;
    let tpvSum = 0, volSum = 0;
    for (const b of todayBars) {
      const tp = (b.h + b.l + b.c) / 3;
      tpvSum += tp * b.v;
      volSum  += b.v;
    }
    return volSum > 0 ? tpvSum / volSum : null;
  }

  function calcVolSurge(bars) {
    if (bars.length < 5) return 1;
    const recent    = bars.slice(-20);
    const avgVol    = recent.reduce((s, b) => s + b.v, 0) / recent.length;
    const latestVol = bars[bars.length - 1].v;
    return avgVol > 0 ? latestVol / avgVol : 1;
  }

  function getSignal(rsi, vwapDist, volSurge) {
    if (rsi === null) {
      return { tone: 'hold', signal: 'Hold', conviction: null, explain: 'Not enough data yet.', confluence: 0 };
    }
    const volOk = volSurge >= 1.5;

    function buildExtras(bullish) {
      const parts = [];
      const vwapOk = bullish ? vwapDist < -0.1 : vwapDist > 0.1;
      if (vwapOk) parts.push(bullish
        ? `${Math.abs(vwapDist).toFixed(1)}% below VWAP`
        : `${Math.abs(vwapDist).toFixed(1)}% above VWAP`);
      if (volOk) parts.push(`vol ×${volSurge.toFixed(1)}`);
      return parts;
    }

    if (rsi <= 20) {
      const extras = buildExtras(true);
      const suffix = extras.length ? ` · ${extras.join(', ')}` : '';
      return { tone: 'buy', signal: 'Buy Calls', conviction: 'HARD',
        explain: `RSI ${rsi.toFixed(1)}${suffix} — price dropped hard and is likely to bounce. Strong call setup.`,
        confluence: 1 + extras.length };
    }
    if (rsi <= 30) {
      const extras = buildExtras(true);
      const suffix = extras.length ? ` · ${extras.join(', ')}` : '';
      return { tone: 'buy', signal: 'Buy Calls', conviction: extras.length >= 2 ? 'HARD' : null,
        explain: `RSI ${rsi.toFixed(1)}${suffix} — price has pulled back. Calls are the play here.`,
        confluence: 1 + extras.length };
    }
    if (rsi >= 80) {
      const extras = buildExtras(false);
      const suffix = extras.length ? ` · ${extras.join(', ')}` : '';
      return { tone: 'sell', signal: 'Buy Puts', conviction: 'HARD',
        explain: `RSI ${rsi.toFixed(1)}${suffix} — price ran up too far too fast. Strong put setup.`,
        confluence: 1 + extras.length };
    }
    if (rsi >= 70) {
      const extras = buildExtras(false);
      const suffix = extras.length ? ` · ${extras.join(', ')}` : '';
      return { tone: 'sell', signal: 'Buy Puts', conviction: extras.length >= 2 ? 'HARD' : null,
        explain: `RSI ${rsi.toFixed(1)}${suffix} — price is stretched. Puts have the edge.`,
        confluence: 1 + extras.length };
    }
    return { tone: 'hold', signal: 'Hold', conviction: null,
      explain: `RSI ${rsi.toFixed(1)} — price is in the middle. No clear edge yet — wait for a better setup.`,
      confluence: 0 };
  }

  const tickers = SYMBOLS.map(sym => {
    try {
      const bars      = allBars[sym]      || [];
      const latestBar = latestBars[sym]   || null;
      const dayBars   = prevCloseBars[sym] || [];
      const prevClose = dayBars.length >= 2 ? dayBars[dayBars.length - 2].c : null;

      // 50 × 15-min bars ≈ 12.5 hours — enough for stable RSI(14)
      const recentBars = bars.slice(-50);
      const rsi        = calcRSI(recentBars);
      const vwap       = calcVWAP(bars);
      const volSurge   = calcVolSurge(bars);
      const price      = latestBar ? latestBar.c : (recentBars.length ? recentBars[recentBars.length - 1].c : null);
      const vwapDist   = (vwap && price) ? ((price - vwap) / vwap * 100) : 0;
      const sig        = getSignal(rsi, vwapDist, volSurge);
      const changePct  = (price && prevClose)
        ? ((price - prevClose) / prevClose * 100).toFixed(2) : null;

      return {
        symbol:    sym,
        name:      NAMES[sym],
        ok:        true,
        price,
        changePct: changePct ? Number(changePct) : 0,
        rsi:       rsi != null ? Number(rsi.toFixed(1)) : null,
        vwap:      vwap ? Number(vwap.toFixed(2)) : null,
        vwapDist:  Number(vwapDist.toFixed(2)),
        volSurge:  Number(volSurge.toFixed(2)),
        ...sig,
      };
    } catch(e) {
      return { symbol: sym, name: NAMES[sym], ok: false };
    }
  });

  return new Response(JSON.stringify({ marketOpen, asOf: new Date().toISOString(), tickers }), {
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, s-maxage=30, stale-while-revalidate=15',
    },
  });
}
