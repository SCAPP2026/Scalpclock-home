// Google Play badge — adds "Get it on Google Play" to the site footer and to
// any element marked data-play-badge. Skipped inside the store apps
// (sc-app-mode.js adds .sc-app to <html>), where it would be pointless.
(function () {
  'use strict';
  var URL = 'https://play.google.com/store/apps/details?id=com.scalpclock.app&utm_source=scalpclock.com&utm_medium=';

  function badge(medium, height) {
    var a = document.createElement('a');
    a.className = 'sc-play-badge';
    a.href = URL + medium;
    a.target = '_blank';
    a.rel = 'noopener';
    a.setAttribute('aria-label', 'Get ScalpClock on Google Play');
    a.style.cssText = 'display:inline-block;line-height:0;';
    var img = document.createElement('img');
    img.src = '/img/google-play-badge.png';
    img.alt = 'Get it on Google Play';
    img.width = Math.round(height * 646 / 250);
    img.height = height;
    img.loading = 'lazy';
    a.appendChild(img);
    return a;
  }

  function run() {
    if (document.documentElement.classList.contains('sc-app')) return;

    var slots = document.querySelectorAll('[data-play-badge]');
    for (var i = 0; i < slots.length; i++) {
      if (!slots[i].querySelector('.sc-play-badge')) {
        slots[i].appendChild(badge(slots[i].getAttribute('data-play-badge') || 'page', 60));
      }
    }

    var footer = document.querySelector('footer');
    if (footer && !footer.querySelector('.sc-play-badge')) {
      var wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0 14px;font-size:.8rem;opacity:.85;';
      var label = document.createElement('span');
      label.textContent = 'Daily lessons on your phone:';
      wrap.appendChild(label);
      wrap.appendChild(badge('footer', 48));
      var inner = footer.querySelector('.foot-copy');
      if (inner) inner.parentNode.insertBefore(wrap, inner);
      else footer.appendChild(wrap);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
