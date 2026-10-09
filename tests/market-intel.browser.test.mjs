/**
 * Market Intelligence Center — real page in headless Chromium.
 * Run with: node tests/market-intel.browser.test.mjs
 *
 * Serves the real market-intelligence.html. /api/market-intel is answered by
 * the REAL response builder (functions/lib/market-intel-response.js) over
 * recorded bars, replayed at different clock times, so each scenario is the
 * exact JSON production would send in that situation:
 *   regular · premarket · closed (weekend) · stale · one ETF missing ·
 *   provider error ({ok:false}) · HTTP 500 · movers endpoint down
 * Checks rendering, honest empty states, no horizontal overflow on phones,
 * and that no JavaScript error is thrown in any of them.
 * Set SHOTS=/some/dir to also write screenshots.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../functions/lib/market-intel.js';
import { buildCalendar } from '../functions/lib/market-intel-calendar.js';
import { buildCoreResponse } from '../functions/lib/market-intel-response.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8951, CDP = 9351;
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/market-intel-bars.json'), 'utf8'));
const MOVERS = fs.readFileSync(path.join(__dirname, 'fixtures/market-intel-movers.json'), 'utf8');
const SHOTS = process.env.SHOTS || null;

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}
const at = iso => Date.parse(iso);
function replay(nowMs, drop = []) {
  const daily = {}, intraday = {}, today = M.etParts(nowMs).date;
  for (const s of M.ETFS) {
    daily[s] = drop.includes(s) ? [] : FIX.daily[s].filter(b => M.etParts(b.t + 12 * 3600e3).date <= today && b.t <= nowMs);
    intraday[s] = drop.includes(s) ? [] : FIX.intraday[s].filter(b => b.t + 5 * 60e3 <= nowMs);
  }
  return { daily, intraday };
}
const LIVE = at('2026-10-08T19:30:00Z');
const SCENARIOS = {
  regular:   { now: LIVE, bars: LIVE },
  premarket: { now: at('2026-10-09T12:45:00Z'), bars: at('2026-10-09T12:45:00Z') },
  closed:    { now: at('2026-10-10T15:00:00Z'), bars: at('2026-10-10T15:00:00Z') },
  stale:     { now: LIVE + 25 * 60e3, bars: LIVE },
  missing:   { now: LIVE, bars: LIVE, drop: ['IWM'] },
};
let mode = 'regular', moversDown = false;

async function coreBody() {
  if (mode === 'error') return { status: 200, body: { ok: false, error: 'Market data provider error: 5Min bars: HTTP 503', asOf: new Date(LIVE).toISOString() } };
  if (mode === 'http500') return { status: 500, body: { error: 'boom' } };
  const sc = SCENARIOS[mode];
  const calendar = await buildCalendar({ fredKey: undefined, nowMs: sc.now });
  return { status: 200, body: buildCoreResponse({ ...replay(sc.bars, sc.drop), trades: {}, calendar, nowMs: sc.now }) };
}
const TYPES = { '.js': 'application/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  try {
    if (url.pathname === '/api/market-intel') { const r = await coreBody(); return send(r.status, r.body); }
    if (url.pathname === '/api/market-intel-movers') return moversDown ? send(200, { ok: false, error: 'Market data provider error: snapshots: HTTP 503' }) : send(200, MOVERS);
    if (url.pathname === '/api/earnings') return send(200, { earnings: [{ symbol: 'JPM', company: 'JPMorgan Chase & Co', date: '2026-10-13', time: 'before-open', epsEstimate: 5.12 }, { symbol: 'ZZZZ', company: 'Not A Holding', date: '2026-10-13', time: 'unknown', epsEstimate: 1 }] });
    if (url.pathname === '/api/news') return send(200, { articles: [{ title: 'Test headline <b>escaped</b>', url: 'https://example.com/a', publishedAt: '2026-10-08T18:00:00Z', sourceLabel: 'Finnhub' }] });
    if (url.pathname === '/api/options') return url.searchParams.get('symbol') === 'IWM' ? send(200, { symbol: 'IWM', noData: true }) : send(200, { symbol: url.searchParams.get('symbol'), iv: 14.2, pcRatio: 1.31, callVolume: 1234567, putVolume: 1617283, callOI: 5000000, putOI: 7100000 });
    if (url.pathname.startsWith('/api/')) return send(200, {});
    let file = path.join(ROOT, url.pathname);
    if (!path.extname(file)) file += '.html';
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(PORT, r));

const chrome = spawn('chromium', ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${CDP}`, 'about:blank'], { stdio: 'ignore' });
async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP}/json/version`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('devtools never came up');
}
function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(), handlers = [];
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    else if (msg.method) handlers.forEach(h => h(msg));
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  return { send: (method, params = {}) => ready.then(() => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); })), on: h => handlers.push(h) };
}

try {
  await waitForDevtools();
  const targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
  const client = cdpClient((targets.find(t => t.type === 'page') || targets[0]).webSocketDebuggerUrl);
  await client.send('Page.enable'); await client.send('Runtime.enable'); await client.send('Network.enable');
  // Third-party scripts are stubbed so the test needs no network, except the
  // chart library, which is passed through when reachable.
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*supabase-js*' }, { urlPattern: '*googletagmanager*' }, { urlPattern: '*fonts.googleapis*' }] });
  let errors = [];
  client.on(async msg => {
    if (msg.method === 'Fetch.requestPaused') {
      const isJs = /supabase-js|googletagmanager/.test(msg.params.request.url);
      const body = /supabase-js/.test(msg.params.request.url) ? 'window.supabase={createClient:function(){return{auth:{getSession:async function(){return{data:{session:null}}},onAuthStateChange:function(){return{data:{subscription:{unsubscribe(){}}}}}},from:function(){return{select:function(){return{eq:function(){return{maybeSingle:async function(){return{data:null}},single:async function(){return{data:null}}}}}}}}}}};' : '';
      await client.send('Fetch.fulfillRequest', { requestId: msg.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: isJs ? 'application/javascript' : 'text/css' }], body: Buffer.from(body).toString('base64') });
    } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push('console.error: ' + msg.params.args.map(a => a.value || a.description).join(' '));
  });
  const js = async expr => {
    const r = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.value;
  };
  async function open(m, width, { movers = true } = {}) {
    mode = m; moversDown = !movers; errors = [];
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
    const loaded = new Promise(resolve => { client.on(x => { if (x.method === 'Page.loadEventFired') resolve(); }); setTimeout(resolve, 8000); });
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/market-intelligence?m=${m}-${width}-${Date.now()}` });
    await loaded;
    for (let i = 0; i < 40; i++) {       // wait for the first render (or the failure state)
      if (await js(`!!document.querySelector('#cards .card') || /could not be loaded/.test(document.getElementById('cards').textContent)`)) break;
      await new Promise(r => setTimeout(r, 150));
    }
    await new Promise(r => setTimeout(r, 500));
  }
  const text = id => js(`document.getElementById(${JSON.stringify(id)}).innerText`);
  const overflow = () => js(`document.documentElement.scrollWidth - window.innerWidth`);
  async function shot(name) {
    if (!SHOTS) return;
    const m = await client.send('Page.getLayoutMetrics');
    // Sliced into screen-sized pieces so each one stays legible.
    const total = Math.min(Math.ceil(m.cssContentSize.height), 12000), step = 1500;
    for (let y = 0, i = 0; y < total; y += step, i++) {
      const r = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width: m.cssContentSize.width, height: Math.min(step, total - y), scale: 1 } });
      await writeFile(path.join(SHOTS, `${name}-${i}.png`), Buffer.from(r.data, 'base64'));
    }
  }

  console.log('\nRegular session — desktop 1280px');
  await open('regular', 1280);
  assert(await js(`document.querySelectorAll('#cards .card').length`) === 3, 'three ETF cards render');
  assert(/SPY[\s\S]*QQQ[\s\S]*IWM/.test(await text('cards')), 'cards are SPY, QQQ, IWM in order');
  assert(/Regular session/.test(await text('sessLabel')) && /Updated .* ET/.test(await text('updPill')), 'session badge and Eastern-time timestamp shown');
  assert(/Alpaca Market Data — IEX feed/.test(await text('dataNote')) && /IEX-only/.test(await text('dataNote')), 'data source and the IEX volume caveat are printed');
  assert(await js(`document.querySelectorAll('#glance .panel').length`) === 3, 'at-a-glance strip answers three questions');
  assert(await js(`document.querySelectorAll('#scen .scen .panel').length`) === 3 && /Calls scenario[\s\S]*Puts scenario[\s\S]*No-trade scenario/i.test(await text('scen')), 'calls / puts / no-trade scenarios render');
  assert(await js(`document.querySelectorAll('#score .score-row').length`) === 8, 'all eight score components are visible');
  assert(!/\d+\s?% (confidence|chance|probability)/i.test(await js(`document.body.innerText`)), 'no percentage confidence or win-probability anywhere on the page');
  assert(await js(`document.querySelectorAll('#levels .lvl').length`) >= 8 && await js(`document.querySelectorAll('#levels .here').length`) === 1, 'levels list renders with the current price marker');
  const hasChart = await js(`typeof LightweightCharts !== 'undefined'`);
  if (hasChart) assert(await js(`!!document.querySelector('#chart canvas')`), 'price chart draws');
  else console.log('  · chart library unreachable from this machine — chart check skipped');
  assert(await js(`document.querySelectorAll('#perf tbody tr').length`) === 4 && await js(`document.querySelectorAll('#corr tbody tr').length`) === 3, 'performance (4 periods) and correlation (3 pairs) tables');
  assert(await js(`document.querySelectorAll('#movers tbody tr').length`) >= 10 && /State Street/.test(await text('movers')), 'SPY movers table with the weights source and date');
  assert(await js(`document.querySelectorAll('#sectors tbody tr').length`) === 11, 'eleven sectors listed');
  assert(/FOMC rate decision/.test(await text('calendar')) && /Consensus: unavailable/.test(await text('calendar')), 'calendar shows the FOMC meeting and marks consensus unavailable');
  assert(/not connected yet/.test(await text('calendar')), 'missing FRED key is stated on the page, not hidden');
  assert(/JPM/.test(await text('earnings')) && !/ZZZZ/.test(await text('earnings')), 'earnings limited to top holdings');
  assert(/Test headline <b>escaped<\/b>/.test(await text('headlines')), 'headline HTML is escaped, not injected');
  assert(/unavailable/i.test(await js(`document.querySelector('#options tbody tr:nth-child(3)').innerText`)) && /14\.2%/.test(await text('options')), 'options table: values for SPY/QQQ, "unavailable" for a symbol with no data');
  assert(await overflow() <= 0, 'no horizontal overflow at 1280px');
  assert(errors.length === 0, 'no JavaScript errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await shot('regular-1280');

  console.log('\nInteractions');
  await js(`document.querySelector('#focusSeg [data-sym="QQQ"]').click()`);
  assert(await js(`[...document.querySelectorAll('.focusSym')].every(e => e.textContent === 'QQQ')`) && /QQQ/.test(await js(`document.querySelector('#levels .here').innerText`)), 'choosing QQQ updates scenarios, score and levels');
  await js(`document.querySelector('#tfSeg [data-tf="daily"]').click()`);
  assert(/Daily candles/.test(await text('chartNote')) || !hasChart, 'chart switches to daily');
  await js(`document.querySelector('#movSeg [data-sym="IWM"]').click()`);
  assert(/not shown for IWM/.test(await text('movers')) && await js(`document.querySelectorAll('#movers tbody tr').length`) === 0, 'IWM movers: explains why contribution is unavailable instead of showing numbers');
  await js(`document.querySelector('#outSeg [data-out="monthly"]').click()`);
  assert(/This month/.test(await text('outlook')) && /Economy, inflation and the Fed/.test(await text('outlook')) && /not connected yet/.test(await text('outlook')), 'monthly outlook renders and labels the missing macro data');
  await js(`document.querySelector('#outSeg [data-out="weekly"]').click()`);
  assert(/Previous week/.test(await text('outlook')), 'weekly outlook renders');
  assert(errors.length === 0, 'no JavaScript errors after interactions' + (errors.length ? ': ' + errors.join(' | ') : ''));

  console.log('\nPhones');
  for (const w of [320, 375, 430]) {
    await open('regular', w);
    assert(await overflow() <= 0, `no horizontal page overflow at ${w}px`);
    // body has overflow-x:hidden, which can mask a too-wide element — check
    // every element, ignoring content inside deliberate horizontal scrollers.
    const wide = await js(`[...document.querySelectorAll('.wrap *')].filter(el => !el.closest('.tbl-wrap, #chart') && el.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map(el => el.tagName + '.' + el.className + '#' + el.id + ' right=' + Math.round(el.getBoundingClientRect().right)).join(' | ')`);
    assert(wide === '', `no element wider than the screen at ${w}px` + (wide ? ': ' + wide : ''));
    assert(await js(`document.querySelectorAll('#cards .card').length`) === 3 && errors.length === 0, `renders without errors at ${w}px`);
    if (w === 375) await shot('regular-375');
  }
  await open('regular', 768);
  assert(await overflow() <= 0, 'no horizontal page overflow at 768px (tablet)');

  console.log('\nPremarket');
  await open('premarket', 1280);
  assert(/Premarket/.test(await text('sessLabel')) && /Premarket\./.test(await text('banners')), 'premarket badge and explanation banner');
  assert(/not open yet/.test(await text('cards')), 'VWAP / day range show "not open yet" rather than yesterday\'s values');
  assert(/favour waiting/.test(await text('scen')), 'premarket: decision panel says wait');
  assert(errors.length === 0, 'no JavaScript errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await shot('premarket-1280');

  console.log('\nMarket closed (weekend)');
  await open('closed', 1280);
  assert(/Market closed/.test(await text('sessLabel')) && /next open Mon, Oct 12/.test(await text('sessLabel')), 'badge says closed and names the next open');
  assert(/most recent session \(Fri, Oct 9\)/.test(await text('banners')), 'banner says the page describes Friday\'s session');
  assert(/Regular-session close/.test(await text('cards')), 'card price is labelled as the session close, not a live trade');
  assert(errors.length === 0, 'no JavaScript errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await shot('closed-1280');

  console.log('\nStale data during market hours');
  await open('stale', 1280);
  assert(/Stale prices/.test(await text('banners')), 'stale banner appears');
  assert(/more than 15 minutes old/.test(await text('score')), 'confidence explanation mentions the stale trade');

  console.log('\nOne ETF missing');
  await open('missing', 1280);
  assert(/IWM: the provider returned no price data/.test(await text('banners')), 'warning names the missing ETF');
  assert(await js(`document.querySelectorAll('#cards .card').length`) === 3 && /unavailable/.test(await js(`document.querySelectorAll('#cards .card')[2].innerText`)), 'IWM card shows "unavailable" in place of numbers');
  assert(!/NaN|undefined|null/.test(await js(`document.querySelector('.wrap').innerText`)), 'no NaN / undefined / null leaks into the page');
  await js(`document.querySelector('#focusSeg [data-sym="IWM"]').click()`);
  assert(errors.length === 0, 'focusing the missing ETF throws no errors' + (errors.length ? ': ' + errors.join(' | ') : ''));

  console.log('\nProvider error ({ok:false})');
  await open('error', 1280);
  assert(/Could not refresh market data/.test(await text('banners')) && /HTTP 503/.test(await text('banners')), 'error banner with the provider message');
  assert(await js(`document.querySelectorAll('#cards .card').length`) === 0 && /Nothing is shown rather than showing made-up numbers/.test(await text('cards')), 'no cards and no placeholder prices');
  assert(!/\$?\d{3}\.\d{2}/.test(await text('cards') + await text('glance') + await text('levels')), 'no price-like numbers anywhere in the core sections');
  assert(errors.filter(e => !/Failed to load resource/.test(e)).length === 0, 'no JavaScript errors');
  await shot('error-1280');

  console.log('\nHTTP 500 from the endpoint');
  await open('http500', 375);
  assert(/Could not refresh market data/.test(await text('banners')) && await js(`document.querySelectorAll('#cards .card').length`) === 0, 'same honest failure state');
  assert(await overflow() <= 0, 'failure state does not overflow on a phone');

  console.log('\nMovers endpoint down, core fine');
  await open('regular', 1280, { movers: false });
  assert(await js(`document.querySelectorAll('#cards .card').length`) === 3 && /Movers could not be loaded/.test(await text('movers')), 'page still works; movers section says it could not load');

  console.log('\nNavigation');
  assert(await js(`!!document.querySelector('#scDrawer a.sc-active[href="/market-intelligence"]')`), 'drawer highlights Market Intelligence');
  await js(`toggleSCNav()`);
  assert(await js(`document.getElementById('scDrawer').classList.contains('open')`), 'menu opens');
} catch (e) {
  console.error('  ✗ FAIL: harness error — ' + e.message); failed++;
} finally {
  chrome.kill(); server.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
