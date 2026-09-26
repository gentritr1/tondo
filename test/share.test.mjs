import { pieResultText } from '../public/js/share.js';

let passed = 0;
const failures = [];
const test = (name, fn) => { try { fn(); passed++; } catch (err) { failures.push({ name, err }); } };
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

const standings = [
  { id: 'p4', name: 'Pina', isBot: true, points: 273, roundsWon: 2 },
  { id: 'p2', name: 'Carmela', isBot: true, points: 85, roundsWon: 1 },
  { id: 'p1', name: 'Gent', isBot: false, points: 81, roundsWon: 1 },
  { id: 'p3', name: 'Dominic', isBot: true, points: 0, roundsWon: 0 },
];

test('names the champion, every seat with its score, and says start a new table', () => {
  const text = pieResultText({ complete: true, championIds: ['p4'], standings }, { origin: 'https://tondo.example' });
  const lines = text.split('\n');
  assert(lines[0] === '🍕 TONDO — Pina took the pie', `line 1: ${lines[0]}`);
  assert(lines[1] === 'Pina 273 · Carmela 85 · Gent 81 · Dominic 0', `line 2: ${lines[1]}`);
  assert(lines[2] === 'Four slices. Start a new table: https://tondo.example', `line 3: ${lines[2]}`);
});

test('a shared pie names everyone who shared it', () => {
  const two = pieResultText({ complete: true, championIds: ['p4', 'p2'], standings }, { origin: 'x' });
  assert(two.startsWith('🍕 TONDO — Pina and Carmela shared the pie'), two);
  const three = pieResultText({ complete: true, championIds: ['p4', 'p2', 'p1'], standings }, { origin: 'x' });
  assert(three.startsWith('🍕 TONDO — Pina, Carmela and Gent shared the pie'), three);
});

test('stays under 400 characters with four 16-character names', () => {
  const long = ['A', 'B', 'C', 'D'].map((ch, i) => ({ id: 'p' + i, name: ch.repeat(16), isBot: false, points: 999, roundsWon: 1 }));
  const text = pieResultText({ complete: true, championIds: ['p0'], standings: long }, { origin: 'https://a-reasonably-long-hostname.example' });
  assert(text.length < 400, `length ${text.length}`);
});

test('makes no reward claim and no durable-link promise', () => {
  const text = pieResultText({ complete: true, championIds: ['p4'], standings }, { origin: 'https://tondo.example' }).toLowerCase();
  for (const word of ['reward', 'unlock', 'bonus', 'win a', 'join my table', 'code']) {
    assert(!text.includes(word), `contains "${word}"`);
  }
});

test('returns an empty string for a pie that is not complete', () => {
  assert(pieResultText({ complete: false, championIds: [], standings }, { origin: 'x' }) === '', 'empty');
});

/* --------------------------------------------------------- addendum cases
 * server/rooms.js:59 defines PIE_ROUNDS and puts it on the wire as
 * match.roundsPerPie (server/rooms.js:378). The plan's example text hardcodes
 * "Four", and the tests above never set match.roundsPerPie at all — so the
 * shipping default of a 4-round pie has to be the fallback, not a literal.
 * These cases pin the derivation itself, not just the shipping value. */

test('a six-round pie says "Six slices."', () => {
  const text = pieResultText({ complete: true, championIds: ['p4'], standings, roundsPerPie: 6 }, { origin: 'x' });
  assert(text.includes('Six slices.'), text);
});

test('a pie length outside the word list still reads sensibly, in numerals', () => {
  const text = pieResultText({ complete: true, championIds: ['p4'], standings, roundsPerPie: 12 }, { origin: 'x' });
  assert(text.includes('12 slices.'), text);
  assert(!/undefined|NaN/i.test(text), text);
});

test('a missing roundsPerPie falls back to the shipping pie length, never "undefined slices"', () => {
  const text = pieResultText({ complete: true, championIds: ['p4'], standings }, { origin: 'x' });
  assert(!/undefined|NaN/i.test(text), text);
  assert(text.includes('Four slices.'), text);
});

test('a zero roundsPerPie falls back the same way, never "0 slices" or "undefined slices"', () => {
  const text = pieResultText({ complete: true, championIds: ['p4'], standings, roundsPerPie: 0 }, { origin: 'x' });
  assert(!/undefined|NaN/i.test(text), text);
  assert(text.includes('Four slices.'), text);
});

test('names are title-cased the same way the on-screen scoreboard cases them', () => {
  // app.js's own scoreboard runs every name through nicely() (app.js:532,
  // applied at app.js:2087 and app.js:2123) — an ALL-CAPS bot name or a
  // lowercase-typed player name reads title-cased everywhere the player has
  // already seen it. The pasted text has to match that, not the raw wire
  // casing, or it looks like a different, sloppier product.
  const shouty = [
    { id: 'p4', name: 'PINA', isBot: true, points: 273, roundsWon: 2 },
    { id: 'p2', name: 'carmela', isBot: true, points: 85, roundsWon: 1 },
  ];
  const text = pieResultText({ complete: true, championIds: ['p4', 'p2'], standings: shouty }, { origin: 'x' });
  assert(text.includes('Pina and Carmela shared the pie'), text);
  assert(text.includes('Pina 273 · Carmela 85'), text);
  assert(!text.includes('PINA'), text);
  assert(!text.includes('carmela'), text);
});

test('a multi-word name is title-cased PER WORD, not as one string', () => {
  // server/bot.js:26 BOT_NAMES includes 'Chef Bot' — the fourth bot at a
  // full table. A whole-string title-case (charAt(0).toUpperCase() + rest
  // .toLowerCase()) turns it into "Chef bot", and would do the same to a
  // human-typed "JO ANNE" -> "Jo anne". This runs the real bot name through
  // the real pieResultText output, not just the helper in isolation, because
  // that is the artifact that leaves the app and cannot be corrected once
  // pasted.
  const withChefBot = [
    { id: 'p1', name: 'Gent', isBot: false, points: 10, roundsWon: 1 },
    { id: 'p2', name: 'Carmela', isBot: true, points: 5, roundsWon: 0 },
    { id: 'p3', name: 'Dominic', isBot: true, points: 0, roundsWon: 0 },
    { id: 'p4', name: 'Chef Bot', isBot: true, points: 0, roundsWon: 0 },
  ];
  const text = pieResultText({ complete: true, championIds: ['p1'], standings: withChefBot }, { origin: 'x' });
  assert(text.includes('Chef Bot'), `expected "Chef Bot" in: ${text}`);
  assert(!text.includes('Chef bot'), `must not read "Chef bot": ${text}`);
});

if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.message}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
