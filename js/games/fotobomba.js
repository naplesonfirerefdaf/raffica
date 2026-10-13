// Ritratto di Corte — Slaparazzi / Camera Shy: be alone in the court painter's portrait, glove-slap the intruders out.
// Up to 4 players: alone in the frame = 2 points, in company = 1 point each. First to 9.
import { clamp, damp, dist, collideCircles, norm, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500, WALL = 40;
const FOUNT_R = 95;
const BALL_R = 40;
const ACCEL = 1600, MAX_SPEED = 520, KEEP = 0.18;
const SLAP_RANGE = 50, SLAP_CD = 0.8, SLAP_PUSH = 800, STUN = 0.5;
const FRAME_W = 330, FRAME_H = 250, FRAME_MIN_W = 150, FRAME_MIN_H = 115;
const SHOT_EVERY = 4, SHOT_FAST = 3.2, FAST_AT = 28, COUNT_STEP = 0.8, COUNT = COUNT_STEP * 3;
const WIN = 9, BLUR_SPEED = 300, PHOTO_LIFE = 1.1;
const MOODS = ['angry', 'scared', 'hurt', 'happy'];
const POSE_TIME = 0.75, POSE_CD = 2.4, POSE_BONUS = 1;
// Seats: 0 bottom, 1 top, 2 left, 3 right (start position and facing).
const START = [[CX, 820, 0, -1], [CX, 180, 0, 1], [180, CY, 1, 0], [820, CY, -1, 0]];
const BOT_DELAY = [22 / 60, 13 / 60, 7 / 60];  // bots' reaction time per level (core/bots.js driver), in game steps

// Bots: remember the last inputs sent (they are still on their way, delayed by the reaction time)…
function botPush(m, out, D) {
  const n = Math.round(D * 60);
  if (!m.hist) { m.hist = new Float32Array(2 * 32); m.hi = 0; }
  m.hist[2 * m.hi] = out.x || 0; m.hist[2 * m.hi + 1] = out.y || 0; m.hi = (m.hi + 1) % n;
}
// …and replay them (free running, no collisions) to predict where I'll be when the next input lands.
function botPredict(p, m, D) {
  const n = Math.round(D * 60), dt = 1 / 60;
  let x = p.x, y = p.y, vx = p.vx, vy = p.vy, stun = p.stun, pose = p.pose;
  for (let j = 0; j < n - 1; j++) {
    const k = m.hist ? (m.hi + 1 + j) % n : -1;
    let ix = k >= 0 ? m.hist[2 * k] : 0, iy = k >= 0 ? m.hist[2 * k + 1] : 0;
    if (pose > 0) { pose -= dt; const q = Math.pow(0.0005, dt); vx *= q; vy *= q; }
    else {
      if (stun > 0) { stun -= dt; ix = 0; iy = 0; }
      const q = Math.pow(stun > 0 ? 0.3 : KEEP, dt);
      vx = (vx + ix * ACCEL * dt) * q; vy = (vy + iy * ACCEL * dt) * q;
      const sp = Math.hypot(vx, vy);
      if (stun <= 0 && sp > MAX_SPEED) { vx *= MAX_SPEED / sp; vy *= MAX_SPEED / sp; }
    }
    x = clamp(x + vx * dt, WALL + p.r, W - WALL - p.r); y = clamp(y + vy * dt, WALL + p.r, H - WALL - p.r);
  }
  return { x, y, vx, vy };
}

function newTarget(s, g) {
  const fr = s.fr;
  const hw = fr.w / 2 + WALL + 10, hh = fr.h / 2 + WALL + 10;
  fr.tx = g.rng.range(hw, W - hw); fr.ty = g.rng.range(hh, H - hh);
}

function clampFrame(fr) {
  const hw = fr.w / 2 + WALL, hh = fr.h / 2 + WALL;
  fr.x = clamp(fr.x, hw, W - hw); fr.y = clamp(fr.y, hh, H - hh);
}

const insideFrame = (fr, p) => Math.abs(p.x - fr.x) <= fr.w / 2 && Math.abs(p.y - fr.y) <= fr.h / 2;

const game = {
  id: 'fotobomba',
  name: 'Ritratto di Corte',
  rule: 'Fatti ritrarre DA SOLO! Schiaffeggia chi si intrufola',
  verb: 'IN POSA!',
  inspired: 'Super Mario Party · Slaparazzi',
  cam: 'top',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Schiaffo', b: 'Posa' },
  help: {
    goal: 'Arriva a 9 punti: ritratto da SOLO = 2 punti, in compagnia = 1 punto a testa.',
    dir: 'Muoviti nel giardino del castello per entrare nella cornice del pittore di corte (si sposta sempre).',
    a: 'SCHIAFFO col guanto: colpisce chi ti sta davanti e lo spedisce lontano, stordito (ricarica 0.8 s).',
    b: 'POSA REGALE: ti fermi in posa per un attimo. Se il ritratto viene finito mentre sei in posa nella cornice: +1 punto bonus!',
    tips: ['Metti la posa sul "1" del conto alla rovescia', 'In posa sei fermo: uno schiaffo ti fa volare il doppio', 'Chi preme prima lo schiaffo vince lo scambio'],
  },
  duration: 40,
  noMods: ['moviola'], // 40 s in slow motion would last over a minute
  supports: ['scale'],
  variants: [
    { id: 'mosso', name: 'Ritratto Mosso', desc: "Se corri durante l'ultima pennellata vieni sbavato: zero punti!" },
    { id: 'stringe', name: 'Miniatura', desc: 'La cornice si restringe a ogni ritratto!' },
    { id: 'teletrasporto', name: 'Pittore Pazzo', desc: "Il pittore cambia posto poco prima dell'ultima pennellata!" },
  ],

  init(g) {
    const n = g.n || 2;
    const sc = g.mods.scale || [];
    const s = {
      t: 0, sc: Array(n).fill(0), shotAt: SHOT_EVERY, digit: 0, tp: 0, hint: null, photo: null, photoN: 0, fast: false,
      fr: { x: CX, y: CY, vx: 0, vy: 0, w: FRAME_W, h: FRAME_H, tx: CX, ty: CY },
      p: Array.from({ length: n }, (_, i) => {
        const k = sc[i] ?? 1, [x, y, fx, fy] = START[i];
        return { i, x, y, vx: 0, vy: 0, r: BALL_R * k, m: k * k, fx, fy, cd: 0.3, stun: 0, slapT: 0, pose: 0, pcd: 0 };
      }),
    };
    newTarget(s, g);
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt, fr = s.fr;
    s.t = g.t;

    // Players. Slaps are collected first and resolved together (no player-order advantage).
    const slaps = [];
    for (const p of s.p) {
      const i = inp[p.i];
      p.cd = Math.max(0, p.cd - dt);
      p.stun = Math.max(0, p.stun - dt);
      p.slapT = Math.max(0, p.slapT - dt);
      p.pose = Math.max(0, p.pose - dt);
      p.pcd = Math.max(0, p.pcd - dt);
      const ctrl = p.stun <= 0;
      if (ctrl && p.pose <= 0 && i.bP && p.pcd <= 0 && !g.ended) {
        p.pose = POSE_TIME; p.pcd = POSE_CD;
        g.sfx('tada', { vol: 0.5, pitch: 1.2 });
        g.burst(p.x, p.y - p.r, { color: '#fff59d', n: 8, speed: 140, size: 5 });
      }
      const posing = p.pose > 0;
      if (posing) { const k = damp(0.0005, dt); p.vx *= k; p.vy *= k; p.x += p.vx * dt; p.y += p.vy * dt; continue; }
      const ix = ctrl ? i.x : 0, iy = ctrl ? i.y : 0;
      if (Math.hypot(ix, iy) > 0.2) { const n = norm(ix, iy); p.fx = n.x; p.fy = n.y; }
      p.vx += ix * ACCEL * dt; p.vy += iy * ACCEL * dt;
      const k = damp(p.stun > 0 ? 0.3 : KEEP, dt);
      p.vx *= k; p.vy *= k;
      const sp = Math.hypot(p.vx, p.vy);
      if (p.stun <= 0 && sp > MAX_SPEED) { p.vx *= MAX_SPEED / sp; p.vy *= MAX_SPEED / sp; }
      if (ctrl && i.aP && p.cd <= 0 && !g.ended) slaps.push({ p, tgt: game.slapTarget(s, p), at: i.aT });
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    // Two players slapping each other: whoever pressed first (as seen on their screen) wins the exchange.
    for (const a of slaps) for (const b of slaps) {
      if (a === b || a.tgt !== b.p.i || b.tgt !== a.p.i || Math.abs(a.at - b.at) <= 0.02) continue;
      if (a.at > b.at) a.tgt = -1;
    }
    for (const sl of slaps) game.slap(s, sl.p, sl.tgt, g);

    // Collisions: players, fountain, hedges.
    for (let a = 0; a < s.p.length; a++) {
      for (let b = a + 1; b < s.p.length; b++) {
        const impact = collideCircles(s.p[a], s.p[b], 0.8);
        if (impact > 250) g.sfx('bonk', { vol: 0.5, pitch: 1.3 });
      }
    }
    for (const p of s.p) {
      const dd = dist(p.x, p.y, CX, CY), min = FOUNT_R + p.r;
      if (dd < min) {
        const n = dd > 1e-6 ? norm(p.x - CX, p.y - CY) : { x: -START[p.i][2], y: -START[p.i][3] };
        p.x = CX + n.x * min; p.y = CY + n.y * min;
        const vn = p.vx * n.x + p.vy * n.y;
        if (vn < 0) {
          p.vx -= 1.5 * vn * n.x; p.vy -= 1.5 * vn * n.y;
          if (p.stun > 0 && vn < -300) { g.sfx('splash', { vol: 0.6 }); g.burst(p.x - n.x * p.r, p.y - n.y * p.r, { color: '#7fd8ff', n: 10, speed: 200 }); }
        }
      }
      const lo = WALL + p.r, hi = W - WALL - p.r;
      if (p.x < lo) { p.x = lo; if (p.vx < 0) p.vx *= -0.5; }
      if (p.x > hi) { p.x = hi; if (p.vx > 0) p.vx *= -0.5; }
      if (p.y < lo) { p.y = lo; if (p.vy < 0) p.vy *= -0.5; }
      if (p.y > hi) { p.y = hi; if (p.vy > 0) p.vy *= -0.5; }
    }

    // The finished painting falls for a moment.
    if (s.photo) { s.photo.a += dt; if (s.photo.a > PHOTO_LIFE) s.photo = null; }

    // Wandering frame.
    if (dist(fr.x, fr.y, fr.tx, fr.ty) < 30) newTarget(s, g);
    const speed = s.fast ? 175 : 125;
    const n = norm(fr.tx - fr.x, fr.ty - fr.y), kf = 1 - damp(0.15, dt);
    fr.vx += (n.x * speed - fr.vx) * kf; fr.vy += (n.y * speed - fr.vy) * kf;
    fr.x += fr.vx * dt; fr.y += fr.vy * dt;
    clampFrame(fr);

    if (g.ended) return;

    if (!s.fast && g.t >= FAST_AT) { s.fast = true; g.say('PITTORE FRENETICO!'); g.sfx('horn'); }

    // Crazy painter: hint, then teleport just before the last stroke.
    if (g.variant === 'teletrasporto') {
      const rem = s.shotAt - g.t;
      if (s.tp === 0 && rem <= 1.5) {
        s.tp = 1;
        const hw = fr.w / 2 + WALL + 10, hh = fr.h / 2 + WALL + 10;
        let hx = fr.x, hy = fr.y;
        for (let k = 0; k < 8 && dist(hx, hy, fr.x, fr.y) < 280; k++) { hx = g.rng.range(hw, W - hw); hy = g.rng.range(hh, H - hh); }
        s.hint = { x: hx, y: hy };
        g.sfx('whoosh', { pitch: 1.3 });
      } else if (s.tp === 1 && rem <= 1.0) {
        s.tp = 2;
        g.burst(fr.x, fr.y, { color: '#c7a6ff', n: 16, speed: 260 });
        fr.x = s.hint.x; fr.y = s.hint.y; fr.vx = 0; fr.vy = 0; s.hint = null;
        newTarget(s, g);
        g.burst(fr.x, fr.y, { color: '#c7a6ff', n: 16, speed: 260 });
        g.sfx('zap'); g.ring(fr.x, fr.y, { color: '#c7a6ff', r: 200 });
      }
    }

    // 3-2-1 countdown on the frame.
    const rem = s.shotAt - g.t;
    const digit = rem <= COUNT ? clamp(Math.ceil(rem / COUNT_STEP), 1, 3) : 0;
    if (digit && digit !== s.digit) g.sfx('tick', { pitch: 1 + (3 - digit) * 0.2 });
    s.digit = digit;
    if (g.t >= s.shotAt) game.shoot(s, g);
  },

  // Who would a slap from p hit right now? The closest player in reach in front of p, or -1.
  slapTarget(s, p) {
    let best = -1, bd = 1e9;
    for (const o of s.p) {
      if (o === p) continue;
      const dx = o.x - p.x, dy = o.y - p.y, dd = Math.hypot(dx, dy) || 1;
      const facing = (dx * p.fx + dy * p.fy) / dd;
      if (dd - p.r - o.r < SLAP_RANGE * (p.r / BALL_R) && facing > -0.2 && dd < bd) { bd = dd; best = o.i; }
    }
    return best;
  },

  slap(s, p, tgt, g) {
    p.cd = SLAP_CD; p.slapT = 0.2;
    if (tgt >= 0) {
      const o = s.p[tgt];
      const dx = o.x - p.x, dy = o.y - p.y, dd = Math.hypot(dx, dy) || 1;
      const nx = dx / dd, ny = dy / dd;
      const bomb = o.pose > 0; // slapping a poser = ruined portrait!
      o.vx = nx * SLAP_PUSH * (bomb ? 1.45 : 1); o.vy = ny * SLAP_PUSH * (bomb ? 1.45 : 1); o.stun = STUN * (bomb ? 1.4 : 1); o.pose = 0;
      p.fx = nx; p.fy = ny;
      if (bomb) { g.text(o.x, o.y - o.r - 80, 'GUASTAFESTE!', { player: p.i, size: 44 }); g.sfx('bonk', { pitch: 0.7 }); }
      g.sfx('punch'); g.sfx('hit', { pitch: 1.4, vol: 0.6 });
      g.text(o.x, o.y - o.r - 30, 'SCIAFF!', { player: p.i, size: 50 });
      g.burst(o.x - nx * o.r, o.y - ny * o.r, { color: '#fff', n: 14, speed: 360 });
      g.shake(0.4); g.hitstop(0.05);
      g.vibrate(o.i, 120); g.vibrate(p.i, 30);
      // Slap right before the last stroke: savour it.
      const rem = s.shotAt - g.t;
      if (rem > 0 && rem < 0.5) g.slowmo(0.4, 0.4);
    } else {
      g.sfx('whoosh', { vol: 0.6, pitch: 1.5 });
    }
  },

  shoot(s, g) {
    const fr = s.fr, mosso = g.variant === 'mosso';
    const inside = s.p.map((p) => insideFrame(fr, p));
    const blur = s.p.map((p, k) => inside[k] && mosso && Math.hypot(p.vx, p.vy) > BLUR_SPEED);
    const valid = inside.map((v, k) => v && !blur[k]);
    const count = valid.filter(Boolean).length;
    const pts = count === 1 ? 2 : 1;
    const posed = s.p.map((p, k) => valid[k] && p.pose > 0);

    g.flash('#fff6d8', 0.85); g.sfx('zap', { pitch: 1.8 }); g.sfx('click');
    s.p.forEach((p, k) => {
      if (valid[k]) {
        const tot = pts + (posed[k] ? POSE_BONUS : 0);
        s.sc[k] += tot;
        g.text(p.x, p.y - p.r - 30, `+${tot}`, { player: k, size: count === 1 ? 64 : 46 });
        if (posed[k]) { g.text(p.x, p.y + p.r + 40, 'IN POSA!', { player: k, size: 40 }); g.sfx('tada'); }
        g.burst(p.x, p.y, { player: k, n: count === 1 ? 18 : 8, speed: 260 });
        g.sfx(count === 1 ? 'coin' : 'point', { pitch: count === 1 ? 1.2 : 1 });
        g.vibrate(k, 60);
      } else if (blur[k]) {
        g.text(p.x, p.y - p.r - 30, 'SBAVATO!', { player: k });
        g.sfx('buzzer', { vol: 0.6 });
      }
    });
    if (!inside.some(Boolean)) { g.text(fr.x, fr.y, 'NESSUNO!', { color: '#fff' }); g.sfx('quack'); }
    if (count >= 2) g.sfx('wobble', { vol: 0.6 });

    // The portrait with silly faces of whoever was in the frame.
    s.photo = {
      a: 0, n: s.photoN++, x: fr.x, y: fr.y, w: fr.w, h: fr.h,
      q: s.p.filter((p, k) => inside[k]).map((p) => ({
        i: p.i, x: p.x - fr.x, y: p.y - fr.y, r: p.r,
        m: p.stun > 0 ? 'dizzy' : blur[p.i] ? 'scared' : posed[p.i] || count === 1 ? 'happy' : g.rng.pick(MOODS), b: blur[p.i] ? 1 : 0, ps: posed[p.i] ? 1 : 0,
        fx: p.fx, fy: p.fy,
      })),
    };

    s.shotAt = g.t + (s.fast ? SHOT_FAST : SHOT_EVERY);
    s.tp = 0; s.digit = 0; s.hint = null;
    if (g.variant === 'stringe' && fr.w > FRAME_MIN_W) {
      fr.w = Math.max(FRAME_MIN_W, fr.w * 0.86); fr.h = Math.max(FRAME_MIN_H, fr.h * 0.86);
      clampFrame(fr); newTarget(s, g);
      g.sfx('shrink', { vol: 0.6 });
    }

    // Winner check (tie at the top on the same portrait: better centred wins).
    if (s.sc.some((v) => v >= WIN)) {
      const w = game.best(s);
      const p = s.p[w];
      g.sfx('fanfare'); g.confetti(p.x, p.y); g.slowmo(0.3, 0.7); g.shake(0.4);
      g.end(w, 'Ritratto da museo!');
    }
  },

  // Highest score; ties broken by distance to the frame centre.
  best(s) {
    const fr = s.fr;
    let w = 0;
    for (let k = 1; k < s.p.length; k++) {
      if (s.sc[k] > s.sc[w]) w = k;
      else if (s.sc[k] === s.sc[w] && dist(s.p[k].x, s.p[k].y, fr.x, fr.y) < dist(s.p[w].x, s.p[w].y, fr.x, fr.y)) w = k;
    }
    return w;
  },

  timeout(s) {
    return game.best(s);
  },

  view(s) {
    const fr = s.fr;
    const v = {
      fr: { x: r1(fr.x), y: r1(fr.y), w: r1(fr.w), h: r1(fr.h) },
      dg: s.digit, ct: r2(clamp((s.shotAt - s.t) / (s.fast ? SHOT_FAST : SHOT_EVERY), 0, 1)), hv: s.hint ? 1 : 0, hx: s.hint ? r1(s.hint.x) : 0, hy: s.hint ? r1(s.hint.y) : 0,
      p: s.p.map((p) => {
        const sp = Math.hypot(p.vx, p.vy);
        return {
          x: r1(p.x), y: r1(p.y), r: r1(p.r), fx: r2(p.fx), fy: r2(p.fy), cd: r2(p.cd), s: r2(p.stun), sl: r2(p.slapT), po: r2(p.pose), pc: r2(p.pcd),
          f: sp > BLUR_SPEED ? 1 : 0, w: r2(Math.min(1, sp / MAX_SPEED)), in: insideFrame(fr, p) ? 1 : 0,
        };
      }),
      hud: { p: s.sc.slice(), max: null, label: 'Punti' },
    };
    if (s.photo) {
      const ph = s.photo;
      v.ph = {
        a: r2(ph.a), n: ph.n, x: r1(ph.x), y: r1(ph.y), w: r1(ph.w), h: r1(ph.h),
        q: ph.q.map((q) => ({ i: q.i, x: r1(q.x), y: r1(q.y), r: r1(q.r), m: q.m, b: q.b, ps: q.ps, fx: r2(q.fx), fy: r2(q.fy) })),
      };
    }
    return v;
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  // Computer player: runs to where the frame will be at the last stroke (around the fountain, to the painter's
  // new spot in Pittore Pazzo), slaps whoever is in reach, and (medio/difficile) hunts the intruders in the frame,
  // slows down for Ritratto Mosso and strikes the pose on the "1" when nobody can spoil it.
  bot(s, me, g, B) {
    const out = game.botThink(s, me, g, B);
    botPush(B.mem, out, BOT_DELAY[B.level]);
    return out;
  },

  botThink(s, me, g, B) {
    const p = s.p[me], fr = s.fr, m = B.mem, lv = B.level;
    const out = { x: 0, y: 0 };
    if (!p || g.ended) return out;
    const D = BOT_DELAY[lv];
    const rem = s.shotAt - g.t;
    if (p.pose > 0) return out;

    // Where the frame will be at the shot.
    let fx = fr.x, fy = fr.y;
    if (s.hint) { fx = s.hint.x; fy = s.hint.y; }
    else {
      const dx = fr.tx - fr.x, dy = fr.ty - fr.y, dd = Math.hypot(dx, dy) || 1;
      const go = Math.min(dd, (s.fast ? 175 : 125) * clamp(rem, 0, 1.2));
      fx += (dx / dd) * go; fy += (dy / dd) * go;
    }
    const hw = fr.w / 2, hh = fr.h / 2;
    const inF = (x, y, mg) => Math.abs(x - fx) <= hw - mg && Math.abs(y - fy) <= hh - mg;

    // Aim: the frame centre (pushed off the fountain), or a rival inside it worth slapping out.
    let ax = fx, ay = fy;
    const rf = FOUNT_R + p.r + 14;
    let dc = Math.hypot(ax - CX, ay - CY);
    if (dc < rf) {
      let ux = ax - CX, uy = ay - CY;
      if (dc < 1) { ux = p.x - CX; uy = p.y - CY; dc = Math.hypot(ux, uy) || 1; }
      ax = CX + (ux / dc) * rf; ay = CY + (uy / dc) * rf;
      if (!inF(ax, ay, 18)) { ax = clamp(ax, fx - hw + 30, fx + hw - 30); ay = clamp(ay, fy - hh + 30, fy + hh - 30); }
    }
    let prey = null, pd = 1e9;
    for (const o of s.p) {
      if (o === p || o.stun > 0) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      // Slap whoever is in reach and could still be in the portrait, or threatens me in it (a poser above all).
      const near = o.pose > 0 || inF(o.x, o.y, -Math.min(250, 40 + 400 * Math.max(0, rem))) || (o.cd <= 0.2 && inF(p.x, p.y, -60));
      if (near && p.cd <= 0 && p.stun <= 0 && d - p.r - o.r < SLAP_RANGE * (p.r / BALL_R) * 0.9 && (d < pd || o.pose > 0)) { prey = o; pd = o.pose > 0 ? -1 : d; }
    }
    if (prey) {
      const dx = prey.x - p.x, dy = prey.y - p.y, d = Math.hypot(dx, dy) || 1;
      out.x = dx / d; out.y = dy / d; out.tapA = true;
      return out;
    }
    if (lv > 0 && p.cd < 0.3 && rem > 0.15 && rem < 2.2 && inF(ax, ay, 0)) {
      // Hunt: a rival standing in the frame (I'd be alone) and close enough to reach.
      let best = 1e9;
      for (const o of s.p) {
        if (o === p || o.stun > 0 || !inF(o.x, o.y, -o.r * 0.5)) continue;
        const d = Math.hypot(o.x - p.x, o.y - p.y);
        if (d < (lv === 2 ? 320 : 220) && d < best) { best = d; ax = o.x + o.vx * D; ay = o.y + o.vy * D; }
      }
    }

    // Steering (around the fountain), with braking near the aim. It works on where I'll be when this input
    // lands (my own queued inputs replayed), so slow reactions don't overshoot.
    const f = botPredict(p, m, D);
    let tx = ax, ty = ay;
    const sx = ax - f.x, sy = ay - f.y, sl = sx * sx + sy * sy || 1;
    const k = clamp(((CX - f.x) * sx + (CY - f.y) * sy) / sl, 0, 1);
    const qx = f.x + sx * k - CX, qy = f.y + sy * k - CY, qd = Math.hypot(qx, qy);
    if (qd < FOUNT_R + p.r + 8 && Math.hypot(f.x - CX, f.y - CY) > FOUNT_R + p.r - 4) {
      let ux = qx, uy = qy;
      if (qd < 1) { ux = -sy; uy = sx; }
      const ul = Math.hypot(ux, uy) || 1;
      tx = CX + (ux / ul) * (FOUNT_R + p.r + 60); ty = CY + (uy / ul) * (FOUNT_R + p.r + 60);
    }
    const dx = tx - f.x, dy = ty - f.y, d = Math.hypot(dx, dy) || 1;
    let vmax = MAX_SPEED;
    if (g.variant === 'mosso' && lv > 0 && rem < D + 0.5 && rem > -0.1) vmax = 160; // no blur on the last stroke
    const want = Math.min(vmax, d * 4.5);
    const vx = (dx / d) * want, vy = (dy / d) * want;
    const drag = -Math.log(KEEP);
    out.x = (vx * drag) / ACCEL + (vx - f.vx) / 500;
    out.y = (vy * drag) / ACCEL + (vy - f.vy) / 500;
    const ol = Math.hypot(out.x, out.y);
    if (ol > 1) { out.x /= ol; out.y /= ol; }

    // Pose on the "1": the pose lands after D and must still be on at the shot, inside the frame with some margin,
    // with no rival able to slap me meanwhile.
    if (lv > 0 && p.pcd <= 0 && p.stun <= 0 && rem > D + 0.04 && rem < D + 0.4 && inF(p.x, p.y, 12 + 150 * (rem - D) * 0.3) && (!s.hint)) {
      let threat = false;
      for (const o of s.p) if (o !== p && o.stun <= 0.1 && Math.hypot(o.x - p.x, o.y - p.y) < (lv === 2 ? 190 : 140)) threat = true;
      if (!threat) out.tapB = true;
    }
    return out;
  },

  // ---------- 3D: the castle's rose garden at dawn, a court painter at the easel ----------
  render3d: {
    assets: [
      'medieval/building_castle_blue', 'medieval/building_tower_A_blue', 'medieval/building_tower_B_blue', 'medieval/wall_straight',
      'medieval/wall_straight_gate', 'medieval/wall_corner_A_outside', 'medieval/building_church_blue', 'medieval/building_stage_C',
      'medieval/tree_single_B', 'medieval/trees_B_small', 'medieval/trees_B_medium', 'medieval/trees_A_large', 'medieval/tent',
      'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow', 'medieval/building_well_blue',
      'medieval/fence_stone_straight', 'medieval/hills_A_trees', 'medieval/mountain_C_grass_trees', 'medieval/rock_single_D',
      'medieval/waterlily_A', 'medieval/waterplant_B', 'medieval/cloud_big', 'dungeon/banner_patternA_blue', 'dungeon/banner_patternC_white',
      'chars/Mage',
    ],
    build(K, r) {
      const { THREE } = K;
      const N = Math.max(2, Math.min(4, r.n || K.n || 2));
      const o = { flags: [], clouds: [] };
      K.theme('alba', { fogNear: 1.8, fogFar: 4.6 });
      K.ground('prato', { tile: 170, margin: 1700, color: '#d8f0b0' });
      buildGarden(K, o, N);
      // Fountain: stone basin, water, column, bowl, a gilded crown on top and the spray.
      const stone = K.texMat('pietra', [6, 1], { color: '#e6ddcf' });
      K.place(K.cyl(FOUNT_R + 8, 30, stone, { seg: 48 }), CX, CY);
      K.place(K.torus(FOUNT_R + 4, 7, K.mat('#d6ccbc', { rough: 0.7 }), { cast: false }), CX, CY, 30);
      K.place(K.disc(FOUNT_R - 6, K.mat('#3fa9e0', { rough: 0.08, metal: 0.15 })), CX, CY, 28.6);
      K.scatter('medieval/waterlily_A', [{ x: CX - 50, y: CY + 30, h: 26, rot: 1 }, { x: CX + 45, y: CY - 40, h: 26, rot: 2 }, { x: CX + 20, y: CY + 60, h: 26 }], { size: 30 });
      K.place(K.cyl(13, 60, stone, { seg: 16 }), CX, CY, 28);
      K.place(K.cyl(32, 12, stone, { r2: 14, seg: 24 }), CX, CY, 84);
      K.place(K.disc(28, K.mat('#5ec0f0', { rough: 0.1 })), CX, CY, 96.3);
      const gold = K.mat('#ffcc3a', { rough: 0.3, metal: 0.8 });
      K.place(K.cyl(14, 10, gold, { seg: 16 }), CX, CY, 97);
      for (let k = 0; k < 5; k++) { const a = (k / 5) * TAU; K.place(K.cone(4, 12, gold), CX + Math.cos(a) * 11, CY + Math.sin(a) * 11, 106); }
      o.ripples = [0, 1, 2].map(() => { const m = K.glow('#ffffff', { opacity: 0.4, unique: true }); return { m, mesh: K.torus(1, 0.03, m, { cast: false }) }; });
      o.drops = [0, 1, 2, 3, 4, 5].map(() => K.ball(4, K.glow('#dcf5ff'), { cast: false }));
      // Royal pigeons strolling along the hedges.
      const pigM = K.mat('#e9e9f0', { rough: 0.7 }), pigH = K.mat('#f4f4fa', { rough: 0.6 }), beakM = K.mat('#f2a33a');
      o.pigeons = [0, 1, 2, 3].map(() => {
        const g = K.group();
        const b = K.ball(11, pigM, { parent: g }); b.position.y = 11; b.scale.set(1.3, 0.9, 1);
        const head = K.ball(7, pigH, { parent: g }); head.position.set(11, 20, 0);
        const beak = K.cone(2.5, 7, beakM, { parent: head }); beak.rotation.z = -Math.PI / 2; beak.position.x = 6;
        return { g, head };
      });
      // The portrait frame on the ground: tinted area, raised golden L-corners, timer bar, wet-paint light.
      o.fillM = K.glow('#fff6d8', { opacity: 0.1, unique: true });
      o.fill = K.box(1, 1, 1, o.fillM, { cast: false });
      o.hotM = K.glow('#ffd86b', { unique: true });
      o.corners = [];
      for (let k = 0; k < 8; k++) o.corners.push(K.box(1, 1, 1, o.hotM, { cast: false }));
      o.barBg = K.box(1, 1, 1, K.glow('#000000', { opacity: 0.35 }), { cast: false });
      o.barM = K.glow('#ffffff', { unique: true });
      o.bar = K.box(1, 1, 1, o.barM, { cast: false });
      o.recM = K.glow('#ff3b3b', { unique: true });
      o.rec = K.ball(7, o.recM, { cast: false });
      // Teleport hint: a ghost frame and a question mark.
      o.ghostM = K.glow('#c7a6ff', { opacity: 0.6, unique: true });
      o.ghost = [];
      for (let k = 0; k < 8; k++) o.ghost.push(K.box(1, 1, 1, o.ghostM, { cast: false }));
      o.ask = K.emoji('❓', 60);
      // Countdown digit floating over the frame.
      o.digit = K.billboard(128, 128, 120, (d, w, h, dg, col) => { if (dg) d.text(String(dg), w / 2, h / 2, { size: 110, color: col }); }, { depthTest: false });
      o.digit.renderOrder = 10; o.dg = -1;
      // The court painter (the mage, without her staff) with a wooden easel and a canvas.
      const roster = K.roster;
      K.roster = [...roster, { char: 'mage', color: 1 }];
      o.painter = K.avatar(roster.length);
      K.roster = roster;
      o.easel = K.group();
      const wood = K.mat('#8a5a2b', { rough: 0.8 });
      for (const [z, rx] of [[-14, 0.12], [14, -0.12]]) { const leg = K.cyl(2.5, 96, wood, { seg: 6, parent: o.easel }); leg.position.set(4, 0, z); leg.rotation.set(rx, 0, 0.18); }
      const back = K.cyl(2.5, 90, wood, { seg: 6, parent: o.easel }); back.position.set(-14, 0, 0); back.rotation.z = -0.3;
      const shelf = K.box(10, 40, 3, wood, { parent: o.easel }); shelf.position.set(9, 40, 0);
      const canvasTex = K.canvasTex(128, 96, (d) => {
        d.rect(0, 0, 128, 96, '#f6ecd2');
        d.rect(10, 50, 108, 40, '#9ac87a'); d.circle(64, 50, 22, '#7fb5e8'); d.circle(40, 40, 10, '#ff8fa8'); d.circle(88, 44, 9, '#ffd36b');
        d.rect(0, 0, 128, 96, null, '#c9962f', 6);
      });
      const cmat = new THREE.MeshStandardMaterial({ map: canvasTex, color: canvasTex ? '#ffffff' : '#f6ecd2', roughness: 0.8 });
      const cnv = K.box(4, 56, 42, cmat, { parent: o.easel }); cnv.position.set(11, 62, 0); cnv.rotation.z = 0.18;
      const palette = K.ball(1, K.mat('#c48a45', { rough: 0.6 }), { parent: o.easel }); palette.position.set(-6, 2, 22); palette.scale.set(12, 2, 9);
      o.flashM = K.glow('#fff1c0', { add: true, opacity: 0.9, unique: true });
      o.flash = K.ball(1, o.flashM, { cast: false });
      o.brush = K.emoji('🖌️', 34);
      // The finished portrait (drawn once per portrait).
      o.photo = K.billboard(512, 512, 420, (d, w, h, ph) => {
        if (!ph) return;
        const k = w / 440;
        d.ctx.save(); d.ctx.translate(w / 2, h / 2); d.ctx.scale(k, k);
        drawCard(d, ph);
        d.ctx.restore();
      }, { depthTest: false });
      o.photo.renderOrder = 11; o.phN = -1;
      // Players.
      o.pl = Array.from({ length: N }, (_, i) => ({
        av: K.avatar(i),
        spot: K.disc(1, K.glow('#fff5a0', { opacity: 0.28, add: true })),
        sparks: [0, 1, 2, 3].map(() => K.ball(5, K.glow('#fff59d', { add: true }), { cast: false })),
        crown: K.emoji('👑', 40),
        stars: [0, 1, 2].map(() => K.emoji('⭐', 22)),
        blur: [0, 1].map(() => K.ball(1, K.glow(K.col(i, 'light'), { opacity: 0.22 }), { cast: false })),
        dec: K.decal(260),
      }));
      return o;
    },
    update(K, o, v, r) {
      const fr = v.fr;
      const t = K.t;
      const counting = v.dg > 0;
      const hot = counting ? ['#fff', '#ff4d4d', '#ffb02e', '#ffe14d'][v.dg] : '#ffd86b';
      // Fountain animation.
      o.ripples.forEach((R, k) => {
        const rr = ((t * 30 + k * 28) % 84) + 10;
        K.place(R.mesh, CX, CY, 29); R.mesh.scale.setScalar(rr); R.m.opacity = 0.5 * (1 - rr / 94);
      });
      o.drops.forEach((b, k) => {
        const a = (k * TAU) / 6 + t * 0.8, ph = ((t * 1.25 + k * 0.18) % 1);
        K.place(b, CX + Math.cos(a) * (14 + ph * 40), CY + Math.sin(a) * (14 + ph * 40), 104 + Math.sin(ph * Math.PI) * 40 - ph * 70);
      });
      // Pigeons strolling and pecking.
      o.pigeons.forEach((P, k) => {
        const tt = t * 0.12 + k * 0.25, u = (tt % 1) * 0.8 + 0.1;
        const side = k % 4;
        const x = side === 0 ? WALL + u * (W - WALL * 2) : side === 1 ? W - WALL - 14 : side === 2 ? W - WALL - u * (W - WALL * 2) : WALL + 14;
        const y = side === 0 ? WALL + 14 : side === 1 ? WALL + u * (H - WALL * 2) : side === 2 ? H - WALL - 14 : H - WALL - u * (H - WALL * 2);
        K.place(P.g, x, y); K.face(P.g, (side * Math.PI) / 2);
        P.head.position.y = 20 - Math.max(0, Math.sin(t * 7 + k * 2)) * 8;
      });
      // Banners and clouds.
      for (const f of o.flags) f.g.rotation.y = f.base + Math.sin(t * 2.2 + f.ph) * 0.12;
      for (const c of o.clouds) { const x = ((c.x + t * c.v + 3000) % 6000) - 2000; K.place(c.g, x, c.y, c.h); }
      // Frame.
      o.fillM.opacity = counting ? 0.18 : 0.1;
      o.fill.scale.set(fr.w, 1, fr.h); K.place(o.fill, fr.x, fr.y, 0.8);
      o.hotM.color.set(hot);
      const lw = counting ? 12 : 9;
      setCorners(K, o.corners, fr.x, fr.y, fr.w, fr.h, lw, counting ? 9 : 6);
      const bw = fr.w * 0.8, by = fr.y + fr.h / 2 + 17;
      o.barBg.scale.set(bw, 2, 10); K.place(o.barBg, fr.x, by, 1);
      const bl = Math.max(10, bw * (1 - v.ct));
      o.barM.color.set(counting ? hot : '#ffffff');
      o.bar.scale.set(bl, 3, 10); K.place(o.bar, fr.x - bw / 2 + bl / 2, by, 1.5);
      o.recM.color.set(Math.floor(t * 2) % 2 ? '#ff3b3b' : '#5a1a1a');
      K.place(o.rec, fr.x - fr.w / 2 + 18, fr.y - fr.h / 2 + 18, 6);
      // Teleport hint.
      const hint = !!v.hv;
      for (const g of o.ghost) g.visible = hint;
      o.ask.visible = hint;
      if (hint) {
        o.ghostM.opacity = 0.35 + 0.45 * Math.abs(Math.sin(t * 25));
        setCorners(K, o.ghost, v.hx, v.hy, fr.w, fr.h, 8, 5);
        K.place(o.ask, v.hx, v.hy, 60);
      }
      // Countdown digit.
      o.digit.visible = counting;
      if (counting) {
        if (o.dg !== v.dg) { o.dg = v.dg; o.digit.redraw(v.dg, hot); }
        K.place(o.digit, fr.x, fr.y - fr.h / 2, 120);
        o.digit.scale.setScalar(Math.min(130, fr.h * 0.55));
      } else o.dg = 0;
      // The painter stands behind her easel next to the frame's top-right corner, painting it.
      const tx = clamp(fr.x + fr.w / 2 + 44, WALL + 25, W - WALL - 25), ty = clamp(fr.y - fr.h / 2 - 44, WALL + 25, H - WALL - 25);
      const look = Math.atan2(fr.y - ty, fr.x - tx);
      const pa = v.ph ? v.ph.a : 9;
      o.painter.set(tx, ty, { r: 30, look, marker: false, gear: false, anim: pa < 0.5 ? 'Spellcast_Shoot' : counting ? 'Spellcasting' : 'Idle', animKey: v.ph ? v.ph.n : -1 });
      K.place(o.easel, tx + Math.cos(look) * 34, ty + Math.sin(look) * 34); K.face(o.easel, look + Math.PI);
      o.brush.visible = counting;
      if (counting) K.place(o.brush, tx + Math.cos(look) * 20, ty + Math.sin(look) * 20, 105 + Math.abs(Math.sin(t * 10)) * 10);
      o.flash.visible = pa < 0.25;
      if (o.flash.visible) { K.place(o.flash, fr.x, fr.y, 60); o.flash.scale.setScalar(40 + (0.25 - pa) * 500); o.flashM.opacity = 0.8 - pa * 3; }
      // The portrait falling and spinning.
      o.photo.visible = !!v.ph;
      if (v.ph) {
        const ph = v.ph;
        if (o.phN !== ph.n) { o.phN = ph.n; o.photo.redraw(ph); }
        const a = clamp(ph.a / PHOTO_LIFE, 0, 1), dir = ph.n % 2 ? 1 : -1;
        const sc = 0.75 - a * 0.35;
        K.place(o.photo, ph.x + dir * a * 60, ph.y + 120 * a, 230 * (1 - a * a) + 30);
        o.photo.scale.set(420 * sc, 420 * sc, 1);
        o.photo.material.rotation = -dir * (0.08 + a * 0.6);
        o.photo.material.opacity = a > 0.75 ? clamp(1 - (a - 0.75) / 0.25, 0, 1) : 1;
      }
      // Players.
      v.p.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const look = Math.atan2(p.fy, p.fx);
        const mood = p.s > 0 ? 'dizzy' : p.po > 0 ? 'happy' : p.sl > 0 ? 'angry' : counting && p.in ? 'happy' : 'ok';
        const anim = p.s > 0 ? (p.s > STUN * 0.55 ? 'Hit_B' : 'Idle') : p.po > 0 ? 'Cheer' : p.sl > 0 ? '1H_Melee_Attack_Slice_Horizontal' : undefined;
        P.av.set(p.x, p.y, { r: p.r, look: p.po > 0 ? Math.PI / 2 : look, mood, walk: p.w ?? 0, gear: false, anim, animSpeed: anim === '1H_Melee_Attack_Slice_Horizontal' ? 2.2 : undefined });
        // Striking a pose: spotlight, sparkles and a crown.
        const pose = p.po > 0;
        P.spot.visible = P.crown.visible = pose;
        P.sparks.forEach((s, k) => {
          s.visible = pose;
          if (!pose) return;
          const a = t * 3 + (k * TAU) / 4;
          K.place(s, p.x + Math.cos(a) * (p.r + 22), p.y + Math.sin(a) * (p.r + 22), p.r + Math.sin(t * 12 + k) * 12);
          s.scale.setScalar(0.8 + 0.4 * Math.sin(t * 12 + k));
        });
        if (pose) {
          K.place(P.spot, p.x, p.y, 1.2); P.spot.scale.setScalar(p.r + 28);
          K.place(P.crown, p.x, p.y, p.r * 3.3 + Math.sin(t * 8) * 4);
        }
        P.stars.forEach((s, k) => {
          s.visible = p.s > 0;
          if (!s.visible) return;
          const a = t * 7 + (k * TAU) / 3;
          K.place(s, p.x + Math.cos(a) * p.r * 0.85, p.y + Math.sin(a) * p.r * 0.85, p.r * 3);
        });
        // Smudge ghosts (Ritratto Mosso).
        P.blur.forEach((b, k) => {
          b.visible = !!p.f && r.variant === 'mosso';
          if (!b.visible) return;
          K.place(b, p.x - p.fx * (26 + k * 22), p.y - p.fy * (26 + k * 22), p.r);
          b.scale.setScalar(p.r * (1 - k * 0.1));
        });
        P.dec.at(p.x, p.y, 1).paint((d) => {
          const ax = p.fx * (p.r + 18), ay = p.fy * (p.r + 18);
          if (p.sl > 0) d.arc(0, 0, p.r + 30, look - 1, look + 1, 'rgba(255,255,255,0.7)', 7);
          d.poly([ax + p.fx * 16, ay + p.fy * 16, ax - p.fy * 12, ay + p.fx * 12, ax + p.fy * 12, ay - p.fx * 12], d.col(i, 'light') + (p.cd <= 0 ? 'ee' : '55'), 'rgba(0,0,0,0.35)', 2);
          if (p.cd <= 0) d.ring(0, 0, p.r + 8, d.col(i, 'light') + 'cc', 6);
          else d.arc(0, 0, p.r + 8, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / SLAP_CD), d.col(i, 'light') + '88', 6);
          if (p.pc > 0) d.arc(0, 0, p.r + 16, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.pc / POSE_CD), 'rgba(255,245,160,0.55)', 4);
          else d.arc(0, 0, p.r + 16, Math.PI * 0.2, Math.PI * 0.8, counting ? '#fff59d' : 'rgba(255,245,160,0.75)', counting ? 7 : 4);
        });
      });
    },
  },

  render(d, v, r) {
    const fr = v.fr;
    drawPiazza(d);

    // Frame shadow area (where the portrait will be painted).
    const counting = v.dg > 0;
    const hot = counting ? ['#fff', '#ff4d4d', '#ffb02e', '#ffe14d'][v.dg] : '#ffd86b';
    d.rect(fr.x - fr.w / 2, fr.y - fr.h / 2, fr.w, fr.h, counting ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.06)');

    // Teleport hint: ghost frame flickering at the next spot.
    if (v.hv) {
      const al = 0.4 + 0.4 * Math.abs(Math.sin(d.t * 25));
      drawCorners(d, v.hx, v.hy, fr.w, fr.h, `rgba(199,166,255,${al.toFixed(2)})`, 6);
      d.emoji('❓', v.hx, v.hy, 60);
    }

    // Players.
    v.p.forEach((p, i) => {
      d.shadow(p.x + 5, p.y + 9, p.r, p.r * 0.8, 0.28);
      const look = Math.atan2(p.fy, p.fx);
      if (p.f && r.variant === 'mosso') {
        d.circle(p.x - p.fx * 26, p.y - p.fy * 26, p.r, d.col(i, 'light') + '40');
        d.circle(p.x - p.fx * 48, p.y - p.fy * 48, p.r * 0.9, d.col(i, 'light') + '22');
      }
      if (p.sl > 0) {
        // Gloved hand swinging in front.
        const sw = (0.2 - p.sl) * 9 - 0.9;
        const ca = Math.cos(sw), sa = Math.sin(sw);
        const hx = p.fx * ca - p.fy * sa, hy = p.fx * sa + p.fy * ca;
        d.arc(p.x, p.y, p.r + 26, look - 1, look + 1, 'rgba(255,255,255,0.5)', 5);
        d.circle(p.x + hx * (p.r + 24), p.y + hy * (p.r + 24), p.r * 0.38, d.col(i, 'light'), '#fff', 3);
      }
      if (p.po > 0) {
        // Royal pose: spotlight, sparkles and a crown.
        d.circle(p.x, p.y, p.r + 26, 'rgba(255,245,160,0.22)');
        for (let k = 0; k < 4; k++) {
          const a = d.t * 3 + (k * TAU) / 4;
          d.star(p.x + Math.cos(a) * (p.r + 22), p.y + Math.sin(a) * (p.r + 22), 7 + 3 * Math.sin(d.t * 12 + k), '#fff59d', 4);
        }
        d.emoji('👑', p.x, p.y - p.r * 1.1, 34);
      }
      const mood = p.s > 0 ? 'dizzy' : p.po > 0 ? 'happy' : p.sl > 0 ? 'angry' : counting && p.in ? 'happy' : 'ok';
      d.avatar(p.x, p.y, p.r, i, { look: p.po > 0 ? Math.PI / 2 : look, mood, squash: p.s > 0 ? -0.15 : p.po > 0 ? -0.12 : p.sl > 0 ? 0.12 : 0 });
      // Facing arrow + recharge rings (outer = slap, inner = pose).
      const ax = p.x + p.fx * (p.r + 16), ay = p.y + p.fy * (p.r + 16);
      d.poly([ax + p.fx * 13, ay + p.fy * 13, ax - p.fy * 9, ay + p.fx * 9, ax + p.fy * 9, ay - p.fx * 9], d.col(i, 'light') + (p.cd <= 0 ? 'ee' : '55'));
      if (p.cd <= 0) d.ring(p.x, p.y, p.r + 6, d.col(i, 'light') + 'aa', 4);
      else d.arc(p.x, p.y, p.r + 6, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / SLAP_CD), d.col(i, 'light') + '66', 4);
      if (p.pc > 0) d.arc(p.x, p.y, p.r + 12, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.pc / POSE_CD), 'rgba(255,245,160,0.4)', 3);
      else d.arc(p.x, p.y, p.r + 12, Math.PI * 0.2, Math.PI * 0.8, counting ? '#fff59d' : 'rgba(255,245,160,0.6)', counting ? 5 : 3);
      if (p.s > 0) {
        for (let k = 0; k < 3; k++) {
          const a = d.t * 7 + (k * TAU) / 3;
          d.star(p.x + Math.cos(a) * p.r * 0.85, p.y - p.r * 0.55 + Math.sin(a) * p.r * 0.3, 8, '#fff59d');
        }
      }
    });

    // Frame with L corners, painter's easel and countdown.
    const lw = counting ? 9 : 7;
    const bw = fr.w * 0.8;
    d.rrect(fr.x - bw / 2, fr.y + fr.h / 2 + 12, bw, 10, 5, 'rgba(0,0,0,0.35)');
    d.rrect(fr.x - bw / 2, fr.y + fr.h / 2 + 12, Math.max(10, bw * (1 - v.ct)), 10, 5, counting ? hot : 'rgba(255,255,255,0.7)');
    d.neon(() => drawCorners(d, fr.x, fr.y, fr.w, fr.h, hot, lw), hot);
    d.circle(fr.x - fr.w / 2 + 18, fr.y - fr.h / 2 + 18, 7, Math.floor(d.t * 2) % 2 ? '#ff3b3b' : 'rgba(255,59,59,0.3)');
    d.emoji('🎨', fr.x + fr.w / 2 + 6, fr.y - fr.h / 2 - 24, 44);
    if (counting) {
      d.text(String(v.dg), fr.x, fr.y, { size: Math.min(110, fr.h * 0.6), color: hot });
    }

    if (v.ph) drawPolaroid(d, v.ph);
  },
};
export default game;

// L-shaped corners of a viewfinder.
function drawCorners(d, x, y, w, h, color, lw) {
  const L = Math.min(48, w * 0.22), x0 = x - w / 2, x1 = x + w / 2, y0 = y - h / 2, y1 = y + h / 2;
  d.line(x0, y0, x0 + L, y0, color, lw); d.line(x0, y0, x0, y0 + L, color, lw);
  d.line(x1, y0, x1 - L, y0, color, lw); d.line(x1, y0, x1, y0 + L, color, lw);
  d.line(x0, y1, x0 + L, y1, color, lw); d.line(x0, y1, x0, y1 - L, color, lw);
  d.line(x1, y1, x1 - L, y1, color, lw); d.line(x1, y1, x1, y1 - L, color, lw);
}

// Castle garden (2D fallback): hedges, flagstones, fountain, flower beds.
function drawPiazza(d) {
  const { ctx } = d;
  ctx.fillStyle = '#4f8a3a';
  ctx.fillRect(-300, -300, W + 600, H + 600);
  d.rect(WALL, WALL, W - WALL * 2, H - WALL * 2, '#d9cfbb');
  const S = 62;
  for (let row = 0, y = WALL + 4; y < H - WALL; row++, y += S * 0.72) {
    const off = row % 2 ? S / 2 : 0;
    for (let x = WALL - off + 4; x < W - WALL; x += S) {
      const w = Math.min(S - 8, W - WALL - x - 2), xs = Math.max(x, WALL + 2);
      if (w - (xs - x) > 10) d.rrect(xs, y, w - (xs - x), S * 0.72 - 8, 10, (row + Math.round(x / S)) % 3 ? '#cfc4ae' : '#c4b89f');
    }
  }
  d.rect(WALL - 6, WALL - 6, W - WALL * 2 + 12, W - WALL * 2 + 12, null, '#2f6a2a', 10);
  d.shadow(CX + 8, CY + 12, FOUNT_R + 10, FOUNT_R + 4, 0.25);
  d.circle(CX, CY, FOUNT_R + 8, '#e6ddcf', '#9c9488', 4);
  d.circle(CX, CY, FOUNT_R - 6, '#3fa9e0');
  for (let k = 0; k < 3; k++) {
    const rr = ((d.t * 30 + k * 28) % 84) + 10;
    d.ring(CX, CY, rr, `rgba(255,255,255,${(0.45 * (1 - rr / 94)).toFixed(2)})`, 3);
  }
  d.circle(CX, CY, 22, '#ffcc3a', '#9c7a20', 3);
  for (const [x, y] of [[WALL + 26, WALL + 26], [W - WALL - 26, WALL + 26], [WALL + 26, H - WALL - 26], [W - WALL - 26, H - WALL - 26]]) {
    d.circle(x, y, 22, '#3f7a32', '#24521c', 3);
    for (let k = 0; k < 5; k++) d.circle(x + Math.cos(k * 1.26) * 10, y + Math.sin(k * 1.26) * 10, 7, k % 2 ? '#ff6fa8' : '#ffffff');
  }
}

// The finished portrait, falling and spinning.
function drawPolaroid(d, ph) {
  const { ctx } = d;
  const a = clamp(ph.a / PHOTO_LIFE, 0, 1);
  const sc = 0.75 - a * 0.35, dir = ph.n % 2 ? 1 : -1;
  const alpha = a > 0.75 ? 1 - (a - 0.75) / 0.25 : 1;
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.translate(ph.x + dir * a * 60, ph.y + 280 * a * a);
  ctx.rotate(dir * (0.08 + a * 0.6));
  ctx.scale(sc, sc);
  drawCard(d, ph);
  if (a < 0.25) d.rect(-ph.w / 2, -ph.h / 2, ph.w, ph.h, `rgba(255,248,220,${(0.8 * (1 - a / 0.25)).toFixed(2)})`);
  ctx.restore();
}

// The portrait in its gilded frame, centered on (0, 0), in frame units.
function drawCard(d, ph) {
  const { ctx } = d;
  const w = ph.w, h = ph.h, m = 22;
  d.rrect(-w / 2 - m + 6, -h / 2 - m + 10, w + m * 2, h + m * 2, 6, 'rgba(0,0,0,0.3)');
  d.rrect(-w / 2 - m, -h / 2 - m, w + m * 2, h + m * 2, 6, '#c9962f', '#6e4a10', 5);
  d.rect(-w / 2 - m + 7, -h / 2 - m + 7, w + m * 2 - 14, h + m * 2 - 14, null, '#ffe08a', 4);
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) d.circle(sx * (w / 2 + m / 2), sy * (h / 2 + m / 2), 7, '#ffe08a', '#8a5a10', 2);
  // Painted landscape background.
  d.rect(-w / 2, -h / 2, w, h, '#a9cfe8');
  d.rect(-w / 2, h / 6, w, h / 3, '#7fae5a');
  d.circle(w / 3, -h / 3, 16, '#ffe9a0');
  ctx.save();
  ctx.beginPath();
  ctx.rect(-w / 2, -h / 2, w, h);
  ctx.clip();
  d.circle(-w / 3, h / 6, 40, '#6a9a4a');
  if (!ph.q.length) {
    // Empty portrait: just a confused pigeon.
    d.circle(0, 6, 22, '#e9e9f0'); d.circle(16, -10, 12, '#f4f4fa'); d.circle(20, -12, 3, '#111');
    d.poly([28, -10, 40, -6, 28, -4], '#f2a33a');
  }
  for (const q of ph.q) {
    if (q.b) {
      d.avatar(q.x - 22, q.y, q.r, q.i, { mood: q.m, alpha: 0.3, look: Math.atan2(q.fy, q.fx) });
      d.avatar(q.x + 22, q.y, q.r, q.i, { mood: q.m, alpha: 0.3, look: Math.atan2(q.fy, q.fx) });
    }
    d.avatar(q.x, q.y, q.r, q.i, { mood: q.m, alpha: q.b ? 0.55 : 1, squash: q.m === 'dizzy' ? -0.2 : 0.1, look: q.ps ? Math.PI / 2 : Math.atan2(q.fy, q.fx) });
    if (q.ps) d.emoji('👑', q.x, q.y - q.r * 1.1, 30);
  }
  ctx.restore();
}

// Place 8 unit boxes as the raised L-corners of a viewfinder (bar thickness lw, height hh).
function setCorners(K, boxes, x, y, w, h, lw, hh) {
  const L = Math.min(48, w * 0.22);
  let n = 0;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const cx = x + (sx * w) / 2, cy = y + (sy * h) / 2;
    const a = boxes[n++], b = boxes[n++];
    a.scale.set(L + lw / 2, hh, lw); K.place(a, cx - (sx * (L - lw / 2)) / 2, cy, hh / 2);
    b.scale.set(lw, hh, L + lw / 2); K.place(b, cx, cy - (sy * (L - lw / 2)) / 2, hh / 2);
  }
}

// Courtyard pattern painted over the flagstones: gravel path ring, flower-bed borders, soft dawn light.
function drawCourt(d) {
  const { ctx } = d;
  d.ring(CX, CY, FOUNT_R + 70, 'rgba(240,226,190,0.55)', 46);
  d.ring(CX, CY, FOUNT_R + 96, 'rgba(150,120,80,0.35)', 4);
  d.ring(CX, CY, FOUNT_R + 44, 'rgba(150,120,80,0.35)', 4);
  // Flower beds hugging the hedges (petals of every team color).
  const cols = ['#ff6f8a', '#ffffff', '#ffd23f', '#c78bff', '#ff9f43'];
  for (let k = 0; k < 120; k++) {
    const side = k % 4, u = WALL + 20 + ((k * 61) % (W - WALL * 2 - 40));
    const off = 8 + ((k * 13) % 14);
    const x = side === 0 ? u : side === 1 ? W - WALL - off : side === 2 ? u : WALL + off;
    const y = side === 0 ? WALL + off : side === 1 ? u : side === 2 ? H - WALL - off : u;
    d.circle(x, y, 7, '#3f7a32');
    d.circle(x, y, 4, cols[k % cols.length]);
  }
  const sun = ctx.createLinearGradient(0, 0, W, H);
  sun.addColorStop(0, 'rgba(255,220,180,0.16)'); sun.addColorStop(1, 'rgba(120,80,160,0.10)');
  ctx.fillStyle = sun;
  ctx.fillRect(WALL, WALL, W - WALL * 2, H - WALL * 2);
}

// The castle garden: flagstone court, hedges, castle and towers behind, pavilions, trees, team banners, hills.
function buildGarden(K, o, N) {
  const { THREE } = K;
  const far = K.quality > 0;
  const rnd = mulberry(5);
  // Flagstone courtyard with the painted path pattern.
  const court = K.mesh(new THREE.PlaneGeometry(W - WALL * 2, H - WALL * 2).rotateX(-Math.PI / 2), K.texMat('lastre', [6, 6], { color: '#f0e6d4' }));
  court.userData.ownGeo = true;
  K.place(court, CX, CY, 0.3);
  K.layer({ x0: WALL, y0: WALL, x1: W - WALL, y1: H - WALL, h: 0.7, transparent: true, once: true, draw: (d) => drawCourt(d) });
  // Clipped box hedges all around (the walls of the play area), with a round topiary at each corner.
  const hedge = K.texMat('erba', [8, 1], { color: '#4e8f3e', rough: 0.95 });
  const hedgeS = K.texMat('erba', [1, 1], { color: '#4e8f3e', rough: 0.95 });
  for (const [x, y, w, h] of [[CX, WALL / 2, W, WALL], [CX, H - WALL / 2, W, WALL], [WALL / 2, CY, WALL, H - WALL * 2], [W - WALL / 2, CY, WALL, H - WALL * 2]]) {
    K.place(K.box(w, h, 44, hedge), x, y, 22);
  }
  for (const [x, y] of [[WALL / 2, WALL / 2], [W - WALL / 2, WALL / 2], [WALL / 2, H - WALL / 2], [W - WALL / 2, H - WALL / 2]]) {
    K.place(K.cyl(10, 30, K.mat('#6b4423'), { seg: 8 }), x, y, 40);
    K.place(K.ball(34, hedgeS, { seg: 16 }), x, y, 92);
  }
  // Rose bushes on the hedges.
  const rose = [K.glow('#ff4d6d'), K.glow('#ffffff'), K.glow('#ffd23f')];
  for (let k = 0; k < (far ? 36 : 16); k++) {
    const side = k % 4, u = 60 + rnd() * (W - 120);
    const x = side === 0 || side === 2 ? u : side === 1 ? W - WALL / 2 : WALL / 2;
    const y = side === 0 ? WALL / 2 : side === 2 ? H - WALL / 2 : u;
    K.place(K.ball(6, rose[k % 3], { cast: false, seg: 8 }), x + (rnd() - 0.5) * 20, y + (rnd() - 0.5) * 20, 44);
  }
  // Team banners on tall poles, one per seat side (0 bottom, 1 top, 2 left, 3 right).
  const flagN = ['medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow'];
  const flagPos = [[CX + 200, H + 40], [CX - 200, -40], [-40, CY + 200], [W + 40, CY - 200]];
  for (let i = 0; i < 4; i++) {
    const f = K.model(flagN[i], { height: i < N ? 170 : 120 });
    K.place(f, flagPos[i][0], flagPos[i][1]);
    o.flags.push({ g: f, base: rnd() * 6, ph: i * 1.7 });
    f.rotation.y = o.flags[i].base;
  }
  // The castle behind the garden, towers and walls.
  const put = (name, x, y, size, face) => { const g = K.model(name, { size }); K.place(g, x, y); K.face(g, face ?? Math.atan2(CY - y, CX - x)); return g; };
  put('medieval/building_castle_blue', CX, -360, 520, Math.PI / 2);
  put('medieval/building_tower_A_blue', -260, -260, 190);
  put('medieval/building_tower_B_blue', W + 260, -260, 190);
  const walls = [];
  for (let k = 0; k < 9; k++) walls.push({ x: -380 + k * 220, y: -170, rot: 0 });
  K.scatter('medieval/wall_straight', walls.filter((w) => Math.abs(w.x - CX) > 330), { size: 222 });
  K.scatter('medieval/wall_corner_A_outside', [{ x: -490, y: -170, rot: Math.PI }, { x: W + 490, y: -170, rot: -Math.PI / 2 }], { size: 222 });
  const ban = K.scatter('dungeon/banner_patternA_blue', [{ x: CX - 200, y: -160, rot: Math.PI / 2 }, { x: CX + 200, y: -160, rot: Math.PI / 2 }], { height: 120 });
  ban.position.y += 60;
  // Pavilions and a stage for the court on the sides.
  put('medieval/tent', -240, 260, 190);
  put('medieval/tent', W + 240, 760, 190);
  put('medieval/building_stage_C', W + 250, 250, 230);
  put('medieval/building_well_blue', -250, 780, 140);
  put('medieval/building_church_blue', -520, -560, 360);
  // Trees: an orchard ring and the forest beyond.
  const near = [], mid = [], big = [];
  for (let k = 0; k < (far ? 28 : 14); k++) {
    const side = k % 4, u = -200 + rnd() * (W + 400);
    const d = 110 + rnd() * 120;
    const x = side === 0 || side === 2 ? u : side === 1 ? W + d : -d;
    const y = side === 0 ? H + d : side === 2 ? -d - 40 : u;
    if (side === 2 && Math.abs(x - CX) < 380) continue;
    if ((side === 1 && Math.abs(y - 250) < 120) || (side === 3 && Math.abs(y - 260) < 120)) continue;
    near.push({ x, y, rot: rnd() * 6, s: 0.8 + rnd() * 0.4 });
  }
  for (let k = 0; k < (far ? 40 : 18); k++) {
    const a = rnd() * TAU, R = 900 + rnd() * 900;
    const x = CX + Math.cos(a) * R, y = CY + Math.sin(a) * R;
    if (y < -300 && Math.abs(x - CX) < 700) continue;
    (k % 2 ? mid : big).push({ x, y, rot: rnd() * 6, s: 0.8 + rnd() * 0.5 });
  }
  K.scatter('medieval/tree_single_B', near, { size: 120 });
  K.scatter('medieval/trees_B_medium', mid, { size: 240 });
  K.scatter('medieval/trees_A_large', big, { size: 280 });
  K.scatter('medieval/trees_B_small', [{ x: 120, y: 1120 }, { x: 880, y: 1130, rot: 2 }, { x: -130, y: 1100, rot: 1 }, { x: 1150, y: 1080 }], { size: 140 });
  K.scatter('medieval/fence_stone_straight', [-1, 0, 1, 2, 3, 4, 5].map((k) => ({ x: k * 200 - 100, y: H + 330, rot: 0 })), { size: 202 });
  K.scatter('medieval/rock_single_D', [{ x: -150, y: 520 }, { x: 1170, y: 470, rot: 2 }], { size: 60 });
  if (far) {
    K.scatter('medieval/hills_A_trees', [{ x: -1300, y: -800 }, { x: 2300, y: -700, rot: 2 }, { x: -1200, y: 1500, rot: 1 }, { x: 2200, y: 1600 }], { size: 900 });
    K.scatter('medieval/mountain_C_grass_trees', [{ x: CX - 900, y: -2200 }, { x: CX + 1100, y: -2300, rot: 1.5 }], { size: 1400 });
    for (const [x, y, h, v] of [[-500, -1500, 950, 24], [1600, -1700, 1050, 18]]) o.clouds.push({ g: K.model('medieval/cloud_big', { size: 650, cast: false }), x, y, h, v });
  }
  K.ambient('petali', { n: 60 });
  K.ambient('polvere', { n: 40 });
}

// Tiny deterministic RNG for the scenery layout.
function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
