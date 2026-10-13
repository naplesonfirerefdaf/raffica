// La Soule — medieval rugby-football on the abbey meadow: carry the leather ball into a rival gate.
// A = tackle dive (knocks rivals over, the carrier drops the ball), B = pass / throw (with the ball) or sprint (without).
// Free-for-all: seat k defends the gate on side k (0 bottom, 1 top, 2 left, 3 right) and scores in the others.
// Teams (g.teams): team 0 defends the bottom gate and attacks the top one, team 1 the opposite.
import { clamp, angleDiff, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500;
const L = 70, R = 930, T = 70, B = 930;           // pitch lines
const PR = 34, BR = 16;
const RUN = 335, CARRY = 305, ACC = 2700, ACC_MUD = 700;
const DIVE_V = 920, DIVE_T = 0.24, DIVE_CD = 0.9, DOWN_MISS = 0.32;
const SPRINT_T = 0.6, SPRINT_CD = 2.4, SPRINT_K = 1.45;
const GRAV = 1700, CATCH_H = 78, GOAL_H = 150, PORCH = 52;
const PASS_V = 820, THROW_V = 760, THROW_VH = 380;
const HEAT_MAX = 2.6;                              // Palla Rovente: seconds before it burns your hands
const TARGET = 4, DUR = 50, SHOT_RANGE = 430, SHOT_V = 760;
const SIDE = [[0, 1], [0, -1], [-1, 0], [1, 0]];
const GOAL = SIDE.map(([ux, uy]) => [CX + ux * (CX - L), CY + uy * (CY - T)]);
const MOODS = ['ok', 'happy', 'dizzy', 'angry', 'hurt'];
const TEAMC = ['#ff4b5c', '#3fa9ff'];
const BANNER = ['red', 'blue', 'green', 'yellow'];
const PUDDLES = [[CX, CY, 95], [290, 290, 72], [710, 290, 72], [290, 710, 72], [710, 710, 72]];
const hyp = Math.hypot;

// ---------------------------------------------------------------- helpers
const sideOf = (s, i) => s.pl[i].side;               // the gate a seat defends (team index in team matches)
const goals = (s) => (s.team ? 2 : s.n);             // number of open gates
const inMud = (s, x, y) => s.mud && PUDDLES.some(([px, py, pr]) => hyp(x - px, y - py) < pr);

function seatOfSide(s, k) {
  const p = s.pl.find((q) => q.side === k);
  return p ? p.i : 0;
}

// Keep a body inside the pitch; open gate mouths let it step into the porch (depth PORCH).
function confine(s, o, r) {
  const gw = s.gw, ng = goals(s);
  let hit = false;
  const mouth = (k, lat) => k < ng && Math.abs(lat) < gw - r * 0.3;
  if (o.x < L + r && !(mouth(2, o.y - CY) && o.x > L - PORCH)) { if (!mouth(2, o.y - CY)) { o.x = L + r; o.vx = Math.max(0, o.vx); hit = true; } else { o.x = L - PORCH; o.vx = Math.max(0, o.vx); } }
  if (o.x > R - r && !(mouth(3, o.y - CY) && o.x < R + PORCH)) { if (!mouth(3, o.y - CY)) { o.x = R - r; o.vx = Math.min(0, o.vx); hit = true; } else { o.x = R + PORCH; o.vx = Math.min(0, o.vx); } }
  if (o.y < T + r && !(mouth(1, o.x - CX) && o.y > T - PORCH)) { if (!mouth(1, o.x - CX)) { o.y = T + r; o.vy = Math.max(0, o.vy); hit = true; } else { o.y = T - PORCH; o.vy = Math.max(0, o.vy); } }
  if (o.y > B - r && !(mouth(0, o.x - CX) && o.y < B + PORCH)) { if (!mouth(0, o.x - CX)) { o.y = B - r; o.vy = Math.min(0, o.vy); hit = true; } else { o.y = B + PORCH; o.vy = Math.min(0, o.vy); } }
  // Inside a porch: the posts keep you between them.
  for (let k = 0; k < ng; k++) {
    const [ux, uy] = SIDE[k], [gx, gy] = GOAL[k];
    const depth = (o.x - gx) * ux + (o.y - gy) * uy;
    if (depth > -r * 0.5) {
      const lat = (o.x - gx) * -uy + (o.y - gy) * ux, lim = gw - r * 0.6;
      if (Math.abs(lat) > lim) { const c = clamp(lat, -lim, lim) - lat; o.x += -uy * c; o.y += ux * c; }
    }
  }
  return hit;
}

// Which gate (if any) a point has crossed into.
function crossed(s, x, y, slack) {
  for (let k = 0; k < goals(s); k++) {
    const [ux, uy] = SIDE[k], [gx, gy] = GOAL[k];
    const depth = (x - gx) * ux + (y - gy) * uy, lat = (x - gx) * -uy + (y - gy) * ux;
    if (depth > slack && Math.abs(lat) < s.gw) return k;
  }
  return -1;
}

function newBall(s) {
  return { x: CX, y: CY, h: 330, vx: 0, vy: 0, vh: 0, o: -1, lt: -1, ban: -1, bt: 0, heat: 0, wig: 0, a: 0, run: 0 };
}

function kickoff(s, g, toward = -1) {
  s.pl.forEach((p) => {
    Object.assign(p, { x: p.hx, y: p.hy, vx: 0, vy: 0, a: p.ha, fall: 0, down: 0, dive: 0, sprint: 0, dcd: 0.3 });
  });
  s.ball = newBall(s);
  if (toward >= 0) { s.ball.x += SIDE[toward][0] * 110; s.ball.y += SIDE[toward][1] * 110; }
  s.freeze = 0.8;
  g.sfx('whistle'); g.say("L'ABATE LANCIA LA SOULE!");
}

function release(s, p) {
  const b = s.ball;
  if (b.o !== p.i) return;
  b.o = -1; b.ban = p.i; b.bt = 0.3; b.heat = 0;
}

// The carrier loses the ball: it pops up and away (tackle, burn, wriggle).
function popBall(s, g, p, a, v = 280) {
  const b = s.ball;
  if (b.o !== p.i) return;
  release(s, p);
  b.x = p.x + Math.cos(a) * (p.r + BR); b.y = p.y + Math.sin(a) * (p.r + BR);
  b.h = 50; b.vh = 340; b.vx = Math.cos(a) * v + p.vx * 0.3; b.vy = Math.sin(a) * v + p.vy * 0.3;
  b.lt = p.i; b.bt = 0.45;
}

function fallP(s, g, p, sec, a) {
  p.fall = Math.max(p.fall, sec); p.dive = 0; p.sprint = 0; p.sad = sec + 0.4;
  popBall(s, g, p, a + g.rng.range(-0.5, 0.5));
  g.vibrate(p.i, 140);
}

function goal(s, g, k, scorer, carried) {
  const ng = goals(s);
  // In team matches the other team scores; in free-for-all whoever carried/threw it (an own gate gives nobody a point).
  const by = s.team ? 1 - k : scorer >= 0 && sideOf(s, scorer) !== k ? sideOf(s, scorer) : -1;
  if (by >= 0) s.score[by]++;
  s.conc[k]++; s.lastConc = k;
  s.gl[k] = 1; s.gc[k] = by >= 0 ? by : k;
  s.last = by;
  const [gx, gy] = GOAL[k];
  const b = s.ball;
  b.o = -1; b.vx = 0; b.vy = 0; b.vh = 0; b.h = 0; b.x = gx; b.y = gy;
  const fxo = by < 0 ? { color: '#ffffff' } : s.team ? { color: TEAMC[by] } : { player: seatOfSide(s, by) };
  g.sfx('goal'); g.sfx('bigexplode', { vol: 0.5 });
  g.burst(gx, gy, { ...fxo, n: 50, speed: 650, size: 12 });
  g.ring(gx, gy, { ...fxo, r: 380 });
  g.confetti(gx, gy);
  g.shake(0.7); g.flash('#ffffff', 0.35); g.slowmo(0.4, 0.3);
  for (const p of s.pl) {
    if (p.side === k) { p.sad = 2; g.vibrate(p.i, 260); } else if (p.side === by) p.joy = 2;
  }
  if (by >= 0 && s.score[by] >= TARGET) { g.end(seatOfSide(s, by), carried ? 'META DECISIVA!' : 'TIRO DECISIVO!'); return; }
  g.say(by < 0 ? 'AUTOMETA!' : carried ? 'META!' : 'CHE TIRO! PUNTO!');
  s.goalT = 1.5;
  void ng;
}

function decide(s, g) {
  const ks = [...Array(goals(s)).keys()];
  const keep = (list, f) => { const m = Math.max(...list.map(f)); return list.filter((k) => f(k) === m); };
  let c = keep(ks, (k) => s.score[k]);
  if (c.length > 1 && s.ball.o >= 0 && c.includes(sideOf(s, s.ball.o))) c = [sideOf(s, s.ball.o)];
  if (c.length > 1) c = keep(c, (k) => -s.conc[k]);
  if (c.length > 1) {
    // Ball deepest in someone else's half: its attacker gets it.
    const b = s.ball;
    c = keep(c, (k) => -hyp(b.x - GOAL[k][0], b.y - GOAL[k][1]));
  }
  if (c.length > 1 && c.includes(s.last)) c = [s.last];
  const k = c.length > 1 ? c[g.rng.int(0, c.length - 1)] : c[0];
  return seatOfSide(s, k);
}

// B with the ball: a pass to a teammate in that direction, a shot at a rival gate, or a long throw.
function throwBall(s, g, p, inp) {
  const b = s.ball;
  const mag = hyp(inp.x, inp.y);
  const aim = mag > 0.3 ? Math.atan2(inp.y, inp.x) : p.a;
  let tx = null, ty = null, th = 40, kind = 'throw';
  // Teammate in the cone: lead the pass.
  let best = null, bs = 1e9;
  for (const q of s.pl) {
    if (q === p || !g.ally(p.i, q.i) || q.fall > 0) continue;
    const dx = q.x - p.x, dy = q.y - p.y, d = hyp(dx, dy);
    const off = Math.abs(angleDiff(aim, Math.atan2(dy, dx)));
    if (d < 760 && off < 0.7 && off * 300 + d * 0.3 < bs) { bs = off * 300 + d * 0.3; best = q; }
  }
  if (best) {
    const d = hyp(best.x - p.x, best.y - p.y), tt = d / PASS_V;
    tx = best.x + best.vx * tt * 0.9; ty = best.y + best.vy * tt * 0.9; kind = 'pass';
  } else {
    // A rival gate in that direction: aim between the posts.
    for (let k = 0; k < goals(s); k++) {
      if (k === p.side) continue;
      const [gx, gy] = GOAL[k], dx = gx - p.x, dy = gy - p.y, d = hyp(dx, dy);
      if (d < SHOT_RANGE && Math.abs(angleDiff(aim, Math.atan2(dy, dx))) < 0.55) {
        const [ux, uy] = SIDE[k];
        tx = gx + ux * 40; ty = gy + uy * 40; th = 60; kind = 'shot';
        break;
      }
    }
  }
  release(s, p);
  b.lt = p.i; b.h = 55;
  if (tx !== null) {
    const dx = tx - p.x, dy = ty - p.y, d = Math.max(60, hyp(dx, dy));
    const v = kind === 'shot' ? SHOT_V : PASS_V, tt = d / v;
    b.vx = (dx / d) * v; b.vy = (dy / d) * v;
    b.vh = (th - b.h + 0.5 * GRAV * tt * tt) / tt;
  } else {
    b.vx = Math.cos(aim) * THROW_V; b.vy = Math.sin(aim) * THROW_V; b.vh = THROW_VH;
  }
  b.x = p.x + Math.cos(aim) * (p.r * 0.6); b.y = p.y + Math.sin(aim) * (p.r * 0.6);
  p.a = Math.atan2(b.vy, b.vx);
  p.act++; p.an = 2; p.at = 0.45;
  g.sfx(kind === 'shot' ? 'kick' : 'whoosh', { pitch: kind === 'pass' ? 1.2 : 1 });
  if (kind === 'pass') g.text(p.x, p.y - 90, 'PASSA!', { player: p.i, size: 36 });
}

function stepPlayer(s, g, p, inp, dt) {
  p.fall = Math.max(0, p.fall - dt); p.down = Math.max(0, p.down - dt); p.dcd = Math.max(0, p.dcd - dt);
  p.scd = Math.max(0, p.scd - dt); p.sprint = Math.max(0, p.sprint - dt);
  p.joy = Math.max(0, p.joy - dt); p.sad = Math.max(0, p.sad - dt); p.at = Math.max(0, p.at - dt);
  const mud = inMud(s, p.x, p.y);
  const b = s.ball;
  if (p.fall > 0 || p.down > 0) {
    const k = Math.max(0, 1 - (mud ? 1.5 : 7) * dt);
    p.vx *= k; p.vy *= k;
  } else if (p.dive > 0) {
    p.dive -= dt;
    if (p.dive <= 0) { p.down = p.hit ? 0.12 : DOWN_MISS; if (mud) { p.vx *= 0.6; p.vy *= 0.6; } else { p.vx *= 0.2; p.vy *= 0.2; } }
  } else if (s.freeze > 0) {
    p.vx = 0; p.vy = 0;
  } else {
    const mag = Math.min(1, hyp(inp.x, inp.y));
    const hold = b.o === p.i;
    let top = (hold ? CARRY : RUN) * (p.sprint > 0 ? SPRINT_K : 1) * (mud ? 0.8 : 1) * (p.r / PR > 1.2 ? 0.92 : 1);
    if (mag > 0.15) p.a = Math.atan2(inp.y, inp.x);
    const tx = mag > 0.15 ? inp.x * top : 0, ty = mag > 0.15 ? inp.y * top : 0;
    const dx = tx - p.vx, dy = ty - p.vy, dl = hyp(dx, dy), st = (mud || s.mudAll ? ACC_MUD : ACC) * dt;
    if (dl <= st) { p.vx = tx; p.vy = ty; } else { p.vx += (dx / dl) * st; p.vy += (dy / dl) * st; }
    void top;
    if (inp.aP && p.dcd <= 0) {
      p.dive = DIVE_T * (mud ? 1.4 : 1); p.dcd = DIVE_CD; p.hit = false;
      p.vx = Math.cos(p.a) * DIVE_V; p.vy = Math.sin(p.a) * DIVE_V;
      p.act++; p.an = 3; p.at = 0.5;
      g.sfx('dash'); g.burst(p.x, p.y, { color: mud ? '#6b4a2a' : '#cfe8a0', n: 6, speed: 160, size: 6 });
    } else if (inp.bP) {
      if (hold) throwBall(s, g, p, inp);
      else if (p.scd <= 0) { p.sprint = SPRINT_T; p.scd = SPRINT_CD; g.sfx('whoosh', { pitch: 1.3, vol: 0.6 }); g.burst(p.x, p.y, { color: '#ffffff', n: 5, speed: 140 }); }
    }
  }
  p.x += p.vx * dt; p.y += p.vy * dt;
  confine(s, p, p.r);
}

function stepBall(s, g, dt) {
  const b = s.ball;
  if (s.goalT > 0) return; // the ball rests in the gate until the restart
  b.bt = Math.max(0, b.bt - dt);
  if (b.bt <= 0) b.ban = -1;
  if (b.o >= 0) {
    const p = s.pl[b.o];
    b.x = p.x + Math.cos(p.a) * p.r * 0.5; b.y = p.y + Math.sin(p.a) * p.r * 0.5; b.h = 46;
    b.vx = p.vx; b.vy = p.vy; b.vh = 0; b.a = p.a;
    if (s.hot) {
      b.heat += dt;
      if (b.heat > HEAT_MAX) {
        g.sfx('fire'); g.text(p.x, p.y - 90, 'SCOTTA!', { color: '#ff7a2a', size: 50 });
        g.burst(p.x, p.y - 30, { color: '#ff7a2a', n: 18, speed: 300 });
        p.fall = 0.35; p.sad = 1;
        popBall(s, g, p, p.a, 300);
        b.heat = 0;
      }
    }
    if (s.pig) {
      b.wig -= dt;
      if (b.wig <= 0) {
        b.wig = g.rng.range(1.3, 2.8);
        g.sfx('squish'); g.sfx('quack', { pitch: 0.6, vol: 0.6 });
        g.text(p.x, p.y - 90, 'SGUSCIATO!', { color: '#ff9ec4', size: 46 });
        popBall(s, g, p, p.a + g.rng.range(-2, 2), 340);
      }
    }
    // Carrying it over the line = META.
    if (!g.ended && s.freeze <= 0) {
      const k = crossed(s, p.x, p.y, 4);
      if (k >= 0) goal(s, g, k, p.i, true);
    }
    return;
  }
  if (s.hot) b.heat = Math.max(0, b.heat - dt * 2);
  // Flight / bounce / roll.
  if (b.h > 0 || b.vh > 0) {
    b.vh -= GRAV * dt; b.h += b.vh * dt;
    if (b.h <= 0) {
      b.h = 0;
      if (b.vh < -160) { b.vh = -b.vh * 0.42; g.sfx('bounce', { vol: 0.4 }); } else b.vh = 0;
      b.vx *= 0.75; b.vy *= 0.75;
    }
  } else {
    const k = Math.pow(inMud(s, b.x, b.y) ? 0.02 : 0.3, dt);
    b.vx *= k; b.vy *= k;
  }
  // The greased piglet runs off on its own.
  if (s.pig && b.h <= 0) {
    let near = null, nd = 1e9;
    for (const p of s.pl) { const d = hyp(p.x - b.x, p.y - b.y); if (d < nd) { nd = d; near = p; } }
    if (near && nd < 230) {
      const a = Math.atan2(b.y - near.y, b.x - near.x) + Math.sin(g.t * 7) * 0.6;
      b.vx += (Math.cos(a) * 250 - b.vx) * Math.min(1, dt * 6); b.vy += (Math.sin(a) * 250 - b.vy) * Math.min(1, dt * 6);
      b.run = 1;
    } else b.run = 0;
  }
  b.x += b.vx * dt; b.y += b.vy * dt;
  if (hyp(b.vx, b.vy) > 30) b.a = Math.atan2(b.vy, b.vx);
  // Through a gate (under the lintel) = point for whoever threw it.
  if (!g.ended && s.freeze <= 0 && b.h < GOAL_H) {
    const k = crossed(s, b.x, b.y, 2);
    if (k >= 0) { goal(s, g, k, b.lt, false); return; }
  }
  const o = { x: b.x, y: b.y, vx: b.vx, vy: b.vy };
  const ovx = b.vx, ovy = b.vy;
  if (confine(s, o, BR)) {
    b.vx = o.vx !== ovx ? -ovx * 0.55 : ovx; b.vy = o.vy !== ovy ? -ovy * 0.55 : ovy;
    if (hyp(ovx, ovy) > 200) g.sfx('bonk', { vol: 0.35 });
  }
  b.x = o.x; b.y = o.y;
  // Catch / pick up.
  if (b.h < CATCH_H && s.freeze <= 0) {
    let best = null, bd = 1e9;
    for (const p of s.pl) {
      if (p.fall > 0 || p.down > 0 || p.i === b.ban) continue;
      const d = hyp(p.x - b.x, p.y - b.y);
      if (d < p.r + BR + 12 && d < bd) { bd = d; best = p; }
    }
    if (best) {
      const fly = b.h > 12;
      const inter = fly && b.lt >= 0 && !g.ally(b.lt, best.i);
      b.o = best.i; b.lt = best.i; b.heat = 0; b.wig = g.rng.range(1.2, 2.6);
      best.act++; best.an = 1; best.at = 0.25;
      g.sfx(fly ? 'pickup' : 'pop', { pitch: fly ? 1.1 : 0.9 });
      if (inter) { g.text(best.x, best.y - 90, 'INTERCETTO!', { player: best.i, size: 44 }); g.sfx('zap', { vol: 0.5 }); }
      g.burst(b.x, b.y, { player: best.i, n: 8, speed: 200, size: 6 });
      g.vibrate(best.i, 40);
    }
  }
}

// ---------------------------------------------------------------- bot
function landing(b) {
  // Time until the ball comes down to catch height (or now if it is low), and where.
  if (b.h <= CATCH_H && b.vh <= 0) return { x: b.x, y: b.y, t: 0 };
  const h0 = b.h - CATCH_H * 0.6, v = b.vh;
  const t = (v + Math.sqrt(Math.max(0, v * v + 2 * GRAV * h0))) / GRAV;
  return { x: clamp(b.x + b.vx * t, L, R), y: clamp(b.y + b.vy * t, T, B), t };
}

// Rival nearest to the segment a→b (lane blocked?).
function laneGap(s, me, ax, ay, bx, by, g) {
  let gap = 1e9;
  const dx = bx - ax, dy = by - ay, d2 = dx * dx + dy * dy || 1;
  for (const q of s.pl) {
    if (g.ally(me, q.i) || q.fall > 0) continue;
    const u = clamp(((q.x - ax) * dx + (q.y - ay) * dy) / d2, 0, 1);
    gap = Math.min(gap, hyp(q.x - (ax + dx * u), q.y - (ay + dy * u)));
  }
  return gap;
}

function souleBot(s, me, g, B) {
  const p = s.pl[me];
  if (!p || p.fall > 0 || p.down > 0 || p.dive > 0) return { x: 0, y: 0 };
  const lv = B.level, b = s.ball, ng = goals(s);
  const out = { x: 0, y: 0 };
  const go = (tx, ty, avoid) => {
    let dx = tx - p.x, dy = ty - p.y;
    const d = hyp(dx, dy) || 1;
    dx /= d; dy /= d;
    if (avoid && lv > 0) {
      for (const q of s.pl) {
        if (g.ally(me, q.i) || q.fall > 0) continue;
        const ex = p.x - q.x, ey = p.y - q.y, e = hyp(ex, ey);
        const ahead = (q.x - p.x) * dx + (q.y - p.y) * dy;
        if (e < 230 && e > 0 && ahead > -40) { const k = (1 - e / 230) * (lv === 2 ? 1.6 : 1); dx += (ex / e) * k; dy += (ey / e) * k; }
      }
    }
    if (inMud(s, p.x + dx * 60, p.y + dy * 60) && lv === 2 && d > 150) { const ox = dx; dx += -dy * 0.7; dy += ox * 0.7; }
    const l = hyp(dx, dy) || 1;
    out.x = dx / l; out.y = dy / l;
    return d;
  };
  const mates = s.pl.filter((q) => q !== p && g.ally(me, q.i));
  const rivals = s.pl.filter((q) => !g.ally(me, q.i));
  const myGoal = GOAL[p.side];
  // Rival gate to attack: team → the other one; FFA → the closest open one (the King prefers the leader's).
  const attackGoal = (fx, fy) => {
    if (s.team) return 1 - p.side;
    let best = -1, bs = 1e9;
    for (let k = 0; k < ng; k++) {
      if (k === p.side) continue;
      let sc = hyp(GOAL[k][0] - fx, GOAL[k][1] - fy);
      for (const q of s.pl) if (q.side === k && q.fall <= 0) sc += Math.max(0, 300 - hyp(q.x - GOAL[k][0], q.y - GOAL[k][1])) * 0.6;
      if (lv === 2) sc -= s.score[k] * 60;
      if (sc < bs) { bs = sc; best = k; }
    }
    return best;
  };
  const tackleIf = (q, range) => {
    if (p.dcd > 0 || q.fall > 0) return;
    const px = q.x + q.vx * 0.12, py = q.y + q.vy * 0.12;
    const d = hyp(px - p.x, py - p.y);
    if (d < range && d > 20) {
      const a = Math.atan2(py - p.y, px - p.x);
      if (Math.abs(angleDiff(p.a, a)) < (lv === 2 ? 0.5 : 0.35) || lv === 2) { out.x = Math.cos(a); out.y = Math.sin(a); out.tapA = true; }
    }
  };

  if (b.o === me) {
    const k = attackGoal(p.x, p.y);
    const [gx, gy] = GOAL[k], [ux, uy] = SIDE[k];
    const dg = hyp(gx - p.x, gy - p.y);
    // Aim at the mouth (a bit inside so we cross the line).
    go(gx + ux * 30, gy + uy * 30, true);
    let threat = 1e9, tq = null;
    for (const q of rivals) { if (q.fall > 0) continue; const e = hyp(q.x - p.x, q.y - p.y); if (e < threat) { threat = e; tq = q; } }
    const hot = s.hot && b.heat > HEAT_MAX * (lv === 2 ? 0.55 : 0.75);
    // Shot when the lane is free and the gate is near.
    if (lv > 0 && dg < (lv === 2 ? SHOT_RANGE - 20 : 330) && laneGap(s, me, p.x, p.y, gx, gy, g) > 70 && threat < (lv === 2 ? 240 : 200) && dg > 120) {
      out.x = (gx - p.x) / dg; out.y = (gy - p.y) / dg; out.tapB = true; return out;
    }
    // Pass to an open mate further ahead when pressed (or when the ball burns).
    if ((threat < (lv === 2 ? 200 : 150) || hot) && mates.length && lv > 0) {
      let bm = null, bsc = -1e9;
      for (const m of mates) {
        if (m.fall > 0 || m.down > 0) continue;
        const gap = laneGap(s, me, p.x, p.y, m.x, m.y, g);
        const md = hyp(m.x - p.x, m.y - p.y);
        if (gap < 75 || md > 680 || md < 90) continue;
        const sc = gap - hyp(gx - m.x, gy - m.y) * 0.5 + 300;
        if (sc > bsc) { bsc = sc; bm = m; }
      }
      if (bm) { const md = hyp(bm.x - p.x, bm.y - p.y); out.x = (bm.x - p.x) / md; out.y = (bm.y - p.y) / md; out.tapB = true; return out; }
    }
    if (hot && lv > 0) { out.tapB = true; return out; } // get rid of it
    // Easy bot: sometimes throws toward the gate from far.
    if (lv === 0 && dg < 300 && B.rng() < 0.01) { out.x = (gx - p.x) / dg; out.y = (gy - p.y) / dg; out.tapB = true; }
    void tq;
    return out;
  }

  const carrier = b.o >= 0 ? s.pl[b.o] : null;
  if (carrier && g.ally(me, carrier.i)) {
    // Support: run ahead on the open side, and flatten whoever chases the carrier.
    if (lv > 0) {
      for (const q of rivals) {
        if (q.fall > 0) continue;
        if (hyp(q.x - carrier.x, q.y - carrier.y) < 230 && hyp(q.x - p.x, q.y - p.y) < 260) {
          go(q.x + q.vx * 0.15, q.y + q.vy * 0.15, false);
          tackleIf(q, 190);
          return out;
        }
      }
    }
    const k = attackGoal(carrier.x, carrier.y);
    const [gx, gy] = GOAL[k];
    const dx = gx - carrier.x, dy = gy - carrier.y, d = hyp(dx, dy) || 1;
    let side = (p.x - carrier.x) * (-dy / d) + (p.y - carrier.y) * (dx / d) >= 0 ? 1 : -1;
    const ahead = Math.min(240, d * 0.5);
    const tx = clamp(carrier.x + (dx / d) * ahead + (-dy / d) * side * 210, L + 60, R - 60);
    const ty = clamp(carrier.y + (dy / d) * ahead + (dx / d) * side * 210, T + 60, B - 60);
    go(tx, ty, true);
    return out;
  }

  if (carrier) {
    // Defend. The mate nearer to the carrier presses; the other covers the gate or the passing lane.
    const ct = carrier.x + carrier.vx * 0.3, cy = carrier.y + carrier.vy * 0.3;
    const myD = hyp(ct - p.x, cy - p.y);
    const presser = !mates.some((m) => m.fall <= 0 && m.down <= 0 && hyp(ct - m.x, cy - m.y) < myD - 30);
    const theirGoal = s.team ? myGoal : null;
    if (presser || !s.team || lv === 0) {
      const lead = lv === 2 ? clamp(myD / 700, 0.1, 0.5) : 0.2;
      go(carrier.x + carrier.vx * lead, carrier.y + carrier.vy * lead, false);
      if (lv > 0 && myD > 260 && p.scd <= 0 && p.sprint <= 0) out.tapB = true;
      tackleIf(carrier, [120, 185, 200][lv]);
      return out;
    }
    // Cover: stand between the carrier and our gate, or on the lane to its open mate (King).
    let tx = theirGoal[0] + (carrier.x - theirGoal[0]) * 0.4, ty = theirGoal[1] + (carrier.y - theirGoal[1]) * 0.4;
    if (lv === 2) {
      const other = s.pl.find((q) => q !== carrier && g.ally(q.i, carrier.i));
      if (other && hyp(other.x - theirGoal[0], other.y - theirGoal[1]) < hyp(carrier.x - theirGoal[0], carrier.y - theirGoal[1])) {
        tx = (carrier.x + other.x) / 2 * 0.4 + other.x * 0.6; ty = (carrier.y + other.y) / 2 * 0.4 + other.y * 0.6;
        tackleIf(other, 170);
      }
    }
    go(tx, ty, false);
    tackleIf(carrier, 170);
    return out;
  }

  // Loose ball (rolling or flying).
  const land = landing(b);
  let bx = land.x, by = land.y;
  if (b.h <= 0 && hyp(b.vx, b.vy) > 30) { const k = lv === 2 ? 0.35 : 0.2; bx = b.x + b.vx * k; by = b.y + b.vy * k; }
  const myD = hyp(bx - p.x, by - p.y);
  const chaser = !mates.some((m) => m.fall <= 0 && m.down <= 0 && hyp(bx - m.x, by - m.y) < myD - 20);
  if (chaser || lv === 0 || !s.team) {
    go(bx, by, false);
    // Dive on a rival about to grab it (better bots), sprint when far.
    if (lv > 0) {
      for (const q of rivals) {
        if (q.fall > 0) continue;
        if (hyp(q.x - bx, q.y - by) < 90 && hyp(q.x - p.x, q.y - p.y) < 200 && myD > 80) { tackleIf(q, 190); break; }
      }
      if (myD > 300 && p.scd <= 0 && b.ban !== me) out.tapB = true;
    }
    if (b.ban === me && b.bt > 0) out.tapB = false;
    return out;
  }
  // The other mate stays between the ball and our gate.
  const tx = myGoal[0] + (bx - myGoal[0]) * 0.45, ty = myGoal[1] + (by - myGoal[1]) * 0.45;
  go(tx, ty, false);
  return out;
}

export default {
  id: 'soule',
  name: 'La Soule',
  rule: 'Porta la palla di cuoio nella porta avversaria!',
  verb: 'PLACCA!',
  inspired: 'Soule medievale · Calcio fiorentino · Rugby',
  cam: 'top',
  split: false,
  players: 4,
  teams: true,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Placca', b: 'Passa' },
  duration: DUR,
  supports: ['scale'],
  help: {
    goal: `Porta la soule (la palla di cuoio) oltre la porta di un rivale, o tirala sotto l'arco: ${TARGET} punti e vinci. A squadre: 2 contro 2, due porte.`,
    dir: 'Corri per il prato. Con la palla in mano sei un po’ più lento.',
    a: 'PLACCAGGIO: tuffo in avanti che butta a terra chi colpisci; chi ha la palla la perde. Se manchi resti a terra un attimo!',
    b: 'Con la palla: PASSA al compagno nella direzione dello stick, oppure TIRA verso una porta. Senza palla: SCATTO.',
    tips: ['Il passaggio va dove punti lo stick: cerca il compagno libero', 'La palla in volo si può intercettare', 'Lanciata sotto l’arco della porta vale come una meta'],
  },
  variants: [
    { id: 'rovente', name: 'Palla Rovente', desc: 'La palla scotta: dopo 2 secondi e mezzo ti brucia le mani!' },
    { id: 'maiale', name: 'Il Porcello Unto', desc: 'Al posto della palla un maialino unto che scappa e sguscia di mano!' },
    { id: 'fango', name: 'Prato Fangoso', desc: 'Pozzanghere di fango: si scivola e i placcaggi vanno lunghissimi' },
  ],

  init(g) {
    const n = g.n || 2;
    const team = !!g.teams;
    const sc = g.mods.scale || [];
    const pl = [...Array(n).keys()].map((i) => {
      const side = team ? g.teams[i] : i;
      const mates = [...Array(n).keys()].filter((j) => (team ? g.teams[j] === side : j === i));
      const j = mates.indexOf(i), cnt = mates.length;
      const [ux, uy] = SIDE[side], [gx, gy] = GOAL[side];
      const lat = (j - (cnt - 1) / 2) * 260;
      const hx = gx - ux * 230 + -uy * lat, hy = gy - uy * 230 + ux * lat;
      const q = sc[i] ?? 1;
      return {
        i, side, hx, hy, ha: Math.atan2(-uy, -ux), x: hx, y: hy, vx: 0, vy: 0, a: Math.atan2(-uy, -ux), r: PR * q,
        fall: 0, down: 0, dive: 0, dcd: 0, hit: false, sprint: 0, scd: 0, joy: 0, sad: 0, act: 0, an: 0, at: 0,
      };
    });
    const ng = team ? 2 : n;
    const s = {
      n, team, pl, gw: team ? 135 : 115,
      score: [...Array(ng)].map(() => 0), conc: [...Array(ng)].map(() => 0), gl: [...Array(ng)].map(() => 0), gc: [...Array(ng).keys()],
      last: -1, lastConc: -1, ball: null, freeze: 0, goalT: 0, warned: false,
      hot: g.variant === 'rovente', pig: g.variant === 'maiale', mud: g.variant === 'fango', mudAll: false,
    };
    s.ball = newBall(s);
    s.freeze = 0.6;
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    for (let k = 0; k < s.gl.length; k++) s.gl[k] = Math.max(0, s.gl[k] - dt * 0.7);
    if (!s.warned && g.t >= DUR - 10 && !g.ended) { s.warned = true; g.say('ULTIMI 10 SECONDI!'); g.sfx('matchpoint'); }
    if (s.goalT > 0) {
      s.goalT -= dt;
      if (s.goalT <= 0 && !g.ended) kickoff(s, g, s.lastConc);
    }
    if (s.freeze > 0) {
      s.freeze -= dt;
      if (s.freeze <= 0) g.sfx('horn', { vol: 0.6 });
    }
    s.pl.forEach((p, k) => stepPlayer(s, g, p, inp[k], dt));
    // Bodies: tackles knock rivals down; otherwise just shoulder-to-shoulder bumps.
    for (let a = 0; a < s.pl.length; a++) {
      for (let c = a + 1; c < s.pl.length; c++) {
        const p = s.pl[a], q = s.pl[c];
        const dx = q.x - p.x, dy = q.y - p.y, d = hyp(dx, dy), m = p.r + q.r;
        if (d >= m + 6 || d === 0) continue;
        if (!g.ally(p.i, q.i)) {
          for (const [att, vic] of [[p, q], [q, p]]) {
            if (att.dive > 0 && !att.hit && vic.fall <= 0 && vic.dive <= 0) {
              att.hit = true;
              const carrier = s.ball.o === vic.i;
              g.sfx(carrier ? 'crash' : 'punch'); g.sfx('hit', { vol: 0.6 });
              g.text(vic.x, vic.y - 95, carrier ? 'PLACCATO!' : 'GIÙ!', { player: att.i, size: carrier ? 52 : 40 });
              g.burst((p.x + q.x) / 2, (p.y + q.y) / 2, { color: s.mud && inMud(s, vic.x, vic.y) ? '#6b4a2a' : '#ffffff', n: carrier ? 22 : 12, speed: 360, size: 7 });
              g.shake(carrier ? 0.5 : 0.3); g.hitstop(carrier ? 0.08 : 0.05);
              fallP(s, g, vic, carrier ? 1.0 : 0.7, att.a);
              vic.vx += Math.cos(att.a) * 380; vic.vy += Math.sin(att.a) * 380;
              att.vx *= 0.35; att.vy *= 0.35; att.dive = Math.min(att.dive, 0.05);
            }
          }
          // Two divers collide head-on: both go down.
          if (p.dive > 0 && q.dive > 0 && !p.hit && !q.hit) {
            p.hit = q.hit = true;
            g.sfx('bonk'); g.text((p.x + q.x) / 2, (p.y + q.y) / 2 - 90, 'TESTATA!', { color: '#ffffff', size: 44 });
            fallP(s, g, p, 0.6, q.a); fallP(s, g, q, 0.6, p.a);
          }
        }
        if (d < m) {
          const push = (m - d) / 2, nx = dx / d, ny = dy / d;
          p.x -= nx * push; p.y -= ny * push; q.x += nx * push; q.y += ny * push;
        }
      }
    }
    stepBall(s, g, dt);
  },

  timeout(s, g) {
    return decide(s, g);
  },

  bot: souleBot,

  view(s) {
    const b = s.ball;
    return {
      p: s.pl.map((p) => ({
        x: r1(p.x), y: r1(p.y), a: r2(p.a), st: p.fall > 0 ? 1 : p.down > 0 ? 2 : 0, dv: p.dive > 0 ? 1 : 0, sp: p.sprint > 0 ? 1 : 0,
        rd: p.dcd <= 0 ? 1 : 0, m: p.fall > 0 ? 2 : p.sad > 0 ? 4 : p.joy > 0 ? 1 : p.dive > 0 ? 3 : 0, tm: p.side,
        w: r2(Math.min(1, hyp(p.vx, p.vy) / RUN)), k: p.act, n: p.at > 0 ? p.an : 0, sc: r2(p.r / PR),
      })),
      b: { x: r1(b.x), y: r1(b.y), h: r1(b.h), o: b.o, ht: s.hot ? r2(b.heat / HEAT_MAX) : 0, a: r2(b.a), rn: b.run ? 1 : 0, vx: Math.round(b.vx), vy: Math.round(b.vy) },
      gl: s.gl.map(r2), gc: s.gc.slice(), gw: s.gw, tm: s.team ? 1 : 0, fr: s.freeze > 0 ? 1 : 0,
      hud: { p: s.pl.map((p) => s.score[p.side]), max: TARGET, label: 'Mete' },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  // ---------------------------------------------------------------- 3D: the abbey meadow on feast day
  render3d: {
    assets: [
      'medieval/building_church_green', 'medieval/building_tower_B_green', 'medieval/building_tower_base_green', 'medieval/wall_straight',
      'medieval/wall_corner_A_outside', 'medieval/building_watermill_green', 'medieval/building_bridge_A', 'medieval/building_market_red',
      'medieval/building_market_blue', 'medieval/building_stage_B', 'medieval/tent', 'medieval/building_home_A_green', 'medieval/building_tavern_yellow',
      'medieval/trees_B_large', 'medieval/trees_A_medium', 'medieval/tree_single_A', 'medieval/hills_B_trees', 'medieval/mountain_C_grass_trees',
      'medieval/barrel', 'medieval/crate_A_big', 'medieval/sack', 'medieval/wheelbarrow', 'medieval/rock_single_C', 'medieval/waterplant_A',
      'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow',
      'dungeon/banner_red', 'dungeon/banner_blue', 'dungeon/banner_green', 'dungeon/banner_yellow', 'dungeon/torch_lit',
      'dungeon/keg_decorated', 'dungeon/table_long_tablecloth_decorated_A', 'dungeon/stool',
      'chars/Mage', 'chars/Rogue_Hooded',
    ],
    build(K, r) {
      const { THREE } = K;
      const n = r.n || K.n || 2;
      const lo = K.quality === 0;
      const o = { n, lo, ready: false, pl: [], dummy: new THREE.Object3D(), col: new THREE.Color(), tmpV: new THREE.Vector3(), tmpQ: new THREE.Quaternion() };
      K.theme('alba', { fogNear: 2.3, fogFar: 6.5 });
      K.ground('prato', { tile: 210, margin: 2300, color: '#e8f5c0' });
      // The pitch: mowed stripes, lime lines, gate areas (repainted only if the match shape changes).
      K.layer({
        x0: L - 140, y0: T - 140, x1: R + 140, y1: B + 140, h: 1.2, transparent: true, maxPx: 1024,
        draw: (d, v) => drawPitch(d, v, r.variant, K.col, true),
        key: (v) => `${v.tm}|${v.gl.length}|${v.gw}`,
      });
      // Gate glow after a point.
      o.fx = K.layer({
        x0: L - 80, y0: T - 80, x1: R + 80, y1: B + 80, h: 1.8, transparent: true, z: 1, maxPx: 512,
        draw: (d, v) => drawGlow(d, v, K.col),
        key: (v) => v.gl.map((q) => Math.round(q * 12)).join(','),
      });

      // Abbey on the far side: church, bell tower, cloister walls.
      const bld = (name, x, y, a, size, h) => { const m = K.model(name, h ? { height: h } : { size }); K.place(m, x, y); K.face(m, a); return m; };
      bld('medieval/building_church_green', CX + 60, -330, Math.PI / 2, 470);
      bld('medieval/building_tower_B_green', CX - 300, -300, Math.PI / 2, 0, 470);
      bld('medieval/building_tower_base_green', CX + 430, -250, Math.PI / 2, 190);
      const wall = [];
      for (let k = -6; k <= 6; k++) if (Math.abs(k) > 2) wall.push({ x: CX + k * 175, y: -150, rot: 0 });
      K.scatter('medieval/wall_straight', wall, { size: 180 });
      K.scatter('medieval/wall_corner_A_outside', [{ x: CX - 1140, y: -150, rot: 0 }, { x: CX + 1140, y: -150, rot: Math.PI / 2 }], { size: 180 });
      // Feast: tents, market stalls, a stage with minstrels, the banquet table with kegs.
      bld('medieval/building_stage_B', -330, 520, 0, 260);
      bld('medieval/building_market_red', -300, 120, 0.15, 210);
      bld('medieval/building_market_blue', -300, 900, -0.15, 210);
      bld('medieval/building_tavern_yellow', W + 360, 120, Math.PI - 0.2, 300);
      bld('medieval/building_home_A_green', W + 340, 880, Math.PI + 0.2, 260);
      K.scatter('medieval/tent', [{ x: W + 240, y: 470, rot: Math.PI }, { x: -560, y: 260, rot: 0.3 }, { x: -560, y: 800, rot: -0.3 }, { x: W + 560, y: 560, rot: Math.PI }], { size: 210 });
      const table = K.model('dungeon/table_long_tablecloth_decorated_A', { size: 200 });
      K.place(table, W + 200, 700); K.face(table, Math.PI / 2);
      K.scatter('dungeon/stool', [{ x: W + 160, y: 640 }, { x: W + 160, y: 760 }, { x: W + 240, y: 640 }, { x: W + 240, y: 760 }], { size: 34 });
      K.scatter('dungeon/keg_decorated', [{ x: W + 160, y: 280 }, { x: W + 200, y: 320, rot: 1 }, { x: -150, y: 330, rot: 2 }], { size: 60 });
      const props = (name, list, size) => K.scatter(name, list.map(([x, y, rot]) => ({ x, y, rot })), { size });
      props('medieval/barrel', [[-140, 700, 0], [-110, 740, 1], [W + 130, 980, 2], [W + 160, 1020, 0]], 48);
      props('medieval/crate_A_big', [[-170, 980, 0.4], [W + 120, 60, 0.2]], 56);
      props('medieval/sack', [[-120, 1010, 0], [W + 170, 30, 1], [-150, 50, 2]], 44);
      props('medieval/wheelbarrow', [[-200, -80, 0.6], [W + 220, -60, 2.4]], 90);
      // River at the near side with a bridge and the abbey mill.
      K.water(-1600, B + 260, W + 1600, B + 520, { h: 1.2, flow: [0.03, 0.004] });
      bld('medieval/building_bridge_A', CX, B + 390, 0, 260);
      bld('medieval/building_watermill_green', W + 460, B + 360, Math.PI, 300);
      K.scatter('medieval/rock_single_C', [[-200, B + 250], [300, B + 255], [760, B + 250], [W + 220, B + 240], [-500, B + 260]].map(([x, y], k) => ({ x, y, rot: k })), { size: 60 });
      K.scatter('medieval/waterplant_A', [[-100, B + 280], [620, B + 280], [180, B + 500], [880, B + 500]].map(([x, y], k) => ({ x, y, rot: k })), { size: 60 });
      // Autumn woods and hills.
      const trees = [], trees2 = [];
      for (let k = 0; k < (lo ? 18 : 36); k++) {
        const a = (k / (lo ? 18 : 36)) * TAU + 0.05;
        if (Math.sin(a) < -0.6) continue; // the abbey side
        const rr = 1150 + (k % 3) * 170;
        (k % 2 ? trees : trees2).push({ x: CX + Math.cos(a) * rr * 1.2, y: CY + Math.sin(a) * rr * (Math.sin(a) > 0.5 ? 1.35 : 1), rot: k * 1.1, s: 0.85 + (k % 4) * 0.12 });
      }
      K.scatter('medieval/trees_B_large', trees, { size: 300 });
      K.scatter('medieval/trees_A_medium', trees2, { size: 260 });
      K.scatter('medieval/tree_single_A', [[-260, -160], [W + 260, -170], [-420, 430], [W + 440, 380]].map(([x, y], k) => ({ x, y, rot: k })), { size: 160 });
      K.scatter('medieval/hills_B_trees', [{ x: -1500, y: -900, rot: 0.3 }, { x: 2500, y: -900, rot: 2 }, { x: -1700, y: 900, rot: 1 }, { x: 2700, y: 900, rot: 4 }], { size: 1200 });
      K.scatter('medieval/mountain_C_grass_trees', [{ x: CX - 1000, y: -1900, rot: 0.5 }, { x: CX + 1200, y: -2000, rot: 2 }, { x: CX, y: -2500, rot: 1 }], { size: 1600 });
      K.ambient('foglie', { n: lo ? 25 : 55, x0: -300, y0: -300, x1: W + 300, y1: H + 300, h: 450 });

      // Hay-bale boundary: one instanced mesh (gaps at the gates are hidden per match in update).
      const baleGeo = new THREE.CylinderGeometry(22, 22, 52, 14);
      baleGeo.rotateZ(Math.PI / 2);
      const bales = new THREE.InstancedMesh(baleGeo, K.texMat('paglia', [2, 1], { color: '#f6dc8a' }), 64);
      bales.castShadow = true; bales.receiveShadow = true; bales.count = 0;
      K.root.add(bales);
      o.bales = bales;
      // Festive bunting strung on poles along the long sides (instanced pennants).
      const poleM = K.texMat('legno', [1, 3], { color: '#8a5a32' });
      const poles = [[L - 90, T - 90], [L - 90, CY], [L - 90, B + 90], [R + 90, T - 90], [R + 90, CY], [R + 90, B + 90]];
      for (const [x, y] of poles) K.place(K.cyl(6, 230, poleM, { seg: 7 }), x, y);
      const tri = new THREE.BufferGeometry();
      tri.setAttribute('position', new THREE.Float32BufferAttribute([-11, 0, 0, 11, 0, 0, 0, -30, 0], 3));
      tri.computeVertexNormals();
      const pen = new THREE.InstancedMesh(tri, new THREE.MeshStandardMaterial({ color: '#ffffff', side: THREE.DoubleSide, roughness: 0.7 }), 80);
      pen.castShadow = false;
      K.root.add(pen);
      o.pennants = [];
      const festive = ['#ff4b5c', '#ffd23f', '#3fa9ff', '#5fd35a', '#ffffff', '#ff8fc8'];
      for (const [a, c] of [[0, 1], [1, 2], [3, 4], [4, 5]]) {
        const [x0, y0] = poles[a], [x1, y1] = poles[c];
        for (let j = 1; j < 20; j++) {
          const u = j / 20;
          o.pennants.push({ x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u, h: 222 - Math.sin(Math.PI * u) * 60, rot: Math.atan2(y1 - y0, x1 - x0), ph: j * 0.7 + a });
          pen.setColorAt(o.pennants.length - 1, o.col.set(festive[(j + a) % festive.length]));
        }
      }
      pen.count = o.pennants.length;
      o.pen = pen;
      // Spectator monks and the lord who throws the ball in.
      o.npcs = [
        { av: K.npc('mage', { marker: false }), x: -170, y: 420, a: 0 },
        { av: K.npc('hooded', { marker: false }), x: -170, y: 600, a: 0 },
        { av: K.npc('hooded', { marker: false }), x: W + 170, y: 450, a: Math.PI },
      ];
      if (!lo) {
        K.light(-330, 520, 160, '#ffcf8a', 1.6, { flicker: 0.3, dist: 520 });
        K.light(W + 330, 120, 160, '#ffcf8a', 1.4, { flicker: 0.3, dist: 480 });
      }

      // The ball (leather soule) — or the greased piglet.
      const pig = r.variant === 'maiale';
      o.pig = pig;
      if (pig) {
        const G = K.group();
        const pink = K.mat('#ffadc6', { rough: 0.45 }), dkp = K.mat('#e27a9a', { rough: 0.5 });
        const body = K.ball(1, pink, { parent: G }); body.scale.set(26, 20, 19); body.position.set(0, 22, 0);
        const head = K.ball(13, pink, { parent: G }); head.position.set(24, 30, 0);
        const snout = K.cyl(6, 6, dkp, { parent: G, center: true, seg: 10 }); snout.rotation.z = Math.PI / 2; snout.position.set(37, 28, 0);
        for (const sd of [-1, 1]) {
          const ear = K.cone(5, 9, dkp, { parent: G, seg: 6 }); ear.position.set(22, 40, sd * 7); ear.rotation.x = sd * 0.5;
          const eye = K.ball(2, K.mat('#1a1010'), { parent: G }); eye.position.set(33, 34, sd * 5);
          for (const fx of [-12, 12]) { const leg = K.cyl(4, 12, dkp, { parent: G, seg: 6 }); leg.position.set(fx, 0, sd * 9); }
        }
        const tail = K.torus(4, 1.4, dkp, { parent: G }); tail.position.set(-27, 28, 0);
        o.ball = G; o.ballR = 0;
      } else {
        const tex = K.canvasTex(256, 128, (d, ctx, w, h) => paintSoule(ctx, w, h));
        const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', map: tex, roughness: 0.55, emissive: '#ff3a00', emissiveIntensity: 0 });
        if (!tex) mat.color.set('#a8743f');
        o.ball = K.ball(1, mat, { seg: 24 });
        o.ballMat = mat; o.ballR = BR + 4;
      }
      o.ballBlob = K.blob(1); o.ballBlob.always = true;
      o.flames = [0, 1, 2, 3].map((k) => K.ball(1, K.glow(k % 2 ? '#ffc828' : '#ff501e', { add: true }), { cast: false }));
      o.ballRing = K.decal(160);
      o.ringKey = '';

      // Players.
      o.pl = [...Array(n).keys()].map((i) => ({ av: K.avatar(i), dec: K.decal(220), key: '', stars: K.emoji('💫', 56) }));
      return o;
    },

    update(K, o, v, r) {
      const t = K.t, dt = Math.min(0.05, K.dt || 0);
      if (!o.ready) { o.ready = true; buildGates(K, o, v); }
      // Gates: banners sway, torches burn.
      for (const G of o.gates) G.ban.rotation.y = G.base + Math.sin(t * 1.6 + G.k) * 0.06;
      // Pennants flutter.
      const dm = o.dummy;
      o.pennants.forEach((P, k) => {
        K.place(dm, P.x, P.y, P.h);
        dm.rotation.set(Math.sin(t * 3 + P.ph) * 0.35, -P.rot, 0);
        dm.updateMatrix();
        o.pen.setMatrixAt(k, dm.matrix);
      });
      o.pen.instanceMatrix.needsUpdate = true;
      // Spectators cheer after a point.
      const cheer = v.gl.some((q) => q > 0.4) || r.ended;
      o.npcs.forEach((N, k) => N.av.set(N.x, N.y, { r: 36, look: N.a, anim: cheer ? 'Cheer' : k === 0 ? 'Spellcasting' : 'Idle', marker: false, gear: false }));

      // Ball.
      const b = v.b;
      const held = b.o >= 0;
      const bh = b.h + (o.pig ? 0 : BR + 4);
      if (o.pig) {
        K.place(o.ball, b.x, b.y, b.h);
        K.face(o.ball, b.a);
        o.ball.rotation.z = held ? Math.sin(t * 25) * 0.5 : b.rn ? Math.sin(t * 30) * 0.15 : 0;
        o.ball.position.y += b.rn ? Math.abs(Math.sin(t * 18)) * 6 : 0;
      } else {
        K.place(o.ball, b.x, b.y, bh);
        o.ball.scale.setScalar(o.ballR);
        const sp = hyp(b.vx, b.vy);
        if (!held && sp > 1 && dt > 0) {
          o.tmpV.set(b.vy / sp, 0, -b.vx / sp);
          o.tmpQ.setFromAxisAngle(o.tmpV, (sp * dt) / o.ballR);
          o.ball.quaternion.premultiply(o.tmpQ);
        }
        if (o.ballMat) o.ballMat.emissiveIntensity = b.ht > 0 ? b.ht * (0.6 + 0.4 * Math.sin(t * (8 + b.ht * 20))) : 0;
      }
      K.place(o.ballBlob, b.x, b.y, 2.5);
      const bs = Math.max(0.4, 1 - b.h / 500) * (o.pig ? 30 : 20);
      o.ballBlob.scale.set(bs, 1, bs);
      o.flames.forEach((f, k) => {
        f.visible = b.ht > 0.3;
        if (!f.visible) return;
        const ph = (t * 1.6 + k / 4) % 1;
        K.place(f, b.x + Math.sin(t * 5 + k * 2) * 8, b.y + Math.cos(t * 5 + k * 2) * 8, bh + 10 + ph * 50);
        f.scale.setScalar((6 + b.ht * 8) * (1 - ph) + 2);
      });
      // Marker ring under a loose ball (so it is easy to find), coloured when held.
      const rk = `${held ? b.o : -1}|${b.h > 90 ? 1 : 0}`;
      if (rk !== o.ringKey) {
        o.ringKey = rk;
        o.ballRing.paint((d) => {
          if (held) return;
          d.ring(0, 0, 40, 'rgba(255,240,200,0.9)', 6);
          if (b.h > 90) d.ring(0, 0, 58, 'rgba(255,240,200,0.5)', 4);
        });
      }
      o.ballRing.at(b.x, b.y, 2.8).show(!held);

      // Players.
      let best = -1;
      if (r.ended) for (const q of v.hud.p) best = Math.max(best, q);
      v.p.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const rr = PR * (p.sc || 1);
        let anim, animKey = p.k, animSpeed, mood = MOODS[p.m] || 'ok', lean = 0;
        if (p.st === 1) { anim = 'Death_B'; animKey = `f${p.k}`; animSpeed = 1.6; }
        else if (p.dv || p.st === 2) { anim = 'Dodge_Forward'; animSpeed = 1.4; lean = 0.5; }
        else if (p.n === 2) anim = 'Throw';
        else if (p.n === 1) { anim = 'PickUp'; animSpeed = 2.4; }
        else if (b.o === i && p.w > 0.12) { anim = 'Running_B'; animSpeed = 1 + p.w * 0.4; }
        if (r.ended) { mood = v.hud.p[i] === best ? 'happy' : 'dizzy'; anim = mood === 'happy' ? 'Cheer' : 'Idle'; }
        P.av.set(p.x, p.y, { r: rr, look: p.a, mood, walk: p.w, anim, animKey, animSpeed, gear: false, lean: lean + (p.sp ? 0.15 : 0) });
        P.stars.visible = p.st === 1;
        if (p.st === 1) K.place(P.stars, p.x + Math.cos(t * 9) * 16, p.y + Math.sin(t * 9) * 16, rr * 1.6);
        const key = `${p.rd}|${v.tm}|${p.sp}`;
        P.dec.at(p.x, p.y, 2.4);
        if (key !== P.key) {
          P.key = key;
          P.dec.paint((d) => {
            if (v.tm) d.ring(0, 0, rr + 24, TEAMC[p.tm] + 'e0', 10);
            if (p.rd) d.ring(0, 0, rr + 11, K.col(i, 'light') + 'aa', 5);
            if (p.sp) for (let k = 0; k < 6; k++) { const a = (k / 6) * TAU; d.line(Math.cos(a) * (rr + 30), Math.sin(a) * (rr + 30), Math.cos(a) * (rr + 44), Math.sin(a) * (rr + 44), '#ffffffcc', 4); }
          });
        }
      });
    },
  },

  // ---------------------------------------------------------------- 2D fallback
  render(d, v, r) {
    const { ctx } = d;
    ctx.fillStyle = '#6fa64a'; ctx.fillRect(-300, -300, W + 600, H + 600);
    drawPitch(d, v, r.variant, d.col, false);
    drawGlow(d, v, d.col);
    const ng = v.gl.length;
    for (let k = 0; k < ng; k++) {
      const [ux, uy] = SIDE[k], [gx, gy] = GOAL[k];
      const c = v.tm ? TEAMC[k] : d.col(k);
      for (const sg of [-1, 1]) d.circle(gx + -uy * sg * v.gw, gy + ux * sg * v.gw, 14, '#8d8577', c, 5);
    }
    const b = v.b;
    v.p.forEach((p, i) => {
      const rr = PR * (p.sc || 1);
      d.shadow(p.x, p.y + rr * 0.6, rr, rr * 0.4, 0.35);
      if (v.tm) d.ring(p.x, p.y, rr + 10, TEAMC[p.tm], 6);
      if (p.rd) d.ring(p.x, p.y, rr + 4, d.col(i, 'light') + '88', 3);
      d.avatar(p.x, p.y, rr, i, { look: p.a, mood: MOODS[p.m] || 'ok', squash: p.st ? 0.35 : p.dv ? 0.2 : 0 });
      if (p.st === 1) d.text('💫', p.x, p.y - rr - 24, { size: 28 });
    });
    if (b.h > 4) d.shadow(b.x, b.y + 4, 14, 6, 0.35);
    const by = b.y - b.h * 0.6 - (b.o >= 0 ? 20 : 0);
    if (r.variant === 'maiale') d.emoji('🐖', b.x, by, 40);
    else {
      if (b.ht > 0.3) d.circle(b.x, by, BR + 8, `rgba(255,90,30,${(b.ht * 0.5).toFixed(2)})`);
      d.circle(b.x, by, BR + 2, '#a8743f', '#4a2c12', 3);
      d.line(b.x - BR, by, b.x + BR, by, '#4a2c12', 2);
    }
    if (b.o < 0) d.ring(b.x, b.y, 34, 'rgba(255,240,200,0.7)', 4);
  },
};

// Gates (stone arches) depend on the match shape: built on the first update.
function buildGates(K, o, v) {
  const ng = v.gl.length, gw = v.gw;
  const stoneO = K.texMat('muro', [1, 3], { color: '#d9d2c3' });
  const stoneT = K.texMat('muro', [1, 3], { color: '#d9d2c3' });
  stoneT.transparent = true; stoneT.opacity = 0.42; stoneT.depthWrite = false;
  o.gates = [];
  for (let k = 0; k < ng; k++) {
    // The gate nearest to the camera is see-through, so it never hides the players in front of it.
    const near = k === 0, stone = near ? stoneT : stoneO;
    const cap = K.mat('#b8ae9c', { rough: 0.8, opacity: near ? 0.42 : 1 });
    const [ux, uy] = SIDE[k], [gx, gy] = GOAL[k];
    const G = K.group();
    K.place(G, gx + ux * 20, gy + uy * 20);
    K.face(G, Math.atan2(uy, ux) - Math.PI / 2); // local x = along the gate line
    const P = { parent: G };
    for (const sg of [-1, 1]) {
      K.place(K.box(34, 34, GOAL_H + 10, stone, P), sg * (gw + 17), 0, (GOAL_H + 10) / 2);
      K.place(K.box(44, 44, 12, cap, P), sg * (gw + 17), 0, GOAL_H + 16);
    }
    K.place(K.box(gw * 2 + 80, 40, 26, stone, P), 0, 0, GOAL_H + 34);
    // Crest in the owner's colour on the lintel.
    const col = v.tm ? TEAMC[k] : K.col(k);
    K.place(K.box(gw * 2 + 84, 42, 8, K.mat(col, { rough: 0.5, emissive: col, ei: 0.2, opacity: near ? 0.6 : 1 }), P), 0, 0, GOAL_H + 50);
    const slot = v.tm ? k : (K.roster[k]?.color ?? k);
    const ban = K.model(`dungeon/banner_${BANNER[slot] || 'red'}`, { height: 120 });
    K.place(ban, gx + ux * 46, gy + uy * 46, GOAL_H - 70);
    K.face(ban, Math.atan2(-uy, -ux));
    for (const sg of [-1, 1]) {
      const tor = K.model('dungeon/torch_lit', { height: 60 });
      K.place(tor, gx + ux * 20 + -uy * sg * (gw + 17), gy + uy * 20 + ux * sg * (gw + 17), GOAL_H + 22);
    }
    // Team flag behind the gate.
    const f = K.model(`medieval/flag_${BANNER[slot] || 'red'}`, { height: 200 });
    K.place(f, gx + ux * 110 + -uy * (gw + 70), gy + uy * 110 + ux * (gw + 70));
    K.face(f, Math.atan2(-uy, -ux));
    o.gates.push({ k, ban, base: ban.rotation.y });
  }
  // Hay bales along the lines, leaving the open gates free.
  const dm = o.dummy;
  let idx = 0;
  const lineBales = (k, x0, y0, x1, y1) => {
    const len = hyp(x1 - x0, y1 - y0), cnt = Math.floor(len / 58);
    const [ux, uy] = SIDE[k];
    const rot = Math.atan2(y1 - y0, x1 - x0);
    for (let j = 0; j <= cnt; j++) {
      const u = j / cnt, x = x0 + (x1 - x0) * u + ux * 34, y = y0 + (y1 - y0) * u + uy * 34;
      const [gx, gy] = GOAL[k];
      if (k < ng && hyp(x - ux * 34 - gx, y - uy * 34 - gy) < gw + 40) continue;
      if (idx >= 64) return;
      K.place(dm, x, y, 22);
      dm.rotation.set(0, -rot, 0);
      dm.updateMatrix();
      o.bales.setMatrixAt(idx++, dm.matrix);
    }
  };
  lineBales(0, L, B, R, B);
  lineBales(1, L, T, R, T);
  lineBales(2, L, T, L, B);
  lineBales(3, R, T, R, B);
  o.bales.count = idx;
  o.bales.instanceMatrix.needsUpdate = true;
}

// Mowed meadow stripes, lime lines, centre circle, gate areas, mud puddles. Shared by 2D and 3D.
function drawPitch(d, v, variant, col, onLayer) {
  const { ctx } = d;
  const ng = v.gl.length;
  ctx.save();
  ctx.beginPath(); ctx.rect(L, T, R - L, B - T); ctx.clip();
  const band = (B - T) / 10;
  for (let k = 0; k < 10; k++) d.rect(L, T + k * band, R - L, band, k % 2 ? 'rgba(255,255,255,0.10)' : 'rgba(30,70,20,0.10)');
  // Team halves tint.
  if (v.tm) { d.rect(L, CY, R - L, B - CY, TEAMC[0] + '18'); d.rect(L, T, R - L, CY - T, TEAMC[1] + '18'); }
  ctx.restore();
  const line = 'rgba(255,255,255,0.88)';
  d.rect(L, T, R - L, B - T, null, line, 7);
  if (ng === 2) d.line(L, CY, R, CY, line, 5);
  else { d.line(L + 40, T + 40, R - 40, B - 40, 'rgba(255,255,255,0.4)', 4); d.line(R - 40, T + 40, L + 40, B - 40, 'rgba(255,255,255,0.4)', 4); }
  d.ring(CX, CY, 110, line, 6);
  d.circle(CX, CY, 10, line);
  for (let k = 0; k < ng; k++) {
    const [ux, uy] = SIDE[k], [gx, gy] = GOAL[k];
    const c = v.tm ? TEAMC[k] : col(k);
    d.arc(gx, gy, 200, Math.atan2(-uy, -ux) - Math.PI / 2, Math.atan2(-uy, -ux) + Math.PI / 2, line, 5);
    // The gate mouth and porch in the owner's colour.
    if (uy) { d.rect(gx - v.gw, uy > 0 ? B : T - PORCH, v.gw * 2, PORCH, c + '55'); d.line(gx - v.gw, gy, gx + v.gw, gy, c, 9); }
    else { d.rect(ux < 0 ? L - PORCH : R, gy - v.gw, PORCH, v.gw * 2, c + '55'); d.line(gx, gy - v.gw, gx, gy + v.gw, c, 9); }
  }
  if (variant === 'fango') {
    for (const [x, y, rr] of PUDDLES) {
      d.circle(x, y, rr * 1.1, 'rgba(70,45,20,0.45)');
      d.circle(x, y, rr, 'rgba(105,72,38,0.92)');
      d.circle(x - rr * 0.3, y - rr * 0.35, rr * 0.22, 'rgba(255,255,255,0.18)');
      d.circle(x + rr * 0.35, y + rr * 0.2, rr * 0.12, 'rgba(255,255,255,0.12)');
    }
  }
  if (!onLayer) d.rect(L - 20, T - 20, R - L + 40, B - T + 40, null, '#e8c96a', 14);
}

function drawGlow(d, v, col) {
  v.gl.forEach((q, k) => {
    if (q <= 0.02) return;
    const [gx, gy] = GOAL[k];
    const c = v.tm ? TEAMC[v.gc[k]] : col(v.gc[k]);
    d.circle(gx, gy, 140 + 160 * (1 - q), c + Math.round(q * 110).toString(16).padStart(2, '0'));
  });
}

// Equirectangular leather soule: brown panels, stitches, a band of the abbey colours.
function paintSoule(ctx, w, h) {
  ctx.fillStyle = '#a8743f'; ctx.fillRect(0, 0, w, h);
  for (let k = 0; k < 80; k++) {
    ctx.fillStyle = k % 2 ? 'rgba(70,40,15,0.18)' : 'rgba(255,215,160,0.12)';
    ctx.beginPath(); ctx.arc((k * 47) % w, (k * 31) % h, 3 + (k % 5) * 3, 0, TAU); ctx.fill();
  }
  ctx.strokeStyle = '#3e2410'; ctx.lineWidth = 4;
  for (let k = 0; k < 4; k++) {
    const x = (k / 4) * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    for (let y = 6; y < h; y += 10) { ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y + 3); ctx.stroke(); }
  }
  ctx.fillStyle = '#ffd23f'; ctx.fillRect(0, h * 0.47, w, h * 0.06);
}
