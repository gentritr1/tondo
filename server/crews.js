'use strict';

/**
 * The crew store — the only module that touches crew tables.
 *
 * Results are SERVER-SOURCED: savePie takes a record the room built from its
 * own pie (server/rooms.js pieRecord), never anything a client sent. Human
 * names live only in `members`, so leave() erasing name + device removes every
 * copy; the tally is derived from pie_players on read, so it cannot drift.
 */

const crypto = require('crypto');
const db = require('./db');

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const CREW_ID = /^[0-9a-hjkmnp-tv-z]{10}$/;
const DEVICE = /^[0-9a-f]{32}$/;
const RECENT = 5;

const validCrewId = (s) => typeof s === 'string' && CREW_ID.test(s);

function newCrewId() {
  return Array.from(crypto.randomBytes(10), (b) => ALPHABET[b & 31]).join('');
}

function hashDevice(device) {
  if (typeof device !== 'string' || !DEVICE.test(device)) return null;
  return crypto.createHash('sha256').update(device).digest('hex');
}

function cleanCrewName(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().slice(0, 24).trim();
  return s || null;
}

function savePie(target, record) {
  const crewLabel = target.crewId || 'new';
  return db.run('save', () => db.tx(async (c) => {
    let crew;
    if (target.newName) {
      const name = cleanCrewName(target.newName);
      if (!name) throw new db.CrewStoreError('bad name', 'Give the crew a name.');
      // 32^10 ids: a collision is astronomically unlikely, but retried rather than assumed away.
      for (let i = 0; i < 3 && !crew; i++) {
        const r = await c.query('INSERT INTO crews (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id, name', [newCrewId(), name]);
        crew = r.rows[0];
      }
      if (!crew) throw new Error('could not mint a crew id');
    } else {
      const r = await c.query('SELECT id, name FROM crews WHERE id = $1 FOR UPDATE', [target.crewId]);
      crew = r.rows[0];
      if (!crew) throw new db.CrewStoreError('not found', 'That crew is gone.');
    }

    // One device, one member row per pie: a second seat on the same device
    // (two tabs on one laptop) is recorded as a guest rather than violating
    // the (pie_id, member_id) key and losing the whole save.
    const seen = new Set();
    const members = [];
    const guests = [];
    const bots = [];
    for (const p of record.players) {
      if (p.kind === 'bot') bots.push({ name: String(p.name), points: p.points, won: !!p.won });
      else if (p.deviceHash && !seen.has(p.deviceHash)) { seen.add(p.deviceHash); members.push(p); }
      else guests.push({ points: p.points, won: !!p.won });
    }

    const pie = await c.query(
      `INSERT INTO pies (crew_id, pie_key, rounds, bots, guests) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (crew_id, pie_key) DO NOTHING RETURNING id`,
      [crew.id, record.pieKey, record.rounds, JSON.stringify(bots), JSON.stringify(guests)]);
    if (!pie.rows[0]) return { id: crew.id, name: crew.name, duplicate: true };
    const pieId = pie.rows[0].id;

    for (const p of members) {
      const m = await c.query(
        `INSERT INTO members (crew_id, device_hash, name) VALUES ($1, $2, $3)
         ON CONFLICT (crew_id, device_hash) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [crew.id, p.deviceHash, String(p.name)]);
      await c.query('INSERT INTO pie_players (pie_id, member_id, points, won) VALUES ($1, $2, $3, $4)',
        [pieId, m.rows[0].id, p.points, !!p.won]);
    }
    await c.query('UPDATE crews SET last_pie_at = now() WHERE id = $1', [crew.id]);
    return { id: crew.id, name: crew.name, duplicate: false };
  }), { crew: crewLabel });
}

/** "Gent", "Gent 2": collisions numbered by join order, case-insensitively, at read time. */
function displayNames(rows) {
  const counts = new Map();
  const out = new Map();
  for (const r of rows) {
    if (r.name == null) continue;
    const k = r.name.toLowerCase();
    const n = (counts.get(k) || 0) + 1;
    counts.set(k, n);
    out.set(String(r.id), n === 1 ? r.name : `${r.name} ${n}`);
  }
  return out;
}

function readCrew(id, deviceHash) {
  return db.run('read', () => db.tx(async (c) => {
    const crew = (await c.query('SELECT id, name FROM crews WHERE id = $1', [id])).rows[0];
    if (!crew) return null;
    const memberRows = (await c.query(
      `SELECT m.id, m.name, m.device_hash,
              count(pp.pie_id)::int AS pies,
              (count(pp.pie_id) FILTER (WHERE pp.won))::int AS wins
         FROM members m LEFT JOIN pie_players pp ON pp.member_id = m.id
        WHERE m.crew_id = $1
        GROUP BY m.id ORDER BY m.joined_at, m.id`, [id])).rows;
    const pieRows = (await c.query(
      `SELECT p.id, p.played_at, p.rounds, p.bots, p.guests,
              (SELECT count(*)::int FROM pies WHERE crew_id = $1) AS total,
              coalesce(json_agg(json_build_object('memberId', pp.member_id, 'points', pp.points, 'won', pp.won))
                       FILTER (WHERE pp.pie_id IS NOT NULL), '[]') AS players
         FROM pies p LEFT JOIN pie_players pp ON pp.pie_id = p.id
        WHERE p.crew_id = $1
        GROUP BY p.id ORDER BY p.played_at DESC, p.id DESC LIMIT ${RECENT}`, [id])).rows;

    const names = displayNames(memberRows);
    const members = memberRows
      .filter((r) => r.name != null)
      .map((r) => ({ name: names.get(String(r.id)), pies: r.pies, wins: r.wins, you: !!deviceHash && r.device_hash === deviceHash }))
      .sort((a, b) => b.wins - a.wins || b.pies - a.pies || a.name.localeCompare(b.name));
    const recent = pieRows.map((p) => ({
      playedAt: new Date(p.played_at).toISOString(),
      rounds: p.rounds,
      players: []
        .concat(p.players.map((x) => {
          const name = names.get(String(x.memberId));
          return { name: name || null, points: x.points, won: x.won, kind: name ? 'member' : 'former' };
        }))
        .concat(p.guests.map((g) => ({ name: null, points: g.points, won: g.won, kind: 'guest' })))
        .concat(p.bots.map((b) => ({ name: b.name, points: b.points, won: b.won, kind: 'bot' })))
        .sort((a, b) => b.points - a.points),
    }));
    return { id: crew.id, name: crew.name, pies: pieRows.length ? pieRows[0].total : 0, members, recent };
  }), { crew: id });
}

function leave(id, deviceHash) {
  return db.run('leave', () => db.tx(async (c) => {
    const r = await c.query(
      'UPDATE members SET name = NULL, device_hash = NULL, left_at = now() WHERE crew_id = $1 AND device_hash = $2 RETURNING id',
      [id, deviceHash]);
    return r.rowCount > 0;
  }), { crew: id });
}

function crewName(id) {
  return db.run('lookup', () => db.tx(async (c) => {
    const r = await c.query('SELECT name FROM crews WHERE id = $1', [id]);
    return r.rows[0] ? r.rows[0].name : null;
  }), { crew: id });
}

module.exports = { validCrewId, newCrewId, hashDevice, cleanCrewName, savePie, readCrew, leave, crewName };
