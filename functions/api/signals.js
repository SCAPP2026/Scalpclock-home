// Market-wide scalp-signal scanner. Instead of only re-checking a fixed
// watchlist, this builds a dynamic universe from Alpaca's screener
// endpoints (most-active-by-volume + top gainers/losers), scores every
// name in it with the same RSI/VWAP/volume-surge model, and returns only
// the strongest Buy-Calls and Buy-Puts candidates.
//
// ?range=day  (default) — 15-min bars, intraday RSI(14) + VWAP + vol surge.
// ?range=week            — daily bars, RSI(14) over closes + a 20-day
//                           volume-surge check. VWAP is an intraday-
//                           anchored concept and doesn't apply here, so
//                           it's dropped from the weekly score instead of
//                           computing something meaningless.
// ?symbol=TICKER          — look up one specific ticker instead of scanning
//                           the market ("SampsonX" ticker search). Skips
//                           the screener/universe build entirely, reuses
//                           the same RSI/VWAP/volume-surge model, and
//                           returns a verdict even for Hold / lower-
//                           liquidity names instead of filtering them out
//                           the way the market scan does.
export async function onRequest(context) {
  const { env, request } = context;
  const KEY_ID = env.ALPACA_KEY_ID;
  const SECRET = env.ALPACA_SECRET;
  const hdrs   = { 'APCA-API-KEY-ID': KEY_ID, 'APCA-API-SECRET-KEY': SECRET };

  const url    = new URL(request.url);
  const range  = url.searchParams.get('range') === 'week' ? 'week' : 'day';
  const symbolParam = (url.searchParams.get('symbol') || '').toUpperCase().replace(/[^A-Z.\-]/g, '').slice(0, 10);

  const DATA_BASE    = 'https://data.alpaca.markets/v2';
  const SCREEN_BASE  = 'https://data.alpaca.markets/v1beta1/screener/stocks';

  async function safeJson(res) {
    try { return await res.json(); } catch { return {}; }
  }

  const now      = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  // ── Shared math (used by both the single-symbol lookup and the scan) ────
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

  function calcVolSurge(bars, lookback = 20) {
    if (bars.length < 5) return 1;
    const recent    = bars.slice(-lookback);
    const avgVol    = recent.reduce((s, b) => s + b.v, 0) / recent.length;
    const latestVol = bars[bars.length - 1].v;
    return avgVol > 0 ? latestVol / avgVol : 1;
  }

  function getSignal(rsi, vwapDist, volSurge) {
    if (rsi === null) {
      return { tone: 'hold', signal: 'Hold', conviction: null, explain: 'Not enough data yet.', confluence: 0 };
    }
    const volOk = volSurge >= 1.5;
    const hasVwap = vwapDist !== null;

    function buildExtras(bullish) {
      const parts = [];
      if (hasVwap) {
        const vwapOk = bullish ? vwapDist < -0.1 : vwapDist > 0.1;
        if (vwapOk) parts.push(bullish
          ? `${Math.abs(vwapDist).toFixed(1)}% below VWAP`
          : `${Math.abs(vwapDist).toFixed(1)}% above VWAP`);
      }
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

  async function fetchAllBars(baseUrl, maxPages) {
    const merged = {};
    let pageToken = null;
    for (let i = 0; i < maxPages; i++) {
      const pageUrl = pageToken ? `${baseUrl}&page_token=${encodeURIComponent(pageToken)}` : baseUrl;
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

  // ── SampsonX ticker search — one specific symbol, any liquidity ─────────
  if (symbolParam) {
    try {
      let rsi, vwap, volSurge, price, prevClose, latestVol;

      if (range === 'day') {
        const startISO = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
        const prevISO  = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const [latestRes, bars15Res, barsDayRes] = await Promise.all([
          fetch(`${DATA_BASE}/stocks/bars/latest?symbols=${symbolParam}&feed=iex`, { headers: hdrs }),
          fetch(`${DATA_BASE}/stocks/bars?symbols=${symbolParam}&timeframe=15Min&start=${startISO}&limit=200&feed=iex&sort=asc`, { headers: hdrs }),
          fetch(`${DATA_BASE}/stocks/bars?symbols=${symbolParam}&timeframe=1Day&start=${prevISO}&limit=10&feed=iex&sort=asc`, { headers: hdrs }),
        ]);
        const latestBar = ((await safeJson(latestRes)).bars || {})[symbolParam] || null;
        const bars       = ((await safeJson(bars15Res)).bars || {})[symbolParam] || [];
        const dayBars    = ((await safeJson(barsDayRes)).bars || {})[symbolParam] || [];

        if (!bars.length && !latestBar) throw new Error('NO_DATA');

        const recentBars = bars.slice(-50);
        price     = latestBar ? latestBar.c : (recentBars.length ? recentBars[recentBars.length - 1].c : null);
        latestVol = latestBar ? latestBar.v : (recentBars.length ? recentBars[recentBars.length - 1].v : 0);
        prevClose = dayBars.length >= 2 ? dayBars[dayBars.length - 2].c : null;

        rsi      = calcRSI(recentBars);
        vwap     = calcVWAP(bars);
        volSurge = calcVolSurge(bars);
      } else {
        const startISO = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
        const barsRes = await fetch(`${DATA_BASE}/stocks/bars?symbols=${symbolParam}&timeframe=1Day&start=${startISO}&limit=100&feed=iex&sort=asc`, { headers: hdrs });
        const bars = ((await safeJson(barsRes)).bars || {})[symbolParam] || [];

        if (!bars.length) throw new Error('NO_DATA');

        const latest = bars[bars.length - 1];
        price     = latest.c;
        latestVol = latest.v;
        prevClose = bars.length >= 2 ? bars[bars.length - 2].c : null;
        rsi       = calcRSI(bars);
        vwap      = null;
        volSurge  = calcVolSurge(bars, 20);
      }

      if (!price) throw new Error('NO_DATA');

      const vwapDist  = (vwap && price) ? Number((((price - vwap) / vwap) * 100).toFixed(2)) : null;
      const sig        = getSignal(rsi, vwapDist, volSurge);
      const changePct  = (price && prevClose) ? Number((((price - prevClose) / prevClose) * 100).toFixed(2)) : null;
      const lowLiquidity = price < 5 || (latestVol || 0) < 50000;

      let clockOpen = false;
      try {
        const clockRes = await fetch('https://paper-api.alpaca.markets/v2/clock', { headers: hdrs });
        clockOpen = (await safeJson(clockRes)).is_open || false;
      } catch (_) {}

      const sampsonX = rsi === null
        ? `SampsonX says: not enough price history yet on ${symbolParam} to call this one — check back after the market's had more time to trade it.`
        : `SampsonX says: ${sig.signal}${sig.conviction === 'HARD' ? ' (high confidence)' : ''} — ${sig.explain}`;

      return new Response(JSON.stringify({
        marketOpen: clockOpen, asOf: new Date().toISOString(), range,
        symbol: symbolParam,
        result: {
          symbol: symbolParam, ok: true,
          price, changePct: changePct ?? 0,
          rsi: rsi != null ? Number(rsi.toFixed(1)) : null,
          vwap: vwap ? Number(vwap.toFixed(2)) : null,
          vwapDist, volSurge: Number(volSurge.toFixed(2)),
          lowLiquidity,
          ...sig,
        },
        sampsonX,
      }), {
        headers: {
          'Content-Type':                'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control':               'public, s-maxage=20, stale-while-revalidate=10',
        },
      });
    } catch (e) {
      const notFound = e.message === 'NO_DATA';
      return new Response(JSON.stringify({
        symbol: symbolParam,
        result: null,
        sampsonX: notFound
          ? `SampsonX says: no price data found for "${symbolParam}" — double-check the ticker symbol.`
          : `SampsonX says: couldn't pull data for "${symbolParam}" right now — try again in a moment.`,
      }), {
        status: notFound ? 404 : 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  }

  // ── Fallback universe ──────────────────────────────────────────────────
  // Used if the screener endpoints error or aren't entitled on the current
  // Alpaca plan (they serve real-time SIP data, which can require a paid
  // market-data tier beyond the free IEX feed the rest of this file uses).
  // Still a real improvement over the old fixed 20 — broader sector spread.
  const FALLBACK_SYMBOLS = [
    'SPY','QQQ','IWM','DIA',
    'AAPL','MSFT','AMZN','GOOGL','META','NVDA','TSLA','AMD','NFLX',
    'CRM','ORCL','ADBE','INTC','MU','AVGO','CSCO','QCOM','UBER','ABNB','SHOP','SQ','PYPL',
    'JPM','GS','MS','WFC','C','BAC','SCHW',
    'XOM','CVX','OXY','SLB',
    'DIS','NKE','SBUX','MCD','WMT','TGT','COST','HD',
    'PFE','JNJ','UNH','LLY','MRNA',
    'BA','CAT','GE','F','GM',
    'COIN','PLTR','SOFI','ARM','HOOD','RIVN','GME','AMC','MARA','RIOT','NIO',
    'GLD','TLT',
  ];

  const NAMES = {
    SPY:'S&P 500 ETF',QQQ:'Nasdaq 100 ETF',IWM:'Russell 2000 ETF',DIA:'Dow Jones ETF',
    AAPL:'Apple',MSFT:'Microsoft',AMZN:'Amazon',GOOGL:'Alphabet',META:'Meta Platforms',
    NVDA:'Nvidia',TSLA:'Tesla',AMD:'Advanced Micro',NFLX:'Netflix',
    CRM:'Salesforce',ORCL:'Oracle',ADBE:'Adobe',INTC:'Intel',MU:'Micron',AVGO:'Broadcom',
    CSCO:'Cisco',QCOM:'Qualcomm',UBER:'Uber',ABNB:'Airbnb',SHOP:'Shopify',SQ:'Block',PYPL:'PayPal',
    JPM:'JPMorgan Chase',GS:'Goldman Sachs',MS:'Morgan Stanley',WFC:'Wells Fargo',C:'Citigroup',
    BAC:'Bank of America',SCHW:'Charles Schwab',
    XOM:'Exxon Mobil',CVX:'Chevron',OXY:'Occidental Petroleum',SLB:'Schlumberger',
    DIS:'Disney',NKE:'Nike',SBUX:'Starbucks',MCD:"McDonald's",WMT:'Walmart',TGT:'Target',
    COST:'Costco',HD:'Home Depot',
    PFE:'Pfizer',JNJ:'Johnson & Johnson',UNH:'UnitedHealth',LLY:'Eli Lilly',MRNA:'Moderna',
    BA:'Boeing',CAT:'Caterpillar',GE:'GE Aerospace',F:'Ford',GM:'General Motors',
    COIN:'Coinbase',PLTR:'Palantir',SOFI:'SoFi Technologies',ARM:'Arm Holdings',HOOD:'Robinhood Markets',
    RIVN:'Rivian',GME:'GameStop',AMC:'AMC Entertainment',MARA:'Marathon Digital',RIOT:'Riot Platforms',
    NIO:'NIO Inc',GLD:'SPDR Gold ETF',TLT:'20+ Yr Treasury ETF',
  };
  function nameFor(sym) { return NAMES[sym] || sym; }

  // ── Build the scan universe ─────────────────────────────────────────────
  let symbols = [];
  let source  = 'scan';
  try {
    const [actRes, movRes] = await Promise.all([
      fetch(`${SCREEN_BASE}/most-actives?by=volume&top=100`, { headers: hdrs }),
      fetch(`${SCREEN_BASE}/movers?top=50`, { headers: hdrs }),
    ]);
    if (!actRes.ok || !movRes.ok) throw new Error(`screener HTTP ${actRes.status}/${movRes.status}`);
    const act = await safeJson(actRes);
    const mov = await safeJson(movRes);
    const fromActives = (act.most_actives || []).map(t => t.symbol);
    const fromMovers   = [...(mov.gainers || []), ...(mov.losers || [])].map(t => t.symbol);
    symbols = [...new Set([...fromActives, ...fromMovers])].filter(Boolean);
    if (symbols.length < 20) throw new Error('screener returned too few symbols');
  } catch (e) {
    console.error('screener unavailable, using fallback universe:', e.message);
    symbols = FALLBACK_SYMBOLS;
    source  = 'fallback-static';
  }

  // Cap universe size — keeps the multi-symbol bars request and per-request
  // CPU work bounded even if a screener response is unexpectedly large.
  symbols = symbols.slice(0, 220);
  const symList = symbols.join(',');

  let marketOpen = false;
  try {
    const clockRes = await fetch('https://paper-api.alpaca.markets/v2/clock', { headers: hdrs });
    marketOpen = (await safeJson(clockRes)).is_open || false;
  } catch (e) { console.error('clock error:', e.message); }

  // ── Fetch bars for the requested range ──────────────────────────────────
  // More symbols means more pages before every symbol has enough bars for
  // RSI(14) — maxPages is bumped well above the old 20-symbol budget.
  let scored = [];
  const MIN_PRICE  = 5;      // filters penny/illiquid-options noise
  const MIN_VOLUME = 300000; // per-bar-window floor, same intent

  if (range === 'day') {
    const startISO = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const prevISO  = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [latestRes, bars15, barsDay] = await Promise.all([
      fetch(`${DATA_BASE}/stocks/bars/latest?symbols=${symList}&feed=iex`, { headers: hdrs }),
      fetchAllBars(`${DATA_BASE}/stocks/bars?symbols=${symList}&timeframe=15Min&start=${startISO}&limit=10000&feed=iex&sort=asc`, 40),
      fetchAllBars(`${DATA_BASE}/stocks/bars?symbols=${symList}&timeframe=1Day&start=${prevISO}&limit=1000&feed=iex&sort=asc`, 10),
    ]);
    const latestBars = (await safeJson(latestRes)).bars || {};

    for (const sym of symbols) {
      try {
        const bars      = bars15[sym] || [];
        const latestBar = latestBars[sym] || null;
        const dayBars   = barsDay[sym] || [];
        const prevClose = dayBars.length >= 2 ? dayBars[dayBars.length - 2].c : null;

        const recentBars = bars.slice(-50); // ~12.5hrs of 15-min bars — enough for stable RSI(14)
        const price       = latestBar ? latestBar.c : (recentBars.length ? recentBars[recentBars.length - 1].c : null);
        const latestVol   = latestBar ? latestBar.v : (recentBars.length ? recentBars[recentBars.length - 1].v : 0);
        if (!price || price < MIN_PRICE) continue;
        if ((latestVol || 0) < MIN_VOLUME && recentBars.reduce((s,b)=>s+b.v,0) < MIN_VOLUME) continue;

        const rsi      = calcRSI(recentBars);
        const vwap     = calcVWAP(bars);
        const volSurge = calcVolSurge(bars);
        const vwapDist = (vwap && price) ? Number((((price - vwap) / vwap) * 100).toFixed(2)) : null;
        const sig       = getSignal(rsi, vwapDist, volSurge);
        const changePct = (price && prevClose) ? Number((((price - prevClose) / prevClose) * 100).toFixed(2)) : null;

        if (sig.tone === 'hold') continue; // only Buy Calls / Buy Puts candidates compete for the top-10 slots

        scored.push({
          symbol: sym, name: nameFor(sym), ok: true,
          price, changePct: changePct ?? 0,
          rsi: rsi != null ? Number(rsi.toFixed(1)) : null,
          vwap: vwap ? Number(vwap.toFixed(2)) : null,
          vwapDist, volSurge: Number(volSurge.toFixed(2)),
          ...sig,
        });
      } catch (e) { /* skip symbols with malformed data rather than fail the whole scan */ }
    }
  } else {
    // range === 'week' — daily bars, longer lookback for a stable daily RSI(14)
    const startISO = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

    const barsDaily = await fetchAllBars(
      `${DATA_BASE}/stocks/bars?symbols=${symList}&timeframe=1Day&start=${startISO}&limit=10000&feed=iex&sort=asc`, 40
    );

    for (const sym of symbols) {
      try {
        const bars = barsDaily[sym] || [];
        if (bars.length < 15) continue; // not enough daily history for RSI(14)

        const latest     = bars[bars.length - 1];
        const prevClose   = bars.length >= 2 ? bars[bars.length - 2].c : null;
        const price       = latest.c;
        if (!price || price < MIN_PRICE) continue;
        if ((latest.v || 0) < MIN_VOLUME) continue;

        const rsi       = calcRSI(bars);
        const volSurge   = calcVolSurge(bars, 20); // vs 20-day average volume
        const sig        = getSignal(rsi, null, volSurge); // no VWAP at weekly timeframe
        const changePct  = prevClose ? Number((((price - prevClose) / prevClose) * 100).toFixed(2)) : null;

        if (sig.tone === 'hold') continue;

        scored.push({
          symbol: sym, name: nameFor(sym), ok: true,
          price, changePct: changePct ?? 0,
          rsi: rsi != null ? Number(rsi.toFixed(1)) : null,
          vwap: null, vwapDist: null, volSurge: Number(volSurge.toFixed(2)),
          ...sig,
        });
      } catch (e) { /* skip malformed symbols */ }
    }
  }

  // ── Rank and cap ─────────────────────────────────────────────────────────
  function rank(list) {
    return list.sort((a, b) => {
      const hardA = a.conviction === 'HARD' ? 1 : 0;
      const hardB = b.conviction === 'HARD' ? 1 : 0;
      if (hardA !== hardB) return hardB - hardA;
      if (b.confluence !== a.confluence) return b.confluence - a.confluence;
      return b.volSurge - a.volSurge;
    }).slice(0, 10);
  }

  const calls = rank(scored.filter(s => s.tone === 'buy'));
  const puts  = rank(scored.filter(s => s.tone === 'sell'));

  const cacheSeconds = range === 'week' ? 300 : 30;
  return new Response(JSON.stringify({
    marketOpen, asOf: new Date().toISOString(), range,
    universeSize: symbols.length, scannedCount: scored.length, source,
    calls, puts,
  }), {
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${Math.round(cacheSeconds/2)}`,
    },
  });
}
