/**
 * 5-Day Level Map (Market Intelligence) + Pre-Market (ScalpCharts) in a real browser.
 * Run with: node tests/levels-premarket.browser.test.mjs   (SHOTS=dir to save screenshots)
 *
 * Serves the real pages. The new endpoints are answered by the REAL pure
 * modules (levels-5day.js, premarket.js) over the recorded IEX fixture, replayed
 * at 9:41 AM ET on 2026-10-09 — so this exercises the full UI path offline.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as M from '../functions/lib/market-intel.js';
import { buildCalendar } from '../functions/lib/market-intel-calendar.js';
import { buildCoreResponse, publicBody } from '../functions/lib/market-intel-response.js';
import { build5DayLevels } from '../functions/lib/levels-5day.js';
import { summarizePremarket } from '../functions/lib/premarket.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8961, CDP = 9361;
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/market-intel-bars.json'), 'utf8'));
const SHOTS = process.env.SHOTS || null;
const NOW = Date.parse('2026-10-09T13:41:00Z');
let passed = 0, failed = 0;
function assert(cond, label) { if (cond) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ FAIL: ${label}`); failed++; } }
const barsUpTo = (sym, ms) => (FIX.intraday[sym] || FIX.intraday.SPY).filter(b => b.t + 5 * 60e3 <= ms);
let levelsDown = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
  try {
    if (url.pathname === '/api/market-intel') {
      const daily = {}, intraday = {}, today = M.etParts(NOW).date;
      for (const s of M.ETFS) { daily[s] = FIX.daily[s].filter(b => M.etParts(b.t + 12 * 3600e3).date <= today && b.t <= NOW); intraday[s] = barsUpTo(s, NOW); }
      const calendar = await buildCalendar({ fredKey: undefined, nowMs: NOW });
      return send(200, publicBody(buildCoreResponse({ daily, intraday, trades: {}, calendar, nowMs: NOW })));
    }
    if (url.pathname === '/api/market-intel-pro') {
      const auth = req.headers.authorization || '';
      if (!auth) return send(401, { ok: false, locked: 'signin' });
      if (auth !== 'Bearer pro-token') return send(403, { ok: false, locked: 'upgrade' });
      const daily = {}, intraday = {}, today = M.etParts(NOW).date;
      for (const s of M.ETFS) { daily[s] = FIX.daily[s].filter(b => M.etParts(b.t + 12 * 3600e3).date <= today && b.t <= NOW); intraday[s] = barsUpTo(s, NOW); }
      const full = buildCoreResponse({ daily, intraday, trades: {}, calendar: null, nowMs: NOW });
      return send(200, { ok: true, asOf: full.asOf, session: full.session, etfs: full.etfs.map(e => ({ symbol: e.symbol, evidence: e.evidence })) });
    }
    if (url.pathname === '/api/market-levels') {
      if (levelsDown) return send(200, { ok: false, error: 'Market data provider error: HTTP 503' });
      const syms = (url.searchParams.get('symbols') || 'SPY,QQQ,IWM').split(',');
      const last = sym => barsUpTo(sym, NOW).at(-1);
      return send(200, { ok: true, asOf: new Date(NOW).toISOString(), note: 'Fixture replay (IEX).', symbols: syms.map(s => build5DayLevels({ symbol: s, bars: barsUpTo(s, NOW), nowMs: NOW, price: last(s).c, priceTs: last(s).t })) });
    }
    if (url.pathname === '/api/premarket') {
      const sym = url.searchParams.get('symbol') || 'SPY';
      return send(200, summarizePremarket({ symbol: sym, bars: barsUpTo(sym, NOW), nowMs: NOW }));
    }
    if (url.pathname === '/api/bars') {
      const sym = url.searchParams.get('symbol') || 'SPY';
      return send(200, { symbol: sym, candles: barsUpTo(sym, NOW).slice(-100).map(b => ({ time: new Date(b.t).toISOString(), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })) });
    }
    if (url.pathname === '/api/price') return send(200, { price: barsUpTo(url.searchParams.get('symbol') || 'SPY', NOW).at(-1).c });
    if (url.pathname.startsWith('/api/')) return send(200, {});
    let file = path.join(ROOT, url.pathname);
    if (!path.extname(file)) file += '.html';
    const body = await readFile(file);
    const T = { '.js': 'application/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': T[path.extname(file)] || 'application/octet-stream' });
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
  await client.send('Page.enable'); await client.send('Runtime.enable');
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*supabase-js*' }, { urlPattern: '*googletagmanager*' }, { urlPattern: '*fonts.googleapis*' }] });
  let errors = [];
  client.on(async msg => {
    if (msg.method === 'Fetch.requestPaused') {
      const isJs = /supabase-js|googletagmanager/.test(msg.params.request.url);
      const body = /supabase-js/.test(msg.params.request.url) ? 'window.supabase={createClient:function(){return{auth:{getSession:async function(){var t=new URLSearchParams(location.search).get("tok");return{data:{session:t?{access_token:t,user:{app_metadata:{plan:"free"}}}:null}}},getUser:async function(){return{data:{user:null}}},onAuthStateChange:function(){return{data:{subscription:{unsubscribe(){}}}}}},from:function(){return{select:function(){return{eq:function(){return{maybeSingle:async function(){return{data:null}},single:async function(){return{data:null}}}}}}}}}}};' : '';
      await client.send('Fetch.fulfillRequest', { requestId: msg.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: isJs ? 'application/javascript' : 'text/css' }], body: Buffer.from(body).toString('base64') });
    } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  });
  const js = async expr => {
    const r = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.value;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // The stubbed Supabase client reads its session token from ?tok= (see the stub above).
  let tok = '';
  async function setToken(t) { tok = t ? 'tok=' + t : ''; }
  async function open(page, width, waitExpr) {
    errors = [];
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${page}${page.includes('?') ? '&' : '?'}x=${Date.now()}${tok ? '&' + tok : ''}` });
    for (let i = 0; i < 60; i++) { await sleep(150); try { if (await js(waitExpr)) break; } catch {} }
    await sleep(600);
  }
  async function shot(name, selector) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    let clip;
    if (selector) {
      const r = await js(`(function(){var e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView();var b=e.getBoundingClientRect();return {x:b.left+scrollX,y:b.top+scrollY,w:b.width,h:b.height};})()`);
      clip = { x: r.x, y: r.y, width: r.w, height: Math.min(r.h, 2400), scale: 1 };
    }
    const { data } = await client.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64'));
  }

  for (const width of [1280, 390]) {
    console.log(`\nMarket Intelligence — 5-Day Level Map @ ${width}px`);
    await open('market-intelligence', width, `!!document.querySelector('#l5Ladder .l5-row')`);
    assert(await js(`document.querySelectorAll('#l5Ladder .l5-row').length`) >= 4, 'ladder lists the levels');
    assert(await js(`!!document.querySelector('#l5Ladder .here')`), '"you are here" marker is placed');
    assert(await js(`document.querySelectorAll('#l5Stats .l5-stat').length`) === 5, 'five stat tiles');
    assert(await js(`document.querySelectorAll('#l5Days .l5-day').length`) === 5, 'five day cards');
    assert(await js(`document.querySelectorAll('#l5chart svg rect').length`) > 100, 'chart drew candles, bands and the profile');
    assert(await js(`document.querySelectorAll('#l5Reads .read').length`) >= 3, 'read-out rendered');
    assert(/Oct 2 → .*Oct 8/.test(await js(`document.getElementById('l5Badge').textContent`)), 'badge names the 5-session window');
    assert(await js(`document.documentElement.scrollWidth - window.innerWidth`) <= 0, 'no horizontal overflow');
    // Hover shows a tooltip.
    await js(`(function(){var el=document.getElementById('l5chart');el.scrollIntoView({block:'center'});var r=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent('pointermove',{clientX:r.left+r.width*0.4,clientY:r.top+r.height*0.5,bubbles:true}));})()`);
    assert(await js(`document.getElementById('l5tip').style.display`) === 'block' && /Open/.test(await js(`document.getElementById('l5tip').textContent`)), 'hover tooltip shows the bar');
    // Focus switch re-renders for QQQ.
    await js(`document.querySelector('#focusSeg button[data-sym="QQQ"]').click()`);
    await sleep(300);
    assert(/QQQ/.test(await js(`document.querySelector('#l5Ladder .here').textContent`)), 'focus switch → QQQ map');
    assert(errors.length === 0, 'no JS errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    await js(`document.querySelector('#focusSeg button[data-sym="SPY"]').click()`);
    await sleep(300);
    await shot(`mi-l5-${width}`, '#five-day-levels');
  }

  console.log('\nEvidence Engine — access states');
  {
    const wait = `!!document.querySelector('#evidence .ev-lock, #evidence .ev-top')`;
    await setToken(null);
    await open('market-intelligence', 1280, wait);
    assert(/Sign in to open the Evidence Engine/.test(await js(`document.getElementById('evidence').innerText`)), 'signed out → sign-in lock');
    const core = await js(`fetch('/api/market-intel').then(r=>r.text())`);
    const coreJ = JSON.parse(core);
    assert(coreJ.etfs.every(e => !('evidence' in e)) && !/"bull":/.test(core) && Array.isArray(coreJ.proLocked), 'free core response carries no evidence scores');
    assert(!/\d+\s*\/\s*100/.test(await js(`document.getElementById('evidence').innerText`)), 'locked view shows no scores');
    await setToken('free-token');
    await open('market-intelligence', 1280, wait);
    assert(/part of ScalpClock Pro/.test(await js(`document.getElementById('evidence').innerText`)) && await js(`!!document.querySelector('#evidence a[href^="/pricing"]')`), 'free member → upgrade lock with pricing link');
    await setToken('pro-token');
    for (const width of [1280, 390]) {
      await open('market-intelligence', width, `!!document.querySelector('#evidence .ev-top') && !document.querySelector('#evidence .ev-lock')`);
      const t = await js(`document.getElementById('evidence').innerText`);
      assert(/Bullish evidence/i.test(t) && /\/\s*100/.test(t), `pro @${width} → scores shown` + (/\/\s*100/.test(t) ? '' : ': ' + t.slice(0, 200)));
      assert(await js(`document.querySelectorAll('#evidence .ev-cat').length`) === 8, 'all eight checks listed');
      assert(await js(`document.querySelectorAll('#evidence .ck').length`) === 14, 'call + put checklists (7 each)');
      assert(/Options liquidity/.test(t) && /No data/.test(t), 'missing liquidity is labelled, not filled');
      assert(await js(`document.documentElement.scrollWidth - window.innerWidth`) <= 0, 'no horizontal overflow');
      await js(`document.querySelector('#focusSeg button[data-sym="IWM"]').click()`);
      await sleep(250);
      assert(/IWM/.test(await js(`document.querySelector('#hEv').textContent`)), 'follows the ETF selector');
      assert(errors.length === 0, 'no JS errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
      await js(`document.querySelector('#focusSeg button[data-sym="SPY"]').click()`);
      await sleep(250);
      await shot(`mi-evidence-${width}`, '#evidence-engine');
    }
    await setToken(null);
  }

  console.log('\nMarket Intelligence — provider down');
  levelsDown = true;
  await open('market-intelligence', 1280, `/could not be loaded/.test(document.getElementById('l5Ladder').textContent)`);
  assert(/could not be loaded/.test(await js(`document.getElementById('l5Ladder').textContent`)), 'clear failure message, no invented levels');
  assert(errors.length === 0, 'no JS errors');
  levelsDown = false;

  for (const width of [1280, 390]) {
    console.log(`\nScalpCharts — pre-market @ ${width}px`);
    await open('scalpchart?t=SPY&l5=1', width, `document.getElementById('pmStrip').classList.contains('show') && /PM HIGH|PM high/i.test(document.getElementById('pmStrip').textContent) && /Support/.test(document.getElementById('pmStrip').textContent)`);
    const strip = await js(`document.getElementById('pmStrip').innerText`);
    assert(/PRE-MARKET/.test(strip), 'strip shows the pre-market block');
    assert(/Gap at open/i.test(strip) && /\+0\.31%/.test(strip), 'gap at open +0.31% (from real fixture bars)');
    assert(/777\.51/.test(strip) && /776\.54/.test(strip), 'PM high / low shown');
    assert(/PML broke/i.test(strip), 'status chip: PM low broke');
    assert(/5-DAY LEVELS/.test(strip), '5-day levels block shown with ?l5=1');
    assert(await js(`document.getElementById('pmBtn').classList.contains('pm-on') && document.getElementById('l5Btn').classList.contains('l5-on')`), 'toggle buttons reflect state');
    assert(errors.length === 0, 'no JS errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    await js(`(function(){var w=document.getElementById('proWall');if(w)w.style.display='none';document.querySelectorAll('[id*=Wall],[class*=paywall]').forEach(function(e){e.style.display='none'});})()`);
    await sleep(200);
    await shot(`sc-pm-${width}`);
    await js(`togglePremarket()`);
    await sleep(200);
    assert(!/PRE-MARKET/.test(await js(`document.getElementById('pmStrip').innerText`)), 'toggle off hides the pre-market block');
    await js(`togglePremarket(); toggleL5()`);
    await sleep(300);
  }
  await js(`try{localStorage.removeItem('sc_l5');localStorage.removeItem('sc_pm')}catch(e){}`);
} catch (e) {
  console.error(e); failed++;
} finally {
  chrome.kill(); server.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
