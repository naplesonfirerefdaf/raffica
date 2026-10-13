// Il Palio degli Asini — donkey race around the medieval square (top-down, 2–4 riders, optional 2 vs 2 teams).
// A = kick the donkey ON THE DRUM BEAT (mashing makes it stubborn and it plants itself), stick = steer,
// B = shove the donkey next to you. Carrots boost, sticks trip, the alley through the square is a shortcut
// with a gate that opens and closes.
import { clamp, damp, dist, collideCircles, wrapAngle, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000;
const R = 280, HALF = 90;                         // centerline radius of the bends, half track width
const C1X = 640, C2X = 360, CY = 500;             // bend centers (right, left)
const SB = CY + R, ST = CY - R;                   // y of the bottom / top straights
const U1 = 280, U2 = U1 + Math.PI * R, U3 = U2 + 280, L = U3 + Math.PI * R;
const FIN_U = 60;                                 // finish line (bottom straight, x = 420)
const LAPS = 3, DUR = 60;
const AX0 = 280, AX1 = 358, AY0 = 300, AY1 = 700, GY = 500, GT = 9; // the alley (shortcut) and its gate
const AXC = (AX0 + AX1) / 2;
const GATE_P = 7.5, GATE_OPEN = 4.5, GATE_WARN = 1.0;
const DR = 22;                                    // donkey radius
const V_MAX = 330, V_CARROT = 440, KEEP = 0.45, TURN = 3.4;
const BEAT = 0.42, BEAT_LAST = 0.36, MASH = 0.19;
const PERFECT = 0.07, GOODW = 0.14;
const PLANT_T = 1.6, SHOVE_CD = 1.3, SHOVE_R = 92, CARROT_T = 2.5, CARROT_R = 26;
const TEAM_COL = ['#ff4b5c', '#3fa9ff'];
const COATS = ['#8d8a86', '#6e5a4a', '#a7a29a', '#5b5450'];
const FLAG = ['red', 'blue', 'green', 'yellow'];

// ---------------------------------------------------------------- track geometry
// Point at track distance u with lateral offset lat (+ = outward), with the forward tangent.
function at(u, lat = 0) {
  u = ((u % L) + L) % L;
  if (u < U1) return { x: C2X + u, y: SB + lat, tx: 1, ty: 0 };
  if (u < U2) { const a = Math.PI / 2 - (u - U1) / R; return { x: C1X + Math.cos(a) * (R + lat), y: CY + Math.sin(a) * (R + lat), tx: Math.sin(a), ty: -Math.cos(a) }; }
  if (u < U3) return { x: C1X - (u - U2), y: ST - lat, tx: -1, ty: 0 };
  const a = -Math.PI / 2 - (u - U3) / R;
  return { x: C2X + Math.cos(a) * (R + lat), y: CY + Math.sin(a) * (R + lat), tx: Math.sin(a), ty: -Math.cos(a) };
}
// Nearest centerline point: { u, lat }. Points in the alley project on the left bend (progress flows through it).
function proj(x, y) {
  if (x >= C2X && x <= C1X) return y >= CY ? { u: x - C2X, lat: y - SB } : { u: U2 + (C1X - x), lat: ST - y };
  if (x > C1X) { const a = Math.atan2(y - CY, x - C1X); return { u: U1 + (Math.PI / 2 - a) * R, lat: Math.hypot(x - C1X, y - CY) - R }; }
  let a = Math.atan2(y - CY, x - C2X);
  if (a > 0) a -= TAU;
  return { u: U3 + (-Math.PI / 2 - a) * R, lat: Math.hypot(x - C2X, y - CY) - R };
}
const wrapU = (d) => (d > L / 2 ? d - L : d < -L / 2 ? d + L : d);

function gateState(t) {
  const ph = t % GATE_P;
  return ph < GATE_OPEN ? (ph > GATE_OPEN - GATE_WARN ? 1 : 0) : 2; // 0 open, 1 about to close, 2 closed
}

function inAlley(x, y, r, closed) {
  if (x < AX0 + r || x > AX1 - r || y < AY0 || y > AY1) return false;
  return !(closed && Math.abs(y - GY) < GT + r);
}

// Keep a donkey on the dirt (track band ∪ alley). Returns the push normal or null.
function confine(p, closed) {
  const pr = proj(p.x, p.y);
  const lim = HALF - p.r;
  if (Math.abs(pr.lat) <= lim || inAlley(p.x, p.y, p.r, closed)) return null;
  const c1 = at(pr.u, clamp(pr.lat, -lim, lim));
  let bx = c1.x, by = c1.y, bd = dist(p.x, p.y, c1.x, c1.y);
  if (pr.lat < 0 && p.x < C2X + 20) {
    let cx = clamp(p.x, AX0 + p.r, AX1 - p.r), cy = clamp(p.y, AY0, AY1);
    if (closed && Math.abs(cy - GY) < GT + p.r) cy = p.y < GY ? GY - GT - p.r : GY + GT + p.r;
    const d2 = dist(p.x, p.y, cx, cy);
    if (d2 < bd) { bx = cx; by = cy; bd = d2; }
  }
  if (bd < 1e-6) return null;
  const nx = (bx - p.x) / bd, ny = (by - p.y) / bd;
  p.x = bx; p.y = by;
  return { x: nx, y: ny };
}

// Fixed items (track distance + lateral offset).
const CARROTS = [[520, -40], [1250, 35], [1985, 52], [900, 30], [2240, -20], [1560, -50]];
const STICKS = [[400, 42], [1010, -48], [1400, 18], [2150, -36]];
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
};
function makeSticks() {
  const out = STICKS.map(([u, lat]) => { const a = at(u, lat - 28), b = at(u, lat + 28); return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }; });
  out.push({ x1: AX0 + 2, y1: 420, x2: AXC + 4, y2: 412 }); // half the alley is blocked: dodge it
  return out;
}

function teamProg(s, t) {
  let v = 0;
  for (const p of s.p) if (s.tm[p.i] === t) v += Math.min(p.prog, LAPS * L);
  return v;
}

// ---------------------------------------------------------------- computer player
const BOT_DELAY = [0.34, 0.2, 0.09];
const BOT_JIT = [0.11, 0.05, 0.015];

function palioBot(s, me, g, B) {
  const p = s.p[me];
  if (!p || s.over) return { x: 0, y: 0 };
  const lv = B.level, m = B.mem, D = BOT_DELAY[lv];
  const out = { x: 0, y: 0 };
  // --- rhythm: press so that the kick lands on the beat (the driver adds D seconds of reaction).
  if (m.nextK === undefined || m.nextK <= s.beatN) { m.nextK = s.beatN + 1; m.jit = (B.rng() - 0.5) * 2 * BOT_JIT[lv]; m.half = false; }
  const beatAt = (k) => s.beatT + (k - s.beatN) * s.P;
  const can = p.pl <= 0 && p.sn <= 0 && p.c <= 0 && !(p.fin && !g.teams);
  if (lv === 0 && !m.foga && B.rng() < 0.12 * g.dt) m.foga = g.t + 0.8 + B.rng(); // the squire gets carried away
  if (m.foga && g.t > m.foga) m.foga = 0;
  if (can && m.foga) {
    if (g.t - (m.lastMash || 0) > 0.13) { m.lastMash = g.t; out.tapA = true; }
  } else if (can && !m.brake) {
    if (g.t >= beatAt(m.nextK) - D + m.jit) { out.tapA = true; m.nextK++; m.jit = (B.rng() - 0.5) * 2 * BOT_JIT[lv]; m.half = false; }
    else if (lv === 2 && p.sb < 0.25 && !m.half && g.t >= beatAt(m.nextK) - s.P / 2 - D) { out.tapA = true; m.half = true; }
  }
  // --- steering: follow the racing line (or the alley), dodge sticks, grab carrots.
  const pr = proj(p.x, p.y);
  const sp = Math.max(120, p.v);
  if (m.alley) {
    // Waypoints through the alley; give up if the gate is shut ahead.
    const wps = [[AXC, AY0 + 30], [AXC - 12, 400], [AXC + 14, 470], [AXC, AY1 - 30], [C2X + 40, SB - 30]];
    while (m.wp < wps.length && (dist(p.x, p.y, wps[m.wp][0], wps[m.wp][1]) < 42 || (m.wp < 4 && p.y > wps[m.wp][1] + 10))) m.wp++;
    if (m.wp >= wps.length || p.x > C2X + 30) m.alley = false;
    else {
      const [tx, ty] = wps[m.wp];
      const closedAhead = p.y < GY && gateState(g.t + D) === 2 && p.y > AY0 - 40;
      m.brake = closedAhead && GY - p.y < 120;
      const d = Math.hypot(tx - p.x, ty - p.y) || 1;
      out.x = (tx - p.x) / d; out.y = (ty - p.y) / d;
      return shove(s, p, g, B, out);
    }
  }
  m.brake = false;
  // Decide on the shortcut while running down the top straight toward the left bend.
  const toBend = wrapU(U3 - pr.u);
  if (lv > 0 && !p.fin && toBend > -20 && toBend < 160 && !m.alley && m.decided !== Math.floor(p.prog / L)) {
    m.decided = Math.floor(p.prog / L);
    const eta = (toBend + 300) / sp + D;
    const margin = lv === 2 ? 0.45 : 1.0;
    let ok = true;
    for (let dtk = -0.2; dtk <= margin; dtk += 0.1) if (gateState(g.t + eta + dtk) === 2) ok = false;
    if (ok) { m.alley = true; m.wp = 0; }
    if (m.alley) return palioBot(s, me, g, B);
  }
  const look = 70 + sp * 0.35;
  const u2 = pr.u + look;
  const inBend = (u) => { const w = ((u % L) + L) % L; return (w > U1 && w < U2) || w > U3; };
  let lat = inBend(u2) ? -42 : inBend(u2 + 120) ? -15 : 8;
  if (lv > 0) {
    for (const st of s.sticks) {
      const sp2 = proj((st.x1 + st.x2) / 2, (st.y1 + st.y2) / 2);
      const du = wrapU(sp2.u - pr.u);
      if (du > 0 && du < 240 && Math.abs(sp2.lat - lat) < 52 && Math.abs(sp2.lat) < HALF) lat = sp2.lat > 0 ? sp2.lat - 62 : sp2.lat + 62;
    }
    s.car.forEach((c, k) => {
      if (!c.on) return;
      const du = wrapU(CARROTS[k][0] - pr.u);
      if (du > 40 && du < 260 && Math.abs(CARROTS[k][1] - lat) < (lv === 2 ? 75 : 45)) lat = CARROTS[k][1];
    });
  }
  if (s.geese.length && lv > 0) for (const q of s.geese) {
    const gp = proj(q.x, q.y), du = wrapU(gp.u - pr.u);
    if (du > 0 && du < 200 && Math.abs(gp.lat - lat) < 45) lat = clamp(gp.lat > lat ? gp.lat - 60 : gp.lat + 60, -HALF + 30, HALF - 30);
  }
  // Finished teammate: go and shove rivals instead.
  if (p.fin && g.teams) {
    let tgt = null, bd = 1e9;
    for (const q of s.p) if (!g.ally(q.i, me) && !q.fin) { const d = dist(p.x, p.y, q.x, q.y); if (d < bd) { bd = d; tgt = q; } }
    if (tgt) { const d = bd || 1; out.x = (tgt.x - p.x) / d; out.y = (tgt.y - p.y) / d; return shove(s, p, g, B, out); }
  }
  const tp = at(u2, clamp(lat, -HALF + 30, HALF - 30));
  const d = Math.hypot(tp.x - p.x, tp.y - p.y) || 1;
  out.x = (tp.x - p.x) / d; out.y = (tp.y - p.y) / d;
  return shove(s, p, g, B, out);
}

function shove(s, p, g, B, out) {
  if (p.cd > 0 || p.pl > 0) return out;
  const lv = B.level;
  if (lv === 0 && B.rng() > 0.02) return out;
  const fx = Math.cos(p.h), fy = Math.sin(p.h);
  for (const q of s.p) {
    if (q === p || g.ally(q.i, p.i)) continue;
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
    if (d < SHOVE_R - 10 && Math.abs(dx * fx + dy * fy) < 50) { out.tapB = true; break; }
  }
  return out;
}

// ---------------------------------------------------------------- game
export default {
  id: 'palio',
  name: 'Il Palio degli Asini',
  rule: 'Sprona l’asino a ritmo di tamburo: 3 giri, vince chi arriva!',
  verb: 'ARRI!',
  inspired: 'Palio di Siena · Mario Kart',
  cam: 'top',
  split: false,
  players: 4,
  teams: true,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Sprona', b: 'Spintone' },
  duration: DUR,
  variants: [
    { id: 'testardi', name: 'Asini Testardissimi', desc: 'Si piantano per un nonnulla e il tamburino cambia ritmo!' },
    { id: 'carote', name: 'Festa delle Carote', desc: 'Carote dappertutto: turbo per tutti!' },
    { id: 'oche', name: 'Le Oche del Podestà', desc: 'Uno stormo di oche attraversa la pista: occhio!' },
  ],
  help: {
    goal: 'Fai 3 giri della piazza prima degli altri. A squadre conta la somma dei giri: vince la contrada che porta all’arrivo entrambi gli asini.',
    dir: 'Sterza l’asino (nelle curve stai all’interno)',
    a: 'SPRONA a tempo col tamburo: sul colpo = scatto pieno. Se premi troppo in fretta l’asino si arrabbia e SI PIANTA!',
    b: 'SPINTONE: spingi di lato l’asino che ti sta accanto (contro le transenne!)',
    tips: ['Il vicolo nella curva a sinistra è una scorciatoia… se il portone è aperto', 'Le carote 🥕 danno un turbo, i bastoni a terra ti fanno inciampare', 'Guarda l’anello sotto il tuo asino: premi quando si chiude'],
  },

  init(g) {
    const n = g.n || 2;
    const tm = g.teams ? g.teams.slice(0, n) : [...Array(n).keys()];
    // Starting grid: abreast on the bottom straight; outer lanes start a little ahead (they have the longer bend).
    const lats = n === 2 ? [40, -40] : n === 3 ? [58, -58, 0] : [66, -66, 22, -22];
    let lat = lats;
    if (g.teams) { const sl = [[66, 22], [-22, -66]], used = [0, 0]; lat = tm.map((t) => sl[t][used[t]++ % 2]); }
    const nc = g.variant === 'carote' ? CARROTS.length : 3;
    const s = {
      t: 0, beatT: 0, beatN: 0, P: BEAT, last: false, over: false, tm, places: 0,
      sticks: makeSticks(),
      car: CARROTS.slice(0, nc).map(() => ({ on: true, at: 0 })),
      geese: [], nextTempo: 6,
      p: [...Array(n).keys()].map((i) => {
        const u0 = FIN_U - 34 + lat[i] * 0.5;
        const q = at(u0, lat[i]);
        return {
          i, x: q.x, y: q.y, h: 0, v: 0, ex: 0, ey: 0, r: DR, sb: 0, pl: 0, sn: 0, c: 0, cd: 0, trip: 0,
          lastTap: -9, q: 0, qk: 0, k: 0, prog: u0 - FIN_U, lu: u0, fin: 0, finT: 0, plants: 0, lap: 0, warned: false,
        };
      }),
    };
    if (g.variant === 'oche') {
      for (let k = 0; k < 7; k++) s.geese.push({ u: k < 4 ? 190 + k * 18 : U2 + 120 + (k - 4) * 22, ph: k * 0.9, x: 0, y: 0, hit: 0, sp: 0.5 + (k % 3) * 0.12 });
    }
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.t = g.t;
    // The drum.
    while (g.t >= s.beatT + s.P) {
      s.beatT += s.P; s.beatN++;
      if (!g.ended) g.sfx('tick', { vol: s.beatN % 4 === 0 ? 0.45 : 0.25, pitch: s.beatN % 4 === 0 ? 0.8 : 1 });
    }
    if (g.variant === 'testardi' && g.t >= s.nextTempo && !s.last) {
      s.nextTempo = g.t + 6;
      s.P = [0.36, 0.42, 0.5, 0.39][Math.floor(g.t / 6) % 4];
      g.say('IL TAMBURINO CAMBIA RITMO!');
    }
    const closed = gateState(g.t) === 2;
    if (s.gs !== gateState(g.t)) {
      const st = gateState(g.t);
      if (st === 2) g.sfx('crash', { vol: 0.5 }); else if (st === 0 && s.gs === 2) g.sfx('slide', { vol: 0.5 });
      s.gs = st;
    }
    // Carrots respawn.
    s.car.forEach((c) => { if (!c.on && g.t >= c.at) { c.on = true; } });
    // Geese wander across the straights.
    for (const q of s.geese) {
      q.hit = Math.max(0, q.hit - dt);
      const lat = Math.sin(g.t * q.sp + q.ph) * 150;
      const p0 = at(q.u + Math.sin(g.t * 0.7 + q.ph) * 30, lat);
      q.x = p0.x; q.y = p0.y;
    }

    const plantT = g.variant === 'testardi' ? 2.2 : PLANT_T;
    const stubK = g.variant === 'testardi' ? 1.6 : 1;
    for (const p of s.p) {
      const i = inp[p.i];
      p.cd = Math.max(0, p.cd - dt);
      p.trip = Math.max(0, p.trip - dt);
      p.sb = Math.max(0, p.sb - 0.18 * dt);
      if (p.pl > 0) { p.pl -= dt; p.v = 0; }
      if (p.sn > 0) p.sn -= dt;
      if (p.c > 0) p.c -= dt;
      const free = p.pl <= 0 && !s.over;
      // Steering toward the stick direction.
      if (free && Math.hypot(i.x, i.y) > 0.25) {
        const want = Math.atan2(i.y, i.x);
        const d = wrapAngle(want - p.h);
        const tr = TURN * (p.v < 120 ? 1.3 : 1) * dt;
        p.h += clamp(d, -tr, tr);
      }
      // Kicks on the beat.
      if (i.aP && free && p.sn <= 0) {
        const tau = i.aT >= 0 && Math.abs(i.aT - g.t) < 0.3 ? i.aT : g.t;
        const k = Math.round((tau - s.beatT) / s.P);
        const e = Math.abs(tau - (s.beatT + k * s.P));
        const since = tau - p.lastTap;
        p.lastTap = tau; p.qk++;
        if (p.c > 0) { p.q = 1; }
        else if (since < MASH) { p.v += 10; p.sb += 0.34 * stubK; p.q = 3; }
        else if (e < PERFECT) { p.v += 92; p.sb = Math.max(0, p.sb - 0.08); p.q = 1; }
        else if (e < GOODW) { p.v += 64; p.q = 2; }
        else { p.v += 34; p.sb += 0.14 * stubK; p.q = 3; }
        if (p.v > 120 && p.q === 1 && !g.ended) g.sfx('kick', { vol: 0.2, pitch: 1.2 + p.i * 0.05 });
        if (p.sb > 0.7 && !p.warned) { p.warned = true; g.text(p.x, p.y - 60, 'CALMA!', { color: '#ff8a3d', size: 34 }); g.sfx('wobble', { vol: 0.5 }); }
        if (p.sb < 0.5) p.warned = false;
        if (p.sb >= 1) {
          p.pl = plantT; p.sb = 0.3; p.v = 0; p.plants++; p.warned = false;
          g.text(p.x, p.y - 70, 'HIII-HAAA!', { color: '#ffd34d', size: 52 });
          g.sfx('horn', { pitch: 0.5 }); g.sfx('horn', { pitch: 0.42, vol: 0.6 });
          g.burst(p.x, p.y, { color: '#c9a87a', n: 14, speed: 160, size: 8 });
          g.shake(0.15); g.vibrate(p.i, 160);
        }
      }
      // Shove.
      if (i.bP && free && p.cd <= 0) {
        const fx = Math.cos(p.h), fy = Math.sin(p.h);
        let tgt = null, bd = SHOVE_R;
        for (const q of s.p) {
          if (q === p || g.ally(q.i, p.i)) continue;
          const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
          if (d < bd && Math.abs(dx * fx + dy * fy) < 58) { bd = d; tgt = q; }
        }
        p.k++;
        if (tgt) {
          const nx = (tgt.x - p.x) / (bd || 1), ny = (tgt.y - p.y) / (bd || 1);
          tgt.ex += nx * 430; tgt.ey += ny * 430; tgt.sn = Math.max(tgt.sn, 0.25);
          p.ex -= nx * 80; p.ey -= ny * 80;
          p.cd = SHOVE_CD;
          g.sfx('punch'); g.text((p.x + tgt.x) / 2, (p.y + tgt.y) / 2 - 50, 'SPINTONE!', { player: p.i, size: 40 });
          g.burst((p.x + tgt.x) / 2, (p.y + tgt.y) / 2, { color: '#fff', n: 12, speed: 260 });
          g.shake(0.25); g.vibrate(tgt.i, 90);
        } else { p.cd = 0.5; g.sfx('whoosh', { vol: 0.5 }); }
      }
      // Speed: decays, carrots pull it up, stunned donkeys skid.
      p.v *= damp(KEEP, dt);
      if (p.c > 0) p.v += (V_CARROT - p.v) * (1 - damp(0.02, dt));
      if (p.sn > 0) p.v *= damp(0.12, dt);
      p.v = clamp(p.v, 0, p.c > 0 ? V_CARROT + 10 : V_MAX);
      if (p.fin && !g.teams) p.v *= damp(0.3, dt);
      const k = damp(0.04, dt);
      p.ex *= k; p.ey *= k;
      p.x += (Math.cos(p.h) * p.v + p.ex) * dt;
      p.y += (Math.sin(p.h) * p.v + p.ey) * dt;
    }
    // Donkey vs donkey.
    for (let a = 0; a < s.p.length; a++) for (let b = a + 1; b < s.p.length; b++) {
      const A = s.p[a], Bq = s.p[b];
      const oa = { x: A.x, y: A.y, r: A.r, m: 1, vx: Math.cos(A.h) * A.v + A.ex, vy: Math.sin(A.h) * A.v + A.ey };
      const ob = { x: Bq.x, y: Bq.y, r: Bq.r, m: 1, vx: Math.cos(Bq.h) * Bq.v + Bq.ex, vy: Math.sin(Bq.h) * Bq.v + Bq.ey };
      const vax = oa.vx, vay = oa.vy, vbx = ob.vx, vby = ob.vy;
      const imp = collideCircles(oa, ob, 0.6);
      if (!imp && dist(oa.x, oa.y, ob.x, ob.y) >= A.r + Bq.r) continue;
      A.x = oa.x; A.y = oa.y; Bq.x = ob.x; Bq.y = ob.y;
      A.ex += (oa.vx - vax) * 0.6; A.ey += (oa.vy - vay) * 0.6; Bq.ex += (ob.vx - vbx) * 0.6; Bq.ey += (ob.vy - vby) * 0.6;
      if (imp > 220) { g.sfx('bonk', { vol: 0.5 }); g.burst((A.x + Bq.x) / 2, (A.y + Bq.y) / 2, { color: '#c9a87a', n: 6, speed: 140 }); }
    }
    // Walls, items, progress.
    for (const p of s.p) {
      const n = confine(p, closed);
      if (n) {
        const vx = Math.cos(p.h) * p.v + p.ex, vy = Math.sin(p.h) * p.v + p.ey;
        const vn = vx * n.x + vy * n.y;
        if (vn < 0) {
          const hit = -vn;
          p.ex -= n.x * vn * 0.6; p.ey -= n.y * vn * 0.6;
          if (hit > 170) {
            p.v *= 0.55;
            if (!g.ended) { g.sfx('bonk', { pitch: 0.8 }); g.burst(p.x - n.x * p.r, p.y - n.y * p.r, { color: '#e9d8b0', n: 8, speed: 180 }); }
            if (closed && Math.abs(p.y - GY) < 60 && p.x < AX1 + 5 && !g.ended) g.text(p.x, p.y - 50, 'PORTONE CHIUSO!', { color: '#ff5a3a', size: 34 });
          } else p.v *= 1 - clamp(hit / (p.v + 1), 0, 1) * 2.5 * dt;
        }
      }
      if (g.ended) continue;
      // Sticks: trip at speed.
      if (p.trip <= 0 && p.v > 110) for (const st of s.sticks) {
        if (segDist(p.x, p.y, st.x1, st.y1, st.x2, st.y2) < p.r * 0.75) {
          p.trip = 1; p.sn = 0.45; p.v *= 0.35;
          g.text(p.x, p.y - 55, 'INCIAMPA!', { color: '#e0a060', size: 38 }); g.sfx('crash', { vol: 0.6 }); g.vibrate(p.i, 80);
          g.burst(p.x, p.y, { color: '#8a5a32', n: 10, speed: 200 });
          break;
        }
      }
      // Carrots.
      s.car.forEach((c, k) => {
        if (!c.on) return;
        const q = at(CARROTS[k][0], CARROTS[k][1]);
        if (dist(p.x, p.y, q.x, q.y) < p.r + CARROT_R) {
          c.on = false; c.at = g.t + (g.variant === 'carote' ? 3 : 6);
          p.c = CARROT_T * (g.variant === 'carote' ? 1.2 : 1); p.sb = 0; p.pl = 0;
          g.sfx('powerup'); g.text(p.x, p.y - 60, 'CAROTA!', { color: '#ff9a2a', size: 44 });
          g.burst(q.x, q.y, { color: '#ff9a2a', n: 16, speed: 240 }); g.vibrate(p.i, 50);
        }
      });
      // Geese.
      for (const q of s.geese) {
        if (q.hit > 0 || dist(p.x, p.y, q.x, q.y) > p.r + 16) continue;
        q.hit = 1.2; q.ph += 1.8;
        p.sn = 0.6; p.v *= 0.4;
        g.sfx('quack'); g.text(q.x, q.y - 40, 'QUA QUA!', { color: '#fff', size: 34 });
        g.burst(q.x, q.y, { color: '#ffffff', n: 14, speed: 220, size: 7 });
      }
      // Progress along the track (laps).
      const pr = proj(p.x, p.y);
      p.prog += wrapU(pr.u - p.lu);
      p.lu = pr.u;
      const lap = Math.max(0, Math.floor(p.prog / L));
      if (lap > p.lap && !p.fin) {
        p.lap = lap;
        if (lap < LAPS) {
          g.sfx('point', { vol: 0.6 }); g.text(p.x, p.y - 60, lap === LAPS - 1 ? 'ULTIMO GIRO!' : `GIRO ${lap + 1}`, { player: p.i, size: 40 });
          if (lap === LAPS - 1 && !s.last) { s.last = true; s.P = BEAT_LAST; g.say('ULTIMO GIRO! IL TAMBURO ACCELERA!'); g.sfx('matchpoint'); }
        }
      }
      if (!p.fin && p.prog >= LAPS * L) {
        p.fin = ++s.places; p.finT = g.t;
        g.confetti(p.x, p.y); g.sfx('fanfare'); g.vibrate(p.i, 200);
        g.text(p.x, p.y - 70, p.fin === 1 ? 'PRIMO!' : `${p.fin}°`, { player: p.i, size: 60 });
      }
    }
    // End: first donkey home (free-for-all), or both donkeys of a team home.
    if (!g.ended) {
      if (!g.teams) {
        const w = s.p.find((p) => p.fin === 1);
        if (w) { g.slowmo(0.35, 0.8); g.end(w.i, 'Il Palio è suo!'); s.over = true; }
      } else {
        for (const t of [0, 1]) {
          const ms = s.p.filter((p) => s.tm[p.i] === t);
          if (ms.length && ms.every((p) => p.fin)) { g.slowmo(0.35, 0.8); g.end(ms[0].i, 'La contrada vince il Palio!'); s.over = true; break; }
        }
      }
    }
  },

  timeout(s) {
    s.over = true;
    const teams = [...new Set(s.tm)];
    let best = teams[0];
    for (const t of teams) if (teamProg(s, t) > teamProg(s, best)) best = t;
    const ms = s.p.filter((p) => s.tm[p.i] === best);
    return ms.reduce((a, p) => (p.prog > a.prog ? p : a), ms[0]).i;
  },

  bot: palioBot,

  view(s) {
    const gs = gateState(s.t);
    const ph = s.t % GATE_P;
    // Gate leaves: 0 = open, 1 = shut (swinging over 0.4 s).
    const gf = ph < GATE_OPEN ? clamp(1 - ph / 0.4, 0, 1) * (s.t > 1 ? 1 : 0) : clamp((ph - GATE_OPEN) / 0.4, 0, 1);
    const team = s.tm.some((t, k) => t !== k);
    return {
      gs, gf: r2(gf), bph: r2(clamp((s.t - s.beatT) / s.P, 0, 1)), last: s.last ? 1 : 0, tmode: team ? 1 : 0,
      car: s.car.map((c) => (c.on ? 1 : 0)),
      gz: s.geese.map((q) => ({ x: r1(q.x), y: r1(q.y), f: q.hit > 0 ? 1 : 0 })),
      p: s.p.map((p) => ({
        x: r1(p.x), y: r1(p.y), a: r2(p.h), v: Math.round(p.v), sb: r2(p.sb), pl: r2(p.pl), sn: r2(p.sn), c: r2(p.c), cd: r2(p.cd),
        q: p.q, qk: p.qk, k: p.k, fin: p.fin, tm: s.tm[p.i], lp: Math.min(LAPS, Math.max(0, Math.floor(p.prog / L))),
      })),
      hud: {
        p: s.p.map((p) => Math.min(LAPS, Math.max(0, Math.floor(p.prog / L)))), max: LAPS, label: 'Giri',
        bar: s.p.map((p) => r2(p.prog >= LAPS * L ? 1 : clamp((p.prog % L) / L, 0, 1))),
      },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  // ---------------------------------------------------------------- 3D: Piazza del Campo at sunset
  render3d: {
    assets: [
      'medieval/building_tower_A_red', 'medieval/building_church_red', 'medieval/building_home_A_yellow', 'medieval/building_home_B_red',
      'medieval/building_home_A_green', 'medieval/building_home_B_blue', 'medieval/building_tavern_yellow', 'medieval/building_market_green',
      'medieval/building_market_red', 'medieval/building_home_B_yellow', 'medieval/building_blacksmith_blue', 'medieval/building_well_red',
      'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow',
      'medieval/barrel', 'medieval/sack', 'medieval/crate_A_small', 'medieval/wheelbarrow', 'medieval/hills_A_trees', 'medieval/trees_B_medium',
      'dungeon/banner_patternA_red', 'dungeon/banner_patternB_green', 'dungeon/banner_patternC_yellow', 'dungeon/banner_triple_white',
      'dungeon/banner_shield_blue', 'dungeon/torch_lit', 'chars/Barbarian',
    ],
    build(K, r) {
      const n = r.n || K.n || 2;
      const lo = K.quality === 0;
      K.theme('tramonto', { fogNear: 2.6, fogFar: 7.5 });
      K.ground('lastre', { tile: 80, color: '#ead2b4' });
      const o = { n, carrots: [], donkeys: [], geese: [], flags: [] };
      // Painted square: brick fan of the Campo, the dirt ring, the alley, finish line (once).
      K.layer({ x0: -240, y0: -100, x1: W + 240, y1: H + 100, h: 0.5, once: true, transparent: true, maxPx: 2048, draw: (d) => drawSquare(d, true) });
      buildBarriers(K, o, lo);
      buildAlley(K, o);
      buildFountain(K, o);
      buildCrowd(K, o, lo);
      buildTown(K, o, lo);
      // Fixed items: sticks lying on the dirt, carrots (pool per spot).
      const stickMat = K.texMat('legno', [1, 3], { color: '#7a4f2a' });
      for (const st of makeSticks()) {
        const len = dist(st.x1, st.y1, st.x2, st.y2);
        const m = K.cyl(4, len, stickMat, { center: true, seg: 6 });
        K.place(m, (st.x1 + st.x2) / 2, (st.y1 + st.y2) / 2, 4);
        m.rotation.order = 'YXZ';
        m.rotation.set(0, -Math.atan2(st.y2 - st.y1, st.x2 - st.x1), Math.PI / 2);
      }
      const orange = K.mat('#ff8a1e', { rough: 0.5 }), leaf = K.mat('#3fae3a', { rough: 0.6 });
      CARROTS.forEach(([u, lat]) => {
        const g = K.group();
        const body = K.cone(9, 34, orange, { parent: g, seg: 10 });
        body.rotation.z = Math.PI; body.position.y = 40;
        for (const a of [0, 2.1, 4.2]) { const l = K.cone(4, 16, leaf, { parent: g, cast: false, seg: 5 }); l.position.set(Math.cos(a) * 3, 40, Math.sin(a) * 3); l.rotation.set(Math.sin(a) * 0.4, 0, Math.cos(a) * 0.4); }
        const glow = K.disc(26, K.glow('#ffb347', { opacity: 0.35, add: true }));
        g.scale.setScalar(1.5);
        const q = at(u, lat);
        o.carrots.push({ g, glow, x: q.x, y: q.y });
      });
      // Geese pool (variant).
      if (r.variant === 'oche') {
        const white = K.mat('#f6f4ee', { rough: 0.6 }), beak = K.mat('#ff9a1e');
        for (let k = 0; k < 7; k++) {
          const g = K.group();
          const b = K.ball(1, white, { parent: g, seg: 12 }); b.scale.set(16, 11, 10); b.position.y = 14;
          const nk = K.cyl(3.5, 18, white, { parent: g, seg: 6 }); nk.position.set(10, 18, 0); nk.rotation.z = -0.3;
          const hd = K.ball(5.5, white, { parent: g, cast: false }); hd.position.set(14, 36, 0);
          const bk = K.cone(2.5, 8, beak, { parent: g, cast: false, seg: 5 }); bk.position.set(19, 35, 0); bk.rotation.z = -Math.PI / 2;
          o.geese.push({ g, last: null });
        }
      }
      // Donkeys + riders.
      for (let i = 0; i < n; i++) {
        const D = buildDonkey(K, i);
        D.dec = K.decal(170);
        o.donkeys.push(D);
      }
      K.ambient('polvere', { n: 50, x0: -100, y0: 100, x1: 1100, y1: 900, h: 140 });
      K.ambient('petali', { n: 26, x0: -200, y0: -200, x1: 1200, y1: 1200, h: 420 });
      return o;
    },

    update(K, o, v, r) {
      const t = K.t;
      // Gate leaves and its lamp.
      const sw = (1 - v.gf) * 1.45;
      o.gateL.rotation.y = sw; o.gateR.rotation.y = -sw;
      o.lamp.material.color.set(v.gs === 2 ? '#ff2a1a' : v.gs === 1 ? (Math.floor(t * 8) % 2 ? '#ffd34d' : '#3a2a1a') : '#4cff6a');
      for (const F of o.flags) F.f.rotation.y = F.base + Math.sin(t * 2 + F.ph) * 0.15;
      // Drummer and drum: pulse on every beat.
      const pulse = Math.max(0, 1 - v.bph * 3);
      o.drum.scale.set(1 + pulse * 0.08, 1 - pulse * 0.1, 1 + pulse * 0.08);
      o.drummer.set(o.drumP.x - 34, o.drumP.y, { r: 30, look: 0, anim: '1H_Melee_Attack_Chop', animKey: Math.floor(t / (v.last ? BEAT_LAST : BEAT)), animSpeed: 1.6, gear: true, marker: false });
      animateCrowd(o.crowd, t, v.last);
      // Carrots.
      o.carrots.forEach((C, k) => {
        const on = !!v.car[k];
        C.g.visible = C.glow.visible = on;
        if (!on) return;
        K.place(C.g, C.x, C.y, Math.abs(Math.sin(t * 4 + k)) * 10);
        C.g.rotation.y = t * 2 + k;
        K.place(C.glow, C.x, C.y, 1.2);
        C.glow.scale.setScalar(1 + Math.sin(t * 6 + k) * 0.12);
      });
      // Geese.
      o.geese.forEach((G, k) => {
        const q = v.gz[k];
        G.g.visible = !!q;
        if (!q) return;
        const prev = G.last || q;
        const dx = q.x - prev.x, dy = q.y - prev.y;
        if (Math.abs(dx) + Math.abs(dy) > 0.05) G.a = Math.atan2(dy, dx);
        G.last = { x: q.x, y: q.y };
        K.place(G.g, q.x, q.y, q.f ? 20 + Math.abs(Math.sin(t * 20)) * 20 : Math.abs(Math.sin(t * 12 + k)) * 3);
        K.face(G.g, G.a || 0);
      });
      // Donkeys.
      let lead = 99;
      if (r.ended) v.p.forEach((p) => { if (p.fin) lead = Math.min(lead, p.fin); });
      v.p.forEach((p, i) => {
        const D = o.donkeys[i];
        if (!D) return;
        const sp = p.v;
        const planted = p.pl > 0;
        D.ph += (K.dt || 0) * (2 + sp / 32);
        const gal = sp > 40 && !planted ? clamp(sp / 250, 0.3, 1) : 0;
        const bob = Math.abs(Math.sin(D.ph)) * 5 * gal;
        K.place(D.g, p.x, p.y, bob);
        K.face(D.g, p.a);
        D.body.rotation.x = planted ? Math.sin(t * 25) * 0.05 : 0;
        D.legs.forEach((Lg, k) => { Lg.rotation.z = planted ? (k < 2 ? -0.35 : 0.35) : Math.sin(D.ph * 2 + (k < 2 ? 0 : Math.PI) + (k % 2) * 0.7) * 0.7 * gal; });
        D.head.rotation.z = planted ? -0.5 + Math.sin(t * 18) * 0.25 : -0.15 + Math.sin(D.ph * 2) * 0.08 * gal;
        D.ears.forEach((e, k) => { e.rotation.x = (k ? 1 : -1) * (planted ? 0.9 : 0.25 + Math.sin(t * 3 + k) * 0.1); });
        D.tail.rotation.z = 2.3 + Math.sin(t * (planted ? 20 : 6)) * 0.3;
        D.angry.visible = planted || p.sb > 0.7;
        if (D.angry.visible) K.place(D.angry, p.x, p.y, 135 + Math.sin(t * 10) * 5);
        D.carrot.visible = p.c > 0;
        D.carrot.rotation.z = Math.sin(t * 9) * 0.2;
        let mood = planted ? 'angry' : p.sn > 0 ? 'hurt' : 'ok', anim = 'Sit_Chair_Idle', animKey;
        if (p.k !== D.lastK) { D.lastK = p.k; D.shoveAt = t; }
        if (t - (D.shoveAt ?? -9) < 0.45) { anim = 'Unarmed_Melee_Attack_Punch_A'; animKey = p.k; }
        if (r.ended) mood = p.fin === lead ? 'happy' : 'dizzy';
        if (p.fin && t % 2 < 1.2) anim = 'Cheer';
        D.av.set(p.x - Math.cos(p.a) * 4, p.y - Math.sin(p.a) * 4, { r: 22, h: SADDLE_H + bob, look: p.a, mood, anim, animKey, gear: false });
        // Ground ring: the beat (closing ring) and the stubbornness meter.
        const qk = `${Math.round(v.bph * 6)}|${Math.round(p.sb * 8)}|${p.qk}|${planted ? 1 : 0}|${p.c > 0 ? 1 : 0}`;
        if (qk !== D.decKey) {
          D.decKey = qk;
          if (p.qk !== D.lastQk) { D.lastQk = p.qk; D.flashAt = t; D.flashQ = p.q; }
          D.dec.paint((d) => drawBeatRing(d, p, v.bph, K.col(i, 'light'), t - (D.flashAt ?? -9) < 0.25 ? D.flashQ : 0));
        }
        D.dec.at(p.x, p.y, 1.1);
      });
    },
  },

  render(d, v, r) {
    drawSquare(d, false);
    // Gate.
    const gc = v.gs === 2 ? '#ff3a2a' : v.gs === 1 ? '#ffd34d' : '#4cdf6a';
    d.rect(AX0, GY - GT, (AX1 - AX0) * v.gf, GT * 2, '#7a4f2a', gc, 3);
    for (const st of makeSticks()) d.line(st.x1, st.y1, st.x2, st.y2, '#6b4422', 9);
    v.car.forEach((on, k) => { if (on) { const q = at(CARROTS[k][0], CARROTS[k][1]); d.circle(q.x, q.y, 22, 'rgba(255,170,60,0.3)'); d.emoji('🥕', q.x, q.y, 40); } });
    for (const q of v.gz) d.emoji('🪿', q.x, q.y, 36);
    v.p.forEach((p, i) => {
      const fx = Math.cos(p.a), fy = Math.sin(p.a);
      d.shadow(p.x + 5, p.y + 8, 30, 18, 0.3);
      d.ring(p.x, p.y, 30 + (1 - v.bph) * 30, d.col(i, 'light') + '66', 3);
      d.ctx.save(); d.ctx.translate(p.x, p.y); d.ctx.rotate(p.a);
      d.rrect(-26, -12, 52, 24, 11, COATS[i % 4], '#2a1d16', 3);
      d.rect(-14, -13, 22, 26, d.col(i));
      d.circle(28, 0, 9, COATS[i % 4]);
      d.ctx.restore();
      if (p.sb > 0) d.arc(p.x, p.y, 36, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(p.sb, 0, 1), '#ff5a3a', 5);
      d.avatar(p.x - fx * 4, p.y - fy * 4, 18, i, { look: p.a, mood: p.pl > 0 ? 'angry' : p.sn > 0 ? 'hurt' : 'ok' });
      if (p.pl > 0) d.emoji('💢', p.x, p.y - 40, 30);
      if (p.c > 0) d.emoji('🥕', p.x + fx * 40, p.y + fy * 40, 26);
    });
  },
};

// ---------------------------------------------------------------- drawing
// The beat ring under a donkey: a ring closing on the donkey at every drum beat, the stubbornness arc, tap flash.
function drawBeatRing(d, p, bph, col, flash) {
  const k = 1 - bph;
  d.ring(0, 0, 36 + k * 40, col + (k > 0.85 ? 'ee' : '88'), 4);
  d.ring(0, 0, 34, col + '55', 3);
  if (p.sb > 0.02) d.arc(0, 0, 44, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(p.sb, 0, 1), p.sb > 0.7 ? '#ff3a2a' : '#ffa23a', 7);
  if (flash) d.ring(0, 0, 40, flash === 1 ? '#7dff7a' : flash === 2 ? '#ffe27a' : '#ff5a3a', 8);
  if (p.c > 0) d.ring(0, 0, 52, '#ff9a2a', 5);
}

// The square: brick fan in the middle (with the alley), the dirt ring, white rails, finish line.
function drawSquare(d, is3d) {
  const { ctx } = d;
  if (!is3d) { ctx.fillStyle = '#b98f6a'; ctx.fillRect(-300, -300, W + 600, H + 600); }
  // Outer pavement band around the track.
  ctx.save();
  stadium(ctx, HALF + 46);
  ctx.fillStyle = '#c9a27a'; ctx.fill();
  ctx.restore();
  // Dirt ring.
  ctx.save();
  stadium(ctx, HALF);
  stadium(ctx, -HALF, true);
  ctx.fillStyle = '#b47a44'; ctx.fill('evenodd');
  ctx.restore();
  // Infield: red-brick fan with travertine lines toward the fountain.
  ctx.save();
  stadium(ctx, -HALF);
  ctx.clip();
  ctx.fillStyle = '#b35a3c'; ctx.fillRect(0, 0, W, H);
  for (let y = CY - R; y < CY + R; y += 14) for (let x = C2X - R + ((y / 14) % 2) * 14; x < C1X + R; x += 28) d.rect(x, y, 24, 10, 'rgba(150,62,40,0.55)');
  for (let k = 0; k <= 8; k++) {
    const a = Math.PI * (0.05 + (0.9 * k) / 8);
    d.line(500, CY - 60, 500 + Math.cos(a) * 700, CY - 60 + Math.sin(a) * 700, 'rgba(235,225,200,0.75)', 6);
  }
  ctx.restore();
  // Alley: dirt strip through the infield of the left bend.
  d.rect(AX0, AY0 - 20, AX1 - AX0, AY1 - AY0 + 40, '#a8703e');
  d.line(AX0, AY0 - 10, AX0, AY1 + 10, '#e9dcc0', 4); d.line(AX1, AY0 - 10, AX1, AY1 + 10, '#e9dcc0', 4);
  // Dirt texture: hoof prints and pebbles (deterministic).
  let seed = 777;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let k = 0; k < 520; k++) {
    const q = at(rnd() * L, (rnd() - 0.5) * 2 * (HALF - 6));
    d.circle(q.x, q.y, 2 + rnd() * 5, rnd() < 0.5 ? 'rgba(90,54,26,0.4)' : 'rgba(220,180,130,0.35)');
  }
  // White rails painted at the edges.
  ctx.save(); stadium(ctx, HALF); ctx.strokeStyle = '#f2ead8'; ctx.lineWidth = 5; ctx.stroke(); ctx.restore();
  ctx.save(); stadium(ctx, -HALF); ctx.strokeStyle = '#f2ead8'; ctx.lineWidth = 5; ctx.stroke(); ctx.restore();
  // Finish line: checkered across the bottom straight.
  const fx = C2X + FIN_U;
  for (let k = 0; k < 12; k++) for (let j = 0; j < 2; j++) d.rect(fx - 10 + j * 10, SB - HALF + k * 15, 10, 15, (k + j) % 2 ? '#111' : '#fff');
  // Direction arrows on the straights.
  for (const [x, y, a] of [[560, SB, 0], [440, ST, Math.PI]]) {
    d.ctx.save(); d.ctx.translate(x, y); d.ctx.rotate(a);
    d.poly([30, 0, -10, -22, -10, 22], 'rgba(255,240,210,0.35)');
    d.ctx.restore();
  }
}

// Stadium outline offset by `off` from the centerline (path only).
function stadium(ctx, off, ccw = false) {
  const rr = R + off;
  ctx.beginPath();
  if (!ccw) {
    ctx.moveTo(C2X, CY + rr); ctx.lineTo(C1X, CY + rr);
    ctx.arc(C1X, CY, rr, Math.PI / 2, -Math.PI / 2, true);
    ctx.lineTo(C2X, CY - rr);
    ctx.arc(C2X, CY, rr, -Math.PI / 2, Math.PI / 2, true);
  } else {
    ctx.moveTo(C2X, CY + rr);
    ctx.arc(C2X, CY, rr, Math.PI / 2, -Math.PI / 2, false);
    ctx.lineTo(C1X, CY - rr);
    ctx.arc(C1X, CY, rr, -Math.PI / 2, Math.PI / 2, false);
    ctx.lineTo(C2X, CY + rr);
  }
  ctx.closePath();
}

// ---------------------------------------------------------------- 3D builders
const SADDLE_H = 31;

// Instanced boxes (one draw call): items [{x, y, h, a, w, d, hh, c}].
function instBoxes(K, items, rough = 0.7) {
  const { THREE } = K;
  const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
  const im = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: rough }), items.length);
  im.userData.ownGeo = true;
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
  items.forEach((it, k) => {
    K.p(it.x, it.y, it.h || 0, p);
    q.setFromAxisAngle(up, -(it.a || 0));
    M.compose(p, q, sc.set(it.w, it.hh, it.d));
    im.setMatrixAt(k, M);
    im.setColorAt(k, c.set(it.c));
  });
  im.castShadow = true; im.receiveShadow = true;
  K.root.add(im);
  return im;
}

// Padded mattresses on the outer edge (contrada colors) and a wooden rail on the inner edge (open at the alley).
function buildBarriers(K, o, lo) {
  const pads = [], rails = [], posts = [];
  const cols = ['#c0392b', '#f1c40f', '#2e86de', '#27ae60', '#ecf0f1', '#8e44ad'];
  const step = lo ? 46 : 32;
  for (let u = 0, k = 0; u < L; u += step, k++) {
    const q = at(u + step / 2, HALF + 10), a = Math.atan2(q.ty, q.tx);
    pads.push({ x: q.x, y: q.y, a, w: step - 2, d: 18, hh: 34, c: cols[Math.floor(k / 3) % cols.length] });
    const qi = at(u + step / 2, -HALF - 6);
    if (qi.x < AX1 + 6 && qi.x > AX0 - 6 && qi.y > AY0 - 40 && qi.y < AY1 + 40) continue; // alley mouths
    rails.push({ x: qi.x, y: qi.y, h: 22, a, w: step, d: 6, hh: 7, c: '#f2ead8' });
    posts.push({ x: qi.x, y: qi.y, a, w: 7, d: 7, hh: 30, c: '#8a5a32' });
  }
  instBoxes(K, pads, 0.85);
  instBoxes(K, rails, 0.6);
  instBoxes(K, posts, 0.8);
}

// The shortcut alley: house walls on both sides, a wooden gate with a lamp, torches.
function buildAlley(K, o) {
  const wall = K.texMat('muro', [3, 1], { color: '#e3c9a3' });
  const roof = K.texMat('tetto', [3, 1], { color: '#c46a44' });
  for (const [x0, x1] of [[AX0 - 70, AX0 - 6], [AX1 + 6, AX1 + 64]]) {
    for (const [y0, y1] of [[AY0 + 20, GY - 30], [GY + 30, AY1 - 20]]) {
      const b = K.box(x1 - x0, y1 - y0, 70, wall);
      K.place(b, (x0 + x1) / 2, (y0 + y1) / 2, 35);
      const rf = K.box(x1 - x0 + 8, y1 - y0 + 8, 10, roof);
      K.place(rf, (x0 + x1) / 2, (y0 + y1) / 2, 72);
    }
  }
  // Gate pillars and leaves (hinged at the pillars).
  const stone = K.texMat('pietra', [1, 2], { color: '#cfc6b8' });
  for (const x of [AX0 - 8, AX1 + 8]) K.place(K.box(16, 22, 90, stone), x, GY, 45);
  K.place(K.box(AX1 - AX0 + 34, 22, 14, stone), AXC, GY, 96);
  const plank = K.texMat('legno', [1, 2], { color: '#7a4f2a' });
  const mk = (x, sign) => {
    const g = K.group();
    K.place(g, x, GY, 0);
    const leaf = K.box((AX1 - AX0) / 2 - 2, 8, 64, plank, { parent: g });
    leaf.position.set(sign * ((AX1 - AX0) / 4), 34, 0);
    return g;
  };
  o.gateL = mk(AX0, 1); o.gateR = mk(AX1, -1);
  o.lamp = K.ball(8, K.glow('#4cff6a', { unique: true }), { cast: false });
  K.place(o.lamp, AXC, GY, 112);
  K.place(K.model('dungeon/torch_lit', { height: 60 }), AX0 - 20, AY0 + 6);
  K.place(K.model('dungeon/torch_lit', { height: 60 }), AX1 + 20, AY1 - 6);
  if (K.quality > 0) K.light(AXC, GY, 120, '#ffb35c', 1.6, { flicker: 0.5, dist: 320 });
}

// Fonte Gaia in the middle of the square.
function buildFountain(K, o) {
  const stone = K.texMat('pietra', [4, 1], { color: '#e8dfcf' });
  const fx = 545, fy = 500, w = 190, h = 110;
  K.place(K.box(w + 20, h + 20, 14, stone), fx, fy, 7);
  for (const [x, y, ww, hh] of [[fx, fy - h / 2, w, 10], [fx, fy + h / 2, w, 10], [fx - w / 2, fy, 10, h], [fx + w / 2, fy, 10, h]]) K.place(K.box(ww, hh, 26, stone), x, y, 13);
  K.place(K.box(w + 10, 14, 70, stone), fx, fy - h / 2 - 8, 35);
  K.water(fx - w / 2 + 6, fy - h / 2 + 6, fx + w / 2 - 6, fy + h / 2 - 6, { h: 20, tile: 80 });
  K.place(K.model('medieval/building_well_red', { size: 60 }), fx, fy - h / 2 - 2, 70);
}

// Crowd in the middle of the square (instanced) behind the inner rail, plus flags of the contrade.
function buildCrowd(K, o, lo) {
  const { THREE } = K;
  const spots = [];
  const N = lo ? 70 : 150;
  let seed = 99;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let k = 0; spots.length < N && k < N * 20; k++) {
    const x = 380 + rnd() * 400, y = CY - 165 + rnd() * 330;
    if (x > 435 && x < 655 && y > 420 && y < 580) continue; // fountain
    const pr = proj(x, y);
    if (pr.lat > -HALF - 22) continue;
    spots.push({ x, y, ph: rnd() * TAU, s: 0.9 + rnd() * 0.25 });
  }
  // Spectators also along the outer pavement (bottom side is low so the track stays visible).
  for (let u = 0; u < L && !lo; u += 55) {
    const q = at(u, HALF + 46 + (Math.floor(u / 55) % 2) * 18);
    if (q.y > 820 && q.x > 380 && q.x < 620) continue;
    spots.push({ x: q.x, y: q.y, ph: u * 0.37, s: 1 });
  }
  const bodyG = new THREE.CylinderGeometry(8, 11, 24, 8); bodyG.translate(0, 12, 0);
  const headG = new THREE.SphereGeometry(7.5, 10, 8);
  const bodies = new THREE.InstancedMesh(bodyG, new THREE.MeshStandardMaterial({ roughness: 0.8 }), spots.length);
  const heads = new THREE.InstancedMesh(headG, new THREE.MeshStandardMaterial({ roughness: 0.7 }), spots.length);
  bodies.userData.ownGeo = heads.userData.ownGeo = true;
  const shirts = ['#c0392b', '#2e86de', '#27ae60', '#f1c40f', '#8e44ad', '#e67e22', '#ecf0f1', '#16a085', '#d35400'];
  const skins = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
  const c = new THREE.Color();
  spots.forEach((s, k) => { bodies.setColorAt(k, c.set(shirts[(k * 7) % shirts.length])); heads.setColorAt(k, c.set(skins[(k * 3) % skins.length])); });
  K.root.add(bodies); K.root.add(heads);
  o.crowd = { K, bodies, heads, spots, m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3() };
  animateCrowd(o.crowd, 0, 0);
  // Contrade flags on poles around the square.
  const fl = [[-90, 120], [1090, 120], [-90, 880], [1090, 880], [200, 60], [800, 60], [180, 950], [820, 950]];
  fl.forEach(([x, y], k) => {
    const f = K.model(`medieval/flag_${FLAG[k % 4]}`, { height: 170 });
    K.place(f, x, y);
    K.face(f, Math.atan2(CY - y, 500 - x));
    o.flags.push({ f, base: f.rotation.y, ph: k * 0.9 });
  });
}

function animateCrowd(C, t, last) {
  const amp = last ? 8 : 3, sp = last ? 12 : 5;
  C.spots.forEach((q, k) => {
    const j = Math.max(0, Math.sin(t * sp + q.ph)) * amp;
    C.K.p(q.x, q.y, j, C.p);
    C.s.set(q.s, q.s, q.s);
    C.m.compose(C.p, C.q, C.s);
    C.bodies.setMatrixAt(k, C.m);
    C.p.y += 30 * q.s;
    C.m.compose(C.p, C.q, C.s);
    C.heads.setMatrixAt(k, C.m);
  });
  C.bodies.instanceMatrix.needsUpdate = true;
  C.heads.instanceMatrix.needsUpdate = true;
}

// Palazzo with the tall tower on the far side, rows of houses all around, banners, the drummer's stage, the Palio cloth.
function buildTown(K, o, lo) {
  const place = (name, x, y, a, opt) => { const m = K.model(name, opt); K.place(m, x, y); K.face(m, a); return m; };
  const down = Math.PI / 2;
  place('medieval/building_tower_A_red', 640, -150, down, { height: 620 });
  place('medieval/building_church_red', 360, -170, down, { size: 360 });
  place('medieval/building_market_red', 860, -90, down, { size: 220 });
  place('medieval/building_market_green', 140, -90, down, { size: 220 });
  const homes = ['medieval/building_home_A_yellow', 'medieval/building_home_B_red', 'medieval/building_home_A_green', 'medieval/building_home_B_blue', 'medieval/building_tavern_yellow', 'medieval/building_home_B_yellow', 'medieval/building_blacksmith_blue'];
  const sideL = [[-230, 160], [-250, 360], [-250, 560], [-230, 780]], sideR = [[1230, 160], [1250, 360], [1250, 560], [1230, 780]];
  sideL.forEach(([x, y], k) => place(homes[k % homes.length], x, y, 0, { size: 210 }));
  sideR.forEach(([x, y], k) => place(homes[(k + 3) % homes.length], x, y, Math.PI, { size: 210 }));
  [[60, 1130], [940, 1130], [-170, 1020], [1170, 1020]].forEach(([x, y], k) => place(homes[(k + 2) % homes.length], x, y, -down, { size: 200 }));
  // Hanging banners in front of the palazzi.
  const banners = ['dungeon/banner_patternA_red', 'dungeon/banner_patternB_green', 'dungeon/banner_patternC_yellow', 'dungeon/banner_triple_white', 'dungeon/banner_shield_blue'];
  [[230, -40], [500, -60], [770, -40], [-110, 260], [-110, 660], [1110, 260], [1110, 660]].forEach(([x, y], k) => {
    const m = K.model(banners[k % banners.length], { height: 130 });
    K.place(m, x, y);
    K.face(m, Math.atan2(CY - y, 500 - x));
  });
  K.scatter('medieval/barrel', [{ x: -80, y: 470, rot: 1 }, { x: -60, y: 510, rot: 2 }, { x: 1080, y: 480, rot: 0.3 }], { size: 42 });
  K.scatter('medieval/sack', [{ x: -90, y: 545 }, { x: 1090, y: 525, rot: 1 }], { size: 36 });
  K.scatter('medieval/crate_A_small', [{ x: 1075, y: 440, rot: 0.4 }, { x: -70, y: 430, rot: 0.2 }], { size: 36 });
  K.scatter('medieval/wheelbarrow', [{ x: 1100, y: 600, rot: 2.6 }], { size: 70 });
  K.scatter('medieval/hills_A_trees', [{ x: -900, y: -500, rot: 0.3 }, { x: 1900, y: -500, rot: 2 }, { x: 500, y: -1100, rot: 1 }], { size: 1000 });
  K.scatter('medieval/trees_B_medium', [{ x: -520, y: 0 }, { x: 1520, y: 0, rot: 1 }, { x: -560, y: 900, rot: 2 }, { x: 1560, y: 900, rot: 3 }], { size: 230 });
  // Drummer's stage by the finish line (outer side, near the camera) and the Palio cloth on its pole.
  const wood = K.texMat('legno', [2, 1], { color: '#8a5a32' });
  o.drumP = { x: 300, y: 935 };
  K.place(K.box(130, 70, 12, wood), o.drumP.x, o.drumP.y, 0);
  o.drum = K.group();
  K.place(o.drum, o.drumP.x + 10, o.drumP.y, 12);
  const shell = K.cyl(22, 30, K.mat('#b3262e', { rough: 0.6 }), { parent: o.drum, seg: 16 });
  shell.rotation.x = 0;
  const skin = K.cyl(22.5, 2, K.mat('#f4ead2'), { parent: o.drum, seg: 16, cast: false });
  skin.position.y = 30;
  o.drummer = K.npc('barbarian', { marker: false });
  const pole = K.cyl(4, 230, K.mat('#ffd34d', { metal: 0.6, rough: 0.3 }), { seg: 8 });
  K.place(pole, C2X + FIN_U, SB + HALF + 40);
  const cloth = K.canvasTex(96, 192, (d) => {
    d.rect(0, 0, 96, 192, '#f4ead2');
    d.rect(4, 4, 88, 184, null, '#b3262e', 6);
    d.circle(48, 70, 30, '#2f6fd6', '#ffd34d', 4);
    d.star(48, 70, 18, '#ffd34d');
    for (let k = 0; k < 4; k++) d.rect(14 + k * 18, 130, 12, 40, ['#c0392b', '#f1c40f', '#27ae60', '#2e86de'][k]);
  });
  const palio = K.box(60, 3, 120, K.mat('#ffffff', { map: cloth, side: 2, rough: 0.8 }));
  K.place(palio, C2X + FIN_U + 32, SB + HALF + 40, 100);
  K.place(K.model('dungeon/torch_lit', { height: 70 }), o.drumP.x - 80, o.drumP.y);
  if (K.quality > 0) K.light(o.drumP.x, o.drumP.y - 40, 90, '#ffb35c', 1.4, { flicker: 0.5, dist: 360 });
}

function buildDonkey(K, i) {
  const g = K.group();
  const coat = K.mat(COATS[i % 4], { rough: 0.7 });
  const pale = K.mat('#e8e2d6', { rough: 0.7 });
  const dark = K.mat('#2a2522', { rough: 0.8 });
  const body = K.group(g);
  const torso = K.ball(1, coat, { parent: body, seg: 16 });
  torso.scale.set(32, 18, 15); torso.position.set(0, 44, 0);
  const cloth = K.cyl(1, 1, K.mat(K.col(i), { rough: 0.75, side: 2 }), { parent: body, open: true, seg: 16 });
  cloth.scale.set(26, 20, 19); cloth.position.set(-2, 34, 0);
  const saddleTop = K.ball(1, K.mat(K.col(i, 'light'), { rough: 0.7 }), { parent: body, seg: 12, cast: false });
  saddleTop.scale.set(20, 7, 17); saddleTop.position.set(-2, 56, 0);
  const head = K.group(g);
  head.position.set(28, 56, 0);
  const neck = K.box(14, 12, 26, coat, { parent: head });
  neck.position.set(4, 4, 0); neck.rotation.z = -0.5;
  const skull = K.box(28, 13, 15, coat, { parent: head });
  skull.position.set(16, 16, 0); skull.rotation.z = -0.35;
  const muzzle = K.box(10, 12, 12, pale, { parent: head, cast: false });
  muzzle.position.set(29, 11, 0); muzzle.rotation.z = -0.35;
  const ears = [];
  for (const z of [-5, 5]) {
    const e = K.cone(4.5, 26, coat, { parent: head, seg: 6 });
    e.position.set(8, 24, z);
    ears.push(e);
  }
  const tail = K.cyl(2.5, 26, dark, { parent: g, r2: 4, seg: 6 });
  tail.position.set(-30, 48, 0);
  const legs = [];
  for (const [lx, lz] of [[18, 8], [18, -8], [-18, 8], [-18, -8]]) {
    const piv = K.group(g);
    piv.position.set(lx, 34, lz);
    const leg = K.cyl(4, 34, coat, { parent: piv, seg: 6 });
    leg.position.y = -34;
    const hoof = K.cyl(4.6, 5, dark, { parent: piv, seg: 6, cast: false });
    hoof.position.y = -34;
    legs.push(piv);
  }
  // Carrot on a stick dangling in front of the nose (shown during a carrot boost).
  const carrot = K.group(g);
  carrot.position.set(30, 92, 0);
  const rod = K.cyl(1.5, 50, K.mat('#7a4f2a'), { parent: carrot, seg: 5, cast: false });
  rod.rotation.z = -Math.PI / 2 + 0.3;
  const cr = K.cone(5, 18, K.mat('#ff8a1e'), { parent: carrot, seg: 8, cast: false });
  cr.position.set(46, -8, 0); cr.rotation.z = Math.PI;
  carrot.visible = false;
  const angry = K.emoji('💢', 40);
  angry.visible = false;
  g.scale.setScalar(1.15);
  return { g, body, head, ears, tail, legs, carrot, angry, ph: i * 1.7, av: K.avatar(i) };
}
