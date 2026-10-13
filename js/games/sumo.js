// Giostra nel Fango — reference mini-game (top-down, dir + A charge + B shield/parry, fire potion power-up).
// 2–4 knights on a round wooden stage over a mud pit: last one standing wins.
import { clamp, damp, dist, collideCircles, norm, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500;
const PLATE_R = 420, PLATE_MIN = 230, SHRINK_STEP = 45, SHRINK_EVERY = 10, SHRINK_WARN = 1.5;
const BALL_R = 46;
const ACCEL = 1500, MAX_SPEED = 560;
const DASH_SPEED = 980, DASH_TIME = 0.22, DASH_CD = 1.0;
const ANCHOR_TIME = 0.55, ANCHOR_CD = 1.6, PARRY_WINDOW = 0.3, ANCHOR_MASS = 6;
const CHILI_FIRST = 6, CHILI_EVERY = 9, CHILI_LIFE = 6, CHILI_TIME = 6, CHILI_R = 30;
const FALLS_TO_LOSE = 2;
// Seat sides: 0 = bottom, 1 = top, 2 = left, 3 = right (unit vector from the center toward the seat's side).
const SIDE = [[0, 1], [0, -1], [-1, 0], [1, 0]];
const MUD_R = 600;   // mud pit around the stage (3D scenery)
const FLAG = ['red', 'blue', 'green', 'yellow']; // KayKit model colors, indexed by slot color

function spawn(s) {
  s.p.forEach((p, i) => {
    if (p.elim) { p.fall = 0; p.vx = 0; p.vy = 0; return; }
    const [ux, uy] = SIDE[i];
    p.x = CX + ux * 200; p.y = CY + uy * 200;
    p.vx = 0; p.vy = 0; p.fall = 0; p.dash = 0; p.cd = 0.4;
    p.anchor = 0; p.acd = 0;
    p.fx = -ux; p.fy = -uy;
  });
  s.pause = 0.9;
}

// Where a power-up can sit: on the stage, outside the hole, a bit closer to whoever is losing.
function chiliSpot(s, g) {
  const inner = Math.max(s.hole + CHILI_R + 20, 0), outer = s.plate - CHILI_R - 40;
  const a = g.rng.range(0, TAU), rr = g.rng.range(inner, Math.max(inner + 1, outer * 0.75));
  let x = CX + Math.cos(a) * rr, y = CY + Math.sin(a) * rr;
  const alive = s.p.filter((p) => !p.elim);
  let hi = -1, lo = 99;
  for (const p of alive) { hi = Math.max(hi, s.falls[p.i]); lo = Math.min(lo, s.falls[p.i]); }
  if (hi > lo) {
    const lp = alive.find((p) => s.falls[p.i] === hi);
    if (!lp.fall) { x += (lp.x - x) * 0.35; y += (lp.y - y) * 0.35; }
  }
  const d = dist(x, y, CX, CY);
  if (d < inner) { const n = norm(x - CX || 1, y - CY); x = CX + n.x * inner; y = CY + n.y * inner; }
  return { x, y };
}

// Two knights bump: the charging one hits much harder; a planted shield is a wall (and parries a fresh charge).
function bump(a, b, g) {
  const mul = (p) => p.m * (p.dash > 0 ? 3 : 1) * (p.anchor > 0 ? ANCHOR_MASS : 1) * (1 + p.swell * 0.15) * (p.hot > 0 ? 1.3 : 1);
  const spA = Math.hypot(a.vx, a.vy), spB = Math.hypot(b.vx, b.vy);
  const A = { ...a, m: mul(a) }, B = { ...b, m: mul(b) };
  const impact = collideCircles(A, B, 1.25);
  if (impact <= 0) return;
  Object.assign(a, { x: A.x, y: A.y, vx: A.vx, vy: A.vy });
  Object.assign(b, { x: B.x, y: B.y, vx: B.vx, vy: B.vy });
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  let parried = false;
  for (const [att, def] of [[a, b], [b, a]]) {
    if (att.dash > 0 && def.anchor > ANCHOR_TIME - PARRY_WINDOW && def.dash <= 0) {
      const n = norm(att.x - def.x, att.y - def.y);
      att.vx = n.x * 900; att.vy = n.y * 900; att.dash = 0; att.hitT = 0.6;
      def.vx = 0; def.vy = 0;
      parried = true;
      g.sfx('bang'); g.sfx('boing', { pitch: 0.7 });
      g.text(def.x, def.y - def.r - 34, 'PARATA!', { player: def.i, size: 56 });
      g.ring(def.x, def.y, { player: def.i, r: def.r + 70 });
      g.burst(mx, my, { color: '#fff', n: 24, speed: 480 });
      g.shake(0.55); g.hitstop(0.1); g.vibrate(att.i, 120); g.vibrate(def.i, 40);
      break;
    }
  }
  const hard = impact > 600;
  if (!parried) {
    g.sfx(hard ? 'punch' : 'bonk', { pitch: hard ? 1 : 1.3 });
    g.burst(mx, my, { color: '#fff', n: hard ? 18 : 6, speed: hard ? 420 : 180 });
  }
  if (hard && !parried) {
    g.shake(0.45); g.hitstop(0.06);
    const da = a.dash > 0, db = b.dash > 0;
    const victim = da !== db ? (da ? b : a) : spA >= spB ? b : a;
    victim.hitT = 0.4;
    g.vibrate(victim.i, 80);
    if (g.variant === 'lievitata' && victim.swell < 5) {
      victim.swell++; victim.r += 7; g.sfx('grow'); g.text(victim.x, victim.y - victim.r - 20, 'BERNOCCOLO!', { player: victim.i });
    }
  }
}

// ---- Computer player ----
const BOT_DELAY = [0.34, 0.2, 0.09]; // reaction delay of the bot driver per level (core/bots.js)
const BOT_MISS_TOL = [40, 160, 400]; // how much a missed charge may overshoot the edge (better aim → rarer misses)
const BOT_PUSH_ANG = [0, 0.5, -0.5, 0.9, -0.9, 1.3, -1.3];

// Steer toward (gx, gy) braking in time: wanted velocity = distance / T (capped), stick = velocity error.
// The distance is measured from where I will be once my (delayed) input lands.
function botSteer(p, gx, gy, T, vmax, lag) {
  // Velocity loop gain: with a reaction delay a stiff loop overshoots and swings (K·delay must stay ≲ 1).
  const G = Math.max(200, 1650 * (lag - 0.05));
  let vx = (gx - p.x - p.vx * lag) / T, vy = (gy - p.y - p.vy * lag) / T;
  const v = Math.hypot(vx, vy);
  if (v > vmax) { vx *= vmax / v; vy *= vmax / v; }
  const ux = (vx - p.vx) / G, uy = (vy - p.vy) / G;
  const m = Math.hypot(ux, uy);
  return m > 1 ? { x: ux / m, y: uy / m } : { x: ux, y: uy };
}

// Distance of the segment a→b from the stage center (to avoid charging across the well).
function segNearCenter(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
  const t = clamp(((CX - ax) * dx + (CY - ay) * dy) / l2, 0, 1);
  return dist(ax + dx * t, ay + dy * t, CX, CY);
}

function sumoBot(s, me, g, B) {
  const p = s.p[me];
  if (!p || p.elim || p.fall > 0 || s.pause > 0) return { x: 0, y: 0 };
  const lv = B.level, m = B.mem;
  const oily = g.variant === 'olio';
  const delay = BOT_DELAY[lv];
  // Approach time constant and stick gain: slow reflexes → gentler steering (else it overshoots and swings).
  const ST = 0.45 + (oily ? 0.6 : 0), LAG = delay + 0.05;
  // Safe ring of the stage (outside the well, inside the edge), with a margin that grows with speed and slowness.
  const tau = oily ? 1.2 : 0.45;
  const look = delay + tau;
  const px = p.x + p.vx * look, py = p.y + p.vy * look;
  const dC = dist(p.x, p.y, CX, CY), dP = dist(px, py, CX, CY);
  const edgeIn = s.plate - p.r * 0.35 - (lv === 0 ? 55 : 35);
  const holeOut = s.hole > 0 ? s.hole - p.r * 0.35 + [60, 45, 35][lv] : 0;
  const midR = s.hole > 0 ? (holeOut + edgeIn) / 2 : 0;
  // Slow down near the edge (and the well): there is no time to brake there.
  const gap = Math.min(edgeIn - dC, s.hole > 0 ? dC - holeOut : 1e9);
  const VM = clamp(140 + gap * (2.6 - delay * 2), 160, MAX_SPEED);
  // Danger: the predicted position leaves the safe ring → run back toward safety, nothing else matters.
  const outDanger = dP > edgeIn, holeDanger = s.hole > 0 && dP < holeOut;
  if (outDanger || holeDanger) {
    const n = norm(p.x - CX || 0.01, p.y - CY);
    const tr = midR || 0;
    const gx = CX + n.x * tr, gy = CY + n.y * tr;
    const st = botSteer(p, gx, gy, ST, MAX_SPEED, LAG);
    // Shield as an emergency brake (feet planted) when about to slide off.
    const brake = lv > 0 && p.acd <= 0 && p.dash <= 0 && (outDanger ? dC > edgeIn - 10 : dC < holeOut + 10);
    return { x: st.x, y: st.y, b: brake };
  }

  // Parry: a rival charging right at me.
  let threat = null;
  for (const q of s.p) {
    if (q === p || q.elim || q.fall > 0) continue;
    const dx = p.x - q.x, dy = p.y - q.y, d = Math.hypot(dx, dy);
    if (q.dash > 0 && d < 260) {
      const sp = Math.hypot(q.vx, q.vy) || 1;
      if ((q.vx * dx + q.vy * dy) / (sp * d) > 0.8) threat = q;
    }
  }
  if (threat && lv > 0 && p.acd <= 0 && p.dash <= 0 && (lv === 2 || B.rng() < 0.5)) return { x: 0, y: 0, b: true };
  if (threat && lv === 2) {
    // Shield on cooldown: sidestep the charge.
    const n = norm(p.x - threat.x, p.y - threat.y);
    let sx = -n.y, sy = n.x;
    if ((p.x + sx * 80 - CX) ** 2 + (p.y + sy * 80 - CY) ** 2 > (p.x - sx * 80 - CX) ** 2 + (p.y - sy * 80 - CY) ** 2) { sx = -sx; sy = -sy; }
    return { x: sx, y: sy };
  }

  // Fire potion: grab it when I am the closest (the easy bot ignores it).
  if (s.chili && lv > 0) {
    const dc = dist(p.x, p.y, s.chili.x, s.chili.y);
    let mine = dc < 420;
    for (const q of s.p) if (q !== p && !q.elim && !q.fall && dist(q.x, q.y, s.chili.x, s.chili.y) < dc * 0.85) mine = false;
    if (mine) {
      const st = botSteer(p, s.chili.x, s.chili.y, ST, VM, LAG);
      return { x: st.x, y: st.y };
    }
  }

  // Target: the easy bot goes for the nearest knight; better bots prefer one near the edge (or the well).
  let tgt = null, best = Infinity;
  for (const q of s.p) {
    if (q === p || q.elim || q.fall > 0) continue;
    const d = dist(p.x, p.y, q.x, q.y);
    const qd = dist(q.x, q.y, CX, CY);
    const edgeGap = s.hole > 0 ? Math.min(s.plate - qd, qd - s.hole) : s.plate - qd;
    const score = lv === 0 ? d : d + edgeGap * (lv === 2 ? 1.4 : 0.8) + (s.falls[q.i] >= FALLS_TO_LOSE - 1 ? -80 : 0);
    if (score < best) { best = score; tgt = q; }
  }
  if (!tgt) {
    const st = botSteer(p, CX + (midR ? midR : 0), CY, ST, VM, LAG);
    return { x: st.x, y: st.y };
  }
  // Predict where the target will be (better bots look further).
  const lead = [0.05, 0.15, 0.22][lv];
  const tx = tgt.x + tgt.vx * lead, ty = tgt.y + tgt.vy * lead;
  // Push direction: away from the center, or slanted when the spot behind the target is unsafe (the well):
  // try a few directions and keep the cheapest attack spot that lies inside the safe ring.
  const td = dist(tx, ty, CX, CY);
  const rs = p.r + tgt.r;
  const back = rs + [35, 60, 70][lv];
  const n0 = norm(tx - CX || 0.01, ty - CY);
  let ux = n0.x, uy = n0.y, ax = tx - ux * back, ay = ty - uy * back, bestC = Infinity, bestA = 0;
  for (const da of BOT_PUSH_ANG) {
    const c = Math.cos(da), sn = Math.sin(da);
    const vx = n0.x * c - n0.y * sn, vy = n0.x * sn + n0.y * c;
    const sx = tx - vx * back, sy = ty - vy * back;
    const sd = dist(sx, sy, CX, CY);
    const bad = sd > edgeIn - 30 || (s.hole > 0 && sd < holeOut + 20);
    const cost = Math.abs(da) * 250 + dist(p.x, p.y, sx, sy) * 0.15 + (bad ? 1000 : 0) + (m.pa === da && m.pt === tgt.i ? -150 : 0);
    if (cost < bestC) { bestC = cost; ux = vx; uy = vy; ax = sx; ay = sy; bestA = da; }
  }
  m.pa = bestA; m.pt = tgt.i; // stick to the chosen side (no dithering)
  // Keep the attack spot inside the safe ring.
  {
    const ad = dist(ax, ay, CX, CY);
    const n = norm(ax - CX || 0.01, ay - CY);
    const lim = Math.max(0, edgeIn - 30);
    if (ad > lim) { ax = CX + n.x * lim; ay = CY + n.y * lim; }
    if (s.hole > 0 && ad < holeOut + 20) { ax = CX + n.x * (holeOut + 20); ay = CY + n.y * (holeOut + 20); }
  }
  const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy) || 1;
  const ex = dx / d, ey = dy / d;
  const align = ex * ux + ey * uy; // 1 = I'm exactly behind the target
  // Charge: in range, roughly aligned, not into a fresh shield, and I would not fly off the stage.
  const shielded = tgt.anchor > 0.05 && tgt.dash <= 0;
  // Charge range: a shaky aim (easy bot) must get close so the charge cannot miss by much.
  const range = Math.min(p.hot > 0 ? 330 : 270, rs + [70, 130, 200][lv]);
  // The charge leaves after my reaction delay: judge the distance I will have by then.
  const close = Math.max(0, ((p.vx - tgt.vx) * ex + (p.vy - tgt.vy) * ey));
  const dNext = d - close * delay;
  if (p.cd <= 0 && p.anchor <= 0 && dNext < range && (lv === 0 ? align > 0.2 : align > 0.45) && !shielded) {
    // After the hit I keep sliding forward (~430 u/s until I react and brake): that point must stay on the stage.
    const land = Math.max(0, d - rs) + 110 + 430 * delay + (oily ? 160 : 0);
    const lx = p.x + ex * land, ly = p.y + ey * land;
    const ld = dist(lx, ly, CX, CY);
    const safe = ld < s.plate - 10 && !(s.hole > 0 && ld < s.hole + 20) &&
      !(s.hole > 0 && segNearCenter(p.x, p.y, lx, ly) < s.hole + 50 + delay * 200);
    // A shaky aim may miss: then the charge carries me ~215 u plus the slide until I react.
    const miss = 215 + 560 * delay + 90 + (oily ? 250 : 0);
    const mx = p.x + ex * miss, my = p.y + ey * miss;
    const missOk = dist(mx, my, CX, CY) < s.plate + BOT_MISS_TOL[lv];
    if (safe && (missOk || d < rs + 45)) return { x: ex, y: ey, tapA: true };
  }
  // Waiting for a shield to drop / the charge to recharge: circle at a safe distance, else go to the attack spot.
  let gx = ax, gy = ay, vm = VM;
  // Already lined up behind the target: run up to it (slowly enough not to bump it before the charge leaves).
  if (align > 0.8 && !shielded && p.cd < 0.3 && dist(p.x, p.y, ax, ay) < back) {
    gx = tx; gy = ty;
    vm = Math.min(VM, Math.max(120, (d - rs - 10) / (delay + 0.15)));
  }
  // Target already close to the edge and I'm behind it: a plain shove is enough (the danger check brakes me).
  const tgap = s.hole > 0 ? Math.min(s.plate - td, td - s.hole) : s.plate - td;
  if (tgap < 110 && align > 0.6 && d < rs + 140 && !shielded) { gx = tx + ux * 60; gy = ty + uy * 60; }
  if (shielded || (p.cd > 0.35 && d < rs + 120)) {
    gx = tx - ux * (rs + 160); gy = ty - uy * (rs + 160);
    const n = norm(gx - CX || 0.01, gy - CY), gd = dist(gx, gy, CX, CY);
    if (gd > edgeIn - 30) { gx = CX + n.x * (edgeIn - 30); gy = CY + n.y * (edgeIn - 30); }
  }
  // Moving straight through the target to reach the spot behind it would push it inward: go around.
  if (align < 0.3 && d < rs + 150) {
    const sx = -ey, sy = ex;
    const side = (gx - p.x) * sx + (gy - p.y) * sy >= 0 ? 1 : -1;
    gx = p.x + sx * side * 160 - ex * 40; gy = p.y + sy * side * 160 - ey * 40;
    const n = norm(gx - CX || 0.01, gy - CY), gd = dist(gx, gy, CX, CY);
    if (gd > edgeIn - 20) { gx = CX + n.x * (edgeIn - 20); gy = CY + n.y * (edgeIn - 20); }
  }
  // Never walk across the well: go around it.
  if (s.hole > 0 && segNearCenter(p.x, p.y, gx, gy) < holeOut + 25) {
    const a0 = Math.atan2(p.y - CY, p.x - CX), a1 = Math.atan2(gy - CY, gx - CX);
    let da = a1 - a0;
    while (da > Math.PI) da -= TAU;
    while (da < -Math.PI) da += TAU;
    // Keep the same way around while detouring (no dithering when the goal is right across the well).
    if (!m.detour || Math.abs(da) < 2.6) m.detour = Math.sign(da || 1);
    const a = a0 + m.detour * Math.min(Math.abs(da), 0.9);
    const rr = Math.max(holeOut + 70, Math.min(dC, edgeIn - 40));
    gx = CX + Math.cos(a) * rr; gy = CY + Math.sin(a) * rr;
  } else m.detour = 0;
  const st = botSteer(p, gx, gy, ST, vm, LAG);
  return { x: st.x, y: st.y };
}

export default {
  id: 'sumo',
  name: 'Giostra nel Fango',
  rule: 'Butta gli altri cavalieri giù dal palco, nel fango!',
  verb: 'CARICA!',
  inspired: 'Mario Party · Bumper Balls',
  cam: 'top',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Carica', b: 'Scudo' },
  duration: 45,
  supports: ['scale'],
  variants: [
    { id: 'olio', name: 'Palco Insaponato', desc: 'Le lavandaie hanno lavato il palco: si scivola tantissimo!' },
    { id: 'ciambella', name: 'Pozzo nel Mezzo', desc: 'Al centro del palco si apre un pozzo che si allarga!' },
    { id: 'lievitata', name: 'Bernoccoli Giganti', desc: 'Chi le prende si gonfia di bernoccoli e diventa pesante!' },
  ],
  help: {
    goal: "Butta gli altri giù dal palco nel fango: chi ci cade 2 volte è fuori. L'ultimo in piedi vince (o chi è caduto meno allo scadere).",
    dir: 'Muovi il cavaliere: ha inerzia, frena in anticipo vicino al bordo!',
    a: 'CARICA: spallata potentissima nella direzione in cui guardi (si ricarica in 1 s, anello pieno = pronta).',
    b: "SCUDO: per mezzo secondo pianti i piedi e nessuno ti sposta. Se ti arriva una carica appena alzato: PARATA e l'altro rimbalza via!",
    tips: ['Il palco si restringe ogni 10 s: le assi che cedono lampeggiano prima', 'La pozione di fuoco 🧪 dà cariche più forti e veloci per 6 s', "Carica contro scudo perde: aspetta che l'altro lo alzi"],
  },

  init(g) {
    const n = g.n || 2;
    const sc = g.mods.scale || [];
    const s = {
      t: 0, plate: PLATE_R, hole: 0, falls: Array(n).fill(0), pause: 0, shrinkAt: SHRINK_EVERY, respawnAt: 0,
      chili: null, chiliAt: CHILI_FIRST,
      p: [...Array(n).keys()].map((i) => {
        const k = sc[i] ?? 1;
        return { i, x: 0, y: 0, vx: 0, vy: 0, r: BALL_R * k, m: k * k, fall: 0, dash: 0, dn: 0, cd: 0, fx: 0, fy: 0, swell: 0, hitT: 0, anchor: 0, acd: 0, hot: 0, elim: false };
      }),
    };
    spawn(s);
    s.pause = 0; // the host countdown already gave everyone time: move right away
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.t = g.t;
    const keep = g.variant === 'olio' ? 0.75 : 0.18;
    // The stage shrinks every 10 s (the band that gives way blinks beforehand).
    if (g.t >= s.shrinkAt) {
      s.shrinkAt += SHRINK_EVERY;
      if (s.plate > PLATE_MIN) { s.plate = Math.max(PLATE_MIN, s.plate - SHRINK_STEP); g.sfx('shrink'); g.say('IL PALCO CEDE!'); g.shake(0.3); }
    }
    if (g.variant === 'ciambella') s.hole = clamp((g.t - 3) * 9, 0, 190);

    // Fire potion power-up.
    if (s.chili) {
      s.chili.life -= dt;
      if (s.chili.life <= 0 || dist(s.chili.x, s.chili.y, CX, CY) > s.plate - 10 || dist(s.chili.x, s.chili.y, CX, CY) < s.hole + 10) {
        g.burst(s.chili.x, s.chili.y, { color: '#ff5a2a', n: 8, speed: 120 });
        s.chili = null; s.chiliAt = g.t + CHILI_EVERY;
      }
    } else if (g.t >= s.chiliAt && !g.ended) {
      const c = chiliSpot(s, g);
      s.chili = { x: c.x, y: c.y, life: CHILI_LIFE };
      g.sfx('powerup', { vol: 0.6 }); g.ring(c.x, c.y, { color: '#ff5a2a', r: 90 });
    }

    if (s.pause > 0) { s.pause -= dt; return; }

    for (const p of s.p) {
      if (p.fall > 0 || p.elim) continue;
      const i = inp[p.i];
      p.cd = Math.max(0, p.cd - dt * (p.hot > 0 ? 2 : 1));
      p.acd = Math.max(0, p.acd - dt);
      p.hitT = Math.max(0, p.hitT - dt);
      p.hot = Math.max(0, p.hot - dt);
      p.anchor = Math.max(0, p.anchor - dt);
      if (Math.hypot(i.x, i.y) > 0.2) { const n = norm(i.x, i.y); p.fx = n.x; p.fy = n.y; }
      if (p.dash > 0) p.dash -= dt;
      else if (p.anchor > 0) {
        // Shield up: feet planted, almost no sliding.
        const k = damp(0.0005, dt);
        p.vx *= k; p.vy *= k;
      } else {
        p.vx += i.x * ACCEL * dt; p.vy += i.y * ACCEL * dt;
        const k = damp(keep, dt);
        p.vx *= k; p.vy *= k;
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > MAX_SPEED) { p.vx *= MAX_SPEED / sp; p.vy *= MAX_SPEED / sp; }
      }
      if (i.aP && p.cd <= 0 && p.anchor <= 0) {
        const pow = p.hot > 0 ? 1.25 : 1;
        p.vx = p.fx * DASH_SPEED * pow; p.vy = p.fy * DASH_SPEED * pow;
        p.dash = DASH_TIME; p.cd = DASH_CD; p.dn++;
        g.sfx('dash', { pitch: p.hot > 0 ? 1.3 : 1 }); g.burst(p.x, p.y, { color: p.hot > 0 ? '#ff7a2a' : null, player: p.i, n: 10, speed: 200 });
      } else if (i.bP && p.acd <= 0 && p.dash <= 0) {
        p.anchor = ANCHOR_TIME; p.acd = ANCHOR_CD;
        p.vx *= 0.15; p.vy *= 0.15;
        g.sfx('land', { pitch: 0.7 }); g.ring(p.x, p.y, { player: p.i, r: p.r + 40 });
      }
      p.x += p.vx * dt; p.y += p.vy * dt;

      if (s.chili && dist(p.x, p.y, s.chili.x, s.chili.y) < p.r + CHILI_R) {
        p.hot = CHILI_TIME; p.cd = 0;
        g.sfx('fire'); g.sfx('powerup', { pitch: 1.3, vol: 0.6 });
        g.text(p.x, p.y - p.r - 30, 'FUOCO!', { color: '#ff7a2a', size: 50 });
        g.burst(s.chili.x, s.chili.y, { color: '#ff5a2a', n: 20, speed: 300 });
        g.vibrate(p.i, 60);
        s.chili = null; s.chiliAt = g.t + CHILI_EVERY;
      }
    }

    // Knight vs knight (every pair of knights still on the stage).
    const on = s.p.filter((p) => !p.fall && !p.elim);
    for (let a = 0; a < on.length; a++) for (let b = a + 1; b < on.length; b++) bump(on[a], on[b], g);

    // Falling off the stage (or into the well). Everyone checked before deciding (no player-order advantage).
    const out = [];
    for (const p of s.p) {
      if (p.fall > 0) {
        p.fall += dt;
        p.vx *= damp(0.2, dt); p.vy *= damp(0.2, dt);
        p.x += p.vx * dt * 0.3; p.y += p.vy * dt * 0.3;
        continue;
      }
      if (p.elim) continue;
      const d = dist(p.x, p.y, CX, CY);
      if (d > s.plate + p.r * 0.35 || (s.hole > 0 && d < s.hole - p.r * 0.35)) out.push(p);
    }
    if (out.length && !g.ended) {
      for (const p of out) {
        p.fall = 0.001; p.anchor = 0; p.hot = 0;
        s.falls[p.i]++;
        g.burst(p.x, p.y, { color: '#6b4a2a', n: 30, speed: 300, size: 10 });
        g.vibrate(p.i, 200);
      }
      g.sfx('fall'); g.sfx('splash', { vol: 0.8 }); g.shake(0.6);
      const lost = out.filter((p) => s.falls[p.i] >= FALLS_TO_LOSE);
      const alive = s.p.filter((p) => !p.elim && s.falls[p.i] < FALLS_TO_LOSE);
      if (lost.length && alive.length <= 1) {
        // Last one standing; if the last ones fall together, the one least far off the stage survives.
        const edge = (p) => { const d = dist(p.x, p.y, CX, CY); return s.hole > 0 && d < s.hole ? s.hole - d : d - s.plate; };
        const win = alive.length ? alive[0] : lost.reduce((best, p) => (edge(p) <= edge(best) ? p : best));
        g.slowmo(0.35, 0.8);
        g.end(win.i, 'Nel fango!');
      } else {
        for (const p of lost) p.elim = true;
        g.say(lost.length ? 'FUORI DAL TORNEO!' : out.length > 1 ? 'TUTTI NEL FANGO!' : 'NEL FANGO!');
        s.respawnAt = g.t + 1.3;
      }
    }
    if (s.respawnAt && g.t >= s.respawnAt && !g.ended) { s.respawnAt = 0; spawn(s); g.sfx('boing'); }
  },

  timeout(s) {
    // Fewest falls among the knights still in; tiebreak: who is closer to the center (a falling knight is very far).
    const far = (p) => (p.fall > 0 ? 1e6 : dist(p.x, p.y, CX, CY));
    let best = null;
    for (const p of s.p) {
      if (p.elim) continue;
      if (!best || s.falls[p.i] < s.falls[best.i] || (s.falls[p.i] === s.falls[best.i] && far(p) < far(best))) best = p;
    }
    return best ? best.i : 0;
  },

  bot: sumoBot,

  view(s) {
    const warn = s.plate > PLATE_MIN && s.shrinkAt - s.t < SHRINK_WARN ? 1 : 0;
    return {
      plate: r1(s.plate), hole: r1(s.hole), wn: warn,
      ch: s.chili ? { x: r1(s.chili.x), y: r1(s.chili.y), l: r2(s.chili.life) } : null,
      p: s.p.map((p) => ({
        x: r1(p.x), y: r1(p.y), r: r1(p.r), f: r2(p.fall), d: p.dash > 0 ? 1 : 0, k: p.dn % 8, h: r2(p.hitT), fx: r2(p.fx), fy: r2(p.fy),
        cd: r2(p.cd), an: r2(p.anchor), ac: r2(p.acd), hot: r2(p.hot), vx: Math.round(p.vx), vy: Math.round(p.vy), e: p.elim ? 1 : 0,
      })),
      hud: { p: s.falls.map((f) => FALLS_TO_LOSE - f), max: FALLS_TO_LOSE, label: 'Vite' },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  render3d: {
    // Every model used by the scenery (downloaded before build; characters are added by the framework).
    assets: [
      'medieval/building_castle_red', 'medieval/building_tower_A_red', 'medieval/building_tower_B_blue', 'medieval/wall_straight',
      'medieval/building_stage_A', 'medieval/building_stage_C', 'medieval/tent', 'medieval/fence_wood_straight',
      'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow',
      'medieval/weaponrack', 'medieval/target', 'medieval/barrel', 'medieval/crate_A_big', 'medieval/sack', 'medieval/wheelbarrow',
      'medieval/rock_single_A', 'medieval/rock_single_C', 'medieval/rock_single_E',
      'medieval/trees_A_large', 'medieval/trees_B_large', 'medieval/tree_single_A', 'medieval/hills_A_trees', 'medieval/mountain_B_grass_trees',
      'dungeon/torch_lit', 'dungeon/banner_patternA_red', 'dungeon/banner_patternB_blue', 'dungeon/bottle_A_labeled_green',
    ],
    build(K, r) {
      const { THREE } = K;
      const n = r.n || K.n || 2;
      K.theme('tramonto', { fogNear: 2.2, fogFar: 6 });
      const PLATE_H = 26;
      const o = { PLATE_H, n, flags: [] };
      const lo = K.quality === 0;
      // Tournament meadow, trodden earth around the pit, then the mud itself (glossy, slowly flowing).
      K.ground('prato', { tile: 220 });
      K.layer({ x0: CX - 900, y0: CY - 900, x1: CX + 900, y1: CY + 900, h: 0.4, transparent: true, once: true, maxPx: 1024, draw: (d) => drawLists(d) });
      const mudTex = K.tex('acqua', { rep: [5, 5], seed: 9 });
      const mudMap = mudTex && mudTex.clone ? mudTex.clone() : null;
      if (mudMap) { mudMap.needsUpdate = true; mudMap.wrapS = mudMap.wrapT = THREE.RepeatWrapping; mudMap.repeat.set(5, 5); }
      const mudMat = new THREE.MeshStandardMaterial({ map: mudMap, color: '#d09a5e', roughness: 0.28, metalness: 0.05, emissive: '#5a3414', emissiveIntensity: 0.75 });
      const mudGeo = new THREE.CircleGeometry(MUD_R, 64).rotateX(-Math.PI / 2);
      const mud = K.mesh(mudGeo, mudMat, { cast: false });
      mud.userData.ownGeo = true; mud.receiveShadow = true;
      K.place(mud, CX, CY, 1.2);
      o.mudMap = mudMap;
      // Mud bubbles (pool of rings that grow and pop).
      o.bub = [];
      for (let k = 0; k < (lo ? 5 : 10); k++) {
        const b = K.torus(1, 0.18, K.mat('#9b7448', { rough: 0.3 }), { cast: false });
        const a = k * 2.39, rr = 470 + (k % 3) * 40;
        o.bub.push({ b, x: CX + Math.cos(a) * rr, y: CY + Math.sin(a) * rr, ph: k * 0.37 });
      }
      // Stones on the bank of the pit.
      const rocks = [];
      for (let k = 0; k < 44; k++) {
        const a = (k / 44) * TAU + (k % 3) * 0.03;
        rocks.push({ x: CX + Math.cos(a) * (MUD_R + 10 + (k % 4) * 9), y: CY + Math.sin(a) * (MUD_R + 10 + (k % 4) * 9), rot: k * 1.7, s: 0.7 + (k % 5) * 0.15 });
      }
      K.scatter('medieval/rock_single_A', rocks.filter((_, k) => k % 3 === 0), { size: 70 });
      K.scatter('medieval/rock_single_C', rocks.filter((_, k) => k % 3 === 1), { size: 60 });
      K.scatter('medieval/rock_single_E', rocks.filter((_, k) => k % 3 === 2), { size: 66 });

      // The stage: squat wooden drum (scaled to the current radius) with the painted plank top on it.
      o.plate = K.cyl(1, PLATE_H, K.texMat('legno', [10, 1], { color: '#c99a66' }), { seg: 64 });
      o.rim = K.torus(1, 0.035, K.mat('#5d6470', { rough: 0.4, metal: 0.5 }));
      o.top = K.layer({
        x0: CX - 470, y0: CY - 470, x1: CX + 470, y1: CY + 470, h: PLATE_H + 0.5, transparent: true,
        draw: (d, v) => drawStage(d, v, true),
        key: (v) => `${v.plate}|${v.hole}|${v.wn && Math.sin(K.t * 22) > 0 ? 1 : 0}`,
      });
      // Stilts under the stage (seen when it shrinks) sinking into the mud.
      const stilt = K.texMat('legno', [1, 2], { color: '#7a5532' });
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * TAU;
        K.place(K.cyl(14, PLATE_H, stilt, { seg: 8 }), CX + Math.cos(a) * 250, CY + Math.sin(a) * 250);
      }

      // Palisade ring with four gates; at each gate the team flag of the seat that starts on that side.
      const fence = [];
      const FR = 720, segs = 40;
      for (let k = 0; k < segs; k++) {
        const a = ((k + 0.5) / segs) * TAU;
        const gate = Math.abs(Math.sin(2 * a)) < 0.09;
        if (gate) continue;
        fence.push({ x: CX + Math.cos(a) * FR, y: CY + Math.sin(a) * FR, rot: a });
      }
      K.scatter('medieval/fence_wood_straight', fence, { size: (TAU * FR) / segs + 6 });
      const gates = [[CX, CY + FR], [CX, CY - FR], [CX - FR, CY], [CX + FR, CY]];
      gates.forEach(([x, y], k) => {
        // Gate posts with torches.
        for (const s of [-1, 1]) {
          const px = x + (k < 2 ? s * 70 : 0), py = y + (k < 2 ? 0 : s * 70);
          K.place(K.model('dungeon/torch_lit', { height: 70 }), px, py);
        }
        if (k < n) {
          const slot = K.roster[k]?.color ?? k;
          const f = K.model(`medieval/flag_${FLAG[slot] || 'red'}`, { height: 190 });
          const fx = x + SIDE[k][0] * 70, fy = y + SIDE[k][1] * 70;
          K.place(f, fx, fy);
          K.face(f, Math.atan2(CY - fy, CX - fx));
          o.flags.push({ f, base: f.rotation.y, ph: k });
        }
      });
      if (!lo) {
        K.light(CX, CY - FR, 90, '#ffb35c', 2.2, { flicker: 0.5, dist: 520 });
        K.light(CX - FR, CY, 90, '#ffb35c', 1.8, { flicker: 0.5, dist: 480 });
        K.light(CX + FR, CY, 90, '#ffb35c', 1.8, { flicker: 0.5, dist: 480 });
      }

      // Castle on the far side, curtain walls and towers.
      const castle = K.model('medieval/building_castle_red', { height: 560 });
      K.place(castle, CX, -720);
      K.face(castle, Math.PI / 2);
      const wall = [];
      for (let k = -5; k <= 5; k++) if (Math.abs(k) > 1) wall.push({ x: CX + k * 190, y: -560, rot: 0 });
      K.scatter('medieval/wall_straight', wall, { size: 200 });
      for (const x of [CX - 1080, CX + 1080]) K.place(K.model('medieval/building_tower_A_red', { height: 420 }), x, -560);
      K.place(K.model('medieval/building_tower_B_blue', { height: 360 }), CX - 620, -620);
      K.place(K.model('medieval/building_tower_B_blue', { height: 360 }), CX + 620, -620);
      // Royal stands on the long sides, facing the arena, with banners.
      for (const s of [-1, 1]) {
        const st = K.model('medieval/building_stage_A', { size: 380 });
        K.place(st, CX + s * 1150, CY - 80);
        K.face(st, s < 0 ? 0 : Math.PI);
        const st2 = K.model('medieval/building_stage_C', { size: 300 });
        K.place(st2, CX + s * 1130, CY + 420);
        K.face(st2, s < 0 ? 0 : Math.PI);
        for (const y of [CY - 330, CY + 170]) {
          const b = K.model(s < 0 ? 'dungeon/banner_patternA_red' : 'dungeon/banner_patternB_blue', { height: 200 });
          K.place(b, CX + s * 960, y);
          K.face(b, s < 0 ? 0 : Math.PI);
        }
      }
      // Knights' camp: tents, racks, targets, barrels, crates and sacks around the palisade.
      const tents = [[-380, -220, 0.6], [1380, -220, 2.6], [-420, 1220, -0.6], [1420, 1220, -2.5], [-700, 520, 0.1], [1700, 520, 3.1]];
      for (const [x, y, a] of tents) { const t = K.model('medieval/tent', { size: 260 }); K.place(t, x, y); K.face(t, a); }
      const props = (name, list, size) => K.scatter(name, list.map(([x, y, rot]) => ({ x, y, rot })), { size });
      props('medieval/weaponrack', [[-200, 330, 0], [1200, 330, Math.PI], [-170, 760, 0.3], [1170, 760, 2.8]], 80);
      props('medieval/target', [[-560, 140, 0.4], [1560, 140, 2.7], [-560, 860, -0.4]], 90);
      props('medieval/barrel', [[-120, 1080, 0], [-80, 1120, 1], [-150, 1150, 2], [1120, 1090, 0], [1160, 1140, 1], [1240, -60, 0], [-240, -60, 1]], 50);
      props('medieval/crate_A_big', [[-190, 1060, 0.3], [1210, 1150, 0.2], [1300, -20, 0.5], [-300, -10, 0.1]], 60);
      props('medieval/sack', [[-60, 1180, 0], [1060, 1180, 1], [1340, 40, 2], [-340, 60, 0.5]], 46);
      props('medieval/wheelbarrow', [[-260, 1240, 0.8], [1280, 1250, 2.2]], 90);
      // Woods and hills all around (the far side is the castle, so trees go on the other three).
      const trees = [], trees2 = [], singles = [];
      for (let k = 0; k < (lo ? 26 : 52); k++) {
        const a = (k / (lo ? 26 : 52)) * TAU + (k % 2) * 0.05;
        if (Math.sin(a) < -0.55) continue; // castle side
        const rr = 1500 + (k % 4) * 140;
        (k % 2 ? trees : trees2).push({ x: CX + Math.cos(a) * rr * 1.25, y: CY + Math.sin(a) * rr, rot: k * 0.9, s: 0.85 + (k % 3) * 0.15 });
      }
      for (let k = 0; k < 18; k++) {
        const a = (k / 18) * TAU + 0.1;
        if (Math.sin(a) < -0.5) continue;
        singles.push({ x: CX + Math.cos(a) * 1050 * 1.3, y: CY + Math.sin(a) * 1050, rot: k, s: 0.8 + (k % 3) * 0.2 });
      }
      K.scatter('medieval/trees_A_large', trees, { size: 300 });
      K.scatter('medieval/trees_B_large', trees2, { size: 320 });
      K.scatter('medieval/tree_single_A', singles, { size: 150 });
      K.scatter('medieval/hills_A_trees', [{ x: -1300, y: -900, rot: 0.3 }, { x: 2300, y: -900, rot: 2 }, { x: -1600, y: 400, rot: 1 }, { x: 2600, y: 500, rot: 4 }], { size: 900 });
      K.scatter('medieval/mountain_B_grass_trees', [{ x: CX - 1500, y: -1700, rot: 0.5 }, { x: CX + 1600, y: -1800, rot: 2 }, { x: CX, y: -2200, rot: 1 }], { size: 1500 });
      K.ambient('petali', { n: 50, x0: -300, y0: -300, x1: 1300, y1: 1300, h: 450 });
      K.ambient('polvere', { n: 40, x0: 0, y0: 0, x1: 1000, y1: 1000, h: 200 });

      // Fire potion: bottle model + glow.
      o.chili = K.model('dungeon/bottle_A_labeled_green', { height: 64 });
      o.chiliGlow = K.disc(1, K.glow('#ff7a2a', { opacity: 0.4, add: true }));
      o.chiliFx = [0, 1, 2].map(() => K.ball(1, K.glow('#ffb347', { add: true }), { cast: false }));
      // Knights, fire auras, shield rings and ground indicators.
      o.pl = [...Array(n).keys()].map((i) => {
        const flames = [];
        for (let k = 0; k < 6; k++) flames.push(K.ball(1, K.glow(k % 2 ? '#ffc828' : '#ff501e', { add: true }), { cast: false }));
        return {
          av: K.avatar(i),
          flames,
          stone: K.torus(1, 0.16, K.mat('#8d93a3', { rough: 0.9, flat: true })),
          fresh: K.torus(1, 0.1, K.glow('#ffffff', { opacity: 0.8 })),
          dec: K.decal(280),
        };
      });
      return o;
    },
    update(K, o, v, r) {
      const top = o.PLATE_H, t = K.t;
      if (o.mudMap) { o.mudMap.offset.x = (t * 0.008) % 1; o.mudMap.offset.y = (t * 0.013) % 1; }
      for (const B of o.bub) {
        const ph = (t * 0.5 + B.ph) % 1;
        K.place(B.b, B.x, B.y, 2);
        B.b.scale.set(4 + ph * 22, 30, 4 + ph * 22);
        B.b.visible = ph < 0.9;
      }
      for (const F of o.flags) F.f.rotation.y = F.base + Math.sin(t * 1.7 + F.ph) * 0.12;
      o.plate.scale.set(v.plate + 20, 1, v.plate + 20);
      K.place(o.plate, CX, CY);
      o.rim.scale.set(v.plate + 20, 400, v.plate + 20);
      K.place(o.rim, CX, CY, top * 0.55);
      // Potion.
      const ch = v.ch;
      const chOn = !!ch && !(ch.l < 1.5 && Math.floor(t * 10) % 2);
      o.chili.visible = o.chiliGlow.visible = chOn;
      o.chiliFx.forEach((f, k) => {
        f.visible = chOn;
        if (!chOn) return;
        const ph = (t * 0.8 + k / 3) % 1;
        K.place(f, ch.x + Math.sin(t * 3 + k * 2) * 10, ch.y + Math.cos(t * 3 + k * 2) * 10, top + 70 + ph * 70);
        f.scale.setScalar(7 * (1 - ph) + 2);
      });
      if (chOn) {
        K.place(o.chili, ch.x, ch.y, top + 8 + Math.abs(Math.sin(t * 5)) * 16);
        o.chili.rotation.y = t * 2;
        K.place(o.chiliGlow, ch.x, ch.y, top + 1);
        o.chiliGlow.scale.setScalar(CHILI_R + 18 + Math.sin(t * 8) * 5);
      }
      let best = -1;
      if (r.ended) for (const q of v.hud.p) best = Math.max(best, q);
      v.p.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const alive = p.f <= 0 && !p.e;
        if (p.e && p.f <= 0) {
          // Out of the tournament: sits on the bank of its side of the pit, as a pale spectator.
          const [ux, uy] = SIDE[i];
          P.av.set(CX + ux * (MUD_R + 50), CY + uy * (MUD_R + 50), { r: p.r * 0.8, look: Math.atan2(-uy, -ux), alpha: 0.45, anim: 'Sit_Floor_Idle', gear: false });
        } else if (p.f > 0) {
          const k = Math.max(0, 1 - p.f / 0.9);
          P.av.set(p.x, p.y, { r: p.r * (0.6 + k * 0.4), h: top - (1 - k) * 170, look: t * 8, alpha: Math.max(0.05, k), anim: 'Jump_Idle' });
        } else {
          const sp = Math.hypot(p.vx, p.vy);
          const sq = p.an > 0 ? 0.12 : p.d ? 0.08 : 0;
          let anim, animKey;
          if (p.h > 0) anim = 'Hit_A';
          else if (p.an > 0) anim = 'Blocking';
          else if (p.d) { anim = '1H_Melee_Attack_Stab'; animKey = p.k; }
          let mood = 'ok';
          if (r.ended) mood = v.hud.p[i] === best ? 'happy' : 'dizzy';
          if (r.ended && mood === 'happy') anim = 'Cheer';
          const lean = clamp(sp / 2500, 0, 0.3);
          P.av.set(p.x, p.y, { r: p.r, h: top, look: Math.atan2(p.fy, p.fx), mood, squash: sq, lean, walk: clamp(sp / 420, 0, 1), anim, animKey });
        }
        // Flames orbiting a fired-up knight.
        P.flames.forEach((f, k) => {
          f.visible = alive && p.hot > 0;
          if (!f.visible) return;
          const a = t * 4 + (k * TAU) / 6;
          K.place(f, p.x + Math.cos(a) * (p.r + 8), p.y + Math.sin(a) * (p.r + 8), top + p.r * 0.8 + Math.sin(t * 20 + k * 2) * 10);
          f.scale.setScalar(9 + 6 * Math.sin(t * 20 + k * 2));
        });
        // Shield: a heavy stone ring at the feet (white flash = parry window).
        const fresh = p.an > ANCHOR_TIME - PARRY_WINDOW;
        P.stone.visible = alive && p.an > 0;
        P.fresh.visible = alive && p.an > 0 && fresh;
        for (const m of [P.stone, P.fresh]) { K.place(m, p.x, p.y, top + 4); m.scale.set(p.r + 14, p.r + 14, p.r + 14); }
        // Ground indicators: facing arrow + charge/shield recharge rings.
        P.dec.show(alive).at(p.x, p.y, top + 0.8).paint((d) => {
          const lt = K.col(i, 'light');
          const ax = p.fx * (p.r + 22), ay = p.fy * (p.r + 22);
          d.poly([ax + p.fx * 18, ay + p.fy * 18, ax - p.fy * 13, ay + p.fx * 13, ax + p.fy * 13, ay - p.fx * 13], lt + (p.cd <= 0 ? 'ee' : '55'), 'rgba(0,0,0,0.35)', 2);
          if (p.cd <= 0) d.ring(0, 0, p.r + 10, lt + 'cc', 6);
          else d.arc(0, 0, p.r + 10, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / DASH_CD), lt + '99', 6);
          if (p.ac > 0) d.arc(0, 0, p.r + 19, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.ac / ANCHOR_CD), 'rgba(200,210,230,0.7)', 4);
        });
      });
    },
  },

  render(d, v, r) {
    drawMud(d);
    drawStage(d, v);

    // Fire potion: bobbing, glowing, blinking when about to vanish.
    if (v.ch && !(v.ch.l < 1.5 && Math.floor(d.t * 10) % 2)) {
      const bob = Math.sin(d.t * 5) * 6;
      d.shadow(v.ch.x, v.ch.y + 22, 26, 9, 0.3);
      d.circle(v.ch.x, v.ch.y + bob, CHILI_R + 14 + Math.sin(d.t * 8) * 4, 'rgba(255,90,42,0.22)');
      d.ring(v.ch.x, v.ch.y + bob, CHILI_R + 8, 'rgba(255,170,60,0.8)', 3);
      d.emoji('🧪', v.ch.x, v.ch.y + bob, 54);
    }

    v.p.forEach((p, i) => {
      if (p.e && p.f <= 0) {
        const [ux, uy] = SIDE[i] || [0, 0];
        d.avatar(CX + ux * 470, CY + uy * 470, p.r * 0.7, i, { mood: 'dizzy', alpha: 0.4 });
        return;
      }
      if (p.f > 0) {
        const k = Math.max(0, 1 - p.f / 0.7);
        if (k <= 0) return;
        d.circle(p.x, p.y, p.r * (1.6 - k * 0.6), `rgba(70,40,15,${(0.5 * k).toFixed(2)})`);
        d.avatar(p.x, p.y, p.r * k, i, { mood: 'scared', alpha: k, look: d.t * 10 });
        return;
      }
      const sp = Math.hypot(p.vx, p.vy);
      d.shadow(p.x + 8, p.y + 14, p.r * 1.02, p.r * 0.8, 0.32);
      if (sp > 300) {
        const nx = p.vx / sp, ny = p.vy / sp, m = p.d ? 3 : 1;
        for (let k = 1; k <= m; k++) d.circle(p.x - nx * 26 * k, p.y - ny * 26 * k, p.r * (1 - k * 0.12), d.col(i, 'light') + (p.d ? '50' : '28'));
      }
      if (p.hot > 0) {
        for (let k = 0; k < 6; k++) {
          const a = d.t * 4 + (k * TAU) / 6, fl = 8 + 6 * Math.sin(d.t * 20 + k * 2);
          d.circle(p.x + Math.cos(a) * (p.r + 6), p.y + Math.sin(a) * (p.r + 6), fl, k % 2 ? 'rgba(255,200,40,0.8)' : 'rgba(255,80,30,0.75)');
        }
      }
      if (p.an > 0) {
        const fresh = p.an > ANCHOR_TIME - PARRY_WINDOW;
        d.circle(p.x, p.y, p.r + 16, fresh ? 'rgba(255,255,255,0.35)' : 'rgba(120,130,150,0.35)', fresh ? '#ffffff' : '#9aa3b5', fresh ? 6 : 4);
      }
      const sq = p.an > 0 ? 0.28 : p.d ? 0.18 : clamp(sp / 4000, 0, 0.1);
      const mood = p.h > 0 ? 'hurt' : p.an > 0 || p.d || p.hot > 0 ? 'angry' : 'ok';
      d.avatar(p.x, p.y, p.r, i, { look: Math.atan2(p.fy, p.fx), mood, squash: sq });
      const ax = p.x + p.fx * (p.r + 20), ay = p.y + p.fy * (p.r + 20);
      d.poly([ax + p.fx * 14, ay + p.fy * 14, ax - p.fy * 10, ay + p.fx * 10, ax + p.fy * 10, ay - p.fx * 10], d.col(i, 'light') + (p.cd <= 0 ? 'ee' : '55'));
      if (p.cd <= 0) d.ring(p.x, p.y, p.r + 8, d.col(i, 'light') + 'aa', 4);
      else d.arc(p.x, p.y, p.r + 8, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / DASH_CD), d.col(i, 'light') + '77', 4);
      if (p.ac > 0) d.arc(p.x, p.y, p.r + 14, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.ac / ANCHOR_CD), 'rgba(200,210,230,0.5)', 3);
    });
  },
};

// 2D fallback background: a mud pit with slow bubbles.
function drawMud(d) {
  const { ctx } = d;
  const grd = ctx.createRadialGradient(CX, CY, 200, CX, CY, 900);
  grd.addColorStop(0, '#6b4a2a');
  grd.addColorStop(1, '#2e1d0e');
  ctx.fillStyle = grd;
  ctx.fillRect(-300, -300, W + 600, H + 600);
  for (let k = 0; k < 14; k++) {
    const ph = (d.t * 0.6 + k * 0.37) % 1;
    const a = k * 2.4, rr = 470 + (k % 4) * 40;
    d.circle(CX + Math.cos(a) * rr, CY + Math.sin(a) * rr, 4 + ph * 12, null, `rgba(190,150,100,${(0.5 * (1 - ph)).toFixed(2)})`, 3);
  }
}

// Trodden tournament ground around the pit (3D, painted once): sandy ring, lists lines toward the gates.
function drawLists(d) {
  const { ctx } = d;
  const g = ctx.createRadialGradient(CX, CY, MUD_R - 40, CX, CY, 880);
  g.addColorStop(0, 'rgba(120,92,58,1)');
  g.addColorStop(0.55, 'rgba(150,118,76,0.85)');
  g.addColorStop(1, 'rgba(150,118,76,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(CX, CY, 880, 0, TAU); ctx.arc(CX, CY, MUD_R - 6, 0, TAU, true); ctx.fill('evenodd');
  // Hoof prints and pebbles (deterministic).
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let k = 0; k < 500; k++) {
    const a = rnd() * TAU, rr = MUD_R + 20 + rnd() * 220;
    d.circle(CX + Math.cos(a) * rr, CY + Math.sin(a) * rr, 2 + rnd() * 5, rnd() < 0.5 ? 'rgba(80,58,34,0.45)' : 'rgba(200,170,120,0.4)');
  }
}

// The wooden stage seen from above: planks, iron studs, the band that gives way blinking, the well.
function drawStage(d, v, noShadow = false) {
  const { ctx } = d;
  const R = v.plate;
  if (!noShadow) d.circle(CX + 10, CY + 18, R + 22, 'rgba(0,0,0,0.35)');
  d.circle(CX, CY, R + 20, '#6e4a2a', '#3d2614', 4);
  ctx.save();
  ctx.beginPath(); ctx.arc(CX, CY, R, 0, TAU); ctx.clip();
  const PW = 52;
  for (let y = CY - R, k = 0; y < CY + R; y += PW, k++) {
    d.rect(CX - R, y, R * 2, PW - 3, k % 2 ? '#b98a5c' : '#a97b50');
    // Plank joints, staggered.
    const off = (k * 137) % 220;
    for (let x = CX - R + off; x < CX + R; x += 220) d.line(x, y, x, y + PW - 3, 'rgba(60,35,15,0.55)', 3);
    d.line(CX - R, y + PW - 2, CX + R, y + PW - 2, 'rgba(50,28,10,0.6)', 3);
  }
  // Worn center and mud splashes.
  d.circle(CX, CY, R * 0.55, 'rgba(255,230,190,0.12)');
  d.circle(CX - R * 0.45, CY + R * 0.4, 30, 'rgba(90,60,30,0.35)');
  d.circle(CX + R * 0.5, CY - R * 0.35, 22, 'rgba(90,60,30,0.3)');
  d.circle(CX + R * 0.2, CY + R * 0.62, 16, 'rgba(90,60,30,0.3)');
  ctx.restore();
  // Iron band with studs.
  d.ring(CX, CY, R + 10, '#4a4f58', 10);
  for (let k = 0; k < 40; k++) {
    const a = (k * TAU) / 40;
    d.circle(CX + Math.cos(a) * (R + 10), CY + Math.sin(a) * (R + 10), 4, '#c9ced6');
  }
  // Shrink warning: the outer band about to give way blinks red.
  if (v.wn) {
    const al = 0.25 + 0.3 * (Math.sin(d.t * 22) > 0 ? 1 : 0);
    ctx.save();
    ctx.beginPath();
    ctx.arc(CX, CY, R, 0, TAU);
    ctx.arc(CX, CY, Math.max(0, R - SHRINK_STEP), 0, TAU, true);
    ctx.fillStyle = `rgba(255,40,40,${al.toFixed(2)})`;
    ctx.fill('evenodd');
    ctx.restore();
  }
  d.ring(CX, CY, R + 20, '#ffd36b', 4);
  if (v.hole > 1) {
    d.circle(CX, CY, v.hole + 10, '#5a5f68');
    d.circle(CX, CY, v.hole, '#1a0f06');
    d.circle(CX + 6, CY + 8, v.hole * 0.8, 'rgba(90,60,30,0.6)');
    d.circle(CX, CY, v.hole, null, '#ff6b6b', 5);
  }
}
