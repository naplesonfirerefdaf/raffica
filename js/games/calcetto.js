// Calcio Storico su Ruote — top-down cart football (dir = drive, A = gunpowder turbo, B = jump).
// Seat 0 defends the bottom goal, 1 the top goal, 2 the left goal, 3 the right goal.
import { clamp, damp, norm, collideCircles, angleDiff, r1, r2, TAU } from '../core/geom.js';

// Extra margin above/below the pitch: on the shared phone the HUD bars sit over the two short ends.
const W = 1000, H = 1680, CX = 500, MID = 840;
const L = 40, R = 960, T = 160, B = 1520, CORNER = 160;
const NET = 70;
const CAR_R = 40, CAR_LEN = 104, CAR_WID = 60;
const ACC = 1500, VMAX = 640, TURBO_ACC = 2700, TURBO_MAX = 1080;
const TURN = 5.2, GRIP = 0.02, DRIFT = 0.22;
const BOOST_USE = 0.5, BOOST_GAIN = 0.2;
const FLIP_SPEED = 1250, FLIP_TIME = 0.25, FLIP_CD = 1.2, FLIP_KICK = 1000;
const BOMB_TIME = 6, SUBSTEPS = 3;
// Gunpowder barrels (symmetric): drive over one to refill the turbo; it comes back after a few seconds.
const PADS = [[150, MID - 330], [850, MID - 330], [150, MID + 330], [850, MID + 330], [CX, MID - 520], [CX, MID + 520]];
const PAD_R = 62, PAD_RESPAWN = 5;
const MOODS = ['ok', 'happy', 'dizzy', 'angry', 'hurt'];
// Seat sides (unit vector from the center toward the seat's goal) and goal mouths.
const SIDE = [[0, 1], [0, -1], [-1, 0], [1, 0]];
const GOAL = [[CX, B], [CX, T], [L, MID], [R, MID]];
const TEAM = ['red', 'blue', 'green', 'yellow']; // model colors by slot color

const BALLS = {
  normal: { r: 52, m: 1, max: 1700, keep: 0.6, e: 0.78, gw: 170 },
  gigante: { r: 125, m: 3.5, max: 850, keep: 0.45, e: 0.6, gw: 250 },
};

// Which goal's wedge a point is in (the pitch diagonals split it into four zones).
function zoneOf(x, y) {
  const u = (x - CX) / (R - CX), w = (y - MID) / (B - MID);
  if (Math.abs(w) >= Math.abs(u)) return w > 0 ? 0 : 1;
  return u < 0 ? 2 : 3;
}

function reflect(o, nx, ny, e) {
  const vn = o.vx * nx + o.vy * ny;
  if (vn <= 0) return 0;
  o.vx -= (1 + e) * vn * nx; o.vy -= (1 + e) * vn * ny;
  return vn;
}

// Keep a circle inside the rounded pitch. gw = goal half-width (open mouths) or 0; n = players (3+: side goals).
function confine(o, e, gw, n = 2) {
  const r = o.r;
  const cx = o.x < L + CORNER ? L + CORNER : o.x > R - CORNER ? R - CORNER : 0;
  const cy = o.y < T + CORNER ? T + CORNER : o.y > B - CORNER ? B - CORNER : 0;
  if (cx && cy) {
    const dx = o.x - cx, dy = o.y - cy, d = Math.hypot(dx, dy), max = CORNER - r;
    if (d <= max || d === 0) return 0;
    const nx = dx / d, ny = dy / d;
    o.x = cx + nx * max; o.y = cy + ny * max;
    return reflect(o, nx, ny, e);
  }
  let hit = 0;
  const openY = gw > 0 && Math.abs(o.y - MID) < gw;
  if (o.x < L + r && !(openY && n >= 3)) { o.x = L + r; hit = Math.max(hit, reflect(o, -1, 0, e)); }
  else if (o.x > R - r && !(openY && n >= 4)) { o.x = R - r; hit = Math.max(hit, reflect(o, 1, 0, e)); }
  const open = gw > 0 && Math.abs(o.x - CX) < gw;
  if (o.y < T + r && !open) { o.y = T + r; hit = Math.max(hit, reflect(o, 0, -1, e)); }
  else if (o.y > B - r && !open) { o.y = B - r; hit = Math.max(hit, reflect(o, 0, 1, e)); }
  return hit;
}

function post(o, px, py, e) {
  const dx = o.x - px, dy = o.y - py, d = Math.hypot(dx, dy);
  if (d >= o.r || d === 0) return 0;
  const nx = dx / d, ny = dy / d;
  o.x = px + nx * o.r; o.y = py + ny * o.r;
  return reflect(o, -nx, -ny, e);
}

function capSpeed(o, max) {
  const sp = Math.hypot(o.vx, o.vy);
  if (sp > max) { o.vx *= max / sp; o.vy *= max / sp; }
}

function newBall(s, x, y) {
  const k = s.kind;
  return { x, y, vx: 0, vy: 0, r: k.r, m: k.m, on: true, respawn: 0, half: y > MID ? 0 : 1, ht: 0, tick: -1 };
}

function kickoff(s) {
  s.cars.forEach((c) => {
    const [ux, uy] = SIDE[c.i];
    c.x = CX + ux * 330; c.y = MID + uy * 330;
    c.vx = 0; c.vy = 0; c.a = Math.atan2(-uy, -ux);
    c.flip = 0; c.spin = 0; c.cd = 0.3;
  });
  const xs = s.trepalle ? [CX, CX - 260, CX + 260] : [CX];
  s.balls = xs.map((x) => newBall(s, x, MID));
}

// Unique leader in goals, or -1.
function leader(s) {
  let best = -1, cnt = 0;
  s.score.forEach((v, k) => { if (best < 0 || v > s.score[best]) { best = k; cnt = 1; } else if (v === s.score[best]) cnt++; });
  return cnt === 1 ? best : -1;
}

// End-of-game decision: more goals, else whoever has the ball in an opponent's half/zone.
function decide(s, g) {
  if (s.n === 2) {
    if (s.score[0] !== s.score[1]) return s.score[0] > s.score[1] ? 0 : 1;
    let cnt = 0, lean = 0;
    for (const b of s.balls) {
      const y = b.on ? b.y : MID;
      cnt += Math.sign(MID - y); lean += MID - y; // ball in the top half favours player 0
    }
    if (cnt !== 0) return cnt > 0 ? 0 : 1;
    if (lean !== 0) return lean > 0 ? 0 : 1;
    return s.last >= 0 ? s.last : g.rng() < 0.5 ? 0 : 1;
  }
  const keepMin = (list, f) => { const m = Math.min(...list.map(f)); return list.filter((k) => f(k) === m); };
  let c = keepMin(s.cars.map((q) => q.i), (k) => -s.score[k]);
  if (c.length > 1) c = keepMin(c, (k) => s.conc[k]);
  if (c.length > 1) {
    const inZone = s.cars.map(() => 0);
    for (const b of s.balls) if (b.on) { const z = zoneOf(b.x, b.y); if (z < s.n) inZone[z]++; }
    c = keepMin(c, (k) => inZone[k]);
  }
  if (c.length > 1 && c.includes(s.last)) return s.last;
  return c.length > 1 ? c[g.rng.int(0, c.length - 1)] : c[0];
}

// The ball went into the goal of `loser`. 2 players: the other one scores; 3–4: whoever touched it last
// (an own goal gives nobody a point).
function scoreGoal(s, g, b, loser, bomb) {
  const scorer = s.n === 2 ? 1 - loser : s.last >= 0 && s.last !== loser ? s.last : -1;
  if (scorer >= 0) s.score[scorer]++;
  s.conc[loser]++;
  s.gl[loser] = 1; s.gc[loser] = scorer >= 0 ? scorer : loser;
  b.on = false; b.vx = 0; b.vy = 0;
  const fxo = scorer >= 0 ? { player: scorer } : { color: '#ffffff' };
  // Rocket League style explosion (a gunpowder one, here).
  g.sfx('bigexplode'); g.sfx('goal');
  g.burst(b.x, b.y, { ...fxo, n: 60, speed: 750, size: 14 });
  g.burst(b.x, b.y, { color: '#ffd36b', n: 30, speed: 420, size: 10 });
  g.ring(b.x, b.y, { ...fxo, r: 420 });
  g.confetti(b.x, b.y);
  g.shake(0.9); g.flash('#ffffff', 0.45);
  g.slowmo(0.3, 0.35);
  g.vibrate(loser, 300);
  if (scorer >= 0) g.vibrate(scorer, 100);
  for (const c of s.cars) {
    const dx = c.x - b.x, dy = c.y - b.y, d = Math.hypot(dx, dy);
    if (d < 450) {
      const n = d > 0 ? { x: dx / d, y: dy / d } : { x: SIDE[c.i][0], y: SIDE[c.i][1] };
      const k = (1 - d / 450) * 1400;
      c.vx += n.x * k; c.vy += n.y * k;
      if (d < 260) c.spin = 0.6;
    }
  }
  if (scorer >= 0) s.cars[scorer].joy = 2;
  s.cars[loser].sad = 2;
  s.cars[loser].boost = 1; // comeback: whoever conceded restarts with a full turbo
  if (s.golden) { const w = leader(s); if (w >= 0) { g.end(w, "GOL D'ORO!"); return; } }
  g.say(scorer < 0 ? 'AUTOGOL!' : bomb ? 'BOOM! GOL!' : 'GOOOL!');
  if (s.trepalle) b.respawn = 1.2;
  else s.goalT = 1.5;
}

// Cart vs ball: mass-based bounce, plus a push from the cart's speed; jump = huge kick.
function carBall(s, g, c, b) {
  const dx = b.x - c.x, dy = b.y - c.y, d = Math.hypot(dx, dy);
  if (d >= c.r + b.r || d === 0) return;
  const nx = dx / d, ny = dy / d;
  const along = c.vx * nx + c.vy * ny;
  const A = { x: c.x, y: c.y, vx: c.vx, vy: c.vy, r: c.r, m: c.m * (c.flip > 0 ? 4 : 1) };
  const imp = collideCircles(A, b, 0.5);
  c.x = A.x; c.y = A.y; c.vx = A.vx; c.vy = A.vy;
  if (imp <= 0) return;
  s.last = c.i;
  let kick = Math.max(0, along) * 0.35;
  if (c.flip > 0 && !c.flipHit) {
    c.flipHit = true;
    kick += FLIP_KICK;
    g.sfx('kick'); g.sfx('bang', { vol: 0.8 });
    g.burst(b.x - nx * b.r, b.y - ny * b.r, { player: c.i, n: 24, speed: 520 });
    g.ring(b.x, b.y, { player: c.i, r: b.r + 70 });
    g.shake(0.5); g.hitstop(0.06); g.vibrate(c.i, 80);
  } else if (imp > 160 && c.kickCd <= 0) {
    c.kickCd = 0.1;
    g.sfx('kick', { vol: clamp(imp / 900, 0.3, 1), pitch: imp > 700 ? 0.9 : 1.2 });
  }
  const km = kick / Math.sqrt(b.m);
  b.vx += nx * km; b.vy += ny * km;
  capSpeed(b, s.kind.max);
}

// Cart vs cart: bumps with sparks; a jumping cart hits like a hay wagon.
function carCar(s, g, c0, c1) {
  const A = { x: c0.x, y: c0.y, vx: c0.vx, vy: c0.vy, r: c0.r, m: c0.m * (c0.flip > 0 ? 3 : 1) };
  const Bc = { x: c1.x, y: c1.y, vx: c1.vx, vy: c1.vy, r: c1.r, m: c1.m * (c1.flip > 0 ? 3 : 1) };
  const imp = collideCircles(A, Bc, 0.7);
  Object.assign(c0, { x: A.x, y: A.y, vx: A.vx, vy: A.vy });
  Object.assign(c1, { x: Bc.x, y: Bc.y, vx: Bc.vx, vy: Bc.vy });
  if (imp > 250 && s.crashCd <= 0) {
    s.crashCd = 0.25;
    const mx = (c0.x + c1.x) / 2, my = (c0.y + c1.y) / 2;
    const hard = imp > 700;
    g.sfx(hard ? 'crash' : 'bonk');
    g.burst(mx, my, { color: '#ffd36b', n: hard ? 22 : 10, speed: hard ? 480 : 260, size: 6 });
    g.shake(hard ? 0.45 : 0.2);
    if (hard) {
      g.hitstop(0.05);
      const victim = c0.flip > 0 && c1.flip <= 0 ? c1 : c1.flip > 0 && c0.flip <= 0 ? c0 : null;
      if (victim) { victim.spin = 0.5; g.vibrate(victim.i, 120); g.text(victim.x, victim.y - 70, 'BAM!', { player: victim === c0 ? c1.i : c0.i }); }
    }
  }
}

function stepCar(s, g, c, i, dt) {
  c.cd = Math.max(0, c.cd - dt); c.kickCd = Math.max(0, c.kickCd - dt); c.smoke = Math.max(0, c.smoke - dt);
  c.joy = Math.max(0, c.joy - dt); c.sad = Math.max(0, c.sad - dt); c.wallCd = Math.max(0, c.wallCd - dt);
  c.turbo = false;
  if (s.freeze > 0) { c.vx = 0; c.vy = 0; c.boost = Math.min(1, c.boost + BOOST_GAIN * dt); return; }
  const mag = Math.min(1, Math.hypot(i.x, i.y));
  const speed = Math.hypot(c.vx, c.vy);
  let diff = 0;
  if (c.spin > 0) { c.spin -= dt; c.a += 13 * dt; }
  else if (c.flip <= 0 && mag > 0.2) {
    // Intuitive steering: the cart turns toward the stick direction (world) at a limited rate.
    diff = angleDiff(c.a, Math.atan2(i.y, i.x));
    const rate = TURN * (0.55 + 0.45 * Math.min(1, speed / 350));
    c.a += clamp(diff, -rate * dt, rate * dt);
  }
  if (c.flip > 0) { c.flip -= dt; return; }
  const fx = Math.cos(c.a), fy = Math.sin(c.a);
  let vf = c.vx * fx + c.vy * fy, vl = -c.vx * fy + c.vy * fx;
  const turbo = i.a && c.boost > 0.02 && c.spin <= 0;
  let cap = VMAX;
  if (turbo) {
    vf += TURBO_ACC * dt; cap = TURBO_MAX; c.boost = Math.max(0, c.boost - BOOST_USE * dt); c.turbo = true;
  } else {
    c.boost = Math.min(1, c.boost + BOOST_GAIN * dt);
    const throttle = mag > 0.2 && c.spin <= 0 ? mag * (Math.abs(diff) > 2 ? 0.4 : 1) : 0;
    if (throttle > 0) vf += throttle * ACC * dt;
    else vf *= damp(0.3, dt);
  }
  if (vf > cap) vf = Math.max(cap, vf - 2200 * dt);
  if (vf < -300) vf = -300;
  const sliding = turbo || Math.abs(diff) > 1;
  vl *= damp(sliding ? DRIFT : GRIP, dt);
  c.vx = fx * vf - fy * vl; c.vy = fy * vf + fx * vl;
  if (Math.abs(vl) > 260 && c.smoke <= 0) {
    c.smoke = 0.12;
    g.burst(c.x - fx * 35, c.y - fy * 35, { color: '#e6d3a8', n: 3, speed: 60, size: 7 });
  }
  if (i.bP && c.cd <= 0 && c.spin <= 0) {
    // Jump: short dash (toward the stick if held) that smashes the ball.
    const dir = mag > 0.3 ? norm(i.x, i.y) : { x: fx, y: fy };
    c.a += angleDiff(c.a, Math.atan2(dir.y, dir.x));
    c.vx = dir.x * FLIP_SPEED; c.vy = dir.y * FLIP_SPEED;
    c.flip = FLIP_TIME; c.cd = FLIP_CD; c.flipHit = false;
    g.sfx('jump'); g.sfx('whoosh', { vol: 0.6 });
    g.burst(c.x, c.y, { player: c.i, n: 8, speed: 200 });
  }
}

// ---- Computer player ----
const BOT_DELAY = [0.34, 0.2, 0.09]; // reaction delay of the bot driver per level (core/bots.js)

// Where a ball will be after t seconds (damped straight line, folded on the boards).
function ballAt(s, b, t) {
  const kp = s.kind.keep, k = (1 - Math.pow(kp, t)) / -Math.log(kp);
  const fold = (v, lo, hi) => {
    const w = hi - lo;
    if (w <= 0) return v;
    let u = (v - lo) % (2 * w);
    if (u < 0) u += 2 * w;
    return lo + (u > w ? 2 * w - u : u);
  };
  return { x: fold(b.x + b.vx * k, L + b.r, R - b.r), y: fold(b.y + b.vy * k, T + b.r, B - b.r) };
}

// Aim point for a shot from (px, py) at goal k: across the mouth, banked off a side board, or (when the
// defender blocks everything) a dribble point beside the defender.
function calcAim(s, k, px, py, smart) {
  const [gx, gy] = GOAL[k], [, uy] = SIDE[k], br = s.kind.r, w = Math.max(10, s.kind.gw - br * 0.6);
  const def = s.cars[k];
  const blocked = (x, y) => {
    if (!def) return 0;
    const dx = x - px, dy = y - py, d = Math.hypot(dx, dy) || 1;
    const t = clamp(((def.x - px) * dx + (def.y - py) * dy) / (d * d), 0, 1);
    const off = Math.hypot(def.x - (px + dx * t), def.y - (py + dy * t));
    const clear = def.r + br + 25;
    return off < clear ? 700 * (1 - off / clear) + 250 : 0;
  };
  let best = null, bc = Infinity;
  const consider = (x, y, extra, bank) => {
    let c = Math.hypot(x - px, y - py) + extra + blocked(x, y);
    if (bank) {
      // A bank shot also passes the defender after the bounce: check the mirrored defender.
      const dm = def ? (uy ? { x: (bank < 0 ? 2 * (L + br) : 2 * (R - br)) - def.x, y: def.y } : { x: def.x, y: (bank < 0 ? 2 * (T + br) : 2 * (B - br)) - def.y }) : null;
      if (dm) {
        const dx = x - px, dy = y - py, d = Math.hypot(dx, dy) || 1;
        const t = clamp(((dm.x - px) * dx + (dm.y - py) * dy) / (d * d), 0, 1);
        const off = Math.hypot(dm.x - (px + dx * t), dm.y - (py + dy * t));
        if (off < def.r + br + 25) c += 600;
      }
    }
    if (c < bc) { bc = c; best = { x, y, open: blocked(x, y) === 0 && !bank }; }
  };
  for (const f of [0, -0.6, 0.6]) {
    const x = uy ? gx + f * w : gx, y = uy ? gy : gy + f * w;
    consider(x, y, Math.abs(f) * 40, 0);
  }
  if (def && bc > 400 + Math.hypot(gx - px, gy - py)) {
    // Everything is blocked: dribble around the defender first.
    const dx = gx - px, dy = gy - py, d = Math.hypot(dx, dy) || 1;
    for (const sg of [-1, 1]) {
      const x = clamp(def.x + (-dy / d) * sg * 230, L + br + 30, R - br - 30), y = clamp(def.y + (dx / d) * sg * 230, T + br + 30, B - br - 30);
      consider(x, y, 300, 0);
    }
  }
  return best;
}

function calcettoBot(s, me, g, B) {
  const c = s.cars[me];
  if (!c) return { x: 0, y: 0 };
  const n = s.n, lv = B.level, delay = BOT_DELAY[lv], mem = B.mem;
  const [ux, uy] = SIDE[me], [gx, gy] = GOAL[me];
  // My position once my input lands.
  const mx = c.x + c.vx * delay, my = c.y + c.vy * delay;
  const live = s.balls.filter((b) => b.on);
  if (!live.length || s.freeze > 0 && s.freeze > delay + 0.1) {
    const hx = gx - ux * 330, hy = gy - uy * 330;
    const dx = hx - c.x, dy = hy - c.y, d = Math.hypot(dx, dy);
    return d > 60 ? { x: dx / d, y: dy / d } : { x: -ux * 0.01, y: -uy * 0.01 };
  }
  // Ball that matters: closest to my goal among the near ones (better bots weigh time to reach it).
  let ball = null, bs = Infinity;
  for (const b of live) {
    const dGoal = Math.hypot(b.x - gx, b.y - gy), dMe = Math.hypot(b.x - mx, b.y - my);
    const sc = dMe + dGoal * (lv === 0 ? 0.2 : 0.6);
    if (sc < bs) { bs = sc; ball = b; }
  }
  const rs = c.r + ball.r;
  // Intercept: first moment the ball is where I can be.
  let bt = 0.1, P = ballAt(s, ball, delay + 0.1);
  if (lv > 0) {
    for (let t = 0.1; t <= 1.6; t += 0.1) {
      const q = ballAt(s, ball, delay + t);
      const need = Math.max(0, Math.hypot(q.x - mx, q.y - my) - rs) / (c.turbo || lv === 2 ? 800 : 620);
      bt = t; P = q;
      if (need <= t) break;
    }
  }
  // Target goal: in 2-player the opponent's; with 3–4 the most open rival goal.
  let aim = null;
  if (n === 2) aim = calcAim(s, 1 - me, P.x, P.y, true);
  else {
    let bc = Infinity;
    for (let k = 0; k < n; k++) {
      if (k === me) continue;
      const a = calcAim(s, k, P.x, P.y, true);
      const cc = Math.hypot(a.x - P.x, a.y - P.y) - (lv === 2 ? s.score[k] * 40 : 0);
      if (cc < bc) { bc = cc; aim = a; }
    }
  }
  let ax = aim.x - P.x, ay = aim.y - P.y;
  { const l = Math.hypot(ax, ay) || 1; ax /= l; ay /= l; }
  const rx = mx - P.x, ry = my - P.y, dP = Math.hypot(rx, ry) || 1;
  const back = -(rx * ax + ry * ay) / dP;   // 1 = I'm right behind the ball on the shooting line
  const side = rx * -ay + ry * ax;
  // Danger: the ball is between me and my own goal (I'm upfield) → get back on the goal side first.
  const ballGoal = Math.hypot(P.x - gx, P.y - gy), meGoal = Math.hypot(mx - gx, my - gy);
  const ownSide = meGoal < ballGoal + 40;

  // Defence: the ball is rolling at my goal and I'm not between them → block its path.
  let defend = null;
  {
    const along = (gx - ball.x) * ux + (gy - ball.y) * uy, va = ball.vx * ux + ball.vy * uy;
    const ta = va > 80 ? along / va : 9;
    if (ta < (lv === 0 ? 1.2 : 2)) {
      const hit = ballAt(s, ball, ta);
      const lat = uy ? Math.abs(hit.x - gx) : Math.abs(hit.y - gy);
      const guarding = ownSide && Math.abs(side) < rs && back > 0.5;
      if ((lat < s.kind.gw + 140 || n >= 3) && !guarding) {
        for (let t = 0.1; t < ta; t += 0.1) {
          const q = ballAt(s, ball, t);
          // a point on the path I reach first, approached from the goal side
          const bx = q.x + ux * (rs + 20), by = q.y + uy * (rs + 20);
          const need = Math.hypot(bx - mx, by - my) / 700 + (lv === 0 ? 0.2 : 0);
          if (need < t) { defend = { x: bx, y: by }; break; }
        }
        if (!defend) defend = { x: uy ? clamp(hit.x, gx - s.kind.gw, gx + s.kind.gw) : gx - ux * 70, y: uy ? gy - uy * 70 : clamp(hit.y, gy - s.kind.gw, gy + s.kind.gw) };
      }
    }
  }

  let tx, ty;
  if (defend) {
    tx = clamp(defend.x, L + c.r + 10, R - c.r - 10); ty = clamp(defend.y, T + c.r + 10, B - c.r - 10);
  } else if (back > 0.82 && Math.abs(side) < rs * 0.7) {
    // Lined up: drive through the ball toward the goal.
    tx = P.x + ax * 120; ty = P.y + ay * 120;
  } else {
    const off = rs + 50;
    tx = P.x - ax * off; ty = P.y - ay * off;
    // On the wrong side of the ball: swing around it (on the side I'm on), never through it.
    if (back < 0.3) {
      const sg = side >= 0 ? 1 : -1;
      tx = P.x - ax * off * 0.4 + -ay * sg * (rs + 90);
      ty = P.y - ay * off * 0.4 + ax * sg * (rs + 90);
    }
    // Never drive through the ball on the way: pass it on my side.
    const sx = tx - mx, sy = ty - my, sl2 = sx * sx + sy * sy || 1;
    const u = clamp(((P.x - mx) * sx + (P.y - my) * sy) / sl2, 0, 1);
    const qx = mx + sx * u - P.x, qy = my + sy * u - P.y, qd = Math.hypot(qx, qy);
    if (u > 0.02 && u < 0.98 && qd < rs + 35) {
      const sl = Math.sqrt(sl2);
      let nx = -sy / sl, ny = sx / sl;
      if (nx * (mx - P.x) + ny * (my - P.y) < 0) { nx = -nx; ny = -ny; }
      tx = P.x + nx * (rs + 90); ty = P.y + ny * (rs + 90);
    }
    tx = clamp(tx, L + c.r + 10, R - c.r - 10); ty = clamp(ty, T + c.r + 10, B - c.r - 10);
  }
  let dx = tx - mx, dy = ty - my;
  const dl = Math.hypot(dx, dy) || 1;
  dx /= dl; dy /= dl;
  const heading = Math.atan2(dy, dx);
  const turn = Math.abs(angleDiff(c.a, heading));
  // Slow down for tight turns near the target so the cart does not orbit it.
  const thr = dl < 160 && turn > 1.2 ? 0.45 : 1;
  const want = { x: dx * thr, y: dy * thr };

  // Jump-kick: ball close, lined up toward the goal (or clearing it away from my goal).
  const dBall = Math.hypot(P.x - mx, P.y - my) - rs;
  if (c.cd <= 0 && c.spin <= 0 && dBall < [90, 140, 170][lv]) {
    const bx = (P.x - mx) / dP, by = (P.y - my) / dP;
    const cosShot = bx * ax + by * ay;
    const clear = ballGoal < 520 && (bx * -ux + by * -uy) > 0.5; // kicks it away from my goal
    if ((cosShot > [0.9, 0.93, 0.95][lv] && (aim.open || lv === 0)) || (lv > 0 && clear)) {
      if (lv > 0 || B.rng() < 0.15) { want.x = bx; want.y = by; want.tapB = true; }
    }
  }
  // Gunpowder: long straight runs (and lined-up shots); the easy bot only on long runs.
  if (c.boost > 0.15 && turn < 0.35) {
    const lined = back > 0.85 && Math.abs(side) < rs * 0.6 && dBall < 450;
    if (dl > (lv === 0 ? 650 : 380) || (lv > 0 && lined)) want.a = true;
  }
  mem.t = g.t;
  return want;
}

export default {
  id: 'calcetto',
  name: 'Calcio Storico su Ruote',
  rule: 'Spingi la palla in porta col tuo carretto!',
  verb: 'GOL!',
  inspired: 'Rocket League · Calcio Storico',
  cam: 'top',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Polvere', b: 'Salto' },
  help: {
    goal: "Spingi la palla nella porta di un rivale col tuo carretto. Chi ha più gol al fischio vince; in parità, gol d'oro.",
    dir: 'Il carretto gira verso dove punti lo stick e accelera da solo: punta dove vuoi andare.',
    a: 'POLVERE DA SPARO (tieni premuto): il barile dietro al carretto sputa fuoco e vai a tutta. Passa sui barili arancioni per ricaricarla.',
    b: "SALTO: balzo fulmineo verso lo stick che calcia la palla fortissimo e fa girare il carretto che centri.",
    tips: ['Prendi la palla da dietro, puntando verso la porta', 'Chi subisce gol riparte con la polvere piena', 'In 3–4 il gol vale per chi ha toccato per ultimo la palla'],
  },
  duration: 50,
  supports: ['scale'],
  variants: [
    { id: 'bomba', name: 'Palla Bombarda', desc: '6 secondi nella stessa metà e la palla esplode: gol!' },
    { id: 'trepalle', name: 'Tre Vesciche', desc: 'Tre palle di vescica di maiale in campo insieme!' },
    { id: 'gigante', name: 'Palla del Gigante', desc: 'Una palla enorme e pesantissima!' },
  ],

  init(g) {
    const n = g.n || 2;
    const sc = g.mods.scale || [];
    // Slow-motion mod: shorter internal clock so the round still ends in reasonable real time.
    const k = g.mods.moviola ? 0.55 : 1;
    const seats = [...Array(n).keys()];
    const pads = PADS;
    const s = {
      n, padXY: pads,
      kind: g.variant === 'gigante' ? BALLS.gigante : BALLS.normal,
      trepalle: g.variant === 'trepalle', bomba: g.variant === 'bomba',
      reg: 40 * k, end: 50 * k, warned: false, checked: false, golden: false,
      score: seats.map(() => 0), conc: seats.map(() => 0), last: -1, time: 0, goalT: 0, freeze: 0, crashCd: 0,
      cars: seats.map((i) => {
        const q = sc[i] ?? 1;
        return {
          i, x: 0, y: 0, vx: 0, vy: 0, a: 0, r: CAR_R * q, m: 2.2 * q * q, sc: q,
          boost: 1, turbo: false, flip: 0, flipHit: false, cd: 0, spin: 0, kickCd: 0, smoke: 0, wallCd: 0, joy: 0, sad: 0,
        };
      }),
      balls: [],
      pads: pads.map(() => 0), // respawn timers (0 = ready)
      gl: seats.map(() => 0), // goal flash per goal (index = defending player)
      gc: seats.slice(), // color of that flash (the scorer)
    };
    kickoff(s);
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt, n = s.n;
    const gw = s.kind.gw;
    s.crashCd = Math.max(0, s.crashCd - dt);
    for (let k = 0; k < n; k++) s.gl[k] = Math.max(0, s.gl[k] - dt * 0.8);
    s.time = g.t;

    // Clock: warning, end of regulation, golden goal.
    if (!s.warned && g.t >= s.reg - 10) { s.warned = true; g.say('ULTIMI 10 SECONDI!'); g.sfx('matchpoint'); }
    if (!s.checked && g.t >= s.reg && !g.ended) {
      s.checked = true;
      const w = leader(s);
      if (w >= 0) { g.sfx('whistle'); g.end(w, 'Fischio finale!'); }
      else { s.golden = true; g.say("⚡ GOL D'ORO! ⚡"); g.sfx('horn'); g.flash('#ffd36b', 0.4); g.shake(0.3); }
    }
    if (!g.ended && g.t >= s.end) { g.sfx('timeup'); g.end(decide(s, g), 'Palla nella metà giusta!'); }

    // After a goal: wait, then kickoff with a short freeze.
    if (s.goalT > 0) {
      s.goalT -= dt;
      if (s.goalT <= 0 && !g.ended) { kickoff(s); s.freeze = 0.7; g.sfx('boing'); }
    }
    if (s.freeze > 0) {
      s.freeze -= dt;
      if (s.freeze <= 0) { g.sfx('whistle'); g.say('VIA!'); }
    }

    s.cars.forEach((c) => stepCar(s, g, c, inp[c.i], dt));
    s.pads.forEach((tm, k) => {
      if (tm > 0) { s.pads[k] = Math.max(0, tm - dt); return; }
      const [px, py] = s.padXY[k];
      for (const c of s.cars) {
        if (c.boost > 0.95 || Math.hypot(c.x - px, c.y - py) > PAD_R + c.r * 0.6) continue;
        c.boost = 1; s.pads[k] = PAD_RESPAWN;
        g.sfx('powerup', { pitch: 1.4, vol: 0.6 });
        g.ring(px, py, { player: c.i, r: 120 });
        g.burst(px, py, { color: '#ffb300', n: 12, speed: 260 });
        g.vibrate(c.i, 40);
        break;
      }
    });

    const h = dt / SUBSTEPS;
    for (let k = 0; k < SUBSTEPS; k++) {
      for (const c of s.cars) { c.x += c.vx * h; c.y += c.vy * h; }
      for (const b of s.balls) if (b.on) { b.x += b.vx * h; b.y += b.vy * h; }
      for (const b of s.balls) if (b.on) for (const c of s.cars) carBall(s, g, c, b);
      for (let a = 0; a < s.cars.length; a++) for (let c = a + 1; c < s.cars.length; c++) carCar(s, g, s.cars[a], s.cars[c]);
      // Ball vs ball (Tre Vesciche).
      for (let a = 0; a < s.balls.length; a++) {
        for (let b = a + 1; b < s.balls.length; b++) {
          if (s.balls[a].on && s.balls[b].on) collideCircles(s.balls[a], s.balls[b], 0.9);
        }
      }
      for (const c of s.cars) {
        const hit = confine(c, 0.3, 0);
        if (hit > 380 && c.wallCd <= 0) { c.wallCd = 0.2; g.sfx('bonk', { vol: 0.6 }); g.burst(c.x, c.y, { color: '#ffd36b', n: 6, speed: 200 }); }
      }
      for (const b of s.balls) {
        if (!b.on) continue;
        let hit = confine(b, s.kind.e, gw, n);
        hit = Math.max(hit, post(b, CX - gw, T, 0.7), post(b, CX + gw, T, 0.7), post(b, CX - gw, B, 0.7), post(b, CX + gw, B, 0.7));
        if (n >= 3) hit = Math.max(hit, post(b, L, MID - gw, 0.7), post(b, L, MID + gw, 0.7));
        if (n >= 4) hit = Math.max(hit, post(b, R, MID - gw, 0.7), post(b, R, MID + gw, 0.7));
        if (hit > 300) g.sfx('bounce', { vol: clamp(hit / 1200, 0.2, 0.8) });
        if (!g.ended) {
          if (b.y < T) scoreGoal(s, g, b, 1, false);
          else if (b.y > B) scoreGoal(s, g, b, 0, false);
          else if (n >= 3 && b.x < L) scoreGoal(s, g, b, 2, false);
          else if (n >= 4 && b.x > R) scoreGoal(s, g, b, 3, false);
        } else if (b.y < T || b.y > B || b.x < L || b.x > R) { b.vx = 0; b.vy = 0; }
      }
    }

    for (const b of s.balls) {
      if (!b.on) {
        if (b.respawn > 0) {
          b.respawn -= dt;
          if (b.respawn <= 0 && !g.ended) {
            Object.assign(b, newBall(s, CX, MID));
            g.sfx('pop'); g.ring(CX, MID, { color: '#ffffff', r: 140 });
          }
        }
        continue;
      }
      const kf = damp(s.kind.keep, dt);
      b.vx *= kf; b.vy *= kf;
      capSpeed(b, s.kind.max);
      // Palla Bombarda: 6 s in the same half (zone with 3–4) = explosion, goal against whoever defends it.
      if (s.bomba && s.freeze <= 0 && !g.ended) {
        const half = n === 2 ? (b.y > MID ? 0 : 1) : zoneOf(b.x, b.y);
        if (half !== b.half || half >= n) { b.half = half; b.ht = 0; b.tick = -1; }
        else b.ht += dt;
        const sec = Math.floor(b.ht);
        if (b.ht > 3 && sec !== b.tick) {
          b.tick = sec;
          g.sfx(sec === 3 ? 'fuse' : 'tick', { pitch: 1 + (sec - 3) * 0.2 });
        }
        if (b.ht >= BOMB_TIME) scoreGoal(s, g, b, half, true);
      }
    }
  },

  timeout(s, g) {
    return decide(s, g);
  },

  bot: calcettoBot,

  view(s) {
    return {
      c: s.cars.map((c) => ({
        x: r1(c.x), y: r1(c.y), a: r2(c.a), s: r2(c.sc), t: c.turbo ? 1 : 0,
        f: c.flip > 0 ? r2(1 - c.flip / FLIP_TIME) : 0, r: c.cd <= 0 ? 1 : 0,
        md: c.spin > 0 ? 2 : c.sad > 0 ? 4 : c.joy > 0 ? 1 : c.flip > 0 || c.turbo ? 3 : 0,
      })),
      b: s.balls.map((b) => ({ x: r1(b.x), y: r1(b.y), vx: Math.round(b.vx), vy: Math.round(b.vy), r: b.r, o: b.on ? 1 : 0, f: s.bomba ? r2(b.ht / BOMB_TIME) : 0 })),
      gl: s.gl.map(r2),
      gc: s.gc.slice(),
      gw: s.kind.gw,
      gd: s.golden ? 1 : 0,
      rt: s.checked ? 0 : r2(clamp(1 - s.time / s.reg, 0, 1)),
      pd: s.pads.map((tm) => (tm > 0 ? r2(1 - tm / PAD_RESPAWN) : 1)),
      hud: { p: s.score.slice(), max: null, label: 'Gol', bar: s.cars.map((c) => r2(c.boost)) },
    };
  },

  focus(v) {
    return v.c.map((c) => ({ x: c.x, y: c.y }));
  },

  render3d: {
    assets: [
      'medieval/building_church_yellow', 'medieval/building_tower_A_yellow', 'medieval/building_tavern_red', 'medieval/building_tavern_blue',
      'medieval/building_home_A_red', 'medieval/building_home_A_green', 'medieval/building_home_B_blue', 'medieval/building_home_B_yellow',
      'medieval/building_market_red', 'medieval/building_market_green', 'medieval/building_market_blue', 'medieval/building_well_green',
      'medieval/building_blacksmith_green', 'medieval/building_windmill_red', 'medieval/tree_single_A', 'medieval/trees_A_medium',
      'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow', 'medieval/barrel', 'medieval/crate_A_small',
      'medieval/wheelbarrow', 'medieval/hills_B_trees',
    ],
    build(K, r) {
      const { THREE } = K;
      const n = r.n || K.n || 2;
      const lo = K.quality === 0;
      const gw = r.variant === 'gigante' ? BALLS.gigante.gw : BALLS.normal.gw;
      const big = r.variant === 'gigante';
      const bomb = r.variant === 'bomba';
      const pads = PADS;
      const o = { gw, bomb, n, pads, tmpV: new THREE.Vector3(), tmpQ: new THREE.Quaternion(), dummy: new THREE.Object3D() };
      K.theme('giorno', { fogNear: 2.2, fogFar: 5.5 });
      // Cobbled piazza, sand pitch (like the real Calcio Storico), chalk markings.
      K.ground('pietra', { tile: 200, color: '#e8dccb' });
      const sand = K.prism(roundRectPts(L - 30, T - 30, R + 30, B + 30, CORNER + 30), 3, K.texMat('sabbia', [1 / 170, 1 / 170], { color: '#f2dcae' }), { cast: false });
      K.place(sand, 0, 0, 0);
      K.layer({
        x0: L - 100, y0: T - NET - 30, x1: R + 100, y1: B + NET + 30, h: 3.4, transparent: true, once: true,
        draw: (d) => drawPitch(d, gw, n, K.col),
      });
      // Dynamic markings: barrel recharge arcs, goal glow, regulation clock, golden-goal ring.
      K.layer({
        x0: L - 20, y0: T - NET - 20, x1: R + 20, y1: B + NET + 20, h: 3.8, transparent: true, z: 1, maxPx: 1024,
        draw: (d, v) => drawPitchFx(d, v, pads, K.col),
        key: (v) => `${(v.pd || []).map((k) => Math.round(k * 24)).join(',')}|${v.gl.map((q) => Math.round(q * 20)).join(',')}|${Math.round(v.rt * 120)}|${v.gd ? Math.floor(K.t * 12) : '-'}`,
      });

      // Wooden barriers (fixed corners + straight runs split around the goal mouths), red-white painted top rail.
      const WT = 22, WH = 44;
      const plank = K.mat('#9b6a3e', { rough: 0.85 });
      const rail = K.mat('#f3efe6', { rough: 0.6 });
      const cornersD = [[L + CORNER, T + CORNER, Math.PI, 1.5 * Math.PI], [R - CORNER, T + CORNER, 1.5 * Math.PI, TAU], [R - CORNER, B - CORNER, 0, 0.5 * Math.PI], [L + CORNER, B - CORNER, 0.5 * Math.PI, Math.PI]];
      for (const [cx, cy, a0, a1] of cornersD) {
        K.prism(arcPts(cx, cy, a0, a1, CORNER, CORNER + WT), WH, plank);
        K.place(K.prism(arcPts(cx, cy, a0, a1, CORNER - 2, CORNER + WT + 2), 7, rail, { cast: false }), 0, 0, WH);
      }
      const runs = [[0, B, 'x'], [1, T, 'x'], [2, L, 'y'], [3, R, 'y']];
      for (const [k, c, ax] of runs) {
        const open = ax === 'x' || k < n;
        const lo2 = ax === 'x' ? L + CORNER : T + CORNER, hi = ax === 'x' ? R - CORNER : B - CORNER, mid = ax === 'x' ? CX : MID;
        const parts = open ? [[lo2, mid - gw], [mid + gw, hi]] : [[lo2, hi]];
        const out = c === B || c === R ? 1 : -1;
        for (const [a0, a1] of parts) {
          const len = a1 - a0, m = (a0 + a1) / 2, cc = c + out * WT / 2;
          const bx = ax === 'x' ? K.box(len, WT, WH, plank) : K.box(WT, len, WH, plank);
          K.place(bx, ax === 'x' ? m : cc, ax === 'x' ? cc : m, WH / 2);
          const tp = ax === 'x' ? K.box(len, WT + 4, 7, rail, { cast: false }) : K.box(WT + 4, len, 7, rail, { cast: false });
          K.place(tp, ax === 'x' ? m : cc, ax === 'x' ? cc : m, WH + 3.5);
        }
      }

      // Goals: team-colored wooden frame, rope net box, inner glow after a goal, team banner behind.
      const GH = big ? 250 : 130;
      const netTex = K.canvasTex(64, 64, (d, ctx, w, h) => {
        ctx.strokeStyle = 'rgba(245,235,210,0.95)'; ctx.lineWidth = 6;
        ctx.strokeRect(0, 0, w, h);
      });
      if (netTex) { netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping; }
      o.goalGlow = [];
      for (let i = 0; i < n; i++) {
        const [ux, uy] = SIDE[i], [gx, gy] = GOAL[i];
        const G = K.group();
        K.place(G, gx, gy);
        K.face(G, Math.atan2(uy, ux) - Math.PI / 2);
        const P = { parent: G };
        const frame = K.mat(K.col(i), { rough: 0.45, emissive: K.col(i), ei: 0.25 });
        const woodD = K.mat('#6b4426', { rough: 0.8 });
        for (const x of [-gw, gw]) {
          K.place(K.cyl(10, GH, frame, P), x, 0);
          K.place(K.cyl(6, GH, woodD, { parent: G, cast: false }), x, NET);
        }
        K.place(K.box(gw * 2 + 20, 18, 18, frame, P), 0, 0, GH);
        const netMat = new THREE.MeshStandardMaterial({ color: K.col(i, 'light'), map: netTex, transparent: true, opacity: netTex ? 0.8 : 0.25, side: THREE.DoubleSide, depthWrite: false, roughness: 0.9 });
        const plane = (w, h, rx, ry, x, y, hh) => {
          const g = new THREE.PlaneGeometry(w, h);
          const uv = g.attributes.uv;
          for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * w / 26, uv.getY(k) * h / 26);
          const m = K.mesh(g, netMat, { cast: false, parent: G });
          m.userData.ownGeo = true;
          m.rotation.set(rx, ry, 0);
          K.place(m, x, y, hh);
          return m;
        };
        plane(gw * 2, GH, 0, 0, 0, NET, GH / 2);
        plane(NET, GH, 0, Math.PI / 2, -gw, NET / 2, GH / 2);
        plane(NET, GH, 0, Math.PI / 2, gw, NET / 2, GH / 2);
        plane(gw * 2, NET, -Math.PI / 2, 0, 0, NET / 2, GH);
        const gg = K.disc(1, K.glow('#ffffff', { opacity: 0.6, add: true, unique: true }), { parent: G });
        K.place(gg, 0, NET * 0.4, 4.5);
        o.goalGlow.push(gg);
      }

      // Wooden stands with a bouncing crowd along the long sides (further out where side goals are).
      const standMat = K.texMat('legno', [1, 6], { color: '#a4774a' });
      const rows = [];
      for (const s of [-1, 1]) {
        for (let k = 0; k < 3; k++) {
          const hh = 34 + k * 36;
          const x = s < 0 ? L - 150 - k * 80 : R + 150 + k * 80;
          K.place(K.box(80, B - T + 300, hh, standMat), x, MID, hh / 2);
          rows.push({ x, top: hh });
        }
      }
      const SP = K.quality > 0 ? 50 : 80;
      const nf = Math.floor((B - T + 260) / SP);
      const crowdGeo = new THREE.SphereGeometry(15, 10, 8);
      const crowdMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
      const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, rows.length * nf);
      crowd.castShadow = false;
      const pal = [...[...Array(n).keys()].flatMap((i) => [K.col(i), K.col(i, 'light')]), '#f3e1c0', '#8a5a32', '#ffffff', '#c9a26b'];
      const col = new THREE.Color();
      o.fans = [];
      let idx = 0;
      rows.forEach((rw, k) => {
        for (let j = 0; j < nf; j++) {
          const y = T - 130 + j * SP + (k % 2) * SP * 0.5;
          const team = n === 2 ? (y > MID ? 0 : 1) : (j + k) % n;
          o.fans.push({ x: rw.x + ((j * 37) % 30) - 15, y, h: rw.top + 15, ph: (j * 1.7 + k * 2.3) % TAU, team });
          crowd.setColorAt(idx++, col.set(pal[(j * 5 + k * 3) % pal.length]));
        }
      });
      K.root.add(crowd);
      o.crowd = crowd;
      // Team flags at the corners of the pitch.
      [[-120, T - 60], [W + 120, T - 60], [-120, B + 60], [W + 120, B + 60]].forEach(([x, y], k) => {
        const slot = K.roster[k % n]?.color ?? k % n;
        const f = K.model(`medieval/flag_${TEAM[slot] || 'red'}`, { height: 260 });
        K.place(f, x, y); K.face(f, Math.atan2(MID - y, CX - x));
      });

      // The piazza: church at the far end, houses, taverns and market stalls all around.
      const bld = (name, x, y, a, size) => { const m = K.model(name, { size }); K.place(m, x, y); K.face(m, a); return m; };
      bld('medieval/building_church_yellow', CX, -560, Math.PI / 2, 420);
      bld('medieval/building_tower_A_yellow', CX - 420, -470, Math.PI / 2, 240);
      bld('medieval/building_tower_A_yellow', CX + 420, -470, Math.PI / 2, 240);
      const leftRow = ['medieval/building_tavern_red', 'medieval/building_home_A_green', 'medieval/building_home_B_blue', 'medieval/building_blacksmith_green', 'medieval/building_home_A_red', 'medieval/building_tavern_blue'];
      const rightRow = ['medieval/building_home_B_yellow', 'medieval/building_tavern_blue', 'medieval/building_home_A_red', 'medieval/building_home_A_green', 'medieval/building_home_B_blue', 'medieval/building_tavern_red'];
      leftRow.forEach((m, k) => bld(m, -720 - (k % 2) * 40, -260 + k * 400, 0, 330));
      rightRow.forEach((m, k) => bld(m, W + 720 + (k % 2) * 40, -260 + k * 400, Math.PI, 330));
      bld('medieval/building_market_red', -330, -160, 0.6, 200);
      bld('medieval/building_market_green', W + 330, -160, Math.PI - 0.6, 200);
      bld('medieval/building_market_blue', -330, H + 160, -0.6, 200);
      bld('medieval/building_market_red', W + 330, H + 160, Math.PI + 0.6, 200);
      bld('medieval/building_well_green', CX, H + 330, -Math.PI / 2, 150);
      bld('medieval/building_windmill_red', -900, H + 700, -0.3, 420);
      K.scatter('medieval/hills_B_trees', [{ x: -1500, y: -1200, rot: 0.4 }, { x: 2500, y: -1100, rot: 2 }, { x: -1700, y: H + 1300, rot: 1 }, { x: 2600, y: H + 1200, rot: 3 }], { size: 1200 });
      const trees = [];
      for (let k = 0; k < (lo ? 14 : 28); k++) {
        const a = (k / (lo ? 14 : 28)) * TAU;
        trees.push({ x: CX + Math.cos(a) * 1500, y: MID + Math.sin(a) * 1900, rot: k, s: 0.85 + (k % 3) * 0.15 });
      }
      K.scatter('medieval/trees_A_medium', trees, { size: 280 });
      K.scatter('medieval/tree_single_A', [[-220, -330], [W + 220, -330], [-220, H + 330], [W + 220, H + 330], [CX - 260, H + 380], [CX + 260, H + 380]].map(([x, y], k) => ({ x, y, rot: k })), { size: 150 });
      K.scatter('medieval/barrel', [[-90, T + 40], [-60, T + 80], [W + 90, B - 40], [W + 60, B - 80], [CX - 300, H + 260], [CX + 300, H + 250]].map(([x, y], k) => ({ x, y, rot: k })), { size: 46 });
      K.scatter('medieval/crate_A_small', [[-100, B - 30], [W + 100, T + 30], [CX - 360, H + 230]].map(([x, y], k) => ({ x, y, rot: k * 0.7 })), { size: 40 });
      K.scatter('medieval/wheelbarrow', [{ x: CX + 380, y: H + 300, rot: 2.4 }, { x: CX - 380, y: -230, rot: 0.6 }], { size: 80 });
      K.ambient('petali', { n: 40, x0: -200, y0: -200, x1: W + 200, y1: H + 200, h: 500 });

      // Gunpowder barrels: low ring + barrel model floating when ready.
      o.pads = pads.map(([x, y]) => {
        const base = K.cyl(PAD_R * 0.8, 5, K.mat('#5a3a1a', { rough: 0.7 }));
        K.place(base, x, y, 2);
        const ring = K.disc(PAD_R * 0.8, K.glow('#ffb300', { opacity: 0.85 }), { r0: PAD_R * 0.6 });
        K.place(ring, x, y, 7.5);
        const orb = K.model('medieval/barrel', { height: 44 });
        return { base, ring, orb, x, y };
      });

      // Balls (pool of 3): leather pig-bladder ball (or an iron bombard ball), trail, fuse + countdown.
      const ballTex = K.canvasTex(256, 128, (d, ctx, w, h) => paintBallTex(ctx, w, h, bomb));
      o.balls = [0, 1, 2].map(() => {
        const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', map: ballTex, roughness: bomb ? 0.35 : 0.6, metalness: bomb ? 0.4 : 0, emissive: '#ff2020', emissiveIntensity: 0 });
        if (!ballTex) mat.color.set(bomb ? '#2b2b33' : '#b07a44');
        const ball = K.ball(1, mat, { seg: 28 });
        const trail = [0.32, 0.22, 0.14, 0.08].map((a) => K.ball(1, K.glow(bomb ? '#ff7a5a' : '#fff1c8', { opacity: a, add: true }), { cast: false }));
        const blob = K.blob(1);
        const B3 = { ball, mat, trail, blob, h: 0, vh: 0, ps: 0, num: -1, fuse: null, spark: null, label: null, dec: null };
        if (bomb) {
          B3.fuse = K.cyl(5, 26, K.mat('#5a4630'));
          B3.spark = K.ball(1, K.glow('#ffb300', { add: true }), { cast: false });
          B3.label = K.billboard(128, 128, 90, (d, w, h, num, hot) => d.text(String(num), w / 2, h / 2 + 4, { size: 96, color: hot ? '#ff5252' : '#ffffff' }));
          B3.dec = K.decal(400);
        }
        return B3;
      });

      // Carts: wooden wagon in the player's colour with a gunpowder barrel at the back and the knight on board.
      o.cars = [...Array(n).keys()].map((i) => {
        const car = K.group();
        const P = { parent: car };
        const main = K.mat(K.col(i), { rough: 0.5 });
        const dark = K.mat(K.col(i, 'dark'), { rough: 0.6 });
        const wood = K.mat('#a0703f', { rough: 0.85 });
        const woodD = K.mat('#5e3d1f', { rough: 0.9 });
        const bed = K.box(CAR_LEN - 8, CAR_WID - 6, 12, wood, P); bed.position.set(0, 22, 0);
        for (const z of [-1, 1]) { const sd = K.box(CAR_LEN - 10, 6, 16, main, P); sd.position.set(0, 34, z * (CAR_WID / 2 - 4)); }
        const front = K.box(8, CAR_WID - 4, 22, dark, P); front.position.set(CAR_LEN / 2 - 6, 36, 0);
        // Pennant on a pole.
        const pole = K.cyl(2.5, 70, woodD, { parent: car, cast: false }); pole.position.set(CAR_LEN / 2 - 8, 30, -CAR_WID / 2 + 6);
        const flag = K.box(26, 3, 16, main, { parent: car, cast: false }); flag.position.set(CAR_LEN / 2 - 22, 90, -CAR_WID / 2 + 6);
        // Gunpowder barrel lying at the back, mouth pointing backwards.
        const barrel = K.cyl(14, 30, K.mat('#7a4e28', { rough: 0.8 }), { parent: car, center: true, seg: 14 });
        barrel.rotation.z = Math.PI / 2; barrel.position.set(-CAR_LEN / 2 + 2, 40, 0);
        const wheels = [];
        for (const [wx, wr] of [[-28, 19], [30, 15]]) for (const wz of [-1, 1]) {
          const wh = K.cyl(wr, 9, woodD, { parent: car, center: true, seg: 12 });
          wh.position.set(wx, wr, wz * (CAR_WID / 2 + 3));
          wheels.push(wh);
        }
        // Turbo flames out of the barrel: outer orange + inner yellow/white cones pointing backwards.
        const flames = [];
        for (const [c, w, op] of [['#ff6a00', 13, 0.85], ['#ffd54f', 8, 0.95], ['#ffffff', 4, 1]]) {
          const f = K.cone(1, 1, K.glow(c, { opacity: op }), { parent: car, cast: false });
          f.rotation.z = Math.PI / 2;
          f.position.set(-CAR_LEN / 2 - 12, 40, 0);
          f.userData.w = w;
          flames.push(f);
        }
        const av = K.avatar(i, { parent: car });
        const blob = K.blob(1);
        const dec = K.decal(220);
        return { car, wheels, flames, av, blob, dec, roll: 0, key: '' };
      });
      return o;
    },

    update(K, o, v, r) {
      const t = K.t, dt = Math.min(0.05, K.dt || 0), n = o.n;
      // Goal glow (the goal that conceded lights up in the scorer's colour).
      o.goalGlow.forEach((gg, i) => {
        const gl = v.gl ? v.gl[i] : 0;
        gg.visible = gl > 0.01;
        if (gg.visible) { gg.scale.setScalar(160 + 120 * (1 - gl)); gg.material.opacity = 0.7 * gl; gg.material.color.set(K.col(v.gc ? v.gc[i] : i)); }
      });
      // Crowd: idle sway, wild jumping after a goal for the scoring side.
      const cheer = [...Array(n).keys()].map(() => 0);
      if (v.gl) v.gl.forEach((q, k) => { const sc = v.gc ? v.gc[k] : n === 2 ? 1 - k : k; if (sc !== k && cheer[sc] !== undefined) cheer[sc] = Math.max(cheer[sc], q); });
      const gold = v.gd ? 0.5 : 0;
      const dm = o.dummy;
      o.fans.forEach((f, k) => {
        const ex = Math.max(cheer[f.team] || 0, gold);
        const amp = 3 + ex * 26;
        dm.position.set(f.x, f.h + Math.abs(Math.sin(t * (3 + ex * 6) + f.ph)) * amp, f.y);
        dm.updateMatrix();
        o.crowd.setMatrixAt(k, dm.matrix);
      });
      o.crowd.instanceMatrix.needsUpdate = true;

      // Gunpowder barrels.
      o.pads.forEach((p, idx) => {
        const k = v.pd ? v.pd[idx] : 1, on = k >= 1;
        p.ring.visible = p.orb.visible = on;
        if (!on) return;
        const bob = Math.sin(t * 3 + idx) * 6;
        K.place(p.orb, p.x, p.y, 14 + bob); p.orb.rotation.y = t * 1.5 + idx;
        p.ring.scale.setScalar(1 + Math.sin(t * 6 + idx) * 0.08);
      });

      // Balls.
      o.balls.forEach((B3, k) => {
        const b = v.b[k];
        const on = !!b && b.o === 1;
        B3.ball.visible = on; B3.blob.visible = on && !K.shadows;
        for (const tr of B3.trail) tr.visible = false;
        if (B3.fuse) { B3.fuse.visible = B3.spark.visible = B3.label.visible = on; B3.dec.show(on); }
        if (!on) { B3.h = 0; B3.vh = 0; B3.ps = 0; return; }
        const rr = b.r, sp = Math.hypot(b.vx || 0, b.vy || 0);
        // Cosmetic hop: a sudden kick lifts the ball, then it bounces back down (x, y stay exact).
        if (sp - B3.ps > 450 && B3.h < 6) B3.vh = Math.min(rr > 100 ? 380 : 720, (sp - B3.ps) * 0.55);
        B3.ps = sp;
        B3.vh -= 2600 * dt; B3.h += B3.vh * dt;
        if (B3.h <= 0) { B3.h = 0; B3.vh = B3.vh < -120 ? -B3.vh * 0.42 : 0; }
        K.place(B3.ball, b.x, b.y, rr + B3.h + 3);
        B3.ball.scale.setScalar(rr);
        if (sp > 1 && dt > 0) {
          o.tmpV.set(b.vy / sp, 0, -b.vx / sp);
          o.tmpQ.setFromAxisAngle(o.tmpV, (sp * dt) / rr);
          B3.ball.quaternion.premultiply(o.tmpQ);
        }
        K.place(B3.blob, b.x, b.y, 3.7); B3.blob.scale.set(rr * (1 - B3.h / 400), 1, rr * (1 - B3.h / 400));
        if (sp > 350) {
          B3.trail.forEach((tr, j) => {
            tr.visible = true;
            K.place(tr, b.x - b.vx * 0.014 * (j + 1), b.y - b.vy * 0.014 * (j + 1), rr + B3.h + 3);
            tr.scale.setScalar(rr * (1 - (j + 1) * 0.12));
          });
        }
        if (B3.fuse) {
          const left = 1 - b.f, hot = b.f > 0.5;
          B3.mat.emissiveIntensity = hot && Math.sin(t * (10 + b.f * 20)) > 0 ? 0.7 : 0;
          K.place(B3.fuse, b.x, b.y, rr * 2 + B3.h - 3);
          K.place(B3.spark, b.x, b.y, rr * 2 + B3.h + 27);
          B3.spark.scale.setScalar(8 + 4 * Math.sin(t * 30));
          const num = Math.max(1, Math.ceil(left * BOMB_TIME));
          const key = num * 2 + (hot ? 1 : 0);
          if (key !== B3.num) { B3.num = key; B3.label.redraw(num, hot); }
          K.place(B3.label, b.x, b.y, rr * 2 + B3.h + 73);
          B3.dec.at(b.x, b.y, 4.2).paint((d) => {
            d.ring(0, 0, rr + 18, 'rgba(0,0,0,0.35)', 12);
            d.arc(0, 0, rr + 18, -Math.PI / 2, -Math.PI / 2 + TAU * left, hot ? '#ff3b3b' : '#ffd36b', 10);
          });
        }
      });

      // Carts.
      let best = -1;
      for (const q of v.hud.p) best = Math.max(best, q);
      v.c.forEach((c, i) => {
        const C3 = o.cars[i];
        if (!C3) return;
        const sc = c.s || 1;
        const jump = c.f > 0 ? Math.sin(Math.PI * c.f) * 70 * sc : 0;
        K.place(C3.car, c.x, c.y, 3 + jump);
        C3.car.rotation.set(0, -c.a, c.f > 0 ? -TAU * c.f : 0);
        C3.car.scale.setScalar(sc);
        C3.roll += dt * (c.t ? 30 : 14);
        for (const wh of C3.wheels) wh.rotation.set(Math.PI / 2, 0, 0), wh.rotateY(C3.roll);
        C3.flames.forEach((f, k) => {
          f.visible = !!c.t;
          if (!f.visible) return;
          const fl = (44 + 24 * Math.sin(t * 45 + i + k)) * (1 - k * 0.25);
          const w = f.userData.w;
          f.scale.set(w, fl, w);
        });
        let mood = MOODS[c.md] || 'ok', anim = 'Sit_Floor_Idle';
        if (c.md === 1) anim = 'Cheer';
        else if (c.md === 2) anim = 'Hit_A';
        if (r.ended) { mood = v.hud.p[i] === best ? 'happy' : 'dizzy'; anim = mood === 'happy' ? 'Cheer' : 'Sit_Floor_Idle'; }
        C3.av.set(-6, 0, { r: 24, h: 28, look: 0, mood, anim, gear: false, squash: c.f > 0 ? 0.15 : 0, lean: c.t ? -0.15 : 0 });
        C3.av.blob.visible = false;
        C3.blob.visible = !K.shadows;
        K.place(C3.blob, c.x, c.y, 3.6); C3.blob.scale.set(62 * sc * (1 - jump / 200), 1, 62 * sc * (1 - jump / 200));
        // Jump-ready ring on the ground.
        const key = `${c.r}|${sc}`;
        C3.dec.at(c.x, c.y, 4);
        if (key !== C3.key) {
          C3.key = key;
          C3.dec.paint((d) => { if (c.r) d.ring(0, 0, Math.min(105, CAR_LEN * 0.62 * sc), K.col(i, 'light') + 'cc', 6); });
        }
      });
    },
  },

  render(d, v, r) {
    const { ctx } = d;
    const t = d.t, n = v.c.length;
    const gw = v.gw;
    const pads = PADS;
    ctx.fillStyle = '#6f6253';
    ctx.fillRect(-400, -400, W + 800, H + 800);
    d.rrect(L - 30, T - 30, R - L + 60, B - T + 60, CORNER + 30, '#e6cf9c', '#7a5230', 6);
    drawPitch(d, gw, n, d.col);
    drawPitchFx(d, v, pads, d.col);

    // Balls.
    const bomb = r.variant === 'bomba';
    for (const b of v.b) {
      if (!b.o) continue;
      const sp = Math.hypot(b.vx || 0, b.vy || 0);
      if (sp > 350) {
        for (let k = 4; k >= 1; k--) d.circle(b.x - b.vx * 0.012 * k, b.y - b.vy * 0.012 * k, b.r * (1 - k * 0.14), `rgba(255,255,255,${(0.2 - k * 0.04).toFixed(2)})`);
      }
      d.shadow(b.x + 10, b.y + 16, b.r, b.r * 0.8, 0.4);
      d.circle(b.x, b.y, b.r, bomb ? '#2b2b33' : '#b07a44', '#3a2412', 4);
      const rot = (b.x + b.y * 0.7) / b.r;
      for (let k = 0; k < 3; k++) {
        const a = rot + (k * Math.PI) / 3;
        d.line(b.x + Math.cos(a) * b.r * 0.9, b.y + Math.sin(a) * b.r * 0.9, b.x - Math.cos(a) * b.r * 0.9, b.y - Math.sin(a) * b.r * 0.9, bomb ? '#ff525288' : '#5a3a1a', 3);
      }
      d.circle(b.x - b.r * 0.35, b.y - b.r * 0.4, b.r * 0.22, 'rgba(255,255,255,0.35)');
      if (bomb) {
        const left = 1 - b.f, hot = b.f > 0.5;
        if (hot && Math.sin(t * (10 + b.f * 20)) > 0) d.circle(b.x, b.y, b.r, 'rgba(255,40,40,0.45)');
        d.arc(b.x, b.y, b.r + 14, -Math.PI / 2, -Math.PI / 2 + TAU * left, hot ? '#ff3b3b' : '#ffd36b', 8);
        d.text(String(Math.max(1, Math.ceil(left * BOMB_TIME))), b.x, b.y, { size: b.r * 0.9, color: hot ? '#ff5252' : '#ffffff' });
      }
    }

    // Carts.
    v.c.forEach((c, i) => {
      const sc = c.s || 1, len = CAR_LEN * sc, wid = CAR_WID * sc;
      const jump = c.f > 0 ? Math.sin(Math.PI * c.f) * 30 * sc : 0;
      d.shadow(c.x + 6, c.y + 12, len * 0.58 * (1 - jump / 120), wid * 0.72 * (1 - jump / 120), 0.4);
      ctx.save();
      ctx.translate(c.x, c.y - jump);
      ctx.rotate(c.a);
      if (c.f > 0) ctx.scale(1 + 0.15 * Math.sin(Math.PI * c.f), Math.cos(TAU * c.f) || 0.05);
      if (c.t) {
        const fl = 40 + 22 * Math.sin(t * 45 + i);
        d.poly([-len / 2, -wid * 0.32, -len / 2 - fl, 0, -len / 2, wid * 0.32], '#ff6a00');
        d.poly([-len / 2, -wid * 0.2, -len / 2 - fl * 0.65, 0, -len / 2, wid * 0.2], '#ffd54f');
      }
      for (const wx of [-0.3, 0.3]) for (const wy of [-1, 1]) d.rrect(wx * len - 14 * sc, wy * wid / 2 - 8 * sc, 28 * sc, 16 * sc, 5, '#3a2412', '#111', 2);
      d.rrect(-len / 2, -wid / 2, len, wid, 10 * sc, '#a0703f', d.col(i), 6);
      d.rect(-len / 2 + 4, -wid / 2 + 6, 14 * sc, wid - 12, '#7a4e28');
      ctx.restore();
      if (c.r) d.ring(c.x, c.y - jump, len * 0.58, d.col(i, 'light') + '66', 3);
      d.avatar(c.x, c.y - jump, 21 * sc, i, { look: c.a, mood: MOODS[c.md] || 'ok', squash: c.f > 0 ? 0.2 : 0 });
    });
  },
};

const ah = (a) => Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, '0');

function roundRectPts(x0, y0, x1, y1, rad) {
  const pts = [];
  const corners = [[x1 - rad, y0 + rad, -Math.PI / 2], [x1 - rad, y1 - rad, 0], [x0 + rad, y1 - rad, Math.PI / 2], [x0 + rad, y0 + rad, Math.PI]];
  for (const [cx, cy, a0] of corners) {
    for (let k = 0; k <= 8; k++) { const a = a0 + (Math.PI / 2) * (k / 8); pts.push(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); }
  }
  return pts;
}

// Outline of a ring sector (corner barrier): from angle a0 to a1 between radii r0 and r1.
function arcPts(cx, cy, a0, a1, r0, r1) {
  const pts = [];
  for (let k = 0; k <= 10; k++) { const a = a0 + ((a1 - a0) * k) / 10; pts.push(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); }
  for (let k = 10; k >= 0; k--) { const a = a0 + ((a1 - a0) * k) / 10; pts.push(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); }
  return pts;
}

// Sand pitch markings (chalk lines, team zones, goal areas, goal mouths).
function drawPitch(d, gw, n, col) {
  const { ctx } = d;
  ctx.save();
  roundPath(ctx, L, T, R - L, B - T, CORNER);
  ctx.clip();
  // Raked sand stripes.
  const band = (B - T) / 12;
  for (let k = 0; k < 12; k += 2) d.rect(L, T + k * band, R - L, band, 'rgba(255,240,205,0.22)');
  if (n === 2) {
    d.rect(L, MID, R - L, B - MID, col(0) + '1c');
    d.rect(L, T, R - L, MID - T, col(1) + '1c');
  } else {
    const tri = [[L, B, R, B], [L, T, R, T], [L, T, L, B], [R, T, R, B]];
    for (let k = 0; k < 4; k++) { const [x0, y0, x1, y1] = tri[k]; d.poly([CX, MID, x0, y0, x1, y1], k < n ? col(k) + '1c' : 'rgba(0,0,0,0.04)'); }
  }
  ctx.restore();
  const line = 'rgba(255,255,255,0.85)';
  if (n === 2) d.line(L, MID, R, MID, line, 6);
  else { d.line(L + 80, T + 120, R - 80, B - 120, 'rgba(255,255,255,0.45)', 5); d.line(R - 80, T + 120, L + 80, B - 120, 'rgba(255,255,255,0.45)', 5); }
  d.ring(CX, MID, 130, line, 6);
  d.circle(CX, MID, 11, line);
  // Goal areas (in front of every goal).
  for (let k = 0; k < Math.max(2, n); k++) {
    const [ux, uy] = SIDE[k], [gx, gy] = GOAL[k];
    if (uy) { d.rect(CX - 270, uy > 0 ? B - 210 : T, 540, 210, null, line, 6); d.arc(CX, gy - uy * 210, 90, uy > 0 ? Math.PI : 0, uy > 0 ? TAU : Math.PI, line, 6); }
    else { d.rect(ux < 0 ? L : R - 210, MID - 270, 210, 540, null, line, 6); d.arc(gx - ux * 210, MID, 90, ux < 0 ? -Math.PI / 2 : Math.PI / 2, ux < 0 ? Math.PI / 2 : 1.5 * Math.PI, line, 6); }
  }
  // Goal mouths (dark sand inside the nets) and goal lines.
  for (let k = 0; k < Math.max(2, n); k++) {
    const [ux, uy] = SIDE[k], [gx, gy] = GOAL[k];
    if (uy) { d.rect(CX - gw, uy > 0 ? B : T - NET, gw * 2, NET, '#b89a64'); d.line(CX - gw, gy, CX + gw, gy, col(k), 7); }
    else { d.rect(ux < 0 ? L - NET : R, MID - gw, NET, gw * 2, '#b89a64'); d.line(gx, MID - gw, gx, MID + gw, col(k), 7); }
  }
}

// Dynamic ground markings: barrel recharge arcs, goal glow, regulation clock, golden-goal ring.
function drawPitchFx(d, v, pads, col) {
  const { ctx } = d;
  ctx.save();
  roundPath(ctx, L, T, R - L, B - T, CORNER);
  ctx.clip();
  (v.gl || []).forEach((gl, i) => {
    if (gl > 0) d.circle(GOAL[i][0], GOAL[i][1], 300 + 120 * (1 - gl), col(v.gc ? v.gc[i] : 1 - i) + ah(0.4 * gl));
  });
  ctx.restore();
  (v.pd || []).forEach((k, idx) => {
    const [x, y] = pads[idx];
    if (k >= 1) return;
    d.circle(x, y, PAD_R * 0.8, 'rgba(0,0,0,0.25)', 'rgba(255,170,60,0.4)', 5);
    d.arc(x, y, PAD_R * 0.8, -Math.PI / 2, -Math.PI / 2 + TAU * k, 'rgba(255,150,40,0.95)', 7);
  });
  if (v.rt > 0) d.arc(CX, MID, 145, -Math.PI / 2, -Math.PI / 2 + TAU * v.rt, v.rt < 0.25 ? '#ff5252' : 'rgba(120,70,30,0.9)', 10);
  if (v.gd) d.ring(CX, MID, 130 + 6 * Math.sin(d.t * 8), '#ffd36b', 10);
}

// Equirectangular ball texture: brown leather pig bladder with seams and stitches (or an iron bombard ball).
function paintBallTex(ctx, w, h, bomb) {
  ctx.fillStyle = bomb ? '#2b2b33' : '#b07a44';
  ctx.fillRect(0, 0, w, h);
  // Leather mottling.
  for (let k = 0; k < 90; k++) {
    const x = (k * 53) % w, y = (k * 29) % h;
    ctx.fillStyle = bomb ? 'rgba(255,255,255,0.05)' : k % 2 ? 'rgba(80,45,20,0.18)' : 'rgba(255,220,170,0.12)';
    ctx.beginPath(); ctx.arc(x, y, 4 + (k % 5) * 3, 0, TAU); ctx.fill();
  }
  ctx.strokeStyle = bomb ? '#ff4040' : '#4a2c12';
  ctx.lineWidth = bomb ? 8 : 4;
  for (let k = 0; k < 6; k++) {
    const x = (k / 6) * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    if (!bomb) for (let y = 6; y < h; y += 10) { ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y + 3); ctx.stroke(); }
  }
  if (bomb) { ctx.fillStyle = '#ff4040'; ctx.fillRect(0, h * 0.46, w, h * 0.08); }
}

function roundPath(ctx, x, y, w, h, rad) {
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
