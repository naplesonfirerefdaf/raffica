// La Trappola del Soffitto — a stone slab falls from the crypt's ceiling: stand under one of its holes or get
// flattened (top-down, dir + A dive + B shove). Up to 4 players, last one standing wins.
import { clamp, damp, dist, collideCircles, norm, lerp, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500;
const X0 = 80, Y0 = 80, X1 = 920, Y1 = 920; // pit interior
const BODY_R = 42, LIVES = 2;
const SHOVE_RANGE = 46, SHOVE_CD = 0.8, PUSH_KB = 760, PUSH_STUN = 0.45;
const DIVE_SPEED = 1150, DIVE_TIME = 0.18, DIVE_REC = 0.22, DIVE_CD = 1.5;
const CHEESE_R = 30;
const PRESS = 0.75;
const INSET = 0.6; // fraction of the radius that must be inside the hole edge
// Seats: 0 bottom, 1 top, 2 left, 3 right (start position and facing).
const START = [[CX, CY + 220, 0, -1], [CX, CY - 220, 0, 1], [CX - 220, CY, 1, 0], [CX + 220, CY, -1, 0]];

function phys(variant) {
  return variant === 'besciamella'
    ? { accel: 1000, keep: 0.55, max: 500, stunKeep: 0.5 }
    : { accel: 2800, keep: 0.012, max: 430, stunKeep: 0.08 };
}

const alive = (s) => s.p.filter((p) => !p.out);
const BOT_DELAY = [22 / 60, 13 / 60, 7 / 60]; // bots' reaction time per level (core/bots.js driver), in game steps

// Bots: remember the last inputs sent (they are still on their way, delayed by the reaction time)…
function botPush(m, out, D) {
  const n = Math.round(D * 60);
  if (!m.hist) { m.hist = new Float32Array(2 * 32); m.hi = 0; }
  m.hist[2 * m.hi] = out.x; m.hist[2 * m.hi + 1] = out.y; m.hi = (m.hi + 1) % n;
}
// …and replay them to predict where the body will be when the next input lands.
function botPredict(p, P, m, D) {
  const n = Math.round(D * 60), dt = 1 / 60, acc = P.accel / Math.sqrt(p.m), kk = Math.pow(P.keep, dt);
  let x = p.x, y = p.y, vx = p.vx, vy = p.vy, dive = p.dive, rec = p.rec, stun = p.stun;
  for (let j = 0; j < n - 1; j++) {
    const k = m.hist ? (m.hi + 1 + j) % n : -1;
    const ix = k >= 0 ? m.hist[2 * k] : 0, iy = k >= 0 ? m.hist[2 * k + 1] : 0;
    if (dive > 0) { dive -= dt; if (dive <= 0) rec = DIVE_REC; }
    else if (rec > 0) { rec -= dt; const q = Math.pow(0.002, dt); vx *= q; vy *= q; }
    else if (stun > 0) { stun -= dt; const q = Math.pow(P.stunKeep, dt); vx *= q; vy *= q; }
    else {
      vx = (vx + ix * acc * dt) * kk; vy = (vy + iy * acc * dt) * kk;
      const sp = Math.hypot(vx, vy);
      if (sp > P.max) { vx *= P.max / sp; vy *= P.max / sp; }
    }
    x = clamp(x + vx * dt, X0 + p.r, X1 - p.r); y = clamp(y + vy * dt, Y0 + p.r, Y1 - p.r);
  }
  return { x, y, vx, vy, free: dive <= 0 && rec <= 0 && stun <= 0 };
}

// Where a (possibly sliding) hole will be in t seconds, bouncing off the pit walls like in step().
function botHolePos(h, t) {
  const [ex, ey] = extents(h);
  const bounce = (x, v, lo, hi) => {
    if (!v || hi <= lo) return clamp(x, lo, hi);
    const L = hi - lo;
    let u = (x - lo + v * t) % (2 * L);
    if (u < 0) u += 2 * L;
    return lo + (u <= L ? u : 2 * L - u);
  };
  return [bounce(h.x, h.vx, X0 + ex + 10, X1 - ex - 10), bounce(h.y, h.vy, Y0 + ey + 10, Y1 - ey - 10)];
}

// ---------- hole geometry ----------

function extents(h) {
  if (h.s === 'r') return [h.w / 2, h.h / 2];
  return [h.w / 2, h.w / 2];
}

// Is a circle (x,y,r) inside the hole (with margin INSET*r)?
function inHole(h, x, y, r) {
  const m = r * INSET, dx = Math.abs(x - h.x), dy = Math.abs(y - h.y);
  if (h.s === 'r') return dx <= h.w / 2 - m && dy <= h.h / 2 - m;
  if (h.s === 'c') return Math.hypot(dx, dy) <= h.w / 2 - m;
  const a = h.w / 2 - m, t = h.h / 2 - m;
  return (dx <= a && dy <= t) || (dx <= t && dy <= a);
}

// Keep a circle inside the hole it stands in (used while the slab presses down).
function clampInHole(h, p) {
  const m = p.r * INSET;
  if (h.s === 'r') {
    p.x = clamp(p.x, h.x - h.w / 2 + m, h.x + h.w / 2 - m);
    p.y = clamp(p.y, h.y - h.h / 2 + m, h.y + h.h / 2 - m);
  } else if (h.s === 'c') {
    const R = Math.max(0, h.w / 2 - m), d = dist(h.x, h.y, p.x, p.y);
    if (d > R && d > 0) { p.x = h.x + (p.x - h.x) * R / d; p.y = h.y + (p.y - h.y) * R / d; }
  } else {
    const a = h.w / 2 - m, t = h.h / 2 - m;
    if (Math.abs(p.y - h.y) <= Math.abs(p.x - h.x)) {
      p.x = clamp(p.x, h.x - a, h.x + a); p.y = clamp(p.y, h.y - t, h.y + t);
    } else {
      p.x = clamp(p.x, h.x - t, h.x + t); p.y = clamp(p.y, h.y - a, h.y + a);
    }
  }
}

// Normalised closeness to a hole centre (0 = dead centre). Used for tiebreaks.
function holeProx(s, p) {
  if (!s.holes.length) return dist(p.x, p.y, CX, CY) / 100;
  let best = 1e9;
  for (const h of s.holes) {
    const [ex, ey] = extents(h);
    best = Math.min(best, dist(p.x, p.y, h.x, h.y) / Math.max(40, Math.min(ex, ey)));
  }
  return best;
}

function warnTime(s, variant) {
  return variant === 'uno' ? Math.max(1.5, 2.6 - s.drop * 0.12) : Math.max(0.95, 2.2 - s.drop * 0.11);
}
function restTime(s) { return Math.max(0.5, 1.0 - s.drop * 0.04); }

function makeHoles(s, g, warn) {
  const live = alive(s);
  const rmax = Math.max(...live.map((p) => p.r));
  const minDim = rmax * 2 * INSET + 40;
  const f = clamp(1 - s.drop * 0.075, 0, 1);
  const uno = g.variant === 'uno';
  const extra = Math.max(0, live.length - 2);
  // Musical chairs in "uno": one hole less than the players still in.
  const n = uno ? Math.max(1, live.length - 1) : (s.drop < 3 ? 2 : g.rng.chance(0.55) ? 1 : 2) + extra;
  const shrink = n > 2 ? 0.86 : 1;
  const reach = phys(g.variant).max * warn * 0.85 + 40;
  let holes = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    holes = [];
    for (let k = 0; k < n; k++) {
      const shape = uno ? g.rng.pick(['r', 'c']) : g.rng.pick(['r', 'r', 'c', 'x']);
      const h = { s: shape, x: CX, y: CY, w: 0, h: 0, vx: 0, vy: 0 };
      if (uno) {
        // Room for exactly one wobbly body.
        h.w = h.h = rmax * 2 * INSET + (shape === 'c' ? 62 : 52);
      } else if (shape === 'r') {
        h.w = Math.max(minDim, lerp(150, 270, f) * shrink * g.rng.range(0.9, 1.15));
        h.h = Math.max(minDim, lerp(125, 200, f) * shrink * g.rng.range(0.9, 1.15));
        if (g.rng.chance(0.5)) [h.w, h.h] = [h.h, h.w];
      } else if (shape === 'c') {
        h.w = h.h = Math.max(minDim + 10, lerp(145, 240, f) * shrink);
      } else {
        h.w = Math.max(minDim * 2, lerp(230, 320, f) * shrink);
        h.h = Math.max(minDim, lerp(100, 130, f));
      }
      const [ex, ey] = extents(h);
      h.x = g.rng.range(X0 + ex + 20, X1 - ex - 20);
      h.y = g.rng.range(Y0 + ey + 20, Y1 - ey - 20);
      if (g.variant === 'scorre') {
        const a = g.rng.range(0, TAU), sp = 110 + s.drop * 6;
        h.vx = Math.cos(a) * sp; h.vy = Math.sin(a) * sp;
      }
      holes.push(h);
    }
    let apart = true;
    for (let a = 0; a < holes.length && apart; a++) {
      for (let b = a + 1; b < holes.length; b++) {
        if (dist(holes[a].x, holes[a].y, holes[b].x, holes[b].y) <= Math.max(...extents(holes[a])) + Math.max(...extents(holes[b])) + 40) { apart = false; break; }
      }
    }
    const reachable = live.every((p) => holes.some((h) => dist(p.x, p.y, h.x, h.y) <= reach));
    if (apart && reachable) break;
  }
  return holes;
}

function startDrop(s, g) {
  s.ph = 0; s.pt = 0; s.pd = warnTime(s, g.variant);
  s.holes = makeHoles(s, g, s.pd);
  s.squashed = s.p.map(() => 0);
  if (!s.cheese && s.drop >= 2 && s.drop % 3 === 2) {
    // Shield power-up, a little closer to whoever has fewer lives.
    let x = g.rng.range(X0 + 80, X1 - 80), y = g.rng.range(Y0 + 80, Y1 - 80);
    const live = alive(s);
    const lo = Math.min(...live.map((p) => s.lives[p.i])), hi = Math.max(...live.map((p) => s.lives[p.i]));
    if (lo !== hi) { const lp = live.find((p) => s.lives[p.i] === lo); x += (lp.x - x) * 0.4; y += (lp.y - y) * 0.4; }
    s.cheese = { x, y };
    g.sfx('powerup', { vol: 0.6 }); g.ring(x, y, { color: '#ffd23f', r: 90 });
  }
  g.sfx('whoosh', { pitch: 0.7 + Math.min(0.6, s.drop * 0.05) });
  if (s.drop === 0) g.say('ARRIVA IL SOFFITTO!');
  else if (s.drop === 4) g.say('PIÙ VELOCE!');
}

function land(s, g) {
  s.ph = 1; s.pt = 0; s.pd = PRESS;
  g.sfx('crash'); g.sfx('land', { pitch: 0.6 }); g.shake(0.5); g.hitstop(0.06);
  g.burst(X0, CY, { color: '#b9b0a2', n: 10, speed: 260 });
  g.burst(X1, CY, { color: '#b9b0a2', n: 10, speed: 260 });
  const live = alive(s);
  const prox = s.p.map((p) => holeProx(s, p));
  const crushed = live.filter((p) => !s.holes.some((h) => inHole(h, p.x, p.y, p.r)));
  for (const p of s.p) { p.dive = 0; p.rec = 0; p.push = 0; }
  const flatT = PRESS + restTime(s) * 0.85;
  for (const p of live) {
    p.safe = !crushed.includes(p);
    p.hole = p.safe ? s.holes.findIndex((h) => inHole(h, p.x, p.y, p.r)) : -1;
  }
  for (const p of crushed.slice()) {
    if (!p.shield) continue;
    // Shield: the slab bounces off once.
    p.shield = 0; p.safe = true; crushed.splice(crushed.indexOf(p), 1);
    g.sfx('boing'); g.sfx('break', { vol: 0.6 });
    g.text(p.x, p.y - p.r - 30, 'SALVATO DALLO SCUDO!', { player: p.i, size: 40 });
    g.burst(p.x, p.y, { color: '#ffd23f', n: 22, speed: 320, size: 9 });
  }
  for (const p of crushed) {
    s.lives[p.i]--;
    s.squashed[p.i] = 1;
    p.flat = flatT; p.vx = 0; p.vy = 0; p.push = 0;
    g.sfx('squish'); g.vibrate(p.i, 220);
    g.burst(p.x, p.y, { color: '#8d877e', n: 26, speed: 380, size: 10 });
    g.text(p.x, p.y - p.r - 30, 'SCHIACCIATO!', { player: p.i, size: 48 });
  }
  if (crushed.length) { g.shake(0.75); g.hitstop(0.1); }
  if (crushed.length >= 2 && crushed.length === live.length) g.say(live.length === 2 ? 'SPIACCICATI TUTTI E DUE!' : 'SPIACCICATI TUTTI!');
  else if (crushed.length === 0) { g.sfx('pop'); g.say('SALVI!'); }
  else if (crushed.length === 1) g.text(crushed[0].x, crushed[0].y + crushed[0].r + 40, 'SPLAT!', { player: crushed[0].i, size: 40 });

  const dead = crushed.filter((p) => s.lives[p.i] <= 0);
  for (const p of dead) p.out = true;
  const left = alive(s);
  if (dead.length && left.length === 0) {
    // Everyone still in got flattened for good: the one closest to a hole wins.
    let w = dead[0];
    for (const p of dead) if (prox[p.i] < prox[w.i]) w = p;
    g.slowmo(0.35, 1); g.sfx('fanfare');
    g.end(w.i, 'Più vicino al buco!');
  } else if (dead.length && left.length === 1) {
    g.slowmo(0.35, 1); g.sfx('fanfare');
    g.end(left[0].i, 'Schiacciato come una frittella!');
  } else if (dead.length) {
    for (const p of dead) g.text(p.x, p.y + p.r + 70, 'FUORI!', { player: p.i, size: 50 });
  }
  s.drop++;
}

export default {
  id: 'lasagna',
  name: 'La Trappola del Soffitto',
  rule: 'Mettiti sotto un buco del soffitto o sei schiacciato!',
  verb: 'NEL BUCO!',
  inspired: 'Mario Party 4 · Booksquirm',
  cam: 'top',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Tuffo', b: 'Spintone' },
  help: {
    goal: "Quando il soffitto di pietra crolla stai sotto un buco: chi resta sotto perde una vita (2 vite, 3 con Un Buco in Meno). Vince l'ultimo in piedi.",
    dir: "Corri per la cripta. L'ombra scura mostra dove cadrà la lastra; i buchi restano chiari e verdi.",
    a: 'TUFFO: scatto lunghissimo nella direzione della levetta per arrivare al buco in tempo (dopo resti fermo un attimo).',
    b: 'SPINTONE: spinta a due mani su chi ti sta davanti, senza muoverti: perfetto per difendere il tuo buco!',
    tips: ['Anello verde attorno a te = sei al sicuro', 'Lo SCUDO 🛡️ ti salva da uno schiacciamento', 'La lastra cade sempre più veloce'],
  },
  duration: 45,
  supports: ['scale'],
  variants: [
    { id: 'uno', name: 'Un Buco in Meno', desc: 'Buchi per uno solo, uno in meno dei giocatori! 3 vite.' },
    { id: 'scorre', name: 'Buchi che Scorrono', desc: 'I buchi si muovono mentre la lastra cade!' },
    { id: 'besciamella', name: 'Pavimento Unto', desc: 'La cripta è unta di grasso di drago: si scivola!' },
  ],

  init(g) {
    const n = g.n || 2;
    const sc = g.mods.scale || [];
    const L0 = g.variant === 'uno' ? 3 : LIVES;
    return {
      ph: 2, pt: 0, pd: 0.7, drop: 0, layer: 0, holes: [], lives: Array(n).fill(L0), maxL: L0, squashed: Array(n).fill(0), cheese: null,
      p: Array.from({ length: n }, (_, i) => {
        const k = sc[i] ?? 1, [x, y, fx, fy] = START[i];
        return {
          i, r: BODY_R * k, m: k * k, x, y, vx: 0, vy: 0, fx, fy,
          push: 0, cd: 0.3, stun: 0, flat: 0, safe: false, hole: -1, dive: 0, rec: 0, dcd: 0.3, shield: 0, out: false,
        };
      }),
    };
  },

  step(s, inp, g) {
    const dt = g.dt;
    const P = phys(g.variant);

    // Drop cycle: rest -> warn (shadow grows) -> press (slab down) -> rest.
    s.pt += dt;
    if (s.ph === 2 && s.pt >= s.pd && !g.ended) startDrop(s, g);
    else if (s.ph === 0) {
      if (g.variant === 'scorre') {
        for (const h of s.holes) {
          const [ex, ey] = extents(h);
          h.x += h.vx * dt; h.y += h.vy * dt;
          if (h.x < X0 + ex + 10) { h.x = X0 + ex + 10; h.vx = Math.abs(h.vx); }
          if (h.x > X1 - ex - 10) { h.x = X1 - ex - 10; h.vx = -Math.abs(h.vx); }
          if (h.y < Y0 + ey + 10) { h.y = Y0 + ey + 10; h.vy = Math.abs(h.vy); }
          if (h.y > Y1 - ey - 10) { h.y = Y1 - ey - 10; h.vy = -Math.abs(h.vy); }
        }
        // Moving holes bounce off each other (overlapping holes would look like rubble).
        for (let a = 0; a < s.holes.length; a++) {
          for (let b = a + 1; b < s.holes.length; b++) {
            const h0 = s.holes[a], h1 = s.holes[b], [ax, ay] = extents(h0), [bx, by] = extents(h1);
            const ox = ax + bx + 24 - Math.abs(h1.x - h0.x), oy = ay + by + 24 - Math.abs(h1.y - h0.y);
            if (ox > 0 && oy > 0) {
              if (ox < oy) {
                const sg = h1.x >= h0.x ? 1 : -1;
                h0.x -= sg * ox / 2; h1.x += sg * ox / 2;
                h0.vx = -sg * Math.abs(h0.vx); h1.vx = sg * Math.abs(h1.vx);
              } else {
                const sg = h1.y >= h0.y ? 1 : -1;
                h0.y -= sg * oy / 2; h1.y += sg * oy / 2;
                h0.vy = -sg * Math.abs(h0.vy); h1.vy = sg * Math.abs(h1.vy);
              }
            }
          }
        }
      }
      const left = s.pd - s.pt;
      if (left < 0.6 && left + dt >= 0.6) g.sfx('fuse', { vol: 0.5 });
      if (s.pt >= s.pd && !g.ended) land(s, g);
    } else if (s.ph === 1 && s.pt >= s.pd) {
      s.ph = 2; s.pt = 0; s.pd = restTime(s);
      s.layer++;
      g.sfx('slide', { vol: 0.5 });
    }

    const shoves = [];
    for (const p of s.p) {
      const i = inp[p.i];
      p.cd = Math.max(0, p.cd - dt);
      p.stun = Math.max(0, p.stun - dt);
      if (p.flat > 0) {
        p.flat -= dt;
        p.vx = 0; p.vy = 0;
        if (p.flat <= 0) { p.flat = 0; if (!p.out) { g.sfx('boing'); g.burst(p.x, p.y, { player: p.i, n: 10, speed: 200 }); } }
        continue;
      }
      if (p.out) { p.vx = 0; p.vy = 0; continue; }
      if (s.ph === 1) {
        // Survivors are stuck in their hole while the slab presses down.
        p.vx = 0; p.vy = 0; p.push = 0;
        if (p.hole >= 0 && s.holes[p.hole]) clampInHole(s.holes[p.hole], p);
        continue;
      }
      p.dcd = Math.max(0, p.dcd - dt);
      p.push = Math.max(0, p.push - dt);
      if (Math.hypot(i.x, i.y) > 0.2 && p.stun <= 0 && p.dive <= 0) { const n = norm(i.x, i.y); p.fx = n.x; p.fy = n.y; }
      if (p.dive > 0) { p.dive -= dt; if (p.dive <= 0) p.rec = DIVE_REC; }
      else if (p.rec > 0) { p.rec -= dt; const k = damp(0.002, dt); p.vx *= k; p.vy *= k; }
      else if (p.stun > 0) { const k = damp(P.stunKeep, dt); p.vx *= k; p.vy *= k; }
      else {
        const acc = P.accel / Math.sqrt(p.m);
        p.vx += i.x * acc * dt; p.vy += i.y * acc * dt;
        const k = damp(P.keep, dt);
        p.vx *= k; p.vy *= k;
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > P.max) { p.vx *= P.max / sp; p.vy *= P.max / sp; }
      }
      const free = p.stun <= 0 && p.dive <= 0 && p.rec <= 0;
      if (i.aP && free && p.dcd <= 0 && !g.ended) {
        const n = Math.hypot(i.x, i.y) > 0.2 ? norm(i.x, i.y) : { x: p.fx, y: p.fy };
        p.fx = n.x; p.fy = n.y;
        p.vx = n.x * DIVE_SPEED; p.vy = n.y * DIVE_SPEED;
        p.dive = DIVE_TIME; p.dcd = DIVE_CD;
        g.sfx('jump', { pitch: 0.9 }); g.burst(p.x, p.y, { player: p.i, n: 8, speed: 160 });
      } else if (i.bP && free && p.cd <= 0 && !g.ended) shoves.push({ p, at: i.bT, tgt: -1 });
      p.x += p.vx * dt; p.y += p.vy * dt;
      // Pit walls.
      if (p.x < X0 + p.r) { p.x = X0 + p.r; if (p.vx < 0) p.vx = -p.vx * 0.5; }
      if (p.x > X1 - p.r) { p.x = X1 - p.r; if (p.vx > 0) p.vx = -p.vx * 0.5; }
      if (p.y < Y0 + p.r) { p.y = Y0 + p.r; if (p.vy < 0) p.vy = -p.vy * 0.5; }
      if (p.y > Y1 - p.r) { p.y = Y1 - p.r; if (p.vy > 0) p.vy = -p.vy * 0.5; }
    }

    const solid = (p) => !p.out && !p.flat && s.ph !== 1;
    // Shoves: two-handed push on the closest player in front, resolved together (earlier press wins a mutual exchange).
    for (const sh of shoves) {
      const p = sh.p;
      let bd = 1e9;
      for (const o of s.p) {
        if (o === p || !solid(o) || !solid(p)) continue;
        const dx = o.x - p.x, dy = o.y - p.y, dd = Math.hypot(dx, dy) || 1;
        if (dd - p.r - o.r < SHOVE_RANGE && (dx * p.fx + dy * p.fy) / dd > 0.2 && dd < bd) { bd = dd; sh.tgt = o.i; }
      }
    }
    for (const a of shoves) for (const b of shoves) {
      if (a !== b && a.tgt === b.p.i && b.tgt === a.p.i && Math.abs(a.at - b.at) > 0.02 && a.at > b.at) a.tgt = -1;
    }
    shoves.forEach((sh) => {
      const p = sh.p;
      p.cd = SHOVE_CD; p.push = 0.2;
      if (sh.tgt < 0) { g.sfx('whoosh', { vol: 0.5, pitch: 1.5 }); return; }
      const o = s.p[sh.tgt];
      const n = norm(o.x - p.x, o.y - p.y);
      const kb = PUSH_KB * clamp(Math.sqrt(p.m / o.m), 0.6, 1.5);
      o.vx = n.x * kb; o.vy = n.y * kb; o.stun = PUSH_STUN; o.dive = 0; o.rec = 0;
      p.vx -= n.x * 60; p.vy -= n.y * 60;
      g.sfx('punch'); g.shake(0.35); g.hitstop(0.05); g.vibrate(o.i, 80);
      g.burst((p.x + o.x) / 2, (p.y + o.y) / 2, { color: '#fff', n: 14, speed: 320 });
      g.text(o.x, o.y - o.r - 24, 'SPINTONE!', { player: p.i });
    });
    for (let a = 0; a < s.p.length; a++) {
      for (let b = a + 1; b < s.p.length; b++) {
        if (!solid(s.p[a]) || !solid(s.p[b])) continue;
        const imp = collideCircles(s.p[a], s.p[b], 0.6);
        if (imp > 250) g.sfx('bonk', { pitch: 1.3, vol: 0.5 });
      }
    }

    if (s.cheese) {
      for (const p of s.p) {
        if (p.out || p.flat || p.shield || dist(p.x, p.y, s.cheese.x, s.cheese.y) > p.r + CHEESE_R) continue;
        p.shield = 1;
        g.sfx('pickup'); g.sfx('coin', { pitch: 1.2, vol: 0.6 });
        g.text(p.x, p.y - p.r - 30, 'SCUDO MAGICO!', { player: p.i, size: 40 });
        g.burst(s.cheese.x, s.cheese.y, { color: '#ffd23f', n: 16, speed: 260 });
        s.cheese = null;
        break;
      }
    }

    // Live "am I safe?" flag for the warning phase.
    if (s.ph === 0) for (const p of s.p) p.safe = !p.out && !p.flat && s.holes.some((h) => inHole(h, p.x, p.y, p.r));
  },

  timeout(s) {
    // Most lives among those still in; then closest to a hole (or to the centre between drops).
    let w = null;
    for (const p of alive(s)) {
      if (!w || s.lives[p.i] > s.lives[w.i] || (s.lives[p.i] === s.lives[w.i] && holeProx(s, p) < holeProx(s, w))) w = p;
    }
    return w ? w.i : 0;
  },

  view(s) {
    return {
      ph: s.ph, k: r2(clamp(s.pt / s.pd, 0, 1)), L: s.layer, ch: s.cheese ? { x: r1(s.cheese.x), y: r1(s.cheese.y) } : null,
      holes: s.holes.map((h) => ({ s: h.s, x: r1(h.x), y: r1(h.y), w: r1(h.w), h: r1(h.h) })),
      p: s.p.map((p) => ({
        x: r1(p.x), y: r1(p.y), r: r1(p.r), fx: r2(p.fx), fy: r2(p.fy),
        d: p.dive > 0 ? 1 : 0, rc: p.rec > 0 ? 1 : 0, sh: r2(p.push), cd: r2(p.cd), dc: r2(p.dcd), sd: p.shield, fl: r2(p.flat), st: p.stun > 0 ? 1 : 0, sf: p.safe ? 1 : 0, sq: s.squashed[p.i],
        o: p.out ? 1 : 0, w: r2(Math.min(1, Math.hypot(p.vx, p.vy) / 430)),
      })),
      hud: { p: s.lives.slice(), max: s.maxL, label: 'Vite' },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  // Computer player: waits in the middle of the crypt, picks the hole it reaches first (a free one when there is
  // room for one only; where the moving hole will be), dives when far, grabs the shield on the way if there is time,
  // and (medio/difficile) shoves rivals out of the holes just before the slab lands.
  bot(s, me, g, B) {
    const p = s.p[me], m = B.mem, lv = B.level;
    const out = { x: 0, y: 0 };
    if (!p || p.out || p.flat > 0 || s.ph === 1 || g.ended) return out;
    const P = phys(g.variant), D = BOT_DELAY[lv], uno = g.variant === 'uno';
    const acc = P.accel / Math.sqrt(p.m), drag = -Math.log(P.keep);
    const free = p.stun <= 0 && p.dive <= 0 && p.rec <= 0;
    const left = s.ph === 0 ? s.pd - s.pt : 9;
    let tx = CX, ty = CY, hvx = 0, hvy = 0, hole = null;

    if (s.ph === 0 && s.holes.length) {
      // Choose a hole: earliest arrival, avoiding the ones a rival will get to first when there's room for one.
      if (m.drop !== s.drop) { m.drop = s.drop; m.hole = -1; }
      let best = -1, bs = 1e9;
      s.holes.forEach((h, k) => {
        const t = Math.max(0, Math.min(left, dist(p.x, p.y, h.x, h.y) / P.max));
        const [hx, hy] = botHolePos(h, t);
        let sc = dist(p.x, p.y, hx, hy) / P.max + (k === m.hole ? -0.12 : 0);
        for (const o of s.p) {
          if (o === p || o.out || o.flat > 0) continue;
          const od = dist(o.x, o.y, hx, hy), md = dist(p.x, p.y, hx, hy);
          if (uno && od < md - 10) sc += od < 60 ? 1.2 : 0.6;
          else if (!uno && od < 120) sc += 0.08;
        }
        if (sc < bs) { bs = sc; best = k; }
      });
      m.hole = best;
      hole = s.holes[best];
      const t = Math.max(0, Math.min(left, dist(p.x, p.y, hole.x, hole.y) / P.max * 0.7 + D));
      [tx, ty] = botHolePos(hole, t);
      if (g.variant === 'scorre' && inHole(hole, p.x, p.y, p.r)) { hvx = hole.vx; hvy = hole.vy; [tx, ty] = botHolePos(hole, D); }
      // Shield on the way, if there is time.
      if (s.cheese && !p.shield && lv > 0) {
        const c = s.cheese, via = (dist(p.x, p.y, c.x, c.y) + dist(c.x, c.y, tx, ty)) / (P.max * 0.85) + D + 0.25;
        if (via < left) { tx = c.x; ty = c.y; }
      }
    } else if (s.cheese && !p.shield) { tx = s.cheese.x; ty = s.cheese.y; }

    // Shove a rival out of a hole when the slab is about to land (or anyone near my only hole in "uno").
    if (lv > 0 && free && p.cd <= 0 && s.ph === 0) {
      const mine = hole && inHole(hole, p.x, p.y, p.r);
      for (const o of s.p) {
        if (o === p || o.out || o.flat > 0 || o.stun > 0) continue;
        const dd = dist(o.x, o.y, p.x, p.y);
        if (dd - p.r - o.r > SHOVE_RANGE * 0.85) continue;
        const oIn = s.holes.some((h) => inHole(h, o.x, o.y, o.r));
        const late = left - D < (lv === 2 ? 0.8 : 0.6) && left - D > 0.03;
        if ((uno && (mine || oIn) && left - D > 0.03) || (late && oIn && (mine || uno))) {
          out.x = ((o.x - p.x) / dd) * 0.4; out.y = ((o.y - p.y) / dd) * 0.4; out.tapB = true;
          botPush(m, out, D);
          return out;
        }
      }
    }

    // Move with braking (the greasy floor needs much more of it), diving when far. The controller works on where
    // I'll be when this input lands (my own queued inputs replayed), so slow reactions don't overshoot.
    const f = botPredict(p, P, m, D);
    const dx = tx - f.x, dy = ty - f.y, d = Math.hypot(dx, dy) || 1;
    const brake = g.variant === 'besciamella' ? Math.sqrt(2 * acc * 0.5 * d) : d * 6;
    const want = Math.min(P.max, brake);
    const vx = (dx / d) * want + hvx, vy = (dy / d) * want + hvy;
    out.x = (vx * drag) / acc + (vx - f.vx) / (acc * 0.09);
    out.y = (vy * drag) / acc + (vy - f.vy) / (acc * 0.09);
    const ol = Math.hypot(out.x, out.y);
    if (ol > 1) { out.x /= ol; out.y /= ol; }
    if (s.ph === 0 && free && p.dcd <= 0 && f.free && d > 280 && (lv > 0 || d / P.max > left - D - 0.2)) {
      out.x = dx / d; out.y = dy / d; out.tapA = true;
    }
    botPush(m, out, D);
    return out;
  },

  // ---------- 3D: a torch-lit crypt, a stone slab on chains drops from the dark ceiling ----------
  render3d: {
    assets: [
      'dungeon/wall', 'dungeon/wall_arched', 'dungeon/wall_window_closed', 'dungeon/wall_corner', 'dungeon/pillar_decorated', 'dungeon/column',
      'dungeon/torch_mounted', 'dungeon/banner_patternA_red', 'dungeon/banner_patternA_blue', 'dungeon/banner_patternA_green', 'dungeon/banner_patternA_yellow',
      'dungeon/banner_thin_white', 'dungeon/barrel_large', 'dungeon/barrel_small_stack', 'dungeon/crates_stacked', 'dungeon/box_stacked',
      'dungeon/trunk_large_A', 'dungeon/coin_stack_large', 'dungeon/coin_stack_medium', 'dungeon/candle_triple', 'dungeon/candle_melted',
      'dungeon/table_long_decorated_A', 'dungeon/chair', 'dungeon/shelf_small_candles', 'dungeon/sword_shield', 'dungeon/rubble_large',
      'dungeon/rubble_half', 'dungeon/keg_decorated', 'dungeon/floor_tile_big_grate', 'weapons/shield_round_color',
    ],
    build(K, r) {
      const bech = r.variant === 'besciamella';
      const { THREE } = K;
      const N = Math.max(2, Math.min(4, r.n || K.n || 2));
      const o = { bech };
      const PW = X1 - X0, PH = Y1 - Y0;
      K.theme('grotta', { fogNear: 1.5, fogFar: 3.6 });
      K.ground('lastre', { tile: 150, margin: 1500, color: '#6e6862' });
      buildCrypt(K, o, N);
      // The pit: a raised stone curb all around (with an iron trim) where the slab lands.
      const curb = K.texMat('muro', [10, 1], { color: '#b0a698' }), curbS = K.texMat('muro', [1, 10], { color: '#b0a698' });
      const trim = K.mat('#3a3634', { rough: 0.5, metal: 0.5 });
      for (const [x, y, w, h, m] of [[CX, Y0 - 14, PW + 56, 28, curb], [CX, Y1 + 14, PW + 56, 28, curb], [X0 - 14, CY, 28, PH, curbS], [X1 + 14, CY, 28, PH, curbS]]) {
        K.place(K.box(w, h, 40, m), x, y, 20);
        K.place(K.box(w + (w > h ? 0 : 6), h + (h > w ? 0 : 6), 4, trim, { cast: false }), x, y, 41);
      }
      // Pit floor (repainted when a layer is added: dust and cracks pile up).
      K.layer({ x0: X0, y0: Y0, x1: X1, y1: Y1, h: 0.5, maxPx: 1024, draw: (d, v) => drawFloor(d, v.L, bech), key: (v) => `${v.L}` });
      // Shadow of the falling slab with the lit holes.
      K.layer({ x0: X0, y0: Y0, x1: X1, y1: Y1, h: 1.2, transparent: true, z: 1, maxPx: 1024,
        draw: (d, v) => {
          if (v.ph !== 0) return;
          const { ctx } = d;
          ctx.globalAlpha = 0.2 + 0.6 * v.k;
          ctx.fillStyle = '#05030a';
          sheetPath(ctx, v.holes);
          ctx.fill();
          ctx.globalAlpha = 0.55 + 0.45 * Math.sin(d.t * (8 + v.k * 22));
          for (const h of v.holes) strokeHole(ctx, h, '#7dff6b', 9);
          ctx.globalAlpha = 1;
        },
        key: (v) => (v.ph !== 0 ? 'off' : `${holesKey(v.holes)}|${Math.round(v.k * 20)}|${Math.round(Math.sin(K.t * (8 + v.k * 22)) * 3)}`) });
      // Green light rising from the holes while the slab falls.
      o.holeGlow = [0, 1, 2, 3].map(() => { const m = K.glow('#7dff6b', { opacity: 0.25, add: true, unique: true }); return { m, c: K.cyl(1, 1, m, { seg: 24, open: true, cast: false }) }; });
      // The stone slab with holes (top + darker underside for thickness) hanging on four chains.
      o.sheetBot = K.layer({ x0: X0, y0: Y0, x1: X1, y1: Y1, h: 20, transparent: true, z: 2, maxPx: 1024,
        draw: (d, v) => { d.ctx.fillStyle = '#4a443d'; sheetPath(d.ctx, v.holes); d.ctx.fill(); }, key: (v) => holesKey(v.holes) });
      o.sheetTop = K.layer({ x0: X0, y0: Y0, x1: X1, y1: Y1, h: 30, transparent: true, z: 3, maxPx: 1024,
        draw: (d, v) => drawSheet(d, v.holes, bech), key: (v) => holesKey(v.holes) });
      for (const L of [o.sheetTop, o.sheetBot]) L.mesh.castShadow = false;
      const chainM = K.mat('#2b2826', { rough: 0.45, metal: 0.7 });
      o.chains = [[X0 + 40, Y0 + 40], [X1 - 40, Y0 + 40], [X0 + 40, Y1 - 40], [X1 - 40, Y1 - 40]].map(([x, y]) => {
        const g = K.group();
        K.place(g, x, y, 0);
        const ringM = K.torus(14, 4, chainM, { parent: g, cast: false }); ringM.position.y = 4;
        for (let k = 0; k < 18; k++) {
          const link = K.torus(9, 2.6, chainM, { parent: g, cast: false });
          link.position.y = 18 + k * 15;
          link.rotation.set(Math.PI / 2, k % 2 ? Math.PI / 2 : 0, 0);
        }
        return g;
      });
      // Shield power-up: a magic round shield spinning over a golden glow.
      o.cheese = K.model('weapons/shield_round_color', { height: 64 });
      o.cheeseGlow = K.disc(1, K.glow('#ffd23f', { opacity: 0.4, add: true }));
      // Players.
      o.pl = Array.from({ length: N }, (_, i) => ({
        av: K.avatar(i),
        slab: K.box(1, 1, 1, K.texMat('pietra', [1, 1], { color: '#9a9288' }), { cast: false }),
        bump: K.ball(1, K.mat('#8d877e', { rough: 0.9 })),
        bumpRing: K.torus(1, 0.05, K.glow(K.col(i)), { cast: false }),
        dizzy: K.emoji('💫', 46),
        ghost: K.emoji('👻', 48),
        palms: [0, 1].map(() => K.ball(1, K.mat(K.col(i, 'light'), { rough: 0.4 }))),
        shield: K.model('weapons/shield_round_color', { height: 30 }),
        shieldRing: K.torus(1, 0.04, K.glow('#ffd23f', { opacity: 0.8 }), { cast: false }),
        dec: K.decal(220),
      }));
      void THREE;
      return o;
    },
    update(K, o, v) {
      const t = K.t;
      // Slab height: high and faint while warning, slammed down when pressing.
      const on = v.ph !== 2 && v.holes.length > 0;
      let sh = 0, al = 1;
      if (v.ph === 0) { sh = 16 + 560 * (1 - v.k) * (1 - v.k); al = 0.2 + 0.7 * v.k * v.k; }
      else if (v.ph === 1) sh = 16 + Math.max(0, 12 * (1 - v.k * 4));
      for (const [L, dh] of [[o.sheetTop, 0], [o.sheetBot, -10]]) {
        L.mesh.visible = on;
        L.mesh.position.y = sh + dh;
        L.mesh.material.opacity = al;
      }
      o.chains.forEach((c) => { c.visible = on; c.position.y = sh + 2; });
      o.holeGlow.forEach((G, k) => {
        const h = v.holes[k];
        G.c.visible = v.ph === 0 && !!h;
        if (!G.c.visible) return;
        const [ex, ey] = extents(h);
        K.place(G.c, h.x, h.y, 1);
        G.c.scale.set(Math.min(ex, ey) * 0.95, Math.max(20, sh - 10), Math.min(ex, ey) * 0.95);
        G.m.opacity = 0.08 + 0.18 * v.k + 0.06 * Math.sin(t * 12);
      });
      // Shield power-up.
      o.cheese.visible = o.cheeseGlow.visible = !!v.ch;
      if (v.ch) {
        K.place(o.cheese, v.ch.x, v.ch.y, 26 + Math.sin(t * 5) * 8);
        o.cheese.rotation.set(0, t * 2.5, 0);
        K.place(o.cheeseGlow, v.ch.x, v.ch.y, 2);
        o.cheeseGlow.scale.setScalar(CHEESE_R + 14 + Math.sin(t * 8) * 4);
      }
      v.p.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const look = Math.atan2(p.fy, p.fx);
        P.slab.visible = P.bump.visible = P.bumpRing.visible = P.dizzy.visible = P.ghost.visible = false;
        for (const m of P.palms) m.visible = false;
        P.shield.visible = P.shieldRing.visible = false;
        if (p.fl > 0 || p.o) {
          P.dec.show(false);
          if (v.ph === 1 && p.sq) {
            // Under the slab: only a bump in the stone shows where they are.
            P.av.set(p.x, p.y, { visible: false });
            P.bump.visible = P.bumpRing.visible = P.dizzy.visible = true;
            K.place(P.bump, p.x, p.y, sh - 4);
            P.bump.scale.set(p.r * 1.2, 22, p.r * 1.2);
            K.place(P.bumpRing, p.x, p.y, sh + 2);
            P.bumpRing.scale.setScalar(p.r * 1.35);
            K.place(P.dizzy, p.x, p.y, sh + 40);
            return;
          }
          if (p.o) {
            // Out of the game: a ghost lying on the floor.
            P.av.set(p.x, p.y, { r: p.r, mood: 'dead', alpha: 0.4, look, marker: false });
            P.ghost.visible = true;
            K.place(P.ghost, p.x, p.y, p.r * 2 + Math.sin(t * 2 + i) * 10);
            return;
          }
          const pop = p.fl < 0.15 ? p.fl / 0.15 : 1;
          const s = p.r * (1.1 + 0.3 * pop);
          P.slab.visible = true;
          K.place(P.slab, p.x, p.y, 2);
          P.slab.scale.set(s * 2, 4, s * 2);
          P.slab.rotation.y = 0.25 + i * 0.3;
          P.av.set(p.x, p.y, { r: p.r, h: 3, mood: 'dead', squash: 0.45 * pop, look: t * 2 });
          P.dizzy.visible = true;
          K.place(P.dizzy, p.x, p.y, p.r * 1.6);
          return;
        }
        const scared = v.ph === 0 && !p.sf && v.k > 0.5;
        const mood = p.st ? 'hurt' : p.d || p.sh > 0 ? 'angry' : scared ? 'scared' : p.sf && v.ph !== 2 ? 'happy' : 'ok';
        const anim = p.d || p.rc ? 'Dodge_Forward' : p.sh > 0 ? 'Unarmed_Melee_Attack_Punch_A' : v.ph === 1 ? (p.sf ? 'Cheer' : 'Blocking') : undefined;
        P.av.set(p.x, p.y, { r: p.r, look, mood, walk: v.ph === 1 ? 0 : p.w ?? 0.5, gear: false, anim, animSpeed: anim === 'Dodge_Forward' ? 1.6 : anim === 'Unarmed_Melee_Attack_Punch_A' ? 2 : undefined });
        if (p.sh > 0) {
          const ext = p.r + 10 + (0.2 - p.sh) * 120, sx = -p.fy, sy = p.fx;
          P.palms.forEach((m, k) => {
            const sg = k ? 1 : -1;
            m.visible = true;
            K.place(m, p.x + p.fx * ext + sx * sg * p.r * 0.45, p.y + p.fy * ext + sy * sg * p.r * 0.45, p.r * 1.1);
            m.scale.setScalar(p.r * 0.25);
          });
        }
        if (p.sd) {
          const a = t * 2.5;
          P.shield.visible = P.shieldRing.visible = true;
          K.place(P.shield, p.x + Math.cos(a) * (p.r + 22), p.y + Math.sin(a) * (p.r + 22), p.r * 0.8);
          K.face(P.shield, a);
          K.place(P.shieldRing, p.x, p.y, p.r * 0.8);
          P.shieldRing.scale.setScalar(p.r + 22);
        }
        P.dec.show(true).at(p.x, p.y, 2).paint((d) => {
          const ax = p.fx * (p.r + 18), ay = p.fy * (p.r + 18);
          d.poly([ax + p.fx * 16, ay + p.fy * 16, ax - p.fy * 11, ay + p.fx * 11, ax + p.fy * 11, ay - p.fx * 11], d.col(i, 'light') + (p.cd <= 0 ? 'ee' : '55'), 'rgba(0,0,0,0.35)', 2);
          if (v.ph === 0 && p.sf) d.ring(0, 0, p.r + 10, '#7dff6b', 8);
          else if (p.cd <= 0) d.ring(0, 0, p.r + 9, d.col(i, 'light') + 'aa', 5);
          else d.arc(0, 0, p.r + 9, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / SHOVE_CD), d.col(i, 'light') + '77', 5);
          if (p.dc > 0) d.arc(0, 0, p.r + 18, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.dc / DIVE_CD), 'rgba(255,255,255,0.45)', 4);
          else d.arc(0, 0, p.r + 18, Math.PI * 0.2, Math.PI * 0.8, 'rgba(255,255,255,0.75)', 4);
        });
      });
    },
  },

  render(d, v, r) {
    const { ctx } = d;
    const bech = r.variant === 'besciamella';
    drawKitchen(d);
    drawFloor(d, v.L, bech);

    if (v.ph === 0) {
      // Shadow of the falling slab: darker as it gets closer, holes stay lit.
      ctx.save();
      ctx.globalAlpha = 0.12 + 0.5 * v.k;
      ctx.fillStyle = '#05030a';
      sheetPath(ctx, v.holes);
      ctx.fill();
      ctx.restore();
      const blink = 0.55 + 0.45 * Math.sin(d.t * (8 + v.k * 22));
      ctx.globalAlpha = blink;
      for (const h of v.holes) strokeHole(ctx, h, '#7dff6b', 6);
      ctx.globalAlpha = 1;
    }

    // Shield power-up.
    if (v.ch) {
      const bob = Math.sin(d.t * 5) * 5;
      d.shadow(v.ch.x, v.ch.y + 20, 24, 8, 0.3);
      d.circle(v.ch.x, v.ch.y + bob, CHEESE_R + 10 + Math.sin(d.t * 8) * 3, 'rgba(255,210,63,0.25)');
      d.emoji('🛡️', v.ch.x, v.ch.y + bob, 50);
    }

    // Players (squashed ones are under the slab while it presses).
    const order = v.p.map((_, i) => i).sort((a, b) => v.p[a].y - v.p[b].y);
    for (const i of order) drawPlayer(d, v.p[i], i, v);

    if (v.ph === 0) {
      // The slab itself, high above: big, translucent, shrinking onto its shadow.
      const sc = 1 + (1 - v.k) * (1 - v.k) * 0.9;
      ctx.save();
      ctx.translate(CX, CY); ctx.scale(sc, sc); ctx.translate(-CX, -CY);
      ctx.globalAlpha = 0.08 + 0.42 * v.k * v.k;
      drawSheet(d, v.holes, bech);
      ctx.restore();
      ctx.globalAlpha = 1;
    } else if (v.ph === 1) {
      const bounce = 1 + Math.max(0, 0.04 * (1 - v.k * 4));
      ctx.save();
      ctx.translate(CX, CY); ctx.scale(bounce, bounce); ctx.translate(-CX, -CY);
      drawSheet(d, v.holes, bech);
      ctx.restore();
      // Bumps where someone got flattened underneath.
      v.p.forEach((p, i) => {
        if (!p.sq) return;
        d.circle(p.x, p.y, p.r * 1.25, 'rgba(40,30,20,0.3)');
        d.circle(p.x - p.r * 0.3, p.y - p.r * 0.3, p.r * 0.5, 'rgba(255,255,255,0.18)');
        d.emoji('💫', p.x, p.y, 40);
        d.ring(p.x, p.y, p.r * 1.3, d.col(i, 'main'), 4);
      });
    }
  },
};

// ---------- render helpers ----------

// Crypt around the pit (2D fallback).
function drawKitchen(d) {
  const { ctx } = d;
  ctx.fillStyle = '#2a2420';
  ctx.fillRect(-400, -400, W + 800, H + 800);
  for (let k = -400; k < W + 400; k += 90) { d.line(k, -400, k, H + 400, 'rgba(0,0,0,0.25)', 4); d.line(-400, k, W + 400, k, 'rgba(0,0,0,0.25)', 4); }
  d.rect(X0 - 40 + 14, Y0 - 40 + 20, X1 - X0 + 80, Y1 - Y0 + 80, 'rgba(0,0,0,0.35)');
  d.rrect(X0 - 40, Y0 - 40, X1 - X0 + 80, Y1 - Y0 + 80, 10, '#8d877e', '#3a3634', 6);
  d.rect(X0 - 14, Y0 - 14, X1 - X0 + 28, Y1 - Y0 + 28, '#5a534b');
}

// Pit floor: big flagstones; every slam adds dust, cracks and pebbles (unto: puddles of dragon grease).
function drawFloor(d, L, bech) {
  const { ctx } = d;
  const w = X1 - X0, h = Y1 - Y0;
  d.rect(X0, Y0, w, h, bech ? '#6f7a5a' : '#77746f');
  const S = 105;
  for (let y = Y0; y < Y1; y += S) {
    for (let x = X0; x < X1; x += S) {
      const k = ((x * 7 + y * 13) / S) | 0;
      d.rect(x + 3, y + 3, S - 6, S - 6, bech ? (k % 2 ? '#7f8a68' : '#87926f') : k % 3 === 0 ? '#9a968f' : k % 3 === 1 ? '#928e87' : '#a19d95');
    }
  }
  for (let k = 0; k < 16; k++) {
    const x = X0 + 30 + ((k * 7919 + L * 1931) % (w - 60));
    const y = Y0 + 30 + ((k * 3571 + L * 2711) % (h - 60));
    const rr = 26 + ((k * 37 + L * 11) % 44);
    if (bech) d.circle(x, y, rr, k % 4 === 0 ? 'rgba(255,240,150,0.35)' : 'rgba(170,220,90,0.45)');
    else d.circle(x, y, rr, k % 3 === 0 ? 'rgba(230,220,200,0.25)' : 'rgba(40,30,20,0.18)');
  }
  // Cracks from previous slams.
  for (let k = 0; k < Math.min(L, 12) * 2; k++) {
    let x = X0 + 40 + ((k * 4241 + 77) % (w - 80)), y = Y0 + 40 + ((k * 6007 + 31) % (h - 80));
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let q = 0; q < 4; q++) { x += ((k * 13 + q * 29) % 60) - 30; y += ((k * 17 + q * 23) % 60) - 30; ctx.lineTo(x, y); }
    ctx.strokeStyle = 'rgba(20,14,10,0.55)'; ctx.lineWidth = 3; ctx.stroke();
  }
  // Stack of layers along the rim.
  const n = Math.min(L, 10);
  for (let k = 0; k < n; k++) {
    const o = 3 + k * 4;
    ctx.globalAlpha = 0.6;
    d.rect(X0 + o, Y0 + o, w - o * 2, h - o * 2, null, k % 2 ? '#4a443d' : '#b9b0a2', 3);
  }
  ctx.globalAlpha = 1;
}

// Pit-sized outline (clockwise) with holes (counter-clockwise) for nonzero filling.
function sheetPath(ctx, holes) {
  ctx.beginPath();
  ctx.moveTo(X0, Y0); ctx.lineTo(X1, Y0); ctx.lineTo(X1, Y1); ctx.lineTo(X0, Y1); ctx.closePath();
  for (const h of holes) holePath(ctx, h, true);
}

function holePath(ctx, h, ccw) {
  if (h.s === 'c') {
    ctx.moveTo(h.x + h.w / 2, h.y);
    ctx.arc(h.x, h.y, h.w / 2, 0, TAU, ccw);
    ctx.closePath();
    return;
  }
  let pts;
  if (h.s === 'r') {
    const a = h.w / 2, b = h.h / 2;
    pts = [[-a, -b], [a, -b], [a, b], [-a, b]];
  } else {
    const a = h.w / 2, t = h.h / 2;
    pts = [[-t, -a], [t, -a], [t, -t], [a, -t], [a, t], [t, t], [t, a], [-t, a], [-t, t], [-a, t], [-a, -t], [-t, -t]];
  }
  if (ccw) pts.reverse();
  ctx.moveTo(h.x + pts[0][0], h.y + pts[0][1]);
  for (let k = 1; k < pts.length; k++) ctx.lineTo(h.x + pts[k][0], h.y + pts[k][1]);
  ctx.closePath();
}

function strokeHole(ctx, h, color, lw) {
  ctx.beginPath();
  holePath(ctx, h, false);
  ctx.strokeStyle = color; ctx.lineWidth = lw;
  ctx.stroke();
}

// The ceiling slab: carved stone blocks, a runic border, moss, iron rings at the corners.
function drawSheet(d, holes, bech) {
  const { ctx } = d;
  ctx.save();
  sheetPath(ctx, holes);
  ctx.fillStyle = bech ? '#8f9a78' : '#a39a8c';
  ctx.fill();
  ctx.clip('nonzero');
  const S = 140;
  for (let y = Y0; y < Y1; y += S / 2) {
    const off = ((y - Y0) / (S / 2)) % 2 ? S / 2 : 0;
    for (let x = X0 - off; x < X1; x += S) {
      const k = ((x * 3 + y * 5) / 20) | 0;
      d.rect(x + 3, y + 3, S - 6, S / 2 - 6, k % 3 === 0 ? '#ada495' : k % 3 === 1 ? '#9d9486' : '#a69d8f');
    }
  }
  for (let k = 0; k < 14; k++) {
    const x = X0 + 50 + ((k * 4241) % 740), y = Y0 + 50 + ((k * 6007) % 740);
    d.circle(x, y, 18 + (k % 4) * 8, k % 2 ? 'rgba(80,130,60,0.35)' : 'rgba(40,30,20,0.18)');
  }
  // Runic border.
  d.rect(X0 + 14, Y0 + 14, X1 - X0 - 28, Y1 - Y0 - 28, null, '#6e665b', 10);
  for (let k = 0; k < 24; k++) {
    const u = X0 + 50 + k * 34;
    for (const [x, y] of [[u, Y0 + 14], [u, Y1 - 14], [X0 + 14, u], [X1 - 14, u]]) d.circle(x, y, 3, '#d9c27a');
  }
  ctx.restore();
  for (const [x, y] of [[X0 + 40, Y0 + 40], [X1 - 40, Y0 + 40], [X0 + 40, Y1 - 40], [X1 - 40, Y1 - 40]]) d.ring(x, y, 14, '#2b2826', 5);
  for (const h of holes) strokeHole(ctx, h, '#4a443d', 8);
}

function drawPlayer(d, p, i, v) {
  const { ctx } = d;
  if (p.o && !(p.fl > 0)) { d.avatar(p.x, p.y, p.r, i, { mood: 'dead', alpha: 0.35 }); return; }
  if (p.fl > 0) {
    if (v.ph === 1 && p.sq) return; // hidden under the slab
    // Flattened like a pancake, re-inflating at the very end.
    const pop = p.fl < 0.15 ? p.fl / 0.15 : 1;
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(0.25 + i * 0.3);
    const s = p.r * (1.1 + 0.3 * pop);
    d.rrect(-s, -s, s * 2, s * 2, 8, '#9a9288', '#5a534b', 4);
    ctx.restore();
    d.avatar(p.x, p.y, p.r * (1 + 0.3 * pop), i, { mood: 'dead', squash: 0.4 * pop, look: d.t * 2 });
    return;
  }
  d.shadow(p.x + 5, p.y + 12, p.r, p.r * 0.75, 0.3);
  if (p.d) {
    for (let k = 1; k <= 3; k++) d.circle(p.x - p.fx * 28 * k, p.y - p.fy * 28 * k, p.r * (1 - k * 0.15), d.col(i, 'light') + '40');
  }
  if (p.sd) {
    d.circle(p.x, p.y, p.r + 16, 'rgba(255,210,63,0.18)', 'rgba(255,210,63,0.8)', 3);
    const a = d.t * 2.5;
    d.emoji('🛡️', p.x + Math.cos(a) * (p.r + 16), p.y + Math.sin(a) * (p.r + 16), 30);
  }
  const scared = v.ph === 0 && !p.sf && v.k > 0.5;
  const mood = p.st ? 'hurt' : p.d || p.sh > 0 ? 'angry' : scared ? 'scared' : p.sf && v.ph !== 2 ? 'happy' : 'ok';
  const squash = p.d ? 0.2 : p.rc ? 0.3 : v.ph === 1 ? -0.12 : scared ? Math.sin(d.t * 30) * 0.08 : 0;
  d.avatar(p.x, p.y, p.r, i, { look: Math.atan2(p.fy, p.fx), mood, squash });
  if (p.sh > 0) {
    const ext = p.r + 10 + (0.2 - p.sh) * 120, sx = -p.fy, sy = p.fx;
    for (const sg of [-1, 1]) {
      d.circle(p.x + p.fx * ext + sx * sg * p.r * 0.45, p.y + p.fy * ext + sy * sg * p.r * 0.45, p.r * 0.32, d.col(i, 'light'), '#fff', 3);
    }
    d.arc(p.x, p.y, p.r + SHOVE_RANGE, Math.atan2(p.fy, p.fx) - 0.6, Math.atan2(p.fy, p.fx) + 0.6, 'rgba(255,255,255,0.4)', 4);
  }
  const ax = p.x + p.fx * (p.r + 16), ay = p.y + p.fy * (p.r + 16);
  d.poly([ax + p.fx * 13, ay + p.fy * 13, ax - p.fy * 9, ay + p.fx * 9, ax + p.fy * 9, ay - p.fx * 9], d.col(i, 'light') + (p.cd <= 0 ? 'ee' : '55'));
  if (v.ph === 0 && p.sf) d.ring(p.x, p.y, p.r + 9, '#7dff6b', 5);
  else if (p.cd <= 0) d.ring(p.x, p.y, p.r + 8, d.col(i, 'light') + '88', 3);
  else d.arc(p.x, p.y, p.r + 8, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / SHOVE_CD), d.col(i, 'light') + '66', 3);
  if (p.dc > 0) d.arc(p.x, p.y, p.r + 14, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.dc / DIVE_CD), 'rgba(255,255,255,0.35)', 3);
  else d.arc(p.x, p.y, p.r + 14, Math.PI * 0.2, Math.PI * 0.8, 'rgba(255,255,255,0.6)', 3);
}

// ---------- 3D helpers ----------
function holesKey(holes) {
  let k = '';
  for (const h of holes) k += `${h.s}${Math.round(h.x)},${Math.round(h.y)},${Math.round(h.w)},${Math.round(h.h)};`;
  return k;
}

// The crypt hall around the pit: walls with arches and torches, pillars, team banners, treasure, barrels, rubble.
function buildCrypt(K, o, N) {
  const far = K.quality > 0;
  const put = (name, x, y, o2, face) => { const g = K.model(name, o2); K.place(g, x, y); K.face(g, face ?? Math.atan2(CY - y, CX - x)); return g; };
  // Back wall (top), side walls: a ring of wall segments far from the pit (arches + windows).
  const WS = 230;
  const back = [], arch = [], win = [];
  for (let k = -3; k <= 7; k++) {
    const x = k * WS + 40;
    (k % 3 === 0 ? arch : k % 3 === 1 ? win : back).push({ x, y: -330, rot: 0 });
  }
  for (let k = -1; k <= 5; k++) {
    const y = k * WS + 40;
    for (const x of [-330, W + 330]) (k % 2 ? back : arch).push({ x, y, rot: Math.PI / 2 });
  }
  K.scatter('dungeon/wall', back, { size: WS });
  K.scatter('dungeon/wall_arched', arch, { size: WS });
  K.scatter('dungeon/wall_window_closed', win, { size: WS });
  // Pillars around the pit.
  const pil = [{ x: -230, y: -230 }, { x: W + 230, y: -230 }, { x: -230, y: H + 260 }, { x: W + 230, y: H + 260 }, { x: CX - 260, y: -230 }, { x: CX + 260, y: -230 }, { x: -250, y: CY }, { x: W + 250, y: CY }];
  K.scatter('dungeon/pillar_decorated', pil, { height: 260 });
  K.scatter('dungeon/column', [{ x: -200, y: 1300 }, { x: CX, y: 1380 }, { x: W + 200, y: 1300 }], { height: 300 });
  // Torches on the back wall and the sides (warm flickering lights).
  const torches = [{ x: CX - 230, y: -312, rot: Math.PI / 2 }, { x: CX + 230, y: -312, rot: Math.PI / 2 }, { x: -312, y: CY - 230, rot: 0 }, { x: -312, y: CY + 230, rot: 0 }, { x: W + 312, y: CY - 230, rot: Math.PI }, { x: W + 312, y: CY + 230, rot: Math.PI }];
  const tg = K.scatter('dungeon/torch_mounted', torches, { height: 70 });
  tg.position.y += 150;
  const flame = K.glow('#ffb03a', { add: true });
  for (const tq of torches) K.place(K.ball(12, flame, { cast: false, seg: 10 }), tq.x + Math.cos(tq.rot) * 14, tq.y + Math.sin(tq.rot) * 14, 235);
  const nl = far ? 4 : 2;
  for (let k = 0; k < nl; k++) { const tq = torches[k]; K.light(tq.x + Math.cos(tq.rot) * 60, tq.y + Math.sin(tq.rot) * 60, 240, '#ff9a40', 3.2, { flicker: 0.6, dist: 1100 }); }
  K.light(CX, CY, 900, '#9ab0ff', 0.8, { dist: 1600 });
  // Team banners hanging on the walls behind each seat's side.
  const banN = ['dungeon/banner_patternA_red', 'dungeon/banner_patternA_blue', 'dungeon/banner_patternA_green', 'dungeon/banner_patternA_yellow'];
  const banPos = [[CX, 1300, -Math.PI / 2], [CX, -315, Math.PI / 2], [-315, CY, 0], [W + 315, CY, Math.PI]];
  for (let i = 0; i < N; i++) {
    const [x, y, f] = banPos[i];
    const b = K.model(banN[i], { height: i === 0 ? 150 : 220 });
    K.place(b, x, y, i === 0 ? 0 : 40); K.face(b, f);
  }
  K.scatter('dungeon/banner_thin_white', [{ x: CX - 120, y: -315, rot: Math.PI / 2 }, { x: CX + 120, y: -315, rot: Math.PI / 2 }], { height: 200 });
  // Treasure corner, kitchen corner, store room: props outside the pit.
  put('dungeon/trunk_large_A', -150, 120, { size: 110 });
  K.scatter('dungeon/coin_stack_large', [{ x: -100, y: 200 }, { x: -200, y: 40 }], { size: 40 });
  K.scatter('dungeon/coin_stack_medium', [{ x: -60, y: 70 }, { x: -230, y: 210 }], { size: 30 });
  put('dungeon/table_long_decorated_A', W + 180, 140, { size: 220 }, Math.PI / 2);
  K.scatter('dungeon/chair', [{ x: W + 110, y: 80, rot: 0 }, { x: W + 110, y: 200, rot: 0 }], { size: 50 });
  K.scatter('dungeon/barrel_large', [{ x: -170, y: 860 }, { x: -110, y: 950 }, { x: W + 160, y: 900 }], { size: 80 });
  put('dungeon/barrel_small_stack', -230, 960, { size: 90 });
  put('dungeon/crates_stacked', W + 220, 990, { size: 110 });
  put('dungeon/box_stacked', W + 140, 600, { size: 80 });
  put('dungeon/keg_decorated', -150, 600, { size: 80 });
  put('dungeon/sword_shield', W + 160, 400, { size: 90 });
  put('dungeon/shelf_small_candles', -230, 380, { size: 120 });
  const cand = [{ x: 30, y: 30 }, { x: W - 30, y: 30 }, { x: 30, y: H - 30 }, { x: W - 30, y: H - 30 }, { x: -60, y: 470 }, { x: W + 60, y: 520 }];
  K.scatter('dungeon/candle_triple', cand, { size: 30 });
  for (const c of cand) K.place(K.ball(6, flame, { cast: false, seg: 8 }), c.x, c.y, 38);
  K.scatter('dungeon/candle_melted', [{ x: 60, y: 22 }, { x: W - 58, y: H - 22 }], { size: 22 });
  K.scatter('dungeon/rubble_large', [{ x: CX - 180, y: 1150 }, { x: CX + 230, y: 1180, rot: 2 }, { x: -260, y: 1180, rot: 1 }], { size: 120 });
  K.scatter('dungeon/rubble_half', [{ x: CX + 40, y: 1120 }, { x: W + 260, y: 1140, rot: 1 }, { x: -320, y: -150 }], { size: 90 });
  K.scatter('dungeon/floor_tile_big_grate', [{ x: -170, y: 470 }, { x: W + 170, y: 760 }], { size: 120 });
  K.ambient('braci', { n: 50 });
  K.ambient('polvere', { n: 70, h: 600 });
}
