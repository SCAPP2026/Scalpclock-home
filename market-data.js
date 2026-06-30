/* market-data.js — live price client
 * Connects to /api/market-ws (Finnhub WebSocket proxy).
 * Falls back to /api/quote (REST) on disconnect.
 * Exposes window.MarketData.subscribe(symbol, callback).
 */
(function () {
  'use strict';

  var LIVE_MS      = 3000;    // ≤3 s  → LIVE
  var STALE_MS     = 10000;   // >10 s → STALE
  var REST_POLL_MS = 5000;
  var RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

  var subscribers  = {};   // symbol → [callback, ...]
  var lastUpdate   = {};   // symbol → { price, ts, source }
  var ws           = null;
  var wsReady      = false;
  var reconnectIdx = 0;
  var restTimer    = null;

  // ── notify all callbacks for a symbol ─────────────────────────
  function notify(symbol, data) {
    lastUpdate[symbol] = data;
    var cbs = subscribers[symbol];
    if (cbs) cbs.forEach(function (cb) { try { cb(data); } catch (_) {} });
  }

  // ── REST fallback ──────────────────────────────────────────────
  function fetchQuote(symbol) {
    fetch('/api/quote?symbol=' + encodeURIComponent(symbol), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.price) notify(symbol, { price: d.price, ts: Date.now(), source: 'rest' });
      })
      .catch(function () {});
  }

  function pollRest() {
    Object.keys(subscribers).forEach(function (sym) {
      if ((subscribers[sym] || []).length > 0) fetchQuote(sym);
    });
  }

  function startRestPolling() {
    if (restTimer) return;
    pollRest();
    restTimer = setInterval(pollRest, REST_POLL_MS);
  }

  function stopRestPolling() {
    if (restTimer) { clearInterval(restTimer); restTimer = null; }
  }

  // ── WebSocket connection ───────────────────────────────────────
  function connect() {
    try {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/api/market-ws');

      ws.addEventListener('open', function () {
        wsReady      = true;
        reconnectIdx = 0;
        stopRestPolling();
        Object.keys(subscribers).forEach(function (sym) {
          if ((subscribers[sym] || []).length > 0) {
            ws.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
          }
        });
      });

      ws.addEventListener('message', function (ev) {
        try {
          var msg = JSON.parse(ev.data);
          if (msg.type === 'price') {
            notify(msg.symbol, { price: msg.price, ts: Date.now(), source: 'ws' });
          }
        } catch (_) {}
      });

      ws.addEventListener('close', function () {
        wsReady = false;
        ws = null;
        startRestPolling();
        var delay = RECONNECT_DELAYS[Math.min(reconnectIdx++, RECONNECT_DELAYS.length - 1)];
        setTimeout(connect, delay);
      });

      ws.addEventListener('error', function () {
        wsReady = false;
      });
    } catch (_) {
      startRestPolling();
      var d = RECONNECT_DELAYS[Math.min(reconnectIdx++, RECONNECT_DELAYS.length - 1)];
      setTimeout(connect, d);
    }
  }

  // ── status badge helper ────────────────────────────────────────
  function getStatus(symbol) {
    var u = lastUpdate[symbol];
    if (!u) return 'error';
    if (u.source === 'rest') return 'delayed';
    var age = Date.now() - u.ts;
    if (age <= LIVE_MS)  return 'live';
    if (age <= STALE_MS) return 'delayed';
    return 'stale';
  }

  // ── DOM helpers ────────────────────────────────────────────────
  function fmtPrice(p) {
    return '$' + p.toFixed(2);
  }

  function fmtTs(ts) {
    var d = new Date(ts);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function updateBadges(symbol, data) {
    var status = getStatus(symbol);
    var labelMap = { live: 'LIVE', delayed: 'DELAYED', stale: 'STALE', error: 'ERROR' };

    document.querySelectorAll('[data-live-price="' + symbol + '"]').forEach(function (el) {
      el.textContent = fmtPrice(data.price);
    });

    document.querySelectorAll('[data-live-badge="' + symbol + '"]').forEach(function (el) {
      el.textContent = labelMap[status] || 'STALE';
      el.className = 'live-badge live-badge--' + status;
    });

    document.querySelectorAll('[data-live-ts="' + symbol + '"]').forEach(function (el) {
      el.textContent = fmtTs(data.ts);
    });
  }

  // ── public API ─────────────────────────────────────────────────
  window.MarketData = {
    subscribe: function (symbol, callback) {
      symbol = symbol.toUpperCase();
      if (!subscribers[symbol]) subscribers[symbol] = [];
      subscribers[symbol].push(callback);

      if (wsReady && ws) {
        ws.send(JSON.stringify({ type: 'subscribe', symbol: symbol }));
      } else if (!wsReady) {
        fetchQuote(symbol);
      }

      var u = lastUpdate[symbol];
      if (u) { try { callback(u); } catch (_) {} }
    },

    unsubscribe: function (symbol, callback) {
      symbol = symbol.toUpperCase();
      if (!subscribers[symbol]) return;
      subscribers[symbol] = subscribers[symbol].filter(function (cb) { return cb !== callback; });
      if (subscribers[symbol].length === 0 && ws && wsReady) {
        ws.send(JSON.stringify({ type: 'unsubscribe', symbol: symbol }));
      }
    },

    getStatus:      getStatus,
    getLastUpdate:  function (symbol) { return lastUpdate[symbol.toUpperCase()] || null; },
  };

  // ── staleness sweeper — refresh badges every 2 s ─────────────
  setInterval(function () {
    Object.keys(lastUpdate).forEach(function (sym) {
      var u = lastUpdate[sym];
      if (u) updateBadges(sym, u);
    });
  }, 2000);

  // Wire default DOM callback for all symbols
  var _origSubscribe = window.MarketData.subscribe;
  window.MarketData.subscribe = function (symbol, callback) {
    symbol = symbol.toUpperCase();
    var domCallback = function (data) {
      updateBadges(symbol, data);
      if (callback) { try { callback(data); } catch (_) {} }
    };
    _origSubscribe(symbol, domCallback);
  };

  connect();
})();
