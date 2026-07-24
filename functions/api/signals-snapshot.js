// Phase 2 of the /signals public preview: called once daily by a Supabase
// pg_cron job (see supabase/signal_history_setup.sql) shortly after market
// open. Persists that moment's top signals so signals-eval.js can later
// compute real forward returns for the "Recent Signal Performance" section.
//
// Auth: a shared secret header, not a user session — this is a server-to-
// server call from Supabase's pg_net, not something a browser ever calls.
const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';

export async function onRequest(context) {
  const { env, request } = context;

  if (!env.SIGNALS_CRON_SECRET || request.headers.get('x-cron-secret') !== env.SIGNALS_CRON_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Not configured' }, 200);
  }

  try {
    const res  = await fetch(new URL('/api/signals?range=day', request.url));
    const data = await res.json();

    // Cap at top 5 each direction — enough to see real performance trends
    // without writing an unbounded number of rows per day.
    const rows = [
      ...(data.calls || []).slice(0, 5).map(s => ({ symbol: s.symbol, tone: 'buy',  conviction: s.conviction, snapshot_price: s.price })),
      ...(data.puts  || []).slice(0, 5).map(s => ({ symbol: s.symbol, tone: 'sell', conviction: s.conviction, snapshot_price: s.price })),
    ].filter(r => r.snapshot_price != null);

    if (!rows.length) {
      return json({ ok: true, inserted: 0, note: 'No calls/puts to snapshot right now.' }, 200);
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_history?on_conflict=symbol,tone,snapshot_date`, {
      method: 'POST',
      headers: {
        apikey:         env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization:  `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        // return=representation (not minimal) so `inserted` below reflects
        // rows actually written, not rows attempted — ignore-duplicates
        // silently drops same-day symbol+tone repeats via the unique index.
        Prefer:         'resolution=ignore-duplicates,return=representation',
      },
      body: JSON.stringify(rows),
    });

    if (!insertRes.ok) {
      const detail = await insertRes.text().catch(() => '');
      console.error('signals-snapshot insert failed:', insertRes.status, detail);
      return json({ error: 'Could not save snapshot.' }, 200);
    }

    const inserted = await insertRes.json().catch(() => []);
    return json({ ok: true, attempted: rows.length, inserted: Array.isArray(inserted) ? inserted.length : null }, 200);
  } catch (e) {
    console.error('signals-snapshot fatal:', e.message);
    return json({ error: e.message }, 200);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
