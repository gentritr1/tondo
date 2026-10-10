'use strict';

/**
 * Whether a `saveToCrew` may run, and running it. Kept out of index.js so the
 * decision is testable with a real Room and a real store and no socket server.
 *
 * Returns { refuse } (send the refusal), { noop } (nothing to do — a save is
 * already running or already landed), or { started } (a promise that settles
 * after pie.saving is cleared; the caller broadcasts and reports an error).
 */

const crews = require('./crews');
const db = require('./db');

function saveToCrew({ room, seat, message, ip, budgets, store = crews, status = () => db.publicStatus() }) {
  if (seat.isBot) return { refuse: 'Bots do not save pies.' };
  const pie = room.pie;
  if (!pie.complete) return { refuse: 'Finish the pie first.' };
  // A late joiner can read the finished scoreboard but did not play the pie.
  if (!pie.playerIds.includes(seat.id)) return { refuse: 'Only the players of this pie can save it.' };
  if (status() !== 'on') return { refuse: db.PLAYER_MESSAGE };

  const wantNew = typeof message.newCrewName === 'string';
  const crewId = wantNew ? null : String(message.crewId || '');
  if (!wantNew && !store.validCrewId(crewId)) return { refuse: 'That crew link is not right.' };

  // One crew per pie: the same crew again is a no-op, any other is refused by name.
  if (pie.savedTo) {
    if (!wantNew && pie.savedTo.id === crewId) return { noop: true };
    return { refuse: `This pie is already saved to ${pie.savedTo.name}.` };
  }
  // A save already running (two players tapping at once): the snapshot will show it land.
  if (pie.saving) return { noop: true };

  const newName = wantNew ? store.cleanCrewName(message.newCrewName) : null;
  if (wantNew && !newName) return { refuse: 'Give the crew a name.' };
  if (wantNew && !budgets.crewCreate.take(ip)) return { refuse: 'You have started enough crews for now. Try again later.' };

  // Built NOW, from this pie: a newRound during the save replaces room.pie and
  // must not change what is recorded or where savedTo lands.
  // Every other path into the store spends the crew-read budget too: a failed
  // `{ crewId }` save leaves savedTo null, so without this one socket could keep
  // Neon awake with random valid ids (a SELECT ... FOR UPDATE each).
  if (!wantNew && !budgets.crewRead.take(ip)) return { refuse: 'Too many crew lookups. Try again in a moment.' };

  const record = room.pieRecord();
  pie.saving = true;
  const started = store.savePie(wantNew ? { newName } : { crewId }, record).then(
    (saved) => {
      pie.saving = false;
      pie.savedTo = { id: saved.id, name: saved.name };
      if (!room.crew) room.crew = pie.savedTo;
      return { ok: true, crew: pie.savedTo };
    },
    (err) => {
      pie.saving = false;
      return { ok: false, message: (err && err.publicMessage) || db.PLAYER_MESSAGE };
    });
  return { started };
}

module.exports = { saveToCrew };
