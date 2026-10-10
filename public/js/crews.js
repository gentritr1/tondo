/**
 * What this browser knows about crews: its device secret and the crews it has
 * played into. No accounts — clearing storage (or "Forget this device", which
 * wipes every `tondo.` key) means rejoining as a new member, which the crew
 * link still allows.
 *
 * Storage is a privilege, not a given (see app.js readLastTable): every touch
 * is guarded, and a value that will not parse reads as "nothing remembered" —
 * never deleted.
 */

const DEVICE_KEY = 'tondo.device';
const CREWS_KEY = 'tondo.crews';
const MAX_CREWS = 10;
export const CREW_ID = /^[0-9a-hjkmnp-tv-z]{10}$/;
const DEVICE = /^[0-9a-f]{32}$/;

function store() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function getDevice() {
  const s = store();
  if (!s) return '';
  let v = '';
  try { v = s.getItem(DEVICE_KEY) || ''; } catch { return ''; }
  if (DEVICE.test(v)) return v;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  v = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try { s.setItem(DEVICE_KEY, v); } catch { return ''; }
  return v;
}

export function withDevice(payload) {
  const device = getDevice();
  return device ? { ...payload, device } : payload;
}

export function readCrews() {
  const s = store();
  if (!s) return [];
  let raw = '';
  try { raw = s.getItem(CREWS_KEY) || ''; } catch { return []; }
  if (!raw) return [];
  let v;
  try { v = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const c of v) {
    if (!c || typeof c !== 'object') continue;
    const id = typeof c.id === 'string' ? c.id : '';
    const name = typeof c.name === 'string' ? c.name.trim().slice(0, 24) : '';
    if (!CREW_ID.test(id) || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, at: Number(c.at) || 0 });
    if (out.length >= MAX_CREWS) break;
  }
  return out;
}

function writeCrews(list) {
  const s = store();
  if (!s) return;
  try { s.setItem(CREWS_KEY, JSON.stringify(list.slice(0, MAX_CREWS))); } catch { /* nowhere to keep it */ }
}

export function rememberCrew({ id, name }) {
  if (!CREW_ID.test(String(id || '')) || !String(name || '').trim()) return;
  writeCrews([{ id, name: String(name).trim().slice(0, 24), at: Date.now() }].concat(readCrews().filter((c) => c.id !== id)));
}

export function forgetCrew(id) {
  writeCrews(readCrews().filter((c) => c.id !== id));
}

export function crewLink(origin, id) {
  return `${origin}?crew=${id}`;
}
