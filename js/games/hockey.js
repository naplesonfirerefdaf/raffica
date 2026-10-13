// Pecorino sul Ghiaccio — air hockey on a frozen lake (top-down, dir + A smash + B shield).
// Seat 0 defends the bottom goal, 1 the top goal, 2 the left goal, 3 the right goal (3–4 players: X-shaped zones).
import { clamp, damp, norm, collideCircles, r1, r2, TAU } from '../core/geom.js';

// Extra margin above/below the rink: on the shared phone the HUD bars sit over the two short ends.
const W = 1000, H = 1680, CX = 500, MID = 840;
const L = 40, R = 960, T = 140, B = 1540, CORNER = 110;
const PUCK_R = 36, MALLET_R = 58;
const MALLET_MAX = 1100, MALLET_ACC = 9000;
const SMASH_SPEED = 2100, SMASH_TIME = 0.13, SMASH_CD = 1.0, SMASH_BONUS = 950;
const PUCK_MAX = 1900, PUCK_MAX_SMASH = 2700, PUCK_KEEP = 0.82;
const GOAL_HALF = 140, GOAL_MAX = 330, GOAL_GROW = 70, GOAL_DEPTH = 60;
const SUBSTEPS = 4, SERVE_DELAY = 1.1;
// B = SCUDO: the shield swells into a big soft bubble for a moment (slow, but covers the goal).
const SHIELD_T = 0.5, SHIELD_CD = 1.6, SHIELD_R = 96, SHIELD_SLOW = 0.35;
// A clean parry of a fast puck arms a SUPER BORDATA for a short window.
const PARRY_MIN = 650, SUPER_WIN = 2.2, SUPER_BONUS = 1500, PUCK_MAX_SUPER = 3300;
const BAND = 250, FOG_R = 300; // fantasma: hidden band (2 players) / hidden disc around the center (3–4)
const MOODS = ['ok', 'happy', 'dizzy', 'angry'];
// Seat sides (unit vector from the center toward the seat's goal) and goal mouths.
const SIDE = [[0, 1], [0, -1], [-1, 0], [1, 0]];
const GOAL = [[CX, B], [CX, T], [L, MID], [R, MID]];
// X-shaped zones (3–4 players): the rink diagonals split it into four wedges, one per goal.
const DG = Math.hypot(R - L, B - T), DX = (R - L) / DG, DY = (B - T) / DG;
const DIAG = [[-DY, DX], [DY, DX]]; // unit normals of the two diagonals
const ZN = SIDE.map(([ux, uy]) => DIAG.map(([nx, ny]) => (nx * ux + ny * uy > 0 ? [nx, ny] : [-nx, -ny])));
const BANNER = ['red', 'blue', 'green', 'yellow']; // flag model colors by slot color

function zoneOf(x, y) {
  const u = (x - CX) / (R - CX), w = (y - MID) / (B - MID);
  if (Math.abs(w) >= Math.abs(u)) return w > 0 ? 0 : 1;
  return u < 0 ? 2 : 3;
}

// Reflect the outward component of velocity along outward normal n. Returns impact speed.
function reflect(o, nx, ny, e) {
  const vn = o.vx * nx + o.vy * ny;
  if (vn <= 0) return 0;
  o.vx -= (1 + e) * vn * nx; o.vy -= (1 + e) * vn * ny;
  return vn;
}

// Keep a circle inside the rounded rink. gw = goal half-widths per seat (open mouths) or null.
function confine(o, e, gw) {
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
  const openX = (half) => gw && half > 0 && Math.abs(o.x - CX) < half;
  const openY = (half) => gw && half > 0 && Math.abs(o.y - MID) < half;
  if (o.x < L + r && !openY(gw?.[2])) { o.x = L + r; hit = Math.max(hit, reflect(o, -1, 0, e)); }
  else if (o.x > R - r && !openY(gw?.[3])) { o.x = R - r; hit = Math.max(hit, reflect(o, 1, 0, e)); }
  if (o.y < T + r && !openX(gw?.[1])) { o.y = T + r; hit = Math.max(hit, reflect(o, 0, -1, e)); }
  else if (o.y > B - r && !openX(gw?.[0])) { o.y = B - r; hit = Math.max(hit, reflect(o, 0, 1, e)); }
  return hit;
}

// Circle vs fixed point (goal post).
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

// Shields stay one puck-width off the zone borders, so a puck can never be jammed between two of them.
function clampHalf(m, n) {
  const reach = m.r + PUCK_R + 14;
  if (n === 2) {
    if (m.i === 0) m.y = Math.max(m.y, MID + reach);
    else m.y = Math.min(m.y, MID - reach);
    return;
  }
  for (let it = 0; it < 3; it++) {
    for (const [nx, ny] of ZN[m.i]) {
      const dd = (m.x - CX) * nx + (m.y - MID) * ny;
      if (dd < reach) { m.x += (reach - dd) * nx; m.y += (reach - dd) * ny; }
    }
  }
}

function newPuck(x, y) {
  return { x, y, vx: 0, vy: 0, r: PUCK_R, m: 1, out: 0, serveTo: 0, sndCd: 0, fire: 0 };
}

function serve(s, p, g) {
  const k = p.serveTo, m = s.m[k], [ux, uy] = SIDE[k];
  p.x = CX + ux * 260; p.y = MID + uy * 260;
  if (Math.hypot(m.x - p.x, m.y - p.y) < MALLET_R + PUCK_R + 30) {
    if (uy !== 0) p.x = m.x < CX ? CX + 190 : CX - 190;
    else p.y = m.y < MID ? MID + 190 : MID - 190;
  }
  p.vx = 0; p.vy = 0; p.out = 0; p.fire = 0;
  g.sfx('pop'); g.ring(p.x, p.y, { color: '#ffe14d', r: 90 });
}

// The cheese went into the goal of `loser`. 2 players: the other one scores; 3–4: whoever touched it last
// (an own goal gives nobody a point).
function scoreGoal(s, g, p, loser) {
  const scorer = s.n === 2 ? 1 - loser : s.last >= 0 && s.last !== loser ? s.last : -1;
  if (scorer >= 0) s.score[scorer]++;
  s.conc[loser]++;
  s.gl[loser] = 1; s.gc[loser] = scorer >= 0 ? scorer : loser;
  p.out = SERVE_DELAY; p.serveTo = loser;
  p.vx = 0; p.vy = 0;
  const [ux, uy] = SIDE[loser], [gx, gy] = GOAL[loser];
  p.x = ux ? gx + ux * GOAL_DEPTH * 0.45 : p.x;
  p.y = uy ? gy + uy * GOAL_DEPTH * 0.45 : p.y;
  const fxo = scorer >= 0 ? { player: scorer } : { color: '#ffffff' };
  g.sfx('goal'); g.sfx('horn', { vol: 0.5 });
  g.burst(ux ? gx : p.x, uy ? gy : p.y, { ...fxo, n: 40, speed: 520, size: 10 });
  g.ring(ux ? gx : p.x, uy ? gy : p.y, { ...fxo, r: 260 });
  g.confetti(gx, gy);
  g.shake(0.6); g.flash('#ffffff', 0.3);
  g.slowmo(0.3, 0.3);
  g.vibrate(loser, 250);
  if (scorer >= 0) { g.vibrate(scorer, 80); s.m[scorer].joy = 1.6; }
  s.m[loser].sad = 1.6;
  // Comeback: whoever conceded gets both moves ready again.
  s.m[loser].cd = 0; s.m[loser].scd = 0;
  p.fire = 0;
  if (scorer >= 0 && s.score[scorer] >= s.target) { g.end(scorer, 'Pecorino in porta!'); return; }
  g.say(scorer >= 0 ? 'GOL!' : 'AUTOGOL!');
  if (g.variant === 'golosa' && scorer >= 0 && s.goalT[scorer] < GOAL_MAX) {
    s.goalT[scorer] = Math.min(GOAL_MAX, s.goalT[scorer] + GOAL_GROW);
    g.sfx('grow');
    const [sx, sy] = SIDE[scorer], [hx, hy] = GOAL[scorer];
    g.text(hx - sx * 120, hy - sy * 120, 'PORTA PIÙ LARGA!', { player: scorer, size: 46 });
  }
}

// Kinematic shield vs puck: impact depends on shield speed; smash adds a huge kick.
function hitPuck(s, g, p, m) {
  const dx = p.x - m.x, dy = p.y - m.y, d = Math.hypot(dx, dy), min = p.r + m.r;
  if (d >= min) return;
  const nx = d > 0 ? dx / d : -SIDE[m.i][0], ny = d > 0 ? dy / d : -SIDE[m.i][1];
  p.x = m.x + nx * min; p.y = m.y + ny * min;
  const rv = (p.vx - m.ex) * nx + (p.vy - m.ey) * ny;
  if (rv >= 0) return;
  s.last = m.i;
  if (m.shield > 0) {
    // Soft bubble: absorbs most of the energy; a fast shot parried arms the SUPER BORDATA.
    const incoming = -(p.vx * nx + p.vy * ny); // the puck's own speed into the shield (not the mallet's)
    p.vx -= 1.45 * rv * nx; p.vy -= 1.45 * rv * ny;
    if (incoming > PARRY_MIN && m.super <= 0 && m.parryCd <= 0) {
      m.super = SUPER_WIN; m.cd = 0; m.parryCd = 0.5;
      g.text(m.x - SIDE[m.i][0] * 150, m.y - SIDE[m.i][1] * 150, 'PARATA!', { player: m.i, size: 54 });
      g.sfx('freeze', { pitch: 1.3 }); g.sfx('powerup', { vol: 0.7 });
      g.ring(m.x, m.y, { player: m.i, r: SHIELD_R + 60 });
      g.hitstop(0.06); g.vibrate(m.i, 90);
    } else if (-rv > 150) g.sfx('boing', { vol: 0.6, pitch: 1.3 });
    p.fire = 0;
    capSpeed(p, PUCK_MAX);
    return;
  }
  p.vx -= 1.9 * rv * nx; p.vy -= 1.9 * rv * ny;
  if (m.smash > 0 && !m.smashHit) {
    m.smashHit = true;
    const sup = m.smashSuper;
    p.vx += nx * (sup ? SUPER_BONUS : SMASH_BONUS); p.vy += ny * (sup ? SUPER_BONUS : SMASH_BONUS);
    capSpeed(p, sup ? PUCK_MAX_SUPER : PUCK_MAX_SMASH);
    if (sup) {
      p.fire = 1.6;
      g.say('SUPER BORDATA! 🔥');
      g.sfx('fire'); g.sfx('bigexplode', { vol: 0.6, pitch: 1.3 });
      g.flash('#ffb347', 0.3); g.slowmo(0.4, 0.2);
    }
    g.sfx('bang'); g.sfx('hit', { pitch: 0.7 });
    g.burst(p.x, p.y, { player: m.i, n: sup ? 40 : 22, speed: sup ? 800 : 520 });
    g.ring(p.x, p.y, { player: m.i, r: sup ? 180 : 110 });
    g.shake(sup ? 0.7 : 0.45); g.hitstop(sup ? 0.09 : 0.05); g.vibrate(m.i, 70);
    return;
  }
  p.fire = 0;
  capSpeed(p, PUCK_MAX);
  if (-rv > 120 && m.sndCd <= 0) {
    m.sndCd = 0.08;
    const hard = -rv > 900;
    g.sfx('hit', { vol: clamp(-rv / 1200, 0.3, 1), pitch: hard ? 0.9 : 1.2 });
    if (hard) { g.burst(p.x, p.y, { color: '#ffe14d', n: 10, speed: 300 }); g.shake(0.15); }
  }
}

// Winner at time-out: more goals, else whoever does NOT have the puck(s) in their own half/zone.
function decide(s, g) {
  if (s.n === 2) {
    if (s.score[0] !== s.score[1]) return s.score[0] > s.score[1] ? 0 : 1;
    let cnt = 0, lean = 0;
    for (const p of s.pucks) {
      const y = p.out > 0 ? (p.serveTo === 0 ? MID + 1 : MID - 1) : p.y;
      cnt += Math.sign(y - MID); lean += y - MID;
    }
    g.say('PECORINO NELLA METÀ SBAGLIATA!');
    if (cnt !== 0) return cnt > 0 ? 1 : 0;
    if (lean !== 0) return lean > 0 ? 1 : 0;
    return s.last >= 0 ? s.last : g.rng() < 0.5 ? 0 : 1;
  }
  const seats = [...Array(s.n).keys()];
  const keepMin = (list, f) => { const m = Math.min(...list.map(f)); return list.filter((k) => f(k) === m); };
  let c = keepMin(seats, (k) => -s.score[k]);
  if (c.length > 1) c = keepMin(c, (k) => s.conc[k]);
  if (c.length > 1) {
    const inZone = s.m.map(() => 0);
    for (const p of s.pucks) inZone[p.out > 0 ? p.serveTo : zoneOf(p.x, p.y)]++;
    const c2 = keepMin(c, (k) => inZone[k]);
    if (c2.length < c.length) g.say('PECORINO NELLA ZONA SBAGLIATA!');
    c = c2;
  }
  if (c.length > 1 && c.includes(s.last)) return s.last;
  return c.length > 1 ? c[g.rng.int(0, c.length - 1)] : c[0];
}

// Visibility of a puck in the fog (fantasma).
function fogAlpha(p, n) {
  if (n === 2) {
    const center = clamp((Math.abs(p.y - MID) - BAND + 60) / 60, 0, 1);
    const side = clamp(1 - (Math.min(p.x - L, R - p.x) - PUCK_R) / 90, 0, 1) * 0.55;
    return Math.max(center, side);
  }
  return clamp((Math.hypot(p.x - CX, p.y - MID) - FOG_R + 60) / 60, 0, 1);
}

// ---- Computer player ----
const BOT_DELAY = [0.34, 0.2, 0.09]; // reaction delay of the bot driver per level (core/bots.js)

// Where a puck will be after t seconds (straight line with damping, folded on the side boards).
function puckAt(p, t, n) {
  const k = (1 - Math.pow(PUCK_KEEP, t)) / -Math.log(PUCK_KEEP); // ∫ keep^τ dτ
  let x = p.x + p.vx * k, y = p.y + p.vy * k;
  const fold = (v, lo, hi) => {
    const w = hi - lo;
    let u = (v - lo) % (2 * w);
    if (u < 0) u += 2 * w;
    return lo + (u > w ? 2 * w - u : u);
  };
  if (n < 3) x = fold(x, L + PUCK_R, R - PUCK_R);
  else { x = clamp(x, L + PUCK_R, R - PUCK_R); }
  y = clamp(y, T + PUCK_R - 40, B - PUCK_R + 40);
  return { x, y };
}

function inZone(me, n, x, y) {
  return n === 2 ? (me === 0 ? y > MID : y < MID) : zoneOf(x, y) === me;
}

// Mallet steering: the shield follows the stick velocity almost at once, so steer by position
// (looking ahead by the reaction delay so slow bots do not overshoot).
function hockeySteer(m, gx, gy, lag, slow = 1) {
  const T0 = Math.max(0.1, lag * 1.1);
  let vx = (gx - m.x - m.vx * lag) / T0, vy = (gy - m.y - m.vy * lag) / T0;
  const v = Math.hypot(vx, vy), max = MALLET_MAX * slow;
  if (v > max) { vx *= max / v; vy *= max / v; }
  return { x: vx / MALLET_MAX, y: vy / MALLET_MAX };
}

// Best aim point for a shot from (px, py) at goal k: across the mouth, direct or banked off a side board,
// avoiding the goal owner's shield.
const AIM_OFF = [0, -0.45, 0.45, -0.8, 0.8];
function shotAim(s, k, px, py, bank) {
  const [gx, gy] = GOAL[k], [, uy] = SIDE[k], w = s.gw[k] - PUCK_R;
  const gm = s.m[k];
  let best = null, bc = Infinity;
  for (let b = 0; b < (bank ? 3 : 1); b++) {
    for (const f of AIM_OFF) {
      let x, y;
      if (uy) { x = gx + f * w; y = gy; if (b === 1) x = 2 * (L + PUCK_R) - x; else if (b === 2) x = 2 * (R - PUCK_R) - x; }
      else { x = gx; y = gy + f * w; if (b === 1) y = 2 * (T + PUCK_R) - y; else if (b === 2) y = 2 * (B - PUCK_R) - y; }
      const dx = x - px, dy = y - py, d = Math.hypot(dx, dy) || 1;
      let c = d * (b ? 1.3 : 1) + Math.abs(f) * 60;
      if (gm) {
        // Where the goal owner's shield sits relative to the (unfolded) shot line.
        let mx = gm.x, my = gm.y;
        if (b === 1) { if (uy) mx = 2 * (L + PUCK_R) - mx; else my = 2 * (T + PUCK_R) - my; }
        else if (b === 2) { if (uy) mx = 2 * (R - PUCK_R) - mx; else my = 2 * (B - PUCK_R) - my; }
        const tt = clamp(((mx - px) * dx + (my - py) * dy) / (d * d), 0, 1);
        const off = Math.hypot(mx - (px + dx * tt), my - (py + dy * tt));
        // The real shield too (a bank shot also passes the near side unfolded).
        const tt2 = clamp(((gm.x - px) * dx + (gm.y - py) * dy) / (d * d), 0, 1);
        const off2 = b ? Math.hypot(gm.x - (px + dx * tt2), gm.y - (py + dy * tt2)) : 1e9;
        const clear = gm.r + PUCK_R + 25;
        const o = Math.min(off, off2);
        if (o < clear) c += 1500 * (1 - o / clear) + 300;
      }
      if (c < bc) { bc = c; best = { x, y }; }
    }
  }
  return best;
}

function hockeyBot(s, me, g, B) {
  const m = s.m[me];
  if (!m) return { x: 0, y: 0 };
  const n = s.n, lv = B.level, delay = BOT_DELAY[lv], lag = delay + 0.03;
  const [ux, uy] = SIDE[me], [gx, gy] = GOAL[me];
  const home = { x: gx - ux * 190, y: gy - uy * 190 };
  if (n === 2) home.x = CX;
  const live = s.pucks.filter((p) => p.out <= 0);
  if (!live.length) { const st = hockeySteer(m, home.x, home.y, lag); return st; }

  // Choose the puck that matters most: one flying at my goal, else the closest one in my zone.
  let pk = null, best = -Infinity, threat = false, tArr = 9;
  for (const p of live) {
    const along = (gx - p.x) * ux + (gy - p.y) * uy; // distance in front of my goal line
    const va = p.vx * ux + p.vy * uy;                 // speed toward my goal line
    const ta = va > 40 ? along / va : 9;
    const mine = inZone(me, n, p.x, p.y);
    let sc = -Math.hypot(p.x - m.x, p.y - m.y) * 0.002;
    if (ta < 1.6) {
      const hit = puckAt(p, ta, n);
      const lat = uy ? Math.abs(hit.x - gx) : Math.abs(hit.y - gy);
      if (lat < s.gw[me] + 120 || n >= 3) sc += 4 / (ta + 0.2);
    }
    if (mine) sc += 2;
    if (sc > best) { best = sc; pk = p; threat = ta < 1.6; tArr = ta; }
  }
  const lead = lv === 0 ? 0.1 : delay + 0.05; // the easy bot reacts to where the puck is, not where it goes
  const P = puckAt(pk, lead, n);
  const mineNow = inZone(me, n, P.x, P.y);
  const rs = m.r + PUCK_R;
  const dP = Math.hypot(P.x - m.x, P.y - m.y);
  const pSpeed = Math.hypot(pk.vx, pk.vy);

  // Shield: a fast puck about to hit me (or my goal) right after my reaction time.
  if (lv > 0 && m.scd <= 0 && m.smash <= 0 && pSpeed > 650) {
    const dx = m.x - pk.x, dy = m.y - pk.y, d = Math.hypot(dx, dy) || 1;
    const closing = (pk.vx * dx + pk.vy * dy) / d;
    if (closing > 500) {
      const tHit = (d - rs - 20) / closing;
      // Will it actually pass near me?
      const perp = Math.abs(pk.vx * dy - pk.vy * dx) / (pSpeed * d) * d;
      if (perp < SHIELD_R + PUCK_R && tHit > delay - 0.05 && tHit < delay + 0.22 && (lv > 0)) {
        return { x: 0, y: 0, b: true };
      }
    }
  }

  // Defend: puck flying at my goal and I'm not already behind it → block the line puck–goal.
  const aimGoal = (() => {
    if (n === 2) return 1 - me;
    // 3–4 players: the most open rival goal from here.
    let bk = -1, bc = Infinity;
    for (let k = 0; k < n; k++) {
      if (k === me) continue;
      const a = shotAim(s, k, P.x, P.y, lv > 0);
      const c = Math.hypot(a.x - P.x, a.y - P.y) + (lv === 0 ? 0 : s.score[k] * -30);
      if (c < bc) { bc = c; bk = k; }
    }
    return bk;
  })();
  const aim = shotAim(s, aimGoal, P.x, P.y, lv > 0);
  let ax = aim.x - P.x, ay = aim.y - P.y;
  { const l = Math.hypot(ax, ay) || 1; ax /= l; ay /= l; }
  // Am I behind the puck (between it and my goal side) on the shooting line?
  const relx = m.x - P.x, rely = m.y - P.y;
  const back = -(relx * ax + rely * ay);            // >0: I'm behind the puck
  const side = relx * -ay + rely * ax;              // lateral offset from the shooting line

  if (threat && tArr < 1.2 && !(back > 0 && Math.abs(side) < rs * 0.6 && dP < 200)) {
    // Intercept on the puck path at a point I can reach, else stand on the goal line of fire.
    let tx = null, ty = null;
    for (let t = 0.1; lv > 0 && t <= Math.min(tArr, 1.2); t += 0.1) {
      const q = puckAt(pk, t, n);
      if (!inZone(me, n, q.x, q.y)) continue;
      const reach = Math.hypot(q.x - m.x, q.y - m.y) / MALLET_MAX + delay + 0.05;
      if (reach < t) { tx = q.x; ty = q.y; break; }
    }
    if (tx === null) {
      const hit = puckAt(pk, Math.max(0, tArr - 0.05), n);
      const dx = hit.x - gx, dy = hit.y - gy, d = Math.hypot(dx, dy) || 1;
      const k = Math.min(110, d * 0.6);
      tx = gx + (dx / d) * k; ty = gy + (dy / d) * k;
      if (uy) ty = gy - uy * Math.max(70, Math.abs(ty - gy)); else tx = gx - ux * Math.max(70, Math.abs(tx - gx));
    }
    // Step in from the goal side so the touch sends the puck away.
    tx -= ux * 10; ty -= uy * 10;
    const st = hockeySteer(m, tx, ty, lag);
    // Smash a dangerous puck away if it is right in front of me.
    const smash = m.cd <= 0 && dP < rs + 70 && back > 0 && (lv > 0 || B.rng() < 0.3);
    return { x: st.x, y: st.y, tapA: smash };
  }

  if (!mineNow) {
    // Puck in a rival zone: wait in front of my goal, following it (a bit forward when it is far).
    const dx = P.x - gx, dy = P.y - gy, d = Math.hypot(dx, dy) || 1;
    const k = lv === 0 ? clamp(d * 0.28, 150, 300) : clamp(d * 0.2, 120, 230);
    let tx = gx + (dx / d) * k, ty = gy + (dy / d) * k;
    if (uy) ty = gy - uy * Math.max(150, Math.abs(ty - gy)); else tx = gx - ux * Math.max(150, Math.abs(tx - gx));
    return hockeySteer(m, tx, ty, lag);
  }

  // Attack: get behind the puck on the shooting line, then drive through it (or smash).
  const lined = back > 0 && Math.abs(side) < rs * (lv === 2 ? 0.35 : 0.5);
  const cosA = back / (Math.hypot(relx, rely) || 1);
  if (m.cd <= 0 && dP < 300 && dP > rs * 0.8 && cosA > [0.8, 0.975, 0.985][lv]) {
    // Smash goes straight at the puck: only when the puck sits on the line toward the goal.
    return { x: ax, y: ay, tapA: true };
  }
  let tx, ty, slow = 1;
  if (lined) {
    tx = P.x + ax * 120; ty = P.y + ay * 120;
  } else {
    // Spot behind the puck; if I'm on the wrong side, go around it.
    const off = rs + 30;
    tx = P.x - ax * off; ty = P.y - ay * off;
    if (back < rs * 0.6) {
      const sg = side >= 0 ? 1 : -1;
      tx = P.x - ax * off * 0.5 + -ay * sg * (rs + 45);
      ty = P.y - ay * off * 0.5 + ax * sg * (rs + 45);
    }
    tx = clamp(tx, L + m.r, R - m.r); ty = clamp(ty, T + m.r, B - m.r);
    if (Math.hypot(tx - m.x, ty - m.y) < 120) slow = 0.6;
  }
  const st = hockeySteer(m, tx, ty, lag, slow);
  return st;
}

export default {
  id: 'hockey',
  name: 'Pecorino sul Ghiaccio',
  rule: 'Tira il pecorino nella porta di un rivale! Primo a 3.',
  verb: 'TIRA!',
  inspired: 'Clubhouse Games 51 · Air Hockey',
  cam: 'top',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Bordata', b: 'Scudo' },
  help: {
    goal: 'Fai scivolare la forma di pecorino nella porta di un avversario. Primo a 3 gol (5 con Tre Forme).',
    dir: 'Muovi il tuo scudo-slitta nella tua zona del lago (non puoi entrare in quella degli altri).',
    a: 'BORDATA: scatto fulmineo verso il pecorino più vicino che lo spara fortissimo (si ricarica in 1 s).',
    b: 'SCUDO: diventi una bolla enorme per mezzo secondo (ti muovi piano). Pari un tiro forte = SUPER BORDATA pronta per 2 s!',
    tips: ['Scudo al momento giusto, poi subito A: il contropiede infuocato è quasi imparabile', 'Dopo un gol subito, Bordata e Scudo tornano subito carichi', 'In 3–4 il gol vale per chi ha toccato per ultimo il pecorino'],
  },
  duration: 45,
  variants: [
    { id: 'multidisco', name: 'Tre Forme', desc: 'Tre forme di pecorino sul ghiaccio insieme! Primo a 5.' },
    { id: 'golosa', name: 'Porta Ingorda', desc: 'Ogni gol che segni allarga la TUA porta!' },
    { id: 'fantasma', name: 'Nebbia sul Lago', desc: 'A centro lago il pecorino sparisce nella nebbia!' },
  ],

  init(g) {
    const n = g.n || 2;
    const multi = g.variant === 'multidisco';
    const seats = [...Array(n).keys()];
    const s = {
      n, score: seats.map(() => 0), conc: seats.map(() => 0), target: multi ? 5 : 3, last: -1, warned: false,
      // Slow-motion mod: shorter internal clock so the round still ends in reasonable real time.
      limit: g.mods.moviola ? 26 : 45,
      gw: seats.map(() => GOAL_HALF), goalT: seats.map(() => GOAL_HALF), gl: seats.map(() => 0), gc: seats.slice(),
      m: seats.map((i) => {
        const [ux, uy] = SIDE[i];
        return {
          i, x: ux ? (ux < 0 ? L + 170 : R - 170) : CX, y: uy ? (uy > 0 ? B - 200 : T + 200) : MID, vx: 0, vy: 0, ex: 0, ey: 0, r: MALLET_R,
          smash: 0, smashHit: false, smashSuper: false, sn: 0, cd: 0.3, sndCd: 0, joy: 0, sad: 0,
          shield: 0, scd: 0.3, super: 0, parryCd: 0,
        };
      }),
      pucks: !multi ? [newPuck(CX, MID)]
        : n === 2 ? [newPuck(CX, MID), newPuck(CX - 260, MID), newPuck(CX + 260, MID)]
          : [newPuck(CX, MID), newPuck(CX - DX * 240, MID - DY * 240), newPuck(CX + DX * 240, MID + DY * 240)],
    };
    // Face-off: the puck drifts toward a random goal.
    for (const p of s.pucks) {
      if (n === 2) p.vy = g.rng.chance(0.5) ? 170 : -170;
      else { const [ux, uy] = SIDE[g.rng.int(0, n - 1)]; p.vx = ux * 170; p.vy = uy * 170; }
    }
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt, n = s.n;
    for (let k = 0; k < n; k++) { s.gw[k] += (s.goalT[k] - s.gw[k]) * Math.min(1, dt * 5); s.gl[k] = Math.max(0, s.gl[k] - dt * 0.8); }
    if (!s.warned && g.t >= s.limit - 10) { s.warned = true; g.say('ULTIMI 10 SECONDI!'); g.sfx('matchpoint'); }

    // Shields: fast, snappy acceleration toward the stick velocity.
    for (const m of s.m) {
      const i = inp[m.i];
      m.cd = Math.max(0, m.cd - dt); m.sndCd = Math.max(0, m.sndCd - dt);
      m.joy = Math.max(0, m.joy - dt); m.sad = Math.max(0, m.sad - dt);
      m.scd = Math.max(0, m.scd - dt); m.parryCd = Math.max(0, m.parryCd - dt);
      if (m.super > 0) { m.super -= dt; if (m.super <= 0) m.super = 0; }
      if (m.shield > 0) m.shield = Math.max(0, m.shield - dt);
      // Bubble radius eases in/out so it never teleports into the puck.
      const tr = m.shield > 0 ? SHIELD_R : MALLET_R;
      m.r += (tr - m.r) * Math.min(1, dt * 22);
      if (Math.abs(m.r - tr) < 0.5) m.r = tr;
      if (i.bP && m.scd <= 0 && m.smash <= 0) {
        m.shield = SHIELD_T; m.scd = SHIELD_CD + SHIELD_T;
        g.sfx('freeze', { vol: 0.6 }); g.ring(m.x, m.y, { player: m.i, r: SHIELD_R + 20 });
      }
      const vmax = MALLET_MAX * (m.shield > 0 ? SHIELD_SLOW : 1);
      if (m.smash > 0) {
        m.smash -= dt;
        if (m.smash <= 0) capSpeed(m, MALLET_MAX);
      } else {
        const tx = i.x * vmax, ty = i.y * vmax;
        const dvx = tx - m.vx, dvy = ty - m.vy, dl = Math.hypot(dvx, dvy), st = MALLET_ACC * dt;
        if (dl <= st) { m.vx = tx; m.vy = ty; } else { m.vx += (dvx / dl) * st; m.vy += (dvy / dl) * st; }
      }
      if (i.aP && m.cd <= 0 && m.shield <= 0) {
        // Smash: short lunge toward the nearest puck in reach, else straight ahead (toward the center).
        let dir = { x: -SIDE[m.i][0], y: -SIDE[m.i][1] }, best = 430;
        for (const p of s.pucks) {
          if (p.out > 0) continue;
          const dd = Math.hypot(p.x - m.x, p.y - m.y);
          if (dd < best) { best = dd; dir = norm(p.x - m.x, p.y - m.y); }
        }
        m.vx = dir.x * SMASH_SPEED; m.vy = dir.y * SMASH_SPEED;
        m.smash = SMASH_TIME; m.cd = SMASH_CD; m.smashHit = false; m.sn++;
        m.smashSuper = m.super > 0; m.super = 0;
        g.sfx('whoosh', { pitch: 1.3 }); g.sfx('dash', { vol: 0.6 });
        g.burst(m.x, m.y, { player: m.i, n: 8, speed: 220 });
      }
    }

    // Physics in substeps (fast puck, no tunneling).
    const h = dt / SUBSTEPS;
    const live = s.pucks.filter((p) => p.out <= 0);
    for (let k = 0; k < SUBSTEPS; k++) {
      for (const m of s.m) {
        const ox = m.x, oy = m.y;
        m.x += m.vx * h; m.y += m.vy * h;
        confine(m, 0, null); clampHalf(m, n);
        m.ex = (m.x - ox) / h; m.ey = (m.y - oy) / h;
      }
      for (const p of live) { if (p.out <= 0) { p.x += p.vx * h; p.y += p.vy * h; } }
      for (const p of live) if (p.out <= 0) for (const m of s.m) hitPuck(s, g, p, m);
      for (let a = 0; a < live.length; a++) {
        for (let b = a + 1; b < live.length; b++) {
          if (live[a].out > 0 || live[b].out > 0) continue;
          const imp = collideCircles(live[a], live[b], 0.95);
          if (imp > 300 && live[a].sndCd <= 0) { live[a].sndCd = 0.08; g.sfx('hit', { pitch: 1.6, vol: 0.5 }); }
        }
      }
      for (const p of live) {
        if (p.out > 0) continue;
        let hit = confine(p, 0.9, s.gw);
        for (let k2 = 0; k2 < n; k2++) {
          const [gx, gy] = GOAL[k2], w = s.gw[k2];
          if (SIDE[k2][1]) hit = Math.max(hit, post(p, gx - w, gy, 0.8), post(p, gx + w, gy, 0.8));
          else hit = Math.max(hit, post(p, gx, gy - w, 0.8), post(p, gx, gy + w, 0.8));
        }
        if (hit > 200 && p.sndCd <= 0) {
          p.sndCd = 0.07;
          g.sfx('tick', { vol: clamp(hit / 1400, 0.25, 0.9), pitch: 1.4 });
          if (g.variant === 'fantasma' && n === 2 && Math.abs(p.y - MID) < BAND) g.ring(p.x, p.y, { color: '#ffe14d', r: 60 });
        }
        // A puck pinned against the boards pushes the shield away instead of overlapping.
        for (const m of s.m) {
          const dx = m.x - p.x, dy = m.y - p.y, d = Math.hypot(dx, dy), min = m.r + p.r;
          if (d < min && d > 0) { m.x += (dx / d) * (min - d); m.y += (dy / d) * (min - d); clampHalf(m, n); }
        }
        if (!g.ended) {
          if (p.y < T) scoreGoal(s, g, p, 1);
          else if (p.y > B) scoreGoal(s, g, p, 0);
          else if (n >= 3 && p.x < L) scoreGoal(s, g, p, 2);
          else if (n >= 4 && p.x > R) scoreGoal(s, g, p, 3);
        } else if (p.y < T - 20 || p.y > B + 20 || p.x < L - 20 || p.x > R + 20) {
          p.vx = 0; p.vy = 0; p.y = clamp(p.y, T - 30, B + 30); p.x = clamp(p.x, L - 30, R + 30);
        }
      }
    }

    for (const p of s.pucks) {
      p.sndCd = Math.max(0, p.sndCd - dt);
      if (p.out > 0) {
        p.out -= dt;
        if (p.out <= 0 && !g.ended) serve(s, p, g);
        else if (p.out <= 0) p.out = 0.01;
        continue;
      }
      const kf = damp(PUCK_KEEP, dt);
      p.vx *= kf; p.vy *= kf;
      p.fire = Math.max(0, p.fire - dt);
      if (n === 2) {
        // Dead zone: a slow puck never rests on the centre line (nobody could reach it).
        const off = p.y - MID;
        if (Math.abs(off) < PUCK_R + 8 && Math.abs(p.vy) < 120) p.vy += (off >= 0 ? 1 : -1) * 600 * dt;
      } else {
        // Same on the two diagonals; with 3 players the empty right wedge slides the puck back to the middle.
        for (const [nx, ny] of DIAG) {
          const off = (p.x - CX) * nx + (p.y - MID) * ny;
          if (Math.abs(off) < PUCK_R + 8 && Math.abs(p.vx * nx + p.vy * ny) < 120) {
            const sg = off >= 0 ? 1 : -1;
            p.vx += sg * nx * 600 * dt; p.vy += sg * ny * 600 * dt;
          }
        }
        if (n === 3 && zoneOf(p.x, p.y) === 3 && Math.hypot(p.vx, p.vy) < 320) p.vx -= 520 * dt;
      }
      capSpeed(p, p.fire > 0 ? PUCK_MAX_SUPER : PUCK_MAX_SMASH);
    }
    if (!g.ended && g.t >= s.limit) { g.end(decide(s, g), 'Tempo scaduto!'); g.sfx('timeup'); }
  },

  timeout(s, g) {
    return decide(s, g);
  },

  bot: hockeyBot,

  view(s) {
    return {
      m: s.m.map((m) => ({
        x: r1(m.x), y: r1(m.y), r: r1(m.r), s: m.smash > 0 ? 1 : 0, k: m.sn % 8, c: r2(m.cd), sc: r2(m.scd),
        sh: m.shield > 0 ? 1 : 0, sp: m.super > 0 ? 1 : 0,
        md: m.smash > 0 ? 3 : m.sad > 0 ? 2 : m.joy > 0 ? 1 : 0,
      })),
      k: s.pucks.map((p) => ({ x: r1(p.x), y: r1(p.y), vx: r1(p.vx), vy: r1(p.vy), o: p.out > 0 ? 1 : 0, f: p.fire > 0 ? 1 : 0 })),
      gl: s.gl.map(r2),
      gc: s.gc.slice(),
      gw: s.gw.map(r1),
      hud: { p: s.score.slice(), max: s.target, label: 'Gol' },
    };
  },

  focus(v) {
    return v.m.map((m) => ({ x: m.x, y: m.y }));
  },

  render3d: {
    assets: [
      'medieval/building_church_blue', 'medieval/building_tower_A_blue', 'medieval/building_tower_B_blue', 'medieval/wall_straight',
      'medieval/building_home_A_blue', 'medieval/building_home_B_yellow', 'medieval/building_market_yellow', 'medieval/building_windmill_yellow',
      'medieval/building_well_blue', 'medieval/trees_B_large', 'medieval/trees_B_medium', 'medieval/tree_single_B',
      'medieval/mountain_A', 'medieval/mountain_C', 'medieval/rock_single_B', 'medieval/rock_single_D',
      'medieval/barrel', 'medieval/crate_B_big', 'medieval/sack', 'medieval/fence_wood_straight',
      'dungeon/torch_lit', 'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow',
    ],
    build(K, r) {
      const { THREE } = K;
      const n = r.n || K.n || 2;
      const ghost = r.variant === 'fantasma';
      const lo = K.quality === 0;
      const o = { ghost, n, prev: [] };
      const RAIL = 34, RAIL_H = 30;
      K.theme('notte', { fogNear: 1.6, fogFar: 4.2 });
      K.ground('neve', { tile: 260, color: '#dfe8f5' });
      // Frozen lake (shiny ice, reflects the braziers) with the rink markings painted on it.
      const lakeTex = K.tex('ghiaccio', { rep: [9, 12], seed: 2 });
      const lakeGeo = new THREE.CircleGeometry(1, 72).rotateX(-Math.PI / 2);
      const lake = K.mesh(lakeGeo, new THREE.MeshStandardMaterial({ map: lakeTex, color: '#cfe6ff', roughness: 0.12, metalness: 0.15 }), { cast: false });
      lake.userData.ownGeo = true; lake.receiveShadow = true;
      lake.scale.set(720, 1, 1080);
      K.place(lake, CX, MID, 0.6);
      K.layer({
        x0: L - RAIL - 70, y0: T - RAIL - 70, x1: R + RAIL + 70, y1: B + RAIL + 70, h: 1.2, transparent: true,
        draw: (d, v) => drawRink(d, v, ghost, n, K.col),
        key: (v) => v.gw.map((w) => Math.round(w)).join('|'),
      });
      // Rocks on the pond shore.
      const rocks = [];
      for (let k = 0; k < 40; k++) {
        const a = (k / 40) * TAU;
        rocks.push({ x: CX + Math.cos(a) * 740, y: MID + Math.sin(a) * 1100, rot: k * 2.1, s: 0.7 + (k % 4) * 0.2 });
      }
      K.scatter('medieval/rock_single_B', rocks.filter((_, k) => k % 2), { size: 80 });
      K.scatter('medieval/rock_single_D', rocks.filter((_, k) => !(k % 2)), { size: 70 });

      // Boards: wooden rails with a snow cap. Corners are fixed; straight runs split around the goal mouths.
      const wood = K.mat('#8a5a32', { rough: 0.8 });
      const snow = K.mat('#f4f8ff', { rough: 0.95 });
      const corners = [[L + CORNER, T + CORNER, Math.PI, 1.5 * Math.PI], [R - CORNER, T + CORNER, 1.5 * Math.PI, TAU], [R - CORNER, B - CORNER, 0, 0.5 * Math.PI], [L + CORNER, B - CORNER, 0.5 * Math.PI, Math.PI]];
      for (const [cx, cy, a0, a1] of corners) {
        K.prism(arcPts(cx, cy, a0, a1, CORNER, CORNER + RAIL), RAIL_H, wood);
        K.place(K.prism(arcPts(cx, cy, a0, a1, CORNER - 2, CORNER + RAIL + 2), 6, snow, { cast: false }), 0, 0, RAIL_H);
      }
      const unit = (m) => K.box(1, 1, 1, m);
      // Runs: seat whose goal is on that side (or -1), fixed coordinate, axis.
      o.runs = [[0, B, 'x'], [1, T, 'x'], [2, L, 'y'], [3, R, 'y']].map(([k, c, ax]) => ({
        k: k < n ? k : -1, c, ax, segs: [0, 1].map(() => ({ rail: unit(wood), cap: unit(snow) })),
      }));
      // Goals: wooden frame posts in the team color, dark pocket, glowing line, team banner behind.
      o.goals = [];
      for (let k = 0; k < n; k++) {
        const slot = K.roster[k]?.color ?? k;
        const col = K.mat(K.col(k), { emissive: K.col(k), ei: 0.5, rough: 0.4 });
        const G = {
          posts: [0, 1].map(() => K.cyl(14, RAIL_H + 30, col)),
          tops: [0, 1].map(() => K.ball(18, K.mat(K.col(k, 'light'), { emissive: K.col(k), ei: 0.6 }))),
          back: unit(K.mat('#2a1a10', { rough: 0.9 })),
          line: unit(K.glow(K.col(k))),
          glow: K.disc(1, K.glow('#ffffff', { opacity: 0.6, add: true, unique: true })),
        };
        const [ux, uy] = SIDE[k], [gx, gy] = GOAL[k];
        for (const s of [-1, 1]) {
          const f = K.model(`medieval/flag_${BANNER[slot] || 'red'}`, { height: 200 });
          K.place(f, gx + ux * (GOAL_DEPTH + 40) + (uy ? s * 200 : 0), gy + uy * (GOAL_DEPTH + 40) + (ux ? s * 200 : 0));
          K.face(f, Math.atan2(-uy, -ux));
        }
        o.goals.push(G);
      }
      // Braziers at the four corners of the rink.
      for (const [x, y] of [[L - 90, T - 90], [R + 90, T - 90], [L - 90, B + 90], [R + 90, B + 90]]) {
        K.place(K.model('dungeon/torch_lit', { height: 110 }), x, y);
      }
      if (!lo) {
        K.light(L - 90, T - 90, 130, '#ffa54a', 2.4, { flicker: 0.5, dist: 700 });
        K.light(R + 90, T - 90, 130, '#ffa54a', 2.4, { flicker: 0.5, dist: 700 });
        K.light(L - 90, B + 90, 130, '#ffa54a', 2.4, { flicker: 0.5, dist: 700 });
        K.light(R + 90, B + 90, 130, '#ffa54a', 2.4, { flicker: 0.5, dist: 700 });
      }

      // The monastery on the far shore; village, mill and cheese market on the sides; pines and mountains all around.
      const church = K.model('medieval/building_church_blue', { height: 480 });
      K.place(church, CX, -1050); K.face(church, Math.PI / 2);
      for (const x of [CX - 420, CX + 420]) { const t = K.model('medieval/building_tower_A_blue', { height: 430 }); K.place(t, x, -960); }
      K.scatter('medieval/wall_straight', [-3, -2, 2, 3].map((k) => ({ x: CX + k * 170, y: -880, rot: 0 })), { size: 180 });
      const side = (name, x, y, a, size) => { const m = K.model(name, { size }); K.place(m, x, y); K.face(m, a); return m; };
      side('medieval/building_market_yellow', -330, MID - 250, 0, 260);
      side('medieval/building_home_A_blue', -520, MID + 180, 0, 300);
      side('medieval/building_home_B_yellow', -480, MID - 700, 0, 300);
      side('medieval/building_windmill_yellow', 1500, MID - 520, Math.PI, 360);
      side('medieval/building_home_A_blue', 1480, MID + 260, Math.PI, 300);
      side('medieval/building_well_blue', 1330, MID - 80, Math.PI, 140);
      side('medieval/building_tower_B_blue', 1450, MID + 1200, Math.PI, 360);
      side('medieval/building_home_B_yellow', -450, MID + 1150, 0, 300);
      // Cheese stacks at the market + barrels, crates and sacks by the boards.
      const cheese = K.mat('#f2c75c', { rough: 0.6 }), rind = K.mat('#d79a2e', { rough: 0.7 });
      for (const [x, y, k] of [[-220, MID - 120, 3], [-200, MID - 380, 2], [1240, MID + 520, 3]]) {
        for (let j = 0; j < k; j++) { K.place(K.cyl(34, 22, j % 2 ? rind : cheese, { seg: 18 }), x + (j % 2) * 6, y, j * 22); }
      }
      // Along the long boards: a low fence for the spectators, barrels, crates, sacks, snowmen and little pines.
      const props = (name, list, size) => K.scatter(name, list.map(([x, y, rot]) => ({ x, y, rot })), { size });
      const fence = [];
      for (let k = 0; k < 20; k++) { const y = T + 30 + k * 70; fence.push({ x: L - 130, y, rot: Math.PI / 2 }, { x: R + 130, y, rot: Math.PI / 2 }); }
      K.scatter('medieval/fence_wood_straight', fence, { size: 72 });
      props('medieval/barrel', [[-150, T + 60, 0], [-190, T + 110, 1], [1150, B - 60, 2], [1190, B - 110, 0], [-170, MID + 330, 1], [1170, MID - 330, 2], [-200, B - 40, 0.5], [1200, T + 40, 1.5]], 50);
      props('medieval/crate_B_big', [[-200, T + 190, 0.3], [1200, B - 190, 0.2], [-210, MID - 420, 0.6], [1210, MID + 420, 0.1]], 58);
      props('medieval/sack', [[-150, T + 230, 0], [1150, B - 230, 1], [-160, MID - 360, 2], [1160, MID + 360, 0.5]], 44);
      const white = K.mat('#f6f9ff', { rough: 0.9 }), coal = K.mat('#1a1a22'), carrot = K.mat('#ff8a1e');
      for (const [x, y] of [[-160, MID + 40], [1160, MID - 40], [-230, B + 20], [1230, T - 20], ...(lo ? [] : [[CX - 380, B + 210], [CX + 380, T - 210]])]) {
        K.place(K.ball(30, white), x, y, 26); K.place(K.ball(22, white), x, y, 70); K.place(K.ball(16, white), x, y, 104);
        const nose = K.cone(5, 22, carrot); nose.rotation.z = -Math.PI / 2; K.place(nose, x + 14, y, 106);
        K.place(K.ball(3.5, coal, { cast: false }), x + 13, y - 7, 112); K.place(K.ball(3.5, coal, { cast: false }), x + 13, y + 7, 112);
      }
      const pines = [], pines2 = [], singles = [];
      const NP = lo ? 30 : 60;
      for (let k = 0; k < NP; k++) {
        const a = (k / NP) * TAU + (k % 3) * 0.02;
        const rr = 1.0 + (k % 4) * 0.12;
        const x = CX + Math.cos(a) * 1050 * rr, y = MID + Math.sin(a) * 1450 * rr;
        if (y < -700 && Math.abs(x - CX) < 700) continue; // keep the monastery clear
        (k % 2 ? pines : pines2).push({ x, y, rot: k * 1.3, s: 0.8 + (k % 3) * 0.2 });
      }
      for (let k = 0; k < 16; k++) singles.push({ x: k % 2 ? -260 - (k % 4) * 60 : 1260 + (k % 4) * 60, y: T - 300 + k * 140, rot: k, s: 0.8 + (k % 3) * 0.2 });
      K.scatter('medieval/trees_B_large', pines, { size: 320 });
      K.scatter('medieval/trees_B_medium', pines2, { size: 260 });
      K.scatter('medieval/tree_single_B', singles, { size: 140 });
      K.scatter('medieval/mountain_A', [{ x: CX - 1700, y: -1800, rot: 0.4 }, { x: CX + 1800, y: -1700, rot: 2.1 }, { x: CX - 2400, y: MID + 600, rot: 1 }, { x: CX + 2500, y: MID + 400, rot: 3 }], { size: 1700 });
      K.scatter('medieval/mountain_C', [{ x: CX, y: -2500, rot: 0.2 }, { x: CX - 2600, y: -600, rot: 1.2 }, { x: CX + 2600, y: -700, rot: 2.6 }, { x: CX, y: H + 2300, rot: 1.7 }], { size: 1900 });
      K.ambient('neve', { n: 160, x0: -400, y0: -400, x1: W + 400, y1: H + 400, h: 700 });

      // Cheese wheels (pool of 3): golden rind, pale top, trail, flames when on fire.
      o.pucks = [0, 1, 2].map(() => {
        const bodyM = K.mat('#f0bd45', { rough: 0.5, emissive: '#ff9a10', ei: 0.35, unique: true });
        const topM = K.mat('#fff1c2', { rough: 0.45, emissive: '#ffd77a', ei: 0.45, unique: true });
        const rimM = K.mat('#b9781e', { rough: 0.6, unique: true });
        const P = {
          body: K.cyl(PUCK_R, 16, bodyM, { seg: 28 }),
          top: K.cyl(PUCK_R - 5, 1.5, topM, { seg: 28, cast: false }),
          rim: K.torus(PUCK_R - 1, 3, rimM),
          mats: [bodyM, topM, rimM], alpha: -1, fire: -1,
          trail: [0.36, 0.28, 0.2, 0.13, 0.07].map((a) => K.disc(1, K.glow('#ffe14d', { opacity: a, add: true, unique: true }))),
          flames: [],
        };
        for (let k = 0; k < 6; k++) P.flames.push(K.ball(1, K.glow(k % 2 ? '#ffc828' : '#ff501e', { add: true }), { cast: false }));
        return P;
      });
      // Shield-sleds with the player's knight standing on top.
      o.mal = [...Array(n).keys()].map((i) => {
        const M = {
          base: K.cyl(1, 1, K.mat('#9a6a3c', { rough: 0.7 }), { seg: 36 }),
          paint: K.cyl(0.78, 1, K.mat(K.col(i), { rough: 0.45 }), { seg: 36, cast: false }),
          rim: K.torus(1, 0.09, K.mat('#c9ced6', { rough: 0.3, metal: 0.6 })),
          boss: K.ball(1, K.mat('#dfe3ea', { rough: 0.25, metal: 0.7 }), { cast: false }),
          bubble: K.ball(1, K.mat(K.col(i, 'light'), { opacity: 0.28, rough: 0.1, emissive: K.col(i), ei: 0.4 }), { cast: false }),
          bubbleRing: K.torus(1, 0.05, K.glow(K.col(i, 'light'))),
          ghosts: [0.3, 0.2, 0.1].map((a) => K.cyl(MALLET_R, 14, K.glow(K.col(i, 'light'), { opacity: a, add: true }), { cast: false })),
          flames: [],
          av: K.avatar(i),
          dec: K.decal(300),
        };
        for (let k = 0; k < 8; k++) M.flames.push(K.ball(1, K.glow(k % 2 ? '#ff7a2a' : '#ffd23f', { add: true }), { cast: false }));
        return M;
      });
      return o;
    },

    update(K, o, v, r) {
      const t = K.t, n = o.n;
      const RAIL = 34, RAIL_H = 30;
      // Board runs: split around the goal mouth of the seat on that side (if any).
      for (const run of o.runs) {
        const gw = run.k >= 0 ? v.gw[run.k] : 0;
        const lo = run.ax === 'x' ? L + CORNER : T + CORNER, hi = run.ax === 'x' ? R - CORNER : B - CORNER;
        const mid = run.ax === 'x' ? CX : MID;
        const parts = gw > 0 ? [[lo, mid - gw], [mid + gw, hi]] : [[lo, hi], null];
        const out = run.c === B || run.c === R ? 1 : -1;
        run.segs.forEach((S, k) => {
          const pr = parts[k];
          S.rail.visible = S.cap.visible = !!pr;
          if (!pr) return;
          const len = Math.max(1, pr[1] - pr[0]), m = (pr[0] + pr[1]) / 2, c = run.c + out * RAIL / 2;
          if (run.ax === 'x') {
            S.rail.scale.set(len, RAIL_H, RAIL); K.place(S.rail, m, c, RAIL_H / 2);
            S.cap.scale.set(len, 6, RAIL + 4); K.place(S.cap, m, c, RAIL_H + 3);
          } else {
            S.rail.scale.set(RAIL, RAIL_H, len); K.place(S.rail, c, m, RAIL_H / 2);
            S.cap.scale.set(RAIL + 4, 6, len); K.place(S.cap, c, m, RAIL_H + 3);
          }
        });
      }
      // Goals follow the (possibly growing) mouth width; the one that conceded flashes in the scorer's color.
      o.goals.forEach((G, k) => {
        const gw = v.gw[k], [ux, uy] = SIDE[k], [gx, gy] = GOAL[k];
        const along = uy ? [1, 0] : [0, 1];
        G.posts.forEach((p, j) => {
          const s = j ? 1 : -1;
          K.place(p, gx + along[0] * gw * s, gy + along[1] * gw * s);
          K.place(G.tops[j], gx + along[0] * gw * s, gy + along[1] * gw * s, RAIL_H + 34 + Math.sin(t * 3 + k) * 3);
        });
        const bx = gx + ux * (GOAL_DEPTH - 6), by = gy + uy * (GOAL_DEPTH - 6);
        if (uy) { G.back.scale.set(gw * 2 + 30, RAIL_H, 12); G.line.scale.set(gw * 2 - 16, 3, 6); }
        else { G.back.scale.set(12, RAIL_H, gw * 2 + 30); G.line.scale.set(6, 3, gw * 2 - 16); }
        K.place(G.back, bx, by, RAIL_H / 2);
        K.place(G.line, gx, gy, 2);
        const gl = v.gl ? v.gl[k] : 0;
        G.glow.visible = gl > 0.01;
        if (G.glow.visible) {
          K.place(G.glow, gx, gy, 2.5); G.glow.scale.setScalar(200 + 80 * (1 - gl));
          G.glow.material.opacity = 0.7 * gl; G.glow.material.color.set(K.col(v.gc ? v.gc[k] : k));
        }
      });

      // Cheese wheels.
      o.pucks.forEach((P, idx) => {
        const p = v.k[idx];
        let alpha = 0;
        if (p) alpha = p.o ? 0.35 : o.ghost ? fogAlpha(p, n) : 1;
        const vis = alpha > 0.02;
        P.body.visible = P.top.visible = P.rim.visible = vis;
        for (const tr of P.trail) tr.visible = false;
        for (const f of P.flames) f.visible = false;
        if (!vis) return;
        if (alpha !== P.alpha) {
          P.alpha = alpha;
          for (const m of P.mats) { m.transparent = alpha < 1; m.opacity = alpha; m.depthWrite = alpha >= 1; m.needsUpdate = true; }
        }
        const fire = p.f ? 1 : 0;
        if (fire !== P.fire) {
          P.fire = fire;
          P.mats[0].emissive?.set(fire ? '#ff3a00' : '#ff9a10'); P.mats[0].emissiveIntensity = fire ? 0.9 : 0.35;
          for (const tr of P.trail) tr.material.color.set(fire ? '#ff8a30' : '#ffe14d');
        }
        const sp = Math.hypot(p.vx, p.vy);
        K.place(P.body, p.x, p.y, 1);
        K.place(P.top, p.x, p.y, 17);
        K.place(P.rim, p.x, p.y, 9);
        P.body.rotation.y = P.top.rotation.y = (p.x + p.y) * 0.01;
        if (!p.o && sp > 250 && alpha >= 0.99) {
          P.trail.forEach((tr, k) => {
            tr.visible = true;
            K.place(tr, p.x - p.vx * 0.011 * (k + 1), p.y - p.vy * 0.011 * (k + 1), 2 + k * 0.1);
            tr.scale.setScalar(PUCK_R * (1 - (k + 1) * 0.13) * (p.f ? 1.2 : 1));
          });
        }
        if (p.f && !p.o && alpha >= 0.99) {
          P.flames.forEach((f, k) => {
            f.visible = true;
            const a = t * 6 + (k * TAU) / 6;
            K.place(f, p.x + Math.cos(a) * (PUCK_R + 4), p.y + Math.sin(a) * (PUCK_R + 4), 16 + Math.sin(t * 20 + k * 2) * 6);
            f.scale.setScalar(9 + 5 * Math.sin(t * 20 + k * 2));
          });
        }
      });

      // Shield-sleds and knights.
      let best = -1;
      for (const q of v.hud.p) best = Math.max(best, q);
      v.m.forEach((m, i) => {
        const M = o.mal[i];
        if (!M) return;
        const mr = m.r || MALLET_R;
        let look = Math.atan2(-SIDE[i][1], -SIDE[i][0]), bd = 1e9;
        for (const p of v.k) {
          if (p.o) continue;
          const dd = Math.hypot(p.x - m.x, p.y - m.y);
          if (dd < bd) { bd = dd; look = Math.atan2(p.y - m.y, p.x - m.x); }
        }
        // Speed from the interpolated motion (for the walk/run animation).
        const pv = o.prev[i] || (o.prev[i] = { x: m.x, y: m.y, sp: 0 });
        const dtt = Math.max(1e-3, K.dt || 1 / 60);
        pv.sp += (Math.hypot(m.x - pv.x, m.y - pv.y) / dtt - pv.sp) * 0.25;
        pv.x = m.x; pv.y = m.y;
        const pr = MALLET_R * (m.s ? 1.1 : 1);
        const BH = 14;
        K.place(M.base, m.x, m.y); M.base.scale.set(pr, BH, pr);
        K.place(M.paint, m.x, m.y, BH); M.paint.scale.set(pr, 1.5, pr);
        K.place(M.rim, m.x, m.y, BH); M.rim.scale.set(pr * 0.98, pr * 0.6, pr * 0.98);
        K.place(M.boss, m.x, m.y, BH); M.boss.scale.setScalar(pr * 0.18);
        M.bubble.visible = M.bubbleRing.visible = !!m.sh;
        if (m.sh) {
          K.place(M.bubble, m.x, m.y); M.bubble.scale.set(mr, mr * 0.75, mr);
          K.place(M.bubbleRing, m.x, m.y, 2); M.bubbleRing.scale.set(mr, 40, mr);
          M.bubbleRing.rotation.y = t * 2;
        }
        M.ghosts.forEach((g, k) => {
          g.visible = !!m.s;
          if (g.visible) { K.place(g, m.x - Math.cos(look) * 26 * (k + 1), m.y - Math.sin(look) * 26 * (k + 1)); g.scale.set(1 - (k + 1) * 0.15, 1, 1 - (k + 1) * 0.15); }
        });
        M.flames.forEach((f, k) => {
          f.visible = !!m.sp;
          if (!f.visible) return;
          const a = (k / 8) * TAU + t * 3, rr = mr + 16 + Math.sin(t * 20 + k * 2) * 8;
          K.place(f, m.x + Math.cos(a) * rr, m.y + Math.sin(a) * rr, 16 + Math.sin(t * 15 + k) * 8);
          f.scale.setScalar(12 + 4 * Math.sin(t * 15 + k));
        });
        let mood = MOODS[m.md] || 'ok', anim, animKey;
        if (m.s) { anim = '1H_Melee_Attack_Slice_Horizontal'; animKey = m.k; }
        else if (m.sh) anim = 'Blocking';
        else if (m.md === 1) anim = 'Cheer';
        else if (m.md === 2) anim = 'Hit_B';
        if (r.ended) { mood = v.hud.p[i] === best ? 'happy' : 'dizzy'; anim = mood === 'happy' ? 'Cheer' : undefined; }
        M.av.set(m.x, m.y, { r: MALLET_R * 0.56, h: BH + 2, look, mood, walk: clamp(pv.sp / 900, 0, 1), anim, animKey, squash: m.sh ? -0.08 : 0 });
        // Cooldown rings on the ice: full ring = Bordata ready, arc on the own side = Scudo ready.
        M.dec.at(m.x, m.y, 1.6).paint((d) => {
          const lt = K.col(i, 'light');
          if (m.c <= 0) d.ring(0, 0, pr + 12, m.sp ? '#ffb347' : lt + 'dd', 6);
          else d.arc(0, 0, pr + 12, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - m.c / SMASH_CD), lt + '66', 6);
          const sc = clamp(1 - (m.sc || 0) / (SHIELD_CD + SHIELD_T), 0, 1);
          const sa = Math.atan2(SIDE[i][1], SIDE[i][0]);
          d.arc(0, 0, pr + 24, sa - Math.PI * 0.35 * sc, sa + Math.PI * 0.35 * sc, sc >= 1 ? '#ffffffdd' : '#ffffff55', 6);
        });
      });
    },
  },

  render(d, v, r) {
    const t = d.t, n = v.m.length;
    const ghost = r.variant === 'fantasma';
    const { ctx } = d;
    const g = ctx.createRadialGradient(CX, MID, 200, CX, MID, 1300);
    g.addColorStop(0, '#24365a');
    g.addColorStop(1, '#0a1022');
    ctx.fillStyle = g;
    ctx.fillRect(-400, -400, W + 800, H + 800);
    drawRink(d, v, ghost, n, d.col, true);

    // Cheese wheels with speed / fire trail.
    for (const p of v.k) {
      const alpha = p.o ? 0.35 : ghost ? fogAlpha(p, n) : 1;
      if (alpha < 0.02) continue;
      ctx.save();
      ctx.globalAlpha = alpha;
      const sp = Math.hypot(p.vx, p.vy);
      if (!p.o && sp > 250) {
        for (let k = 5; k >= 1; k--) {
          const col = p.f ? `rgba(255,${120 + k * 20},40,${(0.42 - k * 0.07).toFixed(2)})` : `rgba(255,225,77,${(0.24 - k * 0.04).toFixed(2)})`;
          d.circle(p.x - p.vx * 0.011 * k, p.y - p.vy * 0.011 * k, PUCK_R * (1 - k * 0.13) * (p.f ? 1.15 : 1), col);
        }
      }
      d.circle(p.x + 6, p.y + 10, PUCK_R, 'rgba(0,0,0,0.4)');
      d.circle(p.x, p.y, PUCK_R, '#e9b949', p.f ? '#ff7a2a' : '#b9781e', 6);
      d.circle(p.x, p.y, PUCK_R * 0.7, '#fbe6a2');
      d.circle(p.x - 10, p.y - 12, 6, 'rgba(255,255,255,0.35)');
      ctx.restore();
    }

    v.m.forEach((m, i) => {
      const mr = m.r || MALLET_R;
      let look = Math.atan2(-SIDE[i][1], -SIDE[i][0]), best = 1e9;
      for (const p of v.k) {
        if (p.o) continue;
        const dd = Math.hypot(p.x - m.x, p.y - m.y);
        if (dd < best) { best = dd; look = Math.atan2(p.y - m.y, p.x - m.x); }
      }
      d.shadow(m.x + 6, m.y + 14, mr, mr * 0.85, 0.4);
      if (m.sp) {
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * TAU + t * 3, rr = mr + 16 + Math.sin(t * 20 + k * 2) * 8;
          d.circle(m.x + Math.cos(a) * rr, m.y + Math.sin(a) * rr, 12 + 4 * Math.sin(t * 15 + k), k % 2 ? '#ff7a2a' : '#ffd23f');
        }
      }
      if (m.sh) { d.circle(m.x, m.y, mr, d.col(i, 'light') + '33'); d.ring(m.x, m.y, mr, d.col(i, 'light'), 6); }
      const pr = MALLET_R * (m.s ? 1.1 : 1);
      d.circle(m.x, m.y, pr, '#9a6a3c', '#c9ced6', 6);
      d.circle(m.x, m.y, pr * 0.75, d.col(i));
      if (m.c <= 0) d.ring(m.x, m.y, pr + 10, m.sp ? '#ffb347' : d.col(i, 'light') + 'bb', 4);
      else d.arc(m.x, m.y, pr + 10, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - m.c / SMASH_CD), d.col(i, 'light') + '55', 4);
      const sc = clamp(1 - (m.sc || 0) / (SHIELD_CD + SHIELD_T), 0, 1);
      const sa = Math.atan2(SIDE[i][1], SIDE[i][0]);
      d.arc(m.x, m.y, pr + 20, sa - Math.PI * 0.35 * sc, sa + Math.PI * 0.35 * sc, sc >= 1 ? '#ffffffcc' : '#ffffff44', 4);
      d.avatar(m.x, m.y, MALLET_R * 0.56, i, { look, mood: MOODS[m.md] || 'ok', squash: m.s ? 0.18 : m.sh ? -0.12 : 0 });
    });
  },
};

const ah = (a) => Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, '0');

// Outline of a ring sector (corner rail): from angle a0 to a1 between radii r0 and r1.
function arcPts(cx, cy, a0, a1, r0, r1) {
  const pts = [];
  for (let k = 0; k <= 10; k++) { const a = a0 + ((a1 - a0) * k) / 10; pts.push(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); }
  for (let k = 10; k >= 0; k--) { const a = a0 + ((a1 - a0) * k) / 10; pts.push(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); }
  return pts;
}

// Rink markings on the ice (3D layer and 2D fallback): team zones, center line or X, goal arcs, goal pockets.
function drawRink(d, v, ghost, n, col, solid = false) {
  const { ctx } = d;
  // Goal pockets cut into the boards.
  for (let k = 0; k < n; k++) {
    const gw = v.gw[k], [ux, uy] = SIDE[k], [gx, gy] = GOAL[k];
    if (uy) d.rect(gx - gw, uy > 0 ? gy : gy - GOAL_DEPTH, gw * 2, GOAL_DEPTH, '#1a1410');
    else d.rect(ux > 0 ? gx : gx - GOAL_DEPTH, gy - gw, GOAL_DEPTH, gw * 2, '#1a1410');
  }
  ctx.save();
  roundPath(ctx, L, T, R - L, B - T, CORNER);
  ctx.clip();
  if (solid) d.rect(L, T, R - L, B - T, '#cfe3f5');
  // Team zones (tinted ice).
  if (n === 2) {
    d.rect(L, MID, R - L, B - MID, col(0) + '33');
    d.rect(L, T, R - L, MID - T, col(1) + '33');
  } else {
    const tri = [[L, B, R, B], [L, T, R, T], [L, T, L, B], [R, T, R, B]];
    for (let k = 0; k < 4; k++) {
      const [x0, y0, x1, y1] = tri[k];
      d.poly([CX, MID, x0, y0, x1, y1], k < n ? col(k) + '33' : 'rgba(255,255,255,0.08)');
    }
  }
  if (ghost) {
    if (n === 2) d.rect(L, MID - BAND, R - L, BAND * 2, 'rgba(200,215,235,0.55)');
    else d.circle(CX, MID, FOG_R, 'rgba(200,215,235,0.55)');
  }
  // Goal glow after a goal (the goal that conceded lights up in the scorer's colour).
  for (let k = 0; k < n; k++) {
    const gl = v.gl ? v.gl[k] : 0;
    if (gl > 0) d.circle(GOAL[k][0], GOAL[k][1], 260 + 80 * (1 - gl), col(v.gc ? v.gc[k] : k) + ah(0.35 * gl));
  }
  ctx.restore();
  const line = 'rgba(40,70,120,0.55)';
  if (n === 2) d.line(L, MID, R, MID, 'rgba(200,40,40,0.6)', 7);
  else { d.line(L, T, R, B, 'rgba(200,40,40,0.6)', 7); d.line(R, T, L, B, 'rgba(200,40,40,0.6)', 7); }
  d.ring(CX, MID, 120, line, 6);
  d.circle(CX, MID, 14, 'rgba(200,40,40,0.7)');
  for (let k = 0; k < n; k++) {
    const [gx, gy] = GOAL[k], a = Math.atan2(-SIDE[k][1], -SIDE[k][0]);
    d.arc(gx, gy, 190, a - Math.PI / 2, a + Math.PI / 2, col(k) + 'cc', 6);
    const gw = v.gw[k];
    if (SIDE[k][1]) d.line(gx - gw + 8, gy, gx + gw - 8, gy, col(k) + 'cc', 5);
    else d.line(gx, gy - gw + 8, gx, gy + gw - 8, col(k) + 'cc', 5);
  }
  if (ghost && n === 2) {
    d.line(L, MID - BAND, R, MID - BAND, 'rgba(120,140,190,0.5)', 4);
    d.line(L, MID + BAND, R, MID + BAND, 'rgba(120,140,190,0.5)', 4);
  }
  if (solid) d.rrect(L, T, R - L, B - T, CORNER, null, '#8a5a32', 10);
}

// Rounded-rect path for clipping.
function roundPath(ctx, x, y, w, h, rad) {
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
