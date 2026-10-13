// Balestra Lesta (id 'fuoco') — medieval quick draw with crossbows: shoot on "FUOCO!", never on the trap words.
// 2–4 archers. Every duel each archer aims at ONE rival (a random ring: everyone hunts one and is hunted by one;
// with 2 players simply each other). The first bolt that hits wins the duel. Shooting early jams your crossbow:
// you are out of that duel (with 2 players the other one takes the point).
// B = dodge roll after the signal (bolts miss you, and a miss leaves the shooter reloading),
// or a feint before the signal to make the others jump the gun.
import { clamp, lerp, r1, r2, r3 } from '../core/geom.js';

const W = 1600, H = 900, GROUND = 735;
const POS = { 2: [330, 1270], 3: [260, 800, 1340], 4: [200, 600, 1000, 1400] };
const RAD = { 2: 160, 3: 142, 4: 128 };   // 3D archer size (also where the crossbow is)
const pxOf = (n) => POS[n] || POS[2];
const radOf = (n) => RAD[n] || RAD[2];
const gunOf = (n) => GROUND - radOf(n) * 1.4;
const MUZ = 150;           // visual: crossbow tip distance from the archer
const WIN = 3;
// Presses are stamped (aT) on the real host clock, while g.dt can be scaled by time mods,
// so we keep our own real clock: one host tick per step (this game never uses hitstop).
const TICK = 1 / 60;
const LAG = 0.09;          // presses are replayed in press-time order this long after they happen (fair over network)
const EARLY_TOL = 0.05;    // network/clock slack before calling a press "early"
const TOO_SLOW = 3, MAX_DUEL = 9;
const READY_TIME = 0.8, RES_TIME = 1.8;
const DODGE_T = 0.45;      // roll duration: bolts arriving now miss
const RELOAD = 0.9;        // after a shot the crossbow is empty this long
const SLUG = { first: 1.35, mul: 0.78, min: 0.45, reload: 0.7, cd: 0.9 }; // Dardo Lumaca

const TRAPS = ['FOCACCIA!', 'FUNGO!', 'FORCA!', 'FOCOLARE!', 'FUORI!', 'FUOCHI!', 'FUMO!', 'FAGIOLI!', 'FAVA!'];
const TRAPS_HARD = ['FUOCO?', 'FUOCHI!', 'FOCO!', 'FUOCA!', 'FUCO!', 'FUOCCO!', 'FUOC0!', 'FIUOCO!', 'FUOCHINO!', 'FOCACCIA!', 'FORCA!', 'FUOCO NO!'];

const pose = (st) => ({ st, t: 0 });
const slug = (g) => g.variant === 'lumaca';
const rolling = (q, t) => t >= q.dodge && t < q.dodge + DODGE_T;
const fill = (n, v) => Array.from({ length: n }, () => v);
const ringTargets = (n) => Array.from({ length: n }, (_, i) => (n === 2 ? 1 - i : (i + 1) % n));

// Current target of archer i: its prey in the ring, skipping archers that are out of this duel.
function aim(s, i) {
  let j = s.tg[i];
  for (let k = 0; k < s.n && j !== i && s.out[j]; k++) j = s.tg[j];
  return j === i || s.out[j] ? -1 : j;
}
const alive = (s) => s.out.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0);

function startDuel(s, g) {
  const hard = g.variant === 'parole';
  const k0 = hard ? g.rng.int(2, 4) : g.rng.chance(0.65) ? g.rng.int(1, 2) : 0;
  const wait = Math.max(g.rng.range(1.6, 5), 1.1 + k0 * 0.85);
  const seg = (wait - 0.6) / Math.max(1, k0);
  s.traps = [];
  for (let k = 0; k < k0; k++) {
    s.traps.push({ at: 0.6 + seg * k + g.rng.range(0, Math.max(0, seg - 0.75)), w: g.rng.pick(hard ? TRAPS_HARD : TRAPS) });
  }
  const n = s.n;
  Object.assign(s, {
    ph: 'wait', pt: 0, duel: s.duel + 1, waitAt: wait, trapIdx: 0, word: '', wordT: 9, real: false,
    rt: fill(n, -1), msg: '', why: '', win: -1, jam: -1, sigReal: 0, ev: [], bul: [], tr: [], shots: 0, nSlug: 0,
    dodged: fill(n, 0), out: fill(n, 0),
    nextBeat: 0.4, nextWind: g.rng.range(0.3, 1.5), twDir: g.rng.chance(0.5) ? 1 : -1,
  });
  // Targets: with 3–4 archers a fresh random ring every duel.
  if (n === 2) s.tg = [1, 0];
  else {
    const ring = g.rng.shuffle([...Array(n).keys()]);
    s.tg = fill(n, 0);
    ring.forEach((p, k) => { s.tg[p] = ring[(k + 1) % n]; });
  }
  // Comeback: whoever is behind the leader gets a second dodge.
  const top = Math.max(...s.sc);
  s.pl = s.sc.map((sc) => { const m = sc < top ? 2 : 1; return { left: m, max: m, dodge: -99, reload: -99, cd: -99, feint: false }; });
  s.p = s.sc.map(() => pose('aim'));
}

function showWord(s, g, word, real) {
  s.word = word; s.real = real; s.wordT = 0;
  if (g.variant === 'buio') g.sfx(real ? 'bang' : 'cork', { vol: 1 });
  else g.sfx('whistle', { pitch: real ? 1.1 : 1.25 });
  g.shake(real ? 0.25 : 0.12);
}

function toRes(s, msg, why, win) {
  s.ph = 'res'; s.pt = 0; s.msg = msg; s.why = why; s.win = win;
  s.word = ''; s.bul = []; s.ev = [];
}

function award(s, w, msg, why, g) {
  s.sc[w]++;
  s.last = w;
  toRes(s, msg, why, w);
  if (s.sc[w] >= WIN) {
    g.slowmo(0.3, 0.9);
    g.end(w, why === 'jam' ? 'Balestra inceppata!' : why === 'counter' ? 'Schivata e contropiede!' : 'Il balestriere più lesto del regno!');
  } else g.sfx('point');
}

function jam(s, i, g) {
  const px = s.px[i], f = s.px[aim(s, i)] > px ? 1 : -1;
  s.out[i] = 1;
  s.jam = i;
  s.p[i] = pose('jam');
  s.rt[i] = -1;
  g.sfx('buzzer'); g.sfx('boing', { pitch: 0.7 });
  g.burst(px + f * 120, s.gy, { color: '#bbb', n: 16, speed: 180, size: 9 });
  g.text(px, GROUND - 440, 'TROPPO PRESTO!', { player: i, size: 46 });
  g.vibrate(i, 160);
  g.shake(0.25);
  const rest = alive(s);
  if (rest.length === 1) {
    s.p[rest[0]] = pose('laugh');
    s.rt = fill(s.n, -1);
    award(s, rest[0], 'INCEPPATA!', 'jam', g);
  }
}

// Feint: a sudden fake draw before the signal (costs your dodge for this duel, except in Lumaca).
function feint(s, i, g) {
  const q = s.pl[i];
  if (q.feint || (!slug(g) && q.left <= 0)) { g.sfx('click', { vol: 0.3, pitch: 0.8 }); return; }
  q.feint = true;
  if (!slug(g)) q.left--;
  s.p[i] = pose('feint');
  g.sfx('click', { pitch: 0.7 }); g.sfx('whoosh', { vol: 0.5, pitch: 1.4 });
  g.shake(0.08);
}

function act(s, e, g) {
  if (s.out[e.i]) return;
  const q = s.pl[e.i];
  if (e.k === 'b') {
    if (rolling(q, e.t)) return;
    if (slug(g) ? e.t < q.cd : q.left <= 0) { g.sfx('click', { vol: 0.3, pitch: 0.8 }); return; }
    q.dodge = e.t;
    if (slug(g)) q.cd = e.t + SLUG.cd; else q.left--;
    s.p[e.i] = pose('roll');
    g.sfx('dash'); g.sfx('whoosh', { vol: 0.5 });
    g.burst(s.px[e.i], GROUND - 10, { color: '#c9a36a', n: 12, speed: 200, size: 10 });
    return;
  }
  // Shooting while rolling: the shot comes out as soon as the roll ends (no press is lost).
  if (rolling(q, e.t)) { s.ev.push({ i: e.i, k: 'a', t: q.dodge + DODGE_T + 0.001 }); return; }
  if (e.t < q.reload) {
    g.sfx('click', { pitch: 1.5 });
    s.p[e.i] = pose('dry');
    return;
  }
  const to = aim(s, e.i);
  if (to < 0) return;
  q.reload = e.t + (slug(g) ? SLUG.reload : RELOAD);
  s.shots++;
  if (s.rt[e.i] < 0) s.rt[e.i] = Math.max(0, e.t);
  s.word = '';
  s.p[e.i] = pose('shoot');
  const f = s.px[to] > s.px[e.i] ? 1 : -1;
  g.sfx('shoot'); g.sfx('bang', { vol: 0.8 });
  g.burst(s.px[e.i] + f * MUZ, s.gy, { color: '#ffd23f', n: 16, speed: 300, size: 8 });
  if (g.variant === 'buio') g.flash('#fff', 0.35);
  const dur = slug(g) ? Math.max(SLUG.min, SLUG.first * SLUG.mul ** s.nSlug++) : 0;
  s.bul.push({ from: e.i, to, t0: e.t, ta: e.t + dur, dur });
  if (slug(g) && s.shots === 1) g.say('SCHIVA CON B!');
}

function arrive(s, b, g) {
  const tgt = b.to, q = s.pl[tgt];
  s.tr.push({ f: b.from, o: tgt, at: s.clock, m: rolling(q, b.ta) ? 1 : 0 });
  if (s.tr.length > 4) s.tr.shift();
  if (rolling(q, b.ta)) {
    s.dodged[tgt] = 1;
    g.sfx('whoosh'); g.sfx('boing', { pitch: 1.3 });
    g.text(s.px[tgt], GROUND - 440, 'SCHIVATO!', { player: tgt, size: 50 });
    if (!slug(g)) g.text(s.px[b.from], GROUND - 440, 'SCARICA!', { player: b.from, size: 40 });
    g.shake(0.15);
    return;
  }
  // Two bolts landing in the very same instant: double hit, duel replayed.
  const twin = s.bul.find((o) => o.from !== b.from && Math.abs(o.ta - b.ta) < 0.0005 && !rolling(s.pl[o.to], o.ta));
  if (twin) {
    g.sfx('bonk');
    s.p[b.from] = pose('shoot'); s.p[twin.from] = pose('shoot');
    toRes(s, 'PARI!', 'draw', -1);
    return;
  }
  s.p[tgt] = pose('fall');
  if (s.p[b.from].st !== 'shoot') s.p[b.from] = pose('shoot');
  g.sfx('hit'); g.sfx('fall', { vol: 0.7 });
  g.burst(s.px[tgt], GROUND - 230, { player: tgt, n: 26, speed: 360 });
  g.shake(0.55); g.vibrate(tgt, 220);
  const counter = s.dodged[b.from] === 1;
  if (counter) g.text(s.px[b.from], GROUND - 440, 'CONTROPIEDE!', { player: b.from, size: 46 });
  s.hit = tgt;
  award(s, b.from, 'COLPITO!', counter ? 'counter' : 'fast', g);
}

// Next thing to resolve on the duel timeline: presses first on ties (a dodge at the last instant counts).
function nextItem(s, horizon) {
  let best = null;
  for (const e of s.ev) if (e.t <= horizon && (!best || e.t < best.t)) best = e;
  for (const b of s.bul) if (b.ta <= horizon && (!best || b.ta < best.t)) best = { b, t: b.ta };
  return best;
}

// ---------- Bot helpers ----------
const BOT_LAG = [0.34, 0.2, 0.09].map((d) => d + TICK); // the driver's reaction delay per level (+1 tick)
const BOT_TRAP = [0.12, 0.04, 0.01];   // chance to shoot on a trap word
const BOT_BAIT = [0.15, 0.05, 0];      // chance to shoot when a rival feints
const BOT_FEINT = [0, 0.15, 0.35];     // chance to try a feint in a duel
const BOT_DODGE = [0.35, 0.8, 1];      // slow bolts: chance to try to roll away (and how well it is timed)

export default {
  id: 'fuoco',
  name: 'Balestra Lesta',
  rule: 'Tira solo quando leggi FUOCO! Occhio alle trappole',
  verb: 'TIRA!',
  inspired: '1-2-Switch · Quick Draw',
  cam: 'side',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: null, a: 'Tira', b: 'Schiva/Finta' },
  help: {
    goal: 'Vinci 3 duelli: il primo dardo che colpisce dopo FUOCO! vince il duello.',
    dir: null,
    a: "TIRA con la balestra. Solo dopo FUOCO!: se tiri prima (o su una parola trappola) la balestra s'inceppa e sei fuori dal duello. Dopo un tiro resta scarica per quasi 1 s.",
    b: "Dopo FUOCO!: SCHIVA, una capriola di mezzo secondo in cui i dardi ti mancano (e chi ha tirato resta scarico: rispondi!). Prima di FUOCO!: FINTA, per far tirare gli altri troppo presto. Una per duello (i pallini sotto i piedi).",
    tips: ['In 3–4 ognuno mira a un solo rivale: guarda il colore sotto i piedi', 'Chi è dietro al primo ha 2 schivate per duello', 'Notte Fonda: ascolta! BUM = vero, tappo = finto'],
  },
  duration: 45,
  noMods: ['scambio', 'nonna', 'peperoncino'],
  variants: [
    { id: 'parole', name: 'Parole Trappola', desc: 'Il banditore grida parole quasi uguali a FUOCO!' },
    { id: 'buio', name: 'Notte Fonda', desc: 'Buio pesto: tira al BUM, non al tappo!' },
    { id: 'lumaca', name: 'Dardi Lumaca', desc: 'Dardi lentissimi: schiva con B e rispondi al tiro!' },
  ],

  init(g) {
    const n = g.n || 2;
    return {
      n, px: pxOf(n), gy: gunOf(n),
      ph: 'ready', pt: 0, clock: 0, duel: 0, sc: fill(n, 0), best: fill(n, 9), last: -1, hit: -1,
      word: '', wordT: 9, real: false, rt: fill(n, -1), msg: '', why: '', win: -1, jam: -1, traps: [], trapIdx: 0,
      p: fill(n, 0).map(() => pose('idle')), ev: [], bul: [], tr: [], shots: 0, nSlug: 0, dodged: fill(n, 0), twDir: 1,
      out: fill(n, 0), tg: ringTargets(n),
      pl: fill(n, 0).map(() => ({ left: 1, max: 1, dodge: -99, reload: -99, cd: -99, feint: false })),
    };
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.clock += TICK;
    s.pt += dt;
    s.wordT += dt;
    for (const p of s.p) p.t += dt;
    if (g.ended) return;

    if (s.ph === 'ready') {
      if (s.pt >= READY_TIME) startDuel(s, g);
      return;
    }

    if (s.ph === 'wait') {
      // Early trigger: everyone who jumped the gun jams, earliest press first.
      const early = [];
      for (let i = 0; i < s.n; i++) if (inp[i].aP && !s.out[i]) early.push(i);
      if (early.length) {
        early.sort((a, b) => inp[a].aT - inp[b].aT);
        for (const i of early) { if (s.ph !== 'wait') break; jam(s, i, g); }
        if (s.ph !== 'wait') return;
      }
      for (let i = 0; i < s.n; i++) if (inp[i].bP && !s.out[i]) feint(s, i, g);
      if (s.trapIdx < s.traps.length && s.pt >= s.traps[s.trapIdx].at) {
        showWord(s, g, s.traps[s.trapIdx].w, false);
        s.trapIdx++;
      }
      const show = g.variant === 'parole' ? 0.42 : 0.55;
      if (s.word && s.wordT > show) s.word = '';
      // Tension: heartbeat speeding up + wind over the range.
      if (s.pt >= s.nextBeat) {
        g.sfx('tick', { vol: 0.25, pitch: 0.55 });
        s.nextBeat += Math.max(0.28, 0.65 - s.pt * 0.07);
      }
      if (s.pt >= s.nextWind) {
        g.sfx('whoosh', { vol: 0.2, pitch: 0.5 });
        s.nextWind += g.rng.range(1.2, 2.4);
      }
      if (s.pt >= s.waitAt) {
        s.ph = 'fire'; s.pt = 0; s.sigReal = s.clock;
        s.p = s.p.map((p, i) => (p.st === 'feint' && !s.out[i] ? pose('aim') : p));
        showWord(s, g, 'FUOCO!', true);
      }
      return;
    }

    if (s.ph === 'fire') {
      const now = s.clock - s.sigReal;
      for (let i = 0; i < s.n; i++) {
        const ip = inp[i];
        for (const k of ['a', 'b']) {
          if (!ip[k + 'P'] || s.out[i]) continue;
          const stamp = ip[k + 'T'];
          const t = (stamp >= 0 ? stamp : s.clock) - s.sigReal;
          if (k === 'a' && t < -EARLY_TOL && s.shots === 0) { jam(s, i, g); if (s.ph !== 'fire') return; continue; }
          s.ev.push({ i, k, t: Math.max(t, 0) });
        }
      }
      const horizon = now - LAG;
      for (let guard = 0; guard < 32 && s.ph === 'fire'; guard++) {
        const it = nextItem(s, horizon);
        if (!it) break;
        if (it.b) { s.bul.splice(s.bul.indexOf(it.b), 1); arrive(s, it.b, g); }
        else { s.ev.splice(s.ev.indexOf(it), 1); act(s, it, g); }
      }
      if (s.ph !== 'fire') {
        if (s.win >= 0 && s.rt[s.win] >= 0) s.best[s.win] = Math.min(s.best[s.win], s.rt[s.win]);
        return;
      }
      if (s.shots === 0 && now > TOO_SLOW) {
        g.sfx('quack');
        toRes(s, 'TROPPO LENTI!', 'slow', -1);
      } else if (now > MAX_DUEL) {
        g.sfx('quack');
        toRes(s, 'STALLO!', 'stall', -1);
      }
      return;
    }

    if (s.ph === 'res' && s.pt >= RES_TIME) {
      s.ph = 'ready'; s.pt = 0; s.word = ''; s.tr = []; s.hit = -1;
      s.out = fill(s.n, 0);
      s.p = s.p.map(() => pose('idle'));
    }
  },

  // Computer player: waits for the real FUOCO! (the weaker ones sometimes fall for a trap word or a feint),
  // shoots at its prey, never into a roll (Cavaliere/Re), rolls away from slow bolts and from the counter.
  bot(s, me, g, B) {
    const M = B.mem, L = B.level, w = { x: 0, y: 0 };
    if (g.ended || s.out[me] || s.ph === 'ready' || s.ph === 'res') return w;
    const lag = BOT_LAG[L], q = s.pl[me], sl = slug(g);
    if (M.duel !== s.duel) {
      M.duel = s.duel; M.trap = s.trapIdx; M.fooled = false; M.shotT = -9; M.dodgeAt = -1; M.bolt = '';
      M.feintAt = B.rng() < BOT_FEINT[L] ? 0.5 + B.rng() * 2.5 : -1;
      M.feints = s.p.map((p) => p.st === 'feint');
    }
    if (s.ph === 'wait') {
      if (s.trapIdx !== M.trap) { M.trap = s.trapIdx; if (B.rng() < BOT_TRAP[L] * (g.variant === 'parole' ? 0.5 : 1)) M.fooled = true; }
      for (let i = 0; i < s.n; i++) {
        const f = s.p[i].st === 'feint';
        if (i !== me && f && !M.feints[i] && B.rng() < BOT_BAIT[L]) M.fooled = true;
        M.feints[i] = f;
      }
      if (M.fooled) { M.fooled = false; w.tapA = true; return w; }
      if (M.feintAt >= 0 && s.pt >= M.feintAt) {
        M.feintAt = -1;
        if (!q.feint && (sl || q.left > 0)) w.tapB = true;
      }
      return w;
    }
    // FUOCO! — duel time of a press made now (when it reaches the crossbow).
    const now = s.clock - s.sigReal, at = now + lag;
    // Slow bolts coming at me: plan a roll that covers the arrival.
    if (sl) {
      let bo = null;
      for (const b of s.bul) if (b.to === me && b.ta > now && (!bo || b.ta < bo.ta)) bo = b;
      const key = bo ? `${bo.from}:${bo.t0}` : '';
      if (bo && key !== M.bolt) {
        M.bolt = key;
        M.dodgeAt = B.rng() < BOT_DODGE[L] ? bo.ta - 0.22 - lag + (B.rng() - 0.5) * [0.4, 0.16, 0.04][L] : -1;
      }
    } else if (L >= 1 && q.left > 0 && at < q.reload && M.dodgeAt < now) {
      // My bolt got dodged and I am reloading: the rival will shoot as soon as its roll ends. Roll over it.
      for (let i = 0; i < s.n; i++) {
        if (i === me || s.out[i] || aim(s, i) !== me || !rolling(s.pl[i], now)) continue;
        if (L === 2 || B.rng() < 0.5) M.dodgeAt = s.pl[i].dodge + DODGE_T - 0.12 - lag;
        break;
      }
    }
    if (M.dodgeAt >= 0 && now >= M.dodgeAt) {
      M.dodgeAt = -1;
      if (!rolling(q, at) && (sl ? at >= q.cd : q.left > 0)) { w.tapB = true; return w; }
    }
    if (M.dodgeAt >= 0 && M.dodgeAt - now < 0.15) return w; // about to roll: do not shoot now
    const to = aim(s, me);
    if (to < 0 || at < q.reload || g.t - M.shotT < lag + 0.1) return w;
    if (L >= 1 && !sl && rolling(s.pl[to], at)) return w; // wait for the roll to end
    w.tapA = true; M.shotT = g.t;
    return w;
  },

  timeout(s) {
    const top = Math.max(...s.sc);
    let cand = s.sc.map((v, i) => (v === top ? i : -1)).filter((i) => i >= 0);
    if (cand.length === 1) return cand[0];
    const fast = Math.min(...cand.map((i) => s.best[i]));
    if (fast < 9) {
      cand = cand.filter((i) => s.best[i] === fast);
      if (cand.length === 1) return cand[0];
    }
    return cand.includes(s.last) ? s.last : top > 0 ? cand[0] : s.last;
  },

  view(s) {
    const now = s.ph === 'fire' ? s.clock - s.sigReal : 0;
    const bul = s.bul.map((b) => {
      const k = b.dur > 0 ? clamp((now - b.t0) / b.dur, 0, 1) : 1;
      const f = s.px[b.to] > s.px[b.from] ? 1 : -1;
      return [r1(lerp(s.px[b.from] + f * MUZ, s.px[b.to], k)), b.from, b.to];
    });
    const tw = s.ph === 'wait' ? (s.twDir > 0 ? -150 + s.pt * 420 : W + 150 - s.pt * 420) : -999;
    return {
      ph: s.ph, pt: r2(s.pt), w: s.word, wt: r2(s.wordT), real: s.real ? 1 : 0,
      rt: s.rt.map(r3), msg: s.msg, why: s.why, win: s.win, jam: s.jam, hit: s.hit, n: s.duel,
      p: s.p.map((p) => ({ st: p.st, t: r2(Math.min(p.t, 9)) })),
      tg: s.p.map((_, i) => aim(s, i)), out: s.out.slice(),
      pl: s.pl.map((q) => ({
        d: q.left, m: q.max, cd: s.ph === 'fire' ? r2(clamp((q.cd - now) / SLUG.cd, 0, 1)) : 0,
        rl: s.ph === 'fire' ? r2(clamp((q.reload - now) / RELOAD, 0, 1)) : 0,
      })),
      tr: s.tr.map((t) => ({ f: t.f, o: t.o, a: r2(s.clock - t.at), m: t.m })),
      bul, tw: r1(tw),
      hud: { p: s.sc.slice(), max: WIN, label: 'Duelli' },
    };
  },

  focus(v) {
    const px = pxOf(v.p.length);
    return v.p.map((_, i) => ({ x: px[i], y: GROUND - 200 }));
  },

  // ---------- 3D: the castle's archery range at sunset — crossbow duel in front of the walls ----------
  render3d: {
    assets: [
      'medieval/building_castle_red', 'medieval/wall_straight', 'medieval/wall_straight_gate',
      'medieval/building_tower_A_red', 'medieval/building_tower_A_blue', 'medieval/building_tower_B_green', 'medieval/building_tower_B_yellow',
      'medieval/building_archeryrange_red', 'medieval/building_archeryrange_blue',
      'medieval/target', 'medieval/tent', 'medieval/weaponrack', 'medieval/bucket_arrows', 'medieval/barrel', 'medieval/crate_A_big',
      'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow',
      'medieval/trees_A_large', 'medieval/trees_B_large', 'medieval/tree_single_A', 'medieval/tree_single_B',
      'medieval/hills_A_trees', 'medieval/hills_B_trees', 'medieval/mountain_A_grass_trees', 'medieval/mountain_B_grass_trees', 'medieval/mountain_C_grass',
      'medieval/cloud_big', 'medieval/cloud_small', 'medieval/rock_single_A', 'medieval/rock_single_C',
      'weapons/crossbow_1handed', 'weapons/arrow', 'weapons/Skeleton_Arrow_Broken',
    ],
    build(K, r) {
      const T = K.THREE;
      const dark = r.variant === 'buio';
      const n = clamp(r.n || (r.roster && r.roster.length) || 2, 2, 4);
      const hi = K.quality > 0;
      K.theme('tramonto', { fogNear: 1.5, fogFar: 4.2 });
      const o = { dark, n, lastWord: '', pl: [], tr: [], bul: [], eyes: [], v3: new T.Vector3() };

      // Sun low behind the castle, slowly turning rays.
      const sun = K.group(); K.place(sun, W / 2 + 120, GROUND - 330, -2900);
      for (const [rr, col, op] of [[820, '#ffb46a', 0.25], [560, '#ffcf6a', 0.55], [430, '#ffe9a0', 1]]) {
        const m = K.glow(col, { opacity: op, unique: true }); m.fog = false;
        K.disc(rr, m, { parent: sun });
      }
      o.rays = K.mesh(new T.PlaneGeometry(3600, 3600), new T.MeshBasicMaterial({
        map: K.canvasTex(512, 512, (d, ctx) => {
          ctx.translate(256, 256);
          for (let k = 0; k < 14; k++) {
            const a = (k / 14) * Math.PI * 2;
            d.poly([0, 0, Math.cos(a - 0.07) * 256, Math.sin(a - 0.07) * 256, Math.cos(a + 0.07) * 256, Math.sin(a + 0.07) * 256], 'rgba(255,214,150,0.13)');
          }
        }), transparent: true, depthWrite: false, fog: false,
      }), { parent: sun, cast: false, receive: false });
      o.rays.position.z = -10;

      // Floor: meadow everywhere + the trampled dirt lane of the shooting line + a stone kerb.
      flat(K, 'erba', GROUND, -4200, 900, -4200, W + 4200, 170, '#cfe0a0');
      flat(K, 'terra', GROUND - 1, -190, 280, -4200, W + 4200, 150, '#e8c9a0');
      K.place(K.box(W + 8400, 10, 18, K.texMat('pietra', [60, 1], { color: '#c8b8a8' }), { cast: false }), W / 2, GROUND - 4, -195);

      // Far away: mountains and wooded hills.
      K.scatter('medieval/mountain_A_grass_trees', [{ x: -2200, y: GROUND, h: -4300 }, { x: 2600, y: GROUND, h: -4400, rot: 1.2 }], { size: 2400 });
      K.scatter('medieval/mountain_B_grass_trees', [{ x: 300, y: GROUND, h: -4800, rot: 0.6 }, { x: 4200, y: GROUND, h: -4200 }], { size: 2600 });
      K.scatter('medieval/mountain_C_grass', [{ x: -400, y: GROUND, h: -3900, rot: 2 }, { x: 1700, y: GROUND, h: -4100, rot: 0.3 }], { size: 1900 });
      K.scatter('medieval/hills_A_trees', [-2600, -1200, 1000, 2600, 4000].map((x, k) => ({ x, y: GROUND, h: -2900 - (k % 2) * 250, rot: k })), { size: 1300 });
      K.scatter('medieval/hills_B_trees', [-1900, 200, 1900, 3300].map((x, k) => ({ x, y: GROUND, h: -2500 - (k % 2) * 200, rot: k * 2 })), { size: 1100 });

      // The castle and its walls (towers in the four team colors).
      const castle = K.model('medieval/building_castle_red', { height: 1150 });
      K.place(castle, W / 2, GROUND, -1900);
      const wallItems = [];
      for (let k = -8; k <= 8; k++) if (k) wallItems.push({ x: W / 2 + k * 470, y: GROUND, h: -1700 });
      K.scatter('medieval/wall_straight', wallItems, { size: 480 });
      K.place(K.model('medieval/wall_straight_gate', { size: 480 }), W / 2, GROUND, -1700);
      [['medieval/building_tower_A_red', -1200], ['medieval/building_tower_A_blue', W + 1200], ['medieval/building_tower_B_green', -300], ['medieval/building_tower_B_yellow', W + 300]]
        .forEach(([m, x]) => K.place(K.model(m, { height: 640 }), x, GROUND, -1720));

      // The range: archery buildings at the sides, straw targets, tents, trees.
      const arL = K.model('medieval/building_archeryrange_red', { size: 560 }); K.place(arL, -330, GROUND, -760); arL.rotation.y = 0.5;
      const arR = K.model('medieval/building_archeryrange_blue', { size: 560 }); K.place(arR, W + 330, GROUND, -760); arR.rotation.y = -0.5;
      K.scatter('medieval/target', [180, 430, 690, 910, 1170, 1420].map((x, k) => ({ x, y: GROUND, h: -1050 - (k % 2) * 90, rot: (k % 3 - 1) * 0.15 })), { height: 190 });
      K.scatter('medieval/tent', [{ x: -720, y: GROUND, h: -1250, rot: 0.4 }, { x: W + 720, y: GROUND, h: -1250, rot: -0.4 }, { x: -1250, y: GROUND, h: -1000, rot: 1 }], { size: 330 });
      K.scatter('medieval/trees_A_large', [-1500, -900, W + 900, W + 1500].map((x, k) => ({ x, y: GROUND, h: -1300 + (k % 2) * 150, rot: k })), { size: 520 });
      K.scatter('medieval/trees_B_large', [-2100, W + 2100, -400, W + 400].map((x, k) => ({ x, y: GROUND, h: -2200 - (k % 2) * 200, rot: k * 2 })), { size: 600 });
      K.scatter('medieval/tree_single_A', [{ x: -560, y: GROUND, h: -420 }, { x: W + 600, y: GROUND, h: -480, rot: 2 }, { x: -900, y: GROUND, h: -200 }], { height: 420 });
      K.scatter('medieval/tree_single_B', [{ x: W + 900, y: GROUND, h: -260 }, { x: -1250, y: GROUND, h: -560 }], { height: 380 });
      K.scatter('medieval/rock_single_A', [{ x: -300, y: GROUND, h: -60 }, { x: W + 380, y: GROUND, h: -120, rot: 1 }], { size: 120 });
      K.scatter('medieval/rock_single_C', [{ x: 760, y: GROUND, h: -980 }, { x: -60, y: GROUND, h: -1500 }], { size: 140 });
      // Props at the sides of the lane (behind the archers, never in front of them).
      if (hi) {
        K.scatter('medieval/weaponrack', [{ x: 40, y: GROUND, h: -330 }, { x: W - 40, y: GROUND, h: -330 }], { height: 150 });
        K.scatter('medieval/bucket_arrows', [{ x: 105, y: GROUND, h: -300 }, { x: W - 110, y: GROUND, h: -280 }, { x: 800, y: GROUND, h: -420 }], { height: 80 });
        K.scatter('medieval/barrel', [{ x: -60, y: GROUND, h: -260 }, { x: W + 60, y: GROUND, h: -250 }, { x: -110, y: GROUND, h: -330 }], { height: 70 });
        K.scatter('medieval/crate_A_big', [{ x: W + 130, y: GROUND, h: -330, rot: 0.4 }, { x: -170, y: GROUND, h: -240, rot: 0.2 }], { height: 70 });
      }
      // Team banners behind each archer.
      o.flags = [];
      const FL = ['red', 'blue', 'green', 'yellow'];
      const px0 = pxOf(n);
      for (let i = 0; i < n; i++) {
        const f = K.model(`medieval/flag_${FL[(r.roster?.[i]?.color ?? i) % 4]}`, { height: 230 });
        K.place(f, px0[i] + (i < n / 2 ? -90 : 90), GROUND, -520);
        f.rotation.y = Math.PI / 2;
        o.flags.push(f);
      }
      K.ambient('foglie', { n: 45, x0: -400, x1: W + 400, y0: -100, y1: GROUND });

      // Clouds drifting in the evening sky, crows circling.
      o.clouds = [0, 1, 2, 3].map((k) => K.model(k % 2 ? 'medieval/cloud_small' : 'medieval/cloud_big', { size: k % 2 ? 520 : 820, cast: false }));
      o.crow = [0, 1].map(() => {
        const g = K.group();
        const m = K.mat('#20101a', { rough: 1 });
        K.ball(1, m, { parent: g, cast: false, seg: 8 }).scale.set(16, 8, 8);
        const wings = [-1, 1].map((sg) => {
          const w = K.mesh(new T.BoxGeometry(36, 3, 12), m, { parent: g, cast: false });
          w.geometry.translate(18, 0, 0);
          w.scale.x = sg;
          return w;
        });
        return { g, wings };
      });
      // Hay bale rolling across the lane while you wait.
      o.hay = K.group();
      K.cyl(52, 80, K.texMat('paglia', [2, 1], { color: '#f3d58a' }), { parent: o.hay, center: true, seg: 18 });
      for (const z of [-22, 22]) K.torus(52, 3, K.mat('#8a5a2a'), { parent: o.hay, cast: false }).position.z = z;

      // Archers.
      for (let i = 0; i < n; i++) o.pl.push(makeArcher(K, i));

      // Shot tracers + their flying bolts, and the slow "snail" bolts (pools).
      const unit = new T.CylinderGeometry(1, 1, 1, 10);
      for (let k = 0; k < 4; k++) {
        o.tr.push({
          a: K.mesh(unit, K.glow('#ffe9a0', { add: true, unique: true }), { cast: false }),
          b: K.mesh(unit, K.glow('#ffffff', { unique: true }), { cast: false }),
          bolt: makeBolt(K, 150),
        });
        o.bul.push(makeSnail(K, n));
      }

      // The herald's parchment banner hanging over the lane (shows the word).
      o.sign = K.group();
      o.signMat = K.mat('#f1deb0', { rough: 0.85, unique: true });
      const rod = K.mat('#5a3418', { rough: 0.7 });
      K.box(1190, 255, 16, o.signMat, { parent: o.sign });
      for (const sy of [-1, 1]) {
        const rr = K.mesh(new T.CylinderGeometry(18, 18, 1290, 12).rotateZ(Math.PI / 2), rod, { parent: o.sign });
        rr.position.set(0, sy * 136, 4);
        for (const sx of [-1, 1]) K.ball(24, K.mat('#c9a03a', { metal: 0.5, rough: 0.35 }), { parent: o.sign, cast: false, seg: 10 }).position.set(sx * 655, sy * 136, 4);
      }
      for (const sx of [-1, 1]) {
        const rope = K.mesh(new T.CylinderGeometry(5, 5, 900, 6), K.mat('#d8b07a', { rough: 1 }), { parent: o.sign, cast: false });
        rope.position.set(sx * 520, 136 + 450, -4);
      }
      o.signGlow = K.disc(1, K.glow('#ff3c1e', { opacity: 0.35, add: true }), { parent: o.sign });
      o.signGlow.position.z = -30;
      o.word = K.billboard(1024, 224, 1160, (d, w, h, word, real) => {
        if (!word) return;
        const size = Math.min(190, 1500 / Math.max(5, word.length));
        if (real) d.neon(() => d.text(word, w / 2, h / 2, { size, color: '#ff2a1a', strokeColor: '#3a0a04' }), '#ff2a2a');
        else d.text(word, w / 2, h / 2, { size, color: '#5a2a10', strokeColor: '#f9ecc8' });
      }, { parent: o.sign });
      o.word.position.z = 24;

      // Darkness / tension vignette over the scene, then the flat UI on top.
      o.veil = K.layer({
        x0: -1300, y0: -900, x1: W + 1300, y1: H + 900, h: 0, transparent: true, lit: false, z: 4, maxPx: 512,
        draw: (d, v) => drawVeil3d(d, v, dark),
        key: (v) => `${Math.round(tension3d(v) * 20)}|${dark ? Math.round(darkness3d(v) * 20) : ''}`,
      });
      o.veil.mesh.material.depthTest = false; o.veil.mesh.renderOrder = 40;
      if (dark) {
        for (let k = 0; k < 8; k++) {
          const e = K.ball(7, K.glow('#ffffc8', { opacity: 0.85 }), { cast: false });
          e.material.depthTest = false; e.renderOrder = 45;
          o.eyes.push(e);
        }
      }
      o.ui = K.layer({
        x0: 0, y0: 0, x1: W, y1: H, h: 0, transparent: true, lit: false, z: 6,
        draw: (d, v, rr) => drawUi3d(d, v, rr, dark),
        key: (v) => uiKey3d(v, K, dark),
      });
      o.ui.mesh.material.depthTest = false; o.ui.mesh.renderOrder = 50;
      return o;
    },

    update(K, o, v) {
      const t = K.t;
      const n = Math.min(v.p.length, o.pl.length);
      const px = pxOf(v.p.length), R = radOf(v.p.length), gy = gunOf(v.p.length);
      const tension = tension3d(v);
      o.rays.rotation.z = -t * 0.04;
      o.clouds.forEach((g, k) => K.place(g, ((k * 1300 + t * (16 + k * 6)) % (W + 5200)) - 2600, -150 + k * 90, -2300 - k * 150));
      o.crow.forEach((V, k) => {
        const a = t * (0.5 + k * 0.2) + k * 2;
        K.place(V.g, W / 2 + Math.cos(a) * (360 + k * 120), 120 + Math.sin(a) * 40 + k * 40, -900 + Math.sin(a) * 250);
        V.g.rotation.y = Math.sin(a) > 0 ? 0 : Math.PI;
        const fl = Math.sin(t * 7 + k) * 0.55;
        V.wings[0].rotation.z = fl; V.wings[1].rotation.z = -fl;
      });
      o.flags.forEach((f, k) => { f.rotation.y = Math.PI / 2 + Math.sin(t * 1.8 + k * 1.3) * 0.18; });

      // Hay bale.
      o.hay.visible = v.tw > -500;
      if (o.hay.visible) {
        K.place(o.hay, v.tw, GROUND - 52 - Math.abs(Math.sin(v.tw / 90)) * 30, -260);
        o.hay.rotation.z = -v.tw / 44;
      }

      // Archers.
      for (let i = 0; i < n; i++) poseArcher(K, o.pl[i], i, v, px, R, gy, t);

      // Tracers + flying bolts.
      o.tr.forEach((T3, k) => {
        const tr = v.tr[k];
        const on = !!tr && tr.a <= 0.3 && px[tr.o] !== undefined;
        T3.a.visible = T3.b.visible = T3.bolt.g.visible = on;
        if (!on) return;
        const f = px[tr.o] > px[tr.f] ? 1 : -1, x0 = px[tr.f] + f * MUZ, al = 1 - tr.a / 0.3;
        const y1 = tr.m ? gy - 120 : gy - 20, x1 = tr.m ? (f > 0 ? W + 400 : -400) : px[tr.o];
        segW(T3.a, x0, -gy, x1, -y1, 70, 5 * al + 1);
        segW(T3.b, x0, -gy, x1, -y1, 70, 1.6);
        T3.a.material.opacity = 0.9 * al;
        T3.a.material.color.set(K.col(tr.f, 'light'));
        T3.b.material.opacity = al;
        const kk = Math.min(1, tr.a / 0.06);
        K.place(T3.bolt.g, lerp(x0, x1, kk), lerp(gy, y1, kk), 70);
        T3.bolt.g.rotation.z = Math.atan2(-(y1 - gy), x1 - x0);
      });

      // Snail bolts (Dardi Lumaca).
      o.bul.forEach((B, k) => {
        const b = v.bul[k];
        B.g.visible = !!b;
        if (!b) return;
        const [bx, bf, bt] = b, f = (px[bt] ?? 0) > px[bf] ? 1 : -1;
        K.place(B.g, bx, gy + Math.sin(t * 9 + bx * 0.01) * 6, 70);
        B.g.scale.x = f;
        B.ring.material = B.rings[bf] || B.rings[0];
        B.ring.rotation.z = t * 3;
      });

      // Parchment banner: drops in with a pop, red and glowing for the real FUOCO!.
      const show = !o.dark && (v.ph === 'wait' || v.ph === 'fire') && !!v.w;
      o.sign.visible = show;
      if (show) {
        const key = v.w + v.real;
        if (key !== o.lastWord) { o.lastWord = key; o.word.redraw(v.w, v.real); }
        const pop = 1 + 0.3 * Math.max(0, 1 - v.wt / 0.1);
        const drop = Math.max(0, 1 - v.wt / 0.07);
        K.place(o.sign, W / 2, 230 - drop * 160, 90);
        o.sign.scale.setScalar(0.6 * pop);
        o.sign.rotation.z = Math.sin(t * 2.4) * 0.025 + drop * 0.08;
        o.signMat.emissive.set(v.real ? '#ff2a10' : '#000000');
        o.signMat.emissiveIntensity = v.real ? 0.3 + Math.sin(t * 30) * 0.1 : 0;
        o.signGlow.visible = !!v.real;
        o.signGlow.scale.setScalar(720 + Math.sin(t * 30) * 20);
      }

      // Notte Fonda: glowing eyes in the dark.
      if (o.dark) {
        const a = darkness3d(v);
        o.eyes.forEach((e) => { e.visible = false; });
        for (let i = 0; i < n; i++) {
          const p = v.p[i];
          const hy = GROUND - R * 1.95 + (p.st === 'roll' ? 40 : 0);
          const on = p.st !== 'fall' && a >= 0.7 && Math.sin(t * 2.3 + i * 2) <= 0.97;
          for (const sd of [0, 1]) {
            const e = o.eyes[i * 2 + sd];
            e.visible = on;
            K.place(e, px[i] + (sd ? 16 : -16), hy, 160);
          }
        }
      }
    },
  },

  render(d, v, r) {
    const ctx = d.ctx;
    const dark = r.variant === 'buio';
    const px = pxOf(v.p.length), gy = gunOf(v.p.length);
    const tension = v.ph === 'wait' ? clamp(v.pt / 4, 0, 1) : v.ph === 'fire' ? 1 : 0;
    drawBackdrop(d, tension);

    // Hay bale rolling by during the wait.
    if (v.tw > -500) {
      const rot = v.tw / 40;
      const ty = GROUND - 32 - Math.abs(Math.sin(v.tw / 90)) * 40;
      d.shadow(v.tw, GROUND + 4, 34, 8, 0.25);
      d.circle(v.tw, ty, 34, '#e8c46a', '#a07a30', 5);
      for (let k = 0; k < 3; k++) {
        const a = rot + k * 2.1;
        d.line(v.tw, ty, v.tw + Math.cos(a) * 30, ty + Math.sin(a) * 30, '#a07a30', 3);
      }
    }

    // Shot tracers.
    for (const t of v.tr) {
      if (t.a > 0.3 || px[t.o] === undefined) continue;
      const f = px[t.o] > px[t.f] ? 1 : -1, x0 = px[t.f] + f * MUZ, al = 1 - t.a / 0.3;
      const y1 = t.m ? gy - 120 : gy - 20, x1 = t.m ? (f > 0 ? W + 300 : -300) : px[t.o];
      d.line(x0, gy, x1, y1, `rgba(255,240,180,${0.9 * al})`, 10 * al + 2);
      d.line(x0, gy, x1, y1, `rgba(255,255,255,${al})`, 3);
    }

    v.p.forEach((p, i) => {
      const f = px[v.tg[i]] !== undefined ? (px[v.tg[i]] > px[i] ? 1 : -1) : (px[i] < W / 2 ? 1 : -1);
      drawArcher(d, px[i], f, i, p.st, p.t, v.win === i && v.ph === 'res', v.p.length);
    });

    // The slow snail-bolts.
    for (const [bx, bf, bt] of v.bul) {
      const f = (px[bt] ?? 0) > px[bf] ? 1 : -1, by = gy + Math.sin(d.t * 9 + bx * 0.01) * 6;
      for (let k = 1; k <= 4; k++) d.circle(bx - f * k * 26, by, 10 - k * 2, 'rgba(255,255,255,0.3)');
      d.line(bx - f * 40, by, bx + f * 34, by, '#7a4a20', 8);
      d.poly([bx + f * 34, by - 12, bx + f * 56, by, bx + f * 34, by + 12], '#c9ccd6');
      d.circle(bx - f * 6, by - 28, 22, '#c2703a', '#5a2a10', 3);
      d.arc(bx - f * 6, by - 28, 11, 0, 5, '#5a2a10', 3);
      d.ring(bx, by, 46, d.col(bf, 'light') + '99', 4);
    }

    if (dark) {
      // Pitch black: light only from the shots, plus glowing eyes.
      let a = 1;
      if (v.ph === 'res') a = clamp(0.35 + v.pt * 0.4, 0.35, 0.92);
      for (const t of v.tr) if (t.a < 0.35) a = Math.min(a, 0.3 + t.a * 2);
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      ctx.fillRect(-900, -900, W + 1800, H + 1800);
      v.p.forEach((p, i) => {
        if (p.st === 'fall' || a < 0.7) return;
        const hy = GROUND - 330 + (p.st === 'roll' ? 60 : 0);
        const blink = Math.sin(d.t * 2.3 + i * 2) > 0.97 ? 0.2 : 1;
        d.circle(px[i] - 18, hy, 7, `rgba(255,255,200,${0.8 * blink})`);
        d.circle(px[i] + 18, hy, 7, `rgba(255,255,200,${0.8 * blink})`);
      });
    }
    drawUi3d(d, v, r, dark);
    if ((v.ph === 'wait' || v.ph === 'fire') && !dark) {
      if (v.w) {
        const pop = 1 + 0.35 * Math.max(0, 1 - v.wt / 0.1);
        const size = Math.min(230, 1750 / Math.max(5, v.w.length)) * pop;
        if (v.real) d.circle(W / 2, 260, 300 + Math.sin(d.t * 30) * 10, 'rgba(255,60,30,0.18)');
        d.text(v.w, W / 2 + 8, 270, { size, color: '#000000aa' });
        d.neon(() => d.text(v.w, W / 2, 260, { size, color: v.real ? '#ff2a2a' : '#ffd9a0' }), '#ff2a2a');
      }
    }
  },
};

// ---------- 2D helpers (fallback) ----------

function drawVerdict(d, v, r) {
  const w = v.win;
  const names = r.names || ['G1', 'G2', 'G3', 'G4'];
  const px = pxOf(v.p.length);
  const pop = 1 + 0.25 * Math.max(0, 1 - v.pt / 0.12);
  const col = w >= 0 ? d.col(w, 'light') : '#ffe066';
  d.rrect(W / 2 - 400, 140, 800, 250, 40, '#000000aa', col, 6);
  d.text(v.msg, W / 2, 228, { size: 84 * pop, color: '#ffe066' });
  let why = '';
  if (v.why === 'fast') why = v.hit >= 0 && v.p.length > 2 ? `${names[w]} colpisce ${names[v.hit]}!` : `${names[w]} è più lesto!`;
  else if (v.why === 'counter') why = `${names[w]}: schivata e contropiede!`;
  else if (v.why === 'jam') why = v.p.length > 2 ? `Tutti inceppati tranne ${names[w]}!` : `${names[v.jam]} ha tirato troppo presto`;
  else if (v.why === 'slow') why = 'Nessuno ha tirato: si rifà';
  else if (v.why === 'stall') why = 'Duello infinito: si rifà';
  else if (v.why === 'draw') why = 'Colpi simultanei: si rifà';
  d.text(why, W / 2, 310, { size: 46, color: col });
  if (w >= 0 && v.rt[w] >= 0 && v.why !== 'jam') d.text(`⏱ ${v.rt[w].toFixed(3)} s`, W / 2, 368, { size: 40, color: '#ffffffcc' });
  if (v.why === 'fast' || v.why === 'counter') v.rt.forEach((t, i) => {
    if (t >= 0) d.text(`${t.toFixed(3)} s`, px[i], GROUND - 500, { size: 44, color: d.col(i, 'light') });
  });
}

function drawBackdrop(d, tension) {
  const ctx = d.ctx;
  const sky = ctx.createLinearGradient(0, -200, 0, GROUND);
  sky.addColorStop(0, '#2e2a6b');
  sky.addColorStop(0.45, '#c8577a');
  sky.addColorStop(0.8, '#ffa25e');
  sky.addColorStop(1, '#ffd27a');
  ctx.fillStyle = sky;
  ctx.fillRect(-900, -600, W + 1800, GROUND + 600);
  d.circle(W / 2, GROUND - 160, 230, 'rgba(255,207,90,0.35)');
  d.circle(W / 2, GROUND - 160, 180, '#ffe28a');
  // castle silhouette + walls
  d.rect(-900, GROUND - 160, W + 1800, 160, '#6a3a5a');
  for (let x = -880; x < W + 900; x += 60) d.rect(x, GROUND - 190, 34, 30, '#6a3a5a');
  d.rect(W / 2 - 160, GROUND - 420, 320, 260, '#5a2e4e');
  d.rect(W / 2 - 230, GROUND - 520, 90, 360, '#5a2e4e');
  d.rect(W / 2 + 140, GROUND - 520, 90, 360, '#5a2e4e');
  d.poly([W / 2 - 245, GROUND - 520, W / 2 - 185, GROUND - 610, W / 2 - 125, GROUND - 520], '#8a2a3a');
  d.poly([W / 2 + 125, GROUND - 520, W / 2 + 185, GROUND - 610, W / 2 + 245, GROUND - 520], '#8a2a3a');
  // ground
  const gr = ctx.createLinearGradient(0, GROUND, 0, H + 200);
  gr.addColorStop(0, '#9ab65a');
  gr.addColorStop(1, '#5a7a30');
  ctx.fillStyle = gr;
  ctx.fillRect(-900, GROUND, W + 1800, H - GROUND + 600);
  d.rect(-900, GROUND, W + 1800, 40, '#c9a46a');
  for (let k = 0; k < 6; k++) {
    const dx = ((k * 330 + d.t * (120 + tension * 260)) % (W + 400)) - 200, dy = GROUND - 30 - (k % 3) * 60;
    d.line(dx, dy, dx + 70 + tension * 60, dy, `rgba(255,230,190,${0.15 + tension * 0.15})`, 4);
  }
  if (tension > 0) {
    const vg = ctx.createRadialGradient(W / 2, H / 2, 300, W / 2, H / 2, 1100);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, `rgba(20,0,10,${0.55 * tension})`);
    ctx.fillStyle = vg;
    ctx.fillRect(-900, -600, W + 1800, H + 1200);
  }
}

function drawArcher(d, x, f, i, st, t, winner, n) {
  const ctx = d.ctx;
  const k = n > 2 ? 0.8 : 1;
  let ang = 0, shift = 0;
  if (st === 'fall') { const q = clamp(t / 0.5, 0, 1); ang = -f * q * q * 1.5; }
  const rollK = st === 'roll' ? Math.sin(clamp(t / DODGE_T, 0, 1) * Math.PI) : 0;
  if (st === 'roll') { ang = -f * rollK * 0.55; shift = -f * rollK * 60; }
  const wobble = st === 'jam' ? Math.sin(t * 30) * 0.06 * Math.max(0, 1 - t) : 0;
  const hop = winner ? Math.abs(Math.sin(t * 7)) * 18 : 0;
  d.shadow(x + shift, GROUND + 4, 90 * k, 16, 0.3);
  ctx.save();
  ctx.translate(x + shift, GROUND - hop);
  ctx.rotate(ang + wobble);
  ctx.scale(k, k);
  const legH = 120 * (1 - rollK * 0.55);
  d.line(-24, -8, -16, -legH, '#3a2a1a', 22);
  d.line(24, -8, 16, -legH, '#3a2a1a', 22);
  const by = -legH;
  // tabard in team colors
  d.poly([-60, by + 6, 60, by + 6, 46, by - 130, -46, by - 130], d.col(i, 'dark'), '#00000088', 4);
  d.rect(-12, by - 130, 24, 136, d.col(i, 'light'));
  d.rect(-56, by - 6, 112, 14, '#4a2a12');
  const drawn = st === 'shoot' || st === 'jam' || st === 'dry' || (st === 'feint' && t < 0.45);
  const ay = drawn ? by - 100 : by - 40;
  const ax = drawn ? 120 : 60;
  d.line(f * 30, by - 100, f * ax, ay, '#f2c49b', 16);
  // crossbow
  d.line(f * (ax - 30), ay, f * (ax + 50), ay, '#6b3a1e', 12);
  d.line(f * (ax + 30), ay - 40, f * (ax + 30), ay + 40, '#4a2a12', 8);
  if (st === 'shoot' && t < 0.15) d.star(f * (ax + 70), ay, 40 * (1 - t / 0.15) + 12, '#ffd23f', 8);
  if (st === 'jam') d.circle(f * (ax + 40), ay - 40 - t * 40, 18 + t * 10, 'rgba(120,120,120,0.5)');
  const hy = by - 190;
  const mood = st === 'fall' ? 'dead' : st === 'jam' ? 'dizzy' : st === 'laugh' || winner ? 'happy' : st === 'shoot' ? 'angry'
    : st === 'roll' || st === 'dry' ? 'scared' : st === 'aim' || st === 'feint' ? 'angry' : 'ok';
  d.avatar(0, hy, 74, i, { look: f > 0 ? 0 : Math.PI, mood, squash: st === 'roll' ? 0.2 * rollK : 0 });
  ctx.restore();
}

// ---------- 3D helpers ----------

const tension3d = (v) => (v.ph === 'wait' ? clamp(v.pt / 4, 0, 1) : v.ph === 'fire' ? 1 : 0);

function darkness3d(v) {
  let a = 1;
  if (v.ph === 'res') a = clamp(0.35 + v.pt * 0.4, 0.35, 0.92);
  for (const t of v.tr) if (t.a < 0.35) a = Math.min(a, 0.3 + t.a * 2);
  return a;
}

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

// A crossbow bolt pointing along +X (the KayKit arrow stands along +Y).
function makeBolt(K, len, parent) {
  const g = K.group(parent);
  const a = K.model('weapons/arrow', { height: len, ground: false, parent: g, cast: false });
  a.rotation.z = -Math.PI / 2;
  return { g };
}

function makeArcher(K, i) {
  const A = { av: K.avatar(i), key: 0, lastSt: '', lastT: 0, cb: null };
  // Crossbow in the right hand (animated characters only).
  const M = A.av.model;
  const bone = M && M.getObjectByName ? M.getObjectByName('handslot.r') || M.getObjectByName('handslotr') : null;
  if (bone) A.cb = K.model('weapons/crossbow_1handed', { s: 1, ground: false, parent: bone });
  const T = K.THREE;
  A.flash = K.ball(1, K.glow('#ffd23f', { add: true }), { cast: false });
  A.flash2 = K.ball(1, K.glow('#ffffff'), { cast: false });
  A.smoke = K.ball(1, K.glow('#d0d0d0', { unique: true, opacity: 0.5 }), { cast: false });
  A.broken = K.model('weapons/Skeleton_Arrow_Broken', { height: 90, ground: false, cast: false });
  A.ring = K.mesh(new T.TorusGeometry(1, 0.08, 8, 40), K.glow(K.col(i, 'light'), { opacity: 0.85, unique: true }), { cast: false });
  return A;
}

function poseArcher(K, A, i, v, px, R, gy, t) {
  const p = v.p[i], st = p.st, x = px[i];
  const tg = v.tg[i];
  const f = tg >= 0 && px[tg] !== undefined ? (px[tg] > x ? 1 : -1) : x < W / 2 ? 1 : -1;
  const winner = v.win === i && v.ph === 'res';
  const rollK = st === 'roll' ? Math.sin(clamp(p.t / DODGE_T, 0, 1) * Math.PI) : 0;
  const hop = winner ? Math.abs(Math.sin(p.t * 7)) * 18 : 0;
  // Restart one-shot clips when the same state starts again (a second shot…).
  if (st !== A.lastSt || p.t < A.lastT - 0.05) A.key++;
  A.lastSt = st; A.lastT = p.t;
  let anim = 'Idle';
  if (winner || st === 'laugh') anim = 'Cheer';
  else if (st === 'fall') anim = 'Death_A';
  else if (st === 'shoot') anim = '1H_Ranged_Shoot';
  else if (st === 'dry') anim = '1H_Ranged_Reload';
  else if (st === 'roll') anim = 'Dodge_Backward';
  else if (st === 'jam') anim = 'Hit_B';
  else if (st === 'feint') anim = p.t < 0.45 ? '1H_Ranged_Aiming' : 'Idle';
  else if (st === 'aim') anim = v.ph === 'fire' ? '1H_Ranged_Aiming' : 'Idle';
  const mood = st === 'fall' ? 'dead' : st === 'jam' ? 'dizzy' : st === 'laugh' || winner ? 'happy' : st === 'roll' || st === 'dry' ? 'scared' : 'ok';
  const out = v.out && v.out[i] && st === 'jam' && p.t > 1.2;
  A.av.set(x - f * rollK * 50, GROUND - R - hop, { r: R, look: f > 0 ? 0 : Math.PI, mood, anim, animKey: A.key, gear: false, alpha: out ? 0.55 : 1 });
  // Muzzle flash and smoke at the crossbow tip.
  const tx = x + f * MUZ, ty = gy;
  const fl = st === 'shoot' && p.t < 0.15;
  A.flash.visible = A.flash2.visible = fl;
  if (fl) {
    const s = 44 * (1 - p.t / 0.15) + 12;
    K.place(A.flash, tx, ty, 80); A.flash.scale.setScalar(s * 0.75);
    K.place(A.flash2, tx, ty, 82); A.flash2.scale.setScalar(s * 0.35);
  }
  A.smoke.visible = (st === 'shoot' && p.t < 1) || (st === 'jam' && p.t < 1.5);
  if (A.smoke.visible) {
    const k = st === 'jam' ? 0.6 : 1;
    K.place(A.smoke, tx - f * 20 + f * p.t * 40, ty - 30 - p.t * 60, 80);
    A.smoke.scale.setScalar((10 + p.t * 22) / k);
    A.smoke.material.opacity = st === 'jam' ? 0.55 * Math.max(0, 1 - p.t / 1.5) : 0.5 * (1 - p.t);
    A.smoke.material.color.set(st === 'jam' ? '#6a6a6a' : '#e0d8c8');
  }
  // Jam: the bolt snaps and flies off spinning.
  A.broken.visible = st === 'jam' && p.t < 1.2;
  if (A.broken.visible) {
    const k = p.t;
    K.place(A.broken, tx + f * k * 160, ty - 300 * k + 520 * k * k, 90);
    A.broken.rotation.z = k * 14 * f;
  }
  A.ring.visible = winner;
  if (winner) { K.place(A.ring, x, GROUND - R, 30); A.ring.scale.setScalar(R * 0.9 + v.pt * 90); A.ring.material.opacity = Math.max(0, 0.85 - v.pt * 0.4); }
}

function makeSnail(K, n) {
  const g = K.group();
  makeBolt(K, 170, g);
  K.ball(26, K.mat('#c2703a', { rough: 0.5 }), { parent: g, seg: 14 }).position.set(-10, 28, 0);
  K.torus(13, 3.5, K.mat('#5a2a10'), { parent: g, cast: false }).position.set(-10, 28, 24);
  const eyes = K.mat('#ffffff');
  for (const dz of [-6, 6]) K.ball(5, eyes, { parent: g, cast: false, seg: 8 }).position.set(22, 40, dz);
  const rings = [0, 1, 2, 3].slice(0, Math.max(2, n)).map((i) => K.glow(K.col(i, 'light'), { opacity: 0.7 }));
  const ring = K.torus(50, 3, rings[0], { parent: g, cast: false, arc: Math.PI * 1.6 });
  return { g, ring, rings };
}

function drawVeil3d(d, v, dark) {
  const ctx = d.ctx;
  const tension = tension3d(v);
  if (tension > 0) {
    const vg = ctx.createRadialGradient(W / 2, H / 2, 300, W / 2, H / 2, 1100);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, `rgba(20,0,10,${0.5 * tension})`);
    ctx.fillStyle = vg;
    ctx.fillRect(-1300, -900, W + 2600, H + 1800);
  }
  if (dark) {
    ctx.fillStyle = `rgba(0,0,0,${darkness3d(v)})`;
    ctx.fillRect(-1300, -900, W + 2600, H + 1800);
  }
}

function uiKey3d(v, K, dark) {
  const pop = (pt) => Math.min(5, Math.floor(pt / 0.03));
  return [
    v.ph, v.n, v.win, v.msg, v.tg.join(''), v.out.join(''),
    v.ph === 'ready' || v.ph === 'res' ? pop(v.pt) : '',
    v.ph === 'wait' && !v.w ? Math.floor(K.t * 3) % 3 : '',
    v.pl.map((q) => `${q.d}${q.m}${Math.round(q.cd * 20)}${v.ph === 'fire' ? Math.round(q.rl * 20) : 0}`).join(','),
    v.p.map((p) => (p.st === 'dry' && p.t < 0.4 ? 1 : 0)).join(''),
    dark ? Math.round(Math.sin(K.t * 4) * 3) : '',
  ].join('|');
}

function drawUi3d(d, v, r, dark) {
  const n = v.p.length, px = pxOf(n), gy = gunOf(n);
  // Dodges left, reload state and (3–4 players) the color of the rival you aim at, under each archer.
  v.pl.forEach((q, i) => {
    const x = px[i], y = GROUND + 62;
    if (v.out[i]) {
      d.rrect(x - 90, y - 22, 180, 44, 22, '#00000099', '#ffffff44', 3);
      d.text('INCEPPATA', x, y + 2, { size: 26, color: '#ffffffaa' });
    } else if (r.variant === 'lumaca') {
      const ready = q.cd <= 0;
      d.rrect(x - 90, y - 22, 180, 44, 22, ready ? d.col(i, 'dark') : '#00000088', ready ? d.col(i, 'light') : '#ffffff44', 4);
      if (!ready) d.rrect(x - 86, y - 18, 172 * (1 - q.cd), 36, 18, d.col(i) + '66');
      d.text('B · SCHIVA', x, y + 2, { size: 26, color: ready ? '#fff' : '#ffffff88' });
    } else {
      const m = Math.max(q.m, 1);
      for (let k = 0; k < m; k++) {
        const cx = x + (k - (m - 1) / 2) * 58, on = k < q.d;
        d.circle(cx, y, 23, on ? d.col(i, 'dark') : '#00000077', on ? d.col(i, 'light') : '#ffffff44', 4);
        d.text('B', cx, y + 2, { size: 27, color: on ? '#fff' : '#ffffff66' });
      }
    }
    const tg = v.tg[i];
    const f = tg >= 0 ? (px[tg] > x ? 1 : -1) : x < W / 2 ? 1 : -1;
    if (n > 2 && tg >= 0 && !v.out[i] && v.ph !== 'res') {
      // Aim tag: an arrow toward the side you shoot + your target's color.
      const ty = GROUND + 128;
      d.rrect(x - 70, ty - 24, 140, 48, 24, '#000000aa', d.col(tg, 'light'), 4);
      d.text(f > 0 ? '➜' : '⬅', x - 30, ty + 2, { size: 30, color: '#fff' });
      d.circle(x + 30, ty, 15, d.col(tg), '#ffffff', 3);
    }
    if (q.rl > 0 && v.ph === 'fire' && !v.out[i]) {
      d.circle(x + f * 150, gy - 90, 30, '#00000066');
      d.arc(x + f * 150, gy - 90, 26, -Math.PI / 2, -Math.PI / 2 + q.rl * Math.PI * 2, '#ffffffcc', 7);
      d.text('↻', x + f * 150, gy - 88, { size: 30, color: '#fff' });
    }
    if (v.p[i].st === 'dry' && v.p[i].t < 0.4) d.text('click', x + f * 190, gy - 60, { size: 30, color: '#ffffffcc' });
  });
  if (dark && (v.ph === 'wait' || v.ph === 'ready' || v.ph === 'fire')) {
    d.text('Tira al BUM, non al tappo!', W / 2, 120, { size: 44, color: '#ffffff66' });
    d.emoji('👂', W / 2, 400, 110 + Math.sin(d.t * 4) * 8);
  }
  if (v.ph === 'ready') {
    const pop = 1 + 0.2 * Math.max(0, 1 - v.pt / 0.15);
    const txt = v.n === 0 ? 'PRONTI…' : `DUELLO ${v.n + 1}`;
    d.text(txt, W / 2 + 6, 336, { size: 100 * pop, color: '#00000088' });
    d.text(txt, W / 2, 330, { size: 100 * pop, color: '#fff3c4' });
    d.text('A = tira dopo FUOCO! · B = schiva / finta', W / 2, 410, { size: 38, color: '#ffffffdd' });
  } else if (v.ph === 'wait' && !v.w && !dark) {
    d.text('·'.repeat(1 + (Math.floor(d.t * 3) % 3)), W / 2, 300, { size: 120, color: '#ffffff88' });
  } else if (v.ph === 'res') {
    drawVerdict(d, v, r);
  }
}
