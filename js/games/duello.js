// Duello all'Ultimo Sangue (finto) — sword duel of timing and mind games, 2–4 players (free-for-all or 2 vs 2).
// A = ALTO (overhead cut), B = BASSO (low sweep), hold A or B = AFFONDO (thrust). Rock-paper-scissors:
// Basso beats Alto (you duck under it), Alto beats Affondo (you knock the blade down), Affondo beats Basso (longer reach).
// Same move = clash of blades. Every hit dents you: dented duellists fly further. Push them off the stone into the chasm!
import { clamp, dist, norm, r1, r2, TAU, wrapAngle } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500;
const DURATION = 50;
const R0 = 420, RMIN = 290, SHRINK_T0 = 28, SHRINK_T1 = 44;    // the stone platform crumbles at the end
const PONTE_HW = 150, PONTE_X0 = 60, PONTE_X1 = 940;          // 'ponte' variant: a rope bridge strip
const PR = 42, SPEED = 330;
const FALLS_TO_LOSE = 2, RESPAWN = 1.3, INV = 1.1;
const HOLD_T = 0.2, INTENT_T = 0.1;     // hold to turn a cut into a thrust; a button held ≥ 0.1 s already "means" thrust
const ST_MAX = 100, ST_REGEN = 30, ST_DELAY = 0.45, FEINT_COST = 8;
const ALTO = 1, BASSO = 2, AFFONDO = 3;
// Moves: windup time, reach (beyond the target's radius), half arc, push speed, dents, stamina, recovery, stun.
const MV = [null,
  { wind: 0.34, reach: 125, arc: 1.05, push: 490, dent: 14, cost: 20, rec: 0.28, stun: 0.35, step: 140, name: 'ALTO' },
  { wind: 0.34, reach: 115, arc: 1.2, push: 340, dent: 10, cost: 18, rec: 0.28, stun: 0.75, step: 90, name: 'BASSO' },
  { wind: 0.62, reach: 180, arc: 0.5, push: 700, dent: 20, cost: 34, rec: 0.45, stun: 0.45, step: 560, name: 'AFFONDO' },
];
const beats = (a, b) => (a === BASSO && b === ALTO) || (a === ALTO && b === AFFONDO) || (a === AFFONDO && b === BASSO);
const BEATER = [0, BASSO, AFFONDO, ALTO]; // BEATER[x] = the move that beats x
// Stun kinds (view): 1 hit, 2 tripped (on the ground), 3 parried (staggered), 4 clash.
const SIDE = [[0, 1], [0, -1], [-1, 0], [1, 0]];
const TEAM_COL = ['#ff4b5c', '#3fa9ff'];
const FLAG = ['red', 'blue', 'green', 'yellow'];

const isPonte = (g) => g.variant === 'ponte';

function spawnPos(s, g, i) {
  const n = s.p.length;
  if (g.teams) {
    const tm = g.teams[i];
    const k = s.p.filter((q) => q.i < i && g.teams[q.i] === tm).length;
    if (isPonte(g)) return { x: tm ? (k ? 690 : 800) : (k ? 310 : 200), y: CY + (k ? 50 : -50) * (tm ? -1 : 1) };
    const a = (tm ? -Math.PI / 2 : Math.PI / 2) + (k ? 0.45 : -0.45);
    return { x: CX + Math.cos(a) * 250, y: CY + Math.sin(a) * 250 };
  }
  if (isPonte(g)) {
    const xs = n <= 2 ? [250, 750] : n === 3 ? [200, 800, 500] : [180, 820, 400, 600];
    const ys = n <= 2 ? [CY, CY] : n === 3 ? [CY, CY, CY - 70] : [CY + 50, CY - 50, CY - 60, CY + 60];
    return { x: xs[i], y: ys[i] };
  }
  const [ux, uy] = SIDE[i];
  return { x: CX + ux * 250, y: CY + uy * 250 };
}

function resetPlayer(s, g, p) {
  const sp = spawnPos(s, g, p.i);
  p.x = sp.x; p.y = sp.y; p.vx = 0; p.vy = 0; p.kx = 0; p.ky = 0;
  p.fa = Math.atan2(CY - p.y, CX - p.x);
  if (isPonte(g)) p.fa = p.x < CX ? 0 : Math.PI;
  p.mv = 0; p.ph = 0; p.mt = 0; p.stun = 0; p.sk = 0; p.st = ST_MAX; p.fall = 0; p.inv = INV;
}

function alive(p) { return !p.elim && p.fall <= 0; }

// Where the arena edge is for p (distance to the edge; negative = off the stone).
function edgeGap(s, g, x, y) {
  if (isPonte(g)) return PONTE_HW - Math.abs(y - CY);
  return s.R - dist(x, y, CX, CY);
}

// The move p "means" right now (a held button already reads as a thrust).
function intent(p) {
  if (p.ph !== 1 && p.ph !== 2) return 0;
  if (p.mv !== AFFONDO && p.held && p.mt >= INTENT_T) return AFFONDO;
  return p.mv;
}

function cancel(p) { p.mv = 0; p.ph = 0; p.mt = 0; p.held = false; }

function knock(p, from, speed) {
  const n = norm(p.x - from.x || 0.01, p.y - from.y);
  p.kx += n.x * speed; p.ky += n.y * speed;
}

function strike(s, g, X) {
  const M = MV[X.mv];
  const gum = g.variant === 'gomma' ? 1.6 : 1;
  // The thrust lunges forward.
  X.kx += Math.cos(X.fa) * M.step; X.ky += Math.sin(X.fa) * M.step;
  X.ak++;
  g.sfx(X.mv === AFFONDO ? 'whoosh' : 'slide', { pitch: X.mv === BASSO ? 0.8 : 1.2, vol: 0.7 });
  let any = false;
  for (const Y of s.p) {
    if (Y === X || !alive(Y) || Y.inv > 0 || g.ally(X.i, Y.i)) continue;
    const dx = Y.x - X.x, dy = Y.y - X.y, d = Math.hypot(dx, dy);
    if (d - Y.r > M.reach + X.r * 0.3) continue;
    if (Math.abs(wrapAngle(Math.atan2(dy, dx) - X.fa)) > M.arc) continue;
    any = true;
    const tY = intent(Y);
    const mx = (X.x + Y.x) / 2, my = (X.y + Y.y) / 2;
    if (tY && beats(tY, X.mv)) {
      // Right counter: X is parried and staggered; Y's own blow comes right away (riposte).
      cancel(X); X.stun = 0.6; X.sk = 3; X.st = Math.max(0, X.st - 10);
      knock(X, Y, 300 * gum);
      if (Y.ph === 1) { Y.mv = tY; Y.mt = Math.max(Y.mt, MV[tY].wind - 0.07); Y.held = false; }
      Y.pc = (Y.pc || 0) + 1;
      const txt = tY === BASSO ? 'SOTTO LA LAMA!' : tY === ALTO ? 'DEVIATO!' : 'PARATA LUNGA!';
      g.text(Y.x, Y.y - Y.r - 40, txt, { player: Y.i, size: 50 });
      g.sfx('bang', { pitch: 1.3 }); g.sfx('boing', { pitch: 0.7, vol: 0.6 });
      g.ring(Y.x, Y.y, { player: Y.i, r: Y.r + 60 });
      g.burst(mx, my, { color: '#fff6c0', n: 22, speed: 420 });
      g.shake(0.4); g.hitstop(0.1); g.vibrate(X.i, 120); g.vibrate(Y.i, 40);
      return;
    }
    if (tY && tY === X.mv && Y.ph === 1) {
      // Same move: blades clash, both bounce off.
      cancel(X); cancel(Y);
      for (const [a, b] of [[X, Y], [Y, X]]) { a.stun = 0.3; a.sk = 4; a.st = Math.max(0, a.st - 12); knock(a, b, 380 * gum); }
      g.text(mx, my - 60, 'SCINTILLE!', { color: '#ffe066', size: 52 });
      g.sfx('zap'); g.sfx('bang', { pitch: 1.6, vol: 0.7 });
      g.burst(mx, my, { color: '#ffe066', n: 30, speed: 520 }); g.burst(mx, my, { color: '#ffffff', n: 12, speed: 300 });
      g.shake(0.45); g.hitstop(0.12); g.vibrate(X.i, 80); g.vibrate(Y.i, 80);
      return;
    }
    // Clean hit.
    const crit = Y.stun > 0 && Y.sk === 2;
    cancel(Y);
    const k = (1 + Y.dents / 90) * (crit ? 1.3 : 1) * gum;
    knock(Y, X, M.push * k);
    Y.dents = Math.min(250, Y.dents + M.dent * (g.variant === 'gomma' ? 1.5 : 1));
    Y.stun = M.stun; Y.sk = X.mv === BASSO ? 2 : 1; Y.hk++;
    const cut = tY === AFFONDO && X.mv === ALTO;
    g.text(Y.x, Y.y - Y.r - 36, crit ? 'COLPO DI GRAZIA!' : cut ? 'TAGLIATO!' : X.mv === BASSO ? 'SGAMBETTO!' : X.mv === AFFONDO ? 'AFFONDO!' : 'ZAC!', { player: X.i, size: X.mv === AFFONDO || crit ? 56 : 44 });
    g.sfx(X.mv === AFFONDO ? 'punch' : 'hit', { pitch: X.mv === BASSO ? 0.8 : 1 });
    if (g.variant === 'gomma') g.sfx('boing', { vol: 0.8 });
    g.burst(Y.x, Y.y, { player: Y.i, n: X.mv === AFFONDO ? 24 : 14, speed: 380 });
    g.shake(X.mv === AFFONDO ? 0.5 : 0.3); g.hitstop(X.mv === AFFONDO ? 0.09 : 0.06); g.vibrate(Y.i, 100);
  }
  if (!any) X.miss = 0.25;
}

// Pick the target: the rival closest to where the stick points (with some stickiness), else the nearest.
function pickTarget(s, g, p, ix, iy) {
  let cur = s.p[p.tg];
  if (cur && (cur === p || !alive(cur) || g.ally(p.i, cur.i))) cur = null;
  const m = Math.hypot(ix, iy);
  const score = (q) => {
    const a = Math.atan2(q.y - p.y, q.x - p.x);
    const d = dist(p.x, p.y, q.x, q.y);
    return m > 0.5 ? Math.abs(wrapAngle(a - Math.atan2(iy, ix))) + d / 1400 : d / 400;
  };
  let best = null, bs = 1e9;
  for (const q of s.p) {
    if (q === p || !alive(q) || g.ally(p.i, q.i)) continue;
    const sc = score(q);
    if (sc < bs) { bs = sc; best = q; }
  }
  if (!best) { p.tg = -1; return; }
  if (!cur || (m > 0.5 && best !== cur && bs < score(cur) - 0.6)) p.tg = best.i;
}

function nextGust(s, g) {
  const a = g.rng.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI / 4, -Math.PI * 0.75]);
  s.gust = { dx: Math.cos(a), dy: Math.sin(a), at: s.t + g.rng.range(6, 8), on: 0, warned: false };
  if (isPonte(g)) { s.gust.dx = 0; s.gust.dy = g.rng() < 0.5 ? 1 : -1; }
}

// ---------------------------------------------------------------- computer player
function duelloBot(s, me, g, B) {
  const p = s.p[me];
  if (!p || !alive(p) || p.stun > 0) return { x: 0, y: 0 };
  const lv = B.level, m = B.mem;
  const pon = isPonte(g);
  // Choose the victim: easy = nearest; better = nearest weighted by how close to the edge and how dented it is.
  let tg = null, best = 1e9;
  for (const q of s.p) {
    if (q === p || !alive(q) || g.ally(me, q.i)) continue;
    const d = dist(p.x, p.y, q.x, q.y);
    const sc = lv === 0 ? d : d + edgeGap(s, g, q.x, q.y) * (lv === 2 ? 0.9 : 0.4) - q.dents * (lv === 2 ? 1.2 : 0.5) + (q.inv > 0 ? 300 : 0);
    if (sc < best) { best = sc; tg = q; }
  }
  if (!tg) return { x: 0, y: 0 };
  const dx = tg.x - p.x, dy = tg.y - p.y, d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  const gap = edgeGap(s, g, p.x, p.y);
  // Keep holding a thrust until it fires (the press reaches the game after the bot's reaction delay).
  if (m.hold && g.t < m.holdT && (p.ph === 0 || p.ph === 1)) return { x: ux * 0.3, y: uy * 0.3, a: m.hold === 'a', b: m.hold === 'b' };
  m.hold = null;
  const hold = (btn, x, y) => { m.hold = btn; m.holdT = g.t + 1.1; return { x, y, a: btn === 'a', b: btn === 'b' }; };
  // Feint (hard bot): switch alto <-> basso mid-windup.
  if (p.ph === 1 && m.feint && p.mt > 0.1 && p.mv !== AFFONDO) {
    const f = m.feint; m.feint = null;
    return f === 'a' ? { x: 0, y: 0, tapA: true } : { x: 0, y: 0, tapB: true };
  }
  // Wind: lean against it near the edge.
  let wx = 0, wy = 0;
  if (s.gust && (s.gust.on > 0 || (lv === 2 && s.gust.warned))) { wx = -s.gust.dx * 0.7; wy = -s.gust.dy * 0.7; }
  // 1) Danger: too close to the edge → back to the middle (unless I'm busy).
  const safe = lv === 0 ? 70 : 110;
  if (gap < safe && p.ph === 0) {
    const n = pon ? { x: 0, y: Math.sign(CY - p.y) } : norm(CX - p.x, CY - p.y);
    return { x: n.x + wx * 0.3, y: n.y + wy * 0.3 };
  }
  // 2) Threats: a rival winding up a blow that reaches me.
  let threat = null;
  for (const q of s.p) {
    if (q === p || !alive(q) || g.ally(me, q.i) || q.ph !== 1) continue;
    const qd = dist(p.x, p.y, q.x, q.y);
    const M = MV[intent(q)];
    if (qd - p.r < M.reach + q.r * 0.3 + 30 && Math.abs(wrapAngle(Math.atan2(p.y - q.y, p.x - q.x) - q.fa)) < M.arc + 0.2) { threat = q; break; }
  }
  if (threat && p.ph === 0) {
    const tt = intent(threat);
    const left = MV[tt].wind - threat.mt;
    const cnt = BEATER[tt];
    const pc = [0.32, 0.6, 0.85][lv];
    if (m.react !== threat.ak + '|' + threat.i) { m.react = threat.ak + '|' + threat.i; m.roll = B.rng(); }
    const can = p.st >= MV[cnt].cost;
    if (m.roll < pc && can && left > (cnt === AFFONDO ? 0.12 : 0.03)) {
      const n = norm(threat.x - p.x, threat.y - p.y);
      if (cnt === AFFONDO) return hold('a', n.x * 0.2, n.y * 0.2);
      return cnt === ALTO ? { x: n.x * 0.2, y: n.y * 0.2, tapA: true } : { x: n.x * 0.2, y: n.y * 0.2, tapB: true };
    }
    // Otherwise step back / sideways out of reach (toward the middle).
    const n = norm(p.x - threat.x, p.y - threat.y);
    const c = pon ? { x: 0, y: Math.sign(CY - p.y) * 0.6 } : norm(CX - p.x, CY - p.y);
    return { x: n.x + c.x * 0.8 - n.y * 0.4, y: n.y + c.y * 0.8 + n.x * 0.4 };
  }
  if (p.ph !== 0) return { x: ux * 0.2, y: uy * 0.2 };
  // 3) Attack when in reach.
  const rd = d - tg.r;
  const tBusy = tg.ph === 3 || tg.stun > 0;
  if (p.st >= MV[ALTO].cost && tg.inv <= 0) {
    if (tg.stun > 0.45 && rd < MV[AFFONDO].reach - 20 && p.st >= MV[AFFONDO].cost) return hold('a', ux * 0.3, uy * 0.3);
    if (rd < MV[BASSO].reach - (lv === 2 ? 15 : 0) && (tBusy || tg.ph === 0) && (m.cool ?? 0) < g.t) {
      m.cool = g.t + [0.9, 0.45, 0.25][lv] + B.rng() * [0.8, 0.4, 0.2][lv];
      const r = B.rng();
      if (lv === 2 && r < 0.25) m.feint = B.rng() < 0.5 ? 'a' : 'b';
      if (rd > MV[ALTO].reach - 10 || r < 0.15) return hold('b', ux * 0.3, uy * 0.3);
      return B.rng() < 0.5 ? { x: ux * 0.3, y: uy * 0.3, tapA: true } : { x: ux * 0.3, y: uy * 0.3, tapB: true };
    }
  }
  // 4) Positioning: get between the target and the middle (so blows push it outward), at striking distance.
  const want = tg.r + p.r + (lv === 0 ? 60 : 75);
  let ox, oy;
  if (pon) { ox = 0; oy = Math.sign(CY - tg.y) || 1; if (Math.abs(tg.y - CY) < 40) { ox = Math.sign(p.x - tg.x) || 1; oy = 0; } }
  else { const n = norm(CX - tg.x || 0.01, CY - tg.y); ox = n.x; oy = n.y; if (dist(tg.x, tg.y, CX, CY) < 80) { const q = norm(p.x - tg.x || 0.01, p.y - tg.y); ox = q.x; oy = q.y; } }
  let gx = tg.x + ox * want, gy = tg.y + oy * want;
  if (lv === 0) { gx = tg.x - ux * want; gy = tg.y - uy * want; }
  if (p.st < MV[ALTO].cost + 10) { gx = tg.x - ux * (want + 120); gy = tg.y - uy * (want + 120); } // out of breath: keep away
  // Keep the goal on the stone.
  if (pon) gy = clamp(gy, CY - PONTE_HW + 70, CY + PONTE_HW - 70);
  else { const n = norm(gx - CX || 0.01, gy - CY), gd = dist(gx, gy, CX, CY), lim = s.R - 100; if (gd > lim) { gx = CX + n.x * lim; gy = CY + n.y * lim; } }
  const n = norm(gx - p.x, gy - p.y), gd = dist(gx, gy, p.x, p.y);
  const k = clamp(gd / 80, 0, 1);
  // Moving toward a goal behind the target would pick the wrong target: aim the stick at the target when close.
  return { x: n.x * k + wx * 0.5 + (gd < 30 ? ux * 0.1 : 0), y: n.y * k + wy * 0.5 + (gd < 30 ? uy * 0.1 : 0) };
}

export default {
  id: 'duello',
  name: "Duello all'Ultimo Sangue (finto)",
  rule: 'A alto, B basso, tieni premuto: affondo. Buttali nel burrone!',
  verb: 'IN GUARDIA!',
  inspired: 'Nidhogg · Sasso-carta-forbice',
  cam: 'top',
  split: false,
  players: 4,
  teams: true,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Alto', b: 'Basso' },
  duration: DURATION,
  supports: ['scale'],
  noMods: ['peperoncino'],
  variants: [
    { id: 'ponte', name: 'Ponte di Corda', desc: 'Si duella su uno stretto ponte di corda sopra il burrone: un passo di lato e giù!' },
    { id: 'bufera', name: 'Bufera sul Burrone', desc: 'Raffiche di vento spingono tutti: la freccia avvisa da dove arrivano.' },
    { id: 'gomma', name: 'Spade di Gomma', desc: 'Il fabbro ha sbagliato lega: spade di gomma, colpi che fanno volare e fiato infinito!' },
  ],
  help: {
    goal: "Butta gli altri giù dalla pietra nel burrone: chi cade 2 volte è fuori. L'ultimo in piedi vince (o chi ha più vite allo scadere).",
    dir: 'Muoviti; guardi sempre il tuo bersaglio. Con 3–4 duellanti, punta lo stick verso chi vuoi sfidare.',
    a: 'ALTO: fendente dall\'alto. TIENI PREMUTO (A o B) per l\'AFFONDO: lento ma spinge fortissimo e arriva lontano.',
    b: 'BASSO: sgambetto alle gambe, chi lo prende cade a terra. Premere l\'altro tasto mentre carichi = FINTA!',
    tips: ['BASSO batte ALTO, ALTO batte AFFONDO, AFFONDO batte BASSO: leggi il simbolo sopra la testa e rispondi giusto!', 'Ogni colpo preso ti ammacca: più ammaccature, più voli lontano', 'Attenti al fiato: senza stamina non si attacca. La pietra si sbriciola alla fine!'],
  },

  init(g) {
    const n = g.n || 2;
    const sc = g.mods.scale || [];
    const s = {
      t: 0, R: R0, xr: [PONTE_X0, PONTE_X1], falls: Array(n).fill(0), gust: null, msg: 0,
      tm: g.teams ? g.teams.slice() : null,
      p: [...Array(n).keys()].map((i) => ({
        i, x: 0, y: 0, vx: 0, vy: 0, kx: 0, ky: 0, fa: 0, r: PR * (sc[i] ?? 1), tg: -1,
        mv: 0, ph: 0, mt: 0, held: false, feint: false, st: ST_MAX, stT: 9, stun: 0, sk: 0, dents: 0,
        fall: 0, elim: false, inv: 0, ak: 0, hk: 0, pc: 0, miss: 0, puff: 0, respawnAt: 0, lastHit: -1,
      })),
    };
    for (const p of s.p) { resetPlayer(s, g, p); p.inv = 0; }
    if (g.variant === 'bufera') nextGust(s, g);
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.t = g.t;
    const pon = isPonte(g);
    // The stone crumbles in the last part of the duel.
    if (g.t > SHRINK_T0) {
      const k = clamp((g.t - SHRINK_T0) / (SHRINK_T1 - SHRINK_T0), 0, 1);
      if (!s.crumble) { s.crumble = 1; g.say(pon ? 'IL PONTE CEDE!' : 'LA PIETRA SI SBRICIOLA!'); g.sfx('shrink'); g.shake(0.3); }
      s.R = R0 - (R0 - RMIN) * k;
      s.xr = [PONTE_X0 + 200 * k, PONTE_X1 - 200 * k];
      if (Math.floor(g.t * 2) !== Math.floor((g.t - dt) * 2) && k < 1) g.sfx('break', { vol: 0.3, pitch: 1.4 });
    }
    // Wind gusts.
    if (s.gust) {
      const G = s.gust;
      if (!G.warned && g.t > G.at - 1.5) { G.warned = true; g.say('💨 RAFFICA IN ARRIVO!'); g.sfx('whoosh', { pitch: 0.6 }); }
      if (g.t >= G.at && G.on <= 0 && !G.done) { G.on = 2.4; G.done = true; g.sfx('whoosh', { pitch: 0.5, vol: 1 }); g.shake(0.2); }
      if (G.on > 0) { G.on -= dt; if (G.on <= 0) nextGust(s, g); }
    }
    for (const p of s.p) {
      if (p.elim) continue;
      const i = inp[p.i];
      if (p.fall > 0) {
        p.fall += dt;
        p.x += p.kx * dt * 0.3; p.y += p.ky * dt * 0.3;
        if (p.respawnAt && g.t >= p.respawnAt && !g.ended) { p.respawnAt = 0; resetPlayer(s, g, p); g.sfx('boing'); g.ring(p.x, p.y, { player: p.i, r: 90 }); }
        continue;
      }
      p.inv = Math.max(0, p.inv - dt);
      p.miss = Math.max(0, p.miss - dt);
      p.puff = Math.max(0, p.puff - dt);
      p.stT += dt;
      const gum = g.variant === 'gomma';
      if (p.stT > ST_DELAY && p.ph === 0) p.st = Math.min(ST_MAX, p.st + ST_REGEN * dt * (gum ? 3 : 1));
      if (p.stun > 0) { p.stun -= dt; if (p.stun <= 0) { p.stun = 0; p.sk = 0; } }
      pickTarget(s, g, p, i.x, i.y);
      const T = s.p[p.tg];
      const busy = p.stun > 0;
      // --- buttons ---
      if (!busy && !g.ended) {
        if (p.ph === 0) {
          let want = 0, btn = null;
          if (i.aP && i.bP) { want = i.aT <= i.bT ? ALTO : BASSO; btn = want === ALTO ? 'a' : 'b'; }
          else if (i.aP) { want = ALTO; btn = 'a'; }
          else if (i.bP) { want = BASSO; btn = 'b'; }
          if (want) {
            const cost = gum ? 0 : MV[want].cost;
            if (p.st >= cost) {
              p.mv = want; p.ph = 1; p.mt = 0; p.held = true; p.btn = btn; p.feint = false;
              p.st -= cost; p.stT = 0;
              g.sfx('click', { pitch: want === ALTO ? 1.4 : 0.9, vol: 0.5 });
            } else if (p.puff <= 0) {
              p.puff = 1; g.text(p.x, p.y - p.r - 30, 'FIATONE!', { color: '#bfe8ff', size: 34 }); g.sfx('buzzer', { vol: 0.3, pitch: 1.5 });
            }
          }
        } else if (p.ph === 1) {
          p.mt += dt;
          const holding = p.btn === 'a' ? i.a : i.b;
          if (!holding) p.held = false;
          // Hold → thrust.
          if (p.mv !== AFFONDO && p.held && p.mt >= HOLD_T) {
            const extra = gum ? 0 : MV[AFFONDO].cost - MV[p.mv].cost;
            if (p.st >= extra) { p.st -= extra; p.mv = AFFONDO; g.sfx('powerup', { vol: 0.4, pitch: 1.6 }); }
            else p.held = false;
          }
          // Feint: the other button switches the cut.
          const other = p.btn === 'a' ? i.bP : i.aP;
          if (other && !p.feint && p.mv !== AFFONDO && p.mt < MV[p.mv].wind - 0.05) {
            p.feint = true; p.mv = p.mv === ALTO ? BASSO : ALTO; p.btn = p.btn === 'a' ? 'b' : 'a';
            p.mt = Math.max(0, p.mt - 0.08); p.held = false; p.st = Math.max(0, p.st - (gum ? 0 : FEINT_COST));
            g.text(p.x, p.y - p.r - 30, 'FINTA!', { player: p.i, size: 38 }); g.sfx('swap', { vol: 0.5 });
          }
          if (p.mt >= MV[p.mv].wind) { p.ph = 2; strike(s, g, p); if (p.ph === 2) { p.ph = 3; p.mt = 0; } }
        } else if (p.ph === 3) {
          p.mt += dt;
          if (p.mt >= MV[p.mv].rec) cancel(p);
        }
      } else if (busy && p.ph) cancel(p);
      // --- facing ---
      if (T && p.ph !== 1 && !busy) p.fa = Math.atan2(T.y - p.y, T.x - p.x);
      else if (T && p.ph === 1 && p.mv !== AFFONDO) {
        const want = Math.atan2(T.y - p.y, T.x - p.x);
        const da = wrapAngle(want - p.fa);
        p.fa += clamp(da, -4 * dt, 4 * dt);
      }
      // --- movement ---
      let sp = SPEED * (p.ph === 1 ? (p.mv === AFFONDO ? 0.25 : 0.35) : p.ph === 3 ? 0.5 : 1);
      if (busy) sp = 0;
      if (p.st < 15 && !gum) sp *= 0.8;
      const k = 1 - Math.pow(0.0008, dt);
      p.vx += (i.x * sp - p.vx) * k; p.vy += (i.y * sp - p.vy) * k;
      const kd = Math.pow(gum ? 0.12 : 0.06, dt);
      p.kx *= kd; p.ky *= kd;
      let wx = 0, wy = 0;
      if (s.gust && s.gust.on > 0) { wx = s.gust.dx * 175; wy = s.gust.dy * 175; }
      p.x += (p.vx + p.kx + wx) * dt; p.y += (p.vy + p.ky + wy) * dt;
      if (pon) {
        // The ends of the bridge are barred.
        if (p.x < s.xr[0] + p.r) { p.x = s.xr[0] + p.r; p.kx = Math.abs(p.kx) * 0.4; }
        if (p.x > s.xr[1] - p.r) { p.x = s.xr[1] - p.r; p.kx = -Math.abs(p.kx) * 0.4; }
      }
    }
    // Duellists push each other a little (no overlap).
    for (let a = 0; a < s.p.length; a++) for (let b = a + 1; b < s.p.length; b++) {
      const A = s.p[a], Bq = s.p[b];
      if (!alive(A) || !alive(Bq)) continue;
      const dx = Bq.x - A.x, dy = Bq.y - A.y, d = Math.hypot(dx, dy), min = A.r + Bq.r;
      if (d < min && d > 0.01) { const o = (min - d) / 2, nx = dx / d, ny = dy / d; A.x -= nx * o; A.y -= ny * o; Bq.x += nx * o; Bq.y += ny * o; }
    }
    // Falling into the chasm.
    const out = [];
    for (const p of s.p) if (alive(p) && edgeGap(s, g, p.x, p.y) < -p.r * 0.3) out.push(p);
    if (out.length && !g.ended) {
      for (const p of out) {
        p.fall = 0.001; cancel(p); p.stun = 0;
        s.falls[p.i]++;
        p.respawnAt = g.t + RESPAWN;
        g.burst(p.x, p.y, { color: '#8a8fa0', n: 24, speed: 300 });
        g.vibrate(p.i, 220);
        g.text(p.x, p.y - 60, 'AAAAAH!', { player: p.i, size: 50 });
      }
      g.sfx('fall'); g.shake(0.55);
      const lost = out.filter((p) => s.falls[p.i] >= FALLS_TO_LOSE);
      for (const p of lost) { p.elim = true; p.respawnAt = 0; }
      const left = s.p.filter((p) => !p.elim);
      let winner = -1;
      if (g.teams) {
        const tl = [0, 1].map((t) => left.filter((p) => g.teams[p.i] === t).length);
        if (!tl[0] || !tl[1]) {
          const wt = tl[0] ? 0 : tl[1] ? 1 : (g.teams[out[out.length - 1].i] ^ 1);
          winner = s.p.find((p) => g.teams[p.i] === wt && !p.elim)?.i ?? s.p.find((p) => g.teams[p.i] === wt).i;
        }
      } else if (left.length <= 1) {
        // Last one standing; if the last ones fall together, the one least far off the edge survives.
        winner = left.length ? left[0].i : lost.reduce((b, p) => (edgeGap(s, g, p.x, p.y) > edgeGap(s, g, b.x, b.y) ? p : b)).i;
      }
      if (winner >= 0) { g.slowmo(0.35, 0.9); g.end(winner, 'Giù nel burrone!'); }
      else g.say(lost.length ? 'FUORI DAL DUELLO!' : 'NEL BURRONE!');
    }
  },

  timeout(s, g) {
    const lives = (p) => (p.elim ? -1 : FALLS_TO_LOSE - s.falls[p.i]) * 1000 - p.dents - (p.fall > 0 ? 500 : 0);
    if (g.teams) {
      const tot = [0, 0];
      for (const p of s.p) tot[g.teams[p.i]] += lives(p);
      const wt = tot[0] === tot[1] ? (g.rng() < 0.5 ? 0 : 1) : tot[0] > tot[1] ? 0 : 1;
      return s.p.find((p) => g.teams[p.i] === wt && !p.elim)?.i ?? s.p.find((p) => g.teams[p.i] === wt).i;
    }
    let best = null;
    for (const p of s.p) if (!best || lives(p) > lives(best) || (lives(p) === lives(best) && g.rng() < 0.5)) best = p;
    return best.i;
  },

  bot: duelloBot,

  view(s) {
    const G = s.gust;
    return {
      R: r1(s.R), xr: [r1(s.xr[0]), r1(s.xr[1])], cr: s.crumble ? 1 : 0,
      gu: G ? { dx: r2(G.dx), dy: r2(G.dy), on: G.on > 0 ? 1 : 0, w: G.warned && G.on <= 0 ? 1 : 0 } : null,
      p: s.p.map((p) => ({
        x: r1(p.x), y: r1(p.y), r: r1(p.r), fa: r2(p.fa), mv: p.mv, ph: p.ph, it: intent(p),
        mt: p.ph === 1 ? r2(clamp(p.mt / MV[p.mv].wind, 0, 1)) : 0, sta: r2(p.st / ST_MAX), sn: r2(p.stun), sk: p.sk,
        dn: Math.round(p.dents), f: r2(p.fall), e: p.elim ? 1 : 0, inv: p.inv > 0 ? 1 : 0, ak: p.ak % 64, hk: p.hk % 64,
        tg: p.tg, tm: s.tm ? s.tm[p.i] : -1, sp: Math.round(Math.hypot(p.vx, p.vy)), ms: p.miss > 0 ? 1 : 0,
      })),
      hud: { p: s.falls.map((f) => FALLS_TO_LOSE - f), max: FALLS_TO_LOSE, label: 'Vite' },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  render3d: {
    cam: { fit: 1.08 },
    assets: [
      'medieval/building_castle_blue', 'medieval/building_tower_A_blue', 'medieval/building_tower_B_red', 'medieval/wall_straight', 'medieval/wall_straight_gate',
      'medieval/mountain_A_grass', 'medieval/mountain_C', 'medieval/mountain_B_grass_trees', 'medieval/rock_single_A', 'medieval/rock_single_B', 'medieval/rock_single_D',
      'medieval/trees_B_medium', 'medieval/trees_A_small', 'medieval/tree_single_B', 'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow',
      'medieval/tent', 'medieval/weaponrack', 'medieval/barrel', 'medieval/crate_A_small',
      'dungeon/torch_lit', 'dungeon/barrier', 'dungeon/banner_patternB_red', 'dungeon/banner_patternC_blue', 'dungeon/sword_shield', 'dungeon/sword_shield_broken',
      'chars/Barbarian', 'chars/Mage', 'chars/Rogue', 'chars/Rogue_Hooded',
    ],
    build(K, r) {
      const { THREE } = K;
      const n = r.n || K.n || 2;
      const lo = K.quality === 0;
      const pon = r.variant === 'ponte';
      K.theme('notte', { fogNear: 2.2, fogFar: 6.5 });
      K.hemi.intensity = 1.25;
      K.sun.intensity = 1.5;
      K.sun.color.set('#c8d4ff');
      const o = { n, pon, flags: [] };
      const CR = 700, DEPTH = 900;
      // The chasm: a far dark floor, the round cliff wall and the meadow on top of the cliff.
      K.ground('pietra', { h: -DEPTH, color: '#20263a', tile: 300 });
      const cliffMat = K.texMat('pietra', [24, 4], { color: '#7a7f94' });
      cliffMat.side = THREE.BackSide;
      const wallC = K.mesh(new THREE.CylinderGeometry(CR, CR * 0.92, DEPTH, 72, 1, true), cliffMat, { cast: false });
      wallC.userData.ownGeo = true;
      K.place(wallC, CX, CY, -DEPTH / 2);
      const grassTex = K.tex('erba', { rep: [30, 30], seed: 4 });
      const topMat = new THREE.MeshStandardMaterial({ map: grassTex, color: '#55705e', roughness: 0.95 });
      const topGeo = new THREE.RingGeometry(CR, 4200, 72, 1).rotateX(-Math.PI / 2);
      // RingGeometry UVs are in [0,1] across the whole ring: scale them so the texture tiles.
      const top = K.mesh(topGeo, topMat, { cast: false });
      top.userData.ownGeo = true;
      K.place(top, CX, CY, 0);
      // Cliff lip: a stony rim ring and rocks along the edge.
      K.place(K.torus(CR + 6, 16, K.mat('#8d8a86', { rough: 0.95, flat: true })), CX, CY, 2);
      const rocks = [];
      for (let k = 0; k < 40; k++) { const a = (k / 40) * TAU + (k % 3) * 0.04; rocks.push({ x: CX + Math.cos(a) * (CR + 40 + (k % 4) * 18), y: CY + Math.sin(a) * (CR + 40 + (k % 4) * 18), rot: k * 1.9, s: 0.7 + (k % 5) * 0.15 }); }
      K.scatter('medieval/rock_single_A', rocks.filter((_, k) => k % 3 === 0), { size: 90 });
      K.scatter('medieval/rock_single_B', rocks.filter((_, k) => k % 3 === 1), { size: 80 });
      K.scatter('medieval/rock_single_D', rocks.filter((_, k) => k % 3 === 2), { size: 85 });
      // Mist down in the chasm.
      for (const [h, op] of [[-260, 0.16], [-480, 0.22], [-700, 0.3]]) K.place(K.disc(CR, K.glow('#5a6c9e', { opacity: op })), CX, CY, h);

      // The duel stone: a rock pillar rising from the abyss, its top painted (runes, cracks, crumbling band).
      const pil = K.texMat('pietra', [10, 6], { color: '#9a98a6' });
      o.pillar = K.cyl(1, DEPTH, pil, { seg: 56, r2: 0.82 });
      o.pillar.visible = !pon;
      o.top = K.layer({
        x0: CX - 460, y0: CY - 460, x1: CX + 460, y1: CY + 460, h: 1, transparent: true,
        draw: (d, v) => drawStone(d, v, K.t), key: (v) => `${Math.round(v.R)}|${v.cr && Math.sin(K.t * 18) > 0 ? 1 : 0}`,
      });
      o.top.mesh.visible = !pon;
      // Rope bridges from the stone to the cliff (diagonals), or the long bridge of the 'ponte' variant.
      const plankMat = K.texMat('legno', [1, 1], { color: '#a07850' });
      const ropeMat = K.mat('#c8b07a', { rough: 0.9 });
      const planks = [], ropes = [], posts = [];
      const bridge = (x0, y0, x1, y1, wid, sag, step) => {
        const L = dist(x0, y0, x1, y1), a = Math.atan2(y1 - y0, x1 - x0), N = Math.max(2, Math.round(L / step));
        for (let k = 0; k <= N; k++) {
          const u = k / N, x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * u, h = -4 * sag * u * (1 - u) - 6;
          planks.push({ x, y, h, a: a + Math.sin(k * 7.3) * 0.04, w: wid });
          for (const sd of [-1, 1]) ropes.push({ x: x - Math.sin(a) * sd * (wid / 2 + 4), y: y + Math.cos(a) * sd * (wid / 2 + 4), h: h + 34, a, len: L / N + 2 });
        }
        for (const [px, py] of [[x0, y0], [x1, y1]]) for (const sd of [-1, 1]) posts.push({ x: px - Math.sin(a) * sd * (wid / 2 + 6), y: py + Math.cos(a) * sd * (wid / 2 + 6) });
      };
      if (pon) bridge(CX - CR - 20, CY, CX + CR + 20, CY, PONTE_HW * 2, 30, 26);
      else for (let k = 0; k < 4; k++) { const a = Math.PI / 4 + (k * Math.PI) / 2; bridge(CX + Math.cos(a) * (R0 + 8), CY + Math.sin(a) * (R0 + 8), CX + Math.cos(a) * (CR + 30), CY + Math.sin(a) * (CR + 30), 110, 40, 24); }
      const inst = (geo, mat, list, fn) => {
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        im.userData.ownGeo = true;
        const M4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3();
        list.forEach((it, k) => { fn(it, p, q, sc, up); M4.compose(p, q, sc); im.setMatrixAt(k, M4); });
        im.castShadow = true; im.receiveShadow = true;
        K.root.add(im);
        return im;
      };
      inst(new THREE.BoxGeometry(1, 1, 1), plankMat, planks, (it, p, q, sc, up) => { K.p(it.x, it.y, it.h, p); q.setFromAxisAngle(up, -it.a); sc.set(pon ? 22 : 18, 6, it.w); });
      inst(new THREE.CylinderGeometry(1, 1, 1, 6).rotateZ(Math.PI / 2), ropeMat, ropes, (it, p, q, sc, up) => { K.p(it.x, it.y, it.h, p); q.setFromAxisAngle(up, -it.a); sc.set(it.len, 2.4, 2.4); });
      inst(new THREE.CylinderGeometry(7, 9, 60, 8).translate(0, 30, 0), K.texMat('legno', [1, 2], { color: '#6a4a2a' }), posts, (it, p, q, sc) => { K.p(it.x, it.y, 0, p); q.identity(); sc.set(1, 1, 1); });
      if (pon) {
        // Bridge floor layer (shows the missing planks at the crumbling ends) and the barricades at the ends.
        o.bridgeL = K.layer({ x0: PONTE_X0 - 80, y0: CY - PONTE_HW - 30, x1: PONTE_X1 + 80, y1: CY + PONTE_HW + 30, h: 0.5, transparent: true,
          draw: (d, v) => drawBridge(d, v), key: (v) => `${Math.round(v.xr[0])}` });
        o.bars = [0, 1].map(() => { const g = K.group(); for (const dy of [-100, 0, 100]) { const b = K.model('dungeon/barrier', { size: 110, parent: g }); b.position.set(0, 0, dy); b.rotation.y = Math.PI / 2; } return g; });
      }
      // Torches at the bridge heads on the cliff, braziers glow.
      const torchSpots = pon ? [[CX - CR - 60, CY - 190], [CX - CR - 60, CY + 190], [CX + CR + 60, CY - 190], [CX + CR + 60, CY + 190]]
        : [0, 1, 2, 3].map((k) => { const a = Math.PI / 4 + (k * Math.PI) / 2; return [CX + Math.cos(a) * (CR + 70), CY + Math.sin(a) * (CR + 70)]; });
      for (const [x, y] of torchSpots) K.place(K.model('dungeon/torch_lit', { height: 110 }), x, y);
      torchSpots.forEach(([x, y], k) => { if (!lo || k < 2) K.light(x, y, 130, '#ffa040', 2.6, { flicker: 0.6, dist: 900 }); });
      K.light(CX, CY, 420, '#9fb0ff', lo ? 1.2 : 0.9, { dist: 1400 }); // moonlight pool over the stone
      if (!pon && !lo) for (let k = 0; k < 4; k++) { const a = (k * Math.PI) / 2; K.light(CX + Math.cos(a) * 300, CY + Math.sin(a) * 300, 16, '#ff7a30', 0.9, { flicker: 0.5, dist: 300 }); }

      // The castle courtyard wall on the far cliff: curtain wall with a gate, towers, banners; the keep behind.
      const castle = K.model('medieval/building_castle_blue', { height: 480 });
      K.place(castle, CX, CY - CR - 420);
      K.face(castle, Math.PI / 2);
      const WYc = CY - CR - 110;
      const wall = [];
      for (let k = -7; k <= 7; k++) if (k !== 0) wall.push({ x: CX + k * 160, y: WYc, rot: 0 });
      K.scatter('medieval/wall_straight', wall, { size: 162 });
      const gate = K.model('medieval/wall_straight_gate', { size: 162 });
      K.place(gate, CX, WYc);
      for (const s of [-1, 1]) {
        K.place(K.model('medieval/building_tower_A_blue', { height: 330 }), CX + s * 600, WYc - 20);
        K.place(K.model('medieval/building_tower_B_red', { height: 300 }), CX + s * 1180, WYc + 60);
      }
      for (const [x, name] of [[CX - 300, 'dungeon/banner_patternB_red'], [CX + 300, 'dungeon/banner_patternC_blue']]) {
        const b = K.model(name, { height: 200 }); K.place(b, x, WYc + 30); K.face(b, Math.PI / 2);
      }
      // Team flags (the seat that starts on that side) along the cliff.
      for (let k = 0; k < n; k++) {
        const slot = K.roster[k]?.color ?? k;
        const sp = SIDE[k];
        const f = K.model(`medieval/flag_${FLAG[slot] || 'red'}`, { height: 190 });
        const fx = CX + sp[0] * (CR + 120) + (k < 2 ? 200 : 0), fy = CY + sp[1] * (CR + 60);
        K.place(f, fx, fy);
        K.face(f, Math.atan2(CY - fy, CX - fx));
        o.flags.push({ f, base: f.rotation.y, ph: k });
      }
      // Knights' camp on the side cliffs, with a few spectators cheering the duel.
      const L = CX - CR - 200, R = CX + CR + 200;
      const props = (name, list, size) => K.scatter(name, list.map(([x, y, rot]) => ({ x, y, rot })), { size });
      props('medieval/tent', [[L - 120, CY - 260, 0.3], [R + 120, CY - 280, 2.8], [L - 160, CY + 420, -0.4], [R + 160, CY + 440, -2.7]], 240);
      props('medieval/weaponrack', [[L + 60, CY + 120, 0.1], [R - 60, CY + 100, 3.0], [L + 40, CY - 470, 0.6]], 90);
      props('medieval/barrel', [[L + 10, CY + 220, 0], [L + 50, CY + 250, 1], [R - 20, CY + 210, 1], [R + 20, CY - 470, 2]], 55);
      props('medieval/crate_A_small', [[L - 30, CY + 260, 0.3], [R + 20, CY + 250, 0.8]], 50);
      props('dungeon/sword_shield', [[L + 80, CY - 120, 0.6], [R - 80, CY - 140, 2.2]], 70);
      props('dungeon/sword_shield_broken', [[R - 60, CY + 330, 2.4]], 70);
      o.crowd = [['barbarian', CX - CR - 70, CY - 60], ['mage', CX - CR - 90, CY + 170], ['rogue', CX + CR + 70, CY - 60], ['hooded', CX + CR + 90, CY + 170]]
        .slice(0, lo ? 2 : 4).map(([c, x, y], k) => ({ av: K.npc(c, { marker: false }), x, y, k }));
      // Woods and mountains under the moon.
      const trees = [], trees2 = [], singles = [];
      for (let k = 0; k < (lo ? 22 : 44); k++) {
        const a = (k / (lo ? 22 : 44)) * TAU + (k % 2) * 0.06;
        if (Math.sin(a) < -0.5) continue;
        const rr = CR + 420 + (k % 4) * 150;
        (k % 2 ? trees : trees2).push({ x: CX + Math.cos(a) * rr * 1.3, y: CY + Math.sin(a) * rr, rot: k * 0.9, s: 0.85 + (k % 3) * 0.15 });
      }
      for (let k = 0; k < 16; k++) { const a = (k / 16) * TAU + 0.15; if (Math.sin(a) < -0.4) continue; singles.push({ x: CX + Math.cos(a) * (CR + 230) * 1.25, y: CY + Math.sin(a) * (CR + 230), rot: k, s: 0.8 + (k % 3) * 0.2 }); }
      K.scatter('medieval/trees_B_medium', trees, { size: 260 });
      K.scatter('medieval/trees_A_small', trees2, { size: 220 });
      K.scatter('medieval/tree_single_B', singles, { size: 150 });
      K.scatter('medieval/mountain_C', [{ x: CX - 1700, y: -1500, rot: 0.4 }, { x: CX + 1800, y: -1400, rot: 2.1 }], { size: 1700 });
      K.scatter('medieval/mountain_A_grass', [{ x: CX, y: -2300, rot: 1 }, { x: -1500, y: 300, rot: 0.3 }, { x: 2500, y: 300, rot: 2 }], { size: 1500 });
      // The moon.
      o.moon = K.billboard(128, 128, 520, (d, w, h) => {
        const { ctx } = d;
        const gr = ctx.createRadialGradient(64, 64, 10, 64, 64, 64);
        gr.addColorStop(0, 'rgba(255,250,225,1)'); gr.addColorStop(0.5, 'rgba(255,245,210,0.95)'); gr.addColorStop(0.62, 'rgba(200,210,255,0.25)'); gr.addColorStop(1, 'rgba(200,210,255,0)');
        ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
        d.circle(50, 56, 8, 'rgba(210,200,170,0.6)'); d.circle(76, 74, 6, 'rgba(210,200,170,0.5)'); d.circle(70, 44, 4, 'rgba(210,200,170,0.5)');
      });
      K.place(o.moon, CX + 900, -2600, 1900);
      K.ambient('lucciole', { n: 50, x0: -300, y0: -300, x1: 1300, y1: 1300, h: 220 });
      K.ambient('braci', { n: 40, x0: 0, y0: 0, x1: 1000, y1: 1000, h: 300 });

      // Wind arrow (bufera).
      o.wind = K.decal(520, { h: 3 });
      o.windStreaks = [...Array(lo ? 8 : 16)].map(() => K.box(1, 1, 1, K.glow('#dfe8ff', { opacity: 0.5 }), { cast: false }));
      // Duellists: avatar, ground decal (stamina, windup, target), move icons over the head.
      o.pl = [...Array(n)].map((_, i) => ({
        av: K.avatar(i),
        dec: K.decal(300),
        icon: [1, 2, 3].map((mv) => { const b = K.billboard(128, 128, 70, (d) => drawIcon(d, mv)); b.visible = false; return b; }),
        trail: K.torus(1, 0.06, K.glow('#ffffff', { opacity: 0.75, unique: true }), { cast: false, arc: 1.6 }),
        last: '',
      }));
      return o;
    },
    update(K, o, v, r) {
      const t = K.t;
      for (const F of o.flags) F.f.rotation.y = F.base + Math.sin(t * 1.5 + F.ph) * 0.15;
      if (!o.pon) { o.pillar.scale.set(v.R + 14, 1, v.R + 14); K.place(o.pillar, CX, CY, -900 + 0.5); }
      else o.bars.forEach((b, k) => K.place(b, v.xr[k] + (k ? 28 : -28), CY));
      // Wind.
      const gu = v.gu;
      const wOn = !!gu && (gu.on || gu.w);
      o.wind.show(wOn).at(CX, CY, 3);
      if (wOn && (o.lastW !== `${gu.on}${gu.dx}${gu.dy}${Math.floor(t * 4) % 2}`)) {
        o.lastW = `${gu.on}${gu.dx}${gu.dy}${Math.floor(t * 4) % 2}`;
        o.wind.paint((d) => {
          const a = Math.atan2(gu.dy, gu.dx), c = Math.cos(a), s = Math.sin(a);
          const col = gu.on ? 'rgba(220,235,255,0.55)' : (Math.floor(t * 4) % 2 ? 'rgba(255,240,140,0.7)' : 'rgba(255,240,140,0.3)');
          const P = (x, y) => [x * c - y * s, x * s + y * c];
          d.poly([...P(-180, -40), ...P(60, -40), ...P(60, -95), ...P(190, 0), ...P(60, 95), ...P(60, 40), ...P(-180, 40)], col, 'rgba(30,40,80,0.4)', 4);
        });
      }
      o.windStreaks.forEach((b, k) => {
        b.visible = !!gu && !!gu.on;
        if (!b.visible) return;
        const ph = (t * 0.9 + k * 0.137) % 1;
        const a = Math.atan2(gu.dy, gu.dx);
        const off = ((k * 211) % 900) - 450;
        const x = CX + gu.dx * (ph * 1400 - 700) - gu.dy * off, y = CY + gu.dy * (ph * 1400 - 700) + gu.dx * off;
        K.place(b, x, y, 60 + (k % 5) * 40);
        b.scale.set(140, 3, 3);
        K.face(b, a);
      });
      // Spectators: cheer at every hit, otherwise idle (looking at the stone).
      let hits = 0;
      for (const p of v.p) hits += p.hk;
      if (o.hits !== hits) { o.hits = hits; o.cheerT = t; }
      for (const C of o.crowd) C.av.set(C.x, C.y, { r: 40, look: Math.atan2(CY - C.y, CX - C.x), anim: t - (o.cheerT ?? -9) < 1.6 || r.ended ? 'Cheer' : 'Idle', gear: false, marker: false });
      // Duellists.
      const ended = r.ended;
      let best = -1;
      if (ended) for (const q of v.hud.p) best = Math.max(best, q);
      v.p.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const up = p.f <= 0 && !p.e;
        P.icon.forEach((b, k) => { b.visible = false; });
        P.trail.visible = false;
        if (p.e && p.f <= 0) {
          // Out: sits on the cliff edge on its side, as a ghostly spectator.
          const [ux, uy] = SIDE[i];
          P.av.set(CX + ux * 900, CY + uy * 900, { r: p.r * 0.8, look: Math.atan2(-uy, -ux), alpha: 0.45, anim: 'Sit_Floor_Idle', gear: false });
          P.dec.show(false);
          return;
        }
        if (p.f > 0) {
          const k = clamp(p.f / 1.1, 0, 1);
          P.av.set(p.x, p.y, { r: p.r * (1 - k * 0.5), h: -k * k * 700, look: t * 9, alpha: Math.max(0.05, 1 - k), anim: 'Jump_Idle', mood: 'scared' });
          P.dec.show(false);
          return;
        }
        let anim, animKey, animSpeed, mood = 'ok';
        if (p.sk === 2) { anim = 'Lie_Idle'; mood = 'dizzy'; }
        else if (p.sk === 3) { anim = 'Block_Hit'; mood = 'hurt'; animKey = p.hk + 100; }
        else if (p.sk === 4) { anim = 'Block_Hit'; animKey = p.ak; }
        else if (p.sk === 1) { anim = 'Hit_B'; mood = 'hurt'; animKey = p.hk; }
        else if (p.ph === 1) {
          anim = p.mv === ALTO ? '1H_Melee_Attack_Chop' : p.mv === BASSO ? '1H_Melee_Attack_Slice_Horizontal' : '1H_Melee_Attack_Stab';
          animKey = p.ak * 4 + p.mv; animSpeed = p.mv === AFFONDO ? 0.45 : 0.75; mood = 'angry';
        } else if (p.ph === 3) {
          anim = p.mv === ALTO ? '1H_Melee_Attack_Chop' : p.mv === BASSO ? '1H_Melee_Attack_Slice_Horizontal' : '1H_Melee_Attack_Stab';
          animKey = p.ak * 4 + p.mv; animSpeed = 1.4; mood = 'angry';
        } else if (p.sta < 0.2) { anim = 'Idle'; mood = 'dizzy'; }
        if (ended) { const win = v.hud.p[i] === best; mood = win ? 'happy' : 'dizzy'; anim = win ? 'Cheer' : undefined; }
        P.av.set(p.x, p.y, { r: p.r, look: p.fa, mood, anim, animKey, animSpeed, walk: clamp(p.sp / 300, 0, 1), alpha: p.inv && Math.floor(t * 12) % 2 ? 0.5 : 1, lean: p.ph === 1 && p.mv === AFFONDO ? -0.15 : 0 });
        // Telegraph: the move icon over the head while winding up (pulses near the strike).
        if (p.ph === 1 && p.it) {
          const b = P.icon[p.it - 1];
          b.visible = true;
          K.place(b, p.x, p.y, p.r * 3.5 + 18);
          const s = 66 + p.mt * 26 + (p.mt > 0.75 ? Math.sin(t * 40) * 6 : 0);
          b.scale.set(s, s, 1);
        }
        // Sword arc flash on the strike.
        if (p.ph === 3 && !p.ms) {
          P.trail.visible = true;
          const reach = MV[p.mv || 1].reach * 0.8 + p.r;
          K.place(P.trail, p.x, p.y, p.mv === BASSO ? 12 : p.mv === ALTO ? p.r * 2 : p.r * 1.3);
          P.trail.scale.set(reach, reach, reach);
          P.trail.rotation.y = -p.fa + 0.8;
          P.trail.material.color.set(p.mv === ALTO ? '#ffe066' : p.mv === BASSO ? '#7ae0ff' : '#ff7a7a');
        }
        // Ground decal: stamina ring, windup progress, arrow toward the target, team color.
        const tgt = v.p[p.tg];
        const ta = tgt ? Math.atan2(tgt.y - p.y, tgt.x - p.x) : p.fa;
        const td = tgt ? Math.min(140, Math.hypot(tgt.x - p.x, tgt.y - p.y) - p.r - 20) : 0;
        const key = `${Math.round(p.sta * 20)}|${Math.round(p.mt * 12)}|${p.it}|${Math.round(ta * 10)}|${Math.round(td / 10)}|${p.dn}`;
        P.dec.show(up).at(p.x, p.y, 1.5);
        if (key !== P.last) {
          P.last = key;
          P.dec.paint((d) => {
            const col = p.tm >= 0 ? TEAM_COL[p.tm] : K.col(i, 'light');
            const rr = p.r + 12;
            // Stamina (green → red).
            const sc = p.sta > 0.5 ? '#6fe08a' : p.sta > 0.25 ? '#ffd36b' : '#ff6b6b';
            d.arc(0, 0, rr, -Math.PI / 2, -Math.PI / 2 + TAU * p.sta, sc, 6);
            d.ring(0, 0, rr + 9, col + '99', 3);
            if (p.it) d.arc(0, 0, rr + 18, -Math.PI / 2, -Math.PI / 2 + TAU * p.mt, ICON_COL[p.it], 8);
            if (tgt && td > 10) {
              const c = Math.cos(ta), s = Math.sin(ta), x0 = c * (rr + 22), y0 = s * (rr + 22);
              d.poly([x0 + c * 22, y0 + s * 22, x0 - s * 12, y0 + c * 12, x0 + s * 12, y0 - c * 12], col + 'ee', 'rgba(0,0,0,0.4)', 2);
            }
            // Dents: little cracks around (more dents, more cracks).
            const nd = Math.min(12, Math.floor(p.dn / 12));
            for (let k = 0; k < nd; k++) { const a = k * 0.52 + 0.3; d.line(Math.cos(a) * (rr + 2), Math.sin(a) * (rr + 2), Math.cos(a) * (rr + 14), Math.sin(a) * (rr + 14), 'rgba(255,120,80,0.8)', 3); }
          });
        }
      });
    },
  },

  render(d, v, r) {
    d.rect(-400, -400, W + 800, H + 800, '#121628');
    if (v.gu && (v.gu.on || v.gu.w)) {
      const a = Math.atan2(v.gu.dy, v.gu.dx);
      d.ctx.save(); d.ctx.translate(CX, CY); d.ctx.rotate(a);
      d.poly([-180, -40, 60, -40, 60, -95, 190, 0, 60, 95, 60, 40, -180, 40], v.gu.on ? 'rgba(220,235,255,0.25)' : 'rgba(255,240,140,0.35)');
      d.ctx.restore();
    }
    if (r.variant === 'ponte') drawBridge(d, v);
    else drawStone(d, v, d.t);
    v.p.forEach((p, i) => {
      if (p.e && p.f <= 0) { const [ux, uy] = SIDE[i]; d.avatar(CX + ux * 470, CY + uy * 470, p.r * 0.7, i, { mood: 'dizzy', alpha: 0.4 }); return; }
      if (p.f > 0) { const k = Math.max(0, 1 - p.f / 0.8); if (k > 0) d.avatar(p.x, p.y, p.r * k, i, { mood: 'scared', alpha: k, look: d.t * 10 }); return; }
      d.shadow(p.x + 6, p.y + 12, p.r, p.r * 0.75, 0.35);
      const col = p.tm >= 0 ? TEAM_COL[p.tm] : d.col(i, 'light');
      d.arc(p.x, p.y, p.r + 10, -Math.PI / 2, -Math.PI / 2 + TAU * p.sta, p.sta > 0.3 ? '#6fe08a' : '#ff6b6b', 5);
      if (p.it) d.arc(p.x, p.y, p.r + 18, -Math.PI / 2, -Math.PI / 2 + TAU * p.mt, ICON_COL[p.it], 7);
      const mood = p.sk ? (p.sk === 2 ? 'dizzy' : 'hurt') : p.ph ? 'angry' : 'ok';
      d.avatar(p.x, p.y, p.r, i, { look: p.fa, mood, squash: p.sk === 2 ? 0.35 : 0, alpha: p.inv && Math.floor(d.t * 12) % 2 ? 0.5 : 1 });
      // Sword.
      const sl = p.ph === 3 ? MV[p.mv || 1].reach * 0.7 : 40;
      d.line(p.x + Math.cos(p.fa) * p.r * 0.8, p.y + Math.sin(p.fa) * p.r * 0.8, p.x + Math.cos(p.fa) * (p.r + sl), p.y + Math.sin(p.fa) * (p.r + sl), '#e8eef8', 6);
      if (p.it) d.emoji(['', '⬆️', '⬇️', '🗡️'][p.it], p.x, p.y - p.r - 34, 40);
      const tg = v.p[p.tg];
      if (tg) { const a = Math.atan2(tg.y - p.y, tg.x - p.x); d.circle(p.x + Math.cos(a) * (p.r + 26), p.y + Math.sin(a) * (p.r + 26), 7, col); }
    });
  },
};

// ---------------------------------------------------------------- drawing helpers
const ICON_COL = ['', '#ffd23f', '#3fd0ff', '#ff5a5a'];

// Move icon (billboard): colored medallion with an arrow/sword and the name.
function drawIcon(d, mv) {
  const col = ICON_COL[mv];
  d.circle(64, 58, 50, col, '#1a1030', 8);
  d.circle(64, 58, 40, 'rgba(255,255,255,0.25)');
  const { ctx } = d;
  ctx.fillStyle = '#1a1030';
  ctx.beginPath();
  if (mv === ALTO) { ctx.moveTo(64, 18); ctx.lineTo(96, 58); ctx.lineTo(76, 58); ctx.lineTo(76, 92); ctx.lineTo(52, 92); ctx.lineTo(52, 58); ctx.lineTo(32, 58); }
  else if (mv === BASSO) { ctx.moveTo(64, 98); ctx.lineTo(96, 58); ctx.lineTo(76, 58); ctx.lineTo(76, 24); ctx.lineTo(52, 24); ctx.lineTo(52, 58); ctx.lineTo(32, 58); }
  else { ctx.moveTo(104, 58); ctx.lineTo(66, 28); ctx.lineTo(66, 46); ctx.lineTo(24, 46); ctx.lineTo(24, 70); ctx.lineTo(66, 70); ctx.lineTo(66, 88); }
  ctx.closePath(); ctx.fill();
  d.text(['', 'ALTO', 'BASSO', 'AFFONDO'][mv], 64, 118, { size: mv === AFFONDO ? 17 : 21, color: '#ffffff' });
}

// Top of the duel stone: flagstones, a rune circle, cracks; the crumbling band blinks.
function drawStone(d, v, t) {
  const { ctx } = d;
  const R = v.R;
  d.circle(CX, CY, R + 14, '#6c6a78');
  ctx.save();
  ctx.beginPath(); ctx.arc(CX, CY, R, 0, TAU); ctx.clip();
  d.circle(CX, CY, R, '#9a97a8');
  // Concentric flagstone rings.
  for (let k = 0; k < 6; k++) {
    const r0 = 70 + k * 70, segs = 6 + k * 5;
    d.ring(CX, CY, r0, 'rgba(50,48,64,0.55)', 4);
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * TAU + k * 0.3;
      d.line(CX + Math.cos(a) * (r0 - 70), CY + Math.sin(a) * (r0 - 70), CX + Math.cos(a) * r0, CY + Math.sin(a) * r0, 'rgba(50,48,64,0.45)', 3);
      if ((j + k) % 3 === 0) d.circle(CX + Math.cos(a + 0.2) * (r0 - 35), CY + Math.sin(a + 0.2) * (r0 - 35), 10 + (j % 3) * 4, 'rgba(255,255,255,0.06)');
    }
  }
  // Rune circle and a crossed-swords sigil in the middle.
  d.ring(CX, CY, 150, 'rgba(140,200,255,0.55)', 5);
  d.ring(CX, CY, 132, 'rgba(140,200,255,0.3)', 2);
  for (let k = 0; k < 16; k++) { const a = (k / 16) * TAU; d.rect(CX + Math.cos(a) * 141 - 4, CY + Math.sin(a) * 141 - 4, 8, 8, 'rgba(160,215,255,0.6)'); }
  d.line(CX - 70, CY - 70, CX + 70, CY + 70, 'rgba(220,230,255,0.6)', 10);
  d.line(CX + 70, CY - 70, CX - 70, CY + 70, 'rgba(220,230,255,0.6)', 10);
  d.circle(CX, CY, 22, 'rgba(255,210,90,0.7)');
  // Cracks.
  for (const [a, l] of [[0.4, 160], [2.2, 130], [3.6, 180], [5.1, 120]]) {
    const x0 = CX + Math.cos(a) * (R - l), y0 = CY + Math.sin(a) * (R - l);
    d.line(x0, y0, x0 + Math.cos(a + 0.3) * l * 0.5, y0 + Math.sin(a + 0.3) * l * 0.5, 'rgba(30,28,40,0.6)', 3);
    d.line(x0 + Math.cos(a + 0.3) * l * 0.5, y0 + Math.sin(a + 0.3) * l * 0.5, CX + Math.cos(a) * R, CY + Math.sin(a) * R, 'rgba(30,28,40,0.6)', 3);
  }
  ctx.restore();
  // Crumbling edge warning.
  if (v.cr && R > RMIN + 2) {
    const on = Math.sin(t * 18) > 0;
    ctx.save(); ctx.beginPath(); ctx.arc(CX, CY, R, 0, TAU); ctx.arc(CX, CY, Math.max(0, R - 40), 0, TAU, true);
    ctx.fillStyle = on ? 'rgba(255,60,60,0.45)' : 'rgba(255,60,60,0.15)'; ctx.fill('evenodd'); ctx.restore();
  }
  d.ring(CX, CY, R + 2, '#ffd36b', 5);
}

// The rope bridge strip seen from above ('ponte' variant): planks between the barricades.
function drawBridge(d, v) {
  const y0 = CY - PONTE_HW, y1 = CY + PONTE_HW;
  for (let x = PONTE_X0 - 60; x < PONTE_X1 + 60; x += 26) {
    const gone = x + 13 < v.xr[0] - 6 || x + 13 > v.xr[1] + 6;
    if (gone) continue;
    d.rect(x + 1, y0, 23, y1 - y0, (Math.floor(x / 26) % 2) ? '#a8805a' : '#9a7450', 'rgba(50,30,15,0.6)', 2);
  }
  d.line(v.xr[0], y0 - 6, v.xr[1], y0 - 6, '#ffd36b', 5);
  d.line(v.xr[0], y1 + 6, v.xr[1], y1 + 6, '#ffd36b', 5);
}
