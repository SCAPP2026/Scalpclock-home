export async function onRequest(context) {
  const { env } = context;

  const KEY_ID = env.ALPACA_KEY_ID;
  const SECRET = env.ALPACA_SECRET;

  const SYMBOLS = ['SPY', 'QQQ', 'TSLA', 'NVDA', 'IWM', 'AAPL'];

  const NAMES = {
    SPY:  'S&P 500 ETF',
    QQQ:  'Nasdaq 100 ETF',
    TSLA: 'Tesla',
    NVDA: 'Nvidia',
    IWM:  'Russell 2000 ETF',
    AAPL: 'Apple',
  };

  const headers = {
    'APCA-API-KEY-ID':     KEY_ID,
    'APCA-API-SECRET-KEY': SECRET,
  };

  // Alpaca market data base URL
  const BASE = 'https://data.alpaca.markets/v2';

  // Check if market is open
  let marketOpen = false;
  try {
    const clockRes = await fetch('https://paper-api.alpaca.markets/v2/clock', { headers });
    const clock = await clockRes.json();
    marketOpen = clock.is_open;
  } catch (e) {}

  // Fetch 5-min bars for RSI(14) — need at least 15 bars
  const now   = new Date();
  const start = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
  const startISO = start.toISOString();

  async function fetchBars(symbol) {
    const url = `${BASE}/stocks/${symbol}/bars?timeframe=5Min&start=${startISO}&limit=30&feed=iex`;
    const res = await fetch(url, { headers });
    const data = await res.json();
    return (data.bars || []).map(b => b.c); // closing prices
  }

  function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const g = diff >= 0 ? diff : 0;
      const l = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  function getSignal(rsi) {
    if (rsi === null) return { tone: 'hold', signal: 'Hold', conviction: null, explain: 'Not enough data yet.' };
    if (rsi <= 20) return { tone: 'buy',  signal: 'Buy Calls', conviction: 'HARD', explain: `RSI ${rsi.toFixed(1)} — extremely oversold. Strong call setup.` };
    if (rsi <= 30) return { tone: 'buy',  signal: 'Buy Calls', conviction: null,   explain: `RSI ${rsi.toFixed(1)} — oversold. Calls have the edge.` };
    if (rsi >= 80) return { tone: 'sell', signal: 'Buy Puts',  conviction: 'HARD', explain: `RSI ${rsi.toFixed(1)} — extremely overbought. Strong put setup.` };
    if (rsi >= 70) return { tone: 'sell', signal: 'Buy Puts',  conviction: null,   explain: `RSI ${rsi.toFixed(1)} — overbought. Puts have the edge.` };
    return { tone: 'hold', signal: 'Hold', conviction: null, explain: `RSI ${rsi.toFixed(1)} — neutral zone. No edge right now.` };
  }

  // Fetch latest quotes for price + change
  async function fetchQuote(symbol) {
    const url = `${BASE}/stocks/${symbol}/quotes/latest?feed=iex`;
    const res = await fetch(url, { headers });
    const data = await res.json();
    return data.quote || null;
  }

  async function fetchPrevClose(symbol) {
    const url = `${BASE}/stocks/${symbol}/bars/latest?timeframe=1Day&feed=iex`;
    const res = await fetch(url, { headers });
    const data = await res.json();
    return data.bar?.c || null;
  }

  const tickers = await Promise.all(SYMBOLS.map(async (sym) => {
    try {
      const [closes, quote, prevClose] = await Promise.all([
        fetchBars(sym),
        fetchQuote(sym),
        fetchPrevClose(sym),
      ]);

      const rsi   = calcRSI(closes);
      const sig   = getSignal(rsi);
      const price = quote ? (quote.ap + quote.bp) / 2 : null;
      const changePct = (price && prevClose)
        ? ((price - prevClose) / prevClose * 100).toFixed(2)
        : null;

      return {
        symbol:     sym,
        name:       NAMES[sym],
        ok:         true,
        price,
        changePct:  changePct ? Number(changePct) : 0,
        rsi:        rsi ? Number(rsi.toFixed(1)) : 50,
        ...sig,
      };
    } catch (e) {
      return { symbol: sym, name: NAMES[sym], ok: false };
    }
  }));

  const body = JSON.stringify({ marketOpen, asOf: new Date().toISOString(), tickers });

  return new Response(body, {
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-store',
    },
  });
}
