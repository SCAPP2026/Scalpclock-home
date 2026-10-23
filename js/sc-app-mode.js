// ── SC App Mode — purchase guard for the Android (TWA) and iOS (Capacitor) apps ──
// Only ever loaded inside the store apps. Every page carries a one-line
// inline check in <head> that sets sessionStorage.sc_app when the page was
// opened by an app (Android: launch URL /learn?source=twa or an android-app://
// referrer; iOS: "ScalpClockApp-iOS" in the user agent) and only then
// document.write()s this file — regular website visitors never download it
// and see the site exactly as before.
//
// Why: Google Play's payments policy and App Store guideline 3.1.1 both
// require digital subscriptions sold inside a store app to use the store's
// own billing. ScalpClock sells Pro and
// Founding Member via Stripe, so the app sells nothing: purchase CTAs are
// hidden, /pricing and /success show a neutral notice, and Stripe checkout
// requests are refused client-side as a backstop. Existing subscribers just
// log in — plans live on the Supabase account (app_metadata.plan), so
// gating/unlocks work in the app with zero changes. The merch shop
// (/api/shop/checkout) is physical goods, which Play allows outside its
// billing, so it is deliberately left alone.
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('sc-app');
  var IOS = /ScalpClockApp-iOS/.test(navigator.userAgent);
  if (IOS) {
    root.classList.add('sc-app-ios');
    // Native extras (daily reminder, haptics) — see that file.
    document.write('<script src="/js/sc-ios-native.js" defer><\/script>');
  }

  // Selectors go through CSS (not a one-time DOM sweep) so CTAs that other
  // scripts insert or rewrite later — FounderCTA banners, FounderNav turning
  // "Learn Free" into a /pricing link, paywall modals — are hidden the
  // moment they appear, with no MutationObserver needed.
  var css = [
    'a[href*="/pricing"]',
    '[onclick*="heckout"]',
    '[onclick*="pricing"]',
    '[onclick*="setBilling"]',
    '[data-fc-cta]', '[data-fc-sticky-cta]',
    '.fc-banner', '.fc-sticky', '.fc-badge',
    '#promoBar', '#foundingHeroCard', '#founding',
    '.upgrade'
  ].map(function (s) { return '.sc-app ' + s; }).join(',') +
    '{display:none!important}';
  var style = document.createElement('style');
  style.textContent = css;
  (document.head || root).appendChild(style);

  // Backstop: no Stripe checkout session can be created from inside the app,
  // even if some CTA is reachable that the selectors above missed.
  var BLOCKED = /\/api\/stripe\/checkout|\/api\/stripe-checkout/;
  if (window.fetch) {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (BLOCKED.test(url)) {
        return Promise.resolve(new Response(
          JSON.stringify({ error: 'Plans are not available for purchase in the app.' }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        ));
      }
      return origFetch(input, init);
    };
  }

  // Purchase pages get replaced with a short notice instead of a plan grid.
  if (/^\/(pricing|success)(\.html)?\/?$/.test(location.pathname)) {
    document.addEventListener('DOMContentLoaded', function () {
      document.body.innerHTML =
        '<div style="max-width:440px;margin:18vh auto 0;padding:0 20px;text-align:center;' +
        'font-family:Inter,system-ui,sans-serif;color:#eef3f0;">' +
        '<div style="font-size:2.2rem;margin-bottom:12px;">📚</div>' +
        '<h1 style="font-family:Rajdhani,sans-serif;font-size:1.5rem;margin:0 0 10px;">Plans aren’t available in the app</h1>' +
        '<p style="color:rgba(238,243,240,.7);line-height:1.6;margin:0 0 22px;">Subscriptions can’t be purchased in the ScalpClock app. ' +
        'If you already have a plan, log in and it’s applied to your account automatically.</p>' +
        '<a href="/learn" style="display:inline-block;background:#16d97e;color:#04210f;font-weight:700;' +
        'text-decoration:none;padding:12px 22px;border-radius:10px;">Back to Daily Lessons</a></div>';
      document.body.style.background = '#070a08';
    });
  }
})();
