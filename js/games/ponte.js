// Il Ponte sul Fossato — top-down building race over a castle moat.
// dir = move, A = context action (take a plank from the pile / lay it at your bridge tip / hammer it /
// steal a loose plank or pry a nailed one off an enemy bridge), B = shoulder charge (knock rivals into the moat).
// Free-for-all: one bridge each (lanes left → right by seat). Teams (2 vs 2): one bridge per team, team 0 on the left.
// The first side whose bridge reaches the castle bank wins.
import { clamp, damp, dist, norm, collideCircles, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000;
const DURATION = 50;
const MOAT_N = 330, MOAT_S = 640, MOAT_W = MOAT_S - MOAT_N;
const BW = 100;
const P_R = 34, ACC = 2200, VMAX = 380, KEEP = 0.06, CARRY_K = 0.8;
const DASH_V = 880, DASH_T = 0.18, DASH_CD = 1.1, KNOCK_V = 680, KNOCK_T = 0.42, STUN_T = 0.55;
const SWIM_T = 2.0, NAILS = 4, PRY = 7, REACH_TIP = 85, REACH_PILE = 95, REACH_DROP = 62;
const PILE_Y = 900;
const NEED_FFA = 7, NEED_TEAM = 12;
const LANES = { 1: [500], 2: [300, 700], 3: [200, 500, 800], 4: [140, 380, 620, 860] };
const PILES = { 1: [500], 2: [500], 3: [350, 650], 4: [260, 500, 740] };
const TEAM_COL = ['#ff4b5c', '#3fa9ff'];
const FLAG = ['red', 'blue', 'green', 'yellow'];
const BANNER = ['red', 'blue', 'green', 'yellow'];

const tipY = (s, b) => MOAT_S - b.nailed * s.PL;

function onBridge(s, x, y) {
  for (const b of s.br) if (Math.abs(x - b.x) <= BW / 2 && y <= MOAT_S + 1 && y >= tipY(s, b) - 1) return b;
  return null;
}
function walkable(s, x, y) {
  if (x < 25 || x > W - 25 || y > H - 25) return false;
  if (y >= MOAT_S) return true;
  return !!onBridge(s, x, y);
}

// Nearest bridge tip to a point: { b, d }.
function nearestTip(s, x, y) {
  let best = null, bd = Infinity;
  for (const b of s.br) {
    const d = dist(x, y, b.x, tipY(s, b));
    if (d < bd) { bd = d; best = b; }
  }
  return { b: best, d: bd };
}

function spawnPos(s, p) {
  const mates = s.p.filter((q) => q.side === p.side);
  const m = mates.indexOf(p), c = mates.length;
  return { x: s.br[p.side].x + (m - (c - 1) / 2) * 90, y: 820 };
}

function dropPlank(s, p, g) {
  if (!p.carry) return;
  if (walkable(s, p.x, p.y) && s.dp.length < 8) s.dp.push({ id: ++s.uid, x: p.x, y: p.y, v: p.carry, t: 12 });
  else { g.sfx('splash', { vol: 0.5, pitch: 1.4 }); g.burst(p.x, p.y, { color: '#8fd3ff', n: 10, speed: 200 }); }
  p.carry = 0;
}

function fallIn(s, p, g) {
  p.swim = SWIM_T; p.bit = 0; p.kn = 0; p.dash = 0; p.vx *= 0.2; p.vy *= 0.2;
  if (p.carry) { p.carry = 0; g.text(p.x, p.y - 90, 'ASSE PERSA!', { color: '#cfe8ff', size: 32 }); }
  g.sfx('splash'); g.sfx('fall', { vol: 0.5 });
  g.burst(p.x, p.y, { color: '#9fdcff', n: 26, speed: 340, size: 9 });
  g.text(p.x, p.y - 60, 'SPLASH!', { color: '#bfe9ff', size: 48 });
  g.vibrate(p.i, 160); g.shake(0.25);
  // A crocodile right there takes a bite.
  for (const c of s.cr) if (dist(c.x, c.y, p.x, p.y) < 130) { p.swim += 1.2; p.bit = 1; g.text(p.x, p.y - 110, 'GNAM!', { color: '#7dff6a', size: 52 }); g.sfx('squish'); break; }
}

function nailDone(s, b, p, g) {
  b.nailed = Math.min(s.need, b.nailed + b.loose);
  b.loose = 0; b.nails = 0;
  const y = tipY(s, b);
  g.sfx('stack'); g.sfx('coin', { vol: 0.5, pitch: 0.8 + b.nailed * 0.06 });
  g.burst(b.x, y + s.PL / 2, { color: '#e8c08a', n: 14, speed: 240 });
  g.text(b.x, y - 40, `${b.nailed}/${s.need}`, { player: p.i, size: 50 });
  if (b.nailed >= s.need && !g.ended) {
    g.sfx('fanfare'); g.confetti(b.x, MOAT_N); g.flash('#fff3c4', 0.4);
    g.slowmo(0.35, 0.9);
    g.say('PONTE FINITO!');
    g.end(p.i, 'Ponte finito!');
  } else if (b.nailed === s.need - 1) g.say('MANCA UN\'ASSE!');
}

// A = context action.
function act(s, p, g) {
  const tip = nearestTip(s, p.x, p.y);
  if (p.carry) {
    if (tip.b && tip.b.k === p.side && tip.d < REACH_TIP && !tip.b.loose) {
      tip.b.loose = p.carry; tip.b.nails = 0; p.carry = 0; p.hk++; p.hm = 0.25;
      g.sfx('slide', { pitch: 0.8 }); g.text(tip.b.x, tipY(s, tip.b) - 30, 'ORA MARTELLA!', { player: p.i, size: 30 });
      return;
    }
    // Put it down only at your own tip (to hammer the plank already there); elsewhere A does nothing.
    if (tip.b && tip.b.k === p.side && tip.d < REACH_TIP) { dropPlank(s, p, g); g.sfx('slide', { vol: 0.6, pitch: 1.2 }); }
    return;
  }
  if (tip.b && tip.d < REACH_TIP) {
    const b = tip.b;
    if (b.k === p.side) {
      if (!b.loose) return;
      b.nails++; p.hk++; p.hm = 0.22;
      g.sfx('hit', { pitch: 0.85 + b.nails * 0.12, vol: 0.8 });
      g.burst(b.x, tipY(s, b) - s.PL / 2, { color: '#fff2c0', n: 5, speed: 160, size: 5 });
      if (b.nails >= NAILS) nailDone(s, b, p, g);
      return;
    }
    if (b.loose) {
      p.carry = b.loose; b.loose = 0; b.nails = 0; p.hk++; p.hm = 0.25; s.steals++;
      g.sfx('swap'); g.text(b.x, tipY(s, b) - 40, 'RUBATA!', { player: p.i, size: 46 });
      g.vibrate(p.i, 60);
      return;
    }
    if (b.nailed > 0) {
      b.pry++; b.prT = 0; p.hk++; p.hm = 0.22;
      g.sfx('wobble', { pitch: 0.7 + b.pry * 0.08, vol: 0.6 });
      if (b.pry >= PRY) {
        b.nailed--; b.loose = 1; b.pry = 0; b.nails = 0;
        g.sfx('break'); g.text(b.x, tipY(s, b) - 40, 'SCHIODATA!', { player: p.i, size: 46 });
        g.burst(b.x, tipY(s, b), { color: '#c99a66', n: 16, speed: 260 });
        g.shake(0.2);
      }
      return;
    }
  }
  // Pick up a plank lying on the ground (or the golden one).
  if (s.gold && dist(p.x, p.y, s.gold.x, s.gold.y) < REACH_DROP + 10) {
    p.carry = 2; s.gold = null; p.hm = 0.2;
    g.sfx('powerup'); g.text(p.x, p.y - 80, 'ASSE D\'ORO!', { color: '#ffd84a', size: 44 });
    return;
  }
  let dp = null, dd = REACH_DROP;
  for (const q of s.dp) { const d = dist(p.x, p.y, q.x, q.y); if (d < dd) { dd = d; dp = q; } }
  if (dp) { p.carry = dp.v; s.dp = s.dp.filter((q) => q !== dp); g.sfx('pickup'); return; }
  for (const x of s.piles) {
    if (dist(p.x, p.y, x, PILE_Y) < REACH_PILE) { p.carry = 1; p.hm = 0.2; g.sfx('pickup', { pitch: 0.9 }); return; }
  }
}

function snap(s, c, g) {
  const hx = c.x + Math.cos(c.a) * 55, hy = c.y + Math.sin(c.a) * 55;
  g.sfx('squish'); g.sfx('bonk', { pitch: 0.5 });
  g.burst(hx, hy, { color: '#bfe9ff', n: 16, speed: 260 });
  let bit = false;
  for (const p of s.p) {
    if (dist(p.x, p.y, hx, hy) > 95) continue;
    bit = true;
    if (p.swim > 0) { p.swim += 1; continue; }
    if (p.carry) { p.carry = 0; g.text(p.x, p.y - 110, "SE L'È MANGIATA!", { color: '#7dff6a', size: 30 }); }
    p.kn = 0.3; p.st = 0.9; p.vx = 0; p.vy = 520; p.dash = 0;
    g.vibrate(p.i, 150);
  }
  if (g.variant === 'coccodrilli') {
    for (const b of s.br) if (b.loose && dist(b.x, tipY(s, b) - s.PL / 2, hx, hy) < 95) { b.loose = 0; b.nails = 0; bit = true; g.text(b.x, tipY(s, b) - 60, 'ASSE DIVORATA!', { color: '#7dff6a', size: 34 }); }
  }
  if (bit) { g.text(hx, hy - 60, 'GNAM!', { color: '#7dff6a', size: 58 }); g.shake(0.3); }
}

// ---------------------------------------------------------------- computer player
const BOT_DELAY = [0.34, 0.2, 0.09];

function go(p, gx, gy, s) {
  // Leave or reach a bridge through its foot (never cut across the water).
  const on = onBridge(s, p.x, p.y);
  const tgB = gy < MOAT_S - 2 ? onBridge(s, gx, gy) || null : null;
  if (on && p.y < MOAT_S - 4 && (!tgB || tgB !== on)) { gx = on.x; gy = MOAT_S + 50; }
  else if (!on && tgB && Math.abs(p.x - tgB.x) > 18) { gx = tgB.x; gy = Math.max(gy, MOAT_S + 30); }
  const dx = gx - p.x, dy = gy - p.y, d = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, d / 70);
  return { x: (dx / d) * k, y: (dy / d) * k };
}

function ponteBot(s, me, g, B) {
  const p = s.p[me];
  if (!p || p.swim > 0 || p.st > 0) return { x: 0, y: 0 };
  const lv = B.level, m = B.mem, delay = BOT_DELAY[lv];
  const my = s.br[p.side];
  const myTip = tipY(s, my);
  // Crocodile lunging at the tip I'm standing next to: step back (not the easy squire).
  if (lv > 0) {
    for (const c of s.cr) {
      if (c.st !== 'lunge') continue;
      const hx = c.x + Math.cos(c.a) * 55, hy = c.y + Math.sin(c.a) * 55;
      if (dist(p.x, p.y, hx, hy) < 135) return { x: 0, y: 1 };
    }
  }
  // Gust coming and I'm on a bridge with a plank (a sail!): back to the bank.
  if (lv > 0 && s.wind && (s.wind.w > 0 || s.wind.t > 0) && p.y < MOAT_S - 5 && (p.carry || lv === 2)) {
    const st = go(p, p.x, MOAT_S + 60, s);
    return { x: st.x - s.wind.d * 0.3, y: st.y };
  }
  const tap = (want, ready = true) => { if (ready && B.rng() < (lv === 0 ? 0.35 : 0.8)) want.tapA = true; return want; };
  const mates = s.p.filter((q) => q !== p && q.side === p.side);
  // Shoulder charge: an enemy near the water (or carrying a plank) within reach.
  if (lv > 0 && !p.carry && p.dcd <= 0) {
    for (const q of s.p) {
      if (q === p || q.side === p.side || q.swim > 0 || q.st > 0) continue;
      const d = dist(p.x, p.y, q.x, q.y);
      if (d > (lv === 2 ? 150 : 115)) continue;
      const n = norm(q.x - p.x, q.y - p.y);
      const qOn = onBridge(s, q.x, q.y) && q.y < MOAT_S - 8;
      // Does the charge send them into the water? (sideways off a bridge, or north off the bank)
      const wet = (qOn && Math.abs(n.x) > 0.5) || (!qOn && q.y < MOAT_S + 70 && n.y < -0.5 && !onBridge(s, q.x, q.y - 60));
      const worth = wet || (q.carry && lv === 2) || (q.carry && B.rng() < 0.3);
      if (worth && (lv === 2 || B.rng() < 0.25)) return { x: n.x, y: n.y, tapB: true };
    }
  } else if (lv === 0 && !p.carry && p.dcd <= 0) {
    for (const q of s.p) if (q.side !== p.side && q.swim <= 0 && dist(p.x, p.y, q.x, q.y) < 90 && B.rng() < 0.02) { const n = norm(q.x - p.x, q.y - p.y); return { x: n.x, y: n.y, tapB: true }; }
  }
  // 1) Carrying: lay it at my tip (wait there if a plank still needs nailing; drop it to hammer if alone too long).
  if (p.carry) {
    const d = dist(p.x, p.y, my.x, myTip);
    const st = go(p, my.x, myTip + 40, s);
    if (d < REACH_TIP - 12) {
      if (!my.loose) return tap({ x: 0, y: 0 });
      m.wait = (m.wait || 0) + g.dt;
      const helper = mates.some((q) => !q.carry && q.swim <= 0 && dist(q.x, q.y, my.x, myTip) < 220);
      if (m.wait > (helper ? 2.5 : 0.4)) { m.wait = 0; return tap({ x: 0, y: 1 }); } // put it down beside me and hammer
      return { x: 0, y: 0 };
    }
    m.wait = 0;
    return st;
  }
  m.wait = 0;
  // 2) My bridge has a loose plank: hammer it (the closest teammate does it, the other fetches).
  if (my.loose) {
    const dMe = dist(p.x, p.y, my.x, myTip);
    const closer = mates.some((q) => !q.carry && q.swim <= 0 && dist(q.x, q.y, my.x, myTip) < dMe - 40);
    if (!closer || dMe < REACH_TIP) {
      const st = go(p, my.x, myTip + 34, s);
      if (dMe < REACH_TIP - 6) return tap({ x: st.x * 0.5, y: st.y * 0.5 });
      return st;
    }
  }
  // 3) Sabotage (better bots): steal a loose plank or pry the leader's bridge.
  if (lv > 0) {
    let tgt = null, best = Infinity;
    for (const b of s.br) {
      if (b.k === p.side) continue;
      const ty = tipY(s, b), d = dist(p.x, p.y, b.x, ty);
      const lead = b.nailed - my.nailed;
      let sc = Infinity;
      if (b.loose && d < (lv === 2 ? 420 : 260)) sc = d - 150;
      else if (lv === 2 && b.nailed > 0 && (lead >= 2 || b.nailed >= s.need - 2) && d < 520) sc = d + 60;
      else if (lv === 1 && b.nailed >= s.need - 1 && d < 300) sc = d + 100;
      if (sc < best) { best = sc; tgt = b; }
    }
    // In a team, only one of us goes sabotaging (the higher seat), unless the enemy is about to finish.
    if (tgt && mates.length && mates[0].i > p.i && tgt.nailed < s.need - 1 && !tgt.loose) tgt = null;
    if (tgt) {
      const ty = tipY(s, tgt);
      if (dist(p.x, p.y, tgt.x, ty) < REACH_TIP - 10) return tap({ x: 0, y: 0 });
      return go(p, tgt.x, ty + 40, s);
    }
  }
  // 4) Fetch: a golden plank or a dropped one close by, else the nearest pile.
  if (s.gold && lv > 0 && dist(p.x, p.y, s.gold.x, s.gold.y) < 450) {
    if (dist(p.x, p.y, s.gold.x, s.gold.y) < REACH_DROP - 10) return tap({ x: 0, y: 0 });
    return go(p, s.gold.x, s.gold.y, s);
  }
  let tx = null, ty = PILE_Y, bd = Infinity;
  for (const x of s.piles) { const d = dist(p.x, p.y, x, PILE_Y) + Math.abs(x - my.x) * 0.5; if (d < bd) { bd = d; tx = x; } }
  for (const q of s.dp) { const d = dist(p.x, p.y, q.x, q.y) + 40; if (d < bd) { bd = d; tx = q.x; ty = q.y; } }
  const near = ty === PILE_Y ? REACH_PILE - 20 : REACH_DROP - 12;
  if (dist(p.x, p.y, tx, ty) < near) return tap({ x: 0, y: 0 });
  // Approach the pile from my bridge's side (fewer collisions with rivals).
  const off = ty === PILE_Y ? clamp(my.x - tx, -45, 45) : 0;
  return go(p, tx + off, ty - (ty === PILE_Y ? 40 : 0), s);
}

// ---------------------------------------------------------------- definition
export default {
  id: 'ponte',
  name: 'Il Ponte sul Fossato',
  rule: 'Porta le assi e finisci per primo il tuo ponte!',
  verb: 'MARTELLA!',
  inspired: 'Overcooked · Mario Party (Bridge Work)',
  cam: 'top',
  split: false,
  players: 4,
  teams: true,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Asse', b: 'Spallata' },
  duration: DURATION,
  variants: [
    { id: 'coccodrilli', name: 'Coccodrilli Affamati', desc: 'Il doppio dei coccodrilli, più veloci: azzannano chi sta in punta e si mangiano le assi non inchiodate!' },
    { id: 'vento', name: 'Bufera sul Fossato', desc: 'Raffiche di vento spingono tutti di lato: chi porta un\'asse fa da vela!' },
    { id: 'oro', name: "Assi d'Oro", desc: "Ogni tanto spunta un'asse d'oro che vale DUE assi: corri a prenderla!" },
  ],
  help: {
    goal: 'Costruisci il tuo ponte fino al castello prima degli altri (a squadre: un ponte per squadra). Allo scadere vince il ponte più lungo.',
    dir: 'Muoviti nel cantiere e sul tuo ponte (da solo non cadi in acqua: ti ci devono buttare!).',
    a: "ASSE: al mucchio prendi un'asse, in punta al tuo ponte la posi, poi premi ancora per MARTELLARLA (4 colpi). In punta a un ponte nemico RUBI l'asse sciolta o SCHIODI l'ultima (7 colpi)!",
    b: "SPALLATA: butti gli avversari in acqua (o gli fai cadere l'asse). Non funziona mentre porti un'asse.",
    tips: ['A squadre dividetevi i compiti: uno porta le assi, l\'altro martella o difende', 'I coccodrilli che si avvicinano alla punta stanno per azzannare: indietro!', "Un'asse posata ma non inchiodata si può rubare: martella in fretta!"],
  },

  init(g) {
    const n = g.n || 2;
    const teams = !!g.teams;
    const S = teams ? 2 : n;
    const need = teams ? NEED_TEAM : NEED_FFA;
    const s = {
      t: 0, S, teams, need, PL: MOAT_W / need, uid: 0, steals: 0,
      br: LANES[S].map((x, k) => ({ k, x, nailed: 0, loose: 0, nails: 0, pry: 0, prT: 0 })),
      piles: PILES[S].slice(),
      dp: [], gold: null, goldAt: 6,
      wind: g.variant === 'vento' ? { d: 1, w: 0, t: 0, at: 6 } : null,
      cr: [],
      p: [...Array(n).keys()].map((i) => ({
        i, side: teams ? g.team(i) : i, x: 0, y: 0, vx: 0, vy: 0, r: P_R, fx: 0, fy: -1,
        carry: 0, st: 0, kn: 0, swim: 0, bit: 0, dash: 0, dcd: 0, dhit: 0, hm: 0, hk: 0,
      })),
    };
    for (const p of s.p) { const q = spawnPos(s, p); p.x = q.x; p.y = q.y; }
    const nc = g.variant === 'coccodrilli' ? 4 : 2;
    for (let k = 0; k < nc; k++) {
      const x = 120 + ((k + 0.5) / nc) * 760;
      s.cr.push({ x, y: MOAT_N + 60 + (k % 2) * (MOAT_W - 120), a: k % 2 ? Math.PI : 0, st: 'swim', t: 0, cd: 3 + k, gx: x, gy: MOAT_N + MOAT_W / 2, tg: -1, sp: 0 });
    }
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.t = g.t;
    const fast = g.variant === 'coccodrilli';
    // ---- crocodiles
    for (const c of s.cr) {
      if (c.st === 'lunge') {
        c.t -= dt;
        if (c.t <= 0) { snap(s, c, g); c.st = 'swim'; c.cd = fast ? 1.6 : 2.8; c.tg = -1; c.gx = g.rng.range(80, 920); c.gy = g.rng.range(MOAT_N + 45, MOAT_S - 45); }
        continue;
      }
      c.cd -= dt;
      let gx = c.gx, gy = c.gy;
      if (c.tg >= 0) {
        const b = s.br[c.tg];
        gx = b.x; gy = Math.max(MOAT_N + 30, tipY(s, b) - 48);
      }
      const dx = gx - c.x, dy = gy - c.y, d = Math.hypot(dx, dy);
      const sp = fast ? 135 : 85;
      c.gt = (c.gt || 0) + dt;
      if (d > 4) {
        const ta = Math.atan2(dy, dx);
        while (c.a > Math.PI) c.a -= TAU;
        while (c.a < -Math.PI) c.a += TAU;
        let da = ta - c.a;
        while (da > Math.PI) da -= TAU;
        while (da < -Math.PI) da += TAU;
        c.a += clamp(da, -3 * dt, 3 * dt);
        const v = Math.min(sp, d * 3) * Math.max(0.2, Math.cos(da));
        c.x += Math.cos(c.a) * v * dt; c.y += Math.sin(c.a) * v * dt;
        c.sp = v;
      }
      c.y = clamp(c.y, MOAT_N + 28, MOAT_S - 28);
      c.x = clamp(c.x, 40, 960);
      if (c.tg >= 0 && c.cd <= 0 && d < 26) { c.st = 'lunge'; c.t = 0.9; c.a = Math.PI / 2; g.sfx('wobble', { pitch: 0.5, vol: 0.7 }); continue; }
      if ((d < 40 || c.gt > 5) && c.tg < 0) {
        c.gt = 0;
        // New goal: often the tip of a bridge with someone working on it.
        if (c.cd <= 0 && g.rng.chance(0.65)) {
          const busy = s.br.filter((b) => b.nailed > 0 && s.p.some((p) => !p.swim && dist(p.x, p.y, b.x, tipY(s, b)) < 120) && !s.cr.some((o) => o !== c && o.tg === b.k));
          const pool = busy.length ? busy : s.br.filter((b) => b.nailed > 0);
          if (pool.length) c.tg = g.rng.pick(pool).k;
        }
        if (c.tg < 0) { c.gx = g.rng.range(80, 920); c.gy = g.rng.range(MOAT_N + 45, MOAT_S - 45); }
      }
      // Swimmers nearby get nibbled.
      for (const p of s.p) if (p.swim > 0 && !p.bit && dist(c.x, c.y, p.x, p.y) < 70) { p.bit = 1; p.swim += 1; g.text(p.x, p.y - 80, 'GNAM!', { color: '#7dff6a', size: 46 }); g.sfx('squish'); }
    }
    if (s.cr.length > 1) for (let a = 0; a < s.cr.length; a++) for (let b = a + 1; b < s.cr.length; b++) {
      const A = s.cr[a], Bc = s.cr[b], d = dist(A.x, A.y, Bc.x, Bc.y);
      if (d < 90 && d > 0) { const n = norm(Bc.x - A.x, Bc.y - A.y), k = (90 - d) * 0.1; A.x -= n.x * k; A.y -= n.y * k; Bc.x += n.x * k; Bc.y += n.y * k; }
    }
    // ---- variants
    if (s.wind) {
      const w = s.wind;
      if (g.t >= w.at && w.w <= 0 && w.t <= 0) { w.d = g.rng.chance(0.5) ? 1 : -1; w.w = 1.3; w.at = g.t + 7.5; g.say(w.d > 0 ? 'VENTO DA SINISTRA!' : 'VENTO DA DESTRA!'); g.sfx('whoosh'); }
      if (w.w > 0) { w.w -= dt; if (w.w <= 0) { w.t = 1.4; g.sfx('whoosh', { pitch: 0.6 }); g.shake(0.2); } }
      else if (w.t > 0) w.t -= dt;
    }
    if (g.variant === 'oro' && !s.gold && g.t >= s.goldAt && !g.ended) {
      s.gold = { x: g.rng.range(90, 910), y: g.rng.range(700, 940), t: 9 };
      g.sfx('powerup', { vol: 0.6 }); g.ring(s.gold.x, s.gold.y, { color: '#ffd84a', r: 110 });
    }
    if (s.gold) { s.gold.t -= dt; if (s.gold.t <= 0) { s.gold = null; s.goldAt = g.t + 4; } else s.goldAt = g.t + 8; }
    for (const q of s.dp) q.t -= dt;
    s.dp = s.dp.filter((q) => q.t > 0);
    for (const b of s.br) { b.prT += dt; if (b.pry > 0 && b.prT > 1.2) { b.pry--; b.prT = 0; } }

    // ---- knights
    for (const p of s.p) {
      const i = inp[p.i];
      p.dcd = Math.max(0, p.dcd - dt);
      p.hm = Math.max(0, p.hm - dt);
      p.kn = Math.max(0, p.kn - dt);
      if (p.swim > 0) {
        p.swim -= dt;
        p.vx *= damp(0.2, dt); p.vy *= damp(0.2, dt);
        p.x = clamp(p.x + p.vx * dt, 40, 960); p.y = clamp(p.y + p.vy * dt, MOAT_N + 20, MOAT_S - 20);
        if (p.swim <= 0) {
          p.swim = 0;
          const q = spawnPos(s, p);
          p.x = q.x; p.y = MOAT_S + 60; p.vx = 0; p.vy = 0; p.st = 0.3;
          g.sfx('jump', { pitch: 0.8 }); g.burst(p.x, p.y, { color: '#9fdcff', n: 10, speed: 160 });
        }
        continue;
      }
      p.st = Math.max(0, p.st - dt);
      if (Math.hypot(i.x, i.y) > 0.2) { const n = norm(i.x, i.y); p.fx = n.x; p.fy = n.y; }
      if (p.dash > 0) p.dash -= dt;
      else if (p.st > 0) { const k = damp(0.03, dt); p.vx *= k; p.vy *= k; }
      else {
        p.vx += i.x * ACC * dt; p.vy += i.y * ACC * dt;
        const k = damp(KEEP, dt);
        p.vx *= k; p.vy *= k;
        const vm = VMAX * (p.carry ? CARRY_K : 1);
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > vm) { p.vx *= vm / sp; p.vy *= vm / sp; }
      }
      if (p.st <= 0 && !g.ended) {
        if (i.bP && p.dcd <= 0 && !p.carry) {
          p.dash = DASH_T; p.dcd = DASH_CD; p.dhit = 0;
          p.vx = p.fx * DASH_V; p.vy = p.fy * DASH_V;
          g.sfx('dash'); g.burst(p.x, p.y, { player: p.i, n: 8, speed: 180 });
        } else if (i.aP) act(s, p, g);
      }
      // Move: on your own you never step into the water; knocked (or blown) you can fall in.
      const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt;
      if (p.kn > 0 || walkable(s, nx, ny)) { p.x = nx; p.y = ny; }
      else if (walkable(s, nx, p.y)) { p.x = nx; p.vy = 0; }
      else if (walkable(s, p.x, ny)) { p.y = ny; p.vx = 0; }
      else { p.vx = 0; p.vy = 0; }
      if (s.wind && s.wind.t > 0) p.x += s.wind.d * (p.carry ? 260 : 130) * dt;
      p.x = clamp(p.x, 25, W - 25); p.y = Math.min(p.y, H - 25);
    }
    // ---- bumps (shoulder charges knock enemies; nobody is pushed into the water by a simple bump)
    const on = s.p.filter((p) => p.swim <= 0);
    for (let a = 0; a < on.length; a++) {
      for (let b = a + 1; b < on.length; b++) {
        const A = on[a], Bq = on[b];
        if (dist(A.x, A.y, Bq.x, Bq.y) >= A.r + Bq.r) continue;
        let hit = false;
        for (const [att, vic] of [[A, Bq], [Bq, A]]) {
          if (att.dash <= 0 || att.dhit || g.ally(att.i, vic.i)) continue;
          const n = norm(vic.x - att.x, vic.y - att.y);
          const dn = norm(att.fx * 0.6 + n.x * 0.4, att.fy * 0.6 + n.y * 0.4);
          vic.vx = dn.x * KNOCK_V; vic.vy = dn.y * KNOCK_V; vic.kn = KNOCK_T; vic.st = STUN_T; vic.dash = 0;
          if (vic.carry) { dropPlank(s, vic, g); g.text(vic.x, vic.y - 90, 'MOLLA!', { player: att.i, size: 34 }); }
          att.dhit = 1; att.dash = 0; att.vx *= 0.25; att.vy *= 0.25;
          hit = true;
          g.sfx('punch'); g.burst((att.x + vic.x) / 2, (att.y + vic.y) / 2, { color: '#fff', n: 14, speed: 360 });
          g.shake(0.3); g.hitstop(0.07); g.vibrate(vic.i, 110); g.vibrate(att.i, 40);
          break;
        }
        if (hit) continue;
        const ax = A.x, ay = A.y, bx = Bq.x, by = Bq.y;
        collideCircles(A, Bq, 0.3);
        if (A.kn <= 0 && !walkable(s, A.x, A.y)) { A.x = ax; A.y = ay; }
        if (Bq.kn <= 0 && !walkable(s, Bq.x, Bq.y)) { Bq.x = bx; Bq.y = by; }
      }
    }
    // ---- falling in
    for (const p of s.p) if (p.swim <= 0 && !walkable(s, p.x, p.y) && !g.ended) fallIn(s, p, g);
  },

  timeout(s) {
    // Longest bridge; ties: a loose plank, then hammer progress, then planks in hand.
    let best = null, bv = -Infinity;
    for (const b of s.br) {
      const carriers = s.p.filter((p) => p.side === b.k && p.carry).length;
      const near = Math.min(...s.p.filter((p) => p.side === b.k).map((p) => dist(p.x, p.y, b.x, tipY(s, b))));
      const v = b.nailed * 1e6 + b.loose * 1e5 + b.nails * 1e4 + carriers * 1e3 - Math.min(999, near);
      if (v > bv) { bv = v; best = b; }
    }
    const w = s.p.find((p) => p.side === best.k);
    return w ? w.i : 0;
  },

  bot: ponteBot,

  view(s) {
    return {
      S: s.S, tm: s.teams ? 1 : 0, need: s.need,
      br: s.br.map((b) => ({ x: b.x, n: b.nailed, l: b.loose, h: b.nails, pr: b.pry })),
      pi: s.piles,
      dp: s.dp.map((q) => ({ id: q.id, x: r1(q.x), y: r1(q.y), v: q.v })),
      au: s.gold ? { x: r1(s.gold.x), y: r1(s.gold.y), l: r2(s.gold.t) } : null,
      wd: s.wind ? { d: s.wind.d, w: r2(s.wind.w), t: r2(s.wind.t) } : null,
      cr: s.cr.map((c) => ({ x: r1(c.x), y: r1(c.y), a: r2(c.a), m: c.st === 'lunge' ? r2(1 - c.t / 0.9) : 0, sp: Math.round(c.sp) })),
      p: s.p.map((p) => ({
        x: r1(p.x), y: r1(p.y), fx: r2(p.fx), fy: r2(p.fy), s: p.side, c: p.carry, st: r2(p.st), kn: r2(p.kn), sw: r2(p.swim),
        d: p.dash > 0 ? 1 : 0, cd: r2(p.dcd), hm: r2(p.hm), hk: p.hk % 16, sp: Math.round(Math.hypot(p.vx, p.vy)),
      })),
      hud: { p: s.p.map((p) => s.br[p.side].nailed), max: null, label: 'Assi', bar: s.p.map((p) => r2(s.br[p.side].nailed / s.need)) },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  // ---------------------------------------------------------------- 3D: the castle moat at dawn, a building site on the near bank
  render3d: {
    assets: [
      'medieval/building_castle_yellow', 'medieval/building_tower_B_yellow', 'medieval/building_tower_A_yellow', 'medieval/wall_straight', 'medieval/wall_straight_gate',
      'medieval/building_scaffolding', 'medieval/building_lumbermill_red', 'medieval/building_lumbermill_blue', 'medieval/building_home_A_yellow', 'medieval/building_well_blue',
      'medieval/resource_lumber', 'medieval/crate_A_big', 'medieval/crate_long_A', 'medieval/barrel', 'medieval/sack', 'medieval/wheelbarrow', 'medieval/bucket_water', 'medieval/pallet',
      'medieval/waterlily_A', 'medieval/waterlily_B', 'medieval/waterplant_A', 'medieval/waterplant_B', 'medieval/waterplant_C',
      'medieval/rock_single_A', 'medieval/rock_single_C', 'medieval/trees_A_large', 'medieval/trees_B_medium', 'medieval/tree_single_A', 'medieval/hills_A_trees', 'medieval/mountain_A_grass_trees',
      'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow',
      'dungeon/banner_red', 'dungeon/banner_blue', 'dungeon/banner_green', 'dungeon/banner_yellow', 'dungeon/torch_lit',
    ],
    build(K, r) {
      const n = r.n || K.n || 2;
      const lo = K.quality === 0;
      K.theme('alba', { fogNear: 2.4, fogFar: 6.5 });
      const M = {
        grass: K.texMat('erba', [16, 8], { color: '#c9dc9a' }),
        grassS: K.texMat('erba', [16, 8], { color: '#c9d49a' }),
        wall: K.texMat('muro', [26, 1], { color: '#c9bba5' }),
        plank: K.texMat('legno', [1, 1], { color: '#c8945c' }),
        plankDark: K.texMat('legno', [1, 1], { color: '#8a5f38' }),
        post: K.mat('#5e3d22', { rough: 0.9 }),
        rope: K.mat('#d9c08a', { rough: 0.9 }),
        croc: K.mat('#5f8a3a', { rough: 0.6, flat: true }),
        crocB: K.mat('#c9c27a', { rough: 0.7 }),
        eye: K.mat('#fff6c8', { rough: 0.3 }),
        pupil: K.mat('#141414'),
        tooth: K.mat('#ffffff', { rough: 0.4 }),
        gold: K.mat('#ffcc33', { rough: 0.25, metal: 0.6, emissive: '#ffb000', ei: 0.35 }),
      };
      const o = { n, M };
      // Banks: two big grass slabs; between them the moat (stone retaining walls, muddy bottom, water).
      const BIG = 5200;
      const north = K.box(BIG, 2000, 60, M.grass); K.place(north, W / 2, MOAT_N - 1000, -30);
      const south = K.box(BIG, 2000, 60, M.grassS); K.place(south, W / 2, MOAT_S + 1000, -30);
      for (const y of [MOAT_N + 9, MOAT_S - 9]) { const w = K.box(BIG, 18, 66, M.wall); K.place(w, W / 2, y, -30); }
      const bed = K.box(BIG, MOAT_W, 10, K.mat('#4b5a3a', { rough: 1 })); K.place(bed, W / 2, (MOAT_N + MOAT_S) / 2, -70);
      if (K.tex('acqua')) K.water(-2100, MOAT_N, W + 2100, MOAT_S, { h: -22, tile: 210, flow: [0.012, 0.004] });
      // Painted ground: site on the near bank (sawdust, ruts, lanes), cobbled road on the castle bank.
      K.layer({ x0: -500, y0: -500, x1: 1500, y1: 1500, h: 0.6, transparent: true, once: true, maxPx: 2048, draw: (d) => drawBanks(d) });
      o.lanes = K.layer({ x0: 0, y0: MOAT_S, x1: W, y1: H, h: 1.2, transparent: true, z: 1, key: (v) => `${v.S}|${v.tm}`, draw: (d, v) => drawLanes(d, v, K) });
      // Lilies and reeds in the moat.
      const lil = [], lil2 = [], reeds = [];
      for (let k = 0; k < (lo ? 14 : 26); k++) {
        const x = -600 + ((k * 263) % 2200), y = MOAT_N + 30 + ((k * 97) % (MOAT_W - 60));
        (k % 2 ? lil : lil2).push({ x, y, h: -21, rot: k * 1.3, s: 0.8 + (k % 3) * 0.2 });
      }
      for (let k = 0; k < (lo ? 10 : 22); k++) reeds.push({ x: -700 + k * 110 + (k % 3) * 20, y: k % 2 ? MOAT_N + 22 : MOAT_S - 22, h: -24, rot: k, s: 0.8 + (k % 4) * 0.15 });
      K.scatter('medieval/waterlily_A', lil, { size: 60, cast: false });
      K.scatter('medieval/waterlily_B', lil2, { size: 54, cast: false });
      K.scatter('medieval/waterplant_A', reeds.filter((_, k) => k % 3 === 0), { size: 60 });
      K.scatter('medieval/waterplant_B', reeds.filter((_, k) => k % 3 === 1), { size: 56 });
      K.scatter('medieval/waterplant_C', reeds.filter((_, k) => k % 3 === 2), { size: 50 });
      buildCastleBank(K, M, lo);
      buildSite(K, M, lo);
      // Bridges (pool for up to 4 lanes × 10 planks): deck planks, piles in the water, rope rails, loose plank, nail ring.
      o.br = [0, 1, 2, 3].map(() => {
        const B = { planks: [], posts: [], rails: [], g: K.group() };
        for (let k = 0; k < NEED_TEAM; k++) {
          const pl = K.box(1, 1, 1, k % 2 ? M.plank : M.plankDark, { parent: B.g });
          B.planks.push(pl);
        }
        for (let k = 0; k < 12; k++) { const ps = K.cyl(7, 1, M.post, { parent: B.g, seg: 8 }); B.posts.push(ps); }
        for (let k = 0; k < 2; k++) { const rl = K.box(4, 1, 4, M.rope, { parent: B.g, cast: false }); B.rails.push(rl); }
        B.loose = K.box(1, 1, 1, M.plank, { parent: B.g });
        B.looseGold = K.box(1, 1, 1, M.gold, { parent: B.g });
        B.dec = K.decal(170, { px: 192, h: 9 });
        B.key = '';
        return B;
      });
      // Flags at the foot of each lane (one per seat: in a team match only the captain's shows) and goal banners.
      o.flags = [...Array(n).keys()].map((i) => {
        const c = FLAG[K.roster[i]?.color ?? i] || 'red';
        const f = K.model(`medieval/flag_${c}`, { height: 120 });
        const bn = K.model(`dungeon/banner_${BANNER[K.roster[i]?.color ?? i] || 'red'}`, { height: 120 });
        return { f, bn, base: 0 };
      });
      // Plank piles (up to 3).
      o.piles = [0, 1, 2].map(() => {
        const g = K.group();
        // A neat criss-crossed stack of planks.
        for (let L = 0; L < 4; L++) {
          for (let k = -1; k <= 1; k++) {
            const pl = K.box(PLANK_L, 24, 10, (k + L) % 2 ? M.plank : M.plankDark, { parent: g });
            if (L % 2) { K.place(pl, k * 34, 0, 5 + L * 10); pl.rotation.y = Math.PI / 2 + k * 0.05; } else { K.place(pl, (k % 2) * 4, k * 34, 5 + L * 10); pl.rotation.y = k * 0.04; }
          }
        }
        return g;
      });
      // Dropped planks on the ground and the golden plank.
      o.dp = [...Array(8)].map(() => K.box(PLANK_L, 22, 9, M.plank));
      o.dpGold = [...Array(8)].map(() => K.box(PLANK_L, 22, 9, M.gold));
      o.gold = K.box(PLANK_L, 24, 10, M.gold);
      o.goldGlow = K.disc(1, K.glow('#ffd84a', { opacity: 0.35, add: true }));
      // Crocodiles.
      o.cr = [...Array(4)].map(() => buildCroc(K, M));
      // Knights: avatar + carried plank + ground marks; swim rings.
      o.pl = [...Array(n).keys()].map((i) => ({
        av: K.avatar(i),
        plank: K.box(PLANK_L, 22, 9, M.plank),
        plankG: K.box(PLANK_L, 22, 9, M.gold),
        dec: K.decal(190, { px: 192 }),
        ring: K.torus(1, 0.08, K.glow('#e8f7ff', { opacity: 0.7 }), { cast: false }),
      }));
      o.windLeaves = !!(r.variant === 'vento');
      if (o.windLeaves) K.ambient('foglie', { n: 70, h: 400 });
      K.ambient('petali', { n: lo ? 25 : 50, h: 380, x0: -300, y0: -400, x1: 1300, y1: 1300 });
      if (!lo) K.ambient('lucciole', { n: 30, x0: -200, y0: MOAT_N, x1: 1200, y1: MOAT_S, h: 80 });
      return o;
    },
    update(K, o, v, r) {
      const t = K.t;
      const PL = MOAT_W / v.need;
      const lanes = v.br.length;
      // Bridges.
      o.br.forEach((B, k) => {
        const b = v.br[k];
        B.g.visible = !!b;
        B.dec.show(!!b);
        if (!b) return;
        B.planks.forEach((pl, j) => {
          pl.visible = j < b.n;
          if (!pl.visible) return;
          pl.scale.set(BW + 10 + (j % 3) * 4, 10, PL - 3);
          K.place(pl, b.x + ((j % 2) - 0.5) * 3, MOAT_S - (j + 0.5) * PL, 1);
          pl.rotation.y = ((j % 3) - 1) * 0.02;
        });
        // Being pried: the last plank rattles.
        if (b.pr > 0 && b.n > 0) { const last = B.planks[b.n - 1]; last.rotation.z = Math.sin(t * 50) * 0.04 * b.pr; last.position.y = 1 + Math.abs(Math.sin(t * 40)) * b.pr; } else if (b.n > 0) B.planks[b.n - 1].rotation.z = 0;
        const len = b.n * PL;
        B.posts.forEach((ps, j) => {
          const row = Math.floor(j / 2), sd = j % 2 ? 1 : -1;
          const y = MOAT_S - (row * 2 + 1.2) * PL;
          ps.visible = y > MOAT_S - len;
          if (!ps.visible) return;
          ps.scale.set(1, 70, 1);
          K.place(ps, b.x + sd * (BW / 2 + 2), y, -64);
        });
        B.rails.forEach((rl, j) => {
          rl.visible = len > 4;
          if (!rl.visible) return;
          K.place(rl, b.x + (j ? 1 : -1) * (BW / 2 + 2), MOAT_S - len / 2, 18);
          rl.scale.set(1, 1, len);
        });
        const ty = MOAT_S - len;
        const wob = b.l ? Math.sin(t * 14) * (4 - b.h) * 0.012 : 0;
        B.loose.visible = b.l === 1; B.looseGold.visible = b.l === 2;
        for (const m of [B.loose, B.looseGold]) {
          if (!m.visible) continue;
          m.scale.set(BW + 8, 10, PL - 4);
          K.place(m, b.x + 4, ty - PL / 2, 4 + Math.abs(wob) * 60);
          m.rotation.y = 0.12 + wob; m.rotation.z = wob * 2;
        }
        const key = `${b.l}|${b.h}|${b.pr}|${Math.floor(t * 4) % 2}`;
        if (B.key !== key) { B.key = key; B.dec.paint((d) => drawTipMarks(d, b, sideCol(K, v, k))); }
        B.dec.at(b.x, ty - (b.l ? PL / 2 : 0) + 34, 9);
      });
      // Flags at the lane feet; goal banners on the castle bank.
      o.flags.forEach((F, i) => {
        let lane = -1;
        if (v.tm) { const side = v.p[i]?.s; if (side !== undefined && v.p.findIndex((q) => q.s === side) === i) lane = side; } else if (i < lanes) lane = i;
        F.f.visible = F.bn.visible = lane >= 0;
        if (lane < 0) return;
        const x = v.br[lane].x;
        K.place(F.f, x - BW / 2 - 34, MOAT_S + 30);
        K.face(F.f, Math.PI + Math.sin(t * 2 + i) * 0.15);
        K.place(F.bn, x, MOAT_N - 40);
        K.face(F.bn, Math.PI / 2);
      });
      o.piles.forEach((g, k) => { g.visible = k < v.pi.length; if (g.visible) K.place(g, v.pi[k], PILE_Y); });
      o.dp.forEach((m, k) => {
        const q = v.dp[k];
        m.visible = !!q && q.v === 1; o.dpGold[k].visible = !!q && q.v === 2;
        if (!q) return;
        const mm = q.v === 2 ? o.dpGold[k] : m;
        K.place(mm, q.x, q.y, 5); mm.rotation.y = (q.id * 1.7) % 3;
      });
      o.gold.visible = o.goldGlow.visible = !!v.au && !(v.au.l < 2 && Math.floor(t * 10) % 2);
      if (o.gold.visible) {
        K.place(o.gold, v.au.x, v.au.y, 20 + Math.sin(t * 4) * 8); o.gold.rotation.y = t * 1.5;
        K.place(o.goldGlow, v.au.x, v.au.y, 1.5); o.goldGlow.scale.setScalar(70 + Math.sin(t * 7) * 8);
      }
      // Crocodiles: swim (tail sway), lunge (jaw opens, head rises).
      o.cr.forEach((C, k) => {
        const c = v.cr[k];
        C.g.visible = !!c;
        if (!c) return;
        const lunge = c.m;
        K.place(C.g, c.x, c.y, -24 + lunge * 14);
        K.face(C.g, c.a);
        C.jaw.rotation.z = -lunge * 0.9;
        C.tail.rotation.y = Math.sin(t * 5 + k) * 0.35 * (0.3 + Math.min(1, c.sp / 80));
        C.g.rotation.z = lunge * 0.12;
        C.wake.scale.setScalar(40 + ((t * 30 + k * 20) % 30));
      });
      // Knights.
      v.p.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const col = sideCol(K, v, p.s);
        const swim = p.sw > 0;
        P.ring.visible = swim;
        if (swim) {
          const bob = Math.sin(t * 6 + i) * 4;
          P.av.set(p.x, p.y, { r: P_R, h: -52 + bob, look: t * 2 + i, mood: 'scared', anim: 'Jump_Idle', gear: false });
          K.place(P.ring, p.x, p.y, -21); P.ring.scale.setScalar(P_R + 12 + Math.sin(t * 8) * 4);
          P.plank.visible = P.plankG.visible = false;
          P.dec.show(false);
          return;
        }
        let anim, animKey, mood = 'ok';
        if (p.st > 0 || p.kn > 0) { anim = 'Hit_A'; mood = 'dizzy'; } else if (p.d) { anim = 'Dodge_Forward'; mood = 'angry'; } else if (p.hm > 0 && !p.c) { anim = '1H_Melee_Attack_Chop'; animKey = p.hk; mood = 'angry'; } else if (p.c) anim = p.sp > 40 ? 'Walking_A' : 'Idle';
        if (r.ended) {
          const mine = v.br[p.s].n;
          const win = v.br.every((b) => b.n <= mine);
          mood = win ? 'happy' : 'hurt'; anim = win ? 'Cheer' : anim;
        }
        P.av.set(p.x, p.y, { r: P_R, look: Math.atan2(p.fy, p.fx), mood, walk: clamp(p.sp / 300, 0, 1), anim, animKey, gear: !p.c });
        // The plank is carried overhead.
        const pm = p.c === 2 ? P.plankG : P.plank;
        P.plank.visible = p.c === 1; P.plankG.visible = p.c === 2;
        if (p.c) {
          K.place(pm, p.x, p.y, P_R * 2.75 + Math.abs(Math.sin(t * 9)) * (p.sp > 40 ? 5 : 0));
          K.face(pm, Math.atan2(p.fy, p.fx) + Math.PI / 2);
        }
        P.dec.show(true).at(p.x, p.y, 1.8).paint((d) => drawKnightMarks(d, p, col, K.col(i, 'light')));
      });
    },
  },

  render(d, v, r) {
    const PL = MOAT_W / v.need;
    drawBanks(d, true);
    drawLanes(d, v, null, d);
    const { ctx } = d;
    // Water.
    const gr = ctx.createLinearGradient(0, MOAT_N, 0, MOAT_S);
    gr.addColorStop(0, '#2f7fa8'); gr.addColorStop(1, '#3d97c0');
    ctx.fillStyle = gr; ctx.fillRect(-400, MOAT_N, W + 800, MOAT_W);
    for (let k = 0; k < 10; k++) { const x = ((k * 173 + d.t * 25) % 1300) - 150; d.line(x, MOAT_N + 40 + (k % 5) * 50, x + 60, MOAT_N + 40 + (k % 5) * 50, 'rgba(255,255,255,0.25)', 3); }
    for (let k = 0; k < 8; k++) d.circle(60 + k * 130, MOAT_N + 50 + ((k * 71) % 200), 22, '#4f9a3a');
    v.br.forEach((b, k) => {
      const col = v.tm ? TEAM_COL[k] : d.col(k);
      for (let j = 0; j < b.n; j++) d.rect(b.x - BW / 2, MOAT_S - (j + 1) * PL + 1, BW, PL - 2, j % 2 ? '#c8945c' : '#a87443', '#5e3d22', 2);
      const ty = MOAT_S - b.n * PL;
      if (b.l) d.rect(b.x - BW / 2 + 6, ty - PL + 2, BW, PL - 3, b.l === 2 ? '#ffcc33' : '#d8a46c', '#5e3d22', 2);
      d.circle(b.x, ty - (b.l ? PL / 2 : 0), 10, col);
      for (let j = 0; j < NAILS; j++) d.circle(b.x - 30 + j * 20, ty + 22, 6, j < b.h ? '#ffd84a' : 'rgba(0,0,0,0.3)');
      d.rect(b.x - 8, MOAT_N - 90, 16, 70, col);
    });
    for (const c of v.cr) {
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.a);
      d.rrect(-70, -20, 120, 40, 14, '#5f8a3a', '#2f4a1a', 3);
      d.poly([50, -14, 50 + 40, -14 - c.m * 18, 50 + 40, -6, 50, 0], '#6d9a42');
      d.poly([50, 14, 50 + 40, 14 + c.m * 18, 50 + 40, 6, 50, 0], '#6d9a42');
      d.circle(40, -14, 6, '#fff6c8'); d.circle(40, 14, 6, '#fff6c8');
      ctx.restore();
    }
    v.pi.forEach((x) => { for (let k = 0; k < 4; k++) d.rect(x - 55, PILE_Y - 30 + k * 14, 110, 12, k % 2 ? '#c8945c' : '#8a5f38', '#3d2614', 2); });
    for (const q of v.dp) d.rect(q.x - PLANK_L / 2, q.y - 11, PLANK_L, 22, q.v === 2 ? '#ffcc33' : '#c8945c', '#3d2614', 2);
    if (v.au) d.rect(v.au.x - PLANK_L / 2, v.au.y - 12, PLANK_L, 24, '#ffcc33', '#fff3c4', 3);
    v.p.forEach((p, i) => {
      if (p.sw > 0) { d.ring(p.x, p.y, P_R + 10, 'rgba(230,247,255,0.8)', 4); d.avatar(p.x, p.y, P_R * 0.8, i, { mood: 'scared', alpha: 0.7 }); return; }
      d.shadow(p.x + 6, p.y + 12, P_R, P_R * 0.75, 0.3);
      d.ring(p.x, p.y, P_R + 8, (v.tm ? TEAM_COL[p.s] : d.col(p.s)) + 'cc', 4);
      d.avatar(p.x, p.y, P_R, i, { look: Math.atan2(p.fy, p.fx), mood: p.st > 0 ? 'dizzy' : p.hm > 0 ? 'angry' : 'ok' });
      if (p.c) d.rect(p.x - PLANK_L / 2, p.y - P_R - 22, PLANK_L, 18, p.c === 2 ? '#ffcc33' : '#c8945c', '#3d2614', 2);
    });
  },
};

// ---------------------------------------------------------------- drawing helpers
const PLANK_L = 112;
function sideCol(K, v, k) { return v.tm ? TEAM_COL[k] : K.col(k); }

// Both banks seen from above (3D: painted over the grass slabs; 2D: full background).
function drawBanks(d, full) {
  const { ctx } = d;
  if (full) {
    ctx.fillStyle = '#7aa04a'; ctx.fillRect(-400, -400, W + 800, MOAT_N + 400);
    ctx.fillStyle = '#86a656'; ctx.fillRect(-400, MOAT_S, W + 800, H + 400 - MOAT_S);
  }
  let seed = 4321;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // Building site: trampled earth with sawdust and wheel ruts.
  const g = ctx.createLinearGradient(0, MOAT_S, 0, H + 300);
  g.addColorStop(0, 'rgba(150,118,80,0.95)'); g.addColorStop(0.75, 'rgba(160,128,88,0.9)'); g.addColorStop(1, 'rgba(160,128,88,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-120, MOAT_S + 8); ctx.lineTo(W + 120, MOAT_S + 8); ctx.lineTo(W + 260, H + 300); ctx.lineTo(-260, H + 300); ctx.closePath(); ctx.fill();
  for (let k = 0; k < 700; k++) {
    const x = -150 + rnd() * (W + 300), y = MOAT_S + 12 + rnd() * 500;
    d.circle(x, y, 1.5 + rnd() * 4, rnd() < 0.6 ? 'rgba(235,205,150,0.55)' : 'rgba(90,64,40,0.35)');
  }
  for (const x of [80, 920]) d.line(x, MOAT_S + 30, x + (x < 500 ? -60 : 60), H + 200, 'rgba(90,64,40,0.35)', 14);
  // Castle bank: cobbled road to the gate and a stone quay along the water.
  ctx.fillStyle = 'rgba(170,160,145,0.95)';
  ctx.fillRect(-500, MOAT_N - 60, W + 1000, 52);
  for (let x = -500; x < W + 500; x += 34) d.line(x, MOAT_N - 60, x, MOAT_N - 8, 'rgba(90,85,78,0.5)', 2);
  ctx.fillStyle = 'rgba(160,148,130,0.9)';
  ctx.beginPath(); ctx.moveTo(380, MOAT_N - 60); ctx.lineTo(620, MOAT_N - 60); ctx.lineTo(580, -200); ctx.lineTo(420, -200); ctx.closePath(); ctx.fill();
  for (let k = 0; k < 160; k++) {
    const x = 400 + rnd() * 200, y = -190 + rnd() * (MOAT_N - 70 + 190);
    d.circle(x, y, 5 + rnd() * 6, 'rgba(110,102,92,0.35)');
  }
  for (let k = 0; k < 260; k++) {
    const x = -400 + rnd() * (W + 800), y = -300 + rnd() * (MOAT_N - 80 + 300);
    if (x > 380 && x < 620) continue;
    d.circle(x, y, 2 + rnd() * 3, rnd() < 0.5 ? 'rgba(255,240,140,0.7)' : 'rgba(255,170,200,0.6)');
  }
}

// Lane strips at the foot of each bridge on the building site (team colors) + pile pads.
function drawLanes(d, v, K, d2) {
  const lanes = LANES[v.S];
  lanes.forEach((x, k) => {
    const col = v.tm ? TEAM_COL[k] : K ? K.col(k) : d2.col(k);
    const { ctx } = d;
    const g = ctx.createLinearGradient(0, MOAT_S, 0, MOAT_S + 190);
    g.addColorStop(0, col + 'aa'); g.addColorStop(1, col + '00');
    ctx.fillStyle = g;
    ctx.fillRect(x - BW / 2 - 6, MOAT_S, BW + 12, 190);
    for (let j = 0; j < 3; j++) {
      ctx.beginPath(); ctx.moveTo(x - 22, MOAT_S + 120 - j * 34); ctx.lineTo(x, MOAT_S + 98 - j * 34); ctx.lineTo(x + 22, MOAT_S + 120 - j * 34);
      ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.stroke();
    }
  });
  for (const x of PILES[v.S]) { d.circle(x, PILE_Y, REACH_PILE - 10, 'rgba(255,230,170,0.18)', 'rgba(255,230,170,0.55)', 4); }
}

function drawTipMarks(d, b, col) {
  // Hammer progress (4 nails) when a plank is laid; pry progress in red when someone is pulling it off.
  if (b.l) {
    for (let j = 0; j < NAILS; j++) {
      const a = -Math.PI / 2 + (j - 1.5) * 0.5;
      d.circle(Math.cos(a) * 58, 30 + Math.sin(a) * 18, 10, j < b.h ? '#ffd84a' : 'rgba(30,20,10,0.55)', '#fff', 2);
    }
    d.ring(0, -20, 64, col + 'cc', 5);
  } else d.ring(0, -34, 44, col + '88', 4);
  if (b.pr > 0) d.arc(0, -34, 54, -Math.PI / 2, -Math.PI / 2 + TAU * (b.pr / PRY), '#ff4b2a', 8);
}

function drawKnightMarks(d, p, col, light) {
  d.ring(0, 0, P_R + 9, col + 'dd', 5);
  const ax = p.fx * (P_R + 22), ay = p.fy * (P_R + 22);
  d.poly([ax + p.fx * 16, ay + p.fy * 16, ax - p.fy * 11, ay + p.fx * 11, ax + p.fy * 11, ay - p.fx * 11], light + 'dd', 'rgba(0,0,0,0.35)', 2);
  if (p.cd > 0 && !p.c) d.arc(0, 0, P_R + 17, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / DASH_CD), 'rgba(230,235,245,0.7)', 4);
}

// ---------------------------------------------------------------- 3D builders
function buildCastleBank(K, M, lo) {
  const castle = K.model('medieval/building_castle_yellow', { height: 560 });
  K.place(castle, W / 2, -330); K.face(castle, Math.PI / 2);
  const wall = [];
  for (let k = -6; k <= 6; k++) if (k !== 0) wall.push({ x: W / 2 + k * 190, y: 110, rot: 0 });
  K.scatter('medieval/wall_straight', wall, { size: 196 });
  const gate = K.model('medieval/wall_straight_gate', { size: 196 }); K.place(gate, W / 2, 110);
  for (const x of [W / 2 - 300, W / 2 + 300]) K.place(K.model('medieval/building_tower_B_yellow', { height: 330 }), x, 70);
  for (const x of [-380, W + 380]) K.place(K.model('medieval/building_tower_A_yellow', { height: 380 }), x, 60);
  for (const x of [W / 2 - 110, W / 2 + 110]) K.place(K.model('dungeon/torch_lit', { height: 80 }), x, MOAT_N - 70);
  if (!lo) { K.light(W / 2 - 110, MOAT_N - 70, 90, '#ffb35c', 1.6, { flicker: 0.5, dist: 420 }); K.light(W / 2 + 110, MOAT_N - 70, 90, '#ffb35c', 1.6, { flicker: 0.5, dist: 420 }); }
  K.scatter('medieval/trees_A_large', [-700, -520, 1520, 1700, -820, 1820].map((x, k) => ({ x, y: -60 + (k % 3) * 120, rot: k, s: 0.9 + (k % 2) * 0.2 })), { size: 300 });
  K.scatter('medieval/hills_A_trees', [{ x: -1200, y: -700, rot: 0.3 }, { x: 2200, y: -700, rot: 2.1 }], { size: 1100 });
  K.scatter('medieval/mountain_A_grass_trees', [{ x: -400, y: -1800, rot: 0.4 }, { x: 1500, y: -1900, rot: 1.8 }], { size: 1700 });
  const rocks = [[-180, MOAT_N - 30], [1180, MOAT_N - 40], [-420, MOAT_S + 40], [1420, MOAT_S + 30]];
  K.scatter('medieval/rock_single_A', rocks.map(([x, y], k) => ({ x, y, rot: k })), { size: 70 });
}

function buildSite(K, M, lo) {
  // Scaffolding and lumber mills on the flanks of the site, a well, crates, sacks, wheelbarrows, a crane.
  for (const [x, y, a] of [[-250, 640, 0], [1250, 640, Math.PI]]) { const sc = K.model('medieval/building_scaffolding', { height: 190 }); K.place(sc, x, y + 60); K.face(sc, a); }
  const m1 = K.model('medieval/building_lumbermill_red', { size: 300 }); K.place(m1, -380, 960); K.face(m1, -0.3);
  const m2 = K.model('medieval/building_lumbermill_blue', { size: 300 }); K.place(m2, 1380, 960); K.face(m2, Math.PI + 0.3);
  const well = K.model('medieval/building_well_blue', { size: 110 }); K.place(well, -60, 1080);
  const home = K.model('medieval/building_home_A_yellow', { size: 240 }); K.place(home, 1080, 1130); K.face(home, -Math.PI / 2);
  const props = (name, list, size) => K.scatter(name, list.map(([x, y, rot]) => ({ x, y, rot })), { size });
  props('medieval/crate_A_big', [[-90, 680, 0.2], [1090, 690, 0.5], [-60, 900, 0.1], [1060, 880, 0.3]], 60);
  props('medieval/crate_long_A', [[-120, 840, 1.4], [1120, 820, 1.7]], 90);
  props('medieval/barrel', [[-40, 760, 0], [1040, 760, 1], [-30, 980, 2], [1030, 990, 0]], 46);
  props('medieval/sack', [[1010, 940, 0], [-10, 930, 1]], 40);
  props('medieval/wheelbarrow', [[60, 1010, 0.8], [940, 1010, 2.3]], 84);
  props('medieval/bucket_water', [[-20, 700, 0], [1020, 650, 0]], 30);
  props('medieval/pallet', [[-160, 1000, 0.3], [1160, 1000, -0.3]], 90);
  props('medieval/resource_lumber', [[-240, 640, 0.2], [1240, 640, 2.9]], 140);
  K.scatter('medieval/trees_B_medium', [-560, -700, 1560, 1700, -500, 1500].map((x, k) => ({ x, y: 700 + (k % 3) * 220, rot: k, s: 0.9 })), { size: 220 });
  K.scatter('medieval/tree_single_A', [[-300, 1250], [1300, 1250], [-650, 1100], [1650, 1100]].map(([x, y], k) => ({ x, y, rot: k })), { size: 170 });
  // Wooden crane over the site (left), with a plank hanging from its rope.
  const cr = K.group(); K.place(cr, -40, 600);
  const mast = K.box(16, 16, 250, M.post, { parent: cr }); K.place(mast, 0, 0, 125);
  const jib = K.box(220, 12, 12, M.post, { parent: cr }); K.place(jib, 90, 0, 245);
  const brace = K.box(110, 8, 8, M.post, { parent: cr }); K.place(brace, 40, 0, 205); brace.rotation.z = 0.6;
  const rope = K.box(3, 3, 120, M.rope, { parent: cr }); K.place(rope, 190, 0, 185);
  const hang = K.box(110, 20, 9, M.plank, { parent: cr }); K.place(hang, 190, 0, 120);
  // Sawhorses at the pile spots' sides.
  for (const x of [130, 870]) {
    const sh = K.group(); K.place(sh, x, 960);
    const top = K.box(90, 10, 10, M.post, { parent: sh }); K.place(top, 0, 0, 40);
    for (const sx of [-35, 35]) for (const sy of [-10, 10]) { const leg = K.box(6, 6, 46, M.post, { parent: sh }); K.place(leg, sx, sy, 20); leg.rotation.x = sy > 0 ? 0.3 : -0.3; }
    const pl = K.box(120, 22, 8, M.plank, { parent: sh }); K.place(pl, 0, 0, 50); pl.rotation.y = 0.2;
  }
}

// A cartoon crocodile: body, bumpy back, snout with an opening jaw, bulging eyes, swaying tail.
function buildCroc(K, M) {
  const g = K.group();
  const C = { g };
  const body = K.ball(1, M.croc, { parent: g, seg: 14 }); body.scale.set(62, 18, 26); K.place(body, 0, 0, 10);
  const belly = K.ball(1, M.crocB, { parent: g, seg: 12 }); belly.scale.set(56, 10, 22); K.place(belly, 0, 0, 4);
  for (let k = 0; k < 5; k++) { const b = K.cone(7, 10, M.croc, { parent: g }); K.place(b, -40 + k * 18, 0, 24); }
  // Head: upper snout (fixed) and lower jaw (opens).
  const snout = K.box(60, 30, 12, M.croc, { parent: g }); K.place(snout, 70, 0, 22);
  C.jaw = K.group(g); K.place(C.jaw, 42, 0, 14);
  const jawM = K.box(58, 28, 10, M.crocB, { parent: C.jaw }); K.place(jawM, 29, 0, 0);
  for (let k = 0; k < 4; k++) for (const sy of [-1, 1]) { const tt = K.cone(3, 7, M.tooth, { parent: g, cast: false }); K.place(tt, 54 + k * 12, sy * 13, 10); tt.rotation.x = Math.PI; }
  for (const sy of [-1, 1]) {
    const e = K.ball(8, M.eye, { parent: g, seg: 10 }); K.place(e, 46, sy * 12, 32);
    const pu = K.ball(4, M.pupil, { parent: g, seg: 8 }); K.place(pu, 52, sy * 13, 34);
  }
  C.tail = K.group(g); K.place(C.tail, -58, 0, 10);
  const tail = K.cone(16, 70, M.croc, { parent: C.tail }); tail.rotation.z = Math.PI / 2; K.place(tail, -2, 0, 0);
  C.wake = K.torus(1, 0.05, K.glow('#e8f7ff', { opacity: 0.45 }), { parent: g, cast: false }); K.place(C.wake, 0, 0, 2);
  return C;
}
