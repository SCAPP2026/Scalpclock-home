// Market Intelligence Center — "what is moving each ETF" module.
//
//   GET /api/market-intel-movers
//
// For SPY and QQQ: each top holding's move today × its weight in the fund =
// its estimated contribution to the ETF's move, in percentage points. That
// is arithmetic on two facts (weight, price change), so a big company with a
// tiny move can rank below a smaller company with a big one — market cap by
// itself never decides the ranking.
//
// Weights come from functions/lib/etf-holdings-data.js (issuer holdings
// files, refreshed by scripts/update-etf-holdings.py). Each ETF carries its
// own source / method / as-of date and the page prints them. An ETF whose
// weights could not be obtained is returned as unavailable — never guessed.
//
// Headlines are matched to movers by ticker tag from the news providers.
// A matched headline is "news about this company in the same window", not
// proof that it caused the move; the response labels it that way.
import HOLDINGS from '../lib/etf-holdings-data.js';
import { ETFS, marketSession, etParts, round } from '../lib/market-intel.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const SECTORS = {
  XLK: 'Technology', XLF: 'Financials', XLV: 'Health Care', XLY: 'Consumer Discretionary',
  XLP: 'Consumer Staples', XLE: 'Energy', XLI: 'Industrials', XLB: 'Materials',
  XLU: 'Utilities', XLRE: 'Real Estate', XLC: 'Communication Services',
};
const NEWS_WINDOW_H = 48;

export async function onRequest(context) {
  const { env, request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: CORS });

  const nowMs = Date.now();
  const session = marketSession(nowMs);
  const ttl = session.state === 'closed' ? 300 : 60;
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/market-intel-movers?v=1', request.url).toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  if (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET) return json({ ok: false, error: 'Market data provider is not configured.' }, 0);
  const headers = { 'APCA-API-KEY-ID': env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET };

  const tickers = new Set([...ETFS, ...Object.keys(SECTORS)]);
  for (const s of ETFS) for (const h of HOLDINGS.etfs[s]?.holdings || []) tickers.add(h.ticker);
  const stockTickers = [...tickers].filter(t => !ETFS.includes(t) && !SECTORS[t]);

  let snaps;
  try {
    snaps = await fetchSnapshots([...tickers], headers);
  } catch (e) {
    return json({ ok: false, error: `Market data provider error: ${e.message}`, asOf: new Date(nowMs).toISOString() }, 0);
  }
  const quotes = {};
  for (const t of tickers) quotes[t] = quoteFromSnapshot(snaps[t], session);

  const newsStatus = {};
  const news = await collectNews(env, headers, stockTickers, nowMs, newsStatus);

  const weightIn = (etf, ticker) => HOLDINGS.etfs[etf]?.holdings.find(h => h.ticker === ticker)?.weight ?? null;

  const etfs = ETFS.map(symbol => {
    const meta = HOLDINGS.etfs[symbol] || { method: 'unavailable', holdings: [] };
    const etfQuote = quotes[symbol];
    const base = {
      symbol, etfChangePct: etfQuote.changePct,
      holdings: { method: meta.method, source: meta.source, sourceUrl: meta.sourceUrl, asOf: meta.asOf, shown: meta.holdings.length, total: meta.count, coveragePct: meta.coveragePct ?? null },
    };
    if (meta.method === 'unavailable' || !meta.holdings.length) {
      return {
        ...base, available: false, movers: [], explainedPts: null,
        message: symbol === 'IWM'
          ? 'Per-company contribution is not shown for IWM. The Russell 2000 holds about 2,000 small companies — the largest is well under 1% of the fund, so no single stock moves it — and its issuer does not allow automated downloads of the holdings file. Use the sector table and the IWM-vs-SPY comparison instead.'
          : 'Constituent weights for this ETF could not be loaded, so contribution is not shown.',
      };
    }
    const movers = meta.holdings.map(h => {
      const q = quotes[h.ticker];
      const contribution = q.changePct != null ? (h.weight * q.changePct) / 100 : null;
      const headline = news[h.ticker] || null;
      const others = ETFS.filter(x => x !== symbol).map(x => {
        const w = weightIn(x, h.ticker);
        if (w != null) return { etf: x, effect: 'direct', detail: `${w.toFixed(2)}% of ${x}` };
        if (x === 'IWM') return { etf: x, effect: 'indirect', detail: 'Not a Russell 2000 company — any effect on IWM is through overall market mood only.' };
        return { etf: x, effect: 'uncertain', detail: `Not in ${x}'s top ${HOLDINGS.topN} holdings; it may be a smaller position or not held.` };
      });
      return {
        ticker: h.ticker, name: h.name, weight: h.weight,
        price: q.price, priceTs: q.priceTs, changePct: q.changePct,
        contributionPts: round(contribution, 3),
        direction: q.changePct == null ? 'unknown' : q.changePct > 0.05 ? 'up' : q.changePct < -0.05 ? 'down' : 'flat',
        effect: 'direct',
        why: `${h.name} is ${h.weight.toFixed(2)}% of ${symbol}, so its ${q.changePct == null ? 'move' : `${q.changePct > 0 ? '+' : ''}${q.changePct}% move`} ${contribution == null ? 'cannot be sized (no price)' : `adds about ${contribution >= 0 ? '+' : ''}${contribution.toFixed(3)} percentage points to ${symbol}`}.`,
        otherEtfs: others,
        headline,
        quoteNote: q.note,
      };
    });
    const sized = movers.filter(m => m.contributionPts != null);
    sized.sort((a, b) => Math.abs(b.contributionPts) - Math.abs(a.contributionPts));
    const maxAbs = sized.length ? Math.abs(sized[0].contributionPts) : 0;
    for (const m of movers) {
      const a = Math.abs(m.contributionPts ?? 0);
      m.relevance = m.contributionPts == null ? 'unknown' : (maxAbs > 0 && a >= maxAbs * 0.5 && a >= 0.02) ? 'high' : a >= 0.01 ? 'medium' : 'low';
    }
    const explained = sized.reduce((s, m) => s + m.contributionPts, 0);
    return {
      ...base, available: true,
      movers: [...sized, ...movers.filter(m => m.contributionPts == null)],
      explainedPts: round(explained, 2),
      message: `These ${meta.holdings.length} holdings are ${meta.coveragePct}% of the fund. Together they account for about ${explained >= 0 ? '+' : ''}${explained.toFixed(2)} points of ${symbol}'s ${etfQuote.changePct == null ? 'move' : `${etfQuote.changePct > 0 ? '+' : ''}${etfQuote.changePct}% move`}; the rest comes from the other ${Math.max(0, (meta.count || 0) - meta.holdings.length)} holdings.`,
    };
  });

  const sectors = Object.entries(SECTORS).map(([ticker, name]) => ({ ticker, name, changePct: quotes[ticker].changePct, price: quotes[ticker].price }))
    .sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity));

  const body = {
    ok: true, asOf: new Date(nowMs).toISOString(), session,
    etfs, sectors,
    sectorNote: 'Sector SPDR ETFs (large-cap S&P 500 sectors), used as a read on which sectors are leading. Small-cap sector breakdowns are not available from our data.',
    newsStatus,
    newsNote: `Headlines are matched by the ticker tags news providers attach, from the last ${NEWS_WINDOW_H} hours. A matched headline is news about the company — it is not proof of why the stock moved.`,
    priceNote: 'Stock prices are IEX trades; a thinly traded name can show a slightly older last trade than the consolidated tape.',
    methodNote: 'Contribution = holding weight × the stock\'s percentage change. It is an estimate: weights are from the issuer\'s last published holdings and drift during the day.',
  };
  const res = json(body, ttl);
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function fetchSnapshots(symbols, headers) {
  const res = await fetch(`https://data.alpaca.markets/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(','))}&feed=iex`, { headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`snapshots: non-JSON response (HTTP ${res.status})`); }
  if (!res.ok) throw new Error(`snapshots: ${data.message || `HTTP ${res.status}`}`);
  return data.snapshots || data;
}

// Change vs. the previous regular-session close, for the reference session.
function quoteFromSnapshot(s, session) {
  const none = note => ({ price: null, priceTs: null, changePct: null, note });
  if (!s || !s.dailyBar) return none('No data from the provider.');
  const barDate = etParts(Date.parse(s.dailyBar.t) + 12 * 3600 * 1000).date;
  const trade = s.latestTrade ? { p: s.latestTrade.p, t: Date.parse(s.latestTrade.t) } : null;
  const live = session.state === 'regular' || session.state === 'premarket';
  let price, base, priceTs = null, note = null;
  if (barDate === session.refDate) {
    base = s.prevDailyBar ? s.prevDailyBar.c : null;
    if (live && trade) { price = trade.p; priceTs = trade.t; } else price = s.dailyBar.c;
  } else {
    // No bar for the reference session yet (typically premarket).
    base = s.dailyBar.c;
    if (trade && etParts(trade.t).date === session.refDate) { price = trade.p; priceTs = trade.t; }
    else return { price: round(s.dailyBar.c), priceTs: null, changePct: null, note: 'No trades yet this session.' };
  }
  if (price == null || !base) return none('Missing price or previous close.');
  return { price: round(price), priceTs, changePct: round((price / base - 1) * 100, 2), note };
}

// Newest headline per ticker from whichever providers are configured.
async function collectNews(env, alpacaHeaders, tickers, nowMs, status) {
  const want = new Set(tickers);
  const cutoff = nowMs - NEWS_WINDOW_H * 3600 * 1000;
  const sources = [
    ['alpaca', async () => {
      const r = await fetch(`https://data.alpaca.markets/v1beta1/news?symbols=${encodeURIComponent(tickers.join(','))}&limit=50&sort=desc`, { headers: alpacaHeaders });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      return (d.news || []).map(a => ({ title: a.headline, url: a.url, publishedAt: a.created_at, tickers: a.symbols || [], source: a.source ? `${a.source} via Alpaca` : 'Alpaca News' }));
    }],
    ['polygon', async () => {
      if (!env.MASSIVE_API_KEY) throw new Error('not configured');
      const r = await fetch(`https://api.polygon.io/v2/reference/news?limit=100&order=desc&sort=published_utc&apiKey=${env.MASSIVE_API_KEY}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      return (d.results || []).map(a => ({ title: a.title, url: a.article_url, publishedAt: a.published_utc, tickers: a.tickers || [], source: a.publisher?.name ? `${a.publisher.name} via Massive` : 'Massive' }));
    }],
    ['finnhub', async () => {
      if (!env.FINNHUB_KEY) throw new Error('not configured');
      const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${env.FINNHUB_KEY}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      return (Array.isArray(d) ? d : []).map(a => ({ title: a.headline, url: a.url, publishedAt: new Date(a.datetime * 1000).toISOString(), tickers: a.related ? a.related.split(',').map(x => x.trim()).filter(Boolean) : [], source: a.source ? `${a.source} via Finnhub` : 'Finnhub' }));
    }],
  ];
  const results = await Promise.allSettled(sources.map(([, fn]) => fn()));
  const best = {};
  results.forEach((r, i) => {
    const name = sources[i][0];
    if (r.status !== 'fulfilled') { status[name] = `unavailable (${r.reason?.message || 'error'})`; return; }
    status[name] = `ok (${r.value.length} articles)`;
    for (const a of r.value) {
      const ts = Date.parse(a.publishedAt);
      if (!a.title || !a.url || !Number.isFinite(ts) || ts < cutoff) continue;
      // Skip round-ups tagged with a long list of tickers — they are rarely
      // about any one company.
      if (a.tickers.length > 6) continue;
      for (const t of a.tickers) {
        if (!want.has(t)) continue;
        if (!best[t] || ts > best[t].ts) best[t] = { title: a.title, url: a.url, publishedAt: new Date(ts).toISOString(), source: a.source, ts };
      }
    }
  });
  for (const t of Object.keys(best)) delete best[t].ts;
  return best;
}

function json(data, ttl) {
  return new Response(JSON.stringify(data), {
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': ttl > 0 ? `public, max-age=${ttl}` : 'no-store' },
  });
}
