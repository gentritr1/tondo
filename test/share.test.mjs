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
  // A tripwire for regressions someone has already imagined, not a proof
  // that the copy asks the reader for nothing in general. 'win a' is a
  // plain substring match — a player literally named Edwin would trip it —
  // which is exactly how crude this check is: it catches the specific
  // words below, not the underlying property. That property stays a human
  // gate (self-review), not something a word list can guarantee.
  const text = pieResultText({ complete: true, championIds: ['p4'], standings }, { origin: 'https://tondo.example' }).toLowerCase();
  for (const word of ['reward', 'unlock', 'bonus', 'win a', 'join my table', 'code', 'invite', 'rematch']) {
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

/* ----------------------------------------------------- fix round 1 cases */

test('a lowercase-typed name is still title-cased', () => {
  const typed = [
    { id: 'p4', name: 'pina', isBot: true, points: 273, roundsWon: 2 },
    { id: 'p2', name: 'carmela', isBot: true, points: 85, roundsWon: 1 },
  ];
  const text = pieResultText({ complete: true, championIds: ['p4', 'p2'], standings: typed }, { origin: 'x' });
  assert(text.includes('Pina and Carmela shared the pie'), text);
  assert(text.includes('Pina 273 · Carmela 85'), text);
});

test('a multi-word name is title-cased PER WORD, not as one string', () => {
  // server/bot.js:26 BOT_NAMES includes 'Chef Bot' — the fourth bot at a
  // full table. A whole-string title-case (charAt(0).toUpperCase() + rest
  // .toLowerCase()) turns it into "Chef bot". This runs the real bot name
  // through the real pieResultText output, not just the helper in
  // isolation, because that is the artifact that leaves the app and cannot
  // be corrected once pasted.
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

/* ----------------------------------------------------- fix round 2 cases
 * Four defects found in review of fix round 1, addressed together because
 * they are the same underlying lesson: a value this function did not fully
 * control (a name's casing, a champion's resolvability, a count's source)
 * needs its OWN defended fallback, not an assumption borrowed from the
 * common case. */

test('names typed with an intentional interior capital are left exactly as typed', () => {
  // AJ, McDonald, eBay and DeAndre are all real ways a person might type
  // their own name. Per-word title-casing (fix round 1) still destroys all
  // four ("AJ" -> "Aj"). The rule: a word that already carries a capital
  // past its first letter is left alone, because there is no way to tell a
  // deliberately-styled name from an accident, and destroying one that was
  // deliberate is the worse failure in an artifact that cannot be
  // corrected once pasted. It does NOT recover a capital buried inside an
  // otherwise all-caps word — "MCDONALD" still comes out "Mcdonald", not
  // "McDonald" — that needs a name dictionary and is out of scope.
  const styled = [
    { id: 'p1', name: 'AJ', isBot: false, points: 10, roundsWon: 1 },
    { id: 'p2', name: 'McDonald', isBot: false, points: 5, roundsWon: 0 },
    { id: 'p3', name: 'eBay', isBot: false, points: 3, roundsWon: 0 },
    { id: 'p4', name: 'DeAndre', isBot: false, points: 1, roundsWon: 0 },
  ];
  const text = pieResultText({ complete: true, championIds: ['p1'], standings: styled }, { origin: 'x' });
  assert(text.includes('AJ took the pie'), text);
  assert(text.includes('AJ 10'), text);
  assert(text.includes('McDonald 5'), text);
  assert(text.includes('eBay 3'), text);
  assert(text.includes('DeAndre 1'), text);
});

test('an ALL-CAPS-typed name is left as typed, not forced into Title Case', () => {
  // A wholly-uppercase word has an "interior capital" by the exact same
  // guard that protects AJ/McDonald/eBay/DeAndre above — there is no
  // per-word, context-free way to tell a deliberate abbreviation (AJ) from
  // caps-lock-on, so this function does not try to. This is a real,
  // disclosed behavior change from fix round 1 (which forced "PINA" ->
  // "Pina"). It costs nothing in production: a real bot's name off the
  // wire is never ALL CAPS (server/bot.js's BOT_NAMES; game.js's up() only
  // uppercases LOG lines, a separate derived string, never a seat's
  // .name), so this only ever affects a human who typed their own name
  // that way on purpose — the honest default is to leave it alone.
  const shouty = [{ id: 'p4', name: 'PINA', isBot: false, points: 40, roundsWon: 4 }];
  const text = pieResultText({ complete: true, championIds: ['p4'], standings: shouty }, { origin: 'x' });
  assert(text.includes('PINA took the pie'), text);
  assert(text.includes('PINA 40'), text);
});

test('a departed solo champion still resolves through the app-supplied name resolver', () => {
  // CRITICAL (review finding): championIds is frozen at server/rooms.js:168's
  // recordRound() and never cleared; standings() (rooms.js:133) is
  // recomputed live and deliberately drops a seat that has left; removeSeat
  // (rooms.js:231-241) touches neither. The champion's name is still
  // knowable — the screen keeps printing it, because game.js's viewFor
  // (~538) keeps the ROUND winner resolvable in `players` even after they
  // leave — so this must resolve through standings FIRST, then the
  // caller's resolver, not read as unnamed just because standings dropped
  // them.
  const departedStandings = standings.filter((r) => r.id !== 'p4'); // Pina left
  const text = pieResultText(
    { complete: true, championIds: ['p4'], standings: departedStandings },
    { origin: 'x', resolveName: (id) => (id === 'p4' ? 'Pina' : '') },
  );
  assert(text.startsWith('🍕 TONDO — Pina took the pie'), text);
});

test('a departed co-champion that cannot be resolved must not become a solo win', () => {
  // CRITICAL: the exact regression the review reproduced — championIds
  // ['p4','p2'] with p2 gone used to silently read as "Pina took the pie",
  // handing Pina a win she only shared. If a co-champion cannot be named at
  // all, the text must claim nothing about WHO won rather than naming only
  // the champion it still has.
  const departedStandings = standings.filter((r) => r.id !== 'p2'); // Carmela left
  const text = pieResultText(
    { complete: true, championIds: ['p4', 'p2'], standings: departedStandings },
    { origin: 'x', resolveName: () => '' }, // nobody resolvable beyond standings
  );
  assert(!text.includes('Pina took the pie'), `must not downgrade to a solo win: ${text}`);
  assert(!text.includes('Nobody took the pie'), `someone specific DID win: ${text}`);
  assert(text.startsWith('🍕 TONDO — the pie is finished'), text);
});

test('an unresolvable champion must not read as "Nobody took the pie"', () => {
  // CRITICAL: the root defect was conflating "nobody won" with "I cannot
  // name the winner" — this is the case with no resolver supplied at all
  // (a champion id that matches nothing anywhere).
  const text = pieResultText(
    { complete: true, championIds: ['ghost'], standings },
    { origin: 'x' },
  );
  assert(!text.includes('Nobody took the pie'), `someone specific DID win: ${text}`);
  assert(text.startsWith('🍕 TONDO — the pie is finished'), text);
});

test('a genuinely unwon pie (no champion at all) still says "Nobody took the pie"', () => {
  // The one case where "Nobody" is correct: leaders() returns [] at 0
  // points and 0 round wins, so championIds is genuinely empty, not just
  // unresolvable. Pinned explicitly so the CRITICAL fix above cannot creep
  // into swallowing this case too.
  const text = pieResultText({ complete: true, championIds: [], standings }, { origin: 'x' });
  assert(text.startsWith('🍕 TONDO — Nobody took the pie'), text);
});

test('a missing roundsPerPie derives the slice count from match.round before falling back to a literal', () => {
  // M6: for a COMPLETE pie (the only kind this function ever renders —
  // guarded at the top), match.round IS the slice count it finished on,
  // one layer closer to the truth than the hardcoded 4.
  const text = pieResultText({ complete: true, championIds: ['p4'], standings, round: 7 }, { origin: 'x' });
  assert(text.includes('Seven slices.'), text);
});

test('a standings row missing points prints 0, never the word "undefined"', () => {
  // M5: `points` is defended the same way `roundsPerPie` already was — an
  // external value off the wire, not something this function controls, so
  // it cannot be trusted to always be a number. Not reachable today (the
  // server always sends one), but the same reasoning that produced
  // sliceCount's fallback applies to every field in this string, not just
  // the one it was first applied to.
  const withMissingPoints = standings.concat([{ id: 'p9', name: 'Ghost', isBot: false, roundsWon: 0 }]);
  const text = pieResultText({ complete: true, championIds: ['p4'], standings: withMissingPoints }, { origin: 'x' });
  assert(text.includes('Ghost 0'), text);
  assert(!/undefined/i.test(text), text);
});

test('a pie saved to a crew links the crew, not a new table', () => {
  const text = pieResultText({ complete: true, championIds: ['p4'], standings }, { origin: 'https://tondo.example/', crewUrl: 'https://tondo.example/?crew=k7m2q9xh3p' });
  const last = text.split('\n')[2];
  assert(last === 'Four slices. See the crew: https://tondo.example/?crew=k7m2q9xh3p', last);
});

test('without crewUrl the text is byte-identical to before', () => {
  const a = pieResultText({ complete: true, championIds: ['p4'], standings }, { origin: 'https://tondo.example' });
  const b = pieResultText({ complete: true, championIds: ['p4'], standings }, { origin: 'https://tondo.example', crewUrl: '' });
  assert(a === b && a.endsWith('Four slices. Start a new table: https://tondo.example'), a);
});

if (failures.length) {
  for (const f of failures) console.error(`\n  FAIL  ${f.name}\n        ${f.err && f.err.message}`);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n${passed} passed, 0 failed\n`);
