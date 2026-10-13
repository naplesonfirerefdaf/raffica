// "Squadre 2 contro 2" (client side): team names, team colors and team scores.
// Teams live in the snapshot: pl[slot].tm = 0|1, s.tm = true when the team match is really on (4 players, 2 + 2).
// In a team match every player takes a color of its team: team 0 = red + gold, team 1 = blue + green
// (indices into PLAYER_COLORS, so the 3D roster, the 2D helpers and the effects all agree).
import { PLAYER_COLORS, MAX_PLAYERS } from '../core/proto.js';

export const TEAMS = [
  { id: 0, name: 'Rossa', plural: 'Rossi', colors: [0, 3], ...pick(0) },
  { id: 1, name: 'Blu', plural: 'Blu', colors: [1, 2], ...pick(1) },
];
function pick(k) { const c = PLAYER_COLORS[k]; return { main: c.main, light: c.light, dark: c.dark }; }

const IDENTITY = [...Array(MAX_PLAYERS).keys()];
export const teamOf = (p) => (p?.tm === 1 ? 1 : 0);

// slot -> PLAYER_COLORS index. `slots` = the slots taking part (seat order); identity when teams are off.
export function colorMap(pl, slots, active) {
  const map = IDENTITY.slice();
  if (!active || !pl) return map;
  const used = [0, 0];
  for (const s of slots) {
    const t = teamOf(pl[s]);
    map[s] = TEAMS[t].colors[Math.min(1, used[t]++)];
  }
  return map;
}

// Color map of a snapshot (team colors only while the team match is on).
export function snapColorMap(snap) {
  if (!snap?.tm) return IDENTITY.slice();
  const slots = snap.seats?.length ? snap.seats : snap.pl.map((p, s) => (p?.on ? s : -1)).filter((s) => s >= 0);
  return colorMap(snap.pl, slots, true);
}

// Team members (slots) of a snapshot, in seat order.
export function members(snap, t) {
  const seats = snap?.seats?.length ? snap.seats : [];
  return seats.filter((s) => teamOf(snap.pl?.[s]) === t);
}

// Team score: every member of the winning team scores, so the team has the score of its best member.
export function teamScore(snap, t, sc = snap?.sc) {
  const m = members(snap, t);
  return m.length ? Math.max(...m.map((s) => sc?.[s] || 0)) : 0;
}

// Counts of a list of {on, tm} places: [team0, team1] and whether the split is a valid 2 + 2.
export function teamSplit(list) {
  const n = [0, 0];
  for (const p of list) if (p?.on) n[teamOf(p)]++;
  return { n, ok: n[0] === 2 && n[1] === 2 };
}
