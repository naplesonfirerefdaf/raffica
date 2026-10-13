// La Quintana — tournament against the spinning Saracen (top-down, 2–4 riders, optional 2 vs 2 teams).
// Every rider has a radial lane toward the dummy in the middle: A = charge, the stick slides the lance left/right,
// B = pull back before the mace line. Hit the shield (center = more points), miss it and the mace sends you flying.
import { clamp, damp, wrapAngle, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500;
const DUR = 45, FINALE = 10;
const R_START = 440, R_STRIKE = 150, R_DANGER = 225, R_ABORT = 235;
const SH_D = 58, SH_R = 33, CENTER = 9, GOOD = 20;      // shield distance from the axis, radius, score bands
const AIM_MAX = 42, AIM_RATE = 170;                      // lateral lance offset (world units) and its speed
const V0 = 160, ACC = 700, VMAX = 520, V_BACK = 430;     // charge kinematics
const DOWN_T = 1.5, MACE_W = 0.28, MACE_R = 140;
const FACE_COS = Math.cos(1.25);                          // the shield must face the lane (±72°)
const RING_TOL = 15, RING_LIFE = 5;
const SPIN_K = 3.2, KEEP = 0.3;                          // spin added by an off-axis hit, kept fraction of extra spin / s
const PTS = [0, 5, 3, 1];                                 // by result code: 1 center, 2 good, 3 edge
const RES_TXT = ['', 'CENTRO!', 'BUONO!', 'DI STRISCIO', 'MAZZATA!'];
const TEAM_COL = ['#ff4b5c', '#3fa9ff'];
const FLAG = ['red', 'blue', 'green', 'yellow'];
const COATS = ['#7a4a26', '#efe9dc', '#3a2a22', '#a8642e'];

// Charge time from the gate to the strike line (fixed kinematics), used by the bots.
const T_CHARGE = (() => {
  let r = R_START, v = V0, t = 0;
  const dt = 1 / 60;
  while (r > R_STRIKE && t < 3) { v = Math.min(VMAX, v + ACC * dt); r -= v * dt; t += dt; }
  return t;
})();

// Lane angle (direction from the center toward the rider's gate) per seat.
function laneAngles(n, teams) {
  if (teams) {
    const slots = [[Math.PI / 2, Math.PI], [-Math.PI / 2, 0]]; // team 0 bottom + left, team 1 top + right
    const used = [0, 0];
    return teams.map((t) => slots[t][used[t]++ % 2]);
  }
  if (n === 3) return [Math.PI / 2, -Math.PI / 6, (7 * Math.PI) / 6];
  if (n >= 4) return [Math.PI / 2, -Math.PI / 2, Math.PI, 0];
  return [Math.PI / 2, -Math.PI / 2];
}

const lanePos = (a, r, o) => ({ x: CX + Math.cos(a) * r + Math.sin(a) * o, y: CY + Math.sin(a) * r - Math.cos(a) * o });
const baseSpin = (t, variant) => (1.0 + 0.9 * clamp(t / DUR, 0, 1)) * (variant === 'turbine' ? 1.55 : 1);
const shieldAngles = (th, variant) => (variant === 'doppio' ? [th, th + Math.PI] : [th]);
const maceAngles = (th, variant) => (variant === 'doppio' ? [th + Math.PI / 2, th - Math.PI / 2] : [th + Math.PI]);
const ringRadii = (variant) => (variant === 'anelli' ? [335, 270] : [300]);

function teamScore(s, t) {
  let v = 0;
  for (const p of s.p) if (s.tm[p.i] === t) v += p.pn;
  return v;
}

// Best shield for a rider at lane angle a with lance offset o: { miss, ok } (ok = facing the lane).
function shieldMiss(a, o, th, variant) {
  let best = null;
  for (const sa of shieldAngles(th, variant)) {
    if (Math.cos(sa - a) < FACE_COS) continue;
    const miss = SH_D * Math.sin(a - sa) - o;
    if (!best || Math.abs(miss) < Math.abs(best)) best = miss;
  }
  return best;
}

function addPoints(s, p, n, g, label, color) {
  if (g.ended) return;
  const k = s.fin ? 2 : 1;
  p.pn += n * k;
  const q = lanePos(p.a, p.r, p.o);
  g.text(q.x, q.y - 70, `${label} +${n * k}`, { player: color === undefined ? p.i : undefined, color, size: n * k >= 5 ? 58 : 44 });
}

function whack(s, p, g, credit) {
  const q = lanePos(p.a, p.r, p.o);
  p.st = 3; p.t = DOWN_T; p.fx = q.x; p.fy = q.y; p.fr = p.r; p.falls++;
  p.pn = Math.max(0, p.pn - 1);
  p.rs = 4; p.rt = 1.3; p.k++;
  g.sfx('bang'); g.sfx('fall', { pitch: 0.9 }); g.sfx('boing', { pitch: 0.6 });
  g.text(q.x, q.y - 80, 'MAZZATA!', { color: '#ff5a3a', size: 60 });
  g.burst(q.x, q.y, { color: '#d8b07a', n: 26, speed: 380, size: 9 });
  g.burst(q.x, q.y, { player: p.i, n: 10, speed: 260 });
  g.shake(0.5); g.hitstop(0.1); g.vibrate(p.i, 220);
  s.cheer = 1.2;
  if (credit !== null && credit !== undefined && credit !== p.i && !g.ally(credit, p.i)) {
    const c = s.p[credit];
    if (c) addPoints(s, c, 1, g, 'MAZZATA SERVITA!');
  }
}

function strike(s, p, g) {
  if (g.ended || s.over) { p.st = 2; p.v = V_BACK; return; } // the trumpet already sounded: no more scoring
  const miss = shieldMiss(p.a, p.o, s.th, g.variant);
  const q = lanePos(p.a, R_STRIKE, p.o);
  if (miss === null || Math.abs(miss) >= SH_R) {
    // Lance into the arm: the dummy swings round and the mace finds the rider.
    for (const ma of maceAngles(s.th, g.variant)) {
      const d = wrapAngle(p.a - ma);
      s.w += Math.sign(d || 1) * 3.6;
      break;
    }
    s.hitBy = p.i; s.hitT = g.t; s.hitSpin = 0;
    s.hk++;
    whack(s, p, g, null);
    return;
  }
  const code = Math.abs(miss) < CENTER ? 1 : Math.abs(miss) < GOOD ? 2 : 3;
  p.rs = code; p.rt = 1.2; p.k++;
  if (code === 1) p.cen++;
  addPoints(s, p, PTS[code], g, RES_TXT[code]);
  // An off-axis blow spins the Saracen (a clean center barely moves it).
  const dw = -(p.o / AIM_MAX) * SPIN_K * (code === 1 ? 0.35 : 1) + 0.25 * Math.sign(s.w || 1);
  s.w += dw;
  s.hitBy = p.i; s.hitT = g.t; s.hitSpin = Math.abs(dw);
  if (Math.sign(s.w) !== s.dir && Math.abs(s.w) > 1) s.dir = Math.sign(s.w);
  s.hk++;
  g.sfx(code === 1 ? 'bang' : 'hit', { pitch: code === 1 ? 1.1 : 1 });
  g.sfx(code === 1 ? 'tada' : 'point', { vol: 0.7 });
  g.burst(q.x - Math.cos(p.a) * 70, q.y - Math.sin(p.a) * 70, { color: code === 1 ? '#ffd34d' : '#fff', n: code === 1 ? 30 : 14, speed: code === 1 ? 460 : 280 });
  g.burst(q.x - Math.cos(p.a) * 60, q.y - Math.sin(p.a) * 60, { color: '#c9a06a', n: 8, speed: 220, size: 7 }); // lance splinters
  if (code === 1) { g.ring(CX, CY, { color: '#ffd34d', r: 120 }); g.shake(0.35); g.hitstop(0.08); s.cheer = 1.6; }
  else g.shake(0.15);
  g.vibrate(p.i, code === 1 ? 90 : 40);
  p.st = 2; p.v = V_BACK;
}

// ---------------------------------------------------------------- computer player
const BOT_DELAY = [0.34, 0.2, 0.09];
const BOT_TOL = [40, 38, 38];       // how far off-axis a shield may be at the strike for the bot to launch
const BOT_HAND = [14, 4, 2];        // hand shake of the lance (world units)

// Predicted dummy angle after T seconds (lv 0: constant spin; lv 1: spin relaxing to the base; lv 2: + reversals).
function predictTheta(s, T, g, lv) {
  if (lv === 0) return s.th + s.w * T;
  let th = s.th, w = s.w, dir = s.dir, t = s.t;
  const steps = Math.max(2, Math.ceil(T / 0.04)), dt = T / steps;
  for (let k = 0; k < steps; k++) {
    if (lv === 2 && s.revAt > 0 && t >= s.revAt && t - dt < s.revAt) dir = -dir;
    const target = dir * baseSpin(t, g.variant);
    w = target + (w - target) * Math.pow(KEEP, dt);
    th += w * dt; t += dt;
  }
  return th;
}

// Seconds until a charging rider at radius r with speed v reaches the strike line.
function timeToStrike(r, v) {
  const d = Math.max(0, r - R_STRIKE);
  v = Math.max(v, V0);
  if (v >= VMAX) return d / VMAX;
  const t1 = (VMAX - v) / ACC, d1 = v * t1 + 0.5 * ACC * t1 * t1;
  if (d1 >= d) return (-v + Math.sqrt(v * v + 2 * ACC * d)) / ACC;
  return t1 + (d - d1) / VMAX;
}

// Lance offset that puts the lance on the center of a shield facing the lane at time T (null = no shield there).
function neededAim(p, th, variant) {
  let best = null;
  for (const sa of shieldAngles(th, variant)) {
    if (Math.cos(sa - p.a) < FACE_COS + 0.1) continue;
    const o = SH_D * Math.sin(p.a - sa);
    if (best === null || Math.abs(o) < Math.abs(best)) best = o;
  }
  return best;
}

function quintanaBot(s, me, g, B) {
  const p = s.p[me];
  if (!p || p.st === 3 || s.over) return { x: 0, y: 0 };
  const lv = B.level, m = B.mem, D = BOT_DELAY[lv];
  const Lx = Math.sin(p.a), Ly = -Math.cos(p.a);
  const aimTo = (o) => { const k = clamp(o / AIM_MAX, -1, 1); return { x: Lx * k, y: Ly * k }; };
  if (m.charge !== p.n) { m.charge = p.n; m.hand = (B.rng() - 0.5) * 2 * BOT_HAND[lv]; }
  if (p.st === 2) return aimTo(0);
  if (p.st === 0) {
    // A short breath after each run (the squire dawdles).
    if (m.readyN !== p.n) { m.readyN = p.n; m.wait = g.t + (lv === 0 ? 0.25 + B.rng() * 0.8 : lv === 1 ? B.rng() * 0.3 : 0); }
    const T = D + T_CHARGE;
    const th = predictTheta(s, T, g, lv);
    const need = neededAim(p, th, g.variant);
    if (g.t < (m.wait || 0)) return aimTo(need ?? 0);
    // The best riders also aim for a ring hanging over their lane.
    let ringO = null;
    if (lv > 0) for (const rg of s.rings) if (rg.l === me && rg.life > T_CHARGE * 0.6) ringO = rg.o;
    // Teams: do not charge right behind a teammate who is about to strike (their hit moves the shield).
    let mateBusy = false;
    if (lv > 0 && g.teams) for (const q of s.p) if (q !== p && g.ally(q.i, me) && q.st === 1 && q.r < 330) mateBusy = true;
    const ok = need !== null && Math.abs(need) < BOT_TOL[lv] && !mateBusy && (lv === 0 || Math.abs(s.w) < 4.5);
    const pre = ringO !== null ? ringO : need ?? 0;
    return { ...aimTo(pre), tapA: ok };
  }
  // Charging: lv 0 keeps the aim chosen at launch; better riders re-aim (and abort a doomed run).
  const rem = timeToStrike(p.r, p.v);
  if (lv === 0) {
    if (m.fixed === undefined || m.fixedN !== p.n) { m.fixedN = p.n; m.fixed = neededAim(p, predictTheta(s, rem, g, 0), g.variant) ?? 0; }
    return aimTo(m.fixed + m.hand);
  }
  const th = predictTheta(s, rem, g, lv);
  const need = neededAim(p, th, g.variant);
  if ((need === null || Math.abs(need) > AIM_MAX + 4) && p.r > R_ABORT + 15 + p.v * D) return { ...aimTo(0), b: true };
  for (const rg of s.rings) {
    if (rg.l !== me || p.r <= rg.r + 5) continue;
    // Ring first if there is still time to slide back onto the shield after it.
    const after = (rg.r - R_STRIKE) / Math.max(300, p.v);
    if (need === null || Math.abs((need ?? 0) - rg.o) < AIM_RATE * after * 0.8) return aimTo(rg.o);
  }
  return aimTo((need ?? 0) + m.hand);
}

// ---------------------------------------------------------------- game
export default {
  id: 'giostra',
  name: 'La Quintana',
  rule: 'Carica il Saracino e colpisci lo scudo, non la mazza!',
  verb: 'IN LIZZA!',
  inspired: 'Giostra della Quintana · Wii Sports',
  cam: 'top',
  split: false,
  players: 4,
  teams: true,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Carica', b: 'Frena' },
  duration: DUR,
  variants: [
    { id: 'turbine', name: 'Saracino Indemoniato', desc: 'Gira come una trottola e cambia verso a tradimento!' },
    { id: 'doppio', name: 'Saracino Bifronte', desc: 'Due scudi davanti e dietro… e due mazze ai lati!' },
    { id: 'anelli', name: 'Pioggia di Anelli', desc: 'Anelli d’oro ovunque sulla corsia: infilali tutti!' },
  ],
  help: {
    goal: 'Fai più punti di tutti in 45 s colpendo lo scudo del Saracino: centro 5, buono 3, di striscio 1. Gli ultimi 10 s valgono doppio!',
    dir: 'Sposta la lancia a destra/sinistra nella tua corsia per centrare lo scudo (e infilare gli anelli d’oro)',
    a: 'CARICA: il cavallo parte al galoppo verso il Saracino e colpisce da solo quando arriva. Parti quando lo scudo ti guarda!',
    b: 'FRENA: torni indietro prima della linea rossa se capisci che lo scudo non sarà lì',
    tips: ['Lo spicchio dorato a terra indica dove guarda lo scudo, quello rosso la mazza', 'Colpi storti fanno girare il Saracino: la mazza può stendere chi sta caricando (+1 a te!)', 'A squadre i punti si sommano e la mazza del compagno non vi tocca'],
  },

  init(g) {
    const n = g.n || 2;
    const tm = g.teams ? g.teams.slice(0, n) : [...Array(n).keys()];
    const ang = laneAngles(n, g.teams);
    return {
      t: 0, th: -Math.PI / 2 + 0.6, w: 1, dir: 1, revAt: 7 + g.rng.range(0, 3), fin: false, over: false,
      hitBy: -1, hitT: -9, hitSpin: 0, hk: 0, cheer: 0,
      rings: [], ringAt: 3.5, tm,
      p: [...Array(n).keys()].map((i) => ({
        i, a: ang[i], r: R_START, o: 0, st: 0, v: 0, t: 0, n: 0, k: 0, rs: 0, rt: 0, pn: 0, cen: 0, rg: 0, falls: 0,
        fx: 0, fy: 0, fr: 0, duck: 0,
      })),
    };
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.t = g.t;
    s.cheer = Math.max(0, s.cheer - dt);
    if (!s.fin && g.t >= DUR - FINALE) { s.fin = true; g.say('GRAN FINALE: PUNTI DOPPI!'); g.sfx('fanfare', { vol: 0.8 }); }
    // The Saracen spins; its speed relaxes toward the base (which grows over time). Sometimes it turns the other way.
    if (s.revAt > 0 && g.t >= s.revAt) {
      s.dir = -s.dir;
      s.revAt = g.t + (g.variant === 'turbine' ? g.rng.range(2.5, 4.5) : g.rng.range(7, 11));
      g.sfx('wobble', { pitch: 0.8 }); g.text(CX, CY - 150, 'GIRA!', { color: '#ffd34d', size: 46 });
    }
    const target = s.dir * baseSpin(g.t, g.variant);
    s.w = target + (s.w - target) * damp(KEEP, dt);
    s.th += s.w * dt;

    // Gold rings over the lanes (every lane gets the same one: fair).
    for (const rg of s.rings) {
      rg.life -= dt;
      if (g.variant === 'anelli') rg.o = clamp(rg.o0 + Math.sin(g.t * 1.6 + rg.ph) * 18, -AIM_MAX + 6, AIM_MAX - 6);
    }
    s.rings = s.rings.filter((rg) => rg.life > 0);
    if (g.t >= s.ringAt && !g.ended) {
      s.ringAt = g.t + (g.variant === 'anelli' ? 3 : 6.5);
      const radii = ringRadii(g.variant);
      radii.forEach((rr, k) => {
        const o0 = g.rng.range(-30, 30), ph = g.rng.range(0, TAU);
        for (const p of s.p) s.rings.push({ l: p.i, r: rr, o: o0, o0, ph: ph + k, life: RING_LIFE + k * 0.5 });
      });
      g.sfx('coin', { vol: 0.5, pitch: 1.3 });
    }

    for (const p of s.p) {
      const i = inp[p.i];
      p.rt = Math.max(0, p.rt - dt);
      p.duck = Math.max(0, p.duck - dt);
      if (p.st === 3) {
        p.t -= dt;
        if (p.t <= 0) { p.st = 0; p.r = R_START; p.o = 0; p.v = 0; g.sfx('boing', { vol: 0.5 }); }
        continue;
      }
      // Lance aim: the stick (projected on the lane's crosswise axis) sets the wanted offset.
      if (!s.over) {
        const Lx = Math.sin(p.a), Ly = -Math.cos(p.a);
        const want = clamp(i.x * Lx + i.y * Ly, -1, 1) * AIM_MAX;
        p.o += clamp(want - p.o, -AIM_RATE * dt, AIM_RATE * dt);
      }
      if (p.st === 0) {
        if (i.aP && !s.over) {
          p.st = 1; p.v = V0; p.n++;
          g.sfx('dash'); g.sfx('horn', { vol: 0.35, pitch: 1.4 });
          const q = lanePos(p.a, p.r, p.o);
          g.burst(q.x, q.y, { color: '#d8b07a', n: 10, speed: 160, size: 8 });
        }
      } else if (p.st === 1) {
        const prev = p.r;
        p.v = Math.min(VMAX, p.v + ACC * dt);
        p.r -= p.v * dt;
        if (i.bP && p.r > R_ABORT) {
          p.st = 2; p.v = V_BACK * 0.8;
          const q = lanePos(p.a, p.r, p.o);
          g.sfx('whoosh'); g.text(q.x, q.y - 70, 'RITIRATA!', { player: p.i, size: 36 });
          continue;
        }
        for (const rg of s.rings) {
          if (g.ended || rg.l !== p.i || !(prev > rg.r && p.r <= rg.r) || Math.abs(p.o - rg.o) >= RING_TOL) continue;
          rg.life = 0; p.rg++;
          const q = lanePos(p.a, rg.r, rg.o);
          addPoints(s, p, 2, g, 'ANELLO!', '#ffd34d');
          g.sfx('coin'); g.burst(q.x, q.y, { color: '#ffd34d', n: 16, speed: 240 }); g.vibrate(p.i, 30);
        }
        // The mace sweeping over the lane near the dummy knocks the rider off.
        if (p.r < R_DANGER && p.duck <= 0 && !g.ended) {
          const q = lanePos(p.a, p.r, p.o);
          const ap = Math.atan2(q.y - CY, q.x - CX);
          for (const ma of maceAngles(s.th, g.variant)) {
            if (Math.abs(wrapAngle(ma - ap)) >= MACE_W) continue;
            const fresh = g.t - s.hitT < 1.2 && s.hitSpin > 1.4 && s.hitBy !== p.i ? s.hitBy : null;
            if (fresh !== null && g.ally(fresh, p.i)) {
              p.duck = 0.5; g.text(q.x, q.y - 70, 'CHINATO!', { player: p.i, size: 34 }); g.sfx('slide');
            } else whack(s, p, g, fresh);
            break;
          }
          if (p.st !== 1) continue;
        }
        if (p.r <= R_STRIKE) { p.r = R_STRIKE; strike(s, p, g); }
      } else if (p.st === 2) {
        p.r += V_BACK * dt;
        if (p.r >= R_START) { p.r = R_START; p.st = 0; p.v = 0; }
      }
    }
  },

  timeout(s) {
    s.over = true;
    // Best team (or rider) by points; ties: centers, rings, courage (charges), fewer falls.
    const teams = [...new Set(s.tm)];
    const key = (t) => {
      const ps = s.p.filter((p) => s.tm[p.i] === t);
      const sum = (f) => ps.reduce((a, p) => a + f(p), 0);
      return [teamScore(s, t), sum((p) => p.cen), sum((p) => p.rg), sum((p) => p.n), -sum((p) => p.falls)];
    };
    let best = teams[0], bk = key(best);
    for (const t of teams.slice(1)) {
      const k = key(t);
      for (let j = 0; j < k.length; j++) { if (k[j] > bk[j]) { best = t; bk = k; break; } if (k[j] < bk[j]) break; }
    }
    const mates = s.p.filter((p) => s.tm[p.i] === best);
    return mates.reduce((a, p) => (p.pn > a.pn ? p : a), mates[0]).i;
  },

  bot: quintanaBot,

  view(s) {
    const team = s.tm.some((t, k) => t !== k);
    return {
      rot: r2(s.th), w: r2(s.w), wn: s.revAt - s.t < 0.7 ? 1 : 0, fin: s.fin ? 1 : 0, hk: s.hk, ch: r2(s.cheer), tmode: team ? 1 : 0,
      rg: s.rings.map((rg) => ({ l: rg.l, o: r1(rg.o), rr: rg.r, f: r2(rg.life) })),
      p: s.p.map((p) => {
        const q = lanePos(p.a, p.r, p.o);
        return {
          x: r1(q.x), y: r1(q.y), a: r2(p.a), r: r1(p.r), o: r1(p.o), st: p.st, v: Math.round(p.v), k: p.k, rs: p.rs, rt: r2(p.rt),
          fx: r1(p.fx), fy: r1(p.fy), fr: r1(p.fr), dt: r2(p.t), tm: s.tm[p.i], pn: p.pn,
        };
      }),
      hud: { p: s.p.map((p) => (team ? teamScore(s, s.tm[p.i]) : p.pn)), max: null, label: team ? 'Squadra' : 'Punti' },
    };
  },

  focus(v) {
    return v.p.map((p) => (p.st === 3 ? { x: p.fx, y: p.fy } : { x: p.x, y: p.y }));
  },

  // ---------------------------------------------------------------- 3D: the tournament lists
  render3d: {
    assets: [
      'medieval/tent', 'medieval/fence_wood_straight',
      'medieval/building_church_yellow', 'medieval/building_home_A_red', 'medieval/building_home_B_yellow', 'medieval/building_home_A_blue',
      'medieval/building_tower_B_yellow', 'medieval/building_tavern_red', 'medieval/building_windmill_yellow', 'medieval/building_stage_B',
      'medieval/trees_B_large', 'medieval/trees_A_medium', 'medieval/tree_single_B', 'medieval/hills_B_trees', 'medieval/mountain_A_grass_trees',
      'medieval/barrel', 'medieval/sack', 'medieval/crate_B_small', 'medieval/weaponrack', 'medieval/wheelbarrow', 'medieval/bucket_water',
      'dungeon/banner_patternA_yellow', 'dungeon/banner_patternC_red', 'dungeon/banner_triple_blue', 'dungeon/banner_shield_green',
      'chars/Knight', 'chars/Mage', 'chars/Rogue',
    ],
    build(K, r) {
      const n = r.n || K.n || 2;
      const lo = K.quality === 0;
      K.theme('giorno', { fogNear: 2.6, fogFar: 7 });
      K.ground('prato', { tile: 210 });
      // Lane angles as a set (which seat rides which lane is known only from the view: teams reorder them).
      const o = { n, laneSet: laneAngles(n, null), laneOf: [], colKey: '', lanes: [], ringSlots: [], riders: [] };
      // Painted lists: sand arena, lanes with the riders' colors, strike and mace lines (painted once, from the first view).
      K.layer({
        x0: -260, y0: -260, x1: W + 260, y1: H + 260, h: 0.5, once: true, transparent: true, maxPx: 2048,
        draw: (d, v) => drawLists(d, v, (i) => K.col(i), true),
      });
      buildSaracen(K, o, lo);
      o.setVariant(r.variant);
      const wood = K.texMat('legno', [1, 3], { color: '#8a5a32' });
      const ringMat = K.mat('#ffd34d', { metal: 0.8, rough: 0.25, emissive: '#7a5600', ei: 0.6 });
      const fence = [];
      o.laneSet.forEach((a, j) => {
        const L = { a, cloth: K.mat('#ffffff', { rough: 0.7, unique: true }), flag: K.mat('#ffffff', { rough: 0.8, unique: true, side: 2 }) };
        // Low wooden tilts along the lane (fence models) with a cloth in the rider's color.
        for (const side of [-1, 1]) {
          for (let k = 0; k < 5; k++) { const q = lanePos(a, 215 + k * 56, side * (AIM_MAX + 34) - 50); fence.push({ x: q.x, y: q.y, rot: a + Math.PI / 2 }); }
          const c = K.box(290, 9, 7, L.cloth, { cast: false });
          const q = lanePos(a, 330, side * (AIM_MAX + 34));
          K.place(c, q.x, q.y, 31);
          K.face(c, a);
        }
        // Rider's banner by the gate (pole + cloth colored in update) and a pavilion (not on the king's side).
        const fq = lanePos(a, 515, -(AIM_MAX + 60));
        K.place(K.cyl(4, 210, wood, { seg: 6 }), fq.x, fq.y);
        L.flagG = K.group();
        K.place(L.flagG, fq.x, fq.y, 190);
        const cl = K.box(70, 3, 44, L.flag, { parent: L.flagG });
        cl.position.set(36, 0, 0);
        L.flagBase = a + Math.PI / 2;
        if (Math.sin(a) > -0.9) {
          const tq = lanePos(a, 610, 150);
          const tent = K.model('medieval/tent', { size: 150 });
          K.place(tent, tq.x, tq.y); K.face(tent, a + Math.PI);
        }
        // Gallows with the hanging gold ring(s).
        for (const rr of ringRadii(r.variant)) {
          const base = lanePos(a, rr, AIM_MAX + 30);
          K.place(K.cyl(4, 132, wood, { seg: 8 }), base.x, base.y);
          const arm = K.box(2 * AIM_MAX + 40, 7, 7, wood);
          const mid = lanePos(a, rr, 10);
          K.place(arm, mid.x, mid.y, 128);
          K.face(arm, a + Math.PI / 2);
          const ring = K.torus(13, 2.6, ringMat, { cast: false });
          ring.rotation.order = 'YXZ';
          const str = K.cyl(0.8, 26, K.mat('#3d2614'), { cast: false, seg: 4 });
          const glow = K.disc(20, K.glow('#ffe27a', { opacity: 0.35, add: true }));
          o.ringSlots.push({ j, rr, m: ring, str, glow });
        }
        o.lanes.push(L);
      });
      K.scatter('medieval/fence_wood_straight', fence, { size: 58 });
      // Empty cardinal sides (2–3 riders): a musicians' stage and props instead of a lane.
      for (const a of laneAngles(4, null)) {
        if (o.laneSet.some((b) => Math.abs(wrapAngle(a - b)) < 0.6) || Math.sin(a) < -0.9) continue;
        const q = lanePos(a, 400, 0);
        const st = K.model('medieval/building_stage_B', { size: 180 });
        K.place(st, q.x, q.y); K.face(st, a + Math.PI);
        const b1 = lanePos(a, 300, 90), b2 = lanePos(a, 300, -90), w1 = lanePos(a, 480, 0);
        K.scatter('medieval/barrel', [{ x: b1.x, y: b1.y, rot: 1 }, { x: b2.x, y: b2.y, rot: 2 }], { size: 40 });
        K.scatter('medieval/weaponrack', [{ x: w1.x, y: w1.y, rot: a + Math.PI / 2 }], { size: 90 });
      }
      // Riders: horse + caparison + lance + the player's character in the saddle; aim tick on the ground.
      for (let i = 0; i < n; i++) {
        const R = buildRider(K, i);
        R.dec = K.decal(160);
        R.dec.paint((d) => {
          const c = K.col(i, 'light');
          d.ring(0, 0, 46, c + 'aa', 5);
          d.poly([62, 0, 46, -12, 46, 12], c + 'ee', 'rgba(0,0,0,0.35)', 2);
        });
        o.riders.push(R);
      }
      buildStands(K, o, lo);
      buildRoyalBox(K, o);
      buildCountryside(K, o, lo);
      K.ambient('polvere', { n: 40, x0: 100, y0: 100, x1: 900, y1: 900, h: 160 });
      K.ambient('petali', { n: 30, x0: -200, y0: -300, x1: 1200, y1: 1200, h: 420 });
      return o;
    },

    update(K, o, v, r) {
      const t = K.t;
      const th = v.rot;
      // Which lane each seat rides (teams reorder them): recolor tilts and banners when it changes.
      const laneOf = v.p.map((p) => o.laneSet.findIndex((a) => Math.abs(wrapAngle(a - p.a)) < 0.1));
      const key = laneOf.join(',');
      if (key !== o.colKey) {
        o.colKey = key;
        o.lanes.forEach((L) => { L.cloth.color.set('#d8c8a8'); L.flag.color.set('#d8c8a8'); });
        laneOf.forEach((j, i) => { const L = o.lanes[j]; if (L) { L.cloth.color.set(K.col(i)); L.flag.color.set(K.col(i)); } });
      }
      o.lanes.forEach((L, j) => { K.face(L.flagG, L.flagBase + Math.sin(t * 2.1 + j) * 0.25); });
      // Saracen: rotation, wobble after a hit, trembling before a reversal, maces flung out by the spin.
      if (o.hkSeen !== v.hk) { o.hkSeen = v.hk; o.hitAt = t; }
      const since = t - (o.hitAt ?? -9);
      const wob = since < 0.6 ? Math.sin(since * 40) * 0.12 * (1 - since / 0.6) : 0;
      const trem = v.wn ? Math.sin(t * 60) * 0.04 : 0;
      K.face(o.sar, th + wob + trem);
      K.face(o.wedges, th);
      o.warn.visible = !!v.wn;
      if (v.wn) { K.place(o.warn, CX, CY, 190 + Math.sin(t * 12) * 6); }
      const sw = clamp(Math.abs(v.w) / 5, 0.15, 1);
      for (const M of o.maces) {
        M.pivot.rotation.z = (Math.PI / 2) * (0.2 + sw * 0.75);
        M.pivot.rotation.x = Math.sign(v.w || 1) * 0.3 * sw;
      }
      // Royals and crowd.
      const cheer = v.ch > 0.2;
      const kingH = o.kingP.h;
      o.king.set(o.kingP.x, o.kingP.y, { r: 30, h: kingH, look: Math.PI / 2, anim: cheer ? 'Cheer' : 'Sit_Chair_Idle', gear: false, marker: false });
      o.queen.set(o.queenP.x, o.queenP.y, { r: 27, h: o.queenP.h, look: Math.PI / 2, anim: cheer ? 'Cheer' : 'Sit_Chair_Idle', gear: false, marker: false });
      o.herald.set(o.heraldP.x, o.heraldP.y, { r: 27, h: o.heraldP.h, look: Math.PI / 2 + 0.4, anim: v.fin ? 'Cheer' : 'Idle', gear: false, marker: false });
      K.place(o.crown, o.kingP.x, o.kingP.y + 2, kingH + (cheer ? 76 : 58));
      animateCrowd(K, o.crowd, t, v.ch);
      // Rings.
      for (const S of o.ringSlots) {
        const rg = v.rg.find((q) => laneOf[q.l] === S.j && q.rr === S.rr);
        const on = !!rg && !(rg.f < 1.2 && Math.floor(t * 10) % 2);
        S.m.visible = S.glow.visible = S.str.visible = on;
        if (!on) continue;
        const a = o.laneSet[S.j];
        const q = lanePos(a, S.rr, rg.o);
        K.place(S.m, q.x, q.y, 88);
        S.m.rotation.set(Math.PI / 2, -a + Math.PI / 2, Math.sin(t * 2.2 + S.j) * 0.12);
        K.place(S.str, q.x, q.y, 101);
        K.place(S.glow, q.x, q.y, 1.3);
      }
      // Riders.
      let best = -1;
      if (r.ended) for (const q of v.hud.p) best = Math.max(best, q);
      v.p.forEach((p, i) => {
        const R = o.riders[i];
        if (!R) return;
        const a = p.a;
        const charging = p.st === 1, back = p.st === 2, down = p.st === 3;
        // Horse on the lane; when the rider is down it trots back to the gate alone.
        let hx = p.x, hy = p.y, face = a + Math.PI, speed = charging ? p.v : back ? V_BACK : 0;
        if (down) {
          const k = clamp(1 - p.dt / DOWN_T, 0, 1);
          const q = lanePos(a, p.fr + (R_START - p.fr) * Math.min(1, k * 1.4), 0);
          hx = q.x; hy = q.y; face = a; speed = k < 0.7 ? 300 : 40;
        } else if (back) face = a;
        R.ph += (K.dt || 0) * (3 + speed / 40);
        const gal = speed > 60 ? 1 : 0.12;
        const bob = Math.abs(Math.sin(R.ph)) * (speed > 60 ? 6 : 1);
        K.place(R.g, hx, hy, bob);
        K.face(R.g, face);
        R.legs.forEach((L, k) => { L.rotation.z = Math.sin(R.ph * 2 + (k < 2 ? 0 : Math.PI) + (k % 2) * 0.6) * 0.65 * gal; });
        R.tail.rotation.z = 2.3 + Math.sin(R.ph * 2) * 0.25 * gal;
        // Lance couched while charging, raised otherwise; gone (broken) while down.
        R.lance.visible = !down;
        R.lance.rotation.z = charging ? 0.02 : back ? 0.7 : 0.95;
        const recoil = p.rt > 0.9 && p.rs > 0 && p.rs < 4 ? (p.rt - 0.9) * 2 : 0;
        R.lance.position.x = -30 - recoil * 30;
        if (down) {
          R.av.set(p.fx, p.fy, { r: 25, look: a, mood: 'dizzy', anim: p.dt > DOWN_T - 0.6 ? 'Death_B' : 'Lie_Idle', gear: false });
        } else {
          let mood = 'ok', anim = 'Sit_Chair_Idle';
          if (r.ended) mood = v.hud.p[i] === best ? 'happy' : 'dizzy';
          const sx = hx - Math.cos(face) * 6, sy = hy - Math.sin(face) * 6;
          R.av.set(sx, sy, { r: 25, h: SADDLE_H + bob, look: face, mood, anim, gear: false });
        }
        R.dec.show(!down).at(hx, hy, 1.1);
        R.dec.mesh.rotation.y = -face;
        // Points flash on the caparison when a hit lands.
        R.capMat.emissiveIntensity = p.rt > 0 && p.rs > 0 && p.rs < 4 ? 0.7 * (p.rt / 1.2) : 0.05;
      });
    },
  },

  render(d, v, r) {
    drawLists(d, v, (i) => d.col(i), false);
    // Wedges: where the shield and the mace point.
    const th = v.rot;
    for (const sa of shieldAngles(th, r.variant)) wedge(d, sa, 0.45, 70, 280, 'rgba(255,211,77,0.28)');
    for (const ma of maceAngles(th, r.variant)) wedge(d, ma, MACE_W, 70, R_DANGER, 'rgba(255,60,50,0.3)');
    // Rings.
    for (const rg of v.rg) {
      const p = v.p[rg.l];
      if (!p || (rg.f < 1.2 && Math.floor(d.t * 10) % 2)) continue;
      const q = lanePos(p.a, rg.rr, rg.o);
      d.ring(q.x, q.y, 14, '#ffd34d', 5);
    }
    // The Saracen from above.
    d.circle(CX, CY, 40, '#7a5a3a', '#3d2614', 4);
    for (const ma of maceAngles(th, r.variant)) {
      const mx = CX + Math.cos(ma) * MACE_R, my = CY + Math.sin(ma) * MACE_R;
      d.line(CX, CY, mx, my, '#4a3a2a', 8);
      d.circle(mx, my, 16, '#555c66', '#222', 3);
    }
    for (const sa of shieldAngles(th, r.variant)) {
      const sx = CX + Math.cos(sa) * SH_D, sy = CY + Math.sin(sa) * SH_D;
      const px = -Math.sin(sa), py = Math.cos(sa);
      d.line(sx - px * SH_R, sy - py * SH_R, sx + px * SH_R, sy + py * SH_R, '#e8e2d0', 12);
      d.line(sx - px * GOOD, sy - py * GOOD, sx + px * GOOD, sy + py * GOOD, '#d33a2c', 12);
      d.line(sx - px * CENTER, sy - py * CENTER, sx + px * CENTER, sy + py * CENTER, '#ffd34d', 12);
    }
    d.circle(CX, CY, 22, '#2b2b2b');
    d.circle(CX, CY, 16, '#f2efe6');
    // Riders.
    v.p.forEach((p, i) => {
      if (p.st === 3) {
        const k = clamp(1 - p.dt / DOWN_T, 0, 1);
        const h = lanePos(p.a, p.fr + (R_START - p.fr) * Math.min(1, k * 1.4), 0);
        d.circle(h.x, h.y, 20, '#7a4a26');
        d.avatar(p.fx, p.fy, 26, i, { mood: 'dizzy', squash: 0.3 });
        return;
      }
      const f = p.st === 2 ? p.a : p.a + Math.PI;
      const fx = Math.cos(f), fy = Math.sin(f);
      d.shadow(p.x + 6, p.y + 10, 34, 22, 0.3);
      d.ctx.save(); d.ctx.translate(p.x, p.y); d.ctx.rotate(f);
      d.rrect(-34, -15, 68, 30, 14, COATS[i % 4], '#2a1a10', 3);
      d.rrect(-20, -17, 34, 34, 8, d.col(i), d.col(i, 'dark'), 2);
      d.circle(36, 0, 10, COATS[i % 4]);
      d.ctx.restore();
      if (p.st === 1) d.line(p.x, p.y, p.x + fx * 95, p.y + fy * 95, d.col(i, 'light'), 5);
      d.avatar(p.x, p.y, 22, i, { look: f, mood: p.st === 1 ? 'angry' : 'ok' });
    });
  },
};

// ---------------------------------------------------------------- drawing helpers
function wedge(d, a, half, r0, r1v, color) {
  const { ctx } = d;
  ctx.beginPath();
  ctx.arc(CX, CY, r1v, a - half, a + half);
  ctx.arc(CX, CY, r0, a + half, a - half, true);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// Sand arena, lanes (stripes in the rider's color), chalk lines. col(i) gives the lane color.
function drawLists(d, v, col, is3d) {
  const { ctx } = d;
  if (!is3d) { ctx.fillStyle = '#6aa84f'; ctx.fillRect(-300, -300, W + 600, H + 600); }
  const g = ctx.createRadialGradient(CX, CY, 100, CX, CY, 560);
  g.addColorStop(0, '#e6c98f'); g.addColorStop(0.85, '#d9b77a'); g.addColorStop(1, 'rgba(201,163,104,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(CX, CY, 560, 0, TAU); ctx.fill();
  d.ring(CX, CY, 520, 'rgba(120,84,46,0.55)', 10);
  // Raked sand: concentric strokes.
  for (let rr = 190; rr < 510; rr += 26) d.ring(CX, CY, rr, 'rgba(160,120,70,0.12)', 3);
  // Center platform (compass rose).
  d.circle(CX, CY, 120, '#c8a06a', 'rgba(90,60,30,0.6)', 5);
  for (let k = 0; k < 8; k++) {
    const a = (k * TAU) / 8, a2 = a + TAU / 16;
    d.poly([CX, CY, CX + Math.cos(a) * 112, CY + Math.sin(a) * 112, CX + Math.cos(a2) * 40, CY + Math.sin(a2) * 40], k % 2 ? 'rgba(140,40,40,0.35)' : 'rgba(240,220,170,0.4)');
  }
  const n = v.p.length;
  v.p.forEach((p, i) => {
    const a = p.a, c = col(i);
    const hw = AIM_MAX + 30;
    const A = lanePos(a, 170, -hw), B = lanePos(a, 500, -hw), C = lanePos(a, 500, hw), D2 = lanePos(a, 170, hw);
    d.poly([A, B, C, D2], 'rgba(150,104,60,0.55)');
    // Hoof-trodden center line and the side stripes in the rider's color.
    const m0 = lanePos(a, 175, 0), m1 = lanePos(a, 495, 0);
    d.line(m0.x, m0.y, m1.x, m1.y, 'rgba(110,72,38,0.35)', 18);
    for (const s of [-1, 1]) {
      const e0 = lanePos(a, 170, s * hw), e1 = lanePos(a, 500, s * hw);
      d.line(e0.x, e0.y, e1.x, e1.y, c, 8);
    }
    // Strike line (white) and mace line (red, dashed).
    const s0 = lanePos(a, R_STRIKE, -hw), s1 = lanePos(a, R_STRIKE, hw);
    d.line(s0.x, s0.y, s1.x, s1.y, 'rgba(255,255,255,0.8)', 5);
    for (let k = 0; k < 6; k++) {
      const q0 = lanePos(a, R_DANGER, -hw + (k * 2 * hw) / 6), q1 = lanePos(a, R_DANGER, -hw + ((k + 0.5) * 2 * hw) / 6);
      d.line(q0.x, q0.y, q1.x, q1.y, 'rgba(230,50,40,0.85)', 5);
    }
    // Gate.
    const g0 = lanePos(a, R_START + 40, -hw), g1 = lanePos(a, R_START + 40, hw);
    d.line(g0.x, g0.y, g1.x, g1.y, c, 10);
  });
  if (n && v.tmode) {
    // Team pennants painted on the sand near each gate.
    v.p.forEach((p) => { const q = lanePos(p.a, 510, 0); d.circle(q.x, q.y, 14, TEAM_COL[p.tm] || '#fff', '#fff', 3); });
  }
}

// ---------------------------------------------------------------- 3D builders
const SAR_H = 46;      // height of the Saracen's waist (shield at lance height)
const LANCE_H = 86;    // lance height on the horse
const SADDLE_H = 48;   // where the character stands so that it sits on the horse

function buildSaracen(K, o, lo) {
  const wood = K.texMat('legno', [1, 3], { color: '#8a5a32' });
  K.place(K.cyl(52, 18, K.texMat('pietra', [3, 1], { color: '#cfc6b8' }), { seg: 24 }), CX, CY);
  K.place(K.cyl(10, SAR_H, wood, { seg: 10 }), CX, CY, 16);
  // Ground wedges (shield = gold, mace = red) turning with the dummy.
  o.wedges = K.group();
  K.place(o.wedges, CX, CY, 2.2);
  const wedgeG = (a, half, r0, r1v, mat) => K.disc(r1v, mat, { r0, a0: a - half, a1: a + half, parent: o.wedges });
  const gold = K.glow('#ffc21a', { opacity: 0.62 }), red = K.glow('#e8281c', { opacity: 0.55 });
  wedgeG(0, 0.45, 70, 290, gold);
  o.wedgeB = wedgeG(Math.PI, 0.45, 70, 290, gold);
  o.maceW = [wedgeG(Math.PI, MACE_W, 70, R_DANGER, red), wedgeG(Math.PI / 2, MACE_W, 70, R_DANGER, red), wedgeG(-Math.PI / 2, MACE_W, 70, R_DANGER, red)];
  // Rotating bust (local +X = where it looks = the shield).
  const S = K.group();
  o.sar = S;
  K.place(S, CX, CY, SAR_H);
  const tunic = K.mat('#b3262e', { rough: 0.7 });
  K.cyl(30, 58, tunic, { r2: 22, parent: S, seg: 16 });
  const belt = K.torus(28, 4, K.mat('#ffd34d', { metal: 0.6, rough: 0.3 }), { parent: S });
  belt.position.y = 10;
  const head = K.ball(21, K.mat('#8a5632', { rough: 0.6 }), { parent: S });
  head.position.y = 76;
  const turban = K.ball(24, K.mat('#f2efe6', { rough: 0.8 }), { parent: S });
  turban.position.y = 93; turban.scale.set(1, 0.72, 1);
  const jewel = K.ball(5, K.mat('#2fbf71', { emissive: '#1a7a44', ei: 0.8 }), { parent: S, cast: false });
  jewel.position.set(22, 93, 0);
  const ink = K.mat('#1a1410');
  for (const z of [-8, 8]) {
    const e = K.ball(4.5, K.mat('#ffffff'), { parent: S, cast: false }); e.position.set(17, 81, z);
    const pu = K.ball(2.4, ink, { parent: S, cast: false }); pu.position.set(21, 81, z);
  }
  const brow = K.box(5, 30, 4, ink, { parent: S, cast: false });
  brow.position.set(18, 88, 0); brow.rotation.x = 0.0;
  const mous = K.box(6, 30, 5, ink, { parent: S, cast: false });
  mous.position.set(20, 69, 0);
  K.box(14, 150, 14, tunic, { parent: S }).position.set(0, 46, 0); // shoulders
  // Shield(s): target-painted disc facing +X (and -X in "bifronte").
  const tex = K.canvasTex(128, 128, (d) => {
    d.circle(64, 64, 63, '#e8e2d0'); d.circle(64, 64, 62, null, '#3d2614', 5);
    d.circle(64, 64, (GOOD / SH_R) * 63, '#d33a2c'); d.circle(64, 64, (CENTER / SH_R) * 63 + 2, '#ffd34d', '#7a5600', 3);
    for (let k = 0; k < 8; k++) { const a = (k * TAU) / 8; d.circle(64 + Math.cos(a) * 54, 64 + Math.sin(a) * 54, 3.5, '#8a8f99'); }
  });
  const faceMat = K.mat('#ffffff', { map: tex, rough: 0.5 });
  const rimMat = K.mat('#6b4a2a', { rough: 0.6 });
  const mkShield = (sign) => {
    const g = K.group(S);
    g.position.set(sign * SH_D, LANCE_H - SAR_H, 0);
    const back = K.cyl(SH_R + 3, 7, rimMat, { parent: g, center: true, seg: 28 });
    back.rotation.z = Math.PI / 2;
    const face = K.disc(SH_R, faceMat, { parent: g, seg: 32 });
    face.rotation.z = (-Math.PI / 2) * sign;
    face.position.x = sign * 4;
    const arm = K.box(SH_D - 14, 9, 9, tunic, { parent: g });
    arm.position.set(-sign * (SH_D / 2 - 4), 46 - (LANCE_H - SAR_H), 0);
    return g;
  };
  mkShield(1);
  o.shieldB = mkShield(-1);
  // Mace(s) on chains (one behind, or two on the sides for "bifronte"), flung out by the spin.
  const iron = K.mat('#5d6470', { metal: 0.7, rough: 0.35 });
  const mkMace = (angle) => {
    const arm = K.group(S);
    arm.rotation.y = -angle;
    const stick = K.box(MACE_R - 40, 9, 9, wood, { parent: arm });
    stick.position.set((MACE_R - 40) / 2 + 20, 46, 0);
    const pivot = K.group(arm);
    pivot.position.set(MACE_R - 22, 46, 0);
    const chain = K.cyl(2, 42, iron, { parent: pivot, seg: 6 });
    chain.position.y = -42;
    const ball = K.ball(15, iron, { parent: pivot });
    ball.position.y = -54;
    for (let k = 0; k < (lo ? 4 : 8); k++) {
      const sp = K.cone(4, 11, iron, { parent: ball, cast: false });
      const a = (k / 8) * TAU;
      sp.position.set(Math.cos(a) * 12, k % 2 ? 6 : -6, Math.sin(a) * 12);
      sp.rotation.set(Math.sin(a) * 1.4, 0, -Math.cos(a) * 1.4);
    }
    return { arm, pivot };
  };
  o.maceSets = { normal: [mkMace(Math.PI)], doppio: [mkMace(Math.PI / 2), mkMace(-Math.PI / 2)] };
  o.maces = [...o.maceSets.normal, ...o.maceSets.doppio];
  o.warn = K.emoji('❗', 60);
  o.warn.visible = false;
  o.setVariant = (variant) => {
    const dbl = variant === 'doppio';
    for (const M of o.maceSets.normal) M.arm.visible = !dbl;
    for (const M of o.maceSets.doppio) M.arm.visible = dbl;
    o.shieldB.visible = dbl;
    o.wedgeB.visible = dbl;
    o.maceW[0].visible = !dbl; o.maceW[1].visible = dbl; o.maceW[2].visible = dbl;
  };
}

function buildRider(K, i) {
  const g = K.group();
  const coat = K.mat(COATS[i % 4], { rough: 0.55 });
  const dark = K.mat('#2a1d16', { rough: 0.8 });
  const capMat = K.mat(K.col(i), { rough: 0.75, side: 2, unique: true, emissive: K.col(i), ei: 0.05 });
  const body = K.ball(1, coat, { parent: g, seg: 16 });
  body.scale.set(40, 22, 18); body.position.set(0, 58, 0);
  const cap = K.cyl(1, 1, capMat, { parent: g, open: true, seg: 18 });
  cap.scale.set(44, 32, 23); cap.position.set(-2, 28, 0);
  const capTop = K.ball(1, capMat, { parent: g, seg: 14, cast: false });
  capTop.scale.set(36, 9, 22); capTop.position.set(-6, 68, 0);
  const neck = K.box(16, 13, 42, coat, { parent: g });
  neck.position.set(34, 80, 0); neck.rotation.z = -0.55;
  const mane = K.box(8, 6, 40, dark, { parent: g, cast: false });
  mane.position.set(28, 84, 0); mane.rotation.z = -0.55;
  const head = K.box(34, 13, 15, coat, { parent: g });
  head.position.set(52, 96, 0); head.rotation.z = -0.35;
  const plume = K.cone(5, 18, K.mat(K.col(i, 'light')), { parent: g, cast: false });
  plume.position.set(44, 104, 0);
  const tail = K.cyl(4, 36, dark, { parent: g, r2: 8, seg: 8 });
  tail.position.set(-38, 62, 0);
  const legs = [];
  for (const [lx, lz] of [[24, 9], [24, -9], [-24, 9], [-24, -9]]) {
    const piv = K.group(g);
    piv.position.set(lx, 46, lz);
    const leg = K.cyl(4.5, 46, coat, { parent: piv, seg: 8 });
    leg.position.y = -46;
    legs.push(piv);
  }
  // Lance: striped shaft along +X with a steel guard, couched at the rider's side.
  const lance = K.group(g);
  lance.position.set(-30, LANCE_H, -12);
  const shaft = K.cyl(3.2, 135, K.mat(K.col(i, 'light'), { rough: 0.5 }), { parent: lance, r2: 1.6, seg: 8 });
  shaft.rotation.z = -Math.PI / 2;
  const guard = K.cone(10, 16, K.mat('#c9ced6', { metal: 0.7, rough: 0.3 }), { parent: lance, seg: 12 });
  guard.rotation.z = -Math.PI / 2; guard.position.x = 22;
  return { g, legs, tail, lance, capMat, ph: i * 1.3, av: K.avatar(i) };
}

// Wooden stands on the four diagonals (taller with striped canopies on the far side) and an instanced crowd.
function buildStands(K, o, lo) {
  const { THREE } = K;
  const wood = K.texMat('legno', [4, 1], { color: '#9a6a3c' });
  const stripeTex = (c1, c2) => K.canvasTex(64, 64, (d) => { for (let k = 0; k < 8; k++) d.rect(k * 8, 0, 8, 64, k % 2 ? c1 : c2); });
  const canopies = [['#d33a2c', '#f2efe6'], ['#2f6fd6', '#f2efe6'], ['#2f9e4a', '#ffd34d'], ['#ffd34d', '#b3262e']];
  const spots = [];
  [Math.PI / 4, (3 * Math.PI) / 4, -Math.PI / 4, (-3 * Math.PI) / 4].forEach((a, k) => {
    const far = Math.sin(a) < 0;
    const R0 = far ? 620 : 680;
    const grp = K.group();
    K.place(grp, CX + Math.cos(a) * R0, CY + Math.sin(a) * R0);
    // Local +X along the stand, local -Z away from the arena.
    grp.rotation.y = -(a + Math.PI / 2);
    const tiers = far ? 4 : 2;
    for (let t = 0; t < tiers; t++) {
      const hh = 20 + t * 22;
      const step = K.box(330, 40, hh, wood, { parent: grp });
      step.position.set(0, hh / 2, t * 38);
      for (let c = 0; c < (lo ? 7 : 11); c++) spots.push({ grp, lx: -150 + c * 30 + (t % 2) * 12, ly: hh, lz: t * 38 });
    }
    if (far) {
      const roof = K.box(350, 170, 8, K.mat('#ffffff', { map: stripeTex(...canopies[k]), rough: 0.8, side: 2 }), { parent: grp });
      roof.position.set(0, 175, 70); roof.rotation.x = 0.18;
      for (const px of [-165, 165]) for (const pz of [-10, 150]) K.cyl(4, 175, wood, { parent: grp, seg: 6 }).position.set(px, 0, pz);
    }
  });
  const n = spots.length;
  const bodyG = new THREE.CylinderGeometry(8, 11, 24, 8); bodyG.translate(0, 12, 0);
  const headG = new THREE.SphereGeometry(7.5, 10, 8);
  const bodies = new THREE.InstancedMesh(bodyG, new THREE.MeshStandardMaterial({ roughness: 0.8 }), n);
  const heads = new THREE.InstancedMesh(headG, new THREE.MeshStandardMaterial({ roughness: 0.7 }), n);
  bodies.userData.ownGeo = heads.userData.ownGeo = true;
  const shirts = ['#c0392b', '#2e86de', '#27ae60', '#f1c40f', '#8e44ad', '#e67e22', '#ecf0f1', '#16a085', '#d35400'];
  const skins = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
  const col = new THREE.Color(), v3 = new THREE.Vector3();
  const pts = spots.map((s, k) => {
    s.grp.updateMatrixWorld(true);
    v3.set(s.lx, s.ly, s.lz).applyMatrix4(s.grp.matrixWorld);
    bodies.setColorAt(k, col.set(shirts[(k * 7) % shirts.length]));
    heads.setColorAt(k, col.set(skins[(k * 3) % skins.length]));
    return { x: v3.x, y: v3.y, z: v3.z, ph: (k * 2.39) % TAU };
  });
  K.root.add(bodies); K.root.add(heads);
  o.crowd = { bodies, heads, pts, m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(1, 1, 1) };
  animateCrowd(K, o.crowd, 0, 0);
}

function animateCrowd(K, C, t, cheer) {
  const amp = cheer > 0.2 ? 10 : 2.5, sp = cheer > 0.2 ? 14 : 4;
  C.pts.forEach((q, k) => {
    const j = Math.max(0, Math.sin(t * sp + q.ph)) * amp;
    C.p.set(q.x, q.y + j, q.z);
    C.m.compose(C.p, C.q, C.s);
    C.bodies.setMatrixAt(k, C.m);
    C.p.y += 30;
    C.m.compose(C.p, C.q, C.s);
    C.heads.setMatrixAt(k, C.m);
  });
  C.bodies.instanceMatrix.needsUpdate = true;
  C.heads.instanceMatrix.needsUpdate = true;
}

// The king's box behind the far gate: platform, striped canopy, thrones, king, queen and the herald.
function buildRoyalBox(K, o) {
  const wood = K.texMat('legno', [3, 1], { color: '#7a4a26' });
  const y0 = -120, hw = 170;
  K.place(K.box(2 * hw, 140, 60, wood), CX, y0);
  K.place(K.box(2 * hw - 40, 120, 4, K.texMat('tappeto', [2, 1]), { cast: false }), CX, y0, 60.5);
  K.place(K.box(2 * hw, 8, 50, K.mat('#b3262e', { rough: 0.8 })), CX, y0 + 72, 28);
  const gold = K.mat('#ffd34d', { metal: 0.7, rough: 0.3 });
  for (const x of [CX - hw + 10, CX + hw - 10]) for (const y of [y0 + 62, y0 - 62]) K.place(K.cyl(6, 210, gold, { seg: 8 }), x, y);
  const canopyTex = K.canvasTex(64, 64, (d) => { for (let k = 0; k < 8; k++) d.rect(k * 8, 0, 8, 64, k % 2 ? '#7a1020' : '#ffd34d'); });
  K.place(K.box(2 * hw + 20, 160, 10, K.mat('#ffffff', { map: canopyTex, side: 2, rough: 0.8 })), CX, y0, 210);
  K.place(K.cone(30, 46, gold, { seg: 8 }), CX, y0, 215);
  for (const [x, hgt] of [[CX - 45, 95], [CX + 45, 82]]) {
    K.place(K.box(46, 40, 26, K.mat('#7a1020')), x, y0, 60);
    K.place(K.box(46, 10, hgt, gold), x, y0 - 22, 60);
  }
  o.kingP = { x: CX - 45, y: y0 + 2, h: 64 };
  o.queenP = { x: CX + 45, y: y0 + 2, h: 64 };
  o.heraldP = { x: CX + 125, y: y0 + 45, h: 60 };
  o.king = K.npc('knight', { marker: false });
  o.queen = K.npc('mage', { marker: false });
  o.herald = K.npc('rogue', { marker: false });
  o.crown = K.cyl(10, 10, gold, { seg: 8, open: true, cast: false });
  const banners = ['dungeon/banner_patternA_yellow', 'dungeon/banner_patternC_red', 'dungeon/banner_triple_blue', 'dungeon/banner_shield_green'];
  banners.forEach((b, k) => { const m = K.model(b, { height: 110 }); K.place(m, CX - 135 + k * 90, y0 + 74, 0); K.face(m, Math.PI / 2); });
}

// Town, church, windmill, woods and hills around the lists, and bunting strung over the arena.
function buildCountryside(K, o, lo) {
  const { THREE } = K;
  const place = (name, x, y, a, size) => { const m = K.model(name, { size }); K.place(m, x, y); K.face(m, a); return m; };
  place('medieval/building_church_yellow', CX - 640, -480, Math.PI / 2, 330);
  place('medieval/building_tower_B_yellow', CX + 650, -460, Math.PI / 2, 220);
  place('medieval/building_windmill_yellow', CX + 1150, -150, Math.PI, 300);
  place('medieval/building_tavern_red', -520, 260, 0, 280);
  place('medieval/building_home_A_red', -560, 660, 0.2, 220);
  place('medieval/building_home_B_yellow', 1540, 300, Math.PI, 230);
  place('medieval/building_home_A_blue', 1560, 700, Math.PI - 0.2, 220);
  place('medieval/building_home_B_yellow', CX - 980, -260, 0.6, 230);
  K.scatter('medieval/barrel', [{ x: -330, y: 360, rot: 1 }, { x: -300, y: 400, rot: 2 }, { x: 1320, y: 380, rot: 0.4 }, { x: 1290, y: 640, rot: 1 }], { size: 46 });
  K.scatter('medieval/sack', [{ x: -340, y: 430 }, { x: 1330, y: 600, rot: 1 }, { x: -260, y: -60, rot: 2 }], { size: 40 });
  K.scatter('medieval/crate_B_small', [{ x: -280, y: 470 }, { x: 1300, y: 700, rot: 0.5 }, { x: 1290, y: -40, rot: 0.3 }], { size: 44 });
  K.scatter('medieval/wheelbarrow', [{ x: -360, y: 720, rot: 0.6 }, { x: 1380, y: 220, rot: 2.4 }], { size: 80 });
  K.scatter('medieval/bucket_water', [{ x: -250, y: 520 }, { x: 1250, y: 520 }], { size: 26 });
  const trees = [], trees2 = [], singles = [];
  const N = lo ? 22 : 44;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * TAU + (k % 2) * 0.07;
    const rr = 1350 + (k % 4) * 130;
    (k % 2 ? trees : trees2).push({ x: CX + Math.cos(a) * rr * 1.35, y: CY + Math.sin(a) * rr, rot: k * 0.8, s: 0.85 + (k % 3) * 0.15 });
  }
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * TAU + 0.2;
    if (Math.sin(a) < -0.3) continue;
    singles.push({ x: CX + Math.cos(a) * 1120 * 1.25, y: CY + Math.sin(a) * 980, rot: k, s: 0.8 + (k % 3) * 0.2 });
  }
  K.scatter('medieval/trees_B_large', trees, { size: 300 });
  K.scatter('medieval/trees_A_medium', trees2, { size: 260 });
  K.scatter('medieval/tree_single_B', singles, { size: 140 });
  K.scatter('medieval/hills_B_trees', [{ x: -1400, y: -700, rot: 0.4 }, { x: 2400, y: -700, rot: 2.2 }, { x: -1700, y: 600, rot: 1 }, { x: 2700, y: 600, rot: 3 }], { size: 950 });
  K.scatter('medieval/mountain_A_grass_trees', [{ x: CX - 1400, y: -1800, rot: 0.3 }, { x: CX + 1500, y: -1900, rot: 1.8 }, { x: CX + 100, y: -2300, rot: 1 }], { size: 1500 });
  // Bunting: tall poles around the arena with strings of pennants (one instanced mesh).
  const poles = [];
  for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU + TAU / 16; poles.push({ x: CX + Math.cos(a) * 545, y: CY + Math.sin(a) * 545 }); }
  const poleMat = K.texMat('legno', [1, 3], { color: '#6b4a2a' });
  for (const p of poles) K.place(K.cyl(5, 200, poleMat, { seg: 6 }), p.x, p.y);
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-9, 0, 0, 9, 0, 0, 0, -22, 0], 3));
  tri.computeVertexNormals();
  const pennants = [];
  for (let k = 0; k < poles.length; k++) {
    const A = poles[k], B = poles[(k + 1) % poles.length];
    const m = lo ? 8 : 14;
    for (let j = 1; j < m; j++) {
      const f = j / m;
      pennants.push({ x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f, h: 196 - Math.sin(f * Math.PI) * 50, a: Math.atan2(B.y - A.y, B.x - A.x) });
    }
  }
  const pm = new THREE.InstancedMesh(tri, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.7 }), pennants.length);
  pm.userData.ownGeo = true;
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), p3 = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  const cols = ['#d33a2c', '#ffd34d', '#2f6fd6', '#f2efe6', '#2f9e4a'];
  const c = new THREE.Color();
  pennants.forEach((pp, k) => {
    K.p(pp.x, pp.y, pp.h, p3);
    q.setFromAxisAngle(up, -pp.a);
    M.compose(p3, q, one);
    pm.setMatrixAt(k, M);
    pm.setColorAt(k, c.set(cols[k % cols.length]));
  });
  K.root.add(pm);
}
