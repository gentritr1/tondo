'use strict';

/**
 * The address a request is charged to.
 *
 * Behind Render's or Fly's load balancer, `socket.remoteAddress` is the
 * balancer's, so every player in the world shares one address, and the
 * 32-socket cap in limits.js would refuse everyone once 32 sockets were open
 * anywhere. The platform tells us the real address in a header, but only the
 * entry IT appended can be trusted: anything further left in X-Forwarded-For
 * was written by the client and can say anything.
 *
 *   TONDO_CLIENT_IP_HEADER=<name>  a single-value header the platform sets
 *                                  (Fly: Fly-Client-IP)
 *   TONDO_TRUST_PROXY=<hops>       take the entry `hops` from the right of
 *                                  X-Forwarded-For (Render: 1)
 *   neither                        the socket address, as before
 */

const fold = (ip) => String(ip || '').trim().replace(/^::ffff:/, '');

function clientIpFrom(req, env = process.env) {
  const headers = (req && req.headers) || {};
  const named = String(env.TONDO_CLIENT_IP_HEADER || '').trim().toLowerCase();
  if (named) {
    const v = headers[named];
    const one = Array.isArray(v) ? v[0] : v;
    if (one && String(one).trim()) return fold(one);
  }
  const hops = Number(env.TONDO_TRUST_PROXY);
  if (Number.isInteger(hops) && hops >= 1) {
    const raw = headers['x-forwarded-for'];
    const list = String(Array.isArray(raw) ? raw.join(',') : raw || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length >= hops) return fold(list[list.length - hops]);
  }
  return fold(req && req.socket && req.socket.remoteAddress);
}

module.exports = { clientIpFrom };
