import WebSocket from 'ws';

/** A WebSocket client that buffers every message so a test can await one by predicate. */
export function client(url, headers = {}) {
  const ws = new WebSocket(url, { headers });
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const w = waiters.find((x) => x.pred(msg));
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); } else inbox.push(msg);
  });
  return {
    ws,
    inbox,
    open: (ms = 5000) => new Promise((resolve, reject) => {
      const t = setTimeout(() => { ws.terminate(); reject(new Error(`open timed out after ${ms}ms`)); }, ms);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('unexpected-response', (_req, res) => { clearTimeout(t); reject(new Error(`HTTP ${res.statusCode}`)); });
      ws.once('error', (err) => { clearTimeout(t); reject(err); });
    }),
    send: (msg) => ws.send(JSON.stringify(msg)),
    next(pred, ms = 5000) {
      const hit = inbox.find(pred);
      if (hit) { inbox.splice(inbox.indexOf(hit), 1); return Promise.resolve(hit); }
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: (m) => { clearTimeout(t); resolve(m); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`timed out after ${ms}ms`)); }, ms);
        waiters.push(w);
      });
    },
    close: () => new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', resolve);
      ws.close();
    }),
  };
}
