// Botti in Miniera — Bomberman for 2-4 dwarves in a dwarven mine (top-down, dir + A bomb + B kick).
// Simulation works in cell units (cell centers at integer coords 0..N-1); the view converts to world units.
import { clamp, r1, r2 } from '../core/geom.js';

const W = 1000, H = 1000;
const N = 11, CELL = 86, OX = (W - N * CELL) / 2, OY = (H - N * CELL) / 2;
const EMPTY = 0, PILLAR = 1, CRATE = 2, BLOCK = 3;
const CRATE_P = 0.62, DROP_P = 0.38;
const BASE_SPEED = 3.6, SHOE_SPEED = 0.6, MAX_SHOES = 3;
const FUSE = 2, FLAME_T = 0.55, START_RANGE = 2, MAX_RANGE = 6, MAX_BOMBS = 5;
const KICK_SPEED = 7.5;
const SHRINK_AT = 25, FALL_WARN = 1.0, FALL_EVERY = 0.4;
const DEATH_WINDOW = 0.15; // a later death inside this window still counts as "died later"
const PU = ['b', 'f', 's', 'b', 'f', 'm']; // m = mega bomb "bombarda" (rarer)
const KICK_CD = 0.3, BOUNCES = 3;
// Seat spawns: 0 bottom-left, 1 top-right, 2 top-left, 3 bottom-right (c, r, facing x).
const SPAWN = [[0, N - 1, 1], [N - 1, 0, -1], [0, 0, 1], [N - 1, N - 1, -1]];
// Cells that mirror a cell: 180° twin (2 players) or the 4 mirror images (3-4 players, every corner is fair).
function mirrors(c, r, four) {
  const out = [idx(c, r), idx(N - 1 - c, N - 1 - r)];
  if (four) out.push(idx(N - 1 - c, r), idx(c, N - 1 - r));
  return [...new Set(out)];
}

const idx = (c, r) => r * N + c;
const wx = (c) => OX + (c + 0.5) * CELL;
const wy = (r) => OY + (r + 0.5) * CELL;
const inside = (c, r) => c >= 0 && r >= 0 && c < N && r < N;
const cellOf = (o) => idx(Math.round(o.x), Math.round(o.y));
const isPillar = (c, r) => c % 2 === 1 && r % 2 === 1;
const overlaps = (p, b) => Math.abs(p.x - b.x) < 0.82 && Math.abs(p.y - b.y) < 0.82;

function bombAt(s, c, r) {
  for (const b of s.bombs) if (Math.round(b.x) === c && Math.round(b.y) === r) return b;
  return null;
}

// Solid for player pi (bombs are walkable for whoever was standing on them when placed).
function solidFor(s, c, r, pi) {
  if (!inside(c, r)) return true;
  if (s.grid[idx(c, r)] !== EMPTY) return true;
  const b = bombAt(s, c, r);
  return !!(b && !b.pass[pi]);
}

// Spiral order of falling blocks, outer ring first, in symmetric groups (pairs, or fours with 3-4 players).
function fallSchedule(four) {
  const order = [];
  for (let k = 0; k <= N >> 1; k++) {
    const lo = k, hi = N - 1 - k;
    for (let c = lo; c <= hi; c++) order.push([c, lo]);
    for (let r = lo + 1; r <= hi; r++) order.push([hi, r]);
    for (let c = hi - 1; c >= lo; c--) order.push([c, hi]);
    for (let r = hi - 1; r > lo; r--) order.push([lo, r]);
  }
  const seen = new Set(), out = [];
  let t = SHRINK_AT + FALL_WARN;
  for (const [c, r] of order) {
    if (isPillar(c, r)) continue;
    if (seen.has(idx(c, r))) continue;
    for (const k of mirrors(c, r, four)) { seen.add(k); out.push({ i: k, t }); }
    t += FALL_EVERY;
  }
  return out;
}

const game = {
  id: 'bombe',
  name: 'Botti in Miniera',
  rule: 'Piazza le bombe e fai saltare in aria gli altri!',
  verb: 'FAI IL BOTTO!',
  inspired: 'Bomberman',
  cam: 'top',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', label: 'Muovi', a: 'Bomba', b: 'Calcio' },
  help: {
    goal: "Fai saltare in aria gli altri nani con le bombe: basta una fiammata! L'ultimo in piedi vince.",
    dir: 'Muoviti nei cunicoli della miniera (scivoli da solo attorno agli spigoli).',
    a: 'BOMBA: piazzi una bomba sotto di te. Esplode dopo 2 s a croce (attento: anche tu!).',
    b: 'CALCIO: calci la bomba che hai davanti (o sotto i piedi) nella direzione in cui guardi: scivola finché sbatte.',
    tips: ['Le croci rosse mostrano dove arriverà l’esplosione', 'Casse: 🧨 +1 bomba, 🔥 +raggio, 👢 stivali veloci, 💣 BOMBARDA', 'Dopo 25 s la miniera crolla: cadono i massi dai bordi'],
  },
  duration: 50,
  variants: [
    { id: 'miccia', name: 'Miccia Pazza', desc: 'Ogni bomba ha una miccia diversa: da 0,8 a 3,5 secondi!' },
    { id: 'infinito', name: 'Polvere dei Nani', desc: 'Le esplosioni arrivano fino alle rocce!' },
    { id: 'rimbalzini', name: 'Bombe Rimbalzine', desc: 'Le bombe calciate rimbalzano sui muri! Calci anche camminandoci contro.' },
  ],

  init(g) {
    const n = Math.max(2, Math.min(4, g.n || 2)), four = n > 2;
    const grid = new Array(N * N).fill(EMPTY);
    const free = new Set();
    // Spawn corners (+ their L) stay free: 0 bottom-left, 1 top-right (+ 2 top-left, 3 bottom-right).
    for (const [c, r] of [[0, 10], [1, 10], [0, 9]]) for (const k of mirrors(c, r, four)) free.add(k);
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const a = idx(c, r), mir = mirrors(c, r, four);
        if (isPillar(c, r)) { grid[a] = PILLAR; continue; }
        if (a > Math.min(...mir)) continue; // mirrored copies decided by their first twin
        if (!free.has(a) && g.rng.chance(CRATE_P)) for (const k of mir) grid[k] = CRATE;
      }
    }
    // Power-ups hidden in crates, mirrored too.
    const drops = new Array(N * N).fill('');
    for (let a = 0; a < N * N; a++) {
      const mir = mirrors(a % N, Math.floor(a / N), four);
      if (mir.length > 1 && a === Math.min(...mir) && grid[a] === CRATE && g.rng.chance(DROP_P)) { const pu = g.rng.pick(PU); for (const k of mir) drops[k] = pu; }
    }
    return {
      grid, drops, pu: new Array(N * N).fill(''), fl: new Array(N * N).fill(0),
      bombs: [], nextId: 1, falls: fallSchedule(four), fallK: 0, shrinkSaid: false,
      firstDeath: -1, lastDeath: -1, t: 0, fresh: new Set(),
      p: Array.from({ length: n }, (_, i) => ({
        i, x: SPAWN[i][0], y: SPAWN[i][1], fx: SPAWN[i][2], fy: 0,
        alive: true, deadT: 0, diedAt: 0, how: '', maxB: 1, range: START_RANGE, shoes: 0,
        lastPlace: -1, crates: 0, walk: 0, mv: 0, kcd: 0, kk: 0, mega: false,
      })),
    };
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.t = g.t;
    s.fresh.clear();
    for (const p of s.p) {
      if (!p.alive) { p.deadT += dt; continue; }
      game.movePlayer(s, p, inp[p.i], dt, g);
      p.kcd = Math.max(0, p.kcd - dt); p.kk = Math.max(0, p.kk - dt);
      if (inp[p.i].aP) game.placeBomb(s, p, g);
      if (inp[p.i].bP && p.kcd <= 0) game.kick(s, p, g);
      // Power-up pickup.
      const ci = cellOf(p), pu = s.pu[ci];
      if (pu) {
        s.pu[ci] = '';
        if (pu === 'b') p.maxB = Math.min(MAX_BOMBS, p.maxB + 1);
        if (pu === 'f') p.range = Math.min(MAX_RANGE, p.range + 1);
        if (pu === 's') p.shoes = Math.min(MAX_SHOES, p.shoes + 1);
        if (pu === 'm') p.mega = true;
        const txt = pu === 'b' ? '+1 BOMBA' : pu === 'f' ? '+1 RAGGIO' : pu === 'm' ? 'BOMBARDA!' : 'STIVALI VELOCI';
        g.sfx('powerup'); g.text(wx(p.x), wy(p.y) - 50, txt, { player: p.i, size: 34 });
        g.burst(wx(p.x), wy(p.y), { color: '#fff36b', n: 12, speed: 180 });
      }
    }
    // Leaving your own bomb makes it solid for you.
    for (const b of s.bombs) for (const p of s.p) if (b.pass[p.i] && !overlaps(p, b)) b.pass[p.i] = false;

    game.slideBombs(s, dt, g);
    // Fuses + chain reactions.
    for (const b of s.bombs) { b.fuse -= dt; if (s.fl[cellOf(b)] > 0) b.fuse = 0; }
    let boom = 0;
    for (let guard = 0; guard < 50; guard++) {
      const b = s.bombs.find((q) => q.fuse <= 0);
      if (!b) break;
      game.explode(s, b, g);
      boom++;
    }
    if (boom) {
      g.sfx(boom > 1 ? 'bigexplode' : 'explode', { pitch: 0.9 + g.rng() * 0.2 });
      g.shake(Math.min(0.8, 0.3 + boom * 0.12));
    }
    for (let k = 0; k < s.fl.length; k++) if (s.fl[k] > 0) s.fl[k] = Math.max(0, s.fl[k] - dt);

    game.stepShrink(s, g);

    // Flame deaths.
    for (const p of s.p) {
      if (p.alive && s.fl[cellOf(p)] > 0) game.kill(s, p, 'fire', g);
    }
    game.resolve(s, g);
  },

  movePlayer(s, p, i, dt, g) {
    const mag = Math.hypot(i.x, i.y);
    p.mv = 0;
    if (mag < 0.3) return;
    if (Math.abs(i.x) > 0.3 || Math.abs(i.y) > 0.3) {
      if (Math.abs(i.x) >= Math.abs(i.y)) { p.fx = Math.sign(i.x); p.fy = 0; } else { p.fx = 0; p.fy = Math.sign(i.y); }
    }
    const dist = (BASE_SPEED + SHOE_SPEED * p.shoes) * dt;
    const primX = Math.abs(i.x) >= Math.abs(i.y);
    const ax1 = primX ? 0 : 1, s1 = Math.sign(primX ? i.x : i.y);
    let moved = game.tryAxis(s, p, ax1, s1, dist, g);
    const sec = primX ? i.y : i.x;
    if (moved < 1e-4 && Math.abs(sec) > 0.25) moved = game.tryAxis(s, p, 1 - ax1, Math.sign(sec), dist, g);
    if (moved > 0) { p.mv = 1; p.walk += moved; }
  },

  // Move along one axis with corner sliding (auto-align to the free lane). Returns distance moved.
  tryAxis(s, p, ax, sgn, dist, g) {
    const solid = (m, l) => (ax === 0 ? solidFor(s, m, l, p.i) : solidFor(s, l, m, p.i));
    let main = ax === 0 ? p.x : p.y, perp = ax === 0 ? p.y : p.x;
    const cm = Math.round(main);
    let moved = 0;
    const lane = Math.round(perp), off = perp - lane;
    if (Math.abs(off) > 1e-3) {
      let target = null;
      if (!solid(cm + sgn, lane)) target = lane;
      else if (Math.abs(off) > 0.3 && !solid(cm + sgn, lane + Math.sign(off))) target = lane + Math.sign(off);
      if (target === null) return 0;
      const need = target - perp, st = Math.min(Math.abs(need), dist);
      perp += Math.sign(need) * st; dist -= st; moved += st;
      if (Math.abs(target - perp) > 1e-6) { game.setPos(p, ax, main, perp); return moved; }
      perp = target;
    }
    const l = Math.round(perp);
    const cur = Math.round(main);
    let nm = main + sgn * dist;
    if (solid(cur + sgn, l)) {
      nm = sgn > 0 ? Math.min(nm, cur) : Math.max(nm, cur);
      // Botti Rimbalzini: pushing into a resting bomb kicks it.
      if (g.variant === 'rimbalzini' && Math.abs(main - cur) < 0.06) {
        const b = ax === 0 ? bombAt(s, cur + sgn, l) : bombAt(s, l, cur + sgn);
        if (b && !b.vx && !b.vy) {
          if (ax === 0) b.vx = sgn * KICK_SPEED; else b.vy = sgn * KICK_SPEED;
          b.bn = BOUNCES;
          g.sfx('kick'); g.burst(wx(b.x), wy(b.y), { color: '#ffffff', n: 8, speed: 160 });
        }
      }
    }
    moved += Math.abs(nm - main);
    game.setPos(p, ax, nm, perp);
    return moved;
  },

  setPos(p, ax, main, perp) {
    if (ax === 0) { p.x = main; p.y = perp; } else { p.y = main; p.x = perp; }
  },

  placeBomb(s, p, g) {
    const c = Math.round(p.x), r = Math.round(p.y);
    if (s.bombs.filter((b) => b.owner === p.i).length >= p.maxB) { g.sfx('click', { vol: 0.4 }); return; }
    if (bombAt(s, c, r) || s.grid[idx(c, r)] !== EMPTY) return;
    const fuse = g.variant === 'miccia' ? g.rng.range(0.8, 3.5) : FUSE;
    const b = { id: s.nextId++, x: c, y: r, vx: 0, vy: 0, fuse, fuse0: fuse, owner: p.i, range: p.mega ? N : p.range, mega: p.mega, bn: 0, pass: s.p.map(() => false) };
    if (p.mega) { p.mega = false; g.sfx('fuse', { pitch: 0.6 }); }
    for (const q of s.p) b.pass[q.i] = q.alive && overlaps(q, b);
    s.bombs.push(b);
    p.lastPlace = g.t;
    g.sfx('fuse', { vol: 0.7 });
    g.ring(wx(c), wy(r), { player: p.i, r: 50 });
  },

  // B: kick the bomb under your feet or the one right in front of you.
  kick(s, p, g) {
    const c = Math.round(p.x), r = Math.round(p.y);
    let b = bombAt(s, c, r);
    if (b && (b.vx || b.vy)) b = null;
    if (!b) {
      const q = bombAt(s, c + p.fx, r + p.fy);
      const along = p.fx ? (p.x - c) * p.fx : (p.y - r) * p.fy;  // >0 when already leaning toward it
      const perp = p.fx ? Math.abs(p.y - r) : Math.abs(p.x - c);
      if (q && !q.vx && !q.vy && perp < 0.4 && along > -0.45) b = q;
    }
    p.kcd = KICK_CD; p.kk = 0.25;
    if (!b) { g.sfx('whoosh', { vol: 0.3, pitch: 1.6 }); return; }
    // Do not kick into a wall right away (nothing would happen).
    const nc = Math.round(b.x) + p.fx, nr = Math.round(b.y) + p.fy;
    if (!inside(nc, nr) || s.grid[idx(nc, nr)] !== EMPTY) { g.sfx('bonk', { vol: 0.4 }); return; }
    b.vx = p.fx * KICK_SPEED; b.vy = p.fy * KICK_SPEED;
    b.bn = g.variant === 'rimbalzini' ? BOUNCES : 0;
    g.sfx('kick'); g.vibrate(p.i, 40);
    g.burst(wx(b.x), wy(b.y), { player: p.i, n: 10, speed: 200 });
  },

  slideBombs(s, dt, g) {
    for (const b of s.bombs) {
      if (!b.vx && !b.vy) continue;
      const ax = b.vx ? 0 : 1, sgn = Math.sign(b.vx || b.vy);
      const main = ax === 0 ? b.x : b.y, l = ax === 0 ? Math.round(b.y) : Math.round(b.x);
      const cur = Math.round(main), nc = cur + sgn;
      const [c, r] = ax === 0 ? [nc, l] : [l, nc];
      let blocked = !inside(c, r) || s.grid[idx(c, r)] !== EMPTY;
      if (!blocked) for (const q of s.bombs) if (q !== b && Math.round(q.x) === c && Math.round(q.y) === r) blocked = true;
      if (!blocked) for (const p of s.p) if (p.alive && Math.round(p.x) === c && Math.round(p.y) === r) blocked = true;
      let nm = main + sgn * Math.abs(b.vx || b.vy) * dt;
      if (blocked && (nm - cur) * sgn >= 0) {
        nm = cur;
        if (b.bn > 0) { // bouncy bomb: bounce back
          b.bn--; b.vx = -b.vx; b.vy = -b.vy;
          g.sfx('boing', { vol: 0.6, pitch: 1.2 });
          g.burst(wx(ax === 0 ? cur : l), wy(ax === 0 ? l : cur), { color: '#fff', n: 5, speed: 120 });
        } else { b.vx = 0; b.vy = 0; g.sfx('bonk', { vol: 0.6 }); }
      }
      if (ax === 0) b.x = nm; else b.y = nm;
      if (!b.vx && !b.vy) { b.x = Math.round(b.x); b.y = Math.round(b.y); }
    }
  },

  explode(s, b, g) {
    s.bombs.splice(s.bombs.indexOf(b), 1);
    const c0 = Math.round(b.x), r0 = Math.round(b.y);
    const range = g.variant === 'infinito' ? N : b.range;
    const burn = (c, r) => {
      const k = idx(c, r);
      s.fl[k] = FLAME_T;
      if (s.pu[k] && !s.fresh.has(k)) { s.pu[k] = ''; g.burst(wx(c), wy(r), { color: '#ffffff', n: 6, speed: 120 }); }
      for (const q of s.bombs) if (Math.round(q.x) === c && Math.round(q.y) === r) q.fuse = 0;
    };
    burn(c0, r0);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let k = 1; k <= range; k++) {
        const c = c0 + dx * k, r = r0 + dy * k;
        if (!inside(c, r)) break;
        const t = s.grid[idx(c, r)];
        if (t === PILLAR || t === BLOCK) break;
        if (t === CRATE) {
          s.grid[idx(c, r)] = EMPTY;
          s.fl[idx(c, r)] = FLAME_T;
          s.p[b.owner].crates++;
          g.sfx('break', { vol: 0.6 });
          g.burst(wx(c), wy(r), { color: '#c98a4b', n: 10, speed: 240, size: 8 });
          // Revealed power-up appears after the flame (it is placed after burning).
          if (s.drops[idx(c, r)]) { s.pu[idx(c, r)] = s.drops[idx(c, r)]; s.drops[idx(c, r)] = ''; s.fresh.add(idx(c, r)); }
          break;
        }
        const hadBomb = !!bombAt(s, c, r);
        burn(c, r);
        if (hadBomb) break;
      }
    }
    // Fireworks juice.
    const x = wx(c0), y = wy(r0);
    g.burst(x, y, { color: '#ffb300', n: 22, speed: 380, size: 9 });
    g.burst(x, y, { player: b.owner, n: 12, speed: 300 });
    g.ring(x, y, { color: '#fff3a0', r: 70 });
  },

  stepShrink(s, g) {
    if (g.t >= SHRINK_AT - 1.5 && !s.shrinkSaid) {
      s.shrinkSaid = true;
      g.say('CROLLA LA MINIERA!'); g.sfx('horn');
    }
    while (s.fallK < s.falls.length && g.t >= s.falls[s.fallK].t) {
      const f = s.falls[s.fallK++];
      const c = f.i % N, r = Math.floor(f.i / N);
      s.grid[f.i] = BLOCK; s.pu[f.i] = ''; s.drops[f.i] = '';
      s.bombs = s.bombs.filter((b) => cellOf(b) !== f.i);
      g.sfx('crash', { vol: 0.5 }); g.shake(0.15);
      g.burst(wx(c), wy(r), { color: '#a89a88', n: 8, speed: 160 });
      for (const p of s.p) if (p.alive && cellOf(p) === f.i) game.kill(s, p, 'squish', g);
    }
  },

  kill(s, p, how, g) {
    p.alive = false; p.diedAt = g.t; p.deadT = 0; p.how = how;
    g.sfx(how === 'squish' ? 'squish' : 'bigexplode');
    g.burst(wx(p.x), wy(p.y), { player: p.i, n: 30, speed: 420, size: 10 });
    g.burst(wx(p.x), wy(p.y), { color: '#333333', n: 16, speed: 220, size: 12 });
    g.vibrate(p.i, 250); g.shake(0.8); g.hitstop(0.1);
    if (s.firstDeath < 0) s.firstDeath = g.t;
    s.lastDeath = g.t;
    const left = s.p.filter((q) => q.alive).length;
    if (left <= 1 && !s.slowSaid) { s.slowSaid = true; g.slowmo(0.3, 0.8); }
    else if (left > 1) g.text(wx(p.x), wy(p.y) - 60, 'ELIMINATO!', { player: p.i, size: 40 });
  },

  // Last one standing. A death inside the window after the latest one still counts as "died later";
  // if nobody is left, the latest death wins (then whoever placed a bomb less recently).
  resolve(s, g) {
    if (g.ended || s.firstDeath < 0) return;
    const alive = s.p.filter((p) => p.alive);
    if (alive.length >= 2) return;
    if (alive.length === 1 && g.t < s.lastDeath + DEATH_WINDOW) return;
    let w;
    if (alive.length === 1) w = alive[0].i;
    else w = game.best(s.p, [(p) => p.diedAt, (p) => -p.lastPlace], g);
    const last = s.p.filter((p) => !p.alive).sort((a, b) => b.diedAt - a.diedAt)[0];
    g.end(w, last && last.how === 'squish' ? 'Schiacciato da un masso!' : 'BOTTO!');
  },

  // Highest by the keys in order (values within 1e-6 tie and go to the next key); full tie: random.
  best(list, keys, g) {
    let pool = list;
    for (const key of keys) {
      const top = Math.max(...pool.map(key));
      pool = pool.filter((p) => key(p) > top - 1e-6);
      if (pool.length === 1) return pool[0].i;
    }
    return pool[g.rng.int(0, pool.length - 1)].i;
  },

  timeout(s, g) {
    const alive = s.p.filter((p) => p.alive);
    if (alive.length === 1) return alive[0].i;
    return game.best(alive.length ? alive : s.p, [(p) => p.maxB + p.range + p.shoes, (p) => p.crates, (p) => -p.lastPlace], g);
  },

  view(s) {
    let gr = '';
    for (let k = 0; k < N * N; k++) {
      const t = s.grid[k];
      gr += t === PILLAR ? '#' : t === CRATE ? 'c' : t === BLOCK ? 'X' : s.pu[k] || '.';
    }
    const fl = [];
    for (let k = 0; k < N * N; k++) if (s.fl[k] > 0) fl.push(k, r2(s.fl[k] / FLAME_T));
    const wn = [];
    // Falling-block warnings: upcoming blocks within FALL_WARN seconds (precomputed times).
    for (let k = s.fallK; k < s.falls.length && s.falls[k].t - s.t <= FALL_WARN; k++) {
      wn.push(s.falls[k].i, r2(clamp(1 - (s.falls[k].t - s.t) / FALL_WARN, 0, 1)));
    }
    return {
      gr, fl: { noLerp: 1, a: fl }, wn: { noLerp: 1, a: wn },
      bo: s.bombs.map((b) => ({ id: b.id, x: r1(wx(b.x)), y: r1(wy(b.y)), f: r2(b.fuse), o: b.owner, r: b.range, m: b.mega ? 1 : 0 })),
      p: s.p.map((p) => ({
        x: r1(wx(p.x)), y: r1(wy(p.y)), fx: p.fx, fy: p.fy, al: p.alive ? 1 : 0, dt: r2(p.deadT),
        mv: p.mv, w: r2(p.walk % 10), sq: p.how === 'squish' ? 1 : 0, sh: p.shoes, kk: r2(p.kk), mg: p.mega ? 1 : 0,
      })),
      hud: { p: s.p.map((p) => p.maxB), max: null, label: 'Bombe' },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  bot(s, me, g, B) { return bombeBot(s, me, g, B); },

  // 3D: "La Miniera dei Nani" — a dwarven mine lit by torches and a lava river, stone pillars, wooden crates,
  // cave-in boulders, round black bombs with team-colored bands.
  render3d: {
    assets: [
      'weapons/smokebomb', 'medieval/crate_A_small', 'medieval/crate_B_small', 'medieval/mountain_C', 'medieval/mountain_A',
      'medieval/mountain_B', 'medieval/building_mine_red', 'medieval/rock_single_A', 'medieval/rock_single_C', 'medieval/rock_single_E',
      'medieval/resource_stone', 'medieval/building_scaffolding', 'medieval/wheelbarrow', 'medieval/sack', 'medieval/tent',
      'dungeon/torch_lit', 'dungeon/crates_stacked', 'dungeon/keg', 'dungeon/barrel_large', 'dungeon/coin_stack_large',
      'dungeon/coin_stack_medium', 'dungeon/banner_patternA_red',
    ],
    build(K, r) {
      const T = K.THREE, NN = N * N, BW = N * CELL, hi = K.quality > 0;
      const n = Math.max(2, (r && r.n) || K.n || 2);
      const o = { gr: null, gone: new Float32Array(NN).fill(-9), D: new T.Object3D() };
      K.theme('grotta', { fogNear: 2.4, fogFar: 6 });
      K.sun.intensity = 1.9; K.hemi.intensity = 1.0;
      K.ground('terra', { tile: 240, color: '#8c7a66', margin: 1900 });
      // Mine floor: worn flagstones, one per cell (painted once), inside a frame of timber beams.
      K.layer({ x0: OX - 30, y0: OY - 30, x1: OX + BW + 30, y1: OY + BW + 30, h: 0.3, once: true, maxPx: 1024, draw: (d) => drawMineFloor(d) });
      K.layer({ x0: OX, y0: OY, x1: OX + BW, y1: OY + BW, h: 0.9, transparent: true, z: 1, maxPx: 1024,
        draw: (d, v) => drawDanger(d, v, K.t), key: (v) => dangerKey(v, K.t) });
      const beam = K.texMat('legno', [6, 1], { color: '#9a6a3e' });
      for (const [x, y, w, h] of [[W / 2, OY - 14, BW + 56, 26], [W / 2, OY + BW + 14, BW + 56, 26], [OX - 14, H / 2, 26, BW], [OX + BW + 14, H / 2, 26, BW]]) {
        K.place(K.box(w, h, 16, beam), x, y, 8);
      }
      // Rails from the mine entrance down to the arena (painted on the dirt).
      K.layer({ x0: 400, y0: -330, x1: 600, y1: OY - 26, h: 0.4, once: true, transparent: true, maxPx: 512, draw: (d) => drawRails(d) });
      // Indestructible rock pillars: stone-brick blocks (one instanced draw call + caps).
      const pil = [], pilGeo = new T.BoxGeometry(CELL - 6, 60, CELL - 6).translate(0, 30, 0), capGeo = new T.BoxGeometry(CELL + 2, 9, CELL + 2).translate(0, 64, 0);
      for (let rr = 0; rr < N; rr++) for (let c = 0; c < N; c++) if (isPillar(c, rr)) pil.push([wx(c), wy(rr)]);
      const pm = new T.InstancedMesh(pilGeo, K.texMat('muro', [1, 1], { color: '#b8c0cc' }), pil.length);
      const pc = new T.InstancedMesh(capGeo, K.texMat('lastre', [1, 1], { color: '#b4ada2' }), pil.length);
      pil.forEach(([x, y], k) => { o.D.position.set(x, 0, y); o.D.rotation.set(0, 0, 0); o.D.scale.set(1, 1, 1); o.D.updateMatrix(); pm.setMatrixAt(k, o.D.matrix); pc.setMatrixAt(k, o.D.matrix); });
      for (const m of [pm, pc]) { m.castShadow = true; m.receiveShadow = true; m.instanceMatrix.needsUpdate = true; m.computeBoundingSphere(); K.root.add(m); }
      // Per-cell instanced models: two kinds of wooden crates, and cave-in boulders.
      const cells = [];
      for (let k = 0; k < NN; k++) cells.push({ x: wx(k % N), y: wy(Math.floor(k / N)), rot: ((k * 7) % 4) * (Math.PI / 2) + ((k * 13) % 5 - 2) * 0.06 });
      o.crA = dynModel(K, 'medieval/crate_A_small', cells, { size: CELL - 16 });
      o.crB = dynModel(K, 'medieval/crate_B_small', cells, { size: CELL - 16 });
      o.rock = dynModel(K, 'medieval/mountain_C', cells.map((c, k) => ({ ...c, rot: k * 2.39 })), { size: CELL * 1.04 });
      o.kind = cells.map((c, k) => ((k % N) * 3 + Math.floor(k / N) * 5) % 3 === 0 ? 1 : 0);
      // Flames (instanced fireballs), dust ring under a falling boulder.
      const inst = (geo, mat) => {
        const m = new T.InstancedMesh(geo, mat, NN);
        m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
        K.root.add(m);
        return m;
      };
      o.fl = inst(new T.SphereGeometry(1, 12, 9), K.glow('#ff6a1e', { opacity: 0.9 }));
      o.core = inst(new T.SphereGeometry(1, 10, 8), K.glow('#ffd23f'));
      o.shadowM = inst(new T.CircleGeometry(1, 20).rotateX(-Math.PI / 2), K.glow('#000000', { opacity: 0.35 }));
      // Power-ups: gold coin pedestal + emoji (texture swapped per kind).
      o.puTex = {};
      for (const [ch, em] of [['b', '🧨'], ['f', '🔥'], ['s', '👢'], ['m', '💣']]) { const sp = K.emoji(em, 1); sp.visible = false; o.puTex[ch] = sp.material.map; }
      o.pu = [];
      const goldM = K.mat('#ffcf4d', { rough: 0.25, metal: 0.6, emissive: '#b07a10', ei: 0.35 });
      for (let k = 0; k < 24; k++) {
        const tile = K.cyl(CELL * 0.34, 8, goldM, { seg: 20 });
        const sp = K.emoji('🧨', 52);
        o.pu.push({ tile, sp });
      }
      // Bombs: round black bomb model + team band + sparking fuse + red warning glow.
      o.bo = [];
      const spark = K.glow('#fff36b', { add: true });
      for (let k = 0; k < 4 * MAX_BOMBS; k++) {
        const g = K.group();
        K.model('weapons/smokebomb', { size: 58, parent: g });
        const band = K.torus(30, 4.5, K.glow('#ffffff', { unique: true }), { parent: g, cast: false });
        band.position.y = 22;
        const sp = K.ball(1, spark, { parent: g, cast: false });
        sp.position.set(5, 72, 0);
        const warn = K.ball(1, K.glow('#ff3020', { opacity: 0.35, add: true, unique: true }), { parent: g, cast: false });
        warn.position.y = 26;
        o.bo.push({ g, band, spark: sp, warn, own: -1 });
      }
      // Players.
      o.pl = Array.from({ length: n }, (_, i) => ({
        av: K.avatar(i),
        boot: K.emoji('👢', 26), mega: K.emoji('💣', 28),
        smoke: [0, 1, 2].map(() => K.ball(1, K.mat('#6d6d78', { opacity: 0.55 }), { cast: false })),
      }));
      buildMine(K, hi);
      return o;
    },
    update(K, o, v) {
      const D = o.D, NN = N * N, t = K.t;
      const setI = (m, k, x, y, h, sx, sy, sz) => {
        D.position.set(x, h, y); D.rotation.set(0, 0, 0); D.scale.set(sx, sy, sz); D.updateMatrix(); m.setMatrixAt(k, D.matrix);
      };
      const hide = (m, k) => setI(m, k, 0, -500, 0, 1e-4, 1e-4, 1e-4);
      // Crates that just broke: remember when (short pop animation).
      if (o.gr !== null && o.gr !== v.gr) for (let k = 0; k < NN; k++) if (o.gr[k] === 'c' && v.gr[k] !== 'c' && v.gr[k] !== 'X') o.gone[k] = t;
      o.gr = v.gr;
      const warn = new Map();
      for (let k = 0; k < v.wn.a.length; k += 2) warn.set(v.wn.a[k], v.wn.a[k + 1]);
      for (let k = 0; k < NN; k++) {
        const ch = v.gr[k], x = wx(k % N), y = wy(Math.floor(k / N));
        const crate = o.kind[k] ? o.crB : o.crA, other = o.kind[k] ? o.crA : o.crB;
        other.set(k, 0);
        if (ch === 'c') crate.set(k, 1);
        else if (t - o.gone[k] < 0.3 && t >= o.gone[k]) {
          const q = (t - o.gone[k]) / 0.3;
          crate.set(k, Math.max(0.01, 1 - q) * (1 + q * 0.4), q * 70, q * 3);
        } else crate.set(k, 0);
        // Boulder: already down, or falling from the cave ceiling during its warning (with a growing shadow).
        let ph = -1;
        if (ch === 'X') ph = 0;
        else if (warn.has(k)) { const p = warn.get(k); ph = 230 * (1 - p) * (1 - p); }
        o.rock.set(k, ph >= 0 ? 1 : 0, Math.max(0, ph));
        if (ph > 0) { const s = CELL * (0.2 + 0.3 * (1 - ph / 230)); setI(o.shadowM, k, x, y, 1.2, s, 1, s); } else hide(o.shadowM, k);
        hide(o.fl, k); hide(o.core, k);
      }
      o.crA.flush(); o.crB.flush(); o.rock.flush();
      // Flames: puffy fireballs on the burning cells.
      const fl = v.fl.a;
      for (let j = 0; j < fl.length; j += 2) {
        const k = fl[j], q = fl[j + 1], x = wx(k % N), y = wy(Math.floor(k / N));
        const s = CELL * (0.36 + 0.2 * q) * (1 + 0.08 * Math.sin(t * 30 + k));
        setI(o.fl, k, x, y, 26 + (1 - q) * 30, s, s * 0.9, s);
        setI(o.core, k, x, y, 26 + (1 - q) * 30 + s * 0.5, s * 0.6, s * 0.6, s * 0.6);
      }
      for (const m of [o.fl, o.core, o.shadowM]) m.instanceMatrix.needsUpdate = true;
      // Power-ups.
      let n = 0;
      for (let k = 0; k < NN && n < o.pu.length; k++) {
        const ch = v.gr[k];
        if (!(ch in o.puTex)) continue;
        const P = o.pu[n++], x = wx(k % N), y = wy(Math.floor(k / N)), bob = Math.sin(t * 5 + k) * 5;
        P.tile.visible = P.sp.visible = true;
        K.place(P.tile, x, y, 2);
        if (P.sp.material.map !== o.puTex[ch]) { P.sp.material.map = o.puTex[ch]; P.sp.material.needsUpdate = true; }
        K.place(P.sp, x, y, 46 + bob);
      }
      for (; n < o.pu.length; n++) o.pu[n].tile.visible = o.pu[n].sp.visible = false;
      // Bombs.
      o.bo.forEach((B, k) => {
        const b = v.bo[k];
        B.g.visible = !!b;
        if (!b) return;
        const urgent = b.f < 0.8, blink = Math.sin(t * (urgent ? 40 : 14)) > 0;
        const pulse = 1 + (urgent ? 0.12 : 0.05) * Math.sin(t * (urgent ? 30 : 10));
        K.place(B.g, b.x, b.y, 0);
        const bs = b.m ? 1.45 : 1.05;
        B.g.scale.set(pulse * bs, bs * (2 - pulse), pulse * bs);
        B.g.rotation.y = b.id * 1.3;
        if (B.own !== b.o) { B.own = b.o; B.band.material.color.set(K.col(b.o, 'light')); }
        B.spark.scale.setScalar(blink ? 12 : 7);
        B.warn.visible = urgent || !!b.m;
        B.warn.material.color.set(b.m && !urgent ? '#ffb300' : '#ff3020');
        B.warn.scale.setScalar((urgent ? (blink ? 40 : 30) : 36) + Math.sin(t * 8) * 3);
      });
      // Players.
      const R = CELL * 0.4;
      v.p.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const look = Math.atan2(p.fy, p.fx);
        if (!p.al) {
          // Knocked out: lies down, then stays as a faded ghost on the spot.
          const ghost = clamp((p.dt - 1.4) / 0.6, 0, 1);
          if (p.sq) P.av.set(p.x, p.y, { r: R, mood: 'dead', squash: 0.3, look, alpha: 1 - ghost * 0.6 });
          else P.av.set(p.x, p.y, { r: R, mood: 'dead', look, alpha: 1 - ghost * 0.6 });
          P.smoke.forEach((m, j) => {
            m.visible = !p.sq && p.dt < 2.5;
            const ph = (p.dt * 0.9 + j / 3) % 1;
            K.place(m, p.x - 10 + j * 10, p.y, R * 1.2 + ph * 90);
            m.scale.setScalar(8 + ph * 14);
          });
          P.boot.visible = P.mega.visible = false;
          return;
        }
        for (const m of P.smoke) m.visible = false;
        let near = false;
        for (const b of v.bo) if (Math.abs(b.x - p.x) < CELL * 1.6 && Math.abs(b.y - p.y) < CELL * 1.6 && b.f < 1) near = true;
        const kick = p.kk > 0 ? Math.sin((p.kk / 0.25) * Math.PI) : 0;
        const won = !v.p.some((q, j) => j !== i && q.al);
        P.av.set(p.x + p.fx * kick * 6, p.y + p.fy * kick * 6, {
          r: R, look, walk: p.mv ? 0.5 + 0.12 * p.sh : 0, mood: won ? 'happy' : near && !p.mv ? 'scared' : 'ok',
          anim: kick > 0 ? 'Unarmed_Melee_Attack_Kick' : undefined, animKey: kick > 0 ? 1 : undefined, animSpeed: kick > 0 ? 1.8 : undefined,
        });
        P.boot.visible = !!p.sh; P.mega.visible = !!p.mg;
        K.place(P.boot, p.x + R * 0.9, p.y + R * 0.6, 14);
        K.place(P.mega, p.x - R * 0.9, p.y + R * 0.6, 22 + Math.sin(t * 6) * 4);
      });
    },
  },
  render(d, v, r) {
    const { ctx } = d;
    // Dwarven mine: dark rock all around, warm stone floor inside a timber frame.
    const cave = ctx.createRadialGradient(500, 500, 300, 500, 500, 900);
    cave.addColorStop(0, '#4a3828'); cave.addColorStop(1, '#140c08');
    ctx.fillStyle = cave;
    ctx.fillRect(-300, -300, W + 600, H + 600);
    for (let k = 0; k < 14; k++) {
      const a = k * 2.39996;
      const x = 500 + Math.cos(a) * (560 + (k % 3) * 60), y = 500 + Math.sin(a) * (560 + (k % 3) * 60);
      d.star(x, y, 5 + 3 * Math.sin(d.t * 3 + k), k % 2 ? '#ffb347' : '#6ff0ff', 4);
    }
    d.rrect(OX - 14, OY - 6, N * CELL + 28, N * CELL + 28, 18, 'rgba(0,0,0,0.45)');
    d.rrect(OX - 14, OY - 14, N * CELL + 28, N * CELL + 28, 18, '#5a3b22', '#9a6a3e', 5);
    for (let rr = 0; rr < N; rr++) {
      for (let c = 0; c < N; c++) {
        d.rect(OX + c * CELL, OY + rr * CELL, CELL, CELL, (c + rr) % 2 ? '#8a7864' : '#7d6c59');
      }
    }
    const t = d.t;
    // Falling-block warnings: growing shadow + blinking frame.
    const wn = v.wn.a;
    for (let k = 0; k < wn.length; k += 2) {
      const i = wn[k], c = i % N, rr = Math.floor(i / N);
      const prog = wn[k + 1];
      if (v.gr[i] === 'X') continue;
      const x = OX + c * CELL, y = OY + rr * CELL;
      const sz = CELL * (0.35 + 0.55 * prog);
      d.rrect(x + (CELL - sz) / 2, y + (CELL - sz) / 2, sz, sz, 10, 'rgba(0,0,0,0.45)');
      if (Math.sin(t * (10 + prog * 20)) > -0.2) d.rrect(x + 4, y + 4, CELL - 8, CELL - 8, 10, null, '#ff4d4d', 4);
    }
    // Danger preview: the cross each bomb will burn, stronger as the fuse runs out.
    for (const b of v.bo) {
      const a = clamp(1.15 - b.f / 1.6, 0.08, 0.6);
      if (b.f < 0.5 && Math.sin(t * 40) < 0) continue;
      const c0 = Math.round((b.x - OX) / CELL - 0.5), r0 = Math.round((b.y - OY) / CELL - 0.5);
      const mark = (c, rr) => d.rrect(OX + c * CELL + 6, OY + rr * CELL + 6, CELL - 12, CELL - 12, 12, `rgba(255,60,60,${a * 0.55})`, `rgba(255,90,90,${a})`, 3);
      mark(c0, r0);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let k = 1; k <= b.r; k++) {
          const c = c0 + dx * k, rr = r0 + dy * k;
          if (c < 0 || rr < 0 || c >= N || rr >= N) break;
          const ch = v.gr[rr * N + c];
          if (ch === '#' || ch === 'X') break;
          mark(c, rr);
          if (ch === 'c') break;
        }
      }
    }
    // Tiles.
    for (let i = 0; i < N * N; i++) {
      const ch = v.gr[i];
      if (ch === '.') continue;
      const c = i % N, rr = Math.floor(i / N);
      const x = OX + c * CELL, y = OY + rr * CELL, cx = x + CELL / 2, cy = y + CELL / 2;
      if (ch === '#') {
        // Stone pillar.
        d.rrect(x + 3, y + 7, CELL - 6, CELL - 6, 8, '#2a2018');
        d.rrect(x + 3, y + 2, CELL - 6, CELL - 8, 8, '#a89a86', '#4a3c30', 3);
        d.line(x + 6, cy, x + CELL - 6, cy, 'rgba(60,45,30,0.5)', 2);
        d.line(cx, y + 4, cx, cy, 'rgba(60,45,30,0.5)', 2);
      } else if (ch === 'c') {
        // Wooden crate.
        d.rrect(x + 6, y + 6, CELL - 12, CELL - 12, 6, '#b07a42', '#5a3b22', 3);
        d.line(x + 10, y + 10, x + CELL - 10, y + CELL - 10, '#7a5230', 5);
        d.rect(x + 8, cy - 4, CELL - 16, 8, '#8a5e34');
      } else if (ch === 'X') {
        // Cave-in boulder.
        d.circle(cx, cy, CELL * 0.5, '#6d6458', '#3a332b', 3);
        d.circle(cx - 12, cy - 12, CELL * 0.18, 'rgba(255,255,255,0.15)');
        d.line(cx - 10, cy + 6, cx + 14, cy - 2, '#3a332b', 3);
      } else {
        // Power-up: bright bobbing tile with emoji.
        const bob = Math.sin(t * 5 + i) * 4;
        d.rrect(x + 10, y + 10 + bob, CELL - 20, CELL - 20, 14, '#fff7d1', '#ffcf4d', 4);
        d.emoji(ch === 'b' ? '🧨' : ch === 'f' ? '🔥' : ch === 'm' ? '💣' : '👢', cx, cy + bob, 46);
      }
    }
    // Flames (fireworks colors).
    const fl = v.fl.a;
    for (let k = 0; k < fl.length; k += 2) {
      const i = fl[k], q = fl[k + 1];
      const c = i % N, rr = Math.floor(i / N);
      const cx = wx(c), cy = wy(rr);
      const s = CELL * (0.35 + 0.2 * q);
      d.circle(cx, cy, s * 1.05, 'rgba(255,90,40,0.75)');
      d.circle(cx, cy, s * 0.75, '#ffb300');
      d.circle(cx, cy, s * 0.4, '#fff8c0');
      d.star(cx + Math.sin(i * 7 + t * 9) * 16, cy + Math.cos(i * 5 + t * 8) * 16, 9, ['#ff5ad8', '#5af0ff', '#b6ff5a'][i % 3], 4);
    }
    // Bombs: round black bombs with a sparking fuse that blinks faster near the end.
    for (const b of v.bo) {
      const urgent = b.f < 0.8;
      const blink = Math.sin(t * (urgent ? 40 : 14)) > 0;
      const pulse = 1 + (urgent ? 0.12 : 0.05) * Math.sin(t * (urgent ? 30 : 10));
      const R = (b.m ? 33 : 27) * pulse;
      d.shadow(b.x, b.y + 22, 26, 9, 0.35);
      if (b.m) d.circle(b.x, b.y, R * 1.35, 'rgba(255,210,63,0.3)');
      d.circle(b.x, b.y, R, blink && urgent ? '#ff5040' : b.m ? '#ffb300' : '#2a2a30', '#0d0d10', 3);
      d.rrect(b.x - R * 0.55, b.y - R + 4, R * 0.35, R * 1.5, 6, 'rgba(255,255,255,0.3)');
      d.rect(b.x - R * 0.7, b.y - 6, R * 1.4, 12, d.col(b.o, 'light'));
      d.ring(b.x, b.y, R + 4, d.col(b.o, 'light'), 3);
      d.line(b.x, b.y - R, b.x + 8, b.y - R - 14, '#3b2a1a', 4);
      d.star(b.x + 8, b.y - R - 16, blink ? 11 : 7, blink ? '#fff36b' : '#ff8a00', 6);
    }
    // Players.
    v.p.forEach((p, i) => {
      const R = CELL * 0.42;
      if (!p.al) {
        const k = Math.min(1, p.dt / 0.4);
        if (p.sq) {
          d.avatar(p.x, p.y + 10, R, i, { mood: 'dead', squash: -0.4 * k });
        } else {
          d.circle(p.x, p.y + 6, R * 1.3, 'rgba(20,20,20,0.5)');
          d.avatar(p.x, p.y - k * 10, R, i, { mood: 'dead', squash: 0.2 * Math.sin(p.dt * 20) * (1 - k) });
          for (let j = 0; j < 3; j++) d.circle(p.x - 10 + j * 10, p.y - R - 10 - ((p.dt * 60 + j * 15) % 45), 7 - j, 'rgba(120,120,120,0.6)');
        }
        return;
      }
      const won = !v.p.some((q, j) => j !== i && q.al);
      const bob = p.mv ? Math.abs(Math.sin(p.w * Math.PI)) * 6 : 0;
      d.shadow(p.x, p.y + R * 0.8, R * 0.8, R * 0.3, 0.35);
      let near = false;
      for (const b of v.bo) if (Math.abs(b.x - p.x) < CELL * 1.6 && Math.abs(b.y - p.y) < CELL * 1.6 && b.f < 1) near = true;
      const mood = won ? 'happy' : near ? 'scared' : 'ok';
      const kick = p.kk > 0 ? Math.sin((p.kk / 0.25) * Math.PI) : 0;
      if (kick > 0) { // little foot poking out toward the kick direction
        const fx = p.x + p.fx * (R + 10 * kick), fy = p.y + p.fy * (R + 10 * kick);
        d.circle(fx, fy, 11, d.col(i, 'dark'), '#fff', 2);
      }
      d.avatar(p.x + p.fx * kick * 6, p.y - bob + p.fy * kick * 6, R, i, { look: Math.atan2(p.fy, p.fx), mood: kick > 0 ? 'angry' : mood, squash: kick > 0 ? 0.15 : p.mv ? 0.06 * Math.sin(p.w * Math.PI * 2) : 0 });
      if (p.sh) d.emoji('👢', p.x + R * 0.8, p.y + R * 0.7, 22);
      if (p.mg) d.emoji('💣', p.x - R * 0.8, p.y + R * 0.7, 24);
    });
  },
};

export default game;

/// ---------- 3D helpers ----------
// Instanced copies of a model at fixed slots, shown/hidden/lifted per frame (crates, boulders: a couple of draw calls).
// set(k, scale (0 = hidden), lift, spin) then flush() once per frame. Without the model (tests) it does nothing.
function dynModel(K, name, slots, opt) {
  const T = K.THREE;
  const g = K.scatter(name, slots, opt);
  const ims = [];
  g.traverse((m) => { if (m.isInstancedMesh) { m.frustumCulled = false; ims.push(m); } });
  if (!ims.length) g.visible = false; // placeholder boxes: never show a field of brown cubes
  const base = ims.map((m) => slots.map((_, k) => { const M = new T.Matrix4(); m.getMatrixAt(k, M); return M; }));
  const zero = new T.Matrix4().makeScale(0, 0, 0), pre = new T.Matrix4(), back = new T.Matrix4(), out = new T.Matrix4();
  const q = new T.Quaternion(), up = new T.Vector3(0, 1, 0), pos = new T.Vector3(), sc = new T.Vector3();
  const state = new Float32Array(slots.length * 3).fill(-1);
  return {
    set(k, s = 1, dh = 0, spin = 0) {
      if (!ims.length) return;
      if (state[k * 3] === s && state[k * 3 + 1] === dh && state[k * 3 + 2] === spin) return;
      state[k * 3] = s; state[k * 3 + 1] = dh; state[k * 3 + 2] = spin;
      if (s <= 0) { for (const m of ims) m.setMatrixAt(k, zero); return; }
      if (s === 1 && !dh && !spin) { ims.forEach((m, j) => m.setMatrixAt(k, base[j][k])); return; }
      const sl = slots[k];
      K.p(sl.x, sl.y, 0, pos);
      back.makeTranslation(-pos.x, -pos.y, -pos.z);
      pos.y += dh;
      pre.compose(pos, q.setFromAxisAngle(up, spin), sc.set(s, s, s)).multiply(back);
      ims.forEach((m, j) => m.setMatrixAt(k, out.multiplyMatrices(pre, base[j][k])));
    },
    flush() { for (const m of ims) m.instanceMatrix.needsUpdate = true; },
  };
}

// Deterministic pseudo-random in [0,1) for scenery layout.
function hash(k) { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

// Glowing crystal clusters as one instanced draw call per color: list = [[x, y, colorIndex], …].
function crystals(K, list, colors) {
  const T = K.THREE, D = new T.Object3D(), geo = new T.ConeGeometry(1, 1, 5).translate(0, 0.5, 0);
  colors.forEach((mat, c) => {
    const mine = list.filter((q) => q[2] === c);
    const m = new T.InstancedMesh(geo, mat, mine.length * 5);
    mine.forEach(([x, y], k) => {
      for (let j = 0; j < 5; j++) {
        const a = j * 1.26 + k + c, rr = j ? 15 : 0, w = 11 + hash(k * 4 + j + c) * 8, h = (j ? 40 : 90) + hash(k * 7 + j + c) * 40;
        K.p(x + Math.cos(a) * rr, y + Math.sin(a) * rr, -4, D.position);
        D.rotation.set(j ? Math.sin(a) * 0.45 : 0, 0, j ? -Math.cos(a) * 0.45 : 0);
        D.scale.set(w, h, w);
        D.updateMatrix(); m.setMatrixAt(k * 5 + j, D.matrix);
      }
    });
    m.castShadow = true; m.computeBoundingSphere();
    K.root.add(m);
  });
}
// Many small glowing balls (torch / candle flames) in one draw call.
function flameBalls(K, pts, r, mat) {
  const T = K.THREE, D = new T.Object3D();
  const m = new T.InstancedMesh(new T.SphereGeometry(r, 10, 8), mat, pts.length);
  pts.forEach(([x, y, h], k) => { K.p(x, y, h, D.position); D.updateMatrix(); m.setMatrixAt(k, D.matrix); });
  m.computeBoundingSphere();
  K.root.add(m);
  return m;
}

function drawMineFloor(d) {
  const BW = N * CELL;
  d.rect(OX - 30, OY - 30, BW + 60, BW + 60, '#3a2e24');
  for (let rr = 0; rr < N; rr++) for (let c = 0; c < N; c++) {
    const x = OX + c * CELL, y = OY + rr * CELL, k = rr * N + c;
    const base = (c + rr) % 2 ? '#8e877c' : '#857e73';
    d.rect(x, y, CELL, CELL, '#4a3c30');
    d.rrect(x + 3, y + 3, CELL - 6, CELL - 6, 8, base);
    d.rrect(x + 7, y + 6, CELL - 14, 8, 4, 'rgba(255,240,210,0.12)');
    // Cracks and pebbles (deterministic).
    if (hash(k) < 0.45) {
      const a = hash(k + 7) * 6.28, cx = x + CELL * (0.3 + 0.4 * hash(k + 3)), cy = y + CELL * (0.3 + 0.4 * hash(k + 5));
      d.line(cx, cy, cx + Math.cos(a) * 22, cy + Math.sin(a) * 22, 'rgba(40,28,18,0.45)', 2);
      d.line(cx + Math.cos(a) * 22, cy + Math.sin(a) * 22, cx + Math.cos(a + 0.7) * 34, cy + Math.sin(a + 0.7) * 34, 'rgba(40,28,18,0.35)', 2);
    }
    for (let j = 0; j < 3; j++) if (hash(k * 3 + j) < 0.5) d.circle(x + 10 + hash(k * 5 + j) * (CELL - 20), y + 10 + hash(k * 9 + j) * (CELL - 20), 2 + hash(k + j) * 3, 'rgba(50,38,26,0.35)');
  }
}

function drawRails(d) {
  for (let y = -330; y < OY - 30; y += 26) d.rect(430, y, 140, 12, '#5a3b22', 'rgba(0,0,0,0.3)', 1);
  for (const x of [455, 545]) { d.rect(x - 4, -330, 8, OY - 30 + 330, '#8d939c'); d.rect(x - 1, -330, 2, OY - 30 + 330, '#c8ccd2'); }
}

// Scenery around the arena: mine entrance and rocky cave walls behind, lava river on the left, the dwarves'
// storehouse on the right, torches, glowing crystals, embers.
function buildMine(K, hi) {
  const BW = N * CELL;
  // Back: mine entrance + mountains as cave walls.
  K.place(K.model('medieval/building_mine_red', { size: 380 }), 500, -470);
  for (const x of [380, 620]) K.place(K.model('dungeon/banner_patternA_red', { height: 150 }), x, -270);
  K.scatter('medieval/mountain_B', [
    { x: 140, y: -470, rot: 0.4 }, { x: 870, y: -470, rot: 2.1 }, { x: -230, y: -260, rot: 1.2, s: 1.1 }, { x: 1230, y: -260, rot: 3.3, s: 1.1 },
    { x: -520, y: -720, rot: 0.2, s: 1.3 }, { x: 1520, y: -720, rot: 2.6, s: 1.3 }, { x: 480, y: -1000, rot: 1.7, s: 1.6 },
  ], { size: 560 });
  K.scatter('medieval/mountain_A', [
    { x: -760, y: 120, rot: 0.9, s: 1.2 }, { x: -820, y: 650, rot: 2.2 }, { x: -760, y: 1200, rot: 4.1 },
    { x: 1700, y: 300, rot: 1.4, s: 1.2 }, { x: 1680, y: 900, rot: 3.0 }, { x: 1550, y: 1400, rot: 5.0 },
  ], { size: 560 });
  // Left: lava river between rocky banks (warm light on the arena).
  if (!K.mockDraw) K.water(-700, -900, -360, 1800, { kind: 'lava', h: 1, tile: 260, flow: [0.0, 0.05] }); // (K.water crashes headless)
  const bank = [];
  for (let k = 0; k < 22; k++) {
    const y = -800 + k * 120;
    bank.push({ x: -340 + hash(k) * 30, y, rot: k * 1.7, s: 0.7 + hash(k + 9) * 0.6 });
    bank.push({ x: -720 - hash(k + 4) * 30, y: y + 60, rot: k * 2.3, s: 0.7 + hash(k + 2) * 0.6 });
  }
  K.scatter('medieval/rock_single_E', bank, { size: 90 });
  K.scatter('medieval/rock_single_C', [
    { x: -120, y: 80, rot: 1 }, { x: -170, y: 420, rot: 2, s: 1.3 }, { x: -110, y: 760, rot: 3 }, { x: -200, y: 980, rot: 4, s: 1.4 },
    { x: 1110, y: 980, rot: 5 }, { x: 1080, y: 1120, rot: 1.4, s: 0.8 }, { x: 160, y: 1120, rot: 2.2, s: 0.8 }, { x: 820, y: 1130, rot: 3.7, s: 0.9 },
    { x: 440, y: 1160, rot: 0.6, s: 0.7 }, { x: -60, y: 1140, rot: 2.6 },
  ], { size: 80 });
  // Right: the dwarves' storehouse.
  K.place(K.model('dungeon/crates_stacked', { size: 160 }), 1170, 90);
  K.place(K.model('medieval/building_scaffolding', { size: 260 }), 1330, 470);
  K.face(K.place(K.model('medieval/tent', { size: 220 }), 1330, 120), Math.PI);
  K.scatter('dungeon/keg', [{ x: 1100, y: 290, rot: 0.3 }, { x: 1160, y: 340, rot: 1.2 }, { x: 1095, y: 380, rot: 2 }, { x: 1110, y: 1040, rot: 0.8 }], { size: 64 });
  K.scatter('dungeon/barrel_large', [{ x: 1230, y: 300, rot: 0.5 }, { x: -140, y: 260, rot: 1.5 }, { x: -110, y: 590, rot: 2.5, s: 0.9 }], { size: 74 });
  K.place(K.model('dungeon/coin_stack_large', { size: 110 }), 1150, 590);
  K.scatter('dungeon/coin_stack_medium', [{ x: 1240, y: 650, rot: 1 }, { x: 1110, y: 680, rot: 2 }, { x: -130, y: -60, rot: 3 }], { size: 64 });
  K.face(K.place(K.model('medieval/wheelbarrow', { size: 120 }), 1150, 800), 0.6);
  K.scatter('medieval/resource_stone', [{ x: 1260, y: 860, rot: 0.4 }, { x: -150, y: 880, rot: 1.9 }, { x: 1270, y: 210, rot: 2.8 }], { size: 120 });
  K.scatter('medieval/sack', [{ x: 1220, y: 760, rot: 0.2 }, { x: 1250, y: 720, rot: 1.6 }, { x: 1090, y: 470, rot: 2.4 }], { size: 70 });
  // Torches on posts around the frame + a few real lights (fewer on phones).
  const tor = [];
  for (const y of [OY + 40, H / 2, OY + BW - 40]) { tor.push({ x: OX - 46, y }); tor.push({ x: OX + BW + 46, y }); }
  tor.push({ x: 300, y: OY - 46 }, { x: 700, y: OY - 46 });
  K.scatter('dungeon/torch_lit', tor, { height: 76 });
  const flames = K.glow('#ffb347', { add: true, opacity: 0.85 });
  flameBalls(K, tor.map((t) => [t.x, t.y, 74]), 9, flames);
  K.light(OX - 46, H / 2, 110, '#ff9a40', 1.6, { flicker: 0.35, dist: 620 });
  K.light(OX + BW + 46, H / 2, 110, '#ffb060', 1.6, { flicker: 0.35, dist: 620 });
  if (hi) {
    K.light(-420, 300, 90, '#ff6a20', 2.4, { flicker: 0.25, dist: 760 });
    K.light(500, -120, 140, '#ffc070', 1.4, { flicker: 0.3, dist: 600 });
  }
  // Glowing dwarven crystals.
  const cry = [K.mat('#6ff0ff', { emissive: '#22c8ff', ei: 0.9, flat: true, rough: 0.2 }), K.mat('#d58cff', { emissive: '#9a3cff', ei: 0.9, flat: true, rough: 0.2 })];
  crystals(K, [[-150, -110, 0], [1150, -60, 1], [-190, 1090, 1], [1190, 1060, 0], [-160, 470, 1], [60, -170, 0], [960, -190, 1]], cry);
  if (hi) K.light(1150, -60, 90, '#5fe0ff', 1.4, { dist: 520 });
  K.ambient('braci', { x0: -720, x1: -340, y0: -700, y1: 1500, n: hi ? 70 : 35, h: 420 });
  K.ambient('polvere', { n: hi ? 70 : 30, h: 260 });
}

// Cross each bomb will burn (stronger as the fuse runs out) + blinking frames where a boulder will fall.
function dangerCells(v, fn) {
  for (const b of v.bo) {
    const c0 = Math.round((b.x - OX) / CELL - 0.5), r0 = Math.round((b.y - OY) / CELL - 0.5);
    fn(c0, r0, b);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let k = 1; k <= b.r; k++) {
        const c = c0 + dx * k, rr = r0 + dy * k;
        if (!inside(c, rr)) break;
        const ch = v.gr[rr * N + c];
        if (ch === '#' || ch === 'X') break;
        fn(c, rr, b);
        if (ch === 'c') break;
      }
    }
  }
}
function dangerKey(v, t) {
  if (!v.bo.length && !v.wn.a.length) return 'n';
  let k = v.gr;
  for (const b of v.bo) k += `|${Math.round((b.x - OX) / CELL - 0.5)},${Math.round((b.y - OY) / CELL - 0.5)},${b.r},${Math.round(clamp(1.15 - b.f / 1.6, 0.08, 0.6) * 20)},${b.f < 0.5 && Math.sin(t * 40) < 0 ? 0 : 1}`;
  for (let j = 0; j < v.wn.a.length; j += 2) k += `|w${v.wn.a[j]},${Math.round(v.wn.a[j + 1] * 10)},${Math.sin(t * (10 + v.wn.a[j + 1] * 20)) > -0.2 ? 1 : 0}`;
  return k;
}
function drawDanger(d, v, t) {
  for (const b of v.bo) {
    const a = clamp(1.15 - b.f / 1.6, 0.08, 0.6);
    if (b.f < 0.5 && Math.sin(t * 40) < 0) continue;
    dangerCells({ bo: [b], gr: v.gr }, (c, rr) => d.rrect(OX + c * CELL + 6, OY + rr * CELL + 6, CELL - 12, CELL - 12, 12, `rgba(255,60,60,${a * 0.6})`, `rgba(255,90,90,${a + 0.2})`, 4));
  }
  const wn = v.wn.a;
  for (let k = 0; k < wn.length; k += 2) {
    const i = wn[k], prog = wn[k + 1];
    if (v.gr[i] === 'X') continue;
    const x = OX + (i % N) * CELL, y = OY + Math.floor(i / N) * CELL;
    const sz = CELL * (0.35 + 0.55 * prog);
    d.rrect(x + (CELL - sz) / 2, y + (CELL - sz) / 2, sz, sz, 10, 'rgba(0,0,0,0.5)');
    if (Math.sin(t * (10 + prog * 20)) > -0.2) d.rrect(x + 4, y + 4, CELL - 8, CELL - 8, 10, null, '#ff4d4d', 5);
  }
}

// ---------------------------------------------------------------- Bot ----------------------------------------------------------------
// Grid planner: a danger map (when each cell will burn, with chain reactions; falling blocks), a timed BFS that never walks
// into a flame, then: flee if threatened, otherwise drop a bomb when it hits crates/rivals AND an escape exists, otherwise
// walk to the most valuable cell (power-ups, crates to blast, rivals to trap, late-falling cells once the mine collapses).
const BOT_DELAY = [0.36, 0.22, 0.11];
const NN = N * N;
const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Calls fn(k) for every cell a bomb at (c0, r0) with this range would burn.
function blastEach(s, c0, r0, range, fn) {
  fn(idx(c0, r0));
  for (const [dx, dy] of D4) {
    for (let k = 1; k <= range; k++) {
      const c = c0 + dx * k, r = r0 + dy * k;
      if (!inside(c, r)) break;
      const t = s.grid[idx(c, r)];
      if (t === PILLAR || t === BLOCK) break;
      fn(idx(c, r));
      if (t === CRATE || bombAt(s, c, r)) break;
    }
  }
}

// Does a blast from (c0, r0) reach (c, r)? (straight line, nothing solid in between)
function blastReaches(s, c0, r0, range, c, r) {
  if (c0 !== c && r0 !== r) return false;
  const d = Math.abs(c - c0) + Math.abs(r - r0);
  if (d > range) return false;
  const dx = Math.sign(c - c0), dy = Math.sign(r - r0);
  for (let k = 1; k < d; k++) if (s.grid[idx(c0 + dx * k, r0 + dy * k)] !== EMPTY) return false;
  return true;
}

// Where a sliding bomb will stop (approximation of slideBombs).
function bombRest(s, b) {
  let c = Math.round(b.x), r = Math.round(b.y);
  if (!b.vx && !b.vy) return [c, r];
  const dx = Math.sign(b.vx), dy = Math.sign(b.vy);
  for (let k = 0; k < N; k++) {
    const nc = c + dx, nr = r + dy;
    if (!inside(nc, nr) || s.grid[idx(nc, nr)] !== EMPTY || bombAt(s, nc, nr)) break;
    c = nc; r = nr;
  }
  return [c, r];
}

// D[k] = seconds until cell k explodes (Infinity = never). extra = hypothetical bomb {c, r, range, fuse}.
function botDanger(s, g, D, extra) {
  D.fill(Infinity);
  const list = [];
  for (const b of s.bombs) {
    const [c, r] = bombRest(s, b);
    list.push({ c, r, range: g.variant === 'infinito' ? N : b.range, t: Math.max(0, b.fuse) });
  }
  if (extra) list.push({ c: extra.c, r: extra.r, range: g.variant === 'infinito' ? N : extra.range, t: extra.fuse });
  for (let it = 0; it < list.length; it++) {
    let changed = false;
    for (const a of list) for (const b of list) {
      if (b.t > a.t && blastReaches(s, a.c, a.r, a.range, b.c, b.r)) { b.t = a.t; changed = true; }
    }
    if (!changed) break;
  }
  for (const b of list) blastEach(s, b.c, b.r, b.range, (k) => { if (b.t < D[k]) D[k] = b.t; });
}

// Timed BFS from (c0, r0): fills M.dist/M.prev, returns the number of reached cells (in M.q).
function botBfs(s, pi, c0, r0, D, F, ct, delay, M, tight) {
  const { dist, prev, q } = M;
  dist.fill(-1);
  const start = idx(c0, r0);
  dist[start] = 0; prev[start] = -1; q[0] = start;
  let head = 0, tail = 1;
  while (head < tail) {
    const k = q[head++], d = dist[k] + 1;
    const c = k % N, r = (k / N) | 0;
    const ta = tight ? (d - 0.5) * ct : Math.max(0, (d - 1) * ct - 0.05), tb = (d + 0.5) * ct + (tight ? 0.03 : delay + 0.12);
    for (const [dx, dy] of D4) {
      const nc = c + dx, nr = r + dy;
      if (!inside(nc, nr)) continue;
      const nk = idx(nc, nr);
      if (dist[nk] >= 0 || solidFor(s, nc, nr, pi)) continue;
      if (s.fl[nk] > ta || (D[nk] < tb && D[nk] + FLAME_T > ta) || F[nk] < tb + 0.2) continue;
      dist[nk] = d; prev[nk] = k; q[tail++] = nk;
    }
  }
  return tail;
}

const safeStand = (s, D, F, k, ta) => D[k] === Infinity && s.fl[k] <= ta && F[k] > ta + 2.2;

// Value of dropping a bomb on cell k: crates it breaks, rivals it threatens, power-ups it would burn.
function bombValue(s, g, me, k, range, D, level) {
  let v = 0;
  const c0 = k % N, r0 = (k / N) | 0;
  const rg = g.variant === 'infinito' ? N : range;
  blastEach(s, c0, r0, rg, (j) => {
    if (s.grid[j] === CRATE && D[j] === Infinity) v += s.drops[j] ? 1.6 : 1;
    else if (s.pu[j]) v -= 1.2;
  });
  for (const q of s.p) {
    if (q.i === me || !q.alive) continue;
    const qc = Math.round(q.x), qr = Math.round(q.y);
    if (!blastReaches(s, c0, r0, rg, qc, qr)) continue;
    if (level === 0) { v += 0.8; continue; }
    // Fewer exits around the rival = better trap.
    let exits = 0;
    for (const [dx, dy] of D4) if (!solidFor(s, qc + dx, qr + dy, q.i)) exits++;
    v += 2.5 + (exits <= 1 ? 3 : exits === 2 ? 1 : 0) * level;
  }
  return v;
}

function botMem(B) {
  const m = B.mem;
  if (!m.D) {
    m.D = new Float64Array(NN); m.D2 = new Float64Array(NN); m.F = new Float64Array(NN);
    m.dist = new Int16Array(NN); m.prev = new Int16Array(NN); m.q = new Int16Array(NN);
    m.M2 = { dist: new Int16Array(NN), prev: new Int16Array(NN), q: new Int16Array(NN) };
    m.goal = -1;
    m.hx = new Float64Array(32); m.hy = new Float64Array(32); m.hn = 0;
    m.val = new Float64Array(NN); m.bp = new Float64Array(NN); m.cand = new Int16Array(NN);
  }
  return m;
}

// Can player q still reach a safe cell with danger map D? (the hard bot uses it to spot sure kills)
function canEscape(s, q, D, F, M2) {
  const ct = 1 / (BASE_SPEED + SHOE_SPEED * q.shoes);
  const n = botBfs(s, q.i, Math.round(q.x), Math.round(q.y), D, F, ct, 0, M2);
  for (let j = 0; j < n; j++) { const k = M2.q[j]; if (safeStand(s, D, F, k, M2.dist[k] * ct)) return true; }
  return false;
}

const PEND = [0.34, 0.2, 0.09]; // the driver's reaction delay per level

function bombeBot(s, me, g, B) {
  const m = botMem(B);
  const out = bombeThink(s, me, g, B, m);
  m.hx[m.hn % 32] = out.x; m.hy[m.hn % 32] = out.y; m.hn++;
  return out;
}

function bombeThink(s, me, g, B, m) {
  const p = s.p[me];
  if (!p || !p.alive) return { x: 0, y: 0 };
  const L = B.level;
  const { D, F } = m;
  const delay = BOT_DELAY[L];
  const ct = 1 / (BASE_SPEED + SHOE_SPEED * p.shoes);
  // Where our own moves already on their way (the reaction delay) will carry us: plan from there.
  let px = p.x, py = p.y;
  const pend = Math.round(PEND[L] * 60), step = (BASE_SPEED + SHOE_SPEED * p.shoes) * g.dt;
  for (let j = Math.min(pend, m.hn); j >= 1; j--) {
    const h = (m.hn - j) % 32, hx = m.hx[h], hy = m.hy[h];
    if (!hx && !hy) continue;
    const ax = Math.abs(hx) >= Math.abs(hy) ? 0 : 1, sg = Math.sign(ax === 0 ? hx : hy);
    const cx = Math.round(px), cy = Math.round(py);
    if (ax === 0) { px += sg * step; if (solidFor(s, cx + sg, cy, me) && (px - cx) * sg > 0) px = cx; }
    else { py += sg * step; if (solidFor(s, cx, cy + sg, me) && (py - cy) * sg > 0) py = cy; }
  }
  const c0 = Math.round(px), r0 = Math.round(py), k0 = idx(c0, r0);
  botDanger(s, g, D, null);
  F.fill(Infinity);
  for (let j = s.fallK; j < s.falls.length; j++) F[s.falls[j].i] = Math.min(F[s.falls[j].i], s.falls[j].t - g.t);
  let n = botBfs(s, me, c0, r0, D, F, ct, delay, m);
  let arrive = (k) => m.dist[k] * ct + delay;
  const out = { x: 0, y: 0 };

  // Walk toward cell `goal` along the BFS path (axis moves; the game slides us around corners).
  const walkTo = (goal) => {
    let k = goal;
    while (k >= 0 && m.prev[k] !== k0 && m.prev[k] >= 0) k = m.prev[k];
    if (goal === k0 || k < 0) {
      const ex = c0 - px, ey = r0 - py; // center on the cell
      if (Math.abs(ex) > 0.12) out.x = Math.sign(ex); else if (Math.abs(ey) > 0.12) out.y = Math.sign(ey);
      return;
    }
    const nc = k % N, nr = (k / N) | 0;
    if (nc !== c0) out.x = Math.sign(nc - c0); else out.y = Math.sign(nr - r0);
  };
  const walk = (goal) => { walkTo(goal); if (out.x || out.y) m.moved = g.t; return out; };

  // 1) Threatened: run to the nearest safe cell.
  if (!safeStand(s, D, F, k0, 0)) {
    let best = -1, bd = Infinity;
    for (let pass = 0; pass < 2 && best < 0; pass++) {
      if (pass === 1) { n = botBfs(s, me, c0, r0, D, F, ct, 0, m, true); arrive = (k) => m.dist[k] * ct; } // no margin left
      for (let j = 0; j < n; j++) {
        const k = m.q[j];
        if (!safeStand(s, D, F, k, arrive(k))) continue;
        const cost = m.dist[k] - (F[k] === Infinity ? 0.4 : Math.min(F[k], 8) * 0.05);
        if (cost < bd) { bd = cost; best = k; }
      }
    }
    if (best < 0) { // nowhere safe: go where the fire comes last
      let bt = -Infinity;
      for (let j = 0; j < n; j++) {
        const k = m.q[j];
        const tt = Math.min(D[k], F[k]) - arrive(k) * 0.3;
        if (tt > bt) { bt = tt; best = k; }
      }
    }
    m.goal = -1;
    m.hold = 0;
    return walk(best);
  }

  // 2) Drop a bomb here if worth it and we can still get away.
  let mine = 0;
  for (const b of s.bombs) if (b.owner === me) mine++;
  const canBomb = mine < p.maxB && s.grid[k0] === EMPTY && !bombAt(s, c0, r0);
  const range = p.mega ? N : p.range;
  // Could we drop a bomb on cell k and still get away?
  const escapeFrom = (k) => {
    const c = k % N, r = (k / N) | 0;
    botDanger(s, g, m.D2, { c, r, range, fuse: g.variant === 'miccia' ? 1.05 : FUSE });
    const n2 = botBfs(s, me, c, r, m.D2, F, ct, delay + (L === 0 ? 0.05 : 0.12), m.M2);
    const far = L === 0 ? 2 : 99;
    for (let j = 0; j < n2; j++) { const q = m.M2.q[j]; if (m.M2.dist[q] <= far && safeStand(s, m.D2, F, q, m.M2.dist[q] * ct + delay)) return true; }
    return false;
  };
  // Wait for the bomb we asked for (the press is still on its way).
  if (m.hold > g.t && mine < p.maxB && !bombAt(s, Math.round(p.x), Math.round(p.y))) return out;
  // Only drop when standing still on the cell (no moves of ours still on the way).
  const still = g.t - (m.moved ?? -9) > delay + 0.03;
  if (canBomb && still && Math.round(p.x) === c0 && Math.round(p.y) === r0) {
    let v = bombValue(s, g, me, k0, range, D, L);
    // The easy bot bombs rarely and only with a short way out (it gets distracted!).
    if (L === 0 && (g.t < (m.nextBomb || 0) || v < 1.5)) v = 0;
    if (v > 0.5) {
      let esc = escapeFrom(k0);
      if (esc && L === 2) {
        // A sure kill is worth a lot; do not waste the mega bomb on a crate.
        for (const q of s.p) if (q.i !== me && q.alive && !canEscape(s, q, m.D2, F, m.M2)) v += 8;
        if (p.mega && v < 2.5) esc = false;
      }
      if (esc) { out.tapA = true; m.goal = -1; m.nextBomb = g.t + 4.5; m.hold = g.t + delay + 0.1; return out; }
    }
  }

  // 3) Pick the best place to be.
  const late = g.t > SHRINK_AT - 5;
  let best = k0, bv = -Infinity, nc = 0;
  for (let j = 0; j < n; j++) {
    const k = m.q[j];
    const ta = arrive(k);
    if (!safeStand(s, D, F, k, ta)) continue;
    let v = 0;
    const pu = s.pu[k];
    if (pu === 'b' && p.maxB < MAX_BOMBS) v += 3;
    else if (pu === 'f' && p.range < MAX_RANGE) v += 3;
    else if (pu === 's' && p.shoes < MAX_SHOES) v += 2.2;
    else if (pu === 'm' && !p.mega) v += 2.5;
    else if (pu) v += 0.8; // still counts at the timeout
    const bp = mine < p.maxB ? Math.max(0, bombValue(s, g, me, k, range, D, L)) : 0;
    v += bp;
    if (late) v += Math.min(F[k], 14) * 0.35;
    if (L > 0) {
      let fd = Infinity;
      const kc = k % N, kr = (k / N) | 0;
      for (const q of s.p) if (q.i !== me && q.alive) fd = Math.min(fd, Math.abs(q.x - kc) + Math.abs(q.y - kr));
      if (fd < Infinity) v -= fd * (L === 2 ? 0.12 : 0.06);
    }
    v -= m.dist[k] * 0.28;
    if (k === m.goal) v += 0.6; // stick to the plan
    m.val[k] = v; m.bp[k] = bp; m.cand[nc++] = k;
  }
  // Best cell; a bomb spot only counts if we could escape from it.
  for (let tries = 0; tries < 6; tries++) {
    best = k0; bv = -Infinity;
    for (let j = 0; j < nc; j++) { const k = m.cand[j]; if (m.val[k] > bv) { bv = m.val[k]; best = k; } }
    if (!nc || m.bp[best] <= 0.5 || escapeFrom(best)) break;
    m.val[best] -= m.bp[best]; m.bp[best] = 0;
  }
  // Easy bot: now and then it just wanders to a random reachable cell.
  if (L === 0) {
    if (!(m.wander > g.t) && B.rng() < 0.01) { m.wander = g.t + 1; m.wk = m.q[(B.rng() * n) | 0]; }
    if (m.wander > g.t && m.dist[m.wk] >= 0 && safeStand(s, D, F, m.wk, arrive(m.wk))) best = m.wk;
  }
  m.goal = best;
  return walk(best);
}
