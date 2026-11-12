// Market Intelligence — PRO fields (bull/bear evidence engine).
//
//   GET /api/market-intel-pro    Authorization: Bearer <supabase access token>
//
// 401 → not signed in, 403 → signed in without a PRO plan. On success it
// returns the PRO-only fields per ETF from the same cached core build the
// free endpoint uses, so both always describe the same moment.
import { loadCoreBody } from './market-intel.js';
import { PRO_FIELDS } from '../lib/market-intel-response.js';
import { checkPro } from '../lib/entitlement.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return reply({ ok: false, error: 'Method not allowed' }, 405);

  const who = await checkPro(request);
  if (who.status === 'anon') return reply({ ok: false, locked: 'signin', error: 'Sign in to see the Evidence Engine.' }, 401);
  if (who.status !== 'pro') return reply({ ok: false, locked: 'upgrade', error: 'The Evidence Engine is part of ScalpClock Pro.' }, 403);

  const { body } = await loadCoreBody(context);
  if (!body.ok) return reply({ ok: false, error: body.error || 'Market data unavailable.' }, 200);
  return reply({
    ok: true, asOf: body.asOf, session: body.session,
    etfs: body.etfs.map(e => {
      const out = { symbol: e.symbol };
      for (const k of PRO_FIELDS) out[k] = e[k];
      return out;
    }),
  }, 200);
}

function reply(data, status) {
  // Per-user response: never cached anywhere.
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}
