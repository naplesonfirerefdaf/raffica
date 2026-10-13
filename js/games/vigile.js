// L'Araldo Matto (id 'vigile') — Shy Guy Says + Stroop in the market square: white gauntlet = same way,
// red gauntlet = opposite, raised banner = press A (ALT!), salute = press B. Golden gauntlet = double points.
// 2–4 players: everyone answers every command, the FIRST correct answer takes the point.
import { clamp, lerp, r2 } from '../core/geom.js';

const W = 1600, H = 900;
const VX = 800, FLOOR = 790;
const POS = { 2: [210, 1390], 3: [180, 1420, 460], 4: [150, 1450, 430, 1170] };
const RAD = { 2: 92, 3: 86, 4: 82 };
const pxOf = (n) => POS[n] || POS[2];
const radOf = (n) => RAD[n] || RAD[2];
const FEET = 780;                       // players stand here (on their little podiums)
const TBY = 100;                        // command timer bar (below the HUD)
const pyOf = (n) => FEET - radOf(n);    // avatar center
// Actions: 0-3 directions, 4 = A (ALT, banner), 5 = B (salute).
const DIRS = [
  { x: 0, y: -1, n: 'SU' }, { x: 0, y: 1, n: 'GIÙ' },
  { x: -1, y: 0, n: 'SINISTRA' }, { x: 1, y: 0, n: 'DESTRA' },
];
const ALT = 4, SAL = 5;
const NAMES = ['SU', 'GIÙ', 'SINISTRA', 'DESTRA', 'ALT!', 'SALUTA!'];
const OPP = [1, 0, 3, 2];
const WIN = 6, WIN_MAMBO = 4;
const RES_TIME = 0.55;
const SLOT = 0.62; // saltarello: time per shown gesture
const SUDDEN = 22; // from here the next point by a non-trailing player wins
const fill = (n, v) => Array.from({ length: n }, () => v);

// Detect a fresh flick: the stick must come back near the center before the next one counts.
function gesture(s, i, ip) {
  const m = Math.hypot(ip.sx, ip.sy);
  let out = -1;
  if (m < 0.35) s.armed[i] = true;
  else if (s.armed[i] && m >= 0.6) {
    s.armed[i] = false;
    out = Math.abs(ip.sx) > Math.abs(ip.sy) ? (ip.sx < 0 ? 2 : 3) : ip.sy < 0 ? 0 : 1;
  }
  if (out < 0 && ip.aP) out = ALT;
  if (out < 0 && ip.bP) out = SAL;
  return out;
}

const target = (s) => (s.variant === 'mambo' ? WIN_MAMBO : WIN);

function feel(s, i, act, ok) {
  s.fb[i] = { d: act, ok: ok ? 1 : 0, t: 0 };
}

function score(s, i, g, pts, x) {
  const others = s.sc.filter((_, k) => k !== i);
  const decisive = s.sd && s.sc[i] >= Math.max(...others);
  s.sc[i] += pts;
  s.last = i;
  const px = s.px[i], py = s.py;
  g.sfx(pts > 1 ? 'powerup' : 'coin', { pitch: 1 + s.sc[i] * 0.06 });
  g.text(px, py - 200, pts > 1 ? '+2 ORO!' : '+1', { player: i, size: pts > 1 ? 70 : 60 });
  g.burst(px, py, { player: i, n: pts > 1 ? 30 : 14, speed: 280 });
  if (pts > 1) g.burst(px, py - 60, { color: '#ffd23f', n: 20, speed: 320 });
  if (s.sc[i] >= target(s) || decisive) {
    g.slowmo(0.35, 0.8);
    g.end(i, decisive ? 'Morte improvvisa!' : x || 'Riflessi da araldo!');
  }
}

function mistake(s, i, g, penalty) {
  s.err[i]++;
  if (penalty && s.sc[i] > 0) { s.sc[i]--; g.text(s.px[i], s.py - 200, '-1', { player: i, size: 60 }); }
  g.sfx('buzzer');
  g.vibrate(i, 140);
  g.shake(0.2);
}

function newCommand(s, g) {
  const k = clamp(g.t / 28, 0, 1);
  const c = { d: 0, pose: 'arm', red: false, word: -1, wh: true, tgt: 0, gold: false };
  const roll = g.rng();
  if (roll < 0.17) c.pose = 'alt';
  else if (roll < 0.32) c.pose = 'sal';
  else c.d = g.rng.int(0, 3);
  const shown = c.pose === 'alt' ? ALT : c.pose === 'sal' ? SAL : c.d;
  if (g.variant === 'parole') {
    c.word = g.rng.chance(0.75) ? (shown + g.rng.int(1, 5)) % 6 : shown;
    c.tgt = c.word;
  } else {
    c.red = c.pose === 'arm' && g.rng.chance(lerp(0.3, 0.5, k));
    c.tgt = c.pose === 'arm' ? (c.red ? OPP[c.d] : c.d) : shown;
  }
  if (g.variant === 'fischio' && s.k > 0) c.wh = g.rng.chance(0.68);
  if (!c.wh) c.tgt = -1;
  // Golden gauntlet: worth double, more frequent when someone is falling behind.
  const gap = Math.max(...s.sc) - Math.min(...s.sc);
  c.gold = c.wh && s.k > 1 && g.rng.chance(gap >= 2 ? 0.3 : 0.12);
  s.cmd = c;
  s.k++;
  s.ans = fill(s.n, 0);
  s.ph = 'cmd'; s.pt = 0; s.winner = -1;
  s.win = lerp(2.0, 0.95, k) + (g.variant === 'parole' ? 0.25 : 0);
  if (c.wh) g.sfx('whistle', { pitch: 0.9 + g.rng() * 0.3 });
  else g.sfx('whoosh', { vol: 0.5 });
  if (c.gold) g.sfx('coin', { pitch: 1.6, vol: 0.6 });
}

function newMambo(s, g) {
  s.round++;
  const len = Math.min(5, 3 + Math.floor((s.round - 1) / 3));
  s.seq = [];
  for (let n = 0; n < len; n++) {
    let d;
    do d = g.rng.chance(0.25) ? g.rng.int(4, 5) : g.rng.int(0, 3); while (n > 0 && d === s.seq[n - 1]);
    s.seq.push(d);
  }
  s.prog = fill(s.n, 0); s.out = fill(s.n, false);
  s.ph = 'show'; s.pt = 0; s.shown = -1; s.winner = -1;
}

// ---------- Bot helpers ----------
const BOT_TRICK = [0.17, 0.06, 0.015]; // chance to fall for a trick (red gauntlet, lying scroll, missing trumpet)
const BOT_FORGET = [0.07, 0.025, 0];   // saltarello: chance to get one step of the dance wrong
const BOT_READ = [0.14, 0.07, 0.03];   // extra reading time when the command is a trick
const BOT_SLOT = [0.3, 0.2, 0.14];     // saltarello: time per repeated step

// Stick / buttons for one action (0-3 directions, 4 = A, 5 = B).
function botAct(act, tap) {
  const w = { x: 0, y: 0, sx: 0, sy: 0 };
  if (act >= 0 && act < 4) { w.sx = w.x = DIRS[act].x; w.sy = w.y = DIRS[act].y; }
  else if (act === ALT) w.tapA = tap;
  else if (act === SAL) w.tapB = tap;
  return w;
}

export default {
  id: 'vigile',
  name: "L'Araldo Matto",
  rule: 'Guanto bianco: stessa direzione. Rosso: al contrario!',
  verb: 'INDICA!',
  inspired: 'Mario Party · Shy Guy Says',
  cam: 'side',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Alt!', b: 'Saluta', dirLabel: 'Indica' },
  help: {
    goal: "Esegui per primo il comando dell'araldo: 6 punti per vincere.",
    dir: "Indica la direzione: guanto BIANCO = la stessa dell'araldo, guanto ROSSO = quella opposta. Riporta lo stick al centro prima del gesto successivo.",
    a: "ALT!: premi A quando l'araldo alza lo STENDARDO bianco e rosso.",
    b: "SALUTA: premi B quando l'araldo si porta la mano al CAPPELLO.",
    tips: ['Risposta sbagliata = -1 punto e sei fuori per quel comando', "Guanto d'ORO = vale 2 punti (esce più spesso se qualcuno è indietro)", 'Dopo 22 s: morte improvvisa, il prossimo punto può chiudere la partita'],
  },
  duration: 35,
  noMods: ['invert', 'sapone', 'scambio', 'scirocco', 'peperoncino'],
  variants: [
    { id: 'fischio', name: 'Squillo Falso', desc: 'Vale solo se suona la trombetta! Senza squillo: fermi!' },
    { id: 'parole', name: 'Pergamene Bugiarde', desc: 'Conta la PAROLA sulla pergamena, non il gesto!' },
    { id: 'mambo', name: 'Saltarello', desc: 'Memorizza la danza (anche A e B) e ripetila per primo!' },
  ],

  init(g) {
    const n = g.n || 2;
    return {
      n, px: pxOf(n), py: pyOf(n),
      variant: g.variant, sc: fill(n, 0), err: fill(n, 0), last: -1, winner: -1,
      ph: 'gap', pt: 0, gap: 0.6, win: 2, k: 0, cmd: null, ans: fill(n, 0),
      armed: fill(n, true), fb: fill(n, 0).map(() => ({ d: -1, ok: 0, t: 9 })),
      sd: false, round: 0, seq: [], prog: fill(n, 0), out: fill(n, false), shown: -1,
    };
  },

  step(s, inp, g) {
    const dt = g.dt;
    const n = s.n;
    s.pt += dt;
    for (const f of s.fb) f.t += dt;
    if (g.ended) return;
    if (!s.sd && g.t >= SUDDEN) {
      s.sd = true;
      g.say('MORTE IMPROVVISA!');
      g.sfx('matchpoint');
    }
    const gest = s.sc.map((_, i) => gesture(s, i, inp[i]));
    // Same-step answers: button presses carry a timestamp, otherwise a random order.
    const rot = g.rng.int(0, n - 1);
    const stamp = (i) => (gest[i] === ALT ? inp[i].aT : gest[i] === SAL ? inp[i].bT : -1);
    const order = s.sc.map((_, k) => (k + rot) % n).sort((a, b) => (stamp(a) >= 0 && stamp(b) >= 0 ? stamp(a) - stamp(b) : 0));

    if (g.variant === 'mambo') {
      if (s.ph === 'gap') { if (s.pt >= 0.6) newMambo(s, g); return; }
      if (s.ph === 'show') {
        const idx = Math.floor(s.pt / SLOT);
        if (idx !== s.shown && idx < s.seq.length) {
          s.shown = idx;
          g.sfx('whistle', { pitch: 0.85 + s.seq[idx] * 0.1 });
        }
        if (s.pt >= s.seq.length * SLOT + 0.15) {
          s.ph = 'input'; s.pt = 0; s.win = 1.6 + s.seq.length * 0.7;
          g.say('RIPETI!');
          g.sfx('go');
        }
        return;
      }
      if (s.ph === 'input') {
        for (const i of order) {
          if (gest[i] < 0 || s.out[i] || g.ended || s.ph !== 'input') continue;
          if (gest[i] === s.seq[s.prog[i]]) {
            feel(s, i, gest[i], true);
            s.prog[i]++;
            g.sfx('tick', { pitch: 1 + s.prog[i] * 0.15 });
            if (s.prog[i] >= s.seq.length) {
              s.winner = i;
              score(s, i, g, 1, 'Re del Saltarello!');
              s.ph = 'res'; s.pt = 0;
            }
          } else {
            feel(s, i, gest[i], false);
            s.out[i] = true;
            mistake(s, i, g, false);
          }
        }
        if (s.ph === 'input' && (s.out.every(Boolean) || s.pt >= s.win)) {
          g.sfx('quack');
          s.ph = 'res'; s.pt = 0;
        }
        return;
      }
      if (s.ph === 'res' && s.pt >= 0.9) { s.ph = 'gap'; s.pt = 0; }
      return;
    }

    if (s.ph === 'gap') {
      s.gap = lerp(0.75, 0.35, clamp(g.t / 28, 0, 1));
      // Moving during the gap does nothing, but the stick must be re-centred.
      if (s.pt >= s.gap) newCommand(s, g);
      return;
    }
    if (s.ph === 'cmd') {
      const c = s.cmd;
      for (const i of order) {
        if (gest[i] < 0 || s.ans[i] || s.ph !== 'cmd' || g.ended) continue;
        if (c.tgt >= 0 && gest[i] === c.tgt) {
          s.ans[i] = 1;
          s.winner = i;
          feel(s, i, gest[i], true);
          score(s, i, g, c.gold ? 2 : 1);
          s.ph = 'res'; s.pt = 0;
        } else {
          s.ans[i] = 2;
          feel(s, i, gest[i], false);
          mistake(s, i, g, true);
          g.text(s.px[i], s.py - 260, c.tgt < 0 ? 'NON HA SUONATO!' : c.red && gest[i] === c.d ? 'ERA ROSSO!' : 'SBAGLIATO!', { player: i, size: 40 });
        }
      }
      if (s.ph === 'cmd' && (s.ans.every((a) => a === 2) || s.pt >= s.win)) {
        if (c.tgt < 0 && s.ans.every((a) => !a)) { g.sfx('pop'); g.text(VX, 200, 'BRAVI, FERMI!', { color: '#fff', size: 50 }); }
        s.ph = 'res'; s.pt = 0;
      }
      return;
    }
    if (s.ph === 'res' && s.pt >= RES_TIME) { s.ph = 'gap'; s.pt = 0; }
  },

  // Computer player: reads the herald like a human would (gauntlet colour, scroll, trumpet); the weaker
  // levels fall for the tricks more often and forget steps of the dance.
  bot(s, me, g, B) {
    const M = B.mem, L = B.level, rest = botAct(-1, false);
    if (g.ended) return rest;
    if (s.variant === 'mambo') {
      if (s.ph !== 'input' || s.out[me]) return rest;
      if (M.round !== s.round) {
        M.round = s.round;
        M.t0 = g.t + B.rng() * BOT_READ[L] * 2;
        M.seq = s.seq.map((d) => (B.rng() < BOT_FORGET[L] ? (d + 1 + Math.floor(B.rng() * 5)) % 6 : d));
        M.tapped = -1;
      }
      const P = BOT_SLOT[L], u = (g.t - M.t0) / P, j = Math.floor(u);
      if (u < 0 || j >= M.seq.length || u - j > 0.5) return rest; // second half of each step: back to the centre
      const tap = M.tapped !== j;
      M.tapped = j;
      return botAct(M.seq[j], tap);
    }
    if (s.ph !== 'cmd' || s.ans[me]) return rest;
    const c = s.cmd;
    if (M.k !== s.k) {
      M.k = s.k;
      const shown = c.pose === 'alt' ? ALT : c.pose === 'sal' ? SAL : c.d;
      const trick = c.red || !c.wh || (c.word >= 0 && c.word !== shown);
      M.act = trick && B.rng() < BOT_TRICK[L] ? shown : c.tgt;
      M.go = g.t + B.rng() * BOT_READ[L] + (trick ? BOT_READ[L] : 0);
      M.tapT = -9;
    }
    if (M.act < 0 || g.t < M.go) return rest;
    // Buttons: one press (again only if it got lost); directions: hold until the answer is taken.
    const tap = g.t - M.tapT > [0.34, 0.2, 0.09][L] + 0.25;
    if (tap) M.tapT = g.t;
    return botAct(M.act, tap);
  },

  timeout(s) {
    const top = Math.max(...s.sc);
    let cand = s.sc.map((v, i) => (v === top ? i : -1)).filter((i) => i >= 0);
    if (cand.length === 1) return cand[0];
    const few = Math.min(...cand.map((i) => s.err[i]));
    cand = cand.filter((i) => s.err[i] === few);
    if (cand.length === 1) return cand[0];
    return cand.includes(s.last) ? s.last : s.last >= 0 ? cand[0] : -1;
  },

  view(s) {
    const c = s.cmd;
    const mambo = s.variant === 'mambo';
    let act = -1, red = 0, word = -1, wh = 0, gold = 0, tgt = -1;
    if (mambo) {
      if (s.ph === 'show') {
        const idx = Math.floor(s.pt / SLOT);
        if (idx < s.seq.length && s.pt - idx * SLOT < SLOT - 0.14) { act = s.seq[idx]; wh = 1; }
      }
    } else if (c && (s.ph === 'cmd' || s.ph === 'res')) {
      act = c.pose === 'alt' ? ALT : c.pose === 'sal' ? SAL : c.d;
      red = c.red ? 1 : 0; word = c.word; wh = c.wh ? 1 : 0; gold = c.gold ? 1 : 0; tgt = c.tgt;
    }
    const v = {
      ph: s.ph, pt: r2(s.pt), act, red, word, wh, gold, tgt, k: s.k, wn: s.winner,
      tl: s.ph === 'cmd' || s.ph === 'input' ? r2(clamp(1 - s.pt / s.win, 0, 1)) : 0,
      ans: s.ans.slice(),
      fb: s.fb.map((f) => ({ d: f.d, ok: f.ok, t: r2(Math.min(f.t, 9)) })),
      hud: { p: s.sc.slice(), max: mambo ? WIN_MAMBO : WIN, label: 'Punti' },
      sd: s.sd ? 1 : 0,
    };
    if (mambo) {
      v.len = s.seq.length;
      v.idx = s.ph === 'show' ? Math.min(s.seq.length - 1, Math.floor(s.pt / SLOT)) : -1;
      v.out = s.out.map((o) => (o ? 1 : 0));
      v.seq = s.ph === 'res' ? s.seq.slice() : null;
      v.hud.bar = s.ph === 'input' || s.ph === 'res' ? s.prog.map((p) => r2(p / Math.max(1, s.seq.length))) : fill(s.n, 0);
    }
    return v;
  },

  focus(v) {
    const n = v.fb.length, px = pxOf(n), py = pyOf(n);
    return v.fb.map((_, i) => ({ x: px[i], y: py }));
  },

  // ---------- 3D: the village market square on fair day, the herald on his striped pedestal ----------
  render3d: {
    assets: [
      'medieval/building_home_A_red', 'medieval/building_home_A_blue', 'medieval/building_home_A_green', 'medieval/building_home_A_yellow',
      'medieval/building_home_B_red', 'medieval/building_home_B_blue', 'medieval/building_home_B_green', 'medieval/building_home_B_yellow',
      'medieval/building_tavern_red', 'medieval/building_market_red', 'medieval/building_market_blue', 'medieval/building_market_green',
      'medieval/building_market_yellow', 'medieval/building_church_yellow', 'medieval/building_well_blue', 'medieval/building_castle_blue',
      'medieval/building_windmill_yellow', 'medieval/hills_A_trees', 'medieval/hills_C_trees', 'medieval/mountain_A_grass_trees',
      'medieval/trees_A_medium', 'medieval/trees_B_medium', 'medieval/tree_single_A', 'medieval/barrel', 'medieval/crate_A_big',
      'medieval/crate_open', 'medieval/sack', 'medieval/wheelbarrow', 'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green',
      'medieval/flag_yellow', 'medieval/cloud_big', 'medieval/cloud_small', 'medieval/bucket_water', 'medieval/fence_wood_straight',
    ],
    build(K, r) {
      const T = K.THREE;
      const mambo = r.variant === 'mambo';
      const n = clamp(r.n || (r.roster && r.roster.length) || 2, 2, 4);
      const hi = K.quality > 0;
      K.theme('giorno', { fogNear: 1.6, fogFar: 4.6 });
      const o = { mambo, n, lastWord: -2 };

      // Square: cobblestones everywhere, a lighter paved ring around the herald.
      flat(K, 'pietra', YF, -4200, 900, -4200, W + 4200, 150, '#e6dccd');
      const ringFloor = K.mesh(new T.CircleGeometry(520, 48).rotateX(-Math.PI / 2), K.texMat('lastre', [6, 6], { color: '#f2e6d0' }), { cast: false });
      ringFloor.position.set(VX, -YF + 1, -220);

      // Far away: hills, the castle on the hill, a windmill.
      K.scatter('medieval/mountain_A_grass_trees', [{ x: -1800, y: YF, h: -4200 }, { x: 3600, y: YF, h: -4300, rot: 1 }], { size: 2200 });
      K.scatter('medieval/hills_A_trees', [-2400, -600, 2200, 3800].map((x, k) => ({ x, y: YF, h: -3000 - (k % 2) * 300, rot: k })), { size: 1500 });
      K.scatter('medieval/hills_C_trees', [{ x: VX - 1500, y: YF, h: -3500 }, { x: VX + 1700, y: YF, h: -3400, rot: 2 }], { size: 1500 });
      K.place(K.model('medieval/building_castle_blue', { height: 1000 }), VX + 520, YF, -3000);
      K.place(K.model('medieval/building_windmill_yellow', { height: 620 }), -900, YF, -2200);

      // The square's houses (team colors), the tavern and the church behind.
      const C4 = ['red', 'blue', 'green', 'yellow'];
      const houses = [];
      for (let k = -6; k <= 6; k++) {
        if (Math.abs(k) <= 1) continue;
        houses.push({ name: `medieval/building_home_${k % 2 ? 'A' : 'B'}_${C4[(k + 8) % 4]}`, x: VX + k * 330, z: -1250 - (Math.abs(k) % 2) * 120, rot: (k % 3) * 0.12 });
      }
      for (const hs of houses) { const m = K.model(hs.name, { size: 360 }); K.place(m, hs.x, YF, hs.z); m.rotation.y = hs.rot; }
      const church = K.model('medieval/building_church_yellow', { height: 780 }); K.place(church, VX, YF, -1700);
      const tav = K.model('medieval/building_tavern_red', { size: 480 }); K.place(tav, -620, YF, -760); tav.rotation.y = 0.55;
      // Market stalls between the players (behind them) and at the edges.
      const stalls = [['blue', VX - 420, -820, 0.15], ['green', VX + 420, -820, -0.15], ['red', -260, -420, 0.5], ['yellow', W + 260, -420, -0.5]];
      for (const [c, x, z, rot] of stalls) { const m = K.model(`medieval/building_market_${c}`, { size: 400 }); K.place(m, x, YF, z); m.rotation.y = rot; }
      const well = K.model('medieval/building_well_blue', { size: 230 }); K.place(well, W + 640, YF, -760);
      // Goods of the fair.
      if (hi) {
        K.scatter('medieval/barrel', [{ x: VX - 560, y: YF, h: -700 }, { x: VX - 610, y: YF, h: -640 }, { x: W + 120, y: YF, h: -260 }, { x: -110, y: YF, h: -300 }], { height: 70 });
        K.scatter('medieval/crate_A_big', [{ x: VX + 560, y: YF, h: -690, rot: 0.3 }, { x: -60, y: YF, h: -230, rot: 0.6 }], { height: 66 });
        K.scatter('medieval/crate_open', [{ x: VX + 610, y: YF, h: -630, rot: -0.2 }, { x: W + 60, y: YF, h: -330 }], { height: 60 });
        K.scatter('medieval/sack', [{ x: VX - 500, y: YF, h: -610 }, { x: VX + 500, y: YF, h: -600, rot: 1 }, { x: W + 170, y: YF, h: -350, rot: 2 }], { size: 70 });
        K.scatter('medieval/bucket_water', [{ x: W + 520, y: YF, h: -640 }], { height: 50 });
        K.scatter('medieval/wheelbarrow', [{ x: -330, y: YF, h: -200, rot: 0.8 }], { size: 120 });
      }
      K.scatter('medieval/trees_A_medium', [-1500, -1100, W + 1100, W + 1500].map((x, k) => ({ x, y: YF, h: -1000 - (k % 2) * 300, rot: k })), { size: 380 });
      K.scatter('medieval/trees_B_medium', [-1900, W + 1900, VX - 900, VX + 900].map((x, k) => ({ x, y: YF, h: -1900 - (k % 2) * 200, rot: k * 2 })), { size: 420 });
      K.scatter('medieval/tree_single_A', [{ x: -900, y: YF, h: -350 }, { x: W + 900, y: YF, h: -380, rot: 2 }], { height: 380 });
      // Banners on poles at the corners of the square.
      o.flags = [];
      [[-420, -560, 0], [W + 420, -560, 1], [-1000, -1000, 2], [W + 1000, -1000, 3]].forEach(([x, z, c]) => {
        const f = K.model(`medieval/flag_${C4[c]}`, { height: 330 });
        K.place(f, x, YF, z);
        f.rotation.y = Math.PI / 2;
        o.flags.push(f);
      });

      // Carts rolling by behind the herald.
      o.cars = [0, 1, 2].map((k) => makeCart(K, k, k % 2 ? -1 : 1));

      // Bunting in the team colors across the square.
      const pts = [];
      for (let k = 0; k <= 24; k++) { const x = -700 + k * 125; pts.push(new T.Vector3(x, -(130 + Math.sin((k / 24) * Math.PI) * 90), -560)); }
      K.mesh(new T.TubeGeometry(new T.CatmullRomCurve3(pts), 60, 2.5, 5), K.mat('#6a4a2a'), { cast: false });
      o.flagsB = [];
      const tri = [0, 1, 2, 3].map((c) => K.mat(['#ff4b5c', '#3fa9ff', '#5fd35a', '#ffc53d'][c], { rough: 0.6, side: 2 }));
      for (let k = 0; k < 24; k++) {
        const fl = K.prism([-26, 0, 26, 0, 0, 44], 3, tri[k % 4], { cast: false });
        const p = pts[k].clone().lerp(pts[k + 1], 0.5);
        fl.position.set(p.x, p.y, p.z);
        o.flagsB.push(fl);
      }
      // Clouds + petals in the air.
      o.clouds = [0, 1, 2].map((k) => K.model(k % 2 ? 'medieval/cloud_small' : 'medieval/cloud_big', { size: k % 2 ? 480 : 760, cast: false }));
      K.ambient('petali', { n: 40, x0: -300, x1: W + 300, y0: -100, y1: YF });

      // The herald.
      o.vig = makeHerald(K);
      o.aura = K.disc(1, K.glow('#ffd23f', { opacity: 0.25, add: true }));
      o.card = K.billboard(512, 140, 420, (d, w, h, word) => {
        if (word === undefined || word < 0) return;
        d.rrect(8, 8, w - 16, h - 16, 26, '#f6e6bd', '#5a3418', 8);
        d.text(NAMES[word], w / 2, h / 2 + 4, { size: 72, color: '#b0122e', stroke: false });
      });

      // Players on their round wooden podiums, with feedback arrows and victory rings.
      const px0 = pxOf(n), R0 = radOf(n);
      const wood = K.texMat('legno', [3, 1], { color: '#c89a68' });
      o.pl = [];
      for (let i = 0; i < n; i++) {
        const pod = K.mesh(new T.CylinderGeometry(R0 * 1.22, R0 * 1.28, YF - FEET, 28), wood);
        K.place(pod, px0[i], (YF + FEET) / 2, 0);
        const rim = K.mesh(new T.TorusGeometry(R0 * 1.24, 6, 8, 40).rotateX(Math.PI / 2), K.mat(K.col(i), { rough: 0.4, emissive: K.col(i), ei: 0.25 }), { cast: false });
        K.place(rim, px0[i], FEET, 0);
        const arrow = makeArrow3d(K, 0.36);
        const ring = K.torus(1, 0.07, K.glow(K.col(i, 'light'), { opacity: 0.85 }), { cast: false });
        o.pl.push({ av: K.avatar(i), arrow, ring, key: 0, lastF: 9 });
      }

      // Command timer bar.
      o.tbg = K.box(612, 34, 8, K.glow('#000000', { opacity: 0.45 }), { cast: false });
      K.place(o.tbg, VX, TBY, 10);
      o.tfill = K.box(1, 24, 12, K.glow('#ffffff', { unique: true }), { cast: false });

      o.ui = K.layer({
        x0: 0, y0: 0, x1: W, y1: H, h: 0, transparent: true, lit: false, z: 6,
        draw: (d, v, rr) => drawUi3dV(d, v, rr),
        key: (v) => uiKeyV(v, K),
      });
      o.ui.mesh.material.depthTest = false; o.ui.mesh.renderOrder = 50;
      return o;
    },

    update(K, o, v) {
      const t = K.t;
      const n = Math.min(v.fb.length, o.pl.length);
      const px = pxOf(v.fb.length), R = radOf(v.fb.length), py = pyOf(v.fb.length);
      // Market life.
      o.cars.forEach((c, k) => {
        const sp = 150 + k * 50;
        const cx = c.dir > 0 ? ((t * sp + k * 900) % (W + 2800)) - 1400 : W + 1400 - ((t * sp + k * 700) % (W + 2800));
        K.place(c.g, cx, YF, c.dir > 0 ? -430 : -640);
        c.wheels.forEach((w) => { w.rotation.z = -c.dir * t * sp / 40; });
      });
      o.flags.forEach((f, k) => { f.rotation.y = Math.PI / 2 + Math.sin(t * 1.6 + k) * 0.2; });
      o.flagsB.forEach((f, k) => { f.rotation.x = Math.sin(t * 2 + k) * 0.35; });
      o.clouds.forEach((g, k) => K.place(g, ((k * 1500 + t * (18 + k * 6)) % (W + 4400)) - 2200, -200 + k * 80, -2200 - k * 150));

      poseHerald(K, o, v, t);

      // Players.
      const mambo = o.mambo;
      for (let i = 0; i < n; i++) {
        const f = v.fb[i], P = o.pl[i], x = px[i];
        const fresh = f.t < 0.7;
        const lost = mambo && v.out && v.out[i] && (v.ph === 'input' || v.ph === 'res');
        const won = v.ph === 'res' && v.wn === i;
        const mood = lost || (fresh && !f.ok) ? 'dizzy' : won || (fresh && f.ok) ? 'happy' : v.tl > 0 && v.tl < 0.35 ? 'scared' : 'ok';
        const lean = fresh && f.d >= 0 && f.d < 4 ? DIRS[f.d] : { x: 0, y: 0 };
        const k = fresh ? Math.max(0, 1 - f.t / 0.6) : 0;
        if (f.t < P.lastF - 0.05) P.key++;
        P.lastF = f.t;
        let anim;
        if (won) anim = 'Cheer';
        else if (fresh && !f.ok) anim = 'Hit_A';
        else if (fresh && f.d === ALT) anim = 'Block';
        else if (fresh && f.d === SAL) anim = 'Interact';
        else if (fresh && f.d >= 0 && f.d < 4) anim = f.d === 0 ? 'Spellcast_Raise' : f.d === 1 ? 'PickUp' : 'Unarmed_Melee_Attack_Punch_A';
        else if (lost) anim = 'Sit_Floor_Idle';
        P.av.set(x + lean.x * 22 * k, py, {
          r: R, look: f.d === 2 && fresh ? Math.PI : f.d === 3 && fresh ? 0 : x < VX ? 0 : Math.PI, mood, anim, animKey: P.key, gear: false,
        });
        const showA = fresh && f.d >= 0 && f.d < 4;
        P.arrow.g.visible = showA;
        if (showA) {
          P.arrow.fill.color.set(f.ok ? '#3dff7a' : '#ff4d4d');
          P.arrow.glow.color.set(f.ok ? '#3dff7a' : '#ff4d4d');
          K.place(P.arrow.g, x, py - R - 110, 60);
          K.face(P.arrow.g, Math.atan2(DIRS[f.d].y, DIRS[f.d].x));
          P.arrow.g.scale.setScalar(0.36 * (1 + 0.3 * Math.max(0, 1 - f.t / 0.12)));
        }
        P.ring.visible = won;
        if (won) { K.place(P.ring, x, py, 20); P.ring.scale.setScalar(R * 1.2 + v.pt * 90); }
      }

      // Timer bar.
      const on = v.tl > 0;
      o.tbg.visible = o.tfill.visible = on;
      if (on) {
        o.tfill.scale.x = Math.max(1, 600 * v.tl);
        K.place(o.tfill, VX - 300 + 300 * v.tl, TBY, 12);
        o.tfill.material.color.set(v.tl < 0.3 ? '#ff5050' : v.gold ? '#ffd23f' : '#ffffff');
      }
    },
  },

  render(d, v, r) {
    drawStreet(d);
    const mambo = r.variant === 'mambo';
    const n = v.fb.length, px = pxOf(n), py = pyOf(n), R = radOf(n);
    drawVigile(d, v, mambo);

    // Players.
    v.fb.forEach((f, i) => {
      const x = px[i];
      const fresh = f.t < 0.7;
      const lost = mambo && v.out && v.out[i] && (v.ph === 'input' || v.ph === 'res');
      const won = v.ph === 'res' && v.wn === i;
      const mood = lost || (fresh && !f.ok) ? 'dizzy' : won || (fresh && f.ok) ? 'happy' : v.tl > 0 && v.tl < 0.35 ? 'scared' : 'ok';
      const lean = fresh && f.d >= 0 && f.d < 4 ? DIRS[f.d] : { x: 0, y: 0 };
      const k = fresh ? Math.max(0, 1 - f.t / 0.6) : 0;
      const hop = won ? Math.abs(Math.sin(v.pt * 14)) * 30 : 0;
      d.shadow(x, FEET + 5, R * 0.95, 16, 0.3);
      d.rrect(x - R * 1.2, FEET - 10, R * 2.4, 40, 14, d.col(i, 'dark'), '#00000088', 4);
      d.avatar(x + lean.x * 26 * k, py + lean.y * 26 * k - hop, R, i, {
        look: Math.atan2(470 - py, VX - x), mood, squash: fresh && !f.ok ? Math.sin(f.t * 30) * 0.15 : f.d >= 4 && fresh ? 0.2 * k : 0,
      });
      if (fresh && f.d >= 0 && f.d < 4) drawArrow(d, x, py - R - 100, f.d, 0.36, f.ok ? '#3dff7a' : '#ff4d4d', '#00000088');
      if (won) d.ring(x, py, R * 1.2 + v.pt * 90, d.col(i, 'light'), 8);
    });

    // Time left for this command.
    if (v.tl > 0) {
      d.rrect(VX - 300, TBY - 13, 600, 26, 13, '#00000066');
      d.rrect(VX - 300, TBY - 13, 600 * v.tl, 26, 13, v.tl < 0.3 ? '#ff5050' : v.gold ? '#ffd23f' : '#ffffff');
    }
    drawUi3dV(d, v, r);
  },
};

// ---------- 2D helpers (fallback) ----------

function drawLegend(d, variant) {
  const y = 858;
  d.rrect(VX - 580, y - 30, 1160, 60, 30, '#000000aa');
  const txt = variant === 'parole' ? 'Conta la PAROLA! · ALT = A · SALUTA = B'
    : variant === 'fischio' ? 'Senza squillo NON muoverti · Rosso = al contrario · Stendardo = A · Saluto = B'
      : 'Bianco = stessa · ROSSO = contrario · Stendardo = A · Saluto = B';
  d.text(txt, VX, y + 2, { size: 30, color: '#fff' });
}

function drawKey(d, x, y, ch, col) {
  d.circle(x, y, 44, col, '#00000088', 6);
  d.text(ch, x, y + 2, { size: 54, color: '#111' });
}

function drawArrow(d, x, y, dir, sc, fill, stroke) {
  const a = Math.atan2(DIRS[dir].y, DIRS[dir].x), ca = Math.cos(a), sa = Math.sin(a);
  const L = 230 * sc, sw = 40 * sc, hw = 95 * sc, hl = 110 * sc;
  const pts = [[-L / 2, -sw], [L / 2 - hl, -sw], [L / 2 - hl, -hw], [L / 2, 0], [L / 2 - hl, hw], [L / 2 - hl, sw], [-L / 2, sw]];
  const flat2 = [];
  for (const [px, py] of pts) flat2.push(x + px * ca - py * sa, y + px * sa + py * ca);
  d.poly(flat2, fill, stroke, Math.max(3, 8 * sc));
}

function drawStreet(d) {
  const ctx = d.ctx;
  const sky = ctx.createLinearGradient(0, -200, 0, 650);
  sky.addColorStop(0, '#3d82d6');
  sky.addColorStop(1, '#d8ecff');
  ctx.fillStyle = sky;
  ctx.fillRect(-900, -600, W + 1800, 1300);
  // Half-timbered houses.
  const cols = ['#f2e2c2', '#e8d2a8', '#f5ead0', '#e2c89a'];
  const roofs = ['#c0392b', '#2e6fb0', '#3d8a3a', '#d9a520'];
  for (let k = -2; k < 8; k++) {
    const x = k * 270 - 40, h = 380 + ((((k * 73) % 5) + 5) % 5) * 30, top = 700 - h;
    d.rect(x, top, 270, h, cols[(k + 8) % 4], '#5a3418', 4);
    d.line(x, top + 120, x + 270, top + 120, '#5a3418', 10);
    d.line(x + 135, top, x + 135, 700, '#5a3418', 10);
    d.poly([x - 20, top, x + 135, top - 120, x + 290, top], roofs[(k + 8) % 4], '#00000055', 3);
    for (let c = 0; c < 2; c++) d.rect(x + 40 + c * 140, top + 40, 50, 60, '#3a5a70', '#5a3418', 4);
  }
  const tri = ['#ff4b5c', '#3fa9ff', '#5fd35a', '#ffc53d'];
  for (let k = 0; k < 22; k++) {
    const x = -60 + k * 80, y = 230 + Math.sin((k / 21) * Math.PI) * 60 + Math.sin(d.t * 2 + k) * 3;
    d.poly([x, y, x + 50, y, x + 25, y + 40], tri[k % 4], '#00000044', 2);
  }
  d.rect(-900, 700, W + 1800, 600, '#a8988a');
  d.rect(-900, 700, W + 1800, 18, '#8a7a6a');
}

function drawVigile(d, v, mambo) {
  const ctx = d.ctx;
  const dance = mambo && (v.ph === 'input' || v.ph === 'gap' || v.ph === 'res') ? Math.sin(d.t * 9) : 0;
  const pop = v.act >= 0 ? Math.max(0, 1 - v.pt / 0.12) : 0;
  const bob = Math.sin(d.t * 3) * 4 + Math.abs(dance) * 10 + pop * 14;
  d.shadow(VX, FLOOR + 30, 150, 22, 0.35);
  d.rrect(VX - 120, FLOOR - 30, 240, 60, 18, '#ffd23f', '#333', 4);
  for (let k = 0; k < 4; k++) d.rect(VX - 100 + k * 55, FLOOR - 30, 26, 60, '#6a3fa0');
  if (v.gold) d.circle(VX, FLOOR - 300, 260 + Math.sin(d.t * 8) * 12, 'rgba(255,210,63,0.22)');
  ctx.save();
  ctx.translate(VX, -bob);
  ctx.rotate(dance * 0.08);
  const top = FLOOR - 30;
  d.line(-30, top, -26 + dance * 20, top - 150, '#6a3fa0', 32);
  d.line(30, top, 26 - dance * 20, top - 150, '#ffd23f', 32);
  const sy = top - 330;
  d.rrect(-75, sy, 150, 190, 30, '#6a3fa0', '#2a1040', 4);
  d.rect(-20, sy, 40, 190, '#ffd23f');
  const L = [-62, sy + 25], R = [62, sy + 25];
  const glove = v.gold ? '#ffd23f' : v.red ? '#ff2b2b' : '#ffffff';
  const hy = sy - 70;
  let used = null, arrowAt = null;
  if (v.act >= 0 && v.act < 4) {
    const dv = DIRS[v.act];
    const sh = dv.x < 0 ? L : R;
    const hand = dv.y > 0 ? [sh[0] + 40, sh[1] + 170] : [sh[0] + dv.x * 165, sh[1] + dv.y * 165];
    d.line(sh[0], sh[1], hand[0], hand[1], '#6a3fa0', 30);
    d.circle(hand[0], hand[1], 30, glove, '#222', 4);
    used = sh; arrowAt = hand;
  } else if (v.act === ALT) {
    const hand = [R[0] + 40, R[1] - 150];
    d.line(R[0], R[1], hand[0], hand[1], '#6a3fa0', 30);
    d.circle(hand[0], hand[1], 26, glove, '#222', 4);
    d.line(hand[0], hand[1], hand[0] + 10, hand[1] - 90, '#5a3418', 12);
    const s2 = 1 + pop * 0.3;
    d.circle(hand[0] + 12, hand[1] - 150, 70 * s2, '#e53935', '#222', 5);
    d.circle(hand[0] + 12, hand[1] - 150, 46 * s2, '#ffffff');
    d.text('ALT', hand[0] + 12, hand[1] - 148, { size: 34 * s2, color: '#e53935' });
    used = R;
  } else if (v.act === SAL) {
    const hand = [34, hy - 50];
    d.line(R[0], R[1], R[0] + 60, sy - 10, '#6a3fa0', 30);
    d.line(R[0] + 60, sy - 10, hand[0], hand[1], '#6a3fa0', 28);
    d.circle(hand[0], hand[1], 26, glove, '#222', 4);
    used = R;
  }
  for (const sh of [L, R]) {
    if (used === sh) continue;
    const s = sh[0] < 0 ? -1 : 1;
    const hand = dance ? [sh[0] + s * 70, sh[1] - 60 + dance * s * 50] : [sh[0] + s * 30, sh[1] + 120];
    d.line(sh[0], sh[1], hand[0], hand[1], '#6a3fa0', 30);
    d.circle(hand[0], hand[1], 26, mambo ? '#ffffff' : glove, '#222', 4);
  }
  d.circle(0, hy, 70, '#f2c49b', '#8a5a3a', 4);
  const look = v.act >= 0 && v.act < 4 ? DIRS[v.act] : { x: 0, y: 0 };
  for (const ex of [-24, 24]) {
    d.circle(ex, hy - 12, 14, '#fff', '#222', 2);
    d.circle(ex + look.x * 6, hy - 12 + look.y * 6, 7, '#222');
  }
  d.poly([-44, hy + 22, 0, hy + 10, 44, hy + 22, 22, hy + 30, 0, hy + 22, -22, hy + 30], '#3a2010');
  d.rrect(-100, hy - 52, 200, 18, 9, '#6a3fa0');
  d.rrect(-60, hy - 110, 120, 62, 26, '#6a3fa0');
  d.line(40, hy - 100, 110, hy - 170, '#e53935', 12);
  ctx.restore();
  if (arrowAt) {
    const dv = DIRS[v.act];
    const ax = VX + arrowAt[0] + dv.x * 190, ay = -bob + arrowAt[1] + dv.y * (dv.y < 0 ? 110 : 170);
    const fill = v.word >= 0 ? '#ffd23f' : glove;
    const sc = 1 + 0.25 * pop;
    d.neon(() => drawArrow(d, ax, ay, v.act, sc, fill, '#111'), v.gold ? '#ffd23f' : v.red ? '#ff2b2b' : '#ffffff');
  }
  if (v.word >= 0) {
    const wx = VX + (v.act === 2 ? 330 : -330), wy = 330;
    d.rrect(wx - 200, wy - 50, 400, 100, 30, '#f6e6bd', '#5a3418', 5);
    d.text(NAMES[v.word], wx, wy + 3, { size: 62, color: '#b0122e' });
  }
}

// ---------- 3D helpers ----------

const YF = 815; // square level in 3D (podiums stand on it)

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

// A farmer's cart loaded with goods (wooden body, two spoked wheels).
function makeCart(K, k, dir) {
  const g = K.group();
  const wood = K.texMat('legno', [2, 1], { color: ['#b07a4a', '#9a6a3a', '#c08a5a'][k % 3] });
  const body = K.box(220, 50, 110, wood, { parent: g }); body.position.y = 70;
  for (const sz of [-1, 1]) { const side = K.box(220, 26, 8, wood, { parent: g }); side.position.set(0, 106, sz * 52); }
  const shaft = K.box(140, 8, 8, K.mat('#6a4a2a'), { parent: g }); shaft.position.set(170, 60, 0);
  const load = [['medieval/barrel', 70], ['medieval/sack', 0], ['medieval/crate_A_big', 66]][k % 3];
  for (const dx of [-55, 35]) {
    const m = load[0] === 'medieval/sack' ? K.model(load[0], { size: 80, parent: g }) : K.model(load[0], { height: load[1], parent: g });
    m.position.set(dx, 95, 0);
  }
  const rim = K.mat('#4a2e18', { rough: 0.7 });
  const wheels = [];
  for (const sz of [-1, 1]) {
    const w = K.group(g); w.position.set(-20, 42, sz * 62);
    K.torus(42, 6, rim, { parent: w });
    for (let s = 0; s < 3; s++) { const sp = K.box(80, 6, 6, rim, { parent: w, cast: false }); sp.rotation.z = (s * Math.PI) / 3; }
    wheels.push(w);
  }
  g.scale.x = dir;
  return { g, wheels, dir };
}

function makeArrow3d(K, s = 1) {
  const pts = [-115, -40, 5, -40, 5, -95, 115, 0, 5, 95, 5, 40, -115, 40];
  const g = K.group();
  g.scale.setScalar(s);
  const fill2 = K.mat('#ffffff', { rough: 0.4, unique: true });
  const glow = K.glow('#ffffff', { add: true, opacity: 0.45, unique: true });
  const a = K.prism(pts, 24, fill2, { parent: g }); a.position.z = -12;
  const ol = K.prism(pts, 14, K.mat('#111111'), { parent: g, cast: false }); ol.position.z = -18; ol.scale.set(1.12, 1.18, 1);
  const gl = K.prism(pts, 2, glow, { parent: g, cast: false }); gl.position.z = -24; gl.scale.set(1.35, 1.45, 1);
  return { g, fill: fill2, glow };
}

// The herald: heraldic hose (one leg purple, one gold), tabard, gauntlets, feathered hat, brass trumpet.
function makeHerald(K) {
  const T = K.THREE;
  const V = {};
  const top = FLOOR - 30;
  // Striped heraldic pedestal.
  const stripes = K.canvasTex(512, 64, (d) => { d.rect(0, 0, 512, 64, '#ffd23f'); for (let k = 0; k < 10; k++) d.rect(k * 51.2, 0, 25.6, 64, '#6a3fa0'); });
  const side = new T.MeshStandardMaterial({ map: stripes, roughness: 0.45 });
  const cap = K.texMat('lastre', [1, 1], { color: '#e8dccb' });
  const pod = K.mesh(new T.CylinderGeometry(120, 132, YF - top, 40), [side, cap, cap]);
  K.place(pod, VX, (YF + top) / 2, 0);
  K.place(K.mesh(new T.TorusGeometry(121, 7, 8, 48).rotateX(Math.PI / 2), K.mat('#c9a03a', { metal: 0.5, rough: 0.35 }), { cast: false }), VX, top, 0);
  V.root = K.group(); K.place(V.root, VX, top, 0);
  V.body = K.group(V.root);
  const purple = K.mat('#6a3fa0', { rough: 0.6 }), gold = K.mat('#ffd23f', { metal: 0.35, rough: 0.35 });
  const skin = K.mat('#f2c49b', { rough: 0.6 }), ink = K.mat('#222222', { rough: 0.5 }), brown = K.mat('#3a2010', { rough: 0.8 });
  const white = K.mat('#ffffff', { rough: 0.4 });
  const unit = new T.CylinderGeometry(1, 1, 1, 12);
  V.legs = [K.mesh(unit, purple, { parent: V.body }), K.mesh(unit, gold, { parent: V.body })];
  for (const s of [-1, 1]) {
    const b = K.box(52, 22, 44, K.mat('#4a2a12', { rough: 0.6 }), { parent: V.body }); b.position.set(s * 34, 11, 6);
    const tip = K.cone(12, 30, K.mat('#4a2a12', { rough: 0.6 }), { parent: V.body, cast: false }); tip.position.set(s * 34, 11, 40);
  }
  const torso = K.mesh(new T.CapsuleGeometry(68, 70, 6, 18), purple, { parent: V.body });
  torso.position.y = 235; torso.scale.z = 0.75;
  // Tabard with the herald's golden band + a lion-ish badge.
  const tab = K.box(56, 200, 10, gold, { parent: V.body }); tab.position.set(0, 230, 50);
  K.ball(20, K.mat('#b0122e', { rough: 0.5 }), { parent: V.body, cast: false, seg: 12 }).position.set(0, 270, 58);
  const belt = K.mesh(new T.CylinderGeometry(70, 70, 18, 24), K.mat('#4a2a12', { rough: 0.6 }), { parent: V.body }); belt.position.y = 171; belt.scale.z = 0.78;
  K.box(24, 20, 8, gold, { parent: V.body }).position.set(0, 171, 56);
  // Shoulder puffs.
  for (const s of [-1, 1]) { const p = K.ball(34, s < 0 ? gold : purple, { parent: V.body, seg: 14 }); p.position.set(s * 62, 300, 0); }
  // Head.
  V.head = K.group(V.body); V.head.position.y = 400;
  K.ball(70, skin, { parent: V.head, seg: 24 });
  for (const s of [-1, 1]) K.ball(16, skin, { parent: V.head, seg: 10 }).position.set(s * 68, 0, 0);
  V.pupils = [];
  V.brows = [];
  for (const s of [-1, 1]) {
    const e = K.ball(14, white, { parent: V.head, cast: false, seg: 12 }); e.position.set(s * 24, 12, 58); e.scale.z = 0.6;
    const p = K.ball(7, ink, { parent: V.head, cast: false, seg: 10 }); V.pupils.push(p);
    const b = K.box(30, 6, 6, brown, { parent: V.head, cast: false }); b.position.set(s * 25, 34, 64); b.rotation.z = -s * 0.32; V.brows.push(b);
  }
  K.ball(13, K.mat('#e8a882', { rough: 0.6 }), { parent: V.head, cast: false, seg: 12 }).position.set(0, -2, 68);
  for (const s of [-1, 1]) { const m = K.ball(1, brown, { parent: V.head, cast: false, seg: 10 }); m.position.set(s * 21, -22, 62); m.scale.set(26, 10, 12); m.rotation.z = s * 0.25; }
  // Brass trumpet at the mouth.
  const brass = K.mat('#e0b040', { metal: 0.6, rough: 0.25 });
  const tube = K.mesh(new T.CylinderGeometry(5, 5, 70, 10).rotateZ(Math.PI / 2), brass, { parent: V.head, cast: false }); tube.position.set(40, -36, 62);
  const bell = K.mesh(new T.ConeGeometry(18, 30, 14, 1, true).rotateZ(Math.PI / 2), brass, { parent: V.head, cast: false }); bell.position.set(86, -36, 62);
  // Floppy feathered hat.
  const hat = K.group(V.head); hat.position.y = 44;
  K.mesh(new T.CylinderGeometry(96, 100, 10, 32), purple, { parent: hat });
  const crown = K.mesh(new T.SphereGeometry(70, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), purple, { parent: hat }); crown.position.y = 4; crown.scale.set(1, 0.7, 1);
  K.mesh(new T.CylinderGeometry(72, 72, 14, 32), gold, { parent: hat }).position.y = 10;
  V.feather = K.ball(1, K.mat('#e53935', { rough: 0.6 }), { parent: hat, cast: false, seg: 12 });
  V.feather.position.set(-40, 70, -10); V.feather.scale.set(16, 70, 8); V.feather.rotation.z = 0.7;
  // Arms with gauntlets.
  V.arms = [0, 1].map((k) => {
    const gm = K.mat('#ffffff', { rough: 0.45, unique: true });
    const sleeve = k ? purple : gold;
    return { up: K.mesh(unit, sleeve, { parent: V.body }), fo: K.mesh(unit, sleeve, { parent: V.body }), glove: K.ball(28, gm, { parent: V.body, seg: 14 }), gm };
  });
  // Round ALT banner on a staff.
  V.pad = K.group(V.body);
  V.stick = K.mesh(unit, K.mat('#5a3418'), { parent: V.body });
  K.cyl(70, 10, K.mat('#e53935', { rough: 0.4 }), { parent: V.pad, center: true, seg: 32 });
  K.cyl(48, 12, white, { parent: V.pad, center: true, seg: 32 });
  K.torus(71, 4, gold, { parent: V.pad, cast: false });
  const txt = K.mesh(new T.PlaneGeometry(84, 42), new T.MeshBasicMaterial({
    transparent: true, map: K.canvasTex(256, 128, (d) => d.text('ALT', 128, 68, { size: 96, color: '#e53935', stroke: false })),
  }), { parent: V.pad, cast: false });
  txt.position.z = 7;
  // Big direction arrow.
  V.arrow = makeArrow3d(K, 1);
  return V;
}

function poseHerald(K, o, v, t) {
  const V = o.vig, mambo = o.mambo;
  const dance = mambo && (v.ph === 'input' || v.ph === 'gap' || v.ph === 'res') ? Math.sin(t * 9) : 0;
  const pop = v.act >= 0 ? Math.max(0, 1 - v.pt / 0.12) : 0;
  const bob = Math.sin(t * 3) * 4 + Math.abs(dance) * 10 + pop * 14;
  V.body.position.y = bob;
  V.body.rotation.z = -dance * 0.08;
  segW(V.legs[0], -30, 0, -26 + dance * 20, 150, 0, 16);
  segW(V.legs[1], 30, 0, 26 - dance * 20, 150, 0, 16);
  V.feather.rotation.z = 0.7 + Math.sin(t * 4) * 0.12 + dance * 0.3;
  const glove = v.gold ? '#ffd23f' : v.red ? '#ff2b2b' : '#ffffff';
  const SH = [[-62, 305], [62, 305]];
  const arm = (k, ex, ey, hx, hy, col) => {
    const A = V.arms[k];
    segW(A.up, SH[k][0], SH[k][1], ex, ey, 30, 15);
    segW(A.fo, ex, ey, hx, hy, 30, 15);
    A.glove.position.set(hx, hy, 32);
    A.gm.color.set(col);
    A.gm.emissive.set(col === '#ffffff' ? '#000000' : col);
    A.gm.emissiveIntensity = col === '#ffffff' ? 0 : 0.35;
  };
  let used = -1, hand = null;
  V.pad.visible = V.stick.visible = false;
  if (v.act >= 0 && v.act < 4) {
    const dv = DIRS[v.act];
    used = dv.x < 0 ? 0 : 1;
    const sh = SH[used];
    hand = dv.y > 0 ? [sh[0] + 40, sh[1] - 170] : [sh[0] + dv.x * 165, sh[1] - dv.y * 165];
    arm(used, (sh[0] + hand[0]) / 2, (sh[1] + hand[1]) / 2, hand[0], hand[1], glove);
  } else if (v.act === ALT) {
    used = 1;
    const h = [102, 455];
    arm(1, 82, 380, h[0], h[1], glove);
    V.pad.visible = V.stick.visible = true;
    segW(V.stick, h[0], h[1], h[0] + 10, h[1] + 90, 30, 6);
    const s2 = 1 + pop * 0.3;
    V.pad.position.set(h[0] + 12, h[1] + 150, 34);
    V.pad.scale.setScalar(s2);
  } else if (v.act === SAL) {
    used = 1;
    arm(1, 122, 340, 34, 450, glove);
  }
  for (let k = 0; k < 2; k++) {
    if (k === used) continue;
    const s = k === 0 ? -1 : 1, sh = SH[k];
    const hx = dance ? sh[0] + s * 70 : sh[0] + s * 30, hy = dance ? sh[1] + 60 - dance * s * 50 : sh[1] - 120;
    arm(k, (sh[0] + hx) / 2 + s * 8, (sh[1] + hy) / 2, hx, hy, mambo ? '#ffffff' : glove);
  }
  const look = v.act >= 0 && v.act < 4 ? DIRS[v.act] : { x: 0, y: 0 };
  V.pupils.forEach((p, k) => p.position.set((k ? 24 : -24) + look.x * 6, 12 - look.y * 6, 66));
  V.brows.forEach((b) => { b.visible = !!v.red; });
  const A = V.arrow;
  A.g.visible = !!hand;
  if (hand) {
    const dv = DIRS[v.act];
    const ax = VX + hand[0] + dv.x * 190, ay = FLOOR - 30 - hand[1] - bob + dv.y * (dv.y < 0 ? 110 : 170);
    K.place(A.g, ax, ay, 70);
    K.face(A.g, Math.atan2(dv.y, dv.x));
    A.g.scale.setScalar(1 + 0.25 * pop);
    A.fill.color.set(v.word >= 0 ? '#ffd23f' : glove);
    A.glow.color.set(v.gold ? '#ffd23f' : v.red ? '#ff2b2b' : '#ffffff');
  }
  o.aura.visible = !!v.gold;
  if (v.gold) { K.place(o.aura, VX, FLOOR - 300, -90); o.aura.scale.setScalar(260 + Math.sin(t * 8) * 12); }
  o.card.visible = v.word >= 0;
  if (v.word >= 0) {
    if (v.word !== o.lastWord) { o.lastWord = v.word; o.card.redraw(v.word); }
    K.place(o.card, VX + (v.act === 2 ? 330 : -330), 330, 90);
  }
}

function uiKeyV(v, K) {
  const blink = (w) => (Math.sin(K.t * w) > 0 ? 1 : 2);
  const whistle = v.wh && v.pt < 0.45 && (v.ph === 'cmd' || v.ph === 'show');
  return [
    v.ph, v.wn, v.tgt, v.act, v.red, v.word, v.k < 6 ? 1 : 0,
    v.gold && (v.ph === 'cmd' || v.ph === 'res') ? blink(10) : 0, v.sd ? blink(8) : 0,
    v.len ?? '', v.idx ?? '', v.seq ? v.seq.join('') : '',
    whistle ? Math.floor(v.pt * 12) : -1,
    v.fb.map((f) => (f.t < 0.7 ? `${f.d}${f.ok}` : '-')).join(','),
  ].join('|');
}

function drawUi3dV(d, v, r) {
  const mambo = r.variant === 'mambo';
  const n = v.fb.length, px = pxOf(n), py = pyOf(n), R = radOf(n);
  // Trumpet blast.
  if (v.wh && v.pt < 0.45 && (v.ph === 'cmd' || v.ph === 'show')) {
    const wx = VX + 110, wy = 396;
    for (let k = 0; k < 3; k++) d.line(wx + 10, wy - 20 + k * 20, wx + 50 + v.pt * 80, wy - 40 + k * 40, '#fff', 6);
    d.text('TU-TUU!', wx + 160, wy - 70, { size: 54, color: '#ffe14d' });
  }
  // "Opposite!" label next to the big arrow.
  if (v.red && v.word < 0 && v.act >= 0 && v.act < 4) {
    const dv = DIRS[v.act];
    const sh = dv.x < 0 ? [-62, 455] : [62, 455];
    const hand = dv.y > 0 ? [sh[0] + 40, sh[1] + 170] : [sh[0] + dv.x * 165, sh[1] + dv.y * 165];
    const ax = VX + hand[0] + dv.x * 190, ay = hand[1] + dv.y * (dv.y < 0 ? 110 : 170);
    d.text('AL CONTRARIO!', ax + (dv.y < 0 ? 290 : 0), ay + (dv.y > 0 ? 130 : dv.y < 0 ? 40 : -120), { size: 40, color: '#ff2b2b' });
  }
  // Player feedback: ✓/✗ and the pressed key.
  v.fb.forEach((f, i) => {
    if (!(f.t < 0.7 && f.d >= 0)) return;
    const x = px[i], col = f.ok ? '#3dff7a' : '#ff4d4d';
    if (f.d >= 4) drawKey(d, x, py - R - 100, f.d === ALT ? 'A' : 'B', col);
    d.text(f.ok ? '✓' : '✗', x + R, py - R - 150, { size: 64, color: col });
  });
  if (v.gold && (v.ph === 'cmd' || v.ph === 'res')) d.text("GUANTO D'ORO · VALE 2!", VX, 150, { size: 46, color: Math.sin(d.t * 10) > 0 ? '#ffd23f' : '#fff3b0' });
  if (v.ph === 'res' && !mambo) {
    const nm = r.names || ['G1', 'G2', 'G3', 'G4'];
    let txt = '', col = '#fff';
    if (v.wn >= 0) { txt = `${nm[v.wn]} PRIMO!`; col = d.col(v.wn, 'light'); }
    else if (v.tgt < 0) { txt = 'Nessuno squillo: bravi!'; col = '#bfffcf'; }
    else { txt = `Era: ${NAMES[v.tgt]}`; col = '#ffd0d0'; }
    d.rrect(VX - 330, 468, 660, 74, 37, '#000000cc', col, 4);
    d.text(txt, VX, 506, { size: 46, color: col });
  }
  if (v.sd) d.text('☠ MORTE IMPROVVISA ☠', VX, 862, { size: 44, color: Math.sin(d.t * 8) > 0 ? '#ff4040' : '#ffffff' });
  else if (!mambo && v.k < 6) drawLegend(d, r.variant);
  if (mambo) {
    const len = v.len || 0;
    for (let k = 0; k < len; k++) {
      const x = VX + (k - (len - 1) / 2) * 70;
      d.circle(x, 150, 22, k === v.idx ? '#ffd23f' : k < v.idx || v.ph !== 'show' ? '#ffffffaa' : '#ffffff44', '#00000088', 3);
      if (v.seq && v.ph === 'res') d.text(v.seq[k] < 4 ? ['↑', '↓', '←', '→'][v.seq[k]] : v.seq[k] === ALT ? 'A' : 'B', x, 152, { size: 30, color: '#111', stroke: false });
    }
    if (v.ph === 'input') d.text('RIPETI LA DANZA!', VX, 215, { size: 52, color: '#fff' });
    if (v.ph === 'show' || v.ph === 'gap') d.text('GUARDA BENE…', VX, 215, { size: 52, color: '#fff' });
    if (v.ph === 'res') {
      const nm = r.names || ['G1', 'G2', 'G3', 'G4'];
      d.text(v.wn >= 0 ? `${nm[v.wn]} RE DEL SALTARELLO!` : "Nessuno ce l'ha fatta", VX, 215, { size: 50, color: v.wn >= 0 ? d.col(v.wn, 'light') : '#ffd0d0' });
    }
  }
}
