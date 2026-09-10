/**
 * Verifies the REAL scalpchart.html / exitassistant.html paywall walls
 * become Founder-aware: a free/expired user sees the $1.99 value-based
 * paywall when Founding is genuinely active, and the original generic
 * "Upgrade to Pro" copy otherwise — while anonymous visitors are unaffected.
 *
 * Each case gets its own fresh Chromium process (not a reused tab/session)
 * — a shared-tab version of this test hit real back-forward-cache state
 * bleed between navigations (confirmed harness artifact, not a product bug:
 * isolated single-navigation runs always rendered correctly). A fresh
 * process per case is slower but removes that whole class of flakiness.
 * Run with: node tests/paywall-founder-aware.browser.test.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
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

// Runs exactly ONE page load in a brand-new server + brand-new Chromium
// process, and returns whatever `extract` reads off the resulting DOM.
async function runOneCase({ pagePath, sessionUser, foundingStatus, extract }) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/founding-status')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(foundingStatus));
      return;
    }
    const filePath = path.join(ROOT, req.url.split('?')[0]);
    try {
      const body = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': ext === '.js' ? 'application/javascript' : 'text/html' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise(r => server.listen(port, r));

  const debugPort = 20000 + Math.floor(Math.random() * 20000);
  // Every headless chromium launch on this machine defaults to the SAME
  // shared profile dir (~/.config/chromium) when --user-data-dir isn't
  // passed — confirmed root cause of this suite's flakiness: cross-process
  // state (very likely Service Worker registration/cache; this app
  // registers /sw.js on every page) was bleeding between what should have
  // been fully independent test cases. A unique tmp profile per launch
  // guarantees real isolation.
  const profileDir = `/tmp/claude-1000/-home-iamtvic/2a82068f-f777-409b-a4d5-c571cf7ec610/scratchpad/chrome-profiles/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const chromeProc = spawn('chromium', ['--headless=new', '--disable-gpu', '--no-sandbox', `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`, 'about:blank'], { stdio: 'ignore' });

  try {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`); if (r.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    const page = targets.find(t => t.type === 'page') || targets[0];
    const client = cdpClient(page.webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Fetch.enable', { patterns: [{ urlPattern: '*supabase-js*' }] });
    client.on(async (msg) => {
      if (msg.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = msg.params;
      if (/supabase-js/.test(request.url)) {
        const sessionJs = sessionUser ? `({data:{session:{user:${JSON.stringify(sessionUser)}}}})` : `({data:{session:null}})`;
        const fakeJs = `window.supabase = { createClient: () => ({ auth: { getSession: async () => (${sessionJs}) } }) };`;
        await client.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }], body: Buffer.from(fakeJs).toString('base64') }).catch(() => {});
      } else {
        await client.send('Fetch.continueRequest', { requestId }).catch(() => {});
      }
    });

    const loadFired = new Promise((resolve) => { client.on((msg) => { if (msg.method === 'Page.loadEventFired') resolve(); }); setTimeout(resolve, 5000); });
    await client.send('Page.navigate', { url: `http://127.0.0.1:${port}/${pagePath}` });
    await loadFired;
    // Poll for the actual wall ELEMENT to exist (not a body.innerHTML
    // substring check — see EXTRACT_SUMMARY's comment on why that's unsafe
    // on this kind of page) as the real readiness signal.
    for (let i = 0; i < 30; i++) {
      const ready = await evalJS(client, `!!Array.from(document.querySelectorAll('div')).find(d => d.style.zIndex === '9999')`);
      if (ready) break;
      await new Promise(r => setTimeout(r, 150));
    }
    await new Promise(r => setTimeout(r, 100));
    return await evalJS(client, extract);
  } finally {
    chromeProc.kill();
    server.close();
  }
}

// IMPORTANT: must read rendered TEXT CONTENT of the actual paywall element,
// never document.body.innerHTML as a whole — the whole-body HTML also
// contains the literal, unexecuted source text of every inline <script>
// tag (script elements are children of <body>), which permanently includes
// BOTH ternary branches' string literals regardless of which one actually
// runs. Checking body.innerHTML.includes(...) is a false-positive trap on
// any page like this one; this cost real debugging time before being
// caught here, so keeping this comment for the next person who copies this
// pattern onto another page's paywall test.
const EXTRACT_SUMMARY = `((() => {
  const wall = Array.from(document.querySelectorAll('div')).find(d => d.style.zIndex === '9999');
  const wallText = wall ? wall.textContent : '';
  return {
    hasFounderCopy: wallText.includes('Founding Member Access'),
    hasGoldCta: !!document.querySelector('a[href="/pricing#foundingCard"]'),
    hasGenericUpgrade: wallText.includes('Upgrade to Pro'),
    hasSignupFlow: wallText.includes('Sign Up Free to Preview'),
  };
})())`;

for (const pagePath of ['exitassistant.html', 'scalpchart.html']) {
  const active = await runOneCase({
    pagePath, sessionUser: { id: 'u1', app_metadata: { plan: 'free' } },
    foundingStatus: { active: true, remaining: 10, cap: 500 }, extract: EXTRACT_SUMMARY,
  });
  assert(active.hasFounderCopy, `[${pagePath}] free user + Founding active -> value-based "Founding Member Access" paywall shown`);
  assert(active.hasGoldCta, `[${pagePath}] paywall CTA links to /pricing#foundingCard`);

  const soldOut = await runOneCase({
    pagePath, sessionUser: { id: 'u1', app_metadata: { plan: 'free' } },
    foundingStatus: { active: false, remaining: 0, cap: 500 }, extract: EXTRACT_SUMMARY,
  });
  assert(soldOut.hasGenericUpgrade, `[${pagePath}] Founding sold out -> original "Upgrade to Pro" copy still shown (regression check)`);
  assert(!soldOut.hasFounderCopy, `[${pagePath}] Founding sold out -> no Founder-specific copy shown`);

  const anon = await runOneCase({
    pagePath, sessionUser: null,
    foundingStatus: { active: true, remaining: 10, cap: 500 }, extract: EXTRACT_SUMMARY,
  });
  assert(anon.hasSignupFlow, `[${pagePath}] anonymous visitor still sees the original "Sign Up Free to Preview" flow, unaffected`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
