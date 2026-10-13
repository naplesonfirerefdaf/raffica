// Carretti e Vesciche — Mario Kart style balloon battle in the village market square (top-down, dir + A).
// 2..4 carts: lose all your bladders and you are out (ghost cart), the last one with bladders wins.
import { clamp, damp, dist2, collideCircles, bounceCircleRect, angleDiff, approach, wrapAngle, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500;
const EDGE = 40;                       // inner edge of the arena fence
const KART_R = 40;
const ACC = 950, MAX_SPEED = 390, BOOST_SPEED = 720, TURN = 6.2;
// B: drift. Hold to slide and turn tighter; release after charging for a mini-turbo.
const DRIFT_TURN = 1.6, DRIFT_MIN_SPEED = 170, MT1 = 0.5, MT2 = 1.1, MT_SPEED = 600;
// Golden balloon: comeback pickup that gives +1 balloon.
const GOLD_FIRST = 12, GOLD_EVERY = 11, GOLD_R = 26;
const GOLD_SPOTS = [[500, 175], [500, 825], [180, 380], [820, 620], [400, 700], [600, 300]];
const START_B = 3, MAX_B = 5;
const SPIN_T = 0.8, INV_T = 1.2, BOOST_T = 1.4;
// Start of each seat: 0 bottom, 1 top, 2 left, 3 right (x, y, heading).
const START = [[500, 880, -Math.PI / 2], [500, 120, Math.PI / 2], [190, 500, 0], [810, 500, Math.PI]];
const GREEN_V = 600, RED_V = 470, SHELL_R = 21, BANANA_R = 23, BOX_R = 34;
const GREEN_BOUNCES = 5, MAX_FLIP_SHELLS = 6, MAX_BANANAS = 14;
const GREEN = 1, RED = 2, BANANA = 3, SHROOM = 4;

// Point symmetry around the center keeps the arena fair.
const mirrorR = ([x, y, w, h]) => [W - x - w, H - y - h, w, h];
const mirrorP = ([x, y, ...rest]) => [W - x, H - y, ...rest];
const sym = (list, fn) => list.flatMap((o) => [o, fn(o)]);

const OBST = [...sym([[175, 255, 170, 46], [655, 255, 170, 46], [85, 470, 60, 60]], mirrorR), [440, 470, 120, 60]];
const RAMPS = [[250, 560, 120, 64, 0], [630, 376, 120, 64, Math.PI]];
const BOXES = sym([[500, 330], [300, 500], [180, 820]], mirrorP);
// Flipper arena: round bumpers + corner slingshots instead of blocks.
const BUMPERS = [[500, 500, 58], ...sym([[300, 330, 40], [700, 330, 40]], mirrorP)];
const BEVELS = [[EDGE, 220, 220, EDGE], [W - EDGE, 780, 780, H - EDGE], [780, EDGE, W - EDGE, 220], [220, H - EDGE, EDGE, 780]];

// Circle vs static segment: push out and reflect. Returns true on contact.
function collideSeg(o, ax, ay, bx, by, rest) {
  const vx = bx - ax, vy = by - ay;
  const t = clamp(((o.x - ax) * vx + (o.y - ay) * vy) / (vx * vx + vy * vy), 0, 1);
  const dx = o.x - (ax + vx * t), dy = o.y - (ay + vy * t);
  const d = Math.hypot(dx, dy);
  if (d >= o.r || d < 1e-6) return false;
  const nx = dx / d, ny = dy / d;
  o.x += nx * (o.r - d); o.y += ny * (o.r - d);
  const vn = o.vx * nx + o.vy * ny;
  if (vn < 0) { o.vx -= (1 + rest) * vn * nx; o.vy -= (1 + rest) * vn * ny; }
  return true;
}

// Collide a circle with fence, blocks/bevels and bumpers. Returns 0 none, 1 wall, 2 bumper.
function collideWorld(s, o, rest, kick) {
  let hit = 0;
  if (o.x < EDGE + o.r) { o.x = EDGE + o.r; if (o.vx < 0) o.vx = -o.vx * rest; hit = 1; }
  if (o.x > W - EDGE - o.r) { o.x = W - EDGE - o.r; if (o.vx > 0) o.vx = -o.vx * rest; hit = 1; }
  if (o.y < EDGE + o.r) { o.y = EDGE + o.r; if (o.vy < 0) o.vy = -o.vy * rest; hit = 1; }
  if (o.y > H - EDGE - o.r) { o.y = H - EDGE - o.r; if (o.vy > 0) o.vy = -o.vy * rest; hit = 1; }
  if (!s.flip) {
    for (const R of OBST) if (bounceCircleRect(o, R[0], R[1], R[2], R[3], rest)) hit = 1;
    return hit;
  }
  for (const B of BEVELS) if (collideSeg(o, B[0], B[1], B[2], B[3], Math.max(rest, 0.8))) hit = 1;
  for (let j = 0; j < BUMPERS.length; j++) {
    const [bx, by, br] = BUMPERS[j];
    const dx = o.x - bx, dy = o.y - by, d = Math.hypot(dx, dy), min = br + o.r;
    if (d >= min || d < 1e-6) continue;
    const nx = dx / d, ny = dy / d;
    o.x = bx + nx * min; o.y = by + ny * min;
    const vn = o.vx * nx + o.vy * ny;
    if (vn < 0) { o.vx -= 2 * vn * nx; o.vy -= 2 * vn * ny; }
    const vn2 = o.vx * nx + o.vy * ny;
    if (kick && vn2 < kick) { o.vx += (kick - vn2) * nx; o.vy += (kick - vn2) * ny; }
    s.bl[j] = 0.3;
    hit = 2;
  }
  return hit;
}

function insideBlock(s, x, y, pad) {
  if (x < EDGE + pad || x > W - EDGE - pad || y < EDGE + pad || y > H - EDGE - pad) return true;
  if (s.flip) return BUMPERS.some(([bx, by, br]) => dist2(x, y, bx, by) < (br + pad) ** 2);
  return OBST.some(([rx, ry, rw, rh]) => x > rx - pad && x < rx + rw + pad && y > ry - pad && y < ry + rh + pad);
}

const sizeF = (s, k) => (s.elio ? Math.max(0.5, 1 - 0.16 * k.lost) : 1);
const speedF = (s, k) => (s.elio ? 1 + 0.2 * k.lost : 1);

function hit(s, g, k, by, how) {
  if (k.inv > 0 || g.ended) return false;
  k.b = Math.max(0, k.b - 1);
  k.lost++;
  k.spin = SPIN_T; k.inv = INV_T; k.boost = 0; k.mt = 0; k.drift = 0; k.dch = 0;
  k.vx *= 0.3; k.vy *= 0.3;
  k.r = k.base * sizeF(s, k);
  if (by >= 0 && by !== k.i) s.lastHit = by;
  g.sfx('pop'); g.sfx(how === 'banana' || how === 'sky' ? 'slide' : 'crash', { vol: 0.8 });
  g.burst(k.x, k.y, { player: k.i, n: 22, speed: 340, size: 9 });
  g.shake(0.4); g.hitstop(0.05); g.vibrate(k.i, 160);
  if (by === k.i) { k.self++; g.say(g.rng.pick(['AUTOGOL!', 'COLPITO DA SOLO!', 'GENIO!'])); }
  if (k.b <= 0) {
    k.out = 0.001; k.item = 0; k.roll = 0; k.drift = 0; k.boost = 0; k.mt = 0;
    g.confetti(k.x, k.y);
    const alive = s.k.filter((q) => !q.out);
    if (alive.length <= 1) {
      g.sfx('bigexplode'); g.slowmo(0.3, 0.9); g.flash('#fff', 0.5);
      g.end(alive.length ? alive[0].i : -1, by === k.i ? 'Si è scoppiato da solo!' : 'Tutte le vesciche scoppiate!');
    } else {
      g.sfx('explode'); g.shake(0.5); g.say('ELIMINATO!');
      g.text(k.x, k.y - 60, '💀', { player: k.i, size: 56 });
    }
  } else {
    g.text(k.x, k.y - 60, 'POP!', { player: k.i, size: 46 });
    if (s.elio) { g.sfx('shrink'); }
  }
  return true;
}

function useItem(s, g, k) {
  const fx = Math.cos(k.a), fy = Math.sin(k.a);
  const it = k.item;
  k.item = 0;
  if (it === GREEN || it === RED) {
    const d = k.r + SHELL_R + 4, v = it === GREEN ? GREEN_V : RED_V;
    s.sh.push({ id: s.nid++, t: it, x: k.x + fx * d, y: k.y + fy * d, vx: fx * v, vy: fy * v, r: SHELL_R, o: k.i, gr: 0.3, n: 0, life: 0 });
    g.sfx('shoot', { pitch: it === RED ? 0.8 : 1.1 });
  } else if (it === BANANA) {
    const d = k.r + BANANA_R + 6;
    s.bn.push({ id: s.nid++, x: clamp(k.x - fx * d, EDGE + 20, W - EDGE - 20), y: clamp(k.y - fy * d, EDGE + 20, H - EDGE - 20), o: k.i, gr: 0.6 });
    if (s.bn.length > MAX_BANANAS) s.bn.shift();
    g.sfx('squish', { pitch: 1.2 });
  } else if (it === SHROOM) {
    k.boost = BOOST_T;
    g.sfx('powerup'); g.sfx('dash');
    g.burst(k.x - fx * k.r, k.y - fy * k.r, { color: '#ffb02e', n: 16, speed: 260 });
    g.text(k.x, k.y - 60, 'TURBO!', { color: '#ffb02e', size: 40 });
  }
}

function rollItem(s, g, k) {
  if (s.flip) return GREEN;
  let most = 0;
  for (const q of s.k) if (q !== k && !q.out) most = Math.max(most, q.b);
  const behind = k.b < most;
  const pool = [[GREEN, 32], [RED, behind ? 30 : 16], [BANANA, 26], [SHROOM, behind ? 26 : 18]];
  let tot = 0;
  for (const [, w] of pool) tot += w;
  let x = g.rng() * tot;
  for (const [it, w] of pool) { if ((x -= w) < 0) return it; }
  return GREEN;
}

export default {
  id: 'palloncini',
  name: 'Carretti e Vesciche',
  rule: 'Scoppia le vesciche degli altri con cavoli e sterco!',
  verb: 'SCOPPIA!',
  inspired: 'Mario Kart · Battaglia Palloncini',
  cam: 'top',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Oggetto', b: 'Derapata' },
  help: {
    goal: "Scoppia tutte e 3 le vesciche degli altri carretti: vince l'ultimo che ne ha ancora (o chi ne ha di più allo scadere).",
    dir: 'Guida il carretto: punta lo stick dove vuoi andare, il carretto sterza e accelera.',
    a: "USA L'OGGETTO preso dai cristalli ?: cavolo (rimbalza), palla di fuoco (insegue il più vicino), sterco (dietro di te), pozione (turbo che ruba una vescica se speroni).",
    b: 'DERAPATA: tienilo premuto in curva per sterzare stretto; le scintille caricano un mini-turbo (blu, poi arancione) che parte quando lo lasci.',
    tips: ["La VESCICA D'ORO te ne ridà una: corri a prenderla!", 'Saltando sulle rampe eviti lo sterco', 'Con la pozione, speronare ruba una vescica'],
  },
  duration: 45,
  supports: ['scale'],
  noMods: ['moviola'], // 45 s in slow motion would drag on for over a minute
  variants: [
    { id: 'flipper', name: 'Palle di Cannone', desc: 'Solo palle di cannone che rimbalzano per SEMPRE!' },
    { id: 'elio', name: 'Vesciche Leggere', desc: 'Ogni vescica persa: più piccolo e più veloce!' },
    { id: 'banane', name: 'Pioggia di Sterco', desc: 'Le catapulte lanciano sterco dal cielo! Guarda le ombre!' },
  ],

  init(g) {
    const N = g.n || 2;
    const sc = g.mods.scale || new Array(N).fill(1);
    return {
      flip: g.variant === 'flipper', elio: g.variant === 'elio', rain: g.variant === 'banane',
      k: Array.from({ length: N }, (_, i) => ({
        i, x: START[i][0], y: START[i][1], vx: 0, vy: 0, a: START[i][2],
        base: KART_R * (sc[i] ?? 1), r: KART_R * (sc[i] ?? 1), m: (sc[i] ?? 1) ** 2,
        b: START_B, lost: 0, item: 0, roll: 0, spin: 0, inv: 0, boost: 0, hop: 0, hopCd: 0,
        bonk: 0, happy: 0, self: 0, boxes: 0, drift: 0, dch: 0, ddir: 0, mt: 0, out: 0,
      })),
      sh: [], bn: [], fb: [], nid: 1,
      box: BOXES.map(() => 0), bl: BUMPERS.map(() => 0),
      lastHit: -1, skyT: 1.5, skyMir: null, late: false, gold: null, goldT: GOLD_FIRST,
    };
  },

  step(s, inp, g) {
    const dt = g.dt;
    if (!s.late && g.t >= 35) { s.late = true; g.say('ULTIMI 10 SECONDI!'); g.sfx('matchpoint'); }

    // --- Karts ---
    for (const k of s.k) {
      if (k.out) {
        // Eliminated: the ghost cart spins out and coasts to a stop.
        k.out = Math.min(9, k.out + dt);
        k.a += (k.out < 0.8 ? 12 : 0) * dt;
        const kp = damp(0.05, dt);
        k.vx *= kp; k.vy *= kp; k.hop = 0;
        k.x += k.vx * dt; k.y += k.vy * dt;
        collideWorld(s, k, 0.3, 0);
        continue;
      }
      const i = inp[k.i];
      k.inv = Math.max(0, k.inv - dt); k.boost = Math.max(0, k.boost - dt);
      k.bonk = Math.max(0, k.bonk - dt); k.happy = Math.max(0, k.happy - dt);
      k.hopCd = Math.max(0, k.hopCd - dt);
      if (k.hop > 0) {
        k.hop -= dt;
        if (k.hop <= 0) { g.sfx('land', { vol: 0.6 }); g.burst(k.x, k.y, { color: '#d9c7a0', n: 8, speed: 140 }); }
      }
      if (k.roll > 0) {
        k.roll -= dt;
        if (k.roll <= 0) g.sfx('slotstop', { vol: 0.6 });
      }
      const sf = speedF(s, k);
      k.mt = Math.max(0, k.mt - dt);
      if (k.spin > 0) {
        k.spin -= dt;
        k.a += 15 * dt;
        k.drift = 0; k.dch = 0;
        const kp = damp(0.05, dt);
        k.vx *= kp; k.vy *= kp;
      } else {
        const m = Math.min(1, Math.hypot(i.x, i.y));
        const want = m > 0.2 ? angleDiff(k.a, Math.atan2(i.y, i.x)) : 0;
        const speed0 = Math.hypot(k.vx, k.vy);
        // Drift: starts when B is held while moving; ends (and maybe fires the mini-turbo) on release.
        if (i.b && !k.drift && speed0 > DRIFT_MIN_SPEED) {
          k.drift = 1; k.dch = 0; k.ddir = Math.sign(want) || 0;
          k.hop = Math.max(k.hop, 0.12); g.sfx('jump', { vol: 0.35, pitch: 1.5 });
        }
        if (k.drift && (!i.b || speed0 < DRIFT_MIN_SPEED * 0.6)) {
          if (!i.b && k.dch >= MT1) {
            const big = k.dch >= MT2;
            k.mt = big ? 0.9 : 0.55;
            g.sfx('dash', { pitch: big ? 0.9 : 1.2 }); g.sfx('whoosh', { vol: 0.5 });
            g.burst(k.x - Math.cos(k.a) * k.r, k.y - Math.sin(k.a) * k.r, { color: big ? '#ff9a2e' : '#5cd6ff', n: 14, speed: 240 });
          }
          k.drift = 0; k.dch = 0;
        }
        if (k.drift) {
          if (!k.ddir && Math.abs(want) > 0.2) k.ddir = Math.sign(want);
          k.dch += dt * (Math.abs(want) > 0.25 ? 1 : 0.6);
        }
        const turn = TURN * (k.drift ? DRIFT_TURN : 1);
        if (m > 0.2) k.a += clamp(want, -turn * dt, turn * dt);
        const fx = Math.cos(k.a), fy = Math.sin(k.a);
        let fwd = k.vx * fx + k.vy * fy, lat = -k.vx * fy + k.vy * fx;
        const fast = k.boost > 0 ? BOOST_SPEED : k.mt > 0 ? MT_SPEED : 0;
        const top = (fast || MAX_SPEED) * sf;
        if (fast) fwd = approach(fwd, top, 3200 * dt);
        else if (m > 0.2 && fwd < top * m) fwd = Math.min(top * m, fwd + ACC * sf * dt);
        else fwd *= damp(m > 0.2 ? 0.5 : 0.25, dt);
        lat *= damp(k.drift ? 0.5 : 0.04, dt); // drifting keeps more sideways slide
        k.vx = fx * fwd - fy * lat; k.vy = fy * fwd + fx * lat;
        if (i.aP && k.item && k.roll <= 0) useItem(s, g, k);
      }
      k.x += k.vx * dt; k.y += k.vy * dt;
      const sp = Math.hypot(k.vx, k.vy);
      const w = collideWorld(s, k, s.flip ? 0.9 : 0.45, s.flip ? 520 : 0);
      if (w && k.bonk <= 0 && (sp > 220 || w === 2)) {
        k.bonk = 0.25;
        g.sfx(w === 2 ? 'boing' : 'bonk', { vol: 0.6 });
        if (w === 2) g.burst(k.x, k.y, { color: '#ff7bf0', n: 8, speed: 220 });
      }
      // Decorative ramps give a little hop (airborne karts skip bananas).
      if (!s.flip && k.hop <= 0 && k.hopCd <= 0 && sp > 220) {
        for (const [rx, ry, rw, rh] of RAMPS) {
          if (k.x > rx && k.x < rx + rw && k.y > ry && k.y < ry + rh) { k.hop = 0.5; k.hopCd = 0.9; g.sfx('jump', { vol: 0.7 }); break; }
        }
      }
    }

    // --- Cart vs cart (potion ram steals a bladder) ---
    for (let ia = 0; ia < s.k.length; ia++) for (let ib = ia + 1; ib < s.k.length; ib++) {
      const A = s.k[ia], B = s.k[ib];
      if (A.out || B.out) continue;
      const Ao = { x: A.x, y: A.y, vx: A.vx, vy: A.vy, r: A.r, m: A.m * (A.boost > 0 ? 3 : 1) };
      const Bo = { x: B.x, y: B.y, vx: B.vx, vy: B.vy, r: B.r, m: B.m * (B.boost > 0 ? 3 : 1) };
      const imp = collideCircles(Ao, Bo, 1.05);
      if (imp <= 0) continue;
      Object.assign(A, { x: Ao.x, y: Ao.y, vx: Ao.vx, vy: Ao.vy });
      Object.assign(B, { x: Bo.x, y: Bo.y, vx: Bo.vx, vy: Bo.vy });
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      let thief = null;
      if (A.boost > 0 && B.boost <= 0) thief = A;
      else if (B.boost > 0 && A.boost <= 0) thief = B;
      const victim = thief && (thief === A ? B : A);
      if (thief && victim.inv <= 0 && !g.ended) {
        thief.b = Math.min(MAX_B, thief.b + 1);
        thief.happy = 1.2;
        g.sfx('coin'); g.say('VESCICA RUBATA!');
        hit(s, g, victim, thief.i, 'ram');
        g.text(thief.x, thief.y - 70, '+1 🎈', { player: thief.i, size: 44 });
      } else if (imp > 120) {
        g.sfx('bonk', { pitch: 1.2 }); g.burst(mx, my, { color: '#fff', n: 6, speed: 160 });
      }
      collideWorld(s, A, 0.3, 0); collideWorld(s, B, 0.3, 0);
    }

    // --- Item boxes ---
    const late = g.t >= 35;
    const flipFull = s.flip && s.sh.length + s.k.filter((k) => k.item === GREEN).length >= MAX_FLIP_SHELLS;
    for (let j = 0; j < BOXES.length; j++) {
      if (s.box[j] > 0) { s.box[j] -= dt; continue; }
      if (flipFull) continue;
      const [bx, by] = BOXES[j];
      for (const k of s.k) {
        if (k.out || k.item || k.roll > 0 || k.spin > 0) continue;
        if (dist2(k.x, k.y, bx, by) < (k.r + BOX_R) ** 2) {
          k.item = rollItem(s, g, k); k.roll = 0.7; k.boxes++;
          s.box[j] = late ? 1.6 : 3.5;
          g.sfx('pickup'); g.sfx('slot', { vol: 0.5 });
          g.burst(bx, by, { color: '#ffe46b', n: 12, speed: 220 });
          break;
        }
      }
    }

    // --- Golden balloon (comeback): appears every few seconds, +1 balloon to whoever grabs it ---
    if (!g.ended) {
      if (!s.gold) {
        s.goldT -= dt;
        if (s.goldT <= 0) {
          const pair = g.rng.int(0, GOLD_SPOTS.length / 2 - 1) * 2;
          const [gx, gy] = GOLD_SPOTS[pair + g.rng.int(0, 1)];
          s.gold = { id: s.nid++, x: gx, y: gy, t: 0 };
          g.sfx('powerup', { pitch: 1.4 }); g.say("VESCICA D'ORO!");
          g.ring(gx, gy, { color: '#ffd23f', r: 90 });
        }
      } else {
        s.gold.t += dt;
        for (const k of s.k) {
          if (k.out || k.spin > 0 || dist2(k.x, k.y, s.gold.x, s.gold.y) >= (k.r + GOLD_R) ** 2) continue;
          k.b = Math.min(MAX_B, k.b + 1); k.happy = 1.2;
          g.sfx('coin'); g.sfx('tada', { vol: 0.6 });
          g.confetti(s.gold.x, s.gold.y);
          g.text(k.x, k.y - 80, '+1 🎈', { player: k.i, size: 48 });
          s.gold = null; s.goldT = GOLD_EVERY;
          break;
        }
      }
    }

    // --- Shells ---
    for (const o of s.sh) {
      o.life += dt; o.gr -= dt;
      if (o.t === RED && o.life > 0.25) {
        // Homes on the nearest cart still in the game (never its owner).
        let tg = null, bd = 1e12;
        for (const k of s.k) {
          if (k.out || k.i === o.o) continue;
          const d2 = dist2(k.x, k.y, o.x, o.y);
          if (d2 < bd) { bd = d2; tg = k; }
        }
        if (tg) {
          const cur = Math.atan2(o.vy, o.vx);
          const na = cur + clamp(angleDiff(cur, Math.atan2(tg.y - o.y, tg.x - o.x)), -3.2 * dt, 3.2 * dt);
          o.vx = Math.cos(na) * RED_V; o.vy = Math.sin(na) * RED_V;
        }
      }
      const steps = Math.max(1, Math.ceil((Math.hypot(o.vx, o.vy) * dt) / 9));
      for (let n = 0; n < steps && !o.dead; n++) {
        o.x += (o.vx * dt) / steps; o.y += (o.vy * dt) / steps;
        const w = collideWorld(s, o, 1, 0);
        if (!w) continue;
        if (o.t === RED) { o.dead = 1; g.sfx('break', { vol: 0.6 }); g.burst(o.x, o.y, { color: '#ff4040', n: 12, speed: 220 }); break; }
        o.n++;
        if (w === 2) g.sfx('boing', { vol: 0.5, pitch: 1.3 });
        else g.sfx('bounce', { vol: 0.35, pitch: 1.2 });
        if (!s.flip && o.n > GREEN_BOUNCES) { o.dead = 1; g.burst(o.x, o.y, { color: '#3dff7a', n: 10, speed: 200 }); }
      }
      if (s.flip) { // keep pinball shells lively forever
        const v = Math.hypot(o.vx, o.vy) || 1;
        o.vx *= GREEN_V / v; o.vy *= GREEN_V / v;
      } else if (o.life > (o.t === RED ? 6 : 9)) o.dead = 1;
      if (o.dead) continue;
      for (const k of s.k) {
        if (k.out || (k.i === o.o && o.gr > 0)) continue;
        if (dist2(o.x, o.y, k.x, k.y) >= (k.r + o.r) ** 2) continue;
        if (s.flip) {
          // Pinball shells bounce off karts instead of disappearing.
          const dx = o.x - k.x, dy = o.y - k.y, d = Math.hypot(dx, dy) || 1;
          const nx = dx / d, ny = dy / d;
          o.x = k.x + nx * (k.r + o.r + 1); o.y = k.y + ny * (k.r + o.r + 1);
          const vn = o.vx * nx + o.vy * ny;
          if (vn < 0) { o.vx -= 2 * vn * nx; o.vy -= 2 * vn * ny; }
          o.gr = 0;
          hit(s, g, k, o.o, 'shell');
        } else {
          if (!hit(s, g, k, o.o, 'shell')) g.sfx('bonk', { pitch: 1.4, vol: 0.6 });
          o.dead = 1;
        }
        break;
      }
    }
    // Shell vs shell and shell vs banana (normal modes only).
    if (!s.flip) {
      for (const o of s.sh) {
        if (o.dead) continue;
        for (const p of s.sh) {
          if (p === o || p.dead) continue;
          if (dist2(o.x, o.y, p.x, p.y) < (o.r + p.r) ** 2) { o.dead = p.dead = 1; g.sfx('break'); g.burst(o.x, o.y, { color: '#fff', n: 12, speed: 220 }); }
        }
        for (const b of s.bn) {
          if (!b.dead && dist2(o.x, o.y, b.x, b.y) < (o.r + BANANA_R) ** 2) { o.dead = b.dead = 1; g.sfx('squish'); g.burst(b.x, b.y, { color: '#ffe14d', n: 10, speed: 180 }); }
        }
      }
    }
    s.sh = s.sh.filter((o) => !o.dead);

    // --- Bananas ---
    for (const b of s.bn) {
      b.gr -= dt;
      if (b.dead) continue;
      for (const k of s.k) {
        if (k.out || k.hop > 0 || k.inv > 0 || (k.i === b.o && b.gr > 0)) continue;
        if (dist2(b.x, b.y, k.x, k.y) < (k.r + BANANA_R * 0.8) ** 2) {
          b.dead = 1;
          hit(s, g, k, b.o, 'banana');
          break;
        }
      }
    }

    // --- Banana rain (variant) ---
    if (s.rain && !g.ended) {
      s.skyT -= dt;
      if (s.skyT <= 0) {
        s.skyT += 2;
        let p = s.skyMir;
        if (!p || insideBlock(s, p[0], p[1], 30)) {
          p = [CX, CY];
          for (let tries = 0; tries < 12; tries++) {
            const x = g.rng.range(100, 900), y = g.rng.range(100, 900);
            if (!insideBlock(s, x, y, 30)) { p = [x, y]; break; }
          }
          s.skyMir = [W - p[0], H - p[1]];
        } else s.skyMir = null;
        s.fb.push({ id: s.nid++, x: p[0], y: p[1], t: 1.1 });
        g.sfx('whoosh', { vol: 0.4, pitch: 0.8 });
      }
    }
    for (const f of s.fb) {
      f.t -= dt;
      if (f.t > 0) continue;
      f.dead = 1;
      g.sfx('squish'); g.burst(f.x, f.y, { color: '#ffe14d', n: 10, speed: 160 });
      let caught = false;
      for (const k of s.k) {
        if (!k.out && k.hop <= 0 && dist2(f.x, f.y, k.x, k.y) < (k.r + 26) ** 2 && hit(s, g, k, -1, 'sky')) { caught = true; g.say('STERCO IN TESTA!'); }
      }
      if (!caught) { s.bn.push({ id: s.nid++, x: f.x, y: f.y, o: -1, gr: 0 }); if (s.bn.length > MAX_BANANAS) s.bn.shift(); }
    }
    s.fb = s.fb.filter((f) => !f.dead);
    s.bn = s.bn.filter((b) => !b.dead);
    for (let j = 0; j < s.bl.length; j++) s.bl[j] = Math.max(0, s.bl[j] - dt);
  },

  // Most bladders among the carts still in; ties: the last one who hit someone, fewer own goals, more boxes.
  timeout(s) {
    const alive = s.k.filter((k) => !k.out);
    const pool = alive.length ? alive : s.k;
    const most = Math.max(...pool.map((k) => k.b));
    let tied = pool.filter((k) => k.b === most);
    if (tied.length === 1) return tied[0].i;
    if (tied.some((k) => k.i === s.lastHit)) return s.lastHit;
    const self = Math.min(...tied.map((k) => k.self));
    tied = tied.filter((k) => k.self === self);
    if (tied.length === 1) return tied[0].i;
    const boxes = Math.max(...tied.map((k) => k.boxes));
    tied = tied.filter((k) => k.boxes === boxes);
    return tied.length === 1 ? tied[0].i : -1;
  },

  view(s) {
    const flipFull = s.flip && s.sh.length + s.k.filter((k) => k.item === GREEN).length >= MAX_FLIP_SHELLS;
    return {
      k: s.k.map((k) => ({
        x: r1(k.x), y: r1(k.y), a: r2(wrapAngle(k.a)), r: r1(k.r), b: k.b,
        it: k.roll > 0 ? -1 : k.item, sp: k.spin > 0 ? 1 : 0, iv: r2(k.inv), bo: k.boost > 0 ? 1 : 0,
        hp: r2(Math.max(0, k.hop)), hy: k.happy > 0 ? 1 : 0, s: r2(sizeF(s, k)),
        dr: k.drift ? (k.dch >= MT2 ? 3 : k.dch >= MT1 ? 2 : 1) : 0, mt: k.mt > 0 ? 1 : 0, dd: k.ddir, o: k.out ? r2(k.out) : 0,
      })),
      sh: s.sh.map((o) => ({ id: o.id, t: o.t, x: r1(o.x), y: r1(o.y) })),
      bn: s.bn.map((b) => ({ id: b.id, x: r1(b.x), y: r1(b.y) })),
      fb: s.fb.map((f) => ({ id: f.id, x: r1(f.x), y: r1(f.y), t: r2(f.t) })),
      bx: s.box.map((t) => (t > 0 ? 0 : flipFull ? 2 : 1)),
      bl: s.flip ? s.bl.map(r2) : [],
      fl: s.flip ? 1 : 0,
      gd: s.gold ? { id: s.gold.id, x: s.gold.x, y: s.gold.y } : null,
      hud: { p: s.k.map((k) => k.b), max: null, label: 'Vesciche' },
    };
  },

  focus(v) {
    return v.k.map((k) => ({ x: k.x, y: k.y }));
  },

  bot(s, me, g, B) { return pallBot(s, me, g, B); },

  // 3D: the market square of a medieval village on a sunny day. Cobbles inside a low stone wall, market
  // counters and hay as obstacles, wooden ramps; all around: stalls, houses, the tavern, the church and the
  // castle on the hill, trees, waving flags. 'Palle di Cannone' turns the obstacles into round stone turrets.
  render3d: {
    assets: [
      'medieval/fence_stone_straight', 'medieval/crate_long_A', 'medieval/crate_long_B', 'medieval/crate_A_big', 'medieval/crate_B_small',
      'medieval/barrel', 'medieval/sack', 'medieval/bucket_water', 'medieval/wheelbarrow', 'medieval/pallet',
      'medieval/building_market_red', 'medieval/building_market_blue', 'medieval/building_market_green', 'medieval/building_market_yellow',
      'medieval/building_home_A_red', 'medieval/building_home_A_blue', 'medieval/building_home_B_yellow', 'medieval/building_home_B_green',
      'medieval/building_tavern_yellow', 'medieval/building_blacksmith_blue', 'medieval/building_church_red', 'medieval/building_well_blue',
      'medieval/building_castle_blue', 'medieval/building_windmill_red', 'medieval/building_tower_A_yellow', 'medieval/tent',
      'medieval/trees_A_large', 'medieval/trees_B_large', 'medieval/tree_single_B', 'medieval/hills_B_trees', 'medieval/mountain_A_grass_trees',
      'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow', 'medieval/cloud_big',
    ],
    build(K) {
      const { THREE } = K;
      const lo = K.quality === 0;
      K.theme('giorno', { fogNear: 2.2, fogFar: 6 });
      const o = { flip: null, v1: new THREE.Vector3(), v2: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), flags: [], clouds: [] };
      const cols = new Map();
      o.C = (hex) => { let c = cols.get(hex); if (!c) { c = new THREE.Color(hex); cols.set(hex, c); } return c; };
      const rnd = (k) => { const x = Math.sin(k * 57.3 + 7.7) * 43758.5453; return x - Math.floor(x); };
      // --- Ground: meadow all around, cobbled square, painted markings (dirt track / rune circle) ---
      K.ground('erba', { margin: 2600, tile: 190 });
      const SQ = W - 2 * EDGE + 120;
      const sq = K.mesh(new THREE.PlaneGeometry(SQ, SQ).rotateX(-Math.PI / 2), K.texMat('pietra', [8, 8], { color: '#e3dacb' }));
      sq.userData.ownGeo = true; sq.castShadow = false;
      K.place(sq, CX, CY, 0.4);
      // Dirt road leaving the square toward the camera and toward the castle.
      for (const [y0, y1] of [[H + 20, H + 1600], [-1600, -20]]) {
        const rd = K.mesh(new THREE.PlaneGeometry(170, y1 - y0).rotateX(-Math.PI / 2), K.texMat('terra', [1, (y1 - y0) / 170]));
        rd.userData.ownGeo = true; rd.castShadow = false;
        K.place(rd, CX, (y0 + y1) / 2, 0.3);
      }
      K.layer({
        x0: EDGE - 30, y0: EDGE - 30, x1: W - EDGE + 30, y1: H - EDGE + 30, h: 1.2, transparent: true, once: true,
        draw: (d, v) => {
          const { ctx } = d;
          if (v.fl === 1) {
            // Cannon yard: a big glowing rune circle.
            for (let k = 0; k < 5; k++) d.ring(CX, CY, 120 + k * 75, `rgba(90,200,255,${(0.32 - k * 0.05).toFixed(2)})`, 5);
            for (let k = 0; k < 12; k++) {
              const a = (k / 12) * Math.PI * 2;
              d.line(CX + Math.cos(a) * 120, CY + Math.sin(a) * 120, CX + Math.cos(a) * 420, CY + Math.sin(a) * 420, 'rgba(90,200,255,0.16)', 4);
            }
            return;
          }
          // A ring of trampled dirt where the carts race round, start marks in the players' colors.
          d.ring(CX, CY, 230, 'rgba(120,84,50,0.45)', 76);
          ctx.save(); ctx.setLineDash([26, 22]); d.ring(CX, CY, 230, 'rgba(255,240,210,0.35)', 4); ctx.restore();
          v.k.forEach((k, i) => {
            const [x, y, a] = START[i];
            const nx = -Math.sin(a), ny = Math.cos(a);
            for (let j = -4; j <= 4; j++) d.circle(x + nx * j * 14 - Math.cos(a) * 48, y + ny * j * 14 - Math.sin(a) * 48, 6, d.col(i) + 'cc');
          });
          for (const [x, y, w, h] of OBST) d.rrect(x - 8, y - 6, w + 16, h + 16, 14, 'rgba(0,0,0,0.25)');
        },
      });
      // --- Low stone wall around the square (the model's pivot is off-centre: compensate) ---
      const n = 10, seg = (W - 2 * EDGE + 40) / n, k0 = seg / 1.15, wall = [];
      const wallAt = (X, Y, rot) => wall.push({ x: X + Math.cos(rot) * k0, y: Y + Math.sin(rot) * k0, rot });
      for (let j = 0; j < n; j++) {
        const q = EDGE - 20 + (j + 0.5) * seg;
        wallAt(q, EDGE - 12, Math.PI / 2); wallAt(q, H - EDGE + 12, Math.PI / 2);
        wallAt(EDGE - 12, q, 0); wallAt(W - EDGE + 12, q, 0);
      }
      o.wall = K.scatter('medieval/fence_stone_straight', wall, { size: seg });
      // --- Obstacles: market counters (long crates), stacked crates and barrels, hay bales in the middle ---
      o.normal = []; o.flipOnly = [];
      const longs = [];
      for (const [x, y, w, h] of OBST) {
        if (w > 150) for (let j = 0; j < 2; j++) longs.push({ x: x + w * (0.25 + j * 0.5), y: y + h / 2, rot: 0, s: 1 });
      }
      o.normal.push(K.scatter('medieval/crate_long_A', longs.filter((_, j) => j % 2 === 0), { size: 86 }));
      o.normal.push(K.scatter('medieval/crate_long_B', longs.filter((_, j) => j % 2 === 1), { size: 86 }));
      const small = OBST.filter(([, , w, h]) => w === 60 && h === 60);
      o.normal.push(K.scatter('medieval/crate_A_big', small.map(([x, y]) => ({ x: x + 30, y: y + 30, rot: 0.1 })), { size: 60 }));
      o.normal.push(K.scatter('medieval/barrel', small.map(([x, y]) => ({ x: x + 30, y: y + 30, h: 60 })), { size: 40 }));
      o.normal.push(K.scatter('medieval/sack', longs.map((l, j) => ({ x: l.x + (j % 2 ? 18 : -14), y: l.y - 4, h: 30, rot: j })), { size: 30 }));
      const hay = K.texMat('paglia', [2, 1], { color: '#f1d27a' });
      const [hx, hy, hw, hh] = OBST.find(([, , w, h]) => w === 120);
      for (let j = 0; j < 2; j++) {
        const b = K.box(hw / 2 - 4, hh, 40, hay);
        K.place(b, hx + hw * (0.25 + j * 0.5), hy + hh / 2, 20);
        o.normal.push(b);
      }
      const bale = K.box(hw / 2 - 10, hh - 10, 30, hay);
      K.place(bale, hx + hw / 2, hy + hh / 2, 55); bale.rotation.y = 0.15;
      o.normal.push(bale);
      // --- Jump ramps: wooden planks with painted arrows, high end toward the jump direction ---
      const plank = K.canvasTex(128, 64, (d) => {
        d.rect(0, 0, 128, 64, '#a87444');
        for (let k = 0; k < 4; k++) d.line(0, 16 * k + 1, 128, 16 * k + 1, '#6e4524', 3);
        for (let k = 0; k < 3; k++) d.poly([18 + k * 36, 12, 40 + k * 36, 32, 18 + k * 36, 52], null, '#ffd23f', 8);
      });
      const rampMat = new THREE.MeshStandardMaterial({ map: plank, color: plank ? '#ffffff' : '#a87444', roughness: 0.8 });
      for (const [rx, ry, rw, rh, ang] of RAMPS) {
        const g = K.group();
        K.place(g, rx + rw / 2, ry + rh / 2, 0); K.face(g, ang);
        const rise = 20, slope = Math.atan2(rise, rw);
        const top = K.box(rw / Math.cos(slope), rh, 5, rampMat, { parent: g });
        top.rotation.z = slope; top.position.y = rise / 2;
        const prop = K.box(8, rh - 4, rise, K.mat('#5a3a1e', { rough: 0.9 }), { parent: g });
        K.place(prop, rw / 2 - 6, 0, rise / 2);
        o.normal.push(g);
      }
      // --- Cannon yard (variant): round stone turrets as bumpers + glowing rune barriers in the corners ---
      const turretM = K.texMat('muro', [3, 1], { color: '#d8cbb8' });
      o.bump = BUMPERS.map(([x, y, br]) => {
        const body = K.cyl(br, 34, turretM, { seg: 20 });
        K.place(body, x, y);
        const cap = K.cone(br * 1.12, br * 0.9, K.mat('#c0392b', { unique: true, rough: 0.6 }), { seg: 20 });
        K.place(cap, x, y, 34);
        const ring = K.torus(br + 10, 3, K.glow('#ffe46b', { add: true }), { cast: false });
        K.place(ring, x, y, 12);
        o.flipOnly.push(body, cap);
        return { body, cap, ring };
      });
      for (const [ax, ay, bx, by] of BEVELS) {
        const len = Math.hypot(bx - ax, by - ay);
        const b = K.box(len, 10, 16, K.glow('#5cd6ff'));
        K.place(b, (ax + bx) / 2, (ay + by) / 2, 8); K.face(b, Math.atan2(by - ay, bx - ax));
        o.flipOnly.push(b);
      }
      // --- The village around the square ---
      const M1 = (m, x, y, sz, rot = 0, by = 'size') => K.place(K.face(K.model(m, { [by]: sz, cast: y > -100 && y < H + 100 }), rot), x, y, 0);
      // Near side (toward the camera): only low market stalls and goods.
      const STALLS = ['medieval/building_market_red', 'medieval/building_market_blue', 'medieval/building_market_green', 'medieval/building_market_yellow'];
      [[150, 1140], [390, 1170], [640, 1170], [870, 1140]].forEach(([x, y], k) => M1(STALLS[k], x, y, 150, -Math.PI / 2 + (k - 1.5) * 0.08));
      K.scatter('medieval/barrel', [{ x: 60, y: 1080 }, { x: 95, y: 1100 }, { x: 960, y: 1070 }, { x: 1080, y: 1010 }, { x: -60, y: 980 }], { size: 38 });
      K.scatter('medieval/crate_B_small', [{ x: 270, y: 1085, rot: 0.3 }, { x: 760, y: 1080 }, { x: 1110, y: 1070, rot: 1 }], { size: 34 });
      K.scatter('medieval/sack', [{ x: 300, y: 1100 }, { x: 520, y: 1100, rot: 1 }, { x: 545, y: 1110, rot: 2 }, { x: 735, y: 1100 }], { size: 30 });
      M1('medieval/wheelbarrow', 1060, 1150, 70, 0.6);
      M1('medieval/tent', -140, 1120, 160, 0.3);
      M1('medieval/tent', 1150, 1150, 150, -0.4);
      // Left and right: houses, the tavern, the blacksmith, a well.
      M1('medieval/building_tavern_yellow', -250, 260, 300, 0, 'height');
      M1('medieval/building_home_A_red', -230, 620, 220, 0, 'height');
      M1('medieval/building_home_B_green', -260, 880, 250, 0, 'height');
      M1('medieval/building_blacksmith_blue', 1250, 280, 230, Math.PI, 'height');
      M1('medieval/building_home_B_yellow', 1250, 620, 260, Math.PI, 'height');
      M1('medieval/building_home_A_blue', 1230, 880, 220, Math.PI, 'height');
      M1('medieval/building_well_blue', -110, 470, 110, 0, 'height');
      K.scatter('medieval/pallet', [{ x: 1110, y: 470 }, { x: 1110, y: 500, h: 6, rot: 0.3 }], { size: 50 });
      K.scatter('medieval/bucket_water', [{ x: -60, y: 520 }, { x: -70, y: 410 }], { size: 22 });
      // Far side: church, houses, the castle on the hill, windmill, tower.
      M1('medieval/building_church_red', 220, -230, 420, Math.PI / 2, 'height');
      M1('medieval/building_home_B_green', 460, -170, 240, Math.PI / 2, 'height');
      M1('medieval/building_home_A_red', 700, -190, 220, Math.PI / 2, 'height');
      M1('medieval/building_home_B_yellow', 900, -220, 250, Math.PI / 2, 'height');
      M1('medieval/building_home_A_blue', -40, -160, 220, Math.PI / 2, 'height');
      M1('medieval/building_tower_A_yellow', 1120, -160, 380, Math.PI / 2, 'height');
      M1('medieval/building_castle_blue', 520, -1150, 1100, Math.PI / 2, 'height');
      M1('medieval/building_windmill_red', -650, -500, 380, 0.6, 'height');
      K.scatter('medieval/hills_B_trees', [{ x: 520, y: -1050, rot: 0.3 }, { x: -700, y: -1300, rot: 1 }, { x: 1700, y: -1250, rot: 2 }], { size: 1300, cast: false });
      K.scatter('medieval/mountain_A_grass_trees', [{ x: -1400, y: -2400 }, { x: 600, y: -2700, rot: 1 }, { x: 2400, y: -2300, rot: 2 }], { height: 1500, cast: false });
      // Trees everywhere outside the village.
      const tr = [[], [], []];
      for (let k = 0; k < (lo ? 40 : 80); k++) {
        const a = rnd(k) * Math.PI * 2, rr = 900 + rnd(k + 99) * 1500;
        const x = CX + Math.cos(a) * rr * 1.2, y = CY + Math.sin(a) * rr;
        if (Math.abs(x - CX) < 160 && (y > H || y < 0)) continue; // keep the roads clear
        tr[k % 3].push({ x, y, rot: rnd(k + 5) * 6, s: 0.75 + rnd(k + 7) * 0.5 });
      }
      K.scatter('medieval/trees_A_large', tr[0], { size: 300, cast: false });
      K.scatter('medieval/trees_B_large', tr[1], { size: 280, cast: false });
      K.scatter('medieval/tree_single_B', tr[2], { height: 230, cast: false });
      // Flags on tall poles at the corners of the square (they wave).
      const FLAGS = ['medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow'];
      const poleM = K.mat('#6e4524', { rough: 0.8 });
      [[-30, -30], [W + 30, -30], [-30, H + 30], [W + 30, H + 30]].forEach(([x, y], k) => {
        K.place(K.cyl(5, 190, poleM, { seg: 8 }), x, y);
        const f = K.model(FLAGS[k], { height: 90 });
        K.place(f, x, y, 110);
        o.flags.push({ f, ph: k * 1.7 });
      });
      for (const [x, y, h, sz] of [[-600, -900, 900, 700], [1500, -700, 1000, 600], [400, -1800, 1100, 900]]) {
        o.clouds.push({ c: K.model('medieval/cloud_big', { size: sz, cast: false }), x, y, h });
      }
      K.ambient('petali', { n: lo ? 25 : 50, h: 380, x0: -400, y0: -400, x1: W + 400, y1: H + 400 });
      // --- Item crystals (rainbow cubes with a "?") ---
      o.box = BOXES.map(([x, y]) => {
        const mat = K.mat('#ffffff', { unique: true, opacity: 0.75, rough: 0.1, metal: 0.1 });
        const cube = K.box(46, 46, 46, mat, { cast: false });
        K.outline(cube, '#ffffff', 0.08);
        const q = K.billboard(96, 96, 44, (d, w, h) => d.text('?', w / 2, h / 2 + 4, { size: 82, color: '#ffffff', strokeColor: '#3a1a6a' }), { depthTest: false });
        q.renderOrder = 5;
        const dot = K.disc(9, K.glow('#ffffff', { opacity: 0.35 }));
        K.place(dot, x, y, 1.5);
        return { cube, mat, q, dot, x, y };
      });
      // --- Golden bladder ---
      o.gold = K.group();
      const gb = K.ball(GOLD_R, K.mat('#ffd23f', { rough: 0.2, metal: 0.5, emissive: '#ffb000', ei: 0.35 }), { parent: o.gold });
      gb.scale.set(1, 1.15, 1); gb.position.y = 70;
      K.place(K.ball(5, K.mat('#ffd23f'), { parent: o.gold }), 0, 0, 70 - GOLD_R * 1.15);
      K.place(K.cyl(1.2, 70 - GOLD_R * 1.15, K.glow('#ffffff'), { parent: o.gold, seg: 6 }), 0, 0, 0);
      o.goldGlow = K.ball(1, K.glow('#ffd23f', { add: true, opacity: 0.35 }), { cast: false });
      o.goldStar = K.emoji('✨', 34);
      // --- Dung on the ground + dung falling from the catapults ---
      o.bn = [];
      for (let k = 0; k < MAX_BANANAS; k++) o.bn.push(K.emoji('💩', 52, { base: true }));
      o.fb = [];
      for (let k = 0; k < 4; k++) {
        o.fb.push({
          sp: K.emoji('💩', 50),
          sh: K.disc(1, K.glow('#000000', { unique: true, opacity: 0.3 })),
          ring: K.disc(44, K.glow('#ffe650', { opacity: 0.75 }), { r0: 39 }),
        });
      }
      // --- Thrown things: cabbages (green, bounce), fireballs (red, homing), cannonballs (variant) ---
      o.shMat = { 1: K.mat('#5fbf3a', { rough: 0.6 }), 2: K.mat('#ff6a1a', { rough: 0.4, emissive: '#ff3a00', ei: 0.9 }), 3: K.mat('#2c2f38', { rough: 0.3, metal: 0.7 }) };
      o.shTop = { 1: K.mat('#b8f08a', { rough: 0.6 }), 2: K.mat('#ffd060', { emissive: '#ffb000', ei: 0.9 }), 3: K.mat('#5a5f6e', { rough: 0.3, metal: 0.7 }) };
      o.sh = [];
      for (let k = 0; k < 8; k++) {
        const g = K.group();
        const dome = K.ball(SHELL_R, o.shMat[1], { parent: g, seg: 16 });
        dome.scale.set(1, 0.85, 1); dome.position.y = SHELL_R * 0.85;
        const spots = [];
        for (let j = 0; j < 4; j++) {
          const sp = K.ball(9, o.shTop[1], { parent: g, cast: false, seg: 8 });
          const a = (j * TAU) / 4;
          sp.position.set(Math.cos(a) * 12, SHELL_R * 0.85 + (j % 2 ? 10 : -4), Math.sin(a) * 12); sp.scale.set(1.1, 0.5, 0.7);
          spots.push(sp);
        }
        const aura = K.ball(1, K.glow('#ff8a2a', { add: true, opacity: 0.45 }), { cast: false, seg: 12 });
        o.sh.push({ g, dome, spots, aura });
      }
      // --- Carts ---
      o.k = Array.from({ length: Math.max(2, K.n || 2) }, (_, i) => {
        const woodM = K.texMat('legno', [1, 1], { color: '#c08a52' });
        const main = K.mat(K.col(i, 'main'), { unique: true, rough: 0.5 });
        const light = K.mat(K.col(i, 'light'), { unique: true, rough: 0.5 });
        const dark = K.mat('#4a2e1c', { unique: true, rough: 0.9 });
        const iron = K.mat('#6b6f7a', { unique: true, rough: 0.35, metal: 0.6 });
        const mats = [woodM, main, light, dark, iron];
        const g = K.group();
        g.rotation.order = 'YXZ'; // yaw, then lean around the cart's own forward axis
        const body = K.group(g); // everything scales with the cart radius (1 = KART_R)
        const pod = K.prism([-0.95, -0.55, 0.6, -0.55, 0.95, -0.35, 0.95, 0.35, 0.6, 0.55, -0.95, 0.55], 0.3, woodM, { parent: body });
        K.place(pod, 0, 0, 0.16);
        K.place(K.box(1.7, 0.1, 0.28, main, { parent: body }), -0.1, -0.58, 0.48);   // painted side boards
        K.place(K.box(1.7, 0.1, 0.28, main, { parent: body }), -0.1, 0.58, 0.48);
        K.place(K.box(0.14, 1.2, 0.22, iron, { parent: body }), 0.98, 0, 0.3);      // iron-shod front
        K.place(K.box(0.3, 0.95, 0.5, light, { parent: body }), -0.6, 0, 0.6);     // seat back
        // Pennant on a pole.
        const pole = K.cyl(0.04, 1.3, dark, { parent: body, seg: 6 });
        K.place(pole, -0.85, 0.4, 0.4);
        const pen = K.prism([0, 0, 0.6, 0.12, 0, 0.26], 0.03, main, { parent: body });
        pen.rotation.x = Math.PI / 2; K.place(pen, -0.83, 0.4, 1.45);
        const wheels = [];
        for (const wx of [-0.5, 0.5]) for (const wy of [-0.82, 0.82]) {
          const w = K.cyl(wx < 0 ? 0.36 : 0.3, 0.14, dark, { parent: body, center: true, seg: 12 });
          w.rotation.x = Math.PI / 2; K.place(w, wx, wy, wx < 0 ? 0.36 : 0.3);
          wheels.push(w);
        }
        // Potion turbo flames (cones pointing backward).
        const flames = [];
        for (const [c, s] of [['#ffb02e', 1], ['#fff6a0', 0.55]]) {
          const f = K.cone(0.28 * s + 0.08, 1, K.glow(c, { unique: true, add: true }), { parent: body, cast: false });
          f.rotation.z = Math.PI / 2; K.place(f, -1.15, 0, 0.5);
          flames.push(f);
        }
        // Drift sparks.
        const sparks = [];
        for (let j = 0; j < 6; j++) sparks.push(K.ball(1, K.glow('#dddddd', { unique: true, add: true }), { cast: false, seg: 6 }));
        // Bladders on strings.
        const balloons = [];
        for (let j = 0; j < MAX_B; j++) {
          const bm = j % 2 ? K.mat(K.col(i, 'light'), { rough: 0.15, emissive: K.col(i, 'light'), ei: 0.15 }) : K.mat(K.col(i, 'main'), { rough: 0.15, emissive: K.col(i, 'main'), ei: 0.15 });
          const ball = K.ball(1, bm, { seg: 16, cast: false });
          const str = K.cyl(1, 1, K.glow('#ffffff', { opacity: 0.8 }), { center: true, seg: 5, cast: false });
          balloons.push({ ball, str });
        }
        const inv = K.torus(1, 0.06, K.glow(K.col(i, 'light'), { unique: true, opacity: 0.5 }), { cast: false });
        const bst = { show: 0 };
        const bubble = K.billboard(128, 128, 58, (d, w, h) => {
          const show = bst.show;
          if (!show) return;
          d.circle(w / 2, h / 2, 54, 'rgba(0,0,0,0.6)', K.col(i, 'light'), 8);
          if (show === GREEN) d.circle(w / 2, h / 2, 30, '#5fbf3a', '#d8ffb8', 6);
          else if (show === RED) { d.circle(w / 2, h / 2, 30, '#ff6a1a', '#ffd060', 6); d.circle(w / 2 - 8, h / 2 - 8, 10, '#ffe08a'); }
          else d.emoji(show === BANANA ? '💩' : '🧪', w / 2, h / 2 + 4, 64);
        });
        return { g, body, mats, wheels, flames, sparks, balloons, inv, bubble, bst, av: K.avatar(i), alpha: 1, itemKey: '' };
      });
      return o;
    },

    update(K, o, v) {
      const t = K.t;
      const flip = v.fl === 1;
      if (o.flip !== flip) {
        o.flip = flip;
        for (const m of o.normal) m.visible = !flip;
        for (const m of o.flipOnly) m.visible = flip;
      }
      for (const f of o.flags) f.f.rotation.y = Math.sin(t * 2.4 + f.ph) * 0.4;
      for (const c of o.clouds) K.place(c.c, ((c.x + t * 12 + 3000) % 5000) - 2000, c.y, c.h);
      o.bump.forEach((B, j) => {
        B.body.visible = B.cap.visible = flip;
        const lit = flip && (v.bl[j] || 0) > 0;
        B.ring.visible = lit;
        B.cap.material.color.copy(o.C(lit ? '#ffe46b' : '#c0392b'));
        const sq = lit ? 1 + (v.bl[j] || 0) * 0.6 : 1;
        B.body.scale.set(sq, 1, sq);
      });
      // Item crystals.
      o.box.forEach((B, j) => {
        const st = v.bx[j];
        B.cube.visible = B.q.visible = !!st;
        B.dot.visible = !st;
        if (!st) return;
        const bob = 40 + Math.sin(t * 3 + j) * 6;
        K.place(B.cube, B.x, B.y, bob);
        B.cube.rotation.set(t * 0.9 + j, t * 1.2 + j, 0.6);
        if (st === 1) B.mat.color.setHSL(((t * 120 + j * 60) % 360) / 360, 0.95, 0.5);
        else B.mat.color.copy(o.C('#888888'));
        K.place(B.q, B.x, B.y, bob + 2);
      });
      // Golden bladder.
      const gd = v.gd;
      o.gold.visible = o.goldGlow.visible = o.goldStar.visible = !!gd;
      if (gd) {
        const bob = Math.sin(t * 3) * 8;
        K.place(o.gold, gd.x, gd.y, bob);
        o.gold.rotation.z = Math.sin(t * 2) * 0.08;
        K.place(o.goldGlow, gd.x, gd.y, 70 + bob);
        o.goldGlow.scale.setScalar(GOLD_R + 14 + 4 * Math.sin(t * 7));
        K.place(o.goldStar, gd.x + 36 * Math.cos(t * 3), gd.y + 36 * Math.sin(t * 3), 70 + bob);
      }
      // Dung.
      o.bn.forEach((sp, k) => {
        const b = v.bn[k];
        sp.visible = !!b;
        if (b) K.place(sp, b.x, b.y, 0);
      });
      o.fb.forEach((F, k) => {
        const f = v.fb[k];
        F.sp.visible = F.sh.visible = !!f;
        F.ring.visible = !!f && Math.floor(t * 10) % 2 === 1;
        if (!f) return;
        const kk = clamp(1 - f.t / 1.1, 0, 1);
        K.place(F.sp, f.x, f.y, 20 + f.t * 420);
        F.sp.scale.set(40 + 20 * kk, 40 + 20 * kk, 1);
        K.place(F.sh, f.x, f.y, 1.5);
        F.sh.scale.setScalar(16 + 26 * kk);
        F.sh.material.opacity = 0.15 + 0.35 * kk;
        K.place(F.ring, f.x, f.y, 1.7);
      });
      // Thrown things.
      o.sh.forEach((S, k) => {
        const s = v.sh[k];
        S.g.visible = !!s;
        const red = !!s && Math.round(s.t) === RED;
        S.aura.visible = red;
        if (!s) return;
        const ty = red ? RED : flip ? 3 : GREEN;
        S.dome.material = o.shMat[ty];
        for (const p of S.spots) { p.material = o.shTop[ty]; p.visible = ty !== 3; }
        K.place(S.g, s.x, s.y, 0);
        S.g.rotation.y = t * 9;
        if (red) {
          K.place(S.aura, s.x, s.y, SHELL_R * 0.85);
          S.aura.scale.setScalar(SHELL_R * (1.45 + 0.15 * Math.sin(t * 24)));
        }
      });
      // Carts.
      v.k.forEach((k, i) => {
        const P = o.k[i];
        if (!P) return;
        const R = k.r;
        const out = k.o > 0;
        const hop = k.hp > 0 ? Math.sin(clamp(1 - k.hp / 0.5, 0, 1) * Math.PI) : 0;
        const lift = hop * 30;
        const blink = k.iv > 0 && k.sp === 0 && Math.floor(t * 14) % 2 === 0;
        const al = out ? 0.35 : blink ? 0.4 : 1;
        if (al !== P.alpha) {
          P.alpha = al;
          for (const m of P.mats) { m.transparent = al < 1; m.opacity = al; m.depthWrite = al >= 1; m.needsUpdate = true; }
        }
        const ang = k.a + (k.dr ? (k.dd || 1) * 0.25 : 0);
        K.place(P.g, k.x, k.y, lift);
        K.face(P.g, ang);
        P.body.scale.setScalar(R * (1 + hop * 0.12));
        P.g.rotation.x = k.dr ? -(k.dd || 1) * 0.12 : 0; // lean into the drift
        // Turbo flames.
        const fast = !out && (k.bo || k.mt);
        P.flames.forEach((f, j) => {
          f.visible = !!fast;
          if (!fast) return;
          const fl = 0.8 + 0.3 * Math.sin(t * 40 + j);
          f.material.color.copy(o.C(j ? (k.bo ? '#fff6a0' : '#e8fbff') : k.bo ? '#b05cff' : '#5cd6ff'));
          f.scale.set(1, (j ? 0.55 : 0.85) * fl + 0.2, 1);
        });
        // Drift sparks behind the rear wheels.
        const spk = k.dr === 3 ? '#ff9a2e' : k.dr === 2 ? '#5cd6ff' : '#eeeeee';
        const ca = Math.cos(k.a), sa = Math.sin(k.a);
        P.sparks.forEach((s, j) => {
          s.visible = !!k.dr && !out;
          if (!s.visible) return;
          const wy = j < 3 ? -0.8 : 0.8;
          const bx = k.x - ca * R * 0.7 - sa * wy * R, by = k.y - sa * R * 0.7 + ca * wy * R;
          const a = k.a + Math.PI + Math.sin(t * 50 + j * 2.1) * 0.8;
          const ln = 8 + ((t * 120 + j * 13) % 18);
          K.place(s, bx + Math.cos(a) * ln, by + Math.sin(a) * ln, lift + 4 + (j % 3) * 4);
          s.scale.setScalar(k.dr >= 2 ? 5 : 3.5);
          s.material.color.copy(o.C(spk));
        });
        // Driver, sitting in the cart.
        const mood = out ? 'ok' : k.sp ? 'dizzy' : k.iv > 0 ? 'hurt' : 'ok';
        const anim = out ? 'Sit_Floor_Idle' : k.sp ? 'Hit_B' : k.hy ? 'Cheer' : k.iv > 0 ? 'Hit_A' : 'Sit_Chair_Idle';
        P.av.set(k.x, k.y, { r: R * 0.55, h: lift + R * 0.3, look: ang, mood, anim, alpha: al, gear: false, marker: !out, lean: k.dr ? 0.15 : 0 });
        // Bladders float above and behind, on strings tied to the seat.
        const n = out ? 0 : Math.max(0, Math.round(k.b));
        const br = 19 * (k.s || 1) + 3;
        const ax = k.x - ca * R * 0.75, ay = k.y - sa * R * 0.75, ah = lift + R * 0.9;
        P.balloons.forEach((B, j) => {
          const on = j < n;
          B.ball.visible = B.str.visible = on;
          if (!on) return;
          // The bunch always floats AWAY from the camera (world -y) and spreads along world x, whatever the
          // heading: so it never sits between the camera and the driver.
          const side = (j - (n - 1) / 2) * br * 1.5 + Math.sin(t * 2.6 + j * 1.7 + i) * 4 - ca * R * 0.25;
          const back = R * 0.55 + br + 10 + Math.abs(j - (n - 1) / 2) * 5 + Math.sin(t * 3.3 + j) * 3;
          const bx = k.x + side, by = k.y - back;
          const bh = lift + R * 1.5 + 54 - Math.abs(j - (n - 1) / 2) * 8 + Math.sin(t * 2.2 + j) * 5;
          K.place(B.ball, bx, by, bh);
          B.ball.scale.set(br, br * 1.15, br);
          B.ball.rotation.z = Math.sin(t * 2 + j) * 0.15;
          // String from the seat to the knot.
          K.p(ax, ay, ah, o.v1);
          K.p(bx, by, bh - br * 1.25, o.v2);
          const len = o.v1.distanceTo(o.v2);
          B.str.position.copy(o.v1).add(o.v2).multiplyScalar(0.5);
          o.v2.sub(o.v1).normalize();
          B.str.quaternion.setFromUnitVectors(o.up, o.v2);
          B.str.scale.set(0.9, len, 0.9);
        });
        // Invulnerability ring.
        P.inv.visible = !out && k.iv > 0 && !k.sp;
        if (P.inv.visible) { K.place(P.inv, k.x, k.y, lift + 6); P.inv.scale.setScalar(R + 12); }
        // Held item bubble (offset toward this player's side of the screen).
        const it = out ? 0 : Math.round(k.it);
        P.bubble.visible = it !== 0;
        if (it !== 0) {
          const show = it < 0 ? 1 + (Math.floor(t * 14) % 4) : it;
          const key = `${it}|${show}`;
          if (key !== P.itemKey) {
            P.itemKey = key;
            P.bst.show = show;
            P.bubble.redraw();
          }
          const oy = i === 1 ? 1 : -1;
          K.place(P.bubble, k.x, k.y + oy * (R + 40), lift + 70 + Math.sin(t * 4) * 3);
        }
      });
    },
  },

  render(d, v, r) {
    const { ctx } = d;
    const flip = v.fl === 1;
    const t = d.t;
    // --- Backdrop: night stadium gradient ---
    const bg = ctx.createRadialGradient(CX, CY, 200, CX, CY, 900);
    bg.addColorStop(0, flip ? '#2a0f45' : '#24405a'); bg.addColorStop(1, flip ? '#0c0418' : '#0b1522');
    ctx.fillStyle = bg;
    ctx.fillRect(-300, -300, W + 600, H + 600);
    d.rrect(EDGE - 26, EDGE - 20, W - 2 * EDGE + 52, H - 2 * EDGE + 52, 34, 'rgba(0,0,0,0.4)');
    d.rrect(EDGE - 26, EDGE - 26, W - 2 * EDGE + 52, H - 2 * EDGE + 52, 34, flip ? '#4b1f7a' : '#c8402e', flip ? '#ff5ce1' : '#7a1f14', 4);
    if (flip) {
      const fg = ctx.createRadialGradient(CX, CY, 50, CX, CY, 650);
      fg.addColorStop(0, '#3a1763'); fg.addColorStop(1, '#170828');
      ctx.fillStyle = fg;
      ctx.fillRect(EDGE, EDGE, W - 2 * EDGE, H - 2 * EDGE);
      d.grid(100, 'rgba(255,120,240,0.07)');
      for (let k = 0; k < 6; k++) d.ring(CX, CY, 120 + k * 70 + ((t * 30) % 70), `rgba(255,90,220,${0.1 - k * 0.014})`, 3);
    } else {
      // Grass with mowing stripes, asphalt ring and start lines.
      const gg = ctx.createLinearGradient(0, EDGE, 0, H - EDGE);
      gg.addColorStop(0, '#3f8a50'); gg.addColorStop(0.5, '#4d9c5c'); gg.addColorStop(1, '#3f8a50');
      ctx.fillStyle = gg;
      ctx.fillRect(EDGE, EDGE, W - 2 * EDGE, H - 2 * EDGE);
      for (let x = EDGE; x < W - EDGE; x += 92 * 2) d.rect(x, EDGE, 92, H - 2 * EDGE, 'rgba(255,255,255,0.045)');
      d.ring(CX, CY, 230, 'rgba(40,40,52,0.55)', 70);
      ctx.save(); ctx.setLineDash([26, 22]); ctx.lineDashOffset = -t * 20;
      d.ring(CX, CY, 230, 'rgba(255,255,255,0.35)', 4);
      ctx.restore();
      for (let k = 0; k < 10; k++) { d.rect(400 + k * 20, 905 + (k % 2) * 10, 20, 10, '#fff'); d.rect(400 + k * 20, 85 + (k % 2) * 10, 20, 10, '#fff'); }
    }
    // Fence: striped curb on normal arena, neon on the flipper.
    if (!flip) {
      for (let k = 0; k < 24; k++) {
        const c = k % 2 ? '#ffffff' : '#ff3a3a';
        const q = EDGE + k * ((W - 2 * EDGE) / 24), sz = (W - 2 * EDGE) / 24;
        d.rect(q, EDGE - 12, sz, 12, c); d.rect(q, H - EDGE, sz, 12, c);
        d.rect(EDGE - 12, q, 12, sz, c); d.rect(W - EDGE, q, 12, sz, c);
      }
    } else d.neon(() => d.rect(EDGE, EDGE, W - 2 * EDGE, H - 2 * EDGE, null, '#ff5ce1', 5), '#ff5ce1');

    if (!flip) {
      // Ramps: striped boards with moving chevrons pointing the jump direction.
      for (const [rx, ry, rw, rh, ang] of RAMPS) {
        d.rect(rx + 6, ry + 8, rw, rh, 'rgba(0,0,0,0.3)');
        d.rrect(rx, ry, rw, rh, 8, '#f2c230', '#7a5a00', 4);
        ctx.save();
        ctx.translate(rx + rw / 2, ry + rh / 2); ctx.rotate(ang);
        const sh = ((t * 40) % 30) - 15;
        for (let k = -1; k <= 1; k++) d.poly([k * 30 - 10 + sh, -18, k * 30 + 8 + sh, 0, k * 30 - 10 + sh, 18], null, '#3a2a00', 6);
        ctx.restore();
      }
      // Blocks: tyre walls.
      for (const [x, y, w, h] of OBST) {
        d.rect(x + 7, y + 10, w, h, 'rgba(0,0,0,0.35)');
        d.rrect(x, y, w, h, 12, '#4f5d78', '#232b3d', 4);
        for (let q = x + 15; q < x + w - 5; q += 28) d.circle(q, y + h / 2, Math.min(12, h / 2 - 6), '#2b3346', '#6c7a96', 3);
        d.rrect(x + 6, y + 4, w - 12, h * 0.25, 6, 'rgba(255,255,255,0.15)');
      }
    } else {
      for (const [ax, ay, bx, by] of BEVELS) d.neon(() => d.line(ax, ay, bx, by, '#5cf2ff', 10), '#5cf2ff');
      BUMPERS.forEach(([x, y, br], j) => {
        const lit = (v.bl[j] || 0) > 0;
        d.circle(x + 6, y + 9, br, 'rgba(0,0,0,0.35)');
        d.circle(x, y, br, lit ? '#ffffff' : '#ff3fa4', '#ffd0f0', 5);
        d.circle(x, y, br * 0.62, lit ? '#ffe46b' : '#ff8ad0');
        d.star(x, y, br * 0.4, lit ? '#ff3fa4' : '#fff', 5);
        if (lit) d.ring(x, y, br + 12, '#ffe46b', 4);
      });
    }

    // --- Item boxes ---
    BOXES.forEach(([x, y], j) => {
      const st = v.bx[j];
      if (!st) { d.circle(x, y, 8, 'rgba(255,255,255,0.22)'); return; }
      const bob = Math.sin(t * 3 + j) * 5;
      d.shadow(x, y + 26, 28, 9, 0.3);
      ctx.save();
      ctx.translate(x, y + bob); ctx.rotate(t * 1.2 + j);
      const hue = (t * 120 + j * 60) % 360;
      const ok = st === 1;
      d.rrect(-BOX_R * 0.8, -BOX_R * 0.8, BOX_R * 1.6, BOX_R * 1.6, 10, ok ? `hsla(${hue},90%,60%,0.5)` : 'rgba(120,120,120,0.35)', ok ? `hsl(${hue},100%,78%)` : '#888', 5);
      ctx.restore();
      d.text('?', x, y + bob + 2, { size: 40, color: ok ? '#fff' : '#999' });
    });

    // --- Golden balloon ---
    if (v.gd) {
      const gd = v.gd, bob = Math.sin(t * 3) * 8;
      d.shadow(gd.x, gd.y + 40, 20, 7, 0.3);
      d.circle(gd.x, gd.y - 6 + bob, GOLD_R + 14 + 4 * Math.sin(t * 7), 'rgba(255,210,63,0.22)');
      d.line(gd.x, gd.y + GOLD_R - 4 + bob, gd.x + Math.sin(t * 4) * 5, gd.y + 40, 'rgba(255,255,255,0.8)', 2);
      d.circle(gd.x, gd.y - 6 + bob, GOLD_R, '#ffd23f', '#fff6c0', 4);
      d.circle(gd.x - 8, gd.y - 15 + bob, 7, 'rgba(255,255,255,0.8)');
      d.star(gd.x + 30 * Math.cos(t * 3), gd.y - 6 + bob + 30 * Math.sin(t * 3), 7, '#fff8c0', 4);
    }

    // --- Bananas on the ground ---
    for (const b of v.bn) { d.shadow(b.x, b.y + 12, 20, 7, 0.3); d.emoji('💩', b.x, b.y, 48); }

    // --- Falling bananas: growing shadow warns before impact ---
    for (const f of v.fb) {
      const k = clamp(1 - f.t / 1.1, 0, 1);
      d.circle(f.x, f.y, 16 + 26 * k, `rgba(0,0,0,${0.15 + 0.3 * k})`);
      if (Math.floor(t * 10) % 2) d.ring(f.x, f.y, 44, 'rgba(255,230,80,0.7)', 4);
      d.emoji('💩', f.x, f.y - f.t * 260, 34 + 16 * k);
    }

    // --- Shells ---
    for (const o of v.sh) {
      const red = Math.round(o.t) === RED;
      d.shadow(o.x, o.y + 10, SHELL_R, 7, 0.35);
      d.circle(o.x, o.y, SHELL_R, red ? '#ff3b3b' : '#30e070', '#fff', 4);
      ctx.save(); ctx.translate(o.x, o.y); ctx.rotate(t * 9);
      d.poly([-10, -6, 0, -11, 10, -6, 10, 6, 0, 11, -10, 6], red ? '#ffb0b0' : '#b8ffcf');
      ctx.restore();
      if (red) d.ring(o.x, o.y, SHELL_R + 6 + 3 * Math.sin(t * 20), 'rgba(255,80,80,0.6)', 3);
    }

    // --- Karts ---
    v.k.forEach((k, i) => {
      const hop = k.hp > 0 ? Math.sin(clamp(1 - k.hp / 0.5, 0, 1) * Math.PI) : 0;
      const lift = hop * 26;
      const ghost = k.o > 0;
      const blink = ghost || (k.iv > 0 && k.sp === 0 && Math.floor(t * 14) % 2 === 0);
      const R = k.r;
      d.shadow(k.x, k.y + 12, R * (1.15 - hop * 0.3), R * 0.5, 0.35);
      // Drift sparks under the rear wheels (grey → blue → orange as the mini-turbo charges).
      if (k.dr) {
        const spk = k.dr === 3 ? '#ff9a2e' : k.dr === 2 ? '#5cd6ff' : '#dddddd';
        for (const wy of [-0.78, 0.78]) {
          const bx = k.x - Math.cos(k.a) * R * 0.6 - Math.sin(k.a) * wy * R, by = k.y - Math.sin(k.a) * R * 0.6 + Math.cos(k.a) * wy * R;
          for (let j = 0; j < 3; j++) {
            const a = k.a + Math.PI + Math.sin(t * 50 + j * 2.1) * 0.8;
            const ln = 10 + ((t * 120 + j * 13) % 18);
            d.line(bx, by, bx + Math.cos(a) * ln, by + Math.sin(a) * ln, spk, 3);
          }
        }
      }
      ctx.save();
      if (blink) ctx.globalAlpha = ghost ? 0.3 : 0.45;
      ctx.translate(k.x, k.y - lift);
      const sc = 1 + hop * 0.18;
      ctx.scale(sc, sc);
      ctx.rotate(k.a + (k.dr ? (k.dd || 1) * 0.25 : 0));
      if (k.bo || k.mt) { // turbo flames (orange mushroom, blue mini-turbo)
        const fl = 0.8 + 0.3 * Math.sin(t * 40);
        const c1 = k.bo ? '#ffb02e' : '#5cd6ff', c2 = k.bo ? '#fff6a0' : '#e8fbff';
        d.poly([-R * 0.9, -R * 0.35, -R * (1.7 + fl * 0.5), 0, -R * 0.9, R * 0.35], c1);
        d.poly([-R * 0.9, -R * 0.18, -R * (1.3 + fl * 0.3), 0, -R * 0.9, R * 0.18], c2);
      }
      for (const wx of [-0.55, 0.55]) for (const wy of [-0.8, 0.8]) d.rrect(wx * R - R * 0.27, wy * R - R * 0.19, R * 0.54, R * 0.38, 5, '#15151c', '#3a3a48', 2);
      d.rrect(-R, -R * 0.64, R * 2, R * 1.28, R * 0.42, d.col(i, 'main'), d.col(i, 'dark'), 4);
      d.rrect(-R * 0.8, -R * 0.52, R * 1.3, R * 0.3, R * 0.15, 'rgba(255,255,255,0.3)');
      d.rrect(R * 0.55, -R * 0.5, R * 0.42, R, R * 0.2, d.col(i, 'light'));
      ctx.restore();
      const mood = k.sp ? 'dizzy' : k.hy ? 'happy' : k.bo || k.mt ? 'angry' : k.iv > 0 ? 'hurt' : k.b <= 1 ? 'scared' : 'ok';
      d.avatar(k.x, k.y - lift, R * 0.62, i, { look: k.a, mood, alpha: blink ? 0.45 : 1 });

      // Balloons trail behind the kart, swaying on their strings.
      const n = ghost ? 0 : Math.max(0, Math.round(k.b));
      const br = 19 * (k.s || 1) + 4;
      for (let j = 0; j < n; j++) {
        const off = (j - (n - 1) / 2) * 0.55 + Math.sin(t * 2.6 + j * 1.7 + i) * 0.16;
        const ang = k.a + Math.PI + off;
        const ln = R + 34 + Math.sin(t * 3.3 + j) * 5;
        const bx = k.x + Math.cos(ang) * ln, by = k.y - lift + Math.sin(ang) * ln - 12;
        d.line(k.x, k.y - lift, bx, by + br, 'rgba(255,255,255,0.75)', 2);
        d.shadow(bx, by + 40, br * 0.7, br * 0.3, 0.18);
        d.circle(bx, by, br, j % 2 ? d.col(i, 'light') : d.col(i, 'main'), '#ffffffaa', 3);
        d.poly([bx - 5, by + br + 5, bx + 5, by + br + 5, bx, by + br - 2], d.col(i, 'dark'));
        d.circle(bx - br * 0.35, by - br * 0.35, br * 0.28, 'rgba(255,255,255,0.75)');
      }

      // Held item bubble, offset toward the top of this player's own view.
      const it = ghost ? 0 : Math.round(k.it);
      if (it !== 0) {
        const oy = i === 1 ? 1 : -1;
        const ix = k.x, iy = k.y - lift + oy * (R + 54);
        d.circle(ix, iy, 28, 'rgba(0,0,0,0.6)', d.col(i, 'light'), 4);
        const show = it < 0 ? 1 + (Math.floor(t * 14) % 4) : it;
        if (show === GREEN || show === RED) d.circle(ix, iy, 15, show === RED ? '#ff3b3b' : '#30e070', '#fff', 3);
        else d.emoji(show === BANANA ? '💩' : '🧪', ix, iy, 36);
        if (it > 0) d.ring(ix, iy, 32 + 3 * Math.sin(t * 8), '#ffffff88', 2);
      }
      if (k.iv > 0 && !k.sp) d.ring(k.x, k.y - lift, R + 12, d.col(i, 'light') + '66', 3);
    });
  },
};

// ---------------------------------------------------------------- Bot ----------------------------------------------------------------
// Drives to a goal (golden bladder, item crystal, a rival to attack) going around blocks/bumpers/dung with a corner
// waypoint, dodges incoming cabbages and falling dung, and uses the item when it pays: cabbage when a rival is lined up
// (difficile leads the shot), fireball when a rival is in sight, dung behind when chased (or to stop a fireball),
// potion to ram someone or reach the golden bladder first.
const P_PEND = [0.34, 0.2, 0.09];
const PSIM = { flip: false, bl: BUMPERS.map(() => 0) }; // scratch world for predicting cabbage bounces

// Does segment a->b pass through the rect grown by pad? (slab test)
function segHitsRect(ax, ay, bx, by, R, pad) {
  const x0 = R[0] - pad, y0 = R[1] - pad, x1 = R[0] + R[2] + pad, y1 = R[1] + R[3] + pad;
  const dx = bx - ax, dy = by - ay;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}
function segNearPt(ax, ay, bx, by, px, py) {
  const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy || 1;
  const u = clamp(((px - ax) * vx + (py - ay) * vy) / L2, 0, 1);
  return Math.hypot(px - ax - vx * u, py - ay - vy * u);
}

// Obstacles as rects/circles for path checks (blocks or bumpers, plus dung on the ground).
function pObstacles(s, me) {
  const list = [];
  if (!s.flip) for (const R of OBST) list.push({ R });
  else for (const [x, y, r] of BUMPERS) list.push({ x, y, r });
  for (const b of s.bn) if (!b.dead && !(b.o === me && b.gr > 0)) list.push({ x: b.x, y: b.y, r: BANANA_R * 0.8 + 30, soft: 1 });
  for (const f of s.fb) if (f.t < 1.0) list.push({ x: f.x, y: f.y, r: 30, soft: 1 });
  return list;
}
const blocks = (o, ax, ay, bx, by, pad) => (o.R ? segHitsRect(ax, ay, bx, by, o.R, pad) : segNearPt(ax, ay, bx, by, o.x, o.y) < o.r + pad);

// Next point to steer at to reach (tx, ty): straight if clear, else around the first obstacle in the way.
function pWaypoint(obs, x, y, tx, ty, pad) {
  let first = null, fd = Infinity;
  for (const o of obs) {
    if (!blocks(o, x, y, tx, ty, pad)) continue;
    const ox = o.R ? o.R[0] + o.R[2] / 2 : o.x, oy = o.R ? o.R[1] + o.R[3] / 2 : o.y;
    const d = Math.hypot(ox - x, oy - y);
    if (d < fd) { fd = d; first = o; }
  }
  if (!first) return [tx, ty];
  const cand = [];
  const m = pad + 22;
  if (first.R) {
    const [rx, ry, rw, rh] = first.R;
    cand.push([rx - m, ry - m], [rx + rw + m, ry - m], [rx - m, ry + rh + m], [rx + rw + m, ry + rh + m]);
  } else {
    const ang = Math.atan2(first.y - y, first.x - x), rr = first.r + m;
    for (const s of [-1, 1]) cand.push([first.x + Math.cos(ang + s * Math.PI / 2) * rr, first.y + Math.sin(ang + s * Math.PI / 2) * rr]);
  }
  let best = [tx, ty], bv = Infinity;
  for (const [cx, cy] of cand) {
    if (cx < EDGE + 30 || cx > W - EDGE - 30 || cy < EDGE + 30 || cy > H - EDGE - 30) continue;
    let v = Math.hypot(cx - x, cy - y) + Math.hypot(tx - cx, ty - cy);
    if (blocks(first, x, y, cx, cy, pad * 0.7)) v += 2000;
    if (v < bv) { bv = v; best = [cx, cy]; }
  }
  return best;
}

// Clear straight line (no block/bumper) between two points?
function pClear(s, ax, ay, bx, by, pad) {
  if (!s.flip) { for (const R of OBST) if (segHitsRect(ax, ay, bx, by, R, pad)) return false; return true; }
  for (const [x, y, r] of BUMPERS) if (segNearPt(ax, ay, bx, by, x, y) < r + pad) return false;
  return true;
}

function pallBot(s, me, g, B) {
  const k = s.k[me], L = B.level;
  const out = { x: 0, y: 0 };
  if (!k || k.out) return out;
  const m = B.mem;
  const delay = P_PEND[L];
  PSIM.flip = s.flip;
  // Where we will be when this command lands.
  const x = clamp(k.x + k.vx * delay, EDGE + k.r, W - EDGE - k.r), y = clamp(k.y + k.vy * delay, EDGE + k.r, H - EDGE - k.r);
  const foes = s.k.filter((q) => q.i !== me && !q.out);
  if (!foes.length) return out;
  const speed = Math.hypot(k.vx, k.vy);
  const fa = Math.cos(k.a), fb = Math.sin(k.a);

  // --- Danger: cabbages / fireballs coming at us, dung falling from the sky ---
  let dodge = null;
  {
    for (const o of s.sh) {
      if (o.o === me && o.gr > 0) continue;
      if (L === 0 && o.o !== me && o.id % 2) continue; // the easy bot only notices some of them
      // Follow the ball for ~1 s with its bounces (fireballs home on someone else, never their owner).
      const q = m.shq || (m.shq = { x: 0, y: 0, vx: 0, vy: 0, r: 0 });
      q.x = o.x; q.y = o.y; q.vx = o.vx; q.vy = o.vy; q.r = o.r;
      for (let j = 0; j < 18; j++) {
        const ax = q.x, ay = q.y;
        q.x += q.vx * 0.05; q.y += q.vy * 0.05;
        if (o.t === GREEN) collideWorld(PSIM, q, 1, 0);
        // where we will be at that time (keep rolling)
        const tt = (j + 1) * 0.05, mx = k.x + k.vx * Math.min(tt, 0.3), my = k.y + k.vy * Math.min(tt, 0.3);
        if (segNearPt(ax, ay, q.x, q.y, mx, my) < k.r + o.r + 22) {
          if (L === 2 && k.item === BANANA && k.roll <= 0 && (o.x - k.x) * fa + (o.y - k.y) * fb < 0) out.tapA = true;
          const sp = Math.hypot(q.vx, q.vy) || 1;
          const side = (q.vx * (my - ay) - q.vy * (mx - ax)) > 0 ? 1 : -1;
          dodge = [-q.vy / sp * side, q.vx / sp * side];
          break;
        }
      }
    }
  }
  for (const f of s.fb) {
    if (f.t < 0.9 && Math.hypot(f.x - x, f.y - y) < k.r + 40) {
      const dx = x - f.x, dy = y - f.y, d = Math.hypot(dx, dy) || 1;
      dodge = [dx / d, dy / d];
    }
  }

  // --- Goal ---
  let tx = null, ty = null, why = '';
  const myDist = (px, py) => Math.hypot(px - k.x, py - k.y);
  if (s.gold) {
    const mine = myDist(s.gold.x, s.gold.y);
    const best = Math.min(...foes.map((q) => Math.hypot(s.gold.x - q.x, s.gold.y - q.y)));
    if (mine < best * (L === 2 ? 1.3 : L === 1 ? 1.1 : 0.7) || (L === 0 && mine < 220)) { tx = s.gold.x; ty = s.gold.y; why = 'gold'; }
  }
  // Target rival: the nearest (difficile: prefers the leader when close enough).
  let tgt = foes[0], td = Infinity;
  for (const q of foes) {
    let d = Math.hypot(q.x - k.x, q.y - k.y);
    if (L === 2) d -= q.b * 60;
    if (d < td) { td = d; tgt = q; }
  }
  if (tx === null) {
    if (!k.item && k.roll <= 0) {
      let bd = Infinity;
      for (let j = 0; j < BOXES.length; j++) {
        if (s.box[j] > 0.4) continue;
        const d = myDist(BOXES[j][0], BOXES[j][1]);
        if (d < bd) { bd = d; tx = BOXES[j][0]; ty = BOXES[j][1]; }
      }
      why = 'box';
    }
    if (tx === null) {
      // Attack position: behind/beside the rival at shooting distance.
      const dist = k.item === BANANA ? 0 : k.item === SHROOM ? 0 : 230;
      const ang = Math.atan2(k.y - tgt.y, k.x - tgt.x);
      tx = clamp(tgt.x + Math.cos(ang) * dist, EDGE + 60, W - EDGE - 60);
      ty = clamp(tgt.y + Math.sin(ang) * dist, EDGE + 60, H - EDGE - 60);
      why = 'chase';
      // Too close with nothing to throw: point at the rival anyway (bump), easy just wanders.
      if (k.item === BANANA) {
        // Run ahead of the rival so it drives into our dung: head for the next crystal or the far side.
        tx = W - tgt.x; ty = H - tgt.y; why = 'lure';
      }
    }
  }
  if (L === 0) {
    if (!(m.wT > g.t) && B.rng() < 0.006) { m.wT = g.t + 1 + B.rng(); m.wx = 150 + B.rng() * 700; m.wy = 150 + B.rng() * 700; }
    if (m.wT > g.t && why !== 'gold') { tx = m.wx; ty = m.wy; }
  }

  // --- Item use ---
  if (k.item && k.roll <= 0 && k.spin <= 0 && !out.tapA) {
    const it = k.item;
    if (it === GREEN || (s.flip && it)) {
      for (const q of foes) {
        const d = Math.hypot(q.x - k.x, q.y - k.y);
        const tt = d / GREEN_V;
        const lead = L === 2 ? 1 : L === 1 ? 0.5 : 0;
        const px = q.x + q.vx * tt * lead, py = q.y + q.vy * tt * lead;
        const ang = Math.atan2(py - k.y, px - k.x);
        const tol = Math.atan2(q.r * (L === 0 ? 1.4 : 0.8), d);
        if (d < (s.flip ? 700 : L === 0 ? 320 : 550) && Math.abs(angleDiff(k.a, ang)) < tol && (s.flip || pClear(s, k.x, k.y, px, py, SHELL_R))) out.tapA = true;
      }
      if (!out.tapA && why === 'chase') { // line up the throw
        const ang = Math.atan2(tgt.y - k.y, tgt.x - k.x);
        if (td < 500) { tx = k.x + Math.cos(ang) * 200; ty = k.y + Math.sin(ang) * 200; }
      }
    } else if (it === RED) {
      // Fireball homes on the nearest rival: fire when that one is in sight and not behind us.
      let nq = null, nd = Infinity;
      for (const q of foes) { const d = Math.hypot(q.x - k.x, q.y - k.y); if (d < nd) { nd = d; nq = q; } }
      const ahead = (nq.x - k.x) * fa + (nq.y - k.y) * fb > (L === 0 ? -50 : nd * 0.3);
      if (nd < 650 && ahead && pClear(s, k.x, k.y, nq.x, nq.y, SHELL_R + 4)) out.tapA = true;
    } else if (it === BANANA) {
      // Drop it when a rival follows us closely (or randomly for the easy bot).
      for (const q of foes) {
        const rel = (q.x - k.x) * fa + (q.y - k.y) * fb, d = Math.hypot(q.x - k.x, q.y - k.y);
        if (rel < 0 && d < (L === 0 ? 250 : 380)) out.tapA = true;
      }
      if (L === 0 && B.rng() < 0.004) out.tapA = true;
    } else if (it === SHROOM) {
      // Potion: ram a rival in front of us (steals a bladder) or rush to the golden one.
      const ang = Math.atan2(tgt.y - k.y, tgt.x - k.x);
      if (td < (L === 2 ? 330 : 250) && Math.abs(angleDiff(k.a, ang)) < 0.35 && tgt.inv <= 0) out.tapA = true;
      if (why === 'gold' && L > 0 && myDist(tx, ty) > 250 && Math.abs(angleDiff(k.a, Math.atan2(ty - k.y, tx - k.x))) < 0.3) out.tapA = true;
      if (L === 0 && B.rng() < 0.004) out.tapA = true;
      if (why === 'chase') { tx = tgt.x; ty = tgt.y; }
    }
  }

  // --- Steering ---
  if (dodge) { out.x = dodge[0]; out.y = dodge[1]; return out; }
  const obs = pObstacles(s, me);
  const [wx, wy] = pWaypoint(obs, x, y, tx, ty, k.r + 8);
  let dx = wx - x, dy = wy - y, d = Math.hypot(dx, dy) || 1;
  dx /= d; dy /= d;
  // Push away from dung lying close in front of us (turning circles sweep wide).
  for (const b of s.bn) {
    if (b.dead || (b.o === me && b.gr > 0)) continue;
    const ex = x - b.x, ey = y - b.y, e = Math.hypot(ex, ey) || 1;
    if (e > 170 || ex * k.vx + ey * k.vy > 0) continue; // behind us already
    const w = ((170 - e) / 170) * 2.2;
    dx += (ex / e) * w; dy += (ey / e) * w;
  }
  const dl = Math.hypot(dx, dy) || 1;
  // Slow down a bit for tight goals so we do not orbit them.
  const mag = d < 90 && why !== 'chase' ? 0.6 : 1;
  out.x = (dx / dl) * mag; out.y = (dy / dl) * mag;
  // Stuck against something: back off sideways for a moment.
  if (speed < 40 && g.t > 1) { m.stuck = (m.stuck || 0) + (g.dt || 1 / 60); } else m.stuck = 0;
  if (m.stuck > 0.6) { m.unstickT = g.t + 0.5; m.ua = k.a + Math.PI * (0.6 + B.rng() * 0.8); m.stuck = 0; }
  if (m.unstickT > g.t) { out.x = Math.cos(m.ua); out.y = Math.sin(m.ua); }
  return out;
}
