// Lastre dei Nani — hexagon floor that crumbles under your feet (two layers) above the lava of a dwarven mine.
// Hex-A-Gone meets Tron, 2..4 players: last one standing wins.
import { clamp, damp, norm, collideCircles, r1, r2 } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500;
const S = 50;                         // hex circumradius (pointy-top)
const HW = Math.sqrt(3) * S, ROW = 1.5 * S;
const ARENA_R = 445;
const BODY_R = 30;
const ACCEL = 2600, MAX_SPEED = 330;
const HOP_T = 0.38, HOP_SPEED = 470, HOP_CD = 1.2;
const DROP_T = 0.4;
const MINE_CD = 5;
const SUDDEN_AT = 30;
// Forgiving start: no cracks during GRACE, then the crack delay shrinks from "early" to "late" by RAMP_END.
const GRACE = 2, RAMP_END = 12, LAND_SAFE = 0.9;
const CRACK_T = { normal: [1.0, 0.45], piombo: [0.5, 0.18] };
// Tile states (also the characters sent in the view).
const OK = 0, CRACK = 1, GONE = 2, GROW = 3, FUSE = 4, SPRING = 5;
// B: shove shockwave. Springs: comeback tiles on the lower floor that bounce you back upstairs.
const SHOVE_CD = 2.2, SHOVE_R = 175, SHOVE_V = 560;
const SPRING_FIRST = 7, SPRING_EVERY = 6;
const LOW = -120; // 3D: height of the lower floor
// Home side of each seat: 0 bottom, 1 top, 2 left, 3 right (position + initial facing).
const HOME = [[CX, CY + 270, 0, -1], [CX, CY - 270, 0, 1], [CX - 270, CY, 1, 0], [CX + 270, CY, -1, 0]];

// Point-symmetric hex lattice clipped to a circle (~10 columns).
const TILES = [];
for (let r = -7; r <= 7; r++) {
  const y = CY + r * ROW, off = (Math.abs(r) % 2) * HW / 2;
  for (let c = -8; c <= 8; c++) {
    const x = CX + c * HW + off;
    if (Math.hypot(x - CX, y - CY) <= ARENA_R - S * 0.5) TILES.push({ x, y });
  }
}
// Index of the point-mirrored tile (the lattice is symmetric around the center).
const MIRROR = TILES.map((t) => TILES.findIndex((q) => Math.abs(q.x - (W - t.x)) < 1 && Math.abs(q.y - (H - t.y)) < 1));
const HEX = Array.from({ length: 6 }, (_, k) => {
  const a = -Math.PI / 2 + (k * Math.PI) / 3;
  return { x: Math.cos(a), y: Math.sin(a) };
});

// Index of the tile under (x,y), or -1 if the point is off the floor.
function tileAt(x, y) {
  let best = -1, bd = S * S;
  for (let k = 0; k < TILES.length; k++) {
    const dx = TILES[k].x - x, dy = TILES[k].y - y, d2 = dx * dx + dy * dy;
    if (d2 < bd) { bd = d2; best = k; }
  }
  return best;
}

// Railing test: the point lies inside one of the hexagons (pointy-top: flat sides at 0°, ±60°).
const IN_R = (Math.sqrt(3) / 2) * S + 0.5;
function onFloor(x, y) {
  for (let k = 0; k < TILES.length; k++) {
    const dx = x - TILES[k].x, dy = y - TILES[k].y;
    if (Math.abs(dx) > IN_R || Math.abs(dy) > S) continue;
    if (Math.abs(dx * 0.5 + dy * 0.866) <= IN_R && Math.abs(-dx * 0.5 + dy * 0.866) <= IN_R) return true;
  }
  return false;
}

const solid = (st) => st === OK || st === CRACK || st === FUSE || st === SPRING;

function crack(s, layer, k, time) {
  const st = s.st[layer];
  if (st[k] === OK) { st[k] = CRACK; s.tm[layer][k] = time; }
}

export default {
  id: 'pavimento',
  name: 'Lastre dei Nani',
  rule: 'Le lastre crollano dopo di te: non finire nella lava!',
  verb: 'CORRI!',
  inspired: 'Fall Guys · Hex-A-Gone + Tron',
  cam: 'top',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Saltello', b: 'Spallata' },
  help: {
    goal: "Le lastre della miniera crollano poco dopo che ci passi sopra: l'ultimo che resta in piedi vince.",
    dir: 'Corri sulle lastre. Non restare fermo: la lastra sotto di te si crepa e cade!',
    a: 'SALTELLO: un balzo in avanti che scavalca i buchi (si ricarica in 1,2 s, anello attorno a te).',
    b: "SPALLATA: un'onda d'urto che spinge via chi ti sta vicino (ricarica 2,2 s). Con la Polvere Nera fa anche saltare le lastre attorno.",
    tips: ['Ci sono due piani: se cadi finisci al piano di sotto, poi nella lava', 'Le RUNE verdi del piano di sotto ti riportano su!', 'Spingi gli altri verso i buchi'],
  },
  duration: 50,
  supports: ['scale'],
  variants: [
    { id: 'piombo', name: 'Armatura di Piombo', desc: 'Le lastre crollano quasi subito!' },
    { id: 'ricrescita', name: 'Magia dei Nani', desc: 'Alcune lastre si ricostruiscono a caso' },
    { id: 'mina', name: 'Polvere Nera', desc: 'La spallata fa esplodere le lastre attorno a te!' },
  ],

  init(g) {
    const N = g.n || 2;
    const sc = g.mods.scale || new Array(N).fill(1);
    const n = TILES.length;
    return {
      st: [new Array(n).fill(OK), new Array(n).fill(OK)],
      tm: [new Array(n).fill(0), new Array(n).fill(0)],
      crackT: CRACK_T[g.variant === 'piombo' ? 'piombo' : 'normal'],
      growAt: 2, shakeAt: SUDDEN_AT, sudden: false, broke: 0, springAt: SPRING_FIRST,
      p: Array.from({ length: N }, (_, i) => ({
        i, x: HOME[i][0], y: HOME[i][1], vx: 0, vy: 0, fx: HOME[i][2], fy: HOME[i][3],
        r: BODY_R * (sc[i] ?? 1), m: (sc[i] ?? 1) ** 2, layer: 0, hop: 0, hcd: 0.3, drop: 0, kb: 0, mcd: 1, out: 0, bump: 0, run: 0, safe: 0, scd: 0.5, sw: 0,
      })),
    };
  },

  step(s, inp, g) {
    const dt = g.dt;
    const grace = g.t < GRACE;
    const [early, late] = s.crackT;
    const crackT = early + (late - early) * clamp((g.t - GRACE) / (RAMP_END - GRACE), 0, 1);

    // Tile timers.
    for (let L = 0; L < 2; L++) {
      const st = s.st[L], tm = s.tm[L];
      for (let k = 0; k < st.length; k++) {
        if (st[k] === OK || st[k] === GONE || st[k] === SPRING) continue;
        tm[k] -= dt;
        if (tm[k] > 0) continue;
        if (st[k] === GROW) { st[k] = OK; continue; }
        st[k] = GONE;
        if ((s.broke++ & 1) === 0) g.sfx('break', { vol: 0.25, pitch: L ? 0.7 : 1 + (k % 4) * 0.08 });
        g.burst(TILES[k].x, TILES[k].y, { color: L ? '#7a5cc7' : '#ffcf5c', n: 5, speed: 140, size: 7 });
      }
    }

    if (!g.ended) this.events(s, g);

    for (const p of s.p) {
      if (p.out > 0) { p.out = Math.min(9, p.out + dt); p.vx *= damp(0.1, dt); p.vy *= damp(0.1, dt); p.x += p.vx * dt * 0.4; p.y += p.vy * dt * 0.4; continue; }
      const n = inp[p.i];
      p.hcd = Math.max(0, p.hcd - dt);
      p.mcd = Math.max(0, p.mcd - dt);
      p.kb = Math.max(0, p.kb - dt);
      p.bump = Math.max(0, p.bump - dt);
      p.safe = Math.max(0, p.safe - dt);
      p.scd = Math.max(0, p.scd - dt);
      p.sw = Math.max(0, p.sw - dt);
      if (Math.hypot(n.x, n.y) > 0.2) { const d = norm(n.x, n.y); p.fx = d.x; p.fy = d.y; }

      if (p.drop > 0) {
        // Falling to the lower layer.
        p.drop -= dt;
        p.vx *= damp(0.05, dt); p.vy *= damp(0.05, dt);
        const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt;
        if (onFloor(nx, ny)) { p.x = nx; p.y = ny; } else { p.vx = 0; p.vy = 0; }
        if (p.drop <= 0) {
          p.layer = 1; p.drop = 0; p.safe = LAND_SAFE; // a moment to find your feet downstairs
          g.sfx('crash', { vol: 0.7 }); g.shake(0.35); g.vibrate(p.i, 120);
          g.burst(p.x, p.y, { color: '#7a5cc7', n: 14, speed: 220 });
        }
        continue;
      }

      if (!g.ended && n.aP && p.hcd <= 0 && p.hop <= 0) {
        p.hop = HOP_T; p.hcd = HOP_CD;
        p.vx = p.fx * HOP_SPEED; p.vy = p.fy * HOP_SPEED;
        g.sfx('jump', { pitch: 1.2 });
      }
      if (!g.ended && n.bP && p.scd <= 0) this.shove(s, g, p);

      if (p.hop > 0) {
        p.hop -= dt;
        if (p.hop <= 0) { g.sfx('land', { vol: 0.5 }); }
      } else if (p.kb > 0) {
        p.vx *= damp(0.08, dt); p.vy *= damp(0.08, dt);
      } else {
        p.vx += n.x * ACCEL * dt; p.vy += n.y * ACCEL * dt;
        const k = damp(0.004, dt);
        p.vx *= k; p.vy *= k;
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > MAX_SPEED) { p.vx *= MAX_SPEED / sp; p.vy *= MAX_SPEED / sp; }
      }
      const ox = p.x, oy = p.y;
      p.x += p.vx * dt; p.y += p.vy * dt;
      // Invisible railing along the jagged outline of the floor: you never walk off the edge,
      // you only fall through holes (slide along the rim when possible).
      if (!onFloor(p.x, p.y)) {
        if (onFloor(p.x, oy)) { p.y = oy; p.vy *= -0.2; }
        else if (onFloor(ox, p.y)) { p.x = ox; p.vx *= -0.2; }
        else { p.x = ox; p.y = oy; p.vx *= -0.2; p.vy *= -0.2; }
      }
      p.run += Math.hypot(p.x - ox, p.y - oy);
    }

    // Shoving: every pair on the same layer, both on their feet (a hopping player hits harder).
    for (let ia = 0; ia < s.p.length; ia++) for (let ib = ia + 1; ib < s.p.length; ib++) {
      const a = s.p[ia], b = s.p[ib];
      if (a.out || b.out || a.drop || b.drop || a.layer !== b.layer) continue;
      const A = { ...a, m: a.m * (a.hop > 0 ? 2.5 : 1) }, B = { ...b, m: b.m * (b.hop > 0 ? 2.5 : 1) };
      const impact = collideCircles(A, B, 1.4);
      if (impact > 0) {
        Object.assign(a, { x: A.x, y: A.y, vx: A.vx, vy: A.vy });
        Object.assign(b, { x: B.x, y: B.y, vx: B.vx, vy: B.vy });
        if (impact > 120) {
          a.kb = b.kb = 0.18;
          const hard = impact > 500;
          g.sfx(hard ? 'punch' : 'bonk', { pitch: hard ? 1 : 1.3 });
          g.burst((a.x + b.x) / 2, (a.y + b.y) / 2, { color: '#fff', n: hard ? 14 : 6, speed: hard ? 360 : 160 });
          if (hard) { g.shake(0.35); g.hitstop(0.05); a.bump = b.bump = 0.4; g.vibrate(a.i, 60); g.vibrate(b.i, 60); }
        }
      }
    }

    // Ground check: crack what you stand on, fall through holes.
    const losers = [];
    for (const p of s.p) {
      if (p.out || p.drop > 0 || p.hop > 0 || g.ended) continue;
      const k = tileAt(p.x, p.y);
      const st = s.st[p.layer];
      if (k < 0 || !solid(st[k])) {
        g.sfx('fall'); g.vibrate(p.i, 150);
        if (p.layer === 0) {
          p.drop = DROP_T;
          g.text(p.x, p.y - 60, 'GIÙ!', { player: p.i, size: 50 });
        } else losers.push(p);
        continue;
      }
      if (st[k] === SPRING && p.layer === 1) { this.spring(s, g, p, k); continue; }
      if (!grace && p.safe <= 0) crack(s, p.layer, k, crackT);
    }
    if (losers.length) {
      for (const p of losers) {
        p.out = 0.001;
        g.burst(p.x, p.y, { player: p.i, n: 24, speed: 300 });
        g.burst(p.x, p.y, { color: '#ff7a1a', n: 16, speed: 240 });
      }
      const alive = s.p.filter((p) => !p.out);
      if (alive.length <= 1) {
        // Everyone left fell on the very same tick: the timeout tiebreak among them.
        g.end(alive.length === 1 ? alive[0].i : this.best(s, losers), 'Giù nella lava!');
        g.sfx('lose', { vol: 0.6 }); g.shake(0.6); g.slowmo(0.3, 0.9);
      } else {
        g.say('NELLA LAVA!'); g.sfx('lose', { vol: 0.4 }); g.shake(0.5);
        for (const p of losers) g.text(p.x, p.y - 60, 'ELIMINATO!', { player: p.i, size: 46 });
      }
    }
  },

  // Timed events: regrowth, sudden-death tremors.
  events(s, g) {
    if (g.variant === 'ricrescita' && g.t >= s.growAt) {
      s.growAt = g.t + 0.45;
      const L = g.rng.chance(0.7) ? 0 : 1;
      const st = s.st[L];
      const k = g.rng.int(0, st.length - 1);
      if (st[k] === GONE) {
        st[k] = GROW; s.tm[L][k] = 1.1;
        g.sfx('grow', { vol: 0.3, pitch: 1.4 });
      }
    }
    if (g.t >= s.springAt) {
      s.springAt = g.t + SPRING_EVERY;
      // A mirrored pair of springs on the lower floor, under holes of the top floor.
      const lo = s.st[1], hi = s.st[0];
      const cand = [];
      for (let k = 0; k < TILES.length; k++) {
        const m = MIRROR[k];
        if (m > k && lo[k] === OK && lo[m] === OK && hi[k] === GONE && hi[m] === GONE) cand.push(k);
      }
      if (cand.length && !lo.includes(SPRING)) {
        const k = g.rng.pick(cand);
        lo[k] = lo[MIRROR[k]] = SPRING;
        g.sfx('boing', { vol: 0.5 }); g.sfx('powerup', { vol: 0.25, pitch: 1.6 });
        for (const q of [k, MIRROR[k]]) g.ring(TILES[q].x, TILES[q].y, { color: '#5cff8a', r: 70 });
      }
    }
    if (g.t >= s.shakeAt) {
      if (!s.sudden) { s.sudden = true; g.say('LA MINIERA TREMA!'); g.sfx('wobble'); g.shake(0.4); }
      s.shakeAt = g.t + Math.max(0.08, 0.3 - (g.t - SUDDEN_AT) * 0.012);
      const L = g.rng.chance(0.5) ? 0 : 1;
      crack(s, L, g.rng.int(0, TILES.length - 1), 0.6);
    }
  },

  // B: shockwave that shoves a nearby rival on the same floor.
  shove(s, g, p) {
    p.scd = g.variant === 'mina' ? MINE_CD : SHOVE_CD; p.sw = 0.3;
    if (g.variant === 'mina') { this.mine(s, g, p); return; }
    g.sfx('whoosh', { pitch: 0.8 }); g.sfx('punch', { vol: 0.5, pitch: 0.7 });
    g.ring(p.x, p.y, { player: p.i, r: SHOVE_R });
    for (const o of s.p) {
      if (o === p) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (!o.out && !o.drop && o.layer === p.layer && d < SHOVE_R && d > 0) {
        const k = SHOVE_V * (1 - (d / SHOVE_R) * 0.4) / Math.sqrt(o.m);
        o.vx = ((o.x - p.x) / d) * k; o.vy = ((o.y - p.y) / d) * k; o.kb = 0.28; o.bump = 0.5;
        g.burst(o.x, o.y, { color: '#fff', n: 12, speed: 260 }); g.shake(0.3); g.hitstop(0.04); g.vibrate(o.i, 100);
      }
    }
  },

  // Lower-floor spring: launches you back to the top floor and rebuilds the tile you land on.
  spring(s, g, p, k) {
    s.st[1][k] = OK;
    p.layer = 0; p.hop = HOP_T * 1.4; p.safe = LAND_SAFE; p.vx *= 0.3; p.vy *= 0.3;
    const top = tileAt(p.x, p.y);
    if (top >= 0) { s.st[0][top] = OK; s.tm[0][top] = 0; }
    g.sfx('boing'); g.sfx('powerup', { vol: 0.5 });
    g.say('RUNA MAGICA! DI NUOVO SU!');
    g.burst(p.x, p.y, { color: '#5cff8a', n: 20, speed: 300 });
    g.text(p.x, p.y - 70, 'SU!', { player: p.i, size: 50 });
  },

  // Mina: the ring of tiles around you starts a short fuse; shoves a nearby rival.
  mine(s, g, p) {
    p.mcd = MINE_CD;
    const st = s.st[p.layer], tm = s.tm[p.layer];
    for (let k = 0; k < TILES.length; k++) {
      const d = Math.hypot(TILES[k].x - p.x, TILES[k].y - p.y);
      if (d > S * 0.6 && d < HW * 1.25 && (st[k] === OK || st[k] === CRACK)) { st[k] = FUSE; tm[k] = 0.3; }
    }
    g.sfx('fuse'); g.sfx('explode', { vol: 0.7 });
    g.ring(p.x, p.y, { color: '#ff5a1f', r: HW * 1.4 });
    g.burst(p.x, p.y, { color: '#ff7a00', n: 20, speed: 320 });
    g.shake(0.4);
    for (const o of s.p) {
      if (o === p) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (!o.out && !o.drop && o.layer === p.layer && d < 190 && d > 0) {
        o.vx = ((o.x - p.x) / d) * 520; o.vy = ((o.y - p.y) / d) * 520; o.kb = 0.25; o.bump = 0.5;
        g.vibrate(o.i, 120);
      }
    }
  },

  // Best of a group of players: upper floor, then more solid tiles nearby, then the more active runner.
  best(s, group) {
    const near = (p) => {
      let n = 0;
      const st = s.st[p.layer];
      for (let k = 0; k < TILES.length; k++) if (st[k] === OK && Math.hypot(TILES[k].x - p.x, TILES[k].y - p.y) < 180) n++;
      return n;
    };
    const score = group.map((p) => ({ p, l: p.layer, n: near(p), run: p.run }));
    score.sort((A, B) => A.l - B.l || B.n - A.n || B.run - A.run);
    if (score.length > 1) {
      const [A, B] = score;
      if (A.l === B.l && A.n === B.n && Math.abs(A.run - B.run) <= 1) return -1;
    }
    return score.length ? score[0].p.i : -1;
  },

  timeout(s) {
    const alive = s.p.filter((p) => !p.out);
    return this.best(s, alive.length ? alive : s.p);
  },

  view(s) {
    return {
      t: s.st.map((st) => st.join('')),
      sd: s.sudden ? 1 : 0,
      p: s.p.map((p) => ({
        x: r1(p.x), y: r1(p.y), r: r1(p.r), l: p.layer, h: r2(Math.max(0, p.hop) / HOP_T), hc: r2(p.hcd / HOP_CD),
        dr: r2(p.drop / DROP_T), o: r2(p.out), fx: r2(p.fx), fy: r2(p.fy), mc: r2(p.scd), bu: r2(p.bump), sw: r2(p.sw),
      })),
      hud: { p: s.p.map((p) => (p.out ? 0 : 2 - p.layer)), max: 2, label: 'Piani' },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  bot(s, me, g, B) { return pavBot(s, me, g, B); },

  // 3D: a floating hex floor in the heart of a dwarven mine, above a sea of lava. Rocky cliffs and mine
  // ledges all around, a colonnade of dwarven pillars with banners in the back, torches and rising embers.
  render3d: {
    cam: { tilt: 0.5 },
    assets: [
      'medieval/mountain_A', 'medieval/mountain_C', 'medieval/rock_single_C', 'medieval/rock_single_D', 'medieval/resource_stone',
      'medieval/building_mine_yellow', 'medieval/building_mine_red', 'medieval/barrel', 'medieval/crate_A_big', 'medieval/tent',
      'dungeon/torch_lit', 'dungeon/coin_stack_large', 'dungeon/coin_stack_medium', 'dungeon/crates_stacked', 'dungeon/keg',
      'dungeon/banner_patternA_red', 'dungeon/banner_patternB_blue', 'dungeon/banner_patternC_green', 'dungeon/banner_patternA_yellow',
      'weapons/axe_2handed',
    ],
    build(K) {
      const T = K.THREE, lo = K.quality === 0;
      K.theme('grotta', { fogNear: 1.5, fogFar: 4.6 });
      K.hemi.intensity = 0.95; K.sun.intensity = 1.7; // a bit brighter than a plain cave: the floor must read well
      K.light(CX, CY + 150, 420, '#ffe2b0', 1.3, { dist: 1100 });
      const n = TILES.length;
      const o = { D: new T.Object3D(), prev: ['', ''], fall: [new Float32Array(n).fill(-9), new Float32Array(n).fill(-9)], alpha: 1 };
      // --- The lava sea far below, its glow and the embers rising from it ---
      // (K.water needs a canvas texture: skipped in headless tests, where K.tex returns null.)
      if (K.tex('lava')) K.water(-2600, -2600, W + 2600, H + 2600, { kind: 'lava', h: -900, tile: 420, flow: [0.005, 0.011] });
      K.light(CX, CY, -430, '#ff6a1a', 2.4, { dist: 1500, flicker: 0.2 });
      K.ambient('braci', { n: lo ? 50 : 90, h: 650, x0: -500, y0: -500, x1: W + 500, y1: H + 500 });
      // --- Far mountains behind the cavern (far side only, so nothing covers the floor) ---
      const rnd = (k) => { const x = Math.sin(k * 127.1 + 31.7) * 43758.5453; return x - Math.floor(x); };
      const far = [[], []];
      for (let k = 0; k < 8; k++) {
        const a = -Math.PI * (0.06 + 0.88 * (k / 7));
        const rr = 1650 + rnd(k + 9) * 400;
        far[k % 2].push({ x: CX + Math.cos(a) * rr * 1.25, y: CY + Math.sin(a) * rr, h: -900, rot: rnd(k + 3) * 6.28, s: 0.8 + rnd(k + 5) * 0.5 });
      }
      K.scatter('medieval/mountain_A', far[0], { height: 1300 });
      K.scatter('medieval/mountain_C', far[1], { height: 1300 });
      // --- Basalt columns rising out of the lava all around (low on the camera side) ---
      const basalt = K.texMat('pietra', [1, 5], { color: '#5e4a40', rough: 0.95 });
      const capB = K.mat('#3e302a', { rough: 1, flat: true });
      const NB = lo ? 16 : 30;
      for (let k = 0; k < NB; k++) {
        const a = (k / NB) * Math.PI * 2 + rnd(k) * 0.15;
        const sn = Math.sin(a);
        const rr = 880 + rnd(k + 20) * 520 + (sn > 0 ? 220 : 0);
        const top = sn > 0.3 ? -340 + rnd(k + 7) * 90 : sn > -0.3 ? -230 + rnd(k + 7) * 170 : -120 + rnd(k + 7) * 320;
        const cr = 38 + rnd(k + 11) * 46;
        const col = K.cyl(1, 1, basalt, { seg: 6 });
        K.place(col, CX + Math.cos(a) * rr * 1.2, CY + sn * rr, -900);
        col.scale.set(cr, top + 900, cr);
        col.rotation.y = rnd(k + 2) * 3;
        const cp = K.cyl(1, 1, capB, { seg: 6 });
        K.place(cp, CX + Math.cos(a) * rr * 1.2, CY + sn * rr, top);
        cp.scale.set(cr * 1.05, 10, cr * 1.05);
        cp.rotation.y = col.rotation.y;
      }
      // --- Mine ledges: flat rock pillars with the dwarves' stuff on top ---
      const rock = K.texMat('pietra', [3, 6], { color: '#7a6658', rough: 0.95 });
      const LEDGES = [[-300, 430, 170], [1300, 560, 170], [40, -230, 150], [960, -230, 150], [500, -470, 190]];
      for (const [x, y, rr] of LEDGES) {
        const pil = K.cyl(rr, 860, rock, { r2: rr * 0.55, seg: 9 });
        K.place(pil, x, y, -900);
        pil.receiveShadow = true;
        K.place(K.cyl(rr + 6, 14, K.mat('#5b4a40', { rough: 1, flat: true }), { seg: 9 }), x, y, -46);
      }
      K.place(K.face(K.model('medieval/building_mine_yellow', { size: 300 }), Math.PI / 2), 500, -470, -32);
      K.place(K.face(K.model('medieval/building_mine_red', { size: 230 }), 0), -300, 400, -32);
      K.place(K.face(K.model('medieval/tent', { size: 95 }), Math.PI), 1340, 500, -32);
      K.scatter('dungeon/coin_stack_large', [{ x: 960, y: -250, h: -32, rot: 0.4 }, { x: 1250, y: 640, h: -32, rot: 2 }], { size: 110 });
      K.scatter('dungeon/coin_stack_medium', [{ x: 1010, y: -190, h: -32, rot: 1 }, { x: 60, y: -170, h: -32 }, { x: -230, y: 520, h: -32, rot: 3 }], { size: 70 });
      K.scatter('dungeon/crates_stacked', [{ x: 20, y: -260, h: -32, rot: 0.3 }, { x: 1360, y: 610, h: -32, rot: 1.2 }], { size: 110 });
      K.scatter('dungeon/keg', [{ x: 900, y: -270, h: -32, rot: 1 }, { x: -360, y: 520, h: -32 }], { size: 70 });
      K.scatter('medieval/barrel', [{ x: 90, y: -280, h: -32 }, { x: 110, y: -235, h: -32, rot: 1 }, { x: 1230, y: 480, h: -32 }, { x: -240, y: 330, h: -32, rot: 2 }], { size: 46 });
      K.scatter('medieval/resource_stone', [{ x: 600, y: -420, h: -32 }, { x: 420, y: -540, h: -32, rot: 2 }, { x: 1020, y: -160, h: -32, rot: 1 }], { size: 90 });
      K.place(K.face(K.model('weapons/axe_2handed', { height: 90 }), 0.3), 640, -400, -32);
      // Glowing crystals growing on the cliffs and ledges (cold color against the warm lava).
      const crys = [K.mat('#7af0ff', { emissive: '#3fd8ff', ei: 0.9, rough: 0.2, flat: true }), K.mat('#e08aff', { emissive: '#b04aff', ei: 0.9, rough: 0.2, flat: true })];
      const CR = [[-350, 360, 0], [-230, 470, 1], [1240, 470, 1], [1350, 640, 0], [-30, -200, 1], [1030, -290, 0], [400, -420, 0], [620, -520, 1]];
      if (!lo) CR.forEach(([x, y, c], k) => {
        for (let j = 0; j < 3; j++) {
          const cr = K.cone(10 + j * 4, 60 + j * 26, crys[c], { seg: 6 });
          K.place(cr, x + (j - 1) * 16, y + ((j * 7) % 5) * 4, -34);
          cr.rotation.set((j - 1) * 0.35, k, (j - 1) * 0.3);
        }
      });
      // Torches on the ledges (real flickering lights on the two near the arena).
      K.scatter('dungeon/torch_lit', LEDGES.map(([x, y, rr], k) => ({ x: x + (k % 2 ? -1 : 1) * rr * 0.55, y: y + rr * 0.5, h: -32 })), { height: 80 });
      o.flames = LEDGES.map(([x, y, rr], k) => {
        const f = K.ball(9, K.glow('#ffb347', { add: true, unique: true, opacity: 0.85 }), { cast: false, seg: 8 });
        K.place(f, x + (k % 2 ? -1 : 1) * rr * 0.55, y + rr * 0.5, 40);
        return f;
      });
      if (!lo) {
        K.light(-300 + 90, 430 + 85, 60, '#ffa040', 1.6, { dist: 650, flicker: 0.5 });
        K.light(1300 - 90, 560 + 85, 60, '#ffa040', 1.6, { dist: 650, flicker: 0.5 });
      }
      // --- The dwarven colonnade in the back: brick pillars with huge hanging banners ---
      const brick = K.texMat('muro', [2, 10], { color: '#8a7a6c' });
      const capM = K.mat('#6e6054', { rough: 0.9, flat: true });
      const BAN = ['dungeon/banner_patternA_red', 'dungeon/banner_patternB_blue', 'dungeon/banner_patternC_green', 'dungeon/banner_patternA_yellow'];
      const cols = lo ? [-350, 500, 1350] : [-600, -170, 260, 740, 1170, 1600];
      cols.forEach((x, k) => {
        const y = -820 - (k % 2) * 90;
        K.place(K.cyl(78, 2000, brick, { seg: 12 }), x, y, -900);
        K.place(K.cyl(105, 40, capM, { seg: 8 }), x, y, 1060);
        K.place(K.cyl(105, 40, capM, { seg: 8 }), x, y, -40);
        K.place(K.model(BAN[k % 4], { height: 520 }), x, y + 30, 360);
      });
      // --- Two floors of hexagonal slabs (instanced: one mesh for the bodies, one for the lighter caps) ---
      const slab = K.tex('lastre', { rep: [1, 1], seed: 4 });
      const body = new T.CylinderGeometry(S * 0.95, S * 0.82, 30, 6).translate(0, -15, 0);
      const cap = new T.CylinderGeometry(S * 0.62, S * 0.68, 4, 6).translate(0, 1.5, 0);
      o.fl = [0, 1].map((L) => {
        const mk = (geo, rough, map) => {
          const m = new T.InstancedMesh(geo, new T.MeshStandardMaterial({ color: '#ffffff', map, roughness: rough, flatShading: true, emissive: L ? '#1a1238' : '#4a2300', emissiveIntensity: L ? 0.45 : 0.3 }), n);
          m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
          for (let k = 0; k < n; k++) m.setColorAt(k, new T.Color('#ffffff'));
          K.root.add(m);
          return m;
        };
        return { body: mk(body, 0.85, slab), cap: mk(cap, 0.6, null) };
      });
      // Top-floor tiles right above a downstairs player: drawn only as a crisp hex outline
      // (no body), so the player below stays fully visible and the tile shape stays readable.
      const ring = new T.TorusGeometry(S * 0.9, 3, 4, 6).rotateZ(Math.PI / 2).rotateX(-Math.PI / 2).translate(0, 1.5, 0);
      o.ghost = new T.InstancedMesh(ring, new T.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false }), n);
      o.ghost.frustumCulled = false; o.ghost.renderOrder = 3;
      for (let k = 0; k < n; k++) o.ghost.setColorAt(k, new T.Color('#ffffff'));
      K.root.add(o.ghost);
      o.low = new Float32Array(12); o.nLow = 0;
      o.HID = new T.Matrix4().compose(new T.Vector3(0, -2000, 0), new T.Quaternion(), new T.Vector3(1e-4, 1e-4, 1e-4));
      const C = (c) => new T.Color(c);
      // Per-tile tint jitter (stone slabs are never all the same).
      o.tint = [0, 1].map((L) => Array.from({ length: n }, (_, k) => 0.86 + 0.14 * (((k * 7919 + L * 104729) % 97) / 97)));
      o.tc = new T.Color();
      o.C = {
        body: [C('#d6ae72'), C('#55608a')], cap: [C('#f3dba4'), C('#8592c4')],
        crA: [C('#ffb27a'), C('#c9a8ff')], crB: [C('#ff5a12'), C('#9a3fc0')],
        fuA: C('#ff2d2d'), fuB: C('#ffd23f'), spA: C('#8dffb0'), spB: C('#3fd96e'), grow: [C('#fff1c8'), C('#a8b2e0')],
      };
      // Magic runes on the lower floor: bouncing green arrows over a glowing circle.
      o.springs = [0, 1].map(() => {
        const g = K.group();
        const arrow = K.group(g);
        K.cyl(8, 22, K.mat('#ffffff', { emissive: '#3fd96e', ei: 0.6 }), { parent: arrow });
        K.cone(20, 24, K.mat('#ffffff', { emissive: '#3fd96e', ei: 0.6 }), { parent: arrow }).position.y = 22;
        K.torus(30, 4, K.glow('#5cff8a'), { parent: g, cast: false });
        K.disc(38, K.glow('#5cff8a', { opacity: 0.35, add: true }), { parent: g, r0: 33 }).position.y = 2;
        return { g, arrow };
      });
      // Sudden-death warning ring around the arena.
      o.sudden = K.torus(ARENA_R + 12, 5, K.glow('#ff3b3b', { unique: true }), { cast: false });
      // Players.
      o.pl = Array.from({ length: Math.max(2, K.n || 2) }, (_, i) => ({
        av: K.avatar(i),
        dec: K.decal(160),
        ghost: K.decal(140, { opacity: 0.9 }).paint((d) => { d.ring(0, 0, BODY_R + 8, d.col(i, 'light'), 6); d.ring(0, 0, BODY_R + 18, d.col(i) + '88', 3); }),
        wave: K.torus(1, 0.06, K.glow(K.col(i, 'light'), { opacity: 0.8, unique: true }), { cast: false }),
        px: null, py: 0, walk: 0,
      }));
      return o;
    },
    update(K, o, v, r) {
      const D = o.D, t = K.t, n = TILES.length, mina = r.variant === 'mina';
      const blink = Math.floor(t * 12) % 2 === 0;
      const players = v.p;
      const someoneBelow = players.some((p) => !(p.o > 0) && (p.l === 1 || p.dr > 0));
      const allBelow = players.every((p) => p.l === 1 || p.dr > 0 || p.o > 0);
      // Top floor gets see-through when someone is downstairs.
      const alpha = allBelow ? 0 : someoneBelow ? 0.8 : 1;
      // Downstairs players (x, y, r): the top-floor tiles over them (and along the line of sight to the
      // tilted camera, which looks from +y) turn into outlines.
      o.nLow = 0;
      if (!allBelow) for (const p of players) if (p.l === 1 && !(p.o > 0) && o.nLow < 4) { o.low[o.nLow * 3] = p.x; o.low[o.nLow * 3 + 1] = p.y; o.low[o.nLow * 3 + 2] = p.r; o.nLow++; }
      if (alpha !== o.alpha) {
        o.alpha = alpha;
        for (const m of [o.fl[0].body.material, o.fl[0].cap.material]) { m.transparent = alpha < 1; m.opacity = alpha; m.needsUpdate = true; }
        o.fl[0].body.castShadow = o.fl[0].cap.castShadow = alpha >= 1;
        // With everyone downstairs the top floor no longer matters: hide it.
        o.fl[0].body.visible = o.fl[0].cap.visible = alpha > 0;
      }
      for (let L = 0; L < 2; L++) {
        const str = v.t[L], prev = o.prev[L], F = o.fl[L], fall = o.fall[L];
        const base = L === 0 ? 0 : LOW;
        for (let k = 0; k < n; k++) {
          const st = str.charCodeAt(k) - 48;
          if (prev && st === GONE && prev.charCodeAt(k) - 48 !== GONE) fall[k] = t;
          let x = TILES[k].x, y = TILES[k].y, h = base, sc = 1, rx = 0, rz = 0, show = true;
          let cb = o.C.body[L], cc = o.C.cap[L];
          if (st === GONE) {
            const q = t - fall[k];
            if (q >= 0 && q < 1.1) { h = base - 700 * q * q; sc = 1 - q * 0.5; rx = q * 2.5 * ((k % 2) - 0.5); rz = q * 2 * ((k % 3) - 1); cb = cc = o.C.crB[L]; }
            else show = false;
          } else if (st === CRACK) {
            x += Math.sin(t * 55 + k) * 2.5; y += Math.cos(t * 47 + k * 3) * 2.5; h += Math.sin(t * 40 + k) * 1.5;
            cb = cc = blink ? o.C.crA[L] : o.C.crB[L];
          } else if (st === FUSE) {
            x += Math.sin(t * 70 + k) * 4; y += Math.cos(t * 61 + k) * 4;
            cb = cc = blink ? o.C.fuA : o.C.fuB;
          } else if (st === SPRING) {
            cb = cc = blink ? o.C.spA : o.C.spB;
          } else if (st === GROW) {
            sc = 0.5 + 0.4 * ((t * 2) % 1); cb = cc = o.C.grow[L];
          }
          let over = false;
          if (L === 0 && show && st !== GONE) {
            for (let j = 0; j < o.nLow; j++) {
              const dx = TILES[k].x - o.low[j * 3], dy = TILES[k].y - o.low[j * 3 + 1];
              const dyc = dy < 0 ? dy : dy > 66 ? dy - 66 : 0; // capsule from the feet toward the camera
              const rr = o.low[j * 3 + 2] + S * 1.7;
              if (dx * dx + dyc * dyc < rr * rr) { over = true; break; }
            }
          }
          if (show) { D.position.set(x, h, y); D.rotation.set(rx, 0, rz); D.scale.set(sc, sc, sc); }
          else { D.position.set(0, -2000, 0); D.rotation.set(0, 0, 0); D.scale.set(1e-4, 1e-4, 1e-4); }
          D.updateMatrix();
          if (L === 0) { o.ghost.setMatrixAt(k, over ? D.matrix : o.HID); o.ghost.setColorAt(k, cc); }
          const M = over ? o.HID : D.matrix;
          F.body.setMatrixAt(k, M); F.cap.setMatrixAt(k, M);
          if (st === OK) { const q = o.tint[L][k]; F.body.setColorAt(k, o.tc.copy(cb).multiplyScalar(q)); F.cap.setColorAt(k, o.tc.copy(cc).multiplyScalar(0.5 + q * 0.5)); }
          else { F.body.setColorAt(k, cb); F.cap.setColorAt(k, cc); }
        }
        o.prev[L] = str;
        for (const m of (L === 0 ? [F.body, F.cap, o.ghost] : [F.body, F.cap])) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
      }
      // Runes.
      let sp = 0;
      for (let k = 0; k < n && sp < 2; k++) {
        if (v.t[1].charCodeAt(k) - 48 !== SPRING) continue;
        const S2 = o.springs[sp++];
        S2.g.visible = true;
        K.place(S2.g, TILES[k].x, TILES[k].y, LOW + 3);
        S2.arrow.position.y = Math.abs(Math.sin(t * 6)) * 18;
        S2.g.rotation.y = t * 1.5;
      }
      for (; sp < 2; sp++) o.springs[sp].g.visible = false;
      o.flames.forEach((f, k) => f.scale.setScalar(1 + 0.25 * Math.sin(t * 17 + k * 2)));
      o.sudden.visible = !!v.sd;
      if (v.sd) { K.place(o.sudden, CX, CY, 2); o.sudden.material.opacity = blink ? 1 : 0.35; o.sudden.material.transparent = true; }
      // Players.
      players.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const look = Math.atan2(p.fy, p.fx);
        const base = p.l === 1 ? LOW : 0;
        // Running speed from the motion between frames (the view has no velocity).
        if (P.px !== null && K.dt > 0) {
          const spd = Math.hypot(p.x - P.px, p.y - P.py) / K.dt;
          P.walk += (clamp(spd / MAX_SPEED, 0, 1) - P.walk) * clamp(K.dt * 10, 0, 1);
        }
        P.px = p.x; P.py = p.y;
        P.wave.visible = false;
        // Downstairs: a marker on the top floor shows where you are under it.
        P.ghost.show(p.l === 1 && !p.o && !p.dr && !allBelow);
        if (p.l === 1 && !allBelow) { P.ghost.at(p.x, p.y, 3); P.ghost.mesh.scale.setScalar(p.r / BODY_R); }
        if (p.o > 0) {
          P.dec.show(false);
          if (p.o < 1.1) {
            // Into the lava.
            const k = Math.max(0, 1 - p.o / 1.1);
            P.av.set(p.x, p.y, { r: p.r * (0.7 + 0.3 * k), h: base - p.o * p.o * 780, mood: 'scared', alpha: 1, look: look + p.o * 8 });
          } else {
            // Eliminated: a ghost spectator floating over its home side, outside the floor.
            const hx = HOME[i] ? HOME[i][2] : 0, hy = HOME[i] ? HOME[i][3] : -1;
            const k = clamp((p.o - 1.1) / 0.6, 0, 1);
            P.av.set(CX - hx * 500, CY - hy * 500, { r: BODY_R * 0.9, h: 90 + Math.sin(t * 2 + i) * 12, look: Math.atan2(hy, hx), alpha: 0.42 * k, anim: 'Cheer', animSpeed: 0.6, marker: false });
          }
          return;
        }
        if (p.dr > 0) {
          const q = 1 - p.dr;
          P.av.set(p.x, p.y, { r: p.r, h: LOW * q * q, mood: 'scared', look, squash: -0.2 });
          P.dec.show(false);
          return;
        }
        const z = p.h > 0 ? Math.sin(Math.PI * (1 - p.h)) : 0;
        const mood = p.bu > 0 ? 'hurt' : p.l === 1 && P.walk < 0.12 ? 'scared' : 'ok';
        const anim = p.sw > 0 ? '2H_Melee_Attack_Spin' : z > 0 ? 'Jump_Full_Short' : undefined;
        P.av.set(p.x, p.y, { r: p.r, h: base + z * 55, look, mood, walk: P.walk, anim, animSpeed: z > 0 ? 1.4 : undefined, animKey: p.sw > 0 ? 'sw' : z > 0 ? 'hop' : undefined });
        P.dec.show(true).at(p.x, p.y, base + 2.5).paint((d) => {
          if (p.hc <= 0) d.ring(0, 0, p.r + 12, d.col(i, 'light') + 'dd', 5);
          else d.arc(0, 0, p.r + 12, -Math.PI / 2, -Math.PI / 2 + (1 - p.hc) * Math.PI * 2, d.col(i, 'light') + '88', 5);
          if (p.mc <= 0) d.circle(p.r * 0.95 + 6, -p.r * 0.95 - 6, 10, mina ? '#ff5a1f' : '#ffffff', d.col(i, 'dark'), 3);
        });
        if (p.sw > 0) {
          const k = 1 - p.sw / 0.3;
          P.wave.visible = true;
          K.place(P.wave, p.x, p.y, base + 20);
          P.wave.scale.setScalar(40 + (SHOVE_R - 40) * k);
          P.wave.material.opacity = 0.9 * (1 - k) + 0.1;
        }
      });
    },
  },

  render(d, v, r) {
    const { ctx } = d;
    const t = d.t;
    // Abyss: the lava glowing far below, with heat rings and drifting embers.
    const ab = ctx.createRadialGradient(CX, CY, 20, CX, CY, 760);
    ab.addColorStop(0, '#ff6a12'); ab.addColorStop(0.5, '#8a1e06'); ab.addColorStop(1, '#2a0a04');
    ctx.fillStyle = ab;
    ctx.fillRect(-300, -300, W + 600, H + 600);
    for (let k = 0; k < 6; k++) {
      const ph = (t * 0.25 + k / 6) % 1;
      d.ring(CX, CY, 640 * (1 - ph), `rgba(255,170,60,${0.16 * ph})`, 6);
    }
    for (let k = 0; k < 18; k++) {
      const a = k * 2.39996 + t * 0.15, ph = (t * 0.2 + k * 0.137) % 1, rr = 620 * (1 - ph);
      d.circle(CX + Math.cos(a) * rr, CY + Math.sin(a) * rr, 2 + 3 * (1 - ph), `rgba(255,220,140,${0.5 * ph})`);
    }

    const blink = Math.floor(t * 12) % 2 === 0;
    const hexPath = (L, want, scale = 0.93, ox = 0, oy = 0) => {
      const str = v.t[L];
      ctx.beginPath();
      let any = false;
      for (let k = 0; k < TILES.length; k++) {
        if (!want(str.charCodeAt(k) - 48)) continue;
        any = true;
        const x = TILES[k].x + ox, y = TILES[k].y + oy, rr = S * scale;
        ctx.moveTo(x + HEX[0].x * rr, y + HEX[0].y * rr);
        for (let q = 1; q < 6; q++) ctx.lineTo(x + HEX[q].x * rr, y + HEX[q].y * rr);
        ctx.closePath();
      }
      return any;
    };
    const fill = (color, stroke, lw) => { ctx.fillStyle = color; ctx.fill(); if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); } };
    const drawLayer = (L) => {
      const top = L === 0;
      const base = top ? '#ffcf5c' : '#5b3fa0', edge = top ? '#c98f1e' : '#3a2770';
      if (hexPath(L, (s) => s === OK)) fill(base, edge, 4);
      if (hexPath(L, (s) => s === OK, 0.6, 0, -4)) fill(top ? '#ffe39a' : '#7558c0');
      if (hexPath(L, (s) => s === SPRING)) fill(blink ? '#8dffb0' : '#3fd96e', '#0f5a2a', 5);
      if (hexPath(L, (s) => s === CRACK)) fill(blink ? (top ? '#fff1c1' : '#a58bea') : (top ? '#ff8c42' : '#7a3fa0'), '#4a1d00', 4);
      if (hexPath(L, (s) => s === FUSE)) fill(blink ? '#ff2d2d' : '#ffd23f', '#5a0000', 5);
      if (hexPath(L, (s) => s === GROW, 0.5 + 0.4 * ((t * 2) % 1))) fill(top ? 'rgba(255,207,92,0.35)' : 'rgba(91,63,160,0.4)', '#ffffff55', 3);
    };

    const players = v.p.map((p, i) => ({ ...p, i }));
    const someoneBelow = players.some((p) => p.l === 1 || p.dr > 0);
    const drawPlayer = (p, ghost = false) => {
      if (p.o > 0) {
        const k = Math.max(0, 1 - p.o / 0.8);
        if (k > 0) d.avatar(p.x, p.y, p.r * k, p.i, { mood: 'scared', alpha: k, look: Math.atan2(p.fy, p.fx) });
        return;
      }
      if (ghost) {
        d.avatar(p.x, p.y, p.r, p.i, { alpha: 0.45, look: Math.atan2(p.fy, p.fx), mood: 'scared' });
        d.ring(p.x, p.y, p.r + 6, d.col(p.i, 'light') + 'aa', 3);
        return;
      }
      if (p.dr > 0) {
        const k = 1 - 0.3 * (1 - p.dr);
        d.avatar(p.x, p.y, p.r * k, p.i, { mood: 'scared', look: Math.atan2(p.fy, p.fx), squash: -0.2 });
        return;
      }
      const z = p.h > 0 ? Math.sin(Math.PI * (1 - p.h)) : 0;
      d.shadow(p.x + z * 18, p.y + 10 + z * 22, p.r * (1 - z * 0.3), p.r * 0.55 * (1 - z * 0.3), 0.35);
      const mood = p.bu > 0 ? 'hurt' : z > 0 ? 'happy' : p.l === 1 ? 'scared' : 'ok';
      d.avatar(p.x, p.y - z * 14, p.r * (1 + z * 0.3), p.i, { look: Math.atan2(p.fy, p.fx), mood, squash: z > 0 ? -0.12 : 0 });
      // Hop cooldown (ring when ready) and mine cooldown.
      if (p.hc <= 0) d.ring(p.x, p.y, p.r + 10, d.col(p.i, 'light') + 'aa', 3);
      else d.arc(p.x, p.y, p.r + 10, -Math.PI / 2, -Math.PI / 2 + (1 - p.hc) * Math.PI * 2, d.col(p.i, 'light') + '66', 3);
      // B ready: little orange (mine) or white (shove) dot.
      if (p.mc <= 0) d.circle(p.x + p.r * 0.95, p.y - p.r * 0.95, 9, r.variant === 'mina' ? '#ff5a1f' : '#ffffff', d.col(p.i, 'dark'), 2);
    };

    // Lower layer, players on it, then the top layer (see-through when someone is below).
    drawLayer(1);
    for (const p of players) if (p.l === 1 && !p.dr) drawPlayer(p);
    for (const p of players) if (p.dr > 0) drawPlayer(p);
    ctx.save();
    // With everyone downstairs the top floor no longer matters: make it almost see-through.
    const allBelow = players.every((p) => p.l === 1 || p.dr > 0 || p.o > 0);
    if (!allBelow) {
      ctx.globalAlpha = someoneBelow ? 0.2 : 0.4;
      if (hexPath(0, solid, 0.93, 8, 14)) fill('#000');
      ctx.globalAlpha = someoneBelow ? 0.5 : 0.95;
      drawLayer(0);
    }
    ctx.restore();
    for (const p of players) if (p.l === 1 && !p.dr && !p.o) drawPlayer(p, true);
    for (const p of players) if (p.l === 0 && !p.dr) drawPlayer(p);
    // Spring arrows (visible through the hole above them).
    for (let k = 0; k < TILES.length; k++) {
      if (v.t[1].charCodeAt(k) - 48 !== SPRING) continue;
      const x = TILES[k].x, y = TILES[k].y, b = Math.abs(Math.sin(t * 6)) * 8;
      d.poly([x, y - 26 - b, x - 18, y - 4 - b, x - 7, y - 4 - b, x - 7, y + 16 - b, x + 7, y + 16 - b, x + 7, y - 4 - b, x + 18, y - 4 - b], '#ffffff', '#0f5a2a', 3);
    }
    // Shove shockwaves.
    for (const p of players) {
      if (!(p.sw > 0) || p.o > 0) continue;
      const k = 1 - p.sw / 0.3;
      d.ring(p.x, p.y, 40 + (SHOVE_R - 40) * k, d.col(p.i, 'light') + 'cc', 10 * (1 - k) + 2);
    }
    if (v.sd) d.ring(CX, CY, ARENA_R + 12, blink ? '#ff3b3b' : '#ff3b3b55', 6);
  },
};

// ---------------------------------------------------------------- Bot ----------------------------------------------------------------
// Never stands still: a timed BFS over the tiles of its floor (cracked tiles only if they hold long enough), then runs
// toward the reachable tile with the most solid floor around it (springs downstairs are gold), planning from where its
// own momentum will carry it. Hops over a hole when boxed in; shoves rivals that stand next to a hole (difficile checks
// the push line, Scudiero shoves at random). With "Polvere Nera" only difficile uses the blast (and hops out of it).
const V_PEND = [0.34, 0.2, 0.09];
const STEP_T = HW / MAX_SPEED;
let NB = null, NB2 = null;
function pavNeighbors() {
  if (NB) return;
  NB = TILES.map((t) => TILES.map((q, j) => j).filter((j) => { const d = Math.hypot(TILES[j].x - t.x, TILES[j].y - t.y); return d > 1 && d < HW * 1.1; }));
  NB2 = TILES.map((t) => TILES.map((q, j) => j).filter((j) => { const d = Math.hypot(TILES[j].x - t.x, TILES[j].y - t.y); return d > 1 && d < HW * 2.1; }));
}

// Will tile k of this layer still hold us at time `at` (seconds from now)?
function holds(s, layer, k, at) {
  const st = s.st[layer][k];
  if (st === OK || st === SPRING) return true;
  if (st === CRACK || st === FUSE) return s.tm[layer][k] > at;
  return false;
}
// Solid floor around tile k (2 rings, OK tiles only).
function openAround(s, layer, k) {
  let n = 0;
  const st = s.st[layer];
  for (const j of NB2[k]) if (st[j] === OK || st[j] === SPRING) n++;
  for (const j of NB[k]) if (st[j] === OK || st[j] === SPRING) n += 1.5;
  return n;
}

function pavBot(s, me, g, B) {
  pavNeighbors();
  const p = s.p[me], L = B.level;
  const out = { x: 0, y: 0 };
  if (!p || p.out) return out;
  const m = B.mem;
  const delay = V_PEND[L];
  const layer = p.layer;
  if (p.drop > 0) return out;
  // Plan from where our momentum takes us during the reaction delay.
  let x = p.x + p.vx * delay * 0.8, y = p.y + p.vy * delay * 0.8;
  let k0 = tileAt(x, y);
  if (k0 < 0 || !holds(s, layer, k0, 0)) { x = p.x; y = p.y; k0 = tileAt(x, y); }
  if (k0 < 0) return out;

  // Timed BFS over tiles that still hold when we get there.
  const dist = m.dist || (m.dist = new Int16Array(TILES.length));
  const prev = m.prev || (m.prev = new Int16Array(TILES.length));
  const q = m.q || (m.q = new Int16Array(TILES.length));
  dist.fill(-1);
  dist[k0] = 0; prev[k0] = -1; q[0] = k0;
  let h = 0, n = 1;
  while (h < n) {
    const k = q[h++], d = dist[k] + 1;
    if (d > 7) continue;
    for (const j of NB[k]) {
      if (dist[j] >= 0 || !holds(s, layer, j, d * STEP_T + delay * 0.5 + 0.1)) continue;
      dist[j] = d; prev[j] = k; q[n++] = j;
    }
  }

  // Score the reachable tiles.
  const foes = s.p.filter((o) => o.i !== me && !o.out && !o.drop && o.layer === layer);
  let best = -1, bv = -Infinity;
  for (let a = 1; a < n; a++) {
    const k = q[a], st = s.st[layer][k];
    if (st !== OK && st !== SPRING) continue;
    let v = openAround(s, layer, k) - dist[k] * (L === 0 ? 1.6 : 1.1);
    if (st === SPRING) v += L === 0 ? 15 : 40;
    for (const o of foes) {
      const d = Math.hypot(TILES[k].x - o.x, TILES[k].y - o.y);
      if (d < 140) v -= (140 - d) / 140 * (L === 2 ? 6 : 3);
    }
    v -= Math.hypot(TILES[k].x - CX, TILES[k].y - CY) / 220; // the rim has fewer ways out
    if (k === m.goal) v += 1.5;
    if (v > bv) { bv = v; best = k; }
  }
  // Easy bot: now and then just runs to some random nearby tile.
  if (L === 0 && n > 1) {
    if (!(m.wT > g.t) && B.rng() < 0.01) { m.wT = g.t + 0.8; m.wk = q[1 + ((B.rng() * (n - 1)) | 0)]; }
    if (m.wT > g.t && dist[m.wk] > 0 && s.st[layer][m.wk] === OK) best = m.wk;
  }
  m.goal = best;

  // Boxed in (or nothing good nearby): hop over the hole toward the best landing tile.
  const hopLen = HOP_SPEED * HOP_T;
  if (p.hop <= 0 && p.hcd <= 0 && (best < 0 || bv < 4) && (L > 0 || B.rng() < 0.3)) {
    let ba = null, hv = best < 0 ? -Infinity : bv + 2;
    for (let a = 0; a < 12; a++) {
      const ang = (a * Math.PI) / 6, lx = p.x + Math.cos(ang) * hopLen, ly = p.y + Math.sin(ang) * hopLen;
      const k = tileAt(lx, ly);
      if (k < 0 || !holds(s, layer, k, HOP_T + 0.4) || !onFloor(lx, ly)) continue;
      const v = openAround(s, layer, k) + (s.st[layer][k] === SPRING ? 30 : 0);
      if (v > hv) { hv = v; ba = ang; }
    }
    if (ba !== null) { out.x = Math.cos(ba); out.y = Math.sin(ba); out.tapA = true; m.goal = -1; return out; }
  }

  // Steer to the next tile on the path (or away from the cracking one).
  let tx, ty;
  if (best >= 0) {
    let k = best;
    while (prev[k] >= 0 && prev[k] !== k0) k = prev[k];
    tx = TILES[k].x; ty = TILES[k].y;
    // Already on top of it: aim one step further so we never slow down.
    if (Math.hypot(tx - x, ty - y) < 25 && k !== best) { let k2 = best; while (prev[k2] >= 0 && prev[k2] !== k) k2 = prev[k2]; tx = TILES[k2].x; ty = TILES[k2].y; }
  } else {
    tx = TILES[k0].x * 2 - p.x; ty = TILES[k0].y * 2 - p.y; // nothing reachable: at least keep moving
  }
  const dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy) || 1;
  out.x = dx / d; out.y = dy / d;

  // Shove a rival next to a hole.
  if (p.scd <= 0 && foes.length && !g.ended) {
    const mina = g.variant === 'mina';
    for (const o of foes) {
      const dd = Math.hypot(o.x - p.x, o.y - p.y);
      if (dd > (mina ? 180 : SHOVE_R - 20)) continue;
      if (mina) {
        // Only the hard bot, and only with the hop ready to leave the blast ring.
        if (L === 2 && p.hcd <= 0 && o.hop <= 0) { out.tapB = true; m.mineHop = g.t + 0.05; }
        continue;
      }
      if (L === 0) { if (B.rng() < 0.03) out.tapB = true; continue; }
      // Is there a hole along the push line (or near the rival for the medium bot)?
      const ux = (o.x - p.x) / (dd || 1), uy = (o.y - p.y) / (dd || 1);
      let hole = false;
      for (let a = 40; a <= (L === 2 ? 200 : 120); a += 40) {
        const k = tileAt(o.x + ux * a, o.y + uy * a);
        if (k >= 0 && !holds(s, layer, k, 0.3)) hole = true;
      }
      if (hole || (L === 1 && dd < 90)) out.tapB = true;
    }
  }
  // After our own blast, hop out of the burning ring.
  if (m.mineHop && g.t > m.mineHop && p.hcd <= 0 && p.hop <= 0) {
    m.mineHop = 0;
    let ba = null, hv = -Infinity;
    for (let a = 0; a < 12; a++) {
      const ang = (a * Math.PI) / 6, lx = p.x + Math.cos(ang) * hopLen, ly = p.y + Math.sin(ang) * hopLen;
      const k = tileAt(lx, ly);
      if (k < 0 || !onFloor(lx, ly) || s.st[layer][k] !== OK) continue;
      const v = openAround(s, layer, k);
      if (v > hv) { hv = v; ba = ang; }
    }
    if (ba !== null) { out.x = Math.cos(ba); out.y = Math.sin(ba); out.tapA = true; }
  }
  return out;
}
