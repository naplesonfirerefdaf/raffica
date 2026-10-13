// Bombarde Rimbalzine — Tank Trouble style hedge-maze battle for 2-4 war carts (top-down, dir + A shoot + B shield).
import { clamp, dist2, collideCircles, bounceCircleRect, circleRect, angleDiff, wrapAngle, r1, r2 } from '../core/geom.js';

// Tight world around the maze so everything is as big as possible on a phone.
const W = 900, H = 900;
const N = 6, CELL = 140, M0 = (W - N * CELL) / 2; // maze spans 30..870
const WT = 12;                                     // wall thickness
const TANK_R = 31, HIT_R = 27, SPEED = 205, TURN = 5.5;
const BR = 8, BULLET_V = 400, MAX_BOUNCE = 6, BULLET_LIFE = 7, FIRE_CD = 0.22;
const WINS = 2, ROUND_END = 1.3, ROUND_PAUSE = 0.8, TURBO_AT = 18;
const DANCE_EVERY = 5, DANCE_WARN = 1.1, GHOST_T = 0.5;
// B: shield bubble that bounces bullets back to the sender.
const SHIELD_T = 0.7, SHIELD_CD = 3.5, SHIELD_R = TANK_R + 14;
// Triple-shot crates: appear in mirrored pairs, give 2 spread volleys.
const PICK_FIRST = 4, PICK_EVERY = 7, PICK_R = 26, TRI_SHOTS = 2, TRI_SPREAD = 0.28;
const SUICIDE = ['SUICIDIO TATTICO!', 'AUTOGOL!', 'FUOCO AMICO!', 'SI È SPARATO DA SOLO!', 'GENIO DEL RIMBALZO!'];

// --- Maze topology: 30 vertical edges (between columns) + 30 horizontal edges (between rows) ---
const NE = 60;
function edgeCells(e) {
  if (e < 30) { const r = Math.floor(e / 5), c = e % 5; return [r * N + c, r * N + c + 1]; }
  const k = e - 30, r = Math.floor(k / N), c = k % N;
  return [r * N + c, (r + 1) * N + c];
}
// Edge under 180° rotation around the center (cell (c,r) -> (5-c,5-r)).
function mirrorE(e) {
  if (e < 30) { const r = Math.floor(e / 5), c = e % 5; return (5 - r) * 5 + (4 - c); }
  const k = e - 30, r = Math.floor(k / N), c = k % N;
  return 30 + (4 - r) * N + (5 - c);
}
function edgeRect(e) {
  if (e < 30) {
    const r = Math.floor(e / 5), c = e % 5, x = M0 + (c + 1) * CELL;
    return [x - WT / 2, M0 + r * CELL - WT / 2, WT, CELL + WT];
  }
  const k = e - 30, r = Math.floor(k / N), c = k % N, y = M0 + (r + 1) * CELL;
  return [M0 + c * CELL - WT / 2, y - WT / 2, CELL + WT, WT];
}
const EC = Array.from({ length: NE }, (_, e) => edgeCells(e));
const MIR = Array.from({ length: NE }, (_, e) => mirrorE(e));
const ER = Array.from({ length: NE }, (_, e) => edgeRect(e));
const ADJ = Array.from({ length: N * N }, () => []);
EC.forEach(([a, b], e) => { ADJ[a].push([e, b]); ADJ[b].push([e, a]); });
const OUTER = [
  [M0 - WT / 2, M0 - WT / 2, N * CELL + WT, WT], [M0 - WT / 2, M0 + N * CELL - WT / 2, N * CELL + WT, WT],
  [M0 - WT / 2, M0 - WT / 2, WT, N * CELL + WT], [M0 + N * CELL - WT / 2, M0 - WT / 2, WT, N * CELL + WT],
];
const cellX = (c) => M0 + c * CELL + CELL / 2;

function connected(w) {
  const seen = new Uint8Array(N * N), q = [0];
  seen[0] = 1;
  let n = 1;
  while (q.length) {
    const c = q.pop();
    for (const [e, o] of ADJ[c]) if (!w[e] && !seen[o]) { seen[o] = 1; n++; q.push(o); }
  }
  return n === N * N;
}

// Symmetric random maze: paired Kruskal (always connected) + loops to break up dead ends.
function genMaze(rng) {
  const w = new Array(NE).fill(1);
  const par = Array.from({ length: N * N }, (_, i) => i);
  const find = (x) => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  const open = (e) => { w[e] = 0; const [a, b] = EC[e]; par[find(a)] = find(b); };
  for (const e of rng.shuffle([...Array(NE).keys()])) {
    const [a, b] = EC[e];
    if (find(a) !== find(b)) { open(e); open(MIR[e]); }
  }
  // Open some dead ends (cells with 3 walls; the border counts as wall) to create loops.
  for (const c of rng.shuffle([...Array(N * N).keys()])) {
    const closed = ADJ[c].filter(([e]) => w[e]);
    const walls = closed.length + (4 - ADJ[c].length);
    if (walls >= 3 && rng.chance(0.4)) { const [e] = rng.pick(closed); w[e] = 0; w[MIR[e]] = 0; }
  }
  return w;
}

function buildWalls(s) {
  s.walls = OUTER.slice();
  for (let e = 0; e < NE; e++) if (s.w[e]) s.walls.push(ER[e]);
}

function newRound(s, g) {
  s.round++;
  s.w = genMaze(g.rng);
  buildWalls(s);
  s.b = []; s.pend = null; s.danceT = DANCE_EVERY; s.pk = []; s.pickT = PICK_FIRST;
  s.overT = 0; s.pause = s.round > 1 ? ROUND_PAUSE : 0; s.rt = 0; s.turbo = false;
  // Seats: 0 bottom row, 1 top row, 2 left column, 3 right column (180° symmetric pairs, never the same cell).
  const c0 = g.rng.int(0, N - 1);
  const SP = [[c0, N - 1, -Math.PI / 2], [N - 1 - c0, 0, Math.PI / 2], [0, c0, 0], [N - 1, N - 1 - c0, Math.PI]];
  s.t.forEach((t, i) => {
    const [c, r, a] = SP[i];
    Object.assign(t, {
      x: cellX(c), y: cellX(r), a, alive: true, cd: 0.3, vis: GHOST_T * 2, bump: 0,
      sh: 0, scd: 0.5, tri: 0, mv: 0,
    });
  });
  if (s.round > 1) { g.say(`ROUND ${s.round}!`); g.sfx('whistle'); }
}

function kill(s, g, t, by) {
  if (!t.alive || g.ended) return;
  t.alive = false; t.vis = 9; t.selfDeath = by === t.i; t.sh = 0;
  s.lastDead = t;
  if (s.t.filter((q) => q.alive).length >= 2) g.text(t.x, t.y - 60, 'DISTRUTTO!', { player: t.i, size: 38 });
  if (by === t.i) { s.self[t.i]++; g.say(g.rng.pick(SUICIDE)); g.sfx('quack'); }
  else s.kills[by]++;
  g.sfx('explode'); g.sfx('bang', { vol: 0.7 });
  g.burst(t.x, t.y, { player: t.i, n: 30, speed: 380, size: 12 });
  g.burst(t.x, t.y, { color: '#ffb02e', n: 18, speed: 260, size: 14 });
  g.burst(t.x, t.y, { color: '#3a3a3a', n: 10, speed: 160, size: 16 });
  g.ring(t.x, t.y, { color: '#fff', r: 110 });
  g.shake(0.6); g.hitstop(0.08); g.vibrate(t.i, 260);
}

// Push a circle out of all walls. Returns true if it touched any.
function pushOut(s, o) {
  let hit = false;
  for (let it = 0; it < 2; it++) {
    for (const R of s.walls) if (bounceCircleRect(o, R[0], R[1], R[2], R[3], 0)) hit = true;
  }
  return hit;
}

function fire(s, g, t, ang, bv) {
  const fx = Math.cos(ang), fy = Math.sin(ang);
  s.b.push({ id: s.nid++, o: t.i, x: t.x + fx * 10, y: t.y + fy * 10, vx: fx * bv, vy: fy * bv, r: BR, n: 0, life: 0, safe: true });
}

// Mirrored pair of triple-shot crates in random free cells away from both tanks.
function spawnPicks(s, g) {
  for (let tries = 0; tries < 12; tries++) {
    const c = g.rng.int(0, N - 1), r = g.rng.int(0, N - 1);
    const a = { x: cellX(c), y: cellX(r) }, b = { x: cellX(N - 1 - c), y: cellX(N - 1 - r) };
    if (c === N - 1 - c && r === N - 1 - r) continue;
    if (s.t.some((t) => dist2(t.x, t.y, a.x, a.y) < 200 * 200 || dist2(t.x, t.y, b.x, b.y) < 200 * 200)) continue;
    s.pk = [{ id: s.nid++, ...a }, { id: s.nid++, ...b }];
    g.sfx('powerup', { vol: 0.4, pitch: 1.3 });
    return;
  }
}

const game = {
  id: 'carri',
  name: 'Bombarde Rimbalzine',
  rule: 'Colpisci gli altri carri: le palle rimbalzano!',
  verb: 'FUOCO!',
  inspired: 'Tank Trouble · Clubhouse Games Toy Tanks',
  cam: 'top',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Spara', b: 'Scudo' },
  help: {
    goal: "Colpisci i carri avversari con le palle di cannone: l'ultimo carro in piedi vince il round, chi ne vince 2 vince la sfida.",
    dir: 'Il carro si gira verso la direzione e poi parte (prima ruota, poi avanza).',
    a: 'SPARA una palla di cannone che rimbalza sulle siepi fino a 6 volte (max 4 in volo). Attento: colpisce anche te!',
    b: 'SCUDO per 0,7 s: le palle che lo toccano tornano indietro e diventano tue. Si ricarica in 3,5 s.',
    tips: ['I barili ×3 danno 2 raffiche TRIPLE', 'Dopo 18 s le palle diventano infuocate e più veloci', 'Usa lo scudo appena vedi un colpo in arrivo'],
  },
  duration: 60,
  noMods: ['moviola'], // 60 s in slow motion would last well over a minute and a half
  variants: [
    { id: 'eterni', name: 'Palle Eterne', desc: 'Rimbalzano finché colpiscono qualcosa! Max 3.' },
    { id: 'ballerino', name: 'Siepi Incantate', desc: 'Ogni 5 secondi le siepi cambiano!' },
    { id: 'fantasma', name: 'Carri Fantasma', desc: 'Invisibili! Vi vedete solo quando sparate o urtate.' },
  ],

  init(g) {
    const n = Math.max(2, Math.min(4, g.n || 2));
    const s = {
      eterni: g.variant === 'eterni', dance: g.variant === 'ballerino', ghost: g.variant === 'fantasma',
      round: 0, wins: new Array(n).fill(0), self: new Array(n).fill(0), kills: new Array(n).fill(0), nid: 1, lastDead: null,
      t: Array.from({ length: n }, (_, i) => ({ i, x: 0, y: 0, a: 0, alive: true, cd: 0, vis: 0, bump: 0, recoil: 0, sh: 0, scd: 0, tri: 0, mv: 0 })),
      w: null, walls: [], b: [], pk: [], pickT: PICK_FIRST, pend: null, danceT: DANCE_EVERY, overT: 0, pause: 0, rt: 0, turbo: false,
    };
    newRound(s, g);
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.pause = Math.max(0, s.pause - dt);
    s.rt += dt;
    const maxOwn = s.eterni ? 3 : 4;
    const bv = BULLET_V * (s.turbo ? 1.4 : 1);
    if (!s.turbo && s.rt >= TURBO_AT && !s.overT) {
      s.turbo = true;
      for (const b of s.b) { b.vx *= 1.4; b.vy *= 1.4; }
      g.say('PALLE INFUOCATE!'); g.sfx('powerup'); g.flash('#ff8a30', 0.25);
    }

    // --- Dancing maze: plan with a flashing warning, then swap walls ---
    if (s.dance && !s.overT) {
      s.danceT -= dt;
      if (!s.pend && s.danceT <= DANCE_WARN) {
        const w = s.w.slice(), opens = [], closes = [];
        const reps = (pred) => g.rng.shuffle([...Array(NE).keys()].filter((e) => e < MIR[e] && pred(e)));
        for (const e of reps((e) => w[e]).slice(0, 2)) { w[e] = w[MIR[e]] = 0; opens.push(e); }
        for (const e of reps((e) => !w[e] && !opens.includes(e))) {
          if (closes.length >= 2) break;
          w[e] = w[MIR[e]] = 1;
          if (connected(w)) closes.push(e); else w[e] = w[MIR[e]] = 0;
        }
        s.pend = { opens, closes };
        g.sfx('tick'); g.sfx('fuse', { vol: 0.5 });
      }
      if (s.danceT <= 0) {
        s.danceT += DANCE_EVERY;
        if (s.pend) {
          for (const e of s.pend.opens) s.w[e] = s.w[MIR[e]] = 0;
          for (const e of s.pend.closes) {
            // Never drop a wall onto a tank: skip the whole symmetric pair.
            const blocked = [e, MIR[e]].some((x) => s.t.some((t) => t.alive && circleRect(t.x, t.y, TANK_R + 4, ...ER[x])));
            if (!blocked) s.w[e] = s.w[MIR[e]] = 1;
          }
          s.pend = null;
          buildWalls(s);
          g.sfx('swap'); g.shake(0.2); g.say('LE SIEPI SI MUOVONO!');
        }
      }
    }

    // --- Triple-shot crates ---
    if (!s.overT && s.pause <= 0) {
      s.pickT -= dt;
      if (s.pickT <= 0 && !s.pk.length) { spawnPicks(s, g); s.pickT = PICK_EVERY; }
    }

    // --- Tanks ---
    for (const t of s.t) {
      t.cd = Math.max(0, t.cd - dt);
      t.vis = Math.max(0, t.vis - dt);
      t.bump = Math.max(0, t.bump - dt);
      t.recoil = Math.max(0, t.recoil - dt);
      t.sh = Math.max(0, t.sh - dt);
      t.scd = Math.max(0, t.scd - dt);
      t.mv = 0;
      if (!t.alive) continue;
      const i = inp[t.i];
      const m = Math.min(1, Math.hypot(i.x, i.y));
      let moving = false;
      if (m > 0.2) {
        const df = angleDiff(t.a, Math.atan2(i.y, i.x));
        t.a += clamp(df, -TURN * dt, TURN * dt);
        if (s.pause <= 0) {
          // Turn first, then roll: speed fades in as the hull lines up with the stick.
          const f = clamp((Math.cos(angleDiff(t.a, Math.atan2(i.y, i.x))) - 0.35) / 0.65, 0, 1);
          const v = SPEED * m * f * (t.sh > 0 ? 0.6 : 1);
          t.x += Math.cos(t.a) * v * dt; t.y += Math.sin(t.a) * v * dt;
          moving = v > 10;
        }
      }
      t.mv = moving ? 1 : 0;
      const o = { x: t.x, y: t.y, vx: 0, vy: 0, r: TANK_R };
      if (pushOut(s, o) && moving) {
        if (t.bump <= 0) { g.sfx('bonk', { vol: 0.3, pitch: 0.8 }); t.bump = 0.4; }
        t.vis = Math.max(t.vis, GHOST_T);
      }
      t.x = clamp(o.x, M0 + TANK_R, M0 + N * CELL - TANK_R);
      t.y = clamp(o.y, M0 + TANK_R, M0 + N * CELL - TANK_R);
      // B: shield.
      if (i.bP && t.scd <= 0 && s.pause <= 0) {
        t.sh = SHIELD_T; t.scd = SHIELD_CD; t.vis = Math.max(t.vis, SHIELD_T);
        g.sfx('freeze', { vol: 0.6, pitch: 1.4 }); g.ring(t.x, t.y, { color: '#8ff6ff', r: SHIELD_R + 10 });
      } else if (i.bP && t.scd > 0 && t.bump <= 0) { g.sfx('click', { vol: 0.4 }); t.bump = 0.2; }
      // A: fire (not while shielded).
      if (i.aP && t.cd <= 0 && s.pause <= 0 && t.sh <= 0) {
        const own = s.b.filter((b) => b.o === t.i).length;
        let shot = true;
        if (t.tri > 0) {
          t.tri--;
          for (const da of [-TRI_SPREAD, 0, TRI_SPREAD]) fire(s, g, t, t.a + da, bv);
          g.sfx('shoot', { pitch: 0.75, vol: 0.9 }); g.shake(0.15);
        } else if (own < maxOwn) {
          fire(s, g, t, t.a, bv);
          g.sfx('shoot', { pitch: 1 + g.rng.range(-0.08, 0.08), vol: 0.7 });
        } else {
          shot = false;
          if (t.bump <= 0) { g.sfx('click', { vol: 0.5 }); t.bump = 0.2; }
        }
        if (shot) {
          t.cd = FIRE_CD; t.vis = Math.max(t.vis, GHOST_T); t.recoil = 0.12;
          const fx = Math.cos(t.a), fy = Math.sin(t.a);
          g.burst(t.x + fx * (TANK_R + 18), t.y + fy * (TANK_R + 18), { color: '#ffe9a0', n: 6, speed: 180, size: 6 });
        }
      }
      // Crate pickup.
      for (const p of s.pk) {
        if (!p.dead && dist2(p.x, p.y, t.x, t.y) < (PICK_R + TANK_R) ** 2) {
          p.dead = 1; t.tri = TRI_SHOTS;
          g.sfx('pickup'); g.sfx('powerup', { vol: 0.5 });
          g.burst(p.x, p.y, { color: '#ffd23f', n: 16, speed: 240 });
          g.text(t.x, t.y - 70, 'TRIPLA x2!', { player: t.i, size: 40 });
        }
      }
    }
    if (s.pk.some((p) => p.dead)) s.pk = []; // the twin vanishes too: first come, first served
    // Tank vs tank: shove apart (never into a wall).
    for (let a = 0; a < s.t.length; a++) for (let b = a + 1; b < s.t.length; b++) {
      const A = s.t[a], B = s.t[b];
      if (!(A.alive && B.alive && dist2(A.x, A.y, B.x, B.y) < (2 * TANK_R) ** 2)) continue;
      const Ao = { x: A.x, y: A.y, vx: 0, vy: 0, r: TANK_R }, Bo = { x: B.x, y: B.y, vx: 0, vy: 0, r: TANK_R };
      collideCircles(Ao, Bo, 0);
      pushOut(s, Ao); pushOut(s, Bo);
      A.x = Ao.x; A.y = Ao.y; B.x = Bo.x; B.y = Bo.y;
      A.vis = Math.max(A.vis, GHOST_T); B.vis = Math.max(B.vis, GHOST_T);
      if (A.bump <= 0 && B.bump <= 0) { g.sfx('bonk', { vol: 0.5 }); A.bump = B.bump = 0.5; }
    }

    // --- Bullets: sub-stepped so they never tunnel through thin walls ---
    for (const b of s.b) {
      b.life += dt;
      if (!s.eterni && b.life > BULLET_LIFE) { b.dead = 1; g.burst(b.x, b.y, { color: '#999', n: 4, speed: 60 }); continue; }
      const sp = Math.hypot(b.vx, b.vy);
      const steps = Math.max(1, Math.ceil((sp * dt) / 3));
      for (let n = 0; n < steps && !b.dead; n++) {
        b.x += (b.vx * dt) / steps; b.y += (b.vy * dt) / steps;
        let wall = false;
        for (const R of s.walls) if (bounceCircleRect(b, R[0], R[1], R[2], R[3], 1)) wall = true;
        if (wall) {
          b.n++;
          if (!s.eterni && b.n > MAX_BOUNCE) { b.dead = 1; g.burst(b.x, b.y, { color: '#ccc', n: 5, speed: 90 }); break; }
          g.sfx('bounce', { vol: 0.18, pitch: 1.6 + g.rng.range(0, 0.3) });
        }
        for (const t of s.t) {
          if (!t.alive) continue;
          const d2 = dist2(b.x, b.y, t.x, t.y);
          if (t.sh > 0 && d2 < (SHIELD_R + BR) ** 2) {
            // Reflect off the bubble and steal the bullet.
            const d = Math.sqrt(d2) || 1, nx = (b.x - t.x) / d, ny = (b.y - t.y) / d;
            const vn = b.vx * nx + b.vy * ny;
            if (vn < 0) {
              b.vx -= 2 * vn * nx; b.vy -= 2 * vn * ny;
              if (b.o !== t.i) { b.o = t.i; b.safe = false; }
              b.n = 0;
              g.sfx('zap', { vol: 0.6, pitch: 1.5 }); g.burst(b.x, b.y, { color: '#8ff6ff', n: 8, speed: 180 });
              g.text(t.x, t.y - 70, 'RESPINTO!', { color: '#8ff6ff', size: 34 });
            }
            b.x = t.x + nx * (SHIELD_R + BR + 1); b.y = t.y + ny * (SHIELD_R + BR + 1);
            continue;
          }
          if (b.safe && t.i === b.o) { if (d2 > (TANK_R + BR + 2) ** 2) b.safe = false; continue; }
          if (d2 < (HIT_R + BR) ** 2 && !g.ended) { b.dead = 1; kill(s, g, t, b.o); break; }
        }
      }
      // Keep speed constant (corner double-hits can only reflect, never slow down).
      const v = Math.hypot(b.vx, b.vy) || 1;
      b.vx *= bv / v; b.vy *= bv / v;
    }
    // Bullet vs bullet: both vanish.
    for (let p = 0; p < s.b.length; p++) {
      const a = s.b[p];
      if (a.dead) continue;
      for (let q = p + 1; q < s.b.length; q++) {
        const c = s.b[q];
        if (!c.dead && dist2(a.x, a.y, c.x, c.y) < (2 * BR) ** 2) {
          a.dead = c.dead = 1;
          g.sfx('zap', { vol: 0.5 }); g.burst(a.x, a.y, { color: '#fff', n: 8, speed: 160 });
          break;
        }
      }
    }
    s.b = s.b.filter((b) => !b.dead);

    // --- Round flow ---
    if (g.ended) return;
    const alive = s.t.filter((t) => t.alive);
    if (s.overT > 0) {
      s.overT -= dt;
      if (s.overT <= 0) {
        if (alive.length === 1) {
          const w = alive[0].i;
          s.wins[w]++;
          g.sfx('point'); g.text(alive[0].x, alive[0].y - 60, 'PUNTO!', { player: w, size: 50 });
          if (s.wins[w] >= WINS) { g.end(w, 'Carro nemico distrutto!'); return; }
        } else { g.say('PAREGGIO! SI RIGIOCA'); g.sfx('buzzer'); }
        newRound(s, g);
      }
    } else if (alive.length < 2) {
      if (alive.length === 1 && s.wins[alive[0].i] + 1 >= WINS) {
        // Decisive kill: no waiting, straight to the finish in slow motion.
        const w = alive[0].i;
        s.wins[w]++;
        g.sfx('bigexplode'); g.slowmo(0.3, 0.9); g.flash('#fff', 0.5);
        g.confetti(alive[0].x, alive[0].y);
        g.end(w, s.lastDead && s.lastDead.selfDeath ? 'Suicidio tattico!' : 'Carro nemico distrutto!');
        return;
      }
      s.overT = ROUND_END;
    }
  },

  // Most rounds (a lone survivor of the current round counts it), then fewest own goals, most kills, still alive.
  timeout(s) {
    const w = s.wins.slice();
    const al = s.t.filter((t) => t.alive);
    if (al.length === 1) w[al[0].i]++; // the round in progress already has a survivor
    let pool = s.t;
    for (const key of [(t) => w[t.i], (t) => -s.self[t.i], (t) => s.kills[t.i], (t) => (t.alive ? 1 : 0)]) {
      const top = Math.max(...pool.map(key));
      pool = pool.filter((t) => key(t) === top);
      if (pool.length === 1) return pool[0].i;
    }
    return -1;
  },

  view(s) {
    let p = '';
    if (s.pend) {
      const a = new Array(NE).fill('0');
      for (const e of s.pend.opens) a[e] = a[MIR[e]] = '2';
      for (const e of s.pend.closes) a[e] = a[MIR[e]] = '1';
      p = a.join('');
    }
    return {
      w: s.w.join(''), p, gh: s.ghost ? 1 : 0, tb: s.turbo ? 1 : 0, pz: s.pause > 0 ? 1 : 0,
      t: s.t.map((t) => ({
        x: r1(t.x), y: r1(t.y), a: r2(wrapAngle(t.a)), al: t.alive ? 1 : 0, v: r2(Math.min(1, t.vis / GHOST_T)), rc: r2(t.recoil),
        sh: r2(t.sh / SHIELD_T), sc: r2(t.scd / SHIELD_CD), tri: t.tri, mv: t.mv,
      })),
      b: s.b.map((b) => {
        const v = Math.hypot(b.vx, b.vy) || 1;
        return { id: b.id, o: b.o, x: r1(b.x), y: r1(b.y), dx: r2(b.vx / v), dy: r2(b.vy / v) };
      }),
      pk: s.pk.map((q) => ({ id: q.id, x: r1(q.x), y: r1(q.y) })),
      hud: { p: s.wins.slice(), max: WINS, label: 'Round' },
    };
  },

  focus(v) {
    return v.t.map((t) => ({ x: t.x, y: t.y }));
  },

  bot(s, me, g, B) { return carriBot(s, me, g, B); },

  // 3D: "Il Labirinto di Siepi del Re" — a hedge maze on gravel paths in the royal garden at sunset, the golden
  // castle behind, a reflecting pool, avenues of trees, petals in the wind. Tanks are wooden war carts with a
  // bronze bombard and the team banner; bullets are iron cannonballs (fiery after 18 s).
  render3d: {
    assets: [
      'medieval/building_castle_yellow', 'medieval/building_tower_A_yellow', 'medieval/building_tower_B_yellow', 'medieval/building_windmill_yellow',
      'medieval/building_market_yellow', 'medieval/building_well_yellow', 'medieval/building_home_A_yellow', 'medieval/tent',
      'medieval/trees_A_large', 'medieval/trees_A_medium', 'medieval/tree_single_A', 'medieval/hills_A_trees', 'medieval/mountain_A_grass_trees',
      'medieval/fence_wood_straight', 'medieval/barrel', 'medieval/sack', 'medieval/crate_A_big', 'medieval/flag_yellow',
      'medieval/waterlily_A', 'medieval/waterplant_B', 'dungeon/column', 'dungeon/barrel_small',
    ],
    build(K, r) {
      const T = K.THREE, hi = K.quality > 0;
      const n = Math.max(2, (r && r.n) || K.n || 2);
      const o = { D: new T.Object3D() };
      const MW = N * CELL + 48, MX = M0 - 24;
      K.theme('tramonto', { fogNear: 2.6, fogFar: 7 });
      K.ground('prato', { tile: 200, margin: 1900 });
      // Gravel paths inside the maze (warmer when the cannonballs catch fire).
      K.layer({
        x0: MX, y0: MX, x1: MX + MW, y1: MX + MW, h: 0.4, key: (v) => `${v.tb}`, maxPx: 1024,
        draw: (d, v) => drawGravel(d, v.tb),
      });
      // Outer stone wall with corner pillars.
      const stoneH = K.texMat('muro', [10, 1], { color: '#e3d3b4' }), stoneV = K.texMat('muro', [1, 10], { color: '#e3d3b4' });
      o.capM = K.mat('#cbb48a', { rough: 0.6, unique: true });
      for (const R of OUTER) {
        const horiz = R[2] > R[3];
        K.place(K.box(R[2] + 12, R[3] + 12, 40, horiz ? stoneH : stoneV), R[0] + R[2] / 2, R[1] + R[3] / 2, 20);
        K.place(K.box(R[2] + 18, R[3] + 18, 6, o.capM, { cast: false }), R[0] + R[2] / 2, R[1] + R[3] / 2, 43);
      }
      for (const [x, y] of [[M0, M0], [M0 + N * CELL, M0], [M0, M0 + N * CELL], [M0 + N * CELL, M0 + N * CELL]]) K.place(K.model('dungeon/column', { height: 62 }), x, y);
      // Hedges: one instanced box per maze edge (toggled per frame) + a lighter leafy top.
      o.WH = 44;
      const hedgeGeo = new T.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
      const mk = (mat) => {
        const m = new T.InstancedMesh(hedgeGeo, mat, NE);
        m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
        K.root.add(m);
        return m;
      };
      o.hedge = mk(K.texMat('erba', [1, 3], { color: '#8fe07a', rough: 0.95 }));
      o.hedgeTop = mk(K.texMat('prato', [1, 3], { color: '#d8ff9a', rough: 0.9 }));
      o.wkey = '';
      // Pending changes of the enchanted hedges: blinking white (vanishing) / red (growing) ghosts.
      o.pend = [];
      for (let k = 0; k < 8; k++) o.pend.push(K.box(1, 1, 1, K.glow('#ffffff', { unique: true, opacity: 0.6 }), { cast: false }));
      // War carts.
      o.tk = Array.from({ length: n }, (_, i) => {
        const wood = K.texMat('legno', [2, 1], { color: '#b07a48' });
        const darkWood = K.mat('#5a3b22', { unique: true, rough: 0.8 });
        const team = K.mat(K.col(i, 'main'), { unique: true, rough: 0.5 });
        const teamL = K.mat(K.col(i, 'light'), { unique: true, rough: 0.5 });
        const bronze = K.mat('#c08a3e', { unique: true, rough: 0.3, metal: 0.6 });
        const g = K.group();
        const bed = K.box(58, 40, 12, wood, { parent: g });
        bed.position.y = 16;
        for (const sy of [-1, 1]) {
          const side = K.box(60, 5, 14, team, { parent: g, cast: false });
          side.position.set(0, 27, sy * 20);
          for (const xk of [-18, 18]) {
            const wh = K.cyl(11, 6, darkWood, { parent: g, center: true, seg: 14 });
            wh.rotation.x = Math.PI / 2;
            wh.position.set(xk, 11, sy * 24);
          }
        }
        K.box(8, 34, 14, teamL, { parent: g, cast: false }).position.set(-28, 26, 0);
        // Team banner on a pole at the back.
        const pole = K.cyl(1.6, 52, darkWood, { parent: g, seg: 6, cast: false });
        pole.position.set(-24, 22, -14);
        const flag = K.box(22, 2, 15, team, { parent: g, cast: false });
        flag.position.set(-13, 66, -14);
        // Turret: bronze bombard on a wooden mount.
        const tg = K.group(g);
        tg.position.y = 28;
        K.box(20, 18, 8, darkWood, { parent: tg });
        const barrel = K.cyl(6.5, 38, bronze, { parent: tg, center: true, seg: 14 });
        barrel.rotation.z = -Math.PI / 2;
        const muzzle = K.cyl(8.5, 6, bronze, { parent: tg, center: true, seg: 14 });
        muzzle.rotation.z = -Math.PI / 2;
        const flash = K.ball(1, K.glow('#fff3a0', { add: true }), { parent: tg, cast: false });
        const shield = K.ball(SHIELD_R, K.glow('#ffe48a', { unique: true, opacity: 0.25, add: true }), { cast: false, seg: 32 });
        const shRing = K.torus(SHIELD_R - 3, 2.5, K.glow('#ffffff', { unique: true, opacity: 0.8 }), { cast: false });
        const pips = [0, 1].map(() => K.emoji('⭐', 26));
        const smoke = [0, 1, 2].map(() => K.ball(1, K.mat('#5a5a5a', { opacity: 0.55, rough: 1 }), { cast: false }));
        return {
          g, tg, barrel, muzzle, flash, flag, shield, shRing, pips, smoke, ha: null, alpha: 1, dead: false,
          mats: [wood, darkWood, team, teamL, bronze], cols: ['#b07a48', '#5a3b22', K.col(i, 'main'), K.col(i, 'light'), '#c08a3e'],
          av: K.avatar(i), dec: K.decal(120),
        };
      });
      // Cannonballs: iron core + owner halo + comet tail (fiery orange after 18 s).
      o.core = K.mat('#2b2b33', { rough: 0.35, metal: 0.6 });
      o.halo = Array.from({ length: n }, (_, i) => K.glow(K.col(i, 'main'), { opacity: 0.45 }));
      o.tail = Array.from({ length: n }, (_, i) => K.glow(K.col(i, 'main'), { opacity: 0.45 }));
      o.fire = K.glow('#ff8a2a', { opacity: 0.55, add: true });
      o.bl = [];
      for (let k = 0; k < 24; k++) {
        const core = K.ball(BR, o.core, { seg: 14 });
        K.outline(core, '#14101e', 0.25);
        o.bl.push({ core, halo: K.ball(1, o.halo[0], { cast: false, seg: 12 }), tail: K.ball(1, o.tail[0], { cast: false, seg: 10 }) });
      }
      // Triple-shot gunpowder barrels.
      o.pk = [0, 1].map(() => {
        const g = K.group();
        K.model('dungeon/barrel_small', { height: 46, parent: g });
        const label = K.billboard(128, 96, 46, (d, w, h) => d.text('×3', w / 2, h / 2 + 4, { size: 70, color: '#6b2e00', strokeColor: '#fff6c0' }));
        const glow = K.disc(1, K.glow('#ffd23f', { opacity: 0.4, add: true }));
        return { g, label, glow };
      });
      buildGarden(K, hi);
      return o;
    },

    update(K, o, v, r) {
      const D = o.D, t = K.t;
      const blink = Math.floor(t * 8) % 2 === 0;
      // Hedges: rebuild the instance matrices only when the maze changes.
      if (v.w !== o.wkey) {
        o.wkey = v.w;
        for (let e = 0; e < NE; e++) {
          const R = ER[e], on = v.w[e] === '1', vert = R[2] < R[3];
          const L = vert ? R[3] - 2 : R[2] - 2, th = 16;
          D.position.set(R[0] + R[2] / 2, 0, R[1] + R[3] / 2);
          D.scale.set(on ? (vert ? th : L) : 0, on ? o.WH : 0, on ? (vert ? L : th) : 0);
          D.updateMatrix(); o.hedge.setMatrixAt(e, D.matrix);
          D.position.y = o.WH;
          D.scale.set(on ? (vert ? th + 4 : L + 2) : 0, on ? 7 : 0, on ? (vert ? L + 2 : th + 4) : 0);
          D.updateMatrix(); o.hedgeTop.setMatrixAt(e, D.matrix);
        }
        o.hedge.instanceMatrix.needsUpdate = o.hedgeTop.instanceMatrix.needsUpdate = true;
      }
      let pn = 0;
      if (v.p) {
        for (let e = 0; e < NE && pn < o.pend.length; e++) {
          const pe = v.p[e];
          if (pe === '0') continue;
          const R = ER[e], m = o.pend[pn++], vert = R[2] < R[3];
          const grow = pe === '1';
          m.visible = grow ? true : blink;
          K.place(m, R[0] + R[2] / 2, R[1] + R[3] / 2, grow ? 12 : o.WH / 2 + 2);
          m.scale.set(vert ? 20 : R[2], grow ? 24 : o.WH + 8, vert ? R[3] : 20);
          m.material.color.set(grow ? '#ff3c3c' : '#ffffff');
          m.material.opacity = grow ? (blink ? 0.75 : 0.3) : 0.55;
        }
      }
      for (; pn < o.pend.length; pn++) o.pend[pn].visible = false;
      o.capM.color.set(v.tb ? (blink ? '#ff9a50' : '#e0703a') : '#cbb48a');
      // Barrels.
      o.pk.forEach((P, k) => {
        const q = v.pk[k];
        P.g.visible = P.label.visible = P.glow.visible = !!q;
        if (!q) return;
        const bob = 4 + Math.sin(t * 4 + q.id) * 4;
        K.place(P.g, q.x, q.y, bob);
        P.g.rotation.y = t * 1.4 + q.id;
        K.place(P.label, q.x, q.y, bob + 76);
        K.place(P.glow, q.x, q.y, 0.9);
        P.glow.scale.setScalar(PICK_R + 12 + 4 * Math.sin(t * 6));
      });
      // Cannonballs.
      o.bl.forEach((B, k) => {
        const b = v.b[k];
        const on = !!b;
        B.core.visible = B.halo.visible = B.tail.visible = on;
        if (!on) return;
        const ow = o.halo[b.o] ? b.o : 0, h = BR + 7;
        K.place(B.core, b.x, b.y, h);
        K.place(B.halo, b.x, b.y, h);
        B.halo.material = v.tb ? o.fire : o.halo[ow];
        B.halo.scale.setScalar(BR + (v.tb ? 8 : 5) + Math.sin(t * 30 + k) * 1.5);
        B.tail.material = v.tb ? o.fire : o.tail[ow];
        K.place(B.tail, b.x - b.dx * 16, b.y - b.dy * 16, h);
        K.face(B.tail, Math.atan2(b.dy, b.dx));
        B.tail.scale.set(BR * (v.tb ? 2.8 : 2), BR * 0.7, BR * 0.7);
      });
      // Carts.
      v.t.forEach((tk, i) => {
        const P = o.tk[i];
        if (!P) return;
        let alpha = 1;
        if (v.gh && tk.al) {
          alpha = clamp(tk.v, 0, 1);
          if (r && r.viewer === i) alpha = Math.max(alpha, 0.3);
        }
        const vis = alpha > 0.02;
        if (P.ha === null || !tk.al) P.ha = tk.a;
        else P.ha += angleDiff(P.ha, tk.a) * Math.min(1, (K.dt || 0.016) * 9);
        const dead = !tk.al;
        if (dead !== P.dead) {
          P.dead = dead;
          P.mats.forEach((m, k) => m.color.set(dead ? '#3a3a3a' : P.cols[k] || '#ffffff'));
        }
        const al = vis ? alpha : 0;
        if (al !== P.alpha) {
          P.alpha = al;
          for (const m of P.mats) { m.transparent = al < 1; m.opacity = al; m.depthWrite = al >= 1; m.needsUpdate = true; }
        }
        P.g.visible = vis;
        const shake = tk.mv ? Math.sin(t * 60) * 0.6 : 0;
        K.place(P.g, tk.x, tk.y, shake * 0.5);
        K.face(P.g, P.ha + (dead ? 0.4 : 0));
        P.g.rotation.z = dead ? 0.12 : 0;
        P.tg.rotation.y = dead ? 0.7 : -angleDiff(P.ha, tk.a);
        const rc = tk.rc > 0 ? -7 * Math.min(1, tk.rc / 0.08) : 0;
        P.barrel.position.set(14 + rc, 7, 0);
        P.muzzle.position.set(32 + rc, 7, 0);
        P.flash.visible = vis && tk.rc > 0.04;
        if (P.flash.visible) { P.flash.position.set(40 + rc, 7, 0); P.flash.scale.setScalar(8 + 40 * tk.rc); }
        P.flag.rotation.y = Math.sin(t * 6 + i) * 0.25;
        // The driver standing in the cart behind the bombard.
        let scared = false;
        for (const b of v.b) if (b.o !== i && (b.x - tk.x) ** 2 + (b.y - tk.y) ** 2 < 120 * 120) { scared = true; break; }
        const bx = tk.x - Math.cos(P.ha) * 12, by = tk.y - Math.sin(P.ha) * 12;
        P.av.set(bx, by, {
          r: 13, h: dead ? 24 : 22, look: tk.a, alpha: al, visible: vis, gear: false,
          mood: dead ? 'dead' : scared ? 'scared' : v.pz ? 'happy' : 'ok',
          anim: !dead && tk.rc > 0.02 ? 'Interact' : undefined, animKey: tk.rc > 0.02 ? 1 : undefined, animSpeed: 2,
        });
        P.smoke.forEach((s, j) => {
          s.visible = dead;
          if (!dead) return;
          const ph = (t * 0.9 + j / 3) % 1;
          K.place(s, tk.x - 6 + j * 6 + Math.sin(t * 2 + j) * 5, tk.y, 40 + ph * 70);
          s.scale.setScalar(7 + ph * 12);
        });
        const shOn = vis && !dead && tk.sh > 0;
        P.shield.visible = P.shRing.visible = shOn;
        if (shOn) {
          K.place(P.shield, tk.x, tk.y, 14);
          P.shield.material.opacity = alpha * (0.15 + 0.2 * tk.sh);
          K.place(P.shRing, tk.x, tk.y, 22 + Math.sin(t * 10) * 8);
          P.shRing.rotation.y = t * 8;
          P.shRing.material.opacity = alpha * (0.4 + 0.5 * tk.sh);
        }
        P.pips.forEach((s, k) => {
          s.visible = vis && !dead && k < tk.tri;
          if (!s.visible) return;
          const a = t * 3 + k * Math.PI;
          K.place(s, tk.x + Math.cos(a) * 22, tk.y + Math.sin(a) * 22, 80 + Math.sin(t * 5 + k) * 4);
        });
        // Ground ring: team color, with the shield recharge arc.
        P.dec.show(vis && !dead && !shOn).at(tk.x, tk.y, 0.9).paint((d) => {
          const R = TANK_R + 11;
          d.ring(0, 0, R + 6, d.col(i, 'main') + 'aa', 4);
          if (tk.sc > 0) {
            d.ring(0, 0, R, 'rgba(255,228,138,0.18)', 5);
            d.arc(0, 0, R, -Math.PI / 2, -Math.PI / 2 + (1 - tk.sc) * Math.PI * 2, 'rgba(255,210,90,0.85)', 5);
          } else d.ring(0, 0, R, 'rgba(255,220,110,0.95)', 5);
        });
      });
    },
  },
  render(d, v, r) {
    const { ctx } = d;
    const t = d.t;
    // Royal garden lawn around the hedge maze.
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#4f8a3a'); bg.addColorStop(1, '#2f5f2a');
    ctx.fillStyle = bg;
    ctx.fillRect(-300, -300, W + 600, H + 600);
    d.rrect(M0 - 24, M0 - 18, N * CELL + 48, N * CELL + 48, 26, 'rgba(0,0,0,0.35)');
    d.rrect(M0 - 24, M0 - 24, N * CELL + 48, N * CELL + 48, 26, v.tb ? '#b8552a' : '#d8c8a4', '#6a5a3a', 4);
    // Floor: gravel tiles with a soft vignette.
    for (let r0 = 0; r0 < N; r0++) for (let c = 0; c < N; c++) {
      d.rect(M0 + c * CELL, M0 + r0 * CELL, CELL, CELL, (r0 + c) % 2 ? '#e7d6b4' : '#f2e5c8');
    }
    const vg = ctx.createRadialGradient(W / 2, H / 2, 150, W / 2, H / 2, 620);
    vg.addColorStop(0, 'rgba(255,255,255,0)'); vg.addColorStop(1, 'rgba(80,40,20,0.22)');
    ctx.fillStyle = vg;
    ctx.fillRect(M0, M0, N * CELL, N * CELL);

    // Walls (3D: drop shadow, body, top highlight), plus flashing previews in the dancing maze.
    const wallCol = v.tb ? '#2f6a2c' : '#3f8a3c', wallTop = v.tb ? '#ff9a50' : '#7cc65a';
    const drawWall = (R, fill, top) => {
      d.rrect(R[0], R[1], R[2], R[3], 5, fill, '#1e1530', 2);
      d.rrect(R[0] + 2, R[1] + 1, R[2] - 4, Math.min(R[3], R[2]) * 0.45, 3, top);
    };
    for (let e = 0; e < NE; e++) if (v.w[e] === '1') { const R = ER[e]; d.rect(R[0] + 5, R[1] + 8, R[2], R[3], 'rgba(40,20,10,0.22)'); }
    for (const R of OUTER) d.rect(R[0] + 5, R[1] + 8, R[2], R[3], 'rgba(40,20,10,0.22)');
    for (const R of OUTER) drawWall(R, wallCol, wallTop);
    const blink = Math.floor(t * 8) % 2 === 0;
    for (let e = 0; e < NE; e++) {
      const st = v.w[e], pe = v.p ? v.p[e] : '0';
      if (st === '1') drawWall(ER[e], pe === '2' && blink ? '#ffffff' : wallCol, pe === '2' && blink ? '#fff' : wallTop);
      else if (pe === '1') {
        const R = ER[e];
        d.rrect(R[0], R[1], R[2], R[3], 4, blink ? 'rgba(255,60,60,0.8)' : 'rgba(255,60,60,0.3)', '#ff3c3c', 2);
      }
    }

    // Triple-shot crates.
    for (const q of v.pk) {
      const bob = Math.sin(t * 4 + q.id) * 4;
      d.shadow(q.x, q.y + 22, 24, 8, 0.3);
      d.circle(q.x, q.y + bob, PICK_R + 8 + 3 * Math.sin(t * 6), 'rgba(255,210,63,0.25)');
      d.rrect(q.x - PICK_R, q.y - PICK_R + bob, PICK_R * 2, PICK_R * 2, 10, '#ffd23f', '#8a5a00', 4);
      d.rrect(q.x - PICK_R + 5, q.y - PICK_R + bob + 4, PICK_R * 2 - 10, 9, 4, 'rgba(255,255,255,0.45)');
      d.text('×3', q.x, q.y + bob + 3, { size: 30, color: '#6b2e00' });
    }

    // Bullets: owner-coloured comet tail + dark core with white rim.
    for (const b of v.b) {
      const col = d.col(b.o, 'main');
      d.line(b.x - b.dx * 34, b.y - b.dy * 34, b.x, b.y, col + '55', BR * 1.6);
      d.line(b.x - b.dx * 16, b.y - b.dy * 16, b.x, b.y, col + 'aa', BR * 1.2);
      d.circle(b.x, b.y, BR + 4, col + '77');
      d.circle(b.x, b.y, BR, '#1a1a1a', '#fff', 2);
    }

    // Tanks.
    v.t.forEach((tk, i) => {
      let alpha = 1;
      if (v.gh && tk.al) {
        alpha = clamp(tk.v, 0, 1);
        if (r.viewer === i) alpha = Math.max(alpha, 0.3); // on your own device you can see yourself faintly
        if (alpha <= 0.02) return;
      }
      const R = TANK_R;
      ctx.save();
      ctx.globalAlpha = alpha;
      if (!tk.al) {
        d.circle(tk.x, tk.y, R + 10, 'rgba(30,20,20,0.45)');
        for (let j = 0; j < 3; j++) d.circle(tk.x - 8 + j * 9, tk.y - R - 8 - ((t * 50 + j * 17) % 40), 9 - j * 2, 'rgba(90,90,90,0.5)');
        ctx.translate(tk.x, tk.y); ctx.rotate(tk.a + 0.4);
        d.rrect(-R, -R * 0.8, R * 2, R * 1.6, 7, '#3a3a3a', '#111', 2);
        d.rect(R * 0.3, -4, R * 0.9, 8, '#222');
        ctx.restore();
        d.avatar(tk.x, tk.y, 17, i, { mood: 'dead', look: tk.a });
        return;
      }
      d.shadow(tk.x + 4, tk.y + 8, R * 1.1, R * 0.85, 0.3 * alpha);
      ctx.translate(tk.x, tk.y); ctx.rotate(tk.a);
      const rc = tk.rc > 0 ? -7 : 0;
      const roll = tk.mv ? (t * 60) % 8 : 0;
      for (const sy of [-1, 1]) {
        d.rrect(-R * 1.08, sy * R * 0.64 - R * 0.3, R * 2.16, R * 0.6, 7, '#22222c', '#0d0d12', 2);
        for (let k = -3; k <= 3; k++) {
          const x = k * 8 + roll - 4;
          if (Math.abs(x) < R) d.rect(x - 1.5, sy * R * 0.64 - R * 0.26, 3, R * 0.52, '#474758');
        }
      }
      d.rrect(-R * 0.85, -R * 0.56, R * 1.7, R * 1.12, 9, d.col(i, 'main'), d.col(i, 'dark'), 3);
      d.rrect(-R * 0.7, -R * 0.48, R * 1.3, R * 0.3, 6, 'rgba(255,255,255,0.28)');
      d.rrect(R * 0.15 + rc, -6, R * 1.25, 12, 4, d.col(i, 'dark'), '#111', 2);
      d.rect(R * 1.25 + rc, -7.5, 7, 15, '#111');
      if (tk.rc > 0.04) {
        d.circle(R * 1.55 + rc, 0, 12 + 30 * tk.rc, '#fff3a0');
        d.circle(R * 1.55 + rc, 0, 7 + 18 * tk.rc, '#ffffff');
      }
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = alpha;
      let scared = false;
      for (const b of v.b) if (b.o !== i && (b.x - tk.x) ** 2 + (b.y - tk.y) ** 2 < 120 * 120) { scared = true; break; }
      d.avatar(tk.x, tk.y, 18, i, { look: tk.a, mood: scared ? 'scared' : v.pz ? 'happy' : 'angry', alpha });
      // Triple-shot ammo pips.
      for (let k = 0; k < tk.tri; k++) d.star(tk.x - 12 + k * 24, tk.y - R - 16, 9, '#ffd23f');
      // Shield bubble, or the cooldown arc.
      if (tk.sh > 0) {
        ctx.globalAlpha = alpha * (0.5 + 0.5 * tk.sh);
        d.circle(tk.x, tk.y, SHIELD_R, 'rgba(143,246,255,0.18)', '#8ff6ff', 5);
        d.arc(tk.x, tk.y, SHIELD_R - 7, t * 8, t * 8 + 1.6, '#ffffffcc', 4);
      } else if (tk.sc > 0) {
        d.arc(tk.x, tk.y, R + 11, -Math.PI / 2, -Math.PI / 2 + (1 - tk.sc) * Math.PI * 2, 'rgba(143,246,255,0.45)', 3);
      } else d.ring(tk.x, tk.y, R + 11, 'rgba(143,246,255,0.55)', 3);
      ctx.restore();
    });
  },
};
export default game;

// ---------- 3D helpers ----------
function hash(k) { const x = Math.sin(k * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

// Raked gravel paths, one tile per maze cell; a warm glow when the cannonballs catch fire.
function drawGravel(d, hot) {
  const { ctx } = d;
  const MW = N * CELL + 48, MX = M0 - 24;
  d.rect(MX, MX, MW, MW, '#9c8a66');
  for (let r0 = 0; r0 < N; r0++) for (let c = 0; c < N; c++) {
    const x = M0 + c * CELL, y = M0 + r0 * CELL, k = r0 * N + c;
    d.rect(x, y, CELL, CELL, (r0 + c) % 2 ? '#e2d1a8' : '#ead9b2');
    for (let j = 0; j < 14; j++) d.circle(x + 8 + hash(k * 31 + j) * (CELL - 16), y + 8 + hash(k * 17 + j) * (CELL - 16), 2 + hash(k + j * 7) * 3, hash(k * 3 + j) < 0.5 ? 'rgba(140,120,90,0.45)' : 'rgba(255,255,255,0.45)');
    for (let j = 1; j < 4; j++) d.line(x + 10, y + j * (CELL / 4), x + CELL - 10, y + j * (CELL / 4), 'rgba(160,140,100,0.18)', 2);
  }
  const vg = ctx.createRadialGradient(W / 2, H / 2, 150, W / 2, H / 2, 640);
  vg.addColorStop(0, hot ? 'rgba(255,140,60,0.10)' : 'rgba(255,255,255,0)');
  vg.addColorStop(1, hot ? 'rgba(255,90,30,0.32)' : 'rgba(90,60,30,0.2)');
  ctx.fillStyle = vg; ctx.fillRect(M0, M0, N * CELL, N * CELL);
}

// Royal garden at sunset: the golden castle and towers behind, a reflecting pool and the well on the left,
// a market stall and a pavilion on the right, tree avenues and a wooden fence in front, petals in the wind.
function buildGarden(K, hi) {
  // Flower beds all around the outer wall.
  const MX = M0 - 24, MW = N * CELL + 48, B0 = MX - 150, B1 = MX + MW + 150;
  K.layer({
    x0: B0, y0: B0, x1: B1, y1: B1, h: 0.25, once: true, transparent: true, maxPx: 1024,
    draw: (d) => {
      const band = (x, y, w, h) => d.rrect(x, y, w, h, 30, 'rgba(92,62,36,0.85)');
      band(B0 + 20, B0 + 20, B1 - B0 - 40, 100); band(B0 + 20, B1 - 120, B1 - B0 - 40, 100);
      band(B0 + 20, B0 + 20, 100, B1 - B0 - 40); band(B1 - 120, B0 + 20, 100, B1 - B0 - 40);
      const cols = ['#ff5c8a', '#ffd23f', '#ffffff', '#b07cff', '#ff8a3d'];
      for (let k = 0; k < 900; k++) {
        const side = k % 4, u = hash(k) * (B1 - B0 - 80) + B0 + 40, w = 30 + hash(k + 1) * 60;
        const x = side < 2 ? u : side === 2 ? B0 + 20 + w : B1 - 20 - w;
        const y = side < 2 ? (side === 0 ? B0 + 20 + w : B1 - 20 - w) : u;
        d.circle(x, y, 6 + hash(k + 2) * 5, hash(k + 3) < 0.35 ? '#3f8a3c' : cols[Math.floor(hash(k + 4) * cols.length)]);
      }
    },
  });
  K.place(K.model('medieval/building_castle_yellow', { height: 560 }), 450, -430);
  K.scatter('medieval/building_tower_B_yellow', [{ x: 90, y: -250, rot: 0.2 }, { x: 810, y: -250, rot: -0.2 }], { height: 300 });
  K.face(K.place(K.model('medieval/building_windmill_yellow', { height: 340 }), 1250, -330), -Math.PI / 2 + 0.4);
  K.place(K.model('medieval/building_home_A_yellow', { height: 170 }), -300, -260);
  K.place(K.model('medieval/building_tower_A_yellow', { height: 260 }), -420, 80);
  K.scatter('medieval/mountain_A_grass_trees', [{ x: -560, y: -950, rot: 0.4 }, { x: 1460, y: -950, rot: 2.2 }, { x: 450, y: -1250, rot: 1.2, s: 1.2 }], { size: 820 });
  K.scatter('medieval/hills_A_trees', [{ x: -900, y: 300, rot: 1 }, { x: -950, y: 900, rot: 2 }, { x: 1800, y: 300, rot: 3 }, { x: 1850, y: 900, rot: 4 }], { size: 600 });
  // Reflecting pool with water lilies, and the well.
  const rim = K.texMat('lastre', [6, 1], { color: '#e8dcc2' }), rimV = K.texMat('lastre', [1, 6], { color: '#e8dcc2' });
  const P0 = [-440, 230, -170, 720];
  if (!K.mockDraw) K.water(P0[0], P0[1], P0[2], P0[3], { h: 3, tile: 200, flow: [0.006, 0.01] }); // (K.water crashes headless)
  for (const [x, y, w, h, m] of [[(P0[0] + P0[2]) / 2, P0[1], P0[2] - P0[0] + 24, 24, rim], [(P0[0] + P0[2]) / 2, P0[3], P0[2] - P0[0] + 24, 24, rim], [P0[0], (P0[1] + P0[3]) / 2, 24, P0[3] - P0[1], rimV], [P0[2], (P0[1] + P0[3]) / 2, 24, P0[3] - P0[1], rimV]]) {
    K.place(K.box(w, h, 12, m), x, y, 6);
  }
  K.scatter('medieval/waterlily_A', [{ x: -380, y: 300, h: 4, rot: 1 }, { x: -230, y: 420, h: 4, rot: 2 }, { x: -340, y: 560, h: 4, rot: 3 }, { x: -220, y: 660, h: 4, rot: 4 }, { x: -300, y: 380, h: 4, rot: 5 }], { size: 40, ground: false });
  K.scatter('medieval/waterplant_B', [{ x: -425, y: 250, rot: 1 }, { x: -185, y: 700, rot: 2 }, { x: -430, y: 690, rot: 3 }], { size: 50 });
  K.place(K.model('medieval/building_well_yellow', { height: 130 }), -300, 860);
  // Right: market stall, pavilion, goods.
  K.face(K.place(K.model('medieval/building_market_yellow', { height: 170 }), 1100, 230), Math.PI);
  K.face(K.place(K.model('medieval/tent', { height: 160 }), 1140, 640), Math.PI);
  K.scatter('medieval/barrel', [{ x: 1010, y: 360, rot: 1 }, { x: 1040, y: 395, rot: 2 }, { x: 1180, y: 380, rot: 3 }, { x: -130, y: 1000, rot: 4 }], { size: 38 });
  K.scatter('medieval/sack', [{ x: 1010, y: 760, rot: 1 }, { x: 1050, y: 790, rot: 2 }, { x: 1230, y: 770, rot: 0.5 }], { size: 40 });
  K.scatter('medieval/crate_A_big', [{ x: 1210, y: 300, rot: 0.3 }, { x: 1060, y: 860, rot: 1.2 }], { size: 46 });
  // Tree avenues along the sides, a big wood behind them, a fence and low trees in front.
  const ave = [], wood = [], low = [];
  for (let k = 0; k < 8; k++) {
    ave.push({ x: -80, y: -60 + k * 140, rot: k, s: 0.9 + hash(k) * 0.2 });
    ave.push({ x: 980, y: -60 + k * 140 + 70, rot: k * 2, s: 0.9 + hash(k + 5) * 0.2 });
    wood.push({ x: -650 - hash(k + 1) * 120, y: -200 + k * 170, rot: k * 1.3, s: 0.9 + hash(k + 2) * 0.3 });
    wood.push({ x: 1450 + hash(k + 3) * 120, y: -150 + k * 170, rot: k * 2.3, s: 0.9 + hash(k + 4) * 0.3 });
    low.push({ x: -100 + k * 150 + hash(k + 9) * 40, y: 1080 + hash(k + 7) * 50, rot: k * 1.9, s: 0.8 + hash(k + 8) * 0.3 });
  }
  K.scatter('medieval/tree_single_A', ave, { height: 150 });
  K.scatter('medieval/trees_A_large', wood, { size: 320 });
  K.scatter('medieval/trees_A_medium', low, { size: 150 });
  const fence = [];
  for (let k = 0; k < 9; k++) fence.push({ x: -10 + k * 115, y: 965, rot: Math.PI / 2 });
  K.scatter('medieval/fence_wood_straight', fence, { size: 116 });
  K.light(450, -150, 200, '#ffc27a', 1.4, { dist: 900 });
  if (hi) K.light(-300, 470, 120, '#ffd9a0', 1.0, { dist: 500 });
  K.ambient('petali', { n: hi ? 70 : 35, h: 420 });
}

// ---------------------------------------------------------------- Bot ----------------------------------------------------------------
// Analytic ray tracing of cannonballs (slab test against the hedge rects grown by the ball radius, mirror bounces):
// incoming balls -> shield (or dodge); firing solutions (direct for everyone, 1 bounce for medio, 3 bounces + lead for
// difficile) that never hit ourselves; otherwise drive through the maze (cell BFS) toward the nearest rival or a crate.
const C_PEND = [0.34, 0.2, 0.09];
const C_BOUNCES = [0, 1, 3];
const C_RAYS = [6, 12, 20];
const C_RANGE = [420, 800, 1300];   // longest shot each level tries

function carriMem(B) {
  const m = B.mem;
  if (!m.init) {
    m.hx = new Float64Array(32); m.hy = new Float64Array(32); m.hn = 0;
    m.init = 1; m.last = []; m.vel = []; m.seen = []; m.rot = 0; m.sol = null; m.solT = -9;
    m.cq = new Int16Array(N * N); m.cd = new Int16Array(N * N); m.cp = new Int16Array(N * N);
  }
  return m;
}

// Trace a ball from (x, y) along (dx, dy) (unit) for `len`, mirror-bouncing at most maxB times.
// visit(ax, ay, bx, by, d0) is called for each straight piece (d0 = travelled distance at its start); true stops.
function carriTrace(s, x, y, dx, dy, len, maxB, visit) {
  let d0 = 0;
  for (let b = 0; b <= maxB && d0 < len; b++) {
    let best = len - d0, axis = -1;
    for (const R of s.walls) {
      const x0 = R[0] - BR, y0 = R[1] - BR, x1 = R[0] + R[2] + BR, y1 = R[1] + R[3] + BR;
      let txa, txb, tya, tyb;
      if (dx) { const a = (x0 - x) / dx, c = (x1 - x) / dx; txa = Math.min(a, c); txb = Math.max(a, c); }
      else if (x > x0 && x < x1) { txa = -Infinity; txb = Infinity; } else continue;
      if (dy) { const a = (y0 - y) / dy, c = (y1 - y) / dy; tya = Math.min(a, c); tyb = Math.max(a, c); }
      else if (y > y0 && y < y1) { tya = -Infinity; tyb = Infinity; } else continue;
      const te = Math.max(txa, tya), tx = Math.min(txb, tyb);
      if (te < tx && te > 1e-4 && te < best) { best = te; axis = txa > tya ? 0 : 1; }
    }
    const bx = x + dx * best, by = y + dy * best;
    if (visit(x, y, bx, by, d0)) return;
    d0 += best;
    if (axis < 0) return;
    if (axis === 0) dx = -dx; else dy = -dy;
    x = bx + dx * 0.01; y = by + dy * 0.01;
  }
}

// Distance from point (px, py) to segment a-b, and the projection parameter along it (in length units).
function segNear(ax, ay, bx, by, px, py) {
  const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy || 1;
  const u = clamp(((px - ax) * vx + (py - ay) * vy) / L2, 0, 1);
  const cx = ax + vx * u, cy = ay + vy * u;
  return { d: Math.hypot(px - cx, py - cy), along: u * Math.sqrt(L2) };
}

const cellOfT = (x, y) => clamp(Math.floor((y - M0) / CELL), 0, N - 1) * N + clamp(Math.floor((x - M0) / CELL), 0, N - 1);

// BFS over maze cells from `from`; fills m.cd (distance) and m.cp (previous cell).
function carriBfs(s, m, from) {
  m.cd.fill(-1);
  m.cd[from] = 0; m.cp[from] = -1; m.cq[0] = from;
  let h = 0, t = 1;
  while (h < t) {
    const c = m.cq[h++];
    for (const [e, o] of ADJ[c]) if (!s.w[e] && m.cd[o] < 0) { m.cd[o] = m.cd[c] + 1; m.cp[o] = c; m.cq[t++] = o; }
  }
}

function carriBot(s, me, g, B) {
  const m = carriMem(B);
  const out = carriThink(s, me, g, B, m);
  m.hx[m.hn % 32] = out.x; m.hy[m.hn % 32] = out.y; m.hn++;
  return out;
}

function carriThink(s, me, g, B, m) {
  const t = s.t[me], L = B.level;
  const out = { x: 0, y: 0 };
  if (!t || !t.alive || s.overT > 0) return out;
  const bv = BULLET_V * (s.turbo ? 1.4 : 1);
  const delay = C_PEND[L];

  // Rivals as the bot knows them (in "fantasma" only where it last saw them) + their velocity.
  const foes = [];
  for (const q of s.t) {
    if (q.i === me) continue;
    const last = m.last[q.i];
    if (last && q.alive) m.vel[q.i] = { x: (q.x - last.x) / (g.dt || 1 / 60), y: (q.y - last.y) / (g.dt || 1 / 60) };
    m.last[q.i] = { x: q.x, y: q.y };
    if (!q.alive) continue;
    if (!s.ghost || q.vis > 0 || !m.seen[q.i]) m.seen[q.i] = { x: q.x, y: q.y };
    const k = m.seen[q.i];
    foes.push({ i: q.i, x: k.x, y: k.y, vx: m.vel[q.i] ? m.vel[q.i].x : 0, vy: m.vel[q.i] ? m.vel[q.i].y : 0 });
  }

  // 1) Incoming balls.
  let threat = null;
  const reach = HIT_R + BR + 10;
  for (const b of s.b) {
    const sp = Math.hypot(b.vx, b.vy) || 1;
    const mine = b.o === me && b.safe;
    carriTrace(s, b.x, b.y, b.vx / sp, b.vy / sp, bv * 1.2, s.eterni ? 8 : Math.max(0, MAX_BOUNCE - b.n), (ax, ay, bx, by, d0) => {
      const r = segNear(ax, ay, bx, by, t.x, t.y);
      if (r.d < reach && !(mine && d0 + r.along < 60)) {
        const tt = (d0 + r.along) / bv;
        if (!threat || tt < threat.tt) threat = { tt, dx: (bx - ax), dy: (by - ay) };
        return true;
      }
      return false;
    });
  }
  if (threat && threat.tt < 0.45 + delay) {
    const useShield = L > 0 || B.rng() < 0.5;
    if (t.scd <= 0 && useShield && threat.tt > delay * 0.6) { out.tapB = true; return out; }
    // Dodge sideways (the side with room).
    const l = Math.hypot(threat.dx, threat.dy) || 1;
    let nx = -threat.dy / l, ny = threat.dx / l;
    const room = (sx, sy) => { for (const R of s.walls) if (circleRect(t.x + sx * 45, t.y + sy * 45, TANK_R, R[0], R[1], R[2], R[3])) return false; return true; };
    if (!room(nx, ny)) { nx = -nx; ny = -ny; }
    out.x = nx; out.y = ny;
    return out;
  }

  // 2) Firing solution: an angle whose ball hits a rival before it could hit us.
  const own = s.b.reduce((n, b) => n + (b.o === me ? 1 : 0), 0);
  const canFire = t.cd <= 0 && s.pause <= 0 && t.sh <= 0 && (t.tri > 0 || own < (s.eterni ? 3 : 4));
  const shotLen = bv * 2.2;
  const test = (ang, full) => {
    let hitD = Infinity, selfD = Infinity;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    carriTrace(s, t.x + dx * 10, t.y + dy * 10, dx, dy, shotLen, full ? MAX_BOUNCE : C_BOUNCES[L], (ax, ay, bx, by, d0) => {
      for (const f of foes) {
        const tt = d0 / bv + delay;
        const fx = f.x + (L === 2 ? f.vx * tt : 0), fy = f.y + (L === 2 ? f.vy * tt : 0);
        const r = segNear(ax, ay, bx, by, fx, fy);
        if (r.d < HIT_R + BR - 6 && d0 + r.along < hitD) hitD = d0 + r.along;
      }
      // Us, now and a little further along the hull (we may still be rolling). The first straight piece leaves
      // the barrel: if it bounces right in front of us, the ball comes straight back.
      if (d0 === 0) { if (hitD === Infinity && Math.hypot(bx - t.x, by - t.y) < 70) selfD = 0; }
      else {
        for (let k = 0; k < 2; k++) {
          const r = segNear(ax, ay, bx, by, t.x + Math.cos(t.a) * 50 * k, t.y + Math.sin(t.a) * 50 * k);
          if (r.d < HIT_R + BR + 32) selfD = Math.min(selfD, d0 + r.along);
        }
      }
      return hitD < Infinity && selfD < Infinity;
    });
    if (full === 2) return selfD; // safety check only
    return hitD < Infinity && selfD > hitD + (hitD < 160 ? 60 : 250) ? hitD : Infinity;
  };
  let sol = null;
  if (m.sol && g.t - m.solT < 0.6) { const d = test(m.sol.a); if (d < Infinity) sol = { a: m.sol.a, d }; }
  // Direct shots at each rival, then a fan of angles (rotating so every tick tries new ones).
  for (const f of foes) {
    const a = Math.atan2(f.y - t.y, f.x - t.x);
    const d = test(a);
    if (d < Infinity && (!sol || d < sol.d - 60)) sol = { a, d };
  }
  if (L > 0 && !sol) {
    const nR = C_RAYS[L];
    m.rot = (m.rot + 1) % 4;
    for (let k = 0; k < nR; k++) {
      const a = ((k + m.rot / 4) / nR) * Math.PI * 2;
      const d = test(a);
      if (d < Infinity && (!sol || Math.abs(angleDiff(t.a, a)) < Math.abs(angleDiff(t.a, sol.a)) - 0.2)) sol = { a, d };
    }
  }
  if (sol && sol.d > C_RANGE[L]) sol = null;
  if (sol) { m.sol = sol; m.solT = g.t; }
  const turnRate = Math.abs(angleDiff(m.prevA ?? t.a, t.a));
  m.prevA = t.a;
  if (sol && s.pause <= 0 && !(m.noAim > g.t)) {
    if (!(m.aimStart > 0)) m.aimStart = g.t;
    // The ball follows the hull (aim errors included): if the barrel as it is now scores, hold still and fire
    // once we have been still for our reaction time; otherwise keep turning (slow creep).
    if (test(t.a, 1) < Infinity) {
      if (!(m.holdSince > 0)) m.holdSince = g.t;
      if (canFire && g.t - m.holdSince > delay + 0.04 && turnRate < 0.01) { out.tapA = true; m.aimStart = 0; }
    } else {
      m.holdSince = 0;
      out.x = Math.cos(sol.a) * 0.22; out.y = Math.sin(sol.a) * 0.22;
    }
    // Cannot line it up: drive on for a while.
    if (m.aimStart && g.t - m.aimStart > 2) { m.noAim = g.t + 1.2; m.aimStart = 0; }
    return out;
  }
  m.aimStart = 0; m.holdSince = 0;

  // 3) Drive: toward a crate if close, else toward the nearest rival (stop once in its cell neighbourhood).
  // Plan from where the moves already on their way will take us (reaction delay).
  let px = t.x, py = t.y, pa = t.a;
  const dt = g.dt || 1 / 60;
  if (s.pause <= 0) {
    for (let j = Math.min(Math.round(delay * 60), m.hn); j >= 1; j--) {
      const h = (m.hn - j) % 32, hx = m.hx[h], hy = m.hy[h], mg = Math.min(1, Math.hypot(hx, hy));
      if (mg <= 0.2) continue;
      const want = Math.atan2(hy, hx);
      pa += clamp(angleDiff(pa, want), -TURN * dt, TURN * dt);
      const f = clamp((Math.cos(angleDiff(pa, want)) - 0.35) / 0.65, 0, 1);
      px += Math.cos(pa) * SPEED * mg * f * dt; py += Math.sin(pa) * SPEED * mg * f * dt;
    }
    px = clamp(px, M0 + TANK_R, M0 + N * CELL - TANK_R); py = clamp(py, M0 + TANK_R, M0 + N * CELL - TANK_R);
  }
  const myC = cellOfT(px, py);
  carriBfs(s, m, myC);
  let goal = -1, gd = Infinity, crate = null;
  for (const p of s.pk) { const c = cellOfT(p.x, p.y), d = m.cd[c]; if (d >= 0 && d < gd && d <= 3) { gd = d - 2; goal = c; crate = p; } }
  for (const f of foes) { const c = cellOfT(f.x, f.y), d = m.cd[c]; if (d >= 0 && d < gd) { gd = d; goal = c; crate = null; } }
  // Easy bot wanders when it has no plan.
  if (L === 0 && (goal < 0 || (m.wanderT > g.t))) {
    if (!(m.wanderT > g.t) && B.rng() < 0.003) { m.wanderT = g.t + 1.5; m.wc = (B.rng() * N * N) | 0; }
    if (m.wanderT > g.t) goal = m.wc;
  }
  if (crate && goal === myC) { // pick it up
    const dx = crate.x - px, dy = crate.y - py, d = Math.hypot(dx, dy) || 1;
    out.x = dx / d; out.y = dy / d;
    return out;
  }
  if (goal < 0 || goal === myC) {
    // Same cell: face the rival.
    if (foes.length) { const f = foes[0]; const a = Math.atan2(f.y - t.y, f.x - t.x); out.x = Math.cos(a) * 0.3; out.y = Math.sin(a) * 0.3; }
    return out;
  }
  let c = goal;
  while (m.cp[c] >= 0 && m.cp[c] !== myC) c = m.cp[c];
  if (m.cd[c] < 0) return out;
  const cx = cellX(c % N), cy = cellX((c / N) | 0), mx = cellX(myC % N), my = cellX((myC / N) | 0);
  // Stay on the corridor axis: first line up with our cell center across the direction of travel.
  let tx = cx, ty = cy;
  if (cx !== mx && Math.abs(py - my) > 22) { tx = mx + (cx - mx) * 0.3; ty = my; }
  else if (cy !== my && Math.abs(px - mx) > 22) { tx = mx; ty = my + (cy - my) * 0.3; }
  const dx = tx - px, dy = ty - py, d = Math.hypot(dx, dy) || 1;
  out.x = dx / d; out.y = dy / d;
  return out;
}
