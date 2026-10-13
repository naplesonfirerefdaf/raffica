// Ruba lo Stendardo — capture the flag on a misty battlefield at dawn (top-down).
// Teams 2 vs 2: two camps (bottom / top). Free-for-all 2–4: every knight has a camp with its own standard.
// Grab an enemy standard and carry it into your camp. A = tackle (whoever is hit drops what they carry),
// B = sprint, or throw the standard while carrying it (pass it to a teammate!).
import { clamp, damp, dist, norm, r1, r2, TAU } from '../core/geom.js';

const W = 1000, H = 1000, CX = 500, CY = 500;
const BASE_D = 375, BASE_R = 84;
const P_R = 32;
const SPEED = 330, ACC = 11, CARRY_K = 0.8, MUD_K = 0.5, FINAL_K = 1.12;
const LUNGE_V = 860, LUNGE_T = 0.19, LUNGE_CD = 1.0;
const STUN_T = 0.95, INV_T = 0.6;
const SPRINT_T = 0.9, SPRINT_K = 1.55, SPRINT_CD = 3.2;
const THROW_D = 320, THROW_T = 0.6, NOGRAB_T = 0.5, DROP_D = 110, DROP_T = 0.35;
const GRAB_R = 30, RETURN_T = 7;
const CAP_WIN = 3, FINAL_T = 45;
const RUIN_R = 46, RUIN_D = 250;
const PIG_R = 26, PIG_V = 170, PIG_FLEE = 170;
const F0 = 34, F1 = 966; // field bounds (inside the palisade)
const TEAM_COL = ['#ff4b5c', '#3fa9ff'];
const GOLD = '#ffd23f';

// Static layout from the number of camps (2: bottom/top · 3: triangle · 4: four sides). Shared by sim and render.
function layout(nb, variant) {
  const ang = nb === 3 ? [Math.PI / 2, -Math.PI / 6, (7 * Math.PI) / 6] : nb === 4 ? [Math.PI / 2, -Math.PI / 2, Math.PI, 0] : [Math.PI / 2, -Math.PI / 2];
  const bases = ang.map((a) => ({ x: CX + Math.cos(a) * BASE_D, y: CY + Math.sin(a) * BASE_D, a }));
  const ra = nb === 3 ? [Math.PI / 6, (5 * Math.PI) / 6, -Math.PI / 2] : [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
  const ruins = ra.map((a) => ({ x: CX + Math.cos(a) * RUIN_D, y: CY + Math.sin(a) * RUIN_D, r: RUIN_R }));
  const mud = variant === 'fango'
    ? [{ x: CX, y: CY, r: 135 }, ...ang.map((a) => ({ x: CX + Math.cos(a) * 205, y: CY + Math.sin(a) * 205, r: 70 }))]
    : [];
  return { bases, ruins, mud };
}

const inMud = (s, x, y) => s.mud.some((m) => dist(x, y, m.x, m.y) < m.r);
const seatOf = (s, o) => (s.p.find((p) => p.o === o) || s.p[0]).i;

// Keep a point inside the field and outside the ruined columns.
function confine(s, o, r) {
  o.x = clamp(o.x, F0 + r, F1 - r);
  o.y = clamp(o.y, F0 + r, F1 - r);
  for (const R of s.ruins) {
    const dx = o.x - R.x, dy = o.y - R.y, d = Math.hypot(dx, dy), min = R.r + r;
    if (d < min) {
      const n = d > 1e-6 ? { x: dx / d, y: dy / d } : { x: 1, y: 0 };
      o.x = R.x + n.x * min; o.y = R.y + n.y * min;
      if (o.vx !== undefined) {
        const vn = o.vx * n.x + o.vy * n.y;
        if (vn < 0) { o.vx -= vn * n.x * 1.3; o.vy -= vn * n.y * 1.3; }
      }
    }
  }
}

function homeOf(s, f) {
  return f.o < 0 ? { x: CX, y: CY } : s.bases[f.o];
}

function sendHome(s, f) {
  const h = homeOf(s, f);
  f.st = 0; f.x = h.x; f.y = h.y; f.h = 0; f.by = -1; f.gt = 0; f.nogT = 0;
}

// The standard leaves a knight: a short hop (dropped) or a long arc (thrown).
function launchFlag(s, p, dir, d, T, hm, nog) {
  const f = s.f[p.c];
  p.c = -1;
  const t = { x: p.x + dir.x * d, y: p.y + dir.y * d };
  t.x = clamp(t.x, F0 + 20, F1 - 20); t.y = clamp(t.y, F0 + 20, F1 - 20);
  confine(s, t, 22);
  Object.assign(f, { st: 3, by: -1, x0: p.x, y0: p.y, x1: t.x, y1: t.y, x: p.x, y: p.y, u: 0, T, hm, h: 30, nog: p.i, nogT: nog });
}

function knock(s, q, dir, stun, speed, g) {
  q.stun = stun; q.dash = 0; q.spr = 0;
  q.vx = dir.x * speed; q.vy = dir.y * speed;
  q.hitK++;
  if (q.c >= 0) {
    launchFlag(s, q, dir, DROP_D, DROP_T, 70, 0.6);
    g.text(q.x, q.y - 70, 'STENDARDO A TERRA!', { color: '#fff3c4', size: 46 });
    g.sfx('pop', { pitch: 0.8 });
  }
  g.vibrate(q.i, 120);
}

// ---------------------------------------------------------------- bot
const LAG = [0.34, 0.2, 0.09];

// Direction toward (gx, gy) going around the ruined columns (and the mud, for smarter bots).
function steer(s, p, gx, gy, lv, extra) {
  const obs = s.ruins.map((R) => ({ x: R.x, y: R.y, r: R.r + p.r + 14 }));
  if (lv > 0) for (const m of s.mud) if (dist(gx, gy, m.x, m.y) > m.r) obs.push({ x: m.x, y: m.y, r: m.r + 6 });
  if (extra) obs.push(...extra);
  let tx = gx, ty = gy;
  const dx = gx - p.x, dy = gy - p.y, L = Math.hypot(dx, dy) || 1;
  let bestT = 2;
  for (const O of obs) {
    if (dist(p.x, p.y, O.x, O.y) < O.r - 2) continue; // already inside (mud): just go on
    const t = ((O.x - p.x) * dx + (O.y - p.y) * dy) / (L * L);
    if (t <= 0 || t >= 1 || t >= bestT) continue;
    const cx = p.x + dx * t, cy = p.y + dy * t;
    const dd = dist(cx, cy, O.x, O.y);
    if (dd >= O.r) continue;
    // Go around on the side where the path passes.
    let nx = cx - O.x, ny = cy - O.y;
    const nl = Math.hypot(nx, ny);
    if (nl < 1e-3) { nx = -dy / L; ny = dx / L; } else { nx /= nl; ny /= nl; }
    tx = O.x + nx * (O.r + 22); ty = O.y + ny * (O.r + 22);
    bestT = t;
  }
  const n = norm(tx - p.x, ty - p.y);
  return n;
}

function stBot(s, me, g, B) {
  const p = s.p[me];
  if (!p || p.stun > 0) return { x: 0, y: 0 };
  const lv = B.level, m = B.mem;
  const lag = LAG[lv];
  const px = p.x + p.vx * lag * 0.5, py = p.y + p.vy * lag * 0.5;
  const home = s.bases[p.o];
  const foes = s.p.filter((q) => q.o !== p.o);
  const mates = s.p.filter((q) => q !== p && q.o === p.o);
  const out = { x: 0, y: 0 };
  let gx = CX, gy = CY, chase = null, sprint = false;
  const reach = [130, 175, 205][lv];

  // --- tackle whoever is worth it and in reach (aim at where they will be) ---
  if (p.cd <= 0 && p.dash <= 0) {
    let best = null, bs = -1;
    for (const q of foes) {
      if (q.stun > 0 || q.inv > 0) continue;
      const lead = lag + 0.1;
      const qx = q.x + q.vx * lead, qy = q.y + q.vy * lead;
      const d = dist(px, py, qx, qy);
      if (d > reach + q.r) continue;
      let w = 0;
      if (q.c >= 0) w = 3; // a carrier: always
      const mine = s.f.find((f) => f.o === p.o);
      if (mine && dist(q.x, q.y, mine.x, mine.y) < 160) w = Math.max(w, 2); // about to grab my standard
      if (p.c >= 0) {
        // Carrying: only knock down someone standing in my way home.
        const toH = norm(home.x - p.x, home.y - p.y), toQ = norm(qx - p.x, qy - p.y);
        w = toH.x * toQ.x + toH.y * toQ.y > 0.35 ? 2 : 0;
      } else if (lv > 0 && w === 0 && d < reach * 0.8) w = 1; // in the way: bump it anyway
      if (lv === 0 && w < 2 && d > reach * 0.7) w = 0;
      if (w > bs) { bs = w; best = { qx, qy }; }
    }
    if (best && bs > 0) {
      const n = norm(best.qx - px, best.qy - py);
      return { x: n.x, y: n.y, tapA: true };
    }
  }

  if (p.c >= 0) {
    // --- carrying: run home, around danger ---
    gx = home.x; gy = home.y;
    const extra = [];
    if (lv > 0) for (const q of foes) if (q.stun <= 0 && dist(q.x, q.y, p.x, p.y) < 260) extra.push({ x: q.x + q.vx * 0.2, y: q.y + q.vy * 0.2, r: [0, 90, 120][lv] });
    if (lv > 0 && s.pigs.length) for (const pg of s.pigs) extra.push({ x: pg.x, y: pg.y, r: PIG_R + p.r + 30 });
    // Hard bot: pass the standard to a free teammate closer to home when a rival is on me.
    if (lv === 2 && mates.length) {
      const threat = foes.some((q) => q.stun <= 0 && q.cd <= 0.2 && dist(q.x, q.y, p.x, p.y) < 150);
      const dh = dist(p.x, p.y, home.x, home.y);
      for (const q of mates) {
        const dq = dist(p.x, p.y, q.x, q.y);
        if (threat && q.stun <= 0 && q.c < 0 && dq > 200 && dq < 360 && dist(q.x, q.y, home.x, home.y) < dh - 80) {
          const n = norm(q.x + q.vx * 0.4 - p.x, q.y + q.vy * 0.4 - p.y);
          return { x: n.x, y: n.y, tapB: true };
        }
      }
    }
    const n = steer(s, p, gx, gy, lv, extra);
    out.x = n.x; out.y = n.y;
    return out;
  }

  // --- not carrying ---
  const mine = s.f.find((f) => f.o === p.o);
  // 1) A rival carries my standard (or the golden one): chase the thief.
  let thief = null, td = 1e9;
  for (const q of foes) {
    if (q.c < 0) continue;
    const f = s.f[q.c];
    const prio = f.o === p.o || f.o < 0 ? 0 : 250; // my standard first, then any carrier (steal it back on the drop)
    const d = dist(p.x, p.y, q.x, q.y) + prio - (1 - dist(q.x, q.y, s.bases[q.o].x, s.bases[q.o].y) / 800) * 200;
    if (d < td) { td = d; thief = q; }
  }
  // My standard lies on the ground: the closest of my team brings it back.
  if (mine && (mine.st === 2 || mine.st === 3)) {
    const tx = mine.st === 3 ? mine.x1 : mine.x, ty = mine.st === 3 ? mine.y1 : mine.y;
    const md = dist(p.x, p.y, tx, ty);
    if (!mates.some((q) => q.stun <= 0 && dist(q.x, q.y, tx, ty) < md - 30)) {
      const n = steer(s, p, tx, ty, lv);
      return { x: n.x, y: n.y, tapB: lv > 0 && p.scd <= 0 && md > 260 };
    }
  }
  const mateCarry = mates.find((q) => q.c >= 0);
  if (thief && (s.f[thief.c].o === p.o || s.f[thief.c].o < 0 || !mateCarry)) {
    chase = thief;
  } else if (mateCarry) {
    // 2) Escort: knock down the rival closest to my carrying teammate.
    let best = null, bd = 380;
    for (const q of foes) {
      if (q.stun > 0) continue;
      const d = dist(q.x, q.y, mateCarry.x, mateCarry.y);
      if (d < bd) { bd = d; best = q; }
    }
    if (best) chase = best;
    else { gx = (mateCarry.x + s.bases[p.o].x) / 2; gy = (mateCarry.y + s.bases[p.o].y) / 2; }
  }
  if (chase) {
    const d = dist(p.x, p.y, chase.x, chase.y);
    const lead = lv === 0 ? 0.1 : Math.min(0.6, d / 500);
    gx = chase.x + chase.vx * lead; gy = chase.y + chase.vy * lead;
    sprint = lv > 0 && d > 170;
  } else if (!mateCarry) {
    // 3) Defense (smarter bots): a rival close to my standard while I am the closest of my team.
    let def = null;
    if (lv > 0 && mine && mine.st === 0) {
      for (const q of foes) {
        if (q.stun > 0 || q.c >= 0) continue;
        const dq = dist(q.x, q.y, mine.x, mine.y);
        const dm = dist(p.x, p.y, mine.x, mine.y);
        const guard = mates.every((k) => dist(k.x, k.y, mine.x, mine.y) > dm);
        if (dq < (lv === 2 ? 300 : 200) && dm < dq + 220 && guard && (mates.length || dq < dm + 60)) { def = q; break; }
      }
    }
    if (def) {
      gx = def.x + (mine.x - def.x) * 0.35 + def.vx * 0.25; gy = def.y + (mine.y - def.y) * 0.35 + def.vy * 0.25;
    } else {
      // 4) Steal: the best standard that is not mine and not carried.
      let tf = null, bc = 1e9;
      // Personal preference per standard: breaks ties, so the bots do not all gang up on the same camp.
      const pref = m.pref || (m.pref = s.f.map(() => B.rng() * 120));
      s.f.forEach((f, k) => {
        if (f.o === p.o || f.st === 1) return;
        const fx = f.st === 3 ? f.x1 : f.x, fy = f.st === 3 ? f.y1 : f.y;
        let c = dist(p.x, p.y, fx, fy);
        if (lv > 0) {
          for (const q of foes) if (q.stun <= 0 && dist(q.x, q.y, fx, fy) < 160) c += lv === 2 ? 160 : 90;
          c += dist(fx, fy, home.x, home.y) * (lv === 2 ? 0.45 : 0.2);
        }
        c += pref[k];
        if (m.tf === k) c -= 120; // keep the plan
        if (c < bc) { bc = c; tf = k; }
      });
      if (tf !== null) {
        m.tf = tf;
        const f = s.f[tf];
        gx = f.st === 3 ? f.x1 : f.x; gy = f.st === 3 ? f.y1 : f.y;
        sprint = lv > 0 && dist(p.x, p.y, gx, gy) > 300;
      }
    }
  }
  const extra = lv > 0 && s.pigs.length ? s.pigs.map((pg) => ({ x: pg.x, y: pg.y, r: PIG_R + p.r + 20 })) : null;
  const n = steer(s, p, gx, gy, lv, extra);
  out.x = n.x; out.y = n.y;
  if (sprint && p.scd <= 0 && p.spr <= 0) out.tapB = true;
  // Close enough to a still goal: slow down instead of orbiting it.
  if (!chase && dist(p.x, p.y, gx, gy) < 12) { out.x = 0; out.y = 0; }
  return out;
}

export default {
  id: 'stendardo',
  name: 'Ruba lo Stendardo',
  rule: 'Ruba lo stendardo nemico e portalo al tuo accampamento!',
  verb: 'RUBA!',
  inspired: 'Ruba bandiera · Capture the Flag',
  cam: 'top',
  split: false,
  players: 4,
  teams: true,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Placcaggio', b: 'Scatto/Lancio' },
  duration: 60,
  supports: ['scale'],
  variants: [
    { id: 'dorato', name: "Lo Stendardo d'Oro", desc: "Un solo stendardo d'oro in mezzo al campo: tutti contro tutti per portarlo a casa!" },
    { id: 'maiali', name: 'Maiali allo Sbaraglio', desc: 'Tre maiali scappati dal porcile corrono ovunque: chi li tocca finisce a gambe all\'aria!' },
    { id: 'fango', name: 'Campo Allagato', desc: 'Ha piovuto tutta notte: pozze di fango dove si cammina a fatica!' },
  ],
  help: {
    goal: "Ruba lo stendardo dell'altro accampamento e portalo nel tuo cerchio: 3 stendardi e hai vinto (o chi ne ha di più allo scadere). A squadre si vince insieme!",
    dir: 'Corri per il campo di battaglia (con lo stendardo in spalla vai un po\' più piano)',
    a: 'PLACCAGGIO: tuffo in avanti! Chi viene colpito cade e lascia lo stendardo che porta (si ricarica in 1 s)',
    b: 'SCATTO: corsa velocissima per un attimo. Se porti lo stendardo invece lo LANCI avanti: passalo al compagno!',
    tips: ['Tocca il tuo stendardo caduto per riportarlo subito a casa', 'Uno stendardo a terra torna da solo a casa dopo 7 s', 'Negli ultimi 15 s: ASSALTO FINALE, tutti più veloci!'],
  },

  init(g) {
    const n = g.n || 2;
    const teams = !!g.teams;
    const own = [...Array(n).keys()].map((i) => (teams ? g.teams[i] : i));
    const nb = teams ? 2 : n;
    const L = layout(nb, g.variant);
    const sc = g.mods.scale || [];
    const s = {
      t: 0, n, nb, teams, own, score: Array(nb).fill(0), grabs: Array(nb).fill(0), tackles: Array(nb).fill(0),
      bases: L.bases, ruins: L.ruins, mud: L.mud, final: false, gold: g.variant === 'dorato', f: [], p: [], pigs: [], last: -1,
    };
    const mk = (o) => {
      const f = { o, st: 0, x: 0, y: 0, h: 0, by: -1, gt: 0, nog: -1, nogT: 0, x0: 0, y0: 0, x1: 0, y1: 0, u: 0, T: 1, hm: 0 };
      sendHome(s, f);
      return f;
    };
    if (s.gold) s.f.push(mk(-1));
    else for (let o = 0; o < nb; o++) s.f.push(mk(o));
    const mates = Array(nb).fill(0);
    for (let i = 0; i < n; i++) {
      const o = own[i], b = L.bases[o];
      const k = mates[o]++;
      const ix = (CX - b.x) / BASE_D, iy = (CY - b.y) / BASE_D; // inward unit vector
      const off = teams ? (k === 0 ? -105 : 105) : 0;
      s.p.push({
        i, o, x: b.x + ix * 70 - iy * off, y: b.y + iy * 70 + ix * off, vx: 0, vy: 0, fx: ix, fy: iy, r: P_R * (sc[i] ?? 1),
        dash: 0, dn: 0, cd: 0, stun: 0, inv: 0, spr: 0, scd: 0, c: -1, tn: 0, hitK: 0, caps: 0,
      });
    }
    if (g.variant === 'maiali') {
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * TAU + g.rng.range(-0.3, 0.3);
        s.pigs.push({ x: CX + Math.cos(a) * 80, y: CY + Math.sin(a) * 80, vx: 0, vy: 0, dx: Math.cos(a), dy: Math.sin(a), tt: g.rng.range(0.5, 1.5), oink: 0 });
      }
    }
    return s;
  },

  step(s, inp, g) {
    const dt = g.dt;
    s.t = g.t;
    if (!s.final && g.t >= FINAL_T) {
      s.final = true;
      g.say('ASSALTO FINALE!'); g.sfx('horn'); g.shake(0.25);
    }

    // --- knights ---
    for (const p of s.p) {
      const I = inp[p.i];
      p.cd = Math.max(0, p.cd - dt);
      p.scd = Math.max(0, p.scd - dt);
      p.spr = Math.max(0, p.spr - dt);
      p.inv = Math.max(0, p.inv - dt);
      if (p.stun > 0) {
        p.stun -= dt;
        if (p.stun <= 0) { p.stun = 0; p.inv = INV_T; }
        const k = damp(0.03, dt);
        p.vx *= k; p.vy *= k;
      } else {
        const mag = Math.hypot(I.x, I.y);
        if (mag > 0.2) { p.fx = I.x / mag; p.fy = I.y / mag; }
        if (p.dash > 0) p.dash -= dt;
        else {
          if (I.aP && p.cd <= 0) {
            p.vx = p.fx * LUNGE_V; p.vy = p.fy * LUNGE_V;
            p.dash = LUNGE_T; p.cd = LUNGE_CD; p.dn++; p.spr = 0;
            g.sfx('dash'); g.burst(p.x, p.y, { player: p.i, n: 8, speed: 180 });
          } else if (I.bP) {
            if (p.c >= 0) {
              p.tn++;
              launchFlag(s, p, { x: p.fx, y: p.fy }, THROW_D, THROW_T, 150, NOGRAB_T);
              g.sfx('whoosh'); g.text(p.x, p.y - 70, 'LANCIO!', { player: p.i, size: 40 });
            } else if (p.scd <= 0) {
              p.spr = SPRINT_T; p.scd = SPRINT_CD;
              g.sfx('jump', { pitch: 1.3, vol: 0.6 }); g.burst(p.x, p.y, { color: '#d9c6a0', n: 10, speed: 160 });
            }
          }
          if (p.dash <= 0) {
            const k = (p.c >= 0 ? CARRY_K : 1) * (p.spr > 0 && p.c < 0 ? SPRINT_K : 1) * (inMud(s, p.x, p.y) ? MUD_K : 1) * (s.final ? FINAL_K : 1);
            const sm = Math.max(1, mag);
            const tvx = (mag > 0.08 ? I.x / sm : 0) * SPEED * k, tvy = (mag > 0.08 ? I.y / sm : 0) * SPEED * k;
            const a = Math.min(1, ACC * dt);
            p.vx += (tvx - p.vx) * a; p.vy += (tvy - p.vy) * a;
          }
        }
      }
      p.x += p.vx * dt; p.y += p.vy * dt;
      confine(s, p, p.r);
    }

    // --- tackles (before pushing knights apart) ---
    for (const p of s.p) {
      if (p.dash <= 0 || p.stun > 0) continue;
      for (const q of s.p) {
        if (q === p || q.o === p.o || q.stun > 0 || q.inv > 0) continue;
        if (dist(p.x, p.y, q.x, q.y) > p.r + q.r + 8) continue;
        const dir = norm(q.x - p.x || p.fx, q.y - p.y || p.fy);
        if (q.dash > 0 && p.fx * q.fx + p.fy * q.fy < -0.3) {
          // Head-on: both bounce, nobody falls.
          for (const [a, b] of [[p, q], [q, p]]) {
            const n = norm(a.x - b.x, a.y - b.y);
            a.vx = n.x * 520; a.vy = n.y * 520; a.dash = 0; a.stun = 0.25;
          }
          g.sfx('bonk'); g.sfx('bang', { vol: 0.5 });
          g.text((p.x + q.x) / 2, (p.y + q.y) / 2 - 60, 'SCONTRO!', { color: '#ffffff', size: 44 });
          g.burst((p.x + q.x) / 2, (p.y + q.y) / 2, { color: '#ffffff', n: 16, speed: 360 });
          g.shake(0.3); g.hitstop(0.06);
          break;
        }
        const carried = q.c >= 0;
        knock(s, q, dir, STUN_T, 620, g);
        p.dash = 0; p.vx *= 0.25; p.vy *= 0.25;
        s.tackles[p.o]++;
        g.sfx('punch'); g.sfx('hit', { pitch: 0.8, vol: 0.6 });
        g.burst(q.x, q.y, { player: p.i, n: carried ? 26 : 14, speed: carried ? 420 : 300 });
        if (!carried) g.text(q.x, q.y - 66, 'PLACCATO!', { player: p.i, size: 40 });
        g.shake(carried ? 0.45 : 0.3); g.hitstop(carried ? 0.1 : 0.06); g.vibrate(p.i, 50);
        break;
      }
    }
    // Knights push each other apart.
    for (let a = 0; a < s.p.length; a++) {
      for (let b = a + 1; b < s.p.length; b++) {
        const A = s.p[a], Bq = s.p[b];
        const dx = Bq.x - A.x, dy = Bq.y - A.y, d = Math.hypot(dx, dy), min = A.r + Bq.r;
        if (d >= min || d < 1e-6) continue;
        const push = (min - d) / 2, nx = dx / d, ny = dy / d;
        A.x -= nx * push; A.y -= ny * push; Bq.x += nx * push; Bq.y += ny * push;
        confine(s, A, A.r); confine(s, Bq, Bq.r);
      }
    }

    // --- pigs on the loose ---
    for (const pg of s.pigs) {
      pg.tt -= dt; pg.oink = Math.max(0, pg.oink - dt);
      let fx = 0, fy = 0;
      for (const p of s.p) {
        const d = dist(pg.x, pg.y, p.x, p.y);
        if (d < PIG_FLEE && d > 1e-3) { const k = (PIG_FLEE - d) / PIG_FLEE; fx += ((pg.x - p.x) / d) * k; fy += ((pg.y - p.y) / d) * k; }
      }
      if (pg.tt <= 0) {
        pg.tt = g.rng.range(0.9, 2.2);
        const a = g.rng.range(0, TAU);
        pg.dx = Math.cos(a); pg.dy = Math.sin(a);
      }
      let tvx = pg.dx * PIG_V, tvy = pg.dy * PIG_V;
      if (fx || fy) { const n = norm(fx, fy); tvx = n.x * 270; tvy = n.y * 270; }
      const a = Math.min(1, 4 * dt);
      pg.vx += (tvx - pg.vx) * a; pg.vy += (tvy - pg.vy) * a;
      pg.x += pg.vx * dt; pg.y += pg.vy * dt;
      if (pg.x < F0 + PIG_R || pg.x > F1 - PIG_R) { pg.dx = -pg.dx; pg.vx = -pg.vx; }
      if (pg.y < F0 + PIG_R || pg.y > F1 - PIG_R) { pg.dy = -pg.dy; pg.vy = -pg.vy; }
      confine(s, pg, PIG_R);
      for (const p of s.p) {
        if (p.stun > 0 || p.inv > 0) continue;
        const d = dist(pg.x, pg.y, p.x, p.y);
        if (d > PIG_R + p.r) continue;
        const n = norm(p.x - pg.x || 1, p.y - pg.y);
        knock(s, p, n, 0.6, 430, g);
        pg.vx = -n.x * 300; pg.vy = -n.y * 300; pg.dx = -n.x; pg.dy = -n.y; pg.tt = 1;
        g.sfx('quack', { pitch: 0.6 }); g.sfx('boing', { pitch: 1.2, vol: 0.6 });
        g.text(pg.x, pg.y - 50, 'OINK!', { color: '#ffb3c8', size: 46 });
        g.burst(p.x, p.y, { color: '#ffb3c8', n: 12, speed: 260 });
        g.shake(0.25);
        pg.oink = 0.5;
      }
    }

    // --- standards ---
    for (const f of s.f) {
      if (f.nogT > 0) f.nogT -= dt;
      if (f.st === 1) {
        const c = s.p[f.by];
        f.x = c.x; f.y = c.y; f.h = 0;
      } else if (f.st === 3) {
        f.u += dt / f.T;
        const u = Math.min(1, f.u);
        f.x = f.x0 + (f.x1 - f.x0) * u; f.y = f.y0 + (f.y1 - f.y0) * u;
        f.h = 30 + 4 * f.hm * u * (1 - u);
        if (f.u >= 1) { f.st = 2; f.h = 0; f.gt = RETURN_T; g.sfx('land', { vol: 0.6 }); g.burst(f.x, f.y, { color: '#c9b48a', n: 8, speed: 120 }); }
      } else if (f.st === 4) {
        // The golden standard comes back to the middle after a capture.
        f.gt -= dt;
        if (f.gt <= 0) {
          sendHome(s, f);
          g.sfx('powerup'); g.ring(CX, CY, { color: GOLD, r: 140 }); g.burst(CX, CY, { color: GOLD, n: 24, speed: 320 });
        }
      } else if (f.st === 2) {
        f.gt -= dt;
        if (f.gt <= 0) {
          sendHome(s, f);
          g.sfx('swap', { vol: 0.6 }); g.ring(f.x, f.y, { color: f.o < 0 ? GOLD : '#ffffff', r: 90 });
        }
      }
    }
    // Grab / bring back (nearest valid knight wins: no seat-order advantage).
    s.f.forEach((f, fi) => {
      if (f.st === 1 || f.st === 4 || (f.st === 3 && f.u < 0.55)) return;
      let best = null, bd = 1e9;
      for (const p of s.p) {
        if (p.stun > 0 || (f.nogT > 0 && f.nog === p.i)) continue;
        const mine = f.o === p.o;
        if (mine ? f.st === 0 : p.c >= 0) continue;
        const d = dist(p.x, p.y, f.x, f.y);
        if (d < p.r + GRAB_R && d < bd) { bd = d; best = p; }
      }
      if (!best) return;
      if (f.o === best.o) {
        sendHome(s, f);
        g.sfx('coin'); g.text(best.x, best.y - 66, 'RIPRESO!', { player: best.i, size: 44 });
        g.ring(f.x, f.y, { player: best.i, r: 100 });
      } else {
        const fromHome = f.st === 0;
        f.st = 1; f.by = best.i; f.h = 0; f.nogT = 0;
        best.c = fi; best.spr = 0;
        s.grabs[best.o]++;
        g.sfx('pickup'); g.vibrate(best.i, 60);
        g.burst(f.x, f.y, { player: best.i, n: 14, speed: 260 });
        if (fromHome) { g.say(f.o < 0 ? "PRESO LO STENDARDO D'ORO!" : 'STENDARDO RUBATO!'); g.sfx('horn', { vol: 0.5, pitch: 1.2 }); }
        else g.text(best.x, best.y - 66, 'PRESO!', { player: best.i, size: 42 });
      }
    });
    // Captures: a carrier steps into its own camp.
    if (!g.ended) {
      for (const p of s.p) {
        if (p.c < 0) continue;
        const b = s.bases[p.o];
        if (dist(p.x, p.y, b.x, b.y) > BASE_R) continue;
        const f = s.f[p.c];
        p.c = -1; p.caps++;
        sendHome(s, f);
        if (f.o < 0) { f.st = 4; f.gt = 2.5; }
        s.score[p.o]++;
        s.last = p.o;
        g.sfx('goal'); g.sfx('fanfare', { vol: 0.6 });
        g.confetti(b.x, b.y); g.ring(b.x, b.y, { player: p.i, r: 160 });
        g.shake(0.4); g.vibrate(p.i, 150);
        if (s.score[p.o] >= CAP_WIN) {
          g.slowmo(0.35, 0.9);
          g.end(seatOf(s, p.o), 'Stendardo conquistato!');
        } else {
          g.say(s.teams ? `SQUADRA ${p.o ? 'BLU' : 'ROSSA'}: STENDARDO!` : 'STENDARDO CONQUISTATO!');
          if (s.score[p.o] === CAP_WIN - 1) g.sfx('matchpoint', { vol: 0.7 });
        }
        break;
      }
    }
  },

  timeout(s, g) {
    // Most standards; tie: a standard on its way home (the closer the better), then steals, then tackles.
    const prog = Array(s.nb).fill(0);
    for (const p of s.p) if (p.c >= 0) prog[p.o] = Math.max(prog[p.o], 1 - dist(p.x, p.y, s.bases[p.o].x, s.bases[p.o].y) / 1000);
    const key = (o) => [s.score[o], prog[o], s.grabs[o], s.tackles[o]];
    let best = [0];
    for (let o = 1; o < s.nb; o++) {
      const a = key(o), b = key(best[0]);
      let c = 0;
      for (let k = 0; k < a.length && !c; k++) c = Math.sign(a[k] - b[k]);
      if (c > 0) best = [o]; else if (c === 0) best.push(o);
    }
    const o = best.length > 1 ? best[g.rng.int(0, best.length - 1)] : best[0];
    return seatOf(s, o);
  },

  bot: stBot,

  view(s) {
    return {
      nb: s.nb, tm: s.teams ? 1 : 0, fa: s.final ? 1 : 0, sc: s.score.slice(),
      p: s.p.map((p) => ({
        x: r1(p.x), y: r1(p.y), r: r1(p.r), fx: r2(p.fx), fy: r2(p.fy), vx: Math.round(p.vx), vy: Math.round(p.vy),
        o: p.o, st: r2(p.stun), iv: p.inv > 0 ? 1 : 0, d: p.dash > 0 ? 1 : 0, k: p.dn % 8, sp: p.spr > 0 ? 1 : 0,
        c: p.c, cd: r2(p.cd), sc: r2(p.scd), tn: p.tn % 8, hk: p.hitK % 8,
      })),
      f: s.f.map((f) => ({ x: r1(f.x), y: r1(f.y), h: r1(f.h), s: f.st, o: f.o, by: f.by, g: r2(f.gt) })),
      pg: s.pigs.map((pg) => ({ x: r1(pg.x), y: r1(pg.y), vx: Math.round(pg.vx), vy: Math.round(pg.vy), ok: pg.oink > 0 ? 1 : 0 })),
      hud: { p: s.p.map((p) => s.score[p.o]), max: CAP_WIN, label: 'Stendardi' },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: p.x, y: p.y }));
  },

  render(d, v, r) {
    const L = layout(v.nb, r.variant);
    const ocol = (o) => (o < 0 ? GOLD : v.tm ? TEAM_COL[o] : d.col(o));
    // Meadow and the trampled field inside the palisade.
    d.rect(-400, -400, W + 800, H + 800, '#4f7a35');
    d.rect(F0 - 14, F0 - 14, F1 - F0 + 28, F1 - F0 + 28, '#7a5a34');
    d.rect(F0, F0, F1 - F0, F1 - F0, '#6e9c48');
    for (let k = 0; k < 9; k++) d.rect(F0, F0 + k * 104, F1 - F0, 52, 'rgba(255,255,255,0.04)');
    for (const m of L.mud) { d.circle(m.x, m.y, m.r + 8, '#5a3c1e'); d.circle(m.x, m.y, m.r, '#6b4a26'); d.circle(m.x - m.r * 0.3, m.y - m.r * 0.3, m.r * 0.3, 'rgba(255,255,255,0.12)'); }
    L.bases.forEach((b, o) => {
      d.circle(b.x, b.y, BASE_R, ocol(o) + '44', ocol(o), 8);
      d.ring(b.x, b.y, BASE_R - 14, 'rgba(255,255,255,0.5)', 3);
    });
    for (const R of L.ruins) { d.shadow(R.x + 8, R.y + 10, R.r, R.r * 0.8, 0.3); d.circle(R.x, R.y, R.r, '#9a948a', '#5c574f', 5); d.circle(R.x - 10, R.y - 10, R.r * 0.45, '#b9b3a8'); }
    // Pigs.
    for (const pg of v.pg) { d.shadow(pg.x, pg.y + 12, 24, 10, 0.3); d.emoji('🐖', pg.x, pg.y, 60); }
    // Standards (not carried).
    for (const f of v.f) {
      if (f.s === 1 || f.s === 4) continue;
      const c = ocol(f.o);
      if (f.s === 2) d.arc(f.x, f.y, 34, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(f.g / RETURN_T, 0, 1), '#ffffff', 5);
      const y = f.y - f.h * 0.6;
      d.shadow(f.x, f.y + 6, 18, 7, 0.35);
      d.line(f.x, y + 6, f.x, y - 70, '#5a3b22', 6);
      d.poly([f.x, y - 70, f.x + 46, y - 58, f.x, y - 40], c, '#2b1a0c', 3);
      d.circle(f.x, y - 72, 6, '#ffd23f');
    }
    // Knights.
    v.p.forEach((p, i) => {
      if (p.st <= 0) d.shadow(p.x + 6, p.y + 12, p.r, p.r * 0.75, 0.3);
      const sp = Math.hypot(p.vx, p.vy);
      if (p.sp || p.d) for (let k = 1; k <= 2; k++) d.circle(p.x - (p.vx / (sp || 1)) * 24 * k, p.y - (p.vy / (sp || 1)) * 24 * k, p.r * (1 - k * 0.15), d.col(i, 'light') + '30');
      const mood = p.st > 0 ? 'dizzy' : p.d ? 'angry' : p.c >= 0 ? 'happy' : 'ok';
      d.avatar(p.x, p.y, p.r, i, { look: Math.atan2(p.fy, p.fx), mood, squash: p.st > 0 ? 0.3 : p.d ? 0.15 : 0, alpha: p.iv && Math.floor(d.t * 12) % 2 ? 0.5 : 1 });
      if (p.c >= 0) {
        const f = v.f[p.c], c = ocol(f.o);
        d.line(p.x + 18, p.y - 10, p.x + 18, p.y - 86, '#5a3b22', 5);
        d.poly([p.x + 18, p.y - 86, p.x + 58, p.y - 76, p.x + 18, p.y - 60], c, '#2b1a0c', 3);
      }
      if (p.st > 0) d.emoji('💫', p.x, p.y - p.r - 20, 36);
      const lt = d.col(i, 'light');
      if (p.cd <= 0) d.ring(p.x, p.y, p.r + 8, lt + 'aa', 4);
      else d.arc(p.x, p.y, p.r + 8, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / LUNGE_CD), lt + '66', 4);
    });
  },

  // 3D: "Il Prato della Rocca Diroccata" — a misty battlefield at dawn below a ruined fortress; every side has
  // its camp (tents, banners, campfire) behind the palisade, the standards wave on stone plinths.
  render3d: {
    assets: [
      'medieval/tent', 'medieval/fence_wood_straight', 'medieval/weaponrack', 'medieval/barrel',
      'medieval/crate_A_big', 'medieval/crate_B_small', 'medieval/sack', 'medieval/wheelbarrow', 'medieval/target', 'medieval/bucket_arrows',
      'medieval/rock_single_A', 'medieval/rock_single_B', 'medieval/rock_single_D', 'medieval/tree_single_A', 'medieval/tree_single_B',
      'medieval/trees_A_large', 'medieval/trees_B_large', 'medieval/trees_B_medium', 'medieval/hills_B_trees', 'medieval/mountain_A_grass_trees',
      'medieval/mountain_C_grass', 'medieval/wall_straight', 'medieval/wall_corner_A_outside', 'medieval/building_destroyed',
      'medieval/building_tower_catapult_red', 'medieval/building_scaffolding', 'medieval/resource_stone',
      'dungeon/rubble_large', 'dungeon/rubble_half', 'dungeon/wall_broken', 'dungeon/pillar', 'dungeon/torch_lit', 'dungeon/sword_shield_broken',
    ],
    build(K, r) {
      const n = Math.max(2, r.n || K.n || 2);
      const lo = K.quality === 0;
      const variant = r.variant;
      K.theme('alba', { fogNear: 1.5, fogFar: 4.6 });
      K.ground('erba', { tile: 210, margin: 2300, color: '#d8e6b2' });
      const o = { n, ready: false, variant };
      // Battlefield painted once (needs the camps of the view: drawn at the first update).
      K.layer({ x0: -260, y0: -260, x1: W + 260, y1: H + 260, h: 0.4, transparent: true, once: true, draw: (d, v) => drawField(d, v, variant, K) });

      // Palisade of sharpened stakes around the field, with gates in the middle of every side.
      const fence = [];
      const FS = 70, E = 18;
      for (let x = F0 - E + FS / 2; x < F1 + E; x += FS) { fence.push({ x, y: F0 - E, rot: Math.PI / 2 }); fence.push({ x, y: F1 + E, rot: Math.PI / 2 }); }
      for (let y = F0 - E + FS / 2; y < F1 + E; y += FS) { fence.push({ x: F0 - E, y, rot: 0 }); fence.push({ x: F1 + E, y, rot: 0 }); }
      K.scatter('medieval/fence_wood_straight', fence, { size: FS + 4 });
      // Ruined columns (collision obstacles) with rubble around them.
      const L0 = layout(n === 3 ? 3 : 4, null);
      const stone = K.mat('#aaa59c', { rough: 0.9, flat: true });
      const moss = K.mat('#6f8f3e', { rough: 0.95 });
      const rub = [];
      L0.ruins.forEach((R, k) => {
        K.place(K.cyl(R.r, 58 + (k % 2) * 26, stone, { seg: 8 }), R.x, R.y);
        const cap = K.cyl(R.r * 0.7, 26, stone, { seg: 8 });
        K.place(cap, R.x + 8, R.y - 6, 58 + (k % 2) * 26);
        cap.rotation.z = 0.25; cap.rotation.x = -0.15;
        K.place(K.cyl(R.r + 3, 6, moss, { seg: 18, cast: false }), R.x, R.y, 0);
        // A fallen drum of the column lying next to it (outside the collision circle: decoration only).
        const a = Math.atan2(R.y - CY, R.x - CX);
        const fallen = K.cyl(R.r * 0.6, 50, stone, { seg: 8, center: true });
        K.place(fallen, R.x + Math.cos(a) * (R.r + 34), R.y + Math.sin(a) * (R.r + 34), R.r * 0.6);
        fallen.rotation.z = Math.PI / 2; fallen.rotation.y = -a + Math.PI / 2;
        for (let j = 0; j < 3; j++) {
          const b = a + Math.PI / 2 + j * 1.6;
          rub.push({ x: R.x + Math.cos(b) * (R.r + 20), y: R.y + Math.sin(b) * (R.r + 20), rot: j * 1.3 + k, s: 0.7 + j * 0.15 });
        }
      });
      K.scatter('dungeon/rubble_half', rub, { size: 46 });

      // Mud puddles (Campo Allagato): glossy discs positioned at the first update.
      o.mud = [];
      if (variant === 'fango') {
        const mm = K.mat('#4e3219', { rough: 0.18, metal: 0.05, emissive: '#2a1608', ei: 0.4 });
        const rim = K.mat('#6b4a2a', { rough: 0.9 });
        for (let k = 0; k < 5; k++) o.mud.push({ top: K.disc(1, mm, { seg: 40 }), rim: K.disc(1, rim, { seg: 40 }) });
      }

      // Camps (one kit per possible camp, placed and colored at the first update).
      o.camps = [];
      const pole = K.mat('#4a3020', { rough: 0.8 });
      const goldM = K.mat('#ffcf40', { rough: 0.3, metal: 0.7 });
      const plinthM = K.texMat('muro', [2, 1], { color: '#d8d0c0' });
      for (let k = 0; k < 4; k++) {
        const g = K.group();
        const tent = K.model('medieval/tent', { size: 210, parent: g });
        const banners = [-1, 1].map((sd) => {
          const b = K.group(g);
          K.cyl(4, 210, pole, { parent: b, seg: 8 });
          const bar = K.box(70, 5, 5, pole, { parent: b });
          bar.position.y = 200;
          const cloth = K.box(62, 3, 110, K.mat('#ffffff', { unique: true, rough: 0.7 }), { parent: b, cast: false });
          cloth.position.y = 142;
          const tip = K.ball(8, goldM, { parent: b });
          tip.position.y = 214;
          b.position.set(sd * 150, 0, 0); // local: x along the tangent (set at placement)
          return { b, cloth };
        });
        const fire = K.group(g);
        for (let j = 0; j < 4; j++) {
          const log = K.cyl(5, 46, pole, { parent: fire, center: true, seg: 6 });
          log.rotation.z = Math.PI / 2; log.rotation.y = (j * Math.PI) / 4; log.position.y = 5;
        }
        const flames = [0, 1, 2].map((j) => { const f = K.cone(14 - j * 3, 40 - j * 6, K.glow(j === 1 ? '#ffd23f' : '#ff7a1e', { add: true }), { parent: fire, cast: false }); f.position.y = 4; return f; });
        const ring = K.disc(BASE_R, K.glow('#ffffff', { unique: true, opacity: 0.22 }), { r0: BASE_R - 9, seg: 56 });
        const plinth = K.cyl(24, 16, plinthM, { seg: 16 });
        const light = lo ? null : K.light(0, 0, 60, '#ffae5a', 1.6, { flicker: 0.6, dist: 420 });
        o.camps.push({ g, tent, banners, fire, flames, ring, plinth, light });
      }
      // Standards (pole + waving cloth in the owner color).
      o.flags = [];
      for (let k = 0; k < 4; k++) {
        const g = K.group();
        const tilt = K.group(g);
        K.cyl(3.5, 150, pole, { parent: tilt, seg: 8 });
        const bar = K.box(54, 4, 4, pole, { parent: tilt });
        bar.position.set(24, 138, 0);
        const cm = K.mat('#ffffff', { unique: true, rough: 0.6, emissive: '#000000' });
        const cloth = K.box(48, 3, 64, cm, { parent: tilt, cast: false });
        cloth.position.set(26, 104, 0);
        const emb = K.ball(9, K.mat('#fff6d8', { rough: 0.4 }), { parent: tilt, cast: false });
        emb.position.set(26, 106, 2.5); emb.scale.set(1, 1, 0.3);
        const tip = K.ball(7, goldM, { parent: tilt });
        tip.position.y = 154;
        const beam = K.cyl(30, 260, K.glow('#ffffff', { unique: true, opacity: 0.14, add: true }), { seg: 20, open: true, cast: false });
        const timer = K.decal(110);
        o.flags.push({ g, tilt, cloth, cm, beam, timer, ph: k * 1.3 });
      }
      // Pigs (Maiali allo Sbaraglio).
      o.pigs = [];
      if (variant === 'maiali') {
        const pink = K.mat('#ffa8bf', { rough: 0.55 }), dark = K.mat('#e07a96', { rough: 0.6 }), ink = K.mat('#2a1a1a', { rough: 0.3 });
        for (let k = 0; k < 3; k++) {
          const g = K.group();
          const body = K.ball(1, pink, { parent: g });
          body.scale.set(30, 22, 21); body.position.y = 26;
          const head = K.ball(15, pink, { parent: g });
          head.position.set(28, 34, 0);
          const snout = K.cyl(7, 6, dark, { parent: g, center: true, seg: 12 });
          snout.rotation.z = Math.PI / 2; snout.position.set(43, 31, 0);
          for (const sd of [-1, 1]) {
            const ear = K.cone(6, 12, dark, { parent: g });
            ear.position.set(26, 45, sd * 9); ear.rotation.x = sd * 0.5;
            const eye = K.ball(2.4, ink, { parent: g, cast: false });
            eye.position.set(39, 39, sd * 6);
          }
          const legs = [];
          for (const [lx, lz] of [[14, 10], [14, -10], [-14, 10], [-14, -10]]) {
            const l = K.cyl(4.5, 14, dark, { parent: g, seg: 8 });
            l.position.set(lx, 0, lz);
            legs.push(l);
          }
          const tail = K.torus(5, 1.6, dark, { parent: g });
          tail.position.set(-30, 32, 0); tail.rotation.z = Math.PI / 2;
          o.pigs.push({ g, legs, body });
        }
      }

      // Knights: avatar + ground indicator + dizzy stars.
      o.pl = [...Array(n).keys()].map((i) => ({ av: K.avatar(i), dec: K.decal(170), stars: K.emoji('💫', 46) }));

      buildScenery(K, lo);
      // Low mist banks drifting outside the field.
      o.mist = [];
      for (let k = 0; k < (lo ? 2 : 4); k++) {
        const L = K.layer({ x0: -500, y0: -180, x1: 500, y1: 180, h: 40 + k * 18, transparent: true, once: true, lit: false, z: 2, maxPx: 512, draw: (d) => drawMist(d, k) });
        o.mist.push({ L, k });
      }
      K.ambient('polvere', { n: 70, x0: -300, y0: -300, x1: 1300, y1: 1300, h: 260 });
      return o;
    },

    update(K, o, v, r) {
      const t = K.t;
      const nb = v.nb;
      const ocol = (q) => (q < 0 ? GOLD : v.tm ? TEAM_COL[q] : K.col(q, 'main'));
      if (!o.ready) {
        o.ready = true;
        const L = layout(nb, o.variant);
        o.L = L;
        o.camps.forEach((C, k) => {
          const on = k < nb;
          C.g.visible = C.ring.visible = on;
          C.plinth.visible = on && o.variant !== 'dorato';
          if (C.light) C.light.visible = on;
          if (!on) return;
          const b = L.bases[k];
          const ox = Math.cos(b.a), oy = Math.sin(b.a); // outward
          const bottom = oy > 0.5;
          // Camp behind the palisade (the near side keeps only low things).
          const cx = b.x + ox * (bottom ? 190 : 230), cy = b.y + oy * (bottom ? 190 : 230);
          K.place(C.g, cx, cy);
          K.face(C.g, b.a + Math.PI / 2);
          // Local axes: +X along the palisade, -Z outward (away from the field).
          C.tent.visible = !bottom;
          C.tent.position.set(0, 0, -100);
          C.fire.position.set(bottom ? 120 : 0, 0, bottom ? -10 : 30);
          for (const B of C.banners) { B.b.scale.setScalar(bottom ? 0.6 : 1); B.cloth.material.color.set(ocol(k)); }
          K.place(C.ring, b.x, b.y, 0.9);
          C.ring.material.color.set(ocol(k));
          K.place(C.plinth, b.x, b.y);
          if (C.light) K.place(C.light, cx, cy, 60);
        });
        if (o.variant === 'dorato') {
          // The golden standard stands on a plinth in the middle.
          const C = o.camps[0];
          C.plinth.visible = true;
          K.place(C.plinth, CX, CY);
        }
        o.mud.forEach((M, k) => {
          const m = L.mud[k];
          M.top.visible = M.rim.visible = !!m;
          if (!m) return;
          K.place(M.rim, m.x, m.y, 0.7); M.rim.scale.setScalar(m.r + 10);
          K.place(M.top, m.x, m.y, 1.4); M.top.scale.setScalar(m.r);
        });
        o.flags.forEach((F, k) => { if (v.f[k]) F.cm.color.set(ocol(v.f[k].o)); });
      }
      // Camp life: waving banners, flickering fires, base rings pulsing when a rival carrier approaches.
      o.camps.forEach((C, k) => {
        if (k >= nb) return;
        C.banners.forEach((B, j) => { B.cloth.rotation.y = Math.sin(t * 2.2 + k + j * 1.7) * 0.25; B.cloth.scale.x = 1 + Math.sin(t * 3.1 + j) * 0.06; });
        C.flames.forEach((f, j) => { f.scale.set(1 + Math.sin(t * 17 + j * 2) * 0.15, 1 + Math.sin(t * 13 + j) * 0.3, 1 + Math.cos(t * 15 + j) * 0.15); });
        let hot = false;
        for (const p of v.p) if (p.c >= 0 && p.o === k) hot = true;
        C.ring.material.opacity = hot ? 0.45 + 0.35 * (Math.sin(t * 12) > 0 ? 1 : 0) : 0.3;
      });
      // Mist banks: two along the sides (turned), two over the ruins.
      for (const M of o.mist) {
        const k = M.k;
        const mx = [-340, 1340, CX - 380, CX + 380][k], my = [380, 620, -300, -330][k];
        K.place(M.L.mesh, mx + Math.sin(t * 0.05 + k) * 80, my + Math.cos(t * 0.04 + k) * 70, 40 + k * 18);
        M.L.mesh.rotation.y = k < 2 ? Math.PI / 2 : 0;
      }
      // Standards.
      o.flags.forEach((F, k) => {
        const f = v.f[k];
        const on = !!f && f.s !== 4;
        F.g.visible = on;
        F.beam.visible = on && f.s >= 2;
        F.timer.show(on && f.s === 2);
        if (!on) return;
        F.cloth.rotation.y = Math.sin(t * 3 + F.ph) * 0.22;
        F.cloth.scale.x = 1 + Math.sin(t * 4.2 + F.ph) * 0.07;
        if (f.s === 1) {
          // Carried on the back of the knight.
          const c = v.p[f.by];
          const a = c ? Math.atan2(c.fy, c.fx) : 0;
          const x = c ? c.x - c.fx * 14 : f.x, y = c ? c.y - c.fy * 14 : f.y;
          K.place(F.g, x, y, c ? c.r * 0.9 : 30);
          F.g.rotation.set(0, 0, 0);
          K.face(F.g, a + Math.PI);
          F.tilt.rotation.z = -0.28;
          F.g.scale.setScalar(0.85);
        } else if (f.s === 3) {
          K.place(F.g, f.x, f.y, f.h);
          F.g.rotation.set(0, 0, 0);
          F.g.rotation.y = t * 9;
          F.tilt.rotation.z = Math.sin(t * 7) * 0.6;
          F.g.scale.setScalar(0.9);
        } else {
          const home = f.s === 0;
          K.place(F.g, f.x, f.y, home ? 16 : 0);
          F.g.rotation.set(0, 0, 0);
          K.face(F.g, -Math.PI / 4);
          F.tilt.rotation.z = home ? 0 : 0.5 + Math.sin(t * 5) * 0.05;
          F.g.scale.setScalar(home ? 1 : 0.9);
        }
        if (F.beam.visible) {
          K.place(F.beam, f.x, f.y, 0);
          F.beam.material.color.set(ocol(f.o));
          F.beam.material.opacity = 0.12 + 0.08 * Math.sin(t * 6);
        }
        if (f.s === 2) {
          F.timer.at(f.x, f.y, 1.2).paint((d) => {
            d.circle(0, 0, 40, 'rgba(0,0,0,0.25)');
            d.arc(0, 0, 40, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(f.g / RETURN_T, 0, 1), ocol(f.o), 9);
          });
        }
      });
      // Pigs.
      o.pigs.forEach((P, k) => {
        const pg = v.pg[k];
        P.g.visible = !!pg;
        if (!pg) return;
        const sp = Math.hypot(pg.vx, pg.vy);
        K.place(P.g, pg.x, pg.y, Math.abs(Math.sin(t * 14 + k)) * (sp > 60 ? 6 : 0));
        K.face(P.g, Math.atan2(pg.vy, pg.vx));
        P.legs.forEach((l, j) => { l.rotation.z = Math.sin(t * 18 + j * Math.PI) * 0.6 * Math.min(1, sp / 150); });
        P.body.scale.y = 22 * (pg.ok ? 1.25 : 1);
      });
      // Knights.
      const best = r.ended ? Math.max(...v.sc) : -1;
      v.p.forEach((p, i) => {
        const P = o.pl[i];
        if (!P) return;
        const sp = Math.hypot(p.vx, p.vy);
        let anim, animKey;
        if (p.st > 0) anim = p.st > 0.4 ? 'Hit_B' : 'Lie_StandUp';
        else if (p.d) { anim = 'Dodge_Forward'; animKey = p.k; }
        if (P.lastTn === undefined) P.lastTn = p.tn;
        if (P.lastTn !== p.tn) { P.lastTn = p.tn; P.throwT = t; }
        if (!anim && P.throwT !== undefined && t - P.throwT < 0.45) { anim = 'Throw'; animKey = p.tn; }
        let mood = p.st > 0 ? 'dizzy' : 'ok';
        if (r.ended) { mood = v.sc[p.o] === best ? 'happy' : 'hurt'; if (mood === 'happy') anim = 'Cheer'; else anim = 'Sit_Floor_Idle'; }
        P.av.set(p.x, p.y, {
          r: p.r, look: Math.atan2(p.fy, p.fx), mood, walk: clamp(sp / 300, 0, 1), anim, animKey, gear: p.c < 0,
          lean: p.sp ? 0.18 : 0, alpha: p.iv && Math.floor(t * 12) % 2 ? 0.55 : 1,
        });
        P.stars.visible = p.st > 0;
        if (p.st > 0) K.place(P.stars, p.x, p.y, p.r * 3.1 + Math.sin(t * 8) * 4);
        P.dec.show(p.st <= 0).at(p.x, p.y, 1.1).paint((d) => {
          const lt = K.col(i, 'light');
          const ax = p.fx * (p.r + 22), ay = p.fy * (p.r + 22);
          d.poly([ax + p.fx * 18, ay + p.fy * 18, ax - p.fy * 13, ay + p.fx * 13, ax + p.fy * 13, ay - p.fx * 13], lt + (p.cd <= 0 ? 'ee' : '55'), 'rgba(0,0,0,0.35)', 2);
          if (p.cd <= 0) d.ring(0, 0, p.r + 10, lt + 'cc', 6);
          else d.arc(0, 0, p.r + 10, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.cd / LUNGE_CD), lt + '99', 6);
          if (p.c < 0) {
            if (p.sc > 0) d.arc(0, 0, p.r + 19, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - p.sc / SPRINT_CD), 'rgba(255,240,200,0.6)', 4);
            else d.ring(0, 0, p.r + 19, 'rgba(255,240,200,0.75)', 3);
          }
        });
      });
    },
  },
};

// ---------------------------------------------------------------- 3D scenery helpers
// Trampled battlefield inside the palisade: muddy tracks from every camp to the middle, craters, arrows, camp circles.
function drawField(d, v, variant, K) {
  const { ctx } = d;
  const nb = v.nb;
  const L = layout(nb, variant);
  const ocol = (o) => (o < 0 ? GOLD : v.tm ? TEAM_COL[o] : K.col(o, 'main'));
  let seed = 777;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // Darker trodden grass inside the field.
  ctx.fillStyle = 'rgba(92,110,52,0.35)';
  ctx.fillRect(F0, F0, F1 - F0, F1 - F0);
  // Tracks: brown smudges along the lines from every camp to the center.
  for (const b of L.bases) {
    for (let k = 0; k < 70; k++) {
      const u = rnd();
      const x = b.x + (CX - b.x) * u + (rnd() - 0.5) * 90, y = b.y + (CY - b.y) * u + (rnd() - 0.5) * 90;
      d.circle(x, y, 10 + rnd() * 26, `rgba(${110 + Math.floor(rnd() * 30)},${82 + Math.floor(rnd() * 20)},${50},${(0.18 + rnd() * 0.2).toFixed(2)})`);
    }
  }
  // Center: a large trampled ring.
  const gr = ctx.createRadialGradient(CX, CY, 20, CX, CY, 260);
  gr.addColorStop(0, 'rgba(126,96,60,0.55)'); gr.addColorStop(1, 'rgba(126,96,60,0)');
  ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(CX, CY, 260, 0, TAU); ctx.fill();
  // Craters and broken arrows (the battle went on all night).
  for (let k = 0; k < 9; k++) {
    const x = F0 + 60 + rnd() * (F1 - F0 - 120), y = F0 + 60 + rnd() * (F1 - F0 - 120);
    if (L.bases.some((b) => dist(x, y, b.x, b.y) < BASE_R + 40)) continue;
    d.circle(x, y, 22 + rnd() * 10, 'rgba(60,44,28,0.45)');
    d.ring(x, y, 26 + rnd() * 8, 'rgba(160,130,90,0.35)', 5);
  }
  for (let k = 0; k < 40; k++) {
    const x = F0 + rnd() * (F1 - F0), y = F0 + rnd() * (F1 - F0), a = rnd() * TAU;
    d.line(x, y, x + Math.cos(a) * 22, y + Math.sin(a) * 22, 'rgba(70,46,26,0.7)', 2.5);
    d.line(x, y, x - Math.cos(a + 0.5) * 6, y - Math.sin(a + 0.5) * 6, 'rgba(240,240,240,0.7)', 2);
  }
  // Mud puddles: darker banks.
  for (const m of L.mud) d.circle(m.x, m.y, m.r + 22, 'rgba(70,48,26,0.5)');
  // Camps: colored circle with a bright border and stakes.
  L.bases.forEach((b, o) => {
    const c = ocol(o);
    d.circle(b.x, b.y, BASE_R + 18, 'rgba(60,40,20,0.35)');
    d.circle(b.x, b.y, BASE_R, c + '55');
    d.ring(b.x, b.y, BASE_R, c, 10);
    d.ring(b.x, b.y, BASE_R - 18, 'rgba(255,255,255,0.55)', 4);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU;
      d.circle(b.x + Math.cos(a) * (BASE_R + 10), b.y + Math.sin(a) * (BASE_R + 10), 5, '#f6eedc');
    }
  });
  if (variant === 'dorato') { d.circle(CX, CY, 60, 'rgba(255,210,63,0.3)'); d.ring(CX, CY, 60, GOLD, 6); }
}

function drawMist(d, k) {
  const { ctx } = d;
  for (let j = 0; j < 7; j++) {
    const x = -380 + j * 125 + (k * 37) % 60, y = Math.sin(j * 1.7 + k) * 60;
    const g = ctx.createRadialGradient(x, y, 10, x, y, 160);
    g.addColorStop(0, 'rgba(255,246,240,0.42)'); g.addColorStop(1, 'rgba(255,246,240,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - 160, y - 160, 320, 320);
  }
}

function buildScenery(K, lo) {
  const sc = (name, list, size) => K.scatter(name, list.map(([x, y, rot, s]) => ({ x, y, rot: rot || 0, s: s || 1 })), { size });
  // The ruined fortress on the far side: broken walls, a gutted keep, scaffolding, siege towers.
  const FY = -360;
  const wall = [];
  for (let k = -6; k <= 6; k++) if (k % 3 !== 0) wall.push([CX + k * 170, FY - (Math.abs(k) % 2) * 20, 0]);
  sc('medieval/wall_straight', wall, 175);
  sc('dungeon/wall_broken', [[CX - 510, FY + 5, 0], [CX + 510, FY + 5, 0], [CX, FY + 5, 0]], 180);
  sc('medieval/wall_corner_A_outside', [[-620, FY, 0], [1620, FY, Math.PI / 2]], 200);
  const keep = K.model('medieval/building_destroyed', { size: 420 });
  K.place(keep, CX - 160, FY - 330); K.face(keep, 0.3);
  const keep2 = K.model('medieval/building_destroyed', { size: 340 });
  K.place(keep2, CX + 380, FY - 270); K.face(keep2, 2.2);
  const scaf = K.model('medieval/building_scaffolding', { size: 220 });
  K.place(scaf, CX + 120, FY - 220);
  sc('dungeon/rubble_large', [[CX - 360, FY - 90, 0.4], [CX + 260, FY - 100, 1.2], [CX - 40, FY - 120, 2.4], [CX + 640, FY - 120, 0.8], [CX - 700, FY - 120, 2]], 140);
  sc('medieval/resource_stone', [[CX + 60, FY - 90, 0.3], [CX - 220, FY - 70, 1.1]], 90);
  const cat = K.model('medieval/building_tower_catapult_red', { size: 240 });
  K.place(cat, -380, -120); K.face(cat, 0.6);
  const cat2 = K.model('medieval/building_tower_catapult_red', { size: 240 });
  K.place(cat2, 1380, -120); K.face(cat2, Math.PI - 0.6);
  // Torches on the ruins (light only on PC).
  for (const x of [CX - 300, CX + 300]) K.place(K.model('dungeon/torch_lit', { height: 90 }), x, FY + 60);
  if (!lo) K.light(CX, FY + 60, 120, '#ffb35c', 1.6, { flicker: 0.4, dist: 520 });
  // Siege camp clutter in the corners (the middle of every side may hold a camp).
  sc('medieval/weaponrack', [[-110, 130, 1.5], [1110, 130, -1.5], [-120, 860, 1.4], [1120, 860, -1.6]], 85);
  sc('medieval/barrel', [[-80, 200, 0], [-110, 235, 1], [1090, 820, 0], [1080, 780, 2], [-90, 800, 1], [1110, 210, 0.5]], 46);
  sc('medieval/crate_A_big', [[-150, 240, 0.3], [1150, 790, 0.2], [-160, 940, 0.6], [1170, 60, 0.5]], 60);
  sc('medieval/crate_B_small', [[-120, 270, 0.8], [1120, 750, 0.5]], 38);
  sc('medieval/sack', [[-60, 250, 0], [1060, 760, 1], [-70, 900, 2]], 40);
  sc('medieval/bucket_arrows', [[-70, 160, 0], [1070, 880, 0]], 34);
  sc('medieval/target', [[-280, 230, 1.5], [1280, 780, -1.5]], 90);
  sc('medieval/wheelbarrow', [[-230, 960, 0.8], [1230, 60, 2.4]], 80);
  sc('dungeon/sword_shield_broken', [[-40, 1010, 0.4], [1040, 20, 1.2], [1030, 1010, 2]], 50);
  // Rocks and lone trees around, forests and hills far away.
  sc('medieval/rock_single_A', [[-200, 40, 0], [1210, 960, 1], [-260, 1100, 2], [1300, -60, 0.5]], 70);
  sc('medieval/rock_single_B', [[-330, 640, 0], [1340, 380, 1]], 60);
  sc('medieval/rock_single_D', [[1150, 1100, 0], [-150, -80, 1]], 64);
  const trees = [], trees2 = [], singles = [];
  const N = lo ? 18 : 36;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * TAU;
    if (Math.sin(a) < -0.45) continue; // fortress side
    const rr = 1250 + (k % 3) * 160;
    (k % 2 ? trees : trees2).push([CX + Math.cos(a) * rr * 1.3, CY + Math.sin(a) * rr, k, 0.85 + (k % 3) * 0.15]);
  }
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * TAU + 0.2;
    if (Math.sin(a) < -0.3) continue;
    singles.push([CX + Math.cos(a) * 820 * 1.25, CY + Math.sin(a) * 820, k, 0.8 + (k % 3) * 0.2]);
  }
  sc('medieval/trees_A_large', trees, 300);
  sc('medieval/trees_B_large', trees2, 320);
  sc('medieval/tree_single_B', singles, 150);
  sc('medieval/trees_B_medium', [[-420, 300, 0], [1420, 700, 1], [-450, 900, 2], [1450, 0, 3]], 220);
  sc('medieval/hills_B_trees', [[-1300, -700, 0.3], [2300, -700, 2], [-1500, 600, 1], [2500, 600, 4]], 900);
  sc('medieval/mountain_A_grass_trees', [[CX - 1500, -1500, 0.5], [CX + 1500, -1600, 2]], 1500);
  sc('medieval/mountain_C_grass', [[CX, -2000, 1]], 1700);
}
