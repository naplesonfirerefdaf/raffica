// Barili Giù dalla Collina — side-view climbing race (Donkey Kong style), 2–4 players (free-for-all or 2 vs 2).
// A green ogre on the hilltop rolls barrels down the zig-zag paths: run, jump them (A), climb the ladders,
// shove the others (B: off ladders, off edges). First to reach the castle banner at the top wins.
import { clamp, approach, damp, lerp, sign, r1, r2 } from '../core/geom.js';

const W = 1200, H = 840;
const R = 30;                                   // player radius (body center = feet - R)
const G = 2400, JUMP_V = 560, RUN = 235, CLIMB = 150;
const SLAB = 24;                                // path thickness (ceiling for jumps from below)
const DUR = 60, RAGE_T = 45;
const HOIST_T = 0.6;
const BR = 22, GIANT_R = 46;
// Paths: surface from (x0, ya) to (x1, yb); dir = where barrels roll (+1 right, -1 left).
const LV = [
  { x0: -400, x1: 1600, ya: 790, yb: 790, dir: -1 },  // 0 valley path (start)
  { x0: 90, x1: 1300, ya: 656, yb: 620, dir: -1 },
  { x0: -100, x1: 1110, ya: 480, yb: 516, dir: 1 },
  { x0: 90, x1: 1300, ya: 376, yb: 340, dir: -1 },
  { x0: -100, x1: 1110, ya: 200, yb: 236, dir: 1 },
  { x0: 700, x1: 1400, ya: 86, yb: 86, dir: 0 },      // 5 castle terrace (goal)
  { x0: -300, x1: 430, ya: 86, yb: 86, dir: 0 },      // 6 the ogre's rock
];
const TOP = 5, ROCK = 6;
const LAD = [
  { x: 420, lo: 0, hi: 1 }, { x: 780, lo: 0, hi: 1 },
  { x: 130, lo: 1, hi: 2 }, { x: 1060, lo: 1, hi: 2 },
  { x: 560, lo: 2, hi: 3 }, { x: 640, lo: 2, hi: 3 },
  { x: 150, lo: 3, hi: 4 }, { x: 1050, lo: 3, hi: 4 },
  { x: 760, lo: 4, hi: 5 },
];
const GOAL_X = 1120;
const START = { 2: [270, 930], 3: [270, 570, 930], 4: [270, 570, 630, 930] };
const OGRE_X = 250;
// Player states.
const GROUND = 0, AIR = 1, LADDER = 2, HOIST = 3, WIN = 4;
// Barrel kinds and states.
const NORMAL = 0, FIRE = 1, BOUNCE = 2;
const ROLL = 0, FLY = 1, DOWN = 2;
const BOT_LAG = [0.34, 0.2, 0.09].map((d) => d + 1 / 60);

const surf = (L, x) => L.ya + ((L.yb - L.ya) * (x - L.x0)) / (L.x1 - L.x0);
const inL = (L, x) => x >= L.x0 && x <= L.x1;
const ladTop = (l) => surf(LV[l.hi], l.x);
const ladBot = (l) => surf(LV[l.lo], l.x);
// Floor index used for progress/HUD.
const floorOf = (p) => (p.st === LADDER ? LAD[p.ld].lo : p.st === WIN ? TOP : p.lv);

function barrelSpeed(s, b) {
  if (b.giant) return 165;
  const late = clamp(s.t / DUR, 0, 1);
  const base = b.k === FIRE ? 320 : b.k === BOUNCE ? 225 : 240;
  return base * (1 + late * 0.2) * (s.ice ? 1.25 : 1);
}

function throwBarrel(s, g) {
  const v = g.variant;
  let k = NORMAL;
  if (v === 'fuoco') k = FIRE;
  else { const r = g.rng(); k = r < 0.18 ? FIRE : r < 0.36 ? BOUNCE : NORMAL; }
  const giant = v === 'giganti';
  if (giant && k === BOUNCE) k = NORMAL;
  const r = giant ? GIANT_R : BR;
  s.b.push({ id: s.nid++, k, giant, r, x: OGRE_X + 120, y: 86 - r - 40, vx: 300, vy: -250, st: FLY, lv: -1, ld: -1, a: 0, jb: 0, fT: 0, bT: 0 });
  g.sfx('whoosh', { pitch: giant ? 0.5 : 0.8 });
  if (k === FIRE) g.sfx('fire', { vol: 0.6 });
}

function landBarrel(s, g, b, k) {
  const L = LV[k];
  b.lv = k;
  b.y = surf(L, b.x) - b.r;
  const fast = b.vy > 500;
  b.vx = L.dir * barrelSpeed(s, b);
  if (b.k === BOUNCE && !b.giant) { b.vy = -650; b.st = FLY; if (fast) g.sfx('boing', { vol: 0.35, pitch: 1.3 }); return; }
  b.vy = 0; b.st = ROLL;
  if (fast) {
    g.sfx(b.giant ? 'crash' : 'land', { vol: b.giant ? 0.6 : 0.4, pitch: 0.7 });
    if (b.giant) g.shake(0.25);
    g.burst(b.x, b.y + b.r, { color: '#c9a06a', n: b.giant ? 12 : 5, speed: 160, size: 6 });
  }
}

function updateBarrel(s, g, b, dt) {
  const px = b.x;
  if (b.st === ROLL) {
    const L = LV[b.lv];
    b.vx = L.dir * barrelSpeed(s, b);
    b.x += b.vx * dt;
    if (!inL(L, b.x)) { b.st = FLY; b.vy = 0; }
    else {
      b.y = surf(L, b.x) - b.r;
      // Sometimes the barrel takes the ladder down (like the classic!).
      if (!b.giant) {
        const late = clamp(s.t / DUR, 0, 1);
        for (let k = 0; k < LAD.length; k++) {
          const l = LAD[k];
          if (l.hi !== b.lv || (px - l.x) * (b.x - l.x) > 0) continue;
          if (g.rng.chance(0.22 + late * 0.15)) { b.st = DOWN; b.ld = k; b.x = l.x; b.vx = 0; b.vy = 0; g.sfx('slide', { vol: 0.4 }); }
          break;
        }
      }
      if (s.fireTrail && b.k === FIRE) {
        b.fT -= dt;
        if (b.fT <= 0 && s.fl.length < 26) { b.fT = 0.2; s.fl.push({ id: s.nid++, x: b.x, y: surf(L, b.x), t: 0 }); }
      }
    }
  } else if (b.st === FLY) {
    const pb = b.y + b.r;
    b.vy = Math.min(1500, b.vy + G * dt);
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (b.vy > 0) {
      let best = -1, by = Infinity;
      for (let k = 0; k <= 4; k++) {
        const L = LV[k];
        if (!inL(L, b.x)) continue;
        const sy = surf(L, b.x);
        if (pb <= sy + 2 && b.y + b.r >= sy && sy < by) { by = sy; best = k; }
      }
      if (best >= 0) landBarrel(s, g, b, best);
    }
  } else {
    const l = LAD[b.ld];
    b.y += 260 * dt;
    if (b.y + b.r >= ladBot(l)) { b.y = ladBot(l) - b.r; b.st = ROLL; b.lv = l.lo; b.vx = LV[l.lo].dir * barrelSpeed(s, b); }
  }
  b.a += (b.st === DOWN ? 8 : b.vx / b.r) * dt;
  if (b.x < -140 || b.x > W + 140 || b.y > H + 120) {
    b.dead = true;
    if (b.x < 0 && b.y > 700) { g.sfx('splash', { vol: 0.35 }); g.burst(-30, 800, { color: '#7fc8ff', n: 6, speed: 180, size: 6 }); }
  }
}

// ---------- players ----------
function landPlayer(g, p, k, vy) {
  p.st = GROUND; p.lv = k; p.vy = 0;
  p.y = surf(LV[k], p.x) - R;
  p.landT = 0.12;
  if (vy > 700 && p.stun <= 0) { g.sfx('land', { vol: 0.5 }); g.burst(p.x, p.y + R, { color: '#d8c49a', n: 5, speed: 140 }); }
}

function knock(s, g, q, dir, power, stun, label, color) {
  if (q.st === LADDER) { q.st = AIR; q.vx = dir * 160; q.vy = 0; q.lv = LAD[q.ld].lo; }
  else { q.st = AIR; q.vx = dir * power; q.vy = -300; }
  q.stun = Math.max(q.stun, stun);
  q.an = 6; q.ak++; q.animT = 0.4;
  if (label) g.text(q.x, q.y - 70, label, { color: color || '#ffffff', size: 40 });
  g.vibrate(q.i, 120);
}

function hitByBarrel(s, g, p, b) {
  const dir = sign(b.vx) || (p.x > b.x ? 1 : -1);
  const stun = b.k === FIRE ? 1.6 : b.giant ? 1.4 : 1.15;
  knock(s, g, p, dir, 260, stun, b.k === FIRE ? 'BRUCIACCHIATO!' : b.giant ? 'SPIACCICATO!' : 'TRAVOLTO!', b.k === FIRE ? '#ff8a2a' : '#ffffff');
  p.vy = -380;
  p.inv = stun + 0.9;
  p.burn = b.k === FIRE ? stun : 0;
  p.squash = b.giant ? 1 : 0;
  g.sfx('crash', { vol: 0.8 }); g.sfx('bonk');
  if (b.k === FIRE) g.sfx('fire');
  g.burst(p.x, p.y, { color: b.k === FIRE ? '#ff8a2a' : '#c98a3b', n: 16, speed: 360, size: 9 });
  g.burst(p.x, p.y, { player: p.i, n: 8, speed: 240 });
  g.shake(0.35); g.hitstop(0.06);
}

function smashBarrel(s, g, b, p) {
  b.dead = true;
  g.sfx('break'); g.sfx('bang', { vol: 0.5 });
  g.burst(b.x, b.y, { color: '#c98a3b', n: 20, speed: 420, size: 10 });
  g.text(b.x, b.y - 50, 'SBAM!', { color: '#ffcf3f', size: 48 });
  g.shake(0.25);
  p.happy = 0.6;
}

function tryHoist(s, g, p) {
  if (!s.tm || p.hoistCd > 0) return false;
  for (const q of s.p) {
    if (q === p || !g.ally(p.i, q.i) || q.st !== GROUND || q.stun > 0) continue;
    if (Math.abs(q.x - p.x) > 75 || Math.abs(q.y - p.y) > 40) continue;
    // The path right above the mate.
    const feet = q.y + R;
    let best = -1, by = -Infinity;
    for (let k = 0; k <= TOP; k++) {
      const L = LV[k];
      if (!inL(L, q.x)) continue;
      const sy = surf(L, q.x);
      if (sy < feet - 30 && feet - sy < 200 && sy > by) { by = sy; best = k; }
    }
    if (best < 0) continue;
    const L = LV[best];
    const hx = clamp(q.x + p.face * 24, Math.max(L.x0 + 12, R), Math.min(L.x1 - 12, W - R));
    q.st = HOIST; q.ht = 0; q.hx0 = q.x; q.hy0 = q.y; q.hx1 = hx; q.hy1 = surf(L, hx) - R; q.hlv = best;
    q.vx = 0; q.vy = 0;
    p.hoistCd = 4; p.an = 7; p.ak++; p.animT = 0.4;
    g.sfx('boing'); g.sfx('jump', { pitch: 1.3 });
    g.text(q.x, q.y - 80, 'HOP! SPINTA DI SQUADRA!', { player: q.i, size: 40 });
    g.ring(q.x, q.y + R, { player: q.i, r: 70 });
    return true;
  }
  return false;
}

function shove(s, g, p) {
  p.shoveCd = 0.8;
  p.an = 5; p.ak++; p.animT = 0.35;
  let best = null, bd = Infinity;
  for (const q of s.p) {
    if (q === p || q.st === WIN || q.st === HOIST || q.stun > 0 || g.ally(p.i, q.i)) continue;
    const dx = q.x - p.x, dy = q.y - p.y;
    if (Math.abs(dy) > 60 || Math.abs(dx) > 85) continue;
    const front = (sign(dx) || p.face) === p.face;
    const d = Math.abs(dx) + (front ? 0 : 25);
    if (d < bd) { bd = d; best = q; }
  }
  if (best) {
    const dir = sign(best.x - p.x) || p.face;
    p.face = dir;
    const ham = p.hamT > 0;
    const onLad = best.st === LADDER;
    knock(s, g, best, dir, ham ? 720 : 520, ham ? 0.9 : 0.5, onLad ? 'GIÙ DALLA SCALA!' : 'SPINTONE!');
    g.sfx('punch'); g.sfx('hit', { pitch: 0.8 });
    g.burst((p.x + best.x) / 2, (p.y + best.y) / 2, { color: '#ffffff', n: 10, speed: 280 });
    g.shake(0.2);
    p.happy = 0.5;
    return;
  }
  if (tryHoist(s, g, p)) return;
  g.sfx('whoosh', { pitch: 1.4, vol: 0.5 });
}

function win(s, g, p) {
  p.st = WIN; p.vx = 0; p.vy = 0;
  s.winner = p.i;
  g.sfx('fanfare'); g.sfx('tada');
  g.confetti(p.x, p.y - 40);
  g.burst(p.x, p.y, { player: p.i, n: 40, speed: 520, size: 12 });
  g.slowmo(0.3, 1.0); g.flash('#fff6c8', 0.5);
  g.say(s.tm ? 'LA SQUADRA CONQUISTA IL CASTELLO!' : 'IN CIMA PER PRIMO!', { big: true });
  g.end(p.i, 'Stendardo conquistato!');
}

function updatePlayer(s, g, p, inp, dt) {
  p.shoveCd = Math.max(0, p.shoveCd - dt);
  p.hoistCd = Math.max(0, p.hoistCd - dt);
  p.inv = Math.max(0, p.inv - dt);
  p.turbo = Math.max(0, p.turbo - dt);
  p.happy = Math.max(0, p.happy - dt);
  p.animT = Math.max(0, p.animT - dt);
  p.landT = Math.max(0, p.landT - dt);
  p.burn = Math.max(0, p.burn - dt);
  p.jbuf = Math.max(0, p.jbuf - dt);
  if (p.hamT > 0) {
    p.hamT -= dt;
    if (p.hamT <= 0) { g.sfx('pop'); g.burst(p.x, p.y - 60, { color: '#ffcf3f', n: 10, speed: 200 }); }
  }
  if (p.st === WIN) return;
  if (p.st === HOIST) {
    p.ht += dt;
    const u = clamp(p.ht / HOIST_T, 0, 1);
    p.x = lerp(p.hx0, p.hx1, u);
    p.y = lerp(p.hy0, p.hy1, u) - Math.sin(Math.PI * u) * 90;
    if (u >= 1) landPlayer(g, p, p.hlv, 800);
    return;
  }
  const stun = p.stun > 0;
  if (stun) { p.stun -= dt; if (p.stun <= 0) p.squash = 0; }
  let mx = inp.sx ?? inp.x ?? 0, my = inp.sy ?? inp.y ?? 0;
  if (Math.abs(mx) < 0.25) mx = 0;
  if (Math.abs(my) < 0.3) my = 0;
  if (stun || g.ended) { mx = 0; my = 0; }
  if (inp.aP && !stun) p.jbuf = 0.13;
  if (inp.bP && !stun && p.shoveCd <= 0 && !g.ended) shove(s, g, p);
  const top = RUN * (p.turbo > 0 ? 1.35 : 1) * (p.hamT > 0 ? 0.85 : 1);

  if (p.st === LADDER) {
    const l = LAD[p.ld];
    const yTop = ladTop(l) - R, yBot = ladBot(l) - R;
    const v = my * CLIMB;
    p.y += v * dt; p.vy = v; p.vx = 0;
    p.climb += Math.abs(v) * dt;
    if (p.y <= yTop) { p.y = yTop; p.st = GROUND; p.lv = l.hi; }
    else if (p.y >= yBot) { p.y = yBot; p.st = GROUND; p.lv = l.lo; }
    else if (Math.abs(mx) > 0.7 && !my) {
      if (p.y - yTop < 26) { p.y = yTop; p.st = GROUND; p.lv = l.hi; }
      else if (yBot - p.y < 26) { p.y = yBot; p.st = GROUND; p.lv = l.lo; }
    }
    if (p.st === GROUND && p.lv === TOP) g.sfx('pickup', { pitch: 1.2 });
    return;
  }

  if (p.st === GROUND) {
    const L = LV[p.lv];
    const acc = s.ice ? (mx ? 650 : 330) : mx ? 2600 : 3000;
    p.vx = approach(p.vx, stun ? 0 : mx * top, acc * dt);
    if (mx) p.face = mx > 0 ? 1 : -1;
    p.x += p.vx * dt;
    if (p.x < R || p.x > W - R) { p.x = clamp(p.x, R, W - R); p.vx = 0; }
    if (!inL(L, p.x)) { p.st = AIR; p.vy = 0; }
    else {
      p.y = surf(L, p.x) - R;
      if (p.jbuf > 0) {
        p.jbuf = 0; p.st = AIR; p.vy = -JUMP_V * Math.sqrt(s.gm);
        g.sfx('jump', { vol: 0.6 });
      } else if (my && Math.abs(my) >= Math.abs(mx) * 0.8) {
        for (let k = 0; k < LAD.length; k++) {
          const l = LAD[k];
          if (Math.abs(p.x - l.x) > 24 || (my < 0 ? l.lo : l.hi) !== p.lv) continue;
          p.st = LADDER; p.ld = k; p.x = l.x; p.vx = 0; p.vy = 0;
          if (p.hamT > 0) { p.hamT = 0; g.text(p.x, p.y - 80, 'LA MAZZA È TROPPO PESANTE!', { player: p.i, size: 34 }); g.sfx('fall', { vol: 0.5 }); }
          break;
        }
      }
    }
    if (p.st === GROUND && p.lv === TOP && p.x >= GOAL_X && !g.ended) win(s, g, p);
    return;
  }

  // In the air.
  if (!stun) { if (mx) { p.vx = approach(p.vx, mx * top, (s.ice ? 900 : 1500) * dt); p.face = mx > 0 ? 1 : -1; } }
  else p.vx *= damp(0.4, dt);
  const pf = p.y + R, ph = p.y - R;
  p.vy = Math.min(1400, p.vy + G * s.gm * dt);
  p.x += p.vx * dt; p.y += p.vy * dt;
  if (p.x < R || p.x > W - R) { p.x = clamp(p.x, R, W - R); p.vx = stun ? -p.vx * 0.4 : 0; }
  if (p.vy < 0) {
    for (let k = 0; k < LV.length; k++) {
      const L = LV[k];
      if (!inL(L, p.x)) continue;
      const sb = surf(L, p.x) + SLAB;
      if (ph >= sb - 0.5 && p.y - R < sb) { p.y = sb + R; p.vy = 0; g.sfx('bonk', { vol: 0.4, pitch: 1.4 }); break; }
    }
  } else {
    let best = -1, by = Infinity;
    for (let k = 0; k < LV.length; k++) {
      const L = LV[k];
      if (!inL(L, p.x)) continue;
      const sy = surf(L, p.x);
      if (pf <= sy + 2 && p.y + R >= sy && sy < by) { by = sy; best = k; }
    }
    if (best >= 0) { const vy = p.vy; landPlayer(g, p, best, vy); if (p.jbuf > 0 && !stun) { p.jbuf = 0; p.st = AIR; p.vy = -JUMP_V * Math.sqrt(s.gm); g.sfx('jump', { vol: 0.6 }); } }
  }
  if (p.y > H + 200) { p.x = START[s.n][0]; p.y = surf(LV[0], p.x) - R; landPlayer(g, p, 0, 0); }
}

export default {
  id: 'barili',
  name: 'Barili Giù dalla Collina',
  rule: "L'orco tira barili: arriva per primo in cima alla collina!",
  verb: 'SALI!',
  inspired: 'Donkey Kong',
  cam: 'side',
  split: false,
  players: 4,
  teams: true,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Salto', b: 'Spintone' },
  duration: DUR,
  supports: ['gravity'],
  help: {
    goal: 'Sali i sentieri a zig-zag e tocca per primo lo stendardo del castello in cima. A squadre basta uno della squadra.',
    dir: '◀ ▶ corri · ▲ ▼ sulle scale per salire e scendere',
    a: 'SALTO: scavalca i barili (scavalcarne uno ti dà uno SCATTO di velocità)',
    b: 'SPINTONE: spingi chi ti sta vicino (giù dalle scale e dai sentieri!). A squadre, vicino al compagno lo LANCI al sentiero di sopra',
    tips: ['Barili infuocati = più veloci, barili blu = rimbalzano: passaci sotto o saltali', 'A volte i barili scendono dalle scale: guarda in alto!', 'La MAZZA spacca i barili per 6 s, ma con la mazza non si sale sulle scale'],
  },
  variants: [
    { id: 'giganti', name: 'Botti del Gigante', desc: 'Botti enormi che non si possono saltare: scappa sulle scale!' },
    { id: 'ghiaccio', name: 'Collina Gelata', desc: 'Sentieri ghiacciati: si scivola e i barili corrono di più!' },
    { id: 'fuoco', name: 'Collina in Fiamme', desc: 'Tutti i barili sono infuocati e lasciano fiamme sul sentiero!' },
  ],

  init(g) {
    const n = g.n || 2;
    const tm = g.teams ? [...g.teams] : null;
    const order = [...Array(n).keys()];
    if (tm) order.sort((a, b) => tm[a] - tm[b] || a - b);
    const xs = START[n] || START[4];
    const p = [...Array(n).keys()].map((i) => {
      const x = xs[order.indexOf(i)];
      return {
        i, x, y: surf(LV[0], x) - R, vx: 0, vy: 0, st: GROUND, lv: 0, ld: -1, face: x < W / 2 ? 1 : -1,
        stun: 0, inv: 0, turbo: 0, hamT: 0, shoveCd: 0.5, hoistCd: 0, jbuf: 0, happy: 0, landT: 0, burn: 0, squash: 0,
        an: 0, ak: 0, animT: 0, climb: 0, ht: 0, hx0: 0, hy0: 0, hx1: 0, hy1: 0, hlv: 0, best: 0,
      };
    });
    return {
      n, p, tm, b: [], it: [], fl: [], nid: 1, t: 0, winner: -1,
      gm: g.mods.gravity || 1, ice: g.variant === 'ghiaccio', fireTrail: g.variant === 'fuoco',
      og: { t: 1.4, wind: 0, ak: 0, rage: false }, itemT: 7,
    };
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.t = g.t;
    const late = clamp(g.t / DUR, 0, 1);
    // The ogre.
    const og = s.og;
    if (!g.ended) {
      if (!og.rage && g.t >= RAGE_T) { og.rage = true; g.say("L'ORCO È FURIOSO!", { big: true }); g.sfx('horn'); g.shake(0.4); }
      if (og.wind > 0) {
        og.wind -= dt;
        if (og.wind <= 0) throwBarrel(s, g);
      } else {
        og.t -= dt;
        if (og.t <= 0) {
          og.wind = 0.45; og.ak++;
          og.t = lerp(2.3, 1.25, late) * (g.variant === 'giganti' ? 1.7 : 1) * (1 - (s.n - 2) * 0.07) * (og.rage ? 0.75 : 1);
        }
      }
      // Blacksmith's mallet on a random path.
      s.itemT -= dt;
      if (s.itemT <= 0) {
        s.itemT = 12;
        if (!s.it.length) {
          const k = g.rng.int(1, 3), L = LV[k];
          let x = 0;
          for (let tries = 0; tries < 8; tries++) {
            x = g.rng.range(Math.max(L.x0, 0) + 120, Math.min(L.x1, W) - 120);
            if (LAD.every((l) => Math.abs(l.x - x) > 70)) break;
          }
          s.it.push({ id: s.nid++, x, y: surf(L, x) - 30, lv: k, life: 9 });
          g.sfx('powerup', { vol: 0.5 });
        }
      }
    }
    for (const p of s.p) updatePlayer(s, g, p, inp[p.i], dt);
    // Soft push between players standing on the same path.
    for (let a = 0; a < s.n; a++) {
      for (let b = a + 1; b < s.n; b++) {
        const P = s.p[a], Q = s.p[b];
        if (P.st !== GROUND || Q.st !== GROUND || P.lv !== Q.lv) continue;
        const dx = Q.x - P.x, min = R * 1.5;
        if (Math.abs(dx) < min) {
          const d = dx !== 0 ? sign(dx) : a % 2 ? 1 : -1;
          const push = Math.min(min - Math.abs(dx), 400 * dt) * 0.5;
          P.x = clamp(P.x - d * push, R, W - R); Q.x = clamp(Q.x + d * push, R, W - R);
        }
      }
    }
    for (const b of s.b) updateBarrel(s, g, b, dt);
    // Barrels vs players: hits, mallet smashes, jumps over.
    for (const b of s.b) {
      if (b.dead) continue;
      for (const p of s.p) {
        if (p.st === WIN || p.st === HOIST) continue;
        const dx = p.x - b.x, dy = p.y - b.y, rr = b.r + R * 0.78;
        if (dx * dx + dy * dy < rr * rr) {
          if (p.hamT > 0 && p.stun <= 0) { smashBarrel(s, g, b, p); break; }
          if (p.inv > 0 || p.stun > 0) continue;
          hitByBarrel(s, g, p, b);
        } else if (p.st === AIR && p.stun <= 0 && !b.giant && !(b.jb & (1 << p.i)) && Math.abs(dx) < b.r + 4 && p.y + R < b.y - b.r + 8 && b.y - p.y < 230) {
          b.jb |= 1 << p.i;
          p.turbo = 1.2; p.happy = 0.5;
          g.text(p.x, p.y - 70, 'SALTO! SCATTO!', { player: p.i, size: 38 });
          g.sfx('coin', { pitch: 1.2 });
        }
      }
    }
    // Flames left by burning barrels.
    for (const f of s.fl) {
      f.t += dt;
      for (const p of s.p) {
        if (p.st !== GROUND || p.inv > 0 || p.stun > 0) continue;
        if (Math.abs(p.x - f.x) < 26 && Math.abs(p.y + R - f.y) < 14) {
          knock(s, g, p, p.face * -1, 160, 0.8, 'SCOTTATO!', '#ff8a2a');
          p.inv = 1.5; p.burn = 0.8;
          g.sfx('fire'); g.burst(p.x, p.y + R, { color: '#ff8a2a', n: 10, speed: 200 });
        }
      }
    }
    // Mallet pickup.
    for (const it of s.it) {
      it.life -= dt;
      if (it.life <= 0) { it.dead = true; continue; }
      for (const p of s.p) {
        if (p.st === LADDER || p.st === HOIST || p.st === WIN || p.stun > 0 || p.hamT > 0) continue;
        if (Math.abs(p.x - it.x) < R + 22 && Math.abs(p.y - it.y) < R + 30) {
          it.dead = true; p.hamT = 6;
          g.say('MAZZA DEL FABBRO!'); g.sfx('powerup');
          g.burst(it.x, it.y, { color: '#ffcf3f', n: 14, speed: 260 });
          break;
        }
      }
    }
    // Best height reached (tie-breaks).
    for (const p of s.p) p.best = Math.max(p.best, H - (p.y + R));
    s.b = s.b.filter((b) => !b.dead);
    s.it = s.it.filter((it) => !it.dead);
    s.fl = s.fl.filter((f) => f.t < 1.6);
  },

  timeout(s, g) {
    // Highest up wins (closest to the banner on the castle terrace), then best height ever reached.
    const score = (p) => H - (p.y + R) + (p.lv === TOP && p.st === GROUND ? p.x * 0.05 : 0) + p.best * 0.001;
    let best = s.p[0];
    for (const p of s.p) if (score(p) > score(best)) best = p;
    const tie = s.p.filter((p) => Math.abs(score(p) - score(best)) < 0.5);
    if (tie.length > 1 && !(s.tm && tie.every((p) => s.tm[p.i] === s.tm[tie[0].i]))) return tie[g.rng.int(0, tie.length - 1)].i;
    return best.i;
  },

  view(s) {
    return {
      p: s.p.map((p) => ({
        x: r1(p.x), y: r1(p.y), f: p.face, st: p.st, vx: Math.round(p.vx), vy: Math.round(p.vy),
        sn: p.stun > 0 ? 1 : 0, bn: p.burn > 0 ? 1 : 0, iv: p.inv > 0 ? 1 : 0, hm: p.hamT > 0 ? r1(p.hamT) : 0, tb: p.turbo > 0 ? 1 : 0,
        an: p.animT > 0 ? p.an : 0, ak: p.ak, hp: p.happy > 0 ? 1 : 0, tm: s.tm ? s.tm[p.i] : p.i, fl: floorOf(p),
        sq: p.squash, ld: p.st === LADDER ? 1 : 0, lt: r2(p.landT),
      })),
      b: s.b.map((b) => ({ id: b.id, x: r1(b.x), y: r1(b.y), k: b.k, a: r2(b.a % (Math.PI * 2)), d: b.st === DOWN ? 1 : 0 })),
      og: { w: s.og.wind > 0 ? 1 : 0, ak: s.og.ak, rg: s.og.rage ? 1 : 0 },
      it: s.it.map((it) => ({ id: it.id, x: r1(it.x), y: r1(it.y), bl: it.life < 2 ? 1 : 0 })),
      fl: s.fl.map((f) => ({ id: f.id, x: r1(f.x), y: r1(f.y), t: r2(f.t) })),
      gi: s.b.length && s.b[0].giant ? 1 : 0,
      hud: { p: s.p.map((p) => floorOf(p)), max: 5, label: 'Sentiero' },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: clamp(p.x, 0, W), y: clamp(p.y, 0, H) }));
  },

  // Computer climber: heads for the best ladder of its path (Re plans two paths ahead and avoids busy ladders),
  // jumps the barrels at the right moment (Re accounts for its reaction lag), waits under/over a ladder when a
  // barrel is about to cross it, flees giant barrels, shoves rivals off ladders and hoists its team mate.
  bot(s, me, g, B) {
    const p = s.p[me], L = B.level, M = B.mem, t = g.t, lag = BOT_LAG[L];
    const w = { x: 0, y: 0, sx: 0, sy: 0 };
    const set = (sx, sy) => { w.sx = w.x = sx; w.sy = w.y = sy; };
    if (g.ended || p.st === WIN || p.st === HOIST || p.stun > 0) return w;
    // Shove rivals in reach (Re: always when useful, Cavaliere: often, Scudiero: now and then).
    if (p.shoveCd <= 0) {
      for (const q of s.p) {
        if (q === p || g.ally(me, q.i) || q.stun > 0 || q.st === WIN || q.st === HOIST) continue;
        if (Math.abs(q.x - p.x) > 70 || Math.abs(q.y - p.y) > 50) continue;
        const useful = q.st === LADDER || floorOf(q) >= floorOf(p);
        if ((L === 2 && useful) || (L === 1 && useful && B.rng() < 0.08) || (L === 0 && B.rng() < 0.01)) { w.tapB = true; break; }
      }
      // Team: hoist the mate standing next to me (the higher seat does it, so two bots don't swap forever).
      if (!w.tapB && s.tm && p.hoistCd <= 0 && p.st === GROUND && L >= 1) {
        for (const q of s.p) {
          if (q === p || !g.ally(me, q.i) || q.st !== GROUND || q.stun > 0 || q.lv === TOP) continue;
          if (Math.abs(q.x - p.x) < 60 && Math.abs(q.y - p.y) < 30 && (me > q.i || q.hoistCd > 0) && q.lv === p.lv) { w.tapB = true; break; }
        }
      }
    }
    if (p.st === LADDER) {
      const l = LAD[p.ld];
      const yTop = ladTop(l) - R;
      let up = -1;
      if (L >= 1) {
        for (const b of s.b) {
          if (b.st === DOWN && b.ld === p.ld && b.y < p.y) { up = 1; break; }
          // A barrel about to roll over the top of my ladder: wait just below.
          if (b.st === ROLL && b.lv === l.hi && p.y - yTop < 90) {
            const dx = l.x - b.x;
            if (dx * LV[l.hi].dir > -10 && Math.abs(dx) < 110 + lag * 300) up = p.y - yTop > 70 ? -1 : 0.0001;
          }
        }
      }
      set(0, up > 0.5 ? 1 : up < -0.5 ? -1 : 0);
      if (up > 0.5 && ladBot(l) - R - p.y < 20) set(B.rng() < 0.5 ? 1 : -1, 0);
      return w;
    }
    const lv = p.lv;
    // Target ladder (or the banner on the top terrace).
    let gx;
    if (lv === TOP) gx = GOAL_X + 40;
    else if (lv === ROCK) gx = W;
    else {
      if (M.lv !== lv || t > (M.reT || 0) || M.ld === undefined) {
        let best = -1, bc = Infinity;
        for (let k = 0; k < LAD.length; k++) {
          const l = LAD[k];
          if (l.lo !== lv) continue;
          let c = Math.abs(l.x - p.x) / RUN;
          if (L >= 1) {
            // Distance on the next path to its own way up.
            let nx = Infinity;
            if (l.hi === TOP) nx = Math.abs(GOAL_X - l.x);
            else for (const l2 of LAD) if (l2.lo === l.hi) nx = Math.min(nx, Math.abs(l2.x - l.x));
            c += (nx / RUN) * (L === 2 ? 1 : 0.5);
          }
          if (L === 2) for (const b of s.b) if (b.st === DOWN && LAD[b.ld] === l) c += 1.5;
          if (L === 0) c += B.rng() * 0.6;
          if (c < bc) { bc = c; best = k; }
        }
        M.ld = best; M.lv = lv; M.reT = t + (L === 2 ? 0.5 : 1.5);
      }
      gx = LAD[M.ld].x;
    }
    // Steer on where I will be after my reaction lag (no overshooting the ladder).
    const fx = p.x + p.vx * lag, dx = gx - fx;
    let sx = Math.abs(dx) > 5 ? clamp(dx / 40, -1, 1) : 0, sy = 0;
    if (sx && Math.abs(sx) < 0.35) sx = 0.35 * sign(sx);
    if (lv !== TOP && lv !== ROCK && Math.abs(dx) < 16 && Math.abs(gx - p.x) < 40 && p.st === GROUND) { sx = 0; sy = -1; }
    // Barrels.
    if (p.st === GROUND) {
      for (const b of s.b) {
        // Barrel coming down the ladder I'm standing at: step aside.
        if (b.st === DOWN && LAD[b.ld].lo === lv && Math.abs(LAD[b.ld].x - p.x) < 50 && b.y < p.y && L >= 1) {
          sx = p.x >= LAD[b.ld].x ? 1 : -1; sy = 0;
          continue;
        }
        const same = (b.st === ROLL && b.lv === lv) || (b.st === FLY && Math.abs(b.y + b.r - surf(LV[lv], clamp(b.x, LV[lv].x0, LV[lv].x1))) < 110 && inL(LV[lv], b.x));
        if (!same) continue;
        const rel = (b.vx - p.vx) * (p.x > b.x ? 1 : -1); // closing speed
        const gap = Math.abs(p.x - b.x) - (b.r + R * 0.78);
        if (rel <= 20 || gap < -20) continue;
        const tc = gap / rel;
        if (b.giant) {
          if (tc < 1.6 && L >= 1) {
            // Run to a ladder (up or down) that we reach before the giant does, else run away.
            let esc = null, ed = Infinity;
            for (const l of LAD) {
              if (l.lo !== lv && l.hi !== lv) continue;
              const d = Math.abs(l.x - p.x);
              if (d / RUN < tc * 0.9 && d < ed && sign(l.x - p.x || 1) !== sign(b.x - p.x)) { ed = d; esc = l; }
            }
            if (esc) { sx = Math.abs(esc.x - p.x) > 12 ? sign(esc.x - p.x) : 0; sy = sx ? 0 : esc.lo === lv ? -1 : 1; }
            else { sx = sign(p.x - b.x) || 1; sy = 0; }
          }
          continue;
        }
        const lead = 0.1 + lag * [0.55, 0.85, 1][L];
        if (tc < lead) { w.tapA = true; if (!sx) sx = sign(b.x - p.x); }
      }
      // Flames on the path ahead.
      for (const f of s.fl) {
        if (Math.abs(f.y - (p.y + R)) > 14 || f.t > 1.4) continue;
        const d = (f.x - p.x) * (sx || p.face);
        if (d > 20 && d < 40 + lag * RUN && L >= 1) w.tapA = true;
      }
    }
    set(sx, sy);
    return w;
  },

  render3d: {
    assets: [
      'medieval/building_windmill_red', 'medieval/building_windmill_yellow', 'medieval/building_windmill_blue', 'medieval/building_castle_red', 'medieval/wall_straight_gate',
      'medieval/barrel', 'medieval/ladder', 'medieval/flag_yellow', 'medieval/flag_red', 'medieval/flag_blue', 'medieval/fence_wood_straight', 'medieval/tree_single_A', 'medieval/tree_single_B',
      'medieval/trees_A_medium', 'medieval/trees_B_small', 'medieval/rock_single_C', 'medieval/mountain_A_grass_trees', 'medieval/mountain_C_grass_trees',
      'medieval/hills_A_trees', 'medieval/hills_C_trees', 'medieval/building_home_A_green', 'medieval/building_home_B_red', 'medieval/building_grain', 'medieval/building_well_green',
      'medieval/cloud_big', 'medieval/cloud_small', 'medieval/waterplant_A', 'medieval/waterlily_B', 'medieval/sack', 'medieval/wheelbarrow', 'medieval/crate_A_big',
      'dungeon/keg', 'dungeon/torch_lit', 'chars/Barbarian',
    ],
    // A bit wider than the world and shifted up: the ogre and the castle on the hilltop stay in view.
    cam: { fit: 1.13, target: () => CAM_T },
    build(K) {
      const T3 = K.THREE;
      const n = Math.max(2, K.n || 2), lo = K.quality === 0;
      const o = { n };
      K.theme('alba', { fogNear: 2.6, fogFar: 11 });
      const sunM = K.glow('#ffe0b0', { opacity: 0.95 }); sunM.fog = false;
      K.place(K.ball(300, sunM, { cast: false }), -600, 380, -8000);
      const hplane = (x0, x1, z0, z1, y, mat) => {
        const me = K.mesh(new T3.PlaneGeometry(x1 - x0, z0 - z1).rotateX(-Math.PI / 2), mat, { cast: false });
        me.userData.ownGeo = true;
        me.position.set((x0 + x1) / 2, -y, (z0 + z1) / 2);
        return me;
      };
      const GY = 812; // valley ground
      hplane(-8000, 9000, 900, -12000, GY, K.texMat('prato', [90, 70], { color: '#d6e6a0' }));
      // Pond at the foot of the hill (barrels splash into it).
      const wtex = K.tex('acqua', { rep: [4, 3], seed: 4 });
      const wm = new T3.MeshStandardMaterial({ map: wtex, color: '#d0ecff', roughness: 0.12, metalness: 0.15, emissive: '#0a3a5a', emissiveIntensity: 0.3, transparent: true, opacity: 0.92 });
      hplane(-900, 40, 420, -300, GY - 3, wm);
      K.ticks.push((dt, t) => { if (wtex) { wtex.offset.x = (t * 0.015) % 1; wtex.offset.y = (t * 0.02) % 1; } });
      K.scatter('medieval/waterlily_B', [{ x: -260, y: GY - 3, h: 140 }, { x: -120, y: GY - 3, h: -80, rot: 1 }, { x: -420, y: GY - 3, h: 40, rot: 2 }], { size: 70 });
      K.scatter('medieval/waterplant_A', [{ x: 10, y: GY, h: 240 }, { x: -560, y: GY, h: -200 }, { x: 30, y: GY, h: -260 }], { height: 70 });
      // The hill: a big grassy mound behind the paths.
      const hill = K.prism([-1000, GY, -640, 640, -420, 420, -260, 250, -150, 110, 20, 40, 320, 20, 600, 60, 820, 30, 1080, 10, 1260, 60, 1400, 160, 1560, 360, 1760, 600, 2050, GY], 900, K.texMat('erba', [1 / 170, 1 / 170], { color: '#a9d672' }), { bevel: 18 });
      K.place(hill, 0, 0, -1040);
      hill.receiveShadow = false; // long dawn shadows of the paths made the hillside too dark
      // Painted hillside: meadow stripes, flowers, stones and tufts (so the slope is not a flat green wall).
      K.layer({ x0: -700, x1: 1900, y0: -60, y1: GY, h: 116, transparent: true, lit: false, once: true, maxPx: 2048, draw: (d) => drawHillside(d) });
      K.scatter('medieval/trees_B_small', [{ x: -560, y: 700, h: -60 }, { x: 1600, y: 560, h: -60 }, { x: 1700, y: 700, h: -40 }, { x: -420, y: 520, h: -80 }], { height: 150 });
      K.scatter('medieval/rock_single_C', [{ x: 1340, y: GY, h: 60 }, { x: -130, y: GY, h: 120, rot: 1 }], { size: 80 });
      // --- the zig-zag paths: stone retaining wall in front, beaten earth on top ---
      const stone = K.texMat('muro', [1 / 90, 1 / 90], { color: '#cdbb9c' });
      const dirt = K.texMat('terra', [1 / 120, 1 / 120], { color: '#e0b98a' });
      const terr = K.texMat('lastre', [1 / 110, 1 / 110], { color: '#e6dccb' });
      const rockM = K.texMat('pietra', [1 / 120, 1 / 120], { color: '#a49c90' });
      LV.forEach((L, k) => {
        const x0 = Math.max(L.x0, -700), x1 = Math.min(L.x1, 1900);
        const y0 = surf(L, x0), y1 = surf(L, x1);
        const th = k === 0 ? 40 : k === ROCK ? 70 : SLAB;
        const me = K.prism([x0, y0, x1, y1, x1, y1 + th, x0, y0 + th], k === 0 ? 260 : 170, k === TOP ? terr : k === ROCK ? rockM : stone, { bevel: 2 });
        if (k !== TOP && k !== ROCK) me.material = [stone, dirt];
        K.place(me, 0, 0, k === 0 ? -150 : -110);
      });
      // Grass tufts along the back edge of each path: wooden fences.
      const fences = [];
      for (let k = 1; k <= 4; k++) {
        const L = LV[k];
        for (let x = Math.max(L.x0, -60) + 70; x < Math.min(L.x1, W + 60) - 40; x += 230) fences.push({ x, y: surf(L, x), h: -95, rot: Math.PI / 2 });
      }
      K.scatter('medieval/fence_wood_straight', fences, { height: 34 });
      // Ladders (one instanced set).
      K.scatter('medieval/ladder', LAD.map((l) => ({ x: l.x, y: ladBot(l), h: 2, s: (ladBot(l) - ladTop(l) + 40) / 100 })), { height: 100 });
      // The ogre's rock: a pile of barrels and kegs.
      const pile = [];
      for (let k = 0; k < 4; k++) pile.push({ x: 40 + k * 42, y: 86, h: -60 });
      for (let k = 0; k < 3; k++) pile.push({ x: 61 + k * 42, y: 86 - 46, h: -60 });
      pile.push({ x: 82, y: 86 - 92, h: -60 });
      K.scatter('medieval/barrel', pile, { size: 42 });
      K.scatter('dungeon/keg', [{ x: 380, y: 86, h: -70, rot: 0.4 }], { height: 50 });
      K.scatter('dungeon/torch_lit', [{ x: 410, y: 86, h: -40 }, { x: 710, y: 86, h: -40 }], { height: 80 });
      if (!lo) { K.light(410, 10, 40, '#ffa04a', 1.2, { flicker: 0.5, dist: 420 }); K.light(710, 10, 40, '#ffa04a', 1.2, { flicker: 0.5, dist: 420 }); }
      // Castle on top with the gate and the goal banner.
      const castle = K.model('medieval/building_castle_red', { height: 600 });
      K.place(castle, 1230, 86, -520);
      K.scatter('medieval/wall_straight_gate', [{ x: 1150, y: 86, h: -120 }], { size: 230 });
      o.goalFlag = K.model('medieval/flag_yellow', { height: 170 });
      K.place(o.goalFlag, GOAL_X + 20, 86, -20);
      o.goalFlag.rotation.y = Math.PI / 2;
      o.beam = K.box(70, 300, 70, K.glow('#ffe27a', { opacity: 0.22, add: true, unique: true }), { cast: false });
      K.place(o.beam, GOAL_X + 30, 86 - 150, 0);
      // Background: windmills (rotating fans), farms, hills, mountains, clouds.
      o.fans = [];
      for (const [m, x, h, ht, rot] of [['red', -980, -1800, 620, 0.5], ['yellow', 2150, -2000, 640, -0.4], ['blue', 2800, -3600, 700, -0.2], ['red', -1700, -3900, 680, 0.3]]) {
        const wm2 = K.model(`medieval/building_windmill_${m}`, { height: ht });
        K.place(wm2, x, GY, h);
        wm2.rotation.y = rot;
        wm2.traverse((nd) => { if (/fan/.test(nd.name)) o.fans.push(nd); });
      }
      K.scatter('medieval/building_home_A_green', [{ x: -1500, y: GY, h: -1500, rot: 0.6 }, { x: 2500, y: GY, h: -1300, rot: 2.2 }], { size: 300 });
      K.scatter('medieval/building_home_B_red', [{ x: -1150, y: GY, h: -2500, rot: 1.4 }, { x: 1900, y: GY, h: -2700, rot: 0.3 }], { size: 300 });
      K.scatter('medieval/building_grain', [{ x: -700, y: GY, h: -2300, rot: 0.3 }, { x: 2100, y: GY, h: -900, rot: 1 }], { size: 260 });
      K.scatter('medieval/building_well_green', [{ x: 1750, y: GY, h: -500 }], { size: 130 });
      K.scatter('medieval/wheelbarrow', [{ x: 1500, y: GY, h: 120, rot: 0.6 }], { size: 90 });
      K.scatter('medieval/sack', [{ x: 1420, y: GY, h: 180 }, { x: 1460, y: GY, h: 220, rot: 1 }], { size: 50 });
      K.scatter('medieval/crate_A_big', [{ x: -120, y: GY, h: 300, rot: 0.3 }], { size: 70 });
      const trees = [];
      for (let k = 0; k < (lo ? 10 : 20); k++) trees.push({ x: -2600 + k * 290 + (k % 3) * 60, y: GY, h: -1300 - (k % 4) * 380, rot: k, s: 0.8 + (k % 5) * 0.12 });
      K.scatter('medieval/tree_single_A', trees.filter((_, k) => k % 2 === 0), { height: 300 });
      K.scatter('medieval/tree_single_B', trees.filter((_, k) => k % 2 === 1), { height: 280 });
      K.scatter('medieval/trees_A_medium', [{ x: -1300, y: GY, h: -900 }, { x: 2300, y: GY, h: -600, rot: 2 }], { size: 420 });
      const hills = [];
      for (let k = 0; k < (lo ? 5 : 9); k++) hills.push({ x: -4200 + k * 1150, y: GY, h: -5200 - (k % 2) * 600, rot: k * 2.1, s: 0.9 + (k % 3) * 0.15 });
      K.scatter('medieval/hills_A_trees', hills.filter((_, k) => k % 2 === 0), { size: 1500 });
      K.scatter('medieval/hills_C_trees', hills.filter((_, k) => k % 2 === 1), { size: 1400 });
      const mts = [];
      for (let k = 0; k < (lo ? 4 : 7); k++) mts.push({ x: -5000 + k * 1800, y: GY, h: -9000 - (k % 3) * 500, rot: k * 1.4, s: 0.9 + (k % 4) * 0.12 });
      K.scatter('medieval/mountain_A_grass_trees', mts.filter((_, k) => k % 2 === 0), { size: 3000 });
      K.scatter('medieval/mountain_C_grass_trees', mts.filter((_, k) => k % 2 === 1), { size: 2800 });
      o.clouds = [0, 1, 2].map((k) => ({ g: softCloud(K, K.model(k === 1 ? 'medieval/cloud_small' : 'medieval/cloud_big', { size: 700 - k * 80, cast: false })), x: -1200 + k * 1300, y: -260 + k * 80, z: -3200 - k * 600, v: 12 + k * 6 }));
      K.ambient('foglie', { n: lo ? 16 : 30, h: 400 });
      // --- the ogre (a green barbarian giant) ---
      o.ogre = K.npc('barbarian', { marker: false });
      if (o.ogre.model) {
        const green = new T3.Color('#8fdc6a');
        // Only the visible meshes: their materials are per-avatar clones (hidden ones share the global model's material).
        o.ogre.model.traverse((m) => { if (m.isMesh && m.visible && m.material && m.material.color && !m.userData.tinted) { m.userData.tinted = true; m.material.color.multiply(green); } });
      }
      o.ogreBarrel = makeBarrel3d(K, o, BR);
      // --- barrels, items, flames ---
      o.barrels = [...Array(16)].map(() => makeBarrel3d(K, o, BR));
      o.hams = [...Array(2)].map(() => makeMallet(K));
      o.flames = [...Array(26)].map(() => K.prism([-13, 0, -6, -22, 0, -34, 6, -20, 13, 0], 4, K.glow('#ff8a2a', { opacity: 0.85, add: true }), { cast: false }));
      for (const f of o.flames) f.visible = false;
      // --- players ---
      o.pl = [...Array(n).keys()].map((i) => {
        const P = { av: K.avatar(i), ham: makeMallet(K) };
        P.stars = K.emoji('💫', 50);
        P.fire = K.emoji('🔥', 46);
        P.trail = [0.3, 0.18].map((a) => K.ball(R, K.glow(K.col(i, 'light'), { opacity: a, add: true }), { cast: false }));
        P.hoistGlow = K.torus(R * 1.4, 4, K.glow(K.col(i, 'light'), { add: true }), { cast: false });
        return P;
      });
      return o;
    },

    update(K, o, v) {
      const T = K.t;
      for (const c of o.clouds) K.place(c.g, ((c.x + T * c.v + 3000) % 6000) - 2400, c.y, c.z);
      for (const f of o.fans) f.rotation.z = T * 1.6;
      o.beam.material.opacity = 0.16 + 0.08 * Math.sin(T * 4);
      o.goalFlag.rotation.z = Math.sin(T * 3) * 0.06;
      // Ogre: wind-up holds a barrel over the head, then throws.
      const og = v.og;
      const ogR = 62;
      o.ogre.set(OGRE_X, 86 - ogR, { r: ogR, h: -10, look: 0.3, anim: og.w ? 'Throw' : og.rg ? 'Cheer' : '2H_Melee_Idle', animKey: og.ak, animSpeed: og.w ? 1.6 : 1, gear: false });
      o.ogreBarrel.g.visible = !!og.w;
      if (og.w) setBarrel3d(K, o, o.ogreBarrel, OGRE_X + 20, 86 - ogR * 2.6, 0, NORMAL, false, BR);
      // Barrels.
      const giant = !!v.gi;
      o.barrels.forEach((B3, k) => {
        const b = v.b[k];
        B3.g.visible = !!b;
        if (b) setBarrel3d(K, o, B3, b.x, b.y, b.a, Math.round(b.k), giant, giant ? GIANT_R : BR);
      });
      o.hams.forEach((Hm, k) => {
        const it = v.it[k];
        Hm.visible = !!it && !(it.bl && Math.floor(T * 8) % 2);
        if (Hm.visible) { K.place(Hm, it.x - 28, it.y + 20 + Math.sin(T * 4 + k) * 5, 10); K.face(Hm, -1.2 + Math.sin(T * 2) * 0.3); Hm.scale.setScalar(1.4); }
      });
      o.flames.forEach((F, k) => {
        const f = v.fl[k];
        F.visible = !!f;
        if (f) { K.place(F, f.x, f.y, 10); const s2 = clamp(1.2 - f.t / 1.6, 0.2, 1) * (1 + 0.15 * Math.sin(T * 25 + k)); F.scale.set(s2, s2, 1); }
      });
      // Players.
      v.p.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const st = Math.round(p.st);
        const face = p.f >= 0 ? 1 : -1;
        let anim, animKey, animSpeed, squash = 0;
        const walk = st === GROUND ? clamp(Math.abs(p.vx) / RUN, 0, 1) : 0;
        if (st === WIN) anim = 'Cheer';
        else if (st === HOIST) anim = 'Jump_Full_Long';
        else if (p.sn) { anim = p.sq ? 'Lie_Idle' : 'Hit_B'; if (p.sq) squash = 0.35; }
        else if (p.an === 5) { anim = 'Unarmed_Melee_Attack_Punch_A'; animKey = p.ak; animSpeed = 2.2; }
        else if (p.an === 7) { anim = 'Throw'; animKey = p.ak; animSpeed = 2.2; }
        else if (st === LADDER) { anim = Math.abs(p.vy) > 10 ? 'Walking_A' : 'Idle'; animSpeed = 1.4; }
        else if (st === AIR) anim = p.vy < 0 ? 'Jump_Idle' : 'Jump_Idle';
        else if (p.hm > 0) anim = walk > 0.1 ? 'Running_B' : '2H_Melee_Idle';
        if (p.lt > 0 && st === GROUND) squash = 0.18;
        const alpha = p.iv && !p.sn && Math.floor(T * 12) % 2 ? 0.45 : 1;
        P.av.set(p.x, p.y, { r: R, look: face > 0 ? 0 : Math.PI, walk, anim, animKey, animSpeed, squash, alpha, mood: st === WIN ? 'happy' : p.sn ? 'hurt' : 'ok', gear: p.hm <= 0 });
        if (st === LADDER && P.av.group) P.av.group.rotation.y = Math.PI; // back to the camera while climbing
        // Mallet over the head (DK style).
        P.ham.visible = p.hm > 0 && !(p.hm < 1.5 && Math.floor(T * 10) % 2);
        if (P.ham.visible) {
          const sw = Math.sin(T * 14);
          K.place(P.ham, p.x + face * 6, p.y - R * 0.9, 24);
          K.face(P.ham, -Math.PI / 2 + face * (0.4 + sw * 0.9));
        }
        P.stars.visible = !!p.sn && !p.bn;
        if (P.stars.visible) K.place(P.stars, p.x + Math.sin(T * 8) * 12, p.y - R * 2.3, 30);
        P.fire.visible = !!p.bn;
        if (p.bn) K.place(P.fire, p.x, p.y - R * 2.2 + Math.sin(T * 20) * 3, 30);
        P.trail.forEach((b, k) => {
          b.visible = !!p.tb && st !== LADDER;
          if (b.visible) K.place(b, p.x - face * (k + 1) * 22, p.y, -6 - k * 4);
        });
        P.hoistGlow.visible = st === HOIST;
        if (st === HOIST) { K.place(P.hoistGlow, p.x, p.y, 0); P.hoistGlow.rotation.z = T * 10; }
      });
    },
  },

  render(d, v) {
    const T = d.t;
    const ctx = d.ctx;
    const gr = ctx.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#7c8ed8'); gr.addColorStop(0.6, '#f2b4a8'); gr.addColorStop(1, '#ffe2b0');
    ctx.fillStyle = gr;
    ctx.fillRect(-400, -300, W + 800, H + 600);
    d.poly([-400, H, -300, 600, -150, 200, 100, 40, 1100, 20, 1350, 200, 1600, H], '#8cc45e');
    d.rect(-400, 795, W + 800, 200, '#6aa84a');
    d.rect(-400, 800, 440, 60, '#5aa8e0');
    // Paths.
    LV.forEach((L, k) => {
      const x0 = Math.max(L.x0, -300), x1 = Math.min(L.x1, W + 300);
      d.poly([x0, surf(L, x0), x1, surf(L, x1), x1, surf(L, x1) + SLAB, x0, surf(L, x0) + SLAB], k === TOP ? '#e6dccb' : k === ROCK ? '#a49c90' : '#c9a072', '#6b4a2a', 3);
    });
    // Ladders.
    for (const l of LAD) {
      const y0 = ladTop(l) - 20, y1 = ladBot(l);
      d.line(l.x - 16, y0, l.x - 16, y1, '#7a5230', 5);
      d.line(l.x + 16, y0, l.x + 16, y1, '#7a5230', 5);
      for (let y = y0 + 10; y < y1; y += 22) d.line(l.x - 16, y, l.x + 16, y, '#a8723f', 4);
    }
    // Goal banner + castle.
    d.rect(1150, -40, 80, 126, '#c8b8a0', '#6b5a45', 3);
    d.line(GOAL_X + 20, 86, GOAL_X + 20, -50, '#6b4a2a', 5);
    d.poly([GOAL_X + 20, -50, GOAL_X + 80, -30, GOAL_X + 20, -10], '#ffd23f');
    // Ogre.
    d.circle(OGRE_X, 86 - 60, 58, '#6fbf4a', '#2a5a1a', 4);
    d.text(v.og.rg ? '😡' : '👹', OGRE_X, 86 - 62, { size: 70 });
    if (v.og.w) d.circle(OGRE_X + 20, -40, 22, '#a0642c', '#4a2a10', 3);
    for (const it of v.it) if (!(it.bl && Math.floor(T * 8) % 2)) d.text('🔨', it.x, it.y, { size: 44 });
    for (const f of v.fl) d.poly([f.x - 12, f.y, f.x, f.y - 30, f.x + 12, f.y], '#ff8a2a');
    const gR = v.gi ? GIANT_R : BR;
    for (const b of v.b) {
      const k = Math.round(b.k);
      d.circle(b.x, b.y, gR, k === FIRE ? '#d0501c' : '#a0642c', k === BOUNCE ? '#3fa9ff' : '#4a2a10', 4);
      d.line(b.x - Math.cos(b.a) * gR, b.y - Math.sin(b.a) * gR, b.x + Math.cos(b.a) * gR, b.y + Math.sin(b.a) * gR, '#4a2a10', 3);
      if (k === FIRE) d.star(b.x, b.y - gR - 6, 12 + Math.sin(T * 30) * 3, '#ffcf3f', 6);
    }
    v.p.forEach((p, i) => {
      const st = Math.round(p.st);
      d.avatar(p.x, p.y, R, i, { look: p.f >= 0 ? 0 : Math.PI, mood: st === WIN ? 'happy' : p.sn ? 'dizzy' : 'ok', squash: p.sq && p.sn ? 0.35 : 0, alpha: p.iv && Math.floor(T * 12) % 2 ? 0.5 : 1 });
      if (p.hm > 0) d.text('🔨', p.x, p.y - R - 26, { size: 36 });
    });
  },
};

// ---------- 3D helpers ----------
const CAM_T = { x: W / 2, y: H / 2 - 55 };

// Deterministic hillside painting (world coords, behind the paths).
function drawHillside(d) {
  const ctx = d.ctx;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const gr = ctx.createLinearGradient(0, -60, 0, H);
  gr.addColorStop(0, 'rgba(255,240,170,0.18)'); gr.addColorStop(1, 'rgba(40,90,30,0.22)');
  ctx.fillStyle = gr; ctx.fillRect(-700, -60, 2600, H + 60);
  // Mowed stripes along the slope.
  for (let k = 0; k < 14; k++) {
    const y = 30 + k * 60;
    d.poly([-700, y, 1900, y - 40, 1900, y - 12, -700, y + 28], k % 2 ? 'rgba(255,255,200,0.07)' : 'rgba(30,70,20,0.07)');
  }
  // Grass tufts, flowers, stones.
  for (let k = 0; k < 520; k++) {
    const x = -700 + rnd() * 2600, y = -40 + rnd() * (H + 40);
    const r = rnd();
    if (r < 0.7) { d.line(x, y, x - 4, y - 12, 'rgba(40,95,30,0.6)', 3); d.line(x, y, x + 4, y - 11, 'rgba(60,125,40,0.6)', 3); }
    else if (r < 0.95) { const c = ['#fff6a8', '#ffffff', '#ffb3d1', '#c7b3ff', '#ffd27a'][Math.floor(rnd() * 5)]; d.circle(x, y, 2.5, c); d.circle(x + 5, y + 2, 2.5, c); d.circle(x + 2, y - 4, 2.5, c); }
    else d.rrect(x, y, 14 + rnd() * 14, 8 + rnd() * 6, 4, 'rgba(120,112,100,0.5)');
  }
}

function softCloud(K, g) {
  const m = K.mat('#ffffff', { rough: 1, emissive: '#fff0e6', ei: 0.5 });
  g.traverse((x) => { if (x.isMesh) x.material = m; });
  return g;
}

// Barrel lying on its side (axis toward the camera) so it visibly rolls; fire glow and bouncy blue hoops.
function makeBarrel3d(K, o, r) {
  const g = K.group();
  const spin = K.group(g);
  const hold = K.group(spin);
  hold.rotation.x = Math.PI / 2;
  const m = K.model('medieval/barrel', { size: 2 * r, parent: hold });
  m.position.y = -(m.userData.dims?.h || 2 * r) / 2;
  const fire = K.group(g);
  const f1 = K.ball(1, K.glow('#ff9a2a', { opacity: 0.55, add: true }), { parent: fire, cast: false });
  const f2 = K.ball(1, K.glow('#ffe27a', { opacity: 0.7, add: true }), { parent: fire, cast: false });
  const hoop = K.torus(r * 1.02, r * 0.12, K.mat('#3fa9ff', { rough: 0.3, emissive: '#1a5a9a', ei: 0.5 }), { parent: g, cast: false });
  K.place(hoop, 0, 0, r * 0.9);
  g.visible = false;
  return { g, spin, fire, f1, f2, hoop };
}

function setBarrel3d(K, o, B3, x, y, a, k, giant, r) {
  K.place(B3.g, x, y, 0);
  B3.g.scale.setScalar(r / BR);
  B3.spin.rotation.z = -a;
  B3.fire.visible = k === FIRE;
  if (k === FIRE) {
    const fl = 1 + 0.2 * Math.sin(K.t * 30 + x * 0.1);
    B3.f1.scale.setScalar(BR * 1.25 * fl); K.place(B3.f1, 0, -BR * 0.6, 0);
    B3.f2.scale.setScalar(BR * 0.7 * fl); K.place(B3.f2, 0, -BR * 0.9, BR * 0.2);
  }
  B3.hoop.visible = k === BOUNCE;
}

// Blacksmith's mallet along local +X (handle from the pivot, golden head at the end).
function makeMallet(K) {
  const g = K.group();
  K.place(K.box(56, 9, 9, K.mat('#7a4a22', { rough: 0.7 }), { parent: g }), 28, 0, 0);
  K.place(K.box(24, 40, 30, K.mat('#e8b23a', { rough: 0.3, metal: 0.5, emissive: '#6a4000', ei: 0.3 }), { parent: g }), 62, 0, 0);
  K.place(K.box(6, 42, 32, K.mat('#4a4a52', { rough: 0.35, metal: 0.7 }), { parent: g }), 50, 0, 0);
  g.visible = false;
  return g;
}
