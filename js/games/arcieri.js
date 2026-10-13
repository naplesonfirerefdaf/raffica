// Arcieri sulle Mura — side-view archery gallery, 2–4 players (free-for-all or 2 vs 2 teams).
// Every archer stands on the castle wall walk and moves a crosshair across the sky: crows, balloons, a little
// dragon, the jester's hat. Tap A = quick arrow, hold A = charged arrow (faster, wider, pierces). B = pebble at a rival.
import { clamp, approach, dist, r1, r2 } from '../core/geom.js';

const W = 1200, H = 800;
const WALK = 700;                         // top of the wall walk (archers' feet)
const AR = 47;                            // archer radius
const BOW_Y = WALK - AR * 1.3;            // arrows leave from here
const CX0 = 30, CX1 = W - 30, CY0 = 40, CY1 = 600; // crosshair bounds
const AIM_V = 980;                        // crosshair top speed
const DUR = 45, GOLD_T = 35;              // last 10 s: golden arrows, double points
const CH_T0 = 0.12, CH_T = 0.55;          // charge: dead time, time to full
const RELOAD = 0.3, ROCK_CD = 2.6, ROCK_STUN = 0.7;
const POS = { 2: [430, 770], 3: [330, 600, 870], 4: [240, 480, 720, 960] };
const TEAM_COL = ['#ff4b5c', '#3fa9ff'];
const FLAG = ['red', 'blue', 'green', 'yellow'];
// Target kinds.
const CROW = 0, BAL = 1, DRAGON = 2, HAT = 3, QUIVER = 4, HEN = 5, FIRE = 6;
const TR = [34, 38, 64, 30, 40, 28, 24];
const BAL_COLS = ['#ff5a6e', '#ffd23f', '#4fc3ff', '#7ee06a', '#c78bff'];
const SP_TRIPLE = 1, SP_FIRE = 2;
const FIRE_R = 130;
const BOT_LAG = [0.34, 0.2, 0.09].map((d) => d + 1 / 60);

// ---------- target motion (analytic: the bots can predict it exactly) ----------
// m: 0 wave flight, 1 rising balloon, 2 ballistic toss, 3 boss dragon loop, 4 straight line.
function posAt(t, a, out) {
  switch (t.m) {
    case 0: out.x = t.x0 + t.vx * a; out.y = t.y0 + t.A * Math.sin(a * t.w + t.ph); break;
    case 1: out.x = t.x0 + t.vx * a + 16 * Math.sin(a * 1.6 + t.ph); out.y = t.y0 + t.vy * a; break;
    case 2: out.x = t.x0 + t.vx * a; out.y = t.y0 + t.vy * a + 0.5 * t.gr * a * a; break;
    case 3: out.x = W / 2 + 420 * Math.sin(a * 0.33 + t.ph); out.y = t.y0 + 80 * Math.sin(a * 1.1); break;
    default: out.x = t.x0 + t.vx * a; out.y = t.y0 + t.vy * a;
  }
  return out;
}

function addTarget(s, k, m, o) {
  const t = { id: s.nid++, k, m, a: 0, x: 0, y: 0, r: TR[k], gold: false, hp: 1, hp0: 1, c: 0, pair: 0, x0: 0, y0: 0, vx: 0, vy: 0, A: 0, w: 0, ph: 0, gr: 0, lastBy: -1, lastT: -9, ...o };
  posAt(t, 0, t);
  s.tg.push(t);
  return t;
}

function addCrow(s, g, gold) {
  const dir = g.rng.chance(0.5) ? 1 : -1;
  const late = clamp(g.t / DUR, 0, 1);
  addTarget(s, CROW, 0, {
    x0: dir > 0 ? -60 : W + 60, y0: g.rng.range(90, 470), vx: dir * g.rng.range(180, 260) * (1 + late * 0.25) + s.wind * 0.3,
    A: g.rng.range(18, 45), w: g.rng.range(2.4, 3.8), ph: g.rng.range(0, 6.28), gold: g.rng.chance(gold),
  });
}

function addBalloon(s, g, gold, twin) {
  const x = g.rng.range(140, W - 140 - (twin ? 90 : 0));
  const vy = -g.rng.range(70, 105), vx = g.rng.range(-25, 25) + s.wind * 0.22, ph = g.rng.range(0, 6.28);
  const a = addTarget(s, BAL, 1, { x0: x, y0: 790, vx, vy, ph, c: g.rng.int(0, BAL_COLS.length - 1), gold: !twin && g.rng.chance(gold) });
  if (twin) {
    const b = addTarget(s, BAL, 1, { x0: x + 90, y0: 790, vx, vy, ph, c: a.c });
    a.pair = b.pair = a.id;
  }
}

function addDragon(s, g, boss) {
  if (boss) {
    addTarget(s, DRAGON, 3, { y0: g.rng.range(170, 230), ph: g.rng.chance(0.5) ? -1.4 : 1.4, hp: 24, hp0: 24, r: 82, boss: true });
    g.say('IL DRAGO DEL MONTE!', { big: true });
  } else {
    const dir = g.rng.chance(0.5) ? 1 : -1;
    addTarget(s, DRAGON, 0, { x0: dir > 0 ? -160 : W + 160, y0: g.rng.range(180, 300), vx: dir * 205, A: 100, w: 1.4, ph: g.rng.range(0, 6.28), hp: 4, hp0: 4 });
    g.say('UN DRAGHETTO! 4 FRECCE!');
  }
  g.sfx('horn');
}

function spawn(s, g, dt) {
  const n = s.n, v = g.variant, late = clamp(g.t / DUR, 0, 1);
  const cap = Math.round(5 + n * 1.5) + (v === 'galline' ? 7 : 0);
  const live = s.tg.length;
  const goldP = s.gold ? 0.3 : 0.1;
  const slow = v === 'galline' || v === 'drago' ? 1.7 : 1;
  s.crowT -= dt;
  if (s.crowT <= 0) { s.crowT = (g.rng.range(0.9, 1.6) * slow) / (1 + late * 0.4); if (live < cap) addCrow(s, g, goldP); }
  s.balT -= dt;
  if (s.balT <= 0) { s.balT = (g.rng.range(1.0, 1.8) * slow) / (1 + late * 0.3); if (live < cap) addBalloon(s, g, goldP, g.rng.chance(0.2)); }
  s.hatT -= dt;
  if (s.hatT <= 0) {
    s.hatT = g.rng.range(8, 11);
    addTarget(s, HAT, 2, { x0: g.rng.range(240, W - 240), y0: 760, vx: g.rng.range(70, 200) * (g.rng.chance(0.5) ? 1 : -1), vy: -g.rng.range(820, 900), gr: 640 });
    g.say('IL CAPPELLO DEL GIULLARE: RUBA PUNTI!');
    g.sfx('boing');
  }
  s.quivT -= dt;
  if (s.quivT <= 0) {
    s.quivT = g.rng.range(9, 13);
    addTarget(s, QUIVER, 1, { x0: g.rng.range(180, W - 180), y0: 790, vx: g.rng.range(-20, 20) + s.wind * 0.2, vy: -g.rng.range(70, 90), ph: g.rng.range(0, 6.28) });
  }
  if (v === 'drago') {
    if (!s.tg.some((t) => t.boss)) { s.bossT -= dt; if (s.bossT <= 0) addDragon(s, g, true); }
    const boss = s.tg.find((t) => t.boss);
    if (boss) {
      s.fireT -= dt;
      if (s.fireT <= 0) {
        s.fireT = g.rng.range(2.0, 2.8) / (1 + late * 0.4);
        const tgt = g.rng.pick(s.p);
        const fx = boss.x + Math.sign(Math.cos(boss.a * 0.33 + boss.ph) || 1) * 60, fy = boss.y + 20;
        const dx = tgt.x - fx, dy = WALK - 60 - fy, d = Math.hypot(dx, dy) || 1, sp = 290 + late * 90;
        addTarget(s, FIRE, 4, { x0: fx, y0: fy, vx: (dx / d) * sp, vy: (dy / d) * sp, v: tgt.i });
        g.sfx('fire');
      }
    }
  } else {
    s.dragT -= dt;
    if (s.dragT <= 0) { s.dragT = 17; addDragon(s, g, false); }
  }
  if (v === 'galline') {
    s.henT -= dt;
    if (s.henT <= 0 && live < cap) {
      s.henT = g.rng.range(0.35, 0.6);
      addTarget(s, HEN, 2, { x0: g.rng.range(140, W - 140), y0: 760, vx: g.rng.range(60, 210) * (g.rng.chance(0.5) ? 1 : -1), vy: -g.rng.range(760, 880), gr: 700, gold: g.rng.chance(goldP) });
      if (g.rng.chance(0.25)) g.sfx('quack', { vol: 0.5, pitch: g.rng.range(0.9, 1.3) });
    }
  }
  if (v === 'vento') {
    s.windT -= dt;
    if (s.windT <= 0) {
      s.windT = 7;
      const nw = g.rng.pick([-300, -190, 190, 300]);
      s.wind = nw;
      g.say(nw > 0 ? 'TRAMONTANA → VERSO DESTRA!' : 'TRAMONTANA ← VERSO SINISTRA!');
      g.sfx('whoosh', { pitch: 0.5 });
    }
  }
}

// ---------- scoring ----------
function addScore(s, g, i, pts, x, y, label) {
  const k = s.gold ? 2 : 1;
  const got = pts * k;
  s.p[i].score += got;
  s.p[i].happy = 0.8;
  s.last = i;
  g.text(x, y - 46, (label ? label + ' ' : '') + '+' + got, { player: i, size: label ? 50 : 42 });
  return got;
}

// Best rival (not an ally) to rob, by score.
function robbable(s, g, i) {
  let best = null;
  for (const q of s.p) if (!g.ally(q.i, i) && q.score > 0 && (!best || q.score > best.score)) best = q;
  return best;
}

function daze(g, q, sec, kick, label) {
  if (q.stun > 0.2) return;
  q.stun = Math.max(q.stun, sec);
  q.hold = -1; q.c = 0;
  q.cvx += kick.x; q.cvy += kick.y;
  q.anim = 4; q.ak++;
  g.vibrate(q.i, 120);
  if (label) g.text(q.x, WALK - 130, label, { color: '#ffffff', size: 40 });
}

function killTarget(s, t) { t.dead = true; }

function hitTarget(s, g, t, i, ax, ay) {
  if (t.dead) return;
  const p = s.p[i];
  const x = t.x, y = t.y;
  switch (t.k) {
    case CROW:
    case HEN: {
      killTarget(s, t);
      addScore(s, g, i, t.gold ? 3 : 1, x, y, t.gold ? 'ORO!' : '');
      g.burst(x, y, { color: t.gold ? '#ffd23f' : t.k === HEN ? '#ffffff' : '#2a2633', n: 14, speed: 260, size: 8 });
      g.sfx(t.k === HEN ? 'quack' : 'squish', { pitch: t.k === HEN ? 1.2 : 1 });
      if (t.gold) { g.sfx('coin'); g.ring(x, y, { color: '#ffd23f', r: 80 }); g.hitstop(0.05); }
      break;
    }
    case BAL: {
      killTarget(s, t);
      addScore(s, g, i, t.gold ? 3 : 1, x, y, t.gold ? 'ORO!' : '');
      g.burst(x, y, { color: t.gold ? '#ffd23f' : BAL_COLS[t.c], n: 12, speed: 300, size: 7 });
      g.sfx('pop', { pitch: 0.9 + (t.c % 3) * 0.1 });
      if (t.gold) { g.sfx('coin'); g.ring(x, y, { color: '#ffd23f', r: 80 }); }
      if (t.pair) {
        const prev = s.twin[t.pair];
        if (prev && s.t - prev.t < 2.5) {
          delete s.twin[t.pair];
          if (prev.by === i) { addScore(s, g, i, 2, x, y - 50, 'DOPPIETTA!'); g.sfx('tada'); }
          else if (s.tm && g.ally(prev.by, i)) {
            addScore(s, g, i, 3, x, y - 50, 'COLPO DI SQUADRA!');
            g.say('COLPO DI SQUADRA!'); g.sfx('fanfare'); g.confetti(x, y);
          }
        } else s.twin[t.pair] = { by: i, t: s.t };
      }
      break;
    }
    case QUIVER: {
      killTarget(s, t);
      p.spec = g.rng.chance(0.5) ? SP_TRIPLE : SP_FIRE;
      p.sn = p.spec === SP_TRIPLE ? 3 : 2;
      g.text(p.x, WALK - 150, p.spec === SP_TRIPLE ? 'FRECCE TRIPLE!' : 'FRECCE DI FUOCO!', { player: i, size: 46 });
      g.burst(x, y, { color: '#c78bff', n: 18, speed: 300, size: 8 });
      g.sfx('powerup');
      break;
    }
    case HAT: {
      killTarget(s, t);
      const v = robbable(s, g, i);
      if (v) {
        const st = Math.min(s.gold ? 4 : 2, v.score);
        v.score -= st; p.score += st; p.happy = 1; s.last = i;
        g.text(x, y - 40, `RUBATI ${st}!`, { player: i, size: 52 });
        g.text(v.x, WALK - 140, `-${st}`, { player: v.i, size: 46 });
        g.say(s.tm ? 'PUNTI RUBATI ALL\'ALTRA SQUADRA!' : 'CAPPELLO PRESO: PUNTI RUBATI!');
      } else addScore(s, g, i, 1, x, y, 'CAPPELLO!');
      g.sfx('swap'); g.sfx('boing', { pitch: 1.3 });
      g.burst(x, y, { color: '#ffd23f', n: 16, speed: 320, size: 8 });
      g.shake(0.2);
      break;
    }
    case FIRE: {
      killTarget(s, t);
      addScore(s, g, i, 1, x, y, '');
      g.burst(x, y, { color: '#ff8a2a', n: 12, speed: 240, size: 8 });
      g.sfx('splash', { pitch: 1.4 });
      break;
    }
    case DRAGON: {
      t.hp--;
      t.flash = 0.15;
      // Two team mates hitting the dragon close together: team combo.
      if (s.tm && t.lastBy >= 0 && t.lastBy !== i && g.ally(t.lastBy, i) && s.t - t.lastT < 1.0) {
        addScore(s, g, i, 2, x, y - 70, 'COLPO DI SQUADRA!');
        g.sfx('tada');
      }
      t.lastBy = i; t.lastT = s.t;
      if (t.hp <= 0) {
        killTarget(s, t);
        addScore(s, g, i, t.boss ? 10 : 6, x, y, t.boss ? 'DRAGO ABBATTUTO!' : 'DRAGHETTO!');
        g.say(t.boss ? 'DRAGO ABBATTUTO!' : 'DRAGHETTO ABBATTUTO!', { big: true });
        g.sfx('bigexplode'); g.sfx('fanfare');
        g.burst(x, y, { color: '#5fd35a', n: 30, speed: 480, size: 12 });
        g.burst(x, y, { player: i, n: 20, speed: 380, size: 10 });
        g.confetti(x, y);
        g.shake(0.6); g.slowmo(0.35, 0.6); g.hitstop(0.08);
        if (t.boss) s.bossT = 4;
      } else {
        addScore(s, g, i, 1, x, y, '');
        g.sfx('punch'); g.burst(x, y, { color: '#ffffff', n: 8, speed: 220 });
        g.shake(0.15);
      }
      break;
    }
    default: break;
  }
  g.vibrate(i, 40);
}

// ---------- arrows ----------
function fire(s, g, p) {
  const c = p.c;
  p.hold = -1; p.c = 0; p.cd = RELOAD;
  const spec = p.sn > 0 ? p.spec : 0;
  if (spec) { p.sn--; if (!p.sn) p.spec = 0; }
  const pow = c >= 0.97;
  const bx = p.x + (p.cx >= p.x ? 16 : -16), by = BOW_Y;
  const dx = p.cx - bx, dy = p.cy - by, d = Math.hypot(dx, dy) || 1;
  const px = -dy / d, py = dx / d;
  const offs = spec === SP_TRIPLE ? [-1, 0, 1] : [0];
  for (const k of offs) {
    const x1 = clamp(p.cx + px * k * 85, -40, W + 40), y1 = clamp(p.cy + py * k * 85, 0, CY1 + 40);
    const D = dist(bx, by, x1, y1);
    const T = Math.max(0.1, D / (1500 + 1800 * c));
    s.ar.push({ id: s.nid++, o: p.i, x0: bx, y0: by, x1, y1, wx: s.wind * T, arcH: D * 0.08 * (1 - c * 0.6), t: 0, T, c, k: spec === SP_FIRE ? 2 : pow ? 1 : 0 });
  }
  p.anim = 2; p.ak++; p.animT = 0.35;
  if (spec === SP_FIRE) g.sfx('fire');
  else if (spec === SP_TRIPLE) g.sfx('shoot', { pitch: 0.8 });
  else g.sfx('shoot', { pitch: pow ? 0.7 : 1.15, vol: pow ? 1 : 0.6 });
  if (pow) { g.sfx('whoosh', { pitch: 0.7 }); g.burst(bx, by, { player: p.i, n: 8, speed: 220 }); }
}

function arrowPos(a, u, out) {
  out.x = a.x0 + (a.x1 - a.x0) * u + a.wx * u * u;
  out.y = a.y0 + (a.y1 - a.y0) * u - a.arcH * Math.sin(Math.PI * u);
  const tx = a.x1 - a.x0 + 2 * a.wx * u, ty = a.y1 - a.y0 - a.arcH * Math.PI * Math.cos(Math.PI * u);
  out.a = Math.atan2(ty, tx);
  return out;
}

function land(s, g, a) {
  const x = a.x1 + a.wx, y = a.y1;
  const rr = a.k === 2 ? FIRE_R : 16 + 22 * a.c;
  let hits = s.tg.filter((t) => !t.dead && dist(x, y, t.x, t.y) < t.r + rr);
  if (a.k === 0 && hits.length > 1) {
    let best = hits[0];
    for (const t of hits) if (dist(x, y, t.x, t.y) < dist(x, y, best.x, best.y)) best = t;
    hits = [best];
  }
  if (a.k === 2) {
    s.bm.push({ id: s.nid++, x, y, t: 0 });
    g.sfx('explode'); g.shake(0.35);
    g.burst(x, y, { color: '#ffb02e', n: 22, speed: 420, size: 11 });
    g.ring(x, y, { color: '#ff5a28', r: FIRE_R });
    for (const q of s.p) {
      if (g.ally(q.i, a.o) || dist(q.cx, q.cy, x, y) > FIRE_R) continue;
      daze(g, q, 0.9, { x: (q.cx - x) * 4, y: (q.cy - y) * 4 }, 'ACCECATO!');
    }
  }
  for (const t of hits) hitTarget(s, g, t, a.o, x, y);
  if (!hits.length && a.k !== 2) g.burst(x, y, { color: '#e8dcc0', n: 4, speed: 110, size: 4 });
  if (hits.length > 1 && a.k !== 2) { g.text(x, y + 40, 'TRAFITTI!', { player: a.o, size: 40 }); g.sfx('tada', { vol: 0.5 }); }
}

// ---------- archers ----------
function updateArcher(s, g, p, inp, dt) {
  p.cd = Math.max(0, p.cd - dt);
  p.stun = Math.max(0, p.stun - dt);
  p.rockCd = Math.max(0, p.rockCd - dt);
  p.happy = Math.max(0, p.happy - dt);
  p.animT = Math.max(0, p.animT - dt);
  p.qa = Math.max(0, p.qa - dt);
  let mx = inp.sx ?? inp.x ?? 0, my = inp.sy ?? inp.y ?? 0;
  const m = Math.hypot(mx, my);
  if (m > 1) { mx /= m; my /= m; } else if (m < 0.12) { mx = 0; my = 0; }
  if (p.stun > 0) { mx = Math.sin(s.t * 9 + p.i * 2) * 0.6; my = Math.cos(s.t * 7.3 + p.i) * 0.6; }
  // Holding the bow too long: the arm trembles.
  if (p.hold > 2.2) { const k = Math.min(1, (p.hold - 2.2) / 1.5); mx += Math.sin(s.t * 23 + p.i) * 0.7 * k; my += Math.cos(s.t * 19 + p.i) * 0.7 * k; }
  const sp = AIM_V * (p.hold >= 0 ? 0.6 : 1);
  p.cvx = approach(p.cvx, mx * sp, 7000 * dt);
  p.cvy = approach(p.cvy, my * sp, 7000 * dt);
  p.cx += p.cvx * dt; p.cy += p.cvy * dt;
  if (p.cx < CX0 || p.cx > CX1) { p.cx = clamp(p.cx, CX0, CX1); p.cvx = 0; }
  if (p.cy < CY0 || p.cy > CY1) { p.cy = clamp(p.cy, CY0, CY1); p.cvy = 0; }
  if (p.stun > 0 || g.ended) return;
  // Bow: press = start drawing, release = shoot (a tap shoots at once). Presses during the reload are buffered.
  if (inp.aP) p.qa = p.hold < 0 ? 0.2 : 0;
  if (p.hold < 0 && p.cd <= 0 && p.qa > 0) { p.hold = 0; p.qa = 0; p.held = !!inp.a; }
  if (p.hold >= 0) {
    if (inp.a && p.held) {
      p.hold += dt;
      const c0 = p.c;
      p.c = clamp((p.hold - CH_T0) / CH_T, 0, 1);
      if (c0 < 1 && p.c >= 1) g.sfx('tick', { pitch: 1.7 });
      p.anim = 1;
    } else fire(s, g, p);
  }
  // Pebble at the nearest rival archer.
  if (inp.bP && p.rockCd <= 0) {
    let v = null;
    for (const q of s.p) if (!g.ally(q.i, p.i) && (!v || Math.abs(q.x - p.x) < Math.abs(v.x - p.x))) v = q;
    if (v) {
      s.rk.push({ id: s.nid++, o: p.i, v: v.i, t: 0, T: 0.3 + Math.abs(v.x - p.x) / 2200 });
      p.rockCd = ROCK_CD;
      p.anim = 3; p.ak++; p.animT = 0.4;
      g.sfx('whoosh', { pitch: 1.6, vol: 0.6 });
    }
  }
}

export default {
  id: 'arcieri',
  name: 'Arcieri sulle Mura',
  rule: 'Dalle mura colpisci corvi, palloni e draghetti!',
  verb: 'TIRA!',
  inspired: 'Wii Play · Tiro a segno / Duck Hunt',
  cam: 'side',
  split: false,
  players: 4,
  teams: true,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Tira', b: 'Sassata' },
  duration: DUR,
  help: {
    goal: 'Fai più punti di tutti tirando frecce ai bersagli nel cielo. A squadre conta il punteggio di squadra.',
    dir: 'Muovi il mirino nel cielo (mentre tendi l\'arco va più piano e preciso)',
    a: 'TIRA: tocco = freccia rapida. Tieni premuto = arco teso: freccia velocissima, più grande, trapassa tutto (non tenerlo troppo, il braccio trema!)',
    b: 'SASSATA: tiri un sassolino all\'arciere rivale più vicino: perde la mira e la carica',
    tips: ['Corvi e palloni d\'oro valgono 3, il draghetto vuole 4 frecce: l\'ultima prende il bottino', 'Il cappello del giullare RUBA punti a chi è in testa', 'La faretra viola dà frecce triple o di fuoco · ultimi 10 s punti doppi · a squadre: palloni gemelli e draghetto colpiti insieme = bonus'],
  },
  variants: [
    { id: 'vento', name: 'Tramontana', desc: 'Raffiche di vento deviano le frecce: mira controvento!' },
    { id: 'galline', name: 'Pioggia di Galline', desc: 'Dalla valle catapultano galline a raffica!' },
    { id: 'drago', name: 'Il Drago del Monte', desc: 'Un drago enorme sputa palle di fuoco sugli arcieri: abbattilo!' },
  ],

  init(g) {
    const n = g.n || 2;
    const tm = g.teams ? [...g.teams] : null;
    const order = [...Array(n).keys()];
    if (tm) order.sort((a, b) => tm[a] - tm[b] || a - b);
    const xs = POS[n] || POS[4];
    const p = [...Array(n).keys()].map((i) => {
      const x = xs[order.indexOf(i)];
      return { i, x, cx: x, cy: 330, cvx: 0, cvy: 0, hold: -1, held: false, c: 0, cd: 0.3, qa: 0, stun: 0, score: 0, spec: 0, sn: 0, rockCd: 1.5, anim: 0, ak: 0, animT: 0, happy: 0 };
    });
    return {
      n, p, tm, tg: [], ar: [], rk: [], bm: [], nid: 1, t: 0, last: -1, twin: {},
      wind: 0, windT: g.variant === 'vento' ? 1.5 : 99, crowT: 0.4, balT: 0.9, hatT: 7, quivT: 4.5, dragT: 13, henT: 0.5,
      bossT: 1.5, fireT: 3.5, gold: false,
    };
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.t = g.t;
    if (!s.gold && g.t >= GOLD_T && !g.ended) {
      s.gold = true;
      g.say('FRECCE D\'ORO: PUNTI DOPPI!', { big: true });
      g.sfx('fanfare'); g.flash('#ffd23f', 0.35);
    }
    if (!g.ended) spawn(s, g, dt);
    for (const p of s.p) updateArcher(s, g, p, inp[p.i], dt);
    // Targets move; escapes; fireballs reach the wall.
    for (const t of s.tg) {
      if (t.dead) continue;
      t.a += dt;
      t.flash = Math.max(0, (t.flash || 0) - dt);
      posAt(t, t.a, t);
      if (t.m === 0 && ((t.vx > 0 && t.x > W + 200) || (t.vx < 0 && t.x < -200))) {
        t.dead = true;
        if (t.k === DRAGON) { g.say('IL DRAGHETTO È SCAPPATO!'); g.sfx('buzzer', { vol: 0.5 }); }
      } else if (t.m === 1 && t.y < -80) t.dead = true;
      else if (t.m === 2 && t.vy + t.gr * t.a > 0 && t.y > H + 40) t.dead = true;
      else if (t.m === 4 && t.y >= WALK - 70) {
        t.dead = true;
        const q = s.p[t.v];
        g.burst(t.x, t.y, { color: '#ff8a2a', n: 18, speed: 300, size: 10 });
        g.sfx('explode', { vol: 0.7 }); g.shake(0.3);
        if (q && Math.abs(q.x - t.x) < 80) {
          const lost = Math.min(1, q.score);
          q.score -= lost;
          daze(g, q, 1.3, { x: 0, y: 600 }, lost ? 'BRUCIATO! -1' : 'BRUCIATO!');
        }
      }
    }
    // Arrows.
    for (const a of s.ar) {
      a.t += dt;
      if (a.t >= a.T) { a.dead = true; land(s, g, a); }
    }
    // Pebbles.
    for (const k of s.rk) {
      k.t += dt;
      if (k.t >= k.T) {
        k.dead = true;
        const q = s.p[k.v];
        if (q.stun > 0.2) continue;
        daze(g, q, ROCK_STUN, { x: (q.x > s.p[k.o].x ? 1 : -1) * 700, y: -400 }, 'SASSATA!');
        g.sfx('bonk'); g.burst(q.x, WALK - 95, { color: '#cfc6b8', n: 8, speed: 200, size: 6 });
      }
    }
    for (const b of s.bm) b.t += dt;
    s.tg = s.tg.filter((t) => !t.dead);
    s.ar = s.ar.filter((a) => !a.dead);
    s.rk = s.rk.filter((k) => !k.dead);
    s.bm = s.bm.filter((b) => b.t < 0.5);
  },

  timeout(s, g) {
    const best = (list) => {
      const top = Math.max(...list.map((p) => p.score));
      return list.filter((p) => p.score === top);
    };
    if (s.tm) {
      const ts = [0, 0];
      for (const p of s.p) ts[s.tm[p.i]] += p.score;
      if (ts[0] !== ts[1]) { const wt = ts[0] > ts[1] ? 0 : 1; return best(s.p.filter((p) => s.tm[p.i] === wt))[0].i; }
      if (s.last >= 0) return s.last;
      return g.rng.int(0, s.n - 1);
    }
    const c = best(s.p);
    if (c.length === 1) return c[0].i;
    if (c.some((p) => p.i === s.last)) return s.last;
    return c[g.rng.int(0, c.length - 1)].i;
  },

  view(s) {
    const tmp = {};
    const ts = s.tm ? [0, 0] : null;
    if (ts) for (const p of s.p) ts[s.tm[p.i]] += p.score;
    return {
      p: s.p.map((p) => ({
        x: p.x, cx: r1(p.cx), cy: r1(p.cy), c: r2(p.c), st: p.stun > 0 ? 1 : 0, rd: p.cd <= 0 && p.stun <= 0 ? 1 : 0,
        sp: p.spec, sn: p.sn, an: p.stun > 0 ? 4 : p.animT > 0 ? p.anim : p.happy > 0 ? 5 : p.hold >= 0 ? 1 : 0, ak: p.ak,
        pt: p.score, tm: s.tm ? s.tm[p.i] : p.i, hd: p.hold > 2.2 ? 1 : 0,
      })),
      tg: s.tg.map((t) => {
        const o = { id: t.id, k: t.k, x: r1(t.x), y: r1(t.y) };
        if (t.gold) o.g = 1;
        if (t.k === BAL) o.c = t.c;
        if (t.pair) o.pr = t.pair;
        if (t.k === DRAGON) { o.hp = t.hp; o.hm = t.hp0; o.fl = t.flash > 0 ? 1 : 0; o.bs = t.boss ? 1 : 0; }
        if (t.m === 0 || t.m === 2 || t.m === 4) o.f = t.vx >= 0 ? 1 : -1;
        else if (t.m === 3) o.f = Math.cos(t.a * 0.33 + t.ph) >= 0 ? 1 : -1;
        return o;
      }),
      ar: s.ar.map((a) => {
        arrowPos(a, clamp(a.t / a.T, 0, 1), tmp);
        return { id: a.id, o: a.o, x: r1(tmp.x), y: r1(tmp.y), a: r2(tmp.a), k: a.k };
      }),
      rk: s.rk.map((k) => {
        const u = clamp(k.t / k.T, 0, 1), a = s.p[k.o], b = s.p[k.v];
        const x = a.x + (b.x - a.x) * u, y = WALK - 90 - Math.sin(Math.PI * u) * (50 + Math.abs(b.x - a.x) * 0.12);
        return { id: k.id, x: r1(x), y: r1(y) };
      }),
      bm: s.bm.map((b) => ({ id: b.id, x: r1(b.x), y: r1(b.y), t: r2(b.t) })),
      wd: s.wind, gd: s.gold ? 1 : 0, ts,
      hud: { p: s.p.map((p) => (ts ? ts[s.tm[p.i]] : p.score)), max: null, label: ts ? 'Squadra' : 'Punti' },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: clamp(p.cx, 0, W), y: clamp(p.cy, 0, H) }));
  },

  // Computer archer: picks the best target (value / time), leads it (Re exactly, Cavaliere roughly, Scudiero
  // barely), charges the bow for far/fast targets and dragons, throws pebbles at rivals drawing a big shot.
  bot(s, me, g, B) {
    const p = s.p[me], L = B.level, M = B.mem, t = g.t, lag = BOT_LAG[L];
    const w = { x: 0, y: 0, sx: 0, sy: 0 };
    if (g.ended || p.stun > 0) { M.charging = false; return w; }
    const tmp = M.tmp || (M.tmp = { x: 0, y: 0 });
    // Pebble.
    if (p.rockCd <= 0) {
      let v = null;
      for (const q of s.p) if (!g.ally(q.i, me) && (!v || Math.abs(q.x - p.x) < Math.abs(v.x - p.x))) v = q;
      if (v && v.stun <= 0 && ((L >= 1 && v.hold > 0.25 && v.c > 0.3) || (L === 2 && v.sn > 0) || (L === 0 && B.rng() < 0.006))) w.tapB = true;
    }
    const bx = p.x, by = BOW_Y;
    // Where target t will be when my arrow lands (lead = reaction lag + crosshair travel + charge + flight).
    const plan = (tg, c) => {
      const leadK = [0.55, 0.85, 1][L];
      let ax = tg.x, ay = tg.y;
      for (let k = 0; k < 2; k++) {
        const move = dist(p.cx, p.cy, ax, ay) / AIM_V + 0.05;
        const flight = dist(bx, by, ax, ay) / (1500 + 1800 * c);
        const tl = (lag + Math.max(move, c ? CH_T0 + CH_T * c : 0) + flight) * leadK;
        posAt(tg, tg.a + tl, tmp);
        ax = tmp.x + (s.wind && L ? -s.wind * flight * (L === 2 ? 1 : 0.6) : 0); ay = tmp.y;
      }
      return { x: ax, y: ay };
    };
    const want = (tg) => (L === 2 && (tg.k === DRAGON || Math.abs(tg.y - by) > 420 || tg.r < 32)) || (L === 1 && tg.k === DRAGON) ? 1 : 0;
    // (Re)pick a target.
    let tg = M.tid ? s.tg.find((q) => q.id === M.tid) : null;
    if (!tg || t > M.reT) {
      let best = null, bs = -1;
      const ally = s.tm ? s.p.find((q) => q.i !== me && g.ally(q.i, me)) : null;
      for (const q of s.tg) {
        const c = want(q);
        const P = plan(q, c);
        if (P.x < CX0 + 10 || P.x > CX1 - 10 || P.y < CY0 + 5 || P.y > CY1 - 10) continue;
        let val = q.gold ? 3 : 1;
        if (q.k === DRAGON) val = q.hp <= 1 ? (q.boss ? 10 : 6) : 1.6;
        else if (q.k === HAT) { const v = robbable(s, g, me); val = v ? Math.min(2, v.score) * (L === 2 ? 1.6 : 1) + 0.5 : 1; }
        else if (q.k === QUIVER) val = L ? 2.4 : 1.2;
        else if (q.k === FIRE) val = L && q.v === me ? 5 : L && ally && q.v === ally.i ? 3 : 1;
        // Already being shot at (Re/Cavaliere don't waste arrows).
        if (L >= 1 && q.k !== DRAGON) for (const a of s.ar) if (dist(a.x1 + a.wx, a.y1, q.x, q.y) < q.r + 60 && a.T - a.t < 0.5) val *= 0.2;
        // Team: leave the ally its target, but go for the twin of the balloon it aims at.
        if (ally && q.k !== DRAGON) {
          const near = dist(ally.cx, ally.cy, q.x, q.y) < 110;
          if (near && !q.pair) val *= 0.35;
          if (q.pair && !near && s.tg.some((o) => o !== q && o.pair === q.pair && dist(ally.cx, ally.cy, o.x, o.y) < 110)) val *= 2.2;
        }
        const cost = 0.3 + dist(p.cx, p.cy, P.x, P.y) / AIM_V + (c ? 0.5 : 0) + (L === 0 ? B.rng() * 0.6 : 0);
        const sc = val / cost;
        if (sc > bs) { bs = sc; best = q; }
      }
      tg = best;
      M.tid = tg ? tg.id : 0;
      M.reT = t + [0.7, 0.4, 0.25][L];
      M.c = tg ? want(tg) : 0;
    }
    if (!tg) { M.charging = false; return w; }
    const c = M.c;
    const P = plan(tg, c);
    // Crosshair: proportional steering on the position it will have after my reaction lag.
    const fx = p.cx + p.cvx * lag, fy = p.cy + p.cvy * lag;
    const tau = Math.max(0.11, lag * 1.25);
    let vx = (P.x - fx) / tau, vy = (P.y - fy) / tau;
    if (L === 2) { posAt(tg, tg.a + 0.05, tmp); vx += (tmp.x - tg.x) / 0.05; vy += (tmp.y - tg.y) / 0.05; }
    let sx = vx / AIM_V, sy = vy / AIM_V;
    const m = Math.hypot(sx, sy);
    if (m > 1) { sx /= m; sy /= m; }
    w.x = w.sx = sx; w.y = w.sy = sy;
    const err = dist(fx, fy, P.x, P.y);
    const tol = tg.r * [0.85, 0.6, 0.45][L] + 14;
    if (c) {
      // Charged shot: draw the bow early, release on target once it is full.
      if (p.hold >= 0 || p.cd <= 0) {
        if (p.c >= 0.97 && err < tol) { M.charging = false; return w; } // release
        if (p.hold > 2.0) { M.charging = false; return w; } // arm trembling: let go
        w.a = true; M.charging = true;
      }
    } else if (p.cd <= 0 && err < tol && p.hold < 0) w.tapA = true;
    return w;
  },

  render3d: {
    assets: [
      'medieval/mountain_A_grass', 'medieval/mountain_B_grass_trees', 'medieval/mountain_C_grass', 'medieval/hills_A_trees', 'medieval/hills_B_trees', 'medieval/hills_C_trees',
      'medieval/building_castle_blue', 'medieval/building_home_A_red', 'medieval/building_home_B_yellow', 'medieval/building_home_A_blue', 'medieval/building_home_B_green',
      'medieval/building_church_red', 'medieval/building_tavern_yellow', 'medieval/building_market_green', 'medieval/building_well_blue', 'medieval/building_bridge_A',
      'medieval/building_tower_base_red', 'medieval/building_grain', 'medieval/trees_A_large', 'medieval/trees_B_large', 'medieval/trees_A_medium', 'medieval/tree_single_A', 'medieval/tree_single_B',
      'medieval/cloud_big', 'medieval/cloud_small', 'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow',
      'medieval/bucket_arrows', 'medieval/barrel', 'medieval/crate_A_small', 'medieval/target',
      'dungeon/banner_patternA_red', 'dungeon/banner_patternA_blue', 'dungeon/banner_patternA_green', 'dungeon/banner_patternA_yellow',
      'weapons/quiver', 'chars/Rogue', 'chars/Knight',
    ],
    cam: { tilt: -0.05 },
    build(K) {
      const T3 = K.THREE;
      const n = Math.max(2, K.n || 2), lo = K.quality === 0;
      const o = { n };
      K.theme('giorno', { fogNear: 3, fogFar: 14 });
      o.sunCol = K.sun ? K.sun.color.clone() : null;
      o.goldC = new T3.Color('#ffc340');
      const sunM = K.glow('#fff4c8', { opacity: 0.95 }); sunM.fog = false;
      K.place(K.ball(240, sunM, { cast: false }), W * 0.86, 90, -7500);
      const hplane = (x0, x1, z0, z1, y, mat) => {
        const me = K.mesh(new T3.PlaneGeometry(x1 - x0, z0 - z1).rotateX(-Math.PI / 2), mat, { cast: false });
        me.userData.ownGeo = true;
        me.position.set((x0 + x1) / 2, -y, (z0 + z1) / 2);
        return me;
      };
      const VY = 1250; // valley floor (far below the wall walk)
      // --- the valley ---
      hplane(-9000, 10200, -200, -13000, VY, K.texMat('prato', [80, 60], { color: '#c7dc98' }));
      // Patchwork of fields in front of the river.
      const fieldTex = K.canvasTex(512, 256, (d, ctx) => {
        const cols = ['#e3c45a', '#9cc35a', '#c99a55', '#7fb04a', '#e8d27a', '#a7c96a', '#b98b4a'];
        for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) {
          ctx.fillStyle = cols[(i * 3 + j * 5) % cols.length];
          ctx.fillRect(i * 64, j * 64, 64, 64);
          ctx.strokeStyle = 'rgba(70,50,20,0.35)'; ctx.lineWidth = 2;
          for (let k = 6; k < 64; k += 9) { ctx.beginPath(); ctx.moveTo(i * 64 + 2, j * 64 + k); ctx.lineTo(i * 64 + 62, j * 64 + k); ctx.stroke(); }
          ctx.strokeStyle = '#4f7a30'; ctx.lineWidth = 4; ctx.strokeRect(i * 64, j * 64, 64, 64);
        }
      });
      hplane(-3000, 4200, -4300, -5300, VY - 2, new T3.MeshStandardMaterial({ map: fieldTex, roughness: 0.95, color: '#ffffff' }));
      // River with a stone bridge.
      const wtex = K.tex('acqua', { rep: [40, 3], seed: 9 });
      const wm = new T3.MeshStandardMaterial({ map: wtex, color: '#d6efff', roughness: 0.15, metalness: 0.15, emissive: '#0a3a5a', emissiveIntensity: 0.3 });
      hplane(-7000, 8200, -5450, -5900, VY - 4, wm);
      K.ticks.push((dt, t) => { if (wtex) { wtex.offset.x = (t * 0.02) % 1; wtex.offset.y = (t * 0.01) % 1; } });
      K.scatter('medieval/building_bridge_A', [{ x: 1500, y: VY, h: -5680, rot: Math.PI / 2 }], { size: 600 });
      // Village at the foot of the walls.
      const homes = [
        ['medieval/building_home_A_red', [[-520, -2150, 0.3], [380, -2350, 1.2], [1350, -2100, 2.0]]],
        ['medieval/building_home_B_yellow', [[-120, -2500, 0.8], [880, -2150, 2.4], [1900, -2450, 0.1]]],
        ['medieval/building_home_A_blue', [[160, -2050, 2.7], [1580, -2700, 1.0], [-900, -2600, 0.6]]],
        ['medieval/building_home_B_green', [[640, -2750, 0.4], [2250, -2150, 1.8], [-300, -2950, 2.2]]],
      ];
      for (const [m, l] of homes) K.scatter(m, l.map(([x, h, rot]) => ({ x: x * 1.2, y: VY, h: h - 900, rot })), { size: 330 });
      K.scatter('medieval/building_church_red', [{ x: 1300, y: VY, h: -3550, rot: 0.2 }], { size: 460 });
      K.scatter('medieval/building_tavern_yellow', [{ x: -840, y: VY, h: -3150, rot: 1.0 }], { size: 380 });
      K.scatter('medieval/building_market_green', [{ x: 670, y: VY, h: -3200, rot: 0.1 }], { size: 320 });
      K.scatter('medieval/building_well_blue', [{ x: 290, y: VY, h: -3320 }], { size: 150 });
      K.scatter('medieval/building_grain', [{ x: -1700, y: VY, h: -4500, rot: 0.5 }, { x: 2900, y: VY, h: -4600, rot: 2 }], { size: 260 });
      const orch = [];
      for (let k = 0; k < (lo ? 10 : 22); k++) orch.push({ x: -2400 + k * 240 + (k % 3) * 50, y: VY, h: -2700 - (k % 4) * 260 - (k % 2) * 900, rot: k * 1.7, s: 0.8 + (k % 4) * 0.12 });
      K.scatter('medieval/tree_single_A', orch.filter((_, k) => k % 2 === 0), { height: 240 });
      K.scatter('medieval/tree_single_B', orch.filter((_, k) => k % 2 === 1), { height: 220 });
      // Far bank: forest, hills, mountains and the enemy castle on its hill.
      const forest = [];
      for (let k = 0; k < (lo ? 8 : 16); k++) forest.push({ x: -3200 + k * 520 + (k % 3) * 90, y: VY, h: -6300 - (k % 3) * 300, rot: k * 2.3, s: 0.85 + (k % 3) * 0.15 });
      K.scatter('medieval/trees_A_large', forest.filter((_, k) => k % 2 === 0), { size: 560 });
      K.scatter('medieval/trees_B_large', forest.filter((_, k) => k % 2 === 1), { size: 560 });
      const hills = [];
      for (let k = 0; k < (lo ? 5 : 9); k++) hills.push({ x: -3600 + k * 1050, y: VY, h: -7600 - (k % 2) * 500, rot: k * 1.9, s: 0.9 + (k % 3) * 0.15 });
      K.scatter('medieval/hills_A_trees', hills.filter((_, k) => k % 3 === 0), { size: 1500 });
      K.scatter('medieval/hills_B_trees', hills.filter((_, k) => k % 3 === 1), { size: 1400 });
      K.scatter('medieval/hills_C_trees', hills.filter((_, k) => k % 3 === 2), { size: 1400 });
      const mts = [];
      for (let k = 0; k < (lo ? 5 : 8); k++) mts.push({ x: -4400 + k * 1500 + (k % 2) * 300, y: VY, h: -10500 - (k % 3) * 400, rot: k * 1.3, s: 0.9 + (k % 4) * 0.12 });
      K.scatter('medieval/mountain_A_grass', mts.filter((_, k) => k % 3 === 0), { size: 2800 });
      K.scatter('medieval/mountain_B_grass_trees', mts.filter((_, k) => k % 3 === 1), { size: 2600 });
      K.scatter('medieval/mountain_C_grass', mts.filter((_, k) => k % 3 === 2), { size: 2700 });
      const castle = K.model('medieval/building_castle_blue', { height: 820 });
      K.place(castle, 2500, VY, -7100);
      castle.rotation.y = -0.5;
      // Clouds drifting behind the shooting gallery.
      o.clouds = [0, 1, 2, 3].map((k) => ({ g: softCloud(K, K.model(k % 2 ? 'medieval/cloud_small' : 'medieval/cloud_big', { size: 700 - k * 60, cast: false })), x: -1000 + k * 900, y: -40 + (k % 2) * 140, z: -3200 - k * 500, v: 10 + k * 5 }));
      // --- the castle wall ---
      // Walk (flagstones), front wall face toward the camera, back parapet.
      hplane(-1600, 2800, 120, -130, WALK, K.texMat('lastre', [44, 3], { color: '#dccfb8' }));
      const wallM = K.texMat('muro', [40, 9], { color: '#d2c4ac' });
      K.place(K.box(4400, 980, 40, wallM), W / 2, WALK - 24 + 490, 120);
      K.place(K.box(4400, 46, 30, K.texMat('muro', [40, 0.5], { color: '#c9bba2' })), W / 2, WALK - 23, -118);
      const xs = POS[n] || POS[4];
      const freeAt = (x) => xs.every((ax) => Math.abs(ax - x) > 78);
      const front = [], back = [];
      for (let x = -700; x <= W + 700; x += 120) { if (freeAt(x)) front.push(x); back.push(x + 60); }
      instBoxes(K, front.map((x) => [x, WALK - 24 - 18, 120]), 70, 36, 40, K.texMat('muro', [0.8, 0.4], { color: '#d8cbb3' }));
      instBoxes(K, back.map((x) => [x, WALK - 46 - 18, -118]), 64, 36, 30, K.texMat('muro', [0.8, 0.4], { color: '#c9bba2' }));
      // Round corner towers at both ends (behind the play plane, crows pass in front of them).
      const towerM = K.texMat('muro', [8, 10], { color: '#cdbfa6' });
      const roofM = K.texMat('tetto', [6, 3], { color: '#ffffff' });
      for (const [x, c] of [[-330, 'red'], [W + 330, 'blue']]) {
        const body = K.mesh(new T3.CylinderGeometry(135, 150, 1200, 24), towerM); body.userData.ownGeo = true;
        K.place(body, x, 860, -200);
        const crown = K.mesh(new T3.CylinderGeometry(160, 160, 50, 24), towerM); crown.userData.ownGeo = true;
        K.place(crown, x, 275, -200);
        const roof = K.mesh(new T3.ConeGeometry(182, 290, 24), roofM); roof.userData.ownGeo = true;
        K.place(roof, x, 105, -200);
        const fl = K.model(`medieval/flag_${c}`, { height: 150 });
        K.place(fl, x, -40, -200);
      }
      // Props on the walk: a bucket of arrows next to each archer, barrels, crates, weapon racks.
      K.scatter('medieval/bucket_arrows', xs.slice(0, n).map((x, k) => ({ x: x + (k % 2 ? 62 : -62), y: WALK, h: -70, rot: k })), { height: 54 });
      K.scatter('medieval/barrel', [{ x: 40, y: WALK, h: -80 }, { x: W - 30, y: WALK, h: -84 }, { x: 90, y: WALK, h: -90 }], { height: 58 });
      K.scatter('medieval/crate_A_small', [{ x: W - 90, y: WALK, h: -80, rot: 0.4 }], { size: 50 });
      K.scatter('medieval/target', [{ x: -150, y: WALK, h: -95 }, { x: W + 150, y: WALK, h: -95 }], { height: 90 });
      // Heraldic banners hanging below every archer (in 2 vs 2 the player colors are already the team colors).
      o.banners = [...Array(n).keys()].map((i) => K.model(`dungeon/banner_patternA_${FLAG[K.roster[i]?.color ?? i] || 'red'}`, { height: 150 }));
      // NPCs: the jester (who throws the hat) on the right and the old king cheering on the left.
      o.jester = K.npc('rogue', { marker: false });
      o.king = K.npc('knight', { marker: false });
      K.ambient('foglie', { n: lo ? 14 : 26, h: 300 });
      // --- shared materials ---
      o.mat = {
        crow: K.mat('#24212c', { rough: 0.6 }), gold: K.mat('#ffc83a', { rough: 0.25, metal: 0.6, emissive: '#7a5200', ei: 0.45 }),
        beak: K.mat('#ff9b2a', { rough: 0.5 }), eye: K.glow('#ffffff'), pupil: K.glow('#111111'), white: K.mat('#fbf6ec', { rough: 0.6 }),
        comb: K.mat('#e8342c', { rough: 0.5 }), string: K.mat('#f3eee2', { rough: 0.9 }),
        bal: BAL_COLS.map((c) => K.mat(c, { rough: 0.28, emissive: c, ei: 0.14 })), shine: K.glow('#ffffff', { opacity: 0.55 }),
        drag: K.mat('#4fbf55', { rough: 0.45 }), dragB: K.mat('#c0392b', { rough: 0.45 }), belly: K.mat('#f3d67a', { rough: 0.6 }),
        wing: K.mat('#2f8a3a', { rough: 0.6, side: 2 }), wingB: K.mat('#7a1f1a', { rough: 0.6, side: 2 }), horn: K.mat('#f5ecd2', { rough: 0.4 }),
        flash: K.glow('#ffffff'), wood: K.mat('#7a5230', { rough: 0.7 }), iron: K.mat('#9aa3ad', { rough: 0.3, metal: 0.7 }),
        fireHead: K.glow('#ffb02e'), hatBand: K.mat('#5b2a86', { rough: 0.5 }), bell: K.mat('#ffd23f', { rough: 0.25, metal: 0.7 }),
        hatC: [K.mat('#e8342c', { rough: 0.5, side: 2 }), K.mat('#ffd23f', { rough: 0.5, side: 2 }), K.mat('#2ea84a', { rough: 0.5, side: 2 })],
        rock: K.mat('#9b948a', { rough: 0.9 }), quiv: K.mat('#9b59ff', { rough: 0.25, emissive: '#5a2a9a', ei: 0.35 }),
        ribbon: K.mat('#ff4fa0', { rough: 0.6 }), barBg: K.glow('#1a1028', { opacity: 0.8 }), barFg: K.glow('#ff5a3c'),
      };
      o.fletch = [...Array(n).keys()].map((i) => K.mat(K.col(i), { rough: 0.5, emissive: K.col(i), ei: 0.3 }));
      // --- target pools ---
      o.crows = [...Array(8)].map(() => makeCrow(K, o, false));
      o.hens = [...Array(lo ? 8 : 10)].map(() => makeCrow(K, o, true));
      o.bals = [...Array(12)].map(() => makeBalloon(K, o));
      o.quivs = [...Array(2)].map(() => makeQuiverBalloon(K, o));
      o.drags = [...Array(2)].map(() => makeDragon(K, o));
      o.hats = [...Array(2)].map(() => makeHat(K, o));
      o.fires = [...Array(6)].map(() => makeFireball(K));
      o.ribbons = [...Array(5)].map(() => K.box(1, 6, 4, o.mat.ribbon, { cast: false }));
      o.arrows = [...Array(26)].map(() => makeArrow(K, o));
      o.rocks = [...Array(4)].map(() => K.ball(10, o.mat.rock));
      o.booms = [...Array(3)].map(() => [K.ball(1, K.glow('#ffbe46', { add: true, unique: true }), { cast: false }), K.torus(1, 0.06, K.glow('#ff5a28', { add: true, unique: true }), { cast: false })]);
      o.windSign = K.billboard(256, 96, 190, (d, w, h, wd) => {
        if (!wd) return;
        d.rrect(6, 6, w - 12, h - 12, 30, 'rgba(20,30,50,0.65)', '#ffffff', 4);
        const dir = wd > 0 ? 1 : -1, cx = w / 2, cy = h / 2;
        d.line(cx - dir * 70, cy, cx + dir * 60, cy, '#bfe8ff', 12);
        d.poly([cx + dir * 92, cy, cx + dir * 48, cy - 30, cx + dir * 48, cy + 30], '#bfe8ff');
        if (Math.abs(wd) > 250) d.poly([cx - dir * 20, cy, cx - dir * 56, cy - 24, cx - dir * 56, cy + 24], '#ffffff');
      });
      K.place(o.windSign, W / 2, 34, 80);
      o.lastWind = null;
      // --- archers: avatar, bow, aim line, crosshair, special badge, dizzy stars ---
      o.pl = [...Array(n).keys()].map((i) => {
        const col = K.col(i), light = K.col(i, 'light');
        const P = { av: K.avatar(i) };
        P.bow = makeBow(K, o, i);
        P.aim = K.box(1, 4, 2, K.glow(light, { opacity: 0.4 }), { cast: false });
        P.ch = K.group();
        P.ring = K.torus(30, 3.2, K.glow(col), { parent: P.ch, cast: false });
        P.ringW = K.torus(36, 1.6, K.glow('#ffffff', { opacity: 0.7 }), { parent: P.ch, cast: false });
        P.full = K.torus(40, 4.5, K.glow('#ffd23f', { add: true }), { parent: P.ch, cast: false });
        P.fill = K.disc(28, K.glow(light, { opacity: 0.45 }), { parent: P.ch });
        P.ticks = K.group(P.ch);
        for (let k = 0; k < 4; k++) {
          const b = K.box(14, 4, 2, K.glow(col), { parent: P.ticks, cast: false });
          const an = (k * Math.PI) / 2;
          K.place(b, Math.cos(an) * 38, Math.sin(an) * 38, 0); K.face(b, an);
        }
        P.dot = K.ball(4, K.glow('#ffffff'), { parent: P.ch, cast: false });
        P.badge = K.billboard(160, 80, 86, (d, w, h, sp, sn) => {
          if (!sn) return;
          d.rrect(4, 4, w - 8, h - 8, 26, 'rgba(25,12,40,0.8)', sp === SP_FIRE ? '#ff8a2a' : '#c78bff', 4);
          d.text((sp === SP_FIRE ? '🔥' : '🏹') + '×' + sn, w / 2, h / 2 + 3, { size: 44, color: '#ffffff' });
        });
        P.lastBadge = '';
        P.stars = K.emoji('💫', 54);
        P.tremble = K.emoji('😰', 40);
        return P;
      });
      return o;
    },

    update(K, o, v, r) {
      const T = K.t;
      const n = v.p.length;
      for (const c of o.clouds) K.place(c.g, ((c.x + T * c.v + 3000) % 6000) - 2400, c.y, c.z);
      v.p.forEach((p, i) => { if (o.banners[i]) K.place(o.banners[i], p.x, WALK + 10 + 150, 142); });
      // Golden finale: warmer sunlight.
      if (K.sun && o.sunCol) K.sun.color.copy(o.sunCol).lerp(o.goldC, v.gd ? 0.45 + 0.1 * Math.sin(T * 4) : 0);
      // Wind sign.
      if (o.lastWind !== v.wd) { o.lastWind = v.wd; o.windSign.redraw(v.wd); }
      o.windSign.visible = !!v.wd;
      if (v.wd) K.place(o.windSign, W / 2 + Math.sin(T * 3) * 8, 34, 80);
      // NPCs.
      const anyHappy = v.p.some((p) => p.an === 5);
      o.jester.set(W + 70, WALK - 34, { r: 34, h: -60, look: Math.PI, anim: v.tg.some((t) => t.k === HAT) ? 'Cheer' : 'Idle', gear: false });
      o.king.set(-80, WALK - 36, { r: 36, h: -60, look: 0, anim: anyHappy ? 'Cheer' : 'Idle' });
      // Targets.
      const use = { c: 0, h: 0, b: 0, q: 0, d: 0, t: 0, f: 0, rb: 0 };
      for (const t of v.tg) {
        const k = Math.round(t.k);
        if (k === CROW && use.c < o.crows.length) setCrow(K, o, o.crows[use.c++], t, T, false);
        else if (k === HEN && use.h < o.hens.length) setCrow(K, o, o.hens[use.h++], t, T, true);
        else if (k === BAL && use.b < o.bals.length) setBalloon(K, o, o.bals[use.b++], t, T);
        else if (k === QUIVER && use.q < o.quivs.length) setBalloon(K, o, o.quivs[use.q++], t, T);
        else if (k === DRAGON && use.d < o.drags.length) setDragon(K, o, o.drags[use.d++], t, T);
        else if (k === HAT && use.t < o.hats.length) { const G = o.hats[use.t++]; G.visible = true; K.place(G, t.x, t.y, 0); K.face(G, Math.sin(T * 9 + t.id) * 0.5 + T * 2 * (t.f || 1)); }
        else if (k === FIRE && use.f < o.fires.length) {
          const F = o.fires[use.f++]; F.visible = true; K.place(F, t.x, t.y, 0);
          F.children[0].scale.setScalar(1 + 0.12 * Math.sin(T * 30 + t.id));
        }
        // Twin balloons: ribbon to the partner (drawn by the first of the pair).
        if (k === BAL && t.pr && t.id === t.pr && use.rb < o.ribbons.length) {
          const mate = v.tg.find((q) => q.pr === t.pr && q.id !== t.id);
          if (mate) {
            const R = o.ribbons[use.rb++];
            R.visible = true;
            const ax = t.x, ay = t.y + 60, bx = mate.x, by = mate.y + 60;
            K.place(R, (ax + bx) / 2, (ay + by) / 2 + 8, 12);
            K.face(R, Math.atan2(by - ay, bx - ax));
            R.scale.x = Math.hypot(bx - ax, by - ay);
          }
        }
      }
      for (let k = use.c; k < o.crows.length; k++) o.crows[k].g.visible = false;
      for (let k = use.h; k < o.hens.length; k++) o.hens[k].g.visible = false;
      for (let k = use.b; k < o.bals.length; k++) o.bals[k].g.visible = false;
      for (let k = use.q; k < o.quivs.length; k++) o.quivs[k].g.visible = false;
      for (let k = use.d; k < o.drags.length; k++) o.drags[k].g.visible = false;
      for (let k = use.t; k < o.hats.length; k++) o.hats[k].visible = false;
      for (let k = use.f; k < o.fires.length; k++) o.fires[k].visible = false;
      for (let k = use.rb; k < o.ribbons.length; k++) o.ribbons[k].visible = false;
      // Arrows.
      o.arrows.forEach((A, k) => {
        const a = v.ar[k];
        A.g.visible = !!a;
        if (!a) return;
        K.place(A.g, a.x, a.y, 4);
        K.face(A.g, a.a);
        const kk = Math.round(a.k), own = Math.round(a.o);
        A.fl.material = o.fletch[own] || o.fletch[0];
        A.head.material = kk === 2 ? o.mat.fireHead : o.mat.iron;
        A.trail.visible = kk >= 1;
        if (kk >= 1) A.trail.material = kk === 2 ? A.fireTrail : (A.trails[own] || A.trails[0]);
        A.flame.visible = kk === 2;
      });
      o.rocks.forEach((R, k) => { const e = v.rk[k]; R.visible = !!e; if (e) { K.place(R, e.x, e.y, 30); R.rotation.z = T * 12; } });
      o.booms.forEach((b, k) => {
        const e = v.bm[k];
        b[0].visible = b[1].visible = !!e;
        if (!e) return;
        const kk = clamp(e.t / 0.5, 0, 1);
        K.place(b[0], e.x, e.y, 10); b[0].scale.setScalar(FIRE_R * (0.4 + 0.6 * kk)); b[0].material.opacity = 0.8 * (1 - kk);
        K.place(b[1], e.x, e.y, 20); b[1].scale.setScalar(FIRE_R * (0.6 + 0.6 * kk)); b[1].material.opacity = 1 - kk;
      });
      // Archers.
      v.p.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const ay = WALK - AR;
        const aim = Math.atan2(p.cy - BOW_Y, p.cx - p.x);
        const an = Math.round(p.an);
        let anim = '2H_Ranged_Aiming', animKey, animSpeed;
        if (an === 2) { anim = '2H_Ranged_Shoot'; animKey = p.ak; animSpeed = 2.2; }
        else if (an === 3) { anim = 'Throw'; animKey = p.ak; animSpeed = 2.4; }
        else if (an === 4) { anim = 'Hit_A'; animKey = p.ak; }
        else if (an === 5) anim = 'Cheer';
        P.av.set(p.x, ay, { r: AR, look: aim, anim, animKey, animSpeed, gear: false, mood: an === 4 ? 'hurt' : 'ok' });
        // Bow in front of the chest, turned toward the crosshair; the string draws back with the charge.
        const stun = !!p.st;
        P.bow.g.visible = an !== 5 || p.c > 0;
        const bxp = p.x + Math.cos(aim) * AR * 0.45, byp = ay - AR * 0.25 + Math.sin(aim) * AR * 0.35;
        K.place(P.bow.g, bxp, byp, AR * 0.75);
        K.face(P.bow.g, stun ? aim + Math.sin(T * 14) * 0.6 : aim);
        setBowDraw(K, P.bow, p.c, !!p.rd || p.c > 0);
        // Aim line and crosshair.
        const ex = p.cx, ey = p.cy, L = Math.hypot(ex - bxp, ey - byp);
        P.aim.visible = !stun && L > 60;
        if (P.aim.visible) {
          K.place(P.aim, (bxp + ex) / 2, (byp + ey) / 2, 6);
          K.face(P.aim, Math.atan2(ey - byp, ex - bxp));
          P.aim.scale.x = L - 40;
        }
        const jx = stun ? Math.sin(T * 40) * 6 : p.hd ? Math.sin(T * 47 + i) * 4 : 0;
        K.place(P.ch, ex + jx, ey, 40);
        P.ch.rotation.z = stun ? T * 8 : 0;
        P.ticks.rotation.z = p.c > 0 ? T * 4 : 0;
        P.full.visible = p.c >= 0.97;
        P.fill.visible = p.c > 0.02;
        P.fill.scale.setScalar(Math.max(0.05, p.c));
        P.ch.scale.setScalar(p.rd ? 1 : 0.85);
        P.dot.visible = !!p.rd;
        // Special arrows badge.
        const key = `${p.sp}|${p.sn}`;
        if (key !== P.lastBadge) { P.lastBadge = key; P.badge.redraw(Math.round(p.sp), Math.round(p.sn)); }
        P.badge.visible = p.sn > 0;
        if (p.sn > 0) K.place(P.badge, p.x, ay - AR * 2.9, 30);
        P.stars.visible = stun;
        if (stun) K.place(P.stars, p.x + Math.sin(T * 8) * 14, ay - AR * 1.7, 50);
        P.tremble.visible = !!p.hd && !stun;
        if (p.hd) K.place(P.tremble, p.x + 34, ay - AR * 1.6, 50);
      });
    },
  },

  render(d, v, r) {
    const T = d.t;
    const ctx = d.ctx;
    const gr = ctx.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, v.gd ? '#f5b74a' : '#4a90d9');
    gr.addColorStop(0.7, v.gd ? '#ffe2a0' : '#bfe0ff');
    gr.addColorStop(1, '#e8f4ff');
    ctx.fillStyle = gr;
    ctx.fillRect(-400, -300, W + 800, H + 600);
    // Distant valley and hills.
    d.poly([-400, 560, 100, 470, 380, 520, 700, 450, 1000, 520, 1600, 480, 1600, 720, -400, 720], '#8fbf6a');
    d.poly([-400, 620, 300, 580, 800, 610, 1600, 570, 1600, 720, -400, 720], '#6fa552');
    // Wall.
    d.rect(-400, WALK - 30, W + 800, H, '#bfb19a', '#7a6a55', 3);
    for (let x = -360; x < W + 400; x += 120) d.rect(x, WALK - 62, 70, 34, '#cbbda5', '#7a6a55', 3);
    if (v.wd) d.text(v.wd > 0 ? 'VENTO →' : '← VENTO', W / 2, 40, { size: 40, color: '#ffffff' });
    // Targets.
    for (const t of v.tg) {
      const k = Math.round(t.k);
      if (k === CROW) { d.circle(t.x, t.y, 30, t.g ? '#ffcf3f' : '#2a2633', '#000', 3); d.circle(t.x + (t.f || 1) * 22, t.y - 10, 7, '#ff9b2a'); }
      else if (k === HEN) { d.circle(t.x, t.y, 26, t.g ? '#ffcf3f' : '#ffffff', '#000', 3); d.circle(t.x + (t.f || 1) * 14, t.y - 20, 7, '#e8342c'); }
      else if (k === BAL || k === QUIVER) {
        d.line(t.x, t.y + 36, t.x, t.y + 90, '#ffffff', 2);
        d.circle(t.x, t.y, 36, k === QUIVER ? '#9b59ff' : t.g ? '#ffcf3f' : BAL_COLS[t.c || 0], '#000', 3);
        if (k === QUIVER) d.text('🏹', t.x, t.y + 2, { size: 34 });
      } else if (k === DRAGON) {
        d.circle(t.x, t.y, t.bs ? 80 : 60, t.fl ? '#ffffff' : t.bs ? '#c0392b' : '#4fbf55', '#000', 4);
        d.text('🐉', t.x, t.y, { size: t.bs ? 90 : 70 });
        d.rect(t.x - 60, t.y - 95, 120, 12, '#1a1028');
        d.rect(t.x - 60, t.y - 95, (120 * t.hp) / Math.max(1, t.hm), 12, '#ff5a3c');
      } else if (k === HAT) d.text('🎭', t.x, t.y, { size: 60 });
      else if (k === FIRE) d.circle(t.x, t.y, 24 + Math.sin(T * 30) * 3, '#ff8a2a', '#ffd23f', 4);
    }
    for (const a of v.ar) {
      const c = Math.cos(a.a), s2 = Math.sin(a.a);
      d.line(a.x - c * 36, a.y - s2 * 36, a.x + c * 30, a.y + s2 * 30, a.k === 2 ? '#ff8a2a' : '#5a3a20', 5);
      d.circle(a.x - c * 32, a.y - s2 * 32, 7, d.col(Math.round(a.o)));
    }
    for (const k of v.rk) d.circle(k.x, k.y, 10, '#9b948a', '#000', 2);
    for (const b of v.bm) d.circle(b.x, b.y, FIRE_R * (0.4 + b.t), 'rgba(255,150,40,' + r2(Math.max(0, 0.7 - b.t)) + ')');
    // Archers + crosshairs.
    v.p.forEach((p, i) => {
      const aim = Math.atan2(p.cy - BOW_Y, p.cx - p.x);
      d.avatar(p.x, WALK - AR, AR, i, { look: aim, mood: p.st ? 'dizzy' : p.an === 5 ? 'happy' : p.c > 0 ? 'angry' : 'ok' });
      d.line(p.x, BOW_Y, p.cx, p.cy, d.col(i) + '40', 3);
      d.ring(p.cx, p.cy, 30, d.col(i), 5);
      if (p.c > 0) d.circle(p.cx, p.cy, 28 * p.c, d.col(i, 'light') + '80');
      if (p.c >= 0.97) d.ring(p.cx, p.cy, 40, '#ffd23f', 4);
      if (p.sn > 0) d.text((p.sp === SP_FIRE ? '🔥' : '🏹') + p.sn, p.x, WALK - AR * 3, { size: 34 });
      if (p.st) d.text('💫', p.x, WALK - AR * 2.4, { size: 40 });
    });
  },
};

// ---------- 3D helpers ----------

// One InstancedMesh of boxes (merlons): items [x, y, depth] in world coords.
function instBoxes(K, items, w, h, dz, mat) {
  const T3 = K.THREE;
  const geo = new T3.BoxGeometry(w, h, dz);
  const im = new T3.InstancedMesh(geo, mat, Math.max(1, items.length));
  const m = new T3.Matrix4();
  items.forEach(([x, y, z], k) => { m.makeTranslation(x, -y, z); im.setMatrixAt(k, m); });
  im.count = items.length;
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = true; im.receiveShadow = true;
  im.userData.ownGeo = true;
  K.root.add(im);
  return im;
}

function softCloud(K, g) {
  const m = K.mat('#ffffff', { rough: 1, emissive: '#f4f8ff', ei: 0.5 });
  g.traverse((x) => { if (x.isMesh) x.material = m; });
  return g;
}

// Crow (or hen): body, head, beak, eye, two flapping wings, tail. Local +X = forward.
function makeCrow(K, o, hen) {
  const M = o.mat, r = hen ? TR[HEN] : TR[CROW];
  const g = K.group();
  const body = K.ball(1, hen ? M.white : M.crow, { parent: g });
  body.scale.set(r * 0.95, r * 0.66, r * 0.62);
  const head = K.ball(1, hen ? M.white : M.crow, { parent: g });
  head.scale.setScalar(r * (hen ? 0.5 : 0.42));
  K.place(head, r * 0.72, -r * (hen ? 0.55 : 0.3), 0);
  const beak = K.prism([0, -5, 20, 0, 0, 5], 8, M.beak, { parent: g });
  K.place(beak, r * (hen ? 1.12 : 1.05), -r * (hen ? 0.52 : 0.28), -4);
  const eye = K.ball(1, M.eye, { parent: g, cast: false });
  eye.scale.setScalar(r * 0.13);
  K.place(eye, r * 0.92, -r * (hen ? 0.68 : 0.42), r * 0.3);
  const pupil = K.ball(1, M.pupil, { parent: g, cast: false });
  pupil.scale.setScalar(r * 0.07);
  K.place(pupil, r * 0.98, -r * (hen ? 0.68 : 0.42), r * 0.4);
  const wingPts = [0, 0, -r * 0.45, -r * 1.15, -r * 1.15, -r * 0.75, -r * 0.8, 0];
  const w1 = K.prism(wingPts, 4, hen ? M.white : M.crow, { parent: g });
  const w2 = K.prism(wingPts, 4, hen ? M.white : M.crow, { parent: g });
  K.place(w1, r * 0.15, -r * 0.25, r * 0.35); K.place(w2, r * 0.15, -r * 0.25, -r * 0.4);
  let comb = null;
  if (hen) {
    comb = K.prism([-8, 0, -4, -14, 2, -6, 7, -15, 11, 0], 6, M.comb, { parent: g });
    K.place(comb, r * 0.7, -r * 0.95, -3);
  } else {
    const tail = K.prism([0, 0, -r * 0.7, -r * 0.3, -r * 0.75, r * 0.25], 6, M.crow, { parent: g });
    K.place(tail, -r * 0.7, 0, -3);
  }
  g.visible = false;
  return { g, body, head, w1, w2, hen };
}

function setCrow(K, o, C, t, T, hen) {
  const M = o.mat;
  C.g.visible = true;
  K.place(C.g, t.x, t.y, 0);
  C.g.scale.x = (t.f || 1) >= 0 ? 1 : -1;
  const flap = Math.sin(T * (hen ? 22 : 14) + t.id) * 0.95;
  C.w1.rotation.x = flap; C.w2.rotation.x = -flap;
  C.g.rotation.z = hen ? Math.sin(T * 5 + t.id) * 0.5 : Math.sin(T * 3 + t.id) * 0.1;
  const m = t.g ? M.gold : hen ? M.white : M.crow;
  C.body.material = C.head.material = C.w1.material = C.w2.material = m;
}

// Balloon with a shine, a knot and a long string. Unit-sized parts scaled to the balloon radius.
function makeBalloon(K, o) {
  const M = o.mat, r = TR[BAL];
  const g = K.group();
  const ball = K.ball(1, M.bal[0], { parent: g });
  ball.scale.set(r * 0.92, r * 1.08, r * 0.92);
  const sh = K.ball(1, M.shine, { parent: g, cast: false });
  sh.scale.set(r * 0.2, r * 0.3, r * 0.1);
  K.place(sh, -r * 0.35, -r * 0.45, r * 0.8);
  const knot = K.prism([-6, 0, 6, 0, 0, -9], 6, M.bal[0], { parent: g });
  K.place(knot, 0, r * 1.08 + 7, -3);
  const str = K.box(2, 70, 2, M.string, { parent: g, cast: false });
  K.place(str, 0, r * 1.08 + 42, 0);
  g.visible = false;
  return { g, ball, knot, str };
}

function makeQuiverBalloon(K, o) {
  const B = makeBalloon(K, o);
  B.ball.material = B.knot.material = o.mat.quiv;
  const q = K.model('weapons/quiver', { height: 58, parent: B.g });
  K.place(q, 0, TR[QUIVER] * 1.08 + 77 + 58, 0);
  const glow = K.ball(1, K.glow('#d9b3ff', { opacity: 0.25, add: true }), { parent: B.g, cast: false });
  glow.scale.setScalar(TR[QUIVER] * 1.5);
  B.glow = glow;
  B.quiver = true;
  return B;
}

function setBalloon(K, o, Bl, t, T) {
  Bl.g.visible = true;
  K.place(Bl.g, t.x, t.y, 0);
  Bl.g.rotation.z = Math.sin(T * 1.7 + t.id) * 0.12;
  if (!Bl.quiver) Bl.ball.material = Bl.knot.material = t.g ? o.mat.gold : o.mat.bal[Math.round(t.c || 0) % BAL_COLS.length];
  else Bl.glow.scale.setScalar(TR[QUIVER] * (1.4 + 0.15 * Math.sin(T * 6)));
}

// Little dragon: body, belly, head + snout, horns, eye, two big membrane wings, a tail of three bulbs, HP bar.
function makeDragon(K, o) {
  const M = o.mat, r = 60;
  const g = K.group();
  const body = K.ball(1, M.drag, { parent: g }); body.scale.set(r, r * 0.6, r * 0.58);
  const belly = K.ball(1, M.belly, { parent: g }); belly.scale.set(r * 0.7, r * 0.42, r * 0.45); K.place(belly, r * 0.1, r * 0.15, r * 0.22);
  const head = K.ball(1, M.drag, { parent: g }); head.scale.setScalar(r * 0.44); K.place(head, r * 0.95, -r * 0.42, 0);
  const snout = K.box(r * 0.55, r * 0.3, r * 0.4, M.drag, { parent: g }); K.place(snout, r * 1.35, -r * 0.34, 0);
  const eye = K.ball(1, M.eye, { parent: g, cast: false }); eye.scale.setScalar(r * 0.12); K.place(eye, r * 1.08, -r * 0.55, r * 0.32);
  const pupil = K.ball(1, M.pupil, { parent: g, cast: false }); pupil.scale.setScalar(r * 0.06); K.place(pupil, r * 1.13, -r * 0.55, r * 0.42);
  const horn = K.prism([0, 0, 10, 0, -10, -24], 6, M.horn, { parent: g }); K.place(horn, r * 0.88, -r * 0.8, -3);
  const wingPts = [0, 0, -r * 0.3, -r * 1.4, r * 0.45, -r * 1.05, r * 0.85, -r * 0.25];
  const w1 = K.prism(wingPts, 4, M.wing, { parent: g }); K.place(w1, -r * 0.1, -r * 0.3, r * 0.3);
  const w2 = K.prism(wingPts, 4, M.wing, { parent: g }); K.place(w2, -r * 0.1, -r * 0.3, -r * 0.35);
  const tail = [[-r * 0.95, r * 0.08, 0.36], [-r * 1.35, r * 0.22, 0.27], [-r * 1.68, r * 0.3, 0.19]].map(([x, y, s]) => {
    const b = K.ball(1, M.drag, { parent: g }); b.scale.setScalar(r * s); K.place(b, x, y, 0); return b;
  });
  const spike = K.prism([0, -10, 0, 10, -22, 0], 6, M.horn, { parent: g }); K.place(spike, -r * 1.82, r * 0.3, -3);
  const flash = K.ball(1, M.flash, { parent: g, cast: false }); flash.scale.set(r * 1.1, r * 0.7, r * 0.7);
  const bar = K.group();
  const bg = K.box(130, 14, 2, M.barBg, { parent: bar, cast: false });
  const fg = K.box(1, 10, 2, M.barFg, { parent: bar, cast: false });
  K.place(fg, 0, 0, 3);
  g.visible = false; bar.visible = false;
  return { g, body, head, snout, w1, w2, tail, flash, bar, bg, fg };
}

function setDragon(K, o, D, t, T) {
  const M = o.mat, boss = !!t.bs;
  D.g.visible = true; D.bar.visible = true;
  const sc = boss ? 1.45 : 1;
  K.place(D.g, t.x, t.y, 0);
  D.g.scale.set(((t.f || 1) >= 0 ? 1 : -1) * sc, sc, sc);
  const flap = Math.sin(T * 7 + t.id) * 0.9;
  D.w1.rotation.x = flap; D.w2.rotation.x = -flap;
  D.g.rotation.z = Math.sin(T * 2.2 + t.id) * 0.08;
  const skin = boss ? M.dragB : M.drag;
  D.body.material = D.head.material = D.snout.material = skin;
  for (const b of D.tail) b.material = skin;
  D.w1.material = D.w2.material = boss ? M.wingB : M.wing;
  D.flash.visible = !!t.fl;
  const w = boss ? 200 : 130;
  K.place(D.bar, t.x, t.y - 62 * sc - 26, 20);
  D.bar.scale.x = w / 130;
  const k = clamp(t.hp / Math.max(1, t.hm), 0, 1);
  D.fg.scale.x = Math.max(0.01, 124 * k);
  K.place(D.fg, -62 * (1 - k), 0, 3);
}

// Jester's three-pointed hat with golden bells (spins as it flies).
function makeHat(K, o) {
  const M = o.mat, r = TR[HAT];
  const g = K.group();
  K.place(K.box(r * 1.7, r * 0.5, r * 0.8, M.hatBand, { parent: g }), 0, r * 0.35, 0);
  const tips = [[[-r * 0.85, 0, -r * 0.15, 0, -r * 1.35, -r * 1.25], -r * 1.35, -r * 1.25], [[-r * 0.32, 0, r * 0.32, 0, 0, -r * 1.6], 0, -r * 1.6], [[r * 0.15, 0, r * 0.85, 0, r * 1.35, -r * 1.25], r * 1.35, -r * 1.25]];
  tips.forEach(([pts, bx, by], k) => {
    const c = K.prism(pts, r * 0.6, M.hatC[k], { parent: g });
    K.place(c, 0, r * 0.1, -r * 0.3);
    const bell = K.ball(r * 0.22, M.bell, { parent: g });
    K.place(bell, bx, by + r * 0.1, 0);
  });
  g.visible = false;
  return g;
}

function makeFireball(K) {
  const g = K.group();
  const core = K.ball(1, K.glow('#ffe27a', { add: true }), { parent: g, cast: false }); core.scale.setScalar(16);
  const mid = K.ball(1, K.glow('#ff8a2a', { opacity: 0.8, add: true }), { parent: g, cast: false }); mid.scale.setScalar(26);
  const halo = K.ball(1, K.glow('#ff4a1a', { opacity: 0.25, add: true }), { parent: g, cast: false }); halo.scale.setScalar(44);
  g.visible = false;
  return g;
}

// Arrow along local +X: wooden shaft, iron head, colored fletching, optional glow trail and flame.
function makeArrow(K, o) {
  const M = o.mat;
  const g = K.group();
  const shaft = K.prism([-36, -2.2, 24, -2.2, 24, 2.2, -36, 2.2], 4, M.wood, { parent: g, cast: false });
  K.place(shaft, 0, 0, -2);
  const head = K.prism([22, -7, 38, 0, 22, 7], 5, M.iron, { parent: g, cast: false });
  K.place(head, 0, 0, -2.5);
  const fl = K.prism([-38, -9, -22, -2, -22, 2, -38, 9, -32, 0], 3, o.fletch[0], { parent: g, cast: false });
  K.place(fl, 0, 0, -1.5);
  const trails = (o.fletch || []).map((_, i) => K.glow(K.col(i, 'light'), { opacity: 0.55, add: true }));
  const fireTrail = K.glow('#ff8a2a', { opacity: 0.7, add: true });
  const trail = K.box(70, 8, 2, trails[0] || fireTrail, { parent: g, cast: false });
  K.place(trail, -70, 0, 0);
  const flame = K.ball(1, K.glow('#ffb02e', { opacity: 0.85, add: true }), { parent: g, cast: false });
  flame.scale.set(14, 9, 9);
  K.place(flame, 34, 0, 0);
  g.visible = false;
  return { g, fl, head, trail, trails, fireTrail, flame };
}

// Bow: a wooden arc facing local +X, a string in two halves that draws back, a nocked arrow.
function makeBow(K, o, i) {
  const g = K.group();
  const R = 36;
  const arc = K.torus(R, 3.4, o.mat.wood, { arc: Math.PI * 0.8, a0: -Math.PI * 0.4, parent: g });
  K.place(arc, -R * 0.55, 0, 0);
  const sMat = K.glow('#f6f0e0');
  const s1 = K.box(1, 1.4, 1.4, sMat, { parent: g, cast: false });
  const s2 = K.box(1, 1.4, 1.4, sMat, { parent: g, cast: false });
  const arrow = K.group(g);
  K.place(K.prism([-30, -1.8, 20, -1.8, 20, 1.8, -30, 1.8], 3, o.mat.wood, { parent: arrow, cast: false }), 0, 0, -1.5);
  K.place(K.prism([18, -6, 32, 0, 18, 6], 4, o.mat.iron, { parent: arrow, cast: false }), 0, 0, -2);
  K.place(K.prism([-32, -7, -20, -1.5, -20, 1.5, -32, 7], 3, o.fletch[i] || o.fletch[0], { parent: arrow, cast: false }), 0, 0, -1.5);
  // String end points (arc tips) in the bow's local frame.
  const tip = { x: -R * 0.55 + R * Math.cos(Math.PI * 0.4), y: R * Math.sin(Math.PI * 0.4) };
  return { g, s1, s2, arrow, tip };
}

function setBowDraw(K, Bw, c, loaded) {
  const nx = Bw.tip.x - 4 - c * 22; // nock point moves back with the charge
  for (const [m, sy] of [[Bw.s1, -1], [Bw.s2, 1]]) {
    const ax = Bw.tip.x, ay = sy * Bw.tip.y;
    K.place(m, (ax + nx) / 2, ay / 2, 0);
    K.face(m, Math.atan2(-ay, nx - ax));
    m.scale.x = Math.hypot(ax - nx, ay);
  }
  Bw.arrow.visible = loaded;
  K.place(Bw.arrow, nx + 30, 0, 0);
  Bw.g.scale.y = 1 + c * 0.08;
}
