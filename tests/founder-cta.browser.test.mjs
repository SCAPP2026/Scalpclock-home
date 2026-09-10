/**
 * FounderCTA — real-browser test via headless Chromium + CDP request
 * interception (same technique as founder-guard.browser.test.mjs). Verifies
 * the banner correctly suppresses itself for active Pro/Founder members,
 * hides entirely when Founding is sold out, shows the real (not fabricated)
 * spots-remaining number otherwise, and that the sticky bar only ever shows
 * for logged-out visitors and is dismissible.
 * Run with: node tests/founder-cta.browser.test.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8938;

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

let mockFoundingStatus = { active: true, remaining: 37, cap: 500 };
let mockSessionUser = null; // null = logged out; {id, app_metadata} = logged in

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/founding-status')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mockFoundingStatus));
    return;
  }
  const filePath = path.join(ROOT, req.url === '/' ? '/tests/fixtures/founder-cta-harness.html' : req.url.split('?')[0]);
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': ext === '.js' ? 'application/javascript' : 'text/html' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(PORT, r));

const chromeProc = spawn('chromium', ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=9336', 'about:blank'], { stdio: 'ignore' });

async function waitForDevtools() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:9336/json/version'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('devtools never came up');
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const handlers = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) handlers.forEach(h => h(msg));
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  function send(method, params = {}) {
    return ready.then(() => new Promise((resolve, reject) => {
      const thisId = ++id;
      pending.set(thisId, { resolve, reject });
      ws.send(JSON.stringify({ id: thisId, method, params }));
    }));
  }
  return { send, on: (h) => handlers.push(h) };
}

async function evalJS(client, expr) {
  const result = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails.exception?.description));
  return result.result?.value;
}

let client;
try {
  await waitForDevtools();
  const targets = await (await fetch('http://127.0.0.1:9336/json')).json();
  const page = targets.find(t => t.type === 'page') || targets[0];
  client = cdpClient(page.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*supabase-js*' }] });
  client.on(async (msg) => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = msg.params;
    if (/supabase-js/.test(request.url)) {
      const sessionJs = mockSessionUser
        ? `({data:{session:{user:${JSON.stringify(mockSessionUser)}}}})`
        : `({data:{session:null}})`;
      const fakeJs = `window.supabase = { createClient: () => ({ auth: { getSession: async () => (${sessionJs}) } }) };`;
      await client.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }], body: Buffer.from(fakeJs).toString('base64') });
    } else {
      await client.send('Fetch.continueRequest', { requestId });
    }
  });

  async function navigate() {
    const loadFired = new Promise((resolve) => { client.on((msg) => { if (msg.method === 'Page.loadEventFired') resolve(); }); setTimeout(resolve, 3000); });
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await loadFired;
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Test 1: anonymous visitor, Founding active -> real banner with real spots number ──
  mockSessionUser = null;
  mockFoundingStatus = { active: true, remaining: 37, cap: 500 };
  await navigate();
  const t1 = await evalJS(client, `
    (async () => {
      await FounderCTA.mount(document.getElementById('banner'), { location: 'test' });
      return { html: document.getElementById('banner').innerHTML, hasBtn: !!document.querySelector('[data-fc-cta]') };
    })()
  `);
  assert(t1.hasBtn, 'anon visitor + active Founding -> banner renders with a CTA');
  assert(/37/.test(t1.html), 'banner shows the REAL mocked spots-remaining number, not a fabricated one');
  assert(/1\.99/.test(t1.html), 'banner mentions $1.99');

  // ── Test 2: active Founding Member -> "already locked in" badge, no CTA ──
  mockSessionUser = { id: 'u1', app_metadata: { plan: 'pro', founding_member: true } };
  await navigate();
  const t2 = await evalJS(client, `
    (async () => {
      await FounderCTA.mount(document.getElementById('banner'), { location: 'test' });
      return { html: document.getElementById('banner').innerHTML, hasBtn: !!document.querySelector('[data-fc-cta]') };
    })()
  `);
  assert(!t2.hasBtn, 'existing Founding Member sees NO purchase CTA');
  assert(/already.*Founding Member|locked in/i.test(t2.html), `existing Founding Member sees a "already locked in" badge (got: ${t2.html})`);

  // ── Test 3: active Pro (non-Founder) subscriber -> nothing rendered at all ──
  mockSessionUser = { id: 'u2', app_metadata: { plan: 'pro', founding_member: false } };
  await navigate();
  const t3 = await evalJS(client, `
    (async () => {
      await FounderCTA.mount(document.getElementById('banner'), { location: 'test' });
      return document.getElementById('banner').innerHTML;
    })()
  `);
  assert(t3.trim() === '', `active Pro subscriber sees nothing at all (no nag) (got: "${t3}")`);

  // ── Test 4: Founding sold out -> nothing rendered, even for a free user ──
  mockSessionUser = { id: 'u3', app_metadata: { plan: 'free' } };
  mockFoundingStatus = { active: false, remaining: 0, cap: 500 };
  await navigate();
  const t4 = await evalJS(client, `
    (async () => {
      await FounderCTA.mount(document.getElementById('banner'), { location: 'test' });
      return document.getElementById('banner').innerHTML;
    })()
  `);
  assert(t4.trim() === '', 'Founding sold out -> banner renders nothing (never references a dead offer)');

  // ── Test 5: sticky bar shows only for logged-out visitors, is dismissible ──
  mockSessionUser = null;
  mockFoundingStatus = { active: true, remaining: 20, cap: 500 };
  await navigate();
  const t5 = await evalJS(client, `
    (async () => {
      await FounderCTA.mountSticky({ location: 'test' });
      await new Promise(r => setTimeout(r, 100));
      const before = !!document.querySelector('.fc-sticky');
      document.querySelector('[data-fc-sticky-close]').click();
      await new Promise(r => setTimeout(r, 50));
      const after = !!document.querySelector('.fc-sticky');
      return { before, after };
    })()
  `);
  assert(t5.before, 'logged-out visitor sees the sticky bar');
  assert(!t5.after, 'dismiss button removes the sticky bar');

  // ── Test 6: sticky bar never shows for a logged-in user ─────────────────
  mockSessionUser = { id: 'u4', app_metadata: { plan: 'free' } };
  await navigate();
  const t6 = await evalJS(client, `
    (async () => {
      await FounderCTA.mountSticky({ location: 'test' });
      await new Promise(r => setTimeout(r, 100));
      return !!document.querySelector('.fc-sticky');
    })()
  `);
  assert(!t6, 'logged-in free user does NOT see the sticky bar (inline banners cover them instead)');

} finally {
  chromeProc.kill();
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
