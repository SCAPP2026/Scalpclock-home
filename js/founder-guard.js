// ── FounderGuard — shared Pro/Founding-Member checkout safeguard ───────────
// Included on every page with a "Start Pro Trial" CTA (pricing.html,
// index.html, signals.html, dashboard.html, settings.html) so a user who
// clicks the $9.99 Pro option while $1.99 Founding Member spots are still
// available gets one clear chance to switch before Stripe checkout is ever
// created — and so both plans get a final, unambiguous confirmation step
// right before the Stripe redirect.
//
// Pure UI + one GET to the existing public /api/founding-status endpoint —
// no Supabase dependency, no page-specific coupling. Each host page keeps
// its own existing startCheckout()/startFoundingCheckout() implementation;
// this module only decides WHETHER and HOW to ask the user first, via two
// async functions that resolve to a plain result the caller acts on:
//
//   const gate = await FounderGuard.interceptProClick();
//   if (gate.action === 'cancelled') return;                 // user backed out
//   if (gate.action === 'go_founding') { location.href = '/pricing#founding-plan'; return; }
//   // gate.action === 'continue_pro' -> fall through to the page's own Pro checkout
//
//   const confirmed = await FounderGuard.confirmPro({ price: '$9.99', billing: 'monthly' });
//   if (!confirmed) return;
//   // proceed with the existing fetch('/api/stripe/checkout', ...) call
//
// Never fabricates Founder availability or a spots-remaining count — it
// only ever repeats exactly what /api/founding-status (the same
// server-verified source pricing.html's own countdown uses) returns.
(function (global) {
  'use strict';

  const STATUS_URL = '/api/founding-status';
  let statusPromise = null;

  function getFoundingStatus() {
    if (!statusPromise) {
      statusPromise = fetch(STATUS_URL)
        .then(r => r.json())
        .catch(() => ({ active: false }));
      // Don't cache a failed/negative lookup forever within a long-lived
      // page session — a brief network hiccup shouldn't permanently hide
      // the intercept for the rest of the visit. Successful lookups are
      // still reused for this page load (avoids refetching on every click).
      statusPromise.then(s => { if (!s || s.active !== true) statusPromise = null; });
    }
    return statusPromise;
  }

  function track(name, params) {
    if (typeof global.gtag === 'function') global.gtag('event', name, params);
  }

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = `
.fg-overlay{position:fixed;inset:0;background:rgba(4,6,5,.78);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;animation:fgFadeIn .15s ease;}
@keyframes fgFadeIn{from{opacity:0}to{opacity:1}}
.fg-modal{background:#0e1610;border:1px solid rgba(120,200,160,.18);border-radius:18px;max-width:480px;width:100%;max-height:calc(100vh - 40px);overflow-y:auto;padding:28px 26px;font-family:'Inter',system-ui,sans-serif;color:#eef3f0;box-shadow:0 24px 80px rgba(0,0,0,.5);}
.fg-modal *{box-sizing:border-box;}
.fg-eyebrow{font-family:'Rajdhani',sans-serif;font-weight:700;font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;color:#f5a623;margin-bottom:10px;}
.fg-h{font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.35rem;line-height:1.25;margin-bottom:14px;color:#eef3f0;}
.fg-body{font-size:.92rem;line-height:1.65;color:rgba(238,243,240,.8);margin-bottom:18px;}
.fg-compare{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;}
.fg-plan{border-radius:12px;padding:16px 14px;border:1px solid rgba(120,200,160,.15);}
.fg-plan.gold{border-color:#f5a623;background:rgba(245,166,35,.07);}
.fg-plan-name{font-family:'Rajdhani',sans-serif;font-weight:700;font-size:.85rem;margin-bottom:2px;}
.fg-plan.gold .fg-plan-name{color:#f5a623;}
.fg-plan-price{font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.3rem;margin-bottom:8px;}
.fg-plan ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;}
.fg-plan li{font-size:.78rem;color:rgba(238,243,240,.75);display:flex;gap:6px;align-items:flex-start;}
.fg-plan.gold li b{color:#f5a623;flex-shrink:0;}
.fg-plan:not(.gold) li b{color:rgba(238,243,240,.4);flex-shrink:0;}
.fg-btn{display:block;width:100%;font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1rem;padding:14px;border-radius:11px;border:none;cursor:pointer;text-align:center;margin-bottom:10px;transition:transform .1s,filter .15s;}
.fg-btn:hover{filter:brightness(1.08);transform:translateY(-1px);}
.fg-btn:disabled{opacity:.55;cursor:not-allowed;transform:none;}
.fg-btn-gold{background:#f5a623;color:#1a0d00;box-shadow:0 0 22px rgba(245,166,35,.3);}
.fg-btn-ghost{background:transparent;border:1px solid rgba(120,200,160,.25);color:#eef3f0;}
.fg-btn-green{background:#16d97e;color:#04150d;box-shadow:0 0 22px rgba(22,217,126,.3);}
.fg-fine{font-size:.76rem;color:rgba(238,243,240,.5);text-align:center;margin-top:2px;margin-bottom:6px;}
.fg-why{display:block;text-align:center;font-size:.78rem;color:rgba(238,243,240,.5);text-decoration:underline;background:none;border:none;cursor:pointer;margin:8px auto 0;font-family:inherit;}
.fg-why-body{display:none;font-size:.78rem;color:rgba(238,243,240,.6);background:rgba(120,200,160,.06);border-radius:8px;padding:10px 12px;margin-top:8px;line-height:1.5;}
.fg-why-body.open{display:block;}
@media(max-width:480px){.fg-compare{grid-template-columns:1fr;}.fg-modal{padding:22px 18px;}}
`;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function showModal(html, wire) {
    return new Promise((resolve) => {
      injectStyles();
      const overlay = document.createElement('div');
      overlay.className = 'fg-overlay';
      overlay.innerHTML = `<div class="fg-modal" role="dialog" aria-modal="true" aria-live="polite">${html}</div>`;
      document.body.appendChild(overlay);
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';

      function cleanup(result) {
        document.body.style.overflow = prevOverflow;
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(result);
      }
      function onKey(e) { if (e.key === 'Escape') cleanup({ action: 'cancelled' }); }
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup({ action: 'cancelled' }); });

      const modal = overlay.querySelector('.fg-modal');
      wire(modal, cleanup);
      const firstBtn = modal.querySelector('button, a[href]');
      if (firstBtn) firstBtn.focus();
    });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ── Phase 5: Founder Protection Intercept ─────────────────────────────
  // Only called by the host page when the user clicks the $9.99 Pro CTA.
  // Resolves immediately with continue_pro if Founding isn't active — never
  // shows a modal referencing an offer that isn't real.
  async function interceptProClick() {
    const status = await getFoundingStatus();
    if (!status || status.active !== true) return { action: 'continue_pro' };

    track('pro_founder_intercept_shown');

    const remaining = Number.isFinite(status.remaining) ? status.remaining : null;
    const spotsLine = remaining != null ? `${remaining} of ${status.cap || 500} Founding Member spots remain.` : 'Founding Member spots are currently available.';

    const html = `
      <div class="fg-eyebrow">🔥 Wait</div>
      <div class="fg-h">You may want the $1.99 Founder price</div>
      <div class="fg-body">You're about to start the regular Pro plan at $9.99/month after a 5-day free trial. ${esc(spotsLine)} That price is locked for life, charged today, no trial.</div>
      <div class="fg-compare">
        <div class="fg-plan gold">
          <div class="fg-plan-name">FOUNDING MEMBER</div>
          <div class="fg-plan-price">$1.99<span style="font-size:.6em;color:rgba(238,243,240,.55)">/mo</span></div>
          <ul>
            <li><b>✓</b> Locked for life</li>
            <li><b>✓</b> Full Pro access</li>
            <li><b>✓</b> Founding Member badge</li>
            <li><b>✓</b> Referral benefits</li>
            <li><b>✓</b> Charged today</li>
          </ul>
        </div>
        <div class="fg-plan">
          <div class="fg-plan-name">REGULAR PRO</div>
          <div class="fg-plan-price">$9.99<span style="font-size:.6em;color:rgba(238,243,240,.55)">/mo</span></div>
          <ul>
            <li><b>✓</b> 5-day free trial</li>
            <li><b>✓</b> Full Pro access</li>
            <li><b>✓</b> Standard monthly pricing</li>
            <li><b>✗</b> No Founder benefits</li>
          </ul>
        </div>
      </div>
      <button type="button" class="fg-btn fg-btn-gold" data-fg="founding">🔥 CLAIM $1.99 FOUNDING MEMBER</button>
      <button type="button" class="fg-btn fg-btn-ghost" data-fg="pro">Continue with $9.99 Pro</button>
      <button type="button" class="fg-why" data-fg="why">Why am I seeing this?</button>
      <div class="fg-why-body" id="fgWhyBody">Some visitors have started the $9.99 Pro trial without noticing the $1.99 Founding Member offer next to it. This is just a chance to make sure you're getting the plan you actually want — pick either one, no penalty either way.</div>
    `;

    const result = await showModal(html, (modal, cleanup) => {
      modal.querySelector('[data-fg="founding"]').onclick = () => {
        track('pro_founder_intercept_founder_selected');
        cleanup({ action: 'go_founding' });
      };
      modal.querySelector('[data-fg="pro"]').onclick = () => {
        track('pro_founder_intercept_pro_continued');
        cleanup({ action: 'continue_pro' });
      };
      modal.querySelector('[data-fg="why"]').onclick = () => {
        modal.querySelector('#fgWhyBody').classList.toggle('open');
      };
    });
    return result;
  }

  // ── Phase 6: final checkout confirmation (both plans) ─────────────────
  async function confirmPro({ price = '$9.99', billing = 'monthly' } = {}) {
    const priceLabel = billing === 'annual' ? `${price}/month, billed annually` : `${price}/month`;
    const html = `
      <div class="fg-eyebrow">Confirm Your Plan</div>
      <div class="fg-h">Confirm Your Pro Plan</div>
      <div class="fg-body" style="margin-bottom:10px;">ScalpClock Pro — 5-day free trial</div>
      <div class="fg-plan" style="margin-bottom:16px;">
        <div class="fg-plan-price">$0 <span style="font-size:.55em;color:rgba(238,243,240,.55)">today</span></div>
        <div class="fg-fine" style="margin-top:6px;">Then ${esc(priceLabel)} unless cancelled before the trial ends.</div>
      </div>
      <button type="button" class="fg-btn fg-btn-green" data-fg="confirm">START MY 5-DAY PRO TRIAL</button>
      <button type="button" class="fg-btn fg-btn-ghost" data-fg="back">Go Back</button>
    `;
    const result = await showModal(html, (modal, cleanup) => {
      modal.querySelector('[data-fg="confirm"]').onclick = () => cleanup({ action: 'confirmed' });
      modal.querySelector('[data-fg="back"]').onclick = () => cleanup({ action: 'cancelled' });
    });
    return result.action === 'confirmed';
  }

  async function confirmFounding() {
    const html = `
      <div class="fg-eyebrow">Confirm Your Plan</div>
      <div class="fg-h">Confirm Your Founding Member Plan</div>
      <div class="fg-body" style="margin-bottom:10px;">ScalpClock Founding Member</div>
      <div class="fg-plan gold" style="margin-bottom:16px;">
        <div class="fg-plan-price">$1.99<span style="font-size:.6em;color:rgba(238,243,240,.55)">/mo</span></div>
        <ul>
          <li><b>✓</b> Price locked for life</li>
          <li><b>✓</b> Full Pro access</li>
          <li><b>✓</b> Founding Member benefits</li>
        </ul>
      </div>
      <div class="fg-fine" style="margin-bottom:12px;">Charged today: $1.99. No free trial.</div>
      <button type="button" class="fg-btn fg-btn-gold" data-fg="confirm">CONFIRM $1.99 FOUNDING MEMBER</button>
      <button type="button" class="fg-btn fg-btn-ghost" data-fg="back">Go Back</button>
    `;
    const result = await showModal(html, (modal, cleanup) => {
      modal.querySelector('[data-fg="confirm"]').onclick = () => cleanup({ action: 'confirmed' });
      modal.querySelector('[data-fg="back"]').onclick = () => cleanup({ action: 'cancelled' });
    });
    return result.action === 'confirmed';
  }

  global.FounderGuard = { getFoundingStatus, interceptProClick, confirmPro, confirmFounding };
})(window);
