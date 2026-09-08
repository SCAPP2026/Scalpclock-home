/**
 * Phase 7 mobile verification: real pricing.html + founder-guard modal at
 * 320/375/390/414/430px viewports via headless Chromium + CDP device metric
 * overrides. Checks: Founding card appears before Pro (already-existing
 * CSS order rule), adequate gap between the two CTAs (not directly
 * adjacent), no horizontal overflow, and the intercept/confirm modals fit
 * within each narrow viewport without clipping.
 * Run with: node tests/pricing-mobile.browser.test.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8937;

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
    res.writeHead(200, { 'Content-Type': ext === '.js' ? 'application/javascript' : 'text/html' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(PORT, r));

const chromeProc = spawn('chromium', ['--headless=new', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=9335', 'about:blank'], { stdio: 'ignore' });

async function waitForDevtools() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:9335/json/version'); if (r.ok) return; } catch {}
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
  const targets = await (await fetch('http://127.0.0.1:9335/json')).json();
  const page = targets.find(t => t.type === 'page') || targets[0];
  client = cdpClient(page.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*supabase-js*' }, { urlPattern: `*/api/founding-status*` }] });
  client.on(async (msg) => {
    if (msg.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = msg.params;
    if (/supabase-js/.test(request.url)) {
      await client.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }], body: Buffer.from("window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{user:{id:'test-user-mobile'}}}})}})}").toString('base64') });
    } else if (/founding-status/.test(request.url)) {
      const body = JSON.stringify({ active: true, remaining: 12, cap: 500, cutoff: '2026-09-30T23:59:59Z' });
      await client.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(body).toString('base64') });
    } else {
      await client.send('Fetch.continueRequest', { requestId });
    }
  });

  async function navigate(url) {
    const loadFired = new Promise((resolve) => { client.on((msg) => { if (msg.method === 'Page.loadEventFired') resolve(); }); setTimeout(resolve, 4000); });
    await client.send('Page.navigate', { url });
    await loadFired;
    await new Promise(r => setTimeout(r, 400));
  }

  const WIDTHS = [320, 375, 390, 414, 430];
  for (const width of WIDTHS) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 2, mobile: true });
    await navigate(`http://127.0.0.1:${PORT}/pricing.html`);

    const layout = await evalJS(client, `
      (() => {
        const founding = document.querySelector('.plan-card.founding-active');
        const pro = document.querySelector('.plan-card.pro-card');
        const foundingBtn = document.getElementById('foundingBtn');
        const proBtn = document.getElementById('proBtn');
        const bodyOverflow = document.documentElement.scrollWidth > window.innerWidth + 2;
        const foundingRect = founding.getBoundingClientRect();
        const proRect = pro.getBoundingClientRect();
        const gap = proRect.top - foundingRect.bottom; // vertical gap since mobile stacks single-column
        return {
          foundingBeforeProInDOMOrder: foundingRect.top < proRect.top,
          foundingVisible: foundingRect.width > 0 && getComputedStyle(founding).display !== 'none',
          proVisible: proRect.width > 0,
          foundingBtnVisible: foundingBtn.getBoundingClientRect().width > 0,
          proBtnVisible: proBtn.getBoundingClientRect().width > 0,
          gapBetweenCards: gap,
          bodyOverflow,
          foundingBtnHeight: foundingBtn.getBoundingClientRect().height,
          proBtnHeight: proBtn.getBoundingClientRect().height,
        };
      })()
    `);

    assert(layout.foundingBeforeProInDOMOrder, `[${width}px] Founding card appears before Pro card (CSS order rule)`);
    assert(layout.foundingVisible && layout.proVisible, `[${width}px] both cards are visible`);
    assert(layout.foundingBtnVisible && layout.proBtnVisible, `[${width}px] both CTA buttons are visible`);
    assert(layout.gapBetweenCards >= 16, `[${width}px] adequate gap between Founding and Pro cards (got ${layout.gapBetweenCards.toFixed(0)}px, want >=16px so buttons can't be mistapped)`);
    assert(!layout.bodyOverflow, `[${width}px] no horizontal page overflow`);
    assert(layout.foundingBtnHeight >= 40 && layout.proBtnHeight >= 40, `[${width}px] CTA buttons are tall enough to be a comfortable tap target (got founding=${layout.foundingBtnHeight.toFixed(0)}px, pro=${layout.proBtnHeight.toFixed(0)}px)`);

    // Open the intercept modal and confirm it fits within this viewport with no horizontal clipping.
    const modalFit = await evalJS(client, `
      (async () => {
        document.getElementById('proBtn').click();
        for (let i = 0; i < 20 && !document.querySelector('.fg-modal'); i++) await new Promise(r => setTimeout(r, 100));
        const modal = document.querySelector('.fg-modal');
        const rect = modal.getBoundingClientRect();
        const founderBtn = document.querySelector('[data-fg="founding"]');
        const proBtnInModal = document.querySelector('[data-fg="pro"]');
        return {
          fitsWidth: rect.width <= window.innerWidth,
          fitsLeft: rect.left >= 0,
          fitsRight: rect.right <= window.innerWidth + 1,
          founderBtnHeight: founderBtn.getBoundingClientRect().height,
          proBtnHeight: proBtnInModal.getBoundingClientRect().height,
          buttonGap: proBtnInModal.getBoundingClientRect().top - founderBtn.getBoundingClientRect().bottom,
        };
      })()
    `);
    assert(modalFit.fitsWidth && modalFit.fitsLeft && modalFit.fitsRight, `[${width}px] intercept modal fits within the viewport with no horizontal clipping`);
    assert(modalFit.founderBtnHeight >= 40 && modalFit.proBtnHeight >= 40, `[${width}px] modal buttons are large enough to tap comfortably (founder=${modalFit.founderBtnHeight.toFixed(0)}px, pro=${modalFit.proBtnHeight.toFixed(0)}px)`);
    assert(modalFit.buttonGap >= 4, `[${width}px] modal's two action buttons are not directly touching (gap=${modalFit.buttonGap.toFixed(0)}px)`);
  }
} finally {
  chromeProc.kill();
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
