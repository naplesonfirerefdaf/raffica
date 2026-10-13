// Budini a Corte — wobbly jelly wrestling on a ring at the top of the castle tower (top-down, dir + A grab + B headbutt).
// 2..4 players: who falls twice is out (stays as a ghost spectator), the last one on the tower wins.
import { clamp, damp, dist, collideCircles, norm, approach, lerpAngle, wrapAngle, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500;
const RING0 = 330, RING_MIN = 190, APRON = 36;
const BODY_R = 46, HAND_R = 15;
const LIVES = 2;
const HB_SPEED = 780, HB_TIME = 0.16, HB_CD = 0.75, HB_STUN = 0.36, STUN_TIME = 2;
const REACH = 115, GRAB_MAX = 2.4, SPIN_FULL = TAU * 0.9, SLAM_STUN = 0.45;
const THROW = 840, THROW_DIZZY = 1180;
const ROPE_BREAK = 560, ROPE_BREAK_LATE = 380, LATE_AT = 20, SD_MIN = 165;
const TRUCK_SPEED = 1500, TRUCK_LEN = 300, LANE = 150, TRUCK_WARN = 1.6, TRUCK_EVERY = 7;
// Home side of each seat: 0 bottom, 1 top, 2 left, 3 right (unit direction from the centre).
const HOME = [[0, 1], [0, -1], [-1, 0], [1, 0]];
const GHOST_D = RING0 + APRON + 110; // eliminated players watch from just outside the ring

// Side index for ropes: 0 right (+x), 1 left (-x), 2 bottom (+y), 3 top (-y).
const sideOf = (axis, sgn) => (axis === 0 ? (sgn > 0 ? 0 : 1) : (sgn > 0 ? 2 : 3));

function phys(variant) {
  return variant === 'sapone'
    ? { accel: 850, keep: 0.6, max: 430, flyKeep: 0.5 }
    : { accel: 2700, keep: 0.015, max: 345, flyKeep: 0.3 };
}

function makeHand() { return { x: 0, y: 0, vx: 0, vy: 0 }; }

function spawn(s) {
  s.p.forEach((p, i) => {
    const [hx, hy] = HOME[i];
    const off = Math.min(150, s.ring * 0.5);
    p.fall = 0; p.truck = false;
    if (p.out) { p.x = CX + hx * GHOST_D; p.y = CY + hy * GHOST_D; }
    else { p.x = CX + hx * off; p.y = CY + hy * off; }
    p.vx = 0; p.vy = 0;
    p.fx = -hx; p.fy = -hy;
    p.grab = -1; p.held = false; p.by = -1; p.grabT = 0; p.ext = 0; p.spin = 0;
    p.hb = 0; p.hbHit = false; p.cd = 0.4;
    p.stun = 0; p.dizzy = 0; p.fly = 0; p.hurt = 0;
    p.w = 0; p.wv = 0;
    p.h.forEach((h, k) => { h.x = p.x + (k ? 1 : -1) * p.r; h.y = p.y; h.vx = 0; h.vy = 0; });
  });
  s.pause = 0.9;
}

// Drop whoever p is carrying.
function release(s, p) {
  if (p.grab >= 0) { const v = s.p[p.grab]; v.held = false; v.by = -1; p.grab = -1; }
  p.ext = 0; p.spin = 0;
}

// p lets go of its victim and is let go by its grabber.
function freeFromAll(s, p) {
  release(s, p);
  if (p.held) {
    const o = s.p[p.by];
    if (o && o.grab === p.i) { o.grab = -1; o.ext = 0; o.spin = 0; }
    p.held = false; p.by = -1;
  }
}

function addStun(s, p, amt, g) {
  if (p.dizzy > 0) return;
  p.stun += amt;
  if (p.stun >= 1) {
    p.stun = 0; p.dizzy = STUN_TIME;
    release(s, p);
    g.sfx('wobble'); g.sfx('zap', { pitch: 1.4, vol: 0.6 });
    g.text(p.x, p.y - p.r - 30, 'STORDITO!', { player: p.i, size: 44 });
    g.burst(p.x, p.y, { color: '#ffe14d', n: 14, speed: 220, size: 7 });
    g.vibrate(p.i, 150);
  }
}

const active = (p) => !p.out && !(p.fall > 0);

export default {
  id: 'budini',
  name: 'Budini a Corte',
  rule: 'Afferra gli altri budini e lanciali giù dalla torre!',
  verb: 'LOTTA!',
  inspired: 'Gang Beasts · Party Animals',
  cam: 'top',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Afferra', b: 'Testata' },
  help: {
    goal: "Butta gli altri budini giù dalla torre: chi cade 2 volte è fuori, vince l'ultimo rimasto (le corde reggono solo i lanci forti).",
    dir: 'Muoviti. Mentre porti qualcuno, ruota la levetta in tondo per caricare il lancio.',
    a: 'TIENI PREMUTO per allungare le braccia e afferrare; RILASCIA per lanciare dove punti. Più giri fai prima, più vola!',
    b: "TESTATA: scatto con la testa che stordisce. Se ti hanno afferrato ti libera; se porti qualcuno lo SBATTI sul palco (tanto stordimento).",
    tips: ['3 testate = STORDITO: un budino stordito vola molto più lontano', 'Una presa dura al massimo 2,4 s', 'Dopo 20 s le corde cedono più facilmente'],
  },
  duration: 45,
  supports: ['scale'],
  variants: [
    { id: 'camion', name: "L'Ariete", desc: 'Ogni 7 secondi un ariete sfonda il ring!' },
    { id: 'sapone', name: 'Palco di Lardo', desc: 'Il palco è unto di lardo: si scivola ovunque!' },
    { id: 'gomma', name: 'Braccia di Troll', desc: 'Le braccia si allungano tre volte tanto!' },
    { id: 'stringe', name: 'Recinto che si Stringe', desc: 'Le corde si avvicinano sempre di più!' },
  ],

  init(g) {
    const N = g.n || 2;
    const sc = g.mods.scale || new Array(N).fill(1);
    const s = {
      ring: RING0, falls: new Array(N).fill(0), pause: 0, respawnAt: 0, late: false, broken: false,
      rope: [0, 0, 0, 0], ropeV: [0, 0, 0, 0], ropeU: [0, 0, 0, 0],
      truck: { st: 0, at: 4, o: 0, c: CY, x: 0, dir: 1, warn: 0, n: 0 },
      p: Array.from({ length: N }, (_, i) => {
        const k = sc[i] ?? 1;
        return {
          i, r: BODY_R * k, m: k * k, reach: REACH * (g.variant === 'gomma' ? 3 : 1) * Math.sqrt(k), out: false,
          x: 0, y: 0, vx: 0, vy: 0, fx: 0, fy: 0, h: [makeHand(), makeHand()],
        };
      }),
    };
    spawn(s);
    s.pause = 0; // the countdown already gave time: move right away
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    const P = phys(g.variant);
    // Ring size: 'stringe' shrinks from the start; sudden death shrinks it for everyone.
    let nr = s.ring;
    if (g.variant === 'stringe') nr = Math.min(nr, clamp(RING0 - (g.t - 4) * 5.5, RING_MIN, RING0));
    if (s.late) nr = Math.max(SD_MIN, Math.min(nr, nr - 22 * dt));
    if (Math.floor(nr / 30) !== Math.floor(s.ring / 30) && nr < s.ring) { g.sfx('shrink', { vol: 0.6 }); g.shake(0.15); }
    s.ring = nr;
    if (!s.late && g.t >= LATE_AT) { s.late = true; g.say('MORTE IMPROVVISA!'); g.sfx('matchpoint'); }
    if (s.late && !s.broken && s.ring <= SD_MIN + 0.5) { s.broken = true; g.say('CORDE SPEZZATE!'); g.sfx('break'); g.shake(0.5); g.flash('#ff3d3d'); }
    const R = s.ring;

    // Rope visuals: damped springs.
    for (let k = 0; k < 4; k++) {
      s.ropeV[k] += (-320 * s.rope[k] - 9 * s.ropeV[k]) * dt;
      s.rope[k] += s.ropeV[k] * dt;
    }

    // Wobble springs & hands always animate (even during pauses).
    for (const p of s.p) {
      p.wv += (-200 * p.w - 8 * p.wv) * dt;
      p.w = clamp(p.w + p.wv * dt, -0.4, 0.4);
    }
    updateHands(s, g, dt);

    if (s.respawnAt && g.t >= s.respawnAt && !g.ended) { s.respawnAt = 0; spawn(s); g.sfx('boing'); g.say('IN GUARDIA!'); }

    // Falling animation.
    for (const p of s.p) {
      if (p.fall > 0) {
        p.fall = Math.min(9, p.fall + dt);
        p.vx *= damp(0.3, dt); p.vy *= damp(0.3, dt);
        p.x += p.vx * dt * 0.5; p.y += p.vy * dt * 0.5;
      }
    }

    if (g.variant === 'camion') stepTruck(s, g, dt, R);

    if (s.pause > 0) { s.pause -= dt; return; }

    // Players: input, movement, actions.
    for (const p of s.p) {
      if (!active(p)) continue;
      const i = inp[p.i];
      p.cd = Math.max(0, p.cd - dt);
      p.hurt = Math.max(0, p.hurt - dt);
      if (p.dizzy > 0) p.dizzy = Math.max(0, p.dizzy - dt);
      else p.stun = Math.max(0, p.stun - dt * 0.06);
      if (p.fly > 0) p.fly = Math.max(0, p.fly - dt);
      const canAct = p.dizzy <= 0 && !p.held && p.fly <= 0;
      const mag = Math.hypot(i.x, i.y);

      // Facing: instant when free, swings slowly while carrying someone.
      if (canAct && mag > 0.2) {
        const target = Math.atan2(i.y, i.x);
        const cur = Math.atan2(p.fy, p.fx);
        const a = p.grab >= 0 ? lerpAngle(cur, target, 1 - damp(0.004, dt)) : target;
        if (p.grab >= 0) {
          const prev = p.spin;
          p.spin = Math.min(SPIN_FULL, p.spin + Math.abs(wrapAngle(a - cur)));
          if (p.spin >= SPIN_FULL && prev < SPIN_FULL) { g.sfx('powerup', { pitch: 1.4, vol: 0.5 }); g.ring(p.x, p.y, { player: p.i, r: p.r + 80 }); }
        }
        p.fx = Math.cos(a); p.fy = Math.sin(a);
      }

      // Counter: headbutt your grabber to break free.
      const gr = p.held ? s.p[p.by] : null;
      if (gr && i.bP && p.cd <= 0 && p.dizzy <= 0 && gr.grab === p.i) {
        const n = norm(gr.x - p.x, gr.y - p.y);
        p.fx = n.x; p.fy = n.y; p.cd = HB_CD;
        release(s, gr);
        gr.vx += n.x * 420; gr.vy += n.y * 420; gr.fly = 0.2; gr.hurt = 0.5; gr.wv -= 6;
        p.vx -= n.x * 200; p.vy -= n.y * 200;
        addStun(s, gr, HB_STUN + 0.1, g);
        g.sfx('bonk'); g.hitstop(0.05); g.shake(0.3);
        g.burst((p.x + gr.x) / 2, (p.y + gr.y) / 2, { color: '#fff', n: 12, speed: 260 });
        g.text(gr.x, gr.y - gr.r - 24, 'LIBERO!', { player: p.i });
      }

      if (p.hb > 0) {
        p.hb -= dt;
      } else if (p.fly > 0 || p.dizzy > 0 || p.held) {
        const k = damp(p.dizzy > 0 && p.fly <= 0 ? 0.05 : P.flyKeep, dt);
        p.vx *= k; p.vy *= k;
      } else {
        const acc = P.accel * (p.grab >= 0 ? 0.65 : 1) / Math.sqrt(p.m);
        p.vx += i.x * acc * dt; p.vy += i.y * acc * dt;
        const k = damp(P.keep, dt);
        p.vx *= k; p.vy *= k;
        const max = P.max * (p.grab >= 0 ? 0.75 : 1);
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > max) { p.vx *= max / sp; p.vy *= max / sp; }
      }

      // Slam: B while carrying smashes the victim on the mat (no throw, lots of stun).
      if (p.grab >= 0 && i.bP && p.cd <= 0) {
        const o = s.p[p.grab];
        release(s, p);
        o.vx = p.fx * 120; o.vy = p.fy * 120; o.hurt = 0.7; o.wv += 12; o.fly = 0.15;
        p.cd = HB_CD;
        addStun(s, o, SLAM_STUN, g);
        g.sfx('crash', { vol: 0.7 }); g.sfx('squish'); g.hitstop(0.08); g.shake(0.5);
        g.burst(o.x, o.y, { color: '#fff', n: 16, speed: 300 });
        g.text(o.x, o.y - o.r - 24, 'SBAM!', { player: p.i, size: 50 });
        g.vibrate(o.i, 120);
      }

      // Headbutt.
      if (canAct && i.bP && p.cd <= 0 && p.grab < 0 && p.hb <= 0) {
        p.vx = p.fx * HB_SPEED; p.vy = p.fy * HB_SPEED;
        p.hb = HB_TIME; p.cd = HB_CD; p.hbHit = false; p.wv += 5;
        g.sfx('dash', { pitch: 1.2 });
      }

      // Arms: hold A to stretch them forward.
      if (p.grab < 0) p.ext = canAct && i.a ? approach(p.ext, 1, dt * 5) : approach(p.ext, 0, dt * 7);

      // Release A while carrying: THROW in the movement direction.
      if (p.grab >= 0 && !i.a) {
        const o = s.p[p.grab];
        const dir = mag > 0.3 ? norm(i.x, i.y) : { x: p.fx, y: p.fy };
        const charge = p.spin / SPIN_FULL;
        const sp = (o.dizzy > 0 ? THROW_DIZZY : THROW) * clamp(Math.sqrt(p.m / o.m), 0.7, 1.4) * (0.85 + 0.45 * charge);
        release(s, p);
        if (charge > 0.95) { g.text(p.x, p.y - p.r - 50, 'SUPER LANCIO!', { player: p.i, size: 44 }); g.shake(0.4); }
        o.vx = dir.x * sp + p.vx * 0.3; o.vy = dir.y * sp + p.vy * 0.3;
        o.fly = 0.75; o.wv += 8; o.hurt = 0.6;
        p.vx -= dir.x * 120; p.vy -= dir.y * 120;
        g.sfx('whoosh'); g.sfx('boing', { pitch: 0.8, vol: 0.6 });
        g.shake(0.25); g.vibrate(o.i, 90);
        g.text(o.x, o.y - o.r - 20, 'VOLA!', { player: p.i });
      }

      p.x += p.vx * dt; p.y += p.vy * dt;
    }

    // Grabbing: a stretched hand touching someone catches them (conflicts: the longer reach wins).
    const grabs = [];
    for (const p of s.p) {
      if (!active(p) || p.grab >= 0 || p.ext < 0.35 || p.held || p.dizzy > 0 || p.fly > 0) continue;
      let best = null, bd = 1e9;
      for (const o of s.p) {
        if (o === p || !active(o) || o.held) continue;
        for (const h of p.h) {
          const d = dist(h.x, h.y, o.x, o.y);
          if (d < o.r + HAND_R + 4 && d < bd) { bd = d; best = o; }
        }
      }
      if (best) grabs.push({ p, o: best, k: p.ext });
    }
    if (grabs.length > 1) {
      for (const c of grabs) c.k += g.rng() * 0.02;
      grabs.sort((A, B) => B.k - A.k);
    }
    for (const { p, o } of grabs) {
      if (p.held || p.grab >= 0 || o.held) continue; // already taken this step
      if (o.grab >= 0) release(s, o);
      p.grab = o.i; p.grabT = 0; o.held = true; o.by = p.i; o.hb = 0; o.ext = 0;
      g.sfx('squish'); g.sfx('pickup', { pitch: 0.8, vol: 0.5 });
      g.burst(o.x, o.y, { player: p.i, n: 8, speed: 150 });
      g.vibrate(o.i, 60);
    }

    // Carry constraint: the victim dangles in front of the grabber (spring).
    for (const p of s.p) {
      if (p.grab < 0) continue;
      const o = s.p[p.grab];
      p.grabT += dt;
      if (p.grabT > GRAB_MAX && o.dizzy <= 0) {
        release(s, p);
        const n = norm(o.x - p.x, o.y - p.y);
        o.vx += n.x * 260; o.vy += n.y * 260;
        g.sfx('slide'); g.text(o.x, o.y - o.r - 20, 'SCIVOLA VIA!', { player: o.i });
        continue;
      }
      const hold = p.r + o.r + 10;
      const tx = p.x + p.fx * hold, ty = p.y + p.fy * hold;
      const ax = ((tx - o.x) * 190 - (o.vx - p.vx) * 20) * dt;
      const ay = ((ty - o.y) * 190 - (o.vy - p.vy) * 20) * dt;
      o.vx += ax; o.vy += ay;
      const rk = 0.2 * (o.m / p.m);
      p.vx -= ax * rk; p.vy -= ay * rk;
    }

    // Headbutt hits (resolved simultaneously so nobody is favoured).
    const hits = [];
    for (const p of s.p) {
      if (!active(p) || !(p.hb > 0) || p.hbHit) continue;
      let best = null, bd = 1e9;
      for (const o of s.p) {
        if (o === p || !active(o)) continue;
        const d = dist(p.x, p.y, o.x, o.y);
        if (d < p.r + o.r + 10 && d < bd) { bd = d; best = o; }
      }
      if (best) hits.push([p, best]);
    }
    for (const [p, o] of hits) {
      p.hbHit = true; p.hb = 0;
      const n = norm(o.x - p.x, o.y - p.y);
      const wasDizzy = o.dizzy > 0;
      const kb = (wasDizzy ? 760 : 440) * clamp(Math.sqrt(p.m / o.m), 0.7, 1.4);
      if (o.held) freeFromAll(s, o);
      if (o.grab >= 0) release(s, o);
      o.vx = n.x * kb; o.vy = n.y * kb; o.fly = wasDizzy ? 0.6 : 0.22; o.hurt = 0.5; o.wv -= 7;
      p.vx = -n.x * 120; p.vy = -n.y * 120; p.wv += 4;
      addStun(s, o, HB_STUN, g);
      g.sfx(wasDizzy ? 'punch' : 'bonk'); g.hitstop(0.06); g.shake(wasDizzy ? 0.45 : 0.3);
      g.burst((p.x + o.x) / 2, (p.y + o.y) / 2, { color: '#fff', n: wasDizzy ? 18 : 10, speed: 320 });
      g.vibrate(o.i, 70);
    }

    // Body vs body (jelly bounce), except a carrier and its own victim.
    for (let ia = 0; ia < s.p.length; ia++) for (let ib = ia + 1; ib < s.p.length; ib++) {
      const a = s.p[ia], b = s.p[ib];
      if (!active(a) || !active(b) || a.grab === b.i || b.grab === a.i) continue;
      const imp = collideCircles(a, b, 0.55);
      if (imp > 220) {
        a.wv -= imp / 160; b.wv -= imp / 160;
        g.sfx('boing', { pitch: 1.3, vol: 0.5 });
      }
    }

    // Ropes: soft bounce, but a strong throw (or the ram) sends you over.
    const brk = s.late ? ROPE_BREAK_LATE : ROPE_BREAK;
    const fallen = [];
    for (const p of s.p) {
      if (!active(p)) continue;
      const lim = R - p.r * 0.25;
      for (let ax = 0; ax < 2; ax++) {
        const d = ax === 0 ? p.x - CX : p.y - CY;
        if (Math.abs(d) <= lim) continue;
        const sg = d > 0 ? 1 : -1;
        const v = ax === 0 ? p.vx : p.vy;
        const vn = v * sg;
        const side = sideOf(ax, sg);
        const along = ax === 0 ? p.y - CY : p.x - CX;
        s.ropeU[side] = clamp(along / R, -0.85, 0.85);
        if (s.broken) {
          // No ropes left: walk past the edge of the mat and you drop.
          if (Math.abs(d) > R + 12) { fallen.push(p); break; }
          continue;
        }
        if (p.truck || (p.fly > 0 && vn > brk) || Math.abs(d) > R + APRON) {
          s.ropeV[side] += 140;
          fallen.push(p);
          break;
        }
        if (ax === 0) p.x = CX + sg * lim; else p.y = CY + sg * lim;
        if (vn > 0) {
          const nv = -v * 0.8;
          if (ax === 0) p.vx = nv; else p.vy = nv;
          s.ropeV[side] += Math.min(vn, 900) * 0.35;
          p.wv -= vn / 150;
          if (vn > 140) g.sfx('boing', { pitch: 0.9, vol: Math.min(1, vn / 600) });
        }
      }
    }
    if (fallen.length && !g.ended) handleFalls(s, fallen, g);
  },

  // Best of the players still in: fewest falls, then the one closer to the centre.
  timeout(s) {
    const alive = s.p.filter((p) => !p.out);
    const pool = alive.length ? alive : s.p;
    let best = pool[0];
    for (const p of pool) {
      const f = s.falls[p.i], fb = s.falls[best.i];
      if (f < fb || (f === fb && dist(p.x, p.y, CX, CY) < dist(best.x, best.y, CX, CY))) best = p;
    }
    return best.i;
  },

  view(s) {
    const t = s.truck;
    return {
      R: r1(s.ring), late: s.late ? 1 : 0, br: s.broken ? 1 : 0,
      rope: s.rope.map(r1), ru: s.ropeU.map(r2),
      tk: t.st ? { st: t.st, o: t.o, c: r1(t.c), x: r1(t.x), dir: t.dir, w: r2(t.warn) } : null,
      p: s.p.map((p) => {
        const sp = Math.hypot(p.vx, p.vy);
        return {
          x: r1(p.x), y: r1(p.y), r: r1(p.r), fx: r2(p.fx), fy: r2(p.fy),
          h: [r1(p.h[0].x), r1(p.h[0].y), r1(p.h[1].x), r1(p.h[1].y)],
          w: r2(p.w), st: r2(Math.min(sp / 1000, 0.3)), sa: r2(Math.atan2(p.vy, p.vx)),
          sz: r2(p.stun), dz: r2(p.dizzy), f: r2(p.fall), g: p.grab >= 0 ? p.grab + 1 : 0, hd: p.held ? 1 : 0,
          hb: p.hb > 0 ? 1 : 0, fl: p.fly > 0 ? 1 : 0, hu: p.hurt > 0 ? 1 : 0, e: r2(p.ext), sp: r2(p.spin / SPIN_FULL), cd: r2(p.cd),
          o: p.out && !(p.fall > 0) ? 1 : 0,
        };
      }),
      hud: {
        p: s.p.map((p) => LIVES - s.falls[p.i]), max: LIVES, label: 'Vite',
        bar: s.p.map((p) => r2(p.out ? 0 : p.dizzy > 0 ? 1 : clamp(p.stun, 0, 1))),
      },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  // 3D: the ring is a wooden stage on top of the castle keep at sunset. Far below: the moat, the castle walls,
  // the village with fields and woods, a river; around: the other towers of the castle with waving flags,
  // clouds drifting under the stage, braziers on the ring posts.
  render3d: {
    assets: [
      'medieval/wall_straight', 'medieval/wall_straight_gate', 'medieval/building_tower_A_red', 'medieval/building_tower_A_blue',
      'medieval/building_tower_B_red', 'medieval/building_tower_B_blue', 'medieval/building_castle_red', 'medieval/building_tower_catapult_yellow',
      'medieval/building_home_A_red', 'medieval/building_home_A_yellow', 'medieval/building_home_B_blue', 'medieval/building_home_B_green',
      'medieval/building_tavern_red', 'medieval/building_church_blue', 'medieval/building_windmill_yellow', 'medieval/building_market_green',
      'medieval/building_grain', 'medieval/building_well_red', 'medieval/building_watermill_green',
      'medieval/trees_A_large', 'medieval/trees_B_medium', 'medieval/tree_single_A', 'medieval/tree_single_B',
      'medieval/mountain_B_grass_trees', 'medieval/mountain_A_grass', 'medieval/hills_A_trees',
      'medieval/cloud_big', 'medieval/cloud_small', 'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow',
      'dungeon/banner_patternA_red', 'dungeon/banner_patternB_blue', 'medieval/barrel', 'medieval/crate_A_big',
    ],
    build(K) {
      const lo = K.quality === 0;
      K.theme('tramonto', { fogNear: 1.3, fogFar: 5 });
      const PH = 40, NSEG = 6, LEVELS = [30, 60], FL = -1500;
      const o = { PH, NSEG, LEVELS, clouds: [], flags: [], fires: [] };
      const rnd = (k) => { const x = Math.sin(k * 91.7 + 11.3) * 43758.5453; return x - Math.floor(x); };
      // --- The kingdom far below: meadows, moat, river ---
      K.ground('prato', { h: FL, margin: 3400, tile: 260 });
      if (K.tex('acqua')) { // (K.water needs a canvas: skipped in headless tests)
        K.water(CX - 600, CY - 600, CX + 600, CY + 600, { h: FL + 3, tile: 220, flow: [0.01, 0.006] });
        K.water(-3000, 1700, W + 3000, 2000, { h: FL + 3, tile: 260, flow: [0.04, 0.004] });
      }
      // --- The keep under the stage: stone tower, corbel band, lit arrow slits, hanging banners ---
      const stone = K.texMat('muro', [3, 13], { color: '#c9b9a4' });
      K.place(K.box(300, 300, 1500, stone), CX, CY, -750);
      K.place(K.box(344, 344, 34, K.texMat('muro', [4, 1], { color: '#a8988a' })), CX, CY, -17);
      K.place(K.box(324, 324, 26, K.mat('#6a5a50', { rough: 0.9 })), CX, CY, -47);
      const slit = K.glow('#ffcf6b');
      for (let k = 0; k < 4; k++) K.place(K.box(14, 6, 46, slit, { cast: false }), CX - 105 + k * 70, CY + 151, -170 - (k % 2) * 160);
      K.place(K.model('dungeon/banner_patternA_red', { height: 260 }), CX - 75, CY + 120, -360);
      K.place(K.model('dungeon/banner_patternB_blue', { height: 260 }), CX + 75, CY + 120, -360);
      // --- Castle walls around the moat, with towers on the corners ---
      const WH = 230, WL = (2 / 1.1) * WH, HS = 660;
      const walls = [];
      for (const [sx, sy, rot] of [[0, 1, 0], [0, -1, 0], [-1, 0, Math.PI / 2], [1, 0, Math.PI / 2]]) {
        for (let k = -1; k <= 1; k++) {
          if (sy === 1 && k === 0) continue; // the gate goes here
          walls.push({ x: CX + sx * HS + (sy ? k * WL : 0), y: CY + sy * HS + (sx ? k * WL : 0), h: FL, rot });
        }
      }
      K.scatter('medieval/wall_straight', walls, { height: WH });
      K.place(K.model('medieval/wall_straight_gate', { height: WH }), CX, CY + HS, FL);
      const CT = [[-1, -1, 'medieval/building_tower_A_red'], [1, -1, 'medieval/building_tower_A_blue'], [-1, 1, 'medieval/building_tower_A_blue'], [1, 1, 'medieval/building_tower_A_red']];
      for (const [sx, sy, m] of CT) K.place(K.model(m, { height: 470 }), CX + sx * HS, CY + sy * HS, FL);
      // --- The other towers of the castle, rising almost as high as us (far side only) ---
      const BIG = [
        ['medieval/building_castle_red', CX + 60, CY - 1500, 1450, -0.2, 'medieval/flag_red'],
        ['medieval/building_tower_B_blue', CX - 1250, CY - 650, 1250, 0.4, 'medieval/flag_blue'],
        ['medieval/building_tower_B_red', CX + 1300, CY - 600, 1200, -0.5, 'medieval/flag_yellow'],
        ['medieval/building_tower_catapult_yellow', CX - 1500, CY + 350, 800, 1.2, null],
        ['medieval/building_tower_A_red', CX + 1550, CY + 300, 900, 2.2, 'medieval/flag_green'],
      ];
      for (const [m, x, y, h, rot, flag] of BIG) {
        const t = K.model(m, { height: h });
        K.place(K.face(t, rot), x, y, FL);
        if (flag) {
          const f = K.model(flag, { height: 130 });
          K.place(f, x, y, FL + h - 8);
          o.flags.push({ f, ph: x * 0.01 });
        }
      }
      // --- The village and the countryside ---
      const HOUSES = ['medieval/building_home_A_red', 'medieval/building_home_A_yellow', 'medieval/building_home_B_blue', 'medieval/building_home_B_green'];
      const hs = [[], [], [], []];
      for (let k = 0; k < (lo ? 24 : 46); k++) {
        const a = rnd(k) * Math.PI * 2, rr = 900 + rnd(k + 50) * 1300;
        const x = CX + Math.cos(a) * rr * 1.25, y = CY + Math.sin(a) * rr;
        if (y > 1550 && y < 2150) continue; // river
        hs[k % 4].push({ x, y, h: FL, rot: rnd(k + 7) * 6.3, s: 0.85 + rnd(k + 9) * 0.3 });
      }
      HOUSES.forEach((m, k) => K.scatter(m, hs[k], { height: 150 }));
      K.place(K.face(K.model('medieval/building_tavern_red', { height: 230 }), 0.5), CX - 1000, CY + 900, FL);
      K.place(K.face(K.model('medieval/building_church_blue', { height: 330 }), -0.3), CX + 1150, CY - 1000, FL);
      K.place(K.face(K.model('medieval/building_windmill_yellow', { height: 300 }), 0.8), CX - 1500, CY - 600, FL);
      K.place(K.face(K.model('medieval/building_market_green', { height: 140 }), 0), CX + 950, CY + 950, FL);
      K.place(K.model('medieval/building_well_red', { height: 120 }), CX - 760, CY + 1150, FL);
      K.place(K.face(K.model('medieval/building_watermill_green', { height: 220 }), Math.PI / 2), CX + 300, CY + 1440, FL);
      K.scatter('medieval/building_grain', [
        { x: CX - 1250, y: CY - 1200, h: FL }, { x: CX + 1600, y: CY - 300, h: FL, rot: 0.5 }, { x: CX - 1800, y: CY + 300, h: FL, rot: 1 },
        { x: CX + 1700, y: CY + 800, h: FL, rot: 0.2 },
      ], { size: 420 });
      const trees = [[], [], []];
      for (let k = 0; k < (lo ? 40 : 90); k++) {
        const a = rnd(k + 300) * Math.PI * 2, rr = 820 + rnd(k + 400) * 2200;
        const x = CX + Math.cos(a) * rr * 1.3, y = CY + Math.sin(a) * rr;
        if (y > 1600 && y < 2100) continue;
        trees[k % 3].push({ x, y, h: FL, rot: rnd(k) * 6, s: 0.7 + rnd(k + 2) * 0.6 });
      }
      K.scatter('medieval/trees_A_large', trees[0], { size: 260 });
      K.scatter('medieval/trees_B_medium', trees[1], { size: 220 });
      K.scatter('medieval/tree_single_A', trees[2], { height: 190 });
      const hills = [];
      for (let k = 0; k < 9; k++) hills.push({ x: CX - 3600 + k * 900 + rnd(k) * 200, y: CY - 3000 - rnd(k + 5) * 600, h: FL, rot: rnd(k + 1) * 6, s: 0.8 + rnd(k + 3) * 0.6 });
      K.scatter('medieval/mountain_B_grass_trees', hills.filter((_, k) => k % 2), { height: 1300 });
      K.scatter('medieval/mountain_A_grass', hills.filter((_, k) => !(k % 2)), { height: 1100 });
      K.scatter('medieval/hills_A_trees', [{ x: CX - 2400, y: CY + 600, h: FL }, { x: CX + 2500, y: CY - 200, h: FL, rot: 2 }, { x: CX + 2200, y: CY + 1300, h: FL, rot: 1 }], { size: 1100 });
      // Clouds drifting below the stage.
      const CL = [['medieval/cloud_big', -900, -300, -700, 560], ['medieval/cloud_small', 1700, 100, -820, 420], ['medieval/cloud_big', 400, -1100, -600, 640],
        ['medieval/cloud_small', -500, 1200, -950, 400], ['medieval/cloud_big', 1500, -800, -760, 520]];
      for (const [m, x, y, h, sz] of (lo ? CL.slice(0, 3) : CL)) {
        const c = K.model(m, { size: sz, cast: false });
        o.clouds.push({ c, x, y, h, v: 14 + (sz % 7) * 3 });
      }
      K.ambient('petali', { n: lo ? 30 : 60, h: 420, x0: -300, y0: -300, x1: W + 300, y1: H + 300 });
      // The stage block (scaled to the ring size) with the painted carpet on top.
      o.slab = K.box(1, 1, 1, K.texMat('legno', [5, 1], { color: '#b98552' }));
      const M = RING0 + APRON + 16;
      K.layer({
        x0: CX - M, y0: CY - M, x1: CX + M, y1: CY + M, h: PH + 0.5, transparent: true,
        draw: (d, v, rr) => drawPlatform(d, v, rr, true),
        key: (v, rr) => `${Math.round(v.R / 2)}|${v.br}|${v.late ? Math.floor(K.t * 8) : 0}|${rr.variant === 'sapone' ? Math.floor(K.t * 4) : 0}`,
      });
      // Ram lane warning (only repainted while it blinks).
      o.warn = K.layer({
        x0: CX - M - 120, y0: CY - M - 120, x1: CX + M + 120, y1: CY + M + 120, h: PH + 1.5, transparent: true, z: 1, lit: false, maxPx: 1024,
        draw: (d, v) => { if (v.tk && v.tk.st === 1) drawTruckWarning(d, v.tk, v.R); },
        key: (v) => (v.tk && v.tk.st === 1 ? 'w' + Math.floor(K.t * 10) : 'off'),
      });
      // Ropes: chains of thin cylinders following the bulging curve; 2 levels per side.
      o.ropeM = K.mat('#e9dcc0', { rough: 0.8, unique: true });
      o.ropes = [];
      for (let side = 0; side < 4; side++) for (const lv of LEVELS) {
        const segs = [];
        for (let k = 0; k < NSEG; k++) segs.push(K.cyl(1, 1, o.ropeM, { center: true, seg: 6, cast: false }));
        o.ropes.push({ side, h: PH + lv, k: lv === LEVELS[0] ? 0.75 : 1, segs });
      }
      // Corner posts: dark wood, padded (team colors in a duel, gold otherwise), with a burning brazier on top.
      const two = (K.n || 2) <= 2;
      const ironM = K.mat('#3a3330', { rough: 0.6, metal: 0.4 });
      o.posts = [0, 1, 2, 3].map((k) => {
        const pl = k < 2 ? 1 : 0;
        const col = two ? K.col(pl, 'main') : '#d9a93a';
        const post = K.cyl(11, 80, K.mat('#4a2e1c', { rough: 0.8 }));
        const pad = K.cyl(17, 50, K.mat(col, { rough: 0.5, emissive: col, ei: 0.12 }), { seg: 16 });
        const bowl = K.cyl(20, 14, ironM, { r2: 10, seg: 10 });
        const fire = K.cone(14, 34, K.glow('#ffb347', { add: true, unique: true, opacity: 0.9 }), { cast: false, seg: 8 });
        o.fires.push(fire);
        return { post, pad, bowl, fire };
      });
      if (!lo) {
        o.lights = [K.light(CX - RING0, CY - RING0, PH + 140, '#ffa040', 1.3, { dist: 700, flicker: 0.5 }), K.light(CX + RING0, CY - RING0, PH + 140, '#ffa040', 1.3, { dist: 700, flicker: 0.5 })];
      }
      // Battering ram: local +X forward, iron head at x = 0.
      const tw = LANE - 16;
      o.truck = K.group();
      const wood = K.texMat('legno', [3, 1], { color: '#8a5a32' }), dark = K.mat('#4a2e1c', { rough: 0.9 }), iron = K.mat('#4b4d55', { rough: 0.35, metal: 0.7 });
      const tb = (wx, wy, hh, m, x, y, h) => { const b = K.box(wx, wy, hh, m, { parent: o.truck }); b.position.set(x, h, y); return b; };
      tb(TRUCK_LEN - 30, tw, 14, wood, -TRUCK_LEN / 2 - 5, 0, 34);
      for (const y of [-tw / 2 + 8, tw / 2 - 8]) for (const x of [-30, -TRUCK_LEN + 40]) tb(10, 10, 110, dark, x, y, 90);
      tb(TRUCK_LEN - 40, 10, 10, dark, -TRUCK_LEN / 2 + 5, -tw / 2 + 8, 142); tb(TRUCK_LEN - 40, 10, 10, dark, -TRUCK_LEN / 2 + 5, tw / 2 - 8, 142);
      const log = K.cyl(24, TRUCK_LEN + 20, wood, { center: true, seg: 12, parent: o.truck });
      log.rotation.z = Math.PI / 2; log.position.set(-TRUCK_LEN / 2 + 10, 92, 0);
      const head = K.cone(30, 44, iron, { seg: 10, parent: o.truck });
      head.rotation.z = -Math.PI / 2; head.position.set(18, 92, 0);
      for (const x of [-50, -TRUCK_LEN + 60]) {
        const band = K.cyl(27, 10, iron, { center: true, seg: 12, parent: o.truck });
        band.rotation.z = Math.PI / 2; band.position.set(x, 92, 0);
      }
      for (const x of [-40, -150, -TRUCK_LEN + 40]) for (const y of [-tw / 2 - 2, tw / 2 + 2]) {
        const wh = K.cyl(26, 12, dark, { center: true, seg: 14, parent: o.truck });
        wh.rotation.x = Math.PI / 2; wh.position.set(x, 26, y);
      }
      const roofM = K.mat('#b8323a', { rough: 0.8 });
      for (const sg of [-1, 1]) {
        const rf = tb(TRUCK_LEN - 30, 86, 6, roofM, -TRUCK_LEN / 2 + 5, sg * 32, 168);
        rf.rotation.x = sg * 0.62;
      }
      // Jelly wrestlers: character inside a wobbly translucent jelly, rubber arms, hands, dizzy stars, ground ring.
      o.pl = Array.from({ length: Math.max(2, K.n || 2) }, (_, i) => {
        const shellG = K.group();
        const shell = K.ball(1, K.mat(K.col(i, 'main'), { opacity: 0.34, rough: 0.12, emissive: K.col(i, 'light'), ei: 0.18, unique: true }), { parent: shellG, cast: false, seg: 28 });
        const armM = K.mat(K.col(i, 'main'), { rough: 0.45, opacity: 0.85 });
        const handM = K.mat(K.col(i, 'light'), { rough: 0.35 });
        return {
          av: K.avatar(i), shellG, shell,
          arms: [0, 1].map(() => K.cyl(1, 1, armM, { center: true, seg: 10 })),
          hands: [0, 1].map(() => K.ball(1, handM)),
          stars: [0, 1, 2].map(() => K.emoji('⭐', 26)),
          dec: K.decal(300),
        };
      });
      return o;
    },
    update(K, o, v, r) {
      const { PH, NSEG } = o;
      const t = K.t;
      const R = v.R, P = R + (v.br ? 12 : APRON);
      o.slab.scale.set(P * 2, PH, P * 2);
      K.place(o.slab, CX, CY, PH / 2);
      // Scenery life: drifting clouds, waving flags, flickering braziers.
      for (const c of o.clouds) {
        const x = ((c.x + t * c.v + 3000) % 6000) - 3000 + CX;
        K.place(c.c, x, c.y, c.h);
      }
      for (const f of o.flags) f.f.rotation.y = Math.sin(t * 2.2 + f.ph) * 0.35;
      o.fires.forEach((f, k) => { const s = 1 + 0.18 * Math.sin(t * 19 + k * 2.3) + 0.1 * Math.sin(t * 7 + k); f.scale.set(1, s, 1); });
      // Ropes.
      const L = CX - R, Rr = CX + R, T = CY - R, B = CY + R;
      const sides = [[Rr, T, Rr, B, 1, 0], [L, T, L, B, -1, 0], [L, B, Rr, B, 0, 1], [L, T, Rr, T, 0, -1]];
      o.ropeM.color.set(v.late ? '#ff8a6a' : '#e9dcc0');
      for (const rp of o.ropes) {
        const [x0, y0, x1, y1, nx, ny] = sides[rp.side];
        if (v.br) {
          // Snapped ropes: two short stubs dangling from the posts.
          const sway = Math.sin(t * 4 + rp.side) * 10;
          rp.segs.forEach((m, k) => {
            m.visible = k === 0 || k === NSEG - 1;
            if (!m.visible) return;
            const [px, py, qx, qy] = k === 0 ? [x0, y0, x1, y1] : [x1, y1, x0, y0];
            segment(K, m, px, py, px + (qx - px) * 0.12 + nx * (26 + sway), py + (qy - py) * 0.12 + ny * (26 + sway), rp.h - 10, 4);
          });
          continue;
        }
        const b = clamp(v.rope[rp.side], -80, 80) * 2 * rp.k, u = v.ru[rp.side] * R * 0.5;
        const cx = (x0 + x1) / 2 + nx * b + (ny ? u : 0), cy = (y0 + y1) / 2 + ny * b + (nx ? u : 0);
        let px = x0, py = y0;
        for (let k = 0; k < NSEG; k++) {
          const q = (k + 1) / NSEG, iq = 1 - q;
          const qx = iq * iq * x0 + 2 * iq * q * cx + q * q * x1, qy = iq * iq * y0 + 2 * iq * q * cy + q * q * y1;
          rp.segs[k].visible = true;
          segment(K, rp.segs[k], px, py, qx, qy, rp.h, 4.5);
          px = qx; py = qy;
        }
      }
      [[L, T], [Rr, T], [L, B], [Rr, B]].forEach(([x, y], k) => {
        const Pq = o.posts[k];
        K.place(Pq.post, x, y, PH); K.place(Pq.pad, x, y, PH + 16); K.place(Pq.bowl, x, y, PH + 80); K.place(Pq.fire, x, y, PH + 90);
      });
      if (o.lights) { K.place(o.lights[0], L, T, PH + 140); K.place(o.lights[1], Rr, T, PH + 140); }
      // Ram.
      const tk = v.tk;
      o.truck.visible = !!tk && tk.st === 2;
      if (o.truck.visible) {
        K.place(o.truck, tk.o === 0 ? tk.x : tk.c, tk.o === 0 ? tk.c : tk.x, PH);
        K.face(o.truck, tk.o === 0 ? (tk.dir > 0 ? 0 : Math.PI) : (tk.dir > 0 ? Math.PI / 2 : -Math.PI / 2));
      }
      // Players.
      const lift = (p) => (p.f > 0 ? PH - p.f * p.f * 1300 : PH + (p.hd ? 26 : 0) + (p.fl ? p.st * 260 : 0));
      v.p.forEach((p, i) => {
        const Q = o.pl[i];
        if (!Q) return;
        if (p.o) {
          // Eliminated: a ghost spectator floating just outside the ring, cheering.
          Q.av.set(p.x, p.y, { r: p.r * 0.8, h: PH + 40 + Math.sin(t * 2 + i) * 10, look: Math.atan2(CY - p.y, CX - p.x), anim: 'Cheer', animSpeed: 0.7, alpha: 0.4, gear: false, marker: false });
          Q.shellG.visible = false; Q.dec.show(false);
          for (const m of [...Q.arms, ...Q.hands, ...Q.stars]) m.visible = false;
          return;
        }
        const vic = p.g ? v.p[p.g - 1] : null;
        const h = lift(p);
        const vis = h > -1500;
        const rav = p.r * 0.9;
        const wob = p.w + Math.sin(t * 8 + i * 2) * 0.03;
        const falling = p.f > 0;
        const look = falling ? t * 12 : p.dz > 0 ? t * 6 : Math.atan2(p.fy, p.fx);
        const walk = clamp(p.st * 1000 / 345, 0, 1);
        const anim = falling || p.hd || p.fl ? 'Jump_Idle' : p.hb ? 'Dodge_Forward' : p.hu ? 'Hit_A' : p.g || p.e > 0.3 ? 'Spellcasting'
          : p.dz > 0 ? 'Idle' : walk > 0.55 ? 'Running_A' : walk > 0.12 ? 'Walking_A' : 'Idle';
        const mood = falling || p.hd ? 'scared' : p.dz > 0 ? 'dizzy' : 'ok';
        Q.av.set(p.x, p.y, { r: rav, h, look, mood, anim, gear: false, squash: falling ? Math.sin(t * 30) * 0.2 : clamp(wob, -0.4, 0.4) * 0.6, visible: vis, lean: p.hb ? 0.35 : 0 });
        // Jelly shell stretched along the velocity.
        Q.shellG.visible = vis;
        if (vis) {
          K.place(Q.shellG, p.x, p.y, h + rav * 1.3);
          K.face(Q.shellG, p.sa);
          const sr = p.r * 1.12;
          Q.shell.scale.set(sr * (1 + p.st + wob * 0.6), rav * 1.5 * Math.max(0.55, 1 - wob * 0.5), sr * Math.max(0.5, 1 - p.st * 0.6 - wob * 0.6));
        }
        // Arms and hands (hands of a grabber clamp at the victim's height).
        const sideX = -p.fy, sideY = p.fx;
        const hBody = h + rav * 1.6;
        const hHand = vic ? lift(vic) + vic.r * 0.9 * 1.4 : hBody;
        for (let n = 0; n < 2; n++) {
          const sg = n ? 1 : -1;
          const sx = p.x + sideX * sg * p.r * 0.55, sy = p.y + sideY * sg * p.r * 0.55;
          const hx = p.h[n * 2], hy = p.h[n * 2 + 1];
          const hr = HAND_R * (p.r / BODY_R) * (p.g ? 1.25 : 1.05);
          const arm = Q.arms[n], hand = Q.hands[n];
          arm.visible = hand.visible = vis;
          if (!vis) continue;
          segment(K, arm, sx, sy, hx, hy, (hBody + hHand) / 2, Math.max(4, p.r * 0.13), hHand - hBody);
          K.place(hand, hx, hy, hHand); hand.scale.setScalar(hr);
        }
        // Dizzy stars orbiting the head.
        Q.stars.forEach((st, k) => {
          st.visible = vis && p.dz > 0;
          if (!st.visible) return;
          const a = t * 5 + k * 2.1;
          K.place(st, p.x + Math.cos(a) * p.r * 0.8, p.y + Math.sin(a) * p.r * 0.8, h + rav * 3 + Math.sin(a * 2) * 6);
        });
        // Ground indicators: stun meter, throw charge, headbutt recharge + facing arrow.
        Q.dec.show(!falling).at(p.x, p.y, PH + 0.8).paint((d) => {
          if (p.dz > 0) d.ring(0, 0, p.r + 12, 'rgba(255,225,77,0.8)', 5);
          else if (p.sz > 0.02) d.arc(0, 0, p.r + 12, -Math.PI / 2, -Math.PI / 2 + p.sz * TAU, '#ffe14d', 7);
          if (p.g) {
            const full = p.sp >= 0.99;
            d.arc(0, 0, p.r + 26, -Math.PI / 2, -Math.PI / 2 + Math.max(0.05, p.sp) * TAU, full ? '#ffd23f' : d.col(i, 'light'), full ? 10 : 7);
            if (full) d.ring(0, 0, p.r + 36 + Math.sin(t * 20) * 3, 'rgba(255,210,63,0.6)', 4);
            else {
              const a0 = t * 4;
              d.arc(0, 0, p.r + 40, a0, a0 + 1.2, 'rgba(255,255,255,0.6)', 5);
              d.circle(Math.cos(a0 + 1.2) * (p.r + 40), Math.sin(a0 + 1.2) * (p.r + 40), 7, 'rgba(255,255,255,0.75)');
            }
          } else if (!p.hd) {
            if (p.cd > 0) d.arc(0, 0, p.r + 10, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / HB_CD), d.col(i, 'light') + '88', 6);
            const ax = p.fx * (p.r + 26), ay = p.fy * (p.r + 26);
            d.poly([ax + p.fx * 18, ay + p.fy * 18, ax - p.fy * 13, ay + p.fx * 13, ax + p.fy * 13, ay - p.fx * 13], d.col(i, 'light') + (p.cd <= 0 ? 'ee' : '55'), 'rgba(0,0,0,0.35)', 2);
          }
        });
      });
    },
  },

  render(d, v, r) {
    const { ctx } = d;
    const R = v.R;
    drawVoid(d);
    drawPlatform(d, v, r);
    if (v.tk && v.tk.st === 1) drawTruckWarning(d, v.tk, R);

    // Bodies back-to-front, then arms/hands on top (so grabs read clearly).
    const order = v.p.map((_, i) => i).sort((a, b) => v.p[a].y - v.p[b].y);
    for (const i of order) drawBody(d, v.p[i], i);
    for (const i of order) drawArms(d, v.p[i], i);
    drawRopes(d, v, R);
    if (v.tk && v.tk.st === 2) drawTruck(d, v.tk);
    ctx.globalAlpha = 1;
  },
};

// ---------- simulation helpers ----------

function updateHands(s, g, dt) {
  for (const p of s.p) {
    const sideX = -p.fy, sideY = p.fx;
    const o = p.grab >= 0 ? s.p[p.grab] : null;
    const k = p.ext > 0.05 || o ? 700 : 230;
    const c = p.ext > 0.05 || o ? 30 : 11;
    p.h.forEach((h, n) => {
      const sg = n ? 1 : -1;
      let tx, ty;
      if (o) {
        // Hands clamp on the near side of the victim.
        const dx = o.x - p.x, dy = o.y - p.y;
        const nn = norm(dx, dy);
        tx = o.x - nn.x * o.r * 0.55 - nn.y * sg * o.r * 0.7;
        ty = o.y - nn.y * o.r * 0.55 + nn.x * sg * o.r * 0.7;
      } else {
        const fwd = p.r * 0.45 + p.ext * p.reach;
        const spread = p.r * (1 - 0.6 * p.ext);
        const sway = p.fall > 0 ? Math.sin(g.t * 22 + n * 3) * 30 : p.dizzy > 0 ? Math.sin(g.t * 9 + n * 2) * 16 : Math.sin(g.t * 3.2 + n * 1.7 + p.i) * 5;
        tx = p.x + p.fx * fwd + sideX * sg * (spread + sway);
        ty = p.y + p.fy * fwd + sideY * sg * (spread + sway);
      }
      h.vx += ((tx - h.x) * k - h.vx * c) * dt;
      h.vy += ((ty - h.y) * k - h.vy * c) * dt;
      h.x += h.vx * dt; h.y += h.vy * dt;
      // Elastic limit: arms can only stretch so far.
      const lim = p.r + p.reach + 50;
      const dd = dist(p.x, p.y, h.x, h.y);
      if (dd > lim) {
        const q = lim / dd;
        h.x = p.x + (h.x - p.x) * q; h.y = p.y + (h.y - p.y) * q;
      }
    });
  }
}

function stepTruck(s, g, dt, R) {
  const t = s.truck;
  const calm = s.pause > 0 || s.respawnAt > 0;
  if (t.st === 0 && calm) t.at = Math.max(t.at, g.t + 1);
  if (t.st === 0 && g.t >= t.at && !g.ended) {
    // Lanes take turns aiming at each player still in (fair), with some jitter.
    const alive = s.p.filter((p) => !p.out);
    const target = alive[t.n % Math.max(1, alive.length)] || s.p[0];
    t.n++;
    t.o = g.rng.chance(0.5) ? 0 : 1;
    t.dir = g.rng.chance(0.5) ? 1 : -1;
    const base = t.o === 0 ? target.y : target.x;
    t.c = clamp(base + g.rng.range(-60, 60), (t.o === 0 ? CY : CX) - R + 70, (t.o === 0 ? CY : CX) + R - 70);
    t.st = 1; t.warn = TRUCK_WARN;
    g.sfx('horn'); g.say("🐏 ARRIVA L'ARIETE!");
  } else if (t.st === 1) {
    if (!calm) t.warn -= dt;
    if (t.warn <= 0) {
      t.st = 2; t.x = (t.o === 0 ? CX : CY) - t.dir * (R + 420);
      g.sfx('horn', { pitch: 0.8 }); g.sfx('whoosh');
    }
  } else if (t.st === 2) {
    t.x += t.dir * TRUCK_SPEED * dt;
    const mid = t.o === 0 ? CX : CY;
    for (const p of s.p) {
      if (!active(p) || p.truck) continue;
      const pa = t.o === 0 ? p.x : p.y, pc = t.o === 0 ? p.y : p.x;
      const lo = Math.min(t.x, t.x - t.dir * TRUCK_LEN) - p.r, hi = Math.max(t.x, t.x - t.dir * TRUCK_LEN) + p.r;
      if (Math.abs(pc - t.c) < LANE / 2 + p.r * 0.6 && pa > lo && pa < hi) {
        freeFromAll(s, p);
        p.truck = true; p.fly = 3; p.dizzy = 0; p.hb = 0;
        const side = pc >= t.c ? 1 : -1;
        if (t.o === 0) { p.vx = t.dir * 1500; p.vy = side * 160; } else { p.vy = t.dir * 1500; p.vx = side * 160; }
        p.wv -= 12;
        g.sfx('crash'); g.sfx('horn', { pitch: 1.2 }); g.shake(0.8); g.hitstop(0.08);
        g.burst(p.x, p.y, { player: p.i, n: 26, speed: 480, size: 9 });
        g.text(p.x, p.y - p.r - 30, 'TRAVOLTO!', { player: p.i, size: 48 });
        g.vibrate(p.i, 250);
      }
    }
    if ((t.x - mid) * t.dir > R + 700) { t.st = 0; t.at = g.t + TRUCK_EVERY - TRUCK_WARN; }
  }
}

function handleFalls(s, fallen, g) {
  for (const p of fallen) {
    freeFromAll(s, p);
    p.fall = 0.001; p.fly = 0; p.hb = 0;
    s.falls[p.i]++;
    g.sfx('fall'); g.sfx('wobble', { vol: 0.5 });
    g.text(p.x, p.y - p.r - 30, 'AAAAAH!', { player: p.i, size: 50 });
    g.burst(p.x, p.y, { player: p.i, n: 22, speed: 300 });
    g.shake(0.6); g.vibrate(p.i, 220);
  }
  const gone = fallen.filter((p) => s.falls[p.i] >= LIVES);
  for (const p of gone) p.out = true;
  const alive = s.p.filter((p) => !p.out);
  if (alive.length <= 1) {
    // Everyone left fell on the same step: the one closer to the centre survives.
    const w = alive.length ? alive[0] : gone.reduce((b, p) => (dist(p.x, p.y, CX, CY) < dist(b.x, b.y, CX, CY) ? p : b));
    g.slowmo(0.35, 0.9); g.sfx('bigexplode', { vol: 0.5 });
    g.end(w.i, 'Giù dalla torre!');
  } else {
    g.say(gone.length ? 'FUORI DAL TORNEO!' : 'GIÙ DALLA TORRE!');
    s.respawnAt = g.t + 1.5;
  }
}

// ---------- render helpers ----------

// 2D backdrop: the countryside far below the tower.
function drawVoid(d) {
  const { ctx } = d;
  ctx.fillStyle = '#4f8a3c';
  ctx.fillRect(-400, -400, W + 800, H + 800);
  for (let k = 0; k < 40; k++) {
    const x = ((k * 7919) % 1400) - 200, y = ((k * 104729) % 1400) - 200;
    if (k % 3 === 0) d.circle(x, y, 26 + (k % 4) * 6, '#2f6b2a');
    else d.rect(x, y, 22 + (k % 3) * 6, 16 + (k % 2) * 6, k % 2 ? '#c96a3a' : '#e8d6b0');
  }
  d.rect(-400, 1180, W + 800, 120, '#3f8fd0');
  // Clouds drifting between us and the ground.
  for (let k = 0; k < 6; k++) {
    const x = ((k * 233 + d.t * (14 + k * 3)) % 1600) - 300;
    const y = ((k * 397) % 1300) - 150;
    ctx.globalAlpha = 0.18;
    d.circle(x, y, 120 + k * 15, '#ffffff');
    d.circle(x + 90, y + 20, 90, '#ffffff');
  }
  ctx.globalAlpha = 1;
}

// The stage: wooden apron with gold studs, a royal carpet (lard in 'sapone'), team corners in a duel.
function drawPlatform(d, v, r, is3d = false) {
  const { ctx } = d;
  const R = v.R, P = R + (v.br ? 12 : APRON);
  const soap = r.variant === 'sapone';
  if (!is3d) d.rect(CX - P + 22, CY - P + 30, P * 2, P * 2, 'rgba(0,0,0,0.35)');
  d.rrect(CX - P, CY - P, P * 2, P * 2, 10, '#9a6a3c', '#4a2c14', 6);
  for (let k = -P + 30; k < P - 10; k += 34) {
    d.line(CX - P + 4, CY + k, CX + P - 4, CY + k, 'rgba(60,30,10,0.35)', 2);
  }
  for (let k = -P + 14; k < P - 10; k += 46) {
    for (const [x, y] of [[CX + k, CY - P + 9], [CX + k, CY + P - 9], [CX - P + 9, CY + k], [CX + P - 9, CY + k]]) d.circle(x, y, 5, '#e8c060', '#7a5418', 2);
  }
  const mat = ctx.createRadialGradient(CX, CY - R * 0.3, R * 0.1, CX, CY, R * 1.4);
  mat.addColorStop(0, soap ? '#fff4cf' : '#c23a40');
  mat.addColorStop(1, soap ? '#e6cf8f' : '#6a1420');
  d.rect(CX - R, CY - R, R * 2, R * 2, mat);
  d.rect(CX - R + 10, CY - R + 10, R * 2 - 20, R * 2 - 20, null, soap ? 'rgba(160,120,40,0.5)' : '#e8c060', 5);
  // Carpet seams.
  for (let k = 1; k < 4; k++) {
    d.line(CX - R + (R * 2 * k) / 4, CY - R + 10, CX - R + (R * 2 * k) / 4, CY + R - 10, soap ? 'rgba(255,255,255,0.3)' : 'rgba(255,215,120,0.12)', 3);
  }
  // Corner zones in the players' colors (duel only: red bottom, blue top).
  if (v.p.length <= 2) {
    const c0 = d.col(0) + '44', c1 = d.col(1) + '40';
    d.poly([CX - R, CY + R, CX - R + 90, CY + R, CX - R, CY + R - 90], c0);
    d.poly([CX + R, CY + R, CX + R - 90, CY + R, CX + R, CY + R - 90], c0);
    d.poly([CX - R, CY - R, CX - R + 90, CY - R, CX - R, CY - R + 90], c1);
    d.poly([CX + R, CY - R, CX + R - 90, CY - R, CX + R, CY - R + 90], c1);
  }
  d.circle(CX, CY, R * 0.42, soap ? 'rgba(255,255,255,0.35)' : 'rgba(120,20,30,0.55)');
  d.circle(CX, CY, R * 0.42, null, soap ? '#ffffff' : '#e8c060', 5);
  d.star(CX, CY, R * 0.2, soap ? 'rgba(255,255,255,0.45)' : 'rgba(232,192,96,0.55)', 5);
  // Sweeping lights.
  for (let k = 0; k < (is3d ? 0 : 2); k++) {
    const a = d.t * 0.7 + k * Math.PI;
    d.circle(CX + Math.cos(a) * R * 0.55, CY + Math.sin(a * 1.3) * R * 0.55, R * 0.32, 'rgba(255,255,230,0.06)');
  }
  if (soap) {
    for (let k = 0; k < 14; k++) {
      const x = CX + Math.sin(k * 2.3 + d.t * 0.4) * R * 0.8, y = CY + Math.cos(k * 1.7 + d.t * 0.3) * R * 0.8;
      d.circle(x, y, 10 + (k % 4) * 6, 'rgba(255,255,255,0.35)', '#ffffff', 2);
    }
    ctx.globalAlpha = 0.3;
    d.line(CX - R * 0.7, CY - R * 0.5, CX - R * 0.2, CY - R * 0.9, '#ffffff', 10);
    d.line(CX + R * 0.3, CY + R * 0.8, CX + R * 0.8, CY + R * 0.3, '#ffffff', 10);
    ctx.globalAlpha = 1;
  }
  if (v.late) {
    ctx.globalAlpha = 0.25 + 0.2 * Math.sin(d.t * 8);
    d.rect(CX - R, CY - R, R * 2, R * 2, null, '#ff3d3d', 10);
    ctx.globalAlpha = 1;
  }
}

function ropePath(ctx, x0, y0, x1, y1, ox, oy) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo((x0 + x1) / 2 + ox, (y0 + y1) / 2 + oy, x1, y1);
  ctx.stroke();
}

function drawRopes(d, v, R) {
  const { ctx } = d;
  const L = CX - R, Rr = CX + R, T = CY - R, B = CY + R;
  const sides = [
    [Rr, T, Rr, B, 1, 0], [L, T, L, B, -1, 0], [L, B, Rr, B, 0, 1], [L, T, Rr, T, 0, -1],
  ];
  ctx.lineCap = 'round';
  sides.forEach(([x0, y0, x1, y1, nx, ny], k) => {
    if (v.br) {
      // Snapped ropes: short frayed stubs dangling from the posts.
      const sway = Math.sin(d.t * 4 + k) * 10;
      for (const [px, py, qx, qy] of [[x0, y0, x1, y1], [x1, y1, x0, y0]]) {
        const ex = px + (qx - px) * 0.12 + nx * (26 + sway), ey = py + (qy - py) * 0.12 + ny * (26 + sway);
        d.line(px, py, ex, ey, '#e9dcc0', 6);
      }
      return;
    }
    const b = clamp(v.rope[k], -80, 80) * 2, u = v.ru[k] * R * 0.5;
    const ox = nx * b + (ny ? u : 0), oy = ny * b + (nx ? u : 0);
    ctx.lineWidth = 11; ctx.strokeStyle = '#3a2412';
    ropePath(ctx, x0, y0, x1, y1, ox, oy);
    ctx.lineWidth = 7; ctx.strokeStyle = v.late ? '#ff8a6a' : '#e9dcc0';
    ropePath(ctx, x0, y0, x1, y1, ox, oy);
  });
  // Corner posts: team colors in a duel (red bottom, blue top), gold otherwise.
  for (const [x, y] of [[L, T], [Rr, T], [L, B], [Rr, B]]) {
    const pl = y > CY ? 0 : 1;
    d.circle(x, y, 22, '#4a2e1c');
    d.circle(x, y, 16, v.p.length <= 2 ? d.col(pl, 'main') : '#d9a93a', '#ffe8a0', 3);
  }
}

function drawBody(d, p, i) {
  const { ctx } = d;
  if (p.o) {
    d.avatar(p.x, p.y, p.r * 0.8, i, { mood: 'happy', alpha: 0.35 });
    return;
  }
  if (p.f > 0) {
    const k = Math.max(0, 1 - p.f / 0.9);
    if (k <= 0) return;
    ctx.globalAlpha = k;
    d.avatar(p.x, p.y, p.r * k, i, { mood: 'scared', look: d.t * 12, squash: Math.sin(d.t * 30) * 0.2, alpha: k });
    ctx.globalAlpha = 1;
    return;
  }
  d.shadow(p.x + 6, p.y + 14, p.r * 1.05, p.r * 0.8, 0.3);
  if (p.hb) d.circle(p.x - p.fx * 34, p.y - p.fy * 34, p.r * 0.85, d.col(i, 'light') + '44');
  // Jelly blob: stretched along velocity, squashed by the wobble spring.
  const wob = p.w + Math.sin(d.t * 8 + i * 2) * 0.03;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.sa);
  ctx.scale(1 + p.st + wob * 0.6, Math.max(0.5, 1 - p.st * 0.6 - wob * 0.6));
  d.circle(0, 0, p.r * 1.12, d.col(i, 'main') + '77', d.col(i, 'light'), 4);
  d.circle(-p.r * 0.35, -p.r * 0.45, p.r * 0.25, 'rgba(255,255,255,0.35)');
  ctx.restore();
  const mood = p.dz > 0 ? 'dizzy' : p.fl || p.hd ? 'scared' : p.hu ? 'hurt' : p.g || p.hb ? 'angry' : p.e > 0.3 ? 'happy' : 'ok';
  const look = p.dz > 0 ? d.t * 6 : Math.atan2(p.fy, p.fx);
  d.avatar(p.x, p.y, p.r * 0.9, i, { look, mood, squash: clamp(wob, -0.4, 0.4) });
  if (p.dz > 0) {
    for (let k = 0; k < 3; k++) {
      const a = d.t * 5 + k * 2.1;
      d.star(p.x + Math.cos(a) * p.r * 0.8, p.y - p.r * 0.3 + Math.sin(a) * p.r * 0.35, 10, '#ffe14d');
    }
  } else if (p.sz > 0.02) {
    d.arc(p.x, p.y, p.r + 12, -Math.PI / 2, -Math.PI / 2 + p.sz * TAU, '#ffe14d', 5);
  }
  if (p.g) {
    // Spin charge for the throw: fills while you swing around, gold when full.
    const full = p.sp >= 0.99;
    d.arc(p.x, p.y, p.r + 22, -Math.PI / 2, -Math.PI / 2 + Math.max(0.05, p.sp) * TAU, full ? '#ffd23f' : d.col(i, 'light'), full ? 8 : 5);
    if (full) d.ring(p.x, p.y, p.r + 30 + Math.sin(d.t * 20) * 3, 'rgba(255,210,63,0.5)', 3);
    else {
      // Curved arrow hint: "spin me!"
      const a0 = d.t * 4;
      d.arc(p.x, p.y, p.r + 34, a0, a0 + 1.2, 'rgba(255,255,255,0.45)', 4);
      const ex = p.x + Math.cos(a0 + 1.2) * (p.r + 34), ey = p.y + Math.sin(a0 + 1.2) * (p.r + 34);
      d.circle(ex, ey, 6, 'rgba(255,255,255,0.6)');
    }
  } else if (p.f <= 0 && !p.hd) {
    // Headbutt recharge ring + facing arrow.
    if (p.cd > 0) d.arc(p.x, p.y, p.r + 8, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / HB_CD), d.col(i, 'light') + '66', 4);
    const ax = p.x + p.fx * (p.r + 22), ay = p.y + p.fy * (p.r + 22);
    d.poly([ax + p.fx * 14, ay + p.fy * 14, ax - p.fy * 10, ay + p.fx * 10, ax + p.fy * 10, ay - p.fx * 10], d.col(i, 'light') + (p.cd <= 0 ? 'dd' : '55'));
  }
}

function drawArms(d, p, i) {
  if (p.o || p.f > 0.9) return;
  const k = p.f > 0 ? Math.max(0, 1 - p.f / 0.9) : 1;
  const sideX = -p.fy, sideY = p.fx;
  for (let n = 0; n < 2; n++) {
    const sg = n ? 1 : -1;
    const sx = p.x + sideX * sg * p.r * 0.7 * k, sy = p.y + sideY * sg * p.r * 0.7 * k;
    const hx = p.x + (p.h[n * 2] - p.x) * k, hy = p.y + (p.h[n * 2 + 1] - p.y) * k;
    const lw = Math.max(4, p.r * 0.26 * k);
    d.line(sx, sy, hx, hy, d.col(i, 'dark'), lw + 5);
    d.line(sx, sy, hx, hy, d.col(i, 'main'), lw);
    const hr = HAND_R * (p.r / BODY_R) * k * (p.g ? 1.15 : 1);
    d.circle(hx, hy, hr, d.col(i, 'light'), d.col(i, 'dark'), 3);
  }
}

function drawTruckWarning(d, t, R) {
  const { ctx } = d;
  const blink = Math.sin(d.t * 18) > 0;
  const lo = t.c - LANE / 2;
  const ext = R + APRON;
  ctx.globalAlpha = blink ? 0.4 : 0.18;
  if (t.o === 0) d.rect(CX - ext, lo, ext * 2, LANE, '#ff3030');
  else d.rect(lo, CY - ext, LANE, ext * 2, '#ff3030');
  ctx.globalAlpha = 0.8;
  // Chevrons pointing where the ram goes.
  for (let k = -3; k <= 3; k++) {
    const a = k * 90 + ((d.t * 300 * t.dir) % 90);
    const px = t.o === 0 ? CX + a : t.c, py = t.o === 0 ? t.c : CY + a;
    const fx = t.o === 0 ? t.dir : 0, fy = t.o === 0 ? 0 : t.dir;
    d.poly([px + fx * 24, py + fy * 24, px - fx * 10 + fy * 30, py - fy * 10 + fx * 30, px - fx * 10 - fy * 30, py - fy * 10 - fx * 30], '#ffd36b');
  }
  ctx.globalAlpha = 1;
  d.emoji('🐏', t.o === 0 ? CX - t.dir * (ext + 40) : t.c, t.o === 0 ? t.c : CY - t.dir * (ext + 40), 70);
}

function drawTruck(d, t) {
  const { ctx } = d;
  const cx = t.o === 0 ? t.x : t.c, cy = t.o === 0 ? t.c : t.x;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t.o === 0 ? (t.dir > 0 ? 0 : Math.PI) : (t.dir > 0 ? Math.PI / 2 : -Math.PI / 2));
  // Local frame: +x is forward, iron head at x=0.
  const w = LANE - 16;
  d.rect(-TRUCK_LEN + 10, -w / 2 + 8, TRUCK_LEN, w, 'rgba(0,0,0,0.35)');
  d.rrect(-TRUCK_LEN, -w / 2, TRUCK_LEN - 20, w, 10, '#8a5a32', '#4a2e1c', 4);
  d.rect(-TRUCK_LEN + 10, -w / 2 + 14, TRUCK_LEN - 40, w - 28, '#b8323a');
  d.rrect(-TRUCK_LEN - 10, -18, TRUCK_LEN + 10, 36, 16, '#a0703a', '#4a2e1c', 3);
  d.poly([0, -24, 34, 0, 0, 24], '#4b4d55', '#222', 3);
  ctx.restore();
}

// ---------- 3D helpers ----------

// Orient a unit cylinder (axis = height) as a segment from (x0, y0) to (x1, y1) around height h, rising by dh.
function segment(K, m, x0, y0, x1, y1, h, rad, dh = 0) {
  const dx = x1 - x0, dy = y1 - y0;
  const lh = Math.hypot(dx, dy);
  K.place(m, (x0 + x1) / 2, (y0 + y1) / 2, h);
  m.rotation.set(0, -Math.atan2(dy, dx), Math.atan2(dh, lh) - Math.PI / 2, 'YXZ');
  m.scale.set(rad, Math.max(0.5, Math.hypot(lh, dh)), rad);
}
