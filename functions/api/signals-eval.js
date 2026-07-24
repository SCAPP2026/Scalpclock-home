// Phase 2 of the /signals public preview: called once daily by a Supabase
// pg_cron job (see supabase/signal_history_setup.sql), a few minutes before
// that day's signals-snapshot.js run. Evaluates any signal_history rows
// older than ~20h (i.e. from a prior session, never today's fresh snapshot)
// that haven't been scored yet, and writes real win/loss/flat results.
const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';
const FLAT_THRESHOLD_PCT = 0.15; // moves smaller than this count as "flat", not a real win/loss

export async function onRequest(context) {
  const { env, request } = context;

  if (!env.SIGNALS_CRON_SECRET || request.headers.get('x-cron-secret') !== env.SIGNALS_CRON_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.ALPACA_KEY_ID || !env.ALPACA_SECRET) {
    return json({ error: 'Not configured' }, 200);
  }

  try {
    const cutoffISO = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    const selectUrl = `${SUPABASE_URL}/rest/v1/signal_history`
      + `?eval_at=is.null&snapshot_at=lt.${encodeURIComponent(cutoffISO)}`
      + `&select=id,symbol,tone,snapshot_price&limit=20`;

    const pendingRes = await fetch(selectUrl, {
      headers: {
        apikey:        env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    const pending = await pendingRes.json().catch(() => []);

    if (!Array.isArray(pending) || !pending.length) {
      return json({ ok: true, evaluated: 0 }, 200);
    }

    const symbols = [...new Set(pending.map(r => r.symbol))];
    const priceRes = await fetch(
      `https://data.alpaca.markets/v2/stocks/bars/latest?symbols=${symbols.join(',')}&feed=iex`,
      { headers: { 'APCA-API-KEY-ID': env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET } }
    );
    const priceData = await priceRes.json().catch(() => ({}));
    const latestBars = priceData.bars || {};

    let evaluated = 0;
    for (const row of pending) {
      const bar = latestBars[row.symbol];
      const evalPrice = bar ? bar.c : null;
      if (!evalPrice || !row.snapshot_price) continue;

      const movePct = ((evalPrice - row.snapshot_price) / row.snapshot_price) * 100;
      let result;
      if (Math.abs(movePct) < FLAT_THRESHOLD_PCT) result = 'flat';
      else if (row.tone === 'buy')  result = movePct > 0 ? 'win' : 'loss';
      else                          result = movePct < 0 ? 'win' : 'loss';

      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_history?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: {
          apikey:         env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization:  `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer:         'return=minimal',
        },
        body: JSON.stringify({ eval_price: evalPrice, eval_at: new Date().toISOString(), result }),
      });
      if (patchRes.ok) evaluated++;
      else console.error('signals-eval patch failed for', row.symbol, patchRes.status);
    }

    return json({ ok: true, evaluated, pending: pending.length }, 200);
  } catch (e) {
    console.error('signals-eval fatal:', e.message);
    return json({ error: e.message }, 200);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
