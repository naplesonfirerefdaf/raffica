// Tiro alla Fune — tug of war at the village fair, won by ALTERNATING A/B (hand over hand, no painful mashing).
// Up to 4 players, one rope each, all tied to the same knot: everyone pulls the knot toward their own line.
// Clean alternation builds a combo (stronger pulls); the stick YANKS the rope to block the others' pull.
import { clamp, damp, r1, r2 } from '../core/geom.js';

const W = 1400, H = 1400, CX = 700, MID = 700;
const DIRS = [[0, 1], [0, -1], [-1, 0], [1, 0]]; // seat 0 bottom, 1 top, 2 left, 3 right (from the centre)
const FACE_D = 600, MOUTH_D = 515;               // player and rope-end distance from the centre
const FACE_R = 95;
const BALL_R = 58;
const GOAL = 485;                  // distance from the centre to drag the knot over your line
const DECAY = 0.15;                // pulling power kept per second
const PULL = 42;                   // px/s per unit of power difference
const BOIL_AT = 15;                // after this the pull gets stronger
const STUN_CHILI = 1.5;
const COMBO_MAX = 24, COMBO_GAP = 0.45;
const BITE_T = 0.9, BITE_CD = 5;
const R3 = 60;                     // character radius in 3D

const faceX = (i) => CX + DIRS[i][0] * FACE_D, faceY = (i) => MID + DIRS[i][1] * FACE_D;
const mouthX = (i) => CX + DIRS[i][0] * MOUTH_D, mouthY = (i) => MID + DIRS[i][1] * MOUTH_D;
// Point at distance k from player i's spot, toward the centre (texts).
const toward = (i, k) => ({ x: faceX(i) - DIRS[i][0] * k, y: faceY(i) - DIRS[i][1] * k });
const proj = (x, y, i) => (x - CX) * DIRS[i][0] + (y - MID) * DIRS[i][1];

// Count valid alternations among this step's presses. exp = key expected next ('a'|'b'|null).
function alternate(exp, aN, bN) {
  let good = 0, bad = 0, na = aN, nb = bN;
  if (!na && !nb) return { good, bad, exp };
  if (exp === null) exp = na >= nb ? 'a' : 'b';
  while (na || nb) {
    if (exp === 'a') { if (na) { na--; good++; exp = 'b'; } else { nb--; bad++; } }
    else if (nb) { nb--; good++; exp = 'a'; } else { na--; bad++; }
  }
  return { good, bad, exp };
}

const mult = (c) => 1 + Math.min(c, COMBO_MAX) / COMBO_MAX;
// Bots' reaction time by level (core/bots.js driver delay, plus one tick to reach the game).
const BOT_DELAY = [0.34 + 1 / 60, 0.2 + 1 / 60, 0.09 + 1 / 60];

export default {
  id: 'spaghetto',
  name: 'Tiro alla Fune',
  rule: 'Alterna A e B per tirare il nodo oltre la tua linea!',
  verb: 'TIRA!',
  inspired: "Mario Party · Tug o' War",
  cam: 'top',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Tira A', b: 'Tira B', dirLabel: 'Strattone' },
  help: {
    goal: 'Trascina il nodo della fune oltre la linea del tuo colore.',
    dir: 'STRATTONE: muovi lo stick in qualsiasi direzione e dai un colpo secco alla fune: per quasi 1 s gli altri non riescono a tirare. Si ricarica in 5 s (anello ai tuoi piedi).',
    a: "Tira: premi A e B ALTERNATI (A, B, A, B… una mano dopo l'altra). Due volte lo stesso tasto = presa a vuoto.",
    b: 'Tira: alternato con A. Più alterni senza errori e senza pause, più sale la COMBO (fino a x2 di forza).',
    tips: ['Dopo 15 s la folla si scatena: si tira più forte', 'Dai lo strattone quando un altro sta facendo la combo per spezzargliela!', 'Corda Logora: quando la fune è rossa NON tirare'],
  },
  duration: 25,
  noMods: ['scambio', 'invert', 'sapone', 'scirocco'],
  variants: [
    { id: 'aldente', name: 'Corda Logora', desc: 'Quando scricchiola ed è rossa NON tirare: si spezza!' },
    { id: 'peperoncino', name: 'Il Topo', desc: 'Un topo corre sulla fune: chi se lo trova in mano viene morso!' },
    { id: 'tarantella', name: 'Al Tamburo', desc: 'Tira a tempo col tamburo: conta solo sul colpo!' },
  ],

  init(g) {
    const n = g.n || 2;
    const arr = (v) => Array(n).fill(v);
    return {
      n, px: CX, py: MID, vx: 0, vy: 0, won: -1, boil: false,
      pw: arr(0), exp: arr(null), sucks: arr(0), puff: arr(0), stun: arr(0), miss: arr(0), wob: 0,
      combo: arr(0), lastSuck: arr(-9),
      bite: arr(0), biteCd: arr(0), armed: arr(true),
      // Corda Logora
      ald: 'idle', aldT: g.rng.range(3, 5),
      // Il Topo
      chili: null, chiliAt: 2.5,
      // Al Tamburo
      beat: 0, period: 0.55, used: arr(-1), slipCd: arr(0),
    };
  },

  step(s, inp, g) {
    const dt = g.dt, n = s.n;
    for (let i = 0; i < n; i++) {
      s.puff[i] = Math.max(0, s.puff[i] - dt * 3.5);
      s.miss[i] = Math.max(0, s.miss[i] - dt);
      s.stun[i] = Math.max(0, s.stun[i] - dt);
      s.slipCd[i] = Math.max(0, s.slipCd[i] - dt);
      s.bite[i] = Math.max(0, s.bite[i] - dt);
      s.biteCd[i] = Math.max(0, s.biteCd[i] - dt);
      s.pw[i] *= damp(DECAY, dt);
      if (g.t - s.lastSuck[i] > COMBO_GAP && s.combo[i] > 0 && g.variant !== 'tarantella') s.combo[i] = Math.max(0, s.combo[i] - dt * 30);
    }
    s.wob *= damp(0.05, dt);

    if (g.ended) {
      // The winner drags the knot all the way home.
      if (s.won >= 0) {
        const k = 1 - damp(0.01, dt);
        s.px += (CX + DIRS[s.won][0] * (GOAL + 60) - s.px) * k;
        s.py += (MID + DIRS[s.won][1] * (GOAL + 60) - s.py) * k;
      }
      return;
    }

    if (!s.boil && g.t >= BOIL_AT) {
      s.boil = true;
      g.say('LA FOLLA IMPAZZISCE! TIRA!'); g.sfx('fire'); g.shake(0.3);
    }

    this.stepVariant(s, inp, g);

    // Yank: any fresh stick flick.
    for (let i = 0; i < n; i++) {
      const m = Math.hypot(inp[i].x, inp[i].y);
      if (m < 0.3) s.armed[i] = true;
      else if (m > 0.6 && s.armed[i]) {
        s.armed[i] = false;
        if (s.biteCd[i] <= 0 && s.stun[i] <= 0) this.chomp(s, g, i);
      }
    }

    // Pulling.
    for (let i = 0; i < n; i++) {
      const q = inp[i];
      if (!q.aN && !q.bN) continue;
      if (s.stun[i] > 0 || s.bite[i] > 0) { s.miss[i] = 0.3; continue; }
      if (g.variant === 'aldente' && s.ald === 'red') { this.snap(s, g, i); continue; }
      if (g.variant === 'tarantella') { this.danceSuck(s, g, i, q); continue; }
      const r = alternate(s.exp[i], q.aN, q.bN);
      s.exp[i] = r.exp;
      if (r.bad) {
        s.miss[i] = 0.35;
        if (s.combo[i] >= 6) { const tp = toward(i, 170); g.text(tp.x, tp.y, 'COMBO PERSA', { player: i, size: 40 }); }
        s.combo[i] = 0;
        g.sfx('bonk', { vol: 0.3, pitch: 1.4 });
      }
      if (r.good) this.suck(s, g, i, r.good);
    }

    // Tug of war: every rope pulls the knot toward its owner; only the pull above the average counts
    // (with 1v1 this is exactly the difference of the two powers). A yank blocks everybody else's pull.
    const k = PULL * (s.boil ? 1.6 : 1);
    const eff = s.pw.map((p, i) => (s.bite.some((b, j) => j !== i && b > 0) ? 0 : p));
    const mean = eff.reduce((a, b) => a + b, 0) / n;
    let tx = 0, ty = 0;
    for (let i = 0; i < n; i++) { tx += (eff[i] - mean) * DIRS[i][0]; ty += (eff[i] - mean) * DIRS[i][1]; }
    const kv = 1 - damp(0.02, dt);
    s.vx += (tx * k - s.vx) * kv; s.vy += (ty * k - s.vy) * kv;
    s.px += s.vx * dt; s.py += s.vy * dt;

    for (let i = 0; i < n; i++) {
      if (proj(s.px, s.py, i) >= GOAL) {
        s.won = i;
        g.end(i, 'Nodo conquistato!');
        g.sfx('squish'); g.sfx('tada');
        g.confetti(faceX(i), faceY(i)); g.burst(mouthX(i), mouthY(i), { color: '#c9a66b', n: 30, speed: 380, size: 10 });
        g.shake(0.6); g.slowmo(0.3, 0.8);
        for (let j = 0; j < n; j++) if (j !== i) g.vibrate(j, 250);
        break;
      }
    }
  },

  // One or more correct pulls by player i.
  suck(s, g, i, n, power = 1) {
    s.combo[i] = Math.min(COMBO_MAX + 6, s.combo[i] + n);
    s.lastSuck[i] = g.t;
    s.pw[i] += n * power * mult(s.combo[i]);
    s.sucks[i] += n;
    s.puff[i] = 1;
    s.wob = Math.min(1.5, s.wob + 0.12 * n);
    g.sfx(s.sucks[i] % 2 ? 'slide' : 'pop', { vol: 0.35, pitch: 1.4 + (s.sucks[i] % 5) * 0.12 + i * 0.12 });
    if (s.combo[i] >= COMBO_MAX && (s.combo[i] - n) < COMBO_MAX) {
      const tp = toward(i, 170);
      g.text(tp.x, tp.y, 'COMBO x2!', { player: i, size: 50 });
      g.sfx('powerup', { vol: 0.5 });
    }
    if (s.sucks[i] % 12 === 0) g.vibrate(i, 25);
  },

  // Yank: everybody else loses grip for a moment.
  chomp(s, g, i) {
    s.bite[i] = BITE_T; s.biteCd[i] = BITE_CD;
    for (let j = 0; j < s.n; j++) {
      if (j === i) continue;
      s.pw[j] *= 0.4;
      s.combo[j] = Math.floor(s.combo[j] / 2);
      g.vibrate(j, 90);
    }
    s.px += DIRS[i][0] * 18; s.py += DIRS[i][1] * 18;
    s.wob = 1.2;
    g.sfx('punch'); g.sfx('squish', { vol: 0.6, pitch: 1.3 });
    const tp = toward(i, 170);
    g.text(tp.x, tp.y, 'STRATTONE!', { player: i, size: 54 });
    g.burst(mouthX(i), mouthY(i), { color: '#ffe08a', n: 12, speed: 220, size: 8 });
    g.shake(0.2);
  },

  stepVariant(s, inp, g) {
    const dt = g.dt;
    if (g.variant === 'aldente') {
      s.aldT -= dt;
      if (s.aldT <= 0) {
        if (s.ald === 'idle') { s.ald = 'warn'; s.aldT = 0.8; g.sfx('tick', { pitch: 1.4 }); }
        else if (s.ald === 'warn') { s.ald = 'red'; s.aldT = g.rng.range(1, 2); g.sfx('buzzer', { vol: 0.6 }); g.say('FERMI! LA CORDA SCRICCHIOLA!'); }
        else { s.ald = 'idle'; s.aldT = g.rng.range(2.5, 5); g.sfx('go', { vol: 0.5 }); }
      }
    }
    if (g.variant === 'peperoncino') {
      if (!s.chili && g.t >= s.chiliAt) {
        // The rat jumps on the knot and runs along one rope (1v1: toward a random end).
        const j = s.n === 2 ? (g.rng.sign() > 0 ? 0 : 1) : g.rng.int(0, s.n - 1);
        s.chili = { x: s.px, y: s.py, j, age: 0 };
        g.sfx('pop'); g.ring(s.px, s.py, { color: '#ff3b1f', r: 90 });
      }
      const c = s.chili;
      if (c) {
        // It runs faster and faster, and the rope drags it toward whoever is winning.
        c.age += dt;
        const sp = 110 + 35 * c.age;
        c.x += (DIRS[c.j][0] * sp + s.vx * 1.3) * dt;
        c.y += (DIRS[c.j][1] * sp + s.vy * 1.3) * dt;
        for (let i = 0; i < s.n; i++) {
          if (proj(c.x, c.y, i) >= GOAL + 30) {
            s.chili = null; s.chiliAt = g.t + g.rng.range(2.5, 4.5);
            s.stun[i] = STUN_CHILI; s.pw[i] = 0; s.exp[i] = null; s.combo[i] = 0;
            g.sfx('fire'); g.sfx('horn', { pitch: 1.3, vol: 0.6 });
            g.burst(mouthX(i), mouthY(i), { color: '#9a8a7a', n: 26, speed: 340, size: 9 });
            const tp = toward(i, 150);
            g.text(tp.x, tp.y, 'MORSO DI TOPO!', { color: '#ff7a00', size: 56 });
            g.shake(0.4); g.vibrate(i, 200);
            break;
          }
        }
      }
    }
    if (g.variant === 'tarantella') {
      s.period = 0.55 - 0.15 * clamp(g.t / 25, 0, 1);
      const before = Math.floor(s.beat);
      s.beat += dt / s.period;
      const now = Math.floor(s.beat);
      if (now !== before) g.sfx('tick', { pitch: now % 3 === 0 ? 1.5 : 1, vol: now % 3 === 0 ? 0.8 : 0.45 });
    }
  },

  // Corda Logora: pulling on red snaps the rope and costs 25% of your lead.
  snap(s, g, i) {
    const adv = proj(s.px, s.py, i);
    const back = Math.max(0, adv) * 0.25 + 35;
    s.px -= DIRS[i][0] * back; s.py -= DIRS[i][1] * back;
    s.pw[i] = 0; s.exp[i] = null; s.stun[i] = 0.6; s.vx = 0; s.vy = 0; s.combo[i] = 0;
    s.ald = 'idle'; s.aldT = g.rng.range(2.5, 5);
    s.wob = 1.5;
    g.sfx('break'); g.sfx('boing', { pitch: 0.8 });
    g.burst(s.px, s.py, { color: '#ffd36b', n: 24, speed: 320, size: 8 });
    const tp = toward(i, 160);
    g.text(tp.x, tp.y, 'SPEZZATA!', { player: i, size: 60 });
    g.shake(0.5); g.hitstop(0.08); g.vibrate(i, 150);
  },

  // Al Tamburo: only presses on the beat count; off-beat = slip back.
  danceSuck(s, g, i, q) {
    const tp = q.aN ? q.aT : q.bT;
    const off = tp >= 0 && Math.abs(tp - g.t) < 0.25 ? g.t - tp : 0;
    const b = s.beat - off / s.period;
    const nearest = Math.round(b);
    const err = Math.abs(b - nearest) * s.period;
    if (err < 0.13 && s.used[i] !== nearest) {
      s.used[i] = nearest;
      this.suck(s, g, i, 1, 2.4);
      g.ring(mouthX(i), mouthY(i), { player: i, r: 70 });
    } else if (s.slipCd[i] <= 0) {
      s.slipCd[i] = 0.3;
      s.combo[i] = 0;
      s.px -= DIRS[i][0] * 28; s.py -= DIRS[i][1] * 28; s.pw[i] *= 0.5; s.miss[i] = 0.5;
      g.sfx('slide', { pitch: 0.7 });
      const t2 = toward(i, 160);
      g.text(t2.x, t2.y, 'FUORI TEMPO!', { player: i, size: 44 });
    }
  },

  timeout(s) {
    // Whoever has the knot closest to their line; then the most pulls.
    const ids = [...Array(s.n).keys()];
    const pr = ids.map((i) => proj(s.px, s.py, i));
    ids.sort((a, b) => pr[b] - pr[a]);
    if (pr[ids[0]] - pr[ids[1]] > 1) return ids[0];
    const top = ids.filter((i) => pr[ids[0]] - pr[i] <= 1);
    top.sort((a, b) => s.sucks[b] - s.sucks[a]);
    if (top.length > 1 && s.sucks[top[0]] === s.sucks[top[1]]) return -1;
    return top[0];
  },

  view(s) {
    return {
      px: r1(s.px), py: r1(s.py), vx: r1(s.vx), vy: r1(s.vy), wob: r2(s.wob), won: s.won,
      pw: s.pw.map(r1), puff: s.puff.map(r2), stun: s.stun.map(r2), miss: s.miss.map(r2),
      cb: s.combo.map((c) => r2(mult(c))), bt: s.bite.map(r2), bc: s.biteCd.map((c) => r2(c / BITE_CD)),
      ald: s.ald === 'idle' ? 0 : s.ald === 'warn' ? 1 : 2,
      ch: s.chili ? [r1(s.chili.x), r1(s.chili.y), s.chili.j] : null,
      beat: r2(s.beat), boil: s.boil ? 1 : 0,
      hud: { p: s.sucks.slice(), max: null, label: 'Strappi', bar: s.pw.map((_, i) => r2(clamp(proj(s.px, s.py, i) / GOAL, 0, 1))) },
    };
  },

  focus(v) {
    return v.pw.map((_, i) => ({ x: faceX(i), y: faceY(i) }));
  },

  // Computer player: hand over hand (A, B, A, B… one key per frame, the driver caps the pace), stays still on the
  // red rope, presses on the drum beat (anticipating its own reaction time) and yanks the rope when it pays off.
  bot(s, me, g, B) {
    const m = B.mem, lv = B.level;
    const out = { x: 0, y: 0 };
    if (s.won >= 0 || g.ended) return out;
    // Yank: a short flick of the stick, then back to rest (the yank re-arms at rest).
    if (m.yank > g.t) { out.x = DIRS[me][0]; out.y = DIRS[me][1]; return out; }
    const drum = g.variant === 'tarantella';
    // On the drum the flick lands just after the beat: everybody has just pulled, my fresh power runs alone.
    const D = BOT_DELAY[lv] - 0.02 + (lv === 0 ? (B.rng() - 0.5) * 0.08 : 0);
    const ph = s.beat + D / s.period, prev = m.ph ?? ph;
    m.ph = ph;
    const yankOk = !drum || Math.floor(ph - 0.15) !== Math.floor(prev - 0.15);
    if (lv > 0 && yankOk && this.botYank(s, me, lv, drum)) { m.yank = g.t + 0.08; out.x = DIRS[me][0]; out.y = DIRS[me][1]; return out; }
    if (s.stun[me] > 0 || s.bite[me] > 0) return out;
    if (g.variant === 'aldente' && (s.ald === 'red' || (lv > 0 && s.ald === 'warn'))) return out;
    if (drum) {
      // Aim the press so it lands on the beat after this bot's reaction time.
      if (Math.floor(ph) !== Math.floor(prev)) out.tapA = true;
      return out;
    }
    m.k = !m.k;
    if (m.k) out.tapA = true; else out.tapB = true;
    return out;
  },

  // Is a yank worth it now? It blocks everybody else's pull for a moment and cuts their power and combo.
  botYank(s, me, lv, drum) {
    if (s.biteCd[me] > 0 || s.stun[me] > 0 || s.bite.some((b) => b > 0)) return false;
    let top = 0, topCombo = 0, lose = -1e9;
    for (let j = 0; j < s.n; j++) {
      if (j === me) continue;
      top = Math.max(top, s.pw[j]); topCombo = Math.max(topCombo, s.combo[j]); lose = Math.max(lose, proj(s.px, s.py, j));
    }
    if (lose > GOAL - 160) return true;                                   // somebody is about to win: stop them
    if (lv === 1) return top > s.pw[me] * 1.1 && top > 5;
    if (drum) return s.pw[me] > 2;
    return (top > s.pw[me] * 0.8 && top > 4) || topCombo >= COMBO_MAX * 0.75 || (s.pw[me] > 6 && top > 3);
  },

  // ---------- 3D: tug of war at the village fair, ropes tied to one knot over the mud pit ----------
  render3d: {
    assets: [
      'medieval/building_market_red', 'medieval/building_market_blue', 'medieval/building_market_green', 'medieval/building_market_yellow',
      'medieval/tent', 'medieval/building_stage_A', 'medieval/building_tavern_red', 'medieval/building_home_A_blue', 'medieval/building_home_B_yellow',
      'medieval/building_castle_red', 'medieval/building_tower_A_red', 'medieval/building_well_red', 'medieval/building_church_red',
      'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow', 'medieval/fence_wood_straight',
      'medieval/barrel', 'medieval/crate_A_big', 'medieval/crate_B_small', 'medieval/sack', 'medieval/bucket_water', 'medieval/wheelbarrow',
      'medieval/trees_A_large', 'medieval/trees_B_medium', 'medieval/tree_single_A', 'medieval/hills_B_trees', 'medieval/hill_single_A',
      'medieval/mountain_A_grass', 'medieval/cloud_big', 'medieval/cloud_small', 'medieval/target', 'medieval/weaponrack',
      'chars/Skeleton_Minion', 'chars/Rogue_Hooded', 'chars/Barbarian',
    ],
    build(K, r) {
      const T = K.THREE;
      const N = Math.max(2, Math.min(4, r.n || K.n || 2));
      const o = { N, variant: r.variant, lastCb: ['', '', '', ''], lastBc: [-2, -2, -2, -2], flags: [], clouds: [], npcs: [] };
      K.theme('giorno', { fogNear: 1.7, fogFar: 4.4 });
      K.ground('prato', { tile: 200, margin: 1800 });
      buildFair(K, o, N);
      // The arena: trampled earth, goal lines, stakes; mud pit in the middle.
      K.layer({ x0: 0, y0: 0, x1: W, y1: H, h: 0.6, transparent: true, once: true, maxPx: 1400, draw: (d) => drawArena(d, N) });
      o.mud = K.cyl(150, 3, K.mat('#5a3a1e', { rough: 0.18, metal: 0.1 }), { seg: 48, cast: false });
      K.place(o.mud, CX, MID, 0);
      o.bubbles = [0, 1, 2, 3, 4].map(() => K.ball(1, K.mat('#7a5530', { rough: 0.2 }), { cast: false, seg: 10 }));
      o.goal = [];
      for (let i = 0; i < N; i++) {
        const g = K.box(DIRS[i][0] ? 16 : 300, DIRS[i][0] ? 300 : 16, 6, K.glow(K.col(i), { unique: true, opacity: 0.6 }), { cast: false });
        K.place(g, CX + DIRS[i][0] * GOAL, MID + DIRS[i][1] * GOAL, 4);
        o.goal.push(g);
      }
      // Ropes: tubes built once along a unit line, deformed every frame (no new geometry).
      const geo0 = new T.TubeGeometry(new T.LineCurve3(new T.Vector3(0, 0, 0), new T.Vector3(0, 0, 1)), 40, 9, 8, false);
      o.base = Float32Array.from(geo0.attributes.position.array);
      geo0.dispose();
      o.nMat = K.mat('#c9a66b', { rough: 0.85, unique: true });
      o.ropes = [];
      for (let i = 0; i < N; i++) {
        const geo = new T.TubeGeometry(new T.LineCurve3(new T.Vector3(0, 0, 0), new T.Vector3(0, 0, 1)), 40, 9, 8, false);
        const m = K.mesh(geo, o.nMat);
        m.frustumCulled = false;
        m.userData.ownGeo = true;
        o.ropes.push(m);
      }
      o.specks = [];
      const ribbon = K.mat('#d93a3a', { rough: 0.5 });
      for (let k = 0; k < N * 4; k++) o.specks.push(K.box(10, 10, 16, ribbon, { cast: false }));
      // The knot: an iron ring with a big rope knot and a red pennant on a stick.
      o.ball = K.group();
      o.roll = K.group(o.ball);
      const iron = K.mat('#3a3634', { rough: 0.4, metal: 0.7 });
      const ringM = K.torus(34, 7, iron, { parent: o.roll }); ringM.rotation.x = Math.PI / 2;
      K.mesh(new T.TorusKnotGeometry(22, 9, 64, 8, 2, 3), K.mat('#b08a52', { rough: 0.9 }), { parent: o.roll }).userData.ownGeo = true;
      const stick = K.cyl(3, 90, K.mat('#6b4423'), { parent: o.ball, seg: 6 }); stick.position.y = 10;
      o.pennant = K.mesh(new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), new T.Vector3(0, -30, 0), new T.Vector3(46, -15, 0)]), K.mat('#e8261a', { rough: 0.6, unique: true }), { parent: o.ball, cast: false });
      o.pennant.material.side = T.DoubleSide;
      o.pennant.geometry.computeVertexNormals();
      o.pennant.userData.ownGeo = true;
      o.pennant.position.y = 100;
      o.ghosts = [1, 2, 3].map(() => K.ball(30, K.mat('#b08a52', { opacity: 0.2, rough: 0.8 }), { cast: false, seg: 14 }));
      // The rat running on the ropes (Il Topo).
      o.chili = K.group();
      const fur = K.mat('#7d7470', { rough: 0.8 }), pink = K.mat('#f2a0b0', { rough: 0.6 });
      const body = K.ball(1, fur, { parent: o.chili, seg: 12 }); body.scale.set(26, 15, 14); body.position.y = 14;
      const head = K.cone(10, 22, fur, { parent: o.chili, seg: 10 }); head.rotation.z = -Math.PI / 2; head.position.set(22, 16, 0);
      for (const s of [-1, 1]) { const ear = K.ball(6, pink, { parent: o.chili, seg: 8, cast: false }); ear.position.set(20, 27, s * 7); ear.scale.z = 0.4; }
      const tail = K.cyl(2, 40, pink, { parent: o.chili, seg: 5, cast: false }); tail.rotation.z = Math.PI / 2 + 0.3; tail.position.set(-22, 12, 0);
      o.chiliGlow = K.disc(1, K.glow('#ff5014', { opacity: 0.3, add: true, unique: true }));
      // Drum beat rings (Al Tamburo).
      o.tar = Array.from({ length: N }, (_, i) => ({
        fix: K.torus(1, 0.04, K.glow(K.col(i), { unique: true, opacity: 0.6 }), { cast: false }),
        mov: K.torus(1, 0.04, K.glow(K.col(i, 'light'), { opacity: 0.7 }), { cast: false }),
      }));
      o.beat = K.disc(1, K.glow('#ffd36b', { opacity: 0.35, add: true }));
      // Players.
      o.pl = Array.from({ length: N }, (_, i) => ({
        av: K.avatar(i),
        aura: K.disc(1, K.glow('#ff9628', { unique: true, opacity: 0.3, add: true })),
        dec: K.decal(300),
        cb: K.billboard(256, 96, 140, (d, w, h, txt, col) => { if (txt) d.text(txt, w / 2, h / 2, { size: 70, color: col }); }),
        rat: K.emoji('🐀', 56),
        dizzy: K.emoji('💫', 50),
      }));
      return o;
    },

    update(K, o, v) {
      const t = K.t, N = o.N;
      // Fair life: flags, clouds, the crowd.
      for (const f of o.flags) f.g.rotation.y = f.base + Math.sin(t * 2.4 + f.ph) * 0.14;
      for (const c of o.clouds) { const x = ((c.x + t * c.v + 3000) % 6500) - 2500; K.place(c.g, x, c.y, c.h); }
      const over = v.won >= 0;
      o.npcs.forEach((q, k) => q.av.set(q.x, q.y, { r: q.r, look: Math.atan2(v.py - q.y, v.px - q.x), marker: false, gear: false,
        anim: over || v.boil ? 'Cheer' : q.anim, animSpeed: 0.8 + k * 0.15 }));
      o.goal.forEach((g) => { g.material.opacity = Math.sin(t * 6) > 0 ? 0.95 : 0.5; });
      o.bubbles.forEach((b, k) => {
        const ph = (t * 0.6 + k * 0.23) % 1, a = k * 2.3;
        K.place(b, CX + Math.cos(a) * (40 + k * 18), MID + Math.sin(a) * (40 + k * 18), 2);
        b.scale.setScalar(2 + ph * 10);
        b.visible = ph < 0.92;
      });

      // Rope shape: wobbles when slack, vibrates fast when taut.
      const tension = clamp(v.pw.reduce((a, b) => a + b, 0) / (4 * N), 0, 1);
      const amp = (10 + v.wob * 28) * (1 - tension * 0.6);
      const freq = 6 + tension * 18;
      const blink = Math.floor(t * 10) % 2 === 0;
      let col = '#c9a66b', em = 0;
      if (v.ald === 1) col = blink ? '#ffb347' : '#c9a66b';
      if (v.ald === 2) { col = blink ? '#ff2d2d' : '#ff8080'; em = 0.5; }
      o.nMat.color.set(col);
      o.nMat.emissive.set(v.ald === 2 ? '#ff2d2d' : '#000000');
      o.nMat.emissiveIntensity = em;
      const kh = 52; // knot height
      const B = o.base;
      for (let i = 0; i < N; i++) {
        const rope = o.ropes[i];
        const ax = v.px, ay = v.py;
        const hx = handX(i, v), hy = handY(i, v), hh = R3 * 1.15;
        const dx = hx - ax, dy = hy - ay, L = Math.hypot(dx, dy) || 1;
        const px = -dy / L, py = dx / L; // horizontal perpendicular
        const sag = 26 * (1 - tension);
        const arr = rope.geometry.attributes.position.array;
        for (let k = 0; k < arr.length; k += 3) {
          const u = B[k + 2], ox = B[k], oy = B[k + 1];
          const off = Math.sin(Math.PI * u) * amp * Math.sin(u * L * 0.022 - t * freq + i);
          const cx = ax + dx * u + px * (off + ox), cy = ay + dy * u + py * (off + ox);
          const ch = kh + (hh - kh) * u - Math.sin(Math.PI * u) * sag + oy;
          arr[k] = cx; arr[k + 1] = ch; arr[k + 2] = cy;
        }
        rope.geometry.attributes.position.needsUpdate = true;
        // Red ribbons tied along the rope, moving with it.
        for (let q = 0; q < 4; q++) {
          const sp = o.specks[i * 4 + q];
          const dd = 90 + q * 110;
          sp.visible = dd < L - 40;
          if (!sp.visible) continue;
          const u = dd / L;
          const off = Math.sin(Math.PI * u) * amp * Math.sin(u * L * 0.022 - t * freq + i);
          K.place(sp, ax + dx * u + px * off, ay + dy * u + py * off, kh + (hh - kh) * u - Math.sin(Math.PI * u) * sag - 4);
          K.face(sp, Math.atan2(dy, dx));
        }
      }

      // The knot.
      K.place(o.ball, v.px, v.py, kh);
      o.ball.scale.setScalar(1.5);
      o.roll.rotation.y = (v.px + v.py) * 0.01;
      o.roll.rotation.z = Math.sin(t * 9) * 0.1 * (1 + v.wob);
      o.pennant.rotation.y = Math.sin(t * 5) * 0.5;
      const sp = Math.hypot(v.vx, v.vy);
      o.ghosts.forEach((g, k) => {
        g.visible = sp > 40;
        if (g.visible) { K.place(g, v.px - v.vx * 0.04 * (k + 1), v.py - v.vy * 0.04 * (k + 1), kh); g.scale.setScalar(1 - (k + 1) * 0.15); }
      });

      // The rat runs on its rope (drawn on the segment knot → hands).
      const ch = !!v.ch;
      o.chili.visible = o.chiliGlow.visible = ch;
      if (ch) {
        const [cx0, cy0, j] = v.ch;
        const hx = handX(j, v), hy = handY(j, v);
        const dx = hx - v.px, dy = hy - v.py, L2 = dx * dx + dy * dy || 1;
        const u = clamp(((cx0 - v.px) * dx + (cy0 - v.py) * dy) / L2, 0, 1);
        const x = v.px + dx * u, y = v.py + dy * u;
        K.place(o.chili, x, y, kh + (R3 * 1.15 - kh) * u + 8);
        K.face(o.chili, Math.atan2(dy, dx));
        o.chili.position.y += Math.abs(Math.sin(t * 22)) * 5;
        o.chili.scale.setScalar(1.5);
        K.place(o.chiliGlow, x, y, 2);
        o.chiliGlow.scale.setScalar(50 + Math.sin(t * 10) * 6);
      }

      // Drum beat rings.
      const tar = o.variant === 'tarantella';
      const ph = ((v.beat % 1) + 1) % 1, hit = ph < 0.12 || ph > 0.9;
      o.beat.visible = tar;
      if (tar) { K.place(o.beat, CX, MID, 5); o.beat.scale.setScalar(60 + 50 * Math.pow(1 - ph, 3)); }
      o.tar.forEach((R, i) => {
        R.fix.visible = R.mov.visible = tar;
        if (!tar) return;
        K.place(R.fix, faceX(i), faceY(i), 14); R.fix.scale.setScalar(110);
        R.fix.material.color.set(hit ? '#ffffff' : K.col(i));
        R.fix.material.opacity = hit ? 1 : 0.6;
        K.place(R.mov, faceX(i), faceY(i), 16); R.mov.scale.setScalar(110 + 150 * (1 - ph));
      });

      // Players.
      o.pl.forEach((P, i) => {
        const fx = handX(i, v) + DIRS[i][0] * 40, fy = handY(i, v) + DIRS[i][1] * 40;
        const adv = proj(v.px, v.py, i);
        let mood = 'ok', anim;
        if (v.won === i) mood = 'happy';
        else if (v.won >= 0) mood = 'dead';
        else if (v.stun[i] > 0) { mood = 'hurt'; anim = v.stun[i] > 0.9 ? 'Hit_A' : 'Idle'; }
        else if (v.bt[i] > 0) anim = '2H_Melee_Attack_Slice';
        else if (v.miss[i] > 0) anim = 'Idle';
        else if (v.puff[i] > 0.3) anim = 'Walking_Backwards';
        else if (adv < -GOAL * 0.6) anim = 'Blocking';
        else anim = '2H_Melee_Idle';
        const lean = v.won >= 0 ? 0 : -0.18 - v.puff[i] * 0.18 - clamp(v.pw[i] / 10, 0, 0.15);
        P.av.set(fx, fy, { r: R3, look: Math.atan2(v.py - fy, v.px - fx), mood, lean, gear: false, anim: v.won >= 0 ? undefined : anim,
          animSpeed: anim === 'Walking_Backwards' ? 1.6 : anim === '2H_Melee_Attack_Slice' ? 1.8 : undefined });
        const cb = v.cb[i];
        P.aura.visible = cb > 1.15;
        if (P.aura.visible) {
          K.place(P.aura, fx, fy, 3);
          P.aura.scale.setScalar(R3 + 30 + Math.sin(t * 16) * 5);
          P.aura.material.opacity = (cb - 1) * 0.7;
        }
        // Yank cooldown ring at the feet (full = ready).
        const bk = v.bc[i] <= 0 ? -1 : Math.round(v.bc[i] * 40);
        if (bk !== o.lastBc[i]) {
          o.lastBc[i] = bk;
          P.dec.paint((d) => {
            if (v.bc[i] <= 0) d.ring(0, 0, R3 + 40, d.col(i, 'light') + 'ee', 9);
            else d.arc(0, 0, R3 + 40, -Math.PI / 2, -Math.PI / 2 + (1 - v.bc[i]) * Math.PI * 2, d.col(i, 'light') + '88', 9);
          });
        }
        P.dec.at(fx, fy, 2);
        // Combo multiplier label.
        const txt = cb > 1.15 && v.won < 0 ? `x${cb.toFixed(1)}` : '';
        const tcol = cb >= 1.99 ? '#ff7a1a' : '#ffb070';
        if (txt + tcol !== o.lastCb[i]) { o.lastCb[i] = txt + tcol; P.cb.redraw(txt, tcol); }
        P.cb.visible = !!txt;
        K.place(P.cb, fx - DIRS[i][1] * 150 + DIRS[i][0] * 30, fy + DIRS[i][0] * 150 + DIRS[i][1] * 30, 150);
        const stun = v.stun[i] > 0, rat = stun && o.variant === 'peperoncino';
        P.rat.visible = rat;
        P.dizzy.visible = stun;
        if (rat) K.place(P.rat, fx, fy, R3 * 2.9 + 40 + Math.abs(Math.sin(t * 12)) * 12);
        if (stun) K.place(P.dizzy, fx, fy, R3 * 2.9 + (rat ? 0 : 20));
      });
    },
  },

  render(d, v, r) {
    const { ctx } = d;
    const t = d.t;
    const N = v.pw.length;
    drawArena(d, N, true);
    for (let i = 0; i < N; i++) {
      const gx = CX + DIRS[i][0] * GOAL, gy = MID + DIRS[i][1] * GOAL;
      const c = d.col(i) + (Math.sin(t * 6) > 0 ? 'aa' : '66');
      if (DIRS[i][0]) d.rrect(gx - 8, gy - 140, 16, 280, 8, c); else d.rrect(gx - 140, gy - 8, 280, 16, 8, c);
    }

    // Ropes: wobble when slack, vibrate fast when taut.
    const tension = clamp(v.pw.reduce((a, b) => a + b, 0) / (4 * N), 0, 1);
    const amp = (10 + v.wob * 28) * (1 - tension * 0.6);
    const freq = 6 + tension * 18;
    let col = '#d9b77a', edge = '#7a5a2a';
    const blink = Math.floor(t * 10) % 2 === 0;
    if (v.ald === 1) { col = blink ? '#ffb347' : '#d9b77a'; edge = '#c96a2e'; }
    if (v.ald === 2) { col = blink ? '#ff2d2d' : '#ff8080'; edge = '#8b0000'; }
    for (let i = 0; i < N; i++) {
      const hx = mouthX(i), hy = mouthY(i);
      const dx = hx - v.px, dy = hy - v.py, L = Math.hypot(dx, dy) || 1, px = -dy / L, py = dx / L;
      const path = () => {
        ctx.beginPath();
        for (let k = 0; k <= 30; k++) {
          const u = k / 30, off = Math.sin(Math.PI * u) * amp * Math.sin(u * L * 0.022 - t * freq + i);
          const x = v.px + dx * u + px * off, y = v.py + dy * u + py * off;
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      };
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      path(); ctx.strokeStyle = edge; ctx.lineWidth = 22; ctx.stroke();
      path(); ctx.strokeStyle = col; ctx.lineWidth = 14; ctx.stroke();
      ctx.restore();
    }

    // Drum beat.
    if (r.variant === 'tarantella') {
      const ph = ((v.beat % 1) + 1) % 1;
      const hit = ph < 0.12 || ph > 0.9;
      for (let i = 0; i < N; i++) {
        d.ring(faceX(i), faceY(i), 125, hit ? '#fff' : d.col(i) + '88', hit ? 10 : 5);
        d.ring(faceX(i), faceY(i), 125 + 150 * (1 - ph), d.col(i, 'light') + 'aa', 6);
      }
      d.circle(CX, MID, 40 + 30 * Math.pow(1 - ph, 3), 'rgba(255,211,107,0.35)');
    }

    // Knot with a motion trail.
    if (Math.hypot(v.vx, v.vy) > 40) {
      for (let k = 1; k <= 3; k++) d.circle(v.px - v.vx * 0.04 * k, v.py - v.vy * 0.04 * k, BALL_R * (1 - k * 0.15), `rgba(176,138,82,${0.25 - k * 0.06})`);
    }
    d.shadow(v.px + 10, v.py + 14, BALL_R, BALL_R * 0.8, 0.25);
    d.ring(v.px, v.py, 40, '#3a3634', 12);
    d.circle(v.px, v.py, 28, '#b08a52', '#6b4a22', 5);
    d.poly([v.px, v.py - 20, v.px + 50, v.py - 40, v.px, v.py - 60], '#e8261a');

    // Rat.
    if (v.ch) d.emoji('🐀', v.ch[0], v.ch[1], 60);

    // Players.
    for (let i = 0; i < N; i++) {
      const fx = faceX(i), fy = faceY(i);
      const adv = proj(v.px, v.py, i);
      let mood = 'ok';
      if (v.won === i) mood = 'happy';
      else if (v.won >= 0) mood = 'dead';
      else if (v.stun[i] > 0) mood = 'hurt';
      else if (v.bt[i] > 0) mood = 'angry';
      else if (v.miss[i] > 0) mood = 'dizzy';
      else if (adv < -GOAL * 0.6) mood = 'scared';
      else if (v.puff[i] > 0.4) mood = 'angry';
      else if (adv > GOAL * 0.5) mood = 'happy';
      const cb = v.cb[i];
      if (cb > 1.15) d.circle(fx, fy, FACE_R + 26 + Math.sin(t * 16) * 5, `rgba(255,150,40,${(cb - 1) * 0.6})`);
      if (v.bc[i] <= 0) d.ring(fx, fy, FACE_R + 40, d.col(i, 'light') + 'cc', 6);
      else d.arc(fx, fy, FACE_R + 40, -Math.PI / 2, -Math.PI / 2 + (1 - v.bc[i]) * Math.PI * 2, d.col(i, 'light') + '66', 6);
      const squash = v.puff[i] * 0.12 - (v.won === i ? 0.2 : 0);
      d.avatar(fx, fy, FACE_R, i, { look: Math.atan2(MID - fy, CX - fx), mood, squash });
      if (cb > 1.15 && v.won < 0) d.text(`x${cb.toFixed(1)}`, fx - DIRS[i][1] * 160, fy + DIRS[i][0] * 160, { size: 44, color: cb >= 1.99 ? '#ff7a1a' : '#c96a2e' });
      if (v.stun[i] > 0) d.emoji(r.variant === 'peperoncino' ? '🐀' : '💫', fx, fy - FACE_R, 44);
    }
  },
};

// Where player i holds the rope (the knot side of their spot). Steps back a little when winning.
function handX(i, v) { return mouthX(i) + DIRS[i][0] * clamp(proj(v.px, v.py, i), -200, 200) * 0.1; }
function handY(i, v) { return mouthY(i) + DIRS[i][1] * clamp(proj(v.px, v.py, i), -200, 200) * 0.1; }

// The arena: trampled earth around the mud pit, worn lanes toward each player, stakes and chalk lines.
function drawArena(d, N, flat = false) {
  const { ctx } = d;
  if (flat) { ctx.fillStyle = '#6f9a3a'; ctx.fillRect(-400, -400, W + 800, H + 800); }
  const earth = ctx.createRadialGradient(CX, MID, 120, CX, MID, 680);
  earth.addColorStop(0, 'rgba(150,105,60,1)');
  earth.addColorStop(0.75, 'rgba(176,132,80,0.95)');
  earth.addColorStop(1, 'rgba(176,132,80,0)');
  ctx.fillStyle = earth;
  ctx.beginPath(); ctx.arc(CX, MID, 680, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < N; i++) {
    const [dx, dy] = DIRS[i];
    const x0 = CX + dx * 160, y0 = MID + dy * 160, x1 = CX + dx * 660, y1 = MID + dy * 660;
    d.line(x0, y0, x1, y1, 'rgba(120,80,40,0.5)', 150);
    d.line(x0, y0, x1, y1, 'rgba(100,66,30,0.35)', 60);
  }
  for (let k = 0; k < 150; k++) {
    const a = k * 2.399, rr = 170 + ((k * 97) % 480);
    d.circle(CX + Math.cos(a) * rr, MID + Math.sin(a) * rr, 3 + (k % 4), k % 3 ? 'rgba(90,60,30,0.35)' : 'rgba(230,200,150,0.4)');
  }
  // Mud pit.
  d.circle(CX, MID, 175, 'rgba(70,45,22,0.85)');
  d.circle(CX, MID, 150, '#5a3a1e');
  d.circle(CX - 40, MID - 40, 50, 'rgba(255,255,255,0.08)');
  // Chalk goal lines and players' stakes.
  for (let i = 0; i < N; i++) {
    const [dx, dy] = DIRS[i];
    const gx = CX + dx * GOAL, gy = MID + dy * GOAL;
    if (dx) d.rect(gx - 9, gy - 160, 18, 320, 'rgba(255,255,255,0.75)'); else d.rect(gx - 160, gy - 9, 320, 18, 'rgba(255,255,255,0.75)');
    d.circle(faceX(i), faceY(i), 92, d.col(i) + '33', d.col(i) + 'aa', 6);
  }
}

// The village fair: market stalls, tents, a stage with a bard, tavern, castle on the hill, bunting, crowd.
function buildFair(K, o, N) {
  const T = K.THREE;
  const far = K.quality > 0;
  const rnd = mulberry(31);
  const put = (name, x, y, size, face) => { const g = K.model(name, { size }); K.place(g, x, y); K.face(g, face ?? Math.atan2(MID - y, CX - x)); return g; };
  // Fence ring around the arena with openings behind each player.
  const fence = [];
  for (let k = 0; k < 40; k++) {
    const a = (k / 40) * Math.PI * 2 + Math.PI / 40;
    const gap = [Math.PI / 2, -Math.PI / 2, Math.PI, 0].some((g) => Math.abs(Math.atan2(Math.sin(a - g), Math.cos(a - g))) < 0.12);
    if (!gap) fence.push({ x: CX + Math.cos(a) * 760, y: MID + Math.sin(a) * 760, rot: a });
  }
  K.scatter('medieval/fence_wood_straight', fence, { size: 122 });
  // Team flags behind each seat.
  const flagN = ['medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow'];
  for (let i = 0; i < 4; i++) {
    const [dx, dy] = DIRS[i];
    for (const s of [-1, 1]) {
      const f = K.model(flagN[i], { height: i < N ? 190 : 120 });
      K.place(f, CX + dx * 800 - dy * s * 110, MID + dy * 800 + dx * s * 110);
      const fl = { g: f, base: rnd() * 6, ph: rnd() * 6 };
      f.rotation.y = fl.base;
      o.flags.push(fl);
    }
  }
  // Bunting: pennant strings between the poles around the arena (one mesh, vertex colors).
  const cols = ['#ff4b5c', '#3fa9ff', '#5fd35a', '#ffc53d', '#ffffff'].map((c) => new T.Color(c));
  const pos = [], colA = [];
  const poles = [];
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 + Math.PI / 8; poles.push([CX + Math.cos(a) * 820, MID + Math.sin(a) * 820]); }
  const poleM = K.mat('#6b4423', { rough: 0.8 });
  for (const [x, y] of poles) K.place(K.cyl(5, 230, poleM, { seg: 6 }), x, y);
  for (let k = 0; k < 8; k++) {
    const [x0, y0] = poles[k], [x1, y1] = poles[(k + 1) % 8];
    const n = 16;
    for (let q = 0; q < n; q++) {
      const u0 = q / n, u1 = (q + 0.7) / n, um = (q + 0.35) / n;
      const h0 = 225 - Math.sin(Math.PI * u0) * 60, h1 = 225 - Math.sin(Math.PI * u1) * 60, hm = 225 - Math.sin(Math.PI * um) * 60 - 34;
      const P0 = K.p(x0 + (x1 - x0) * u0, y0 + (y1 - y0) * u0, h0), P1 = K.p(x0 + (x1 - x0) * u1, y0 + (y1 - y0) * u1, h1), PM = K.p(x0 + (x1 - x0) * um, y0 + (y1 - y0) * um, hm);
      pos.push(P0.x, P0.y, P0.z, P1.x, P1.y, P1.z, PM.x, PM.y, PM.z);
      const c = cols[(q + k) % cols.length];
      for (let m = 0; m < 3; m++) colA.push(c.r, c.g, c.b);
    }
  }
  const bg = new T.BufferGeometry();
  bg.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  bg.setAttribute('color', new T.Float32BufferAttribute(colA, 3));
  bg.computeVertexNormals();
  const bunting = new T.Mesh(bg, new T.MeshStandardMaterial({ vertexColors: true, side: T.DoubleSide, roughness: 0.7 }));
  bunting.userData.ownGeo = true;
  K.root.add(bunting);
  // Market stalls and tents ringing the fair.
  const ring = [
    ['medieval/building_market_red', -60, 120, 170], ['medieval/building_market_blue', -110, 380, 170], ['medieval/building_market_green', W + 60, 120, 170],
    ['medieval/building_market_yellow', W + 110, 380, 170], ['medieval/tent', -120, 1000, 200], ['medieval/tent', W + 120, 1000, 200],
    ['medieval/building_market_red', W + 70, 1290, 170], ['medieval/building_market_blue', -70, 1290, 170],
  ];
  for (const [name, x, y, s] of ring) put(name, x, y, s);
  // Stage with the bard behind the top side, tavern, houses, well.
  put('medieval/building_stage_A', CX + 330, -190, 260, Math.PI / 2);
  put('medieval/building_tavern_red', CX - 420, -230, 300, Math.PI / 2);
  put('medieval/building_home_A_blue', -380, -150, 230);
  put('medieval/building_home_B_yellow', W + 380, -170, 230);
  put('medieval/building_well_red', W + 330, 700, 150);
  put('medieval/building_church_red', -450, 640, 330);
  put('medieval/target', -200, 760, 90, 0);
  put('medieval/weaponrack', W + 190, 560, 90);
  // The castle on the hill, far behind.
  if (far) K.scatter('medieval/hill_single_A', [{ x: CX - 100, y: -1250 }], { size: 1100 });
  const castle = K.model('medieval/building_castle_red', { size: 700 });
  K.place(castle, CX - 100, -1250, far ? 140 : 0); K.face(castle, Math.PI / 2);
  K.scatter('medieval/building_tower_A_red', [{ x: CX - 620, y: -1050 }, { x: CX + 440, y: -1050 }], { size: 200 });
  // Props.
  K.scatter('medieval/barrel', [{ x: 40, y: 230 }, { x: 70, y: 270 }, { x: W - 40, y: 230 }, { x: 60, y: 1180 }, { x: W - 50, y: 1170 }], { size: 46 });
  K.scatter('medieval/crate_A_big', [{ x: 30, y: 300, rot: 0.3 }, { x: W - 30, y: 300, rot: 1 }, { x: W - 90, y: 1220, rot: 0.5 }], { size: 60 });
  K.scatter('medieval/crate_B_small', [{ x: 90, y: 200 }, { x: W - 90, y: 190, rot: 1 }], { size: 40 });
  K.scatter('medieval/sack', [{ x: 120, y: 1220 }, { x: 150, y: 1250, rot: 1 }, { x: W - 140, y: 1260 }], { size: 46 });
  put('medieval/wheelbarrow', 200, 1300, 90, 0.4);
  put('medieval/bucket_water', W - 200, 1310, 30);
  // Trees and hills around everything.
  const trees = [], trees2 = [];
  for (let k = 0; k < (far ? 50 : 26); k++) {
    const a = rnd() * Math.PI * 2, R = 1400 + rnd() * 1100;
    const x = CX + Math.cos(a) * R, y = MID + Math.sin(a) * R;
    if (y < -700 && Math.abs(x - CX + 100) < 700) continue;
    (k % 2 ? trees : trees2).push({ x, y, rot: rnd() * 6, s: 0.8 + rnd() * 0.5 });
  }
  K.scatter('medieval/trees_A_large', trees, { size: 300 });
  K.scatter('medieval/trees_B_medium', trees2, { size: 260 });
  K.scatter('medieval/tree_single_A', [{ x: -260, y: 200 }, { x: W + 260, y: 260 }, { x: -250, y: 1250 }, { x: W + 260, y: 1230 }, { x: 300, y: -260 }], { size: 150 });
  if (far) {
    K.scatter('medieval/hills_B_trees', [{ x: -1500, y: -900 }, { x: 2900, y: -800, rot: 2 }, { x: -1500, y: 2100, rot: 1 }, { x: 2900, y: 2200 }], { size: 1100 });
    K.scatter('medieval/mountain_A_grass', [{ x: -900, y: -2700 }, { x: 2300, y: -2700, rot: 2 }], { size: 1600 });
    for (const [name, x, y, h, v] of [['medieval/cloud_big', -800, -1800, 1100, 28], ['medieval/cloud_small', 1200, -2100, 1250, 20], ['medieval/cloud_big', 2600, -1500, 1000, 24]]) {
      o.clouds.push({ g: K.model(name, { size: 700, cast: false }), x, y, h, v });
    }
  }
  // The crowd: a few cheering villagers along the fence diagonals (PC only).
  if (far) {
    const roster = K.roster;
    const extra = [['skminion', CX - 560, MID - 560, 'Idle'], ['hooded', CX + 560, MID - 560, 'Idle'], ['barbarian', CX + 560, MID + 580, 'Idle']];
    K.roster = [...roster, ...extra.map(([c]) => ({ char: c, color: 0 }))];
    extra.forEach(([, x, y, anim], k) => o.npcs.push({ av: K.avatar(roster.length + k), x, y, r: 40, anim }));
    K.roster = roster;
  }
  K.ambient('petali', { n: 50, x0: -400, x1: W + 400, y0: -400, y1: H + 400 });
}

// Tiny deterministic RNG for the scenery layout.
function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
