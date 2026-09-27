/**
 * The finished pie as plain text, for pasting into a group chat.
 *
 * Plain text because it pastes everywhere. It names everyone and spoils
 * nothing, and it asks the reader for nothing: no reward, no "join my table" —
 * a room code is dead 60 seconds after the table empties, so the link offers
 * a NEW table instead of promising the old one.
 */

const listNames = (names) => (names.length <= 2
  ? names.join(' and ')
  : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * Same per-word title-casing as app.js's nicelyName() (app.js:~548, applied
 * at the champion headline and at every score row) — duplicated here rather
 * than imported, since share.js has no DOM and app.js already imports
 * pieResultText FROM it, so importing this back would be circular.
 *
 * Per WORD, not per string: title-casing the whole string turned "Chef Bot"
 * (server/bot.js's own BOT_NAMES) into "Chef bot". Splitting on spaces
 * before capitalising each word fixes that, but a straight per-word
 * title-case is ALSO wrong on its own: a word that already carries a
 * capital past its first letter (McDonald, eBay, DeAndre, AJ) is left
 * exactly as typed, never lowercased into it — a name is something a
 * person chose the casing of on purpose. This still normalizes a
 * plain-lowercase or ALL-CAPS-typed name a word at a time ("gent" ->
 * "Gent"), since neither carries an interior capital to protect. It does
 * NOT recover a capital buried inside an otherwise-uppercase word
 * ("MCDONALD" -> "Mcdonald", not "McDonald") — that needs a name
 * dictionary and is not attempted here.
 */
const nicelyName = (name) => {
  const s = String(name || '');
  return s.split(' ').map((w) => (/[A-Z]/.test(w.slice(1))
    ? w
    : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
};

/* Words for the small pie lengths the game could plausibly ship (server/
   rooms.js:59 defines PIE_ROUNDS = 4 today); anything larger falls back to
   the numeral rather than growing this list forever. */
const SLICE_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/**
 * `match.roundsPerPie` off the wire (PROTOCOL.md), read live rather than
 * hardcoded — the day the pie length changes, this text must not go on
 * saying "Four" in the one artifact that has already left the app and
 * cannot be corrected. A missing, zero or non-numeric value falls back to
 * `match.round`: this function only ever runs on a COMPLETE pie (guarded
 * above), and a complete pie's `round` IS the slice count it finished on —
 * one layer closer to the truth than the literal 4. Only if THAT is also
 * missing does it fall back to the literal, kept in sync with
 * server/rooms.js's PIE_ROUNDS.
 */
function sliceCount(match) {
  const perPie = Number(match && match.roundsPerPie);
  if (Number.isFinite(perPie) && perPie > 0) return perPie;
  const round = Number(match && match.round);
  if (Number.isFinite(round) && round > 0) return round;
  return 4;
}

function sliceSentence(n) {
  const word = SLICE_WORDS[n] || String(n);
  return `${word} slice${n === 1 ? '' : 's'}.`;
}

/**
 * A champion id resolved two ways: first against `standings` (everyone
 * still at the table — server/rooms.js:133 deliberately drops a seat that
 * left, which is correct there), then against the caller's `resolveName`
 * (app.js passes its own `playerName`, which — via game.js's `viewFor` —
 * keeps the ROUND winner resolvable even after they leave). Returns '' if
 * neither source knows the name; the caller decides what an unresolved
 * champion means, because '' is not the same claim as "nobody won."
 */
function championName(id, standings, resolveName) {
  const row = standings.find((r) => r.id === id);
  if (row) return nicelyName(row.name);
  const resolved = resolveName && resolveName(id);
  return resolved ? nicelyName(resolved) : '';
}

export function pieResultText(match, { origin = '', resolveName } = {}) {
  if (!match || !match.complete) return '';
  const standings = match.standings || [];
  const championIds = match.championIds || [];

  // Three outcomes, not two — conflating "nobody won" with "I cannot name
  // the winner" is the bug this function used to have: a champion who left
  // the table (championIds is frozen at round-record time and never
  // cleared; standings is recomputed live and drops them) would silently
  // read as "Nobody took the pie" while the screen beside it still named
  // them the winner, or worse, silently downgraded a shared pie to a solo
  // win for whoever was still left.
  let headline;
  if (championIds.length === 0) {
    // Genuinely unwon: leaders() returns [] at 0 points and 0 round wins.
    headline = 'Nobody took the pie';
  } else {
    const names = championIds.map((id) => championName(id, standings, resolveName));
    if (names.every(Boolean)) {
      headline = names.length > 1
        ? `${listNames(names)} shared the pie`
        : `${names[0]} took the pie`;
    } else {
      // Someone specific DID win — just not everyone involved is nameable
      // right now. Never assert a negative ("Nobody") and never silently
      // drop the unresolved name to make it read as a solo win: say
      // nothing false instead.
      headline = 'the pie is finished';
    }
  }

  const scores = standings.map((r) => {
    // Defended the same way `roundsPerPie` is: a row is trusted for id and
    // isBot, but `points` off the wire is still an external value, and an
    // undefined one would print literally as the word "undefined" in a
    // template string. Not reachable today (the server always sends a
    // number), but `sliceCount` above got this exact treatment for the
    // same reason — a missing field must never speak for itself.
    const pts = Number(r.points);
    return `${nicelyName(r.name)} ${Number.isFinite(pts) ? pts : 0}`;
  }).join(' · ');

  return `🍕 TONDO — ${headline}\n${scores}\n${sliceSentence(sliceCount(match))} Start a new table: ${origin}`;
}
