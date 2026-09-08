// Scalp Opportunity Engine — multi-horizon outcome tracking. Runs every
// ~10min during market hours (see supabase/scalp_score_setup.sql's
// 'signals-outcomes-detail' cron) and, for every signal snapshotted TODAY,
// records: (a) a fixed-horizon return the first time elapsed time crosses
// 5/10/15/30 minutes since snapshot, and (b) a running MFE (max favorable
// excursion) / MAE (max adverse excursion) row, updated in place as new,
// more-extreme observations arrive.
//
// This is separate from — and does not replace — signals-snapshot.js /
// signals-eval.js's existing once-daily win/loss/flat evaluation, which
// keeps working unchanged. This just adds finer-grained data for the
// score-bucket/setup-type backtest report (functions/api/
// signal-backtest-report.js, a later milestone) to use once enough of it
// has accumulated.
//
// Scoped to TODAY's snapshots only (not the full 20h eval window every run)
// to keep this cron's per-run cost bounded — same "start lean" spirit as
// the rest of Milestone 1.
const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';
const FIXED_HORIZONS_MIN = [5, 10, 15, 30];

export async function onRequest(context) {
  const { env, request } = context;

  if (!env.SIGNALS_CRON_SECRET || request.headers.get('x-cron-secret') !== env.SIGNALS_CRON_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.ALPACA_KEY_ID || !env.ALPACA_SECRET) {
    return json({ error: 'Not configured' }, 200);
  }

  const sbHeaders = {
    apikey:        env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    const todayUTC = new Date().toISOString().slice(0, 10);
    const rowsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/signal_history?snapshot_date=eq.${todayUTC}` +
      `&select=id,symbol,tone,snapshot_price,snapshot_at`,
      { headers: sbHeaders }
    );
    const rows = await rowsRes.json().catch(() => []);
    if (!Array.isArray(rows) || !rows.length) {
      return json({ ok: true, processed: 0, note: 'No snapshots for today yet.' }, 200);
    }

    const symbols = [...new Set(rows.map(r => r.symbol))];
    const priceRes = await fetch(
      `https://data.alpaca.markets/v2/stocks/bars/latest?symbols=${symbols.join(',')}&feed=iex`,
      { headers: { 'APCA-API-KEY-ID': env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': env.ALPACA_SECRET } }
    );
    const latestBars = (await priceRes.json().catch(() => ({}))).bars || {};

    // Existing detail rows for today's signals, so fixed-horizon inserts
    // aren't duplicated on a re-run, and mfe/mae rows get updated (not
    // re-inserted) when a more extreme value shows up.
    const ids = rows.map(r => r.id);
    const existingRes = await fetch(
      `${SUPABASE_URL}/rest/v1/signal_outcomes_detail?signal_history_id=in.(${ids.join(',')})` +
      `&select=id,signal_history_id,horizon_type,horizon_minutes,return_pct`,
      { headers: sbHeaders }
    );
    const existing = await existingRes.json().catch(() => []);
    const existingFixed = new Set(
      existing.filter(e => e.horizon_type === 'fixed').map(e => `${e.signal_history_id}:${e.horizon_minutes}`)
    );
    const existingMfeMae = new Map(
      existing.filter(e => e.horizon_type === 'mfe' || e.horizon_type === 'mae')
        .map(e => [`${e.signal_history_id}:${e.horizon_type}`, e])
    );

    const toInsert = [];
    const toUpdate = [];
    const now = Date.now();

    for (const row of rows) {
      const bar = latestBars[row.symbol];
      const latestPrice = bar ? bar.c : null;
      if (!latestPrice || !row.snapshot_price) continue;

      const elapsedMin = (now - new Date(row.snapshot_at).getTime()) / 60000;
      const rawReturnPct = ((latestPrice - row.snapshot_price) / row.snapshot_price) * 100;
      // Favorable-direction excursion — the basis for MFE/MAE. Raw return
      // (not direction-adjusted) is still what's stored for fixed horizons,
      // matching signal-performance.js's existing movePct convention.
      const favorablePct = row.tone === 'sell' ? -rawReturnPct : rawReturnPct;

      for (const h of FIXED_HORIZONS_MIN) {
        if (elapsedMin >= h && !existingFixed.has(`${row.id}:${h}`)) {
          toInsert.push({
            signal_history_id: row.id, horizon_type: 'fixed', horizon_minutes: h,
            price_at_horizon: latestPrice, return_pct: Number(rawReturnPct.toFixed(3)),
          });
        }
      }

      const mfeKey = `${row.id}:mfe`, maeKey = `${row.id}:mae`;
      const existingMfe = existingMfeMae.get(mfeKey);
      const existingMae = existingMfeMae.get(maeKey);
      if (!existingMfe) {
        toInsert.push({ signal_history_id: row.id, horizon_type: 'mfe', price_at_horizon: latestPrice, return_pct: Number(favorablePct.toFixed(3)) });
      } else if (favorablePct > existingMfe.return_pct) {
        toUpdate.push({ id: existingMfe.id, price_at_horizon: latestPrice, return_pct: Number(favorablePct.toFixed(3)) });
      }
      if (!existingMae) {
        toInsert.push({ signal_history_id: row.id, horizon_type: 'mae', price_at_horizon: latestPrice, return_pct: Number(favorablePct.toFixed(3)) });
      } else if (favorablePct < existingMae.return_pct) {
        toUpdate.push({ id: existingMae.id, price_at_horizon: latestPrice, return_pct: Number(favorablePct.toFixed(3)) });
      }
    }

    let inserted = 0, updated = 0;
    if (toInsert.length) {
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_outcomes_detail`, {
        method: 'POST',
        headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(toInsert),
      });
      if (insertRes.ok) {
        const ins = await insertRes.json().catch(() => []);
        inserted = Array.isArray(ins) ? ins.length : 0;
      } else {
        console.error('signals-outcomes-detail insert failed:', insertRes.status, await insertRes.text().catch(() => ''));
      }
    }
    for (const u of toUpdate) {
      const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/signal_outcomes_detail?id=eq.${u.id}`, {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ price_at_horizon: u.price_at_horizon, return_pct: u.return_pct, recorded_at: new Date().toISOString() }),
      });
      if (patchRes.ok) updated++;
      else console.error('signals-outcomes-detail update failed for id', u.id, patchRes.status);
    }

    return json({ ok: true, signalsChecked: rows.length, inserted, updated }, 200);
  } catch (e) {
    console.error('signals-outcomes-detail fatal:', e.message);
    return json({ error: e.message }, 200);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
