/**
 * Paper trading — helper + endpoint tests.
 * Run with: node tests/paper.test.mjs
 *
 * Imports the REAL endpoint modules and stubs global fetch by URL (Supabase
 * auth/RPC, Alpaca snapshots, CBOE chain) and Date.now, so order pricing,
 * validation and market-hours rules run without any network.
 */
import * as P from '../functions/lib/paper.js';
import { onRequest as order } from '../functions/api/paper/order.js';
import { onRequest as chain } from '../functions/api/paper/chain.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; } else { failed++; console.log(`FAIL ${name} ${detail}`); }
}

// Fri 2026-10-16 11:00 ET (regular session) and 18:00 ET (closed).
const OPEN_MS = Date.parse('2026-10-16T15:00:00Z');
const CLOSED_MS = Date.parse('2026-10-16T22:00:00Z');
const realNow = Date.now;
const setNow = ms => { Date.now = () => ms; };

// --- helpers ----------------------------------------------------------------
check('parseOcc call', JSON.stringify(P.parseOcc('SPY261016C00580000')) ===
  JSON.stringify({ contract: 'SPY261016C00580000', underlying: 'SPY', expiry: '2026-10-16', type: 'call', strike: 580 }));
check('parseOcc fractional strike', P.parseOcc('AAPL261120P00242500').strike === 242.5);
check('parseOcc rejects junk', P.parseOcc('SPY 580C') === null);
check('cleanSymbol', P.cleanSymbol(' spy ') === 'SPY' && P.cleanSymbol('BRK.B') === 'BRK.B' && P.cleanSymbol('DROP TABLE') === null);
check('marketIsOpen open', P.marketIsOpen(OPEN_MS) === true);
check('marketIsOpen after close', P.marketIsOpen(CLOSED_MS) === false);
check('marketIsOpen Saturday', P.marketIsOpen(Date.parse('2026-10-17T15:00:00Z')) === false);
check('isExpired past', P.isExpired('2026-10-15', OPEN_MS) === true);
check('isExpired today during session', P.isExpired('2026-10-16', OPEN_MS) === false);
check('isExpired today after close', P.isExpired('2026-10-16', CLOSED_MS) === true);
check('isExpired future', P.isExpired('2026-10-23', CLOSED_MS) === false);
check('intrinsic call ITM', P.intrinsic('call', 580, 585.5) === 5.5);
check('intrinsic put OTM', P.intrinsic('put', 580, 585) === 0);
check('stock fill buys at ask', P.stockFillPrice({ price: 100, bid: 99.98, ask: 100.02 }, 'buy') === 100.02);
check('stock fill sells at bid', P.stockFillPrice({ price: 100, bid: 99.98, ask: 100.02 }, 'sell') === 99.98);
check('stock fill wide quote -> last', P.stockFillPrice({ price: 100, bid: 95, ask: 105 }, 'buy') === 100);
check('stock fill no quote -> last', P.stockFillPrice({ price: 100, bid: null, ask: null }, 'sell') === 100);
check('optionMark mid', P.optionMark({ bid: 1.1, ask: 1.3, last: 2 }) === 1.2);

// --- stubbed network --------------------------------------------------------
const USER = '11111111-2222-3333-4444-555555555555';
let rpcCalls = [];
const CBOE = {
  data: {
    current_price: 584.2,
    options: [
      { option: 'SPY261016C00580000', bid: 4.1, ask: 4.3, last_trade_price: 4.2 },
      { option: 'SPY261016P00580000', bid: 0.0, ask: 0.0 },
      { option: 'SPY261016C00585000', bid: 0.9, ask: 1.0 },
      { option: 'SPY261023C00585000', bid: 3.0, ask: 3.2 },
      { option: 'SPY261015C00585000', bid: 0, ask: 0 }, // already expired
    ],
  },
};
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const res = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (u.endsWith('/auth/v1/user')) {
    return opts.headers?.Authorization === 'Bearer good' ? res({ id: USER }) : res({ msg: 'bad' }, 401);
  }
  if (u.includes('/rest/v1/rpc/')) {
    const fn = u.split('/rpc/')[1];
    const args = JSON.parse(opts.body);
    rpcCalls.push({ fn, args });
    if (fn === 'paper_execute' && args.p_qty * args.p_price > 25000) {
      return res({ message: 'Not enough buying power: need $X, have $25000', code: 'P0001' }, 400);
    }
    return res({ cash: 24000, notional: 1000, realized_pnl: null });
  }
  if (u.includes('data.alpaca.markets/v2/stocks/snapshots')) {
    return res({
      SPY: { latestTrade: { p: 584.25 }, latestQuote: { bp: 584.24, ap: 584.26 }, prevDailyBar: { c: 580 } },
      AAPL: { latestTrade: { p: 240 }, latestQuote: { bp: 0, ap: 0 } },
    });
  }
  if (u.includes('cdn.cboe.com')) return u.includes('/SPY.json') ? res(CBOE) : res({}, 404);
  throw new Error('unexpected fetch ' + u);
};

const env = { SUPABASE_SERVICE_ROLE_KEY: 'svc', ALPACA_KEY_ID: 'k', ALPACA_SECRET: 's' };
async function post(body, token = 'good') {
  const request = new Request('https://x/api/paper/order', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const r = await order({ env, request });
  return { status: r.status, body: await r.json() };
}

setNow(OPEN_MS);

let r = await post({ assetClass: 'stock', symbol: 'SPY', side: 'buy', qty: 1 }, 'bad');
check('order rejects bad token', r.status === 401);

rpcCalls = [];
r = await post({ assetClass: 'stock', symbol: 'spy', side: 'buy', qty: 10 });
check('stock buy ok', r.status === 200 && r.body.price === 584.26, JSON.stringify(r.body));
check('stock buy sends server price', rpcCalls[0]?.args.p_price === 584.26 && rpcCalls[0]?.args.p_symbol === 'SPY');

r = await post({ assetClass: 'stock', symbol: 'SPY', side: 'buy', qty: 1, price: 0.01 });
check('client price is ignored', r.body.price === 584.26);

r = await post({ assetClass: 'stock', symbol: 'AAPL', side: 'sell', qty: 5 });
check('empty quote falls back to last', r.body.price === 240, JSON.stringify(r.body));

r = await post({ assetClass: 'stock', symbol: 'SPY', side: 'buy', qty: 1.5 });
check('fractional qty rejected', r.status === 400);

r = await post({ assetClass: 'stock', symbol: 'SPY', side: 'short', qty: 1 });
check('bad side rejected', r.status === 400);

r = await post({ assetClass: 'stock', symbol: 'SPY', side: 'buy', qty: 100 });
check('buying power error surfaces', r.status === 400 && /buying power/.test(r.body.error), JSON.stringify(r.body));

rpcCalls = [];
r = await post({ assetClass: 'option', contract: 'SPY261016C00580000', side: 'buy', qty: 2 });
check('option buy at ask', r.status === 200 && r.body.price === 4.3 && rpcCalls[0]?.args.p_option_type === 'call' && rpcCalls[0]?.args.p_strike === 580, JSON.stringify(r.body));

r = await post({ assetClass: 'option', contract: 'SPY261016C00580000', side: 'sell', qty: 1 });
check('option sell at bid', r.body.price === 4.1);

r = await post({ assetClass: 'option', contract: 'SPY261016P00580000', side: 'buy', qty: 1 });
check('option with no ask rejected', r.status === 400 && /ask/.test(r.body.error));

r = await post({ assetClass: 'option', contract: 'SPY261015C00585000', side: 'buy', qty: 1 });
check('expired contract rejected', r.status === 400 && /expired/.test(r.body.error));

r = await post({ assetClass: 'option', contract: 'SPY261016C00999000', side: 'buy', qty: 1 });
check('unknown contract rejected', r.status === 400);

setNow(CLOSED_MS);
r = await post({ assetClass: 'stock', symbol: 'SPY', side: 'buy', qty: 1 });
check('closed market rejected', r.status === 400 && /closed/.test(r.body.error));

// --- chain ------------------------------------------------------------------
setNow(OPEN_MS);
const cr = await chain({ env, request: new Request('https://x/api/paper/chain?symbol=SPY') });
const cb = await cr.json();
check('chain status', cr.status === 200, JSON.stringify(cb));
check('chain drops expired expiries', JSON.stringify(cb.expiries) === '["2026-10-16","2026-10-23"]', JSON.stringify(cb.expiries));
check('chain uses live underlying', cb.underlying === 584.25);
check('chain rows pair call/put', cb.rows.find(x => x.strike === 580)?.put?.contract === 'SPY261016P00580000');
const cr2 = await chain({ env, request: new Request('https://x/api/paper/chain?symbol=SPY&expiry=2026-10-23') });
check('chain honours expiry', (await cr2.json()).rows.length === 1);
const cr3 = await chain({ env, request: new Request('https://x/api/paper/chain?symbol=ZZZZ') });
check('chain unknown symbol 404', cr3.status === 404);

// --- chainView fast path: sorted file in CBOE's real formatting --------------
{
  const recs = [];
  for (const exp of ['261016', '261023', '261030']) {
    for (let k = 400; k <= 700; k += 1) {
      const st = String(k * 1000).padStart(8, '0');
      recs.push({ option: `SPY${exp}C${st}`, bid: k / 100, ask: k / 100 + 0.05, open_interest: k });
      recs.push({ option: `SPY${exp}P${st}`, bid: k / 200, ask: k / 200 + 0.05, open_interest: k });
    }
  }
  // Python-style separators, like the live file: {"option": "SPY...", "bid": 1.0}
  const text = JSON.stringify({ timestamp: 't', data: { options: recs, symbol: 'SPY', current_price: 584.2 } })
    .replace(/":/g, '": ').replace(/,"/g, ', "');
  const v = P.chainView(text, 'SPY');
  check('view underlying', v.underlying === 584.2);
  check('view expiries', JSON.stringify(v.expiries()) === '["2026-10-16","2026-10-23","2026-10-30"]', JSON.stringify(v.expiries()));
  const nr = v.near('2026-10-23', 584.2, 6);
  check('view near count', nr.length === 12, nr.length);
  check('view near centred', nr[0].strike === 582 && nr.at(-1).strike === 587 && nr.every(c => c.expiry === '2026-10-23'),
    nr.map(c => c.strike).join());
  check('view near parses quote', nr.find(c => c.strike === 585 && c.type === 'call')?.bid === 5.85);
  check('view near at chain edge', P.chainView(text, 'SPY').near('2026-10-30', 10, 4).map(c => c.strike).join() === '400,400,401,401');
  check('view near past top', P.chainView(text, 'SPY').near('2026-10-16', 9999, 4).map(c => c.strike).join() === '699,699,700,700');
  check('view get', v.get('SPY261030P00650000')?.openInterest === 650 && v.get('SPY261030P00650000')?.type === 'put');
  check('view get missing', v.get('SPY261030P00650500') === null);
}

Date.now = realNow;
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
