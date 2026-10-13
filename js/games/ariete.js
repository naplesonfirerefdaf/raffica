// All'Ariete! — siege tug-of-war around a huge battering ram (top-down).
// dir = move, A = heave the ram (on the drum beat = triple push; on the same beat as a teammate = SYNC bonus),
// B = shoulder charge (knocks enemies off the ram). Smash the enemy gate! Boiling oil falls near threatened gates.
// Teams (2 vs 2): team 0 defends the bottom gate, team 1 the top one. Free-for-all: 2 players → the same two gates,
// 3–4 players → a cross-shaped square with one gate each (seat 0 bottom, 1 top, 2 left, 3 right).
import { clamp, damp, dist, norm, collideCircles, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500;
const DURATION = 50;
// Corridor (2 gates) and cross (3–4 gates) layouts.
const COR = { x0: 170, x1: 830, y0: 60, y1: 940 };
const XA = 330, XB = 670, XE0 = 40, XE1 = 960;
const GATE_HALF = 150;
const SIDE = [[0, 1], [0, -1], [-1, 0], [1, 0]];
const TEAM_COL = ['#ff4b5c', '#3fa9ff'];
const FLAG = ['red', 'blue', 'green', 'yellow'];

const P_R = 36, P_ACC = 2000, P_MAX = 400, P_KEEP = 0.08;
const DASH_V = 900, DASH_T = 0.18, DASH_CD = 1.2, KNOCK_V = 620, STUN_T = 0.75;
const RAM_R = 62, RAM_M = 9, RAM_KEEP = 0.32, RAM_MAX = 560;
const PUSH_J = 70, BEAT_MUL = 3.2, SYNC_J = 160, BEAT_WIN = 0.13, REACH = 26, PUSH_CD = 0.3, MISS_CD = 0.45;
const GATE_HP = 80, HIT_MIN = 60;
const OIL_ZONE = 320, OIL_R = 85, OIL_WARN = 1.05, OIL_CD = 3.2, OIL_STUN = 1.0;
const P0 = 0.62, P1 = 0.48, FURIA = 12;
const MOODS = ['ok', 'happy', 'angry', 'hurt', 'dizzy'];

// ---------------------------------------------------------------- arena
function layout(S) {
  if (S <= 2) {
    return {
      L: 'c', S,
      rects: [COR],
      poly: [COR.x0, COR.y0, COR.x1, COR.y0, COR.x1, COR.y1, COR.x0, COR.y1],
      gates: [{ x: CX, y: COR.y1, nx: 0, ny: -1 }, { x: CX, y: COR.y0, nx: 0, ny: 1 }],
      rocks: [{ x: 270, y: 500, r: 48, k: 0 }, { x: 730, y: 500, r: 48, k: 0 }, { x: 420, y: 255, r: 34, k: 1 }, { x: 580, y: 745, r: 34, k: 1 }],
    };
  }
  const gates = [[CX, XE1], [CX, XE0], [XE0, CY], [XE1, CY]].slice(0, S).map(([x, y], k) => ({ x, y, nx: -SIDE[k][0], ny: -SIDE[k][1] }));
  const rocks = [[420, 790], [580, 210], [210, 420], [790, 580]].slice(0, S).map(([x, y]) => ({ x, y, r: 40, k: 0 }));
  const poly = S >= 4
    ? [XA, XE0, XB, XE0, XB, XA, XE1, XA, XE1, XB, XB, XB, XB, XE1, XA, XE1, XA, XB, XE0, XB, XE0, XA, XA, XA]
    : [XA, XE0, XB, XE0, XB, XE1, XA, XE1, XA, XB, XE0, XB, XE0, XA, XA, XA];
  return { L: 'x', S, rects: [{ x0: XA, y0: XE0, x1: XB, y1: XE1 }, { x0: XE0, y0: XA, x1: S >= 4 ? XE1 : XB, y1: XB }], poly, gates, rocks };
}

// Keep a circle inside the union of rects. Returns null (inside) or { ux, uy (inward push), vn (outward impact speed) }.
function confine(o, rects, e) {
  let bx = 0, by = 0, bd = Infinity;
  for (const R of rects) {
    const cx = clamp(o.x, R.x0 + o.r, R.x1 - o.r), cy = clamp(o.y, R.y0 + o.r, R.y1 - o.r);
    const d = (cx - o.x) ** 2 + (cy - o.y) ** 2;
    if (d === 0) return null;
    if (d < bd) { bd = d; bx = cx; by = cy; }
  }
  const l = Math.sqrt(bd);
  const ux = (bx - o.x) / l, uy = (by - o.y) / l;
  o.x = bx; o.y = by;
  const vn = o.vx * ux + o.vy * uy;
  if (vn < 0) { o.vx -= (1 + e) * vn * ux; o.vy -= (1 + e) * vn * uy; }
  return { ux, uy, vn: -vn };
}

function rockBounce(o, k, e) {
  const dx = o.x - k.x, dy = o.y - k.y, d = Math.hypot(dx, dy), min = o.r + k.r;
  if (d >= min || d === 0) return 0;
  const nx = dx / d, ny = dy / d;
  o.x = k.x + nx * min; o.y = k.y + ny * min;
  const vn = o.vx * nx + o.vy * ny;
  if (vn < 0) { o.vx -= (1 + e) * vn * nx; o.vy -= (1 + e) * vn * ny; }
  return -vn;
}

const lateral = (gt, x, y) => (x - gt.x) * -gt.ny + (y - gt.y) * gt.nx;
const inward = (gt, x, y) => (x - gt.x) * gt.nx + (y - gt.y) * gt.ny;

function spawnPos(s, p) {
  const mates = s.p.filter((q) => q.side === p.side);
  const m = mates.indexOf(p), c = mates.length;
  if (s.lay.L === 'c') return { x: CX + (m - (c - 1) / 2) * 170, y: p.side === 0 ? 850 : 150 };
  const [ux, uy] = SIDE[p.side];
  return { x: CX + ux * 330 + (m - (c - 1) / 2) * 120 * Math.abs(uy), y: CY + uy * 330 + (m - (c - 1) / 2) * 120 * Math.abs(ux) };
}

function placeRams(s) {
  const two = s.rams.length > 1;
  s.rams.forEach((r, k) => {
    if (!two) { r.x = CX; r.y = CY; } else if (s.lay.L === 'c') { r.x = CX + (k ? 95 : -95); r.y = CY; } else { r.x = CX + (k ? 80 : -80); r.y = CY + (k ? 80 : -80); }
    r.vx = 0; r.vy = 0; r.wk = 0;
  });
}

const inPuddle = (s, x, y) => s.slick && s.oil.some((o) => o.w <= 0 && o.l > 0 && dist(x, y, o.x, o.y) < OIL_R);

// Beat offset of a press at time tp: { on, id } (id = the beat the press belongs to).
function beatOf(s, tp) {
  const since = tp - s.bT;
  const toPrev = Math.abs(since), toNext = Math.abs(s.P - since);
  return { on: Math.min(toPrev, toNext) < BEAT_WIN, id: toPrev <= toNext ? s.bn : s.bn + 1 };
}

function heave(s, p, i, g) {
  if (p.pcd > 0) return;
  let ram = null, bd = Infinity, rk = -1;
  s.rams.forEach((r, k) => { const d = dist(p.x, p.y, r.x, r.y) - r.r - p.r; if (d < REACH && d < bd) { bd = d; ram = r; rk = k; } });
  if (!ram) { p.pcd = 0.12; return; }
  const tp = clamp(i.aT >= 0 ? i.aT : g.t, g.t - 0.25, g.t);
  const b = beatOf(s, tp);
  const n = norm(ram.x - p.x, ram.y - p.y);
  const fur = s.fu ? 1.3 : 1;
  const J = PUSH_J * (b.on ? BEAT_MUL : 1) * fur * (RAM_M / ram.m);
  ram.vx += n.x * J; ram.vy += n.y * J;
  p.vx -= n.x * 70; p.vy -= n.y * 70;
  p.pcd = b.on ? PUSH_CD : MISS_CD; p.pn++; p.ps = 0.25; p.pb = b.on ? b.id : -1; p.pr = rk;
  const cx = p.x + n.x * p.r, cy = p.y + n.y * p.r;
  if (b.on) {
    g.sfx('punch', { vol: 0.45, pitch: 1.15 });
    g.burst(cx, cy, { player: p.i, n: 7, speed: 170 });
    // Sync: a teammate heaved the same ram on the same beat.
    const mate = s.p.find((q) => q !== p && !q.out && g.ally(q.i, p.i) && q.pb === b.id && q.pr === rk);
    if (mate && s.syncB[p.side] !== b.id) {
      s.syncB[p.side] = b.id;
      const m2 = norm(ram.x - mate.x, ram.y - mate.y);
      const a = norm(n.x + m2.x, n.y + m2.y);
      ram.vx += a.x * SYNC_J * fur; ram.vy += a.y * SYNC_J * fur;
      p.sy = 0.6; mate.sy = 0.6; s.sync++;
      g.text(ram.x, ram.y - 110, 'SINCRONIA!', { color: '#ffd84a', size: 56 });
      g.ring(ram.x, ram.y, { color: '#ffd84a', r: 170 });
      g.sfx('tada', { vol: 0.45 }); g.shake(0.18);
    }
  } else {
    g.sfx('bonk', { vol: 0.3, pitch: 0.75 });
    if (p.miss <= 0) { g.text(p.x, p.y - 70, 'FUORI TEMPO!', { color: '#d9d2c4', size: 26 }); p.miss = 1.2; }
  }
}

function hitGate(s, gt, geo, vn, g) {
  const dmg = Math.min(34, (vn - 40) * 0.085) * (s.fu ? 1.2 : 1);
  gt.hp = Math.max(0, gt.hp - dmg);
  gt.hit = 0.6;
  const big = dmg > 14;
  g.sfx(big ? 'crash' : 'break', { vol: 0.9, pitch: big ? 0.8 : 1.1 });
  g.burst(geo.x + geo.nx * 20, geo.y + geo.ny * 20, { color: '#a8743f', n: big ? 30 : 14, speed: big ? 520 : 300, size: 9 });
  g.text(geo.x + geo.nx * 120, geo.y + geo.ny * 120, `-${Math.round(dmg)}`, { color: '#ffb35c', size: big ? 64 : 44 });
  g.shake(big ? 0.6 : 0.3); g.hitstop(big ? 0.12 : 0.06);
  for (const p of s.p) if (p.side === gt.k) g.vibrate(p.i, big ? 160 : 70);
  if (gt.hp > 0) { if (big) g.say(gt.hp < GATE_HP * 0.35 ? 'IL PORTONE SCRICCHIOLA!' : 'BUUUM!'); return; }
  // The gate gives way.
  gt.br = 1; gt.hp = 0;
  g.sfx('bigexplode'); g.flash('#ffd6a0', 0.5);
  g.burst(geo.x + geo.nx * 40, geo.y + geo.ny * 40, { color: '#7a4a22', n: 60, speed: 700, size: 12 });
  g.confetti(geo.x + geo.nx * 200, geo.y + geo.ny * 200);
  const alive = s.gates.filter((q) => !q.br);
  if (alive.length <= 1) {
    const ws = alive.length ? alive[0].k : -1;
    const w = s.p.find((p) => p.side === ws);
    g.slowmo(0.3, 1.0);
    g.end(w ? w.i : -1, 'Portone sfondato!');
    return;
  }
  for (const p of s.p) if (p.side === gt.k) { p.out = 1; p.st = 0; }
  g.say('PORTONE SFONDATO!');
  s.pause = 1.2;
  s.resetAt = g.t + 0.9;
}

// ---------------------------------------------------------------- computer player
const BOT_DELAY = [0.34, 0.2, 0.09];

function inArm(k, x, y) {
  return k === 0 ? y > XB : k === 1 ? y < XA : k === 2 ? x < XA : x > XB;
}

function arieteBot(s, me, g, B) {
  const p = s.p[me];
  if (!p || p.out || p.st > 0 || s.pause > 0) return { x: 0, y: 0 };
  const lv = B.level, m = B.mem, delay = BOT_DELAY[lv];
  const lay = s.lay, myGeo = lay.gates[p.side];
  // Boiling oil about to land on me: step out (the easy squire does not look up).
  if (lv > 0) {
    for (const o of s.oil) {
      if (o.w <= 0 || o.w > 0.45 + delay * 1.5) continue;
      if (dist(p.x, p.y, o.x, o.y) < OIL_R + P_R + 18) { const n = norm(p.x - o.x || 0.1, p.y - o.y); return { x: n.x, y: n.y }; }
    }
  }
  // Which ram: the nearest one, unless one threatens my gate (better bots defend first).
  let ram = s.rams[0];
  if (s.rams.length > 1) {
    let best = Infinity;
    for (const r of s.rams) {
      const dg = dist(r.x, r.y, myGeo.x, myGeo.y);
      const sc = dist(p.x, p.y, r.x, r.y) + (lv > 0 && dg < 420 ? -400 + dg * 0.5 : 0);
      if (sc < best) { best = sc; ram = r; }
    }
  }
  // Target gate: the nearest (easy) or the weakest reachable one.
  let tk = -1, best = Infinity;
  for (const gt of s.gates) {
    if (gt.br || gt.k === p.side) continue;
    const geo = lay.gates[gt.k];
    const sc = dist(ram.x, ram.y, geo.x, geo.y) + (lv === 0 ? 0 : gt.hp * (lv === 2 ? 4 : 2));
    if (sc < best) { best = sc; tk = gt.k; }
  }
  if (tk < 0) return { x: 0, y: 0 };
  if (m.tk !== undefined && m.tk !== tk && !s.gates[m.tk]?.br && m.tk !== p.side && g.t < m.tkUntil) tk = m.tk;
  else if (m.tk !== tk) { m.tk = tk; m.tkUntil = g.t + 2.5; }
  const tg = lay.gates[tk];
  // Aim at the nearest point of the door (not its middle): the ram must hit the wood, not the wall.
  const lt = clamp(lateral(tg, ram.x, ram.y), -GATE_HALF + 55, GATE_HALF - 55);
  let ax = tg.x - tg.ny * lt, ay = tg.y + tg.nx * lt;
  if (lay.L === 'x' && !inArm(tk, ram.x, ram.y)) {
    const inCenter = ram.x > XA - 5 && ram.x < XB + 5 && ram.y > XA - 5 && ram.y < XB + 5;
    if (!inCenter) { ax = CX; ay = CY; } else { ax = CX + SIDE[tk][0] * 260; ay = CY + SIDE[tk][1] * 260; }
  }
  // Steer the ram around rocks and stakes.
  for (const k of lay.rocks) {
    const dx = ax - ram.x, dy = ay - ram.y, L2 = dx * dx + dy * dy || 1;
    const t = ((k.x - ram.x) * dx + (k.y - ram.y) * dy) / L2;
    if (t <= 0 || t >= 1) continue;
    const qx = ram.x + dx * t, qy = ram.y + dy * t;
    const dd = dist(qx, qy, k.x, k.y), need = k.r + ram.r + 12;
    if (dd < need) {
      const n = dd < 1 ? norm(-dy, dx) : norm(qx - k.x, qy - k.y);
      ax = k.x + n.x * (need + 30); ay = k.y + n.y * (need + 30);
      break;
    }
  }
  const u = norm(ax - ram.x, ay - ram.y);
  const R = ram.r + P_R;
  // Pushing spot behind the ram; teammates stand side by side (never in each other's way).
  let lat = 0;
  for (const q of s.p) if (q !== p && !q.out && g.ally(q.i, p.i) && dist(q.x, q.y, ram.x, ram.y) < R + 140) lat = q.i < p.i ? 1 : -1;
  const sx = ram.x - u.x * (R + 2) - u.y * lat * 30, sy = ram.y - u.y * (R + 2) + u.x * lat * 30;
  const rel = norm(p.x - ram.x, p.y - ram.y);
  const behind = -(rel.x * u.x + rel.y * u.y);
  const dRam = dist(p.x, p.y, ram.x, ram.y);
  let gx = sx, gy = sy;
  if (behind < 0.55 && dRam < R + 150) {
    // Walk around the ram, not through it (that would push it the wrong way).
    const a0 = Math.atan2(rel.y, rel.x), a1 = Math.atan2(-u.y, -u.x);
    let da = a1 - a0;
    while (da > Math.PI) da -= TAU;
    while (da < -Math.PI) da += TAU;
    if (!m.dir || Math.abs(da) < 2.7) m.dir = Math.sign(da) || 1;
    const a = a0 + m.dir * Math.min(Math.abs(da), 0.8);
    gx = ram.x + Math.cos(a) * (R + 48); gy = ram.y + Math.sin(a) * (R + 48);
  } else m.dir = 0;
  // Shoulder charge whoever pushes against us (better bots only, the easy one at random).
  if (p.dcd <= 0) {
    for (const q of s.p) {
      if (q === p || q.out || q.st > 0 || g.ally(q.i, p.i)) continue;
      const d = dist(p.x, p.y, q.x, q.y);
      if (d > (lv === 0 ? 110 : 170)) continue;
      const qr = norm(ram.x - q.x, ram.y - q.y);
      const against = qr.x * u.x + qr.y * u.y;
      const qTouch = dist(q.x, q.y, ram.x, ram.y) < R + 30;
      const go = lv === 0 ? B.rng() < 0.02 : qTouch && against < -0.3 && (lv === 2 || B.rng() < 0.3);
      if (go) { const n = norm(q.x - p.x, q.y - p.y); return { x: n.x, y: n.y, tapB: true }; }
    }
  }
  const d = dist(p.x, p.y, gx, gy) || 1;
  const sp = Math.min(1, d / 60);
  const want = { x: ((gx - p.x) / d) * sp, y: ((gy - p.y) / d) * sp };
  const touching = dRam < R + REACH - 4;
  if (touching && behind > 0.75) { want.x = want.x * 0.5 + u.x * 0.5; want.y = want.y * 0.5 + u.y * 0.5; }
  if (touching && behind > 0.6 && p.pcd <= delay) {
    if (lv === 0) { if (B.rng() < 0.1) want.tapA = true; }
    else {
      // Time the heave so that it lands on the drum beat (the press arrives after my reaction delay).
      const e = g.t + delay - s.bT;
      const ph = ((e % s.P) + s.P) % s.P;
      const off = Math.min(ph, s.P - ph);
      const id = s.bn + Math.round(e / s.P);
      if (off < (lv === 2 ? 0.04 : 0.07) && m.beat !== id) {
        m.beat = id;
        if (lv === 2 || B.rng() > 0.15) want.tapA = true;
      }
    }
  }
  return want;
}

// ---------------------------------------------------------------- definition
export default {
  id: 'ariete',
  name: "All'Ariete!",
  rule: "Sfonda il portone nemico: spingi l'ariete a tempo!",
  verb: 'OH-ISSA!',
  inspired: 'Mario Party · Tug o\' War + Rhythm Heaven',
  cam: 'top',
  split: false,
  players: 4,
  teams: true,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Spinta', b: 'Spallata' },
  duration: DURATION,
  variants: [
    { id: 'due', name: 'Due Arieti', desc: "Due arieti in campo: attacchi con uno e ti difendi dall'altro!" },
    { id: 'montone', name: 'Il Montone Vero', desc: "L'ariete è un montone vivo: ogni tanto si sveglia e carica da solo il portone più integro!" },
    { id: 'olio', name: "Diluvio d'Olio", desc: "Piove olio bollente ovunque e le pozze restano: si scivola come sul lardo!" },
  ],
  help: {
    goal: "Spingi l'ariete contro il portone nemico finché non cede. A squadre sfondate il portone avversario; tutti contro tutti vince l'ultimo portone in piedi.",
    dir: "Muoviti. Per spingere l'ariete mettiti DIETRO, dal lato opposto a dove vuoi mandarlo.",
    a: "SPINTA (a contatto con l'ariete): premi a tempo col tamburo, quando l'anello d'oro si chiude = spinta TRIPLA! Fuori tempo = spintarella.",
    b: "SPALLATA: scatto che butta a terra i nemici. Stendi chi spinge dall'altra parte!",
    tips: ['A squadre: spingete sullo stesso colpo di tamburo = SINCRONIA, spinta extra!', "I cerchi rossi lampeggianti = olio bollente dalle mura: scansati!", 'Ultimi 12 s: FURIA FINALE, il tamburo accelera e le spinte picchiano di più'],
  },

  init(g) {
    const n = g.n || 2;
    const teams = !!g.teams;
    const S = teams ? 2 : n;
    const lay = layout(S);
    const two = g.variant === 'due';
    const s = {
      t: 0, S, teams, lay, P: P0, bph: 0, bn: 0, bT: 0, fu: 0, pause: 0, resetAt: 0, sync: 0,
      montAt: 5, rainAt: 2.5, slick: g.variant === 'olio', syncB: [-1, -1, -1, -1], oid: 0,
      gates: lay.gates.map((_, k) => ({ k, hp: GATE_HP, hit: 0, br: 0, ocd: 0.9 })),
      rams: [...Array(two ? 2 : 1)].map(() => ({ x: CX, y: CY, vx: 0, vy: 0, r: two ? 54 : RAM_R, m: two ? 7 : RAM_M, a: 0, wk: 0, wx: 0, wy: 0, hk: 0 })),
      oil: [],
      p: [...Array(n).keys()].map((i) => ({
        i, side: teams ? g.team(i) : i, x: 0, y: 0, vx: 0, vy: 0, r: P_R, m: 1, fx: 0, fy: -1,
        st: 0, dash: 0, dcd: 0, dhit: 0, pcd: 0, pn: 0, ps: 0, pb: -1, pr: -1, burn: 0, sy: 0, miss: 0, out: 0, wall: 0, kn: 0,
      })),
    };
    placeRams(s);
    for (const p of s.p) {
      const q = spawnPos(s, p);
      p.x = q.x; p.y = q.y;
      const n0 = norm(CX - p.x, CY - p.y);
      p.fx = n0.x; p.fy = n0.y;
    }
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.t = g.t;
    const lay = s.lay;
    // The war drum: one beat every P seconds (faster and faster).
    s.P = P0 + (P1 - P0) * clamp(g.t / DURATION, 0, 1);
    s.bph += dt / s.P;
    if (s.bph >= 1) {
      s.bph -= Math.floor(s.bph);
      s.bn++; s.bT = g.t - s.bph * s.P;
      g.sfx('kick', { vol: s.fu ? 0.5 : 0.32, pitch: s.fu ? 1.15 : 0.85 });
    }
    if (!s.fu && g.t > DURATION - FURIA) { s.fu = 1; g.say('FURIA FINALE!'); g.sfx('horn'); g.shake(0.3); }
    for (const gt of s.gates) gt.hit = Math.max(0, gt.hit - dt);

    if (s.resetAt && g.t >= s.resetAt) {
      s.resetAt = 0;
      placeRams(s);
      g.sfx('boing'); g.ring(CX, CY, { color: '#ffd84a', r: 200 });
    }
    if (s.pause > 0) s.pause -= dt;

    // ---- boiling oil: the walls pour it behind a ram that threatens their gate
    for (const o of s.oil) {
      if (o.w > 0) {
        o.w -= dt;
        if (o.w <= 0) {
          o.l = s.slick ? 7 : 2.2;
          g.sfx('splash', { vol: 0.8, pitch: 0.8 }); g.sfx('fire', { vol: 0.6 });
          g.burst(o.x, o.y, { color: '#ffb02e', n: 22, speed: 380, size: 8 });
          for (const p of s.p) {
            if (p.out || dist(p.x, p.y, o.x, o.y) > OIL_R + p.r * 0.5) continue;
            const n = norm(p.x - o.x || 0.1, p.y - o.y);
            p.vx = n.x * 430; p.vy = n.y * 430; p.st = OIL_STUN; p.burn = 1.3; p.dash = 0;
            g.text(p.x, p.y - 80, 'SCOTTATO!', { color: '#ff8a2a', size: 44 });
            g.vibrate(p.i, 140);
          }
          g.shake(0.25);
        }
      } else o.l -= dt;
    }
    s.oil = s.oil.filter((o) => o.w > 0 || o.l > 0);
    if (!g.ended && s.pause <= 0) {
      for (const gt of s.gates) {
        if (gt.br) continue;
        const geo = lay.gates[gt.k];
        let near = null, nd = Infinity;
        for (const r of s.rams) {
          const dn = inward(geo, r.x, r.y);
          if (dn < OIL_ZONE && Math.abs(lateral(geo, r.x, r.y)) < GATE_HALF + 140 && dn < nd) { nd = dn; near = r; }
        }
        if (!near) { gt.ocd = Math.max(gt.ocd, 0.9); continue; }
        gt.ocd -= dt;
        if (gt.ocd <= 0 && s.oil.length < 8) {
          gt.ocd = OIL_CD;
          const j = g.rng.range(-60, 60);
          const x = near.x + geo.nx * (near.r + 58) - geo.ny * j, y = near.y + geo.ny * (near.r + 58) + geo.nx * j;
          s.oil.push({ id: ++s.oid, x, y, w: OIL_WARN, l: 0, k: gt.k });
          g.sfx('fuse', { vol: 0.5 });
        }
      }
      // Diluvio d'Olio: oil rains everywhere.
      if (s.slick && g.t >= s.rainAt && s.oil.length < 8) {
        s.rainAt = g.t + 1.6;
        const R = g.rng.pick(lay.rects);
        s.oil.push({ id: ++s.oid, x: g.rng.range(R.x0 + 60, R.x1 - 60), y: g.rng.range(R.y0 + 60, R.y1 - 60), w: OIL_WARN + 0.2, l: 0, k: -1 });
      }
      // Il Montone Vero: the ram wakes up and charges the most intact gate.
      if (g.variant === 'montone' && g.t >= s.montAt) {
        s.montAt = g.t + 6.5;
        for (const r of s.rams) {
          let top = -1, list = [];
          for (const gt of s.gates) {
            if (gt.br) continue;
            if (gt.hp > top + 0.5) { top = gt.hp; list = [gt]; } else if (Math.abs(gt.hp - top) <= 0.5) list.push(gt);
          }
          const tg = lay.gates[g.rng.pick(list).k];
          const n = norm(tg.x - r.x, tg.y - r.y);
          r.wk = 1.1; r.wx = n.x; r.wy = n.y;
        }
        g.say('IL MONTONE SI SVEGLIA!'); g.sfx('quack', { pitch: 0.6 });
      }
    }

    // ---- players
    for (const p of s.p) {
      if (p.out) continue;
      const i = inp[p.i];
      p.st = Math.max(0, p.st - dt);
      p.dcd = Math.max(0, p.dcd - dt);
      p.pcd = Math.max(0, p.pcd - dt);
      p.ps = Math.max(0, p.ps - dt);
      p.burn = Math.max(0, p.burn - dt);
      p.sy = Math.max(0, p.sy - dt);
      p.miss = Math.max(0, p.miss - dt);
      p.kn = Math.max(0, p.kn - dt);
      if (Math.hypot(i.x, i.y) > 0.2) { const n = norm(i.x, i.y); p.fx = n.x; p.fy = n.y; }
      const slip = inPuddle(s, p.x, p.y);
      if (p.dash > 0) p.dash -= dt;
      else if (p.st > 0 || s.pause > 0) { const k = damp(slip ? 0.5 : 0.04, dt); p.vx *= k; p.vy *= k; }
      else {
        const acc = slip ? P_ACC * 0.35 : P_ACC;
        p.vx += i.x * acc * dt; p.vy += i.y * acc * dt;
        const k = damp(slip ? 0.75 : P_KEEP, dt);
        p.vx *= k; p.vy *= k;
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > P_MAX) { p.vx *= P_MAX / sp; p.vy *= P_MAX / sp; }
      }
      if (p.st <= 0 && s.pause <= 0 && !g.ended) {
        if (i.bP && p.dcd <= 0) {
          p.dash = DASH_T; p.dcd = DASH_CD; p.dhit = 0;
          p.vx = p.fx * DASH_V; p.vy = p.fy * DASH_V;
          g.sfx('dash'); g.burst(p.x, p.y, { player: p.i, n: 8, speed: 180 });
        } else if (i.aP) heave(s, p, i, g);
        // Leaning on the ram while walking into it nudges it a little.
        for (const r of s.rams) {
          const d = dist(p.x, p.y, r.x, r.y);
          if (d > r.r + p.r + 8) continue;
          const n = norm(r.x - p.x, r.y - p.y);
          const lean = i.x * n.x + i.y * n.y;
          if (lean > 0.3) { r.vx += n.x * 150 * lean * dt * (RAM_M / r.m); r.vy += n.y * 150 * lean * dt * (RAM_M / r.m); }
        }
      }
      p.x += p.vx * dt; p.y += p.vy * dt;
      for (const k of lay.rocks) rockBounce(p, k, 0.3);
      p.wall = confine(p, lay.rects, 0.2) ? 1 : 0;
    }

    // ---- players bump each other (shoulder charges knock enemies down; no friendly fire)
    const on = s.p.filter((p) => !p.out);
    for (let a = 0; a < on.length; a++) {
      for (let b = a + 1; b < on.length; b++) {
        const A = on[a], Bq = on[b];
        if (dist(A.x, A.y, Bq.x, Bq.y) >= A.r + Bq.r) continue;
        let charged = false;
        for (const [att, vic] of [[A, Bq], [Bq, A]]) {
          if (att.dash <= 0 || att.dhit || g.ally(att.i, vic.i)) continue;
          const n = norm(vic.x - att.x, vic.y - att.y);
          vic.vx = n.x * KNOCK_V; vic.vy = n.y * KNOCK_V; vic.st = STUN_T; vic.dash = 0; vic.kn = STUN_T;
          att.dhit = 1; att.vx *= 0.3; att.vy *= 0.3; att.dash = 0;
          charged = true;
          g.sfx('punch'); g.text(vic.x, vic.y - 80, 'A TERRA!', { player: att.i, size: 44 });
          g.burst((att.x + vic.x) / 2, (att.y + vic.y) / 2, { color: '#fff', n: 16, speed: 380 });
          g.shake(0.35); g.hitstop(0.08); g.vibrate(vic.i, 120); g.vibrate(att.i, 40);
          break;
        }
        if (!charged) collideCircles(A, Bq, 0.4);
      }
    }

    // ---- rams
    for (const r of s.rams) {
      if (r.wk > 0) {
        r.wk -= dt;
        if (r.wk <= 0) {
          r.vx += r.wx * 560; r.vy += r.wy * 560;
          g.sfx('horn', { pitch: 1.4 }); g.text(r.x, r.y - 100, 'BEEEEE!', { color: '#fff3c4', size: 58 });
          g.burst(r.x, r.y, { color: '#f2e8d0', n: 20, speed: 300 }); g.shake(0.3);
        }
      }
      const slip = inPuddle(s, r.x, r.y);
      const k = damp(slip ? 0.75 : RAM_KEEP, dt);
      r.vx *= k; r.vy *= k;
      const sp = Math.hypot(r.vx, r.vy);
      if (sp > RAM_MAX) { r.vx *= RAM_MAX / sp; r.vy *= RAM_MAX / sp; }
      r.x += r.vx * dt; r.y += r.vy * dt;
      for (const k2 of lay.rocks) if (rockBounce(r, k2, 0.4) > 200) { g.sfx('bonk', { pitch: 0.6 }); g.burst(r.x, r.y, { color: '#cfc6b8', n: 6, speed: 160 }); }
      const c = confine(r, lay.rects, 0.45);
      if (c && !g.ended) {
        for (const gt of s.gates) {
          const geo = lay.gates[gt.k];
          if (gt.br || c.ux * geo.nx + c.uy * geo.ny < 0.9 || Math.abs(lateral(geo, r.x, r.y)) > GATE_HALF + 10) continue;
          if (c.vn > HIT_MIN) { r.hk++; hitGate(s, gt, geo, c.vn, g); }
        }
        if (c.vn > 220 && !g.ended) g.sfx('bonk', { vol: 0.6, pitch: 0.55 });
      }
      // Heading: the two-headed ram turns along its motion (either end can lead).
      if (sp > 40) {
        let ta = Math.atan2(r.vy, r.vx), da = ta - r.a;
        while (da > Math.PI) da -= TAU;
        while (da < -Math.PI) da += TAU;
        if (Math.abs(da) > Math.PI / 2) { ta += Math.PI; da = ta - r.a; while (da > Math.PI) da -= TAU; while (da < -Math.PI) da += TAU; }
        r.a += da * Math.min(1, dt * 4 * Math.min(1, sp / 200));
        while (r.a > Math.PI) r.a -= TAU;
        while (r.a < -Math.PI) r.a += TAU;
      }
    }
    if (s.rams.length > 1) collideCircles(s.rams[0], s.rams[1], 0.6);
    // Ram vs knights: a fast ram runs them over, a slow one just shoves (a knight pinned to a wall slips aside).
    for (const r of s.rams) {
      for (const p of s.p) {
        if (p.out) continue;
        const dx = p.x - r.x, dy = p.y - r.y, d = Math.hypot(dx, dy);
        if (d >= r.r + p.r || d === 0) continue;
        const nx = dx / d, ny = dy / d;
        const vrel = r.vx * nx + r.vy * ny; // only the ram's own charge runs knights over
        if (vrel > 230 && p.st <= 0 && p.dash <= 0 && !g.ended) {
          const side = (r.vx * ny - r.vy * nx) > 0 ? -1 : 1;
          p.vx = -ny * side * 520 + nx * 260; p.vy = nx * side * 520 + ny * 260;
          p.st = 0.55; p.kn = 0.55;
          r.vx *= 0.88; r.vy *= 0.88;
          p.x = r.x + nx * (r.r + p.r); p.y = r.y + ny * (r.r + p.r);
          g.sfx('bonk', { pitch: 0.8 }); g.text(p.x, p.y - 70, 'TRAVOLTO!', { color: '#ffd84a', size: 40 });
          g.vibrate(p.i, 100);
          continue;
        }
        p.m = p.dash > 0 ? 2.5 : 1;
        collideCircles(r, p, 0.15);
        p.m = 1;
        if (p.dash > 0 && !p.dhit) {
          const n = norm(r.x - p.x, r.y - p.y);
          r.vx += n.x * 150 * (RAM_M / r.m); r.vy += n.y * 150 * (RAM_M / r.m);
          p.dhit = 1; p.dash = 0;
          g.sfx('punch', { pitch: 0.7 });
        }
        if (p.wall && vrel > 30) {
          const side = (r.vx * ny - r.vy * nx) > 0 ? -1 : 1;
          p.x += -ny * side * 260 * dt; p.y += nx * side * 260 * dt;
        }
      }
    }
  },

  timeout(s) {
    // Most intact gate; tie: the gate farthest from the nearest ram.
    let best = null, bv = -Infinity;
    for (const gt of s.gates) {
      if (gt.br) continue;
      const geo = s.lay.gates[gt.k];
      const far = Math.min(...s.rams.map((r) => dist(r.x, r.y, geo.x, geo.y)));
      const v = gt.hp * 1000 + far;
      if (v > bv) { bv = v; best = gt; }
    }
    const w = best ? s.p.find((p) => p.side === best.k) : null;
    return w ? w.i : 0;
  },

  bot: arieteBot,

  view(s) {
    return {
      L: s.lay.L, S: s.S, tm: s.teams ? 1 : 0, P: r2(s.P), bT: r2(s.bT), fu: s.fu, ps: s.pause > 0 ? 1 : 0,
      rm: s.rams.map((r) => ({ x: r1(r.x), y: r1(r.y), r: r.r, a: r2(r.a), sp: Math.round(Math.hypot(r.vx, r.vy)), wk: r2(r.wk), wa: r2(Math.atan2(r.wy, r.wx)), hk: r.hk % 16 })),
      gt: s.gates.map((gt) => ({ hp: r1(gt.hp), hit: r2(gt.hit), br: gt.br })),
      oil: s.oil.map((o) => ({ id: o.id, x: r1(o.x), y: r1(o.y), w: r2(o.w), l: r2(o.l), k: o.k })),
      p: s.p.map((p) => ({
        x: r1(p.x), y: r1(p.y), fx: r2(p.fx), fy: r2(p.fy), s: p.side, st: r2(p.st), d: p.dash > 0 ? 1 : 0, cd: r2(p.dcd), pc: r2(p.pcd),
        pk: p.pn % 16, pf: r2(p.ps), b: r2(p.burn), sy: r2(p.sy), o: p.out, kn: r2(p.kn), sp: Math.round(Math.hypot(p.vx, p.vy)),
      })),
      hud: { p: s.p.map((p) => Math.round(s.gates[p.side].hp)), max: null, label: 'Portone', bar: s.p.map((p) => r2(s.gates[p.side].hp / GATE_HP)) },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  // ---------------------------------------------------------------- 3D: siege before the castle walls, in a storm
  render3d: {
    assets: [
      'medieval/building_castle_red', 'medieval/building_castle_blue', 'medieval/building_castle_green', 'medieval/building_castle_yellow',
      'medieval/building_tower_A_red', 'medieval/building_tower_A_blue', 'medieval/building_tower_A_green', 'medieval/building_tower_A_yellow',
      'medieval/building_tower_base_red', 'medieval/building_tower_base_blue', 'medieval/building_tower_base_green', 'medieval/building_tower_base_yellow',
      'medieval/building_tower_catapult_red', 'medieval/building_tower_catapult_blue',
      'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow',
      'medieval/tent', 'medieval/fence_wood_straight', 'medieval/weaponrack', 'medieval/barrel', 'medieval/crate_A_big', 'medieval/crate_B_small',
      'medieval/sack', 'medieval/projectile_catapult', 'medieval/wheelbarrow', 'medieval/resource_lumber',
      'medieval/rock_single_B', 'medieval/rock_single_D', 'medieval/rock_single_E',
      'medieval/trees_B_large', 'medieval/trees_A_medium', 'medieval/tree_single_B', 'medieval/hills_B_trees', 'medieval/mountain_C_grass_trees',
      'medieval/building_destroyed', 'medieval/building_home_B_red', 'medieval/building_home_A_blue',
      'dungeon/torch_lit', 'dungeon/banner_red', 'dungeon/banner_blue', 'dungeon/banner_green', 'dungeon/banner_yellow',
      'chars/Barbarian',
    ],
    build(K, r) {
      const n = r.n || K.n || 2;
      const lo = K.quality === 0;
      K.theme('tempesta', { fogNear: 2.3, fogFar: 6.2 });
      K.hemi.intensity += 0.3; K.sun.intensity += 0.4; // a storm, but the field must stay readable
      K.ground('erba', { tile: 230, color: '#7f8a5c', margin: 2400 });
      const o = { n, lays: {}, mats: makeMats(K) };
      // n = 4 can be a team match (2 gates) or free-for-all (cross): build both, show the right one.
      const list = n === 2 ? [['c', 2]] : n === 3 ? [['x', 3]] : [['c', 2], ['x', 4]];
      for (const [L, S] of list) o.lays[L] = buildLayout(K, o, layout(S), n, lo);
      // Shared: rams, oil, knights.
      o.rams = [0, 1].map(() => buildRam(K, o.mats));
      o.oil = [...Array(8)].map(() => ({
        dec: K.decal(230, { px: 128, h: 1.2 }),
        stream: K.cyl(1, 1, K.glow('#ffb02e', { opacity: 0.85 }), { cast: false, seg: 10 }),
        pud: K.disc(1, K.mat('#5a3410', { rough: 0.15, metal: 0.2, emissive: '#ff7a1a', ei: 0.35, opacity: 0.85 })),
        steam: [0, 1, 2].map(() => K.ball(1, K.glow('#fff1d0', { opacity: 0.35 }), { cast: false, seg: 8 })),
      }));
      o.pl = [...Array(n).keys()].map((i) => ({ av: K.avatar(i), dec: K.decal(200, { px: 192 }) }));
      if (!lo) K.ambient('braci', { n: 60, x0: -500, y0: -300, x1: 1500, y1: 1300, h: 420 });
      K.ambient('polvere', { n: lo ? 30 : 60, x0: 100, y0: 0, x1: 900, y1: 1000, h: 220 });
      return o;
    },
    update(K, o, v, r) {
      const t = K.t;
      for (const L in o.lays) o.lays[L].grp.visible = L === v.L;
      const Ly = o.lays[v.L];
      if (!Ly) return;
      const lay = Ly.lay;
      const ph = (((t - v.bT) / v.P) % 1 + 1) % 1; // drum phase: 0 = beat
      for (const F of Ly.flags) F.f.rotation.y = F.base + Math.sin(t * 2.3 + F.ph) * 0.18;
      // Gates: door damage, shake on hits, rubble when broken, oil pourer on the wall.
      v.gt.forEach((gv, k) => {
        const G = Ly.gates[k];
        if (!G) return;
        const dmg = 1 - gv.hp / GATE_HP;
        G.doorMat.color.set('#8a5a32').lerp(o.mats.char, dmg * 0.75);
        for (const lf of G.leaves) {
          lf.m.visible = !gv.br;
          const sh = gv.hit > 0 ? Math.sin(t * 70) * gv.hit * 10 : 0;
          lf.m.position.x = lf.x0 + sh + dmg * 6;
          lf.m.rotation.z = lf.side * dmg * 0.08;
        }
        for (const b of G.bands) b.visible = !gv.br;
        G.cloth.visible = !gv.br;
        G.rubble.visible = !!gv.br;
        const key = `${Math.round(gv.hp)}|${gv.br}`;
        if (G.key !== key) {
          G.key = key;
          G.dec.paint((d) => drawGateBar(d, gv, G.col, G.ang));
        }
        // Oil pourer: throws when its gate has oil on the way.
        const pour = v.oil.find((q) => q.k === k && q.w > 0);
        if (G.npc) {
          G.npc.set(G.nx, G.ny, { r: 30, h: G.nh, look: G.ang, gear: false, anim: gv.br ? 'Death_A' : pour ? 'Throw' : 'Idle', animKey: pour ? pour.id : 0, marker: false });
        }
        if (G.caul) G.caul.rotation.z = pour ? -0.9 * Math.min(1, (OIL_WARN - pour.w) * 3) : 0;
      });
      // Rams.
      o.rams.forEach((R, k) => {
        const rv = v.rm[k];
        R.g.visible = !!rv;
        R.dec.show(!!rv);
        if (!rv) return;
        const sc = rv.r / RAM_R;
        K.place(R.g, rv.x, rv.y, 0);
        K.face(R.g, rv.a);
        R.g.scale.setScalar(sc);
        const roll = (rv.sp / 24) * K.dt;
        for (const w of R.wheels) w.rotation.y += roll * (Math.cos(rv.a) >= 0 ? 1 : -1);
        // Drum sticks hit on the beat; the log sways after a gate hit.
        const hitK = Math.max(0, 1 - ph * 5);
        R.sticks[0].rotation.x = -0.6 + hitK * 0.9; R.sticks[1].rotation.x = 0.6 - hitK * 0.9;
        R.drumTop.material.color.set(hitK > 0.3 ? '#ffe9a8' : '#e8d3a8');
        R.log.position.x = Math.sin(t * 9) * Math.min(8, rv.sp / 50);
        const wake = rv.wk > 0;
        for (const e of R.eyes) e.visible = wake;
        R.dec.at(rv.x, rv.y, 1.6).paint((d) => drawBeatRing(d, rv, ph, v.fu, wake));
      });
      // Boiling oil: warning circle, the falling stream, the smoking puddle.
      o.oil.forEach((O, k) => {
        const q = v.oil[k];
        const show = !!q;
        O.dec.show(show && q.w > 0);
        O.stream.visible = show && q.w > 0 && q.w < 0.35;
        O.pud.visible = show && q.w <= 0;
        for (const st of O.steam) st.visible = show && q.w <= 0;
        if (!show) return;
        if (q.w > 0) {
          O.dec.at(q.x, q.y, 1.3).paint((d) => drawOilWarn(d, q.w, t));
          if (O.stream.visible) {
            const hh = 320 * (1 - q.w / 0.35);
            O.stream.scale.set(16, Math.max(1, hh), 16);
            K.place(O.stream, q.x, q.y, 330 - hh);
          }
        } else {
          const k2 = Math.min(1, q.l * 2);
          O.pud.scale.setScalar(OIL_R * 0.9 * Math.max(0.2, k2));
          K.place(O.pud, q.x, q.y, 1.5);
          O.steam.forEach((st, j) => {
            const p2 = (t * 0.6 + j / 3) % 1;
            K.place(st, q.x + Math.sin(j * 2.1 + t) * 30, q.y + Math.cos(j * 1.7) * 30, 10 + p2 * 120);
            st.scale.setScalar((10 + p2 * 26) * k2);
          });
        }
      });
      // Knights.
      v.p.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const col = sideCol(K, v, p.s);
        if (p.o) {
          const geo = lay.gates[p.s];
          const lt = i % 2 ? 70 : -70;
          P.av.set(geo.x + geo.nx * 60 - geo.ny * lt, geo.y + geo.ny * 60 + geo.nx * lt, { r: P_R * 0.85, look: Math.atan2(geo.ny, geo.nx), alpha: 0.45, anim: 'Sit_Floor_Idle', gear: false });
          P.dec.show(false);
          return;
        }
        let anim, animKey, mood = 'ok';
        if (p.b > 0) { anim = 'Hit_B'; mood = 'hurt'; } else if (p.kn > 0 || p.st > 0) { anim = 'Hit_A'; mood = 'dizzy'; } else if (p.d) { anim = 'Dodge_Forward'; mood = 'angry'; } else if (p.pf > 0) { anim = 'Unarmed_Melee_Attack_Punch_A'; animKey = p.pk; mood = 'angry'; }
        if (r.ended) {
          const mine = v.gt[p.s];
          const win = !mine.br && v.gt.every((g2, k) => k === p.s || g2.br || g2.hp <= mine.hp);
          mood = win ? 'happy' : 'hurt';
          anim = win ? 'Cheer' : anim;
        }
        P.av.set(p.x, p.y, { r: P_R, look: Math.atan2(p.fy, p.fx), mood, walk: clamp(p.sp / 300, 0, 1), anim, animKey, gear: false });
        P.dec.show(true).at(p.x, p.y, 1.4).paint((d) => drawKnightMarks(d, p, col, ph, K.col(i, 'light')));
      });
    },
  },

  render(d, v, r) {
    const lay = layout(v.S);
    const cols = [...Array(v.S).keys()].map((k) => (v.tm ? TEAM_COL[k] : d.col(k)));
    const { ctx } = d;
    ctx.fillStyle = '#4a5236';
    ctx.fillRect(-400, -400, W + 800, H + 800);
    drawField(d, lay, cols, true);
    const ph = (((d.t - v.bT) / v.P) % 1 + 1) % 1;
    // Gates.
    lay.gates.forEach((geo, k) => {
      const gv = v.gt[k];
      ctx.save();
      ctx.translate(geo.x, geo.y);
      ctx.rotate(Math.atan2(geo.ny, geo.nx));
      d.rect(-40, -GATE_HALF - 30, 40, GATE_HALF * 2 + 60, '#5d5a55', '#2e2c29', 4);
      if (!gv.br) {
        const sh = gv.hit > 0 ? Math.sin(d.t * 70) * gv.hit * 8 : 0;
        d.rect(-14 + sh, -GATE_HALF, 22, GATE_HALF * 2, '#8a5a32', '#3d2614', 4);
        d.rect(-10 + sh, -GATE_HALF, 14, GATE_HALF * 2 * (gv.hp / GATE_HP), cols[k]);
      } else {
        for (let j = 0; j < 6; j++) d.rect(-20 + (j % 3) * 14, -GATE_HALF + j * 50, 18, 30, '#6b4524');
      }
      ctx.restore();
    });
    for (const k of lay.rocks) {
      d.shadow(k.x + 6, k.y + 10, k.r, k.r * 0.7, 0.3);
      if (k.k) { d.circle(k.x, k.y, k.r, '#7a5532', '#3d2614', 4); d.line(k.x - k.r, k.y - k.r, k.x + k.r, k.y + k.r, '#c9a26b', 6); d.line(k.x - k.r, k.y + k.r, k.x + k.r, k.y - k.r, '#c9a26b', 6); } else d.circle(k.x, k.y, k.r, '#8d8678', '#4a463f', 4);
    }
    for (const q of v.oil) {
      if (q.w > 0) {
        const bl = Math.floor(d.t * (q.w < 0.4 ? 16 : 8)) % 2;
        d.circle(q.x, q.y, OIL_R, bl ? 'rgba(255,60,30,0.35)' : 'rgba(255,60,30,0.15)', '#ff4b2a', 4);
      } else d.circle(q.x, q.y, OIL_R * 0.85, 'rgba(110,60,15,0.7)', '#ffb02e', 3);
    }
    for (const rv of v.rm) {
      d.shadow(rv.x + 8, rv.y + 12, rv.r * 1.6, rv.r * 0.9, 0.35);
      ctx.save();
      ctx.translate(rv.x, rv.y); ctx.rotate(rv.a);
      const s = rv.r / RAM_R;
      d.rrect(-110 * s, -48 * s, 220 * s, 96 * s, 14, '#6b4524', '#2e1a0c', 4);
      d.rect(-130 * s, -16 * s, 260 * s, 32 * s, '#a9773f', '#3d2614', 3);
      d.circle(-132 * s, 0, 22 * s, '#6d737d', '#2b2f36', 3);
      d.circle(132 * s, 0, 22 * s, '#6d737d', '#2b2f36', 3);
      d.circle(0, 0, 18 * s, ph < 0.15 ? '#ffe9a8' : '#e8d3a8', '#5a3a1a', 3);
      ctx.restore();
      const rr = rv.r + 14 + 110 * (1 - ph);
      d.ring(rv.x, rv.y, rv.r + 14, 'rgba(255,216,74,0.45)', 4);
      d.ring(rv.x, rv.y, rr, ph < 0.15 ? '#ffd84a' : 'rgba(255,216,74,0.7)', ph < 0.15 ? 8 : 4);
      if (rv.wk > 0) d.line(rv.x, rv.y, rv.x + Math.cos(rv.wa) * 220, rv.y + Math.sin(rv.wa) * 220, '#ff4b2a', 10);
    }
    v.p.forEach((p, i) => {
      if (p.o) { const geo = lay.gates[p.s]; d.avatar(geo.x + geo.nx * 60, geo.y + geo.ny * 60, P_R * 0.7, i, { mood: 'dizzy', alpha: 0.4 }); return; }
      d.shadow(p.x + 6, p.y + 12, P_R, P_R * 0.75, 0.3);
      d.ring(p.x, p.y, P_R + 8, cols[p.s] + 'cc', 4);
      if (p.cd > 0) d.arc(p.x, p.y, P_R + 15, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / DASH_CD), 'rgba(230,230,240,0.6)', 3);
      const mood = p.b > 0 ? 'hurt' : p.st > 0 ? 'dizzy' : p.d || p.pf > 0 ? 'angry' : 'ok';
      d.avatar(p.x, p.y, P_R, i, { look: Math.atan2(p.fy, p.fx), mood, squash: p.pf > 0 ? 0.15 : 0 });
    });
  },
};

// ---------------------------------------------------------------- drawing helpers (2D, also used by 3D layers/decals)
function sideCol(K, v, k) { return v.tm ? TEAM_COL[k] : K.col(k); }

function drawField(d, lay, cols, flat) {
  const { ctx } = d;
  const P = lay.poly;
  const path = () => { ctx.beginPath(); ctx.moveTo(P[0], P[1]); for (let k = 2; k < P.length; k += 2) ctx.lineTo(P[k], P[k + 1]); ctx.closePath(); };
  if (!flat) {
    // Trampled, muddy siege ground all around (fades into the meadow).
    const g = ctx.createRadialGradient(CX, CY, 300, CX, CY, 1150);
    g.addColorStop(0, 'rgba(96,74,50,0.95)'); g.addColorStop(0.6, 'rgba(96,78,52,0.55)'); g.addColorStop(1, 'rgba(96,78,52,0)');
    ctx.fillStyle = g; ctx.fillRect(CX - 1200, CY - 1200, 2400, 2400);
  }
  // Stone curb along the edge.
  path(); ctx.lineWidth = 34; ctx.strokeStyle = '#6e675d'; ctx.stroke();
  ctx.lineWidth = 6; ctx.strokeStyle = '#3e3933'; ctx.stroke();
  path(); ctx.fillStyle = '#80654a'; ctx.fill();
  ctx.save();
  path(); ctx.clip();
  let seed = 911;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let k = 0; k < 520; k++) {
    const x = rnd() * W, y = rnd() * H, rr = 3 + rnd() * 9;
    d.circle(x, y, rr, rnd() < 0.5 ? 'rgba(60,42,24,0.28)' : 'rgba(170,140,100,0.22)');
  }
  // Mud puddles and wheel ruts.
  for (let k = 0; k < 14; k++) {
    const x = 120 + rnd() * 760, y = 120 + rnd() * 760;
    ctx.fillStyle = 'rgba(70,50,30,0.35)';
    ctx.beginPath(); ctx.ellipse(x, y, 30 + rnd() * 50, 16 + rnd() * 24, rnd() * 3, 0, TAU); ctx.fill();
  }
  ctx.lineCap = 'round';
  for (const off of [-48, 48]) {
    d.line(CX + off, 0, CX + off, H, 'rgba(55,38,22,0.35)', 12);
    if (lay.L === 'x') d.line(0, CY + off, W, CY + off, 'rgba(55,38,22,0.35)', 12);
  }
  // Colored apron with chevrons in front of each gate.
  lay.gates.forEach((gt, k) => {
    ctx.save();
    ctx.translate(gt.x, gt.y);
    ctx.rotate(Math.atan2(gt.ny, gt.nx));
    const gr = ctx.createLinearGradient(0, 0, 170, 0);
    gr.addColorStop(0, cols[k] + 'aa'); gr.addColorStop(1, cols[k] + '00');
    ctx.fillStyle = gr;
    ctx.fillRect(0, -GATE_HALF - 10, 170, GATE_HALF * 2 + 20);
    for (let j = -1; j <= 1; j++) {
      ctx.beginPath();
      ctx.moveTo(60, j * 90 - 26); ctx.lineTo(34, j * 90); ctx.lineTo(60, j * 90 + 26);
      ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.stroke();
    }
    ctx.restore();
  });
  // Center: the drum circle of the start.
  d.ring(CX, CY, 110, 'rgba(255,230,170,0.25)', 6);
  ctx.restore();
}

function drawGateBar(d, gv, col, ang) {
  const { ctx } = d;
  ctx.save();
  ctx.rotate(ang + Math.PI / 2);
  const w = 280, f = gv.hp / GATE_HP;
  d.rrect(-w / 2 - 6, -15, w + 12, 30, 10, 'rgba(20,12,8,0.75)');
  if (!gv.br) d.rrect(-w / 2, -9, w * f, 18, 7, f < 0.35 ? '#ff6a3a' : col);
  for (let k = 1; k < 5; k++) d.line(-w / 2 + (w * k) / 5, -9, -w / 2 + (w * k) / 5, 9, 'rgba(0,0,0,0.4)', 3);
  ctx.restore();
}

function drawBeatRing(d, rv, ph, fu, wake) {
  const R0 = rv.r + 16;
  const on = ph < 0.13 || ph > 0.92;
  d.ring(0, 0, R0, on ? 'rgba(255,216,74,0.95)' : 'rgba(255,216,74,0.4)', on ? 9 : 5);
  if (on) d.circle(0, 0, R0 + 6, 'rgba(255,216,74,0.18)');
  const rr = R0 + 120 * (1 - ph);
  d.ring(0, 0, rr, fu ? 'rgba(255,90,60,0.85)' : 'rgba(255,236,170,0.8)', 5);
  if (wake) {
    const a = rv.wa;
    const c = Math.cos(a), s = Math.sin(a);
    const L = R0 + 60;
    d.poly([c * (L + 40), s * (L + 40), c * L - s * 26, s * L + c * 26, c * L + s * 26, s * L - c * 26], '#ff4b2a', '#ffffff', 3);
  }
}

function drawOilWarn(d, w, t) {
  const bl = Math.floor(t * (w < 0.4 ? 16 : 7)) % 2;
  d.circle(0, 0, OIL_R, bl ? 'rgba(255,50,20,0.42)' : 'rgba(255,90,20,0.2)');
  d.ring(0, 0, OIL_R, '#ff4b2a', 6);
  d.ring(0, 0, OIL_R * Math.max(0.05, w / OIL_WARN), '#ffd36b', 4);
  d.line(-18, -18, 18, 18, '#ffe7c0', 6); d.line(-18, 18, 18, -18, '#ffe7c0', 6);
}

function drawKnightMarks(d, p, col, ph, light) {
  d.ring(0, 0, P_R + 9, col + 'dd', 5);
  const ax = p.fx * (P_R + 22), ay = p.fy * (P_R + 22);
  d.poly([ax + p.fx * 16, ay + p.fy * 16, ax - p.fy * 11, ay + p.fx * 11, ax + p.fy * 11, ay - p.fx * 11], light + 'dd', 'rgba(0,0,0,0.35)', 2);
  if (p.cd > 0) d.arc(0, 0, P_R + 17, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / DASH_CD), 'rgba(230,235,245,0.7)', 4);
  if (p.sy > 0) d.ring(0, 0, P_R + 26 + (0.6 - p.sy) * 60, `rgba(255,216,74,${(p.sy / 0.6).toFixed(2)})`, 6);
}

// ---------------------------------------------------------------- 3D builders
function makeMats(K) {
  const { THREE } = K;
  return {
    stone: K.texMat('muro', [3, 1], { color: '#b7ad9c' }),
    stone2: K.texMat('pietra', [2, 2], { color: '#9d9384' }),
    wood: K.texMat('legno', [2, 1], { color: '#a87443' }),
    dark: K.mat('#4a3020', { rough: 0.8 }),
    iron: K.mat('#5c626c', { rough: 0.35, metal: 0.7 }),
    horn: K.mat('#e9dcc0', { rough: 0.5 }),
    roof: K.texMat('tetto', [3, 1], { color: '#b0614a' }),
    hide: K.texMat('paglia', [2, 1], { color: '#a0714a' }),
    char: new THREE.Color('#2a1a0e'),
  };
}

// Instanced merlons on top of a wall (one draw call).
function merlons(K, parent, pts, mat) {
  const { THREE } = K;
  const geo = new THREE.BoxGeometry(22, 22, 22);
  const im = new THREE.InstancedMesh(geo, mat, pts.length);
  im.userData.ownGeo = true;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(1, 1, 1);
  pts.forEach((it, k) => { K.p(it.x, it.y, it.h + 11, p); m4.compose(p, q, sc); im.setMatrixAt(k, m4); });
  im.castShadow = K.shadows; im.receiveShadow = true;
  parent.add(im);
  return im;
}

// One gatehouse: wall + door (two leaves) + towers + banner + team cloth + oil pourer. Local +X points into the field.
function buildGate(K, Lg, M, geo, k, col, flag, near, span, hiDetail) {
  const ang = Math.atan2(geo.ny, geo.nx);
  const g = K.group(Lg);
  K.place(g, geo.x, geo.y);
  K.face(g, ang);
  const DH = near ? 78 : 165, WH = near ? 56 : 140, TH = 34;
  const G = { ang, col, leaves: [], bands: [], key: '' };
  G.doorMat = K.mat('#8a5a32', { unique: true, rough: 0.8 });
  for (const sd of [-1, 1]) {
    const m = K.box(16, GATE_HALF - 2, DH, G.doorMat, { parent: g });
    K.place(m, -6, sd * (GATE_HALF / 2), DH / 2);
    G.leaves.push({ m, x0: m.position.x, side: sd });
  }
  for (const hh of [DH * 0.25, DH * 0.7]) { const b = K.box(20, GATE_HALF * 2, 7, M.iron, { parent: g }); K.place(b, -4, 0, hh); G.bands.push(b); }
  const lintel = K.box(46, GATE_HALF * 2 + 40, 26, M.stone, { parent: g });
  K.place(lintel, -14, 0, DH + 13);
  G.cloth = K.box(4, 110, near ? 40 : 70, K.mat(col, { rough: 0.9, emissive: col, ei: 0.15 }), { parent: g });
  K.place(G.cloth, 6, 0, DH - (near ? 20 : 36));
  // Walls on both sides of the gate, with merlons.
  const len = span - GATE_HALF - 20;
  const mer = [];
  for (const sd of [-1, 1]) {
    const w = K.box(TH, len, WH, M.stone, { parent: g });
    K.place(w, -TH / 2 - 6, sd * (GATE_HALF + 20 + len / 2), WH / 2);
    for (let y = GATE_HALF + 40; y < span - 10; y += 44) mer.push({ x: -TH / 2 - 6, y: sd * y, h: WH });
  }
  for (let y = -GATE_HALF; y <= GATE_HALF; y += 44) mer.push({ x: -20, y, h: DH + 26 });
  merlons(K, g, mer, M.stone);
  // Rubble shown once the gate is broken.
  G.rubble = K.group(g);
  for (let j = 0; j < 7; j++) {
    const pl = K.box(18, 70 + (j % 3) * 20, 10, M.wood, { parent: G.rubble });
    K.place(pl, 20 + (j % 4) * 26, -110 + j * 36, 6 + (j % 2) * 8);
    pl.rotation.y = j * 0.9; pl.rotation.z = (j % 2 ? 0.3 : -0.2);
  }
  G.rubble.visible = false;
  // Towers flanking the gate; banners; the oil cauldron and its pourer on the wall walk.
  const towerName = near ? `medieval/building_tower_base_${flag}` : `medieval/building_tower_A_${flag}`;
  for (const sd of [-1, 1]) {
    const tw = K.model(towerName, { height: near ? 100 : 300, parent: g });
    K.place(tw, -40, sd * (GATE_HALF + 52));
  }
  if (!near) {
    for (const sd of [-1, 1]) {
      const bn = K.model(`dungeon/banner_${flag}`, { height: 110, parent: g });
      K.place(bn, 4, sd * (GATE_HALF + 92), WH - 112);
      K.face(bn, -Math.PI / 2);
    }
  }
  const lx = -18, ly = 34;
  G.nx = geo.x + geo.nx * lx - geo.ny * ly; G.ny = geo.y + geo.ny * lx + geo.nx * ly; G.nh = DH + 26;
  G.npc = hiDetail ? K.npc('barbarian', { marker: false, parent: Lg }) : null;
  G.caul = K.group(g);
  K.place(G.caul, -4, -30, DH + 26);
  const pot = K.cyl(20, 28, M.iron, { parent: G.caul, seg: 14 });
  pot.position.y = 0;
  const hot = K.disc(17, K.glow('#ffb02e'), { parent: G.caul });
  hot.position.y = 26;
  // Gate health bar on the ground in front of the door.
  G.dec = K.decal(330, { px: 256, h: 1.1, parent: Lg });
  G.dec.at(geo.x + geo.nx * 46, geo.y + geo.ny * 46, 1.1);
  return G;
}

function buildLayout(K, o, lay, n, lo) {
  const M = o.mats;
  const grp = K.group();
  const teamsC = lay.L === 'c' && n === 4;
  const cols = lay.gates.map((_, k) => (teamsC ? TEAM_COL[k] : K.col(k)));
  const flags = lay.gates.map((_, k) => (teamsC ? FLAG[k] : FLAG[K.roster[k]?.color ?? k] || 'red'));
  const Ly = { grp, lay, gates: [], flags: [] };
  K.layer({ x0: -700, y0: -700, x1: 1700, y1: 1700, h: 0.4, transparent: true, once: true, maxPx: 2048, parent: grp, draw: (d) => drawField(d, lay, cols, false) });
  // Gatehouses.
  lay.gates.forEach((geo, k) => {
    const near = geo.ny < -0.5;
    const span = lay.L === 'c' ? 900 : 170 + 40;
    Ly.gates.push(buildGate(K, grp, M, geo, k, cols[k], flags[k], near, span, !lo || !near));
  });
  // Rocks and stakes (cheval de frise).
  for (const rk of lay.rocks) {
    if (rk.k === 0) {
      const m = K.model(rk.r > 44 ? 'medieval/rock_single_B' : 'medieval/rock_single_D', { size: rk.r * 2.5, parent: grp });
      K.place(m, rk.x, rk.y); m.rotation.y = rk.x * 0.01;
    } else {
      const sg = K.group(grp);
      K.place(sg, rk.x, rk.y);
      const log = K.cyl(9, rk.r * 2.6, M.dark, { parent: sg, center: true, seg: 10 });
      log.rotation.z = Math.PI / 2; log.position.y = 20;
      for (let j = 0; j < 5; j++) {
        const st = K.cone(6, 70, M.wood, { parent: sg });
        K.place(st, -rk.r + j * (rk.r / 2), 0, 0);
        st.rotation.x = j % 2 ? 0.75 : -0.75;
        st.position.y = 2;
      }
    }
  }
  if (lay.L === 'c') buildCorridorScenery(K, grp, M, cols, flags, lo, Ly);
  else buildCrossScenery(K, grp, M, lay, cols, flags, lo, Ly);
  return Ly;
}

function addFlag(K, grp, Ly, name, x, y, h, face) {
  const f = K.model(name, { height: h, parent: grp });
  K.place(f, x, y);
  K.face(f, face);
  Ly.flags.push({ f, base: f.rotation.y, ph: x * 0.01 + y * 0.003 });
}

function buildCorridorScenery(K, grp, M, cols, flags, lo, Ly) {
  // Palisades along the long sides of the field.
  const fence = [];
  for (let y = 90; y < 920; y += 82) { fence.push({ x: COR.x0 - 34, y, rot: 0 }); fence.push({ x: COR.x1 + 34, y, rot: 0 }); }
  K.scatter('medieval/fence_wood_straight', fence, { size: 84, parent: grp });
  // The two castles behind their gates (the near one is off screen, only its towers show).
  const c1 = K.model(`medieval/building_castle_${flags[1]}`, { height: 520, parent: grp });
  K.place(c1, CX, -330);
  K.face(c1, Math.PI / 2);
  addFlag(K, grp, Ly, `medieval/flag_${flags[1]}`, CX - 260, -40, 200, Math.PI / 2);
  addFlag(K, grp, Ly, `medieval/flag_${flags[1]}`, CX + 260, -40, 200, Math.PI / 2);
  addFlag(K, grp, Ly, `medieval/flag_${flags[0]}`, CX - 260, 1050, 150, -Math.PI / 2);
  addFlag(K, grp, Ly, `medieval/flag_${flags[0]}`, CX + 260, 1050, 150, -Math.PI / 2);
  // Siege camps on both flanks: tents, catapult towers, ladders, supplies, campfires.
  const camp = (sx) => {
    const x0 = sx < 0 ? -40 : 1040;
    const t1 = K.model('medieval/tent', { size: 150, parent: grp }); K.place(t1, x0 + sx * 150, 300); K.face(t1, sx < 0 ? 0 : Math.PI);
    const t2 = K.model('medieval/tent', { size: 135, parent: grp }); K.place(t2, x0 + sx * 120, 740); K.face(t2, sx < 0 ? 0.3 : Math.PI - 0.3);
    const cat = K.model(`medieval/building_tower_catapult_${sx < 0 ? 'red' : 'blue'}`, { height: 260, parent: grp });
    K.place(cat, x0 + sx * 260, sx < 0 ? 560 : 440); K.face(cat, sx < 0 ? 0 : Math.PI);
  };
  camp(-1); camp(1);
  const props = (name, list, size) => K.scatter(name, list.map(([x, y, rot]) => ({ x, y, rot })), { size, parent: grp });
  props('medieval/barrel', [[60, 470, 0], [95, 500, 1], [940, 520, 0], [905, 480, 2], [30, 905, 1], [970, 95, 2]], 46);
  props('medieval/crate_A_big', [[40, 540, 0.3], [960, 450, 0.2], [70, 120, 0.5], [930, 880, 0.1]], 58);
  props('medieval/sack', [[110, 560, 0], [890, 430, 1], [120, 610, 2]], 42);
  props('medieval/projectile_catapult', [[-120, 470, 0], [-90, 500, 1], [1120, 530, 0], [1090, 500, 1], [-140, 520, 2], [1140, 480, 2]], 40);
  props('medieval/weaponrack', [[30, 300, Math.PI / 2], [970, 700, -Math.PI / 2]], 80);
  props('medieval/resource_lumber', [[-60, 160, 0.4], [1060, 840, 2.4]], 110);
  props('medieval/wheelbarrow', [[-30, 860, 0.8], [1030, 140, 2.2]], 80);
  // Campfires (light + embers) between the tents.
  const fires = [[-160, 520], [1160, 480]];
  for (const [x, y] of fires) {
    const f = K.group(grp); K.place(f, x, y);
    for (let j = 0; j < 4; j++) { const l = K.cyl(6, 50, M.dark, { parent: f, center: true, seg: 6 }); l.rotation.z = Math.PI / 2; l.rotation.y = j * 0.8; l.position.y = 6; }
    const fl = K.cone(18, 44, K.glow('#ff9a2a', { opacity: 0.9, add: true }), { parent: f, cast: false }); fl.position.y = 8;
  }
  if (!lo) for (const [x, y] of fires) K.light(x, y, 80, '#ff8a3a', 2.4, { flicker: 0.6, dist: 600 });
  K.light(CX, 30, 220, '#ffb35c', 1.4, { flicker: 0.4, dist: 700 });
  // Torches at the gates.
  for (const [x, y] of [[CX - 190, 95], [CX + 190, 95], [CX - 190, 905], [CX + 190, 905]]) K.place(K.model('dungeon/torch_lit', { height: 70, parent: grp }), x, y);
  // Woods, hills and stormy mountains far away.
  const trees = [], trees2 = [];
  for (let k = 0; k < (lo ? 20 : 40); k++) {
    const sx = k % 2 ? 1 : -1;
    const x = CX + sx * (900 + (k % 5) * 130 + ((k * 37) % 90));
    const y = -500 + ((k * 211) % 1900);
    (k % 3 ? trees : trees2).push({ x, y, rot: k * 0.7, s: 0.8 + (k % 4) * 0.12 });
  }
  K.scatter('medieval/trees_B_large', trees, { size: 280, parent: grp });
  K.scatter('medieval/trees_A_medium', trees2, { size: 220, parent: grp });
  K.scatter('medieval/hills_B_trees', [{ x: -900, y: -600, rot: 0.4 }, { x: 1900, y: -650, rot: 2.1 }, { x: -1100, y: 900, rot: 1.2 }, { x: 2100, y: 1000, rot: 3 }], { size: 1000, parent: grp });
  K.scatter('medieval/mountain_C_grass_trees', [{ x: CX - 1300, y: -1600, rot: 0.3 }, { x: CX + 1400, y: -1700, rot: 2 }, { x: CX + 100, y: -2100, rot: 1 }], { size: 1600, parent: grp });
  K.scatter('medieval/building_destroyed', [{ x: -330, y: 60, rot: 0.5 }, { x: 1330, y: 940, rot: 2.6 }], { size: 220, parent: grp });
}

function buildCrossScenery(K, grp, M, lay, cols, flags, lo, Ly) {
  // Low stone walls along the arms (and closing the missing arm with 3 players).
  const segs = [];
  const add = (x0, y0, x1, y1) => segs.push([x0, y0, x1, y1]);
  add(XA, XB, XA, XE1); add(XB, XB, XB, XE1); // bottom arm
  add(XA, XE0, XA, XA); add(XB, XE0, XB, XA); // top arm
  add(XE0, XA, XA, XA); add(XE0, XB, XA, XB); // left arm
  if (lay.S >= 4) { add(XB, XA, XE1, XA); add(XB, XB, XE1, XB); } else add(XB, XA, XB, XB);
  const mer = [];
  for (const [x0, y0, x1, y1] of segs) {
    const vert = x0 === x1;
    const len = vert ? Math.abs(y1 - y0) : Math.abs(x1 - x0);
    const out = vert ? (x0 === XA ? -1 : 1) : (y0 === XA ? -1 : 1);
    const cx = (x0 + x1) / 2 + (vert ? out * 18 : 0), cy = (y0 + y1) / 2 + (vert ? 0 : out * 18);
    const near = (vert && Math.max(y0, y1) > XB + 5) || (!vert && y0 === XB);
    const h = near ? 40 : 70;
    const w = K.box(vert ? 34 : len + 34, vert ? len + 34 : 34, h, M.stone, { parent: grp });
    K.place(w, cx, cy, h / 2);
    for (let s2 = 22; s2 < len - 10; s2 += 46) mer.push(vert ? { x: cx, y: Math.min(y0, y1) + s2, h } : { x: Math.min(x0, x1) + s2, y: cy, h });
  }
  merlons(K, grp, mer, M.stone);
  // Corner blocks: far corners get houses and catapult towers, near corners only low props.
  const far = [[150, 150], [850, 150]], nearC = [[150, 850], [850, 850]];
  far.forEach(([x, y], k) => {
    const h1 = K.model(k ? 'medieval/building_home_A_blue' : 'medieval/building_home_B_red', { size: 190, parent: grp });
    K.place(h1, x + (k ? 30 : -30), y - 40); K.face(h1, Math.PI / 2);
    const cat = K.model(`medieval/building_tower_catapult_${k ? 'blue' : 'red'}`, { height: 220, parent: grp });
    K.place(cat, x + (k ? -60 : 60), y + 90); K.face(cat, k ? Math.PI * 0.75 : Math.PI * 0.25);
  });
  const props = (name, list, size) => K.scatter(name, list.map(([x, y, rot]) => ({ x, y, rot })), { size, parent: grp });
  props('medieval/tent', far.map(([x, y], k) => [x + (k ? 110 : -110), y + 200, k ? Math.PI : 0]), 120);
  props('medieval/resource_lumber', nearC.map(([x, y], k) => [x + (k ? 40 : -40), y + 60, k ? 2.2 : 0.4]), 100);
  props('medieval/barrel', [[250, 720, 0], [280, 760, 1], [750, 720, 0], [720, 760, 2], [90, 290, 1], [910, 290, 0]], 44);
  props('medieval/crate_A_big', [[220, 790, 0.3], [790, 800, 0.2], [270, 240, 0.4], [730, 260, 0.1]], 54);
  props('medieval/crate_B_small', [[250, 830, 0.3], [760, 840, 0.6]], 36);
  props('medieval/sack', [[290, 700, 0], [700, 700, 1], [240, 280, 2]], 40);
  props('medieval/projectile_catapult', [[130, 260, 0], [160, 280, 1], [860, 260, 0], [840, 290, 1]], 38);
  // Campfire in each near corner and torches at the gate towers.
  for (const [x, y] of nearC) {
    const f = K.group(grp); K.place(f, x + (x < CX ? 60 : -60), y - 80);
    for (let j = 0; j < 4; j++) { const l = K.cyl(6, 46, M.dark, { parent: f, center: true, seg: 6 }); l.rotation.z = Math.PI / 2; l.rotation.y = j * 0.8; l.position.y = 6; }
    const fl = K.cone(16, 40, K.glow('#ff9a2a', { opacity: 0.9, add: true }), { parent: f, cast: false }); fl.position.y = 8;
  }
  if (!lo) { K.light(210, 770, 80, '#ff8a3a', 2.2, { flicker: 0.6, dist: 520 }); K.light(790, 770, 80, '#ff8a3a', 2.2, { flicker: 0.6, dist: 520 }); }
  K.light(CX, CY, 260, '#ffcf8a', 0.9, { dist: 900 });
  // Flags of every gate's owner on top of the gate towers' outer side.
  lay.gates.forEach((geo, k) => {
    const x = geo.x - geo.nx * 120, y = geo.y - geo.ny * 120;
    if (geo.ny < -0.5) return; // near gate: nothing tall in front of the camera
    addFlag(K, grp, Ly, `medieval/flag_${flags[k]}`, x, y, 170, Math.atan2(geo.ny, geo.nx));
  });
  const c1 = K.model(`medieval/building_castle_${flags[1]}`, { height: 420, parent: grp });
  K.place(c1, CX, -360); K.face(c1, Math.PI / 2);
  // Woods and mountains around.
  const trees = [];
  for (let k = 0; k < (lo ? 18 : 36); k++) {
    const a = (k / (lo ? 18 : 36)) * TAU;
    if (Math.sin(a) > 0.75) continue;
    trees.push({ x: CX + Math.cos(a) * (1000 + (k % 3) * 160), y: CY + Math.sin(a) * (900 + (k % 4) * 120), rot: k, s: 0.8 + (k % 3) * 0.15 });
  }
  K.scatter('medieval/trees_B_large', trees, { size: 280, parent: grp });
  K.scatter('medieval/tree_single_B', [[-80, 120], [1080, 880], [-60, 640], [1060, 360]].map(([x, y], k) => ({ x, y, rot: k })), { size: 150, parent: grp });
  K.scatter('medieval/mountain_C_grass_trees', [{ x: CX - 1300, y: -1500, rot: 0.3 }, { x: CX + 1400, y: -1600, rot: 2 }], { size: 1600, parent: grp });
  K.scatter('medieval/hills_B_trees', [{ x: -900, y: 300, rot: 0.4 }, { x: 1900, y: 400, rot: 2.1 }], { size: 900, parent: grp });
}

// The two-headed battering ram: log with iron rams' heads, roofed wheeled frame, war drum on top.
function buildRam(K, M) {
  const g = K.group();
  const R = { g, wheels: [], eyes: [], sticks: [] };
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const w = K.cyl(24, 12, M.dark, { parent: g, center: true, seg: 14 });
      w.rotation.x = Math.PI / 2;
      K.place(w, sx * 72, sy * 50, 24);
      R.wheels.push(w);
    }
    const ax = K.box(12, 100, 10, M.dark, { parent: g }); K.place(ax, sx * 72, 0, 24);
    for (const sy of [-1, 1]) { const post = K.box(10, 10, 92, M.wood, { parent: g }); K.place(post, sx * 84, sy * 40, 80); }
  }
  for (const sy of [-1, 1]) {
    const beam = K.box(200, 12, 14, M.wood, { parent: g }); K.place(beam, 0, sy * 40, 40);
    const roof = K.box(176, 52, 7, M.hide, { parent: g }); K.place(roof, 0, sy * 20, 130); roof.rotation.x = sy > 0 ? -0.55 : 0.55;
  }
  const ridge = K.box(184, 10, 10, M.dark, { parent: g }); K.place(ridge, 0, 0, 146);
  // The hanging log with an iron ram's head at each end.
  R.log = K.group(g);
  const log = K.cyl(19, 250, M.wood, { parent: R.log, center: true, seg: 14 });
  log.rotation.z = Math.PI / 2; log.position.y = 74;
  for (const sx of [-1, 1]) {
    const head = K.ball(26, M.iron, { parent: R.log, seg: 16 }); K.place(head, sx * 132, 0, 76);
    const snout = K.ball(14, M.iron, { parent: R.log, seg: 12 }); K.place(snout, sx * 154, 0, 70);
    for (const sy of [-1, 1]) {
      const horn = K.torus(13, 5, M.horn, { parent: R.log }); K.place(horn, sx * 122, sy * 24, 88); horn.rotation.x = Math.PI / 2; horn.rotation.y = sy * 0.4;
      const eye = K.ball(5, K.glow('#ff3a2a'), { parent: R.log, cast: false, seg: 8 }); K.place(eye, sx * 150, sy * 12, 88); R.eyes.push(eye);
    }
    const chain = K.box(4, 4, 52, M.iron, { parent: g }); K.place(chain, sx * 60, 0, 104);
  }
  // War drum on the ridge.
  const drum = K.cyl(22, 24, K.mat('#9b3a2a', { rough: 0.6 }), { parent: g, seg: 16 }); K.place(drum, 0, 0, 150);
  R.drumTop = K.disc(21, K.mat('#e8d3a8', { unique: true, rough: 0.7 }), { parent: g, seg: 20 }); R.drumTop.position.y = 175;
  for (const sy of [-1, 1]) {
    const st = K.group(g); K.place(st, 0, sy * 30, 182);
    const stick = K.box(5, 5, 40, M.dark, { parent: st }); stick.position.y = 16;
    R.sticks.push(st);
  }
  R.dec = K.decal(420, { px: 256, h: 1.6 });
  return R;
}
