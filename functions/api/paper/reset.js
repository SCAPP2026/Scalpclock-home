// POST /api/paper/reset — wipe the member's paper positions and history and
// restore the starting $25,000. Only touches paper_* tables.
import { json, preflight, verifyUser, rpc } from '../../lib/paper.js';

export async function onRequest(context) {
  const { env, request } = context;
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: 'Paper trading is not configured yet' }, 500);

  const user = await verifyUser(request);
  if (!user) return json({ error: 'Sign in to use paper trading' }, 401);

  try {
    const acct = await rpc(env, 'paper_reset', { p_user: user.id });
    return json({ ok: true, cash: Number(acct.cash) });
  } catch (e) {
    return json({ error: e.message || 'Reset failed' }, 400);
  }
}
