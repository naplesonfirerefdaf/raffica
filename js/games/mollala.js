// Mollala, Maestà! — Shine Thief style: grab the royal crown, keep it, ram whoever wears it. 2–4 players.
import { clamp, damp, dist, collideCircles, norm, bounceCircleRect, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500, WALL = 30;
const BALL_R = 44, STAR_R = 26;
const ACCEL = 1500, MAX_SPEED = 540, KEEP = 0.18;
const DASH_SPEED = 1000, DASH_TIME = 0.22, DASH_CD = 1.0;
const HOLD_SLOW = 0.85, WIN_TIME = 10, TURBO_AT = 30, TURBO_RATE = 1.5;
const LOCK = 0.4, STEAL_STUN = 0.35, STEAL_BONUS = 1;
const DODGE_SPEED = 820, DODGE_TIME = 0.32, DODGE_CD = 1.4;
// Point-symmetric obstacles: 4 braziers on stone plinths + 2 banquet tables (2 players only: with 3–4 players
// the tables go away so the hall is symmetric for the four sides), center left open for the crown.
const BLOCKS = [
  { x: 230, y: 230, w: 100, h: 100 }, { x: 670, y: 230, w: 100, h: 100 },
  { x: 230, y: 670, w: 100, h: 100 }, { x: 670, y: 670, w: 100, h: 100 },
  { x: 120, y: 470, w: 130, h: 60 }, { x: 750, y: 470, w: 130, h: 60 },
];
// Seat i starts on its side: 0 bottom, 1 top, 2 left, 3 right (x, y, facing x, facing y).
const SPAWN = [[CX, 860, 0, -1], [CX, 140, 0, 1], [140, CY, 1, 0], [860, CY, -1, 0]];
const GOLD = '#ffd84a';

// Keep a circle inside the arena walls and out of the first nb blocks. Returns true on any hit.
function collideArena(o, rest, nb = 6) {
  let hit = false;
  for (let k = 0; k < nb; k++) { const b = BLOCKS[k]; if (bounceCircleRect(o, b.x, b.y, b.w, b.h, rest)) hit = true; }
  const lo = WALL + o.r, hi = W - WALL - o.r;
  if (o.x < lo) { o.x = lo; if (o.vx < 0) o.vx = -o.vx * rest; hit = true; }
  if (o.x > hi) { o.x = hi; if (o.vx > 0) o.vx = -o.vx * rest; hit = true; }
  if (o.y < lo) { o.y = lo; if (o.vy < 0) o.vy = -o.vy * rest; hit = true; }
  if (o.y > hi) { o.y = hi; if (o.vy > 0) o.vy = -o.vy * rest; hit = true; }
  return hit;
}

const mass = (p) => p.m0 * (p.r / p.base) ** 2;

// ---- Computer player ----
const BOT_DELAY = [0.34, 0.2, 0.09]; // reaction delay of the bot driver per level (core/bots.js)

// Route around the braziers/tables: if the straight line hits a block, head for its best corner instead.
function botRoute(s, x, y, r, gx, gy, margin = 12) {
  for (let k = 0; k < s.nb; k++) {
    const b = BLOCKS[k], m = r + margin;
    const x0 = b.x - m, y0 = b.y - m, x1 = b.x + b.w + m, y1 = b.y + b.h + m;
    // Segment vs expanded rect (slab test).
    let t0 = 0, t1 = 1;
    const dx = gx - x, dy = gy - y;
    let hit = true;
    for (const [p0, d, lo, hi] of [[x, dx, x0, x1], [y, dy, y0, y1]]) {
      if (Math.abs(d) < 1e-6) { if (p0 < lo || p0 > hi) { hit = false; break; } continue; }
      let a = (lo - p0) / d, c = (hi - p0) / d;
      if (a > c) [a, c] = [c, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, c);
      if (t0 > t1) { hit = false; break; }
    }
    // (A goal hugging the block itself is reached directly.)
    if (!hit || (x > x0 && x < x1 && y > y0 && y < y1) || (gx > x0 && gx < x1 && gy > y0 && gy < y1)) continue;
    let best = null, bc = Infinity;
    for (const [cx, cy] of [[x0 - 4, y0 - 4], [x1 + 4, y0 - 4], [x0 - 4, y1 + 4], [x1 + 4, y1 + 4]]) {
      const c = Math.hypot(cx - x, cy - y) + Math.hypot(gx - cx, gy - cy);
      if (c < bc) { bc = c; best = { x: cx, y: cy }; }
    }
    return best;
  }
  return { x: gx, y: gy };
}

function mollalaBot(s, me, g, B) {
  const p = s.p[me];
  if (!p || p.out || s.boom >= 0) return { x: 0, y: 0 };
  const lv = B.level, delay = BOT_DELAY[lv];
  const st = s.star, bomb = s.fuse > 0;
  const px = p.x + p.vx * delay, py = p.y + p.vy * delay;
  const steer = (gx, gy) => {
    const w = botRoute(s, p.x, p.y, p.r, gx, gy);
    const T = 0.3 + delay;
    let vx = (w.x - px) / T, vy = (w.y - py) / T;
    const v = Math.hypot(vx, vy);
    if (v > MAX_SPEED) { vx *= MAX_SPEED / v; vy *= MAX_SPEED / v; }
    const G = Math.max(220, 1500 * delay);
    let ux = (vx - p.vx) / G, uy = (vy - p.vy) / G;
    const m = Math.hypot(ux, uy);
    if (m > 1) { ux /= m; uy /= m; }
    return { x: ux, y: uy };
  };
  const rivals = s.p.filter((q) => q !== p && !q.out);
  const holding = st.holder === me;

  // Dodge an incoming ram (when it matters: I carry the crown, or someone carrying the bomb).
  const mustDodge = bomb ? (st.holder >= 0 && st.holder !== me) : holding;
  if (mustDodge && lv > 0 && p.dcd <= 0 && p.dash <= 0) {
    for (const q of rivals) {
      const dx = p.x - q.x, dy = p.y - q.y, d = Math.hypot(dx, dy) || 1;
      const closing = (q.vx * dx + q.vy * dy) / d;
      const gap = d - p.r - q.r;
      // Ram on its way, or a rival ready to ram, facing me and so close that I could not react in time.
      const coming = q.dash > 0 && closing > 300 && gap / closing < delay + 0.12;
      const ready = q.dash <= 0 && q.cd <= delay && gap < 1000 * delay + 50 && (q.fx * dx + q.fy * dy) / d > 0.8 && q.stun <= 0;
      if (coming || ready) {
        // Hop sideways (the side away from the walls).
        let sx = -dy / d, sy = dx / d;
        if (Math.hypot(p.x + sx * 120 - CX, p.y + sy * 120 - CY) > Math.hypot(p.x - sx * 120 - CX, p.y - sy * 120 - CY)) { sx = -sx; sy = -sy; }
        return { x: sx, y: sy, tapB: true };
      }
    }
  }

  // Run away: from the crown hunters (or from the bomb carrier / the rolling bomb).
  const flee = (threats) => {
    let fx = 0, fy = 0;
    for (const t of threats) {
      const dx = px - t.x, dy = py - t.y, d = Math.max(40, Math.hypot(dx, dy));
      const w = t.w / (d * d);
      fx += dx * w; fy += dy * w;
    }
    // Walls and corners push back toward the open middle.
    const lo = WALL + p.r + 90, hi = W - WALL - p.r - 90;
    // (Beginners forget about the walls and get cornered.)
    const wk = lv === 0 ? 0.0012 : 0.004;
    if (px < lo) fx += (lo - px) * wk; if (px > hi) fx -= (px - hi) * wk;
    if (py < lo) fy += (lo - py) * wk; if (py > hi) fy -= (py - hi) * wk;
    fx += (CX - px) * 0.0004; fy += (CY - py) * 0.0004;
    const n = norm(fx, fy);
    return steer(px + n.x * 200, py + n.y * 200);
  };

  if (!bomb) {
    if (holding) {
      const look = lv === 0 ? 0 : 0.3;
      return flee(rivals.map((q) => ({ x: q.x + q.vx * look, y: q.y + q.vy * look, w: q.cd <= 0.2 && lv > 0 ? 1.6 : 1 })));
    }
    if (st.holder < 0) {
      // Crown loose: go get it (predict where it rolls), ram whoever is about to take it.
      const k = 1 - Math.pow(0.3, 0.4);
      const sx = st.x + st.vx * k / 1.2, sy = st.y + st.vy * k / 1.2;
      const want = steer(sx, sy);
      return want;
    }
  } else if (st.holder < 0) {
    // Loose bomb: keep away from it.
    return flee([{ x: st.x, y: st.y, w: 1.5 }, ...rivals.map((q) => ({ x: q.x, y: q.y, w: 0.2 }))]);
  } else if (!holding) {
    // Someone has the bomb: stay away from them.
    const h = s.p[st.holder];
    return flee([{ x: h.x + h.vx * 0.3, y: h.y + h.vy * 0.3, w: 1.5 }]);
  }

  // Hunting: the crown holder (or, with the bomb, the nearest rival to pass it to).
  let tgt = null;
  if (!bomb) tgt = s.p[st.holder];
  else {
    let bd = Infinity;
    for (const q of rivals) { const d = dist(p.x, p.y, q.x, q.y); if (d < bd && q.dodge <= 0) { bd = d; tgt = q; } }
  }
  if (!tgt) return steer(CX, CY);
  const d0 = dist(px, py, tgt.x, tgt.y);
  const tHit = Math.max(0, d0 - p.r - tgt.r) / DASH_SPEED;
  const lead = (lv === 0 ? 0.05 : delay) + tHit;
  const tx = tgt.x + tgt.vx * lead, ty = tgt.y + tgt.vy * lead;
  const dx = tx - px, dy = ty - py, d = Math.hypot(dx, dy) || 1;
  const range = [170, 250, 260][lv] + p.r + tgt.r;
  const passOk = !bomb || s.passLock <= 0;
  // Ram if the line is clear (a block in the way would eat the charge).
  if (p.cd <= 0 && d < range && passOk && tgt.dodge <= 0) {
    const w = botRoute(s, px, py, p.r * 0.5, tx, ty, -4);
    if (w.x === tx && w.y === ty) return { x: dx / d, y: dy / d, tapA: true };
  }
  // Chase (cut the corner toward where they are going).
  return steer(tx, ty);
}

const game = {
  id: 'mollala',
  name: 'Mollala, Maestà!',
  rule: "Tieni la corona 10 secondi! Sperona chi ce l'ha!",
  verb: 'RUBA!',
  inspired: 'Mario Kart · Shine Thief',
  cam: 'top',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Speronata', b: 'Schivata' },
  help: {
    goal: 'Indossa la corona del re per 10 secondi in totale (o tienila più a lungo di tutti allo scadere).',
    dir: 'Corri per la sala del trono. Con la corona in testa sei un po\' più lento (pesa, è d\'oro!).',
    a: 'SPERONATA: carica in avanti. Se travolgi chi porta la corona gliela fai volare via e gli rubi 1 secondo!',
    b: 'SCHIVATA: balzo rapido nella direzione della levetta; per un attimo sei intoccabile (si ricarica in 1.4 s).',
    tips: ["Chi ha la corona: schiva la speronata all'ultimo momento!", 'Negli ultimi 10 s la corona conta 1.5 volte', 'Bombarda: speronata = passala; in 3–4 chi salta in aria è fuori'],
  },
  duration: 40,
  noMods: ['moviola'], // 40 s in slow motion would last over a minute
  supports: ['scale'],
  variants: [
    { id: 'patata', name: 'Bombarda Bollente', desc: "Al posto della corona c'è una BOMBARDA! Chi ce l'ha quando esplode perde. Speronata = passala!" },
    { id: 'gelosa', name: 'Corona Gelosa', desc: 'Chi la porta ingrassa come un re a banchetto: bersaglio enorme, speronata devastante!' },
    { id: 'blackout', name: 'Coprifuoco', desc: 'Bracieri spenti, buio pesto: brillano solo la corona e gli occhi!' },
  ],

  init(g) {
    const n = g.n || 2;
    const sc = g.mods.scale || Array(n).fill(1);
    const bomb = g.variant === 'patata';
    return {
      n, nb: n > 2 ? 4 : 6,
      held: Array(n).fill(0), turbo: false, tickS: 0, tie: g.rng.int(0, n - 1),
      star: { x: CX, y: CY, vx: 0, vy: 0, r: STAR_R, holder: -1, lock: bomb ? 1 : 0 },
      // 3–4 players: a bomb blows up every ~10 s (one player out each time), so the fuses are shorter.
      fuse: bomb ? (n > 2 ? g.rng.range(9, 13) : g.rng.range(12, 20)) : 0, fuse0: 0,
      blinkPh: 0, bl: 0, passLock: 0, boom: -1, scorch: null,
      p: [...Array(n).keys()].map((i) => ({
        i, x: SPAWN[i][0], y: SPAWN[i][1], vx: 0, vy: 0,
        r: BALL_R * (sc[i] ?? 1), base: BALL_R * (sc[i] ?? 1), m0: (sc[i] ?? 1) ** 2,
        dash: 0, cd: 0.3, fx: SPAWN[i][2], fy: SPAWN[i][3], stun: 0, hitT: 0, hitDone: true, growS: 0, dodge: 0, dcd: 0.3, out: false,
      })),
    };
  },

  step(s, inp, g) {
    const dt = g.dt, st = s.star;
    const bomb = g.variant === 'patata', jealous = g.variant === 'gelosa';

    if (!bomb && !s.turbo && g.t >= TURBO_AT) {
      s.turbo = true;
      g.say('ULTIMI 10 SECONDI: CORONA DOPPIA!'); g.sfx('powerup'); g.shake(0.3);
    }

    // Players.
    for (const p of s.p) {
      const i = inp[p.i];
      p.cd = Math.max(0, p.cd - dt);
      p.hitT = Math.max(0, p.hitT - dt);
      p.stun = Math.max(0, p.stun - dt);
      p.dcd = Math.max(0, p.dcd - dt);
      if (p.out || s.boom === p.i) { p.vx *= damp(0.3, dt); p.vy *= damp(0.3, dt); p.x += p.vx * dt; p.y += p.vy * dt; collideArena(p, 0.6, s.nb); continue; }
      const holding = st.holder === p.i;
      const spdMul = bomb ? (holding ? 1.08 : 1) : (holding ? HOLD_SLOW : 1);
      const ctrl = p.stun <= 0;
      const ix = ctrl ? i.x : 0, iy = ctrl ? i.y : 0;
      if (Math.hypot(ix, iy) > 0.2) { const nn = norm(ix, iy); p.fx = nn.x; p.fy = nn.y; }
      if (p.dodge > 0) p.dodge -= dt;
      if (p.dash > 0) p.dash -= dt;
      else if (p.dodge > 0) { const k = damp(0.05, dt); p.vx *= k; p.vy *= k; }
      else {
        p.vx += ix * ACCEL * spdMul * dt; p.vy += iy * ACCEL * spdMul * dt;
        const k = damp(KEEP, dt);
        p.vx *= k; p.vy *= k;
        const max = MAX_SPEED * spdMul, sp = Math.hypot(p.vx, p.vy);
        if (sp > max) { p.vx *= max / sp; p.vy *= max / sp; }
      }
      if (ctrl && i.aP && p.cd <= 0 && !g.ended) {
        p.vx = p.fx * DASH_SPEED * spdMul; p.vy = p.fy * DASH_SPEED * spdMul;
        p.dash = DASH_TIME; p.cd = DASH_CD; p.hitDone = false;
        g.sfx('dash'); g.burst(p.x, p.y, { player: p.i, n: 8, speed: 180 });
      } else if (ctrl && i.bP && p.dcd <= 0 && p.dash <= 0 && !g.ended) {
        // Dodge hop: along the stick (or backwards if idle), briefly intangible.
        const nn = Math.hypot(ix, iy) > 0.2 ? norm(ix, iy) : { x: -p.fx, y: -p.fy };
        p.vx = nn.x * DODGE_SPEED; p.vy = nn.y * DODGE_SPEED;
        p.dodge = DODGE_TIME; p.dcd = DODGE_CD;
        g.sfx('jump', { pitch: 1.3, vol: 0.7 }); g.ring(p.x, p.y, { player: p.i, r: p.r + 30 });
      }
      p.x += p.vx * dt; p.y += p.vy * dt;
      // Jealous crown: the wearer grows every second, shrinks back once it's gone.
      if (jealous) {
        if (holding) {
          p.r = Math.min(p.base * 1.9, p.r + p.base * 0.11 * dt);
          p.growS += dt;
          if (p.growS >= 1) { p.growS -= 1; g.sfx('grow', { vol: 0.5, pitch: p.base / p.r + 0.4 }); }
        } else { p.r = Math.max(p.base, p.r - p.base * 0.5 * dt); p.growS = 0; }
      }
      collideArena(p, p.dash > 0 ? 0.7 : 0.35, s.nb);
    }

    // Player vs player (every pair): rams steal (or pass the bomb).
    if (s.boom < 0) {
      for (let x = 0; x < s.n; x++) {
        for (let y = x + 1; y < s.n; y++) {
          const a = s.p[x], b = s.p[y];
          if (!a.out && !b.out) game.bump(s, a, b, g, bomb, jealous);
        }
      }
    }

    // Crown (or bomb).
    if (st.holder < 0) {
      st.lock = Math.max(0, st.lock - dt);
      if (bomb && st.lock <= 0 && s.boom < 0) {
        // The bomb rolls toward the nearest player: nobody can hide.
        let near = null, nd = Infinity;
        for (const p of s.p) {
          if (p.out) continue;
          const d = dist(p.x, p.y, st.x, st.y);
          if (d < nd - 1 || (Math.abs(d - nd) <= 1 && p.i === s.tie)) { nd = d; near = p; }
        }
        if (near) {
          const nn = norm(near.x - st.x, near.y - st.y);
          st.vx += nn.x * 520 * dt; st.vy += nn.y * 520 * dt;
        }
      }
      const k = damp(bomb ? 0.5 : 0.3, dt);
      st.vx *= k; st.vy *= k;
      const sp = Math.hypot(st.vx, st.vy), cap = bomb && st.lock <= 0 ? 380 : 1200;
      if (sp > cap) { st.vx *= cap / sp; st.vy *= cap / sp; }
      st.x += st.vx * dt; st.y += st.vy * dt;
      if (collideArena(st, 0.85, s.nb) && sp > 160) g.sfx('bounce', { vol: 0.5, pitch: 1.4 });
      if (st.lock <= 0 && s.boom < 0 && !g.ended) {
        let best = null, bd = Infinity;
        for (const p of s.p) {
          if (p.dodge > 0 || p.out) continue;
          const dd = dist(p.x, p.y, st.x, st.y);
          if (dd < p.r + STAR_R && (dd < bd - 0.5 || (Math.abs(dd - bd) <= 0.5 && p.i === s.tie))) { bd = dd; best = p; }
        }
        if (best) game.pick(s, best, g);
      }
    } else {
      const h = s.p[st.holder];
      st.x = h.x; st.y = h.y; st.vx = h.vx; st.vy = h.vy;
    }

    if (g.ended) return;

    if (bomb) {
      s.passLock = Math.max(0, s.passLock - dt);
      // Secret fuse: only the blink speed hints at it.
      const prog = clamp((g.t - s.fuse0) / (s.fuse - s.fuse0), 0, 1);
      s.blinkPh += (1.5 + 12 * prog * prog * prog) * dt;
      if (s.blinkPh >= 1) { s.blinkPh -= 1; g.sfx('tick', { vol: 0.45, pitch: 1 + prog * 0.8 }); }
      s.bl = s.blinkPh < 0.5 ? 1 : 0;
      if (g.t >= s.fuse) game.explode(s, g);
      return;
    }

    // Crown counter.
    if (st.holder >= 0) {
      const h = st.holder;
      s.held[h] += dt * (s.turbo ? TURBO_RATE : 1);
      const whole = Math.floor(s.held[h]);
      if (whole > s.tickS) g.sfx(whole >= 7 ? 'matchpoint' : 'tick', { vol: 0.6, pitch: 1 + whole * 0.05 });
      s.tickS = whole;
      if (s.held[h] >= WIN_TIME) {
        s.held[h] = WIN_TIME;
        const p = s.p[h];
        g.sfx('fanfare'); g.confetti(p.x, p.y); g.slowmo(0.3, 0.7); g.shake(0.4);
        g.end(h, 'Lunga vita al re!');
      }
    }
  },

  // Two players touching: dodges, rams (steal / pass the bomb / squash) and the physical bounce.
  bump(s, a, b, g, bomb, jealous) {
    const st = s.star;
    if (dist(a.x, a.y, b.x, b.y) >= a.r + b.r + 3) return;
    if (a.dodge > 0 || b.dodge > 0) {
      for (const [att, vic] of [[a, b], [b, a]]) {
        if (att.dash > 0 && !att.hitDone && vic.dodge > 0) {
          att.hitDone = true;
          g.sfx('whoosh', { pitch: 1.6 }); g.text(vic.x, vic.y - vic.r - 30, 'SCHIVATA!', { player: vic.i });
        }
      }
      return;
    }
    for (const [att, vic] of [[a, b], [b, a]]) {
      if (att.dash <= 0 || att.hitDone) continue;
      att.hitDone = true;
      if (!bomb && st.holder === vic.i) game.knockStar(s, att, vic, g);
      else if (bomb && st.holder === att.i && s.passLock <= 0) game.passBomb(s, att, vic, g);
      else if (jealous && att.r > vic.r * 1.2) {
        vic.stun = 0.25 * (att.r / vic.r); vic.hitT = 0.5;
        g.sfx('squish'); g.text(vic.x, vic.y - vic.r - 30, 'SPIACCICATO!', { player: att.i });
        g.shake(0.5); g.vibrate(vic.i, 120);
      } else { vic.hitT = 0.3; }
    }
    const A = { ...a, m: mass(a) * (a.dash > 0 ? 3 : 1) }, B = { ...b, m: mass(b) * (b.dash > 0 ? 3 : 1) };
    const impact = collideCircles(A, B, 1.2);
    Object.assign(a, { x: A.x, y: A.y, vx: A.vx, vy: A.vy });
    Object.assign(b, { x: B.x, y: B.y, vx: B.vx, vy: B.vy });
    if (impact > 0) {
      const hard = impact > 600;
      g.sfx(hard ? 'punch' : 'bonk', { pitch: hard ? 1 : 1.3, vol: hard ? 1 : 0.6 });
      g.burst((a.x + b.x) / 2, (a.y + b.y) / 2, { color: '#fff', n: hard ? 14 : 5, speed: hard ? 380 : 160 });
      if (hard) { g.shake(0.35); g.hitstop(0.04); }
    }
  },

  pick(s, p, g) {
    const st = s.star;
    st.holder = p.i; st.vx = 0; st.vy = 0;
    s.tickS = Math.floor(s.held[p.i]);
    if (g.variant === 'patata') {
      g.sfx('fuse'); g.text(p.x, p.y - p.r - 30, 'AIUTO!', { player: p.i });
    } else {
      g.sfx('pickup'); g.sfx('coin', { pitch: 1.3, vol: 0.6 });
      g.text(p.x, p.y - p.r - 30, 'INCORONATO!', { player: p.i });
    }
    g.ring(p.x, p.y, { color: GOLD, r: 90 });
    g.burst(p.x, p.y, { color: GOLD, n: 14, speed: 260 });
    g.vibrate(p.i, 50);
  },

  knockStar(s, att, vic, g) {
    const st = s.star;
    // The crown flies off roughly along the ram direction.
    const spread = g.rng.range(-0.6, 0.6);
    const dx = att.fx - att.fy * spread, dy = att.fy + att.fx * spread;
    const nn = norm(dx, dy);
    st.holder = -1; st.lock = LOCK;
    st.x = vic.x + nn.x * (vic.r + 6); st.y = vic.y + nn.y * (vic.r + 6);
    st.vx = nn.x * 720; st.vy = nn.y * 720;
    collideArena(st, 0.85, s.nb);
    vic.stun = STEAL_STUN; vic.hitT = 0.6;
    // Comeback: the rammer pockets a second of the victim's time.
    const take = Math.min(STEAL_BONUS, s.held[vic.i]);
    s.held[vic.i] -= take; s.held[att.i] = Math.min(WIN_TIME - 0.5, s.held[att.i] + take);
    g.sfx('punch'); g.sfx('pop', { pitch: 1.2 });
    g.text(vic.x, vic.y - vic.r - 30, take > 0.05 ? 'DETRONIZZATO! -1' : 'DETRONIZZATO!', { player: att.i, size: 50 });
    if (take > 0.05) g.text(att.x, att.y - att.r - 30, '+1', { player: att.i, size: 46 });
    g.burst(vic.x, vic.y, { color: GOLD, n: 22, speed: 420, size: 8 });
    g.shake(0.55); g.hitstop(0.07);
    g.vibrate(vic.i, 140); g.vibrate(att.i, 40);
    if (s.held[vic.i] >= WIN_TIME * 0.7) g.slowmo(0.35, 0.5);
  },

  passBomb(s, att, vic, g) {
    s.star.holder = vic.i; s.passLock = 0.6;
    vic.stun = 0.25; vic.hitT = 0.5;
    g.sfx('swap'); g.sfx('bonk', { pitch: 0.8 });
    g.text(vic.x, vic.y - vic.r - 30, 'PASSATA!', { player: att.i, size: 50 });
    g.burst(vic.x, vic.y, { color: '#ff7a2f', n: 16, speed: 320 });
    g.shake(0.4); g.hitstop(0.05); g.vibrate(vic.i, 120);
  },

  explode(s, g) {
    const st = s.star;
    const alive = s.p.filter((q) => !q.out);
    let loser = st.holder;
    if (loser < 0) {
      // Nobody holds it: whoever is closest to it gets blown up.
      let bd = Infinity;
      for (const q of alive) { const d = dist(q.x, q.y, st.x, st.y); if (d < bd) { bd = d; loser = q.i; } }
    }
    const p = s.p[loser];
    // Blast every standing player away from the bomb.
    for (const q of alive) {
      const nn = norm(q.x - p.x || 0.01, q.y - p.y);
      const pow = q === p ? 300 : 900;
      q.vx = nn.x * pow; q.vy = nn.y * pow; q.stun = 1;
    }
    g.sfx('bigexplode');
    g.burst(p.x, p.y, { color: '#ff8a00', n: 50, speed: 650, size: 14 });
    g.burst(p.x, p.y, { color: '#333', n: 25, speed: 300, size: 18 });
    g.ring(p.x, p.y, { color: '#ffcf4a', r: 260 });
    g.flash('#ffae42', 0.8); g.shake(1); g.vibrate(loser, 400);
    if (alive.length <= 2) {
      // Last two: game over, the other one wins.
      s.boom = loser; st.holder = -1; st.x = p.x; st.y = p.y; st.vx = 0; st.vy = 0;
      p.r *= 1.15;
      g.sfx('lose', { vol: 0.6 }); g.slowmo(0.3, 0.8);
      const w = alive.find((q) => q !== p);
      g.end(w ? w.i : -1, 'BOOM! Bruciacchiato!');
      return;
    }
    // 3–4 players: the blown-up one is out (a sooty ghost), a new bomb appears on the throne carpet.
    p.out = true;
    s.scorch = { x: r1(p.x), y: r1(p.y), t: g.t };
    st.holder = -1; st.x = CX; st.y = CY; st.vx = 0; st.vy = 0; st.lock = 1.5;
    s.fuse0 = g.t; s.fuse = g.t + g.rng.range(7, 10); s.blinkPh = 0; s.passLock = 0;
    g.say('FUORI! NUOVA BOMBARDA!'); g.sfx('horn', { vol: 0.6 }); g.slowmo(0.4, 0.5);
  },

  timeout(s) {
    const st = s.star;
    const alive = s.p.filter((q) => !q.out);
    const dS = (q) => dist(q.x, q.y, st.x, st.y);
    if (s.fuse) {
      // Bomb: whoever holds it (or stands closest to it) loses → the standing player farthest from it wins.
      let best = null, bd = -1;
      for (const q of alive) { if (q.i === st.holder) continue; const d = dS(q); if (d >= bd) { bd = d; best = q; } }
      return best ? best.i : alive[0].i;
    }
    const top = Math.max(...s.held);
    const cands = s.p.filter((q) => Math.abs(s.held[q.i] - top) <= 1e-6);
    if (cands.length === 1) return cands[0].i;
    if (st.holder >= 0 && cands.some((q) => q.i === st.holder)) return st.holder;
    let best = cands[0], bd = Infinity;
    for (const q of cands) { const d = dS(q); if (d < bd) { bd = d; best = q; } }
    return best.i;
  },

  bot: mollalaBot,

  view(s) {
    const st = s.star, bomb = s.fuse > 0;
    const v = {
      st: { x: r1(st.x), y: r1(st.y), vx: Math.round(st.vx), vy: Math.round(st.vy), h: st.holder, l: st.lock > 0 ? 1 : 0, bl: s.bl },
      bomb: bomb ? 1 : 0, tb: s.turbo ? 1 : 0, bo: s.boom, nb: s.nb,
      p: s.p.map((p) => {
        const o = { x: r1(p.x), y: r1(p.y), r: r1(p.r), fx: r2(p.fx), fy: r2(p.fy), d: p.dash > 0 ? 1 : 0, cd: r2(p.cd), s: r2(p.stun), h: r2(p.hitT), dg: r2(p.dodge), dc: r2(p.dcd), vx: Math.round(p.vx), vy: Math.round(p.vy) };
        if (p.out) o.o = 1;
        return o;
      }),
    };
    if (s.scorch) v.sc = [s.scorch.x, s.scorch.y];
    if (!bomb) v.hud = { p: s.held.map((h) => Math.floor(h)), max: null, label: 'Corona', bar: s.held.map((h) => r2(h / WIN_TIME)) };
    return v;
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  render3d: {
    assets: [
      'dungeon/wall', 'dungeon/wall_window_open', 'dungeon/wall_arched', 'dungeon/pillar_decorated', 'dungeon/column',
      'dungeon/banner_patternA_red', 'dungeon/banner_patternA_blue', 'dungeon/banner_patternA_green', 'dungeon/banner_patternA_yellow',
      'dungeon/banner_shield_red', 'dungeon/torch_mounted', 'dungeon/chair', 'dungeon/table_long_decorated_A', 'dungeon/table_long_tablecloth_decorated_A',
      'dungeon/keg_decorated', 'dungeon/barrel_large', 'dungeon/barrel_small_stack', 'dungeon/candle_triple', 'dungeon/stool',
      'dungeon/coin_stack_large', 'dungeon/trunk_large_A', 'dungeon/sword_shield_gold', 'dungeon/shelf_small_candles',
    ],
    build(K, r) {
      const n = Math.max(2, K.n || 2);
      const dark = r.variant === 'blackout', bomb = r.variant === 'patata';
      const nb = n > 2 ? 4 : 6;
      const lo = K.quality === 0;
      const o = { dark, bomb, nb };
      // --- atmosphere: the king's throne room at night, lit by braziers ---
      K.theme(dark ? 'notte' : 'grotta', { fogNear: 2.4, fogFar: 6 });
      if (K.hemi) {
        if (dark) { K.hemi.intensity = 0.07; K.sun.intensity = 0.1; K.rim.intensity = 0; }
        else { K.hemi.intensity = 1.05; K.sun.intensity = 1.5; K.sun.color.set('#ffd9a8'); }
      }
      K.ground('lastre', { tile: 130, color: dark ? '#5d5650' : '#a39888', margin: 1600 });
      // Checkered marble floor of the hall + royal carpets (painted once).
      K.layer({ x0: -40, y0: -240, x1: W + 40, y1: H + 40, h: 0.6, once: true, transparent: true, maxPx: K.quality > 0 ? 2048 : 1024, draw: (d) => drawHall3d(d, nb, dark) });
      // Pulsing rings from the center (no repaint: three glowing tori).
      o.rings = [0, 1, 2].map(() => {
        const m = K.glow(GOLD, { opacity: 0.2, add: true, unique: true });
        return { m, mesh: K.torus(1, 0.012, m, { cast: false }) };
      });
      // --- low stone balustrade around the arena, oak rail on top, gold posts at the corners ---
      const wallH = K.texMat('muro', [W / 90, 0.6], { color: '#d8cbb8' }), wallV = K.texMat('muro', [0.6, W / 90], { color: '#d8cbb8' });
      for (const [x, y, w, h, m] of [[CX, WALL / 2, W, WALL, wallH], [CX, H - WALL / 2, W, WALL, wallH], [WALL / 2, CY, WALL, H, wallV], [W - WALL / 2, CY, WALL, H, wallV]]) {
        K.place(K.box(w, h, 40, m), x, y, 20);
      }
      const rail = K.mat('#6b3f22', { rough: 0.6 });
      for (const [x, y, w, h] of [[CX, WALL / 2, W + 8, WALL + 10], [CX, H - WALL / 2, W + 8, WALL + 10], [WALL / 2, CY, WALL + 10, H + 8], [W - WALL / 2, CY, WALL + 10, H + 8]]) {
        K.place(K.box(w, h, 7, rail), x, y, 40);
      }
      const goldM = K.mat('#e2b04a', { rough: 0.3, metal: 0.7, emissive: '#5a3a00', ei: 0.4 });
      for (const [x, y] of [[WALL / 2, WALL / 2], [W - WALL / 2, WALL / 2], [WALL / 2, H - WALL / 2], [W - WALL / 2, H - WALL / 2]]) {
        K.place(K.cyl(22, 58, K.texMat('muro', [1, 1], { color: '#cdbfa8' })), x, y, 0);
        K.place(K.ball(16, goldM), x, y, 70);
      }
      // --- obstacles: braziers on stone plinths (+ banquet tables with 2 players) ---
      const plinthM = K.texMat('muro', [1.2, 0.8], { color: '#c9bba5' });
      const ironM = K.mat('#3a3330', { rough: 0.5, metal: 0.6 });
      o.fires = [];
      for (let k = 0; k < 4; k++) {
        const b = BLOCKS[k], x = b.x + b.w / 2, y = b.y + b.h / 2;
        K.place(K.box(b.w, b.h, 56, plinthM), x, y, 28);
        K.place(K.box(b.w + 10, b.h + 10, 8, plinthM), x, y, 60);
        K.place(K.box(b.w + 10, b.h + 10, 8, plinthM), x, y, 4);
        K.place(K.cyl(12, 14, ironM), x, y, 64);
        K.place(K.cyl(38, 22, ironM, { r2: 16 }), x, y, 76);
        const coal = K.cyl(33, 4, K.glow(dark ? '#5a1a08' : '#ff6a1a'), { cast: false });
        K.place(coal, x, y, 96);
        const fl = dark ? null : [0, 1, 2].map((q) => {
          const c = K.cone(q ? 14 : 22, q ? 34 : 52, K.glow(q ? '#ffd46b' : '#ff7a1f', { opacity: 0.85, add: true }), { cast: false });
          K.place(c, x + (q === 1 ? -12 : q === 2 ? 12 : 0), y + (q ? 6 : 0), 98);
          return c;
        });
        o.fires.push({ x, y, fl });
        if (!dark && (!lo || k < 2)) K.light(x, y, 150, '#ff9a42', 1.6, { flicker: 0.5, dist: 520 });
      }
      // Gold plaque edge around the plinths (readable obstacle outline).
      o.blockGlow = K.glow('#ffcf6b', { opacity: 0.5, unique: true });
      for (let k = 0; k < nb; k++) {
        const b = BLOCKS[k];
        K.place(K.box(b.w + 14, b.h + 14, 3, o.blockGlow, { cast: false }), b.x + b.w / 2, b.y + b.h / 2, 1.5);
      }
      if (nb > 4) {
        for (let k = 4; k < 6; k++) {
          const b = BLOCKS[k];
          const t = K.model('dungeon/table_long_tablecloth_decorated_A', { size: 134 });
          K.place(t, b.x + b.w / 2, b.y + b.h / 2, 0);
          t.rotation.y = Math.PI / 2;
        }
      }
      // --- the hall around the arena ---
      // Back wall with windows, royal banners of the four kingdoms, mounted torches.
      const wallItems = [], winItems = [];
      for (let k = 0; k < 11; k++) {
        const x = -750 + k * 250;
        (k % 3 === 1 ? winItems : wallItems).push({ x, y: -350 });
      }
      K.scatter('dungeon/wall', wallItems, { size: 250 });
      K.scatter('dungeon/wall_window_open', winItems, { size: 250 });
      // Side walls, far out.
      const sideW = [];
      for (let k = 0; k < 7; k++) { sideW.push({ x: -680, y: -220 + k * 250, rot: Math.PI / 2 }); sideW.push({ x: W + 680, y: -220 + k * 250, rot: Math.PI / 2 }); }
      K.scatter('dungeon/wall', sideW, { size: 250 });
      // Colonnade on both sides of the hall.
      const cols = [];
      for (let k = 0; k < 5; k++) { cols.push({ x: -250, y: -230 + k * 300 }); cols.push({ x: W + 250, y: -230 + k * 300 }); }
      K.scatter('dungeon/pillar_decorated', cols, { size: 92 });
      const banners = ['red', 'blue', 'green', 'yellow'];
      banners.forEach((c, k) => {
        const items = [{ x: [CX - 330, CX + 330, CX - 470, CX + 470][k], y: -335, h: 40 }, { x: [-470, W + 470, -120, W + 120][k], y: -335, h: 40 }];
        K.scatter(`dungeon/banner_patternA_${c}`, items, { height: 210 });
      });
      // The throne dais at the top.
      const daisM = K.texMat('lastre', [3, 1], { color: '#b9ab98' });
      K.place(K.box(420, 150, 24, daisM), CX, -150, 12);
      K.place(K.box(340, 110, 24, daisM), CX, -170, 36);
      K.place(K.box(110, 150, 2, K.mat('#9e1b2a', { rough: 0.9 })), CX, -150, 49);
      const throne = K.model('dungeon/chair', { height: 170 });
      K.place(throne, CX, -185, 48);
      K.place(K.ball(14, goldM), CX - 34, -200, 210);
      K.place(K.ball(14, goldM), CX + 34, -200, 210);
      const shield = K.model('dungeon/banner_shield_red', { height: 260 });
      K.place(shield, CX, -322, 80);
      K.scatter('dungeon/coin_stack_large', [{ x: CX - 150, y: -150, h: 48 }, { x: CX + 150, y: -155, h: 48, rot: 1 }], { size: 46 });
      K.scatter('dungeon/trunk_large_A', [{ x: CX - 250, y: -200, rot: 0.3 }, { x: CX + 255, y: -200, rot: -0.3 }], { size: 70 });
      K.scatter('dungeon/candle_triple', [{ x: CX - 100, y: -115, h: 48 }, { x: CX + 100, y: -115, h: 48 }, { x: CX - 180, y: -90, h: 24 }, { x: CX + 180, y: -90, h: 24 }], { height: 44 });
      K.scatter('dungeon/torch_mounted', [{ x: -300, y: -330, h: 140 }, { x: 300 + W, y: -330, h: 140 }, { x: CX - 250, y: -330, h: 150 }, { x: CX + 250, y: -330, h: 150 }], { height: 70 });
      if (!dark) {
        K.light(CX - 250, -300, 170, '#ffb35c', 1.4, { flicker: 0.6, dist: 600 });
        if (!lo) K.light(CX + 250, -300, 170, '#ffb35c', 1.4, { flicker: 0.6, dist: 600 });
      }
      // Banquet tables along the sides (feast in progress), kegs and barrels.
      const tables = [];
      for (let k = 0; k < 4; k++) { tables.push({ x: -420, y: -60 + k * 330, rot: 0 }); tables.push({ x: W + 420, y: -60 + k * 330, rot: 0 }); }
      K.scatter('dungeon/table_long_decorated_A', tables, { size: 230 });
      const stools = [];
      for (const t of tables) for (const dy of [-70, 0, 70]) { stools.push({ x: t.x - 80, y: t.y + dy, rot: 0.2 }); stools.push({ x: t.x + 80, y: t.y + dy, rot: -0.2 }); }
      K.scatter('dungeon/stool', stools, { size: 34 });
      K.scatter('dungeon/keg_decorated', [{ x: -150, y: -280, rot: 0.1 }, { x: W + 150, y: -280, rot: -0.1 }], { size: 130 });
      K.scatter('dungeon/barrel_large', [{ x: -110, y: 1090 }, { x: -40, y: 1120, s: 0.8 }, { x: W + 110, y: 1090 }, { x: W + 40, y: 1120, s: 0.8 }, { x: -560, y: 980 }, { x: W + 560, y: 980 }], { size: 64 });
      K.scatter('dungeon/barrel_small_stack', [{ x: -560, y: 1100 }, { x: W + 560, y: 1100, rot: 1.4 }], { size: 90 });
      K.scatter('dungeon/sword_shield_gold', [{ x: -590, y: 120, h: 120, rot: Math.PI / 2 }, { x: W + 590, y: 120, h: 120, rot: -Math.PI / 2 }, { x: -590, y: 640, h: 120, rot: Math.PI / 2 }, { x: W + 590, y: 640, h: 120, rot: -Math.PI / 2 }], { size: 120 });
      K.ambient(dark ? 'lucciole' : 'polvere', { n: dark ? 30 : 70, h: dark ? 120 : 260 });
      if (!dark) K.ambient('braci', { n: 26, h: 260, x0: 200, x1: 800, y0: 200, y1: 800 });
      // --- the crown: gold band + spikes with gems, spinning, with a halo and twinkles ---
      o.starG = K.group();
      o.spin = K.group(o.starG);
      o.starM = K.mat(GOLD, { rough: 0.22, metal: 0.65, emissive: '#b07a10', ei: 0.45, unique: true });
      K.cyl(17, 13, o.starM, { parent: o.spin, seg: 20 });
      K.place(K.cyl(18.5, 3, K.mat('#fff0b0', { rough: 0.2, metal: 0.5, emissive: '#806010', ei: 0.4 }), { parent: o.spin, seg: 20 }), 0, 0, 1);
      const gemR = K.mat('#e0213b', { rough: 0.15, emissive: '#7a0010', ei: 0.6 }), gemB = K.mat('#2f7dff', { rough: 0.15, emissive: '#0a2a7a', ei: 0.6 });
      for (let q = 0; q < 5; q++) {
        const a = (q * TAU) / 5;
        K.place(K.cone(5.5, 17, o.starM, { parent: o.spin, seg: 8 }), Math.cos(a) * 14, Math.sin(a) * 14, 12);
        K.place(K.ball(3.6, q % 2 ? gemB : gemR, { parent: o.spin, cast: false }), Math.cos(a) * 14, Math.sin(a) * 14, 30);
        K.place(K.ball(3.2, q % 2 ? gemR : gemB, { parent: o.spin, cast: false }), Math.cos(a + 0.63) * 17.5, Math.sin(a + 0.63) * 17.5, 6.5);
      }
      o.haloM = K.glow('#ffe680', { opacity: 0.16, add: true, unique: true });
      o.halo = K.ball(1, o.haloM, { cast: false });
      o.twinkles = [0, 1, 2].map(() => K.ball(4, K.glow('#fffbe0', { add: true }), { cast: false }));
      o.trail = [1, 2, 3, 4].map(() => K.ball(1, K.glow('#ffec8c', { opacity: 0.6, add: true }), { cast: false }));
      o.starSpot = K.disc(1, K.glow('#ffd84a', { opacity: 0.3, add: true }));
      // The bomb (bombarda): black iron ball, fuse and spark.
      o.bombG = K.group();
      o.bombM = K.mat('#1c1c22', { rough: 0.35, metal: 0.3, unique: true });
      const bb = K.ball(30, o.bombM, { parent: o.bombG }); bb.position.y = 30;
      const cap = K.cyl(9, 10, K.mat('#8a7a5a', { rough: 0.5, metal: 0.5 }), { parent: o.bombG }); cap.position.y = 57;
      const fuse = K.cyl(2.5, 18, K.mat('#c9a36b'), { parent: o.bombG }); fuse.position.set(4, 65, 0); fuse.rotation.z = -0.4;
      o.spark = K.ball(1, K.glow('#ffcf4a', { add: true }), { parent: o.bombG, cast: false }); o.spark.position.set(11, 83, 0);
      // Wearer halo on the ground + explosion scorch (final and intermediate).
      o.holdRing = K.torus(1, 0.06, K.glow(GOLD, { add: true, opacity: 0.9 }), { cast: false });
      o.scorch = K.disc(1, K.glow('#ff8c00', { opacity: 0.35, add: true }));
      o.soot = K.disc(1, K.glow('#000000', { opacity: 0.45 }));
      // Players.
      o.pl = [...Array(n).keys()].map((i) => ({
        av: K.avatar(i),
        stars: [0, 1, 2].map(() => K.emoji('⭐', 22)),
        dec: K.decal(260),
        eyes: dark ? [0, 1].map(() => K.ball(1, K.glow('#ffffff'), { cast: false })) : null,
      }));
      // Blackout: a warm light follows the crown.
      if (dark) {
        o.lamp = K.light(CX, CY, 120, '#ffd27a', 2.4, { dist: 520 });
        o.pool = K.disc(1, K.glow('#ffd27a', { opacity: 0.1, add: true }));
      }
      return o;
    },
    update(K, o, v) {
      const st = v.st, bomb = !!v.bomb;
      const ringCol = bomb ? '#ff7828' : v.tb ? '#ff78dc' : GOLD;
      o.rings.forEach((R, k) => {
        const ph = (K.t * 0.5 + k / 3) % 1;
        K.place(R.mesh, CX, CY, 1.5);
        R.mesh.scale.setScalar(60 + ph * 260);
        R.m.color.set(ringCol); R.m.opacity = 0.35 * (1 - ph);
      });
      o.blockGlow.opacity = 0.35 + 0.2 * Math.sin(K.t * 3);
      // Brazier flames dancing.
      for (const f of o.fires) {
        if (!f.fl) continue;
        f.fl.forEach((c, q) => {
          const s = 1 + 0.18 * Math.sin(K.t * (11 + q * 3) + f.x * 0.01 + q) + 0.08 * Math.sin(K.t * 23 + q);
          c.scale.set(1 / Math.sqrt(s), s, 1 / Math.sqrt(s));
        });
      }
      // Where the crown is: on the floor, or on its wearer's head.
      const holder = st.h >= 0 ? v.p[st.h] : null;
      const free = !holder && v.bo < 0;
      const blinkOff = free && st.l && !bomb && Math.floor(K.t * 20) % 2;
      let sx = st.x, sy = st.y, sh = 40 + Math.sin(K.t * 4) * 6;
      if (holder) {
        const hop = holder.dg > 0 ? Math.sin((1 - holder.dg / DODGE_TIME) * Math.PI) : 0;
        sx = holder.x; sy = holder.y; sh = holder.r * 2.55 + hop * 60 + Math.sin(K.t * 5) * 2;
      }
      const showStar = !bomb && v.bo < 0 && !blinkOff;
      o.starG.visible = o.halo.visible = showStar;
      for (const tw of o.twinkles) tw.visible = showStar;
      if (showStar) {
        if (v.tb) { o.starM.color.setHSL((K.t * 1) % 1, 1, 0.6); o.starM.emissive.copy(o.starM.color).multiplyScalar(0.5); }
        else { o.starM.color.set(GOLD); o.starM.emissive.set('#b07a10'); }
        K.place(o.starG, sx, sy, sh);
        o.spin.rotation.y = K.t * (holder ? 1.2 : 2.2);
        o.spin.rotation.z = holder ? 0 : Math.sin(K.t * 2) * 0.25;
        o.starG.scale.setScalar(holder ? clamp(holder.r / BALL_R, 0.8, 1.9) * 1.05 : 1.55);
        K.place(o.halo, sx, sy, sh + 12);
        o.halo.scale.setScalar(STAR_R * (holder ? 2.0 : 2.2) * (1 + Math.sin(K.t * 8) * 0.08));
        o.haloM.color.set(v.tb ? '#ff9ae6' : '#ffe680');
        o.twinkles.forEach((tw, k) => {
          const a = -K.t * 4 + (k * TAU) / 3;
          K.place(tw, sx + Math.cos(a) * STAR_R * 1.8, sy + Math.sin(a) * STAR_R * 1.8, sh + 14 + Math.sin(K.t * 9 + k) * 10);
          tw.scale.setScalar(0.8 + 0.4 * Math.sin(K.t * 9 + k));
        });
      }
      // Sparkle trail of a flying crown.
      const sp = Math.hypot(st.vx, st.vy);
      o.trail.forEach((b, nn) => {
        b.visible = showStar && free && sp > 40;
        if (!b.visible) return;
        const j = Math.sin(K.t * 13 + nn * 2.3) * 9;
        K.place(b, st.x - st.vx * 0.035 * (nn + 1) + j, st.y - st.vy * 0.035 * (nn + 1) - j, sh + 10);
        b.scale.setScalar(9 - nn * 1.6);
      });
      o.starSpot.visible = showStar && free;
      if (o.starSpot.visible) { K.place(o.starSpot, sx, sy, 1.2); o.starSpot.scale.setScalar(34 + Math.sin(K.t * 6) * 4); }
      // Bomb.
      o.bombG.visible = bomb && v.bo < 0;
      if (o.bombG.visible) {
        K.place(o.bombG, sx, sy, holder ? holder.r * 2.75 : 0);
        o.bombG.scale.setScalar(holder ? 0.85 : 1);
        o.bombM.color.set(st.bl > 0.5 ? '#dd2222' : '#1c1c22');
        o.bombM.emissive.set(st.bl > 0.5 ? '#ff2a2a' : '#000000');
        o.spark.scale.setScalar(6 + 3 * Math.sin(K.t * 40));
      }
      // Gold ring at the wearer's feet.
      o.holdRing.visible = !!holder && !bomb;
      if (o.holdRing.visible) { K.place(o.holdRing, holder.x, holder.y, 3); o.holdRing.scale.setScalar((holder.r + 18) * (1 + Math.sin(K.t * 8) * 0.06)); }
      o.scorch.visible = v.bo >= 0;
      if (v.bo >= 0) { const p = v.p[v.bo]; K.place(o.scorch, p.x, p.y, 1.5); o.scorch.scale.setScalar(120 + Math.sin(K.t * 30) * 6); }
      o.soot.visible = !!v.sc;
      if (v.sc) { K.place(o.soot, v.sc[0], v.sc[1], 1.1); o.soot.scale.setScalar(95); }
      if (o.lamp) {
        K.place(o.lamp, sx, sy, Math.max(90, sh + 30));
        K.place(o.pool, sx, sy, 0.9); o.pool.scale.setScalar(190 * (1 + Math.sin(K.t * 11) * 0.03));
      }
      // Players.
      v.p.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const holding = st.h === i, dead = v.bo === i, out = !!p.o;
        const hop = p.dg > 0 ? Math.sin((1 - p.dg / DODGE_TIME) * Math.PI) : 0;
        const mood = dead || out ? 'dead' : p.s > 0 ? 'dizzy' : p.h > 0 ? 'hurt' : holding ? (bomb ? 'scared' : 'happy') : 'ok';
        const spd = Math.hypot(p.vx, p.vy);
        const look = Math.atan2(p.fy, p.fx);
        const anim = dead || out ? undefined : p.d ? 'Dodge_Forward' : p.s > 0 && p.h <= 0 ? 'Hit_B' : undefined;
        P.av.set(p.x, p.y, { r: p.r, h: hop * 60, look, mood, anim, squash: p.d ? 0.12 : 0, alpha: out ? 0.3 : p.dg > 0 ? 0.55 : 1, lean: clamp(spd / 2500, 0, 0.3), walk: out ? 0 : clamp(spd / 400, 0, 1), marker: !out });
        P.stars.forEach((s, k) => {
          s.visible = p.s > 0 && !dead && !out;
          if (!s.visible) return;
          const a = K.t * 6 + (k * TAU) / 3;
          K.place(s, p.x + Math.cos(a) * p.r * 0.8, p.y + Math.sin(a) * p.r * 0.8, p.r * 3 + hop * 60);
        });
        if (P.eyes) {
          const fx = p.fx || 0, fy = p.fy || 1;
          const blink = Math.sin(K.t * 1.7 + i * 2) > 0.97;
          P.eyes.forEach((e, k) => {
            const sg = k ? 1 : -1;
            e.visible = !out;
            K.place(e, p.x + fx * p.r * 0.45 - fy * p.r * 0.2 * sg, p.y + fy * p.r * 0.45 + fx * p.r * 0.2 * sg, p.r * 2.1 + hop * 60);
            e.scale.set(p.r * 0.1, blink ? p.r * 0.02 : p.r * 0.14, p.r * 0.1);
          });
        }
        P.dec.show(!dead && !out).at(p.x, p.y, 1).paint((d) => {
          const ax = p.fx * (p.r + 20), ay = p.fy * (p.r + 20);
          d.poly([ax + p.fx * 18, ay + p.fy * 18, ax - p.fy * 13, ay + p.fx * 13, ax + p.fy * 13, ay - p.fx * 13], d.col(i, 'light') + (p.cd <= 0 ? 'ee' : '55'), 'rgba(0,0,0,0.35)', 2);
          if (p.cd <= 0) d.ring(0, 0, p.r + 9, d.col(i, 'light') + 'cc', 6);
          else d.arc(0, 0, p.r + 9, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / DASH_CD), d.col(i, 'light') + '88', 6);
          if (p.dc > 0) d.arc(0, 0, p.r + 17, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.dc / DODGE_CD), 'rgba(255,255,255,0.4)', 4);
          else d.arc(0, 0, p.r + 17, Math.PI * 0.15, Math.PI * 0.85, 'rgba(255,255,255,0.75)', 4);
        });
      });
    },
  },

  render(d, v, r) {
    const { ctx } = d;
    const st = v.st, bomb = !!v.bomb, dark = r.variant === 'blackout';
    // Floor & arena.
    drawArena(d, bomb, v.tb, false, v.nb || 6);

    // Free crown / bomb on the ground.
    if (st.h < 0 && v.bo < 0) {
      d.shadow(st.x, st.y + 18, 26, 9, 0.35);
      if (!(st.l && !bomb && Math.floor(d.t * 20) % 2)) {
        if (bomb) drawBomb(d, st.x, st.y, 1, st.bl > 0.5);
        else { drawTrail(d, st, 1); drawStar(d, st.x, st.y, STAR_R + 4 + Math.sin(d.t * 6) * 3, v.tb); }
      }
    }
    if (v.sc) d.circle(v.sc[0], v.sc[1], 90, 'rgba(0,0,0,0.3)');

    // Players.
    v.p.forEach((p, i) => {
      const holding = st.h === i, dead = v.bo === i, out = !!p.o;
      const hop = p.dg > 0 ? Math.sin((1 - p.dg / DODGE_TIME) * Math.PI) : 0;
      d.shadow(p.x + 6 + hop * 14, p.y + 10 + hop * 22, p.r * (1 - hop * 0.25), p.r * 0.8 * (1 - hop * 0.25), 0.3 - hop * 0.15);
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 380 && !dead && !out) {
        const nx = p.vx / sp, ny = p.vy / sp;
        for (let k = 1; k <= 3; k++) d.circle(p.x - nx * 24 * k, p.y - ny * 24 * k, p.r * (1 - k * 0.15), d.col(i, 'light') + (p.dg > 0 ? '22' : '38'));
      }
      if (holding && !bomb) {
        const pulse = 1 + Math.sin(d.t * 8) * 0.06;
        d.circle(p.x, p.y, (p.r + 22) * pulse, 'rgba(255,216,74,0.18)');
        d.ring(p.x, p.y, (p.r + 16) * pulse, GOLD, 3);
      }
      const mood = dead || out ? 'dead' : p.s > 0 ? 'dizzy' : p.h > 0 ? 'hurt' : holding ? (bomb ? 'scared' : 'happy') : p.d ? 'angry' : bomb ? 'ok' : 'angry';
      d.avatar(p.x, p.y - hop * 26, p.r * (1 + hop * 0.12), i, { look: Math.atan2(p.fy, p.fx), mood, squash: p.d ? 0.15 : hop ? -0.15 : 0, alpha: out ? 0.3 : p.dg > 0 ? 0.55 : 1 });
      if (!dead && !out) {
        // Facing arrow + recharge rings (outer = ram, inner = dodge).
        const ax = p.x + p.fx * (p.r + 18), ay = p.y + p.fy * (p.r + 18);
        d.poly([ax + p.fx * 14, ay + p.fy * 14, ax - p.fy * 10, ay + p.fx * 10, ax + p.fy * 10, ay - p.fx * 10], d.col(i, 'light') + (p.cd <= 0 ? 'ee' : '55'));
        if (p.cd <= 0) d.ring(p.x, p.y, p.r + 7, d.col(i, 'light') + 'aa', 4);
        else d.arc(p.x, p.y, p.r + 7, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / DASH_CD), d.col(i, 'light') + '66', 4);
        if (p.dc > 0) d.arc(p.x, p.y, p.r + 13, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.dc / DODGE_CD), 'rgba(255,255,255,0.35)', 3);
        else d.arc(p.x, p.y, p.r + 13, Math.PI * 0.15, Math.PI * 0.85, 'rgba(255,255,255,0.6)', 3);
      }
      if (p.s > 0 && !dead && !out) {
        for (let k = 0; k < 3; k++) {
          const a = d.t * 6 + (k * TAU) / 3;
          d.star(p.x + Math.cos(a) * p.r * 0.8, p.y - p.r * 0.6 + Math.sin(a) * p.r * 0.3, 8, '#fff6a8');
        }
      }
      // The carried crown/bomb orbits its holder (readable from any camera angle).
      if (holding) {
        const a = d.t * 3.2, R = p.r + 14;
        const sx = p.x + Math.cos(a) * R, sy = p.y + Math.sin(a) * R;
        if (bomb) drawBomb(d, sx, sy, 0.75, st.bl > 0.5);
        else { drawTrail(d, { x: sx, y: sy, vx: st.vx, vy: st.vy }, 0.7); drawStar(d, sx, sy, STAR_R * 0.85, v.tb); }
      }
    });

    // Explosion scorch.
    if (v.bo >= 0) {
      const p = v.p[v.bo];
      d.circle(p.x, p.y, 120 + Math.sin(d.t * 30) * 6, 'rgba(255,140,0,0.25)');
      d.circle(p.x, p.y, 70, 'rgba(255,230,120,0.25)');
    }

    if (dark) {
      // Dark mask with a soft light around the crown, then glowing eyes on top.
      let lx = st.x, ly = st.y;
      if (st.h >= 0) { lx = v.p[st.h].x; ly = v.p[st.h].y; }
      const flick = 1 + Math.sin(d.t * 11) * 0.03;
      mask(ctx, lx, ly, 150 * flick, 'rgba(2,1,8,0.6)');
      mask(ctx, lx, ly, 215 * flick, 'rgba(2,1,8,0.93)');
      if (st.h < 0 && !(st.l && Math.floor(d.t * 20) % 2)) drawStar(d, st.x, st.y, STAR_R + 4, v.tb);
      v.p.forEach((p, i) => {
        if (p.o) return;
        const fx = p.fx || 0, fy = p.fy || 1, px = -fy, py = fx;
        const blink = Math.sin(d.t * 1.7 + i * 2) > 0.97;
        for (const sgn of [-1, 1]) {
          const ex = p.x + fx * p.r * 0.35 + px * p.r * 0.32 * sgn, ey = p.y + fy * p.r * 0.35 + py * p.r * 0.32 * sgn;
          if (blink) { d.line(ex - px * 8, ey - py * 8, ex + px * 8, ey + py * 8, '#fff', 3); continue; }
          d.circle(ex, ey, p.r * 0.2, '#fff', d.col(i, 'light'), 3);
          d.circle(ex + fx * p.r * 0.07, ey + fy * p.r * 0.07, p.r * 0.1, p.s > 0 ? d.col(i) : '#111');
        }
      });
    }
  },
};
export default game;

// Fill everything except a circular hole.
function mask(ctx, x, y, rad, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.rect(-400, -400, W + 800, H + 800);
  ctx.moveTo(x + rad, y);
  ctx.arc(x, y, rad, 0, TAU, true);
  ctx.fill('evenodd');
}

// 2D crown (fallback renderer): gold band with three spikes and gems.
function drawStar(d, x, y, r, turbo) {
  const { ctx } = d;
  const col = turbo ? `hsl(${(d.t * 360) % 360},100%,65%)` : GOLD;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.sin(d.t * 2) * 0.2);
  d.glow(col, 16, () => d.poly([-r, r * 0.55, -r, -r * 0.3, -r * 0.5, r * 0.05, 0, -r * 0.75, r * 0.5, r * 0.05, r, -r * 0.3, r, r * 0.55], col, '#7a5200', 3));
  d.circle(0, r * 0.2, r * 0.18, '#e0213b');
  d.circle(-r * 0.55, r * 0.25, r * 0.12, '#2f7dff');
  d.circle(r * 0.55, r * 0.25, r * 0.12, '#2f7dff');
  ctx.restore();
  // Twinkles orbiting the crown.
  for (let k = 0; k < 3; k++) {
    const a = -d.t * 4 + (k * TAU) / 3, s = 4 + 2 * Math.sin(d.t * 9 + k);
    d.star(x + Math.cos(a) * r * 1.5, y + Math.sin(a) * r * 1.5, s, '#fffbe0', 4);
  }
}

// Sparkle trail behind the moving crown.
function drawTrail(d, st, k) {
  const sp = Math.hypot(st.vx, st.vy);
  if (sp < 40) return;
  for (let n = 1; n <= 5; n++) {
    const j = Math.sin(d.t * 13 + n * 2.3) * 9;
    const x = st.x - st.vx * 0.035 * n + j, y = st.y - st.vy * 0.035 * n - j;
    d.star(x, y, (9 - n * 1.3) * k, `rgba(255,236,140,${(0.9 - n * 0.15).toFixed(2)})`, 4);
  }
}

function drawBomb(d, x, y, k, lit) {
  const R = 30 * k;
  d.circle(x, y, R, lit ? '#d22' : '#1c1c22', '#000', 3);
  d.circle(x - R * 0.35, y - R * 0.35, R * 0.25, 'rgba(255,255,255,0.35)');
  d.rect(x + R * 0.35, y - R * 1.05, R * 0.4, R * 0.35, '#666');
  d.line(x + R * 0.55, y - R * 1.05, x + R * 0.9, y - R * 1.5, '#c9a36b', 4 * k);
  const f = 5 + 3 * Math.sin(d.t * 40);
  d.circle(x + R * 0.9, y - R * 1.5, f * k, '#ffcf4a');
  d.circle(x + R * 0.9, y - R * 1.5, f * k * 0.5, '#fff');
  if (lit) d.ring(x, y, R + 8, 'rgba(255,60,60,0.7)', 4);
}

function drawArena(d, bomb, turbo, is3d = false, nb = 6) {
  const { ctx } = d;
  const bg = ctx.createRadialGradient(CX, CY, 100, CX, CY, 800);
  bg.addColorStop(0, '#3a2a1c'); bg.addColorStop(1, '#120a06');
  ctx.fillStyle = bg;
  ctx.fillRect(-300, -300, W + 600, H + 600);
  const fl = ctx.createLinearGradient(0, WALL, 0, H - WALL);
  fl.addColorStop(0, '#5a4636'); fl.addColorStop(0.5, '#4a382a'); fl.addColorStop(1, '#5a4636');
  d.rrect(WALL, WALL, W - WALL * 2, H - WALL * 2, 34, fl);
  d.grid(100, 'rgba(255,255,255,0.05)');
  // Pulsing rings from the centre (the crown spot).
  const col = bomb ? '255,120,40' : turbo ? '255,120,220' : '255,216,74';
  for (let k = 0; k < 3; k++) {
    const ph = (d.t * 0.5 + k / 3) % 1;
    d.ring(CX, CY, 60 + ph * 260, `rgba(${col},${(0.22 * (1 - ph)).toFixed(2)})`, 4);
  }
  d.circle(CX, CY, 150, 'rgba(158,27,42,0.35)', 'rgba(226,176,74,0.5)', 4);
  d.rrect(WALL, WALL, W - WALL * 2, H - WALL * 2, 34, null, '#c9a24a', 6);
  for (let k = 0; k < nb; k++) {
    const b = BLOCKS[k];
    d.rrect(b.x + 8, b.y + 14, b.w, b.h, 16, 'rgba(0,0,0,0.45)');
    d.rrect(b.x, b.y + 8, b.w, b.h, 16, '#4a3a2a');
    d.rrect(b.x, b.y, b.w, b.h, 16, '#8a7a66', '#e2b04a', 4);
    if (k < 4) { d.circle(b.x + b.w / 2, b.y + b.h / 2, 30, '#3a3330'); d.circle(b.x + b.w / 2, b.y + b.h / 2, 22 + Math.sin(d.t * 9 + k) * 3, '#ff7a1f'); }
  }
}

// 3D floor painting: checkered marble hall, round royal carpet at the center and a runner toward the throne.
function drawHall3d(d, nb, dark) {
  const { ctx } = d;
  const S = 100;
  for (let y = WALL; y < H - WALL; y += S) {
    for (let x = WALL; x < W - WALL; x += S) {
      const k = (Math.floor((x - WALL) / S) + Math.floor((y - WALL) / S)) % 2;
      d.rect(x, y, Math.min(S, W - WALL - x), Math.min(S, H - WALL - y), dark ? (k ? '#5a5246' : '#2e2820') : k ? '#cdbfa6' : '#8b7b66');
    }
  }
  d.grid(S / 2, 'rgba(0,0,0,0.05)');
  // Runner from the bottom gate to the throne (beyond the top wall).
  d.rect(CX - 55, -240, 110, H + 240, '#8e1b28');
  d.rect(CX - 55, -240, 8, H + 240, '#e2b04a');
  d.rect(CX + 47, -240, 8, H + 240, '#e2b04a');
  // Round carpet with a crown emblem.
  d.circle(CX, CY, 175, '#e2b04a');
  d.circle(CX, CY, 166, '#8e1b28');
  d.ring(CX, CY, 140, '#e2b04a', 4);
  for (let k = 0; k < 16; k++) {
    const a = (k * TAU) / 16;
    d.circle(CX + Math.cos(a) * 153, CY + Math.sin(a) * 153, 5, '#f3d27a');
  }
  d.poly([CX - 60, CY + 30, CX - 60, CY - 20, CX - 30, CY + 5, CX, CY - 40, CX + 30, CY + 5, CX + 60, CY - 20, CX + 60, CY + 30], 'rgba(243,210,122,0.55)');
  // Dark rim right inside the balustrade.
  d.rect(WALL, WALL, W - 2 * WALL, 10, 'rgba(0,0,0,0.25)');
  for (let k = 0; k < nb; k++) {
    const b = BLOCKS[k];
    d.rect(b.x - 10, b.y - 10, b.w + 20, b.h + 20, 'rgba(0,0,0,0.25)');
  }
}
