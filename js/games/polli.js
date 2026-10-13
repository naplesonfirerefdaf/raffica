// Il Ladro di Polli — top-down farmyard brawl: catch the runaway hens, bring them into your coop, steal the others'.
// Free-for-all: seat k owns the pen on side k (0 bottom, 1 top, 2 left, 3 right).
// Teams (g.teams): team 0 owns the bottom pen, team 1 the top one; teammates share it and win together.
import { clamp, angleDiff, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500;
const X0 = 60, X1 = 940, Y0 = 60, Y1 = 940;     // yard fence
const PR = 34;                                    // player radius
const RUN = 345, CARRY = 300, ACC = 3200, ACC_MUD = 820;
const DASH_V = 980, DASH_T = 0.2, DASH_CD = 1.1;
const GRAB = 52;                                  // grab reach beyond the two radii
const CR = 17;                                    // chicken radius
const GRAV = 1500, THROW_VH = 470, THROW_V = 620, THROW_H0 = 55;
const HAY_R = 64;                                 // haystack in the middle (hens pop out of it)
const ROOSTER_HOLD = 2.4;                         // the rooster pecks whoever holds it longer than this
const SIDE = [[0, 1], [0, -1], [-1, 0], [1, 0]];
const VAL = [1, 3, 2];                            // hen, golden goose, angry rooster
const FLEE = [235, 300, 0];
const MOODS = ['ok', 'happy', 'dizzy', 'angry', 'hurt', 'scared'];
const TEAMC = ['#ff4b5c', '#3fa9ff'];
const FLAGN = ['red', 'blue', 'green', 'yellow'];
const DUR = 50;

const penXY = (k) => [CX + SIDE[k][0] * (CX - X0), CY + SIDE[k][1] * (CY - Y0)];
const hyp = Math.hypot;

function inPen(s, x, y, slack = 0) {
  for (const pn of s.pens) if (hyp(x - pn.x, y - pn.y) < pn.r - slack) return pn.k;
  return -1;
}

function carried(s, p) {
  if (p.cr < 0) return null;
  for (const c of s.ch) if (c.id === p.cr) return c;
  return null;
}

function newChicken(s, k, x, y, st) {
  return { id: s.nid++, k, x, y, vx: 0, vy: 0, h: 0, vh: 0, st, c: -1, th: -1, bonk: false, a: 0, wt: 0, wa: 0, ws: 0, pan: 0, ct: 0, pk: 0.8 };
}

function freePos(s, g) {
  for (let k = 0; k < 12; k++) {
    const x = g.rng.range(X0 + 70, X1 - 70), y = g.rng.range(Y0 + 70, Y1 - 70);
    if (inPen(s, x, y, -70) < 0 && hyp(x - CX, y - CY) > HAY_R + 60) return [x, y];
  }
  return [CX + 200, CY];
}

// New chicken: hens pop out of the haystack; with the "rain" variant (and for the specials) they fall from the sky.
function spawn(s, g, kind, sky = s.rain) {
  let c;
  if (sky) {
    const [x, y] = freePos(s, g);
    c = newChicken(s, kind, x, y, 2);
    c.h = 640; c.vh = -60; c.bonk = true; c.th = -1;
  } else {
    const a = g.rng() * TAU;
    c = newChicken(s, kind, CX + Math.cos(a) * (HAY_R + CR + 4), CY + Math.sin(a) * (HAY_R + CR + 4), 0);
    c.vx = Math.cos(a) * 280; c.vy = Math.sin(a) * 280; c.pan = 0.8; c.a = a;
    g.burst(c.x, c.y, { color: '#e8c35a', n: 6, speed: 160, size: 6 });
  }
  s.ch.push(c);
  if (kind === 1) {
    g.say("ARRIVA L'OCA D'ORO!"); g.sfx('powerup'); g.sfx('quack', { pitch: 0.7 });
    g.ring(c.x, c.y, { color: '#ffd23f', r: 160 });
  } else if (kind === 2) {
    g.text(c.x, c.y - 60, 'GALLO ARRABBIATO!', { color: '#ff7043', size: 44 }); g.sfx('horn', { pitch: 1.4, vol: 0.6 });
  }
  return c;
}

function deposit(s, g, c, k, by) {
  const pn = s.pens[k];
  pn.v += VAL[c.k]; pn.l.push(c.k); pn.fl = 1;
  s.lastDep[k] = g.t;
  s.ch = s.ch.filter((q) => q !== c);
  const [ux, uy] = SIDE[k];
  const col = c.k === 1 ? '#ffd23f' : '#fff6e0';
  g.sfx('coin', { pitch: c.k === 1 ? 0.8 : 1.25 }); g.sfx('quack', { pitch: c.k === 1 ? 0.7 : 1.5, vol: 0.5 });
  g.burst(pn.x - ux * 60, pn.y - uy * 60, { color: col, n: c.k === 1 ? 30 : 14, speed: 300, size: 7 });
  g.text(pn.x - ux * 110, pn.y - uy * 110, `+${VAL[c.k]}`, { color: s.team ? TEAMC[k] : undefined, player: s.team ? undefined : k, size: 64 });
  if (c.k === 1) { g.confetti(pn.x - ux * 80, pn.y - uy * 80); g.shake(0.35); g.sfx('tada'); }
  if (by && by.how === 'throw') {
    if (by.pen === k) { if (c.k) g.say('CANESTRO DORATO!'); else g.text(pn.x - ux * 170, pn.y - uy * 170, 'CANESTRO!', { color: '#fff3b0', size: 50 }); g.sfx('goal', { vol: 0.6 }); }
    else g.text(pn.x - ux * 170, pn.y - uy * 170, 'NEL POLLAIO SBAGLIATO!', { color: '#ffffff', size: 36 });
  }
  for (const p of s.pl) if (p.pen === k) p.joy = 0.8;
}

// Lose the carried chicken: dropped at the feet, or popped into the air (hit, peck).
function drop(s, g, p, pop) {
  const c = carried(s, p);
  p.cr = -1;
  if (!c) return null;
  c.c = -1; c.ct = 0;
  if (pop) {
    c.st = 2; c.h = 45; c.vh = 380; c.bonk = false; c.th = -1;
    const a = pop.a + g.rng.range(-0.6, 0.6);
    c.vx = Math.cos(a) * pop.v; c.vy = Math.sin(a) * pop.v;
  } else {
    c.st = 0; c.h = 0; c.pan = 0.6;
    c.x = clamp(p.x + Math.cos(p.a) * (p.r + CR + 2), X0 + CR, X1 - CR);
    c.y = clamp(p.y + Math.sin(p.a) * (p.r + CR + 2), Y0 + CR, Y1 - CR);
    c.vx = Math.cos(p.a) * 120; c.vy = Math.sin(p.a) * 120;
  }
  return c;
}

function stunP(s, g, p, sec, from) {
  p.stun = Math.max(p.stun, sec); p.dash = 0; p.sad = sec + 0.4;
  const a = from ? Math.atan2(p.y - from.y, p.x - from.x) : g.rng() * TAU;
  drop(s, g, p, { a, v: 300 });
  g.vibrate(p.i, 120);
}

function throwChicken(s, g, p) {
  const c = carried(s, p);
  if (!c) return;
  p.cr = -1;
  let a = p.a, sp = THROW_V;
  // Aim help: thrown roughly toward your own coop, the hen flies right into it.
  const pn = s.pens[p.pen], dx = pn.x - p.x, dy = pn.y - p.y, d = hyp(dx, dy);
  if (d < 700 && Math.abs(angleDiff(a, Math.atan2(dy, dx))) < 0.6) {
    a = Math.atan2(dy, dx);
    const T = (THROW_VH + Math.sqrt(THROW_VH * THROW_VH + 2 * GRAV * THROW_H0)) / GRAV;
    sp = clamp((d - pn.r * 0.35) / T, 250, 950);
  }
  Object.assign(c, { st: 2, c: -1, x: p.x + Math.cos(a) * (p.r * 0.6), y: p.y + Math.sin(a) * (p.r * 0.6), h: THROW_H0, vh: THROW_VH, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, th: p.i, bonk: true, a, ct: 0 });
  p.act++; p.an = 2; p.at = 0.45; p.acd = 0.25;
  g.sfx('whoosh'); g.sfx('quack', { pitch: c.k === 1 ? 0.8 : 1.7, vol: 0.7 });
  g.burst(c.x, c.y, { color: '#ffffff', n: 8, speed: 220, size: 6 });
}

// A: grab a loose chicken, snatch one from a rival's arms, or steal from a rival coop. A while carrying = put it down.
function actA(s, g, p) {
  if (p.cr >= 0) { drop(s, g, p, null); p.acd = 0.3; g.sfx('pop', { vol: 0.5 }); return; }
  let best = null, bs = -1e9;
  for (const c of s.ch) {
    if (c.st === 1 || c.h > 95) continue;
    const d = hyp(c.x - p.x, c.y - p.y);
    if (d > p.r + CR + GRAB) continue;
    const sc = VAL[c.k] * 100 - d;
    if (sc > bs) { bs = sc; best = c; }
  }
  if (best) {
    Object.assign(best, { st: 1, c: p.i, h: 0, vh: 0, ct: 0, pan: 0 });
    p.cr = best.id; p.safe = 0.4; p.act++; p.an = 1; p.at = 0.3; p.acd = 0.25;
    g.sfx('pickup'); g.sfx('quack', { pitch: best.k === 1 ? 0.75 : best.k === 2 ? 1.1 : 1.6, vol: 0.7 });
    g.burst(best.x, best.y, { color: best.k === 1 ? '#ffd23f' : best.k === 2 ? '#c8643a' : '#ffffff', n: 10, speed: 240, size: 6 });
    g.vibrate(p.i, 30);
    return;
  }
  for (const q of s.pl) {
    if (q === p || g.ally(p.i, q.i) || q.cr < 0 || q.safe > 0) continue;
    if (hyp(q.x - p.x, q.y - p.y) > p.r + q.r + 28) continue;
    const c = carried(s, q);
    if (!c) continue;
    q.cr = -1; c.c = p.i; c.ct = 0; p.safe = 0.6;
    p.cr = c.id; p.act++; p.an = 1; p.at = 0.3; p.acd = 0.35;
    q.stun = Math.max(q.stun, 0.25); q.sad = 0.8;
    g.sfx('swap'); g.text(q.x, q.y - 80, 'RUBATA!', { player: p.i, size: 44 });
    g.burst(q.x, q.y, { color: '#ffffff', n: 12, speed: 260, size: 6 });
    g.vibrate(q.i, 80);
    return;
  }
  const k = inPen(s, p.x, p.y);
  if (k >= 0 && k !== p.pen && s.pens[k].l.length) {
    const pn = s.pens[k];
    const kind = pn.l.pop();
    pn.v -= VAL[kind]; pn.fl = -1;
    const c = newChicken(s, kind, p.x, p.y, 1);
    c.c = p.i; s.ch.push(c);
    p.cr = c.id; p.act++; p.an = 4; p.at = 0.35; p.acd = 0.35;
    g.sfx('swap'); g.sfx('quack', { pitch: 1.3 });
    g.text(p.x, p.y - 85, 'LADRO DI POLLI!', { player: p.i, size: 40 });
    g.burst(p.x, p.y, { color: '#e8c35a', n: 14, speed: 260 });
    for (const q of s.pl) if (q.pen === k) g.vibrate(q.i, 60);
    return;
  }
  p.acd = 0.2; p.act++; p.an = 1; p.at = 0.2; // whiff
}

function stepPlayer(s, g, p, inp, dt) {
  p.stun = Math.max(0, p.stun - dt); p.dcd = Math.max(0, p.dcd - dt); p.acd = Math.max(0, p.acd - dt);
  p.joy = Math.max(0, p.joy - dt); p.sad = Math.max(0, p.sad - dt); p.at = Math.max(0, p.at - dt); p.safe = Math.max(0, (p.safe || 0) - dt);
  const acc = s.mud ? ACC_MUD : ACC;
  if (p.stun > 0) {
    const k = Math.max(0, 1 - (s.mud ? 2 : 8) * dt);
    p.vx *= k; p.vy *= k;
  } else if (p.dash > 0) {
    p.dash -= dt;
  } else {
    const mag = Math.min(1, hyp(inp.x, inp.y));
    const c = p.cr >= 0 ? carried(s, p) : null;
    const top = (c ? (c.k === 1 ? CARRY * 0.9 : CARRY) : RUN) * (p.r / PR > 1.2 ? 0.92 : 1);
    if (mag > 0.15) p.a = Math.atan2(inp.y, inp.x);
    const tx = mag > 0.15 ? (inp.x / Math.max(mag, 1e-6)) * mag * top : 0, ty = mag > 0.15 ? (inp.y / Math.max(mag, 1e-6)) * mag * top : 0;
    const dx = tx - p.vx, dy = ty - p.vy, dl = hyp(dx, dy), st = acc * dt;
    if (dl <= st) { p.vx = tx; p.vy = ty; } else { p.vx += (dx / dl) * st; p.vy += (dy / dl) * st; }
    if (inp.aP && p.acd <= 0) actA(s, g, p);
    if (inp.bP) {
      if (p.cr >= 0) throwChicken(s, g, p);
      else if (p.dcd <= 0) {
        p.dash = DASH_T; p.dcd = DASH_CD; p.hit = false;
        p.vx = Math.cos(p.a) * DASH_V; p.vy = Math.sin(p.a) * DASH_V;
        p.act++; p.an = 3; p.at = 0.35;
        g.sfx('dash'); g.burst(p.x, p.y, { color: '#d8b98a', n: 6, speed: 150, size: 7 });
      }
    }
  }
  p.x += p.vx * dt; p.y += p.vy * dt;
  // Fence and haystack.
  if (p.x < X0 + p.r) { p.x = X0 + p.r; p.vx = Math.max(0, p.vx); }
  if (p.x > X1 - p.r) { p.x = X1 - p.r; p.vx = Math.min(0, p.vx); }
  if (p.y < Y0 + p.r) { p.y = Y0 + p.r; p.vy = Math.max(0, p.vy); }
  if (p.y > Y1 - p.r) { p.y = Y1 - p.r; p.vy = Math.min(0, p.vy); }
  const hx = p.x - CX, hy = p.y - CY, hd = hyp(hx, hy), min = HAY_R + p.r;
  if (hd < min && hd > 0) {
    p.x = CX + (hx / hd) * min; p.y = CY + (hy / hd) * min;
    const vn = p.vx * (hx / hd) + p.vy * (hy / hd);
    if (vn < 0) { p.vx -= vn * (hx / hd); p.vy -= vn * (hy / hd); }
    if (p.dash > 0) { p.dash = 0; g.sfx('bonk', { vol: 0.5 }); g.burst(p.x - (hx / hd) * p.r, p.y - (hy / hd) * p.r, { color: '#e8c35a', n: 8, speed: 200 }); }
  }
  // Carrying into your own coop = deposit.
  if (p.cr >= 0 && inPen(s, p.x, p.y, 8) === p.pen) {
    const c = carried(s, p);
    p.cr = -1;
    if (c) deposit(s, g, c, p.pen, { how: 'walk', pen: p.pen });
  }
}

function stepChicken(s, g, c, dt) {
  c.pk = Math.max(0, c.pk - dt); c.pan = Math.max(0, c.pan - dt);
  if (c.st === 1) {
    const p = s.pl[c.c];
    if (!p) { c.st = 0; c.c = -1; return; }
    c.x = p.x; c.y = p.y; c.a = p.a; c.ct += dt;
    if (c.k === 2 && c.ct > ROOSTER_HOLD) {
      // The rooster has had enough: peck and flee.
      g.sfx('hit'); g.sfx('quack', { pitch: 0.9 });
      g.text(p.x, p.y - 85, 'AHIA! BECCATA!', { color: '#ff7043', size: 42 });
      g.shake(0.25);
      stunP(s, g, p, 0.75, null);
    }
    return;
  }
  if (c.st === 2) {
    c.vh -= GRAV * dt; c.h += c.vh * dt; c.x += c.vx * dt; c.y += c.vy * dt;
    if (c.x < X0 + CR) { c.x = X0 + CR; c.vx = Math.abs(c.vx) * 0.4; }
    if (c.x > X1 - CR) { c.x = X1 - CR; c.vx = -Math.abs(c.vx) * 0.4; }
    if (c.y < Y0 + CR) { c.y = Y0 + CR; c.vy = Math.abs(c.vy) * 0.4; }
    if (c.y > Y1 - CR) { c.y = Y1 - CR; c.vy = -Math.abs(c.vy) * 0.4; }
    if (hyp(c.vx, c.vy) > 30) c.a = Math.atan2(c.vy, c.vx);
    if (c.bonk && c.h < 80) {
      for (const p of s.pl) {
        if (p.i === c.th || (c.th >= 0 && g.ally(p.i, c.th)) || p.stun > 0) continue;
        if (hyp(p.x - c.x, p.y - c.y) > p.r + CR + 8) continue;
        c.bonk = false;
        g.sfx('bonk'); g.sfx('quack', { pitch: 1.2 });
        g.text(p.x, p.y - 90, c.th < 0 ? 'PIOVONO POLLI!' : 'POLLATA!', { player: c.th >= 0 ? c.th : undefined, color: c.th < 0 ? '#ffffff' : undefined, size: 46 });
        g.burst(p.x, p.y - 20, { color: '#ffffff', n: 16, speed: 300, size: 7 });
        g.shake(0.3); g.hitstop(0.05);
        stunP(s, g, p, c.k === 2 ? 1.3 : 0.85, c);
        c.vx *= -0.25; c.vy *= -0.25;
        break;
      }
    }
    if (c.h <= 0) {
      c.h = 0; c.vh = 0; c.st = 0; c.pan = 1.2; c.bonk = false; c.vx *= 0.3; c.vy *= 0.3;
      const thr = c.th >= 0 ? s.pl[c.th] : null;
      const k = inPen(s, c.x, c.y);
      if (k >= 0) { deposit(s, g, c, k, thr ? { how: 'throw', pen: thr.pen } : null); return; }
      g.sfx('land', { vol: 0.5 });
      g.burst(c.x, c.y, { color: '#d8b98a', n: 5, speed: 120, size: 6 });
    }
    return;
  }
  // Free on the ground.
  let near = null, nd = 1e9;
  for (const p of s.pl) {
    const d = hyp(p.x - c.x, p.y - c.y);
    if (d < nd) { nd = d; near = p; }
  }
  let dvx = 0, dvy = 0;
  if (c.k === 2 && near && nd < 380 && near.stun <= 0) {
    // Angry rooster: charges the nearest farmer.
    const sp = c.pk > 0 ? 60 : 215;
    dvx = ((near.x - c.x) / nd) * sp; dvy = ((near.y - c.y) / nd) * sp;
    if (nd < near.r + CR + 3 && c.pk <= 0) {
      c.pk = 1.8;
      g.sfx('hit'); g.text(near.x, near.y - 85, 'BECCATA!', { color: '#ff7043', size: 44 });
      g.burst(near.x, near.y - 30, { color: '#c8643a', n: 12, speed: 260 });
      stunP(s, g, near, 0.55, c);
      c.vx = -dvx * 1.5; c.vy = -dvy * 1.5;
    }
  } else if (c.k !== 2 && near && nd < (c.k === 1 ? 250 : 210)) {
    // Panic: run away (wobbly), but corners trap them.
    const sp = FLEE[c.k] * (nd < 120 ? 1 : 0.8);
    const a = Math.atan2(c.y - near.y, c.x - near.x) + Math.sin(g.t * 9 + c.id) * 0.5;
    dvx = Math.cos(a) * sp; dvy = Math.sin(a) * sp;
    if (c.pan <= 0 && g.rng() < 0.02) g.sfx('quack', { pitch: c.k === 1 ? 0.8 : 1.6 + g.rng() * 0.3, vol: 0.35 });
    c.pan = Math.max(c.pan, 0.4);
  } else {
    c.wt -= dt;
    if (c.wt <= 0) {
      c.wt = g.rng.range(0.5, 1.8);
      c.wa = g.rng() * TAU;
      c.ws = g.rng() < 0.35 ? 0 : g.rng.range(40, c.k === 1 ? 140 : 100);
    }
    dvx = Math.cos(c.wa) * c.ws; dvy = Math.sin(c.wa) * c.ws;
    // Calm hens stay away from the coops and the fence.
    for (const pn of s.pens) {
      const dx = c.x - pn.x, dy = c.y - pn.y, d = hyp(dx, dy);
      if (d < pn.r + 50 && d > 0) { dvx += (dx / d) * 120; dvy += (dy / d) * 120; }
    }
    if (c.x < X0 + 60) dvx += 60; if (c.x > X1 - 60) dvx -= 60;
    if (c.y < Y0 + 60) dvy += 60; if (c.y > Y1 - 60) dvy -= 60;
  }
  const kf = Math.min(1, (s.mud ? 2.5 : 9) * dt);
  c.vx += (dvx - c.vx) * kf; c.vy += (dvy - c.vy) * kf;
  c.x += c.vx * dt; c.y += c.vy * dt;
  c.x = clamp(c.x, X0 + CR, X1 - CR); c.y = clamp(c.y, Y0 + CR, Y1 - CR);
  const hx = c.x - CX, hy = c.y - CY, hd = hyp(hx, hy);
  if (hd < HAY_R + CR && hd > 0) { c.x = CX + (hx / hd) * (HAY_R + CR); c.y = CY + (hy / hd) * (HAY_R + CR); }
  if (hyp(c.vx, c.vy) > 25) c.a = Math.atan2(c.vy, c.vx);
  // Players shove chickens aside.
  for (const p of s.pl) {
    const dx = c.x - p.x, dy = c.y - p.y, d = hyp(dx, dy), m = p.r + CR;
    if (d < m && d > 0) { c.x = p.x + (dx / d) * m; c.y = p.y + (dy / d) * m; }
  }
  // A panicking hen that runs into a coop is caught there.
  if (c.k !== 2) {
    const k = inPen(s, c.x, c.y, 12);
    if (k >= 0) deposit(s, g, c, k, null);
  }
}

function seatOfPen(s, k) {
  const p = s.pl.find((q) => q.pen === k);
  return p ? p.i : 0;
}

function decide(s, g) {
  const ks = s.pens.map((pn) => pn.k);
  const keep = (list, f) => { const m = Math.max(...list.map(f)); return list.filter((k) => f(k) === m); };
  let c = keep(ks, (k) => s.pens[k].v);
  if (c.length > 1) c = keep(c, (k) => s.pl.reduce((a, p) => a + (p.pen === k && p.cr >= 0 ? VAL[carried(s, p)?.k ?? 0] : 0), 0));
  if (c.length > 1) c = keep(c, (k) => -s.lastDep[k]);
  const k = c.length > 1 ? c[g.rng.int(0, c.length - 1)] : c[0];
  return seatOfPen(s, k);
}

// ---------------------------------------------------------------- bot
function polliBot(s, me, g, B) {
  const p = s.pl[me];
  if (!p || p.stun > 0.1) return { x: 0, y: 0 };
  const lv = B.level, pen = s.pens[p.pen];
  const out = { x: 0, y: 0 };
  const steer = (tx, ty, care = true) => {
    let dx = tx - p.x, dy = ty - p.y;
    const d = hyp(dx, dy) || 1;
    dx /= d; dy /= d;
    // Walk around the haystack instead of into it.
    const hx = CX - p.x, hy = CY - p.y, along = hx * dx + hy * dy;
    if (along > 0 && along < d) {
      const off = hx * dy - hy * dx;
      if (Math.abs(off) < HAY_R + p.r + 18) { const sg = off >= 0 ? -1 : 1, ox = dx; dx += -dy * sg * 0.9; dy += ox * sg * 0.9; }
    }
    // Keep away from rivals when carrying (better bots).
    if (care && p.cr >= 0 && lv > 0) {
      for (const q of s.pl) {
        if (g.ally(me, q.i) || q.stun > 0) continue;
        const ex = p.x - q.x, ey = p.y - q.y, e = hyp(ex, ey);
        if (e < 210 && e > 0) { dx += (ex / e) * (1 - e / 210) * 1.2; dy += (ey / e) * (1 - e / 210) * 1.2; }
      }
    }
    const l = hyp(dx, dy) || 1;
    out.x = dx / l; out.y = dy / l;
    return d;
  };
  const rivals = s.pl.filter((q) => !g.ally(me, q.i));
  const mates = s.pl.filter((q) => q !== p && g.ally(me, q.i));

  if (p.cr >= 0) {
    const c = carried(s, p);
    const d = steer(pen.x, pen.y);
    // Rooster about to peck: throw it now (toward the coop, or at a rival nearby).
    if (c && c.k === 2 && c.ct > ROOSTER_HOLD - 0.6 && lv > 0) {
      if (d < 680) { steer(pen.x, pen.y, false); out.tapB = true; }
      else {
        let tq = null, td = 380;
        for (const q of rivals) { const e = hyp(q.x - p.x, q.y - p.y); if (e < td && q.stun <= 0) { td = e; tq = q; } }
        if (tq) { steer(tq.x, tq.y, false); out.tapB = true; } else out.tapA = true;
      }
      return out;
    }
    if (lv > 0 && d > pen.r * 0.7 && d < 560) {
      let threat = 1e9;
      for (const q of rivals) if (q.stun <= 0) threat = Math.min(threat, hyp(q.x - p.x, q.y - p.y));
      if (threat < (lv === 2 ? 230 : 160) || (lv === 2 && d > pen.r + 60)) { steer(pen.x, pen.y, false); out.tapB = true; }
    }
    return out;
  }

  // Not carrying: pick the best target.
  let best = null, bs = 1e9;
  const consider = (sc, t) => { if (sc < bs) { bs = sc; best = t; } };
  for (const c of s.ch) {
    if (c.st === 1) continue;
    if (c.st === 2 && c.h > 300 && lv < 2) continue;
    if (c.k === 2 && lv < 2) continue; // only the King dares grab the rooster
    const px = c.x + c.vx * 0.25, py = c.y + c.vy * 0.25;
    const d = hyp(px - p.x, py - p.y);
    let sc = d - (lv > 0 ? VAL[c.k] * 110 : 0);
    if (c.k === 2) sc += 120 + hyp(c.x - pen.x, c.y - pen.y) * 0.4;
    // Teamwork: leave it to the mate who is closer.
    for (const m of mates) if (m.cr < 0 && m.stun <= 0 && hyp(px - m.x, py - m.y) < d - 40) sc += 260;
    if (lv > 0) for (const q of rivals) if (q.cr < 0 && hyp(px - q.x, py - q.y) < d * 0.5) sc += 120;
    consider(sc, { kind: 'c', c, x: px, y: py });
  }
  if (lv > 0) {
    for (const q of rivals) {
      if (q.cr < 0 || q.stun > 0) continue;
      const d = hyp(q.x - p.x, q.y - p.y);
      const qc = carried(s, q);
      const toPen = hyp(q.x - s.pens[q.pen].x, q.y - s.pens[q.pen].y);
      let sc = d - 140 - (qc ? VAL[qc.k] * 60 : 0) - (toPen < 300 ? 80 : 0);
      for (const m of mates) if (m.cr < 0 && m.stun <= 0 && hyp(q.x - m.x, q.y - m.y) < d - 60) sc += 200;
      consider(sc, { kind: 'q', q, x: q.x + q.vx * 0.2, y: q.y + q.vy * 0.2 });
    }
    // Thief in my coop: chase it away (the mate nearer to the coop takes care of it).
    for (const q of rivals) {
      if (q.stun > 0) continue;
      if (hyp(q.x - pen.x, q.y - pen.y) < pen.r + 70 && pen.l.length) {
        const d = hyp(q.x - p.x, q.y - p.y);
        let sc = d - 260;
        for (const m of mates) if (m.stun <= 0 && hyp(q.x - m.x, q.y - m.y) < d) sc += 300;
        consider(sc, { kind: 'q', q, x: q.x, y: q.y });
      }
    }
    // Raid a rival coop.
    for (const pn of s.pens) {
      if (pn.k === p.pen || !pn.l.length) continue;
      const d = hyp(pn.x - p.x, pn.y - p.y);
      let guard = 0;
      for (const q of s.pl) if (q.pen === pn.k && q.stun <= 0 && hyp(q.x - pn.x, q.y - pn.y) < 260) guard++;
      const top = pn.l[pn.l.length - 1];
      let sc = d + 160 - VAL[top] * 70 - pn.v * (lv === 2 ? 14 : 6) + guard * 260;
      for (const m of mates) if (m.cr < 0 && hyp(pn.x - m.x, pn.y - m.y) < d) sc += 200;
      consider(sc, { kind: 'pen', pn, x: pn.x - SIDE[pn.k][0] * pn.r * 0.45, y: pn.y - SIDE[pn.k][1] * pn.r * 0.45 });
    }
  }
  if (!best) { steer(CX + (pen.x - CX) * 0.3, CY + (pen.y - CY) * 0.3); return out; }
  let tx = best.x, ty = best.y;
  if (best.kind === 'c' && lv > 0) {
    // Herd from the middle: come from the center side so it flees into the fence.
    const c = best.c, d = hyp(c.x - p.x, c.y - p.y);
    if (d > 130 && c.k !== 2) {
      const ox = CX - c.x, oy = CY - c.y, ol = hyp(ox, oy) || 1;
      tx = c.x + (ox / ol) * 70; ty = c.y + (oy / ol) * 70;
    }
  }
  const d = steer(tx, ty);
  if (best.kind === 'c') {
    const c = best.c;
    if (hyp(c.x - p.x, c.y - p.y) < p.r + CR + GRAB - 6 && c.h < 90) out.tapA = true;
  } else if (best.kind === 'q') {
    const q = best.q, e = hyp(q.x - p.x, q.y - p.y);
    if (q.cr >= 0 && e < p.r + q.r + 22) out.tapA = true;
    else if (p.dcd <= 0 && e < 190 && e > 60) {
      const ang = Math.abs(angleDiff(p.a, Math.atan2(q.y - p.y, q.x - p.x)));
      if (ang < 0.35 || lv === 2) { steer(q.x + q.vx * 0.12, q.y + q.vy * 0.12, false); out.tapB = true; }
    }
  } else if (best.kind === 'pen') {
    if (inPen(s, p.x, p.y) === best.pn.k) out.tapA = true;
    else if (d < 25) steer(best.pn.x, best.pn.y);
  }
  return out;
}

export default {
  id: 'polli',
  name: 'Il Ladro di Polli',
  rule: 'Acchiappa le galline e portale nel tuo pollaio!',
  verb: 'ACCHIAPPA!',
  inspired: 'Mario Party · Chicken Chase · Overcooked',
  cam: 'top',
  split: false,
  players: 4,
  teams: true,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Afferra', b: 'Lancia' },
  duration: DUR,
  supports: ['scale'],
  help: {
    goal: 'Allo scadere vince chi ha più galline nel pollaio (oca d’oro = 3, gallo = 2). A squadre il pollaio è in comune.',
    dir: 'Corri per l’aia. Le galline scappano da te: chiudile contro lo steccato!',
    a: 'AFFERRA: prendi la gallina vicina, strappala dalle braccia di un rivale o RUBALA dal suo pollaio. Con una gallina in braccio: posala.',
    b: 'Con la gallina: LANCIALA (verso il tuo pollaio fa canestro, sugli avversari li stordisce). Senza: SPINTONE che fa cadere le galline.',
    tips: ['Il gallo arrabbiato vale 2 ma dopo 2 secondi ti becca: lancialo!', 'Le galline spaventate che entrano in un pollaio contano per quel pollaio', 'Lascia sempre qualcuno a difendere il pollaio'],
  },
  variants: [
    { id: 'pioggia', name: 'Pioggia di Polli', desc: 'Le galline cadono dal cielo a raffica: guarda le ombre!' },
    { id: 'galli', name: 'Galli Furiosi', desc: 'Tre galli arrabbiati in giro per l’aia che beccano tutti' },
    { id: 'fango', name: 'Aia Fangosa', desc: 'Ha piovuto: si scivola dappertutto, galline comprese!' },
  ],

  init(g) {
    const n = g.n || 2;
    const team = !!g.teams;
    const np = team ? 2 : n;
    const sc = g.mods.scale || [];
    const pens = [...Array(np).keys()].map((k) => { const [x, y] = penXY(k); return { k, x, y, r: team ? 195 : 150, v: 0, l: [], fl: 0 }; });
    const pl = [...Array(n).keys()].map((i) => {
      const pen = team ? g.teams[i] : i;
      const mates = [...Array(n).keys()].filter((j) => (team ? g.teams[j] === pen : j === i));
      const j = mates.indexOf(i), cnt = mates.length;
      const [ux, uy] = SIDE[pen], pn = pens[pen];
      const lat = (j - (cnt - 1) / 2) * 200;
      const q = sc[i] ?? 1;
      return {
        i, pen, x: pn.x - ux * (pn.r + 80) + (-uy) * lat, y: pn.y - uy * (pn.r + 80) + ux * lat, vx: 0, vy: 0,
        a: Math.atan2(-uy, -ux), r: PR * q, stun: 0, dash: 0, dcd: 0, acd: 0, hit: false, safe: 0, cr: -1, joy: 0, sad: 0, act: 0, an: 0, at: 0,
      };
    });
    const s = {
      n, team, pens, pl, ch: [], nid: 1, lastDep: pens.map(() => 99),
      rain: g.variant === 'pioggia', galli: g.variant === 'galli', mud: g.variant === 'fango',
      hens: team ? 12 : 5 + 2 * n, spawnT: 0, gooseT: 13, roosterT: 7, warned: false, gold: false,
    };
    // Starting flock around the haystack.
    const start = team ? 10 : 4 + 2 * n;
    for (let k = 0; k < start; k++) {
      const a = (k / start) * TAU + 0.3, rr = 150 + (k % 3) * 60;
      const c = newChicken(s, 0, CX + Math.cos(a) * rr, CY + Math.sin(a) * rr, 0);
      c.a = a; c.wt = 0.3 + (k % 4) * 0.2;
      s.ch.push(c);
    }
    if (s.galli) for (let k = 0; k < 3; k++) { const a = (k / 3) * TAU + 0.5; const c = newChicken(s, 2, CX + Math.cos(a) * 300, CY + Math.sin(a) * 300, 0); c.pk = 2.5; s.ch.push(c); }
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    for (const pn of s.pens) pn.fl = pn.fl > 0 ? Math.max(0, pn.fl - dt * 2) : Math.min(0, pn.fl + dt * 2);
    // Clock events: new hens, specials, final countdown.
    if (!g.ended) {
      s.spawnT -= dt;
      const free = s.ch.filter((c) => c.k === 0 && c.st !== 1).length;
      if (s.spawnT <= 0 && s.ch.length < 26) {
        if (free < s.hens + (s.rain ? 6 : 0)) spawn(s, g, 0);
        s.spawnT = s.rain ? 0.45 : 1.4;
      }
      const has = (k) => s.ch.some((c) => c.k === k);
      if (g.t >= s.gooseT) { s.gooseT += 15; if (!has(1)) spawn(s, g, 1, true); }
      if (s.galli) {
        if (g.t >= s.roosterT) { s.roosterT = g.t + 3; if (s.ch.filter((c) => c.k === 2).length < 3) spawn(s, g, 2); }
      } else if (g.t >= s.roosterT) { s.roosterT += 12; if (!has(2)) spawn(s, g, 2); }
      if (!s.warned && g.t >= DUR - 10) {
        s.warned = true;
        g.say('ULTIMI 10 SECONDI!'); g.sfx('matchpoint');
        if (!has(1)) spawn(s, g, 1, true);
      }
    }
    s.pl.forEach((p, k) => stepPlayer(s, g, p, inp[k], dt));
    // Bodies: dashes knock rivals over, everyone else just bumps.
    for (let a = 0; a < s.pl.length; a++) {
      for (let b = a + 1; b < s.pl.length; b++) {
        const p = s.pl[a], q = s.pl[b];
        const dx = q.x - p.x, dy = q.y - p.y, d = hyp(dx, dy), m = p.r + q.r;
        if (d >= m + 4 || d === 0) continue;
        const ally = g.ally(p.i, q.i);
        for (const [att, vic] of [[p, q], [q, p]]) {
          if (att.dash > 0 && !att.hit && !ally && vic.stun <= 0) {
            att.hit = true; att.dash = 0; att.vx *= 0.3; att.vy *= 0.3;
            g.sfx('punch'); g.sfx('quack', { pitch: 1.4, vol: 0.5 });
            g.text(vic.x, vic.y - 90, 'SPINTONE!', { player: att.i, size: 44 });
            g.burst((p.x + q.x) / 2, (p.y + q.y) / 2, { color: '#ffffff', n: 14, speed: 320, size: 7 });
            g.shake(0.35); g.hitstop(0.06);
            stunP(s, g, vic, 0.8, att);
            vic.vx += Math.cos(att.a) * 420; vic.vy += Math.sin(att.a) * 420;
          }
        }
        if (d < m) {
          const push = (m - d) / 2, nx = dx / d, ny = dy / d;
          p.x -= nx * push; p.y -= ny * push; q.x += nx * push; q.y += ny * push;
        }
      }
    }
    for (const c of [...s.ch]) if (s.ch.includes(c)) stepChicken(s, g, c, dt);
    // Hens keep a little personal space.
    const fr = s.ch;
    for (let a = 0; a < fr.length; a++) {
      const c = fr[a];
      if (c.st !== 0) continue;
      for (let b = a + 1; b < fr.length; b++) {
        const e = fr[b];
        if (e.st !== 0) continue;
        const dx = e.x - c.x, dy = e.y - c.y, d = hyp(dx, dy);
        if (d < CR * 2 && d > 0) { const k = (CR * 2 - d) / 2; c.x -= (dx / d) * k; c.y -= (dy / d) * k; e.x += (dx / d) * k; e.y += (dy / d) * k; }
      }
    }
  },

  timeout(s, g) {
    return decide(s, g);
  },

  bot: polliBot,

  view(s) {
    return {
      p: s.pl.map((p) => {
        const c = p.cr >= 0 ? carried(s, p) : null;
        const md = p.stun > 0 ? 2 : p.sad > 0 ? 4 : p.joy > 0 ? 1 : p.dash > 0 ? 3 : c && c.k === 2 ? 5 : 0;
        return {
          x: r1(p.x), y: r1(p.y), a: r2(p.a), c: c ? c.k : -1, ct: c && c.k === 2 ? r2(c.ct / ROOSTER_HOLD) : 0,
          st: p.stun > 0 ? 1 : 0, d: p.dash > 0 ? 1 : 0, rd: p.dcd <= 0 ? 1 : 0, m: md, tm: p.pen,
          w: r2(Math.min(1, hyp(p.vx, p.vy) / RUN)), k: p.act, n: p.at > 0 ? p.an : 0, sc: r2(p.r / PR),
        };
      }),
      c: s.ch.filter((c) => c.st !== 1).map((c) => ({ id: c.id, x: r1(c.x), y: r1(c.y), h: r1(c.h), k: c.k, a: r2(c.a), f: c.st === 2 ? 1 : c.pan > 0 ? 2 : 0 })),
      pn: s.pens.map((pn) => ({ v: pn.v, l: pn.l.slice(-14).join(''), f: r2(pn.fl), rr: pn.r })),
      tm: s.team ? 1 : 0,
      hud: { p: s.pl.map((p) => s.pens[p.pen].v), max: null, label: 'Galline' },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  // ---------------------------------------------------------------- 3D: the farmyard
  render3d: {
    assets: [
      'medieval/fence_wood_straight', 'medieval/fence_wood_straight_gate', 'medieval/building_windmill_yellow', 'medieval/building_home_B_yellow',
      'medieval/building_home_A_red', 'medieval/building_lumbermill_yellow', 'medieval/building_well_red', 'medieval/building_grain',
      'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow',
      'medieval/barrel', 'medieval/sack', 'medieval/crate_A_small', 'medieval/crate_open', 'medieval/wheelbarrow', 'medieval/bucket_water',
      'medieval/resource_lumber', 'medieval/tree_single_B', 'medieval/trees_B_medium', 'medieval/trees_A_small', 'medieval/hills_C_trees',
      'medieval/mountain_A_grass_trees', 'medieval/rock_single_B', 'medieval/waterlily_A', 'medieval/waterplant_B', 'medieval/cloud_big',
      'chars/Barbarian',
    ],
    build(K, r) {
      const { THREE } = K;
      const n = r.n || K.n || 2;
      const lo = K.quality === 0;
      const o = { n, lo, pens: [], pl: [], signKey: [], tmp: new THREE.Matrix4(), tmp2: new THREE.Matrix4(), q: new THREE.Quaternion(), e: new THREE.Euler(), v: new THREE.Vector3(), sv: new THREE.Vector3(), col: new THREE.Color() };
      K.theme('giorno', { fogNear: 2.4, fogFar: 6.5 });
      K.ground('erba', { tile: 210, margin: 2200, color: '#c7e69a' });
      // Packed-earth yard inside the fence, painted details (straw, grain, puddles, coop floors) on top.
      const yard = K.prism([X0 - 18, Y0 - 18, X1 + 18, Y0 - 18, X1 + 18, Y1 + 18, X0 - 18, Y1 + 18], 2, K.texMat('terra', [1 / 180, 1 / 180], { color: r.variant === 'fango' ? '#b09070' : '#fff1d6' }), { cast: false });
      K.place(yard, 0, 0, 0);
      o.floorKey = '';
      o.floor = K.layer({
        x0: -260, y0: -260, x1: W + 260, y1: H + 260, h: 2.6, transparent: true, maxPx: 1024,
        draw: (d, v) => drawYard(d, v, r.variant, (k) => penColor(K.col, v.tm, k), true),
        key: (v) => `${v.tm}|${v.pn.length}`,
      });


      // Haystack in the middle with a pitchfork.
      const hay = K.texMat('paglia', [3, 1], { color: '#f2d37a' });
      K.place(K.cyl(HAY_R, 64, hay, { seg: 20, r2: HAY_R - 4 }), CX, CY);
      K.place(K.cone(HAY_R + 4, 66, hay, { seg: 20 }), CX, CY, 62);
      const fork = K.group(); K.place(fork, CX + 50, CY + 30, 0); fork.rotation.set(0.35, 0.6, 0.2);
      K.place(K.cyl(3, 150, K.mat('#7a5230'), { parent: fork, seg: 6 }), 0, 0, 0);
      for (const z of [-8, 0, 8]) K.place(K.cyl(1.6, 26, K.mat('#9aa0a8', { metal: 0.6, rough: 0.4 }), { parent: fork, seg: 5 }), 0, z, 150);
      // Bits of straw blowing around the stack.
      K.scatter('medieval/sack', [{ x: CX - 92, y: CY + 40, rot: 0.4 }, { x: CX + 86, y: CY - 52, rot: 2 }], { size: 46 });

      // Farm all around: farmhouse, barn/lumber mill, windmill, well, fields, pond, trees and hills.
      const bld = (name, x, y, a, size) => { const m = K.model(name, { size }); K.place(m, x, y); K.face(m, a); return m; };
      bld('medieval/building_home_B_yellow', -260, -230, 0.7, 300);
      bld('medieval/building_lumbermill_yellow', W + 290, -220, Math.PI - 0.7, 300);
      bld('medieval/building_windmill_yellow', CX + 330, -330, Math.PI / 2, 300);
      bld('medieval/building_home_A_red', CX - 330, -330, Math.PI / 2, 250);
      bld('medieval/building_well_red', -230, H + 210, -0.6, 150);
      const fields = [];
      for (let k = 0; k < 6; k++) {
        fields.push({ x: -380 - (k % 2) * 170, y: 140 + k * 150, rot: 0 });
        fields.push({ x: W + 380 + (k % 2) * 170, y: 140 + k * 150, rot: 0 });
      }
      K.scatter('medieval/building_grain', fields, { size: 190 });
      
      // Pond with "ducks" (bottom right, outside the fence).
      K.water(W + 120, H + 120, W + 520, H + 380, { h: 1.5 });
      K.scatter('medieval/waterlily_A', [{ x: W + 200, y: H + 200 }, { x: W + 420, y: H + 300 }, { x: W + 300, y: H + 330 }], { size: 50 });
      K.scatter('medieval/waterplant_B', [{ x: W + 130, y: H + 140 }, { x: W + 510, y: H + 140 }, { x: W + 130, y: H + 370, rot: 1 }], { size: 70 });
      K.scatter('medieval/rock_single_B', [{ x: W + 110, y: H + 250 }, { x: W + 530, y: H + 260, rot: 2 }, { x: W + 320, y: H + 400, rot: 1 }], { size: 60 });
      const props = (name, list, size) => K.scatter(name, list.map(([x, y, rot]) => ({ x, y, rot })), { size });
      props('medieval/barrel', [[-120, -40, 0], [-80, -80, 1], [W + 110, H + 20, 0], [-110, H + 40, 2]], 48);
      props('medieval/crate_open', [[W + 120, -60, 0.4], [-140, H - 60, 1]], 54);
      props('medieval/crate_A_small', [[W + 160, -10, 0.1], [-170, H - 20, 0.8]], 40);
      props('medieval/sack', [[-150, -10, 0.5], [W + 90, -110, 1.4], [-60, H + 110, 0.2]], 44);
      props('medieval/wheelbarrow', [[-150, 300, 0.4], [W + 150, 700, 2.6]], 90);
      props('medieval/bucket_water', [[-90, 390, 0], [W + 90, 620, 0]], 30);
      props('medieval/resource_lumber', [[W + 170, 360, 1.5]], 110);
      const trees = [], small = [];
      for (let k = 0; k < (lo ? 18 : 34); k++) {
        const a = (k / (lo ? 18 : 34)) * TAU + 0.07;
        const rr = 1050 + (k % 3) * 160;
        const x = CX + Math.cos(a) * rr * 1.15, y = CY + Math.sin(a) * rr;
        (k % 3 ? trees : small).push({ x, y, rot: k * 1.3, s: 0.85 + (k % 4) * 0.12 });
      }
      K.scatter('medieval/trees_B_medium', trees, { size: 260 });
      K.scatter('medieval/trees_A_small', small, { size: 200 });
      K.scatter('medieval/tree_single_B', [[-120, 160], [W + 120, 860], [-300, 760], [W + 310, 120], [CX - 520, -160], [CX + 540, H + 170]].map(([x, y], k) => ({ x, y, rot: k })), { size: 150 });
      K.scatter('medieval/hills_C_trees', [{ x: -1500, y: -900, rot: 0.3 }, { x: 2500, y: -900, rot: 2 }, { x: -1600, y: 1900, rot: 1 }, { x: 2600, y: 1900, rot: 4 }], { size: 1200 });
      K.scatter('medieval/mountain_A_grass_trees', [{ x: CX - 900, y: -1900, rot: 0.5 }, { x: CX + 1100, y: -2000, rot: 2 }], { size: 1500 });
      if (!lo) K.scatter('medieval/cloud_big', [{ x: -400, y: -900, h: 700 }, { x: 1400, y: -700, h: 800, rot: 2 }, { x: 500, y: -1400, h: 900, rot: 1 }], { size: 420, cast: false });
      K.ambient('polvere', { n: 50, x0: X0, y0: Y0, x1: X1, y1: Y1, h: 160 });
      if (!lo) K.ambient('petali', { n: 30, h: 400 });
      // The farmer, furious, at the corner of the yard.
      o.farmer = K.npc('barbarian', { marker: false });
      o.farmerX = X0 - 90; o.farmerY = Y0 - 90;

      // Chickens: every body part is one InstancedMesh (all hens in a handful of draw calls).
      const MAXC = 96;
      const part = (geom, color, count) => {
        const m = new THREE.InstancedMesh(geom, new THREE.MeshStandardMaterial({ color, roughness: 0.75 }), count);
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.castShadow = !lo; m.receiveShadow = false; m.frustumCulled = false; m.count = 0;
        K.root.add(m);
        return m;
      };
      const sph = new THREE.SphereGeometry(1, 12, 9), cone = new THREE.ConeGeometry(1, 1, 8), box = new THREE.BoxGeometry(1, 1, 1), cyl = new THREE.CylinderGeometry(1, 1, 1, 5);
      o.parts = {
        body: part(sph, '#ffffff', MAXC), head: part(sph, '#ffffff', MAXC), beak: part(cone, '#ffffff', MAXC), comb: part(box, '#e8322f', MAXC),
        tail: part(cone, '#ffffff', MAXC), wing: part(sph, '#ffffff', MAXC * 2), leg: part(cyl, '#f0a020', MAXC * 2), eye: part(sph, '#1a1208', MAXC * 2),
      };
      // Per-instance colours must exist before the first render (shader variant).
      for (const m of Object.values(o.parts)) m.setColorAt(0, o.col.set('#ffffff'));
      o.MAXC = MAXC;
      // Golden-goose halos and stun stars / shadows.
      o.halo = [0, 1, 2].map(() => K.disc(1, K.glow('#ffd23f', { opacity: 0.5, add: true }), { cast: false }));
      o.shad = [...Array(8)].map(() => K.blob(1));
      for (const b of o.shad) b.always = true;

      // Players.
      o.pl = [...Array(n).keys()].map((i) => ({ av: K.avatar(i), dec: K.decal(200), key: '', stars: K.emoji('💫', 60) }));
      return o;
    },

    update(K, o, v, r) {
      const t = K.t;
      const tm = v.tm;
      if (!o.coops) { o.coops = true; buildCoops(K, o, !!tm); }
      // Coop signs and flags.
      o.pens.forEach((P, k) => {
        const pn = v.pn[k];
        if (!pn) return;
        if (o.signKey[k] !== pn.v) { o.signKey[k] = pn.v; P.sign.redraw(pn.v); }
        const pulse = pn.f > 0 ? 1 + pn.f * 0.35 : pn.f < 0 ? 1 + pn.f * 0.2 : 1;
        P.sign.scale.set(110 * pulse, 75.6 * pulse, 1);
        P.f.rotation.y = P.fb + Math.sin(t * 2 + k) * 0.1;
      });
      // Farmer: shakes his fist whenever a hen is stolen, otherwise watches.
      const farmerAngry = v.p.some((p) => p.n === 4);
      o.farmer.set(o.farmerX, o.farmerY, { r: 40, marker: false, look: Math.atan2(CY - o.farmerY, CX - o.farmerX), anim: farmerAngry ? 'Cheer' : 'Idle', gear: false });

      // Chickens (free, flying, carried, inside the coops, ducks in the pond).
      const P = o.parts, M4 = o.tmp, L4 = o.tmp2, q = o.q, e = o.e, vp = o.v, sv = o.sv;
      let idx = 0, w2 = 0, l2 = 0, e2 = 0, halo = 0, shad = 0;
      const put = (mesh, k, lx, ly, lz, sx, sy, sz, rx = 0, rz = 0) => {
        e.set(rx, 0, rz); q.setFromEuler(e);
        L4.compose(vp.set(lx, ly, lz), q, sv.set(sx, sy, sz));
        mesh.setMatrixAt(k, L4.premultiply(M4));
      };
      const chicken = (x, y, h, a, kind, flap, peck, scale = 1, duck = false) => {
        if (idx >= o.MAXC) return;
        const s = (kind === 1 ? 1.3 : kind === 2 ? 1.12 : 1) * scale;
        K.p(x, y, h, vp);
        e.set(0, -a, 0); q.setFromEuler(e);
        M4.compose(vp, q, sv.set(s, s, s));
        const bodyC = duck ? '#ffffff' : kind === 1 ? '#ffc928' : kind === 2 ? '#b4512a' : '#fbf5e6';
        put(P.body, idx, 0, 21, 0, 19, 16, 15);
        P.body.setColorAt(idx, o.col.set(bodyC));
        const hx = 15 + peck * 6, hy = 36 - peck * 16;
        put(P.head, idx, hx, hy, 0, 9.5, 9.5, 9);
        P.head.setColorAt(idx, o.col.set(kind === 2 ? '#7a2e14' : bodyC));
        put(P.beak, idx, hx + 10, hy - 1, 0, 3.4, 9, 3.4, 0, -Math.PI / 2);
        P.beak.setColorAt(idx, o.col.set(duck || kind === 1 ? '#ff8c1a' : '#ffad1f'));
        const comb = kind === 1 || duck ? 0.001 : kind === 2 ? 1.6 : 1;
        put(P.comb, idx, hx, hy + 9 * comb, 0, 9 * comb, 7 * comb, 2.6 * comb);
        put(P.tail, idx, -19, 30, 0, kind === 2 ? 10 : 7, kind === 2 ? 26 : 15, kind === 2 ? 5 : 7, 0, 0.9);
        P.tail.setColorAt(idx, o.col.set(kind === 2 ? '#1f4a2c' : bodyC));
        for (const sd of [-1, 1]) {
          put(P.wing, w2, -1, 24, sd * 13, 12, 7, 3, sd * flap, 0);
          P.wing.setColorAt(w2, o.col.set(kind === 2 ? '#8c3a1c' : kind === 1 ? '#ffb000' : duck ? '#f2f2f2' : '#efe6d0'));
          w2++;
          if (!duck) { put(P.leg, l2++, 3, 4.5, sd * 5, 1.6, 9, 1.6); }
          put(P.eye, e2++, hx + 6, hy + 2, sd * 5.5, 1.8, 1.8, 1.8);
        }
        idx++;
      };
      // Ducks in the pond.
      for (let k = 0; k < 3; k++) {
        const a = t * 0.25 + k * 2.1;
        chicken(W + 320 + Math.cos(a) * 120, H + 255 + Math.sin(a) * 60, 1 + Math.sin(t * 2 + k) * 2, a + Math.PI / 2, 0, 0.1, 0, 0.9, true);
      }
      // Hens in the coops (shown up to 14 per pen).
      v.pn.forEach((pn, k) => {
        const [px, py] = penXY(k), [ux, uy] = SIDE[k];
        const inA = Math.atan2(-uy, -ux);
        for (let j = 0; j < pn.l.length; j++) {
          const kind = Number(pn.l[j]) || 0;
          const ang = inA + (((j * 0.618) % 1) - 0.5) * 2.3;
          const rr = 40 + ((j * 0.37 + 0.2) % 1) * (pn.rr - 70);
          const peck = Math.max(0, Math.sin(t * 3 + j * 1.7)) ** 6;
          chicken(px + Math.cos(ang) * rr, py + Math.sin(ang) * rr, 2, ang + Math.sin(t * 0.7 + j) * 1.2, kind, 0.15, peck);
        }
      });
      // Loose and flying chickens.
      for (const c of v.c) {
        const fly = c.f === 1, pan = c.f === 2;
        const flap = fly || pan ? 0.35 + Math.sin(t * 40 + c.id) * 0.9 : 0.12;
        const hop = pan ? Math.abs(Math.sin(t * 16 + c.id)) * 8 : 0;
        const peck = !fly && !pan ? Math.max(0, Math.sin(t * 2.3 + c.id * 1.3)) ** 8 : 0;
        chicken(c.x, c.y, 2 + c.h + hop, c.a, c.k, flap, peck);
        if (c.k === 1 && halo < o.halo.length) {
          const hm = o.halo[halo++];
          hm.visible = true; K.place(hm, c.x, c.y, 3.2); hm.scale.setScalar(44 + Math.sin(t * 6) * 6);
        }
        if (c.h > 8 && shad < o.shad.length) {
          const b = o.shad[shad++];
          b.visible = true; K.place(b, c.x, c.y, 3.3);
          const k = Math.max(0.35, 1.2 - c.h / 900);
          b.scale.set(26 * k, 1, 26 * k);
        }
      }
      for (let k = halo; k < o.halo.length; k++) o.halo[k].visible = false;
      for (let k = shad; k < o.shad.length; k++) o.shad[k].visible = false;

      // Players (+ the chicken in their arms).
      let best = -1;
      if (r.ended) for (const q2 of v.hud.p) best = Math.max(best, q2);
      v.p.forEach((p, i) => {
        const Pl = o.pl[i];
        if (!Pl) return;
        const rr = PR * (p.sc || 1);
        let anim, animKey = p.k, animSpeed;
        let mood = MOODS[p.m] || 'ok';
        if (p.st) anim = 'Hit_B';
        else if (p.n === 2) anim = 'Throw';
        else if (p.n === 3) anim = 'Dodge_Forward';
        else if (p.n === 1 || p.n === 4) { anim = 'Interact'; animSpeed = 1.8; }
        else if (p.c >= 0) anim = p.w > 0.15 ? 'Walking_C' : 'Idle';
        if (r.ended) { mood = v.hud.p[i] === best ? 'happy' : 'dizzy'; if (mood === 'happy') anim = 'Cheer'; }
        Pl.av.set(p.x, p.y, { r: rr, look: p.a, mood, walk: p.w, anim, animKey, animSpeed, gear: false, lean: p.d ? 0.25 : 0 });
        if (p.c >= 0) {
          const flap = 0.4 + Math.sin(t * 30 + i) * 0.8;
          chicken(p.x + Math.cos(p.a) * rr * 0.55, p.y + Math.sin(p.a) * rr * 0.55, rr * 1.25, p.a + Math.sin(t * 9 + i) * 0.3, p.c, flap, 0, 0.9);
        }
        Pl.stars.visible = !!p.st;
        if (p.st) { K.place(Pl.stars, p.x + Math.cos(t * 8) * 18, p.y + Math.sin(t * 8) * 18, rr * 3.1); }
        // Ground ring: team colour (in team matches) + dash recharge + rooster fuse.
        const key = `${p.rd}|${p.d}|${tm}|${p.ct > 0 ? Math.round(p.ct * 20) : -1}`;
        Pl.dec.at(p.x, p.y, 3.4);
        if (key !== Pl.key) {
          Pl.key = key;
          const lt = K.col(i, 'light');
          Pl.dec.paint((d) => {
            if (tm) d.ring(0, 0, rr + 22, TEAMC[p.tm] + 'dd', 9);
            if (p.rd) d.ring(0, 0, rr + 10, lt + 'aa', 5);
            if (p.ct > 0) d.arc(0, 0, rr + 32, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.ct), p.ct > 0.7 ? '#ff3b3b' : '#ffb347', 8);
          });
        }
      });
      for (const m of Object.values(P)) {
        m.count = m === P.wing || m === P.eye ? (m === P.wing ? w2 : e2) : m === P.leg ? l2 : idx;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    },
  },

  // ---------------------------------------------------------------- 2D fallback
  render(d, v, r) {
    const t = d.t;
    drawYard(d, v, r.variant, (k) => penColor(d.col, v.tm, k), false);
    // Haystack.
    d.circle(CX, CY, HAY_R + 6, '#b98c3c');
    d.circle(CX, CY, HAY_R, '#f2d37a', '#9c7430', 4);
    d.circle(CX - 14, CY - 16, HAY_R * 0.5, '#f8e19a');
    // Coop hens.
    v.pn.forEach((pn, k) => {
      const [px, py] = penXY(k), [ux, uy] = SIDE[k];
      const inA = Math.atan2(-uy, -ux);
      for (let j = 0; j < pn.l.length; j++) {
        const kind = Number(pn.l[j]) || 0;
        const ang = inA + (((j * 0.618) % 1) - 0.5) * 2.3, rr = 40 + ((j * 0.37 + 0.2) % 1) * (pn.rr - 70);
        drawHen(d, px + Math.cos(ang) * rr, py + Math.sin(ang) * rr, kind, 0.8, t + j);
      }
      d.text(String(pn.v), px - ux * 40, py - uy * 40, { size: 46, color: '#fff7e0' });
    });
    for (const c of v.c) {
      if (c.h > 4) d.shadow(c.x, c.y + 6, 16, 7, 0.35);
      drawHen(d, c.x, c.y - c.h * 0.6, c.k, 1 + Math.min(0.6, c.h / 600), t + c.id);
    }
    v.p.forEach((p, i) => {
      const rr = PR * (p.sc || 1);
      d.shadow(p.x, p.y + rr * 0.7, rr, rr * 0.4, 0.35);
      if (v.tm) d.ring(p.x, p.y, rr + 10, TEAMC[p.tm], 6);
      if (p.rd) d.ring(p.x, p.y, rr + 4, d.col(i, 'light') + '88', 3);
      d.avatar(p.x, p.y, rr, i, { look: p.a, mood: MOODS[p.m] || 'ok', squash: p.d ? 0.2 : 0 });
      if (p.c >= 0) drawHen(d, p.x, p.y - rr - 10, p.c, 0.9, t * 3);
      if (p.ct > 0) d.arc(p.x, p.y, rr + 16, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.ct), '#ff5a3a', 5);
      if (p.st) d.text('💫', p.x, p.y - rr - 26, { size: 30 });
    });
  },
};

// Fence and coops depend on the match (team or not): built on the first update, when the view tells us.
function buildCoops(K, o, team) {
  const { THREE } = K;
  const n = o.n;
  // Fence around the yard (gaps where the coops are).
  const fence = [];
  const seg = 88;
  const gapOf = (k) => (k < (team ? 2 : n) ? (team ? 195 : 150) : 0);
  const sideRun = (k, x0, y0, x1, y1, rot) => {
    const L = hyp(x1 - x0, y1 - y0), cnt = Math.round(L / seg);
    for (let j = 0; j < cnt; j++) {
      const t = (j + 0.5) / cnt, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      const [px, py] = penXY(k);
      if (hyp(x - px, y - py) < gapOf(k) + 10) continue;
      fence.push({ x, y, rot: rot + Math.PI / 2 });
    }
  };
  sideRun(0, X0, Y1 + 10, X1, Y1 + 10, 0);
  sideRun(1, X0, Y0 - 10, X1, Y0 - 10, 0);
  sideRun(2, X0 - 10, Y0, X0 - 10, Y1, Math.PI / 2);
  sideRun(3, X1 + 10, Y0, X1 + 10, Y1, Math.PI / 2);
  K.scatter('medieval/fence_wood_straight', fence, { size: seg + 4 });
  // Corner posts.
  const post = K.texMat('legno', [1, 2], { color: '#8a5a32' });
  for (const [x, y] of [[X0 - 10, Y0 - 10], [X1 + 10, Y0 - 10], [X0 - 10, Y1 + 10], [X1 + 10, Y1 + 10]]) K.place(K.cyl(11, 62, post, { seg: 8 }), x, y);

  // Coops: wooden hen houses in the owner's colour, behind each pen, with flag and a counter sign.
  const np = team ? 2 : n;
  const wood = K.texMat('legno', [2, 1], { color: '#b88250' });
  const dark = K.mat('#3a2412', { rough: 0.9 });
  for (let k = 0; k < np; k++) {
    const [px, py] = penXY(k), [ux, uy] = SIDE[k];
    const col = penColor(K.col, team ? 1 : 0, k);
    const G = K.group();
    K.place(G, px + ux * 105, py + uy * 105);
    K.face(G, Math.atan2(-uy, -ux)); // local +X faces the yard
    const P = { parent: G };
    const wide = team ? 1.25 : 1;
    // Stilts, body, roof, door, ramp.
    for (const [sx, sz] of [[-40, -70], [-40, 70], [40, -70], [40, 70]]) K.place(K.cyl(7, 26, dark, { parent: G, seg: 6 }), sx, sz * wide);
    const body = K.box(100, 170 * wide, 66, wood, P); K.place(body, 0, 0, 26 + 33);
    // Gable roof: two tilted slabs in the owner's colour + a ridge beam.
    const roofM = K.mat(col, { rough: 0.65 });
    for (const sd of [-1, 1]) {
      const slab = K.box(66, 190 * wide, 8, roofM, P);
      K.place(slab, sd * 27, 0, 108);
      slab.rotation.z = -sd * 0.62;
    }
    K.place(K.box(10, 194 * wide, 10, dark, P), 0, 0, 128);
    const door = K.box(4, 46, 40, dark, P); K.place(door, 51, 0, 30 + 20);
    const ramp = K.box(70, 40, 6, wood, P); K.place(ramp, 80, 0, 16); ramp.rotation.z = 0.42;
    const stripe = K.box(102, 172 * wide, 8, K.mat(col, { rough: 0.5, emissive: col, ei: 0.15 }), P); K.place(stripe, 0, 0, 80);
    // Flag on the coop.
    const fslot = team ? k : (K.roster[k]?.color ?? k);
    const f = K.model(`medieval/flag_${FLAGN[fslot] || 'red'}`, { height: 170 });
    K.place(f, px + ux * 105 + (-uy) * (120 * wide), py + uy * 105 + ux * (120 * wide));
    K.face(f, Math.atan2(-uy, -ux));
    // Counter sign above the roof.
    const sign = K.billboard(160, 110, 110, (d, w, h, val) => {
      d.rrect(6, 6, w - 12, h - 12, 22, 'rgba(40,24,10,0.82)', col, 7);
      d.text(`🐔 ${val ?? 0}`, w / 2, h / 2 + 3, { size: 54, color: '#fff7e0' });
    });
    K.place(sign, px + ux * 70 + uy * (150 * wide), py + uy * 70 - ux * (150 * wide), 100);
    o.pens.push({ k, x: px, y: py, ux, uy, sign, f, fb: f.rotation.y });
    o.signKey.push(-1);
  }
}

function penColor(col, tm, k) {
  return tm ? TEAMC[k] : col(k);
}

// Yard markings: straw in the coops (owner colour border), scattered grain, puddles. Shared by 2D and the 3D layer.
function drawYard(d, v, variant, colOf, onLayer) {
  const { ctx } = d;
  if (!onLayer) {
    ctx.fillStyle = '#7bb04e'; ctx.fillRect(-300, -300, W + 600, H + 600);
    d.rect(X0, Y0, X1 - X0, Y1 - Y0, '#d9b98a', '#7a5230', 10);
  }
  // Grain and straw bits.
  for (let k = 0; k < 140; k++) {
    const x = X0 + 20 + ((k * 397) % (X1 - X0 - 40)), y = Y0 + 20 + ((k * 211 + (k % 7) * 53) % (Y1 - Y0 - 40));
    if (k % 3) d.circle(x, y, 2.6, 'rgba(250,224,140,0.7)');
    else d.line(x, y, x + 12, y + 5, 'rgba(240,210,120,0.75)', 3);
  }
  // Mud puddles (bigger and everywhere on the muddy variant).
  const mud = variant === 'fango';
  const pud = mud ? [[230, 300, 110], [770, 300, 110], [230, 700, 110], [770, 700, 110], [500, 250, 80], [500, 750, 80], [300, 500, 70], [700, 500, 70]] : [[260, 260, 50], [740, 740, 50], [760, 270, 36], [240, 730, 36]];
  for (const [x, y, rr] of pud) {
    d.circle(x, y, rr * 1.08, 'rgba(90,60,30,0.35)');
    d.circle(x, y, rr, mud ? 'rgba(110,74,40,0.85)' : 'rgba(120,86,52,0.6)');
    d.circle(x - rr * 0.3, y - rr * 0.3, rr * 0.25, 'rgba(255,255,255,0.18)');
  }
  // Coop floors.
  v.pn.forEach((pn, k) => {
    const [px, py] = penXY(k), [ux, uy] = SIDE[k];
    const a0 = Math.atan2(-uy, -ux);
    const c = colOf(k);
    ctx.save();
    ctx.beginPath(); ctx.rect(X0, Y0, X1 - X0, Y1 - Y0); ctx.clip();
    d.circle(px, py, pn.rr, '#f0d27a');
    for (let j = 0; j < 40; j++) {
      const a = a0 + ((j * 0.73) % 1 - 0.5) * 2.8, rr = (j * 0.41 % 1) * (pn.rr - 10);
      const x = px + Math.cos(a) * rr, y = py + Math.sin(a) * rr;
      d.line(x, y, x + Math.cos(j) * 16, y + Math.sin(j) * 16, 'rgba(190,140,50,0.8)', 3);
    }
    d.circle(px, py, pn.rr, c + '30');
    d.arc(px, py, pn.rr, a0 - Math.PI / 2, a0 + Math.PI / 2, c, 12);
    d.arc(px, py, pn.rr - 14, a0 - Math.PI / 2, a0 + Math.PI / 2, 'rgba(255,255,255,0.55)', 4);
    ctx.restore();
  });
}

function drawHen(d, x, y, kind, s, t) {
  const body = kind === 1 ? '#ffc928' : kind === 2 ? '#b4512a' : '#fbf5e6';
  const r = 16 * s * (kind === 1 ? 1.25 : 1);
  if (kind === 1) d.circle(x, y, r + 8, 'rgba(255,210,60,0.35)');
  d.circle(x, y, r, body, '#5a3a1a', 2);
  d.circle(x + r * 0.7, y - r * 0.6, r * 0.5, kind === 2 ? '#7a2e14' : body, '#5a3a1a', 2);
  d.poly([x + r * 1.1, y - r * 0.7, x + r * 1.55, y - r * 0.55, x + r * 1.1, y - r * 0.4], '#ffad1f');
  if (kind !== 1) d.circle(x + r * 0.7, y - r * 1.1, r * (kind === 2 ? 0.35 : 0.22), '#e8322f');
  d.circle(x - r * 0.2, y + Math.sin(t * 8) * 2, r * 0.45, kind === 2 ? '#8c3a1c' : '#efe6d0');
}
