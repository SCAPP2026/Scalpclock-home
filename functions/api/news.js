const SOURCE_META = {
  polygon:          { label: 'Polygon',     color: '#a78bfa' },
  finnhub:          { label: 'Finnhub',     color: '#60a5fa' },
  fmp:              { label: 'FMP',         color: '#22d3ee' },
  benzinga:         { label: 'Benzinga',    color: '#f59e0b' },
  newsapi:          { label: 'NewsAPI',     color: '#f97316' },
  tradingeconomics: { label: 'Trading Eco', color: '#fb7185' },
};

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const results = await Promise.allSettled([
    fetchPolygon(env.MASSIVE_API_KEY),
    fetchFinnhub(env.FINNHUB_KEY),
    fetchFMP(env.FMP_KEY),
    fetchBenzinga(env.BENZINGA_KEY),
    fetchNewsAPI(env.NEWSAPI_KEY),
    fetchTradingEconomics(env.TE_KEY),
  ]);

  const articles = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      articles.push(...r.value);
    }
  }

  articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  return new Response(JSON.stringify({ articles: articles.slice(0, 60) }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=120, s-maxage=120',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function norm(source, { title, summary, url, publishedAt, tickers = [] }) {
  const { label, color } = SOURCE_META[source];
  return { source, sourceLabel: label, color, title, summary: summary || '', url, publishedAt, tickers };
}

async function fetchPolygon(key) {
  if (!key) return [];
  const r = await fetch(
    `https://api.polygon.io/v2/reference/news?limit=20&order=desc&sort=published_utc&apiKey=${key}`
  );
  const d = await r.json();
  return (d.results || []).map(a => norm('polygon', {
    title: a.title,
    summary: a.description,
    url: a.article_url,
    publishedAt: a.published_utc,
    tickers: a.tickers || [],
  }));
}

async function fetchFinnhub(key) {
  if (!key) return [];
  const r = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${key}`);
  const d = await r.json();
  return (Array.isArray(d) ? d : []).slice(0, 20).map(a => norm('finnhub', {
    title: a.headline,
    summary: a.summary,
    url: a.url,
    publishedAt: new Date(a.datetime * 1000).toISOString(),
    tickers: a.related ? a.related.split(',').map(s => s.trim()).filter(Boolean) : [],
  }));
}

async function fetchFMP(key) {
  if (!key) return [];
  const tickers = 'SPY,QQQ,AAPL,NVDA,TSLA,MSFT,AMZN,META,AMD,GOOGL';
  const r = await fetch(
    `https://financialmodelingprep.com/api/v3/stock_news?tickers=${tickers}&limit=20&apikey=${key}`
  );
  const d = await r.json();
  return (Array.isArray(d) ? d : []).map(a => norm('fmp', {
    title: a.title,
    summary: a.text,
    url: a.url,
    publishedAt: new Date(a.publishedDate).toISOString(),
    tickers: a.symbol ? [a.symbol] : [],
  }));
}

async function fetchBenzinga(key) {
  if (!key) return [];
  const r = await fetch(
    `https://api.benzinga.com/api/v2/news?token=${key}&pagesize=20&displayOutput=abstract`
  );
  const d = await r.json();
  const items = Array.isArray(d) ? d : (d.data || []);
  return items.map(a => norm('benzinga', {
    title: a.title,
    summary: a.teaser,
    url: a.url,
    publishedAt: new Date(a.created).toISOString(),
    tickers: (a.stocks || []).map(s => s.name).filter(Boolean),
  }));
}

async function fetchNewsAPI(key) {
  if (!key) return [];
  const q = encodeURIComponent('stock market options trading SPY QQQ');
  const r = await fetch(
    `https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=20&apiKey=${key}`
  );
  const d = await r.json();
  return (d.articles || []).map(a => norm('newsapi', {
    title: a.title,
    summary: a.description,
    url: a.url,
    publishedAt: a.publishedAt,
    tickers: [],
  }));
}

async function fetchTradingEconomics(key) {
  if (!key) return [];
  const r = await fetch(`https://api.tradingeconomics.com/news?c=${key}&f=json`);
  const d = await r.json();
  return (Array.isArray(d) ? d : []).slice(0, 20).map(a => norm('tradingeconomics', {
    title: a.title,
    summary: a.description,
    url: a.url,
    publishedAt: new Date(a.date).toISOString(),
    tickers: [],
  }));
}
