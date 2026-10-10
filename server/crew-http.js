'use strict';

/**
 * The crew's HTTP surface: read a crew, leave it, and a health check that
 * actually touches the database (for drills; the host's own health check is
 * /health, which never does — spec §4.2, Neon CU-hours).
 *
 * The device secret arrives in a header (read) or a JSON body (leave), never
 * in the URL, which ends up in logs and history.
 */

const crews = require('./crews');
const db = require('./db');

const ROUTE = /^\/api\/crew\/([^/?]+)(\/leave)?(?:\?.*)?$/;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function readBody(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const pathOf = (url) => url.split('?')[0];

function matches(url) {
  return pathOf(url) === '/health/crews' || ROUTE.test(url);
}

async function handle(req, res, { ip, budgets, store = crews }) {
  if (!budgets.crewRead.take(ip)) return json(res, 429, { error: 'slow down' });

  if (pathOf(req.url) === '/health/crews') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method' });
    if (db.publicStatus() === 'off') return json(res, 503, { ok: false, reason: 'not configured' });
    try { await db.ping(); return json(res, 200, { ok: true }); } catch (err) { return json(res, 503, { ok: false, reason: err.reason || 'database error' }); }
  }

  const m = req.url.match(ROUTE);
  const id = m[1];
  if (!store.validCrewId(id)) return json(res, 404, { error: 'not found' });
  if (db.publicStatus() !== 'on') return json(res, 503, { reason: db.publicStatus() === 'off' ? 'not configured' : (db.state().reason || 'database error') });

  if (m[2]) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    let device = null;
    try { device = JSON.parse(await readBody(req)).device; } catch { return json(res, 400, { error: 'bad body' }); }
    const hash = store.hashDevice(device);
    if (!hash) return json(res, 400, { error: 'bad device' });
    try { await store.leave(id, hash); return json(res, 204); } catch (err) { return json(res, 503, { reason: err.reason || 'database error' }); }
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'method' });
  const hash = store.hashDevice(String(req.headers['x-tondo-device'] || ''));
  try {
    const crew = await store.readCrew(id, hash);
    return crew ? json(res, 200, crew) : json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 503, { reason: err.reason || 'database error' });
  }
}

module.exports = { matches, handle };
