// Mastri Muratori — tetromino tower race with real physics (Planck.js), one field per player (2–4 players).
import * as planck from '../../vendor/planck.mjs';
import { clamp, r1, r2 } from '../core/geom.js';

const W = 600, H = 1000, CX = W / 2;
const SCALE = 40;                 // world units per meter (physics runs in meters)
const CELL = 46;                  // tetromino cell size (world units)
const STEP = CELL / 2;            // horizontal move step: half a cell
// The base sits above the bottom ~15% of the field: on the shared phone that strip is covered by the HUD bar.
const BASE_W = 250, BASE_H = 44, BASE_TOP = 800, PILLAR_W = 150;
const GY = BASE_TOP - 880;        // vertical offset of the decorative ground (hills, avatar)
const LINE_Y = 250;               // finish line: tower ~12 cells tall
const SPAWN_TOP = 70;
const HOLD_WIN = 2;               // seconds above the line to win
const MAX_PIECES = 40;
const FALL_V0 = 105, FALL_V1 = 190, FAST_V = 520, LAND_V = 40; // gentle landing = predictable stacking
const PIECES_PER_CHARGE = 4, MAX_CHARGE = 2;
const GIANT = 2;
const FRICTION = 0.85, SOAP_FRICTION = 0.03;
const WIND_A = 0.7, WIND_DRIFT = 40, WIND_EVERY = 8;
const QUAKE_EVERY = 10, QUAKE_LEN = 1.2, QUAKE_WARN = 1.6, QUAKE_W = Math.PI * 2 * 2.5, QUAKE_A = 9 / (QUAKE_W * QUAKE_W);
const QUAKE_KX = 0.65, QUAKE_KY = 0.6, QUAKE_KW = 0.5; // random kicks (m/s, rad/s)

// Tetromino definitions in cell units (row grows downward) + rectangles used for physics.
const KINDS = ['I', 'O', 'T', 'L', 'J', 'S', 'Z'];
const RAW = {
  I: { cells: [[0, 0], [1, 0], [2, 0], [3, 0]], rects: [[0, 0, 4, 1]], col: '#35e0ff', dk: '#0b6f8c' },
  O: { cells: [[0, 0], [1, 0], [0, 1], [1, 1]], rects: [[0, 0, 2, 2]], col: '#ffd93b', dk: '#a87f00' },
  T: { cells: [[0, 0], [1, 0], [2, 0], [1, 1]], rects: [[0, 0, 3, 1], [1, 1, 1, 1]], col: '#c26bff', dk: '#62249a' },
  L: { cells: [[0, 0], [0, 1], [0, 2], [1, 2]], rects: [[0, 0, 1, 3], [1, 2, 1, 1]], col: '#ff9a3b', dk: '#9e4c06' },
  J: { cells: [[1, 0], [1, 1], [1, 2], [0, 2]], rects: [[1, 0, 1, 3], [0, 2, 1, 1]], col: '#4f7dff', dk: '#1d3796' },
  S: { cells: [[1, 0], [2, 0], [0, 1], [1, 1]], rects: [[1, 0, 2, 1], [0, 1, 2, 1]], col: '#5ef07c', dk: '#1a8c36' },
  Z: { cells: [[0, 0], [1, 0], [1, 1], [2, 1]], rects: [[0, 0, 2, 1], [1, 1, 2, 1]], col: '#ff4f6d', dk: '#9c142c' },
};
// Centered on the centroid (= center of mass), in world units.
const PIECES = {};
for (const k of KINDS) {
  const R = RAW[k];
  const cx = R.cells.reduce((a, c) => a + c[0] + 0.5, 0) / 4;
  const cy = R.cells.reduce((a, c) => a + c[1] + 0.5, 0) / 4;
  const rects = R.rects.map(([x, y, w, h]) => ({ x: (x + w / 2 - cx) * CELL, y: (y + h / 2 - cy) * CELL, hw: (w * CELL) / 2, hh: (h * CELL) / 2 }));
  let rad = 0;
  for (const r of rects) rad = Math.max(rad, Math.hypot(Math.abs(r.x) + r.hw, Math.abs(r.y) + r.hh));
  PIECES[k] = { k, col: R.col, dk: R.dk, rects, rad, cells: R.cells.map(([c, r]) => [(c + 0.5 - cx) * CELL, (r + 0.5 - cy) * CELL]) };
}

// Physics shapes are immutable and shared between bodies.
const shapeCache = new Map();
function shapesFor(k, s) {
  const key = k + s;
  let sh = shapeCache.get(key);
  if (!sh) {
    sh = PIECES[k].rects.map((r) => planck.Box((r.hw * s) / SCALE, (r.hh * s) / SCALE, planck.Vec2((r.x * s) / SCALE, (r.y * s) / SCALE), 0));
    shapeCache.set(key, sh);
  }
  return sh;
}

// Axis-aligned extents of a rotated piece, relative to its centroid.
function extents(k, s, a) {
  const c = Math.cos(a), sn = Math.sin(a);
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const r of PIECES[k].rects) {
    for (let q = 0; q < 4; q++) {
      const lx = (r.x + (q & 1 ? r.hw : -r.hw)) * s, ly = (r.y + (q & 2 ? r.hh : -r.hh)) * s;
      const X = lx * c - ly * sn, Y = lx * sn + ly * c;
      if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    }
  }
  return { x0, x1, y0, y1 };
}

function nextKind(s, f, g) {
  // Shared 7-bag sequence: both players get the same pieces (fairness).
  while (s.seq.length <= f.n) { const bag = KINDS.slice(); g.rng.shuffle(bag); s.seq.push(...bag); }
  return s.seq[f.n++];
}

function makeField(i, s, g) {
  const grav = 10 * (g.mods.gravity || 1);
  const world = new planck.World({ gravity: planck.Vec2(0, grav) });
  const base = world.createBody({ type: s.quakeOn ? 'kinematic' : 'static', position: planck.Vec2(CX / SCALE, (BASE_TOP + BASE_H / 2) / SCALE) });
  base.createFixture(planck.Box(BASE_W / 2 / SCALE, BASE_H / 2 / SCALE), { friction: 1, restitution: s.rest * 0.6 });
  const f = {
    i, world, base, pieces: [], cur: null, next: null, n: 0, placed: 0, lost: 0, charge: 0, prog: 0,
    hold: 0, holdTick: 0, top: BASE_TOP, spawnIn: 0.4, mv: 0, rep: 0, fastLock: false, lostT: [], crashT: -9, cursedT: -9,
    fxK: '', fxT: 0, id: 0, mood: 'ok',
  };
  f.next = { k: nextKind(s, f, g), s: 1, sl: false };
  return f;
}

// Does the active piece overlap anything (base or placed pieces) at (x, y)?
function overlaps(f, c, x, y) {
  const px = x / SCALE, py = y / SCALE, rr = (PIECES[c.k].rad * c.s) / SCALE + 0.05;
  const xf = new planck.Transform(planck.Vec2(px, py), c.a);
  let hit = false;
  f.world.queryAABB(new planck.AABB(planck.Vec2(px - rr, py - rr), planck.Vec2(px + rr, py + rr)), (fix) => {
    const sh = fix.getShape(), bxf = fix.getBody().getTransform();
    for (const s of c.shapes) if (planck.testOverlap(s, 0, sh, 0, xf, bxf)) { hit = true; return false; }
    return true;
  });
  return hit;
}

function spawn(s, f, g) {
  const nx = f.next;
  const e = extents(nx.k, nx.s, 0);
  const c = { k: nx.k, s: nx.s, sl: nx.sl, rot: 0, a: 0, x: CX, y: SPAWN_TOP - e.y0, shapes: shapesFor(nx.k, nx.s), e };
  c.x = clamp(c.x, 6 - e.x0, W - 6 - e.x1);
  // Tower already reaching the spawn point: wait instead of spawning inside it (it would lock instantly).
  if (overlaps(f, c, c.x, c.y)) { f.spawnIn = 0.2; return; }
  f.next = { k: nextKind(s, f, g), s: 1, sl: false };
  f.cur = c;
  f.fastLock = !!f.downHeld; // a "down" still held from the previous piece must be released first
  if (nx.s > 1) g.sfx('grow', { pitch: 0.7 });
}

// Horizontal move with collision: slides flush against obstacles (leaving a tiny gap).
function shift(f, dx) {
  const c = f.cur;
  const nx = clamp(c.x + dx, 6 - c.e.x0, W - 6 - c.e.x1);
  dx = nx - c.x;
  if (Math.abs(dx) < 0.01) return false;
  if (!overlaps(f, c, c.x + dx, c.y)) { c.x += dx; return true; }
  let lo = 0, hi = 1;
  for (let k = 0; k < 6; k++) { const m = (lo + hi) / 2; if (overlaps(f, c, c.x + dx * m, c.y)) hi = m; else lo = m; }
  const go = Math.abs(dx * lo) - 1.5;
  if (go > 0) c.x += Math.sign(dx) * go;
  return false;
}

function rotate(f, g) {
  const c = f.cur;
  const rot = (c.rot + 1) % 4, a = (rot * Math.PI) / 2;
  const e = extents(c.k, c.s, a);
  const old = { rot: c.rot, a: c.a, e: c.e, x: c.x, y: c.y };
  c.rot = rot; c.a = a; c.e = e;
  for (const [ox, oy] of [[0, 0], [STEP, 0], [-STEP, 0], [0, -STEP], [CELL, 0], [-CELL, 0]]) {
    const x = clamp(old.x + ox, 6 - e.x0, W - 6 - e.x1), y = old.y + oy;
    if (!overlaps(f, c, x, y)) { c.x = x; c.y = y; g.sfx('click', { vol: 0.5, pitch: 1.2 }); return; }
  }
  Object.assign(c, old);
  g.sfx('bonk', { vol: 0.4, pitch: 1.6 });
}

// Turn the active piece into a dynamic Planck body. landed=false: it missed the base.
function release(s, f, g, landed) {
  const c = f.cur;
  const body = f.world.createBody({ type: 'dynamic', position: planck.Vec2(c.x / SCALE, c.y / SCALE), angle: c.a, linearDamping: 0.1, angularDamping: 0.6 });
  for (const sh of c.shapes) body.createFixture(sh, { density: 1, friction: c.sl ? SOAP_FRICTION : FRICTION, restitution: s.rest });
  body.setLinearVelocity(planck.Vec2((s.wind * WIND_DRIFT * 0.3) / SCALE, (landed ? LAND_V : FALL_V0) / SCALE));
  f.pieces.push({ body, k: c.k, s: c.s, sl: c.sl, st: false, id: f.id++, landed });
  f.cur = null;
  f.spawnIn = 0.45;
  if (!landed) {
    g.sfx('whoosh', { vol: 0.6 });
    g.text(c.x, BASE_TOP - 40, 'MANCATO!', { player: f.i, size: 34, field: f.i });
    return;
  }
  f.placed++;
  g.sfx('stack', { pitch: 1 / Math.sqrt(c.s) });
  g.burst(c.x, c.y + c.e.y1, { color: '#fff', n: c.s > 1 ? 16 : 6, speed: 140, size: 6, field: f.i });
  if (c.s > 1) g.shake(0.25);
  g.vibrate(f.i, 25);
  // Comeback: a tower 2+ floors behind charges its magic faster.
  f.behind = bestOther(s, f) - towerScore(f) >= CELL * 2;
  if (++f.prog >= (f.behind ? PIECES_PER_CHARGE - 1 : PIECES_PER_CHARGE)) {
    f.prog = 0;
    if (f.charge < MAX_CHARGE) {
      f.charge++;
      g.sfx('powerup');
      g.text(90, 160, 'INCANTO PRONTO!', { player: f.i, size: 30, field: f.i });
    }
  }
}

// B = MALOCCHIO on the leading rival (giant or greasy next piece); UP + B = EDERA (glue your last 3 pieces).
// The rival hit by the evil eye: the tallest other tower (ties: the next seat after the caster).
function target(s, f) {
  let best = null, bs = -1;
  for (let k = 1; k < s.f.length; k++) {
    const o = s.f[(f.i + k) % s.f.length], sc = towerScore(o);
    if (sc > bs) { bs = sc; best = o; }
  }
  return best;
}
const bestOther = (s, f) => Math.max(...s.f.filter((o) => o !== f).map(towerScore));
function castMagic(s, f, g, wantIvy) {
  const opp = target(s, f);
  const ivy = f.pieces.filter((pc) => pc.landed && !pc.st && pc.body.getPosition().y * SCALE < BASE_TOP).slice(-3);
  if (wantIvy && !ivy.length) { g.sfx('buzzer', { vol: 0.4 }); g.text(CX, 300, 'NIENTE DA INCOLLARE', { player: f.i, size: 30, field: f.i }); return; }
  f.charge--;
  if (wantIvy) {
    for (const pc of ivy) {
      pc.st = true;
      pc.body.setLinearVelocity(planck.Vec2(0, 0));
      pc.body.setAngularVelocity(0);
      pc.body.setType('static');
      const p = pc.body.getPosition();
      g.burst(p.x * SCALE, p.y * SCALE, { color: '#5ef07c', n: 14, speed: 200, size: 8, field: f.i });
    }
    g.say('EDERA! 🌿');
    g.sfx('grow'); g.sfx('powerup', { pitch: 1.3 });
    f.fxK = 'ivy'; f.fxT = 1.4;
  } else {
    const kind = opp.next.s > 1 ? 'soap' : opp.next.sl ? 'giant' : g.rng.chance(0.5) ? 'giant' : 'soap';
    if (kind === 'giant') opp.next.s = GIANT; else opp.next.sl = true;
    g.say(kind === 'giant' ? 'MASSO GIGANTE! 🪨' : 'PIETRA UNTA DI LARDO! 🧈');
    g.sfx('zap'); g.sfx(kind === 'giant' ? 'grow' : 'slide', { pitch: 0.8 });
    g.flash('#9b4dff', 0.35);
    g.vibrate(opp.i, 160);
    opp.fxK = kind; opp.fxT = 1.6; opp.cursedT = g.t;
    f.fxK = 'cast'; f.fxT = 0.8;
  }
}

function controlPiece(s, f, I, g, dt) {
  const c = f.cur;
  const presses = Math.min(2, I.aN || (I.aP ? 1 : 0));
  for (let k = 0; k < presses && f.cur; k++) rotate(f, g);
  // Dominant axis + hysteresis: a stick pushed "down" does not also nudge the piece sideways, no jitter.
  const ax = Math.abs(I.sx || 0), down = I.sy || 0;
  const horiz = ax >= Math.abs(down) * 0.6;
  let dir = 0;
  if (horiz && ax > 0.5) dir = Math.sign(I.sx);
  else if (horiz && ax > 0.3 && Math.sign(I.sx) === f.mv) dir = f.mv;
  const fast = !f.fastLock && down > 0.5 && down >= ax * 0.6;
  if (dir !== f.mv) {
    f.mv = dir;
    if (dir) { shift(f, dir * STEP); f.rep = 0.2; g.sfx('tick', { vol: 0.25, pitch: 1.4 }); }
  } else if (dir) {
    f.rep -= dt;
    if (f.rep <= 0) { f.rep = 0.07; shift(f, dir * STEP); }
  }
  if (s.wind) shift(f, s.wind * WIND_DRIFT * dt);
  // Falling: kinematic, locks as soon as it touches the tower or the base.
  const v = fast ? FAST_V : FALL_V0 + (FALL_V1 - FALL_V0) * Math.min(1, g.t / 55);
  const dy = v * dt;
  if (overlaps(f, c, c.x, c.y)) return release(s, f, g, true);
  if (!overlaps(f, c, c.x, c.y + dy)) {
    c.y += dy;
    if (c.y + c.e.y0 > BASE_TOP + BASE_H) release(s, f, g, false);
    else c.gy = ghostY(f, c);
    c.fast = fast;
    return;
  }
  let lo = 0, hi = dy;
  for (let k = 0; k < 7; k++) { const m = (lo + hi) / 2; if (overlaps(f, c, c.x, c.y + m)) hi = m; else lo = m; }
  c.y += lo;
  release(s, f, g, true);
}

// Where would the active piece lock if it kept falling straight down? (ghost preview; null = it misses)
function ghostY(f, c) {
  const step = CELL / 2, limit = BASE_TOP + BASE_H - c.e.y0;
  let y = c.y;
  while (y < limit && !overlaps(f, c, c.x, y + step)) y += step;
  if (y >= limit) return null;
  let lo = 0, hi = step;
  for (let k = 0; k < 5; k++) { const m = (lo + hi) / 2; if (overlaps(f, c, c.x, y + m)) hi = m; else lo = m; }
  return y + lo;
}

function physics(s, f, g) {
  const dt = Math.min(g.dt, 1 / 30);
  if (s.wind) {
    for (const pc of f.pieces) {
      const b = pc.body;
      if (b.isDynamic()) b.applyForceToCenter(planck.Vec2(s.wind * WIND_A * b.getMass(), 0), false);
    }
  }
  if (s.quakeOn) {
    if (s.quakeT > 0) {
      const tau = QUAKE_LEN - s.quakeT;
      f.base.setLinearVelocity(planck.Vec2(QUAKE_A * QUAKE_W * Math.cos(QUAKE_W * tau), 0.15 * QUAKE_A * 2 * QUAKE_W * Math.cos(2 * QUAKE_W * tau)));
      // Rattle: shared random kicks (same for both fields), stronger higher up the tower.
      if (s.kick) {
        f.pieces.forEach((pc, k) => {
          const b = pc.body;
          if (!b.isDynamic()) return;
          const kv = s.kick[k % s.kick.length], up = clamp((BASE_TOP - b.getPosition().y * SCALE) / 400, 0.4, 1.4);
          const v = b.getLinearVelocity();
          b.setLinearVelocity(planck.Vec2(v.x + kv[0] * up, v.y - kv[1]));
          b.setAngularVelocity(b.getAngularVelocity() + kv[2] * up);
        });
      }
    } else {
      f.base.setLinearVelocity(planck.Vec2(0, 0));
      f.base.setTransform(planck.Vec2(CX / SCALE, (BASE_TOP + BASE_H / 2) / SCALE), 0);
    }
  }
  if (dt > 0) f.world.step(dt, 8, 3);

  // Lost pieces: fell into the clouds.
  for (let k = f.pieces.length - 1; k >= 0; k--) {
    const pc = f.pieces[k], p = pc.body.getPosition();
    if (p.y * SCALE > H + 150 || Math.abs(p.x * SCALE - CX) > W) {
      f.world.destroyBody(pc.body);
      f.pieces.splice(k, 1);
      f.lost++;
      f.lostT.push(g.t);
      g.sfx('fall', { vol: 0.5, pitch: 0.9 + g.rng() * 0.3 });
      g.burst(clamp(p.x * SCALE, 30, W - 30), H - 40, { color: '#ffe0f0', n: 10, speed: 160, size: 9, field: f.i });
    }
  }
  f.lostT = f.lostT.filter((t) => g.t - t < 3);
  const recent = f.lostT.filter((t) => g.t - t < 1.5).length;
  if (recent >= 3 && g.t - f.crashT > 2.5) {
    f.crashT = g.t;
    g.sfx('crash'); g.sfx('break', { pitch: 0.8 });
    g.shake(0.55); g.vibrate(f.i, 250);
    g.text(CX, 420, 'CROLLO!', { player: f.i, size: 64, field: f.i });
  }

  // Tower top = highest point of resting pieces.
  let top = BASE_TOP;
  for (const pc of f.pieces) {
    const b = pc.body, xf = b.getTransform();
    if (xf.p.y * SCALE > BASE_TOP + 10) continue;
    if (b.isDynamic() && b.isAwake()) {
      const v = b.getLinearVelocity();
      if (v.x * v.x + v.y * v.y > 0.35 * 0.35 || Math.abs(b.getAngularVelocity()) > 0.8) continue;
    }
    for (let fx = b.getFixtureList(); fx; fx = fx.getNext()) {
      for (const vt of fx.getShape().m_vertices) {
        const y = (xf.p.y + xf.q.s * vt.x + xf.q.c * vt.y) * SCALE;
        if (y < top) top = y;
      }
    }
  }
  f.top = top;
}

const towerScore = (f) => Math.round(BASE_TOP - f.top);

// ---------- Bot helpers ----------
const BOT_LAG = [0.34, 0.2, 0.09].map((d) => d + 1 / 60); // the driver's reaction delay per level (+1 tick)
const BOT_GAP = [0.22, 0.15, 0.11]; // spacing of repeated presses (above the driver's max press rate)
const COLW = STEP / 2, NCOL = Math.ceil(W / COLW);
const colX = (c) => (c + 0.5) * COLW;
const colOf = (x) => Math.floor(x / COLW - 0.5 + 1e-6);
const botProf = new Float64Array(NCOL), botTmp = new Float64Array(NCOL);
const botBot = new Float64Array(NCOL), botTop = new Float64Array(NCOL);
const botPoly = new Float64Array(16);

// Tower skyline: for every thin column the y of the highest resting surface (Infinity = nothing below).
function towerProfile(f, prof) {
  prof.fill(Infinity);
  const bp = f.base.getPosition(), bx = bp.x * SCALE, by = bp.y * SCALE - BASE_H / 2;
  for (let c = 0; c < NCOL; c++) if (Math.abs(colX(c) - bx) < BASE_W / 2) prof[c] = by;
  for (const pc of f.pieces) {
    const b = pc.body, xf = b.getTransform();
    if (xf.p.y * SCALE > BASE_TOP + 40) continue;
    const v = b.getLinearVelocity();
    if (v.x * v.x + v.y * v.y > 4) continue; // tumbling away: not a surface
    for (let fx = b.getFixtureList(); fx; fx = fx.getNext()) {
      const vs = fx.getShape().m_vertices, nv = Math.min(8, vs.length);
      let x0 = 1e9, x1 = -1e9;
      for (let k = 0; k < nv; k++) {
        const X = (xf.p.x + xf.q.c * vs[k].x - xf.q.s * vs[k].y) * SCALE, Y = (xf.p.y + xf.q.s * vs[k].x + xf.q.c * vs[k].y) * SCALE;
        botPoly[2 * k] = X; botPoly[2 * k + 1] = Y;
        if (X < x0) x0 = X; if (X > x1) x1 = X;
      }
      for (let c = Math.max(0, colOf(x0) + 1), c1 = Math.min(NCOL - 1, colOf(x1)); c <= c1; c++) {
        const X = colX(c);
        let top = Infinity;
        for (let k = 0; k < nv; k++) {
          const ax = botPoly[2 * k], ay = botPoly[2 * k + 1], k2 = (k + 1) % nv, bx2 = botPoly[2 * k2], by2 = botPoly[2 * k2 + 1];
          if ((ax <= X && X <= bx2) || (bx2 <= X && X <= ax)) {
            const y = bx2 === ax ? Math.min(ay, by2) : ay + ((by2 - ay) * (X - ax)) / (bx2 - ax);
            if (y < top) top = y;
          }
        }
        if (top < prof[c]) prof[c] = top;
      }
    }
  }
}

// Score of dropping piece c with rotation rot at x on the skyline (null = impossible / misses the tower).
function botEval(f, c, rot, x, prof, goal) {
  const P = PIECES[c.k], h = (CELL * c.s) / 2, ca = [1, 0, -1, 0][rot], sa = [0, 1, 0, -1][rot];
  const e = extents(c.k, c.s, (rot * Math.PI) / 2);
  // The way there must be free (high towers late in the game).
  for (let k = Math.max(0, colOf(Math.min(c.x, x) + e.x0) + 1), k1 = Math.min(NCOL - 1, colOf(Math.max(c.x, x) + e.x1)); k <= k1; k++) {
    if (prof[k] < c.y + e.y1 + 4) return null;
  }
  const c0 = Math.max(0, colOf(x + e.x0) + 1), c1 = Math.min(NCOL - 1, colOf(x + e.x1));
  for (let k = c0; k <= c1; k++) { botBot[k] = -Infinity; botTop[k] = Infinity; }
  let land = Infinity;
  for (const [lx, ly] of P.cells) {
    const X = (lx * ca - ly * sa) * c.s + x, Y = (lx * sa + ly * ca) * c.s;
    for (let k = Math.max(c0, colOf(X - h) + 1), k1 = Math.min(c1, colOf(X + h)); k <= k1; k++) {
      land = Math.min(land, prof[k] - (Y + h));
      if (Y + h > botBot[k]) botBot[k] = Y + h;
      if (Y - h < botTop[k]) botTop[k] = Y - h;
    }
  }
  if (!Number.isFinite(land) || land < c.y) return null;
  botTmp.set(prof);
  let holes = 0, hang = 0, cMin = 1e9, cMax = -1e9, top = Infinity;
  for (let k = c0; k <= c1; k++) {
    if (botBot[k] === -Infinity) continue;
    const gap = prof[k] - (land + botBot[k]);
    if (!Number.isFinite(gap)) hang++;
    else {
      holes += Math.min(gap, 3 * CELL);
      if (gap < 3) { cMin = Math.min(cMin, colX(k)); cMax = Math.max(cMax, colX(k)); }
    }
    botTmp[k] = land + botTop[k];
    top = Math.min(top, botTmp[k]);
  }
  const stable = x >= cMin - 4 && x <= cMax + 4;
  const margin = stable ? Math.min(x - cMin, cMax - x) + COLW / 2 : 0;
  let bump = 0;
  const b0 = colOf(CX - BASE_W / 2) + 1, b1 = colOf(CX + BASE_W / 2);
  for (let k = b0; k < b1; k++) bump += Math.min(Math.abs(botTmp[k] - botTmp[k + 1]), 3 * CELL);
  let sc = -3 * (holes * COLW) / (CELL * CELL) - (0.6 * bump) / CELL - 2.5 * hang - 1.5 * clamp(1 - margin / CELL, 0, 1);
  if (!stable) sc -= 40;
  const height = (BASE_TOP - top) / CELL;
  sc += (goal ? 1.2 : 2) * height; // grow (in the last seconds stability counts a bit more)
  if (stable && top <= LINE_Y - 4) sc += 25;
  sc -= (5 * Math.abs(x - CX)) / CELL; // a narrow tower in the middle stands best
  return sc;
}

function botPlan(s, f, c, L, g, rng) {
  towerProfile(f, botProf);
  // Tower already over the banner: do not risk it, throw the block away beside the cliff.
  if (f.hold > 0 || f.top <= LINE_Y) {
    for (const rot of [c.rot, (c.rot + 1) % 4]) {
      const e = extents(c.k, c.s, (rot * Math.PI) / 2);
      for (const side of [-1, 1]) {
        const x = side < 0 ? 6 - e.x0 : W - 6 - e.x1;
        if (side < 0 ? x + e.x1 > CX - BASE_W / 2 - 4 : x + e.x0 < CX + BASE_W / 2 + 4) continue;
        let free = true;
        for (let k = Math.max(0, colOf(Math.min(c.x, x) + e.x0) + 1), k1 = Math.min(NCOL - 1, colOf(Math.max(c.x, x) + e.x1)); k <= k1; k++) {
          if (botProf[k] < c.y + Math.max(e.y1, c.e.y1) + 4) free = false;
        }
        if (free) return { rot, x, sc: 99, away: true };
      }
    }
  }
  const goal = g.t > 50 || f.top - LINE_Y < 3 * CELL;
  let best = null;
  const R0 = L === 0 ? 2 : 0; // Scudiero does not bother turning blocks, and stays near the middle
  for (let rot = 0; rot < (R0 ? 1 : 4); rot++) {
    const e = extents(c.k, c.s, (rot * Math.PI) / 2);
    for (let j = R0 ? -R0 : -13; j <= (R0 || 13); j++) {
      const x = c.x + j * STEP;
      if (x < 6 - e.x0 || x > W - 6 - e.x1 || Math.abs(x - CX) > BASE_W / 2 + CELL) continue;
      let sc = botEval(f, c, rot, x, botProf, goal);
      if (sc === null) continue;
      sc += -0.15 * ((rot - c.rot + 4) % 4) - 0.02 * Math.abs(j) + (rng() - 0.5) * [1.5, 0.5, 0][L];
      if (!best || sc > best.sc) best = { rot, x, sc };
    }
  }
  return best;
}

// Magic: Re/Cavaliere glue their tower with ivy and curse a rival that is getting close; Scudiero casts at
// random moments (ivy if there is something to glue).
function botMagic(s, f, M, L, g, B) {
  if (f.charge <= 0 || g.t < (M.nextMagic || 0)) return 0;
  let glue = 0;
  for (const pc of f.pieces) if (pc.landed && !pc.st && pc.body.getPosition().y * SCALE < BASE_TOP) glue++;
  const last = f.pieces[f.pieces.length - 1];
  const calm = !last || last.body.getLinearVelocity().length() < 0.3;
  if (L === 0) return B.rng() < 0.01 ? (glue >= 3 && calm ? 2 : 1) : 0;
  let other = 0, oppHold = 0;
  for (const o of s.f) if (o !== f) { other = Math.max(other, towerScore(o)); oppHold = Math.max(oppHold, o.hold); }
  const mine = towerScore(f);
  const threat = oppHold > 0 || other >= BASE_TOP - LINE_Y - 3 * CELL || (other > mine + CELL && other > 5 * CELL);
  if (threat && (L === 2 || f.charge >= MAX_CHARGE)) return 1;
  if (glue >= 3 && calm && mine > 3 * CELL && (L === 2 || f.charge >= MAX_CHARGE || s.quakeWarn)) return 2;
  return 0;
}

export default {
  id: 'torre',
  name: 'Mastri Muratori',
  rule: 'Impila i blocchi oltre lo stendardo del re e tienili su!',
  verb: 'COSTRUISCI!',
  inspired: 'Tricky Towers',
  cam: 'side',
  split: true,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Ruota', b: 'Incanto' },
  help: {
    goal: 'Costruisci per il re una torre che superi lo stendardo a scacchi e tienila su per 2 secondi.',
    dir: '◀ ▶ sposta il blocco di mezzo quadretto · ▼ lo fa cadere veloce. La sagoma luminosa mostra dove atterrerà.',
    a: 'RUOTA il blocco di 90° (se tocca qualcosa prova a spostarlo di lato).',
    b: 'INCANTO (si carica ogni 4 blocchi): B = MALOCCHIO sulla torre più alta degli altri, il suo prossimo blocco sarà un masso gigante o unto di lardo. ▲ + B = EDERA, incolla i tuoi ultimi 3 blocchi.',
    tips: ['Appoggia i blocchi di piatto: le punte fanno ribaltare la torre', "Chi è indietro di 2 piani ricarica l'incanto ogni 3 blocchi", 'Tieni ▼ solo quando il blocco è già allineato'],
  },
  duration: 60,
  supports: ['gravity'],
  noMods: ['scambio'],
  variants: [
    { id: 'terremoto', name: 'Il Drago Russa', desc: 'Sotto la rupe dorme un drago: ogni 10 secondi si gira e trema tutto!' },
    { id: 'gelatina', name: 'Mattoni di Budino', desc: 'Il fornaio di corte ha sbagliato ricetta: i blocchi rimbalzano!' },
    { id: 'vento', name: 'Tramontana', desc: 'Un vento laterale che cambia verso ogni 8 s!' },
  ],

  init(g) {
    const s = {
      seq: [], rest: g.variant === 'gelatina' ? 0.62 : 0,
      quakeOn: g.variant === 'terremoto', quakeNext: QUAKE_EVERY, quakeT: 0, quakeWarn: false, kick: null, kickIn: 0,
      wind: 0, windNext: WIND_EVERY, windWarn: false, warn10: false, win: -1,
    };
    if (g.variant === 'vento') s.wind = g.rng.chance(0.5) ? 1 : -1;
    s.f = [...Array(g.n || 2).keys()].map((i) => makeField(i, s, g));
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    // Variant timers (same events in both fields).
    if (s.quakeOn) {
      if (!s.quakeWarn && g.t >= s.quakeNext - QUAKE_WARN) { s.quakeWarn = true; g.say('IL DRAGO SI SVEGLIA! ⚠️'); g.sfx('horn'); }
      if (s.quakeT <= 0 && g.t >= s.quakeNext) {
        s.quakeT = QUAKE_LEN; s.quakeNext += QUAKE_EVERY; s.quakeWarn = false;
        g.sfx('bigexplode', { vol: 0.7, pitch: 0.6 }); g.shake(0.8);
        for (const f of s.f) { for (const pc of f.pieces) pc.body.setAwake(true); g.vibrate(f.i, 400); }
      }
      s.kick = null;
      if (s.quakeT > 0) {
        s.quakeT = Math.max(0, s.quakeT - dt);
        if ((s.kickIn -= dt) <= 0) {
          s.kickIn = 0.12;
          s.kick = Array.from({ length: 12 }, () => [g.rng.range(-1, 1) * QUAKE_KX, g.rng() * QUAKE_KY, g.rng.range(-1, 1) * QUAKE_KW]);
        }
      }
    }
    if (s.wind) {
      s.windWarn = g.t >= s.windNext - 1;
      if (g.t >= s.windNext) {
        s.wind = -s.wind; s.windNext += WIND_EVERY;
        g.say(s.wind > 0 ? 'VENTO A DESTRA! ➡️' : '⬅️ VENTO A SINISTRA!');
        g.sfx('whoosh', { pitch: 0.7 });
      }
    }
    if (!s.warn10 && g.t >= 50) { s.warn10 = true; g.say('ULTIMI 10 SECONDI!'); g.sfx('whistle'); }

    for (const f of s.f) {
      const I = inp[f.i];
      f.fxT = Math.max(0, f.fxT - dt);
      if (!g.ended) {
        f.downHeld = (I.sy || 0) >= 0.3;
        if (!f.downHeld) f.fastLock = false;
        if (I.bP && f.charge > 0) castMagic(s, f, g, (I.sy || 0) < -0.5);
        if (f.cur) controlPiece(s, f, I, g, dt);
        else if ((f.spawnIn -= dt) <= 0 && f.pieces.length < MAX_PIECES) spawn(s, f, g);
      }
      physics(s, f, g);
    }

    // Finish line: hold the tower above it for 2 seconds.
    for (const f of s.f) {
      if (f.top <= LINE_Y && !g.ended) {
        if (f.hold === 0) g.text(CX, LINE_Y - 60, 'TIENI!', { player: f.i, size: 44, field: f.i });
        f.wob = false;
        f.hold += dt;
        const tick = Math.floor(f.hold * 3);
        if (tick > f.holdTick) { f.holdTick = tick; g.sfx('tick', { pitch: 1 + tick * 0.1 }); }
      } else if (!g.ended) {
        if (f.hold > 0.5 && !f.wob) { f.wob = true; g.sfx('wobble', { vol: 0.7 }); g.text(CX, LINE_Y - 60, 'NOOO!', { player: f.i, size: 40, field: f.i }); }
        f.hold = Math.max(0, f.hold - dt * 4);
        if (f.hold === 0) f.holdTick = 0;
      }
    }
    if (!g.ended) {
      const done = s.f.filter((f) => f.hold >= HOLD_WIN);
      if (done.length) {
        // Several towers finished in the same step: longest hold, then the tallest tower.
        done.sort((a, b) => b.hold - a.hold || towerScore(b) - towerScore(a));
        const tie = done.length > 1 && done[0].hold === done[1].hold && towerScore(done[0]) === towerScore(done[1]);
        const w = tie ? -1 : done[0].i;
        if (w < 0) { g.end(-1, 'Torri gemelle!'); return; }
        s.win = w;
        g.sfx('fanfare'); g.sfx('tada');
        g.confetti(CX, LINE_Y, { field: w });
        g.slowmo(0.35, 0.9);
        g.vibrate(w, 300);
        g.end(w, 'Torre finita: il re è contento!');
      }
    }

    // Moods for the builder avatars.
    for (const f of s.f) {
      f.mood = s.win >= 0 ? (s.win === f.i ? 'happy' : 'dizzy')
        : s.quakeT > 0 ? 'dizzy'
        : f.lostT.some((t) => g.t - t < 1.5) ? 'scared'
        : g.t - f.cursedT < 2 ? 'angry'
        : f.hold > 0 ? 'happy' : 'ok';
    }
  },

  // Computer player: reads its tower's skyline, picks a stable spot that makes a narrow tall tower in the middle
  // (over the banner: throws the block away), rotates, steps there one half-cell at a time and drops; uses magic.
  bot(s, me, g, B) {
    const f = s.f[me], M = B.mem, L = B.level, lag = BOT_LAG[L];
    const w = { x: 0, y: 0, sx: 0, sy: 0 };
    if (g.ended || !f) return w;
    // Casting: hold ▲ for ivy around the press of B.
    if (M.castT >= 0 && g.t < M.castT + 0.12) {
      if (M.cast === 2) w.sy = w.y = -1;
      if (!M.castTap && g.t >= M.castT + 0.03) { w.tapB = true; M.castTap = true; }
      return w;
    }
    const cast = botMagic(s, f, M, L, g, B);
    if (cast) {
      M.cast = cast; M.castT = g.t; M.castTap = false; M.nextMagic = g.t + 0.6 + lag;
      if (cast === 2) w.sy = w.y = -1;
      return w;
    }
    const c = f.cur;
    if (!c) return w;
    if (M.pid !== f.n) {
      M.pid = f.n; M.tgt = null; M.planT = -9; M.rotT = -9; M.rotTaps = 0; M.rotLeft = 0; M.mvT = -9; M.pulses = 0; M.moves = 0; M.stuck = 0; M.okT = -1;
    }
    // Plan (Re and Cavaliere look again while the piece is still high: the tower may have settled).
    if (!M.tgt || (L >= 1 && !M.pulses && g.t - M.planT > 0.4 && g.t > M.rotT + lag && g.t > M.mvT)) {
      const p = botPlan(s, f, c, L, g, B.rng);
      M.planT = g.t;
      if (p && (!M.tgt || p.sc > M.tgt.sc + 0.5 || p.rot !== M.tgt.rot || Math.abs(p.x - M.tgt.x) > 1)) {
        if (!M.tgt || p.sc > M.tgt.sc + 0.5) M.tgt = p;
        else M.tgt.sc = p.sc;
      }
      if (!M.tgt) return w;
    }
    const T = M.tgt;
    // 1) rotate (one press at a time, wait to see it).
    const dr = (T.rot - c.rot + 4) % 4;
    if (M.rotLeft > 0) {
      if (g.t >= M.rotT + BOT_GAP[L]) { M.rotT = g.t; M.rotLeft--; M.rotTaps++; w.tapA = true; }
      return w;
    }
    if (dr && M.rotTaps < 8) {
      if (g.t > M.rotT + lag + 0.05) { M.rotT = g.t; M.rotTaps++; M.rotLeft = dr - 1; w.tapA = true; }
      return w;
    }
    if (dr) { T.rot = c.rot; T.x = c.x; } // blocked: give up turning
    // 2) step sideways with short taps of the stick (one half-cell per tap).
    if (M.pulses > 0) {
      if (M.on) { w.sx = w.x = M.dir; M.pulses--; }
      M.on = !M.on;
      if (!M.pulses) M.mvT = g.t + lag + 0.05;
      return w;
    }
    if (g.t <= M.mvT || g.t <= M.rotT + lag + 0.05) return w;
    const steps = Math.round((T.x - c.x) / STEP);
    if (steps) {
      // No progress since the last taps: something is in the way, settle for this spot.
      if (M.moves > 0 && Math.abs(c.x - M.lastX) < 2 && ++M.stuck >= 2) { T.x = c.x; return w; }
      M.moves++; M.lastX = c.x; M.pulses = Math.abs(steps); M.dir = Math.sign(steps); M.on = true;
      w.sx = w.x = M.dir; M.pulses--; M.on = false;
      if (!M.pulses) M.mvT = g.t + lag + 0.05;
      M.okT = -1;
      return w;
    }
    // 3) aligned: drop (the Scudiero hesitates a moment first) — but only above the tower.
    if (M.okT < 0) {
      M.okT = g.t;
      towerProfile(f, botProf);
      M.okHere = T.away || botEval(f, c, c.rot, c.x, botProf, false) !== null;
      if (!M.okHere) { M.tgt = null; M.okT = -1; return w; }
    }
    // A gentle push down: with a shaky thumb a full push would also nudge the block sideways.
    if (g.t - M.okT >= [0.15, 0.05, 0][L]) w.sy = w.y = 0.65;
    return w;
  },

  timeout(s) {
    // Tallest tower, then more pieces on it, then fewer pieces lost; identical towers: replay.
    const keys = [(f) => towerScore(f), (f) => f.pieces.length, (f) => -f.lost];
    let c = s.f;
    for (const key of keys) {
      const top = Math.max(...c.map(key));
      c = c.filter((f) => key(f) === top);
      if (c.length === 1) { s.win = c[0].i; return s.win; }
    }
    return -1;
  },

  view(s) {
    return {
      f: s.f.map((f) => {
        const bp = f.base.getPosition();
        const c = f.cur;
        return {
          p: f.pieces.map((pc) => {
            const p = pc.body.getPosition();
            const o = { i: pc.id, k: pc.k, x: r1(p.x * SCALE), y: r1(p.y * SCALE), a: r2(pc.body.getAngle()) };
            if (pc.s !== 1) o.s = pc.s;
            if (pc.sl) o.sl = 1;
            if (pc.st) o.st = 1;
            return o;
          }),
          c: c ? { k: c.k, x: r1(c.x), y: r1(c.y), a: r2(c.a), s: c.s, sl: c.sl ? 1 : 0, gy: c.gy == null ? -1 : r1(c.gy), f: c.fast ? 1 : 0 } : null,
          n: { k: f.next.k, s: f.next.s, sl: f.next.sl ? 1 : 0 },
          top: r1(f.top), h: r2(f.hold), ch: f.charge, pr: f.prog, lost: f.lost, bh: f.behind ? 1 : 0,
          bx: r1(bp.x * SCALE - CX), by: r1(bp.y * SCALE - BASE_TOP - BASE_H / 2),
          m: f.mood, fk: f.fxK, ft: r2(f.fxT),
        };
      }),
      w: s.wind, ww: s.windWarn ? 1 : 0,
      q: s.quakeT > 0 ? 1 : s.quakeWarn ? 2 : 0,
      hud: {
        p: s.f.map((f) => Math.max(0, Math.floor(towerScore(f) / CELL))),
        max: null, label: 'Piani',
        bar: s.f.map((f) => r2(Math.min(1, f.hold / HOLD_WIN))),
      },
    };
  },

  render3d: {
    assets: [
      'medieval/mountain_A_grass_trees', 'medieval/mountain_B_grass_trees', 'medieval/mountain_C_grass_trees',
      'medieval/building_home_A_red', 'medieval/building_home_B_blue', 'medieval/building_home_A_yellow', 'medieval/building_home_B_green', 'medieval/building_church_blue',
      'medieval/building_windmill_yellow', 'medieval/building_watermill_green', 'medieval/building_market_red', 'medieval/building_grain', 'medieval/building_tower_A_red',
      'medieval/trees_A_large', 'medieval/trees_B_medium', 'medieval/tree_single_A', 'medieval/tree_single_B', 'medieval/cloud_big', 'medieval/cloud_small',
      'medieval/building_scaffolding', 'medieval/building_tower_base_green', 'medieval/building_castle_green', 'medieval/resource_stone', 'medieval/resource_lumber',
      'medieval/wheelbarrow', 'medieval/crate_A_big', 'medieval/barrel', 'medieval/tent', 'medieval/ladder', 'medieval/rock_single_C', 'medieval/rock_single_E',
      'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow',
    ],
    build(K, r) {
      const T3 = K.THREE;
      const fi = Number.isInteger(r.field) ? r.field : 0;
      const lo = K.quality === 0;
      const pc = K.col(fi), pcl = K.col(fi, 'light');
      const o = { fi };
      // --- the king's building site on a crag, at dawn, high above the valley ---
      K.theme('alba', { fogNear: 2.6, fogFar: 9.5 });
      if (K.hemi) K.hemi.intensity = 1.35;
      const sunM = K.glow('#fff0c8', { opacity: 0.95 }); sunM.fog = false;
      K.place(K.ball(300, sunM, { cast: false }), CX + 1400, 650, -7000);
      const sunH = K.glow('#ffc890', { opacity: 0.22, add: true }); sunH.fog = false;
      K.place(K.ball(720, sunH, { cast: false }), CX + 1400, 650, -7100);
      // Horizontal planes (side cam: three Y = -world y, Z = depth).
      const hplane = (x0, x1, z0, z1, y, mat) => {
        const me = K.mesh(new T3.PlaneGeometry(x1 - x0, z0 - z1).rotateX(-Math.PI / 2), mat, { cast: false });
        me.userData.ownGeo = true;
        me.position.set((x0 + x1) / 2, -y, (z0 + z1) / 2);
        return me;
      };
      const VY = 1300; // valley floor
      hplane(-5000, 5600, -300, -9000, VY, K.texMat('prato', [70, 58], { color: '#bfd88c' }));
      const wtex = K.tex('acqua', { rep: [40, 2], seed: 7 });
      const wm = new T3.MeshStandardMaterial({ map: wtex, color: '#d8eeff', roughness: 0.15, metalness: 0.2, emissive: '#1a4a6a', emissiveIntensity: 0.3 });
      hplane(-5000, 5600, -2050, -2350, VY - 2, wm);
      K.ticks.push((dt, t) => { if (wtex) wtex.offset.x = (t * 0.03) % 1; });
      // Mountains and hills on the horizon.
      const mts = [];
      // Only at the sides: the sky right behind the tower stays clear.
      for (let k = 0; k < (lo ? 4 : 8); k++) mts.push({ x: (k % 2 ? 1 : -1) * (1500 + Math.floor(k / 2) * 700) + CX, y: VY, h: -5000 - (k % 3) * 500, rot: k * 1.7, s: 0.85 + (k % 4) * 0.12 });
      ['medieval/mountain_A_grass_trees', 'medieval/mountain_B_grass_trees', 'medieval/mountain_C_grass_trees'].forEach((m, q) => K.scatter(m, mts.filter((_, k) => k % 3 === q), { size: 1100 }));
      // The village down in the valley, along the river.
      const homes = ['medieval/building_home_A_red', 'medieval/building_home_B_blue', 'medieval/building_home_A_yellow', 'medieval/building_home_B_green'];
      const houses = [];
      for (let k = 0; k < (lo ? 10 : 22); k++) houses.push({ x: -1900 + ((k * 397) % 4400), y: VY, h: -1500 - ((k * 173) % 420) - (k % 2 ? 700 : 0), rot: k * 0.9, s: 0.85 + (k % 3) * 0.15 });
      homes.forEach((m, q) => K.scatter(m, houses.filter((_, k) => k % 4 === q), { size: 120 }));
      K.scatter('medieval/building_church_blue', [{ x: 420, y: VY, h: -1800, rot: 0.4 }], { size: 170 });
      K.scatter('medieval/building_windmill_yellow', [{ x: -900, y: VY, h: -1650, rot: 0.8 }, { x: 1900, y: VY, h: -2700, rot: -0.5 }], { size: 170 });
      K.scatter('medieval/building_watermill_green', [{ x: 1100, y: VY, h: -2000, rot: 0 }], { size: 160 });
      K.scatter('medieval/building_market_red', [{ x: -200, y: VY, h: -1650, rot: 0.2 }], { size: 190 });
      K.scatter('medieval/building_grain', [{ x: -1500, y: VY, h: -1300 }, { x: 1500, y: VY, h: -1250, rot: 0.6 }, { x: 2300, y: VY, h: -1600, rot: 1.2 }, { x: -2300, y: VY, h: -1700, rot: 2 }], { size: 420 });
      K.scatter('medieval/building_tower_A_red', [{ x: 2600, y: VY, h: -2300, rot: -0.3 }], { height: 330 });
      const vtrees = [];
      for (let k = 0; k < (lo ? 12 : 26); k++) vtrees.push({ x: -2400 + ((k * 331) % 5200), y: VY, h: -1100 - ((k * 211) % 1500), rot: k, s: 0.8 + (k % 4) * 0.15 });
      K.scatter('medieval/trees_B_medium', vtrees, { size: 180 });
      // Plateaus of the crag on both sides of the gap (cliff faces in front), with the building site on them.
      const PY = 880;
      const cliffTop = K.texMat('erba', [10, 5], { color: '#a9c27a' }), cliffSide = K.texMat('pietra', [12, 3], { color: '#d2c2a6' });
      for (const [x0, x1] of [[-2400, -60], [W + 60, W + 2400]]) {
        const b = K.box(x1 - x0, VY + 60 - PY, 1000, cliffSide);
        b.material = [cliffSide, cliffSide, cliffTop, cliffSide, cliffSide, cliffSide];
        K.place(b, (x0 + x1) / 2, (PY + VY + 60) / 2, -150 - 500);
      }
      // Left: the half-built castle wing in scaffolding, stone piles, workers' tent. Right: a new tower going up.
      K.scatter('medieval/building_scaffolding', [{ x: -520, y: PY, h: -560, rot: 0.2 }], { size: 430 });
      K.scatter('medieval/building_tower_base_green', [{ x: -520, y: PY, h: -560, rot: 0.2 }], { height: 380 });
      K.scatter('medieval/building_castle_green', [{ x: -1200, y: PY, h: -900, rot: 0.5 }], { height: 900 });
      K.scatter('medieval/building_scaffolding', [{ x: W + 520, y: PY, h: -600, rot: -0.3 }], { size: 380 });
      K.scatter('medieval/building_tower_base_green', [{ x: W + 520, y: PY, h: -600, rot: -0.3 }], { height: 300 });
      K.scatter('medieval/tent', [{ x: W + 1050, y: PY, h: -420, rot: 0.6 }, { x: -1600, y: PY, h: -500, rot: 2 }], { size: 230 });
      K.scatter('medieval/resource_stone', [{ x: -230, y: PY, h: -260 }, { x: -300, y: PY, h: -330, rot: 1 }, { x: W + 250, y: PY, h: -280, rot: 2 }, { x: W + 760, y: PY, h: -300 }], { size: 110 });
      K.scatter('medieval/resource_lumber', [{ x: -760, y: PY, h: -280, rot: 0.3 }, { x: W + 300, y: PY, h: -420, rot: -0.4 }], { size: 170 });
      K.scatter('medieval/wheelbarrow', [{ x: -150, y: PY, h: -400, rot: 2.2 }, { x: W + 880, y: PY, h: -260, rot: 1 }], { size: 90 });
      K.scatter('medieval/crate_A_big', [{ x: -880, y: PY, h: -350 }, { x: -930, y: PY, h: -300, s: 0.8 }, { x: W + 170, y: PY, h: -560 }], { size: 60 });
      K.scatter('medieval/barrel', [{ x: -840, y: PY, h: -420 }, { x: W + 400, y: PY, h: -230 }, { x: W + 430, y: PY, h: -280 }], { size: 46 });
      K.scatter('medieval/tree_single_A', [{ x: -1000, y: PY, h: -260 }, { x: -1450, y: PY, h: -300, s: 1.2 }, { x: W + 1300, y: PY, h: -300 }, { x: W + 1500, y: PY, h: -700, s: 1.3 }], { height: 260 });
      K.scatter('medieval/tree_single_B', [{ x: -380, y: PY, h: -900 }, { x: W + 900, y: PY, h: -850 }], { height: 240 });
      ['red', 'blue', 'green', 'yellow'].forEach((c, k) => K.scatter(`medieval/flag_${c}`, [{ x: [-650, -420, W + 420, W + 650][k], y: PY - (k < 2 ? 380 : 300) + 6, h: [-560, -560, -600, -600][k], rot: Math.PI / 2 }], { height: 120 }));
      // Clouds: some drift below the cliff top (we are really high up), some in the sky.
      o.clouds = [0, 1].slice(0, lo ? 1 : 2).map((k) => ({ g: softCloud(K, K.model(k % 2 ? 'medieval/cloud_small' : 'medieval/cloud_big', { size: [700, 520][k], cast: false })), x: -900 + k * 2200, y: [-250, -120][k], z: [-3200, -2600][k], v: [10, 14][k] }));
      // The crag under the foundation stone.
      const rockM = K.texMat('pietra', [3, 3], { color: '#a39684' });
      const crag = K.mesh(new T3.CylinderGeometry(98, 240, VY + 60 - (BASE_TOP + BASE_H - 6), 7, 1), rockM);
      crag.userData.ownGeo = true;
      K.place(crag, CX, (BASE_TOP + BASE_H - 6 + VY + 60) / 2, -20);
      crag.rotation.y = 0.3;
      K.scatter('medieval/rock_single_E', [{ x: CX - 120, y: BASE_TOP + BASE_H + 10, h: 20 }, { x: CX + 130, y: BASE_TOP + BASE_H + 12, h: -60, rot: 2 }], { size: 46 });
      K.scatter('medieval/rock_single_C', [{ x: CX + 100, y: BASE_TOP + BASE_H + 2, h: 70 }], { size: 46 });
      // --- finish line: the king's banner (painted band) + wooden poles with pennants ---
      o.line = K.layer({ x0: 0, x1: W, y0: LINE_Y - 18, y1: LINE_Y + 18, h: 30, lit: false, maxPx: 1024,
        draw: (d, v) => { const f = v.f[fi]; if (f) drawLineBand(d, f, d.t); },
        key: (v) => { const f = v.f[fi]; if (!f) return '-'; return `${f.top <= LINE_Y ? 1 : 0}|${Math.round(f.h * 20)}|${Math.floor(K.t * 20)}`; } });
      o.lineEdge = [LINE_Y - 18, LINE_Y + 18].map((y) => { const b = K.box(W, 4, 4, K.glow('#fff4d6', { opacity: 0.7 }), { cast: false }); K.place(b, CX, y, -26); return b; });
      o.lineGold = K.glow('#ffd740'); o.lineWhite = o.lineEdge[0].material;
      const poleGeo = new T3.CylinderGeometry(4, 5, 150, 8); poleGeo.translate(0, 35, 0);
      o.flags = [[14, 1], [W - 14, -1]].map(([x, dir]) => {
        K.place(K.mesh(poleGeo, K.mat('#7a5230', { rough: 0.8 })), x, LINE_Y, 0);
        K.place(K.ball(7, K.mat('#e2b04a', { rough: 0.3, metal: 0.6 })), x, LINE_Y - 112, 0);
        const fl = K.prism([0, 0, dir * 56, 14, 0, 32], 3, K.mat(pc, { unique: true, side: 2, rough: 0.6 }));
        K.place(fl, x, LINE_Y - 108, -1.5);
        return fl;
      });
      // Pennant bunting hanging under the banner.
      o.pennants = [];
      for (let k = 0; k < 9; k++) {
        const x = 40 + k * ((W - 80) / 8);
        const p = K.prism([-11, 0, 11, 0, 0, 24], 2, K.mat(k % 2 ? pc : '#f3e2b8', { side: 2, rough: 0.7 }), { cast: false });
        K.place(p, x, LINE_Y + 19, 2);
        o.pennants.push(p);
      }
      o.star = K.emoji('👑', 54);
      K.place(o.star, CX, LINE_Y - 48, 10);
      // --- foundation stone (moves with the quake) ---
      o.baseG = K.group();
      const BD = 120;
      K.place(K.box(BASE_W, BASE_H, BD, K.texMat('muro', [3, 0.6], { color: '#cbbfae' }), { parent: o.baseG }), CX, BASE_TOP + BASE_H / 2, 0);
      K.layer({ parent: o.baseG, x0: CX - BASE_W / 2, x1: CX + BASE_W / 2, y0: BASE_TOP, y1: BASE_TOP + BASE_H, h: -(BD / 2 + 0.5), transparent: true, once: true, maxPx: 512, draw: (d) => drawBaseFront(d) });
      K.place(K.box(BASE_W + 10, 8, BD + 10, K.mat('#e6dccb', { rough: 0.6 }), { parent: o.baseG }), CX, BASE_TOP + 2, 0);
      o.warnBox = K.box(BASE_W + 16, BASE_H + 16, BD + 4, K.glow('#ff3b3b', { opacity: 0.85 }), { cast: false, parent: o.baseG });
      K.place(o.warnBox, CX, BASE_TOP + BASE_H / 2, -2);
      o.warnIcons = [-1, 1].map((s) => { const e = K.emoji('⚠️', 44, { parent: o.baseG }); K.place(e, CX + s * (BASE_W / 2 + 30), BASE_TOP - 20, 30); return e; });
      o.dust = [];
      for (let k = 0; k < 6; k++) o.dust.push(K.ball(1, K.glow('#dcc8b4', { opacity: 0.5 }), { cast: false, parent: o.baseG }));
      // --- the blocks: pool of rounded 3D stone cells (painted stone texture tinted per kind) ---
      const hs = CELL / 2 - 1.5 - 3, cr = 7, pts = [];
      for (let q = 0; q < 4; q++) {
        const ccx = q === 0 || q === 3 ? hs - cr : -hs + cr, ccy = q < 2 ? hs - cr : -hs + cr, a0 = (q * Math.PI) / 2;
        for (let s = 0; s <= 3; s++) { const an = a0 + (s / 3) * (Math.PI / 2); pts.push(ccx + Math.cos(an) * cr, ccy + Math.sin(an) * cr); }
      }
      const proto = K.prism(pts, 34, K.mat('#ffffff'), { bevel: 3, parent: null });
      const cellGeo = proto.geometry; cellGeo.translate(0, 0, -17);
      o.cellGeo = cellGeo;
      const stoneTex = K.canvasTex(64, 64, (d) => drawStoneTex(d));
      if (stoneTex) { stoneTex.repeat.set(1 / (CELL - 3), 1 / (CELL - 3)); stoneTex.offset.set(0.5, 0.5); }
      const stone = (col, o2) => { const m = K.mat(col, { ...o2, unique: true }); m.map = stoneTex; return m; };
      o.kmat = {}; o.smat = {}; o.imat = {};
      for (const k of KINDS) {
        o.kmat[k] = stone(PIECES[k].col, { rough: 0.55, emissive: PIECES[k].col, ei: 0.16 });
        o.smat[k] = stone(PIECES[k].col, { rough: 0.05, metal: 0.2, opacity: 0.8, emissive: '#fff0c0', ei: 0.3 });
        o.imat[k] = stone(PIECES[k].col, { rough: 0.7, emissive: '#2e9e3e', ei: 0.5 });
      }
      const faceTex = K.canvasTex(128, 64, (d) => drawFace(d, false));
      const stuckTex = K.canvasTex(128, 64, (d) => drawFace(d, true));
      o.faceMat = new T3.MeshBasicMaterial({ map: faceTex, transparent: true, depthWrite: false, visible: !!faceTex });
      o.stuckMat = new T3.MeshBasicMaterial({ map: stuckTex, transparent: true, depthWrite: false, visible: !!stuckTex });
      o.faceGeo = new T3.PlaneGeometry(44, 22);
      const makeSlot = (extra) => {
        const g = K.group();
        const cells = [0, 1, 2, 3].map(() => K.mesh(cellGeo, o.kmat.I, { parent: g }));
        const face = K.mesh(o.faceGeo, o.faceMat, { parent: g, cast: false });
        face.position.z = 21; face.renderOrder = 3;
        const sl = { g, cells, face, k: '' };
        if (extra) sl.halo = [0, 1, 2, 3].map(() => { const h = K.mesh(cellGeo, K.glow(pcl, { opacity: 0.55 }), { parent: g, cast: false }); h.scale.set(1.25, 1.25, 0.5); return h; });
        return sl;
      };
      o.slots = [];
      for (let k = 0; k < MAX_PIECES + 2; k++) o.slots.push(makeSlot(false));
      o.cur = makeSlot(true);
      // Ghost (where the active block will land).
      o.ghost = K.group();
      o.ghostCells = [0, 1, 2, 3].map(() => K.mesh(cellGeo, K.glow(pcl, { opacity: 0.22 }), { parent: o.ghost, cast: false }));
      // Drop guide + speed streaks.
      o.guide = K.box(1, 1, 2, K.glow('#ffffff', { opacity: 0.08 }), { cast: false });
      o.guideMiss = K.glow('#ff4d4d', { opacity: 0.12 }); o.guideOk = o.guide.material;
      o.gl = [0, 1].map(() => K.box(3, 1, 3, K.glow(pc, { opacity: 0.5 }), { cast: false }));
      o.glMiss = K.glow('#ff4d4d', { opacity: 0.45 }); o.glOk = o.gl[0].material;
      o.streaks = [0, 1, 2, 3].map(() => K.box(4, 1, 4, K.glow('#ffffff', { opacity: 0.5 }), { cast: false }));
      // Tower height marker.
      o.mark = K.box(W - 36, 3, 3, K.glow(pc, { opacity: 0.5 }), { cast: false });
      o.markGold = K.glow('#ffd740', { opacity: 0.7 }); o.markPc = o.mark.material;
      const arGeo = new T3.ConeGeometry(14, 26, 3); arGeo.rotateZ(-Math.PI / 2);
      o.arrow = K.mesh(arGeo, K.mat(pc, { emissive: pc, ei: 0.4 }));
      o.arrowGold = K.mat('#ffd740', { emissive: '#ffd740', ei: 0.4 }); o.arrowPc = o.arrow.material;
      // Wind gusts.
      o.windMat = K.glow('#ffffff', { opacity: 0.32, unique: true });
      const headGeo = new T3.ConeGeometry(14, 22, 3); headGeo.rotateZ(-Math.PI / 2);
      o.gusts = [];
      for (let k = 0; k < 7; k++) {
        const g = K.group();
        K.box(1, 6, 6, o.windMat, { parent: g, cast: false });
        const head = K.mesh(headGeo, o.windMat, { parent: g, cast: false });
        o.gusts.push({ g, shaft: g.children[0], head });
      }
      o.leafWind = lo ? null : K.ambient('foglie', { n: 24, h: 200, x0: -200, x1: W + 200, y0: 150, y1: 750 });
      // The master builder on a wooden ledge bolted to the crag.
      o.av = K.avatar(fi);
      const ledgeM = K.texMat('legno', [2, 1], { color: '#c99a6a' });
      K.place(K.box(130, 14, 90, ledgeM), 78, 908 + GY + 34 + 7, 10);
      const beam = K.box(140, 10, 10, K.mat('#6b4426', { rough: 0.8 }));
      K.place(beam, 140, 908 + GY + 34 + 52, -20); beam.rotation.z = -0.62;
      // HUD panels (painted slightly behind the play plane) + spinning 3D next block.
      o.magic = K.layer({ x0: 10, x1: 142, y0: 10, y1: 142, h: 25, transparent: true, lit: false, z: 3, maxPx: 256,
        draw: (d, v) => { const f = v.f[fi]; if (f) drawMagicPanel(d, f, pc, pcl, d.t); },
        key: (v) => { const f = v.f[fi]; if (!f) return '-'; return `${f.ch}|${f.pr}|${f.bh}|${f.ch > 0 ? Math.floor(K.t * 15) : 0}`; } });
      o.nextP = K.layer({ x0: W - 142, x1: W - 10, y0: 10, y1: 142, h: 25, transparent: true, lit: false, z: 3, maxPx: 256,
        draw: (d, v) => { const f = v.f[fi]; if (f) drawNextBox(d, f, pc); },
        key: (v) => { const f = v.f[fi]; const nx = f && f.n; return nx ? `${nx.s}|${nx.sl}` : '-'; } });
      o.next = makeSlot(false);
      // Magic effects.
      o.icons = {};
      for (const [k, ch] of [['giant', '🪨'], ['soap', '🧈'], ['ivy', '🌿'], ['cast', '🔮']]) { o.icons[k] = K.emoji(ch, 110); K.place(o.icons[k], CX, 320, 60); }
      o.bubbleMat = K.mat('#fff3c8', { rough: 0.05, opacity: 0.35, unique: true, emissive: '#ffe6a0', ei: 0.3 });
      o.bubbles = [];
      for (let q = 0; q < 8; q++) o.bubbles.push(K.ball(1, o.bubbleMat, { cast: false }));
      o.leaves = [];
      for (let q = 0; q < 6; q++) o.leaves.push(K.emoji('🍃', 30));
      return o;
    },

    update(K, o, v, r) {
      const fi = o.fi;
      const f = v.f && v.f[fi];
      if (!f) return;
      const t = K.t;
      // Quake rattle (the whole field shakes like in 2D).
      K.root.position.x = v.q === 1 ? Math.sin(t * 61) * 6 : 0;
      K.root.position.y = v.q === 1 ? Math.cos(t * 47) * 3 : 0;
      // Clouds.
      for (const c of o.clouds) K.place(c.g, ((c.x + t * c.v + 3000) % 4400) - 1900, c.y, c.z);
      // Finish line.
      const above = f.top <= LINE_Y;
      for (const e of o.lineEdge) { e.material = above ? o.lineGold : o.lineWhite; e.scale.y = above ? 1.6 : 1; }
      o.flags.forEach((fl, k) => { fl.rotation.y = Math.sin(t * 6 + k * 3) * 0.5; });
      o.pennants.forEach((p, k) => { p.rotation.x = Math.sin(t * 4 + k * 0.9) * 0.35; });
      o.star.visible = above;
      if (above) o.star.scale.setScalar(54 + Math.sin(t * 10) * 8);
      // Base (quake offset + warnings).
      o.baseG.position.set(f.bx || 0, -(f.by || 0), 0);
      const warn = v.q === 2;
      o.warnBox.visible = warn && Math.sin(t * 18) > 0;
      for (const e of o.warnIcons) { e.visible = warn; e.scale.setScalar(44 + Math.sin(t * 18) * 6); }
      o.dust.forEach((b, k) => {
        b.visible = v.q === 1;
        if (!b.visible) return;
        const a = t * 9 + k;
        K.place(b, CX - BASE_W / 2 + ((k * 53) % BASE_W), BASE_TOP + BASE_H + 6 + Math.sin(a) * 6, 50);
        b.scale.setScalar(10 + 5 * Math.sin(a * 1.7));
      });
      // Placed blocks.
      for (let k = 0; k < o.slots.length; k++) {
        const sl = o.slots[k], p = f.p[k];
        sl.g.visible = !!p && !!PIECES[p.k];
        if (sl.g.visible) setPiece3d(K, o, sl, p.k, p.x, p.y, p.a, p.s || 1, p.sl, p.st);
      }
      // Active block, ghost, drop guide, streaks.
      const c = f.c && PIECES[f.c.k] ? f.c : null;
      o.cur.g.visible = !!c;
      o.ghost.visible = !!c && c.gy >= 0 && c.gy - c.y > 8;
      o.guide.visible = o.gl[0].visible = o.gl[1].visible = false;
      for (const s of o.streaks) s.visible = false;
      if (c) {
        setPiece3d(K, o, o.cur, c.k, c.x, c.y, c.a, c.s || 1, c.sl, false);
        o.cur.halo.forEach((h, q) => { h.position.copy(o.cur.cells[q].position); h.position.z = -12; });
        if (o.ghost.visible) {
          K.place(o.ghost, c.x, c.gy, 0); K.face(o.ghost, c.a); o.ghost.scale.setScalar(c.s || 1);
          const P = PIECES[c.k];
          o.ghostCells.forEach((m, q) => K.place(m, P.cells[q][0], P.cells[q][1], 0));
        }
        const e = extents(c.k, c.s || 1, c.a);
        const gy = c.y + e.y1, miss = !(c.gy >= 0), end = miss ? H : c.gy + e.y1;
        if (end > gy) {
          o.guide.visible = true;
          o.guide.material = miss ? o.guideMiss : o.guideOk;
          K.place(o.guide, c.x + (e.x0 + e.x1) / 2, (gy + end) / 2, -24);
          o.guide.scale.set(e.x1 - e.x0, end - gy, 1);
          o.gl.forEach((l, q) => {
            l.visible = true; l.material = miss ? o.glMiss : o.glOk;
            K.place(l, c.x + (q ? e.x1 : e.x0), (gy + end) / 2, -22);
            l.scale.y = end - gy;
          });
        }
        if (c.f) o.streaks.forEach((s, k) => {
          const x = c.x + e.x0 + ((k + 0.5) * (e.x1 - e.x0)) / 4, L = 40 + ((k * 37 + Math.floor(t * 30)) % 50);
          s.visible = true;
          K.place(s, x, c.y + e.y0 - 8 - L / 2, 0);
          s.scale.y = L;
        });
      }
      // Height marker.
      o.mark.visible = o.arrow.visible = f.top < BASE_TOP - 2;
      if (o.mark.visible) {
        o.mark.material = above ? o.markGold : o.markPc;
        o.arrow.material = above ? o.arrowGold : o.arrowPc;
        K.place(o.mark, 26 + (W - 36) / 2, f.top, -20);
        K.place(o.arrow, 14, f.top, 0);
      }
      // Wind.
      const wv = v.w || 0;
      if (wv) o.windMat.opacity = v.ww && Math.sin(t * 20) > 0 ? 0.75 : 0.32;
      o.gusts.forEach((gu, k) => {
        if (!wv) { gu.g.visible = false; return; }
        const y = 210 + k * 95, span = W + 240;
        let x = (t * 160 * wv + k * 173) % span;
        if (x < 0) x += span;
        x -= 120;
        const L = 70 + (k % 3) * 20;
        gu.g.visible = x > 30 && x < W - 30;
        K.place(gu.g, x, y, 40);
        gu.g.scale.x = wv;
        gu.shaft.scale.x = L;
        K.place(gu.head, L / 2 + 6, 0, 0);
      });
      if (o.leafWind) o.leafWind.visible = !!wv;
      // Master builder: casts spells, cheers, panics.
      const ax = 78, ay = 908 + GY;
      const fx = f.ft > 0 ? f.fk : '';
      const anim = fx === 'cast' ? 'Spellcast_Shoot' : fx === 'ivy' ? 'Spellcast_Raise' : f.m === 'happy' ? 'Cheer' : f.m === 'scared' ? 'Blocking' : f.m === 'dizzy' ? 'Hit_B' : f.m === 'angry' ? 'Hit_A' : 'Idle';
      o.av.set(ax, ay, { r: 34, look: 0.15, anim, squash: f.h > 0 ? Math.sin(t * 12) * 0.06 : 0, h: 10 });
      // Next block: a small 3D tetromino spinning in its panel.
      const nx = f.n && PIECES[f.n.k] ? f.n : null;
      o.next.g.visible = !!nx;
      if (nx) {
        const sc = (nx.s || 1) > 1 ? 0.62 : 0.4;
        const e = extents(nx.k, sc, 0);
        setPiece3d(K, o, o.next, nx.k, W - 76 - (e.x0 + e.x1) / 2, 80 - (e.y0 + e.y1) / 2, (nx.s || 1) > 1 || nx.sl ? Math.sin(t * 8) * 0.08 : 0, sc, nx.sl, false);
        o.next.g.position.z = 10;
        o.next.g.rotation.y = Math.sin(t * 1.6) * 0.5;
      }
      // Magic effects.
      const fxOn = f.ft > 0 && !!o.icons[f.fk];
      for (const k in o.icons) o.icons[k].visible = fxOn && f.fk === k;
      const kk = Math.min(1, f.ft || 0);
      if (fxOn) { const ic = o.icons[f.fk]; ic.material.opacity = kk; ic.scale.setScalar(110 * (1 + (1 - kk) * 0.6)); }
      const soap = fxOn && f.fk === 'soap', ivy = fxOn && f.fk === 'ivy';
      o.bubbleMat.opacity = 0.35 * kk;
      o.bubbles.forEach((b, q) => {
        b.visible = soap;
        if (soap) { K.place(b, (q * 79 + t * 40) % W, 700 - ((t * 120 + q * 90) % 500), 40); b.scale.setScalar(10 + (q % 3) * 6); }
      });
      o.leaves.forEach((l, q) => {
        l.visible = ivy;
        if (ivy) { K.place(l, CX - 120 + q * 48, f.top - 20 - Math.sin(t * 5 + q) * 14, 40); l.material.opacity = kk; }
      });
    },
  },

  render(d, v, r) {
    const fi = Number.isInteger(r.field) ? r.field : 0;
    const f = v.f && v.f[fi];
    if (!f) return;
    const ctx = d.ctx, t = d.t;
    const pc = d.col(fi), pcl = d.col(fi, 'light');

    ctx.save();
    if (v.q === 1) ctx.translate(Math.sin(t * 61) * 6, Math.cos(t * 47) * 3); // quake camera rattle
    drawSky(d, t);
    if (v.w) drawWind(d, v, t);
    drawFinishLine(d, f, t);

    // Drop guide under the active piece.
    const c = f.c;
    if (c && PIECES[c.k]) {
      const e = extents(c.k, c.s, c.a);
      const gy = c.y + e.y1;
      const miss = !(c.gy >= 0);
      const end = miss ? H : c.gy + e.y1;
      if (end > gy) {
        const col = miss ? '#ff4d4d' : pc;
        d.rect(c.x + e.x0, gy, e.x1 - e.x0, end - gy, miss ? 'rgba(255,60,60,0.10)' : 'rgba(255,255,255,0.07)');
        d.line(c.x + e.x0, gy, c.x + e.x0, end, col + '66', 2);
        d.line(c.x + e.x1, gy, c.x + e.x1, end, col + '66', 2);
      }
      // Speed streaks while fast-dropping.
      if (c.f) for (let k = 0; k < 4; k++) {
        const x = c.x + e.x0 + ((k + 0.5) * (e.x1 - e.x0)) / 4, L = 40 + ((k * 37 + Math.floor(t * 30)) % 50);
        d.line(x, c.y + e.y0 - 8, x, c.y + e.y0 - 8 - L, 'rgba(255,255,255,0.45)', 4);
      }
    }

    drawBase(d, f, v.q, t);
    for (const p of f.p) drawPiece(d, p.k, p.x, p.y, p.a, p.s || 1, p);
    if (c && c.gy >= 0 && c.gy - c.y > 8) drawGhost(d, c.k, c.x, c.gy, c.a, c.s || 1, pcl, t);
    if (c) drawPiece(d, c.k, c.x, c.y, c.a, c.s || 1, { sl: c.sl, active: true, outline: pcl });

    // Height marker on the left edge.
    if (f.top < BASE_TOP - 2) {
      const above = f.top <= LINE_Y;
      ctx.save();
      ctx.setLineDash([10, 10]);
      d.line(26, f.top, W - 10, f.top, (above ? '#ffd740' : pc) + '66', 2);
      ctx.restore();
      d.poly([4, f.top - 14, 28, f.top, 4, f.top + 14], above ? '#ffd740' : pc, '#000', 2);
    }

    drawClouds(d, t);

    // Builder avatar on a little cloud.
    const bob = Math.sin(t * 2.2 + fi) * 5;
    const ax = 78, ay = 908 + GY + bob;
    for (const [ox, oy, rr] of [[-34, 40, 26], [0, 44, 32], [34, 40, 26]]) d.circle(ax + ox, ay + oy, rr, '#fff4fa');
    d.avatar(ax, ay, 34, fi, { mood: f.m || 'ok', look: Math.atan2(f.top - ay, CX - ax), squash: f.h > 0 ? Math.sin(t * 12) * 0.1 : 0 });

    drawNextPanel(d, f, pc, t);
    drawMagicPanel(d, f, pc, pcl, t);
    drawMagicFx(d, f, t);
    ctx.restore();
  },
};

// ---------- drawing helpers ----------

function drawSky(d, t) {
  const ctx = d.ctx;
  const gr = ctx.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, '#140f3a');
  gr.addColorStop(0.5, '#43296f');
  gr.addColorStop(0.85, '#c8577a');
  gr.addColorStop(1, '#ff9b6a');
  ctx.fillStyle = gr;
  ctx.fillRect(-20, -20, W + 40, H + 40);
  // Twinkling stars.
  for (let k = 0; k < 18; k++) {
    const x = (k * 137.5) % W, y = 30 + ((k * 89.3) % 420);
    d.circle(x, y, 2 + (k % 3), `rgba(255,255,255,${0.25 + 0.25 * Math.sin(t * 2 + k)})`);
  }
  // Moon with a soft halo and a shooting star every few seconds.
  d.circle(470, 380, 70, 'rgba(255,240,210,0.08)');
  d.circle(470, 380, 46, 'rgba(255,240,210,0.16)');
  d.circle(470, 380, 30, '#fff1d6');
  d.circle(461, 372, 7, '#ecd9b8');
  d.circle(478, 389, 5, '#ecd9b8');
  const sp = (t * 0.35) % 3;
  if (sp < 0.5) {
    const k = sp / 0.5, sx = 80 + k * 380, sy = 70 + k * 140;
    d.line(sx - 60, sy - 22, sx, sy, `rgba(255,255,255,${(0.7 * (1 - k)).toFixed(2)})`, 3);
    d.circle(sx, sy, 3, '#fff');
  }
  // Tuscan hills and a tiny leaning tower far away.
  d.poly([0, H, 0, 860 + GY, 90, 820 + GY, 200, 850 + GY, 330, 800 + GY, 470, 845 + GY, W, 810 + GY, W, H], '#5a2f6e');
  ctx.save();
  ctx.translate(500, 812 + GY);
  ctx.rotate(0.09);
  d.rect(-11, -62, 22, 62, '#e8d9c8');
  for (let k = 1; k < 5; k++) d.line(-11, -k * 12, 11, -k * 12, '#b8a593', 2);
  for (let k = 0; k < 4; k++) d.rect(-3, -k * 12 - 9, 6, 5, Math.sin(t * 1.3 + k * 2) > 0 ? '#ffd76a' : '#7d6a5a');
  ctx.restore();
  d.poly([0, H, 0, 905 + GY, 140, 880 + GY, 300, 915 + GY, 440, 885 + GY, W, 900 + GY, W, H], '#3b1f52');
}

function drawWind(d, v, t) {
  const ctx = d.ctx;
  const blink = v.ww && Math.sin(t * 20) > 0;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip(); // keep the gusts inside this field
  ctx.globalAlpha = blink ? 0.75 : 0.32;
  for (let k = 0; k < 7; k++) {
    const y = 210 + k * 95;
    const span = W + 240;
    let x = (t * 160 * v.w + k * 173) % span;
    if (x < 0) x += span;
    x -= 120;
    const L = 70 + (k % 3) * 20;
    d.line(x - (L / 2) * v.w, y, x + (L / 2) * v.w, y, '#dff6ff', 6);
    const hx = x + (L / 2) * v.w;
    d.poly([hx + 16 * v.w, y, hx - 6 * v.w, y - 14, hx - 6 * v.w, y + 14], '#dff6ff');
  }
  ctx.restore();
}

function drawFinishLine(d, f, t) {
  const ctx = d.ctx;
  const above = f.top <= LINE_Y;
  const sq = 18, off = (t * 40) % (sq * 2);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, LINE_Y - sq, W, sq * 2);
  ctx.clip();
  d.rect(0, LINE_Y - sq, W, sq * 2, '#fff');
  for (let x = -sq * 2 + off; x < W + sq; x += sq * 2) {
    d.rect(x, LINE_Y - sq, sq, sq, '#111');
    d.rect(x + sq, LINE_Y, sq, sq, '#111');
  }
  if (f.h > 0) d.rect(0, LINE_Y - sq, W * Math.min(1, f.h / HOLD_WIN), sq * 2, 'rgba(255,200,40,0.6)');
  ctx.restore();
  const glow = above ? '#ffd740' : 'rgba(255,255,255,0.5)';
  d.line(0, LINE_Y - sq, W, LINE_Y - sq, glow, above ? 5 : 3);
  d.line(0, LINE_Y + sq, W, LINE_Y + sq, glow, above ? 5 : 3);
  // Waving flags at both ends.
  for (const [x, dir] of [[14, 1], [W - 14, -1]]) {
    d.line(x, LINE_Y - 80, x, LINE_Y + sq, '#ddd', 4);
    const wv = Math.sin(t * 6 + x) * 8;
    d.poly([x, LINE_Y - 80, x + dir * 46, LINE_Y - 66 + wv, x, LINE_Y - 50], above ? '#ffd740' : '#ff5a7a', '#222', 2);
  }
  if (above) d.star(W / 2, LINE_Y - 44, 18 + Math.sin(t * 10) * 4, '#ffd740');
}

function drawBase(d, f, q, t) {
  const bx = f.bx || 0, by = f.by || 0;
  const x0 = CX - BASE_W / 2 + bx, y0 = BASE_TOP + by;
  // Pillar down into the clouds.
  const px = CX - PILLAR_W / 2 + bx;
  d.rect(px, y0 + BASE_H, PILLAR_W, H - y0 - BASE_H + 20, '#7d7590');
  for (let y = y0 + BASE_H + 30; y < H; y += 30) d.line(px, y, px + PILLAR_W, y, '#5d5670', 2);
  d.rect(px, y0 + BASE_H, 16, H - y0, 'rgba(255,255,255,0.12)');
  // Stone cap.
  const warn = q === 2 && Math.sin(t * 18) > 0;
  d.rrect(x0, y0, BASE_W, BASE_H, 8, '#b7afc6', warn ? '#ff3b3b' : '#4d475c', warn ? 7 : 4);
  d.line(x0 + 4, y0 + BASE_H / 2, x0 + BASE_W - 4, y0 + BASE_H / 2, '#8c849d', 2);
  for (let k = 1; k < 6; k++) {
    const x = x0 + (k * BASE_W) / 6;
    d.line(x + (k % 2 ? 0 : 20), y0 + 3, x + (k % 2 ? 0 : 20), y0 + BASE_H / 2, '#8c849d', 2);
    d.line(x + (k % 2 ? 20 : 0), y0 + BASE_H / 2, x + (k % 2 ? 20 : 0), y0 + BASE_H - 3, '#8c849d', 2);
  }
  d.rrect(x0 + 6, y0 + 4, BASE_W - 12, 6, 3, 'rgba(255,255,255,0.35)');
  if (q === 2) {
    d.emoji('⚠️', x0 - 30, y0 - 20, 40 + Math.sin(t * 18) * 6);
    d.emoji('⚠️', x0 + BASE_W + 30, y0 - 20, 40 + Math.sin(t * 18) * 6);
  }
  if (q === 1) {
    for (let k = 0; k < 6; k++) {
      const a = t * 9 + k;
      d.circle(x0 + ((k * 53) % BASE_W), y0 + BASE_H + 6 + Math.sin(a) * 6, 10 + 5 * Math.sin(a * 1.7), 'rgba(220,200,180,0.5)');
    }
  }
}

function drawPiece(d, k, x, y, a, s, o) {
  const P = PIECES[k];
  if (!P) return;
  const ctx = d.ctx;
  const h = CELL / 2 - 1.5;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  if (s !== 1) ctx.scale(s, s);
  if (o.outline) for (const [cx, cy] of P.cells) d.rrect(cx - h - 5, cy - h - 5, h * 2 + 10, h * 2 + 10, 13, o.outline + 'aa');
  for (const [cx, cy] of P.cells) {
    d.rrect(cx - h, cy - h, h * 2, h * 2, 9, P.col, P.dk, 3.5);
    d.rect(cx - h + 4, cy + h - 10, h * 2 - 8, 6, 'rgba(0,0,0,0.18)');
    d.rrect(cx - h + 5, cy - h + 4, h * 2 - 10, 8, 4, 'rgba(255,255,255,0.45)');
    if (o.sl) {
      d.rrect(cx - h, cy - h, h * 2, h * 2, 9, 'rgba(210,245,255,0.45)');
      d.circle(cx + 8, cy + 6, 5, null, '#ffffffcc', 2);
    }
  }
  // Cartoon face at the centroid: pupils always look down (towards the base).
  const lx = Math.sin(a) * 2.5, ly = Math.cos(a) * 2.5;
  if (o.st) {
    d.line(-14, -2, -4, -2, '#222', 3);
    d.line(4, -2, 14, -2, '#222', 3);
  } else {
    d.circle(-9, -3, 7, '#fff', '#222', 1.5);
    d.circle(9, -3, 7, '#fff', '#222', 1.5);
    d.circle(-9 + lx, -3 + ly, 3.5, '#111');
    d.circle(9 + lx, -3 + ly, 3.5, '#111');
  }
  if (o.st) {
    // Ivy: vines across the cells with leaves.
    const cs = P.cells;
    for (let q = 1; q < cs.length; q++) d.line(cs[q - 1][0], cs[q - 1][1] + 6, cs[q][0], cs[q][1] - 6, '#2e9e3e', 5);
    for (const [cx, cy] of cs) {
      d.circle(cx - 10, cy + 10, 7, '#4fd65e', '#1d6b28', 2);
      d.circle(cx + 12, cy - 12, 6, '#4fd65e', '#1d6b28', 2);
    }
  }
  ctx.restore();
}

// Dashed outline where the active piece will land.
function drawGhost(d, k, x, y, a, s, col, t) {
  const P = PIECES[k];
  if (!P) return;
  const ctx = d.ctx, h = CELL / 2 - 1.5;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  if (s !== 1) ctx.scale(s, s);
  ctx.setLineDash([9, 7]);
  ctx.lineDashOffset = -t * 30;
  for (const [cx, cy] of P.cells) d.rrect(cx - h, cy - h, h * 2, h * 2, 9, 'rgba(255,255,255,0.10)', col + 'cc', 3);
  ctx.restore();
}

function drawClouds(d, t) {
  for (let k = 0; k < 9; k++) {
    const x = ((k * 83 + t * (10 + (k % 3) * 6)) % (W + 160)) - 80;
    const y = 975 + (k % 3) * 12;
    d.circle(x, y, 46 + (k % 4) * 8, k % 2 ? '#ffd9e6' : '#ffe9f1');
  }
}

function drawNextPanel(d, f, pc, t) {
  const x = W - 136, y = 16, w = 120, h = 120;
  d.rrect(x, y, w, h, 18, 'rgba(12,6,34,0.7)', pc + 'aa', 3);
  const n = f.n;
  if (!n || !PIECES[n.k]) return;
  const ns = n.s || 1;
  const sc = ns > 1 ? 0.62 : 0.4;
  const e = extents(n.k, sc, 0);
  const wob = ns > 1 || n.sl ? Math.sin(t * 8) * 0.08 : 0;
  drawPiece(d, n.k, x + w / 2 - (e.x0 + e.x1) / 2, y + h / 2 + 4 - (e.y0 + e.y1) / 2, wob, sc, { sl: n.sl });
  if (ns > 1) d.emoji('🪨', x + 14, y + 16, 30);
  if (n.sl) d.emoji('🧈', x + w - 14, y + 16, 30);
}

function drawMagicPanel(d, f, pc, pcl, t) {
  const x = 16, y = 16, w = 120, h = 120;
  d.rrect(x, y, w, h, 18, 'rgba(12,6,34,0.7)', pc + 'aa', 3);
  const ox = x + w / 2, oy = y + 50;
  const ready = f.ch > 0;
  const pulse = ready ? 1 + Math.sin(t * 7) * 0.08 : 1;
  if (ready) d.neon(() => d.circle(ox, oy, 32 * pulse, '#7b3dff', pcl, 4), '#b07bff');
  else d.circle(ox, oy, 30, '#2b2050', '#4a3d78', 3);
  d.emoji(ready ? '🔮' : '✨', ox, oy, ready ? 38 * pulse : 26);
  if (f.ch > 1) d.circle(ox + 30, oy - 26, 13, '#ffd740', '#222', 2);
  if (f.ch > 1) d.text('2', ox + 30, oy - 26, { size: 18, color: '#222' });
  // Progress pips toward the next charge.
  const need = f.bh ? PIECES_PER_CHARGE - 1 : PIECES_PER_CHARGE;
  for (let k = 0; k < need; k++) {
    const px = x + 24 + k * 24 + (f.bh ? 12 : 0), py = y + h - 18;
    d.circle(px, py, 8, k < f.pr ? '#c79bff' : 'rgba(255,255,255,0.15)', '#000', 1.5);
  }
}

function drawMagicFx(d, f, t) {
  if (!(f.ft > 0) || !f.fk) return;
  const ctx = d.ctx;
  const k = Math.min(1, f.ft);
  const icon = { giant: '🪨', soap: '🧈', ivy: '🌿', cast: '🔮' }[f.fk];
  if (!icon) return;
  ctx.save();
  ctx.globalAlpha = k;
  const pop = 1 + (1 - k) * 0.6;
  if (f.fk === 'soap') {
    for (let q = 0; q < 8; q++) {
      const bx = (q * 79 + t * 40) % W, by = 700 - ((t * 120 + q * 90) % 500);
      d.circle(bx, by, 10 + (q % 3) * 6, 'rgba(220,250,255,0.35)', '#ffffffaa', 2);
    }
  }
  if (f.fk === 'ivy') {
    for (let q = 0; q < 6; q++) d.emoji('🍃', CX - 120 + q * 48, f.top - 20 - Math.sin(t * 5 + q) * 14, 30);
  }
  d.emoji(icon, CX, 320, 110 * pop);
  ctx.restore();
}

// ---------- 3D helpers (render3d) ----------

// Move one pooled 3D piece (group of 4 rounded cells + face) to a tetromino pose.
function setPiece3d(K, o, sl, k, x, y, a, s, soap, stuck) {
  const P = PIECES[k];
  const mat = stuck ? o.imat[k] : soap ? o.smat[k] : o.kmat[k];
  if (sl.k !== k) {
    sl.k = k;
    sl.cells.forEach((m, q) => K.place(m, P.cells[q][0], P.cells[q][1], 0));
  }
  for (const m of sl.cells) m.material = mat;
  sl.face.material = stuck ? o.stuckMat : o.faceMat;
  K.place(sl.g, x, y, 0);
  K.face(sl.g, a);
  sl.g.rotation.y = 0;
  sl.g.scale.setScalar(s);
}

// Cartoon face texture (eyes looking down / closed + ivy for glued pieces), 128x64 px for a 44x22 plane.
function drawFace(d, stuck) {
  const { ctx } = d;
  ctx.scale(128 / 44, 64 / 22);
  ctx.translate(22, 11);
  if (stuck) {
    d.line(-15, 0, -5, 0, '#222', 3);
    d.line(5, 0, 15, 0, '#222', 3);
    d.circle(-15, 6, 4, '#4fd65e', '#1d6b28', 1.5);
    d.circle(16, -6, 4, '#4fd65e', '#1d6b28', 1.5);
  } else {
    d.circle(-9, 0, 7, '#fff', '#222', 1.5);
    d.circle(9, 0, 7, '#fff', '#222', 1.5);
    d.circle(-9, 2.5, 3.5, '#111');
    d.circle(9, 2.5, 3.5, '#111');
  }
}

// The king's banner: red and gold checks (the finish line), filling with gold while the tower holds.
function drawLineBand(d, f, t) {
  const above = f.top <= LINE_Y;
  const sq = 18, off = (t * 40) % (sq * 2);
  d.rect(0, LINE_Y - sq, W, sq * 2, '#f3d27a');
  for (let x = -sq * 2 + off; x < W + sq; x += sq * 2) {
    d.rect(x, LINE_Y - sq, sq, sq, '#9e1b28');
    d.rect(x + sq, LINE_Y, sq, sq, '#9e1b28');
  }
  if (f.h > 0) d.rect(0, LINE_Y - sq, W * Math.min(1, f.h / HOLD_WIN), sq * 2, 'rgba(255,200,40,0.6)');
  if (above) d.rect(0, LINE_Y - sq, W, sq * 2, 'rgba(255,215,64,0.18)');
}

function drawBaseFront(d) {
  const x0 = CX - BASE_W / 2, y0 = BASE_TOP;
  d.rect(x0, y0, BASE_W, BASE_H, '#b7afc6');
  d.line(x0 + 4, y0 + BASE_H / 2, x0 + BASE_W - 4, y0 + BASE_H / 2, '#8c849d', 2);
  for (let k = 1; k < 6; k++) {
    const x = x0 + (k * BASE_W) / 6;
    d.line(x + (k % 2 ? 0 : 20), y0 + 3, x + (k % 2 ? 0 : 20), y0 + BASE_H / 2, '#8c849d', 2);
    d.line(x + (k % 2 ? 20 : 0), y0 + BASE_H / 2, x + (k % 2 ? 20 : 0), y0 + BASE_H - 3, '#8c849d', 2);
  }
}

function drawNextBox(d, f, pc) {
  const x = W - 136, y = 16, w = 120, h = 120;
  d.rrect(x, y, w, h, 18, 'rgba(40,22,10,0.72)', pc + 'cc', 4);
  d.rrect(x + 6, y + 6, w - 12, h - 12, 14, null, 'rgba(243,210,122,0.5)', 2);
  const n = f.n;
  if (!n) return;
  if ((n.s || 1) > 1) d.emoji('🪨', x + 14, y + 16, 30);
  if (n.sl) d.emoji('🧈', x + w - 14, y + 16, 30);
}

// Stone block texture (light, tinted by the material color): chiselled face, bevel light/shadow, speckles.
function drawStoneTex(d) {
  const { ctx } = d;
  d.rect(0, 0, 64, 64, '#e9e4dc');
  for (let k = 0; k < 70; k++) {
    const x = (k * 37.7) % 64, y = (k * 53.3) % 64, s = 1 + (k % 3);
    d.rect(x, y, s, s, k % 2 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.35)');
  }
  ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillRect(0, 0, 64, 5); ctx.fillRect(0, 0, 5, 64);
  ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(0, 59, 64, 5); ctx.fillRect(59, 0, 5, 64);
  d.line(14, 22, 30, 26, 'rgba(0,0,0,0.12)', 2);
  d.line(38, 44, 50, 40, 'rgba(0,0,0,0.12)', 2);
}

// Clouds lit from below look grey: give them their own bright, slightly glowing material (never touch the shared one).
function softCloud(K, g) {
  const m = K.mat('#ffffff', { rough: 1, emissive: '#fff0f2', ei: 0.55 });
  g.traverse((x) => { if (x.isMesh) x.material = m; });
  return g;
}
