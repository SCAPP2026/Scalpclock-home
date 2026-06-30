// WebSocket proxy: browser ↔ /api/market-ws ↔ Finnhub wss://
// Each client connection gets a dedicated Finnhub socket (Cloudflare stateless).

export async function onRequest(context) {
  const { env, request } = context;

  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  const FINNHUB_KEY = env.FINNHUB_KEY;
  if (!FINNHUB_KEY) {
    return new Response(JSON.stringify({ error: 'FINNHUB_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
  serverSocket.accept();

  const subscribedSymbols = new Set();
  let finnhub = null;
  let reconnectIdx = 0;
  const DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
  let closed = false;

  function send(obj) {
    try { serverSocket.send(JSON.stringify(obj)); } catch (_) {}
  }

  function connectFinnhub() {
    if (closed) return;
    try {
      finnhub = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);

      finnhub.addEventListener('open', () => {
        reconnectIdx = 0;
        send({ type: 'status', status: 'connected' });
        for (const sym of subscribedSymbols) {
          finnhub.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
        }
      });

      finnhub.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'trade' && Array.isArray(msg.data)) {
            for (const t of msg.data) {
              send({ type: 'price', symbol: t.s, price: t.p, volume: t.v, timestamp: t.t });
            }
          }
        } catch (_) {}
      });

      finnhub.addEventListener('close', () => {
        if (closed) return;
        send({ type: 'status', status: 'reconnecting' });
        const delay = DELAYS[Math.min(reconnectIdx++, DELAYS.length - 1)];
        // Workers support setTimeout in recent compat dates
        setTimeout(connectFinnhub, delay);
      });

      finnhub.addEventListener('error', () => {
        send({ type: 'status', status: 'error' });
      });
    } catch (e) {
      send({ type: 'status', status: 'error', message: e.message });
    }
  }

  serverSocket.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'subscribe' && msg.symbol) {
        subscribedSymbols.add(msg.symbol.toUpperCase());
        if (finnhub && finnhub.readyState === 1) {
          finnhub.send(JSON.stringify({ type: 'subscribe', symbol: msg.symbol.toUpperCase() }));
        }
      } else if (msg.type === 'unsubscribe' && msg.symbol) {
        subscribedSymbols.delete(msg.symbol.toUpperCase());
        if (finnhub && finnhub.readyState === 1) {
          finnhub.send(JSON.stringify({ type: 'unsubscribe', symbol: msg.symbol.toUpperCase() }));
        }
      }
    } catch (_) {}
  });

  serverSocket.addEventListener('close', () => {
    closed = true;
    if (finnhub) try { finnhub.close(); } catch (_) {}
  });

  connectFinnhub();

  return new Response(null, { status: 101, webSocket: clientSocket });
}
