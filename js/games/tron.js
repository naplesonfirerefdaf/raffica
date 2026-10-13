// Scie Magiche — Tron light cycles + Achtung die Kurve for 2-4 wizards (top-down, dir + A turbo + B jump).
import { clamp, wrapAngle, pointSegDist, r1, r2 } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500;
const BASE_SPEED = 240;          // units/s at the start of a mini-round
const RAMP = 0.05;               // +5% speed per second of mini-round (rounds always end)
const MAX_RAMP = 2;
const TURN = 3.2;                // max angular speed (rad/s)
const TURBO = 1.7;
const FUEL_DRAIN = 0.55, FUEL_REGEN = 0.13;
const SAMPLE = 12;               // trail sampling distance
const HEAD_R = 6, TRAIL_HW = 5;  // collision radius of the head, half-width of the trail
const SUBSTEP = 4;               // max movement per collision substep
const WINS = 2;                  // best of 3
const READY_T = 1.1, OVER_T = 1.6;
const VIEW_MAX = 300, VIEW_RECENT = 150; // view budget per trail (points)
// Al Dente: draw ON units, then leave a passable hole of OFF units.
const GAP_ON = 150, GAP_OFF = 38;
// La Forchetta.
const FORK_EVERY = 6, FORK_FIRST = 4, FORK_WARN = 1.4, FORK_SPEED = 1050, FORK_RANGE = 820;
const FORK_HALF_LEN = 70, FORK_HALF_W = 115, FORK_HANDLE = 520, FORK_HANDLE_HW = 18;
// B: jump over trails (no trail is drawn while airborne).
const JUMP_T = 0.42, JUMP_CD = 3.5;
// Energy orbs: mirrored pairs, refill turbo and recharge the jump.
const ORB_FIRST = 3, ORB_EVERY = 6, ORB_R = 22;
const DIAGS = [[1, 1], [-1, -1], [1, -1], [-1, 1]].map(([x, y]) => [x / Math.SQRT2, y / Math.SQRT2]);

function scaleOf(g, i) { return (g.mods.scale && g.mods.scale[i]) || 1; }

// Push a trail point at the head; it connects to the previous one if the pen was down.
function addPt(p) {
  p.pts.push({ x: p.x, y: p.y, c: p.live ? 1 : 0, L: p.len });
  p.live = true;
  p.acc = 0;
}

function startRound(s) {
  s.round++;
  s.phase = 'ready'; s.pt = 0; s.rt = 0;
  // Alternate lanes every round; seats 0/1 bottom/top, 2/3 left/right, symmetric around the center.
  const off = s.round % 2 ? -110 : 110;
  s.p.forEach((p, i) => {
    p.x = [CX + off, CX - off, 120, 880][i];
    p.y = [880, 120, CY + off, CY - off][i];
    p.a = [-Math.PI / 2, Math.PI / 2, 0, Math.PI][i];
    p.alive = true; p.deadT = 0; p.fuel = 1; p.turbo = false; p.air = 0; p.jcd = 0;
    p.len = 0; p.acc = 0; p.cyc = 0; p.pen = true; p.live = false;
    p.pts = [];
    addPt(p);
  });
  s.orbs = []; s.orbT = ORB_FIRST;
}

// Fork geometry helpers: local frame u (motion dir) and v (lateral).
function forkLocal(f, x, y) {
  const dx = x - CX, dy = y - CY;
  const u = dx * f.dx + dy * f.dy - f.c;
  const v = -dx * f.dy + dy * f.dx - f.off;
  return { u, v };
}
function inFork(f, x, y, m = 0) {
  const { u, v } = forkLocal(f, x, y);
  if (u > -FORK_HALF_LEN - m && u < FORK_HALF_LEN + m && Math.abs(v) < FORK_HALF_W + m) return true;
  return u <= -FORK_HALF_LEN && u > -FORK_HALF_LEN - FORK_HANDLE - m && Math.abs(v) < FORK_HANDLE_HW + m;
}

const game = {
  id: 'tron',
  name: 'Scie Magiche',
  rule: 'Non toccare le scie magiche! Fai schiantare gli altri.',
  verb: 'STERZA!',
  inspired: 'Tron · Achtung die Kurve',
  cam: 'top',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', label: 'Sterza', a: 'Turbo', b: 'Salto' },
  help: {
    goal: "Fai schiantare gli altri maghi contro una scia o le mura: l'ultimo in corsa vince il round, chi ne vince 2 vince.",
    dir: 'Indica dove vuoi andare: il mago curva verso quella direzione (non si ferma mai).',
    a: "TURBO (tieni premuto): corri molto più veloce finché c'è mana (arco giallo). Si ricarica da solo.",
    b: 'SALTO: per un attimo voli sopra le scie (non lasci scia). Si ricarica in 3,5 s (anello bianco).',
    tips: ['Le pozioni 🧪 ricaricano turbo e salto', 'Taglia la strada agli altri col turbo', 'La velocità aumenta col tempo'],
  },
  duration: 45,
  supports: ['scale'],
  variants: [
    { id: 'forchetta', name: 'La Scopa della Strega', desc: 'Una scopa gigante spazza via le scie… e voi!' },
    { id: 'aldente', name: 'Incantesimo Bucato', desc: 'Le scie hanno dei buchi: infilatevi dentro!' },
    { id: 'pacman', name: 'Portali Magici', desc: 'Niente mura: uscite da un lato, rientrate dall\'altro!' },
  ],

  init(g) {
    const n = Math.max(2, Math.min(4, g.n || 2));
    const s = {
      orbs: [], orbT: ORB_FIRST, nid: 1,
      round: 0, phase: 'ready', pt: 0, rt: 0, wins: new Array(n).fill(0), total: new Array(n).fill(0),
      fork: null, forkNext: FORK_FIRST, forkIdx: g.rng.int(0, 3),
      p: Array.from({ length: n }, (_, i) => ({
        i, x: 0, y: 0, a: 0, alive: true, deadT: 0, fuel: 1, turbo: false,
        len: 0, acc: 0, cyc: 0, pen: true, live: false, pts: [], air: 0, jcd: 0,
        hr: HEAD_R * scaleOf(g, i), hw: TRAIL_HW * scaleOf(g, i), sc: scaleOf(g, i),
      })),
    };
    startRound(s);
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.pt += dt;
    if (g.variant === 'forchetta') game.stepFork(s, g);

    if (s.phase === 'ready') {
      // Players can already aim during the countdown (heads rotate in place).
      s.p.forEach((p) => game.steer(p, inp[p.i], dt));
      if (s.pt >= READY_T) { s.phase = 'run'; s.pt = 0; g.sfx('go', { pitch: 1.2 }); }
      return;
    }
    if (s.phase === 'over') {
      s.p.forEach((p) => { if (!p.alive) p.deadT += dt; });
      if (s.pt >= OVER_T && !g.ended) { startRound(s); g.sfx('whoosh'); g.say(`ROUND ${s.round}`); }
      return;
    }

    // Running.
    s.rt += dt;
    const speed = BASE_SPEED * Math.min(MAX_RAMP, 1 + RAMP * s.rt);
    const dist = s.p.map(() => 0);
    s.p.forEach((p) => {
      if (!p.alive) return;
      const i = inp[p.i];
      game.steer(p, i, dt);
      p.jcd = Math.max(0, p.jcd - dt);
      if (p.air > 0) {
        p.air -= dt;
        if (p.air <= 0) { // landing: start a fresh strip of trail
          p.air = 0;
          if (p.pen) { p.live = false; addPt(p); }
          g.sfx('land', { vol: 0.6 }); g.burst(p.x, p.y, { player: p.i, n: 10, speed: 180 });
        }
      } else if (i.bP && p.jcd <= 0) {
        if (p.pen && p.live) addPt(p);
        p.live = false; p.air = JUMP_T; p.jcd = JUMP_CD;
        g.sfx('jump', { pitch: 1.3 }); g.ring(p.x, p.y, { player: p.i, r: 40 });
      }
      const want = i.a && p.fuel > 0.02;
      if (want && !p.turbo) { g.sfx('dash', { vol: 0.6 }); g.burst(p.x, p.y, { player: p.i, n: 6, speed: 160 }); }
      p.turbo = want;
      if (p.turbo) p.fuel = Math.max(0, p.fuel - FUEL_DRAIN * dt);
      else p.fuel = Math.min(1, p.fuel + FUEL_REGEN * dt);
      dist[p.i] = speed * (p.turbo ? TURBO : 1) * dt;
    });

    // Move every head in small simultaneous substeps, checking collisions each time.
    const n = Math.max(1, Math.ceil(Math.max(...dist) / SUBSTEP));
    const dead = s.p.map(() => false);
    const run = s.p.filter((p) => p.alive);
    for (let k = 0; k < n && !dead.some(Boolean); k++) {
      run.forEach((p) => game.advance(s, p, dist[p.i] / n, g));
      run.forEach((p) => { dead[p.i] = game.hits(s, p, g); });
      for (let a = 0; a < run.length; a++) for (let b = a + 1; b < run.length; b++) {
        const A = run[a], B = run[b];
        if (!A.air && !B.air && Math.hypot(A.x - B.x, A.y - B.y) < A.hr + B.hr + 4) dead[A.i] = dead[B.i] = true;
      }
    }
    if (g.variant === 'forchetta' && s.fork && s.fork.on) {
      run.forEach((p) => { if (!p.air && inFork(s.fork, p.x, p.y, p.hr)) dead[p.i] = true; });
    }
    game.stepOrbs(s, g);
    if (dead.some(Boolean)) game.crash(s, dead, g);
  },

  steer(p, i, dt) {
    if (Math.hypot(i.x, i.y) < 0.35) return;
    const diff = wrapAngle(Math.atan2(i.y, i.x) - p.a);
    p.a = wrapAngle(p.a + clamp(diff, -TURN * dt, TURN * dt));
  },

  advance(s, p, step, g) {
    p.x += Math.cos(p.a) * step; p.y += Math.sin(p.a) * step;
    p.len += step;
    if (g.variant === 'aldente') {
      p.cyc += step;
      const on = p.cyc % (GAP_ON + GAP_OFF) < GAP_ON;
      if (on !== p.pen) {
        if (!p.air) { if (on) { p.live = false; addPt(p); } else { addPt(p); p.live = false; } }
        p.pen = on;
      }
    }
    if (p.pen && !p.air) { p.acc += step; if (p.acc >= SAMPLE) addPt(p); }
    if (g.variant === 'pacman') {
      let nx = p.x, ny = p.y;
      if (nx < 0) nx += W; else if (nx > W) nx -= W;
      if (ny < 0) ny += H; else if (ny > H) ny -= H;
      if (nx !== p.x || ny !== p.y) {
        if (p.pen && !p.air) addPt(p);
        p.x = nx; p.y = ny; p.live = false;
        if (p.pen && !p.air) addPt(p);
        g.sfx('zap', { vol: 0.4, pitch: 1.4 });
      }
    }
  },

  // True if head of p touches a border or any trail (own recent trail ignored).
  hits(s, p, g) {
    if (g.variant !== 'pacman' && (p.x < p.hr || p.x > W - p.hr || p.y < p.hr || p.y > H - p.hr)) return true;
    if (p.air) return false; // flying over every trail
    for (const q of s.p) {
      const tol = p.hr + q.hw;
      const own = q === p;
      const ign = own ? 2.5 * (p.hr + p.hw) + SAMPLE : 0;
      const pts = q.pts;
      for (let k = 1; k < pts.length; k++) {
        const b = pts[k];
        if (!b.c) continue;
        if (own && p.len - b.L < ign) break; // points are in arc-length order
        const a = pts[k - 1];
        // Cheap reject before the exact distance.
        if (Math.abs(p.x - b.x) > tol + 20 || Math.abs(p.y - b.y) > tol + 20) continue;
        if (pointSegDist(p.x, p.y, a.x, a.y, b.x, b.y) < tol) return true;
      }
      // Opponent's live segment (last point -> head) is solid too.
      if (!own && q.live && pts.length) {
        const a = pts[pts.length - 1];
        if (pointSegDist(p.x, p.y, a.x, a.y, q.x, q.y) < tol) return true;
      }
    }
    return false;
  },

  // Crashed heads are out; the mini-round ends when at most one wizard is still running.
  crash(s, dead, g) {
    s.p.forEach((p) => {
      if (!dead[p.i] || !p.alive) return;
      p.alive = false; p.deadT = 0; p.turbo = false;
      g.burst(p.x, p.y, { player: p.i, n: 34, speed: 420, size: 9 });
      g.burst(p.x, p.y, { color: '#fff', n: 14, speed: 260 });
      g.ring(p.x, p.y, { player: p.i, r: 90 });
      g.vibrate(p.i, 220);
    });
    const alive = s.p.filter((p) => p.alive);
    g.sfx('bigexplode');
    if (alive.length >= 2) {
      g.shake(0.45); g.hitstop(0.04);
      s.p.forEach((p) => { if (dead[p.i]) g.text(p.x, p.y - 50, 'ABBRUSTOLITO!', { player: p.i, size: 36 }); });
      return;
    }
    s.p.forEach((p) => { s.total[p.i] += p.len; });
    g.shake(0.7); g.flash('#ffffff', 0.35);
    s.phase = 'over'; s.pt = 0;
    if (!alive.length) {
      g.hitstop(0.08);
      g.say('SCONTRO! RIPETERE!');
      g.sfx('buzzer', { vol: 0.6 });
      return;
    }
    const w = alive[0].i;
    s.wins[w]++;
    if (s.wins[w] >= WINS) {
      g.hitstop(0.12); g.slowmo(0.3, 0.9);
      g.end(w, 'Mago abbrustolito!');
    } else {
      g.hitstop(0.06);
      g.sfx('point');
      g.say(s.wins[w] === WINS - 1 && s.wins.some((x, j) => j !== w && x === WINS - 1) ? 'SPAREGGIO!' : 'MAGO ABBRUSTOLITO!');
    }
  },

  stepOrbs(s, g) {
    s.orbT -= g.dt;
    if (s.orbT <= 0 && s.orbs.length === 0) {
      s.orbT = ORB_EVERY;
      for (let tries = 0; tries < 10; tries++) {
        const x = g.rng.range(170, 830), y = g.rng.range(170, 830);
        if (Math.hypot(x - CX, y - CY) < 90) continue;
        // Mirrored pair (4 rotated copies with 3-4 players).
        const pts = [[x, y], [W - x, H - y]];
        if (s.p.length > 2) pts.push([CX - (y - CY), CY + (x - CX)], [CX + (y - CY), CY - (x - CX)]);
        if (s.p.some((p) => pts.some(([qx, qy]) => Math.hypot(p.x - qx, p.y - qy) < 160))) continue;
        s.orbs = pts.map(([qx, qy]) => ({ id: s.nid++, x: qx, y: qy }));
        g.sfx('powerup', { vol: 0.35, pitch: 1.5 });
        break;
      }
    }
    for (const o of s.orbs) {
      for (const p of s.p) {
        if (!p.alive || Math.hypot(p.x - o.x, p.y - o.y) > ORB_R + p.hr + 8) continue;
        o.dead = 1; p.fuel = 1; p.jcd = 0;
        g.sfx('coin', { pitch: 1.2 }); g.burst(o.x, o.y, { color: '#ffe14d', n: 14, speed: 240 });
        g.text(o.x, o.y - 50, 'POZIONE!', { player: p.i, size: 34 });
        break;
      }
    }
    s.orbs = s.orbs.filter((o) => !o.dead);
  },

  stepFork(s, g) {
    if (!s.fork && g.t >= s.forkNext - FORK_WARN) {
      const [dx, dy] = DIAGS[s.forkIdx++ % 4];
      s.fork = { dx, dy, off: g.rng.range(-260, 260), c: -FORK_RANGE, on: false };
      g.sfx('horn', { vol: 0.6 }); g.say('ARRIVA LA SCOPA!');
    }
    const f = s.fork;
    if (!f) return;
    if (!f.on && g.t >= s.forkNext) { f.on = true; g.sfx('whoosh'); g.shake(0.3); }
    if (!f.on) return;
    f.c += FORK_SPEED * g.dt;
    // Erase every trail point inside the fork; the following point loses its connection.
    for (const p of s.p) {
      let broke = false, removed = false;
      const out = [];
      for (const pt of p.pts) {
        if (inFork(f, pt.x, pt.y, p.hw)) { broke = true; removed = true; continue; }
        out.push(broke ? { ...pt, c: 0 } : pt);
        broke = false;
      }
      if (removed) {
        if (broke) p.live = false; // the newest point was eaten
        p.pts = out;
      }
    }
    if (f.c > FORK_RANGE + FORK_HANDLE) { s.fork = null; s.forkNext += FORK_EVERY; }
  },

  // Most rounds, then longest total trail, then most mana left (exact tie: lowest seat).
  timeout(s) {
    let pool = s.p;
    const keys = [(p) => s.wins[p.i], (p) => s.total[p.i] + (s.phase === 'run' ? p.len : 0), (p) => p.fuel];
    const eps = [0.5, 0.5, -1];
    keys.forEach((key, k) => {
      if (pool.length < 2) return;
      const top = Math.max(...pool.map(key));
      pool = pool.filter((p) => key(p) >= top - Math.max(0, eps[k]));
    });
    return pool[0].i;
  },

  // Compact trail: flat int strips; old part subsampled when the trail gets long.
  packTrail(p) {
    const pts = p.pts, n = pts.length;
    const oldEnd = n > VIEW_MAX ? n - VIEW_RECENT : 0;
    let k = oldEnd ? Math.ceil(oldEnd / (VIEW_MAX - VIEW_RECENT)) : 1;
    for (;;) {
      const strips = [];
      let cur = null, count = 0;
      for (let j = 0; j < n; j++) {
        const q = pts[j];
        if (j < oldEnd && j % k && q.c && pts[j + 1] && pts[j + 1].c) continue;
        if (!q.c || !cur) { cur = []; strips.push(cur); }
        cur.push(Math.round(q.x), Math.round(q.y));
        count++;
      }
      // Hard cap for absurdly long rounds: subsample the old part harder.
      if (count <= VIEW_MAX * 1.4 || k > 64) return strips.filter((st) => st.length >= 4 || st === cur);
      k *= 2;
    }
  },

  view(s) {
    const f = s.fork;
    return {
      ph: s.phase === 'ready' ? 0 : s.phase === 'run' ? 1 : 2,
      pt: r2(s.pt),
      p: s.p.map((p) => ({
        x: r1(p.x), y: r1(p.y), a: r2(p.a), al: p.alive ? 1 : 0, dt: r2(p.deadT),
        f: r2(p.fuel), tb: p.turbo ? 1 : 0, lv: p.live ? 1 : 0, hw: r1(p.hw), sc: r2(p.sc),
        air: r2(p.air / JUMP_T), jc: r2(p.jcd / JUMP_CD),
      })),
      tr: { noLerp: 1, s: s.p.map((p) => game.packTrail(p)) },
      ob: s.orbs.map((o) => ({ id: o.id, x: r1(o.x), y: r1(o.y) })),
      fk: f ? { dx: r2(f.dx), dy: r2(f.dy), off: r1(f.off), c: r1(f.c), on: f.on ? 1 : 0 } : null,
      hud: { p: s.wins.slice(), max: WINS, label: 'Round', bar: s.p.map((p) => r2(p.fuel)) },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  bot(s, me, g, B) { return tronBot(s, me, g, B); },

  // 3D: "Il Cortile della Torre del Mago" — a moonlit flagstone courtyard with a glowing magic circle, low rune walls,
  // the wizard's tower and castle behind, enchanted forest around; trails are glowing magic ribbons in team colors.
  render3d: {
    assets: [
      'medieval/building_tower_B_blue', 'medieval/building_tower_A_blue', 'medieval/building_castle_blue', 'medieval/building_church_blue',
      'medieval/trees_B_large', 'medieval/trees_B_medium', 'medieval/tree_single_B', 'medieval/mountain_B_grass_trees', 'medieval/hills_B_trees',
      'medieval/rock_single_B', 'medieval/rock_single_D', 'medieval/flag_blue', 'dungeon/candle_triple', 'dungeon/candle_lit',
      'dungeon/banner_patternB_blue', 'dungeon/bottle_C_green', 'dungeon/column', 'weapons/spellbook_open', 'weapons/staff',
    ],
    build(K, r) {
      const T = K.THREE, hi = K.quality > 0;
      const pac = r.variant === 'pacman';
      const n = Math.max(2, (r && r.n) || K.n || 2);
      const o = { pac, tr: [], key: [] };
      K.theme('notte', { fogNear: 2.2, fogFar: 6 });
      K.sun.intensity = 1.5; K.hemi.intensity = 1.0;
      K.ground('erba', { tile: 220, color: '#5d7a6e', margin: 1900 });
      // Courtyard floor + magic circle (painted once) and a slow rune band sweeping it.
      K.layer({ x0: -70, y0: -70, x1: W + 70, y1: H + 70, h: 0.3, once: true, maxPx: 2048, draw: (d) => drawCourtyard(d) });
      o.band = K.box(W, 240, 1, K.glow('#9a7bff', { opacity: 0.05, add: true }), { cast: false });
      // Border: low stone rune walls (deadly) or open magic portals (Pac-Man).
      if (!pac) {
        const stone = K.texMat('muro', [12, 1], { color: '#9aa4c0' }), stoneS = K.texMat('muro', [1, 12], { color: '#9aa4c0' });
        const rune = K.glow('#b48cff'), halo = K.glow('#9a7bff', { opacity: 0.22, add: true });
        for (const [x, y, w, h, m] of [[CX, -14, W + 56, 28, stone], [CX, H + 14, W + 56, 28, stone], [-14, CY, 28, H, stoneS], [W + 14, CY, 28, H, stoneS]]) {
          K.place(K.box(w, h, 30, m), x, y, 15);
          K.place(K.box(w > h ? w : 6, h > w ? h : 6, 3, rune, { cast: false }), x + (w > h ? 0 : (x < CX ? 14 : -14)), y + (h > w ? 0 : (y < CY ? 14 : -14)), 31);
          K.place(K.box(w > h ? w : 46, h > w ? h : 46, 1, halo, { cast: false }), x + (w > h ? 0 : (x < CX ? 20 : -20)), y + (h > w ? 0 : (y < CY ? 20 : -20)), 0.8);
        }
        // Corner pillars with candles.
        for (const [x, y] of [[-14, -14], [W + 14, -14], [-14, H + 14], [W + 14, H + 14]]) K.place(K.model('dungeon/column', { height: 60 }), x, y);
        K.scatter('dungeon/candle_triple', [[-14, -14], [W + 14, -14], [-14, H + 14], [W + 14, H + 14]].map(([x, y]) => ({ x, y, h: 60 })), { height: 36 });
      } else {
        o.dash = [];
        const m = K.glow('#7df9ff');
        for (let k = 0; k < 56; k++) o.dash.push(K.box(1, 1, 1, m, { cast: false }));
        o.portal = K.glow('#7df9ff', { opacity: 0.12, add: true });
        for (const [x, y, w, h] of [[CX, 0, W, 60], [CX, H, W, 60], [0, CY, 60, H], [W, CY, 60, H]]) K.place(K.box(w, h, 1, o.portal, { cast: false }), x, y, 0.6);
      }
      // Trails: glowing walls (sides + bright top + glow on the floor), rebuilt only when the trail changes.
      const MAXSEG = 640;
      const dyn = (nVerts, mat) => {
        const g = new T.BufferGeometry();
        const at = new T.BufferAttribute(new Float32Array(MAXSEG * nVerts * 3), 3);
        at.setUsage(T.DynamicDrawUsage);
        g.setAttribute('position', at);
        g.setDrawRange(0, 0);
        const me = new T.Mesh(g, mat);
        me.frustumCulled = false; me.userData.ownGeo = true;
        K.root.add(me);
        return me;
      };
      o.walls = Array.from({ length: n }, (_, i) => ({
        side: dyn(12, K.glow(K.col(i), { opacity: 0.92 })),
        top: dyn(6, K.glow(K.col(i, 'light'))),
        glow: dyn(6, K.glow(K.col(i), { opacity: 0.35, add: true })),
        live: K.box(1, 1, 1, K.glow(K.col(i), { opacity: 0.92 }), { cast: false }),
        liveTop: K.box(1, 1, 1, K.glow(K.col(i, 'light')), { cast: false }),
        liveGlow: K.box(1, 1, 1, K.glow(K.col(i), { opacity: 0.35, add: true }), { cast: false }),
      }));
      o.MAXSEG = MAXSEG;
      // Potions (energy orbs): a green flask on a glowing rune disc.
      o.orbs = [0, 1, 2, 3].map(() => {
        const g = K.group();
        K.model('dungeon/bottle_C_green', { height: 52, parent: g });
        return {
          g,
          ring: K.torus(ORB_R + 12, 2.5, K.glow('#d8ffb0'), { cast: false }),
          halo: K.disc(ORB_R * 2, K.glow('#7dff6a', { opacity: 0.32, add: true })),
          glow: K.ball(ORB_R * 1.1, K.glow('#9dff7a', { opacity: 0.22, add: true }), { cast: false }),
        };
      });
      // La Scopa della Strega: danger lane + a giant witch's broom sweeping the courtyard.
      if (r.variant === 'forchetta') {
        o.fork = K.group();
        o.lane = K.box(3000, FORK_HALF_W * 2, 1, K.glow('#ff3c3c', { opacity: 0.2, unique: true }), { parent: o.fork, cast: false });
        o.lane.position.y = 1;
        for (const sd of [-1, 1]) K.box(3000, 6, 2, K.glow('#ff5a5a', { opacity: 0.7 }), { parent: o.fork, cast: false }).position.set(0, 1.5, sd * FORK_HALF_W);
        o.arrows = [];
        for (let k = 0; k < 5; k++) o.arrows.push(K.prism([40, 0, -20, -40, -20, 40], 2, K.glow('#ff7878', { opacity: 0.6 }), { parent: o.fork, cast: false }));
        o.steel = K.group(o.fork);
        const wood = K.texMat('legno', [4, 1], { color: '#8a5a32' });
        const handle = K.cyl(FORK_HANDLE_HW, FORK_HANDLE + 40, wood, { parent: o.steel, center: true, seg: 12 });
        handle.rotation.z = Math.PI / 2;
        handle.position.set(-FORK_HALF_LEN - FORK_HANDLE / 2 + 10, 34, 0);
        const straw = K.texMat('paglia', [2, 2], { color: '#ffe08a' });
        straw.emissive.set('#5a4210');
        const L = FORK_HALF_LEN, Wb = FORK_HALF_W;
        const brist = K.prism([-L, -48, L - 10, -Wb, L + 6, -Wb * 0.55, L + 6, Wb * 0.55, L - 10, Wb, -L, 48], 46, straw, { parent: o.steel, bevel: 3 });
        brist.position.y = 8;
        K.box(36, 104, 50, K.mat('#7a2a8a', { rough: 0.5 }), { parent: o.steel }).position.set(-L + 4, 33, 0);
        K.box(10, 110, 54, K.mat('#ffd04d', { rough: 0.3, metal: 0.4 }), { parent: o.steel }).position.set(-L + 16, 33, 0);
      }
      // Wizards: team sparkles while in turbo + ground indicators (mana arc, jump ring, start arrow).
      o.pl = Array.from({ length: n }, (_, i) => ({
        av: K.avatar(i),
        fire: [0, 1, 2, 3].map((j) => K.ball(1, K.glow(j % 2 ? K.col(i, 'light') : '#ffffff', { add: true }), { cast: false })),
        dec: K.decal(300),
      }));
      buildTowerYard(K, hi, pac);
      return o;
    },
    update(K, o, v) {
      const t = K.t, HW_ = 26;
      K.place(o.band, CX, ((t * 140) % (H + 300)) - 150, 1.2);
      if (o.dash) {
        o.dash.forEach((m, k) => {
          const side = k % 4, j = Math.floor(k / 4), q = (((j * 1000) / 14 + t * 60) % 1000);
          const horiz = side < 2;
          K.place(m, horiz ? q : side === 2 ? 3 : W - 3, horiz ? (side === 0 ? 3 : H - 3) : q, 4);
          m.scale.set(horiz ? 40 : 8, 8, horiz ? 8 : 40);
        });
      }
      // Trails.
      v.tr.s.forEach((strips, i) => {
        const Wl = o.walls[i], p = v.p[i];
        if (!Wl || !p) return;
        const hw = p.hw;
        let key = `${strips.length}|${hw}`;
        for (const st of strips) key += `|${st.length},${st[0]},${st[1]},${st[st.length - 2]},${st[st.length - 1]}`;
        if (key !== o.key[i]) { o.key[i] = key; buildTrail(Wl, strips, hw, HW_, o.MAXSEG); }
        const last = strips.length ? strips[strips.length - 1] : null;
        const on = !!(p.lv && last && last.length >= 2);
        Wl.live.visible = Wl.liveTop.visible = Wl.liveGlow.visible = false;
        if (on) {
          const ax = last[last.length - 2], ay = last[last.length - 1];
          const dx = p.x - ax, dy = p.y - ay, len = Math.hypot(dx, dy);
          if (len > 0.5 && len < 200) {
            const a = Math.atan2(dy, dx), mx = (ax + p.x) / 2, my = (ay + p.y) / 2;
            Wl.live.visible = Wl.liveTop.visible = Wl.liveGlow.visible = true;
            K.place(Wl.live, mx, my, HW_ / 2); K.face(Wl.live, a); Wl.live.scale.set(len + hw, HW_, hw * 2);
            K.place(Wl.liveTop, mx, my, HW_ + 0.5); K.face(Wl.liveTop, a); Wl.liveTop.scale.set(len + hw, 1, hw * 1.2);
            K.place(Wl.liveGlow, mx, my, 0.7); K.face(Wl.liveGlow, a); Wl.liveGlow.scale.set(len + hw, 1, hw * 5);
          }
        }
      });
      // Potions.
      o.orbs.forEach((O, k) => {
        const ob = (v.ob || [])[k];
        O.g.visible = O.ring.visible = O.halo.visible = O.glow.visible = !!ob;
        if (!ob) return;
        const bob = 10 + Math.sin(t * 4 + ob.id) * 6;
        K.place(O.g, ob.x, ob.y, bob);
        O.g.rotation.y = t * 1.5 + ob.id;
        K.place(O.ring, ob.x, ob.y, bob + 24);
        O.ring.rotation.set(Math.sin(t * 2) * 0.6, t * 4, 0);
        K.place(O.halo, ob.x, ob.y, 1);
        O.halo.scale.setScalar(1 + 0.12 * Math.sin(t * 8 + ob.id));
        K.place(O.glow, ob.x, ob.y, bob + 24);
      });
      // Broom.
      if (o.fork) {
        const f = v.fk;
        o.fork.visible = !!f;
        if (f) {
          K.place(o.fork, CX - f.dy * f.off, CY + f.dx * f.off, 0);
          K.face(o.fork, Math.atan2(f.dy, f.dx));
          o.lane.material.opacity = 0.14 + 0.14 * (Math.sin(t * (f.on ? 8 : 16)) > 0 ? 1 : 0);
          o.arrows.forEach((a, k) => { a.visible = !f.on; a.position.set(((t * 400 + (k - 2) * 280) % 1400 + 1400) % 1400 - 700, 1.5, 0); });
          o.steel.visible = !!f.on;
          o.steel.position.x = f.c;
          o.steel.rotation.x = Math.sin(t * 18) * 0.04;
        }
      }
      // Wizards.
      const runners = v.p.filter((q) => q.al).length;
      v.p.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const R = 24 * p.sc;
        if (!p.al) {
          // Out: knocked down in a scorch mark, then a faded ghost.
          const k = Math.min(1, p.dt / 0.4), ghost = clamp((p.dt - 1.2) / 0.6, 0, 1);
          P.av.set(p.x, p.y, { r: R, look: p.a, mood: 'dead', alpha: 1 - ghost * 0.6 });
          for (const f of P.fire) f.visible = false;
          P.dec.show(true).at(p.x, p.y, 1).paint((d) => {
            d.circle(0, 0, R * (1.3 + k * 0.6), 'rgba(0,0,0,0.5)');
            for (let j = 0; j < 6; j++) { const a = j * 1.05 + i; d.line(0, 0, Math.cos(a) * R * (1.7 + k), Math.sin(a) * R * (1.7 + k), d.col(i, 'dark'), 5); }
          });
          return;
        }
        const winning = v.ph === 2 && runners === 1;
        const z = p.air > 0 ? Math.sin(Math.PI * (1 - p.air)) : 0;
        const h = z * 70;
        P.av.set(p.x, p.y, {
          r: R, h, look: p.a, mood: winning ? 'happy' : 'ok', lean: p.tb ? 0.18 : 0.06,
          walk: v.ph === 1 ? (p.tb ? 1 : 0.8) : 0, anim: v.ph === 0 ? 'Idle' : z > 0 ? 'Jump_Idle' : undefined,
          animSpeed: v.ph === 1 ? (p.tb ? 1.5 : 1.1) : undefined,
        });
        P.fire.forEach((f, j) => {
          f.visible = !!p.tb;
          if (!p.tb) return;
          const back = R + 6 + j * 12 + Math.sin(t * 40 + j) * 3;
          K.place(f, p.x - Math.cos(p.a) * back + Math.sin(t * 30 + j) * 4, p.y - Math.sin(p.a) * back, h + R * (0.5 + 0.4 * Math.sin(t * 25 + j * 2)));
          f.scale.setScalar((8 - j * 1.5) * p.sc);
        });
        P.dec.show(true).at(p.x, p.y, 1.1).paint((d) => {
          d.arc(0, 0, R + 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p.f, p.f > 0.25 ? '#ffe14d' : '#ff5a3c', 6);
          if (p.jc <= 0) d.ring(0, 0, R + 21, 'rgba(255,255,255,0.75)', 4);
          else d.arc(0, 0, R + 21, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - p.jc), 'rgba(255,255,255,0.4)', 4);
          if (v.ph === 0) {
            const pulse = 1 + 0.15 * Math.sin(t * 10);
            d.ring(0, 0, (R + 30) * pulse, d.col(i, 'light'), 4);
            const ax = Math.cos(p.a) * (R + 62), ay = Math.sin(p.a) * (R + 62), px = -Math.sin(p.a), py = Math.cos(p.a);
            d.poly([ax + Math.cos(p.a) * 22, ay + Math.sin(p.a) * 22, ax + px * 16, ay + py * 16, ax - px * 16, ay - py * 16], d.col(i, 'light'), 'rgba(0,0,0,0.4)', 2);
          }
        });
      });
    },
  },
  render(d, v, r) {
    const { ctx } = d;
    const pac = r.variant === 'pacman';
    const t = d.t;
    // Moonlit courtyard of the wizard's tower: deep gradient, faint rune grid and a slow sweeping band.
    ctx.fillStyle = '#07030f';
    ctx.fillRect(-300, -300, W + 600, H + 600);
    const bg = ctx.createRadialGradient(CX, CY, 80, CX, CY, 760);
    bg.addColorStop(0, '#24124a'); bg.addColorStop(1, '#0d0620');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    d.grid(50, `rgba(120,90,255,${0.09 + 0.03 * Math.sin(t * 2)})`);
    d.grid(250, 'rgba(160,120,255,0.12)');
    const band = ((t * 140) % (H + 300)) - 150;
    const sg = ctx.createLinearGradient(0, band - 120, 0, band + 120);
    sg.addColorStop(0, 'rgba(255,79,216,0)'); sg.addColorStop(0.5, 'rgba(255,79,216,0.06)'); sg.addColorStop(1, 'rgba(255,79,216,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, Math.max(0, band - 120), W, 240);
    // Border: deadly neon wall, or Pac-Man portals.
    if (pac) {
      ctx.save();
      ctx.setLineDash([22, 18]);
      ctx.lineDashOffset = -d.t * 60;
      d.rect(3, 3, W - 6, H - 6, null, '#ffe14d', 6);
      ctx.restore();
    } else {
      d.neon(() => d.rect(0, 0, W, H, null, '#ff4fd8', 8), '#ff4fd8');
    }

    game.renderFork(d, v);

    // Energy orbs.
    for (const o of v.ob || []) {
      const pulse = 1 + 0.12 * Math.sin(t * 8 + o.id);
      d.circle(o.x, o.y, ORB_R * 1.7 * pulse, 'rgba(255,225,77,0.15)');
      d.circle(o.x, o.y, ORB_R * pulse, '#ffe14d', '#fff8c0', 3);
      d.emoji('🧪', o.x, o.y, 30);
      d.arc(o.x, o.y, ORB_R + 8, t * 4, t * 4 + 1.2, '#fff8c0', 3);
    }

    // Trails: dim wide stroke (fake glow) + bright core + white heart. No shadowBlur.
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    v.tr.s.forEach((strips, i) => {
      const p = v.p[i];
      ctx.beginPath();
      for (const st of strips) {
        ctx.moveTo(st[0], st[1]);
        for (let k = 2; k < st.length; k += 2) ctx.lineTo(st[k], st[k + 1]);
      }
      if (p.lv && strips.length) {
        const last = strips[strips.length - 1];
        ctx.moveTo(last[last.length - 2], last[last.length - 1]);
        ctx.lineTo(p.x, p.y);
      }
      const col = d.col(i), hw = p.hw;
      ctx.strokeStyle = col + '40'; ctx.lineWidth = hw * 4.2; ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = hw * 2; ctx.stroke();
      ctx.strokeStyle = d.col(i, 'light'); ctx.lineWidth = hw * 0.7; ctx.stroke();
    });
    ctx.restore();

    // Heads.
    v.p.forEach((p, i) => {
      const R = 24 * p.sc;
      if (!p.al) {
        const k = Math.min(1, p.dt / 0.4);
        // Scorched spaghetto: black splat + dizzy face.
        d.circle(p.x, p.y, R * (1.3 + k * 0.6), 'rgba(0,0,0,0.45)');
        for (let j = 0; j < 6; j++) {
          const a = j * 1.05 + i;
          d.line(p.x, p.y, p.x + Math.cos(a) * R * (1.6 + k), p.y + Math.sin(a) * R * (1.6 + k), d.col(i, 'dark'), 4);
        }
        d.avatar(p.x, p.y, R, i, { look: p.a, mood: 'dead', squash: -0.25 * k });
        return;
      }
      const winning = v.ph === 2 && v.p.filter((q) => q.al).length === 1;
      if (p.tb) {
        for (let j = 0; j < 3; j++) {
          const back = R + 8 + j * 9 + Math.sin(d.t * 40 + j) * 3;
          d.circle(p.x - Math.cos(p.a) * back, p.y - Math.sin(p.a) * back, (7 - j * 2) * p.sc, j ? '#ffb300' : '#fff3a0');
        }
      }
      const z = p.air > 0 ? Math.sin(Math.PI * (1 - p.air)) : 0;
      d.circle(p.x + 5 + z * 22, p.y + 7 + z * 26, R * (1 - z * 0.25), `rgba(0,0,0,${0.3 - z * 0.12})`);
      const hy = p.y - z * 22, Rz = R * (1 + z * 0.45);
      if (z > 0) d.ring(p.x, hy, Rz + 6, d.col(i, 'light') + '88', 3);
      d.avatar(p.x, hy, Rz, i, { look: p.a, mood: winning ? 'happy' : z > 0 ? 'happy' : p.tb ? 'angry' : 'ok', squash: z > 0 ? -0.15 : p.tb ? 0.15 : 0 });
      // Fuel arc + jump-ready ring.
      d.arc(p.x, hy, Rz + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p.f, p.f > 0.25 ? '#ffe14d' : '#ff5a3c', 4);
      if (p.jc <= 0) d.ring(p.x, hy, Rz + 13, 'rgba(255,255,255,0.55)', 2);
      else d.arc(p.x, hy, Rz + 13, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - p.jc), 'rgba(255,255,255,0.3)', 2);
      if (v.ph === 0) {
        // Pre-round: pulsing ring + heading arrow.
        const pulse = 1 + 0.15 * Math.sin(d.t * 10);
        d.ring(p.x, p.y, (R + 16) * pulse, d.col(i, 'light'), 3);
        const ax = p.x + Math.cos(p.a) * (R + 46), ay = p.y + Math.sin(p.a) * (R + 46);
        const px = -Math.sin(p.a), py = Math.cos(p.a);
        d.poly([ax + Math.cos(p.a) * 18, ay + Math.sin(p.a) * 18, ax + px * 13, ay + py * 13, ax - px * 13, ay - py * 13], d.col(i, 'light'));
      }
    });
  },

  renderFork(d, v) {
    const f = v.fk;
    if (!f) return;
    const { ctx } = d;
    ctx.save();
    ctx.translate(CX - f.dy * f.off, CY + f.dx * f.off);
    ctx.rotate(Math.atan2(f.dy, f.dx));
    // Danger lane (always visible while the fork is around).
    const blink = 0.12 + 0.1 * (Math.sin(d.t * (f.on ? 8 : 16)) > 0 ? 1 : 0);
    d.rect(-1500, -FORK_HALF_W, 3000, FORK_HALF_W * 2, `rgba(255,60,60,${blink})`);
    d.line(-1500, -FORK_HALF_W, 1500, -FORK_HALF_W, 'rgba(255,90,90,0.6)', 3);
    d.line(-1500, FORK_HALF_W, 1500, FORK_HALF_W, 'rgba(255,90,90,0.6)', 3);
    if (!f.on) {
      for (let k = -2; k <= 2; k++) {
        const x = ((d.t * 400 + k * 280) % 1400) - 700;
        d.poly([x + 40, 0, x - 20, -40, x - 20, 40], 'rgba(255,120,120,0.55)');
      }
    } else {
      const c = f.c;
      // Handle.
      d.rrect(c - FORK_HALF_LEN - FORK_HANDLE, -FORK_HANDLE_HW, FORK_HANDLE, FORK_HANDLE_HW * 2, 16, '#c9d1dc', '#7d8794', 4);
      // Neck + tines.
      d.rrect(c - FORK_HALF_LEN - 10, -FORK_HALF_W, 50, FORK_HALF_W * 2, 22, '#dfe5ee', '#7d8794', 4);
      for (let t = 0; t < 4; t++) {
        const y = -FORK_HALF_W + 14 + t * ((FORK_HALF_W * 2 - 28) / 3);
        d.rrect(c - FORK_HALF_LEN + 30, y - 11, FORK_HALF_LEN * 2 - 30, 22, 11, '#eef2f7', '#7d8794', 3);
      }
      d.line(c - FORK_HALF_LEN - FORK_HANDLE + 20, -6, c - FORK_HALF_LEN, -6, 'rgba(255,255,255,0.7)', 4);
    }
    ctx.restore();
  },
};
export default game;

/// ---------- 3D helpers ----------
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

// Moonlit flagstones with a big faint magic circle (kept dark and low-contrast: the trails must pop).
function drawCourtyard(d) {
  const { ctx } = d;
  d.rect(-70, -70, W + 140, H + 140, '#1b1d30');
  for (let row = 0, y = -70; y < H + 70; row++, y += 92) {
    for (let x = -70 - (row % 2) * 60, k = 0; x < W + 70; x += 120, k++) {
      const c = 0.5 + hash(row * 31 + k) * 0.5;
      d.rect(x + 3, y + 3, 114, 86, `rgb(${Math.round(42 + 14 * c)},${Math.round(45 + 14 * c)},${Math.round(70 + 18 * c)})`);
      if (hash(row * 17 + k * 3) < 0.25) d.line(x + 20, y + 30, x + 60, y + 50, 'rgba(15,16,30,0.6)', 2);
    }
  }
  const g = ctx.createRadialGradient(CX, CY, 60, CX, CY, 700);
  g.addColorStop(0, 'rgba(140,110,255,0.16)'); g.addColorStop(1, 'rgba(10,10,30,0.35)');
  ctx.fillStyle = g; ctx.fillRect(-70, -70, W + 140, H + 140);
  // Magic circle.
  const vio = 'rgba(170,140,255,0.38)', vio2 = 'rgba(170,140,255,0.22)';
  d.ring(CX, CY, 430, vio, 7); d.ring(CX, CY, 400, vio2, 3); d.ring(CX, CY, 260, vio2, 4); d.ring(CX, CY, 90, vio, 5);
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2, x = CX + Math.cos(a) * 415, y = CY + Math.sin(a) * 415;
    if (k % 2) d.circle(x, y, 5, vio); else d.line(x - Math.sin(a) * 8, y + Math.cos(a) * 8, x + Math.sin(a) * 8, y - Math.cos(a) * 8, vio, 3);
  }
  const star = [];
  for (let k = 0; k < 6; k++) { const a = -Math.PI / 2 + (k * Math.PI * 2) / 6; star.push(CX + Math.cos(a) * 400, CY + Math.sin(a) * 400); }
  d.poly([star[0], star[1], star[4], star[5], star[8], star[9]], null, vio2, 3);
  d.poly([star[2], star[3], star[6], star[7], star[10], star[11]], null, vio2, 3);
}

// The wizard's tower and castle behind, an enchanted forest on the sides, candles, crystals and fireflies.
function buildTowerYard(K, hi, pac) {
  K.place(K.model('medieval/building_tower_B_blue', { height: 470 }), 500, -250);
  K.place(K.model('medieval/building_castle_blue', { height: 560 }), 130, -560);
  K.place(K.model('medieval/building_church_blue', { height: 300 }), 880, -430);
  K.scatter('medieval/building_tower_A_blue', [{ x: -200, y: -150, rot: 0.3 }, { x: 1200, y: -150, rot: -0.3 }], { height: 300 });
  for (const x of [390, 610]) K.place(K.model('dungeon/banner_patternB_blue', { height: 130 }), x, -150);
  K.place(K.model('dungeon/column', { height: 46 }), 250, -110);
  K.place(K.model('weapons/spellbook_open', { size: 46 }), 250, -110, 46);
  const staff = K.model('weapons/staff', { height: 120 });
  K.place(staff, 745, -112, 0); staff.rotation.z = 0.15;
  K.scatter('medieval/mountain_B_grass_trees', [
    { x: -420, y: -760, rot: 0.3 }, { x: 1420, y: -760, rot: 2.2 }, { x: 520, y: -1150, rot: 1.1, s: 1.3 }, { x: -900, y: -250, rot: 2.7 }, { x: 1900, y: -250, rot: 0.9 },
  ], { size: 720 });
  K.scatter('medieval/hills_B_trees', [
    { x: -650, y: 350, rot: 0.5 }, { x: -700, y: 950, rot: 2 }, { x: 1650, y: 350, rot: 3 }, { x: 1700, y: 950, rot: 1 },
  ], { size: 520 });
  // Forest on the sides (big clusters far, single trees near the walls).
  const big = [], mid = [], single = [];
  for (let k = 0; k < 9; k++) {
    const y = -200 + k * 160;
    big.push({ x: -330 - hash(k) * 80, y, rot: k * 1.3, s: 0.9 + hash(k + 3) * 0.3 });
    big.push({ x: 1330 + hash(k + 5) * 80, y: y + 70, rot: k * 2.1, s: 0.9 + hash(k + 8) * 0.3 });
    single.push({ x: -130 - hash(k + 11) * 50, y: y + 40, rot: k, s: 0.8 + hash(k + 2) * 0.4 });
    single.push({ x: 1130 + hash(k + 13) * 50, y: y + 100, rot: k * 3, s: 0.8 + hash(k + 4) * 0.4 });
  }
  for (let k = 0; k < 8; k++) mid.push({ x: -60 + k * 160 + hash(k) * 40, y: 1190 + hash(k + 1) * 60, rot: k * 1.7, s: 0.8 + hash(k + 6) * 0.3 });
  K.scatter('medieval/trees_B_large', big, { size: 300 });
  K.scatter('medieval/tree_single_B', single, { height: 170 });
  K.scatter('medieval/trees_B_medium', mid, { size: 150 });
  K.scatter('medieval/rock_single_B', [{ x: -90, y: 300, rot: 1 }, { x: 1090, y: 660, rot: 2 }, { x: -80, y: 900, rot: 3 }, { x: 1080, y: 120, rot: 4 }, { x: 300, y: 1090, rot: 5 }], { size: 60 });
  K.scatter('medieval/rock_single_D', [{ x: -110, y: 560, rot: 1 }, { x: 1100, y: 420, rot: 2 }, { x: 760, y: 1100, rot: 3 }], { size: 70 });
  // Candles on the walls (or along the portal edge).
  if (!pac) {
    const cs = [];
    for (let k = 1; k < 5; k++) { cs.push({ x: k * 200, y: -14, h: 30 }, { x: -14, y: k * 200, h: 30 }, { x: W + 14, y: k * 200, h: 30 }); }
    K.scatter('dungeon/candle_lit', cs, { height: 26 });
    const fl = K.glow('#ffcf70', { add: true, opacity: 0.9 });
    flameBalls(K, cs.map((c) => [c.x, c.y, 58]), 5, fl);
  }
  // Crystals.
  const cry = [K.mat('#c9a2ff', { emissive: '#8a4dff', ei: 1, flat: true, rough: 0.2 }), K.mat('#8ff6ff', { emissive: '#2ad0ff', ei: 1, flat: true, rough: 0.2 })];
  crystals(K, [[-110, 90, 0], [1110, 820, 1], [-120, 1060, 1], [1120, -40, 0], [60, -110, 1], [940, -110, 0]], cry);
  // Moon.
  const moonM = K.glow('#fff4d0');
  moonM.fog = false;
  K.place(K.ball(160, moonM, { cast: false }), 760, -2400, 1300);
  K.light(500, -140, 230, '#a07bff', 2.0, { dist: 900 });
  K.light(CX, CY, 420, '#8fa8ff', 0.8, { dist: 1100 });
  if (hi) {
    K.light(-110, 90, 80, '#9a5cff', 1.4, { dist: 420, flicker: 0.2 });
    K.light(1110, 820, 80, '#3ad8ff', 1.4, { dist: 420, flicker: 0.2 });
  }
  K.ambient('lucciole', { x0: -600, x1: -60, y0: -300, y1: 1300, n: hi ? 40 : 20, h: 160 });
  K.ambient('lucciole', { x0: 1060, x1: 1600, y0: -300, y1: 1300, n: hi ? 40 : 20, h: 160 });
}

// Fill the trail meshes (side walls, bright top, floor glow) from the packed strips.
function buildTrail(Wl, strips, hw, wh, maxSeg) {
  const S = Wl.side.geometry.attributes.position, Tp = Wl.top.geometry.attributes.position, G = Wl.glow.geometry.attributes.position;
  const s = S.array, tp = Tp.array, gl = G.array;
  let n = 0;
  const quad = (arr, base, ax, ay, ah, bx, by, bh, cx, cy, ch, dx, dy, dh) => {
    // two triangles a-b-c, a-c-d (written in place: no allocations)
    arr[base] = ax; arr[base + 1] = ah; arr[base + 2] = ay;
    arr[base + 3] = bx; arr[base + 4] = bh; arr[base + 5] = by;
    arr[base + 6] = cx; arr[base + 7] = ch; arr[base + 8] = cy;
    arr[base + 9] = ax; arr[base + 10] = ah; arr[base + 11] = ay;
    arr[base + 12] = cx; arr[base + 13] = ch; arr[base + 14] = cy;
    arr[base + 15] = dx; arr[base + 16] = dh; arr[base + 17] = dy;
  };
  for (const st of strips) {
    for (let k = 2; k + 1 < st.length && n < maxSeg; k += 2) {
      let ax = st[k - 2], ay = st[k - 1], bx = st[k], by = st[k + 1];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      if (len < 0.01 || len > 200) continue;
      const ux = dx / len, uy = dy / len, e = hw * 0.6;
      ax -= ux * e; ay -= uy * e; bx += ux * e; by += uy * e; // overlap a bit at the joints
      const nx = -uy * hw, ny = ux * hw;
      quad(s, n * 36, ax + nx, ay + ny, 0, bx + nx, by + ny, 0, bx + nx, by + ny, wh, ax + nx, ay + ny, wh);
      quad(s, n * 36 + 18, ax - nx, ay - ny, 0, bx - nx, by - ny, 0, bx - nx, by - ny, wh, ax - nx, ay - ny, wh);
      const tx = nx * 0.6, ty = ny * 0.6;
      quad(tp, n * 18, ax + tx, ay + ty, wh + 0.5, bx + tx, by + ty, wh + 0.5, bx - tx, by - ty, wh + 0.5, ax - tx, ay - ty, wh + 0.5);
      // Floor glow without the joint overlap (additive: overlaps would show as dots).
      const gx0 = ax + ux * e, gy0 = ay + uy * e, gx1 = bx - ux * e, gy1 = by - uy * e;
      quad(gl, n * 18, gx0 + nx * 2.5, gy0 + ny * 2.5, 0.7, gx1 + nx * 2.5, gy1 + ny * 2.5, 0.7, gx1 - nx * 2.5, gy1 - ny * 2.5, 0.7, gx0 - nx * 2.5, gy0 - ny * 2.5, 0.7);
      n++;
    }
  }
  Wl.side.geometry.setDrawRange(0, n * 12);
  Wl.top.geometry.setDrawRange(0, n * 6);
  Wl.glow.geometry.setDrawRange(0, n * 6);
  S.needsUpdate = Tp.needsUpdate = G.needsUpdate = true;
}

// ---------------------------------------------------------------- Bot ----------------------------------------------------------------
// A coarse occupancy grid of every trail (kept up to date incrementally in B.mem), then "feelers": arcs that turn toward
// 13 candidate headings at the real turning rate. The bot takes the heading with the longest free run; among the safe
// ones it prefers open space (small flood fill), cutting off a rival (medio/difficile) and potions. Jumps over a trail
// when a crash is unavoidable, turbo to cut someone off (difficile).
const GC = 20, GN = W / GC;                 // grid cell size and cells per side
const PEND_T = [0.34, 0.2, 0.09];           // driver reaction delay per level (seconds)
const FEEL = 520, FSTEP = 12, OWN_SKIP = 45;
const CANDS = 13, CSTEP = Math.PI / 8;

function tronMem(B) {
  const m = B.mem;
  if (!m.occ) {
    m.occ = new Uint8Array(GN * GN); m.myL = new Float32Array(GN * GN);
    m.seen = new Int32Array(GN * GN); m.stamp = 1; m.fq = new Int32Array(GN * GN);
    m.refs = []; m.done = []; m.round = -1;
    m.hx = new Float64Array(32); m.hy = new Float64Array(32); m.hn = 0;
    m.fk = { dx: 0, dy: 0, off: 0, c: 0 };
    m.F = new Float64Array(CANDS); m.EX = new Float64Array(CANDS); m.EY = new Float64Array(CANDS);
    m.pick = 0;
  }
  return m;
}

// Mark the cells around the trail point(s) of player q from index `from`.
function tronMark(s, m, me, q, from) {
  const bit = q.i === me ? 2 : 1;
  const pts = q.pts, R = 9;
  for (let k = Math.max(1, from); k < pts.length; k++) {
    const b = pts[k];
    if (!b.c) continue;
    const a = pts[k - 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(len / 8));
    for (let j = 0; j <= n; j++) {
      const x = a.x + ((b.x - a.x) * j) / n, y = a.y + ((b.y - a.y) * j) / n;
      for (let ox = -R; ox <= R; ox += R) for (let oy = -R; oy <= R; oy += R) {
        const cx = Math.floor((x + ox) / GC), cy = Math.floor((y + oy) / GC);
        if (cx < 0 || cy < 0 || cx >= GN || cy >= GN) continue;
        const c = cy * GN + cx;
        m.occ[c] |= bit;
        if (bit === 2 && b.L > m.myL[c]) m.myL[c] = b.L;
      }
    }
  }
}

function tronGrid(s, m, me) {
  let rebuild = m.round !== s.round;
  for (const q of s.p) if (m.refs[q.i] !== q.pts || (m.done[q.i] || 0) > q.pts.length) rebuild = true;
  if (rebuild) {
    m.occ.fill(0); m.myL.fill(0); m.round = s.round;
    for (const q of s.p) { m.refs[q.i] = q.pts; m.done[q.i] = 0; }
  }
  for (const q of s.p) {
    // The newest point may still get its connection flag changed: re-mark from the previous last point.
    const from = Math.max(0, (m.done[q.i] || 0) - 1);
    if (q.pts.length > from) tronMark(s, m, me, q, from);
    m.done[q.i] = q.pts.length;
  }
}

// Is (x, y) blocked for us at path distance d (seconds tau from now)?
function tronBlocked(s, g, m, p, x, y, d, tau, others) {
  const pac = g.variant === 'pacman';
  if (pac) { x = ((x % W) + W) % W; y = ((y % H) + H) % H; }
  else if (x < p.hr + 4 || x > W - p.hr - 4 || y < p.hr + 4 || y > H - p.hr - 4) return true;
  const cx = Math.floor(x / GC), cy = Math.floor(y / GC);
  if (cx >= 0 && cy >= 0 && cx < GN && cy < GN) {
    const c = cy * GN + cx, o = m.occ[c];
    if (o & 1) return true;
    if ((o & 2) && m.myL[c] < p.len - OWN_SKIP) return true;
  }
  // Rival heads (predicted straight on): do not ram them, do not cross right in front of them.
  if (tau < 0.8) {
    for (const q of others) {
      const qx = q.x + Math.cos(q.a) * q.v * tau, qy = q.y + Math.sin(q.a) * q.v * tau;
      if (Math.abs(qx - x) < 34 && Math.abs(qy - y) < 34) return true;
    }
  }
  const f = s.fork;
  if (f && g.variant === 'forchetta') {
    const T = g.t + tau;
    let c = null;
    if (f.on) c = f.c + FORK_SPEED * tau;
    else if (T >= s.forkNext) c = -FORK_RANGE + FORK_SPEED * (T - s.forkNext);
    if (c !== null && c < FORK_RANGE + FORK_HANDLE) {
      const k = m.fk; k.dx = f.dx; k.dy = f.dy; k.off = f.off; k.c = c;
      if (inFork(k, x, y, p.hr + 22)) return true;
    }
  }
  return false;
}

// Free cells reachable from (x, y), up to `cap` (open space estimate).
function tronSpace(m, x, y, cap, pac) {
  let cx = Math.floor(x / GC), cy = Math.floor(y / GC);
  if (pac) { cx = ((cx % GN) + GN) % GN; cy = ((cy % GN) + GN) % GN; }
  if (cx < 0 || cy < 0 || cx >= GN || cy >= GN) return 0;
  const st = ++m.stamp, q = m.fq;
  let head = 0, tail = 0;
  const start = cy * GN + cx;
  m.seen[start] = st; q[tail++] = start;
  while (head < tail && tail < cap) {
    const c = q[head++], x0 = c % GN, y0 = (c / GN) | 0;
    for (let k = 0; k < 4; k++) {
      let nx = x0 + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y0 + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (pac) { nx = (nx + GN) % GN; ny = (ny + GN) % GN; } else if (nx < 1 || ny < 1 || nx >= GN - 1 || ny >= GN - 1) continue;
      const n = ny * GN + nx;
      if (m.seen[n] === st || (m.occ[n] & 1) || (m.occ[n] & 2)) continue;
      m.seen[n] = st; q[tail++] = n;
    }
  }
  return tail;
}

function tronBot(s, me, g, B) {
  const m = tronMem(B);
  const out = tronThink(s, me, g, B, m);
  m.hx[m.hn % 32] = out.x; m.hy[m.hn % 32] = out.y; m.hn++;
  return out;
}

function tronThink(s, me, g, B, m) {
  const p = s.p[me], L = B.level;
  if (!p || !p.alive || s.phase === 'over') return { x: 0, y: 0 };
  tronGrid(s, m, me);
  const pac = g.variant === 'pacman';
  const v = BASE_SPEED * Math.min(MAX_RAMP, 1 + RAMP * (s.phase === 'run' ? s.rt : 0));
  const others = [];
  for (const q of s.p) if (q.i !== me && q.alive) { others.push({ x: q.x, y: q.y, a: q.a, v: v * (q.turbo ? TURBO : 1), i: q.i, air: q.air }); }

  // Pose after the commands already on their way (reaction delay).
  let x = p.x, y = p.y, a = p.a;
  const pend = Math.round(PEND_T[L] * 60), dt = g.dt || 1 / 60, vs = v * (p.turbo ? TURBO : 1);
  for (let j = Math.min(pend, m.hn); j >= 1; j--) {
    const h = (m.hn - j) % 32, hx = m.hx[h], hy = m.hy[h];
    if (Math.hypot(hx, hy) >= 0.35) a = wrapAngle(a + clamp(wrapAngle(Math.atan2(hy, hx) - a), -TURN * dt, TURN * dt));
    if (s.phase === 'run') { x += Math.cos(a) * vs * dt; y += Math.sin(a) * vs * dt; }
  }
  const tau0 = s.phase === 'run' ? pend * dt : READY_T - s.pt + PEND_T[L];

  // Feelers.
  const turnStep = (TURN * FSTEP) / v;
  let bestF = -1;
  for (let k = 0; k < CANDS; k++) {
    const th = a + (k - (CANDS >> 1)) * CSTEP;
    let hx = x, hy = y, h = a, d = 0;
    while (d < FEEL) {
      h += clamp(wrapAngle(th - h), -turnStep, turnStep);
      hx += Math.cos(h) * FSTEP; hy += Math.sin(h) * FSTEP; d += FSTEP;
      if (tronBlocked(s, g, m, p, hx, hy, d, tau0 + d / v, others)) break;
    }
    m.F[k] = d; m.EX[k] = hx; m.EY[k] = hy;
    if (d > bestF) bestF = d;
  }

  // Target to chase (cut-off point in front of the nearest rival) and potions.
  let tx = null, ty = null;
  if (L > 0 && others.length) {
    let bq = null, bd = Infinity;
    for (const q of others) { const d = Math.hypot(q.x - x, q.y - y); if (d < bd) { bd = d; bq = q; } }
    if (bd > 160) { // no close-range chases: that is how you crash into their trail
      const lead = Math.min(260, bd * 0.7) + 40;
      tx = bq.x + Math.cos(bq.a) * lead; ty = bq.y + Math.sin(bq.a) * lead;
    }
  }
  let ox = null, oy = null;
  if (L > 0 && (p.fuel < 0.7 || p.jcd > 0)) {
    let bd = 330;
    for (const o of s.orbs) { const d = Math.hypot(o.x - x, o.y - y); if (d < bd) { bd = d; ox = o.x; oy = o.y; } }
  }

  // Choose: free run first, then open space, then intent.
  const safe = bestF * 0.92;
  let pick = CANDS >> 1, pv = -Infinity;
  for (let k = 0; k < CANDS; k++) {
    const F = m.F[k];
    let val = F;
    if (F >= safe) {
      const th = a + (k - (CANDS >> 1)) * CSTEP;
      if (L > 0 || B.rng() < 0.5) val += Math.min(tronSpace(m, m.EX[k], m.EY[k], L > 0 ? 420 : 260, pac), L > 0 ? 420 : 260) * 0.9;
      const dir = (px, py) => { const ang = Math.atan2(py - y, px - x); return Math.cos(wrapAngle(ang - th)); };
      if (tx !== null) val += dir(tx, ty) * (L === 2 ? 70 : 60);
      if (ox !== null) val += dir(ox, oy) * 50;
      if (L === 0 && m.wob) val += Math.cos(wrapAngle(th - m.wob)) * 40; // easy: wanders a bit
      val -= Math.abs(k - (CANDS >> 1)) * 4;     // prefer straight lines
      if (k === m.pick) val += 15;
    } else val -= 2000;
    if (val > pv) { pv = val; pick = k; }
  }
  if (L === 0 && (!m.wobT || g.t > m.wobT)) { m.wobT = g.t + 1 + B.rng() * 2; m.wob = B.rng() * Math.PI * 2; }
  const th = a + (pick - (CANDS >> 1)) * CSTEP;
  m.pick = pick;
  const out = { x: Math.cos(th), y: Math.sin(th) };

  if (s.phase !== 'run') return out;
  const F = m.F[pick];
  // Jump over a trail when the crash cannot be avoided any more.
  if (p.jcd <= 0 && !p.air && F < v * (L === 2 ? 0.3 : 0.25) + 20 && (L > 0 || B.rng() < 0.4)) {
    const land = v * JUMP_T + 30;
    const lx = x + Math.cos(a) * land, ly = y + Math.sin(a) * land;
    const wallOk = pac || (lx > 30 && lx < W - 30 && ly > 30 && ly < H - 30);
    let ok = wallOk;
    for (let d = 0; ok && d <= 120; d += FSTEP) ok = !tronBlocked(s, g, m, p, lx + Math.cos(a) * d, ly + Math.sin(a) * d, land + d, tau0 + (land + d) / v, others);
    for (const q of others) if (ok && Math.hypot(q.x + Math.cos(q.a) * q.v * JUMP_T - lx, q.y + Math.sin(q.a) * q.v * JUMP_T - ly) < 90) ok = false;
    if (ok) out.tapB = true;
  }
  // Turbo: hard bot cuts rivals off / grabs potions when the road ahead is long and clear.
  if (L === 2 && p.fuel > 0.25 && F >= FEEL && Math.abs(pick - (CANDS >> 1)) <= 1 && (tx !== null || ox !== null)) {
    const gx = ox !== null ? ox : tx, gy = ox !== null ? oy : ty;
    const ang = Math.atan2(gy - y, gx - x);
    if (Math.cos(wrapAngle(ang - a)) > 0.93 && Math.hypot(gx - x, gy - y) < 450) out.a = true;
  }
  return out;
}
