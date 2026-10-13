// Shared constants (Node + browser).
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const PHASES = ['lobby', 'pick', 'roulette', 'intro', 'countdown', 'play', 'finish', 'result', 'final', 'pause'];

// Phase durations in seconds (host side).
export const PHASE_TIME = {
  pick: 7,        // last-placed player chooses among cards
  roulette: 3.2,  // random wheel
  intro: 3600,    // rule card: no timer, starts when every player presses A
  countdown: 2.6, // 3-2-1-VIA
  finish: 1.6,    // slow-motion after end()
  result: 2.8,    // winner banner
};

export const DEFAULT_SETTINGS = {
  target: 5,       // points to win the match
  crazy: true,     // global crazy rules ("regole pazze")
  variants: true,  // per-game crazy variants
  loserPicks: true,
  teams: false,    // 2 contro 2 (needs 4 players, 2 per team): a game won by a player gives the point to the whole team
  only: null,      // array of game ids to restrict the pool (practice / free play)
};

export const EMPTY_INPUT = Object.freeze({
  x: 0, y: 0, sx: 0, sy: 0, a: false, b: false, ac: 0, bc: 0, aT: -1, bT: -1,
});

// Sanitize an input message coming from a client.
export function cleanInput(i) {
  if (!i || typeof i !== 'object') return { ...EMPTY_INPUT };
  const n = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
  let x = n(i.x, -1, 1), y = n(i.y, -1, 1);
  const len = Math.hypot(x, y);
  if (len > 1) { x /= len; y /= len; }
  return {
    x, y,
    sx: n(i.sx, -1, 1), sy: n(i.sy, -1, 1),
    a: !!i.a, b: !!i.b,
    ac: Math.floor(n(i.ac, 0, 1e9)), bc: Math.floor(n(i.bc, 0, 1e9)),
    aT: typeof i.aT === 'number' && Number.isFinite(i.aT) ? i.aT : -1,
    bT: typeof i.bT === 'number' && Number.isFinite(i.bT) ? i.bT : -1,
  };
}

export const MAX_PLAYERS = 4;

// Team colors (banners, rings, HUD). Characters are chosen separately.
export const PLAYER_COLORS = [
  { main: '#ff4b5c', light: '#ffa3ab', dark: '#8a1626', name: 'Rosso' },
  { main: '#3fa9ff', light: '#a9d8ff', dark: '#0f4f8a', name: 'Blu' },
  { main: '#5fd35a', light: '#b5f0b1', dark: '#1f6e1c', name: 'Verde' },
  { main: '#ffc53d', light: '#ffe4a3', dark: '#8a6408', name: 'Giallo' },
];

// Selectable characters (KayKit CC0 models in public/assets/chars/<file>.glb).
export const CHARACTERS = [
  { id: 'knight', name: 'Cavaliere', file: 'Knight', icon: '🛡️' },
  { id: 'barbarian', name: 'Barbaro', file: 'Barbarian', icon: '🪓' },
  { id: 'mage', name: 'Maga', file: 'Mage', icon: '🔮' },
  { id: 'rogue', name: 'Ladra', file: 'Rogue', icon: '🗡️' },
  { id: 'hooded', name: 'Incappucciato', file: 'Rogue_Hooded', icon: '🏹' },
  { id: 'skwarrior', name: 'Scheletro Guerriero', file: 'Skeleton_Warrior', icon: '💀' },
  { id: 'skmage', name: 'Negromante', file: 'Skeleton_Mage', icon: '🪄' },
  { id: 'skrogue', name: 'Scheletro Furfante', file: 'Skeleton_Rogue', icon: '☠️' },
  { id: 'skminion', name: 'Scheletrino', file: 'Skeleton_Minion', icon: '🦴' },
];
// Null prototype: client-sent ids like 'constructor' or '__proto__' must never look like a character.
export const CHAR_BY_ID = Object.assign(Object.create(null), Object.fromEntries(CHARACTERS.map((c) => [c.id, c])));
export const DEFAULT_CHARS = ['knight', 'mage', 'barbarian', 'rogue'];
// Max players a game supports (games declare `players: 4`; older 1v1 games default to 2).
export const maxPlayersOf = (def) => Math.max(2, Math.min(MAX_PLAYERS, def?.players || 2));
