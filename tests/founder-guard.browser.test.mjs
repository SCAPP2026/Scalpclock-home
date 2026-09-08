/**
 * FounderGuard — real-browser smoke test via headless Chromium + CDP
 * (same technique this repo already uses elsewhere: Node's built-in
 * WebSocket, no puppeteer). Verifies the actual modal DOM/JS behaves
 * correctly for a JS file that can't be meaningfully unit-tested outside a
 * real DOM. Serves the repo statically on a local port, mocks
 * /api/founding-status responses, and drives the real js/founder-guard.js.
 *
 * Run with: node tests/founder-guard.browser.test.mjs
 * Requires: a `chromium` binary on PATH (already present in this env).
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8934;

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

// ── Tiny static server + mocked /api/founding-status ────────────────────
let mockStatus = { active: true, remaining: 42, cap: 500, cutoff: '2026-09-30T23:59:59Z' };
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/founding-status')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mockStatus));
    return;
  }
  const filePath = path.join(ROOT, req.url.startsWith('/tests/') ? req.url : req.url === '/' ? '/tests/fixtures/founder-guard-harness.html' : req.url);
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': filePath.endsWith('.js') ? 'application/javascript' : 'text/html' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise(resolve => server.listen(PORT, resolve));

// ── Minimal CDP client over the built-in WebSocket ──────────────────────
async function connectCDP() {
  const infoRes = await fetch('http://127.0.0.1:9333/json/version').catch(() => null);
  return null; // placeholder, replaced below by launch+discover flow
}

const chromeProc = spawn('chromium', [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=9333', 'about:blank',
], { stdio: 'ignore' });

async function waitForDevtools(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9333/json/version');
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Chromium devtools endpoint never came up');
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', reject);
  });
  function send(method, params = {}) {
    return ready.then(() => new Promise((resolve, reject) => {
      const thisId = ++id;
      pending.set(thisId, { resolve, reject });
      ws.send(JSON.stringify({ id: thisId, method, params }));
    }));
  }
  return { send, close: () => ws.close(), _ws: ws };
}

async function evalJS(client, expression, awaitPromise = true) {
  const result = await client.send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error('Eval error: ' + JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails));
  }
  return result.result?.value;
}

let client;
try {
  await waitForDevtools();
  const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
  const page = targets.find(t => t.type === 'page') || targets[0];
  client = cdpClient(page.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  async function navigate(url) {
    const loadFired = new Promise((resolve) => {
      const handler = (msg) => {
        try {
          const parsed = JSON.parse(msg.data);
          if (parsed.method === 'Page.loadEventFired') resolve();
        } catch {}
      };
      client._ws.addEventListener('message', handler, { once: false });
      setTimeout(resolve, 3000); // hard fallback so a missed event can't hang the suite
    });
    await client.send('Page.navigate', { url });
    await loadFired;
    await new Promise(r => setTimeout(r, 150)); // let founder-guard.js's own synchronous top-level run finish
  }

  // ── Test 1: Founding active -> intercept modal shows, structure correct ──
  mockStatus = { active: true, remaining: 42, cap: 500, cutoff: '2026-09-30T23:59:59Z' };
  await navigate(`http://127.0.0.1:${PORT}/`);
  await new Promise(r => setTimeout(r, 200));

  const startResult = await evalJS(client, `
    (async () => {
      window.__result = null;
      FounderGuard.interceptProClick().then(r => { window.__result = r; });
      await new Promise(r => setTimeout(r, 300));
      const overlay = document.querySelector('.fg-overlay');
      return {
        hasOverlay: !!overlay,
        hasFoundingBtn: !!document.querySelector('[data-fg="founding"]'),
        hasProBtn: !!document.querySelector('[data-fg="pro"]'),
        headline: document.querySelector('.fg-h')?.textContent || null,
        mentionsSpots: (document.querySelector('.fg-body')?.textContent || '').includes('42'),
      };
    })()
  `);
  assert(startResult.hasOverlay, 'intercept modal renders when Founding is active');
  assert(startResult.hasFoundingBtn && startResult.hasProBtn, 'both Founding and Pro buttons present');
  assert(/1\.99/.test(startResult.headline || ''), `headline mentions $1.99 (got "${startResult.headline}")`);
  assert(startResult.mentionsSpots, 'modal shows the REAL remaining-spots number from the mocked API, not a fabricated one');

  // Click "Continue with $9.99 Pro" and confirm the promise resolves correctly.
  const proContinueResult = await evalJS(client, `
    (async () => {
      document.querySelector('[data-fg="pro"]').click();
      await new Promise(r => setTimeout(r, 100));
      return { result: window.__result, overlayGone: !document.querySelector('.fg-overlay') };
    })()
  `);
  assert(proContinueResult.result?.action === 'continue_pro', `clicking "Continue with $9.99 Pro" resolves action=continue_pro (got ${JSON.stringify(proContinueResult.result)})`);
  assert(proContinueResult.overlayGone, 'modal is removed from the DOM after a choice is made');

  // ── Test 2: clicking "Claim Founding" resolves go_founding ──────────────
  await navigate(`http://127.0.0.1:${PORT}/`);
  await new Promise(r => setTimeout(r, 200));
  const foundingClickResult = await evalJS(client, `
    (async () => {
      window.__result2 = null;
      FounderGuard.interceptProClick().then(r => { window.__result2 = r; });
      await new Promise(r => setTimeout(r, 300));
      document.querySelector('[data-fg="founding"]').click();
      await new Promise(r => setTimeout(r, 100));
      return window.__result2;
    })()
  `);
  assert(foundingClickResult?.action === 'go_founding', `clicking "Claim $1.99 Founding Member" resolves action=go_founding (got ${JSON.stringify(foundingClickResult)})`);

  // ── Test 3: ESC key cancels ──────────────────────────────────────────────
  await navigate(`http://127.0.0.1:${PORT}/`);
  await new Promise(r => setTimeout(r, 200));
  const escResult = await evalJS(client, `
    (async () => {
      window.__result3 = null;
      FounderGuard.interceptProClick().then(r => { window.__result3 = r; });
      await new Promise(r => setTimeout(r, 300));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise(r => setTimeout(r, 100));
      return { result: window.__result3, overlayGone: !document.querySelector('.fg-overlay') };
    })()
  `);
  assert(escResult.result?.action === 'cancelled', `ESC key resolves action=cancelled (got ${JSON.stringify(escResult.result)})`);
  assert(escResult.overlayGone, 'ESC removes the modal from the DOM');

  // ── Test 4: click-outside (on the overlay backdrop) cancels ─────────────
  await navigate(`http://127.0.0.1:${PORT}/`);
  await new Promise(r => setTimeout(r, 200));
  const outsideClickResult = await evalJS(client, `
    (async () => {
      window.__result4 = null;
      FounderGuard.interceptProClick().then(r => { window.__result4 = r; });
      await new Promise(r => setTimeout(r, 300));
      document.querySelector('.fg-overlay').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      return window.__result4;
    })()
  `);
  assert(outsideClickResult?.action === 'cancelled', `clicking the backdrop resolves action=cancelled (got ${JSON.stringify(outsideClickResult)})`);

  // ── Test 5: Founding NOT active -> intercept resolves immediately, no modal ──
  mockStatus = { active: false, remaining: 0, cap: 500 };
  await navigate(`http://127.0.0.1:${PORT}/`);
  await new Promise(r => setTimeout(r, 200));
  const soldOutResult = await evalJS(client, `
    (async () => {
      const result = await FounderGuard.interceptProClick();
      return { result, overlayShown: !!document.querySelector('.fg-overlay') };
    })()
  `);
  assert(soldOutResult.result?.action === 'continue_pro', `Founding sold out -> interceptProClick resolves continue_pro immediately (got ${JSON.stringify(soldOutResult.result)})`);
  assert(!soldOutResult.overlayShown, 'no intercept modal is ever shown when Founding is not active (Phase 10 requirement)');

  // ── Test 6: confirmPro() and confirmFounding() render + resolve ─────────
  mockStatus = { active: true, remaining: 10, cap: 500 };
  await navigate(`http://127.0.0.1:${PORT}/`);
  await new Promise(r => setTimeout(r, 200));
  const confirmProResult = await evalJS(client, `
    (async () => {
      window.__cp = null;
      FounderGuard.confirmPro({ price: '$9.99', billing: 'monthly' }).then(r => { window.__cp = r; });
      await new Promise(r => setTimeout(r, 200));
      const text = document.querySelector('.fg-modal')?.textContent || '';
      const hasConfirmBtn = !!document.querySelector('[data-fg="confirm"]');
      document.querySelector('[data-fg="confirm"]').click();
      await new Promise(r => setTimeout(r, 100));
      return { text, hasConfirmBtn, resolved: window.__cp };
    })()
  `);
  assert(confirmProResult.hasConfirmBtn, 'confirmPro() modal renders a confirm button');
  assert(/\$0/.test(confirmProResult.text) && /9\.99/.test(confirmProResult.text), 'confirmPro() modal shows $0 today and the real $9.99 recurring price');
  assert(confirmProResult.resolved === true, `confirmPro() resolves true on confirm click (got ${confirmProResult.resolved})`);

  await navigate(`http://127.0.0.1:${PORT}/`);
  await new Promise(r => setTimeout(r, 200));
  const confirmFoundingResult = await evalJS(client, `
    (async () => {
      window.__cf = null;
      FounderGuard.confirmFounding().then(r => { window.__cf = r; });
      await new Promise(r => setTimeout(r, 200));
      const text = document.querySelector('.fg-modal')?.textContent || '';
      document.querySelector('[data-fg="back"]').click();
      await new Promise(r => setTimeout(r, 100));
      return { text, resolved: window.__cf };
    })()
  `);
  assert(/1\.99/.test(confirmFoundingResult.text) && /No free trial/i.test(confirmFoundingResult.text), 'confirmFounding() modal shows $1.99 and "No free trial"');
  assert(confirmFoundingResult.resolved === false, `confirmFounding() "Go Back" resolves false (got ${confirmFoundingResult.resolved})`);

} finally {
  if (client) client.close();
  chromeProc.kill();
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
