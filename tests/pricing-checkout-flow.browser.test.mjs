/**
 * End-to-end browser test of the REAL pricing.html page: verifies clicking
 * the Pro CTA actually triggers the Founder Protection Intercept, then the
 * final confirmation, then posts the correct body to /api/stripe/checkout —
 * and that clicking the Founding CTA goes straight to its own confirmation
 * and posts the correct founding_member body. Uses headless Chromium + CDP
 * request interception to stub the Supabase CDN script (fake logged-in
 * session) and the two API calls, so no live network/credentials are used.
 *
 * Run with: node tests/pricing-checkout-flow.browser.test.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8936;

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

const server = http.createServer(async (req, res) => {
  const filePath = path.join(ROOT, req.url.split('?')[0]);
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath);
    const type = ext === '.js' ? 'application/javascript' : ext === '.html' ? 'text/html' : 'text/plain';
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise(resolve => server.listen(PORT, resolve));

const chromeProc = spawn('chromium', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=9334', 'about:blank',
], { stdio: 'ignore' });

async function waitForDevtools(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch('http://127.0.0.1:9334/json/version'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Chromium devtools endpoint never came up');
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const eventHandlers = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method) {
      eventHandlers.forEach(h => h(msg));
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  function send(method, params = {}) {
    return ready.then(() => new Promise((resolve, reject) => {
      const thisId = ++id;
      pending.set(thisId, { resolve, reject });
      ws.send(JSON.stringify({ id: thisId, method, params }));
    }));
  }
  function on(handler) { eventHandlers.push(handler); }
  return { send, on, close: () => ws.close() };
}

async function evalJS(client, expression, awaitPromise = true) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error('Eval error: ' + JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails));
  }
  return result.result?.value;
}

let client;
const checkoutCalls = [];
try {
  await waitForDevtools();
  const targets = await (await fetch('http://127.0.0.1:9334/json')).json();
  const page = targets.find(t => t.type === 'page') || targets[0];
  client = cdpClient(page.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  await client.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*supabase-js*' },
      { urlPattern: '*://scalpclock.com/api/founding-status*' },
      { urlPattern: `http://127.0.0.1:${PORT}/api/founding-status*` },
      { urlPattern: `http://127.0.0.1:${PORT}/api/stripe/checkout*` },
    ],
  });

  client.on(async (msg) => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = msg.params;
    if (/supabase-js/.test(request.url)) {
      // Fake, minimal Supabase client — just enough for pricing.html's
      // `_sb.auth.getSession()` calls to resolve a logged-in test user.
      const fakeJs = `
        window.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: 'test-user-123' } } } }) } }) };
      `;
      await client.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }],
        body: Buffer.from(fakeJs).toString('base64'),
      });
    } else if (/founding-status/.test(request.url)) {
      const body = JSON.stringify({ active: true, remaining: 7, cap: 500, cutoff: '2026-09-30T23:59:59Z', referralProgramEnabled: true, currentReferralRate: 1.0 });
      await client.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(body).toString('base64'),
      });
    } else if (/stripe\/checkout/.test(request.url)) {
      checkoutCalls.push(JSON.parse(request.postData || '{}'));
      const body = JSON.stringify({ url: 'https://checkout.stripe.com/fake-session' });
      await client.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(body).toString('base64'),
      });
    } else {
      await client.send('Fetch.continueRequest', { requestId });
    }
  });

  async function navigate(url) {
    const loadFired = new Promise((resolve) => {
      const handler = (msg) => { if (msg.method === 'Page.loadEventFired') resolve(); };
      client.on(handler);
      setTimeout(resolve, 4000);
    });
    await client.send('Page.navigate', { url });
    await loadFired;
    await new Promise(r => setTimeout(r, 400));
  }

  // Prevent the real redirect to Stripe from navigating the page away
  // (which would kill our ability to inspect state) — stub
  // window.location.href assignment by intercepting via a getter/setter
  // isn't trivial across navigations, so instead we just check
  // `checkoutCalls` (captured server-side via Fetch interception) and stop
  // short of asserting the final redirect itself.

  await navigate(`http://127.0.0.1:${PORT}/pricing.html`);

  // ── Test A: Pro CTA -> intercept -> continue with Pro -> confirm -> checkout body ──
  const flowA = await evalJS(client, `
    (async () => {
      const btn = document.getElementById('proBtn');
      btn.click();
      // Wait for the intercept modal, click "Continue with $9.99 Pro"
      for (let i = 0; i < 20 && !document.querySelector('[data-fg="pro"]'); i++) await new Promise(r => setTimeout(r, 100));
      const interceptShown = !!document.querySelector('[data-fg="pro"]');
      document.querySelector('[data-fg="pro"]').click();
      // Wait for the confirm-Pro modal, click confirm
      for (let i = 0; i < 20 && !document.querySelector('[data-fg="confirm"]'); i++) await new Promise(r => setTimeout(r, 100));
      const confirmShown = !!document.querySelector('[data-fg="confirm"]');
      document.querySelector('[data-fg="confirm"]').click();
      await new Promise(r => setTimeout(r, 300));
      return { interceptShown, confirmShown };
    })()
  `);
  assert(flowA.interceptShown, 'Test A: clicking the real Pro CTA on pricing.html shows the Founder Protection Intercept');
  assert(flowA.confirmShown, 'Test A: choosing "Continue with $9.99 Pro" shows the final Pro confirmation modal');
  const proCall = checkoutCalls.find(c => c.tier === 'pro');
  assert(!!proCall, `Test A: /api/stripe/checkout was called with tier=pro after confirming (calls so far: ${JSON.stringify(checkoutCalls)})`);
  assert(proCall && proCall.userId === 'test-user-123', 'Test A: checkout body includes the real (fake-session) userId');
  assert(proCall && proCall.trial === true, 'Test A: checkout body correctly requests a trial for the Pro plan');

  // ── Test B: Founding CTA -> confirm -> checkout body (no intercept for the intentional path) ──
  checkoutCalls.length = 0;
  await navigate(`http://127.0.0.1:${PORT}/pricing.html`);
  const flowB = await evalJS(client, `
    (async () => {
      const btn = document.getElementById('foundingBtn');
      btn.click();
      for (let i = 0; i < 20 && !document.querySelector('[data-fg="confirm"]'); i++) await new Promise(r => setTimeout(r, 100));
      const confirmShown = !!document.querySelector('[data-fg="confirm"]');
      const confirmText = document.querySelector('.fg-modal')?.textContent || '';
      document.querySelector('[data-fg="confirm"]').click();
      await new Promise(r => setTimeout(r, 300));
      return { confirmShown, confirmText };
    })()
  `);
  assert(flowB.confirmShown, 'Test B: clicking the real Founding CTA shows the Founding confirmation modal directly (no intercept)');
  assert(/1\.99/.test(flowB.confirmText) && /No free trial/i.test(flowB.confirmText), 'Test B: Founding confirmation shows $1.99 and "No free trial"');
  const foundingCall = checkoutCalls.find(c => c.tier === 'founding_member');
  assert(!!foundingCall, `Test B: /api/stripe/checkout was called with tier=founding_member (calls: ${JSON.stringify(checkoutCalls)})`);
  assert(foundingCall && foundingCall.trial === false, 'Test B: checkout body explicitly sets trial=false for Founding');

  // ── Test C: "go_founding" path from the intercept routes into the Founding confirmation, not straight to Stripe ──
  checkoutCalls.length = 0;
  await navigate(`http://127.0.0.1:${PORT}/pricing.html`);
  const flowC = await evalJS(client, `
    (async () => {
      document.getElementById('proBtn').click();
      for (let i = 0; i < 20 && !document.querySelector('[data-fg="founding"]'); i++) await new Promise(r => setTimeout(r, 100));
      document.querySelector('[data-fg="founding"]').click();
      for (let i = 0; i < 20 && !document.querySelector('[data-fg="confirm"]'); i++) await new Promise(r => setTimeout(r, 100));
      const foundingConfirmShown = !!document.querySelector('[data-fg="confirm"]');
      const text = document.querySelector('.fg-modal')?.textContent || '';
      return { foundingConfirmShown, text };
    })()
  `);
  assert(flowC.foundingConfirmShown, 'Test C: choosing "Claim $1.99 Founding Member" from the intercept leads to the Founding confirmation (not straight to Stripe)');
  assert(/1\.99/.test(flowC.text), 'Test C: that confirmation is genuinely the Founding one ($1.99), not the Pro one');

} finally {
  if (client) client.close();
  chromeProc.kill();
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
