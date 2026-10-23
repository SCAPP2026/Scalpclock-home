// ── SC iOS Native — extras that only run inside the ScalpClock iOS app ──
// Loaded by /js/sc-app-mode.js when the user agent contains "ScalpClockApp-iOS"
// (set by the Capacitor shell in ~/scalpclock-lessons-ios). The app loads the
// live site, and Capacitor injects window.Capacitor into it, so these features
// ship with the website — no App Store update needed to change them.
//
// What it adds (App Store guideline 4.2 expects more than a website in a frame):
//   • Daily lesson reminder — a local notification at a time the user picks
//   • Streak saver — one alert 2h before the streak day rolls over, only if
//     no lesson was done today (streak days follow UTC, like /learn does)
//   • Haptics on quiz/practice answers and on lesson completion
//   • A "Daily reminder" control on /settings
//
// Everything is guarded: if the native bridge is missing, nothing happens.
(function () {
  'use strict';
  var C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;

  var DAILY_ID = 1001, STREAK_ID = 1002;
  var PREF = 'sc_ios_reminder';            // {on:bool, time:"HH:MM"} or absent
  var ASKED = 'sc_ios_reminder_asked';     // set once the prompt was answered

  function call(plugin, method, opts) {
    try {
      var p = C.Plugins && C.Plugins[plugin];
      if (p && typeof p[method] === 'function') return Promise.resolve(p[method](opts || {}));
      if (typeof C.nativePromise === 'function') return C.nativePromise(plugin, method, opts || {});
    } catch (e) {}
    return Promise.resolve(null);
  }
  function get(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // ── Haptics ──
  function haptic(kind) {
    if (kind === 'success' || kind === 'error') {
      call('Haptics', 'notification', { type: kind === 'success' ? 'SUCCESS' : 'ERROR' });
    } else {
      call('Haptics', 'impact', { style: 'LIGHT' });
    }
  }
  function wrap(name, after) {
    var orig = window[name];
    if (typeof orig !== 'function' || orig.__scWrapped) return;
    var w = function () {
      var r = orig.apply(this, arguments);
      try { after(); } catch (e) {}
      return r;
    };
    w.__scWrapped = true;
    window[name] = w;
  }
  function isCorrect(id) {
    var el = document.getElementById(id);
    return el && el.classList.contains('correct');
  }

  // ── Streak helpers (same storage + UTC day as /learn) ──
  function todayUTC() { return new Date().toISOString().slice(0, 10); }
  function doneToday() { return get('sc_streak_date', '') === todayUTC(); }
  function streakCount() {
    var last = get('sc_streak_date', ''), d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    var y = d.toISOString().slice(0, 10);
    return (last === todayUTC() || last === y) ? get('sc_streak_count', 0) : 0;
  }

  // ── Notifications ──
  function scheduleDaily(time) {
    var hm = (time || '08:00').split(':');
    return call('LocalNotifications', 'cancel', { notifications: [{ id: DAILY_ID }] }).then(function () {
      return call('LocalNotifications', 'schedule', { notifications: [{
        id: DAILY_ID,
        title: 'Your daily lesson is ready 📚',
        body: 'Five minutes of trading practice keeps your streak alive.',
        schedule: { on: { hour: +hm[0], minute: +hm[1] }, allowWhileIdle: true },
        extra: { url: '/learn' }
      }] });
    });
  }
  function refreshStreakSaver() {
    var pref = get(PREF, null);
    call('LocalNotifications', 'cancel', { notifications: [{ id: STREAK_ID }] }).then(function () {
      if (!pref || !pref.on || doneToday()) return;
      var n = streakCount();
      if (n < 1) return;
      var end = new Date(); end.setUTCHours(24, 0, 0, 0);       // next UTC midnight
      var at = new Date(end.getTime() - 2 * 3600 * 1000);
      var h = at.getHours();
      if (at.getTime() < Date.now() + 5 * 60 * 1000 || h < 9 || h >= 22) return; // no odd-hour pings
      call('LocalNotifications', 'schedule', { notifications: [{
        id: STREAK_ID,
        title: '🔥 Your ' + n + '-day streak is at risk',
        body: 'Finish one lesson in the next 2 hours to keep it going.',
        schedule: { at: at.toISOString(), allowWhileIdle: true },
        extra: { url: '/learn' }
      }] });
    });
  }
  function enableReminder(time) {
    return call('LocalNotifications', 'requestPermissions').then(function (r) {
      var ok = r && r.display === 'granted';
      set(ASKED, true);
      if (!ok) { set(PREF, { on: false, time: time }); return false; }
      set(PREF, { on: true, time: time });
      return scheduleDaily(time).then(function () { refreshStreakSaver(); return true; });
    });
  }
  function disableReminder() {
    var pref = get(PREF, {}) || {};
    set(PREF, { on: false, time: pref.time || '08:00' });
    return call('LocalNotifications', 'cancel', { notifications: [{ id: DAILY_ID }, { id: STREAK_ID }] });
  }

  // Tapping a notification opens the lesson page.
  try {
    var LN = C.Plugins && C.Plugins.LocalNotifications;
    if (LN && LN.addListener) {
      LN.addListener('localNotificationActionPerformed', function (ev) {
        var url = ev && ev.notification && ev.notification.extra && ev.notification.extra.url;
        if (url && location.pathname !== url) location.href = url;
      });
    }
  } catch (e) {}

  // ── UI ──
  var CSS =
    '.sc-ios-sheet{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:99999;' +
    'background:#101612;border:1px solid rgba(22,217,126,.3);border-radius:18px;padding:18px;color:#eef3f0;' +
    'font-family:Inter,-apple-system,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6);' +
    'transform:translateY(140%);transition:transform .35s cubic-bezier(.2,.9,.3,1)}' +
    '.sc-ios-sheet.show{transform:none}' +
    '.sc-ios-sheet h3{margin:0 0 6px;font-size:1.05rem}' +
    '.sc-ios-sheet p{margin:0 0 14px;color:rgba(238,243,240,.7);font-size:.9rem;line-height:1.45}' +
    '.sc-ios-row{display:flex;gap:10px;align-items:center}' +
    '.sc-ios-time{flex:0 0 auto;background:#070a08;color:#eef3f0;border:1px solid rgba(238,243,240,.2);' +
    'border-radius:10px;padding:10px;font-size:1rem}' +
    '.sc-ios-btn{flex:1;border:0;border-radius:10px;padding:12px;font-weight:700;font-size:.95rem}' +
    '.sc-ios-on{background:#16d97e;color:#04210f}.sc-ios-off{background:transparent;color:rgba(238,243,240,.6)}';
  function addCSS() {
    if (document.getElementById('sc-ios-css')) return;
    var s = document.createElement('style'); s.id = 'sc-ios-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function showReminderSheet() {
    addCSS();
    var el = document.createElement('div');
    el.className = 'sc-ios-sheet';
    el.innerHTML =
      '<h3>🔔 Get a daily lesson reminder?</h3>' +
      '<p>We’ll nudge you once a day so your streak keeps growing. You can change this in Settings.</p>' +
      '<div class="sc-ios-row">' +
      '<input class="sc-ios-time" type="time" value="08:00" aria-label="Reminder time">' +
      '<button class="sc-ios-btn sc-ios-on">Turn on</button></div>' +
      '<div class="sc-ios-row" style="margin-top:6px"><button class="sc-ios-btn sc-ios-off">Not now</button></div>';
    document.body.appendChild(el);
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.add('show'); }); });
    function close() { el.classList.remove('show'); setTimeout(function () { el.remove(); }, 400); }
    el.querySelector('.sc-ios-on').onclick = function () {
      haptic('tap');
      enableReminder(el.querySelector('.sc-ios-time').value || '08:00').then(close);
    };
    el.querySelector('.sc-ios-off').onclick = function () { set(ASKED, true); close(); };
  }

  function addSettingsCard() {
    var anchor = document.querySelector('.section-title');
    if (!anchor || document.getElementById('sc-ios-reminder')) return;
    var pref = get(PREF, null) || { on: false, time: '08:00' };
    var wrapEl = document.createElement('div');
    wrapEl.id = 'sc-ios-reminder';
    wrapEl.style.marginBottom = '28px';
    wrapEl.innerHTML =
      '<div class="section-title">Daily Reminder</div>' +
      '<div class="account-card"><div class="account-row" style="gap:12px;flex-wrap:wrap">' +
      '<span class="account-key">Lesson reminder</span>' +
      '<input type="time" id="scIosTime" value="' + (pref.time || '08:00') + '" ' +
      'style="background:transparent;color:inherit;border:1px solid rgba(238,243,240,.2);border-radius:8px;padding:6px 8px">' +
      '<label style="display:flex;align-items:center;gap:8px;margin-left:auto">' +
      '<input type="checkbox" id="scIosOn"' + (pref.on ? ' checked' : '') + ' style="width:22px;height:22px;accent-color:#16d97e">' +
      '<span id="scIosState">' + (pref.on ? 'On' : 'Off') + '</span></label></div>' +
      '<div id="scIosNote" style="font-size:.82rem;opacity:.6;padding:4px 0 2px"></div></div>';
    anchor.parentNode.insertBefore(wrapEl, anchor);
    var on = document.getElementById('scIosOn'), t = document.getElementById('scIosTime');
    var state = document.getElementById('scIosState'), note = document.getElementById('scIosNote');
    function apply() {
      if (on.checked) {
        enableReminder(t.value || '08:00').then(function (ok) {
          if (!ok) {
            on.checked = false;
            note.textContent = 'Notifications are off for ScalpClock. Turn them on in the iPhone Settings app → Notifications → ScalpClock.';
          } else { note.textContent = ''; }
          state.textContent = on.checked ? 'On' : 'Off';
        });
      } else {
        disableReminder(); state.textContent = 'Off'; note.textContent = '';
      }
    }
    on.onchange = apply;
    t.onchange = function () { if (on.checked) apply(); else set(PREF, { on: false, time: t.value }); };
  }

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn();
  }

  onReady(function () {
    var path = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';

    // Keep the schedule fresh on every launch (cheap and idempotent).
    var pref = get(PREF, null);
    if (pref && pref.on) { scheduleDaily(pref.time); refreshStreakSaver(); }

    if (path === '/learn') {
      wrap('answerQuiz', function () { haptic(isCorrect('qexp') ? 'success' : 'error'); });
      wrap('answerPractice', function () { haptic(isCorrect('pfb') ? 'success' : 'error'); });
      wrap('finishLesson', function () {
        haptic('success');
        setTimeout(refreshStreakSaver, 1500);  // streak is saved by then → cancel the alert
      });
      if (!get(ASKED, false) && !(pref && pref.on)) setTimeout(showReminderSheet, 4000);
    }
    if (path === '/settings') addSettingsCard();
  });
})();
