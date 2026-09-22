// ── FounderCTA — reusable Founding Member promo banner + mobile sticky bar ──
// Deployed across high-intent pages (homepage, ScalpCharts, Replay, Exit
// Assistant, Signals, ORB Signal Engine) to keep the $1.99 Founding Member
// offer visible without re-nagging users who don't need to see it:
//   - Active Founding Members  -> "you're already locked in" badge, no CTA
//   - Active Pro subscribers    -> nothing rendered at all
//   - Founding offer sold out   -> nothing rendered at all (never references
//                                  an offer that no longer exists)
//   - Everyone else (anon/free) -> the real promo, gated by the same
//                                  public /api/founding-status endpoint
//                                  pricing.html's own countdown uses
//                                  (no spots-remaining count is shown here).
//
// Self-contained: creates its own Supabase client from the same public
// anon key already used site-wide (not a secret), so it works regardless
// of what a host page's own auth variable is named. Pairs with, but is
// independent of, js/founder-guard.js (which owns the checkout-time
// intercept/confirm modals, not this ambient promo surface).
(function (global) {
  'use strict';

  const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';
  const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZudXF4aWZscXFlamp0dHh5bWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzMxODksImV4cCI6MjA5ODAwOTE4OX0.XE1-LPW0043gRFEAl9onCahkmpQ8BMAAtGkF9FqJLiY';

  let sbClient = null;
  function getClient() {
    if (sbClient) return sbClient;
    if (typeof global.supabase === 'undefined') return null;
    try { sbClient = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON); } catch (e) { return null; }
    return sbClient;
  }

  async function getPlanState() {
    const client = getClient();
    if (!client) return { loggedIn: false, plan: 'anon', isFounder: false };
    try {
      const { data: { session } } = await client.auth.getSession();
      if (!session) return { loggedIn: false, plan: 'anon', isFounder: false };
      const meta = session.user.app_metadata || {};
      return { loggedIn: true, plan: meta.plan || 'free', isFounder: meta.founding_member === true, userId: session.user.id };
    } catch (e) { return { loggedIn: false, plan: 'anon', isFounder: false }; }
  }

  function getFoundingStatus() {
    if (typeof global.FounderGuard !== 'undefined') return global.FounderGuard.getFoundingStatus();
    return fetch('/api/founding-status').then(r => r.json()).catch(() => ({ active: false }));
  }

  function track(name, params) { if (typeof global.gtag === 'function') global.gtag('event', name, params); }

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const css = `
.fc-banner{font-family:'Inter',system-ui,sans-serif;background:linear-gradient(135deg,rgba(245,166,35,.12),rgba(245,166,35,.03));border:1px solid rgba(245,166,35,.35);border-radius:14px;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;color:#eef3f0;}
.fc-banner-copy{flex:1;min-width:200px;}
.fc-banner-eyebrow{font-family:'Rajdhani',sans-serif;font-weight:700;font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:#f5a623;margin-bottom:4px;}
.fc-banner-h{font-family:'Rajdhani',sans-serif;font-weight:700;font-size:1.05rem;color:#eef3f0;}
.fc-banner-sub{font-size:.8rem;color:rgba(238,243,240,.65);margin-top:2px;}
.fc-banner-btn{flex-shrink:0;font-family:'Rajdhani',sans-serif;font-weight:700;font-size:.9rem;padding:11px 20px;border-radius:10px;background:#f5a623;color:#1a0d00;text-decoration:none;white-space:nowrap;box-shadow:0 0 20px rgba(245,166,35,.3);transition:filter .15s,transform .1s;}
.fc-banner-btn:hover{filter:brightness(1.08);transform:translateY(-1px);}
.fc-banner.compact{padding:12px 16px;}
.fc-banner.compact .fc-banner-h{font-size:.92rem;}
.fc-badge{font-family:'Inter',system-ui,sans-serif;display:inline-flex;align-items:center;gap:8px;background:rgba(245,166,35,.1);border:1px solid rgba(245,166,35,.3);border-radius:10px;padding:10px 16px;color:#f5a623;font-size:.85rem;font-weight:600;}
.fc-sticky{position:fixed;left:0;right:0;bottom:0;z-index:500;background:#0e1610;border-top:1px solid rgba(245,166,35,.4);padding:10px 14px;display:flex;align-items:center;gap:10px;box-shadow:0 -8px 24px rgba(0,0,0,.35);font-family:'Inter',system-ui,sans-serif;}
.fc-sticky-copy{flex:1;min-width:0;}
.fc-sticky-h{font-family:'Rajdhani',sans-serif;font-weight:700;font-size:.86rem;color:#f5a623;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.fc-sticky-sub{font-size:.7rem;color:rgba(238,243,240,.6);}
.fc-sticky-btn{flex-shrink:0;font-family:'Rajdhani',sans-serif;font-weight:700;font-size:.82rem;padding:9px 16px;border-radius:9px;background:#f5a623;color:#1a0d00;text-decoration:none;white-space:nowrap;}
.fc-sticky-close{flex-shrink:0;background:none;border:none;color:rgba(238,243,240,.4);font-size:1.1rem;cursor:pointer;padding:4px 6px;line-height:1;}
@media(min-width:769px){.fc-sticky{display:none;}}
`;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  const DISMISS_KEY = 'sc_founder_sticky_dismissed';

  // ── Inline banner (used in-page: homepage, ScalpCharts, Replay, etc.) ──
  async function mount(container, opts = {}) {
    if (!container) return;
    const { mode = 'inline', location = 'unknown' } = opts;
    injectStyles();
    container.innerHTML = '';

    const [state, status] = await Promise.all([getPlanState(), getFoundingStatus()]);

    // Check isFounder FIRST — a Founding Member's app_metadata.plan also
    // reads 'pro' under the hood (see webhook.js: plan is set from the
    // Stripe subscription status regardless of founding_member), so the
    // generic "already paying, no nag" check below must not short-circuit
    // before this one runs, or every Founder would silently see nothing.
    if (state.isFounder) {
      container.innerHTML = `<div class="fc-badge">🏆 You're a Founding Member — locked in at $1.99/month for life.</div>`;
      return;
    }
    if (state.plan === 'pro' || state.plan === 'trial') return; // already an active paying (non-Founder) member — no nag
    if (!status || status.active !== true) return; // sold out / ended — never reference a dead offer

    container.innerHTML = `
      <div class="fc-banner ${mode === 'compact' ? 'compact' : ''}">
        <div class="fc-banner-copy">
          <div class="fc-banner-eyebrow">🔥 Founding Member Pricing</div>
          <div class="fc-banner-h">Full Pro access for $1.99/month — locked for life</div>
          ${mode === 'compact' ? '' : '<div class="fc-banner-sub">First 500 members only. Charged today, no trial.</div>'}
        </div>
        <a class="fc-banner-btn" href="/pricing#foundingCard" data-fc-cta>CLAIM MY $1.99 FOUNDER PRICE →</a>
      </div>`;

    const btn = container.querySelector('[data-fc-cta]');
    if (btn) btn.addEventListener('click', () => {
      track('founder_cta_click', { location });
      track('founding_member_cta_click', { location, surface: 'banner' });
    });
    track('founder_cta_view', { location });
  }

  // ── Mobile sticky bar (logged-out visitors only) ────────────────────────
  async function mountSticky(opts = {}) {
    const { location = 'unknown' } = opts;
    if (sessionStorage.getItem(DISMISS_KEY) === '1') return;
    injectStyles();

    const [state, status] = await Promise.all([getPlanState(), getFoundingStatus()]);
    // Only for fully logged-out visitors — a logged-in free user already
    // gets the full inline banners; this is specifically the anonymous-
    // visitor mobile nudge the spec calls for.
    if (state.loggedIn) return;
    if (!status || status.active !== true) return;

    const el = document.createElement('div');
    el.className = 'fc-sticky';
    el.innerHTML = `
      <div class="fc-sticky-copy">
        <div class="fc-sticky-h">🔥 $1.99 Founder Price</div>
        <div class="fc-sticky-sub">Locked for life</div>
      </div>
      <a class="fc-sticky-btn" href="/pricing#foundingCard" data-fc-sticky-cta>CLAIM MY SPOT</a>
      <button type="button" class="fc-sticky-close" data-fc-sticky-close aria-label="Dismiss">✕</button>
    `;
    document.body.appendChild(el);
    el.querySelector('[data-fc-sticky-cta]').addEventListener('click', () => track('founder_cta_click', { location: location + '_sticky' }));
    el.querySelector('[data-fc-sticky-close]').addEventListener('click', () => {
      track('founder_offer_dismissed', { location: location + '_sticky' });
      sessionStorage.setItem(DISMISS_KEY, '1');
      el.remove();
    });
    track('founder_cta_view', { location: location + '_sticky' });
  }

  global.FounderCTA = { mount, mountSticky, getPlanState, getFoundingStatus };
})(window);
