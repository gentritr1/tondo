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

/* The same title-casing app.js's own scoreboard runs every name through
   (app.js:532, applied at the champion headline and at every score row) —
   duplicated here rather than imported, since share.js has no DOM and app.js
   imports FROM share.js. A name typed or stored in any case reads the same
   way in the pasted text as it already does on the screen the player is
   looking at.
   Per WORD, not per string: title-casing the whole string turned the bot
   name "Chef Bot" (server/bot.js's own BOT_NAMES) into "Chef bot", and does
   the same to a human-typed "JO ANNE" -> "Jo anne". Splitting on spaces
   before capitalising each word fixes that. It still flattens a capital
   INSIDE a single word ("McDonald" -> "Mcdonald") — recovering that needs a
   name dictionary and is not worth it here. */
const nicely = (name) => {
  const s = String(name || '');
  return s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
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
 * the shipping length (4) rather than ever printing "undefined" or "NaN".
 */
function sliceCount(match) {
  const n = Number(match && match.roundsPerPie);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

function sliceSentence(n) {
  const word = SLICE_WORDS[n] || String(n);
  return `${word} slice${n === 1 ? '' : 's'}.`;
}

export function pieResultText(match, { origin = '' } = {}) {
  if (!match || !match.complete) return '';
  const standings = match.standings || [];
  const nameOf = (id) => {
    const row = standings.find((r) => r.id === id);
    return row ? nicely(row.name) : '';
  };
  const champions = (match.championIds || []).map(nameOf).filter(Boolean);
  const headline = champions.length > 1
    ? `${listNames(champions)} shared the pie`
    : `${champions[0] || 'Nobody'} took the pie`;
  const scores = standings.map((r) => `${nicely(r.name)} ${r.points}`).join(' · ');
  return `🍕 TONDO — ${headline}\n${scores}\n${sliceSentence(sliceCount(match))} Start a new table: ${origin}`;
}
