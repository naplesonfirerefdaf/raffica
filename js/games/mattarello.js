// Il Rullo dell'Aia — a stone threshing roller sweeps the threshing floor like a clock hand: jump it, flip it, survive.
// Golden eggs appear (mirrored for every player): grab one and your next flip is a TURBO flip. Up to 4 players,
// last one standing wins.
import { clamp, wrapAngle, r1, r2, r3 } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500;
const TABLE_R = 440, PIN_LEN = 470, PIN_HALF = 26;
const PR = 360;                         // players' distance from the center
const BODY_R = 42;
const HOME = [Math.PI / 2, -Math.PI / 2, Math.PI, 0]; // seat 0 bottom, 1 top, 2 left, 3 right
const MOVE_RANGE = 0.55, MOVE_SPEED = 1.5;
const JUMP_T = 0.55, JUMP_MAX = 1.05, SAFE_Z = 0.35;
const FLIP_CD = 3;
const LIVES = 3, INVULN = 1.2;
const SUDDEN_AT = 30;
const EGG_EVERY = 5.5, EGG_LIFE = 4.5, TURBO_T = 1.8, TURBO_K = 1.6;
const OMEGA_MAX = 8;                    // turbo during sudden death must stay jumpable

function makePlayer(i) {
  return { i, a: HOME[i], jp: -1, jt: JUMP_T, jh: 1, hold: false, inv: 0, hit: 0, cd: 0.5, lives: LIVES, lastHit: -1, jumps: 0, sup: false, egg: null, out: false };
}

const jumpZ = (p) => (p.jp < 0 ? 0 : Math.sin(Math.PI * p.jp) * p.jh);

// ---------- bot helpers ----------
const TWO_PI = Math.PI * 2;
const BOT_DELAY = [22 / 60, 13 / 60, 7 / 60];          // driver reaction time per level, in game steps
const HIT_HALF = (PIN_HALF + BODY_R * 0.7) / PR;        // half-width of the hit zone (radians)
const LIFT = Math.asin(SAFE_Z) / Math.PI;               // jump fraction where a player is high enough
// Seconds until the first of `arms` (turning in `dir`) reaches angle a. `w` overrides the speed.
function botArrival(s, arms, dir, a, w) {
  let best = 1e9;
  for (const arm of arms) {
    const sp = (w ?? s.omega) * arm.k;
    if (sp < 1e-3) continue;
    const d = wrapAngle(arm.a - a);
    const travel = dir > 0 ? (d <= 0 ? -d : TWO_PI - d) : (d >= 0 ? d : TWO_PI + d);
    best = Math.min(best, travel / sp);
  }
  return best;
}
// Will p be safe (invulnerable or high in its current jump) when the roller arrives in t (± hz) seconds?
function botCovered(p, t, hz) {
  if (p.inv > t + hz) return true;
  if (p.jp < 0) return false;
  const a = (LIFT * 1.05 - p.jp) * p.jt, b = (1 - LIFT * 1.05 - p.jp) * p.jt;
  return t - hz >= a && t + hz <= b;
}
// A point between player at angle a and the center (for texts).
const inward = (a, k) => ({ x: CX + Math.cos(a) * (PR - k), y: CY + Math.sin(a) * (PR - k) });

export default {
  id: 'mattarello',
  name: "Il Rullo dell'Aia",
  rule: 'Salta il rullo di pietra! B lo fa girare al contrario',
  verb: 'SALTA!',
  inspired: 'Mario Party · Hot Rope Jump',
  cam: 'top',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'h', a: 'Salta', b: 'Gira' },
  help: {
    goal: "Salta il rullo che trebbia l'aia: chi viene travolto 3 volte è fuori. Vince l'ultimo in piedi.",
    dir: "Ti sposti lungo il bordo dell'aia (nella tua zona colorata): serve per prendere le UOVA D'ORO.",
    a: 'SALTA: il rullo ti passa sotto solo se sei in aria. Il cerchio rosso lampeggiante = sta arrivando!',
    b: "GIRA: inverte il verso del rullo (si ricarica in 3 s, anello pieno = pronto). Attacco: aspetta che un avversario ATTERRI e gira: il rullo gli torna addosso! Difesa: se sta per travolgerti, giralo via.",
    tips: ["Prendi l'UOVO D'ORO 🥚: la prossima GIRA è TURBO (rullo velocissimo per 2 s)", 'Quando vieni travolto la tua GIRA si ricarica subito: vendicati!', 'Dopo 30 s morte improvvisa: velocità massima'],
  },
  duration: 45,
  supports: ['gravity'],
  variants: [
    { id: 'due', name: 'Due Rulli', desc: 'Due rulli di pietra a velocità diverse!' },
    { id: 'stanca', name: 'Mulo Stanco', desc: 'Il mulo che tira il rullo si ferma di colpo e riparte!' },
    { id: 'saltone', name: 'Salto del Grillo', desc: 'Tieni premuto A per un salto più alto e lento' },
  ],

  init(g) {
    const n = g.n || 2;
    // The roller starts on an empty side: same distance from both players in 1v1, a free diagonal with 4.
    const start = n === 2 ? g.rng.pick([0, Math.PI]) : n === 3 ? 0 : g.rng.pick([Math.PI / 4, -Math.PI / 4, (3 * Math.PI) / 4, (-3 * Math.PI) / 4]);
    const arms = [{ a: start, k: 1 }];
    if (g.variant === 'due') arms.push({ a: start + Math.PI, k: 0.62 });
    const grav = g.mods.gravity || 1;
    const p = Array.from({ length: n }, (_, i) => makePlayer(i));
    return {
      arms, dir: g.rng.sign(), omega: 0, stop: 0, stopAt: g.rng.range(3, 5), sudden: false,
      jumpScale: 1 / Math.sqrt(grav), flash: 0, flipBy: -1, turbo: 0, eggAt: 3,
      prev: arms.map((arm) => p.map((q) => wrapAngle(arm.a - q.a))),
      p,
    };
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.flash = Math.max(0, s.flash - dt);
    s.turbo = Math.max(0, s.turbo - dt);

    // Roller speed ramps up; sudden death after 30 s.
    if (!s.sudden && g.t >= SUDDEN_AT) {
      s.sudden = true;
      g.say('MORTE IMPROVVISA!'); g.sfx('horn'); g.shake(0.4); g.flash('#ff3b3b', 0.4);
    }
    s.omega = Math.min(OMEGA_MAX, (s.sudden ? 6.2 : 1.7 + g.t * 0.085) * (s.turbo > 0 ? TURBO_K : 1));
    if (g.variant === 'stanca') {
      if (s.stop > 0) {
        s.stop -= dt;
        if (s.stop <= 0) { g.sfx('whoosh', { pitch: 1.3 }); g.text(CX, CY - 80, 'RIPARTE!', { color: '#ffd36b', size: 50 }); }
      } else if (g.t >= s.stopAt) {
        s.stop = g.rng.range(0.35, 1.0);
        s.stopAt = g.t + s.stop + g.rng.range(1.5, 3.5);
        g.sfx('slide', { pitch: 0.6 }); g.text(CX, CY - 80, 'Hiii-hooo…', { color: '#fff', size: 50 });
      }
    }
    const moving = !(g.variant === 'stanca' && s.stop > 0);
    for (const arm of s.arms) if (moving) arm.a += s.dir * s.omega * arm.k * dt;

    if (g.ended) return;

    // Golden eggs: one per player still in, mirrored (same offset inside each home arc).
    if (s.p.every((p) => !p.egg) && g.t >= s.eggAt) {
      const off = g.rng.range(0.25, MOVE_RANGE - 0.05) * g.rng.sign();
      for (const p of s.p) if (!p.sup && !p.out) p.egg = { a: HOME[p.i] + off, t: EGG_LIFE };
      if (s.p.some((p) => p.egg)) { g.sfx('pop', { pitch: 1.4 }); }
      s.eggAt = g.t + EGG_EVERY;
    }

    for (const p of s.p) {
      const n = inp[p.i];
      p.inv = Math.max(0, p.inv - dt);
      p.hit = Math.max(0, p.hit - dt);
      p.cd = Math.max(0, p.cd - dt);
      if (p.out) { p.jp = -1; p.egg = null; continue; }
      // Slide along the rim: project world stick on the tangent.
      const tx = -Math.sin(p.a), ty = Math.cos(p.a);
      const along = clamp(n.x * tx + n.y * ty, -1, 1);
      const air = p.jp >= 0 ? 0.5 : 1;
      if (p.hit <= 0) p.a += along * MOVE_SPEED * air * dt;
      p.a = HOME[p.i] + clamp(wrapAngle(p.a - HOME[p.i]), -MOVE_RANGE, MOVE_RANGE);

      // Egg pickup.
      if (p.egg) {
        p.egg.t -= dt;
        if (Math.abs(wrapAngle(p.egg.a - p.a)) < 0.13 && jumpZ(p) < 0.5) {
          p.egg = null; p.sup = true; p.cd = 0;
          const x = CX + Math.cos(p.a) * PR, y = CY + Math.sin(p.a) * PR;
          const tp = inward(p.a, 90);
          g.sfx('powerup'); g.burst(x, y, { color: '#ffd23f', n: 18, speed: 240 });
          g.text(tp.x, tp.y, 'TURBO PRONTO!', { player: p.i, size: 44 });
        } else if (p.egg.t <= 0) {
          p.egg = null;
          g.sfx('squish', { vol: 0.4, pitch: 1.5 });
        }
      }

      // Jump.
      if (n.aP && p.jp < 0 && p.hit <= 0) {
        p.jp = 0; p.jt = JUMP_T * s.jumpScale; p.jh = 1; p.hold = g.variant === 'saltone'; p.jumps++;
        g.sfx('jump', { pitch: 1 + p.i * 0.1 });
      }
      if (p.jp >= 0) {
        if (p.hold) {
          if (n.a && p.jp < 0.45) {
            p.jt = Math.min(JUMP_MAX * s.jumpScale, p.jt + dt * 1.4);
            p.jh = p.jt / (JUMP_T * s.jumpScale);
          } else p.hold = false;
        }
        p.jp += dt / p.jt;
        if (p.jp >= 1) {
          p.jp = -1;
          g.sfx('land', { vol: 0.6 });
          g.burst(CX + Math.cos(p.a) * PR, CY + Math.sin(p.a) * PR, { color: '#f3dca0', n: 6, speed: 120, size: 6 });
        }
      }

      // Flip the roller's direction (turbo if you hold a golden egg).
      if (n.bP) {
        if (p.cd > 0) { g.sfx('click', { vol: 0.4, pitch: 0.7 }); continue; }
        p.cd = FLIP_CD; s.dir = -s.dir; s.flash = 0.35; s.flipBy = p.i;
        g.sfx('swap'); g.sfx('whoosh', { pitch: 0.8 });
        g.ring(CX, CY, { player: p.i, r: 120 });
        const tx2 = CX + Math.cos(HOME[p.i]) * 110, ty2 = CY + Math.sin(HOME[p.i]) * 110;
        if (p.sup) {
          p.sup = false; s.turbo = TURBO_T;
          g.sfx('powerup', { pitch: 0.7 }); g.shake(0.3);
          g.text(tx2, ty2, 'TURBO!', { player: p.i, size: 64 });
        } else g.text(tx2, ty2, 'GIRA!', { player: p.i, size: 54 });
      }
    }

    // Hits: overlap or crossing of the roller through a grounded player.
    const half = (PIN_HALF + BODY_R * 0.7) / PR;
    s.arms.forEach((arm, k) => {
      for (const p of s.p) {
        const diff = wrapAngle(arm.a - p.a);
        const prev = s.prev[k][p.i];
        s.prev[k][p.i] = diff;
        if (g.ended || p.out || p.inv > 0 || jumpZ(p) >= SAFE_Z) continue;
        const crossed = Math.sign(prev) !== Math.sign(diff) && Math.abs(prev) < 1 && Math.abs(diff) < 1;
        if (Math.abs(diff) < half || crossed) this.hitPlayer(s, g, p);
      }
    });
  },

  hitPlayer(s, g, p) {
    p.lives--; p.inv = INVULN; p.hit = 0.45; p.jp = -1; p.lastHit = g.t;
    p.cd = 0; // comeback: revenge flip ready at once
    const x = CX + Math.cos(p.a) * PR, y = CY + Math.sin(p.a) * PR;
    const tp = inward(p.a, 90);
    g.sfx('squish'); g.sfx('bonk', { pitch: 0.8 });
    g.burst(x, y, { color: '#f3dca0', n: 24, speed: 300, size: 10 });
    g.burst(x, y, { player: p.i, n: 10, speed: 220 });
    g.shake(0.5); g.hitstop(0.07); g.vibrate(p.i, 160);
    if (p.lives <= 0) {
      p.out = true; p.sup = false; p.egg = null;
      const alive = s.p.filter((q) => !q.out);
      if (alive.length <= 1) {
        g.end(alive.length ? alive[0].i : p.i, 'Travolto dal rullo!');
        g.sfx('bigexplode', { vol: 0.6 }); g.slowmo(0.25, 1); g.confetti(x, y);
      } else {
        g.text(tp.x, tp.y, 'FUORI!', { player: p.i, size: 56 });
        g.sfx('bigexplode', { vol: 0.4 });
      }
    } else {
      g.text(tp.x, tp.y, 'TRAVOLTO!', { player: p.i, size: 50 });
    }
  },

  timeout(s) {
    // Most lives; then whoever was hit least recently; then fewer jumps (calmer nerves).
    const order = s.p.slice().sort((a, b) => (b.lives - a.lives) || (a.lastHit - b.lastHit) || (a.jumps - b.jumps));
    const [a, b] = order;
    if (b && a.lives === b.lives && a.lastHit === b.lastHit && a.jumps === b.jumps) return -1;
    return a.i;
  },

  view(s) {
    return {
      arms: s.arms.map((a) => r3(a.a)), dir: s.dir, st: s.stop > 0 ? 1 : 0, sd: s.sudden ? 1 : 0,
      fl: r2(s.flash), fb: s.flipBy, om: r2(s.omega), tb: r2(s.turbo),
      p: s.p.map((p) => ({
        a: r3(p.a), z: r2(jumpZ(p)), inv: r2(p.inv), h: r2(p.hit), cd: r2(p.cd / FLIP_CD), su: p.sup ? 1 : 0,
        e: p.egg ? r3(p.egg.a) : null, et: p.egg ? r1(p.egg.t) : 0, o: p.out ? 1 : 0,
      })),
      hud: { p: s.p.map((p) => p.lives), max: LIVES, label: 'Vite' },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: CX + Math.cos(p.a) * PR, y: CY + Math.sin(p.a) * PR }));
  },

  // Computer player. Times the jump so the roller passes under the middle of it (allowing for its own reaction
  // time), flips the roller away when a pass can't be jumped, and (medio/difficile) flips it back onto a rival who
  // can't react in time, chasing the golden egg for a TURBO flip.
  bot(s, me, g, B) {
    const p = s.p[me], m = B.mem, lv = B.level;
    const out = { x: 0, y: 0 };
    if (!p || p.out || g.ended) return out;
    const D = BOT_DELAY[lv];
    const jt = JUMP_T * s.jumpScale * (g.variant === 'saltone' ? 1.04 : 1);
    const moving = !(g.variant === 'stanca' && s.stop > 0);
    const air = p.jp >= 0, land = air ? (1 - p.jp) * p.jt : 0;
    const hz = HIT_HALF / Math.max(0.5, s.omega * (s.arms.length > 1 ? 0.62 : 1)) + 0.02;
    // The next two passes of a roller that the current jump (or invulnerability) doesn't cover.
    let t1 = 1e9, h1 = 0, t2 = 1e9, h2 = 0;
    if (moving) {
      for (const arm of s.arms) {
        const sp = s.omega * arm.k;
        if (sp < 1e-3) continue;
        const hk = HIT_HALF / sp + 0.02;
        for (let t = botArrival(s, [arm], s.dir, p.a), n = 0; n < 2; n++, t += TWO_PI / sp) {
          if (botCovered(p, t, hk)) continue;
          if (t < t1) { t2 = t1; h2 = h1; t1 = t; h1 = hk; } else if (t < t2) { t2 = t; h2 = hk; }
        }
      }
    }
    const tA = t1;
    const start = air ? Math.max(D, land + 1 / 60) : D;          // earliest take-off of a new jump
    const doomed = t1 < 1e8 && t1 - h1 < start + LIFT * jt;
    const pending = m.jumpAt !== undefined && g.t < m.jumpAt + D + 0.02;

    // Jump: take off so the pass falls in the middle of the airtime (or both passes, if they are close
    // together; otherwise early enough to land and jump again for the second one).
    if (t1 < 1e8 && !pending && p.hit <= 0 && (!air || land < D - 0.03)) {
      const lo1 = t1 + h1 - (1 - LIFT) * jt, hi1 = t1 - h1 - LIFT * jt;
      let ts = (lo1 + hi1) / 2;
      if (t2 < 1e8) {
        const lo = Math.max(lo1, t2 + h2 - (1 - LIFT) * jt), hi = Math.min(hi1, t2 - h2 - LIFT * jt);
        if (lo <= hi) ts = (lo + hi) / 2;
        else ts = Math.max(lo1, Math.min(ts, t2 - h2 - LIFT * jt - jt - 0.06));
      }
      if (ts <= D + 0.5 / 60) { out.tapA = true; m.jumpAt = g.t; }
    }

    // Flip.
    if (p.cd <= 0 && !(m.flipAt > g.t - D - 0.1)) {
      let flip = false;
      if (lv > 0 && doomed && tA > D + 0.02) flip = this.botFlipSafe(s, me, D, jt, hz); // can't jump it: send it away
      else if (lv > 0 && !moving && this.botStopNear(s, p) < 0.45) flip = true; // the mule stopped right next to me
      else if (lv > 0) flip = this.botAttack(s, me, D, jt, hz, lv);
      else if (B.rng() < 0.004 && !doomed) flip = true;                      // the easy bot flips at random
      if (flip) { out.tapB = true; m.flipAt = g.t; }
    }

    // Move: grab the golden egg; with the mule stopped, step away from a roller parked next to me.
    let goal = null;
    if (!moving && this.botStopNear(s, p) < 0.6) goal = p.a + s.dir * 0.4;
    else if (lv > 0 && p.egg && !p.sup && p.egg.t > Math.abs(wrapAngle(p.egg.a - p.a)) / (MOVE_SPEED * 0.8)) goal = p.egg.a;
    if (goal !== null) {
      const tgt = HOME[me] + clamp(wrapAngle(goal - HOME[me]), -MOVE_RANGE, MOVE_RANGE);
      const k = clamp(wrapAngle(tgt - p.a) * 8, -1, 1);
      out.x = -Math.sin(p.a) * k; out.y = Math.cos(p.a) * k;
    }
    return out;
  },

  // Angular distance from p to a stopped roller coming toward it (in the current direction).
  botStopNear(s, p) {
    let best = 9;
    for (const arm of s.arms) {
      const d = wrapAngle(arm.a - p.a);
      const travel = s.dir > 0 ? (d <= 0 ? -d : TWO_PI - d) : (d >= 0 ? d : TWO_PI + d);
      best = Math.min(best, travel);
    }
    return best;
  },

  // After a flip landing in D seconds, can I still jump every roller coming back at me?
  botFlipSafe(s, me, D, jt, hz) {
    const p = s.p[me], om = s.omega, wNew = p.sup ? Math.min(OMEGA_MAX, om * TURBO_K) : om;
    const land = p.jp >= 0 ? (1 - p.jp) * p.jt - D : 0;
    for (const arm of s.arms) {
      const a = arm.a + (s.stop > 0 ? 0 : s.dir * om * arm.k * D);
      const t = botArrival(s, [{ a, k: arm.k }], -s.dir, p.a, wNew);
      if (botCovered(p, t + D, hz)) continue;
      if (t - hz < Math.max(D, land + 0.03) + LIFT * jt + 0.03) return false;
    }
    return true;
  },

  // Would flipping now (it lands after D) roll the roller onto a rival who can't jump it in time?
  botAttack(s, me, D, jt, hz, lv) {
    const R = lv === 2 ? 0.24 : 0.33;                  // how fast a rival is assumed to react to the flip
    if (s.stop > 0 || !this.botFlipSafe(s, me, D, jt, hz)) return false;
    const om = s.omega, wNew = s.p[me].sup ? Math.min(OMEGA_MAX, om * TURBO_K) : om;
    // Where the arms will be when the flip lands.
    const arms = s.arms.map((arm) => ({ a: arm.a + s.dir * om * arm.k * D, k: arm.k }));
    let gain = false;
    for (const q of s.p) {
      if (q.out || q.i === me) continue;
      // Don't rescue somebody the roller is about to reach anyway.
      const tNow = botArrival(s, s.arms, s.dir, q.a);
      if (tNow > D && tNow < D + 0.4 && q.inv < tNow && !botCovered(q, tNow, hz)) return false;
      const t = botArrival(s, arms, -s.dir, q.a, wNew);
      if (q.inv > D + t + hz || botCovered(q, D + t, hz)) continue;
      const landQ = q.jp >= 0 ? (1 - q.jp) * q.jt - D : 0;
      if (t - hz < Math.max(R, landQ + 0.02) + LIFT * jt) gain = true;
    }
    return gain;
  },

  // ---------- 3D: a threshing floor among wheat fields and windmills at sunset ----------
  render3d: {
    assets: [
      'medieval/building_windmill_yellow', 'medieval/building_windmill_red', 'medieval/building_grain', 'medieval/fence_wood_straight',
      'medieval/fence_wood_straight_gate', 'medieval/trees_A_medium', 'medieval/trees_B_large', 'medieval/tree_single_A', 'medieval/tree_single_B',
      'medieval/building_home_A_yellow', 'medieval/building_home_B_red', 'medieval/building_barracks_yellow', 'medieval/building_well_yellow',
      'medieval/building_watermill_yellow', 'medieval/hills_A_trees', 'medieval/hills_B', 'medieval/mountain_A_grass_trees', 'medieval/mountain_B_grass',
      'medieval/sack', 'medieval/wheelbarrow', 'medieval/crate_A_small', 'medieval/barrel', 'medieval/bucket_water', 'medieval/flag_yellow',
      'medieval/rock_single_B', 'medieval/cloud_big', 'medieval/cloud_small', 'chars/Skeleton_Minion',
    ],
    build(K, r) {
      const TOP = 34, JH = 165;
      const N = Math.max(2, Math.min(4, r.n || K.n || 2));
      const o = { TOP, JH, spin: [], clouds: [] };
      K.theme('tramonto', { fogNear: 1.6, fogFar: 4.2 });
      K.ground('prato', { tile: 190, margin: 1700, color: '#e9d9a0' });
      buildFarm(K, o);
      // The threshing floor: a stone-rimmed round platform with the trampled earth painted on top.
      o.edgeMat = K.texMat('pietra', [10, 1], { color: '#d8c8b0' });
      o.table = K.cyl(TABLE_R + 22, TOP, o.edgeMat, { seg: 72 });
      K.place(o.table, CX, CY);
      K.layer({
        x0: CX - TABLE_R - 30, y0: CY - TABLE_R - 30, x1: CX + TABLE_R + 30, y1: CY + TABLE_R + 30, h: TOP + 0.5, transparent: true,
        draw: (d, v) => drawAia(d, v, N),
        key: (v) => `${v.sd}|${v.tb > 0 ? Math.floor(K.t * 12) % 2 : -1}|${v.p.map((p) => p.o).join('')}`,
      });
      o.rimGlow = K.torus(TABLE_R + 22, 4, K.glow('#ff3b3b', { add: true }), { cast: false });
      K.place(o.rimGlow, CX, CY, TOP);
      // Stone threshing rollers: pivot group (faces the arm angle) -> roll group (spins on its axis) -> parts.
      const beamMat = K.mat('#6b4423', { rough: 0.8 });
      const ironMat = K.mat('#4a4a52', { rough: 0.45, metal: 0.6 });
      const ridgeMat = K.mat('#8d877e', { rough: 0.9 });
      const L = PIN_LEN - 110;
      o.pins = [0, 1].map((k) => {
        const g = K.group();
        const roll = K.group(g);
        const bodyMat = K.texMat('pietra', [3, 1], { color: k ? '#b9b0a2' : '#d9d0c0', rough: 0.9 });
        const body = K.cyl(PIN_HALF, L, bodyMat, { center: true, seg: 28, parent: roll });
        body.rotation.z = Math.PI / 2; body.position.x = 55 + L / 2;
        for (let q = 0; q < 8; q++) {
          const a = (q / 8) * Math.PI * 2;
          const st = K.box(L - 10, 6, 6, ridgeMat, { parent: roll, cast: false });
          st.position.set(55 + L / 2, Math.sin(a) * (PIN_HALF - 1), Math.cos(a) * (PIN_HALF - 1));
          st.rotation.x = -a;
        }
        for (const x0 of [55, 55 + L - 8]) { const band = K.cyl(PIN_HALF + 3, 8, ironMat, { center: true, seg: 28, parent: roll }); band.rotation.z = Math.PI / 2; band.position.x = x0 + 4; }
        for (const [x0, len] of [[8, 50], [PIN_LEN - 58, 54]]) {
          const hd = K.cyl(11, len, beamMat, { center: true, seg: 12, parent: roll });
          hd.rotation.z = Math.PI / 2; hd.position.x = x0 + len / 2;
        }
        const knob = K.ball(15, ironMat, { parent: roll }); knob.position.x = PIN_LEN - 2;
        // The wooden frame dragging the roller (does not spin): two side beams.
        for (const s of [1, -1]) { const fb = K.box(PIN_LEN - 30, 8, 10, beamMat, { parent: g }); fb.position.set(PIN_LEN / 2, PIN_HALF + 6, s * (PIN_HALF + 7)); }
        // Direction arrows on the leading side (flipped with scale.z = dir).
        const arrows = K.group(g);
        for (const tip of [PIN_LEN - 120, 200]) {
          K.prism([tip - 22, PIN_HALF + 12, tip + 22, PIN_HALF + 12, tip, PIN_HALF + 44], 3, K.glow('#ffffff'), { parent: arrows, cast: false });
        }
        arrows.position.y = -PIN_HALF + 1.5;
        // Motion ghosts behind the roller.
        const ghosts = [1, 2].map(() => {
          const gg = K.group();
          const m = K.glow('#fff0d2', { opacity: 0.16, add: true, unique: true });
          const c = K.cyl(PIN_HALF, L, m, { center: true, seg: 16, parent: gg, cast: false });
          c.rotation.z = Math.PI / 2; c.position.x = 55 + L / 2;
          return { g: gg, m };
        });
        return { g, roll, bodyMat, arrows, ghosts };
      });
      // Pivot: a stone hub with the skeleton farmer standing on it, pushing the beam around.
      const hubM = K.texMat('pietra', [3, 1], { color: '#a89c8a' });
      K.place(K.cyl(48, 2 * PIN_HALF + 26, hubM, { seg: 28 }), CX, CY, TOP);
      K.place(K.cyl(54, 8, K.mat('#5a3a20', { rough: 0.8 }), { seg: 28 }), CX, CY, TOP + 2 * PIN_HALF + 26);
      const roster = K.roster;
      K.roster = [...roster, { char: 'skminion', color: 3 }];
      o.farmer = K.avatar(roster.length, { blob: false });
      K.roster = roster;
      o.faces = ['\u{1F468}\u{200D}\u{1F33E}', '\u{1F621}', '\u{1F634}'].map((e) => K.emoji(e, 70));
      // Golden eggs (one per player).
      const eggM = K.mat('#ffd23f', { rough: 0.25, metal: 0.55, emissive: '#b07a00', ei: 0.35 });
      o.eggs = Array.from({ length: N }, (_, i) => ({
        egg: K.ball(1, eggM, { seg: 20 }),
        glow: K.disc(1, K.glow(K.col(i, 'light'), { opacity: 0.5, add: true })),
      }));
      // Players (avatars live on the floor top: h = jump height).
      o.pl = Array.from({ length: N }, (_, i) => {
        const base = K.group();
        K.place(base, 0, 0, TOP);
        return {
          av: K.avatar(i, { parent: base }),
          aura: K.torus(1, 0.09, K.glow('#ffd23f', { add: true, opacity: 0.85 }), { cast: false }),
          dizzy: K.emoji('\u{1F4AB}', 46),
          ghost: K.emoji('\u{1F47B}', 50),
          dec: K.decal(240, { h: TOP + 1 }),
        };
      });
      return o;
    },
    update(K, o, v) {
      const { TOP, JH } = o;
      const t = K.t;
      o.rimGlow.visible = !!v.sd;
      if (v.sd) o.rimGlow.material.opacity = 0.6 + 0.4 * Math.sin(t * 10);
      const turbo = v.tb > 0;
      o.pins.forEach((P, k) => {
        const a = v.arms[k];
        const on = a !== undefined;
        P.g.visible = on;
        for (const gh of P.ghosts) gh.g.visible = on && !v.st;
        if (!on) return;
        const hc = TOP + PIN_HALF;
        K.place(P.g, CX, CY, hc); K.face(P.g, a);
        P.roll.rotation.x = -a * (PR / PIN_HALF);
        P.arrows.scale.z = v.dir;
        // Flash in the flipper's color, glow orange in turbo.
        if (v.fl > 0 && v.fb >= 0) { P.bodyMat.emissive.set(K.col(v.fb, 'light')); P.bodyMat.emissiveIntensity = 0.4 + v.fl; }
        else if (turbo) { P.bodyMat.emissive.set('#ff7a1a'); P.bodyMat.emissiveIntensity = 0.35 + 0.25 * Math.sin(t * 24); }
        else P.bodyMat.emissiveIntensity = 0;
        if (!v.st) {
          const trail = clamp(v.om * 0.08, 0.08, 0.5) * (k === 1 ? 0.62 : 1);
          P.ghosts.forEach((gh, q) => {
            K.place(gh.g, CX, CY, hc); K.face(gh.g, a - v.dir * trail * ((q + 1) / 2.5));
            gh.m.color.set(turbo ? '#ff9a3c' : '#fff0d2');
            gh.m.opacity = (turbo ? 0.3 : 0.16) - q * 0.06;
          });
        }
      });
      // The farmer on the hub turns with the roller.
      const a0 = v.arms[0] ?? 0;
      const fh = TOP + 2 * PIN_HALF + 34;
      const angry = v.sd || turbo;
      o.farmer.set(CX, CY, { r: 34, h: fh, look: a0 + v.dir * Math.PI / 2, marker: false, gear: false,
        anim: v.st ? 'Idle' : angry ? 'Running_A' : 'Walking_A', animSpeed: v.st ? 1 : clamp(v.om / 3, 0.6, 1.8) });
      const face = v.st ? 2 : angry ? 1 : 0;
      o.faces.forEach((f, k) => { f.visible = k === face; if (k === face) K.place(f, CX, CY, fh + 150 + Math.sin(t * 3) * 6); });
      // Windmill sails and the watermill wheel.
      for (const sp of o.spin) sp.node.rotation.z = t * sp.w;
      for (const c of o.clouds) { const x = ((c.x + t * c.v + 3000) % 6000) - 2000; K.place(c.g, x, c.y, c.h); }
      v.p.forEach((p, i) => {
        const P = o.pl[i], E = o.eggs[i];
        if (!P) return;
        // Egg.
        E.egg.visible = E.glow.visible = p.e !== null;
        if (p.e !== null) {
          const x = CX + Math.cos(p.e) * PR, y = CY + Math.sin(p.e) * PR;
          const wob = p.et < 1.2 ? Math.sin(t * 30) * 0.25 : Math.sin(t * 4) * 0.1;
          K.place(E.egg, x, y, TOP + 26 + Math.abs(Math.sin(t * 5)) * 6); E.egg.scale.set(21, 27, 21); E.egg.rotation.set(wob, t * 2, wob * 0.6);
          K.place(E.glow, x, y, TOP + 1); E.glow.scale.setScalar(40 + Math.sin(t * 6) * 4);
        }
        // Player.
        const x = CX + Math.cos(p.a) * PR, y = CY + Math.sin(p.a) * PR, z = p.z;
        const look = Math.atan2(CY - y, CX - x);
        if (p.o) {
          // Out: lies on the floor as a translucent ghost.
          P.av.set(x, y, { r: BODY_R, h: 0, look, mood: 'dead', alpha: 0.45, marker: false });
          P.aura.visible = P.dizzy.visible = false;
          P.ghost.visible = true;
          K.place(P.ghost, x, y, TOP + 90 + Math.sin(t * 2 + i) * 10);
          P.dec.show(false);
          return;
        }
        P.ghost.visible = false;
        let danger = false;
        if (!v.st) v.arms.forEach((a, k) => {
          const ahead = wrapAngle(p.a - a) * v.dir;
          if (ahead > 0 && ahead < v.om * (k === 1 ? 0.62 : 1) * 0.45) danger = true;
        });
        const blink = p.inv > 0 && Math.floor(t * 14) % 2 === 0;
        const mood = p.h > 0.25 ? 'hurt' : p.h > 0 || p.inv > 0.6 ? 'dizzy' : danger && z < SAFE_Z ? 'scared' : 'ok';
        const squash = p.h > 0 ? 0.3 : 0;
        const hh = z * JH;
        P.av.set(x, y, { r: BODY_R, h: hh, look, mood, squash, alpha: blink ? 0.35 : 1, anim: z > 0.05 ? 'Jump_Idle' : undefined });
        P.aura.visible = !!p.su;
        if (p.su) { K.place(P.aura, x, y, TOP + hh + BODY_R); P.aura.scale.setScalar(BODY_R * 1.45 + Math.sin(t * 10) * 4); P.aura.rotation.x = Math.sin(t * 3) * 0.3; }
        P.dizzy.visible = p.h > 0.25;
        if (p.h > 0.25) K.place(P.dizzy, x, y, TOP + BODY_R * 3 + 30);
        const warn = danger && z < SAFE_Z && p.inv <= 0;
        P.dec.show(true).at(x, y).paint((d) => {
          if (warn) {
            const on = Math.floor(t * 12) % 2;
            d.circle(0, 0, BODY_R + 20, on ? 'rgba(255,59,59,0.45)' : 'rgba(255,211,107,0.3)');
            d.ring(0, 0, BODY_R + 20, on ? '#ff3b3b' : '#ffd36b', 7);
          }
          const rc = p.su ? '#ffd23f' : d.col(i, 'light');
          if (p.cd <= 0) d.ring(0, 0, BODY_R + 34, rc + 'ee', 7);
          else d.arc(0, 0, BODY_R + 34, -Math.PI / 2, -Math.PI / 2 + (1 - p.cd) * Math.PI * 2, rc + '99', 7);
        });
      });
    },
  },

  render(d, v, r) {
    const { ctx } = d;
    drawFloor(d);
    drawTable(d, v);
    // Eggs.
    v.p.forEach((p, i) => {
      if (p.e === null) return;
      const x = CX + Math.cos(p.e) * PR, y = CY + Math.sin(p.e) * PR;
      const wob = p.et < 1.2 ? Math.sin(d.t * 30) * 0.2 : Math.sin(d.t * 4) * 0.08;
      d.shadow(x + 6, y + 8, 22, 12, 0.3);
      ctx.save(); ctx.translate(x, y); ctx.rotate(wob);
      d.circle(0, 0, 40, 'rgba(255,210,63,0.25)');
      ctx.scale(1, 1.25);
      d.circle(0, 0, 22, '#ffd23f', d.col(i, 'light'), 4);
      ctx.restore();
    });

    // Rollers (shadow, motion trail, body, handles).
    const drawPin = (a, k) => {
      const moving = !v.st;
      if (moving) {
        const trail = clamp(v.om * 0.08, 0.08, 0.5) * (k === 1 ? 0.62 : 1);
        for (let q = 1; q <= 3; q++) {
          const ta = a - v.dir * trail * (q / 3);
          ctx.save(); ctx.translate(CX, CY); ctx.rotate(ta);
          d.rrect(40, -PIN_HALF, PIN_LEN - 100, PIN_HALF * 2, PIN_HALF, v.tb > 0 ? `rgba(255,170,60,${0.3 - q * 0.07})` : `rgba(255,240,210,${0.18 - q * 0.05})`);
          ctx.restore();
        }
      }
      ctx.save(); ctx.translate(CX + 12, CY + 18); ctx.rotate(a);
      d.rrect(30, -PIN_HALF, PIN_LEN - 40, PIN_HALF * 2, PIN_HALF, 'rgba(0,0,0,0.28)');
      ctx.restore();
      ctx.save(); ctx.translate(CX, CY); ctx.rotate(a);
      const body = k === 1 ? '#b9b0a2' : '#d9d0c0';
      const edge = v.fl > 0 && v.fb >= 0 ? d.col(v.fb, 'light') : '#5a5048';
      d.rrect(10, -11, 50, 22, 11, '#6b4423');
      d.rrect(55, -PIN_HALF, PIN_LEN - 110, PIN_HALF * 2, PIN_HALF, body, edge, v.fl > 0 ? 8 : 4);
      d.rrect(60, -PIN_HALF + 6, PIN_LEN - 120, 10, 5, 'rgba(255,255,255,0.3)');
      d.rrect(PIN_LEN - 60, -11, 60, 22, 11, '#6b4423');
      for (let q = 0; q < 4; q++) d.line(110 + q * 80, -PIN_HALF + 6, 110 + q * 80, PIN_HALF - 6, 'rgba(60,50,40,0.3)', 3);
      // Direction arrows on the leading side.
      for (const tip of [PIN_LEN - 120, 200]) d.poly([tip, v.dir * (PIN_HALF + 8), tip - 22, v.dir * (PIN_HALF + 30), tip + 22, v.dir * (PIN_HALF + 30)], '#fff');
      ctx.restore();
    };
    v.arms.forEach((a, k) => drawPin(a, k));
    // Pivot: the stone hub with the farmer.
    d.circle(CX, CY, 40, '#a89c8a', '#5a3a20', 4);
    if (v.st) d.emoji('😴', CX, CY, 52);
    else if (v.sd || v.tb > 0) d.emoji('😡', CX, CY, 48);
    else d.emoji('👨‍🌾', CX, CY, 48);

    // Players.
    v.p.forEach((p, i) => {
      const x = CX + Math.cos(p.a) * PR, y = CY + Math.sin(p.a) * PR;
      if (p.o) { d.avatar(x, y, BODY_R, i, { look: Math.atan2(CY - y, CX - x), mood: 'dead', alpha: 0.35 }); return; }
      const z = p.z;
      // Danger warning: roller about to reach a grounded player.
      let danger = false;
      if (!v.st) v.arms.forEach((a, k) => {
        const ahead = wrapAngle(p.a - a) * v.dir;
        if (ahead > 0 && ahead < v.om * (k === 1 ? 0.62 : 1) * 0.45) danger = true;
      });
      d.shadow(x + z * 25, y + z * 30, BODY_R * (1 - z * 0.25), BODY_R * 0.6 * (1 - z * 0.25), 0.35 - z * 0.12);
      if (danger && z < SAFE_Z && p.inv <= 0) {
        d.circle(x, y, BODY_R + 18, Math.floor(d.t * 12) % 2 ? 'rgba(255,59,59,0.35)' : 'rgba(255,211,107,0.25)');
        d.ring(x, y, BODY_R + 18, Math.floor(d.t * 12) % 2 ? '#ff3b3b' : '#ffd36b', 6);
      }
      const blink = p.inv > 0 && Math.floor(d.t * 14) % 2 === 0;
      const mood = p.h > 0.25 ? 'dead' : p.h > 0 || p.inv > 0.6 ? 'dizzy' : danger && z < SAFE_Z ? 'scared' : z > 0.2 ? 'happy' : 'ok';
      const squash = p.h > 0 ? 0.4 : z > 0 ? -0.15 * z : 0;
      if (p.su) d.circle(x, y - z * 18, BODY_R * 1.5 + Math.sin(d.t * 10) * 4, 'rgba(255,210,63,0.35)');
      d.avatar(x, y - z * 18, BODY_R * (1 + z * 0.35), i, { look: Math.atan2(CY - y, CX - x), mood, squash, alpha: blink ? 0.35 : 1 });
      if (p.h > 0.25) d.emoji('💫', x, y - 60, 40);
      // Flip cooldown ring (full = ready, gold = turbo ready).
      const ready = p.cd <= 0;
      const rc = p.su ? '#ffd23f' : d.col(i, 'light');
      if (ready) d.ring(x, y, BODY_R + 26, rc + 'dd', 5);
      else d.arc(x, y, BODY_R + 26, -Math.PI / 2, -Math.PI / 2 + (1 - p.cd) * Math.PI * 2, rc + '77', 5);
    });
  },
};

// Grass around the threshing floor (2D fallback).
function drawFloor(d, m = 300) {
  const { ctx } = d;
  ctx.fillStyle = '#7a9a3a';
  ctx.fillRect(-m, -m, W + m * 2, H + m * 2);
  for (let k = 0; k < 60; k++) d.circle(((k * 7919) % (W + 2 * m)) - m, ((k * 3571) % (H + 2 * m)) - m, 30 + (k % 4) * 12, k % 2 ? '#86a840' : '#6e8e32');
}

// Threshing floor (2D fallback): packed earth, straw, home arcs.
function drawTable(d, v) {
  d.circle(CX + 14, CY + 22, TABLE_R + 24, 'rgba(0,0,0,0.35)');
  d.circle(CX, CY, TABLE_R + 22, v.sd ? '#7a3a2a' : '#8d877e', '#4a443d', 4);
  d.circle(CX, CY, TABLE_R, '#c9a46a');
  for (let k = 1; k <= 5; k++) d.ring(CX, CY, TABLE_R * (k / 5.6), 'rgba(110,80,40,0.18)', 3);
  d.circle(CX, CY, 170, '#e2c47a');
  if (v.sd) d.neon(() => d.ring(CX, CY, TABLE_R + 20, '#ff3b3b', 5), '#ff3b3b');
  if (v.tb > 0) d.ring(CX, CY, TABLE_R + 6, Math.floor(d.t * 12) % 2 ? '#ffd23f' : '#ff7a1a', 10);
  v.p.forEach((p, i) => {
    const a0 = HOME[i];
    d.arc(CX, CY, PR, a0 - MOVE_RANGE, a0 + MOVE_RANGE, d.col(i) + (p.o ? '22' : '66'), 14);
    d.arc(CX, CY, PR, a0 - MOVE_RANGE, a0 + MOVE_RANGE, d.col(i, 'light') + '33', 4);
  });
}

// The threshing floor top in 3D: trampled earth, straw, worn ring, golden chaff, home arcs.
function drawAia(d, v, N) {
  const { ctx } = d;
  d.circle(CX, CY, TABLE_R + 22, v.sd ? '#8a3a28' : '#9a8f80', '#4a443d', 4);
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    d.circle(CX + Math.cos(a) * (TABLE_R + 11), CY + Math.sin(a) * (TABLE_R + 11), 9, k % 2 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.1)');
  }
  const earth = ctx.createRadialGradient(CX - 120, CY - 140, 60, CX, CY, TABLE_R);
  earth.addColorStop(0, '#d9b47a');
  earth.addColorStop(1, '#b48a52');
  ctx.fillStyle = earth;
  ctx.beginPath(); ctx.arc(CX, CY, TABLE_R, 0, Math.PI * 2); ctx.fill();
  // Worn track of the roller and scattered straw.
  d.ring(CX, CY, PR - 70, 'rgba(120,85,45,0.22)', 60);
  d.ring(CX, CY, 220, 'rgba(120,85,45,0.15)', 40);
  for (let k = 0; k < 160; k++) {
    const a = k * 2.399, rr = 60 + ((k * 97) % (TABLE_R - 70));
    const x = CX + Math.cos(a) * rr, y = CY + Math.sin(a) * rr, ang = k * 1.7;
    d.line(x, y, x + Math.cos(ang) * 16, y + Math.sin(ang) * 16, k % 3 ? 'rgba(255,226,140,0.75)' : 'rgba(200,150,70,0.6)', 3);
  }
  d.circle(CX, CY, 150, 'rgba(240,210,120,0.55)');
  for (let k = 0; k < 40; k++) {
    const a = k * 2.1, rr = (k * 13) % 140;
    d.circle(CX + Math.cos(a) * rr, CY + Math.sin(a) * rr, 5, 'rgba(255,236,170,0.8)');
  }
  if (v.sd) d.ring(CX, CY, TABLE_R - 4, '#ff3b3b', 6);
  if (v.tb > 0) d.ring(CX, CY, TABLE_R - 8, Math.floor(d.t * 12) % 2 ? '#ffd23f' : '#ff7a1a', 10);
  for (let i = 0; i < N; i++) {
    const a0 = HOME[i], out = v.p[i] && v.p[i].o;
    d.arc(CX, CY, PR, a0 - MOVE_RANGE, a0 + MOVE_RANGE, d.col(i) + (out ? '30' : '99'), 16);
    d.arc(CX, CY, PR, a0 - MOVE_RANGE, a0 + MOVE_RANGE, d.col(i, 'light') + (out ? '20' : '66'), 5);
  }
}

// Farmland scenery: wheat fields, windmills, farmhouses, fences, haystacks, hills and drifting clouds.
function buildFarm(K, o) {
  const rnd = mulberry(77);
  const far = K.quality > 0;
  // Wooden fence ring around the threshing floor with four gates.
  const fence = [], gates = [];
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2 + Math.PI / 32;
    const item = { x: CX + Math.cos(a) * 560, y: CY + Math.sin(a) * 560, rot: a };
    (k % 8 === 3 ? gates : fence).push(item);
  }
  K.scatter('medieval/fence_wood_straight', fence, { size: 112 });
  K.scatter('medieval/fence_wood_straight_gate', gates, { size: 112 });
  // Wheat fields: rings of hex patches beyond the fence.
  const wheat = [];
  // Fields = clusters of patches (gaps of grass between them).
  for (const [fx, fy] of [[-420, 650], [-480, 1150], [1420, 520], [1450, 1100], [200, 1520], [900, 1560], [-650, -50], [1650, -150]]) {
    for (let k = 0; k < (far ? 7 : 4); k++) {
      const a = (k / 6) * Math.PI * 2, R = k ? 175 : 0;
      wheat.push({ x: fx + Math.cos(a) * R, y: fy + Math.sin(a) * R * 0.87, rot: Math.PI / 6, s: 1 });
    }
  }
  K.scatter('medieval/building_grain', wheat, { size: 230 });
  // Farmyard behind the floor: barn, houses, well, watermill.
  const put = (name, x, y, size, face) => { const g = K.model(name, { size }); K.place(g, x, y); K.face(g, face ?? Math.atan2(CY - y, CX - x)); return g; };
  put('medieval/building_barracks_yellow', CX - 40, -360, 300, Math.PI / 2);
  put('medieval/building_home_A_yellow', CX - 330, -250, 200);
  put('medieval/building_home_B_red', CX + 300, -270, 200);
  put('medieval/building_well_yellow', CX + 150, -180, 110);
  put('medieval/flag_yellow', CX - 170, -190, 70);
  const wm = put('medieval/building_watermill_yellow', -520, 300, 300, 0);
  const wheel = wm.getObjectByName('building_watermill_wheel_yellow');
  if (wheel) o.spin.push({ node: wheel, w: -0.8 });
  if (K.tex('acqua')) K.water(-760, -900, -620, 1900, { kind: 'acqua', h: 1, flow: [0, 0.05] }); // K.water crashes without a canvas (tests)
  // Windmills with turning sails.
  for (const [name, x, y, size, w] of [['medieval/building_windmill_red', -330, -420, 330, 0.9], ['medieval/building_windmill_yellow', 1360, -260, 360, 0.7], ['medieval/building_windmill_red', 1480, 640, 300, 1.1]]) {
    const g = put(name, x, y, size);
    const fan = g.getObjectByName(name.replace('medieval/building_windmill_', 'building_windmill_top_fan_'));
    if (fan) o.spin.push({ node: fan, w });
  }
  // Haystacks (straw texture) around the fields.
  const straw = K.texMat('paglia', [2, 1], { color: '#f2d27a' }), straw2 = K.texMat('paglia', [2, 1], { color: '#e0b860' });
  for (const [x, y, s] of [[-180, 120, 1], [-230, 230, 0.8], [1180, 120, 1.1], [1230, 260, 0.8], [-160, 860, 0.9], [1170, 880, 1], [1260, 980, 0.75], [140, -140, 0.7], [860, -150, 0.8]]) {
    K.place(K.cyl(55 * s, 50 * s, straw, { seg: 16 }), x, y);
    K.place(K.cone(60 * s, 60 * s, straw2, { seg: 16 }), x, y, 50 * s);
  }
  // Farm props near the fence.
  K.scatter('medieval/sack', [{ x: 110, y: 90, rot: 0.3 }, { x: 140, y: 120, rot: 1.2 }, { x: 905, y: 905, rot: 2 }, { x: 880, y: 940, rot: 0.8 }, { x: 70, y: 930, rot: 1 }], { size: 40 });
  K.scatter('medieval/barrel', [{ x: 930, y: 90 }, { x: 960, y: 130 }, { x: 60, y: 120 }], { size: 38 });
  K.scatter('medieval/crate_A_small', [{ x: 905, y: 60, rot: 0.4 }, { x: 95, y: 960, rot: 0.2 }], { size: 40 });
  put('medieval/wheelbarrow', 950, 960, 80, -2.4);
  put('medieval/bucket_water', 40, 70, 28);
  // Trees, hills and mountains on the horizon.
  const trees = [], trees2 = [];
  for (let k = 0; k < (far ? 46 : 24); k++) {
    const a = rnd() * Math.PI * 2, R = 1500 + rnd() * 900;
    (k % 2 ? trees : trees2).push({ x: CX + Math.cos(a) * R, y: CY + Math.sin(a) * R * 0.9, rot: rnd() * 6, s: 0.8 + rnd() * 0.5 });
  }
  K.scatter('medieval/trees_A_medium', trees, { size: 230 });
  K.scatter('medieval/trees_B_large', trees2, { size: 260 });
  K.scatter('medieval/tree_single_A', [{ x: -120, y: -40 }, { x: 1110, y: -60 }, { x: 1150, y: 1040 }, { x: -110, y: 1060 }], { size: 120 });
  K.scatter('medieval/tree_single_B', [{ x: -60, y: 520 }, { x: 1080, y: 520 }], { size: 110 });
  K.scatter('medieval/rock_single_B', [{ x: 30, y: 300 }, { x: 980, y: 700, rot: 2 }, { x: 260, y: 1040, rot: 1 }], { size: 50 });
  if (far) {
    K.scatter('medieval/hills_A_trees', [{ x: -1000, y: -1300 }, { x: 600, y: -1700 }, { x: 2100, y: -1100 }], { size: 900 });
    K.scatter('medieval/mountain_A_grass_trees', [{ x: -200, y: -2300 }, { x: 1500, y: -2400, rot: 1 }], { size: 1300 });
    K.scatter('medieval/mountain_B_grass', [{ x: 2600, y: -1900 }, { x: -1700, y: -2000, rot: 2 }], { size: 1200 });
    for (const [name, x, y, h, v] of [['medieval/cloud_big', -600, -1600, 900, 30], ['medieval/cloud_small', 900, -1900, 1000, 22], ['medieval/cloud_big', 2200, -1500, 850, 26]]) {
      const g = K.model(name, { size: 600, cast: false });
      o.clouds.push({ g, x, y, h, v });
    }
  }
  // Warm braziers at the four corners of the floor.
  const iron = K.mat('#2e2a28', { rough: 0.5, metal: 0.5 });
  const fire = K.glow('#ffb03a', { add: true });
  const corners = [[CX - 400, CY - 400], [CX + 400, CY - 400], [CX - 400, CY + 400], [CX + 400, CY + 400]];
  corners.forEach(([x, y], k) => {
    K.place(K.cyl(6, 70, iron, { seg: 8 }), x, y);
    K.place(K.cyl(22, 16, iron, { r2: 12, seg: 12 }), x, y, 70);
    K.place(K.cone(15, 34, fire, { cast: false }), x, y, 82);
    if (far && k < 2) K.light(x, y, 120, '#ff9a40', 1.6, { flicker: 0.5, dist: 500 });
  });
  K.ambient('polvere', { n: 70 });
  if (far) K.ambient('lucciole', { n: 40, x0: -300, x1: 1300, y0: -300, y1: 1300 });
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
