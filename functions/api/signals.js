export async function onRequest(context) {
  const { env } = context;
  const KEY_ID = env.ALPACA_KEY_ID;
  const SECRET = env.ALPACA_SECRET;

  const SYMBOLS = [
    'SPY','QQQ','IWM','AAPL','MSFT','AMZN','GOOGL','META',
    'NVDA','TSLA','AMD','NFLX','COIN','PLTR','SOFI','ARM',
    'GOLD','JPM','XOM','RIOT',
  ];

  const NAMES = {
    SPY:'S&P 500 ETF', QQQ:'Nasdaq 100 ETF', IWM:'Russell 2000 ETF',
    AAPL:'Apple', MSFT:'Microsoft', AMZN:'Amazon', GOOGL:'Alphabet',
    META:'Meta Platforms', NVDA:'Nvidia', TSLA:'Tesla',
    AMD:'Advanced Micro Devices', NFLX:'Netflix', COIN:'Coinbase',
    PLTR:'Palantir', SOFI:'SoFi Technologies', ARM:'Arm Holdings',
    GOLD:'Barrick Gold', JPM:'JPMorgan Chase', XOM:'ExxonMobil', RIOT:'Riot Platforms',
  };

  const headers = {
    'APCA-API-KEY-ID':     KEY_ID,
    'APCA-API-SECRET-KEY': SECRET,
  };
  const BASE = 'https://data.alpaca.markets/v2';

  let marketOpen = false;
  try {
    const clockRes = await fetch('https://paper-api.alpaca.markets/v2/clock', { headers });
    const clock = await clockRes.json();
    marketOpen = clock.is_open;
  } catch (e) { console.error('clock fetch failed:', e.message); }

  const now      = new Date();
  const startISO = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const todayStr = now.toISOString().slice(0, 10);

  async function safeJson(res) {
    if (!res.ok) return {};
    try { return await res.json(); } catch { return {}; }
  }

  async function fetchBars(symbol) {
    const url = `${BASE}/stocks/${symbol}/bars?timeframe=5Min&start=${startISO}&limit=200&feed=iex`;
    const res  = await fetch(url, { headers });
    const data = await safeJson(res);
    return data.bars || [];
  }

  async function fetchLatestBar(symbol) {
    const url  = `${BASE}/stocks/${symbol}/bars/latest?feed=iex`;
    const res  = await fetch(url, { headers });
    const data = await safeJson(res);
    return data.bar || null;
  }

  async function fetchPrevDayBar(symbol) {
    const url  = `${BASE}/stocks/${symbol}/bars?timeframe=1Day&start=${new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()}&limit=2&feed=iex`;
    const res  = await fetch(url, { headers });
    const data = await safeJson(res);
    const bars = data.bars || [];
    return bars.length >= 2 ? bars[bars.length - 2].c : null;
  }

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
    const recent = bars.slice(-20);
    const avgVol = recent.reduce((s, b) => s + b.v, 0) / recent.length;
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
        explain: `RSI ${rsi.toFixed(1)}${suffix} — extremely oversold. Strong call setup.`,
        confluence: 1 + extras.length };
    }
    if (rsi <= 30) {
      const extras = buildExtras(true);
      const upgrade = extras.length >= 2;
      const suffix = extras.length ? ` · ${extras.join(', ')}` : '';
      return { tone: 'buy', signal: 'Buy Calls', conviction: upgrade ? 'HARD' : null,
        explain: `RSI ${rsi.toFixed(1)}${suffix} — oversold. Calls have the edge.`,
        confluence: 1 + extras.length };
    }
    if (rsi >= 80) {
      const extras = buildExtras(false);
      const suffix = extras.length ? ` · ${extras.join(', ')}` : '';
      return { tone: 'sell', signal: 'Buy Puts', conviction: 'HARD',
        explain: `RSI ${rsi.toFixed(1)}${suffix} — extremely overbought. Strong put setup.`,
        confluence: 1 + extras.length };
    }
    if (rsi >= 70) {
      const extras = buildExtras(false);
      const upgrade = extras.length >= 2;
      const suffix = extras.length ? ` · ${extras.join(', ')}` : '';
      return { tone: 'sell', signal: 'Buy Puts', conviction: upgrade ? 'HARD' : null,
        explain: `RSI ${rsi.toFixed(1)}${suffix} — overbought. Puts have the edge.`,
        confluence: 1 + extras.length };
    }
    return { tone: 'hold', signal: 'Hold', conviction: null,
      explain: `RSI ${rsi.toFixed(1)} — neutral zone. No edge right now.`,
      confluence: 0 };
  }

  const tickers = await Promise.all(SYMBOLS.map(async (sym) => {
    try {
      const [bars, latestBar, prevClose] = await Promise.all([
        fetchBars(sym),
        fetchLatestBar(sym),
        fetchPrevDayBar(sym),
      ]);

      const recentBars = bars.slice(-30);
      const rsi        = calcRSI(recentBars);
      const vwap       = calcVWAP(bars);
      const volSurge   = calcVolSurge(bars);
      const price      = latestBar ? latestBar.c : (recentBars.length ? recentBars[recentBars.length - 1].c : null);
      const vwapDist   = (vwap && price) ? ((price - vwap) / vwap * 100) : 0;
      const sig        = getSignal(rsi, vwapDist, volSurge);

      const changePct = (price && prevClose)
        ? ((price - prevClose) / prevClose * 100).toFixed(2)
        : null;

      return {
        symbol:    sym,
        name:      NAMES[sym],
        ok:        true,
        price,
        changePct: changePct ? Number(changePct) : 0,
        rsi:       rsi != null ? Number(rsi.toFixed(1)) : 50,
        vwap:      vwap ? Number(vwap.toFixed(2)) : null,
        vwapDist:  Number(vwapDist.toFixed(2)),
        volSurge:  Number(volSurge.toFixed(2)),
        ...sig,
      };
    } catch (e) {
      return { symbol: sym, name: NAMES[sym], ok: false };
    }
  }));

  return new Response(JSON.stringify({ marketOpen, asOf: new Date().toISOString(), tickers }), {
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-store',
    },
  });
}
