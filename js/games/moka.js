// Il Calderone Matto (id 'moka') — pump the bellows 1-3 times and pass: whoever blows the cauldron up gets soup
// in the face. B passes; B without pumping uses your one valve per round (pressure -2). Pumping 3 = RAISE:
// the next one must pump 2. 2 players: best of 3 rounds. 3–4 players: whoever blows it up is OUT (a new
// cauldron is put on the fire), the last one still clean wins.
import { clamp, r2 } from '../core/geom.js';

const W = 1600, H = 900;
const TABLE = 760;                 // kitchen floor (everyone stands here)
const POS = { 2: [250, 1350], 3: [160, 1440, 430], 4: [110, 1490, 370, 1230] };
const RAD = { 2: 95, 3: 86, 4: 80 };
const pxOf = (n) => POS[n] || POS[2];
const radOf = (n) => RAD[n] || RAD[2];
const PY = 640;                    // 2D fallback: avatar center
const MAX_PUMPS = 3;
const WINS = 2;
const HOT_AFTER = 10;              // seconds into a round: the fire is stoked (min 2 pumps per turn)
const VENT = 2;                    // pressure released by the valve
const fill = (n, v) => Array.from({ length: n }, () => v);

// Cauldron positions: one in the middle, or two (Doppio Calderone; closer together with 3–4 players).
const potXs = (nm, n) => (nm === 1 ? [W / 2] : n > 2 ? [650, 950] : [600, 1000]);
const potSc = (nm) => (nm === 1 ? 1 : 0.78);
const bellowsOff = (n) => (n > 2 ? 108 : 150);
const facing = (x) => (x < W / 2 ? 1 : -1);
const mokaX = (s, k) => potXs(s.m.length, s.n)[k];
const minPumps = (s) => Math.max(s.hot ? 2 : 1, s.raise);

function nextAlive(s, i) {
  for (let k = 1; k <= s.n; k++) { const j = (i + k) % s.n; if (!s.out[j]) return j; }
  return i;
}

function newRound(s, g) {
  s.round++;
  if (s.n === 2) s.cur = s.round === 1 ? g.rng.int(0, 1) : 1 - s.starter;
  else s.cur = s.round === 1 ? g.rng.int(0, s.n - 1) : nextAlive(s, s.loser);
  s.starter = s.cur;
  const big = s.n > 2;
  if (g.variant === 'doppia') {
    const lo = big ? 4 : 5, hi = big ? 9 : 11;
    const a = g.rng.int(lo, hi);
    let b; do b = g.rng.int(lo, hi); while (b === a);
    s.m = [{ p: 0, th: a, ten: 0, vent: 9 }, { p: 0, th: b, ten: 0, vent: 9 }];
  } else {
    s.m = [{ p: 0, th: big ? g.rng.int(7, 13) : g.rng.int(8, 16), ten: 0, vent: 9 }];
  }
  s.ph = 'turn'; s.pt = 0; s.rt = 0; s.hot = false; s.raise = 0;
  s.pumps = 0; s.tt = s.turn; s.boomK = -1; s.loser = -1;
  s.valve = fill(s.n, 1); s.last = '';
  g.say(s.n > 2 && s.round > 1 ? 'NUOVO CALDERONE!' : `ROUND ${s.round}`);
  g.sfx('fire', { vol: 0.6 });
}

function pump(s, g, k) {
  const m = s.m[k];
  m.p++;
  s.total[s.cur]++;
  s.pa[s.cur] = 0;
  // Displayed tension = real ratio + a random bluff, so the gauge can lie a little.
  m.ten = clamp(m.p / m.th + g.rng.range(-0.18, 0.2), 0, 1);
  const x = mokaX(s, k);
  g.sfx('wobble', { pitch: 0.8 + m.ten * 0.8 });
  g.burst(x + 70, 470, { color: '#ffffff', n: 4 + Math.round(m.ten * 10), speed: 120 + m.ten * 200, size: 10 });
  g.shake(0.05 + m.ten * 0.2);
  g.vibrate(s.cur, 30);
  if (m.ten > 0.75) g.sfx('whistle', { vol: 0.5, pitch: 1.3 });
  else if (m.ten > 0.5) g.sfx('fuse', { vol: 0.5 });
  if (m.p >= m.th) boom(s, g, k);
}

function boom(s, g, k) {
  const l = s.cur;
  s.ph = 'boom'; s.pt = 0; s.loser = l; s.boomK = k;
  const x = mokaX(s, k);
  g.sfx('bigexplode');
  g.sfx('splash', { vol: 0.8 });
  g.flash('#2a3a0a', 0.5);
  g.shake(1);
  g.hitstop(0.12);
  g.burst(x, 520, { color: '#7a9a2a', n: 60, speed: 700, size: 16 });
  g.burst(x, 440, { color: '#ffd23f', n: 20, speed: 500, size: 10 });
  g.burst(s.px[l], PY, { color: '#4a6a1a', n: 30, speed: 350, size: 12 });
  g.vibrate(l, 400);
  g.text(s.px[l], PY - 220, 'ZUPPA IN FACCIA!', { player: l, size: 50 });
  if (s.n === 2) {
    const w = 1 - l;
    s.wins[w]++;
    if (s.wins[w] >= WINS) { g.slowmo(0.3, 1); g.end(w, 'Zuppa in faccia!'); }
    return;
  }
  // 3–4 players: the one who blew it up is out; the last one standing wins.
  s.out[l] = true;
  const rest = s.out.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0);
  if (rest.length === 1) {
    s.wins[rest[0]]++;
    g.slowmo(0.3, 1);
    g.end(rest[0], "L'ultimo senza zuppa in faccia!");
  } else g.say('FUORI!');
}

// Valve: release pressure instead of pumping (once per round per player).
function vent(s, g) {
  const k = s.sel[s.cur], m = s.m[k];
  s.valve[s.cur] = 0;
  m.p = Math.max(0, m.p - VENT);
  m.ten = clamp(m.p / m.th + g.rng.range(-0.15, 0.15), 0, 1);
  m.vent = 0;
  s.last = 'vent';
  g.sfx('whoosh'); g.sfx('pop', { pitch: 0.7 });
  g.text(s.px[s.cur], PY - 220, 'SFIATO!', { player: s.cur, size: 54 });
  g.burst(mokaX(s, k), 420, { color: '#ffffff', n: 25, speed: 380, size: 14 });
}

function pass(s, g, byB) {
  const min = minPumps(s);
  if (byB && s.pumps === 0 && s.valve[s.cur] && s.m[s.sel[s.cur]].p > 0) vent(s, g);
  else {
    while (s.pumps < min && s.ph === 'turn') { s.pumps++; pump(s, g, s.sel[s.cur]); }
    if (s.ph !== 'turn') return;
    s.last = '';
  }
  // Raise: three pumps force the next player to pump at least two.
  const raised = s.last !== 'vent' && s.pumps >= MAX_PUMPS;
  s.raise = raised ? (s.hot ? 3 : 2) : 0;
  if (raised) {
    g.say(`RILANCIO! MINIMO ${s.raise}`);
    g.sfx('horn', { vol: 0.5, pitch: 1.2 });
  }
  // Valvola Matta: sometimes the cauldron vents and pressure drops.
  if (g.variant === 'valvola' && g.rng.chance(0.3)) {
    const k = g.rng.int(0, s.m.length - 1), m = s.m[k];
    if (m.p > 0) {
      const drop = Math.min(m.p, g.rng.int(1, 3));
      m.p -= drop;
      m.ten = clamp(m.p / m.th + g.rng.range(-0.15, 0.15), 0, 1);
      m.vent = 0;
      g.sfx('whoosh'); g.sfx('pop', { pitch: 0.7 });
      g.say('SFIATA DA SOLO!');
      g.burst(mokaX(s, k), 420, { color: '#ffffff', n: 25, speed: 380, size: 14 });
    }
  }
  s.cur = nextAlive(s, s.cur);
  s.pumps = 0;
  s.tt = s.turn;
  s.pt = 0;
  g.sfx('swap', { vol: 0.5 });
  if (!s.hot && s.rt >= HOT_AFTER) {
    s.hot = true;
    g.say('FUOCO ALTO! MINIMO 2');
    g.sfx('fire');
  }
}

// ---------- Bot helpers ----------
const BOT_GAP = [0.22, 0.15, 0.11];  // spacing between single presses (a bit above the driver's max rate per level)
const BOT_LAG = [0.34, 0.2, 0.09];   // the driver's reaction delay per level (to know when a press has landed)

// Thresholds still possible given the gauge readings [p, ten, bluffMin, bluffMax] (uniform weights).
function posterior(p, lo, hi, obs) {
  const out = [];
  for (let th = Math.max(lo, p + 1); th <= hi; th++) {
    let ok = true;
    for (const [op, ten, a, b] of obs) {
      if (op >= th) { ok = false; break; }
      const r = op / th, tol = 0.006;
      if (ten <= 0 ? r + a > tol : ten >= 1 ? r + b < 1 - tol : r < ten - b - tol || r > ten - a + tol) { ok = false; break; }
    }
    if (ok) out.push(th);
  }
  if (!out.length && obs.length) return posterior(p, lo, hi, []);
  return out;
}

// Share of the candidate thresholds in ths that a run of n pumps from pressure p would reach.
function riskOf(ths, p, n) {
  let all = 0, bad = 0;
  for (const th of ths) if (th > p) { all++; if (th <= p + n) bad++; }
  return all ? bad / all : 1;
}

// Plan a turn: for every threshold still possible play the round out with simple policies (the others pump the
// minimum; the bot uses its valve when its own reading says the minimum is too dangerous)
// and pick the opening move that survives most often.
function mokaPlan(s, me, M, L) {
  const mn = minPumps(s);
  const big = s.n > 2, dbl = s.m.length > 1;
  const lo = dbl ? (big ? 4 : 5) : big ? 7 : 8, hi = dbl ? (big ? 9 : 11) : big ? 13 : 16;
  const brave = s.n === 2 && 45 - s.rt < 6 ? 0.03 : 0.01; // near the end pumps are the tiebreak
  const dMine = 0.5 + 0.3 * (2 - L), dOther = M.dur || 1.5; // expected turn lengths (the fire gets hot at 10 s)
  let best = null;
  s.m.forEach((m, k) => {
    // Re and Cavaliere remember every gauge movement of the round, Scudiero only the last two.
    const post = posterior(m.p, lo, hi, L ? M.obs[k] : M.obs[k].slice(-2));
    const opts = [];
    if (s.pumps && k !== s.sel[me]) return; // halfway through a turn: keep the same cauldron
    if (s.valve[me] && m.p > 0 && !s.pumps) opts.push({ vent: true, k: 0, sel: k });
    for (let n = Math.max(mn, s.pumps); n <= MAX_PUMPS; n++) opts.push({ vent: false, k: n, sel: k }); // k = pumps in this turn
    for (const o of opts) {
      let win = 0;
      for (const th of post) {
        const valve = s.valve.slice();
        let p = m.p, h = s.hot, rt = s.rt + dMine * 0.6, raise = 0;
        if (o.vent) { valve[me] = 0; p = Math.max(0, p - VENT); }
        else if (p + o.k - s.pumps >= th) continue;
        else { p += o.k - s.pumps; raise = o.k === MAX_PUMPS ? (h ? 3 : 2) : 0; }
        h = h || rt >= HOT_AFTER;
        let need = Math.max(h ? 2 : 1, raise), cur = me, res = 1;
        for (let turn = 0; turn < 40; turn++) {
          cur = nextAlive(s, cur);
          const mine = cur === me;
          rt += mine ? dMine : dOther;
          if (mine && valve[me] && p > 0 && riskOf(post, p, need) >= 0.45) { valve[me] = 0; p = Math.max(0, p - VENT); raise = 0; }
          else if (p + need >= th) { res = mine ? 0 : 1; break; }
          else { p += need; raise = need === MAX_PUMPS ? (h ? 3 : 2) : 0; }
          h = h || rt >= HOT_AFTER;
          need = Math.max(h ? 2 : 1, raise);
        }
        win += res;
      }
      o.sc = win / Math.max(1, post.length) + brave * o.k - (o.vent ? 0.02 : 0);
      if (!best || o.sc > best.sc) best = o;
    }
  });
  return best;
}

export default {
  id: 'moka',
  name: 'Il Calderone Matto',
  rule: 'Soffia 1-3 volte e passa: chi lo fa scoppiare perde!',
  verb: 'SOFFIA!',
  inspired: "Mario Party · Bowser's Big Blast",
  cam: 'side',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'h', a: 'Soffia', b: 'Passa', dirLabel: 'Scegli' },
  help: {
    goal: "Non far scoppiare il calderone nel tuo turno! In 2: vince chi resta pulito per 2 round. In 3–4: chi lo fa scoppiare è fuori, vince l'ultimo pulito.",
    dir: 'Solo in Doppio Calderone: sinistra/destra sceglie quale calderone gonfiare.',
    a: 'SOFFIA col mantice: +1 pressione. Da 1 a 3 soffi per turno (i pallini col bordo rosso sono il minimo obbligatorio).',
    b: 'PASSA il turno. Se premi B SENZA aver soffiato usi la VALVOLA (una per round): -2 di pressione e passi.',
    tips: ["3 soffi = RILANCIO: il prossimo dovrà soffiarne almeno 2 (3 col fuoco alto). La valvola lo annulla!", "Il manometro mente un po': la soglia è segreta!", 'Se il tempo scade soffi il minimo in automatico'],
  },
  duration: 45,
  noMods: ['scambio', 'nonna'],
  variants: [
    { id: 'veloce', name: 'Fuoco Lesto', desc: 'Turni da un secondo e mezzo!' },
    { id: 'valvola', name: 'Valvola Matta', desc: 'Ogni tanto il calderone sfiata da solo e la pressione scende' },
    { id: 'doppia', name: 'Doppio Calderone', desc: 'Due calderoni! Scegli quale gonfiare con sinistra/destra' },
  ],

  init(g) {
    const n = g.n || 2;
    const s = {
      n, px: pxOf(n), out: fill(n, false),
      round: 0, starter: 0, cur: 0, wins: fill(n, 0), total: fill(n, 0), sel: fill(n, 0).map((_, i) => (i % 2 ? 1 : 0)),
      turn: g.variant === 'veloce' ? 1.5 : 3, tt: 3, pumps: 0, ph: 'turn', pt: 0, rt: 0, hot: false, raise: 0,
      m: [], boomK: -1, loser: -1, pa: fill(n, 9), valve: fill(n, 1), last: '',
    };
    newRound(s, g);
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.pt += dt;
    for (let i = 0; i < s.n; i++) s.pa[i] += dt;
    for (const m of s.m) m.vent += dt;
    if (g.ended) return;
    if (s.ph === 'boom') {
      if (s.pt >= 2.2) newRound(s, g);
      return;
    }
    s.rt += dt;
    // Doppio Calderone: choose which cauldron with left/right (as the player sees it).
    if (s.m.length > 1) {
      for (let i = 0; i < s.n; i++) {
        const sx = inp[i].sx;
        if (sx < -0.5 && s.sel[i] !== 0) { s.sel[i] = 0; if (i === s.cur) g.sfx('click'); }
        if (sx > 0.5 && s.sel[i] !== 1) { s.sel[i] = 1; if (i === s.cur) g.sfx('click'); }
      }
    } else s.sel = fill(s.n, 0);

    const ip = inp[s.cur];
    // Presses of the others: a gentle "not your turn" buzz.
    for (let i = 0; i < s.n; i++) {
      if (i === s.cur || s.out[i]) continue;
      if ((inp[i].aP || inp[i].bP) && s.pt > 0.25) { g.sfx('bonk', { vol: 0.25, pitch: 1.6 }); g.vibrate(i, 20); }
    }
    if (ip.aP && s.pumps < MAX_PUMPS) {
      const k0 = Math.min(ip.aN, MAX_PUMPS - s.pumps);
      for (let k = 0; k < k0 && s.ph === 'turn'; k++) { s.pumps++; pump(s, g, s.sel[s.cur]); }
      if (s.ph !== 'turn') return;
      if (s.pumps >= MAX_PUMPS) s.tt = Math.min(s.tt, 0.45); // max pumps: pass shortly
    }
    if (ip.bP) { pass(s, g, true); return; }
    s.tt -= dt;
    if (s.tt <= 0) pass(s, g, false);
  },

  // Computer player: reads the gauge like a careful human (only what the screen shows), then plays the
  // exact "known threshold" game averaged over the thresholds that are still possible.
  bot(s, me, g, B) {
    const M = B.mem, L = B.level;
    if (M.round !== s.round || !M.obs || M.obs.length !== s.m.length) {
      M.round = s.round; M.obs = s.m.map(() => []); M.seen = s.m.map((m) => ({ p: m.p, ten: m.ten })); M.mine = false;
    }
    // Every change of a gauge is a clue: tension = pressure/threshold + a bounded bluff.
    s.m.forEach((m, k) => {
      const pv = M.seen[k];
      if (pv.p !== m.p || pv.ten !== m.ten) {
        const vent = m.p < pv.p;
        M.obs[k].push([m.p, r2(m.ten), vent ? -0.15 : -0.18, vent ? 0.15 : 0.2]);
        M.seen[k] = { p: m.p, ten: m.ten };
      }
    });
    // How long the others take for a turn (the fire gets hot after 10 s of round).
    if (M.cur !== s.cur || M.curRound !== s.round) {
      if (M.curRound === s.round && M.cur !== me && M.cur >= 0) { const d = g.t - M.curT; M.dur = M.dur ? M.dur * 0.6 + d * 0.4 : d; }
      M.cur = s.cur; M.curT = g.t; M.curRound = s.round;
    }
    const w = { x: 0, y: 0 };
    if (s.ph !== 'turn' || s.cur !== me || g.ended) { M.mine = false; return w; }
    if (!M.mine) {
      M.mine = true; M.taps = 0; M.planned = 0; M.lastTap = -9; M.passed = false; M.t0 = g.t;
      M.plan = mokaPlan(s, me, M, L);
      M.think = (s.turn / 3) * [0.3 + B.rng() * 0.6, 0.15 + B.rng() * 0.35, 0.08 + B.rng() * 0.2][L];
    }
    const P = M.plan, gap = BOT_GAP[L], lag = BOT_LAG[L];
    if (s.m.length > 1) w.sx = P.sel ? 1 : -1;
    if (g.t - M.t0 < M.think) return w;
    if (P.vent) {
      if (!M.passed && s.pumps === 0) { w.tapB = true; M.passed = true; M.lastTap = g.t; }
      else if (M.passed && g.t - M.lastTap > lag + 0.3) M.passed = false; // the press got lost: again
      return w;
    }
    // A press can get lost (distraction): after a while trust what the screen shows.
    if (s.pumps < M.taps && g.t - M.lastTap > lag + 0.2) M.taps = s.pumps;
    // Pump one at a time and look at the gauge again after each pump.
    if (s.pumps === M.taps && s.pumps > M.planned) { M.planned = s.pumps; M.plan = mokaPlan(s, me, M, L); }
    const Q = M.plan;
    if (M.taps < Q.k) {
      if (g.t - M.lastTap >= gap && s.pumps === M.taps) { w.tapA = true; M.taps++; M.lastTap = g.t; }
      return w;
    }
    if (g.t - M.lastTap < lag + 0.1 || s.pumps < Q.k) return w;
    // Three pumps pass by themselves; otherwise pass, unless the timer would beat the press anyway.
    if (Q.k < MAX_PUMPS && !M.passed && s.tt > lag + 0.2) { w.tapB = true; M.passed = true; M.lastTap = g.t; }
    else if (M.passed && g.t - M.lastTap > lag + 0.3 && s.tt > lag + 0.2) M.passed = false;
    return w;
  },

  timeout(s) {
    if (s.n === 2) {
      if (s.wins[0] !== s.wins[1]) return s.wins[0] > s.wins[1] ? 0 : 1;
      // Tie: the bravest pumper wins, else whoever is not holding the hot cauldron.
      if (s.total[0] !== s.total[1]) return s.total[0] > s.total[1] ? 0 : 1;
      return 1 - s.cur;
    }
    // 3–4 players: among those still in, the bravest pumper; then whoever is not on turn.
    const alive = s.out.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0);
    const top = Math.max(...alive.map((i) => s.total[i]));
    const cand = alive.filter((i) => s.total[i] === top);
    return cand.find((i) => i !== s.cur) ?? cand[0];
  },

  view(s) {
    const tl = s.ph === 'turn' ? clamp(s.tt / s.turn, 0, 1) : 0;
    const big = s.n > 2;
    return {
      ph: s.ph, pt: r2(s.pt), cur: s.cur, pumps: s.pumps, lose: s.loser, bk: s.boomK, hot: s.hot ? 1 : 0,
      min: minPumps(s), rs: s.raise ? 1 : 0, va: s.valve.slice(), rd: s.round, out: s.out.map((o) => (o ? 1 : 0)),
      tl: r2(tl), sel: s.sel.slice(), pa: s.pa.map((t) => r2(Math.min(t, 9))),
      m: s.m.map((m) => ({ ten: r2(m.ten), vent: r2(Math.min(m.vent, 9)) })),
      hud: big
        ? { p: s.out.map((o) => (o ? 0 : 1)), max: 1, label: 'In gara', bar: s.out.map((_, i) => (s.cur === i ? r2(tl) : 0)) }
        : { p: s.wins.slice(), max: WINS, label: 'Round', bar: [s.cur === 0 ? r2(tl) : 0, s.cur === 1 ? r2(tl) : 0] },
    };
  },

  focus(v) {
    const px = pxOf(v.va.length);
    return v.va.map((_, i) => ({ x: px[i], y: TABLE - radOf(v.va.length) }));
  },

  // ---------- 3D: the castle kitchen in the vaulted cellar, a bubbling iron cauldron on the hearth ----------
  render3d: {
    cam: { fit: 1.04 },
    assets: [
      'dungeon/wall', 'dungeon/wall_arched', 'dungeon/wall_shelves', 'dungeon/pillar_decorated', 'dungeon/torch_mounted',
      'dungeon/banner_patternA_red', 'dungeon/banner_patternA_blue', 'dungeon/banner_patternA_green', 'dungeon/banner_patternA_yellow',
      'dungeon/table_long_decorated_A', 'dungeon/chair', 'dungeon/barrel_large', 'dungeon/keg_decorated', 'dungeon/crates_stacked',
      'dungeon/barrel_small_stack', 'dungeon/box_stacked', 'dungeon/candle_triple', 'dungeon/shelf_small_candles',
      'dungeon/plate_stack', 'dungeon/bottle_A_green', 'dungeon/bottle_B_brown', 'medieval/sack', 'medieval/resource_lumber',
      'medieval/bucket_water',
    ],
    build(K, r) {
      const T = K.THREE;
      const n = clamp(r.n || (r.roster && r.roster.length) || 2, 2, 4);
      const nm = r.variant === 'doppia' ? 2 : 1;
      const hi = K.quality > 0;
      K.theme('grotta', { fogNear: 2.4, fogFar: 6 });
      K.bg('#1a110b');
      const o = { n, mk: [], pl: [] };

      // Floor of big flagstones.
      flat(K, 'lastre', TABLE, -2600, 900, -3200, W + 3200, 150, '#c8b49c');
      // Back wall of the cellar: two rows of stone wall pieces (shelves and arches in the lower row).
      const ZW = -640, WS = 440;
      const rows = { 'dungeon/wall': [], 'dungeon/wall_arched': [], 'dungeon/wall_shelves': [] };
      for (let k = -6; k <= 7; k++) {
        const x = W / 2 - WS / 2 + k * WS + WS / 2;
        const lower = k === 0 || k === 1 ? 'dungeon/wall' : (k + 10) % 3 === 0 ? 'dungeon/wall_shelves' : (k + 10) % 3 === 1 ? 'dungeon/wall_arched' : 'dungeon/wall';
        rows[lower].push({ x, y: TABLE, h: ZW });
        rows['dungeon/wall'].push({ x, y: TABLE - WS, h: ZW });
      }
      for (const [name, items] of Object.entries(rows)) if (items.length) K.scatter(name, items, { size: WS });
      // Big chimney hood above the hearth.
      const brick = K.texMat('muro', [3, 2], { color: '#a8806a' });
      K.mesh(new T.CylinderGeometry(150, 330, 260, 4, 1).rotateY(Math.PI / 4), brick, { cast: false }).position.set(W / 2, -(TABLE - 650), ZW + 120);
      K.place(K.box(170, 600, 150, brick, { cast: false }), W / 2, TABLE - 1050, ZW + 100);
      // Ceiling beams.
      const beam = K.texMat('legno', [10, 1], { color: '#7a5030' });
      for (const z of [-120, -420]) K.place(K.box(W + 3000, 36, 40, beam, { cast: false }), W / 2, -40 - (z === -120 ? 0 : 60), z);
      // Pillars against the wall.
      K.scatter('dungeon/pillar_decorated', [{ x: -150, y: TABLE, h: ZW + 90 }, { x: W + 150, y: TABLE, h: ZW + 90 }, { x: -1000, y: TABLE, h: ZW + 90 }, { x: W + 1000, y: TABLE, h: ZW + 90 }], { height: 880 });
      // Team banners on the wall, above each player.
      const BC = ['red', 'blue', 'green', 'yellow'];
      const px0 = pxOf(n);
      for (let i = 0; i < n; i++) {
        const b = K.model(`dungeon/banner_patternA_${BC[(r.roster?.[i]?.color ?? i) % 4]}`, { height: 330, cast: false });
        K.place(b, px0[i], TABLE - 300, ZW + 60);
      }
      // Torches on the wall.
      for (const x of [W / 2 - 520, W / 2 + 520]) {
        K.place(K.model('dungeon/torch_mounted', { height: 120 }), x, TABLE - 360, ZW + 60);
        if (hi) K.light(x, TABLE - 420, ZW + 160, '#ffa040', 2.4, { flicker: 0.45, dist: 800 });
      }
      // Kitchen stuff: the long table with food, barrels, kegs, crates, firewood.
      const tbl = K.model('dungeon/table_long_decorated_A', { size: 420 }); K.place(tbl, -330, TABLE, -380); tbl.rotation.y = Math.PI / 2;
      K.scatter('dungeon/chair', [{ x: -560, y: TABLE, h: -300, rot: Math.PI / 2 }, { x: -120, y: TABLE, h: -440, rot: -Math.PI / 2 }], { height: 130 });
      K.scatter('dungeon/barrel_large', [{ x: W + 260, y: TABLE, h: -420 }, { x: W + 120, y: TABLE, h: -520 }], { height: 150 });
      K.scatter('dungeon/keg_decorated', [{ x: W + 380, y: TABLE, h: -260, rot: 0.4 }], { height: 140 });
      K.scatter('dungeon/crates_stacked', [{ x: 300, y: TABLE, h: -540, rot: 0.2 }], { height: 170 });
      K.scatter('dungeon/barrel_small_stack', [{ x: W - 300, y: TABLE, h: -540, rot: -0.2 }], { height: 150 });
      if (hi) {
        K.scatter('dungeon/box_stacked', [{ x: -700, y: TABLE, h: -520 }], { height: 160 });
        K.scatter('medieval/resource_lumber', [{ x: W / 2 - 300, y: TABLE, h: -520, rot: 0.1 }, { x: W / 2 + 300, y: TABLE, h: -520, rot: -0.1 }], { size: 150 });
        K.scatter('medieval/sack', [{ x: W + 30, y: TABLE, h: -380, rot: 1 }, { x: -60, y: TABLE, h: -560 }], { size: 90 });
        K.scatter('medieval/bucket_water', [{ x: W / 2 + 230, y: TABLE, h: -330 }], { height: 60 });
        K.scatter('dungeon/candle_triple', [{ x: 300, y: TABLE - 170, h: -540 }, { x: W - 300, y: TABLE - 150, h: -540 }], { height: 60 });
      }
      // Copper pans hanging from a rail.
      o.pans = [[160, 50], [300, 40], [1300, 46], [1440, 38]].map(([px, rr]) => {
        const g = K.group(); K.place(g, px, 150, -520);
        const pan = K.cyl(rr, 12, K.mat('#b8683a', { rough: 0.35, metal: 0.6 }), { parent: g, center: true, seg: 28 });
        pan.position.y = -(30 + rr);
        K.box(8, 34, 8, K.mat('#555'), { parent: g, cast: false }).position.y = -14;
        return g;
      });
      K.place(K.box(1500, 8, 8, K.mat('#3a3a3a', { metal: 0.5 }), { cast: false }), W / 2, 150, -520);
      K.ambient('braci', { n: 50, x0: W / 2 - 360, x1: W / 2 + 360, y0: 150, y1: TABLE });

      // Cauldrons on their fire pits.
      const xs = potXs(nm, n), sc = potSc(nm);
      for (let k = 0; k < nm; k++) o.mk.push(makeCauldron(K, xs[k], sc));
      o.fire = hi ? K.light(W / 2, TABLE - 90, 160, '#ff8a30', 2.6, { flicker: 0.5, dist: 1100 }) : null;
      o.sel = K.mesh(new T.ConeGeometry(30, 50, 16).rotateX(Math.PI), K.mat('#ffffff', { unique: true, rough: 0.4 }), { cast: false });

      // Players: avatar, bellows, hose(s), turn ring, timer bar, pump dots, soup splash.
      for (let i = 0; i < n; i++) o.pl.push(makePlayer3d(K, i, o, n));

      o.ui = K.layer({
        x0: 0, y0: 0, x1: W, y1: H, h: 0, transparent: true, lit: false, z: 6,
        draw: (d, v, rr) => drawBanner3d(d, v, rr),
        key: (v) => `${v.ph}|${v.cur}|${v.rs}|${v.hot}|${v.min}|${v.va.join('')}|${v.out.join('')}|${v.lose}|${Math.min(5, Math.floor(v.pt / 0.03))}`,
      });
      o.ui.mesh.material.depthTest = false; o.ui.mesh.renderOrder = 50;
      return o;
    },

    update(K, o, v) {
      const t = K.t;
      o.pans.forEach((g, k) => { g.rotation.z = Math.sin(t * 1.3 + k * 2) * 0.08; });
      const n = v.m.length;
      for (let k = 0; k < o.mk.length; k++) poseCauldron(K, o.mk[k], v.m[k] || v.m[0], v.ph === 'boom' && v.bk === k ? v.pt : -1, v.hot, t);
      if (o.fire) o.fire.intensity = (v.hot ? 4 : 2.6) * (0.8 + 0.2 * Math.sin(t * 17));
      // Selection marker (Doppio Calderone).
      const xs = potXs(o.mk.length, v.va.length);
      o.sel.visible = n > 1 && v.ph === 'turn';
      if (o.sel.visible) {
        K.place(o.sel, xs[v.sel[v.cur]] ?? xs[0], 290 + Math.sin(t * 6) * 10, 60);
        o.sel.rotation.y = t * 3;
        o.sel.material.color.set(K.col(v.cur));
      }
      const np = Math.min(o.pl.length, v.va.length);
      for (let i = 0; i < np; i++) posePlayer3d(K, o.pl[i], i, v, t, o);
    },
  },

  render(d, v, r) {
    drawKitchen(d, v.hot);
    const n = v.va.length, nm = v.m.length, px = pxOf(n), xs = potXs(nm, n), sc = potSc(nm), R = radOf(n);
    for (let k = 0; k < nm; k++) {
      const x = xs[k];
      const exploded = v.ph === 'boom' && v.bk === k;
      drawMoka(d, x, sc, v.m[k], exploded ? v.pt : -1, v.hot);
      if (!exploded) drawGauge(d, x, TABLE - 470 * sc - 30, v.m[k].ten, sc);
      if (nm > 1 && v.ph === 'turn' && v.sel[v.cur] === k) {
        const y = 250 + Math.sin(d.t * 6) * 10;
        d.poly([x - 34, y, x + 34, y, x, y + 46], d.col(v.cur), '#000', 4);
      }
    }
    for (let i = 0; i < n; i++) {
      const x = px[i], f = facing(x);
      const on = v.ph === 'turn' && v.cur === i;
      const pumpX = x + f * bellowsOff(n);
      const down = Math.max(0, 1 - v.pa[i] / 0.18);
      const tgt = nm === 1 ? xs[0] : xs[v.sel[i]] ?? xs[0];
      const ctx = d.ctx;
      if (on) d.circle(x, TABLE - R, R * 2, d.col(i) + '22');
      ctx.strokeStyle = on ? d.col(i, 'light') : '#3a2a1a';
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.moveTo(pumpX, TABLE - 10);
      ctx.quadraticCurveTo((pumpX + tgt) / 2, TABLE + 60, tgt - f * 70, TABLE - 60);
      ctx.stroke();
      // bellows
      const a = 0.4 - down * 0.32;
      d.poly([pumpX - f * 60, TABLE - 10, pumpX + f * 60, TABLE - 10, pumpX - f * 60, TABLE - 10 - Math.sin(a) * 120], '#8a5a2a', '#3a2010', 3);
      const coffee = v.lose === i && v.ph === 'boom';
      const out = v.out[i] && !coffee;
      const winner = v.ph === 'boom' && !coffee && !v.out[i];
      const hot = v.m.some((m) => m.ten > 0.6);
      const mood = coffee || out ? 'dead' : winner ? 'happy' : on ? (hot ? 'scared' : 'angry') : hot ? 'scared' : 'ok';
      d.avatar(x, TABLE - R, R, i, { look: f > 0 ? 0 : Math.PI, mood, squash: on ? down * 0.25 : 0, alpha: out ? 0.5 : 1 });
      if (coffee || out) d.circle(x, TABLE - R * 1.2, R * 0.6, 'rgba(90,120,30,0.75)');
    }
    drawBanner3d(d, v, r);
  },
};

// ---------- 2D helpers (fallback) ----------

function drawKitchen(d, hot) {
  const ctx = d.ctx;
  const wall = ctx.createLinearGradient(0, -200, 0, TABLE);
  wall.addColorStop(0, '#3a2a20');
  wall.addColorStop(1, '#6a5040');
  ctx.fillStyle = wall;
  ctx.fillRect(-900, -600, W + 1800, TABLE + 600);
  for (let y = 0; y < TABLE; y += 70) {
    for (let x = -880 + ((y / 70) % 2) * 60; x < W + 900; x += 120) d.rect(x, y, 116, 66, 'rgba(255,255,255,0.05)');
  }
  d.rect(-900, TABLE, W + 1800, H - TABLE + 600, '#5a4a3a');
  d.rect(-900, TABLE, W + 1800, 12, '#7a6a5a');
  if (hot) d.circle(W / 2, TABLE - 100, 260, 'rgba(255,120,30,0.15)');
}

function drawGauge(d, x, y, ten, sc) {
  const r = 46 * sc;
  d.line(x, y + r, x, y + r + 20 * sc, '#555', 8);
  d.circle(x, y, r + 6, '#8a6a2a', '#222', 3);
  d.circle(x, y, r, '#fffaf0');
  d.arc(x, y, r - 8, Math.PI * 0.75, Math.PI * 1.5, '#5fd35f', 8);
  d.arc(x, y, r - 8, Math.PI * 1.5, Math.PI * 2, '#ffd23f', 8);
  d.arc(x, y, r - 8, Math.PI * 2, Math.PI * 2.25, '#ff4040', 8);
  const a = Math.PI * 0.75 + clamp(ten, 0, 1) * Math.PI * 1.5 + (ten > 0.75 ? Math.sin(d.t * 40) * 0.06 : 0);
  d.line(x, y, x + Math.cos(a) * (r - 6), y + Math.sin(a) * (r - 6), '#c00', 5);
  d.circle(x, y, 6, '#222');
}

function drawMoka(d, x, sc, m, boomT, hot) {
  const ten = m.ten;
  const amp = boomT >= 0 ? 0 : ten * ten * 14 + (ten > 0.8 ? 6 : 0);
  const jx = Math.sin(d.t * 55) * amp;
  const base = TABLE;
  const fl = (hot ? 1.6 : 1) * (1 + Math.sin(d.t * 20) * 0.15);
  for (let k = -2; k <= 2; k++) {
    const fx = x + k * 40 * sc, fh = 50 * fl * (1 + Math.sin(d.t * 17 + k) * 0.15);
    d.poly([fx - 15, base, fx + 15, base, fx, base - fh], hot ? '#ff4a1a' : '#ff9a2a');
    d.poly([fx - 8, base, fx + 8, base, fx, base - fh * 0.55], '#ffe08a');
  }
  if (boomT >= 0) {
    const k = Math.min(1, boomT / 0.25);
    d.circle(x, base - 170 * sc, 125 * sc, '#2a2a30', '#111', 4);
    d.circle(x, base - 200 * sc, 260 * k * sc, `rgba(90,120,30,${0.7 * Math.max(0, 1 - boomT / 2)})`);
    d.star(x, base - 200 * sc, 200 * k * sc, `rgba(255,210,63,${Math.max(0, 1 - boomT * 1.5)})`, 10);
    return;
  }
  if (ten > 0.5) d.circle(x, base - 170 * sc, 200 * sc, `rgba(255,60,20,${(ten - 0.5) * 0.35})`);
  d.circle(x + jx, base - 170 * sc, 125 * sc, '#2a2a30', '#111', 4);
  d.rrect(x + jx - 120 * sc, base - 290 * sc - ten * 20, 240 * sc, 30 * sc, 14, '#3a3a40', '#111', 3);
  const e = (8 + ten * 14) * sc;
  d.circle(x + jx - 34 * sc, base - 180 * sc, e, '#fff', '#222', 3);
  d.circle(x + jx + 34 * sc, base - 180 * sc, e, '#fff', '#222', 3);
  d.circle(x + jx - 34 * sc, base - 180 * sc, 5, '#000');
  d.circle(x + jx + 34 * sc, base - 180 * sc, 5, '#000');
  const puffs = 1 + Math.round(ten * 5);
  for (let k = 0; k < puffs; k++) {
    const ph = (d.t * (0.8 + ten) + k / puffs) % 1;
    d.circle(x + 100 * sc + ph * 50 + jx, base - 300 * sc - ph * 160, (12 + ph * 30) * (0.6 + ten), `rgba(255,255,255,${0.6 * (1 - ph)})`);
  }
  if (m.vent < 0.8) {
    const a = 1 - m.vent / 0.8;
    for (let k = 0; k < 6; k++) d.circle(x + (k - 2.5) * 50, base - 360 * sc - m.vent * 200, 40 + m.vent * 60, `rgba(255,255,255,${0.7 * a})`);
  }
}

// ---------- 3D helpers ----------

// Horizontal textured floor for side games (three Y up = -world y).
function flat(K, kind, y, z0, z1, x0, x1, tile, color) {
  const T = K.THREE;
  const me = K.mesh(new T.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2), K.texMat(kind, [(x1 - x0) / tile, (z1 - z0) / tile], { color }), { cast: false });
  me.position.set((x0 + x1) / 2, -y, (z0 + z1) / 2);
  me.userData.ownGeo = true;
  return me;
}

// Cylinder of unit geometry stretched between two points (three coords), width w.
function segW(m, ax, ay, bx, by, z, w) {
  const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 0.001;
  m.position.set((ax + bx) / 2, (ay + by) / 2, z);
  m.rotation.set(0, 0, Math.atan2(dy, dx) - Math.PI / 2);
  m.scale.set(w, L, w);
}

function makeCauldron(K, x, sc) {
  const T = K.THREE;
  const M = { x, sc, flames: [] };
  const base = TABLE;
  // Fire pit: a ring of stones, crossed logs, flames.
  const stone = K.texMat('pietra', [4, 1], { color: '#9a8a7a' });
  const ring = K.mesh(new T.TorusGeometry(130 * sc, 20 * sc, 6, 14).rotateX(Math.PI / 2), stone);
  K.place(ring, x, base - 8, 0);
  const logMat = K.texMat('legno', [1, 1], { color: '#6a4020' });
  for (let k = 0; k < 3; k++) {
    const lg = K.mesh(new T.CylinderGeometry(13 * sc, 13 * sc, 200 * sc, 8).rotateZ(Math.PI / 2), logMat);
    K.place(lg, x, base - 14 * sc, 0);
    lg.rotation.y = (k * Math.PI) / 3 + 0.3;
  }
  M.fCold = [K.glow('#ff9a2a', { add: true }), K.glow('#ffe08a', { add: true })];
  M.fHot = [K.glow('#ff4a1a', { add: true }), K.glow('#ffd23f', { add: true })];
  const cone = new T.ConeGeometry(17, 1, 8).translate(0, 0.5, 0);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    const outer = K.mesh(cone, M.fCold[0], { cast: false });
    const inner = K.mesh(cone, M.fCold[1], { cast: false });
    for (const m of [outer, inner]) m.position.set(x + Math.cos(a) * 70 * sc, -base + 14 * sc, Math.sin(a) * 60 * sc);
    inner.position.z += 4;
    M.flames.push({ outer, inner });
  }
  // The cauldron: round iron belly on three legs, thick rim, bubbling soup, handles and a nervous face.
  M.metal = K.mat('#3a3a42', { metal: 0.55, rough: 0.45, unique: true });
  M.g = K.group();
  M.low = K.group(M.g);
  const belly = K.ball(1, M.metal, { parent: M.low, seg: 28 }); belly.position.y = 160; belly.scale.set(128, 112, 120);
  const rim = K.mesh(new T.TorusGeometry(108, 14, 10, 32).rotateX(Math.PI / 2), M.metal, { parent: M.low }); rim.position.y = 250;
  M.soupMat = K.glow('#8fc23a', { unique: true });
  const soup = K.mesh(new T.CircleGeometry(100, 28).rotateX(-Math.PI / 2), M.soupMat, { parent: M.low, cast: false }); soup.position.y = 252;
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.5;
    const leg = K.mesh(new T.CylinderGeometry(10, 6, 70, 8), M.metal, { parent: M.low });
    leg.position.set(Math.cos(a) * 80, 35, Math.sin(a) * 70);
  }
  for (const s of [-1, 1]) { const hd = K.torus(26, 6, K.mat('#2a2a30', { metal: 0.6, rough: 0.4 }), { parent: M.low, cast: false }); hd.position.set(s * 128, 220, 0); hd.rotation.y = Math.PI / 2; }
  M.eyes = []; M.pupils = [];
  for (const s of [-1, 1]) {
    const e = K.ball(1, K.mat('#ffffff', { rough: 0.3 }), { parent: M.low, cast: false, seg: 12 });
    const p = K.ball(5, K.mat('#000000'), { parent: M.low, cast: false, seg: 8 });
    e.position.set(s * 34, 170, 112); p.position.set(s * 34, 170, 122);
    M.eyes.push(e); M.pupils.push(p);
  }
  M.mouthO = K.ball(1, K.mat('#1a0a04'), { parent: M.low, cast: false, seg: 10 });
  M.mouthO.position.set(0, 118, 108);
  M.mouthL = K.box(44, 5, 5, K.mat('#111111'), { parent: M.low, cast: false });
  M.mouthL.position.set(0, 124, 116);
  M.sweat = K.ball(8, K.glow('#78c8ff', { unique: true, opacity: 0.9 }), { parent: M.low, cast: false, seg: 8 });
  // The lid (flies off in the explosion).
  M.up = K.group(M.g);
  M.up.position.y = 256;
  const lid = K.mesh(new T.SphereGeometry(108, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.metal, { parent: M.up }); lid.scale.y = 0.4;
  K.ball(18, K.mat('#2a2a30', { metal: 0.6, rough: 0.35 }), { parent: M.up, seg: 12 }).position.y = 48;
  M.halo = K.disc(1, K.glow('#ff3c14', { unique: true, opacity: 0.2, add: true }));
  // Pressure gauge on a brass pipe above the lid.
  M.gauge = K.group();
  M.gy = TABLE - 470 * sc - 30;
  K.place(M.gauge, x, M.gy, 20);
  M.gauge.scale.setScalar(sc);
  K.cyl(54, 16, K.mat('#c9a03a', { metal: 0.6, rough: 0.3 }), { parent: M.gauge, center: true, seg: 28 });
  const face = K.mesh(new T.CircleGeometry(46, 32), new T.MeshStandardMaterial({
    roughness: 0.4,
    map: K.canvasTex(256, 256, (d) => {
      d.ctx.translate(128, 128); d.ctx.scale(128 / 50, 128 / 50);
      d.circle(0, 0, 50, '#fff4dc');
      d.arc(0, 0, 38, Math.PI * 0.75, Math.PI * 1.5, '#5fd35f', 8);
      d.arc(0, 0, 38, Math.PI * 1.5, Math.PI * 2, '#ffd23f', 8);
      d.arc(0, 0, 38, Math.PI * 2, Math.PI * 2.25, '#ff4040', 8);
      for (let k = 0; k <= 6; k++) { const a = Math.PI * 0.75 + (k / 6) * Math.PI * 1.5; d.line(Math.cos(a) * 26, Math.sin(a) * 26, Math.cos(a) * 31, Math.sin(a) * 31, '#333', 2); }
    }),
  }), { parent: M.gauge, cast: false });
  face.position.z = 8.5;
  M.needle = K.mesh(new T.BoxGeometry(40, 5, 3).translate(18, 0, 0), K.mat('#cc0000'), { parent: M.gauge, cast: false });
  M.needle.position.z = 11;
  K.ball(7, K.mat('#222222'), { parent: M.gauge, cast: false, seg: 8 }).position.z = 12;
  M.pipe = K.mesh(new T.CylinderGeometry(1, 1, 1, 8), K.mat('#c9a03a', { metal: 0.6, rough: 0.3 }));
  segW(M.pipe, x, -(M.gy + 52 * sc), x, -(base - 6 - 300 * sc), 20, 10 * sc);
  // Steam, valve blast and the explosion.
  M.puffs = []; M.vents = [];
  for (let k = 0; k < 6; k++) {
    M.puffs.push(K.ball(1, K.glow('#ffffff', { unique: true, opacity: 0.5 }), { cast: false, seg: 10 }));
    M.vents.push(K.ball(1, K.glow('#ffffff', { unique: true, opacity: 0.5 }), { cast: false, seg: 10 }));
  }
  M.cloud = K.ball(1, K.glow('#6a8a2a', { unique: true, opacity: 0.7 }), { cast: false, seg: 16 });
  M.star = K.ball(1, K.glow('#ffd23f', { unique: true, opacity: 0.8, add: true }), { cast: false, seg: 12 });
  return M;
}

function poseCauldron(K, M, m, boomT, hot, t) {
  const { x, sc } = M;
  const base = TABLE;
  const ten = m.ten;
  const fl = (hot ? 1.7 : 1) * (1 + Math.sin(t * 20) * 0.15);
  const mats = hot ? M.fHot : M.fCold;
  M.flames.forEach((F, k) => {
    const fh = 55 * fl * (1 + Math.sin(t * 17 + k) * 0.18) * sc;
    F.outer.material = mats[0]; F.inner.material = mats[1];
    F.outer.scale.set(1, fh, 1); F.inner.scale.set(0.55, fh * 0.55, 0.55);
  });
  M.soupMat.color.set(ten > 0.75 ? '#c2e04a' : '#8fc23a');
  const boom = boomT >= 0;
  M.gauge.visible = M.pipe.visible = !boom;
  M.cloud.visible = M.star.visible = boom;
  if (boom) {
    K.place(M.g, x, base - 6, 0);
    M.g.scale.setScalar(sc);
    M.metal.emissiveIntensity = 0;
    const ty = base - 6 - 256 * sc - 1400 * boomT + 1600 * boomT * boomT;
    const Y = Math.min(base - 40, ty);
    M.up.position.set((boomT * 300) / sc, (base - 6 - Y) / sc, 0);
    M.up.rotation.z = -boomT * 12;
    const k = Math.min(1, boomT / 0.25);
    K.place(M.cloud, x, base - 220 * sc, 60);
    M.cloud.scale.setScalar(Math.max(1, 260 * k * sc));
    M.cloud.material.opacity = 0.7 * Math.max(0, 1 - boomT / 2);
    K.place(M.star, x, base - 220 * sc, 80);
    M.star.scale.setScalar(Math.max(1, 200 * k * sc));
    M.star.material.opacity = Math.max(0, 1 - boomT * 1.5);
    M.star.visible = boomT < 0.66;
    M.halo.visible = false;
    M.sweat.visible = false;
    for (const p of M.puffs) p.visible = false;
    for (const p of M.vents) p.visible = false;
    for (const e of M.eyes) e.scale.setScalar(22);
    return;
  }
  const amp = ten * ten * 14 + (ten > 0.8 ? 6 : 0);
  const jx = Math.sin(t * 55) * amp, jy = Math.cos(t * 47) * amp * 0.5;
  const swell = 1 + ten * 0.06 * (1 + Math.sin(t * 12));
  K.place(M.g, x + jx, base - 6 + jy, 0);
  M.g.scale.set(sc * swell, sc / swell, sc * swell);
  // The lid rattles more and more.
  const rattle = ten > 0.3 ? Math.abs(Math.sin(t * (14 + ten * 20))) * ten * 22 : 0;
  M.up.position.set(0, 256 + rattle, 0);
  M.up.rotation.z = ten > 0.3 ? Math.sin(t * 23) * ten * 0.08 : 0;
  M.metal.emissive.set('#ff3c14');
  M.metal.emissiveIntensity = ten > 0.5 ? (ten - 0.5) * 1.2 : 0;
  M.halo.visible = ten > 0.5;
  if (M.halo.visible) { K.place(M.halo, x, base - 180 * sc, -160); M.halo.scale.setScalar(260 * sc); M.halo.material.opacity = (ten - 0.5) * 0.6; }
  // Face: eyes widen, mouth opens, sweat drops.
  const e = 9 + ten * 15;
  for (const ey of M.eyes) ey.scale.set(e, e, e * 0.5);
  M.pupils.forEach((p, k) => p.position.set((k ? 34 : -34) + Math.sin(t * 40) * ten * 2, 170, 112 + e * 0.5 + 2));
  M.mouthO.visible = ten > 0.6;
  M.mouthL.visible = !M.mouthO.visible;
  if (M.mouthO.visible) M.mouthO.scale.set(12 + ten * 10, 10 + ten * 10, 6);
  M.sweat.visible = ten > 0.45;
  if (M.sweat.visible) { const ph = (t * 1.5) % 1; M.sweat.position.set(80, 200 - ph * 60, 100); M.sweat.material.opacity = 1 - ph; }
  // Gauge needle.
  const a = Math.PI * 0.75 + clamp(ten, 0, 1) * Math.PI * 1.5 + (ten > 0.75 ? Math.sin(t * 40) * 0.06 : 0);
  M.needle.rotation.z = -a;
  // Steam escaping under the lid.
  const puffs = 1 + Math.round(ten * 5);
  M.puffs.forEach((p, k) => {
    p.visible = k < puffs;
    if (!p.visible) return;
    const ph = (t * (0.8 + ten) + k / puffs) % 1;
    const side = k % 2 ? 1 : -1;
    K.place(p, x + side * (100 + ph * 50) * sc + jx, base - 270 * sc - ph * 170, 30);
    p.scale.setScalar((12 + ph * 30) * (0.6 + ten));
    p.material.opacity = 0.6 * (1 - ph);
  });
  // Valve blast.
  M.vents.forEach((p, k) => {
    p.visible = m.vent < 0.8;
    if (!p.visible) return;
    const al = 1 - m.vent / 0.8;
    K.place(p, x + (k - 2.5) * 50, base - 360 * sc - m.vent * 200, 30);
    p.scale.setScalar(40 + m.vent * 60);
    p.material.opacity = 0.7 * al;
  });
}

// Bellows lying on the floor (nozzle toward the cauldron), hinged at the nozzle end.
function makeBellows(K, x, f, L) {
  const T = K.THREE;
  const B = { g: K.group() };
  K.place(B.g, x, TABLE, 0);
  B.g.scale.x = f;
  const wood = K.texMat('legno', [1, 1], { color: '#a8743e' });
  K.box(L, 10, 74, wood, { parent: B.g }).position.set(0, 8, 0);
  B.hinge = K.group(B.g); B.hinge.position.set(L / 2, 16, 0);
  K.box(L, 10, 74, wood, { parent: B.hinge }).position.set(-L / 2, 6, 0);
  const brass = K.mat('#c9a03a', { metal: 0.6, rough: 0.3 });
  for (const yy of [-2, 8]) K.ball(6, brass, { parent: B.hinge, cast: false, seg: 8 }).position.set(-L * 0.7, yy + 4, 38);
  const hdl = K.mesh(new T.CylinderGeometry(7, 7, 50, 8).rotateZ(Math.PI / 2), K.mat('#6a4020'), { parent: B.hinge });
  hdl.position.set(-L - 22, 6, 0);
  const hdl2 = K.mesh(new T.CylinderGeometry(7, 7, 50, 8).rotateZ(Math.PI / 2), K.mat('#6a4020'), { parent: B.g });
  hdl2.position.set(-L / 2 - 22, 8, 0);
  B.leather = K.box(1, 1, 64, K.mat('#6a3a24', { rough: 0.9 }), { parent: B.g });
  const noz = K.mesh(new T.ConeGeometry(12, 50, 10).rotateZ(-Math.PI / 2), brass, { parent: B.g });
  noz.position.set(L / 2 + 24, 16, 0);
  B.L = L;
  return B;
}

function poseBellows(B, down) {
  const a = 0.42 - down * 0.36;
  B.hinge.rotation.z = -a;
  const gap = Math.sin(a) * B.L * 0.5;
  B.leather.scale.set(B.L * 0.8, Math.max(1, gap), 1);
  B.leather.position.set(-B.L * 0.1, 14 + gap / 2, 0);
}

function makePlayer3d(K, i, o, n) {
  const T = K.THREE;
  const x = pxOf(n)[i], f = facing(x), R = radOf(n), L = n > 2 ? 104 : 140;
  const pumpX = x + f * bellowsOff(n);
  const P = { pumpX, key: 0, lastPa: 9, R };
  P.glow = K.disc(R * 2, K.glow(K.col(i), { opacity: 0.18, add: true }));
  K.place(P.glow, x, TABLE - R, -200);
  P.ring = K.torus(R * 1.18, 5, K.glow(K.col(i, 'light')), { cast: false });
  P.av = K.avatar(i);
  P.bel = makeBellows(K, pumpX, f, L);
  // Hoses (one per cauldron; only the selected one shows).
  P.hoseMat = K.mat('#4a2e1a', { rough: 0.6, unique: true });
  const nx = pumpX + f * (L / 2 + 46);
  P.hoses = o.mk.map((M) => {
    const ex = M.x - f * 120 * M.sc;
    const pts = [
      [nx, TABLE - 16, 0], [nx + f * 30, TABLE - 8, 70], [(nx + ex) / 2, TABLE - 8, 110],
      [ex - f * 24, TABLE - 50, 80], [ex, TABLE - 100 * M.sc, 40],
    ].map(([a, b, c]) => new T.Vector3(a, -b, c));
    return K.mesh(new T.TubeGeometry(new T.CatmullRomCurve3(pts), 40, 7, 8), P.hoseMat, { cast: false });
  });
  // Turn timer bar + pump dots above the head.
  const top = TABLE - R * 2.3 - 40;
  P.top = top;
  P.tbg = K.box(224, 28, 6, K.glow('#000000', { opacity: 0.5 }), { cast: false });
  K.place(P.tbg, x, top, 10);
  P.tfill = K.box(1, 22, 10, K.glow('#ffffff', { unique: true }), { cast: false });
  P.dots = [0, 1, 2].map((k) => {
    const mat = K.glow('#ffffff', { unique: true, opacity: 0.35 });
    const d = K.cyl(17, 6, mat, { center: true, seg: 20, cast: false });
    const rimMat = K.glow('#000000', { unique: true });
    const rim = K.torus(17, 4, rimMat, { cast: false });
    K.place(d, x - 55 + k * 55, top - 44, 10);
    K.place(rim, x - 55 + k * 55, top - 44, 12);
    return { d, mat, rim, rimMat };
  });
  // Soup splash: a green puddle and drops falling over the unlucky one.
  P.puddle = K.mesh(new T.CircleGeometry(R * 1.1, 24).rotateX(-Math.PI / 2), K.mat('#7a9a2a', { rough: 0.2, opacity: 0.85 }), { cast: false });
  P.drips = [0, 1, 2, 3].map(() => K.ball(9, K.mat('#8fb23a', { rough: 0.2 }), { cast: false, seg: 8 }));
  return P;
}

function posePlayer3d(K, P, i, v, t, o) {
  const n = v.va.length, x = pxOf(n)[i], f = facing(x), R = P.R;
  const on = v.ph === 'turn' && v.cur === i;
  const down = Math.max(0, 1 - v.pa[i] / 0.18);
  const AY = TABLE - R;
  P.glow.visible = P.ring.visible = on;
  if (on) { K.place(P.ring, x, AY, 30); P.ring.scale.setScalar(1 + Math.sin(t * 8) * 0.035); }
  poseBellows(P.bel, on ? down : 0);
  const sel = o.mk.length > 1 ? v.sel[i] : 0;
  P.hoses.forEach((h, k) => { h.visible = k === sel; });
  const coffee = v.lose === i && v.ph === 'boom';
  const out = !!v.out[i] && !coffee;
  P.hoseMat.color.set(on ? K.col(i, 'light') : out ? '#2a2420' : '#4a2e1a');
  // Avatar.
  const winner = v.ph === 'boom' && !coffee && !v.out[i] && (n === 2 || v.out.filter((q) => !q).length === 1);
  const hot = v.m.some((m) => m.ten > 0.6);
  if (v.pa[i] < P.lastPa - 0.02) P.key++;
  P.lastPa = v.pa[i];
  let anim;
  if (coffee) anim = 'Death_A';
  else if (out) anim = 'Sit_Floor_Idle';
  else if (winner) anim = 'Cheer';
  else if (on && v.pa[i] < 0.5) anim = '1H_Melee_Attack_Chop';
  else if (hot) anim = 'Blocking';
  else if (on) anim = '2H_Melee_Idle';
  const mood = coffee || out ? 'dead' : winner ? 'happy' : on ? (hot ? 'scared' : 'angry') : hot ? 'scared' : 'ok';
  P.av.set(x + (on ? f * down * 10 : 0), AY, { r: R, look: f > 0 ? 0 : Math.PI, mood, anim, animKey: P.key, gear: false, alpha: out ? 0.7 : 1 });
  // Soup.
  const soupy = coffee || out;
  P.puddle.visible = soupy;
  if (soupy) { P.puddle.position.set(x, -TABLE + 2, 30); P.puddle.scale.setScalar(coffee ? Math.min(1, 0.3 + v.pt * 1.5) : 1); }
  P.drips.forEach((dm, k) => {
    dm.visible = soupy;
    if (!soupy) return;
    const ph = (t * 0.9 + k * 0.27) % 1;
    K.place(dm, x - R * 0.45 + k * R * 0.3, TABLE - R * (out ? 1.4 : 2) + ph * R * (out ? 1.3 : 1.9), 50);
  });
  // Timer + pumps used (red rim = mandatory).
  P.tbg.visible = P.tfill.visible = on;
  for (const D of P.dots) D.d.visible = D.rim.visible = on;
  if (on) {
    P.tfill.scale.x = Math.max(1, 220 * v.tl);
    K.place(P.tfill, x - 110 + 110 * v.tl, P.top, 12);
    P.tfill.material.color.set(v.tl < 0.35 ? '#ff4d4d' : K.col(i, 'light'));
    P.dots.forEach((D, k) => {
      D.mat.color.set(k < v.pumps ? '#ffd23f' : '#ffffff');
      D.mat.opacity = k < v.pumps ? 1 : 0.35;
      D.rimMat.color.set(k < v.min ? '#ff4d4d' : '#000000');
    });
  }
}

function drawBanner3d(d, v, r) {
  const names = r.names || ['G1', 'G2', 'G3', 'G4'];
  const n = v.va.length, px = pxOf(n);
  // Valve token (one per round) / OUT tag in front of every player.
  for (let i = 0; i < n; i++) {
    const x = px[i], y = TABLE + 72;
    if (v.out[i] && !(v.ph === 'boom' && v.lose === i)) {
      d.rrect(x - 70, y - 22, 140, 44, 22, '#000000aa', '#ffffff44', 3);
      d.text('FUORI', x, y + 2, { size: 26, color: '#ffffffaa' });
      continue;
    }
    const on = v.va[i];
    d.circle(x - 62, y, 22, on ? '#d0d4dc' : '#00000055', on ? '#555' : '#ffffff33', 4);
    if (on) for (let k = 0; k < 3; k++) { const a = k * 2.1; d.line(x - 62, y, x - 62 + Math.cos(a) * 18, y + Math.sin(a) * 18, '#555', 5); }
    d.circle(x - 62, y, 7, on ? '#e53935' : '#555');
    d.text('VALVOLA', x + 18, y + 2, { size: 22, color: on ? '#fff' : '#ffffff55' });
  }
  if (v.ph === 'turn') {
    const c = v.cur;
    const pop = 1 + 0.2 * Math.max(0, 1 - v.pt / 0.15);
    d.rrect(W / 2 - 300, 70, 600, 72, 36, '#000000aa', d.col(c, 'light'), 4);
    d.text(`TOCCA A ${names[c]}`, W / 2, 107, { size: 42 * pop, color: d.col(c, 'light') });
    const info = v.rs ? `⚠ RILANCIO: minimo ${v.min}!` : v.hot ? '🔥 FUOCO ALTO: minimo 2' : `A soffia · B passa${v.va[c] ? ' (subito = valvola)' : ''}`;
    d.rrect(W / 2 - 330, 152, 660, 50, 25, '#00000088');
    d.text(info, W / 2, 178, { size: 32, color: v.rs || v.hot ? '#ffb070' : '#ffffff' });
  } else if (v.ph === 'boom' && v.lose >= 0) {
    const l = v.lose;
    const alive = v.out.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0);
    const w = n === 2 ? 1 - l : alive.length === 1 ? alive[0] : -1;
    d.rrect(W / 2 - 420, 70, 840, 130, 40, '#000000bb', w >= 0 ? d.col(w, 'light') : d.col(l, 'light'), 5);
    d.text(`${names[l]} fa scoppiare il calderone!`, W / 2, 112, { size: 40, color: d.col(l, 'light') });
    const sub = n === 2 ? `Round a ${names[w]}` : w >= 0 ? `Vince ${names[w]}!` : `${names[l]} è fuori! Restano in ${alive.length}`;
    d.text(sub, W / 2, 164, { size: 44, color: '#ffe066' });
  }
}
