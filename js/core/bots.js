// Computer players ("bot"). ISOMORPHIC: runs inside the Host (Node or browser), never touches the DOM.
// A game may export `bot(s, me, g, B)` that returns what the bot WANTS to do this tick:
//   { x, y,            world direction (|v| ≤ 1), like a player's stick
//     sx?, sy?,        optional "screen" stick (defaults to x, y)
//     a?, b?,          hold the button (the first frame of a hold is a press)
//     tapA?, tapB? }   press as soon as the level allows (for mashing / single taps)
//   s = full game state (READ ONLY), me = seat index, g = game API (g.n, g.t, g.world, g.variant, g.mods…),
//   B = { level: 0 (facile) | 1 (medio) | 2 (difficile), rng, t, mem: {} per bot per round }.
// The driver below applies the level the same way for every game: reaction delay, aim error,
// max press rate and occasional distractions. Game bots should still play "as well as they can" and use
// B.level only for tactics (e.g. the easy bot does not use the special move, the hard one predicts).
import { EMPTY_INPUT } from './proto.js';

export const BOT_LEVELS = [
  { id: 'facile', name: 'Scudiero', icon: '🪵' },
  { id: 'medio', name: 'Cavaliere', icon: '⚔️' },
  { id: 'difficile', name: 'Re', icon: '👑' },
];
export const botLevelIndex = (id) => Math.max(0, BOT_LEVELS.findIndex((l) => l.id === id));
export const BOT_NAMES = ['Ser Pancotto', 'Dama Frittella', 'Fra Mestolo', 'Re Tortello', 'Messer Lardo', 'Donna Ricotta', 'Conte Fagiolo', 'Baron Polenta'];

const TUNING = [
  { delay: 0.34, aim: 0.55, rate: 0.19, lapse: 0.12, lapseLen: [0.5, 1.3] },  // facile
  { delay: 0.2, aim: 0.25, rate: 0.12, lapse: 0.04, lapseLen: [0.3, 0.8] },   // medio
  { delay: 0.09, aim: 0.07, rate: 0.085, lapse: 0, lapseLen: [0, 0] },        // difficile
];
const IDLE = Object.freeze({ x: 0, y: 0, a: false, b: false });

// Turns "wants" into a raw INPUT (same format a real client sends), applying the level.
export function makeBotDriver(level, rng) {
  const L = TUNING[Math.max(0, Math.min(2, level))];
  const raw = { ...EMPTY_INPUT };
  const q = [];
  let lastA = -9, lastB = -9, heldA = false, heldB = false, releaseA = false, releaseB = false;
  let noise = 0, lapseUntil = -1, lapseDir = { x: 0, y: 0 };
  // Personality: two bots of the same level must never act in perfect sync (mirror matches look robotic).
  // Each bot gets its own reaction speed, a slowly wandering extra delay and a habit of hesitating before a press.
  const pers = 0.75 + rng() * 0.5;
  const wobble = rng() * Math.PI * 2;
  const hesitate = 0.25 + rng() * 0.35; // chance per frame of NOT pressing yet when a press is wanted
  let pendA = false, pendB = false;
  return {
    level,
    mem: {},
    step(T, want) {
      q.push({ T, w: want || IDLE });
      const delay = L.delay * pers * (1 + 0.3 * Math.sin(T * 0.9 + wobble)) + 0.02;
      while (q.length > 1 && q[1].T <= T - delay) q.shift();
      let w = q[0].T <= T - delay ? q[0].w : IDLE;
      // Hesitation: a wanted tap waits a random few frames (holds stay immediate so movement is not sluggish).
      if (w.tapA || pendA) { pendA = rng() < hesitate; if (pendA) w = { ...w, tapA: false }; }
      if (w.tapB || pendB) { pendB = rng() < hesitate; if (pendB) w = { ...w, tapB: false }; }
      // Distraction: wander for a moment (easy bots).
      if (L.lapse && T > lapseUntil && rng() < L.lapse * (1 / 60)) {
        lapseUntil = T + L.lapseLen[0] + rng() * (L.lapseLen[1] - L.lapseLen[0]);
        const a = rng() * Math.PI * 2;
        lapseDir = rng() < 0.5 ? { x: 0, y: 0 } : { x: Math.cos(a), y: Math.sin(a) };
      }
      if (T < lapseUntil) w = { x: lapseDir.x, y: lapseDir.y, a: false, b: false };
      // Aim error: a slowly drifting rotation of the stick.
      noise += (rng() - 0.5) * 0.3 - noise * 0.05;
      const ang = noise * L.aim * 2;
      const c = Math.cos(ang), s = Math.sin(ang);
      const x = w.x || 0, y = w.y || 0;
      raw.x = x * c - y * s; raw.y = x * s + y * c;
      const m = Math.hypot(raw.x, raw.y);
      if (m > 1) { raw.x /= m; raw.y /= m; }
      const sx = w.sx ?? x, sy = w.sy ?? y;
      raw.sx = Math.max(-1, Math.min(1, sx * c - sy * s));
      raw.sy = Math.max(-1, Math.min(1, sx * s + sy * c));
      // Buttons: a press needs the button released for a frame and respects the level's max press rate.
      const press = (wantHold, wantTap, held, last, release) => {
        if (release) return { held: false, last, release: false, pressed: false };
        if ((wantHold && !held) || wantTap) {
          if (T - last >= L.rate) return { held: true, last: T, release: !wantHold, pressed: true };
          return { held, last, release: false, pressed: false };
        }
        return { held: wantHold && held, last, release: false, pressed: false };
      };
      const A = press(!!w.a, !!w.tapA, heldA, lastA, releaseA);
      heldA = A.held; lastA = A.last; releaseA = A.release;
      if (A.pressed) { raw.ac++; raw.aT = T; }
      const B = press(!!w.b, !!w.tapB, heldB, lastB, releaseB);
      heldB = B.held; lastB = B.last; releaseB = B.release;
      if (B.pressed) { raw.bc++; raw.bT = T; }
      raw.a = heldA; raw.b = heldB;
      return raw;
    },
  };
}

// Fallback for games without their own bot: walk toward the nearest rival (from def.focus) and press A when close.
export function genericBot(def, s, me, g, B) {
  let pts = null;
  try { pts = def.focus ? def.focus(def.view(s)) : null; } catch { pts = null; }
  if (!pts || !pts[me]) {
    const m = B.mem;
    if (!m.until || g.t > m.until) { m.until = g.t + 0.5 + B.rng() * 1.2; const a = B.rng() * Math.PI * 2; m.dx = Math.cos(a); m.dy = Math.sin(a); }
    return { x: m.dx, y: m.dy, tapA: B.rng() < 0.08, tapB: B.rng() < 0.02 };
  }
  const p = pts[me];
  let best = null, bd = Infinity;
  pts.forEach((q, k) => { if (k !== me && q) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = q; } } });
  if (!best) return IDLE;
  const dx = best.x - p.x, dy = best.y - p.y, d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d, tapA: d < 180 && B.rng() < 0.2, tapB: B.rng() < 0.01 };
}
