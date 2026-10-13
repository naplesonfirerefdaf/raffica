// Il Banchetto del Re — top-down food frenzy for 2–4 players (free-for-all or 2 vs 2 with a team pantry).
// The King and his servants fling food onto the carpet of the great hall: run, bite the good stuff (A),
// avoid the nasty stuff (bones, dragon chilis, mice), rob a rival's plate with a lunge (B).
// Every bite fills your belly: the fuller you are, the slower (and heavier) you get.
import { clamp, dist, collideCircles, norm, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 540;   // CY = center of the carpet (the King sits above it)
const AX0 = 70, AX1 = 930, AY0 = 150, AY1 = 930;      // the carpet (play area)
const DURATION = 45, FINAL = 10;                       // last 10 s: "abbuffata finale", double points
const R0 = 40, BELLY_MAX = 18, DIGEST = 0.75;          // belly: +1 per bite, digests 0.75/s
const SPEED = 430;
const LUNGE_V = 880, LUNGE_T = 0.17, LUNGE_CD = 1.5, STEAL = 3;
const CHEW = 0.13, MISS_CHEW = 0.22;
const FALL_T = 1.0, LIFE = 7.5, MAX_ITEMS = 18;
const SPECIAL_AT = [10, 22, 34];
// Food types (index = view code). bites: how many A presses to finish it (1 point per bite).
const TYPES = ['uva', 'pane', 'coscia', 'torta', 'osso', 'pepe', 'topo', 'cinghiale', 'pasticcio'];
const INFO = [
  { bites: 1, r: 22, good: true, w: 22, emo: '🍇', col: '#8e44ad', name: 'UVA' },
  { bites: 2, r: 26, good: true, w: 22, emo: '🍞', col: '#d9a35b', name: 'PAGNOTTA' },
  { bites: 3, r: 28, good: true, w: 18, emo: '🍗', col: '#c8763a', name: 'COSCIA' },
  { bites: 5, r: 36, good: true, w: 8, emo: '🥧', col: '#f2c46b', name: 'TORTA' },
  { bites: 1, r: 24, good: false, w: 10, emo: '🦴', col: '#f4f0e0', name: 'OSSO' },
  { bites: 1, r: 22, good: false, w: 8, emo: '🌶️', col: '#ff3b1f', name: 'PEPERONCINO' },
  { bites: 1, r: 22, good: false, w: 7, emo: '🐭', col: '#9a9aa6', name: 'TOPO' },
  { bites: 12, r: 62, good: true, w: 0, emo: '🐗', col: '#8a5a32', name: 'CINGHIALE' },
  { bites: 0, r: 46, good: true, w: 0, emo: '🥮', col: '#e0a64a', name: 'PASTICCIO' },
];
const T_COSCIA = 2, T_OSSO = 4, T_PEPE = 5, T_TOPO = 6, T_BOAR = 7, T_PIE = 8;
// Throw origins: the King on his dais (far side) and the servants behind the side tables.
const ORIG = [[500, 10, 150], [-40, 0, 90], [1040, 0, 90]];
const SIDE = [[0, 1], [0, -1], [-1, 0], [1, 0]];
// Player state codes in the view.
const ST_OK = 0, ST_CHOKE = 1, ST_PANIC = 2, ST_SCARED = 3, ST_DIZZY = 4, ST_ROBBED = 5, ST_FIRE = 6;
const TEAM_COL = ['#ff4b5c', '#3fa9ff'];

const isGood = (k) => INFO[k].good;
const bad = (it) => !INFO[it.k].good;

function spawnPlayers(s, g) {
  const n = s.p.length;
  const teams = g.teams;
  s.p.forEach((p, i) => {
    let x, y;
    if (teams) {
      // Teammates start on the same side (team 0 bottom, team 1 top), one left and one right.
      const tm = teams[i];
      const k = s.p.filter((q) => q.i < i && teams[q.i] === tm).length;
      x = k ? 680 : 320; y = tm ? 300 : 790;
    } else {
      const [ux, uy] = SIDE[i];
      x = CX + ux * 300; y = CY + uy * 300;
    }
    p.x = x; p.y = y;
    const n0 = norm(CX - x || 0.01, CY - y);
    p.fx = n0.x; p.fy = n0.y;
  });
  return n;
}

function weightsFor(g, s) {
  const w = INFO.map((f) => f.w);
  if (g.variant === 'piccante') w[T_PEPE] *= 2.5;
  if (s.t > DURATION - FINAL) { w[3] *= 1.6; w[2] *= 1.3; }
  return w;
}

function pickType(g, s) {
  const w = weightsFor(g, s);
  let tot = 0;
  for (const v of w) tot += v;
  let r = g.rng() * tot;
  for (let k = 0; k < w.length; k++) { r -= w[k]; if (r < 0) return k; }
  return 0;
}

function addItem(s, g, k, x, y, o = {}) {
  if (s.it.length >= MAX_ITEMS && !o.force) return null;
  const inf = INFO[k];
  const oi = o.orig ?? 0;
  const ox = o.ox ?? ORIG[oi][0], oy = o.oy ?? (oi === 0 ? ORIG[0][1] : clamp(y + (g.rng() - 0.5) * 300, AY0, AY1));
  const it = {
    id: ++s.nid, k, x, y, ox, oy, oh: o.oh ?? ORIG[oi][2], ft: o.ft ?? FALL_T, f: o.ft ?? FALL_T,
    b: o.b ?? inf.bites, life: o.life ?? LIFE, age: 0, dog: -1,
    cl: g.variant === 'cloche' && k < T_BOAR && !o.open ? 1 : 0, pop: k === T_PIE ? 0.9 : 0,
  };
  s.it.push(it);
  return it;
}

// A free landing spot on the carpet, not on top of another item (fair random spread).
function freeSpot(s, g, r) {
  let best = null, bd = -1;
  for (let k = 0; k < 6; k++) {
    const x = g.rng.range(AX0 + r + 20, AX1 - r - 20), y = g.rng.range(AY0 + r + 20, AY1 - r - 20);
    let m = 1e9;
    for (const it of s.it) m = Math.min(m, dist(x, y, it.x, it.y) - INFO[it.k].r);
    if (m > bd) { bd = m; best = { x, y }; }
    if (m > 120) break;
  }
  return best;
}

// The bitten player loses points; they fall on the floor as a roasted leg anyone can grab.
function dropFood(s, g, p, amount, ang) {
  const n = Math.min(amount, s.sc[p.i]);
  if (n <= 0) return 0;
  s.sc[p.i] -= n;
  const a = ang ?? g.rng.range(0, TAU);
  const x = clamp(p.x + Math.cos(a) * 110, AX0 + 30, AX1 - 30), y = clamp(p.y + Math.sin(a) * 110, AY0 + 30, AY1 - 30);
  addItem(s, g, T_COSCIA, x, y, { ox: p.x, oy: p.y, oh: 60, ft: 0.45, b: n, open: true, force: true });
  return n;
}

function hurt(p, code, time) {
  p.st = code; p.stT = time;
  p.lunge = 0;
}

function biteCandidates(p, s) {
  const mx = p.x + p.fx * p.r * 0.5, my = p.y + p.fy * p.r * 0.5;
  let best = null, bd = 1e9;
  for (const it of s.it) {
    if (it.f > 0 || it.k === T_PIE || it.b <= 0) continue;
    const d = dist(mx, my, it.x, it.y);
    if (d < INFO[it.k].r + p.r * 0.9 + 18 && d < bd) { bd = d; best = it; }
  }
  return best;
}

function doBite(s, g, p, it) {
  const inf = INFO[it.k];
  it.cl = 0;
  p.bk++;
  if (inf.good) {
    const pts = s.t > DURATION - FINAL ? 2 : 1;
    s.sc[p.i] += pts;
    p.belly = Math.min(BELLY_MAX, p.belly + 1);
    p.bites++;
    p.chew = CHEW;
    it.b--;
    g.sfx('squish', { vol: 0.45, pitch: 0.9 + g.rng() * 0.4 });
    g.burst(it.x, it.y, { color: inf.col, n: 4, speed: 140, size: 6 });
    if (it.b <= 0) {
      const tot = inf.bites * pts;
      g.text(it.x, it.y - 50, it.k === T_BOAR ? 'SPOLPATO!' : `+${tot > 1 ? tot : 1} GNAM!`, { player: p.i, size: it.k === T_BOAR ? 60 : 40 });
      g.burst(it.x, it.y, { color: inf.col, n: it.k === T_BOAR ? 30 : 12, speed: 260 });
      g.sfx(it.k === T_BOAR ? 'tada' : 'coin', { vol: 0.6 });
      if (p.belly >= BELLY_MAX - 1) g.text(p.x, p.y - p.r - 40, 'PANZA PIENA!', { color: '#ffd36b', size: 34 });
    }
    return;
  }
  // Nasty stuff.
  it.b = 0;
  g.vibrate(p.i, 150);
  if (it.k === T_OSSO) {
    s.sc[p.i] = Math.max(0, s.sc[p.i] - 2);
    hurt(p, ST_CHOKE, 1.1);
    g.sfx('bonk'); g.sfx('wobble', { vol: 0.6 });
    g.text(p.x, p.y - p.r - 30, 'TI VA DI TRAVERSO!', { color: '#fff3d0', size: 40 });
    g.burst(it.x, it.y, { color: '#f4f0e0', n: 10, speed: 200 });
    g.shake(0.25);
  } else if (it.k === T_PEPE) {
    g.sfx('fire'); g.shake(0.35);
    g.burst(p.x, p.y, { color: '#ff5a1f', n: 26, speed: 380 });
    if (g.variant === 'piccante') {
      p.fire = 1.7; p.fireHit = 0; p.firedSet = 0;
      g.text(p.x, p.y - p.r - 30, 'FIATO DI DRAGO!', { color: '#ff7a2a', size: 46 });
      g.say('🔥 FIATO DI DRAGO!');
    } else {
      s.sc[p.i] = Math.max(0, s.sc[p.i] - 1);
      hurt(p, ST_PANIC, 1.5);
      const a = g.rng.range(0, TAU);
      p.pdx = Math.cos(a); p.pdy = Math.sin(a);
      g.text(p.x, p.y - p.r - 30, 'SCOTTA! SCOTTA!', { color: '#ff7a2a', size: 44 });
    }
  } else if (it.k === T_TOPO) {
    hurt(p, ST_SCARED, 0.9);
    const lost = dropFood(s, g, p, 3);
    g.sfx('quack', { pitch: 1.8 }); g.sfx('slide');
    g.text(p.x, p.y - p.r - 30, lost ? `UN TOPO! -${lost}` : 'UN TOPO!', { color: '#d8d8e8', size: 44 });
    // The mouse runs off toward the nearest side.
    const dir = it.x < CX ? -1 : 1;
    s.mice.push({ id: ++s.nid, x: it.x, y: it.y, vx: dir * 520, vy: g.rng.range(-160, 160) });
    if (s.mice.length > 4) s.mice.shift();
  }
}

function botTarget(s, me, g, B, p) {
  const lv = B.level;
  const sp = speedOf(p);
  let best = null, bs = -1;
  for (const it of s.it) {
    if (it.k === T_PIE || it.b <= 0) continue;
    const inf = INFO[it.k];
    // Cloche: the bad ones rattle. Easy bots do not notice.
    const looksBad = it.cl ? (lv > 0 && !inf.good) : !inf.good;
    if (looksBad) continue;
    if (g.variant === 'piccante' && it.k === T_PEPE) continue;
    const d = dist(p.x, p.y, it.x, it.y);
    const eta = d / sp;
    if (it.f > 0 && lv === 0) continue;                   // the easy bot does not read the shadows
    if (it.f > 0 && it.f > eta + 0.6) continue;           // would wait too long
    if (it.dog >= 0 && lv > 0) continue;                  // a dog is already on it
    const val = it.cl ? 2 : it.b;
    let time = Math.max(eta, it.f) + it.b * (lv === 2 ? 0.1 : 0.16) + 0.25;
    // Somebody much closer will get it first (the boar is shared: everybody can bite it).
    for (const q of s.p) {
      if (q === p || q.st === ST_PANIC) continue;
      const dq = dist(q.x, q.y, it.x, it.y);
      if (it.k !== T_BOAR && dq < d * 0.6 && dq < 260) time += g.ally(me, q.i) ? 3 : lv === 2 ? 1.2 : 0.5;
    }
    const sc = val / time + (B.mem.tid === it.id ? 0.3 : 0);
    if (sc > bs) { bs = sc; best = it; }
  }
  return best;
}

function speedOf(p) {
  return SPEED * (1 - 0.5 * (p.belly / BELLY_MAX));
}

function banchettoBot(s, me, g, B) {
  const p = s.p[me];
  if (!p) return { x: 0, y: 0 };
  const lv = B.level, m = B.mem;
  if (p.st === ST_PANIC || p.st === ST_CHOKE || p.st === ST_SCARED || p.st === ST_DIZZY || p.st === ST_ROBBED) return { x: 0, y: 0 };
  // Dragon breath (piccante): turn the flames toward the nearest rival.
  if (p.fire > 0) {
    let q = null, qd = 1e9;
    for (const o of s.p) if (o !== p && !g.ally(me, o.i)) { const d = dist(p.x, p.y, o.x, o.y); if (d < qd) { qd = d; q = o; } }
    if (q) { const n = norm(q.x - p.x, q.y - p.y); return { x: n.x, y: n.y }; }
  }
  // Rob a rival's plate: a juicy rival in lunge range.
  if (p.cd <= 0 && p.lunge <= 0) {
    for (const q of s.p) {
      if (q === p || g.ally(me, q.i) || q.imm > 0) continue;
      const d = dist(p.x, p.y, q.x, q.y);
      const range = p.r + q.r + (lv === 2 ? 125 : 95);
      const want = lv === 0 ? s.sc[q.i] >= 4 && B.rng() < 0.03 : s.sc[q.i] >= 3 && (lv === 2 ? B.rng() < 0.5 : B.rng() < 0.06);
      if (d < range && want) {
        const lead = lv === 2 ? 0.12 : 0;
        const n = norm(q.x + q.vx * lead - p.x, q.y + q.vy * lead - p.y);
        return { x: n.x, y: n.y, tapB: true };
      }
    }
  }
  // Dodge items about to land on my head (and the boar).
  if (lv > 0) {
    for (const it of s.it) {
      if (it.f <= 0 || it.f > (lv === 2 ? 0.5 : 0.3)) continue;
      const rr = INFO[it.k].r + p.r + (it.k === T_BOAR ? 60 : 8);
      const d = dist(p.x, p.y, it.x, it.y);
      if (d < rr) {
        const n = norm(p.x - it.x || 0.3, p.y - it.y);
        return { x: n.x, y: n.y };
      }
    }
  }
  if (!m.re || g.t > m.re || !s.it.some((it) => it.id === m.tid && it.b > 0)) {
    const t = botTarget(s, me, g, B, p);
    m.tid = t ? t.id : -1;
    m.re = g.t + (lv === 2 ? 0.15 : lv === 1 ? 0.35 : 0.7);
  }
  const it = s.it.find((q) => q.id === m.tid);
  if (!it) {
    // Nothing to eat: drift toward the middle of the carpet (where food lands most often), away from rivals.
    const n = norm(CX - p.x, CY - p.y);
    const d = dist(CX, CY, p.x, p.y);
    return d > 120 ? { x: n.x * 0.6, y: n.y * 0.6 } : { x: 0, y: 0 };
  }
  // Approach so that the mouth reaches the food; if a nasty item is closer to the mouth, come from the other side.
  const d = dist(p.x, p.y, it.x, it.y);
  const reach = INFO[it.k].r + p.r * 0.9 + 18;
  const near = biteCandidates(p, s);
  if (it.f <= 0 && near === it && p.chew <= 0) {
    const n = norm(it.x - p.x, it.y - p.y);
    return { x: n.x * 0.15, y: n.y * 0.15, tapA: true };
  }
  let gx = it.x, gy = it.y;
  if (near && near !== it && bad(near) && lv > 0) {
    const n = norm(p.x - near.x || 0.1, p.y - near.y);
    gx = it.x + n.x * reach * 0.6; gy = it.y + n.y * reach * 0.6;
  }
  if (lv === 0 && near && near !== it && p.chew <= 0 && B.rng() < 0.08) return { x: 0, y: 0, tapA: true }; // the easy bot bites whatever is in front
  const n = norm(gx - p.x, gy - p.y);
  // Brake when close (no overshoot).
  const k = clamp((d - reach * 0.4) / 120, 0.25, 1);
  return { x: n.x * k, y: n.y * k };
}

export default {
  id: 'banchetto',
  name: 'Il Banchetto del Re',
  rule: 'Mangia il buono, evita le porcherie, ruba dal piatto altrui!',
  verb: 'ABBUFFATEVI!',
  inspired: 'Mario Party · Hungry Hungry Hippos',
  cam: 'top',
  split: false,
  players: 4,
  teams: true,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Morso', b: 'Ruba' },
  duration: DURATION,
  supports: ['autoA'],
  variants: [
    { id: 'cani', name: 'Cani Affamati', desc: 'Quattro cagnacci sotto il tavolo: rubano il cibo e pure le cosce dal tuo piatto!' },
    { id: 'cloche', name: 'Piatti Misteriosi', desc: 'Tutto arriva sotto la campana d\'argento: le porcherie fanno tremare il coperchio…' },
    { id: 'piccante', name: 'Cena del Drago', desc: 'Pioggia di peperoncini del drago: chi li mangia sputa fuoco sugli altri!' },
  ],
  help: {
    goal: 'Chi ha mangiato più bocconi allo scadere vince. Negli ultimi 10 s (abbuffata finale) ogni boccone vale doppio! A squadre conta la dispensa di squadra.',
    dir: 'Corri sul tappeto. Più mangi, più la panza cresce e rallenti (poi digerisci).',
    a: 'MORSO: mordi il cibo davanti a te (premi più volte: la coscia vuole 3 morsi, la torta 5, il cinghiale del Re 12 e lo mordono tutti).',
    b: 'RUBA: scatto in avanti; se tocchi un rivale gli freghi 3 bocconi dal piatto (si ricarica in 1.5 s).',
    tips: ['Ossa (-2, ti va di traverso), peperoncini (scappi urlando) e topi (ti cade il piatto): NON morderli!', "L'ombra a terra mostra dove cade il cibo: se ti arriva in testa resti stordito", 'I cani sotto i tavoli si mangiano il cibo lasciato vicino ai bordi'],
  },

  init(g) {
    const n = g.n || 2;
    const s = {
      t: 0, nid: 0, next: 0.4, sp: 0, kt: 0, kw: 0, fin: false,
      it: [], mice: [], sc: Array(n).fill(0),
      p: [...Array(n).keys()].map((i) => ({
        i, x: 0, y: 0, vx: 0, vy: 0, kx: 0, ky: 0, fx: 0, fy: -1, r: R0, belly: 0, bites: 0, bad: 0,
        chew: 0, cd: 0, lunge: 0, ln: 0, bk: 0, st: ST_OK, stT: 0, pdx: 0, pdy: 0, imm: 0, fire: 0, fireHit: 0, firedSet: 0,
      })),
      dogs: [], tm: g.teams ? g.teams.slice() : null,
    };
    spawnPlayers(s, g);
    const homes = g.variant === 'cani' ? [[22, 640], [978, 360], [22, 280], [978, 760]] : [[22, 640], [978, 360]];
    s.dogs = homes.map(([x, y], k) => ({ k, x, y, hx: x, hy: y, st: 0, tgt: -1, pl: -1, a: x < CX ? 0 : Math.PI, cd: 2 + k, carry: 0, eat: 0 }));
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.t = g.t;
    const final = g.t >= DURATION - FINAL;
    if (final && !s.fin) {
      s.fin = true;
      g.say('🍗 ABBUFFATA FINALE! PUNTI DOPPI!'); g.sfx('fanfare'); g.flash('#ffd36b', 0.3);
    }
    // --- the King's specials (warned 1.2 s before) ---
    if (s.sp < SPECIAL_AT.length && g.t >= SPECIAL_AT[s.sp] - 1.2 && !s.kw) {
      s.kw = 1;
      const boar = s.sp % 2 === 0;
      g.say(boar ? '👑 IL RE LANCIA IL CINGHIALE!' : '👑 IL PASTICCIO DEL RE!');
      g.sfx('horn');
    }
    if (s.sp < SPECIAL_AT.length && g.t >= SPECIAL_AT[s.sp]) {
      const boar = s.sp % 2 === 0;
      s.sp++; s.kw = 0; s.kt++;
      const x = g.rng.range(330, 670), y = g.rng.range(420, 680);
      addItem(s, g, boar ? T_BOAR : T_PIE, x, y, { orig: 0, ft: 1.6, life: boar ? 14 : 9, force: true, open: true });
      g.sfx('whoosh');
    }
    // --- regular rain of food ---
    s.next -= dt;
    if (s.next <= 0 && !g.ended) {
      const u = clamp(g.t / DURATION, 0, 1);
      s.next = (0.62 - 0.26 * u) * (final ? 0.75 : 1) * (s.p.length >= 3 ? 0.82 : 1);
      const k = pickType(g, s);
      const sp = freeSpot(s, g, INFO[k].r);
      const roll = g.rng();
      const orig = roll < 0.5 ? 0 : sp.x < CX ? 1 : 2;
      if (addItem(s, g, k, sp.x, sp.y, { orig }) && orig === 0) s.kt++;
    }
    // --- items: falling, landing, aging, pie bursting ---
    for (const it of s.it) {
      const inf = INFO[it.k];
      if (it.f > 0) {
        it.f -= dt;
        if (it.f <= 0) {
          it.f = 0;
          if (it.k === T_BOAR || it.k === T_PIE) {
            g.sfx('crash'); g.shake(0.5); g.ring(it.x, it.y, { color: '#ffd36b', r: 150 });
            g.burst(it.x, it.y, { color: '#d9b38a', n: 30, speed: 360 });
            for (const p of s.p) {
              const d = dist(p.x, p.y, it.x, it.y);
              if (d < inf.r + p.r + 40) { const n = norm(p.x - it.x || 0.1, p.y - it.y); p.kx += n.x * 700; p.ky += n.y * 700; hurt(p, ST_DIZZY, 0.5); }
            }
          } else {
            g.sfx('land', { vol: 0.35, pitch: 1.3 });
            for (const p of s.p) {
              if (dist(p.x, p.y, it.x, it.y) < p.r + inf.r * 0.6) {
                hurt(p, ST_DIZZY, 0.55);
                g.sfx('bonk', { pitch: 1.2 }); g.text(p.x, p.y - p.r - 30, 'BONK!', { color: '#fff', size: 36 });
                g.vibrate(p.i, 60);
                const n = norm(it.x - p.x || 0.2, it.y - p.y);
                it.x = clamp(p.x + n.x * (p.r + inf.r + 6), AX0 + 20, AX1 - 20); it.y = clamp(p.y + n.y * (p.r + inf.r + 6), AY0 + 20, AY1 - 20);
              }
            }
          }
        }
        continue;
      }
      it.age += dt;
      it.life -= dt;
      if (it.k === T_PIE && it.pop > 0) {
        it.pop -= dt;
        if (it.pop <= 0) {
          // The pie bursts: 6 treats fly out (one of them nasty).
          it.b = 0;
          g.sfx('explode', { vol: 0.7 }); g.shake(0.35); g.burst(it.x, it.y, { color: '#f2c46b', n: 30, speed: 420 });
          const badK = g.rng.pick([T_OSSO, T_TOPO, T_PEPE]);
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * TAU + g.rng.range(-0.3, 0.3), rr = g.rng.range(120, 210);
            const x = clamp(it.x + Math.cos(a) * rr, AX0 + 30, AX1 - 30), y = clamp(it.y + Math.sin(a) * rr, AY0 + 30, AY1 - 30);
            addItem(s, g, k === 0 ? badK : g.rng.pick([0, 1, 2, 2, 3]), x, y, { ox: it.x, oy: it.y, oh: 50, ft: 0.5, force: true });
          }
        }
      }
    }
    // --- dogs ---
    const dogV = g.variant === 'cani' ? 400 : 360;
    for (const dg of s.dogs) {
      dg.cd = Math.max(0, dg.cd - dt);
      dg.eat = Math.max(0, dg.eat - dt);
      let tx = dg.hx, ty = dg.hy;
      if (dg.st === 0 && dg.cd <= 0) {
        // Food left lying near my table?
        let best = null, bd = 380;
        for (const it of s.it) {
          if (it.f > 0 || it.age < 1.8 || it.dog >= 0 || it.k === T_BOAR || it.k === T_PIE || it.b <= 0) continue;
          const d = dist(dg.hx, dg.hy, it.x, it.y);
          if (d < bd) { bd = d; best = it; }
        }
        if (best) { dg.st = 1; dg.tgt = best.id; best.dog = dg.k; g.sfx('quack', { pitch: 0.5, vol: 0.5 }); }
        else if (g.variant === 'cani') {
          // Hungry dogs also go for the fattest plate in reach.
          let q = null, qs = 2;
          for (const p of s.p) if (s.sc[p.i] > qs && p.imm <= 0 && dist(dg.hx, dg.hy, p.x, p.y) < 480) { qs = s.sc[p.i]; q = p; }
          if (q) { dg.st = 3; dg.pl = q.i; g.sfx('quack', { pitch: 0.45, vol: 0.6 }); }
        }
      }
      if (dg.st === 1) {
        const it = s.it.find((q) => q.id === dg.tgt && q.b > 0);
        if (!it) { dg.st = 2; }
        else {
          tx = it.x; ty = it.y;
          if (dist(dg.x, dg.y, it.x, it.y) < 34) {
            it.b = 0; dg.carry = 1; dg.st = 2; dg.eat = 0.6;
            g.sfx('pop'); g.text(it.x, it.y - 40, 'BAU! 🐕', { color: '#ffe0b0', size: 34 });
            g.burst(it.x, it.y, { color: INFO[it.k].col, n: 8, speed: 160 });
          }
        }
      } else if (dg.st === 3) {
        const p = s.p[dg.pl];
        if (!p || p.imm > 0) dg.st = 2;
        else {
          tx = p.x; ty = p.y;
          if (dist(dg.x, dg.y, p.x, p.y) < p.r + 26) {
            const n = Math.min(2, s.sc[p.i]);
            s.sc[p.i] -= n;
            p.imm = 1.2; hurt(p, ST_ROBBED, 0.35);
            dg.carry = 1; dg.st = 2;
            g.sfx('slide'); g.vibrate(p.i, 80);
            g.text(p.x, p.y - p.r - 30, `IL CANE TI FREGA! -${n}`, { color: '#ffe0b0', size: 38 });
          }
        }
      }
      if (dg.st === 2 && dist(dg.x, dg.y, dg.hx, dg.hy) < 10) { dg.st = 0; dg.carry = 0; dg.cd = 1.5 + dg.k * 0.4; }
      if (dg.st === 0) { tx = dg.hx; ty = dg.hy; }
      const dx = tx - dg.x, dy = ty - dg.y, d = Math.hypot(dx, dy);
      if (d > 2) {
        const v = Math.min(dogV * (dg.st === 2 ? 0.8 : 1), d / dt);
        dg.x += (dx / d) * v * dt; dg.y += (dy / d) * v * dt;
        dg.a = Math.atan2(dy, dx);
        dg.mv = 1;
      } else dg.mv = 0;
    }
    // --- mice running away ---
    for (const m of s.mice) { m.x += m.vx * dt; m.y += m.vy * dt; }
    s.mice = s.mice.filter((m) => m.x > -150 && m.x < W + 150);
    // --- remove eaten / expired items ---
    s.it = s.it.filter((it) => {
      if (it.b <= 0 && !(it.k === T_PIE && it.pop > 0)) return false;
      if (it.life <= 0) { g.burst(it.x, it.y, { color: '#b38a5a', n: 5, speed: 90 }); return false; }
      return true;
    });

    // --- players ---
    const reqs = [];
    for (const p of s.p) {
      const i = inp[p.i];
      p.chew = Math.max(0, p.chew - dt);
      p.cd = Math.max(0, p.cd - dt);
      p.imm = Math.max(0, p.imm - dt);
      p.belly = Math.max(0, p.belly - DIGEST * dt);
      p.r = R0 + p.belly * 1.15;
      if (p.stT > 0) { p.stT -= dt; if (p.stT <= 0) { p.st = ST_OK; p.stT = 0; } }
      const busy = p.st !== ST_OK;
      if (Math.hypot(i.x, i.y) > 0.2 && p.st !== ST_PANIC) { const n = norm(i.x, i.y); p.fx = n.x; p.fy = n.y; }
      let sp = speedOf(p);
      let wx = i.x, wy = i.y;
      if (p.st === ST_PANIC) { wx = p.pdx; wy = p.pdy; sp = SPEED * 1.25; }
      else if (busy) { wx = 0; wy = 0; }
      if (p.chew > 0) sp *= 0.6;
      if (p.fire > 0) sp *= 0.5;
      const k = 1 - Math.pow(0.0015, dt);
      if (p.lunge > 0) {
        p.lunge -= dt;
      } else {
        p.vx += (wx * sp - p.vx) * k;
        p.vy += (wy * sp - p.vy) * k;
      }
      const kd = Math.pow(0.02, dt);
      p.kx *= kd; p.ky *= kd;
      p.x += (p.vx + p.kx) * dt; p.y += (p.vy + p.ky) * dt;
      // Carpet borders (panicking players bounce off them).
      if (p.x < AX0 + p.r * 0.5) { p.x = AX0 + p.r * 0.5; p.pdx = Math.abs(p.pdx); p.kx = Math.abs(p.kx) * 0.3; }
      if (p.x > AX1 - p.r * 0.5) { p.x = AX1 - p.r * 0.5; p.pdx = -Math.abs(p.pdx); p.kx = -Math.abs(p.kx) * 0.3; }
      if (p.y < AY0 + p.r * 0.5) { p.y = AY0 + p.r * 0.5; p.pdy = Math.abs(p.pdy); p.ky = Math.abs(p.ky) * 0.3; }
      if (p.y > AY1 - p.r * 0.5) { p.y = AY1 - p.r * 0.5; p.pdy = -Math.abs(p.pdy); p.ky = -Math.abs(p.ky) * 0.3; }
      if (busy || g.ended) continue;
      // Rob (B): a short lunge forward.
      if (i.bP && p.cd <= 0 && p.lunge <= 0 && p.fire <= 0) {
        p.lunge = LUNGE_T; p.cd = LUNGE_CD; p.ln++;
        p.vx = p.fx * LUNGE_V; p.vy = p.fy * LUNGE_V;
        g.sfx('dash', { vol: 0.7 });
        g.burst(p.x, p.y, { player: p.i, n: 8, speed: 180 });
      }
      // Bite (A): every press is a bite (mash!). Requests sorted by press time: no seat advantage.
      if ((i.aP || i.aN > 0) && p.chew <= 0 && p.lunge <= 0) reqs.push({ p, t: i.aT });
    }
    reqs.sort((a, b) => a.t - b.t);
    for (const { p } of reqs) {
      const it = biteCandidates(p, s);
      if (it) doBite(s, g, p, it);
      else { p.chew = MISS_CHEW; p.bk++; g.sfx('click', { vol: 0.35, pitch: 0.6 }); }
    }
    s.it = s.it.filter((it) => it.b > 0 || (it.k === T_PIE && it.pop > 0));

    // --- lunges hit rivals: steal from their plate ---
    for (const p of s.p) {
      if (p.lunge <= 0) continue;
      for (const q of s.p) {
        if (q === p || g.ally(p.i, q.i) || q.imm > 0) continue;
        if (dist(p.x, p.y, q.x, q.y) > p.r + q.r + 10) continue;
        const n = Math.min(STEAL, s.sc[q.i]);
        s.sc[q.i] -= n; s.sc[p.i] += n;
        q.imm = 1.4; hurt(q, ST_ROBBED, 0.45);
        const d = norm(q.x - p.x, q.y - p.y);
        q.kx += d.x * 420; q.ky += d.y * 420;
        p.lunge = 0; p.vx *= 0.2; p.vy *= 0.2;
        g.vibrate(q.i, 100); g.vibrate(p.i, 40);
        g.hitstop(0.06); g.shake(0.3);
        g.sfx(n ? 'punch' : 'bonk');
        if (n) g.sfx('coin', { pitch: 1.3, vol: 0.6 });
        g.burst((p.x + q.x) / 2, (p.y + q.y) / 2, { color: '#c8763a', n: n ? 16 : 6, speed: 300 });
        g.text(q.x, q.y - q.r - 30, n ? `RUBATO! -${n}` : 'PIATTO VUOTO!', { player: p.i, size: 44 });
        break;
      }
    }
    // --- dragon breath (piccante) ---
    for (const p of s.p) {
      if (p.fire <= 0) continue;
      p.fire -= dt;
      for (const q of s.p) {
        if (q === p || g.ally(p.i, q.i) || q.imm > 0) continue;
        const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
        if (d > 250 + q.r || d < 1) continue;
        if ((dx * p.fx + dy * p.fy) / d < Math.cos(0.5)) continue;
        q.imm = 1.2; hurt(q, ST_PANIC, 0.9);
        q.pdx = dx / d; q.pdy = dy / d;
        const lost = dropFood(s, g, q, 2, Math.atan2(dy, dx));
        g.sfx('fire', { pitch: 1.3 }); g.vibrate(q.i, 120);
        g.text(q.x, q.y - q.r - 30, lost ? `ARROSTITO! -${lost}` : 'ARROSTITO!', { color: '#ff7a2a', size: 42 });
        g.burst(q.x, q.y, { color: '#ff7a2a', n: 18, speed: 260 });
      }
    }
    // --- bumping ---
    for (let a = 0; a < s.p.length; a++) {
      for (let b = a + 1; b < s.p.length; b++) {
        const A = s.p[a], Bq = s.p[b];
        const ma = 1 + A.belly * 0.12 + (A.lunge > 0 ? 1 : 0), mb = 1 + Bq.belly * 0.12 + (Bq.lunge > 0 ? 1 : 0);
        const ca = { x: A.x, y: A.y, vx: A.kx + A.vx * 0.5, vy: A.ky + A.vy * 0.5, r: A.r, m: ma };
        const cb = { x: Bq.x, y: Bq.y, vx: Bq.kx + Bq.vx * 0.5, vy: Bq.ky + Bq.vy * 0.5, r: Bq.r, m: mb };
        const imp = collideCircles(ca, cb, 0.8);
        if (!imp && !(dist(A.x, A.y, Bq.x, Bq.y) < A.r + Bq.r)) continue;
        A.x = ca.x; A.y = ca.y; Bq.x = cb.x; Bq.y = cb.y;
        if (imp > 0) {
          A.kx = ca.vx - A.vx * 0.5; A.ky = ca.vy - A.vy * 0.5; Bq.kx = cb.vx - Bq.vx * 0.5; Bq.ky = cb.vy - Bq.vy * 0.5;
          if (imp > 500) { g.sfx('boing', { vol: 0.5, pitch: 0.8 }); g.burst((A.x + Bq.x) / 2, (A.y + Bq.y) / 2, { color: '#fff', n: 5, speed: 150 }); }
          // A panicking (or fire-breathing) player bowls others over.
          for (const [x, y] of [[A, Bq], [Bq, A]]) if (x.st === ST_PANIC && y.st === ST_OK && y.imm <= 0) { hurt(y, ST_DIZZY, 0.4); g.sfx('bonk'); }
        }
      }
    }
    // Dogs are solid too.
    for (const dg of s.dogs) {
      for (const p of s.p) {
        const d = dist(p.x, p.y, dg.x, dg.y), rr = p.r + 24;
        if (d < rr && d > 0.01) { const n = norm(p.x - dg.x, p.y - dg.y); p.x += n.x * (rr - d); p.y += n.y * (rr - d); }
      }
    }
  },

  timeout(s, g) {
    const n = s.p.length;
    if (g.teams) {
      const tot = [0, 0];
      for (let i = 0; i < n; i++) tot[g.teams[i]] += s.sc[i] * 1000 + s.p[i].bites;
      let w = tot[0] === tot[1] ? (g.rng() < 0.5 ? 0 : 1) : tot[0] > tot[1] ? 0 : 1;
      return s.p.find((p) => g.teams[p.i] === w).i;
    }
    // Most bites on the plate; tiebreak: more food eaten overall, then fewer belly (lighter), then luck.
    let best = 0;
    for (let i = 1; i < n; i++) {
      const a = s.sc[i], b = s.sc[best];
      if (a > b || (a === b && (s.p[i].bites > s.p[best].bites || (s.p[i].bites === s.p[best].bites && g.rng() < 0.5)))) best = i;
    }
    return best;
  },

  bot: banchettoBot,

  view(s) {
    const teams = s.tm || null;
    return {
      t: r1(s.t),
      fin: s.fin ? 1 : 0, kt: s.kt, kw: s.kw,
      it: s.it.map((it) => ({
        id: it.id, k: it.cl ? -1 : it.k, x: r1(it.x), y: r1(it.y), ox: r1(it.ox), oy: r1(it.oy), oh: it.oh,
        f: r2(it.ft ? it.f / it.ft : 0), b: it.b, bl: it.life < 1.6 ? 1 : 0, wb: it.cl && !INFO[it.k].good ? 1 : 0, pp: it.k === T_PIE ? r2(it.pop) : 0,
      })),
      dg: s.dogs.map((d) => ({ x: r1(d.x), y: r1(d.y), a: r2(d.a), c: d.carry, m: d.mv ? 1 : 0, st: d.st })),
      mc: s.mice.map((m) => ({ id: m.id, x: r1(m.x), y: r1(m.y), a: r2(Math.atan2(m.vy, m.vx)) })),
      p: s.p.map((p) => ({
        x: r1(p.x), y: r1(p.y), r: r1(p.r), fx: r2(p.fx), fy: r2(p.fy), be: r2(p.belly / BELLY_MAX), bk: p.bk % 50, ln: p.ln % 50,
        lu: p.lunge > 0 ? 1 : 0, st: p.st, cd: r2(p.cd), im: p.imm > 0 ? 1 : 0, fi: p.fire > 0 ? 1 : 0, ch: p.chew > 0 ? 1 : 0,
        sp: Math.round(Math.hypot(p.vx, p.vy)), tm: teams ? teams[p.i] : -1, pt: s.sc[p.i],
      })),
      hud: { p: teams ? s.p.map((p) => s.sc.reduce((a, v, j) => a + (teams[j] === teams[p.i] ? v : 0), 0)) : s.sc.slice(), max: null, label: teams ? 'Dispensa' : 'Bocconi' },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  render3d: {
    cam: { target: () => ({ x: 500, y: 455 }), fit: 1.05 },
    assets: [
      'dungeon/table_long_tablecloth_decorated_A', 'dungeon/table_long_tablecloth', 'dungeon/chair', 'dungeon/plate_food_A', 'dungeon/plate_food_B',
      'dungeon/plate_stack', 'dungeon/candle_triple', 'dungeon/candle_lit', 'dungeon/keg_decorated', 'dungeon/barrel_large', 'dungeon/barrel_small_stack',
      'dungeon/banner_patternA_red', 'dungeon/banner_patternB_blue', 'dungeon/banner_patternC_yellow', 'dungeon/banner_patternA_green',
      'dungeon/banner_shield_red', 'dungeon/banner_triple_yellow', 'dungeon/torch_mounted', 'dungeon/pillar_decorated', 'dungeon/shelf_large',
      'dungeon/bottle_A_labeled_green', 'dungeon/bottle_B_brown', 'dungeon/crates_stacked', 'dungeon/box_small_decorated', 'dungeon/trunk_large_A',
      'dungeon/banner_red', 'dungeon/banner_blue', 'weapons/mug_full', 'dungeon/stool',
      'chars/Knight', 'chars/Rogue', 'chars/Barbarian', 'chars/Mage', 'chars/Rogue_Hooded',
    ],
    build(K, r) {
      const { THREE } = K;
      const n = r.n || K.n || 2;
      const lo = K.quality === 0;
      K.theme('grotta', { fogNear: 3.2, fogFar: 9 });
      K.hemi.intensity = 1.5;
      K.hemi.color.set('#ffe6c8');
      K.sun.intensity = 2.3;
      K.sun.color.set('#ffe2b8');
      const o = { n, lo };
      // Stone floor of the hall and the royal carpet (the play area).
      K.ground('lastre', { tile: 150, color: '#b4a48e' });
      K.layer({ x0: -40, y0: 80, x1: 1040, y1: 1000, h: 0.6, transparent: true, once: true, maxPx: 2048, draw: (d) => drawCarpet(d) });
      if (!lo) K.light(500, 520, 520, '#ffd9a0', 1.3, { dist: 1600 }); // the big chandelier (off screen, above the camera)

      // --- the walls (back wall close behind the King, side walls at the screen edges) ---
      const WY = -235;
      const wallMat = K.texMat('muro', [16, 2], { color: '#cdbb9e' });
      K.place(K.box(3600, 60, 480, wallMat), 500, WY - 30, 240);
      for (const x of [-470, 1470]) K.place(K.box(60, 2800, 420, wallMat), x, 400, 210);
      const beam = K.texMat('legno', [10, 1], { color: '#5a3a22' });
      K.place(K.box(3600, 40, 30, beam), 500, WY + 4, 430);
      for (const x of [-330, 40, 960, 1330]) K.place(K.box(40, 30, 430, beam), x, WY + 6, 215);
      K.scatter('dungeon/pillar_decorated', [[-430, 120], [-430, 640], [1430, 120], [1430, 640]].map(([x, y]) => ({ x, y })), { height: 360 });

      // --- the fireplace (left of the King) ---
      const stone = K.texMat('pietra', [3, 2], { color: '#a39684' });
      const FX = -150;
      K.place(K.box(330, 80, 290, stone), FX, WY + 10, 145);
      K.place(K.box(210, 24, 170, K.mat('#160c08', { rough: 1 })), FX, WY + 52, 85);
      K.place(K.box(380, 100, 30, stone), FX, WY + 20, 300);
      K.place(K.box(260, 70, 160, stone), FX, WY, 390);
      for (const dx of [-50, 0, 50]) { const lg = K.cyl(13, 130, K.mat('#4a2c18'), { center: true }); lg.rotation.z = Math.PI / 2; lg.rotation.y = dx * 0.012; K.place(lg, FX + dx * 0.4, WY + 62 + dx * 0.1, 14); }
      o.flames = [];
      for (let k = 0; k < 5; k++) {
        const f = K.cone(1, 1, K.glow(k % 2 ? '#ffb02e' : '#ff5a1e', { add: true, opacity: 0.85 }), { cast: false });
        o.flames.push({ f, x: FX - 52 + k * 26, y: WY + 62, ph: k * 1.3 });
      }
      K.light(FX, WY + 120, 100, '#ff8a3a', lo ? 2.4 : 3.4, { flicker: 0.6, dist: 1000 });
      K.ambient('braci', { n: 26, x0: FX - 90, y0: WY + 40, x1: FX + 90, y1: WY + 90, h: 360 });
      // Stained-glass window on the right of the back wall (moonlight from outside).
      const glassTex = K.canvasTex(256, 384, (d) => drawWindow(d));
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(220, 330), new THREE.MeshBasicMaterial({ map: glassTex, transparent: true }));
      glass.userData.ownGeo = true;
      K.place(glass, 1150, WY + 1, 230);
      K.root.add(glass);
      K.place(K.box(250, 30, 20, stone), 1150, WY + 12, 60);
      if (!lo) K.light(1150, WY + 160, 220, '#9fb8ff', 1.2, { dist: 700 });
      // Tapestries (arazzi) on the back wall and on the side walls.
      const tap = (name, x, y, a, h = 300, hh = 0) => { const b = K.model(name, { height: h }); K.place(b, x, y, hh); K.face(b, a); return b; };
      tap('dungeon/banner_patternA_red', 215, WY + 4, Math.PI / 2, 300);
      tap('dungeon/banner_patternB_blue', 785, WY + 4, Math.PI / 2, 300);
      tap('dungeon/banner_triple_yellow', -390, WY + 4, Math.PI / 2, 280);
      tap('dungeon/banner_patternC_yellow', 1390, WY + 4, Math.PI / 2, 280);
      K.scatter('dungeon/banner_patternA_green', [380, 900].map((y) => ({ x: -440, y, rot: 0 })), { height: 300 });
      K.scatter('dungeon/banner_shield_red', [380, 900].map((y) => ({ x: 1440, y, rot: Math.PI })), { height: 300 });
      const torches = [[60, WY + 6], [940, WY + 6], [-440, 120], [1440, 120]];
      K.scatter('dungeon/torch_mounted', torches.map(([x, y], k) => ({ x, y, h: 170, rot: k < 2 ? Math.PI / 2 : k === 2 ? 0 : Math.PI })), { height: 80 });
      if (!lo) K.light(940, WY + 60, 220, '#ffb35c', 1.4, { flicker: 0.5, dist: 650 });

      // --- the King's dais: throne in the middle, two laden tables with guests on the sides ---
      const carpetRed = K.texMat('tappeto', [4, 1], { color: '#d8a0a0' });
      K.place(K.box(760, 150, 30, stone), 500, 20, 15);
      K.place(K.box(730, 130, 4, carpetRed), 500, 20, 31);
      for (const s of [-1, 1]) {
        const tb = K.model('dungeon/table_long_tablecloth_decorated_A', { size: 230 });
        K.place(tb, 500 + s * 220, 55, 30);
        K.face(tb, Math.PI / 2);
      }
      // Throne: tall red-and-gold chair built from boxes.
      const gold = K.mat('#e2b13c', { rough: 0.3, metal: 0.7 }), velvet = K.mat('#9b1b2a', { rough: 0.7 });
      K.place(K.box(100, 60, 40, gold), 500, 0, 50);
      K.place(K.box(116, 20, 200, gold), 500, -34, 130);
      K.place(K.box(88, 8, 160, velvet), 500, -22, 140);
      for (const s of [-1, 1]) { K.place(K.ball(13, gold), 500 + s * 54, -34, 234); K.place(K.box(14, 60, 50, gold), 500 + s * 50, 0, 85); }
      o.king = K.npc('knight', { marker: false });
      o.crown = K.group();
      K.cyl(17, 16, gold, { parent: o.crown, open: true, seg: 12 });
      for (let k = 0; k < 5; k++) { const c = K.cone(5, 14, gold, { parent: o.crown }); const a = (k / 5) * TAU; c.position.set(Math.cos(a) * 15, 16, Math.sin(a) * 15); }
      const gem = K.ball(5, K.mat('#ff2a4a', { emissive: '#ff2a4a', ei: 0.6 }), { parent: o.crown }); gem.position.set(0, 10, 17);
      // Royal guests behind the dais tables.
      K.scatter('dungeon/chair', [[290, 0], [710, 0]].map(([x, y]) => ({ x, y, rot: -Math.PI / 2 })), { height: 80 });
      o.guests = (lo ? [] : [['mage', 290, -5]]).map(([c, x, y]) => ({ av: K.npc(c, { marker: false }), x, y }));
      // --- side tables with the court, plates, candles; the dogs wait between tables and carpet ---
      const tables = [];
      for (const x of [-105, 1105]) for (const y of [170, 500, 830]) tables.push({ x, y, rot: 0 });
      K.scatter('dungeon/table_long_tablecloth', tables, { size: 300 });
      const stools = [];
      for (const x of [-200, 1200]) for (const y of [90, 250, 420, 580, 750, 910]) stools.push({ x, y, rot: x < 0 ? 0 : Math.PI });
      K.scatter('dungeon/stool', stools, { height: 46 });
      const plates = [], plates2 = [], candles = [], mugs = [];
      for (const x of [-105, 1105]) for (let y = 60; y <= 940; y += 70) {
        const k = Math.round(y / 70);
        if (k % 5 === 4) continue; // gaps between tables
        (k % 2 ? plates : plates2).push({ x: x + (k % 3 - 1) * 12, y, h: 0, rot: k });
        if (k % 4 === 1) candles.push({ x: x - (x < 0 ? -22 : 22), y: y + 30, h: 0 });
        if (k % 3 === 2) mugs.push({ x: x + (x < 0 ? 26 : -26), y: y + 12, h: 0, rot: k });
      }
      const TOP = 70; // table top height (model dependent: tuned on screenshots)
      K.scatter('dungeon/plate_food_A', plates.map((q) => ({ ...q, h: TOP })), { size: 40, cast: false });
      K.scatter('dungeon/plate_food_B', plates2.map((q) => ({ ...q, h: TOP })), { size: 40, cast: false });
      K.scatter('dungeon/candle_triple', candles.map((q) => ({ ...q, h: TOP })), { height: 46, cast: false });
      K.scatter('weapons/mug_full', mugs.map((q) => ({ ...q, h: TOP })), { height: 20, cast: false });
      // A few seated courtiers cheering on each side.
      const court = [['barbarian', -200, 250, 0], ['mage', 1200, 750, Math.PI]];
      o.court = (lo ? court.slice(0, 1) : court).map(([c, x, y, a], k) => ({ av: K.npc(c, { marker: false }), x, y, a, k }));
      // Kegs, barrels, crates in the corners.
      K.scatter('dungeon/keg_decorated', [[-330, -150], [1330, -150], [-360, 1080], [1360, 1080]].map(([x, y], k) => ({ x, y, rot: k })), { height: 90 });
      K.scatter('dungeon/barrel_small_stack', [[-300, 990], [1300, 990], [-390, -40], [1390, -40]].map(([x, y], k) => ({ x, y, rot: k * 1.3 })), { height: 100 });
      K.scatter('dungeon/crates_stacked', [[-400, 1180], [1400, 1180]].map(([x, y]) => ({ x, y })), { height: 120 });

      // --- jesters juggling at the front corners ---
      o.jesters = [[-60, 995], [1060, 995]].map(([x, y], k) => {
        const balls = [0, 1, 2].map((b) => K.ball(9, K.mat(['#ff4b5c', '#ffd36b', '#3fa9ff'][(b + k) % 3], { rough: 0.3 }), { cast: false }));
        return { av: K.npc(k ? 'rogue' : 'hooded', { marker: false }), x, y, balls, k };
      });
      K.ambient('polvere', { n: 60, x0: -200, y0: -200, x1: 1200, y1: 1100, h: 400 });

      // --- team pantries (only in a 2 vs 2) ---
      o.pantry = [];
      for (let t = 0; t < 2; t++) {
        const px = t ? 1300 : -300, py = t ? 330 : 670;
        const grp = K.group();
        K.place(grp, px, py);
        const piles = [];
        const tbl = K.box(170, 110, 60, K.texMat('legno', [2, 1], { color: '#8a5a32' }), { parent: grp });
        tbl.position.set(0, 30, 0);
        const ban = K.model(t ? 'dungeon/banner_blue' : 'dungeon/banner_red', { height: 220, parent: grp });
        ban.position.set(0, 0, -70);
        for (let k = 0; k < 15; k++) {
          const col = ['#c8763a', '#d9a35b', '#8e44ad', '#f2c46b'][k % 4];
          const b = K.ball(16, K.mat(col, { rough: 0.6 }), { parent: grp });
          const row = Math.floor(k / 5), c = k % 5;
          b.position.set(-56 + c * 28 + (row % 2) * 12, 74 + row * 22, -20 + row * 10);
          b.scale.set(1, 0.75, 1);
          piles.push(b);
        }
        grp.rotation.y = t ? -Math.PI / 2 : Math.PI / 2;
        grp.visible = false;
        o.pantry.push({ grp, piles });
      }

      // --- food pools (3D primitives, one pool per type) ---
      o.pool = TYPES.map((_, k) => [...Array([7, 7, 8, 5, 6, 6, 6, 1, 1][k])].map(() => makeFood(K, k)));
      o.cloche = [...Array(12)].map(() => makeCloche(K));
      o.shadow = [...Array(MAX_ITEMS + 2)].map(() => { const b = K.blob(1, { always: true }); b.visible = false; return b; });
      o.warn = [...Array(MAX_ITEMS + 2)].map(() => { const d = K.disc(1, K.glow('#fff4d0', { opacity: 0.55 }), { r0: 0.86 }); d.visible = false; return d; });
      o.steam = [...Array(8)].map(() => K.ball(1, K.glow('#ffffff', { opacity: 0.35 }), { cast: false }));
      o.dogs = [...Array(4)].map((_, k) => makeDog(K, k));
      o.mice = [...Array(4)].map(() => makeFood(K, T_TOPO));
      // Players: avatar + ground decal (lunge recharge, team color) + fire breath cones.
      o.pl = [...Array(n)].map((_, i) => ({
        av: K.avatar(i),
        dec: K.decal(260),
        fire: [0, 1, 2, 3, 4].map((k) => K.ball(1, K.glow(k % 2 ? '#ffc828' : '#ff501e', { add: true }), { cast: false })),
        stars: [0, 1, 2].map(() => K.ball(5, K.glow('#ffe66b'), { cast: false })),
        lastKey: '',
      }));
      return o;
    },
    update(K, o, v, r) {
      const t = K.t;
      // Fire in the hearth.
      for (const F of o.flames) {
        const h = 50 + 34 * Math.abs(Math.sin(t * 6 + F.ph)) + 16 * Math.sin(t * 13 + F.ph * 2);
        F.f.scale.set(18, h, 18);
        K.place(F.f, F.x, F.y + Math.sin(F.ph) * 8, 18);
      }
      // The King: sits on his throne, throws when food comes from him, cheers at the specials.
      if (o.kt !== v.kt) { o.kt = v.kt; o.ktT = t; }
      const throwing = t - (o.ktT ?? -9) < 0.9;
      o.king.set(500, 2, { r: 46, h: 30, look: Math.PI / 2, anim: throwing ? 'Throw' : v.kw ? 'Cheer' : 'Sit_Chair_Idle', animKey: throwing ? v.kt : undefined, gear: false, marker: false });
      K.place(o.crown, 500, -3, 30 + 46 * 2.7 * 0.78);
      o.crown.rotation.y = t * 0.6;
      for (const G of o.guests) G.av.set(G.x, G.y, { r: 38, h: 6, look: Math.PI / 2, anim: v.fin ? 'Cheer' : 'Sit_Chair_Idle', gear: false, marker: false });
      for (const C of o.court) C.av.set(C.x, C.y, { r: 38, look: C.a, anim: (v.fin || Math.sin(t * 0.7 + C.k * 2) > 0.7) ? 'Cheer' : 'Sit_Chair_Idle', gear: false, marker: false });
      for (const J of o.jesters) {
        J.av.set(J.x, J.y, { r: 40, look: -Math.PI / 2, anim: J.k ? 'Cheer' : 'Interact', gear: false, marker: false });
        J.balls.forEach((b, k) => {
          const ph = t * 3.2 + (k * TAU) / 3;
          K.place(b, J.x + Math.cos(ph) * 26, J.y - 10, 120 + Math.abs(Math.sin(ph)) * 70);
        });
      }
      // Pantries (team game only): the pile grows with the team score.
      const teams = v.p[0] && v.p[0].tm >= 0;
      if (teams) {
        const tot = [0, 0];
        for (const p of v.p) tot[p.tm] += p.pt;
        o.pantry.forEach((P, k) => { P.grp.visible = true; const c = Math.min(P.piles.length, Math.ceil(tot[k] / 5)); P.piles.forEach((b, j) => { b.visible = j < c; }); });
      }
      // Food.
      const used = TYPES.map(() => 0);
      let cl = 0, sh = 0, st = 0;
      for (const it of v.it) {
        const k = it.k;
        const u = 1 - it.f;
        let x = it.x, y = it.y, h = 0;
        if (it.f > 0) {
          x = it.ox + (it.x - it.ox) * u; y = it.oy + (it.y - it.oy) * u;
          h = it.oh * (1 - u) + 4 * 260 * u * (1 - u);
        }
        const blink = it.bl && Math.floor(t * 10) % 2;
        // Landing shadow + warning ring.
        if (sh < o.shadow.length) {
          const rr = (k >= 0 ? INFO[k].r : 30);
          const S = o.shadow[sh], R = o.warn[sh];
          sh++;
          S.visible = it.f > 0;
          R.visible = it.f > 0;
          if (it.f > 0) {
            K.place(S, it.x, it.y, 0.9); S.scale.set(rr * (0.5 + u * 0.7), 1, rr * (0.5 + u * 0.7)); S.material.opacity = 0.3 + 0.5 * u;
            K.place(R, it.x, it.y, 1.1); R.scale.setScalar(rr + 10 + (1 - u) * 30);
          }
        }
        let obj = null;
        if (k < 0) { obj = o.cloche[cl++]; }
        else { const pool = o.pool[k]; obj = pool[used[k]++]; }
        if (!obj) continue;
        obj.visible = !blink;
        if (blink) continue;
        K.place(obj, x, y, h);
        // Bites shrink the food (the boar keeps its size until the end).
        const full = k >= 0 ? INFO[k].bites : 1;
        let sc = k >= 0 && full > 1 && k !== T_BOAR ? 0.55 + 0.45 * (it.b / full) : 1;
        if (k === T_BOAR) sc = 0.7 + 0.3 * (it.b / full);
        if (k === T_PIE && it.pp > 0 && it.pp < 0.5) sc = 1 + Math.sin(t * 40) * 0.08 + (0.5 - it.pp) * 0.5;
        obj.scale.setScalar(sc * (k >= T_BOAR ? 1.1 : 1.35));
        obj.rotation.set(0, it.id * 1.7 + (it.f > 0 ? t * 8 : 0), 0);
        if (it.wb) { obj.rotation.z = Math.sin(t * 30 + it.id) * 0.12; obj.position.y += Math.abs(Math.sin(t * 15 + it.id)) * 4; }
        if (k === T_TOPO) obj.rotation.y += Math.sin(t * 9 + it.id) * 0.3;
        if (k === T_PEPE) obj.rotation.y += t * 0.5;
        // Steam over the big dishes.
        if ((k === T_BOAR || k === 3 || k === T_PIE) && it.f <= 0) for (let q = 0; q < 2 && st < o.steam.length; q++, st++) {
          const ph = (t * 0.6 + q * 0.5 + it.id * 0.13) % 1;
          const S = o.steam[st];
          S.visible = true;
          K.place(S, x + Math.sin(t * 2 + q * 3) * 8, y, 40 + ph * 90);
          S.scale.setScalar(6 + ph * 14);
        }
      }
      TYPES.forEach((_, k) => { for (let j = used[k]; j < o.pool[k].length; j++) o.pool[k][j].visible = false; });
      for (let j = cl; j < o.cloche.length; j++) o.cloche[j].visible = false;
      for (let j = sh; j < o.shadow.length; j++) { o.shadow[j].visible = false; o.warn[j].visible = false; }
      for (let j = st; j < o.steam.length; j++) o.steam[j].visible = false;
      // Mice fleeing.
      o.mice.forEach((m, k) => {
        const M = v.mc[k];
        m.visible = !!M;
        if (!M) return;
        K.place(m, M.x, M.y, Math.abs(Math.sin(t * 20 + k)) * 8);
        m.rotation.set(0, -M.a + Math.PI / 2, 0);
      });
      // Dogs.
      o.dogs.forEach((D, k) => {
        const dg = v.dg[k];
        D.g.visible = !!dg;
        if (!dg) return;
        K.place(D.g, dg.x, dg.y);
        K.face(D.g, dg.a);
        const run = dg.m ? 1 : 0;
        D.legs.forEach((L, j) => { L.rotation.z = run * Math.sin(t * 22 + (j % 2 ? Math.PI : 0) + (j > 1 ? Math.PI / 2 : 0)) * 0.6; });
        D.tail.rotation.y = Math.sin(t * (run ? 20 : 6)) * 0.6;
        D.bone.visible = !!dg.c;
        D.head.position.y = 34 + (run ? Math.abs(Math.sin(t * 22)) * 3 : Math.sin(t * 2) * 1.5);
      });
      // Players.
      v.p.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const look = Math.atan2(p.fy, p.fx);
        let anim, animKey, mood = 'ok';
        if (p.st === ST_CHOKE) { anim = 'Hit_B'; mood = 'hurt'; }
        else if (p.st === ST_PANIC) { anim = 'Running_B'; mood = 'scared'; }
        else if (p.st === ST_SCARED) { anim = 'Dodge_Backward'; mood = 'scared'; animKey = p.bk; }
        else if (p.st === ST_DIZZY) { anim = 'Hit_A'; mood = 'dizzy'; }
        else if (p.st === ST_ROBBED) { anim = 'Hit_B'; mood = 'hurt'; animKey = p.ln + 100 * i; }
        else if (p.lu) { anim = 'Unarmed_Melee_Attack_Punch_A'; animKey = p.ln; mood = 'angry'; }
        else if (p.ch) { anim = 'Interact'; animKey = p.bk; mood = 'happy'; }
        else if (p.fi) { anim = 'Spellcast_Shoot'; mood = 'angry'; }
        if (r.ended) {
          let best = -1;
          for (const q of v.hud.p) best = Math.max(best, q);
          const win = v.hud.p[i] === best;
          mood = win ? 'happy' : 'dizzy'; anim = win ? 'Cheer' : 'Sit_Floor_Idle';
        }
        const be = p.be;
        P.av.set(p.x, p.y, { r: p.r * 0.95, look, mood, anim, animKey, walk: clamp(p.sp / 360, 0, 1), squash: -0.05 + be * 0.28, lean: p.lu ? 0.25 : 0, gear: false, alpha: p.im && Math.floor(K.t * 12) % 2 ? 0.55 : 1 });
        // Dragon breath flames.
        P.fire.forEach((f, k) => {
          f.visible = !!p.fi;
          if (!p.fi) return;
          const ph = (t * 3 + k / 5) % 1;
          K.place(f, p.x + p.fx * (p.r + ph * 220), p.y + p.fy * (p.r + ph * 220), 60 + Math.sin(t * 20 + k) * 8);
          f.scale.setScalar(12 + ph * 40);
        });
        // Dizzy stars.
        P.stars.forEach((s, k) => {
          s.visible = p.st === ST_DIZZY || p.st === ST_CHOKE;
          if (!s.visible) return;
          const a = t * 6 + (k * TAU) / 3;
          K.place(s, p.x + Math.cos(a) * p.r * 0.7, p.y + Math.sin(a) * p.r * 0.7, p.r * 2.9);
        });
        // Ground decal: belly gauge + lunge recharge + facing arrow (repainted only when it changes).
        const tm = p.tm;
        const key = `${Math.round(p.be * 12)}|${Math.round(p.cd * 10)}|${Math.round(look * 8)}|${tm}|${Math.round(p.r)}`;
        P.dec.show(!r.ended).at(p.x, p.y, 1.4);
        if (key !== P.lastKey) {
          P.lastKey = key;
          P.dec.paint((d) => {
            const col = tm >= 0 ? TEAM_COL[tm] : K.col(i, 'light');
            const rr = p.r + 12;
            if (p.cd <= 0) d.ring(0, 0, rr, col + 'dd', 6);
            else d.arc(0, 0, rr, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / LUNGE_CD), col + '88', 6);
            // Belly gauge (yellow arc around the outside).
            if (p.be > 0.02) d.arc(0, 0, rr + 10, Math.PI / 2 - Math.PI * p.be, Math.PI / 2 + Math.PI * p.be, 'rgba(255,211,107,0.9)', 5);
            const ax = p.fx * (rr + 14), ay = p.fy * (rr + 14);
            d.poly([ax + p.fx * 16, ay + p.fy * 16, ax - p.fy * 11, ay + p.fx * 11, ax + p.fy * 11, ay - p.fx * 11], col + 'ee', 'rgba(0,0,0,0.35)', 2);
          });
        }
      });
    },
  },

  render(d, v, r) {
    drawFloor2D(d);
    drawCarpet(d);
    // Dogs and mice.
    for (const dg of v.dg) { d.shadow(dg.x, dg.y + 10, 22, 8, 0.3); d.emoji('🐕', dg.x, dg.y, 50); if (dg.c) d.emoji('🦴', dg.x + 18, dg.y - 6, 22); }
    for (const m of v.mc) d.emoji('🐭', m.x, m.y, 32);
    // Food.
    for (const it of v.it) {
      if (it.bl && Math.floor(d.t * 10) % 2) continue;
      const rr = it.k >= 0 ? INFO[it.k].r : 30;
      if (it.f > 0) {
        const u = 1 - it.f;
        d.circle(it.x, it.y, rr * (0.5 + u * 0.6), `rgba(0,0,0,${(0.15 + 0.3 * u).toFixed(2)})`);
        d.ring(it.x, it.y, rr + 10 + it.f * 30, 'rgba(255,244,208,0.6)', 3);
        const x = it.ox + (it.x - it.ox) * u, y = it.oy + (it.y - it.oy) * u - (it.oh * (1 - u) + 4 * 200 * u * (1 - u)) * 0.6;
        d.emoji(it.k >= 0 ? INFO[it.k].emo : '🛎️', x, y, rr * 2);
        continue;
      }
      d.shadow(it.x, it.y + rr * 0.5, rr, rr * 0.4, 0.3);
      const wob = it.wb ? Math.sin(d.t * 30 + it.id) * 4 : 0;
      if (it.k < 0) { d.circle(it.x + wob, it.y, 30, '#d7dbe2', '#8a8f9a', 3); d.circle(it.x + wob, it.y - 26, 6, '#d7dbe2'); }
      else {
        const full = INFO[it.k].bites || 1;
        const sc = it.k === T_BOAR ? 0.7 + 0.3 * (it.b / full) : full > 1 ? 0.55 + 0.45 * (it.b / full) : 1;
        d.emoji(INFO[it.k].emo, it.x, it.y, rr * 2 * sc);
      }
    }
    // Players.
    v.p.forEach((p, i) => {
      d.shadow(p.x + 6, p.y + 12, p.r, p.r * 0.75, 0.3);
      const tc = p.tm >= 0 ? TEAM_COL[p.tm] : d.col(i, 'light');
      if (p.cd <= 0) d.ring(p.x, p.y, p.r + 8, tc + 'aa', 4);
      else d.arc(p.x, p.y, p.r + 8, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / LUNGE_CD), tc + '77', 4);
      if (p.fi) for (let k = 0; k < 5; k++) { const ph = (d.t * 3 + k / 5) % 1; d.circle(p.x + p.fx * (p.r + ph * 220), p.y + p.fy * (p.r + ph * 220), 12 + ph * 30, 'rgba(255,110,40,0.5)'); }
      let mood = 'ok';
      if (p.st === ST_CHOKE || p.st === ST_ROBBED) mood = 'hurt';
      else if (p.st === ST_PANIC || p.st === ST_SCARED) mood = 'scared';
      else if (p.st === ST_DIZZY) mood = 'dizzy';
      else if (p.ch) mood = 'happy';
      else if (p.lu) mood = 'angry';
      d.avatar(p.x, p.y, p.r, i, { look: Math.atan2(p.fy, p.fx), mood, squash: p.be * 0.25, alpha: p.im && Math.floor(d.t * 12) % 2 ? 0.55 : 1 });
    });
  },
};

// ---------------------------------------------------------------- drawing helpers
function drawFloor2D(d) {
  d.rect(-400, -400, W + 800, H + 800, '#6d6152');
  for (let y = -400; y < H + 400; y += 90) for (let x = -400 + ((y / 90) % 2) * 45; x < W + 400; x += 90) d.rect(x + 2, y + 2, 86, 86, '#7b6e5d');
  d.rect(-400, -400, W + 800, 360, '#3b2e24');
}

// Royal carpet: deep red with a gold border, fleurs-de-lis and worn spots (play area = inner rectangle).
function drawCarpet(d) {
  const x0 = AX0 - 24, y0 = AY0 - 24, w = AX1 - AX0 + 48, h = AY1 - AY0 + 48;
  d.rect(x0 - 14, y0 - 14, w + 28, h + 28, '#4a2a12');
  d.rect(x0, y0, w, h, '#a3172b');
  d.rect(x0 + 10, y0 + 10, w - 20, h - 20, null, '#f0c24a', 8);
  d.rect(x0 + 30, y0 + 30, w - 60, h - 60, null, '#f0c24a', 3);
  d.rect(x0 + 44, y0 + 44, w - 88, h - 88, '#8e1224');
  // Diamond lattice.
  const { ctx } = d;
  ctx.save();
  ctx.beginPath(); ctx.rect(x0 + 44, y0 + 44, w - 88, h - 88); ctx.clip();
  for (let k = -12; k < 24; k++) {
    d.line(x0 + k * 90, y0, x0 + k * 90 + h, y0 + h, 'rgba(240,194,74,0.18)', 3);
    d.line(x0 + k * 90 + h, y0, x0 + k * 90, y0 + h, 'rgba(240,194,74,0.18)', 3);
  }
  ctx.restore();
  // Central medallion: the King's crown.
  d.circle(CX, CY, 130, 'rgba(240,194,74,0.18)', '#f0c24a', 5);
  d.circle(CX, CY, 100, null, 'rgba(240,194,74,0.6)', 2);
  d.poly([CX - 60, CY + 30, CX - 70, CY - 30, CX - 35, CY, CX, CY - 45, CX + 35, CY, CX + 70, CY - 30, CX + 60, CY + 30], 'rgba(240,194,74,0.55)');
  // Fringes on the short sides.
  for (let x = x0; x <= x0 + w; x += 16) { d.line(x, y0 - 14, x, y0 - 30, '#f0c24a', 3); d.line(x, y0 + h + 14, x, y0 + h + 30, '#f0c24a', 3); }
  // Gravy stains and crumbs (deterministic).
  let seed = 777;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let k = 0; k < 26; k++) d.circle(AX0 + rnd() * (AX1 - AX0), AY0 + rnd() * (AY1 - AY0), 6 + rnd() * 18, 'rgba(70,20,10,0.25)');
}

// Stained-glass window: an arch of colored panes with lead lines and the royal crown.
function drawWindow(d) {
  const { ctx } = d;
  ctx.save();
  ctx.beginPath(); ctx.moveTo(18, 384); ctx.lineTo(18, 128); ctx.arc(128, 128, 110, Math.PI, 0); ctx.lineTo(238, 384); ctx.closePath(); ctx.clip();
  const cols = ['#3a5fd9', '#d93a4a', '#f0c24a', '#3aa85a', '#8a3ad9', '#5ac8f0'];
  let k = 0;
  for (let y = 0; y < 384; y += 48) for (let x = 0; x < 256; x += 48) d.rect(x, y, 48, 48, cols[(k++ * 7 + (y / 48)) % cols.length] + 'dd');
  for (let x = 0; x <= 256; x += 48) d.line(x, 0, x, 384, '#2a1a10', 5);
  for (let y = 0; y <= 384; y += 48) d.line(0, y, 256, y, '#2a1a10', 5);
  d.circle(128, 150, 62, '#ffe9a8', '#2a1a10', 8);
  d.poly([88, 175, 80, 125, 106, 150, 128, 110, 150, 150, 176, 125, 168, 175], '#e2b13c', '#2a1a10', 4);
  ctx.restore();
  ctx.beginPath(); ctx.moveTo(18, 384); ctx.lineTo(18, 128); ctx.arc(128, 128, 110, Math.PI, 0); ctx.lineTo(238, 384);
  ctx.strokeStyle = '#6d6152'; ctx.lineWidth = 16; ctx.stroke();
}

// ---------------------------------------------------------------- 3D food (primitives, local coords: x, height, y)
function makeFood(K, k) {
  const g = K.group();
  const M = (c, o) => K.mat(c, o);
  const at = (m, x, h, y) => { m.position.set(x, h, y); return m; };
  if (k === 0) { // grapes
    for (let j = 0; j < 4; j++) { const a = j * 2.1, rr = j ? 9 : 0; at(K.ball(9, M('#7b2fa0', { rough: 0.25 }), { parent: g, cast: false }), Math.cos(a) * rr, 8 + (j % 3) * 5, Math.sin(a) * rr); }
    at(K.cyl(1.5, 10, M('#4a7a2a'), { parent: g }), 0, 20, 0);
    at(K.ball(6, M('#5fa83a', { flat: true }), { parent: g }), 4, 26, 0).scale.set(1.4, 0.4, 1);
  } else if (k === 1) { // loaf
    at(K.ball(1, M('#d9a35b', { rough: 0.8 }), { parent: g }), 0, 14, 0).scale.set(28, 16, 20);
    for (const dx of [-10, 2, 14]) at(K.box(3, 14, 2, M('#f3dcae'), { parent: g }), dx, 28, 0);
  } else if (k === 2) { // roast leg
    const meat = at(K.ball(1, M('#b5622a', { rough: 0.5 }), { parent: g }), -6, 16, 0); meat.scale.set(20, 15, 15);
    const bone = at(K.cyl(4, 26, M('#f4efe0'), { parent: g, center: true }), 18, 16, 0); bone.rotation.z = Math.PI / 2;
    at(K.ball(5, M('#f4efe0'), { parent: g }), 31, 19, 3); at(K.ball(5, M('#f4efe0'), { parent: g }), 31, 13, -3);
  } else if (k === 3) { // pie
    at(K.cyl(34, 20, M('#e0a64a', { rough: 0.6 }), { parent: g }), 0, 0, 0);
    at(K.cyl(35, 6, M('#fff4e0', { rough: 0.4 }), { parent: g }), 0, 20, 0);
    for (let j = 0; j < 3; j++) { const a = (j / 3) * TAU; at(K.ball(6, M('#ff2a4a', { rough: 0.2 }), { parent: g }), Math.cos(a) * 22, 28, Math.sin(a) * 22); }
    at(K.ball(8, M('#ff2a4a', { rough: 0.2 }), { parent: g }), 0, 30, 0);
  } else if (k === 4) { // bone
    const b = at(K.cyl(5, 40, M('#f6f2e4', { rough: 0.6 }), { parent: g, center: true }), 0, 8, 0); b.rotation.z = Math.PI / 2;
    for (const [x, y] of [[-21, 5], [-21, -5], [21, 5], [21, -5]]) at(K.ball(7, M('#f6f2e4', { rough: 0.6 }), { parent: g }), x, 8, y);
  } else if (k === 5) { // dragon chili
    const c = at(K.cone(10, 40, M('#e8221a', { rough: 0.25, emissive: '#ff2a00', ei: 0.35 }), { parent: g }), 0, 10, 0); c.rotation.z = -Math.PI / 2 + 0.25;
    at(K.cyl(4, 10, M('#3f8a2a'), { parent: g, center: true }), -22, 12, 0).rotation.z = Math.PI / 2;
    at(K.ball(6, M('#4ea83a', { flat: true }), { parent: g }), -18, 13, 0).scale.set(1, 0.5, 1.4);
  } else if (k === 6) { // mouse
    at(K.ball(1, M('#8f8f9c', { rough: 0.8 }), { parent: g }), 0, 11, 0).scale.set(16, 11, 11);
    at(K.ball(1, M('#8f8f9c', { rough: 0.8 }), { parent: g }), 0, 14, 14).scale.set(8, 8, 9);
    for (const s of [-1, 1]) { at(K.ball(6, M('#ffb0c0'), { parent: g }), s * 7, 22, 12).scale.set(1, 1, 0.3); at(K.ball(1.8, M('#111'), { parent: g, cast: false }), s * 4, 17, 21); }
    at(K.cyl(1.5, 26, M('#ffb0c0'), { parent: g, center: true }), 0, 6, -24).rotation.x = Math.PI / 2;
  } else if (k === T_BOAR) { // roast boar on a silver platter
    at(K.cyl(78, 6, M('#d7dbe2', { rough: 0.2, metal: 0.8 }), { parent: g }), 0, 0, 0);
    at(K.ball(1, M('#9a5a2a', { rough: 0.45 }), { parent: g }), 0, 34, 0).scale.set(58, 34, 38);
    at(K.ball(1, M('#8a4e24', { rough: 0.45 }), { parent: g }), 56, 40, 0).scale.set(26, 24, 24);
    at(K.ball(1, M('#c87a5a'), { parent: g }), 78, 38, 0).scale.set(9, 10, 12);
    for (const s of [-1, 1]) { const t = at(K.cone(4, 16, M('#fffbe8'), { parent: g }), 74, 30, s * 9); t.rotation.z = -0.8; at(K.cone(7, 14, M('#6a3a1a'), { parent: g }), 52, 60, s * 14).rotation.x = s * 0.4; }
    at(K.ball(11, M('#e8221a', { rough: 0.25 }), { parent: g }), 86, 38, 0);
    for (const [x, y] of [[-20, 42], [10, -42]]) at(K.ball(9, M('#4ea83a', { flat: true }), { parent: g }), x, 8, y);
  } else if (k === T_PIE) { // the King's pie
    at(K.cyl(46, 30, M('#d8902f', { rough: 0.6 }), { parent: g }), 0, 0, 0);
    at(K.cyl(44, 8, M('#f0b85a', { rough: 0.6 }), { parent: g, r2: 40 }), 0, 30, 0);
    for (let j = -2; j <= 2; j++) { at(K.box(6, 84, 4, M('#b8701f'), { parent: g }), j * 16, 39, 0); at(K.box(84, 6, 4, M('#b8701f'), { parent: g }), 0, 40, j * 16); }
    at(K.ball(9, M('#ffd36b', { metal: 0.6, rough: 0.3 }), { parent: g }), 0, 46, 0);
  }
  g.traverse((m) => { m.castShadow = false; });
  g.visible = false;
  return g;
}

function makeCloche(K) {
  const g = K.group();
  const silver = K.mat('#f2f4f8', { rough: 0.28, metal: 0.45, emissive: '#3a3f4a', ei: 0.5 });
  K.cyl(40, 4, silver, { parent: g });
  const dome = K.ball(34, silver, { parent: g });
  dome.position.set(0, 4, 0); dome.scale.set(1, 0.85, 1);
  K.ball(7, K.mat('#e2b13c', { rough: 0.3, metal: 0.7 }), { parent: g }).position.set(0, 36, 0);
  g.visible = false;
  return g;
}

function makeDog(K, k) {
  const g = K.group();
  const fur = K.mat(['#8a5a2e', '#d8c8a8', '#4a3a2e', '#b07a3e'][k % 4], { rough: 0.85 });
  const dark = K.mat('#2a1a10', { rough: 0.8 });
  const body = K.ball(1, fur, { parent: g }); body.position.set(0, 26, 0); body.scale.set(30, 15, 14);
  const head = K.group(g); head.position.set(28, 34, 0);
  K.ball(12, fur, { parent: head });
  const snout = K.ball(1, fur, { parent: head }); snout.position.set(12, -3, 0); snout.scale.set(9, 6, 6);
  K.ball(3, dark, { parent: head }).position.set(20, -2, 0);
  for (const s of [-1, 1]) { const e = K.ball(1, dark, { parent: head }); e.position.set(-2, 6, s * 10); e.scale.set(5, 9, 2); }
  const legs = [];
  for (const [x, z] of [[18, 8], [18, -8], [-18, 8], [-18, -8]]) {
    const L = K.group(g); L.position.set(x, 20, z);
    const leg = K.cyl(4, 20, fur, { parent: L, center: true }); leg.position.y = -10;
    legs.push(L);
  }
  const tail = K.group(g); tail.position.set(-28, 30, 0);
  const tl = K.cyl(3, 18, fur, { parent: tail, center: true }); tl.position.set(-6, 6, 0); tl.rotation.z = 0.9;
  const bone = K.group(head);
  const bb = K.cyl(3, 22, K.mat('#f6f2e4'), { parent: bone, center: true }); bb.rotation.x = Math.PI / 2;
  bone.position.set(18, -6, 0);
  g.visible = false;
  return { g, legs, tail, head, bone };
}
