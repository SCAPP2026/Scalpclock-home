export async function onRequest(context) {
  const { env } = context;

  const today = new Date();
  const from  = fmt(today);
  const to    = fmt(new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000));

  const out = {
    from, to,
    finnhub: { hasKey: !!env.FINNHUB_KEY, keyLen: (env.FINNHUB_KEY || '').length },
    fmp:     { hasKey: !!env.FMP_KEY,     keyLen: (env.FMP_KEY || '').length },
  };

  if (env.FINNHUB_KEY) {
    try {
      const res  = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${env.FINNHUB_KEY}`);
      const text = await res.text();
      out.finnhub.status = res.status;
      out.finnhub.body   = text.slice(0, 500);
    } catch (e) {
      out.finnhub.fetchError = e.message;
    }
  }

  if (env.FMP_KEY) {
    try {
      const res  = await fetch(`https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${env.FMP_KEY}`);
      const text = await res.text();
      out.fmp.status = res.status;
      out.fmp.body   = text.slice(0, 500);
    } catch (e) {
      out.fmp.fetchError = e.message;
    }
  }

  return new Response(JSON.stringify(out, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function fmt(d) {
  return d.toISOString().split('T')[0];
}
