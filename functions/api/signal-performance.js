// Public, read-only: recent evaluated signal_history rows for the "Recent
// Signal Performance" section on /signals. Shows real wins AND losses (for
// credibility) — returns an empty array until signals-eval.js has actually
// evaluated something, so the frontend can show an honest "still building
// history" state instead of anything fabricated.
const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';

export async function onRequest(context) {
  const { env } = context;
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ results: [], winRate: null }, 200);
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/signal_history`
      + `?eval_at=not.is.null&order=snapshot_at.desc&limit=10`
      + `&select=symbol,tone,snapshot_price,eval_price,result,snapshot_at,eval_at`;

    const res = await fetch(url, {
      headers: {
        apikey:        env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    const rows = await res.json().catch(() => []);

    if (!Array.isArray(rows) || !rows.length) {
      return json({ results: [], winRate: null }, 200);
    }

    const results = rows.map(r => ({
      symbol:      r.symbol,
      tone:        r.tone,
      movePct:     r.snapshot_price ? Number((((r.eval_price - r.snapshot_price) / r.snapshot_price) * 100).toFixed(2)) : null,
      result:      r.result,
      snapshotAt:  r.snapshot_at,
    }));

    const decisive = results.filter(r => r.result !== 'flat');
    const wins = decisive.filter(r => r.result === 'win').length;
    const winRate = decisive.length ? Number(((wins / decisive.length) * 100).toFixed(0)) : null;

    return json({ results, winRate }, 200);
  } catch (e) {
    console.error('signal-performance fatal:', e.message);
    return json({ results: [], winRate: null }, 200);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, s-maxage=300, stale-while-revalidate=150',
    },
  });
}
