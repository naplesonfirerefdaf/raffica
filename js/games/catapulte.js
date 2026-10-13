// Catapulte! — siege artillery duel around a stormy lake (top-down, tilted camera).
// Every player works a catapult in front of its castle. Point the stick, hold A to wind up (the power swings
// back and forth: the landing mark slides along the aim), release to fling a rock / cow / cabbage / powder keg.
// Mind the wind! B (held, when loaded) repairs your weakest tower. Knock down every enemy tower to win.
// Teams 2 vs 2: two castles of five towers, two catapults each. Free-for-all 2–4: one castle each, last one standing.
import { clamp, dist, norm, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500;
const CASTLE_D = 430, CAT_D = 290;
const TOWER_R = 40, TOWER_HP = 80;
const T3 = [-125, 0, 125], T5 = [-250, -125, 0, 125, 250];
const RMIN = 120, RMAX = 980, PERIOD = 1.6;
const RELOAD = 1.5, RELOAD_FINAL = 1.0, STUN_T = 2.0, CAT_HIT = 72;
const REPAIR = 7, FINAL_T = 40, FINAL_DMG = 1.4;
const LAKE_R = 150, ISLE_R = 52;
const LAUNCH_H = 46;
// Ammo: 0 rock, 1 cow, 2 cabbage, 3 powder keg.
const ROCK = 0, COW = 1, CABBAGE = 2, KEG = 3;
const DMG = [34, 22, 15, 50], BLAST = [78, 70, 60, 115];
const AMMO_NAME = ['MASSO', 'VACCA', 'CAVOLI', 'BARILE'];
const AMMO_EMOJI = ['🪨', '🐄', '🥬', '🛢️'];
const TEAM_COL = ['#ff4b5c', '#3fa9ff'];
const FLAGS = ['red', 'blue', 'green', 'yellow']; // KayKit model colors by player color index
// Wind names by the direction it comes FROM (world up = north).
const WINDS = ['Levante', 'Scirocco', 'Ostro', 'Libeccio', 'Ponente', 'Maestrale', 'Tramontana', 'Grecale'];

const meter = (ph) => { const f = ph % 1; return f < 0.5 ? f * 2 : 2 - f * 2; };
const rangeOf = (pw) => RMIN + pw * (RMAX - RMIN);
const flightT = (pw) => 1.0 + 0.9 * pw;
const peakH = (pw) => 140 + 360 * pw;
const seatOf = (s, o) => (s.p.find((p) => p.o === o) || s.p[0]).i;

function angles(nb) {
  return nb === 3 ? [Math.PI / 2, -Math.PI / 6, (7 * Math.PI) / 6] : nb === 4 ? [Math.PI / 2, -Math.PI / 2, Math.PI, 0] : [Math.PI / 2, -Math.PI / 2];
}

// Tower positions of every castle (owner o): a row along the side, facing the lake.
function towerSpots(nb, teams) {
  const out = [];
  angles(nb).forEach((a, o) => {
    const ox = Math.cos(a), oy = Math.sin(a), tx = -oy, ty = ox;
    for (const off of teams ? T5 : T3) out.push({ o, x: CX + ox * CASTLE_D + tx * off, y: CY + oy * CASTLE_D + ty * off, a });
  });
  return out;
}

function nextAmmo(g) {
  if (g.variant === 'vacche') return COW;
  const r = g.rng();
  return r < 0.4 ? ROCK : r < 0.65 ? COW : r < 0.9 ? CABBAGE : KEG;
}

function windName(wx, wy) {
  // Wind blows toward (wx, wy): it comes from the opposite side. World angle: 0 = east, π/2 = south (y down).
  const from = Math.atan2(-wy, -wx);
  const k = Math.round(((from + TAU) % TAU) / (TAU / 8)) % 8;
  return WINDS[k];
}

// Total tower HP of a castle (owner o).
const castleHp = (s, o) => s.tw.reduce((a, t) => a + (t.o === o ? t.hp : 0), 0);
const castleUp = (s, o) => s.tw.some((t) => t.o === o && t.hp > 0);

function fire(s, p, g) {
  const pw = meter(p.ch);
  p.ch = -1;
  const k = p.ammo;
  const R = rangeOf(pw), T = flightT(pw), hm = peakH(pw);
  const wx = s.wind.x * T, wy = s.wind.y * T;
  const mk = (ang, rk, main) => ({
    o: p.o, i: p.i, k, x0: p.x, y0: p.y,
    x1: clamp(p.x + Math.cos(ang) * R * rk + wx, -250, W + 250), y1: clamp(p.y + Math.sin(ang) * R * rk + wy, -250, H + 250),
    T, u: 0, hm, b: k === COW ? (g.variant === 'vacche' ? 2 : 1) : 0, main, grp: s.sid,
  });
  s.sh.push(mk(p.aim, 1, true));
  if (k === CABBAGE) { s.sh.push(mk(p.aim - 0.11, 0.93, false)); s.sh.push(mk(p.aim + 0.11, 1.07, false)); }
  s.sid++;
  p.k++; p.shots++;
  p.rl = s.final ? RELOAD_FINAL : RELOAD;
  p.ammo = nextAmmo(g);
  g.sfx('shoot', { pitch: 0.7 + pw * 0.3 }); g.sfx('whoosh', { vol: 0.6 });
  if (k === COW) g.sfx('quack', { pitch: 0.45, vol: 0.7 });
  g.burst(p.x, p.y, { color: '#d9c6a0', n: 10, speed: 200 });
  g.shake(0.12);
}

function impact(s, sh, g) {
  const x = sh.x1, y = sh.y1, k = sh.k;
  if (dist(x, y, CX, CY) < LAKE_R && dist(x, y, CX, CY) > ISLE_R) {
    g.sfx('splash'); g.burst(x, y, { color: '#9fd8ff', n: 18, speed: 300, size: 9 });
    g.ring(x, y, { color: '#cfefff', r: 70 });
    if (k === COW) g.text(x, y - 60, 'MUUU... SPLASH!', { color: '#cfefff', size: 40 });
    return;
  }
  s.cr.push([r1(x), r1(y), k === KEG ? 1 : 0]);
  if (s.cr.length > 14) s.cr.shift();
  s.nc++;
  const dmg0 = DMG[k] * (s.final ? FINAL_DMG : 1), R = BLAST[k];
  let best = 0;
  for (const t of s.tw) {
    if (t.hp <= 0 || t.o === sh.o) continue;
    const d = Math.max(0, dist(x, y, t.x, t.y) - TOWER_R * 0.5);
    if (d > R) continue;
    const f = d < R * 0.4 ? 1 : 1 - (0.65 * (d - R * 0.4)) / (R * 0.6);
    const dmg = Math.min(t.hp, dmg0 * f);
    t.hp -= dmg; t.hit = 0.45; t.hk++;
    s.dealt[sh.o] += dmg;
    s.p[sh.i].hits++;
    best = Math.max(best, dmg);
    g.text(t.x, t.y - 150, `-${Math.round(dmg)}`, { color: '#ffd23f', size: 40 });
    if (t.hp <= 0.5) {
      t.hp = 0;
      g.sfx('crash'); g.sfx('break');
      g.burst(t.x, t.y, { color: '#c9bca8', n: 36, speed: 420, size: 12 });
      g.text(t.x, t.y - 110, 'TORRE CROLLATA!', { player: sh.i, size: 50 });
      g.shake(0.6); g.hitstop(0.08);
    }
  }
  // Direct hit on an enemy catapult: it is stunned.
  for (const q of s.p) {
    if (q.o === sh.o || q.elim) continue;
    if (dist(x, y, q.x, q.y) > CAT_HIT + R * 0.25) continue;
    q.stun = STUN_T; q.ch = -1; q.rep = false;
    g.text(q.x, q.y - 90, 'RINTRONATA!', { player: sh.i, size: 44 });
    g.sfx('bonk'); g.vibrate(q.i, 160);
  }
  if (k === KEG) { g.sfx('bigexplode'); g.burst(x, y, { color: '#ff8a2a', n: 40, speed: 520, size: 12 }); g.ring(x, y, { color: '#ffb347', r: R + 30 }); g.shake(0.55); }
  else if (k === COW) { g.sfx('boing', { pitch: 0.8 }); g.burst(x, y, { color: '#ffffff', n: 14, speed: 260 }); g.text(x, y - 50, 'MUUU!', { color: '#ffffff', size: 40 }); }
  else if (k === CABBAGE) { g.sfx('squish'); g.burst(x, y, { color: '#7ed957', n: 16, speed: 260 }); }
  else { g.sfx('explode', { vol: 0.8 }); g.burst(x, y, { color: '#a89a86', n: 22, speed: 340, size: 10 }); }
  if (best > 0) { g.shake(Math.max(0.25, best / 90)); g.vibrate(sh.i, 50); g.sfx('hit', { vol: 0.7 }); }
  // A cow bounces on once more (or twice), straight ahead.
  if (k === COW && sh.b > 0) {
    const n = norm(sh.x1 - sh.x0, sh.y1 - sh.y0);
    s.sh.push({ o: sh.o, i: sh.i, k, x0: x, y0: y, x1: clamp(x + n.x * 170, -250, W + 250), y1: clamp(y + n.y * 170, -250, H + 250), T: 0.6, u: 0, hm: 70, b: sh.b - 1, main: true, grp: s.sid++, bo: 1 });
  }
}

// Castles that just lost their last tower are out; the last castle standing wins.
function checkCastles(s, g) {
  for (let o = 0; o < s.nb; o++) {
    if (s.dead[o] || castleUp(s, o)) continue;
    s.dead[o] = true;
    for (const p of s.p) if (p.o === o) { p.elim = true; p.ch = -1; p.rep = false; }
    g.sfx('bigexplode'); g.sfx('lose', { vol: 0.6 });
    g.shake(0.8);
  }
  const up = [];
  for (let o = 0; o < s.nb; o++) if (!s.dead[o]) up.push(o);
  if (g.ended) return;
  if (up.length <= 1) {
    const w = up.length ? up[0] : s.lastHit;
    g.slowmo(0.35, 1);
    g.end(seatOf(s, w), 'Castello raso al suolo!');
  } else if (up.length < s.nb && !s.saidFall[s.nb - up.length]) {
    s.saidFall[s.nb - up.length] = true;
    g.say('CASTELLO CADUTO!');
  }
}

// ---------------------------------------------------------------- bot
const LAG = [0.34, 0.2, 0.09];
const POW_ERR = [0.075, 0.035, 0.012];

function pickTarget(s, p, lv, B) {
  let best = -1, bc = 1e9;
  // Free-for-all: smarter bots finish off the weakest castle (fewer catapults shooting at them).
  const hp = [];
  for (let o = 0; o < s.nb; o++) hp[o] = castleHp(s, o);
  // Personal grudge per castle (breaks symmetric ties: otherwise every bot would gang up on the same seat).
  const pref = B.mem.pref || (B.mem.pref = Array.from({ length: s.nb }, () => B.rng() * 90));
  s.tw.forEach((t, k) => {
    if (t.hp <= 0 || t.o === p.o) return;
    const d = dist(p.x, p.y, t.x, t.y);
    let c;
    if (lv === 0) c = d + B.rng() * 200;
    else {
      c = t.hp * 4 + d * 0.25 + hp[t.o] * (lv === 2 ? 1.2 : 0.6) + pref[t.o];
      if (lv === 2) {
        // Splash bonus: another live enemy tower close by.
        for (const u of s.tw) if (u !== t && u.hp > 0 && u.o === t.o && dist(u.x, u.y, t.x, t.y) < 140) c -= 40;
      }
    }
    if (c < bc) { bc = c; best = k; }
  });
  return best;
}

function catBot(s, me, g, B) {
  const p = s.p[me];
  if (!p || p.elim || p.stun > 0) return { x: 0, y: 0 };
  const lv = B.level, m = B.mem, lag = LAG[lv];
  if (m.tg === undefined || !s.tw[m.tg] || s.tw[m.tg].hp <= 0 || (p.ch < 0 && p.rl <= 0 && m.pickAt !== p.k)) {
    m.tg = pickTarget(s, p, lv, B);
    m.pickAt = p.k;
  }
  const tw = s.tw[m.tg];
  if (!tw) return { x: 0, y: 0 };
  // Where the catapult will be when the shot leaves (moving carts).
  const fx = p.x + p.vx * (lag + 0.05), fy = p.y + p.vy * (lag + 0.05);
  // Aim point compensating the wind (the easy bot ignores it, the medium one half-guesses).
  const comp = [0, 0.7, 1][lv];
  let ax = tw.x, ay = tw.y, pw = 0.5;
  for (let it = 0; it < 3; it++) {
    pw = clamp((dist(fx, fy, ax, ay) - RMIN) / (RMAX - RMIN), 0, 1);
    const T = flightT(pw);
    ax = tw.x - s.wind.x * T * comp; ay = tw.y - s.wind.y * T * comp;
  }
  pw = clamp((dist(fx, fy, ax, ay) - RMIN) / (RMAX - RMIN), 0, 1);
  const a = Math.atan2(ay - fy, ax - fx);
  const out = { x: Math.cos(a), y: Math.sin(a) };
  // Repair (smarter bots) when a tower is about to fall and I am not winning.
  if (lv > 0 && p.rl <= 0 && p.ch < 0) {
    let weak = null;
    for (const t of s.tw) if (t.o === p.o && t.hp > 0 && (!weak || t.hp < weak.hp)) weak = t;
    let foe = 0;
    for (let o = 0; o < s.nb; o++) if (o !== p.o && !s.dead[o]) foe = Math.max(foe, castleHp(s, o));
    const losing = castleHp(s, p.o) <= foe + 20;
    if (weak && (m.rep ? weak.hp < 58 : weak.hp < (lv === 2 ? 26 : 20) && losing)) { m.rep = true; return { x: out.x, y: out.y, b: true }; }
    m.rep = false;
  }
  if (m.relUntil > s.t) return out; // just released: let the shot leave
  if (p.rl > 0) return out;
  if (p.ch < 0) { m.err = (B.rng() * 2 - 1) * POW_ERR[lv]; out.a = true; return out; }
  // Winding up: let go when the swinging power (as it will be once my hand reacts) matches what I need.
  const need = clamp(pw + m.err, 0.01, 0.99);
  const ph = p.ch + (lag + 1 / 60) / PERIOD;
  const v1 = meter(ph), v2 = meter(ph + 1 / 60 / PERIOD);
  if ((v1 - need) * (v2 - need) <= 0 || Math.abs(v1 - need) < 0.01) { m.relUntil = s.t + lag + 0.15; return out; }
  out.a = true;
  return out;
}

export default {
  id: 'catapulte',
  name: 'Catapulte!',
  rule: 'Mira, carica e abbatti tutte le torri nemiche!',
  verb: 'TIRA!',
  inspired: 'Worms · Angry Birds · Castle Crashers',
  cam: 'top',
  split: false,
  players: 4,
  teams: true,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Carica e tira', b: 'Ripara' },
  duration: 60,
  noMods: ['scirocco'],
  variants: [
    { id: 'vacche', name: 'Pioggia di Vacche', desc: 'Il fattore ha venduto tutto: si tirano solo vacche, che rimbalzano due volte!' },
    { id: 'uragano', name: 'Tramontana Impazzita', desc: 'Vento fortissimo che cambia ogni 5 secondi: mira controvento!' },
    { id: 'ruote', name: 'Catapulte su Ruote', desc: 'Le catapulte scorrono avanti e indietro sui binari: tempismo!' },
  ],
  help: {
    goal: "Abbatti tutte le torri del castello nemico (a squadre si vince insieme). Allo scadere vince chi ha il castello più integro.",
    dir: 'Punta la catapulta: il segno a terra mostra dove cade il colpo (senza contare il vento!)',
    a: 'TIENI PREMUTO per caricare: la forza va avanti e indietro, il segno scorre. LASCIA per tirare!',
    b: 'RIPARA (tieni premuto, a catapulta carica): il tuo mastro rattoppa la torre più malconcia',
    tips: ['Il vento sposta i colpi: guarda il mulino e la freccia sul lago', 'Vacca = rimbalza avanti · Cavoli = tre colpi · Barile = esplosione enorme', 'Colpisci la catapulta nemica per rintronarla 2 s!'],
  },

  init(g) {
    const n = g.n || 2;
    const teams = !!g.teams;
    const own = [...Array(n).keys()].map((i) => (teams ? g.teams[i] : i));
    const nb = teams ? 2 : n;
    const ang = angles(nb);
    const s = {
      t: 0, n, nb, teams, own, final: false, sid: 0, sh: [], cr: [], nc: 0, lastHit: 0, saidFall: [],
      dead: Array(nb).fill(false), dealt: Array(nb).fill(0), tw: [], p: [],
      wind: { x: 0, y: 0 }, wt: { x: 0, y: 0 }, windAt: 0, uragano: g.variant === 'uragano', ruote: g.variant === 'ruote',
    };
    for (const T of towerSpots(nb, teams)) s.tw.push({ ...T, hp: TOWER_HP, hit: 0, hk: 0 });
    const mates = Array(nb).fill(0);
    for (let i = 0; i < n; i++) {
      const o = own[i], a = ang[o], ox = Math.cos(a), oy = Math.sin(a);
      const k = mates[o]++;
      const off = teams ? (k === 0 ? -140 : 140) : 0;
      const bx = CX + ox * CAT_D - oy * off, by = CY + oy * CAT_D + ox * off;
      s.p.push({
        i, o, x: bx, y: by, bx, by, tx: -oy, ty: ox, vx: 0, vy: 0, ph: i * 1.7,
        aim: a + Math.PI, ch: -1, rl: 0.6, ammo: nextAmmo(g), stun: 0, rep: false, elim: false, k: 0, shots: 0, hits: 0, rt: 0,
      });
    }
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.t = g.t;
    if (!s.final && g.t >= FINAL_T) {
      s.final = true;
      g.say('ASSEDIO FINALE!'); g.sfx('horn'); g.shake(0.3);
    }
    // Wind: a new gust every 10 s (5 s in the hurricane), eased in.
    if (g.t >= s.windAt) {
      s.windAt += s.uragano ? 5 : 10;
      const a = g.rng.range(0, TAU), m = s.uragano ? g.rng.range(80, 140) : g.rng.range(15, 70);
      s.wt = { x: Math.cos(a) * m, y: Math.sin(a) * m };
      if (g.t > 1) { g.say(`VENTO DI ${windName(s.wt.x, s.wt.y).toUpperCase()}!`); g.sfx('whoosh', { pitch: 0.6 }); }
      else { s.wind.x = s.wt.x; s.wind.y = s.wt.y; }
    }
    const kw = Math.min(1, 1.6 * dt);
    s.wind.x += (s.wt.x - s.wind.x) * kw; s.wind.y += (s.wt.y - s.wind.y) * kw;

    for (const t of s.tw) t.hit = Math.max(0, t.hit - dt);
    for (const p of s.p) {
      const I = inp[p.i];
      if (s.ruote) {
        const off = Math.sin(g.t * 0.8 + p.ph) * 110;
        const nx = p.bx + p.tx * off, ny = p.by + p.ty * off;
        p.vx = (nx - p.x) / Math.max(dt, 1e-4); p.vy = (ny - p.y) / Math.max(dt, 1e-4);
        p.x = nx; p.y = ny;
      }
      if (p.elim) continue;
      p.rl = Math.max(0, p.rl - dt);
      if (p.stun > 0) { p.stun = Math.max(0, p.stun - dt); p.rep = false; continue; }
      const mag = Math.hypot(I.x, I.y);
      if (mag > 0.35) p.aim = Math.atan2(I.y, I.x);
      if (p.ch >= 0) {
        if (!I.a) fire(s, p, g);
        else {
          const before = meter(p.ch);
          p.ch += dt / PERIOD;
          if (meter(p.ch) > 0.97 && before <= 0.97) g.sfx('tick', { pitch: 1.6, vol: 0.4 });
        }
        p.rep = false;
      } else if (I.aP && p.rl <= 0) {
        p.ch = 0; p.rep = false;
        g.sfx('wobble', { vol: 0.5 });
      } else if (I.b && p.rl <= 0) {
        // Repair the weakest standing tower of my castle.
        let weak = null;
        for (const t of s.tw) if (t.o === p.o && t.hp > 0 && t.hp < TOWER_HP && (!weak || t.hp < weak.hp)) weak = t;
        p.rep = !!weak;
        if (weak) {
          weak.hp = Math.min(TOWER_HP, weak.hp + REPAIR * dt);
          p.rt += dt;
          if (p.rt > 0.45) { p.rt = 0; g.sfx('stack', { vol: 0.5, pitch: 1.2 }); g.burst(weak.x, weak.y, { color: '#e8d6b0', n: 4, speed: 100 }); }
        }
      } else p.rep = false;
    }

    // Projectiles in flight.
    for (let k = s.sh.length - 1; k >= 0; k--) {
      const sh = s.sh[k];
      sh.u += dt / sh.T;
      if (sh.u < 1) continue;
      s.sh.splice(k, 1);
      if (!g.ended) {
        s.lastHit = sh.o;
        impact(s, sh, g);
        checkCastles(s, g);
      }
    }
  },

  timeout(s, g) {
    // The most intact castle; tie: who dealt more damage, then luck.
    let best = [], bk = null;
    for (let o = 0; o < s.nb; o++) {
      if (s.dead[o]) continue;
      const k = [Math.round(castleHp(s, o)), Math.round(s.dealt[o])];
      const c = bk ? Math.sign(k[0] - bk[0]) || Math.sign(k[1] - bk[1]) : 1;
      if (c > 0) { best = [o]; bk = k; } else if (c === 0) best.push(o);
    }
    if (!best.length) best = [0];
    const o = best.length > 1 ? best[g.rng.int(0, best.length - 1)] : best[0];
    return seatOf(s, o);
  },

  bot: catBot,

  view(s) {
    const tpc = s.teams ? T5.length : T3.length;
    return {
      nb: s.nb, tm: s.teams ? 1 : 0, fa: s.final ? 1 : 0, w: [r1(s.wind.x), r1(s.wind.y)], nc: s.nc,
      tw: s.tw.map((t) => ({ x: r1(t.x), y: r1(t.y), o: t.o, hp: Math.ceil(t.hp), h: r2(t.hit), a: r2(t.a) })),
      p: s.p.map((p) => ({
        x: r1(p.x), y: r1(p.y), o: p.o, a: r2(p.aim), ch: p.ch >= 0 ? r2(meter(p.ch)) : -1, rl: r2(p.rl), am: p.ammo,
        st: r2(p.stun), rp: p.rep ? 1 : 0, e: p.elim ? 1 : 0, k: p.k % 16,
      })),
      s: s.sh.map((sh) => {
        const u = Math.min(1, sh.u);
        return {
          x: r1(sh.x0 + (sh.x1 - sh.x0) * u), y: r1(sh.y0 + (sh.y1 - sh.y0) * u), h: r1((sh.bo ? 0 : LAUNCH_H * (1 - u)) + 4 * sh.hm * u * (1 - u)),
          k: sh.k, u: r2(u), x1: r1(sh.x1), y1: r1(sh.y1), v: sh.main || u > 0.45 ? 1 : 0, id: sh.grp % 64, o: sh.o,
        };
      }),
      cr: s.cr,
      hud: {
        p: s.p.map((p) => s.tw.filter((t) => t.o === p.o && t.hp > 0).length),
        max: tpc, label: 'Torri',
        bar: s.p.map((p) => r2(castleHp(s, p.o) / (tpc * TOWER_HP))),
      },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  // 3D: "La Valle del Mulino nella Tempesta" — castles around a stormy lake with a windmill islet that turns into the
  // wind; clouds and leaves fly with the wind, lightning flashes, homemade wooden catapults with swinging arms.
  render3d: {
    assets: [
      'medieval/building_tower_A_red', 'medieval/building_tower_B_red', 'medieval/building_tower_A_blue', 'medieval/building_tower_B_blue',
      'medieval/building_tower_A_green', 'medieval/building_tower_B_green', 'medieval/building_tower_A_yellow', 'medieval/building_tower_B_yellow',
      'medieval/wall_straight', 'medieval/projectile_catapult', 'medieval/barrel', 'medieval/cloud_big', 'medieval/cloud_small',
      'dungeon/rubble_large', 'medieval/rock_single_A', 'medieval/rock_single_C', 'medieval/rock_single_E',
      'medieval/trees_A_large', 'medieval/trees_B_large', 'medieval/tree_single_A', 'medieval/tree_single_B', 'medieval/trees_A_medium',
      'medieval/hills_A_trees', 'medieval/hills_C_trees', 'medieval/mountain_B_grass_trees', 'medieval/mountain_A_grass',
      'medieval/building_home_A_green', 'medieval/building_home_B_yellow', 'medieval/building_church_blue', 'medieval/building_windmill_yellow',
      'medieval/building_well_green', 'medieval/building_grain', 'medieval/fence_wood_straight', 'medieval/sack', 'medieval/crate_A_big',
      'medieval/waterlily_A', 'medieval/waterplant_B', 'medieval/resource_lumber', 'medieval/resource_stone', 'medieval/crate_open',
    ],
    build(K, r) {
      const THREE = K.THREE;
      const n = Math.max(2, r.n || K.n || 2);
      const lo = K.quality === 0;
      K.theme('tempesta', { fogNear: 1.9, fogFar: 5.2 });
      const o = { n, ready: false, hemiBase: K.hemi.intensity, sunBase: K.sun.intensity };
      K.ground('prato', { tile: 230, margin: 2400, color: '#b4c99a' });
      // Castle courtyards and roads (need the layout of the view: painted at the first update).
      K.layer({ x0: -260, y0: -260, x1: W + 260, y1: H + 260, h: 0.4, transparent: true, once: true, draw: (d, v) => drawValley(d, v) });
      // Scorch marks where the shots landed (repainted only when a new one appears).
      K.layer({ x0: -200, y0: -200, x1: W + 200, y1: H + 200, h: 0.9, transparent: true, z: 1, maxPx: 1024, key: (v) => `${v.nc}`, draw: (d, v) => drawCraters(d, v) });

      // Lake with an islet and the windmill.
      const wtex = K.tex('acqua', { rep: [3, 3], seed: 5 });
      const wmap = wtex && wtex.clone ? wtex.clone() : null;
      if (wmap) { wmap.needsUpdate = true; wmap.wrapS = wmap.wrapT = THREE.RepeatWrapping; wmap.repeat.set(3, 3); }
      o.wmap = wmap;
      const lake = K.mesh(new THREE.CircleGeometry(LAKE_R, 56).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: wmap, color: '#bfe3ff', roughness: 0.12, metalness: 0.15, emissive: '#0a3a5a', emissiveIntensity: 0.3 }), { cast: false });
      lake.userData.ownGeo = true;
      K.place(lake, CX, CY, 2);
      K.place(K.cyl(ISLE_R, 8, K.texMat('erba', [2, 2], { color: '#9fc27a' }), { seg: 28 }), CX, CY);
      K.place(K.cyl(ISLE_R + 6, 4, K.texMat('sabbia', [2, 2]), { seg: 28, cast: false }), CX, CY);
      K.scatter('medieval/waterlily_A', [[CX - 95, CY + 60], [CX + 105, CY - 40], [CX + 40, CY + 110], [CX - 60, CY - 100], [CX + 115, CY + 55]].map(([x, y], k) => ({ x, y, h: 2, rot: k })), { size: 26 });
      K.scatter('medieval/waterplant_B', [[CX - 140, CY + 30], [CX + 135, CY - 70], [CX - 30, CY + 140], [CX + 80, CY - 128]].map(([x, y], k) => ({ x, y, rot: k })), { size: 36 });
      const mill = K.group();
      K.place(mill, CX, CY, 8);
      K.cyl(17, 92, K.texMat('muro', [2, 2], { color: '#efe4cf' }), { parent: mill, r2: 25, seg: 16 });
      const roof = K.cone(24, 34, K.texMat('tetto', [2, 1], { color: '#c86a4a' }), { parent: mill, seg: 16 });
      roof.position.y = 90;
      const door = K.box(4, 14, 22, K.mat('#5a3b22'), { parent: mill, cast: false });
      door.position.set(23, 11, 0);
      o.head = K.group(mill);
      o.head.position.y = 100;
      const hub = K.cyl(6, 16, K.mat('#5a3b22'), { parent: o.head, center: true, seg: 10 });
      hub.rotation.z = Math.PI / 2; hub.position.x = 26;
      o.blades = K.group(o.head);
      o.blades.position.x = 34;
      const armM = K.mat('#6b4a2a', { rough: 0.8 }), sailM = K.mat('#f3ead6', { rough: 0.9, side: 2 });
      for (let k = 0; k < 4; k++) {
        const arm = K.group(o.blades);
        arm.rotation.x = (k * Math.PI) / 2;
        const a = K.box(3, 4, 78, armM, { parent: arm });
        a.position.y = 39;
        const sail = K.box(1.5, 22, 50, sailM, { parent: arm, cast: false });
        sail.position.set(0, 50, 12);
      }
      // Wind arrow floating on the water.
      o.arrow = K.group();
      const arM = K.glow('#ffffff', { opacity: 0.75 });
      o.shaft = K.box(1, 14, 3, arM, { parent: o.arrow, cast: false });
      o.tip = K.prism([0, -26, 34, 0, 0, 26], 3, arM, { parent: o.arrow, cast: false });

      // Castles: tower models of both possible layouts (teams 2 × 5 / free-for-all n × 3), the right one shown at the first update.
      const towerSet = (teams) => {
        const nb = teams ? 2 : n;
        const g = K.group();
        const spots = towerSpots(nb, teams);
        const list = spots.map((T, k) => {
          const color = teams ? ['red', 'blue'][T.o] : FLAGS[K.roster[T.o]?.color ?? T.o] || 'red';
          const tall = k % 2 === 0;
          const h = tall ? 150 : 128;
          const m = K.model(`medieval/building_tower_${tall ? 'A' : 'B'}_${color}`, { height: h, parent: g });
          K.place(m, T.x, T.y);
          K.face(m, T.a + Math.PI);
          const ruin = K.model('dungeon/rubble_large', { size: 96, parent: g });
          K.place(ruin, T.x, T.y);
          ruin.visible = false;
          const bar = K.billboard(160, 30, 84, (d, w, hh, hp) => drawBar(d, w, hh, hp ?? TOWER_HP), { parent: g });
          K.place(bar, T.x, T.y, h + 26);
          const smoke = [0, 1, 2].map(() => K.ball(1, K.mat('#9a948c', { opacity: 0.38, rough: 1 }), { cast: false, parent: g, seg: 12 }));
          const fire = [0, 1].map((j) => K.cone(1, 1, K.glow(j ? '#ffd23f' : '#ff6a1e', { add: true }), { cast: false, parent: g }));
          return { m, ruin, bar, smoke, fire, x: T.x, y: T.y, a: T.a, h, hp: TOWER_HP, sh: 0 };
        });
        // Curtain walls between neighbouring towers of the same castle.
        const walls = [];
        for (let k = 1; k < spots.length; k++) {
          const A = spots[k - 1], B = spots[k];
          if (A.o === B.o) walls.push({ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, rot: A.a + Math.PI / 2 });
        }
        K.scatter('medieval/wall_straight', walls, { size: 112, parent: g });
        // Ammo piles at both ends of every castle: stones, cabbage crates, hay sacks, kegs.
        const stones = [], crates = [], sacks = [], kegs = [];
        angles(nb).forEach((a) => {
          const ox = Math.cos(a), oy = Math.sin(a), tx = -oy, ty = ox, half = (teams ? 250 : 125) + 92;
          for (const sd of [-1, 1]) {
            const x = CX + ox * (CASTLE_D - 30) + tx * half * sd, y = CY + oy * (CASTLE_D - 30) + ty * half * sd;
            stones.push({ x, y, rot: a });
            crates.push({ x: x - ox * 50, y: y - oy * 50, rot: a + 0.3 });
            sacks.push({ x: x + tx * sd * 34, y: y + ty * sd * 34, rot: a });
            kegs.push({ x: x - ox * 50 + tx * sd * 40, y: y - oy * 50 + ty * sd * 40, rot: a });
          }
        });
        K.scatter('medieval/resource_stone', stones, { size: 70, parent: g });
        K.scatter('medieval/crate_open', crates, { size: 44, parent: g });
        K.scatter('medieval/sack', sacks, { size: 36, parent: g });
        K.scatter('medieval/barrel', kegs, { size: 34, parent: g });
        return { g, list };
      };
      o.sets = [towerSet(false)];
      if (n === 4) o.sets.push(towerSet(true));

      // Catapults (one per player) with the crew next to them.
      const wood = K.texMat('legno', [1, 1], { color: '#b07a48' });
      const dark = K.mat('#5a3b22', { rough: 0.8 });
      const iron = K.mat('#4b4f57', { rough: 0.4, metal: 0.6 });
      o.cat = [...Array(n).keys()].map((i) => {
        const g = K.group();
        const body = K.group(g);
        for (const z of [-24, 24]) { const b = K.box(96, 8, 10, wood, { parent: body }); b.position.set(0, 18, z); }
        for (const x of [-36, 30]) { const b = K.box(8, 56, 8, wood, { parent: body, cast: false }); b.position.set(x, 19, 0); }
        for (const [x, z] of [[-30, -30], [30, -30], [-30, 30], [30, 30]]) {
          const wh = K.cyl(14, 6, dark, { parent: body, center: true, seg: 14, cast: false });
          wh.rotation.x = Math.PI / 2; wh.position.set(x, 14, z);
        }
        // Uprights and the padded stop bar (team color).
        for (const z of [-20, 20]) { const u = K.box(8, 8, 46, wood, { parent: body }); u.position.set(12, 44, z); u.rotation.z = -0.15; }
        const stop = K.cyl(5, 50, K.mat(K.col(i, 'main'), { rough: 0.6 }), { parent: body, center: true, seg: 10, cast: false });
        stop.rotation.x = Math.PI / 2; stop.position.set(16, 66, 0);
        const winch = K.cyl(7, 44, iron, { parent: body, center: true, seg: 10, cast: false });
        winch.rotation.x = Math.PI / 2; winch.position.set(-40, 30, 0);
        // The throwing arm (pivot at the axle).
        const pivot = K.group(body);
        pivot.position.set(-6, 26, 0);
        const arm = K.box(84, 7, 9, wood, { parent: pivot });
        arm.position.x = 42;
        const bucket = K.group(pivot);
        bucket.position.x = 84;
        const cup = K.cyl(13, 9, dark, { parent: bucket, seg: 12, cast: false });
        cup.position.y = -2;
        const ammo = AMMO_EMOJI.map((ch) => { const sp = K.emoji(ch, 34, { parent: bucket }); sp.position.y = 18; return sp; });
        const flag = K.box(26, 2, 18, K.mat(K.col(i, 'main'), { rough: 0.6 }), { parent: body, cast: false });
        flag.position.set(-40, 62, -22);
        const fpole = K.cyl(1.6, 52, dark, { parent: body, seg: 6, cast: false });
        fpole.position.set(-52, 18, -22);
        const dots = [...Array(12)].map(() => K.ball(5, K.glow(K.col(i, 'light'), { opacity: 0.85 }), { cast: false, seg: 8 }));
        const mark = K.disc(32, K.glow(K.col(i, 'main'), { opacity: 0.85 }), { r0: 24, seg: 36 });
        const markIn = K.disc(10, K.glow(K.col(i, 'light'), { opacity: 0.85 }), { seg: 16 });
        const smoke = [0, 1, 2].map(() => K.ball(1, K.mat('#7d7873', { opacity: 0.4, rough: 1 }), { cast: false, seg: 12 }));
        const stars = K.emoji('💫', 40);
        return {
          g, body, pivot, ammo, flag, dots, mark, markIn, smoke, stars, dec: K.decal(240),
          av: K.avatar(i), cx: null, cy: null, fireT: -9, lastK: null,
        };
      });

      // Projectiles: spiked rocks, cows, cabbages, powder kegs (+ shadows and landing warnings).
      o.pool = [[], [], [], []];
      for (let k = 0; k < 10; k++) { const m = K.model('medieval/projectile_catapult', { height: 34 }); m.visible = false; o.pool[ROCK].push(m); }
      for (let k = 0; k < 10; k++) o.pool[COW].push(makeCow(K));
      const cabM = K.mat('#7ed957', { rough: 0.6 }), cabD = K.mat('#4f9e34', { rough: 0.7 });
      for (let k = 0; k < 18; k++) {
        const g = K.group();
        const b = K.ball(14, cabM, { parent: g, seg: 14 });
        K.outline(b, '#2a5a1c', 0.08);
        for (let j = 0; j < 3; j++) { const l = K.ball(9, cabD, { parent: g, seg: 10 }); l.position.set(Math.cos(j * 2.1) * 10, -4, Math.sin(j * 2.1) * 10); l.scale.set(1, 0.5, 1); }
        g.visible = false;
        o.pool[CABBAGE].push(g);
      }
      for (let k = 0; k < 6; k++) {
        const g = K.group();
        K.model('medieval/barrel', { height: 36, parent: g }).position.y = -18;
        const spark = K.ball(6, K.glow('#ffd23f', { add: true }), { parent: g, cast: false, seg: 8 });
        spark.position.y = 22;
        g.visible = false;
        o.pool[KEG].push(g);
      }
      o.blobs = [...Array(24)].map(() => K.blob(1, { always: true }));
      o.warn = [...Array(24)].map(() => K.disc(1, K.glow('#ff3b3b', { unique: true, opacity: 0.6 }), { r0: 0.82, seg: 40 }));

      // Wind-blown leaves (one draw call).
      const NL = lo ? 40 : 90;
      const pos = new Float32Array(NL * 3);
      const seed = [];
      for (let k = 0; k < NL; k++) { pos[k * 3] = -200 + ((k * 397) % 1400); pos[k * 3 + 1] = 20 + ((k * 151) % 260); pos[k * 3 + 2] = -200 + ((k * 631) % 1400); seed.push(k * 1.37); }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const leaves = new THREE.Points(lg, new THREE.PointsMaterial({ color: '#e3d27a', size: 11, map: K.dotTex(), transparent: true, depthWrite: false, opacity: 0.9 }));
      leaves.userData.ownGeo = true;
      leaves.frustumCulled = false;
      K.root.add(leaves);
      o.leaves = { pos, seed, lg, n: NL };
      // Clouds drifting with the wind, far over the hills.
      o.clouds = [];
      for (let k = 0; k < (lo ? 4 : 7); k++) {
        const c = K.model(k % 2 ? 'medieval/cloud_small' : 'medieval/cloud_big', { size: 260 + (k % 3) * 90, cast: false });
        o.clouds.push({ c, x: -900 + k * 430, y: -520 - (k % 3) * 260, h: 420 + (k % 4) * 70 });
      }
      buildValley(K, lo);
      return o;
    },

    update(K, o, v, r) {
      const t = K.t, dt = Math.min(0.1, K.dt || 0);
      if (!o.ready) {
        o.ready = true;
        o.sets.forEach((S, k) => { S.g.visible = (k === 1) === !!v.tm; });
        o.set = o.sets[v.tm && o.sets[1] ? 1 : 0];
      }
      const wx = v.w[0], wy = v.w[1], wl = Math.hypot(wx, wy), wa = Math.atan2(wy, wx);
      // Storm light: a double lightning flash every few seconds.
      const ph = t % 8.7;
      const flash = ph < 0.08 || (ph > 0.16 && ph < 0.22);
      K.hemi.intensity = o.hemiBase * (flash ? 2.3 : 1);
      K.sun.intensity = o.sunBase * (flash ? 1.8 : 1);
      if (o.wmap) { o.wmap.offset.x = (t * 0.01 + wx * t * 0.0004) % 1; o.wmap.offset.y = (t * 0.013 + wy * t * 0.0004) % 1; }
      // Windmill: the sails face the wind and spin with its strength.
      K.face(o.head, wa + Math.PI);
      o.blades.rotation.x += dt * (0.6 + wl * 0.05);
      o.arrow.visible = wl > 3;
      K.place(o.arrow, CX, CY, 6);
      K.face(o.arrow, wa);
      const L = Math.min(135, 50 + wl * 0.8);
      o.shaft.scale.set(L * 2 - 30, 1, 1);
      o.shaft.position.x = -15;
      o.tip.position.x = L - 30;
      // Leaves and clouds fly with the wind.
      const P = o.leaves;
      for (let k = 0; k < P.n; k++) {
        const i3 = k * 3, sd = P.seed[k];
        P.pos[i3] += (wx * 2.2 + Math.sin(t * 1.3 + sd) * 30) * dt;
        P.pos[i3 + 2] += (wy * 2.2 + Math.cos(t * 1.1 + sd) * 30) * dt;
        P.pos[i3 + 1] += Math.sin(t * 2 + sd) * 20 * dt - 8 * dt;
        if (P.pos[i3] < -250) P.pos[i3] += 1500; else if (P.pos[i3] > 1250) P.pos[i3] -= 1500;
        if (P.pos[i3 + 2] < -250) P.pos[i3 + 2] += 1500; else if (P.pos[i3 + 2] > 1250) P.pos[i3 + 2] -= 1500;
        if (P.pos[i3 + 1] < 10) P.pos[i3 + 1] = 280;
      }
      P.lg.attributes.position.needsUpdate = true;
      for (const C of o.clouds) {
        C.x += wx * 1.5 * dt; C.y += wy * 0.4 * dt;
        if (C.x > 2200) C.x -= 3400; else if (C.x < -1200) C.x += 3400;
        C.y = clamp(C.y, -1300, -350);
        K.place(C.c, C.x, C.y, C.h);
      }
      // Towers: damage shake, smoke, fire, rubble, health bars.
      v.tw.forEach((T, k) => {
        const S = o.set.list[k];
        if (!S) return;
        const dead = T.hp <= 0;
        S.m.visible = !dead; S.ruin.visible = dead; S.bar.visible = !dead && T.hp < TOWER_HP; // bar only once damaged
        if (T.hp !== S.hp) { if (T.hp < S.hp) S.sh = 0.4; S.hp = T.hp; S.bar.redraw(T.hp); }
        S.sh = Math.max(0, S.sh - dt);
        const jx = S.sh > 0 ? (Math.sin(t * 70) * 5 * S.sh) / 0.4 : 0;
        K.place(S.m, S.x + jx, S.y);
        const frac = T.hp / TOWER_HP;
        S.smoke.forEach((b, j) => {
          b.visible = (frac < 0.55 && !dead) || (dead && j < 2);
          if (!b.visible) return;
          const q = (t * 0.45 + j / 3) % 1;
          K.place(b, S.x + Math.sin(t + j * 2) * 10 + wx * q * 0.8, S.y + wy * q * 0.8, (dead ? 30 : S.h * 0.8) + q * 130);
          b.scale.setScalar(8 + q * 18);
        });
        S.fire.forEach((f, j) => {
          f.visible = frac < 0.3 && !dead;
          if (!f.visible) return;
          K.place(f, S.x + (j ? 8 : -6), S.y + (j ? -4 : 6), S.h * 0.62);
          f.scale.set(14 - j * 4, 30 + Math.sin(t * 18 + j) * 8, 14 - j * 4);
        });
      });
      // Catapults and crews.
      const bestHp = r.ended ? Math.max(...v.hud.bar) : -1;
      v.p.forEach((p, i) => {
        const C = o.cat[i];
        if (!C) return;
        K.place(C.g, p.x, p.y);
        K.face(C.g, p.a);
        if (C.lastK === null) C.lastK = p.k;
        if (p.k !== C.lastK) { C.lastK = p.k; C.fireT = t; }
        // Arm: lies back while loading, pulled lower while winding up, whips to the stop bar when fired.
        const rest = Math.PI - 0.35;
        let th;
        const since = t - C.fireT;
        if (since < 0.12) th = rest + (1.25 - rest) * (since / 0.12);
        else if (p.rl > 0) th = 1.25 + (rest - 1.25) * clamp(1 - p.rl / RELOAD, 0, 1);
        else th = rest + (p.ch >= 0 ? 0.28 * p.ch : 0);
        if (p.e) th = 0.6;
        C.pivot.rotation.z = th;
        C.body.rotation.z = p.e ? 0.25 : 0;
        const loaded = p.rl <= 0 && !p.e && since > 0.12;
        C.ammo.forEach((sp, k) => { sp.visible = loaded && k === p.am; });
        C.flag.rotation.y = Math.sin(t * 6) * 0.3 * Math.min(1, wl / 50);
        // Aim preview while winding up: dotted arc + landing mark (the wind is NOT included!).
        const show = p.ch >= 0 && !p.e;
        const ax = Math.cos(p.a), ay = Math.sin(p.a);
        const R = show ? rangeOf(p.ch) : 0, hm = peakH(Math.max(0, p.ch));
        C.dots.forEach((b, k) => {
          b.visible = show;
          if (!show) return;
          const u = (k + 1) / 13;
          K.place(b, p.x + ax * R * u, p.y + ay * R * u, LAUNCH_H * (1 - u) + 4 * hm * u * (1 - u));
        });
        C.mark.visible = C.markIn.visible = show;
        if (show) {
          K.place(C.mark, p.x + ax * R, p.y + ay * R, 3);
          K.place(C.markIn, p.x + ax * R, p.y + ay * R, 3.2);
          C.mark.scale.setScalar(1 + Math.sin(t * 12) * 0.08);
        }
        // Stunned / out of the game: smoke and stars.
        C.stars.visible = p.st > 0 && !p.e;
        if (C.stars.visible) K.place(C.stars, p.x, p.y, 110 + Math.sin(t * 7) * 6);
        C.smoke.forEach((b, j) => {
          b.visible = p.st > 0 || !!p.e;
          if (!b.visible) return;
          const q = (t * 0.6 + j / 3) % 1;
          K.place(b, p.x + Math.sin(t * 2 + j) * 8, p.y, 40 + q * 120);
          b.scale.setScalar(8 + q * 20);
        });
        C.dec.show(!p.e).at(p.x, p.y, 1.2).paint((d) => {
          const lt = K.col(i, 'light');
          if (!show) {
            const a0 = 56, a1 = 110;
            d.line(ax * a0, ay * a0, ax * a1, ay * a1, lt + 'cc', 8);
            d.poly([ax * (a1 + 18), ay * (a1 + 18), ax * a1 - ay * 13, ay * a1 + ax * 13, ax * a1 + ay * 13, ay * a1 - ax * 13], lt + 'ee');
          }
          if (p.rl > 0) d.arc(0, 0, 50, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.rl / RELOAD), lt + 'aa', 7);
          else d.ring(0, 0, 50, lt + (show ? '55' : 'cc'), 5);
        });
        // Crew: next to the catapult; runs to the weakest tower to patch it up.
        let tx = p.x - ay * 56 - ax * 10, ty = p.y + ax * 56 - ay * 10, look = p.a;
        if (p.rp) {
          let weak = null;
          for (const T of v.tw) if (T.o === p.o && T.hp > 0 && T.hp < TOWER_HP && (!weak || T.hp < weak.hp)) weak = T;
          if (weak) { const dx = CX - weak.x, dy = CY - weak.y, dl = Math.hypot(dx, dy) || 1; tx = weak.x + (dx / dl) * 62; ty = weak.y + (dy / dl) * 62; look = Math.atan2(-dy, -dx); }
        }
        if (C.cx === null) { C.cx = tx; C.cy = ty; }
        const ddx = tx - C.cx, ddy = ty - C.cy, dd = Math.hypot(ddx, ddy);
        const stp = Math.min(dd, 420 * dt);
        if (dd > 0.5) { C.cx += (ddx / dd) * stp; C.cy += (ddy / dd) * stp; }
        const walking = dd > 4;
        let anim, animKey, mood = 'ok';
        if (p.e) { anim = 'Sit_Floor_Idle'; mood = 'hurt'; }
        else if (p.st > 0) { anim = 'Hit_B'; mood = 'dizzy'; }
        else if (walking) anim = 'Running_A';
        else if (since < 0.5) { anim = 'Throw'; animKey = p.k; }
        else if (p.rp) { anim = '1H_Melee_Attack_Chop'; animKey = Math.floor(t / 0.75); }
        else if (p.ch >= 0) anim = 'Interact';
        if (r.ended && !p.e) { const win = v.hud.bar[i] >= bestHp - 0.001; mood = win ? 'happy' : 'hurt'; anim = win ? 'Cheer' : 'Sit_Floor_Idle'; }
        C.av.set(C.cx, C.cy, { r: 34, look: walking ? Math.atan2(ddy, ddx) : look, mood, anim, animKey, walk: walking ? 0.8 : 0, alpha: p.e ? 0.5 : 1, gear: !!p.rp });
      });
      // Shots.
      const used = [0, 0, 0, 0];
      let nb = 0;
      for (const s of v.s) {
        if (!s.v) continue;
        const pool = o.pool[s.k];
        const m = pool && pool[used[s.k]++];
        if (m) {
          m.visible = true;
          K.place(m, s.x, s.y, s.h + 14);
          if (s.k === COW) { m.rotation.set(0, 0, 0); K.face(m, Math.atan2(s.y1 - s.y, s.x1 - s.x)); m.rotation.z = t * 5 + s.id; }
          else m.rotation.set(t * 6 + s.id, t * 4 + s.id * 0.7, 0);
        }
        const b = o.blobs[nb], w = o.warn[nb];
        nb++;
        if (b) { b.visible = true; K.place(b, s.x, s.y, 1.5); const k = 1 / (1 + s.h / 160); b.scale.set(20 * k, 1, 20 * k); b.material.opacity = 0.6 * k; }
        if (w) {
          w.visible = s.u > 0.45;
          if (w.visible) {
            K.place(w, s.x1, s.y1, 1.6);
            w.scale.setScalar(BLAST[s.k] * (1.1 - (s.u - 0.45) * 0.5));
            w.material.opacity = 0.35 + 0.4 * (Math.sin(t * (10 + s.u * 20)) > 0 ? 1 : 0);
          }
        }
      }
      for (let k = 0; k < 4; k++) for (let j = used[k]; j < o.pool[k].length; j++) o.pool[k][j].visible = false;
      for (let j = nb; j < o.blobs.length; j++) { o.blobs[j].visible = false; o.warn[j].visible = false; }
    },
  },

  render(d, v, r) {
    const ocol = (o) => (v.tm ? TEAM_COL[o] : d.col(o));
    d.rect(-400, -400, W + 800, H + 800, '#5b7f45');
    // Lake with the windmill islet.
    d.circle(CX, CY, LAKE_R + 14, '#d8c690');
    d.circle(CX, CY, LAKE_R, '#3f8fc0');
    d.circle(CX, CY, ISLE_R, '#7aa155', '#d8c690', 6);
    // Wind arrow on the lake.
    const wl = Math.hypot(v.w[0], v.w[1]);
    if (wl > 2) {
      const ux = v.w[0] / wl, uy = v.w[1] / wl, L = 40 + wl * 0.9;
      d.line(CX - ux * L, CY - uy * L, CX + ux * L, CY + uy * L, '#ffffff', 10);
      d.poly([CX + ux * (L + 26), CY + uy * (L + 26), CX + ux * L - uy * 20, CY + uy * L + ux * 20, CX + ux * L + uy * 20, CY + uy * L - ux * 20], '#ffffff');
    }
    for (const c of v.cr) d.circle(c[0], c[1], c[2] ? 40 : 26, 'rgba(50,36,24,0.45)');
    // Towers.
    for (const t of v.tw) {
      if (t.hp <= 0) { d.circle(t.x, t.y, TOWER_R, '#7d756a'); continue; }
      const sh = t.h > 0 ? Math.sin(d.t * 60) * 4 : 0;
      d.shadow(t.x + 8, t.y + 10, TOWER_R, TOWER_R * 0.8, 0.35);
      d.circle(t.x + sh, t.y, TOWER_R, '#bdb2a0', '#5d554a', 5);
      d.circle(t.x + sh, t.y, TOWER_R * 0.6, ocol(t.o));
      d.rect(t.x - 36, t.y - TOWER_R - 22, 72, 10, '#2a2018');
      d.rect(t.x - 36, t.y - TOWER_R - 22, 72 * (t.hp / TOWER_HP), 10, t.hp > 40 ? '#7ed957' : t.hp > 20 ? '#ffc53d' : '#ff4b4b');
    }
    // Catapults, aim lines and crews.
    v.p.forEach((p, i) => {
      const ax = Math.cos(p.a), ay = Math.sin(p.a);
      if (!p.e) {
        if (p.ch >= 0) {
          const R = rangeOf(p.ch);
          for (let k = 1; k <= 10; k++) d.circle(p.x + ax * R * (k / 10), p.y + ay * R * (k / 10), 5, d.col(i, 'light') + 'aa');
          d.ring(p.x + ax * R, p.y + ay * R, 30, d.col(i, 'light'), 5);
        } else d.line(p.x, p.y, p.x + ax * 90, p.y + ay * 90, d.col(i, 'light') + '99', 6);
      }
      d.rrect(p.x - 34, p.y - 26, 68, 52, 10, p.e ? '#4a3a2a' : '#8a5a32', '#3a2414', 4);
      if (!p.e && p.rl <= 0) d.emoji(AMMO_EMOJI[p.am], p.x + ax * 22, p.y + ay * 22, 34);
      d.avatar(p.x - ay * 50, p.y + ax * 50, 26, i, { look: p.a, mood: p.e ? 'dead' : p.st > 0 ? 'dizzy' : p.rp ? 'angry' : 'ok', alpha: p.e ? 0.45 : 1 });
      if (p.st > 0) d.emoji('💫', p.x, p.y - 50, 34);
      if (p.rl > 0 && !p.e) d.arc(p.x, p.y, 44, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.rl / RELOAD), d.col(i, 'light'), 5);
    });
    // Shots: shadow on the ground + the projectile up in the air.
    for (const s of v.s) {
      if (!s.v) continue;
      if (s.u > 0.5) d.ring(s.x1, s.y1, BLAST[s.k] * 0.6, 'rgba(255,60,60,0.6)', 3);
      d.shadow(s.x, s.y, 16, 7, 0.4);
      d.emoji(AMMO_EMOJI[s.k], s.x, s.y - s.h * 0.6, s.k === KEG ? 46 : 40);
    }
  },
};

// ---------------------------------------------------------------- 3D helpers
function drawBar(d, w, h, hp) {
  const f = clamp(hp / TOWER_HP, 0, 1);
  d.rrect(2, 2, w - 4, h - 4, 8, 'rgba(25,16,10,0.85)');
  if (f > 0) d.rrect(6, 6, (w - 12) * f, h - 12, 5, f > 0.5 ? '#7ed957' : f > 0.25 ? '#ffc53d' : '#ff4b4b');
}

// A flying cow: white body with black patches, pink snout, horns, legs.
function makeCow(K) {
  const g = K.group();
  const white = K.mat('#f7f3ea', { rough: 0.6 }), black = K.mat('#2a2522', { rough: 0.6 }), pink = K.mat('#ffaec0', { rough: 0.5 }), horn = K.mat('#efe0b8', { rough: 0.4 });
  const body = K.ball(1, white, { parent: g });
  body.scale.set(24, 15, 15);
  for (const [x, y, z, s] of [[6, 8, 9, 7], [-10, 4, -10, 8], [-4, 12, -2, 6]]) { const p = K.ball(s, black, { parent: g, cast: false, seg: 10 }); p.position.set(x, y, z); p.scale.y = 0.45; }
  const head = K.ball(11, white, { parent: g, seg: 14 });
  head.position.set(26, 7, 0);
  const snout = K.ball(7, pink, { parent: g, seg: 10 });
  snout.position.set(34, 3, 0); snout.scale.set(0.8, 0.7, 1.1);
  for (const z of [-1, 1]) {
    const h = K.cone(2.4, 9, horn, { parent: g, seg: 8 });
    h.position.set(25, 15, z * 7); h.rotation.x = z * 0.6;
    const eye = K.ball(2, black, { parent: g, cast: false, seg: 8 });
    eye.position.set(33, 11, z * 5);
  }
  for (const [x, z] of [[12, 8], [12, -8], [-12, 8], [-12, -8]]) { const l = K.cyl(3.2, 16, white, { parent: g, seg: 8 }); l.position.set(x, 8, z); }
  const tail = K.cyl(1.4, 14, black, { parent: g, seg: 6 });
  tail.position.set(-24, 4, 0); tail.rotation.z = 1.1;
  g.visible = false;
  return g;
}

// Valley floor: stone courtyards under every castle, dirt roads from the castles to the lake, sandy shore.
function drawValley(d, v) {
  const { ctx } = d;
  let seed = 4321;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const nb = v.nb, teams = !!v.tm;
  // Meadow variety: darker patches and tiny flowers.
  for (let k = 0; k < 60; k++) {
    const x = -240 + rnd() * (W + 480), y = -240 + rnd() * (H + 480);
    d.circle(x, y, 30 + rnd() * 60, `rgba(${60 + Math.floor(rnd() * 30)},${90 + Math.floor(rnd() * 30)},40,0.18)`);
  }
  const FL = ['#fff6d0', '#ffd23f', '#ff9ec4', '#c9b6ff'];
  for (let k = 0; k < 420; k++) d.circle(-240 + rnd() * (W + 480), -240 + rnd() * (H + 480), 2.5 + rnd() * 2.5, FL[k % 4]);
  const g = ctx.createRadialGradient(CX, CY, LAKE_R - 10, CX, CY, LAKE_R + 70);
  g.addColorStop(0, 'rgba(190,170,120,0.9)'); g.addColorStop(1, 'rgba(190,170,120,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(CX, CY, LAKE_R + 70, 0, TAU); ctx.fill();
  angles(nb).forEach((a) => {
    const ox = Math.cos(a), oy = Math.sin(a), tx = -oy, ty = ox;
    const half = teams ? 320 : 190;
    for (let k = 0; k < 40; k++) {
      const u = rnd(), rr = LAKE_R + 40 + u * (CASTLE_D - LAKE_R - 60);
      const x = CX + ox * rr + tx * (rnd() - 0.5) * 70, y = CY + oy * rr + ty * (rnd() - 0.5) * 70;
      d.circle(x, y, 14 + rnd() * 18, `rgba(150,118,76,${(0.25 + rnd() * 0.25).toFixed(2)})`);
    }
    const cx = CX + ox * (CASTLE_D - 20), cy = CY + oy * (CASTLE_D - 20);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a + Math.PI / 2);
    d.rrect(-half, -80, half * 2, 170, 30, 'rgba(120,110,96,0.55)');
    for (let x = -half + 10; x < half - 40; x += 34) {
      for (let y = -70, row = 0; y < 76; y += 30, row++) {
        d.rrect(x + (row % 2) * 12, y, 30, 26, 4, `rgba(${170 + Math.floor(rnd() * 30)},${160 + Math.floor(rnd() * 25)},${140 + Math.floor(rnd() * 20)},0.55)`);
      }
    }
    ctx.restore();
  });
}

function drawCraters(d, v) {
  for (const c of v.cr) {
    const R = c[2] ? 52 : 34;
    d.circle(c[0], c[1], R * 1.25, 'rgba(70,52,34,0.35)');
    d.circle(c[0], c[1], R, 'rgba(40,30,22,0.55)');
    d.circle(c[0] - R * 0.2, c[1] - R * 0.2, R * 0.45, 'rgba(20,14,10,0.45)');
  }
}

function buildValley(K, lo) {
  const sc = (name, list, size) => K.scatter(name, list.map(([x, y, rot, s]) => ({ x, y, rot: rot || 0, s: s || 1 })), { size });
  // A village on the far side: homes, church, well, granary, the old windmill on the hill.
  sc('medieval/building_home_A_green', [[CX - 520, -330, 0.4], [CX + 610, -300, 2.6]], 200);
  sc('medieval/building_home_B_yellow', [[CX - 300, -420, 1.2], [CX + 360, -440, 2]], 190);
  const church = K.model('medieval/building_church_blue', { size: 300 });
  K.place(church, CX + 40, -560); K.face(church, Math.PI / 2);
  const wm = K.model('medieval/building_windmill_yellow', { size: 260 });
  K.place(wm, CX - 820, -620);
  sc('medieval/building_well_green', [[CX - 120, -300, 0]], 90);
  sc('medieval/building_grain', [[CX + 220, -310, 0.4], [CX - 680, -360, 1]], 110);
  sc('medieval/fence_wood_straight', [[CX - 420, -220, 0], [CX - 330, -220, 0], [CX + 420, -220, 0], [CX + 510, -220, 0]], 90);
  sc('medieval/sack', [[CX - 150, -250, 0], [CX + 180, -250, 1]], 40);
  sc('medieval/crate_A_big', [[CX - 190, -250, 0.4], [CX + 230, -260, 0.2]], 56);
  sc('medieval/resource_lumber', [[-200, 980, 0.5], [1200, 30, 1.2]], 90);
  // Rocks along the sides, woods and hills all around, mountains on the horizon.
  sc('medieval/rock_single_A', [[-180, 300, 0], [1190, 700, 1], [-240, 760, 2], [1250, 250, 0.5]], 80);
  sc('medieval/rock_single_C', [[-120, 120, 0], [1120, 880, 1]], 60);
  sc('medieval/rock_single_E', [[-300, 520, 0], [1300, 480, 1]], 70);
  const trees = [], trees2 = [], singles = [];
  const N = lo ? 18 : 34;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * TAU;
    if (Math.sin(a) < -0.5) continue; // village side
    const rr = 1180 + (k % 3) * 170;
    (k % 2 ? trees : trees2).push([CX + Math.cos(a) * rr * 1.3, CY + Math.sin(a) * rr, k, 0.85 + (k % 3) * 0.15]);
  }
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * TAU + 0.2;
    if (Math.sin(a) < -0.35) continue;
    singles.push([CX + Math.cos(a) * 780 * 1.3, CY + Math.sin(a) * 780, k, 0.8 + (k % 3) * 0.2]);
  }
  sc('medieval/trees_A_large', trees, 300);
  sc('medieval/trees_B_large', trees2, 320);
  sc('medieval/tree_single_A', singles.filter((_, k) => k % 2), 150);
  sc('medieval/tree_single_B', singles.filter((_, k) => !(k % 2)), 160);
  sc('medieval/trees_A_medium', [[-420, -80, 0], [1420, -60, 1], [-380, 1080, 2], [1400, 1100, 3]], 220);
  sc('medieval/hills_A_trees', [[-1300, -800, 0.3], [2300, -800, 2]], 900);
  sc('medieval/hills_C_trees', [[-1500, 500, 1], [2500, 500, 4]], 900);
  sc('medieval/mountain_B_grass_trees', [[CX - 1500, -1600, 0.5], [CX + 1600, -1700, 2]], 1500);
  sc('medieval/mountain_A_grass', [[CX + 100, -2100, 1]], 1800);
}
