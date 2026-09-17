// ── FounderNav — swaps a page's top-nav "Learn Free" signup CTA to the
// live $1.99 Founding Member offer, mirroring the exact pattern already
// proven on the homepage hero (see index.html's initHeroCta()). Reuses
// FounderCTA's own lookups — no new network calls, no new eligibility
// logic. Falls back to leaving the nav CTA untouched for every other
// state (already a Founder/Pro, offer inactive, or lookup failure).
(function (global) {
  'use strict';

  async function initFounderNav(navId, drawerId) {
    if (typeof global.FounderCTA === 'undefined') return;
    try {
      const [state, status] = await Promise.all([
        global.FounderCTA.getPlanState(),
        global.FounderCTA.getFoundingStatus(),
      ]);
      const eligible = !state.isFounder && state.plan !== 'pro' && state.plan !== 'trial';
      if (!eligible || !status || status.active !== true) return;

      [navId, drawerId].filter(Boolean).forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.href = '/pricing#foundingCard';
        el.textContent = '🔥 $1.99 Founding Member';
        el.addEventListener('click', () => {
          if (typeof global.gtag === 'function') {
            global.gtag('event', 'nav_founding_cta_click');
            global.gtag('event', 'founding_member_cta_click', { surface: 'nav' });
          }
        });
      });
    } catch (e) { /* leave default nav CTA in place */ }
  }

  global.FounderNav = { initFounderNav };
})(window);
