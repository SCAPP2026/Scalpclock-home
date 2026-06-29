const SOURCE_META = {
  polygon: { label: 'Massive',  color: '#a78bfa' },
  finnhub: { label: 'Finnhub',  color: '#60a5fa' },
};

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const results = await Promise.allSettled([
    fetchPolygon(env.MASSIVE_API_KEY),
    fetchFinnhub(env.FINNHUB_KEY),
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
