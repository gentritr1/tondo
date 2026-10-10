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

/** The X-Forwarded-For entries, left to right. Their VALUES are the client's to
 *  write, so callers that log should log only how many there are. */
function xffList(req) {
  const raw = ((req && req.headers) || {})['x-forwarded-for'];
  return String(Array.isArray(raw) ? raw.join(',') : raw || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/* A hop count deeper than the chain falls back to the socket address, which
   behind a balancer is the balancer's: every player then shares one budget.
   Say so once per process, or the operator has nothing to read. */
let warnedShortChain = false;
function resetShortChainWarning() { warnedShortChain = false; }

function clientIpFrom(req, env = process.env, warn = (m) => console.warn(m)) {
  const headers = (req && req.headers) || {};
  const named = String(env.TONDO_CLIENT_IP_HEADER || '').trim().toLowerCase();
  if (named) {
    const v = headers[named];
    const one = Array.isArray(v) ? v[0] : v;
    if (one && String(one).trim()) return fold(one);
  }
  const hops = Number(env.TONDO_TRUST_PROXY);
  if (Number.isInteger(hops) && hops >= 1) {
    const list = xffList(req);
    if (list.length >= hops) return fold(list[list.length - hops]);
    if (!warnedShortChain) {
      warnedShortChain = true;
      warn(`[tondo] TONDO_TRUST_PROXY=${hops} but X-Forwarded-For has ${list.length} entries; using the socket address`);
    }
  }
  return fold(req && req.socket && req.socket.remoteAddress);
}

module.exports = { clientIpFrom, xffList, resetShortChainWarning };
