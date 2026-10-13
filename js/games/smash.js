// Rissa sul Ponte Levatoio — side-view platform fighter (Super Smash Bros style), 2–4 players.
// Damage %, knockback grows with damage, blast zones, crates with mallet/bomb items, sudden death, last one standing.
import { clamp, approach, damp, norm, sign, lerp, dist, circleRect, r1, r2 } from '../core/geom.js';

// Tight framing around the stage: fighters stay big even on half of a shared phone.
const W = 1240, H = 780;
const VIS_B = H - 140;            // lowest world y surely visible (the shared-phone HUD covers the bottom strip)
// Main solid platform (the stone bridge, floating: it does not reach the borders).
const SX0 = 150, SX1 = 1090, STOP = 530, SBOT = 630, SCX = (SX0 + SX1) / 2;
// Thin pass-through platforms (symmetric wooden scaffolds).
const THIN = [{ x0: 240, x1: 470, y: 340 }, { x0: 770, x1: 1000, y: 340 }];
// Blast zones (well beyond the level).
const BL = -520, BR = 1760, BB = 1180, BT = -630;
// Hay-joust ring (gommoso) ropes.
const ROPE_L = SX0 + 16, ROPE_R = SX1 - 16, ROPE_TOP = 400;

const R = 46;
const LIVES = 2;
const GRAV = 2700, JUMP = 1180, DJUMP = 1080;
const RUN = 540, ACC = 4200, FRIC = 3600;
const AIRMAX = 500, AIRACC = 2400, AIRFRIC = 700;
const FALL = 1100, FFALL = 1750;
const HOLD_MIN = 0.3, HOLD_MAX = 1.5;
const INV = 1.5, SPAWN_Y = 230;
const SD_T = 45;
const DODGE_T = 0.34, DODGE_CD = 0.75, RAGE = 1.25;
const CRATE_H = 38, ITEM_R = 28, BOMB_R = 26, ER = 160;
// Start / respawn x offsets from the bridge center, by number of players (seat order).
const START = { 2: [-260, 260], 3: [-300, 300, 0], 4: [-330, 330, -110, 110] };
const RESP = [-170, 170, -60, 60];
const faceOf = (dx) => (dx > 0 ? -1 : 1);

// Attack table: times in s, offsets/radius in body radii, angle in degrees (up +, relative to facing).
const ATK = {
  jab: { dur: 0.24, a0: 0.04, a1: 0.13, ox: 1.25, oy: 0.05, hr: 0.8, dmg: 5, base: 260, grow: 5.5, ang: 32 },
  up: { dur: 0.3, a0: 0.05, a1: 0.17, ox: 0.3, oy: -1.3, hr: 0.85, dmg: 7, base: 320, grow: 6, ang: 82 },
  down: { dur: 0.34, a0: 0.07, a1: 0.2, ox: 0.1, oy: 1.25, hr: 0.85, dmg: 8, base: 280, grow: 6, ang: -75 },
  smash: { dur: 0.5, a0: 0.1, a1: 0.24, ox: 1.45, oy: 0, hr: 1.0, dmg: 14, base: 440, grow: 12, ang: 38 },
  usmash: { dur: 0.5, a0: 0.1, a1: 0.24, ox: 0.2, oy: -1.5, hr: 1.05, dmg: 14, base: 440, grow: 12, ang: 86 },
  ham: { dur: 0.4, a0: 0.08, a1: 0.24, ox: 1.6, oy: -0.1, hr: 1.15, dmg: 17, base: 620, grow: 15, ang: 40 },
  throw: { dur: 0.22, a0: 9, a1: 9, ox: 0, oy: 0, hr: 0, dmg: 0, base: 0, grow: 0, ang: 0 },
};
const AK = ['', 'jab', 'up', 'down', 'smash', 'usmash', 'ham', 'throw'];

function makePlayer(i, sc, n) {
  const dx = START[n][i];
  return {
    i, r: R * sc, w: Math.sqrt(sc),
    x: SCX + dx, y: STOP - R * sc, vx: 0, vy: 0, face: faceOf(dx),
    ground: true, onThin: false, jumps: 1, coyote: 0, dropT: 0, ff: false, upUsed: false, prevSy: 0,
    dmg: 0, lives: LIVES, st: 'alive', koT: 0, spT: 0, platT: 0, inv: 0, hitstun: 0, flash: 0,
    ak: '', at: 0, ahit: 0, apw: 1, hold: -1, pressQ: 0, by: -1,
    item: null, hamT: 0, wobT: 0, landT: 0, happy: 0, dodge: 0, dodgeCd: 0,
  };
}

// Land a falling object of half-height h on platform tops. Returns true if it landed.
function landObj(o, h, prevY) {
  if (o.vy < 0) return false;
  const feet = o.y + h, pf = prevY + h;
  if (o.x > SX0 && o.x < SX1 && pf <= STOP + 0.5 && feet >= STOP) { o.y = STOP - h; o.vy = 0; return true; }
  for (const t of THIN) {
    if (o.x > t.x0 && o.x < t.x1 && pf <= t.y + 0.5 && feet >= t.y) { o.y = t.y - h; o.vy = 0; return true; }
  }
  return false;
}

// Highest platform surface below (x, y), or null (used for drop shadows).
function surfaceBelow(x, y) {
  let best = null;
  for (const t of THIN) if (x > t.x0 && x < t.x1 && t.y >= y && (best === null || t.y < best)) best = t.y;
  if (x > SX0 && x < SX1 && STOP >= y && (best === null || STOP < best)) best = STOP;
  return best;
}

// ahit = bitmask of the players this attack already hit (an attack can hit several fighters once each).
function startAtk(p, k, pw) { p.ak = k; p.at = 0; p.ahit = 0; p.apw = pw; }

function hitbox(p) {
  const A = ATK[p.ak];
  if (!A || !A.hr || p.at < A.a0 || p.at > A.a1) return null;
  return { x: p.x + p.face * A.ox * p.r, y: p.y + A.oy * p.r, r: A.hr * p.r };
}

function quickAttack(g, p, inp) {
  const up = inp.sy < -0.5 && -inp.sy >= Math.abs(inp.sx);
  const down = !p.ground && inp.sy > 0.5 && inp.sy >= Math.abs(inp.sx);
  if (Math.abs(inp.sx) > 0.3 && !up && !down) p.face = inp.sx > 0 ? 1 : -1;
  startAtk(p, up ? 'up' : down ? 'down' : 'jab', 1);
  // Rising uppercut doubles as a recovery move (once per air time).
  if (up && !p.ground && !p.upUsed) { p.upUsed = true; p.vy = Math.min(p.vy, -760); p.ff = false; }
  g.sfx('whoosh', { pitch: 1.5, vol: 0.5 });
}

function releaseHold(g, p, inp) {
  const h = p.hold;
  p.hold = -1;
  if (h < HOLD_MIN) return quickAttack(g, p, inp);
  const pw = 1 + 0.65 * clamp((h - HOLD_MIN) / 0.9, 0, 1);
  const up = inp.sy < -0.5 && -inp.sy >= Math.abs(inp.sx);
  if (!up && Math.abs(inp.sx) > 0.3) p.face = inp.sx > 0 ? 1 : -1;
  startAtk(p, up ? 'usmash' : 'smash', pw);
  g.sfx('whoosh', { pitch: 0.8 });
  g.burst(p.x, p.y, { player: p.i, n: 10, speed: 260 });
}

function throwBomb(s, g, p, inp) {
  p.item = null;
  const up = inp.sy < -0.5 && -inp.sy >= Math.abs(inp.sx);
  const down = !p.ground && inp.sy > 0.5;
  if (Math.abs(inp.sx) > 0.3 && !up) p.face = inp.sx > 0 ? 1 : -1;
  const vx = up ? p.face * 120 : down ? 0 : p.face * 950 + p.vx * 0.3;
  const vy = up ? -1150 : down ? 800 : -380;
  s.bombs.push({ x: p.x + p.face * p.r * 0.6, y: p.y - p.r * 0.8, vx, vy, own: p.i, t: 0, rain: false });
  startAtk(p, 'throw', 1);
  g.sfx('whoosh');
}

function pressAttack(s, g, p, inp) {
  if (p.item === 'hammer') { startAtk(p, 'ham', 1); g.sfx('whoosh', { pitch: 0.6 }); return; }
  if (p.item === 'bomb') return throwBomb(s, g, p, inp);
  if (inp.a) { p.hold = 0; return; } // still held: wait for release or charge a smash
  quickAttack(g, p, inp);
}

function dropItem(s, p) {
  if (p.item === 'bomb') s.items.push({ k: 'bomb', x: p.x, y: p.y - p.r, vx: p.vx * 0.3, vy: -300, life: 10, fuse: 0 });
  p.item = null; p.hamT = 0;
}

// Apply a launch to player q. kb = knockback magnitude (px/s). by = attacker seat or -1.
function launch(s, g, q, vx, vy, kb, by) {
  q.vx = vx; q.vy = vy;
  q.hitstun = clamp(kb * 0.00038, 0.12, 1.0);
  q.flash = 0.3; q.ground = false;
  q.ak = ''; q.hold = -1; q.pressQ = 0;
  q.jumps = 1; q.ff = false; q.upUsed = false;
  if (q.item === 'bomb') dropItem(s, q);
  if (by >= 0 && by !== q.i) { s.last = by; q.by = by; }
  // Juice by strength.
  const big = kb > 1400, mid = kb > 750;
  g.sfx(big ? 'bang' : mid ? 'punch' : 'hit', { pitch: big ? 0.9 : 1.1 });
  if (big) g.sfx('punch', { pitch: 0.7 });
  g.burst(q.x, q.y, { color: '#fff', n: big ? 16 : mid ? 10 : 6, speed: big ? 520 : 300 });
  if (big) { g.burst(q.x, q.y, { player: q.i, n: 22, speed: 650, size: 10 }); g.ring(q.x, q.y, { player: q.i, r: 160 }); g.flash('#fff', 0.35); }
  g.hitstop(clamp(0.03 + kb * 0.00004, 0.04, 0.14));
  g.shake(big ? 0.7 : mid ? 0.35 : 0.15);
  g.vibrate(q.i, big ? 200 : 70);
  // Probably lethal on the last life: Smash-style dramatic slow-mo at the impact.
  if (q.lives === 1 && kb > 1900 && !g.ended) { g.slowmo(0.25, 0.5); g.hitstop(0.18); }
}

function strike(s, g, p, q, ak, pw) {
  const A = ATK[ak];
  q.dmg = Math.min(999, q.dmg + Math.round(A.dmg * pw));
  const rage = p.lives < q.lives ? RAGE : 1; // comeback: who lost a life hits harder
  const kb = ((A.base + A.grow * q.dmg) * pw * s.kbMul * rage) / q.w;
  const ang = (A.ang * Math.PI) / 180;
  launch(s, g, q, Math.cos(ang) * p.face * kb, -Math.sin(ang) * kb, kb, p.i);
  if (ak === 'smash' || ak === 'usmash') g.text(q.x, q.y - q.r - 70, 'SBAM!', { player: p.i, size: 56 });
  if (ak === 'ham') g.text(q.x, q.y - q.r - 70, 'BONK!', { color: '#ffcf3f', size: 56 });
}

function breakCrate(s, g, c) {
  if (c.dead) return;
  c.dead = true;
  const k = g.rng.chance(0.5) ? 'hammer' : 'bomb';
  s.items.push({ k, x: c.x, y: c.y, vx: g.rng.range(-120, 120), vy: -450, life: 12, fuse: 0 });
  g.sfx('break'); g.sfx('pickup', { pitch: 0.8, vol: 0.5 });
  g.burst(c.x, c.y, { color: '#c98a3b', n: 18, speed: 380, size: 9 });
  g.shake(0.2);
}

function explode(s, g, x, y, power, own, ownSafe) {
  s.booms.push({ x, y, t: 0 });
  g.sfx('explode'); g.shake(0.55); g.hitstop(0.05);
  g.burst(x, y, { color: '#ffb02e', n: 26, speed: 520, size: 12 });
  g.burst(x, y, { color: '#ff4b2b', n: 12, speed: 300, size: 16 });
  g.ring(x, y, { color: '#ffd36b', r: ER });
  for (const q of s.p) {
    if (q.st !== 'alive' || q.inv > 0 || q.dodge > 0 || (ownSafe && q.i === own)) continue;
    if (dist(x, y, q.x, q.y) > ER + q.r * 0.5) continue;
    const nn = norm(q.x - x, q.y - y - 40);
    const dn = norm(nn.x, Math.min(nn.y, -0.5));
    q.dmg = Math.min(999, q.dmg + Math.round(14 * power));
    const kb = ((520 + 11 * q.dmg) * power * s.kbMul) / q.w;
    launch(s, g, q, dn.x * kb, dn.y * kb, kb, own >= 0 && own !== q.i ? own : -1);
  }
  for (const c of s.crates) if (!c.dead && dist(x, y, c.x, c.y) < ER + CRATE_H) breakCrate(s, g, c);
  for (const o of s.items) if (!o.dead && o.k === 'bomb' && o.fuse <= 0 && dist(x, y, o.x, o.y) < ER + ITEM_R) o.fuse = 0.15;
}

function startSpawn(p) {
  p.st = 'spawn'; p.spT = 0;
  p.x = SCX + RESP[p.i]; p.y = -160; p.vx = 0; p.vy = 0;
  p.face = faceOf(RESP[p.i]);
  p.dmg = 0; p.hitstun = 0; p.ak = ''; p.hold = -1; p.inv = INV; p.ff = false; p.jumps = 1; p.upUsed = false; p.by = -1;
}

function ko(s, g, p) {
  p.lives--;
  p.st = 'ko'; p.koT = 1.2; p.ak = ''; p.hold = -1;
  p.item = null; p.hamT = 0;
  const ex = clamp(p.x, 30, W - 30), ey = clamp(p.y, 30, H - 30);
  s.kos.push({ x: ex, y: ey, i: p.i, t: 0 });
  s.cheer = 2;
  g.sfx('bigexplode'); g.sfx('crash', { vol: 0.6 });
  g.burst(ex, ey, { player: p.i, n: 50, speed: 800, size: 14 });
  g.burst(ex, ey, { color: '#fff', n: 20, speed: 500, size: 8 });
  g.ring(ex, ey, { player: p.i, r: 300 });
  g.shake(0.9); g.vibrate(p.i, 350);
  const credit = p.by >= 0 ? p.by : s.n === 2 ? 1 - p.i : -1;
  if (credit >= 0) s.p[credit].happy = 1.6;
  if (p.lives <= 0) {
    const left = s.p.filter((q) => q.lives > 0);
    if (left.length <= 1) {
      g.slowmo(0.25, 1.2); g.hitstop(0.25); g.flash('#fff', 0.7);
      g.say('VITTORIA!', { big: true });
      g.end(left.length ? left[0].i : -1, 'Dritto nel fossato!');
    } else {
      g.say('FUORI DAL TORNEO!');
    }
  } else {
    g.say('NEL FOSSATO!');
  }
}

function updatePlayer(s, g, p, inp, dt) {
  const gs = s.gs;
  p.flash = Math.max(0, p.flash - dt);
  p.inv = Math.max(0, p.inv - dt);
  p.landT = Math.max(0, p.landT - dt);
  p.happy = Math.max(0, p.happy - dt);
  if (inp.aP) p.pressQ = 0.15; else p.pressQ = Math.max(0, p.pressQ - dt);

  if (p.st === 'ko') {
    p.koT -= dt;
    if (p.koT <= 0 && p.lives > 0 && !g.ended) { startSpawn(p); g.sfx('powerup', { vol: 0.6 }); }
    return;
  }
  if (p.st === 'spawn') {
    p.spT += dt;
    const k = clamp(p.spT / 0.7, 0, 1);
    p.y = lerp(-160, SPAWN_Y, 1 - (1 - k) ** 3);
    p.inv = INV;
    if (k >= 1) { p.st = 'plat'; p.platT = 2.5; }
    p.pressQ = 0;
    return;
  }
  if (p.st === 'plat') {
    p.inv = INV; p.platT -= dt;
    const go = Math.abs(inp.sx) > 0.35 || inp.sy > 0.6 || inp.bP || p.pressQ > 0 || p.platT <= 0;
    if (!go) { p.prevSy = inp.sy; return; }
    p.st = 'alive'; p.ground = false; p.jumps = 1; p.vy = 0; p.coyote = 0.12;
  }

  // Mallet timer + its wobbly background music.
  if (p.item === 'hammer') {
    p.hamT -= dt; p.wobT -= dt;
    if (p.wobT <= 0) { p.wobT = 0.5; g.sfx('wobble', { vol: 0.5 }); }
    if (p.hamT <= 0) { p.item = null; g.sfx('pop'); g.burst(p.x, p.y - p.r, { color: '#ffcf3f', n: 10, speed: 200 }); }
  }

  p.dropT = Math.max(0, p.dropT - dt);
  p.dodge = Math.max(0, p.dodge - dt); p.dodgeCd = Math.max(0, p.dodgeCd - dt);
  p.coyote = Math.max(0, p.coyote - dt);
  const mx = Math.abs(inp.sx) > 0.2 ? clamp(inp.sx, -1, 1) : 0;
  const down = inp.sy > 0.6;
  p.prevSy = inp.sy;
  const stun = p.hitstun > 0;

  if (stun) {
    p.hitstun -= dt;
    const k = damp(0.32, dt);
    p.vx *= k; p.vy *= k;
    p.pressQ = 0;
  } else {
    if (p.ak) { p.at += dt; if (p.at >= ATK[p.ak].dur) p.ak = ''; }
    if (p.hold >= 0) {
      if (inp.a && p.hold < HOLD_MAX) p.hold += dt;
      else releaseHold(g, p, inp);
    }
    if (!p.ak && p.hold < 0 && p.pressQ > 0 && p.dodge <= 0) { p.pressQ = 0; pressAttack(s, g, p, inp); }
    const busyGround = p.ground && (!!p.ak || p.hold >= HOLD_MIN || p.dodge > 0);

    if (p.ground) {
      const target = busyGround ? 0 : mx * RUN * (p.item === 'hammer' ? 0.85 : 1);
      const acc = mx && !busyGround && Math.abs(p.vx) <= RUN ? ACC : FRIC;
      p.vx = approach(p.vx, target, acc * dt);
    } else if (mx) {
      const fast = Math.abs(p.vx) > AIRMAX && sign(p.vx) === sign(mx);
      p.vx = approach(p.vx, mx * AIRMAX, (fast ? AIRFRIC : AIRACC) * dt);
    } else {
      p.vx = approach(p.vx, 0, AIRFRIC * dt);
    }
    if (mx && !p.ak && p.hold < HOLD_MIN) p.face = mx > 0 ? 1 : -1;

    // DOWN + B = dodge: intangible for a moment (spot dodge on the ground, air dodge stalls in the air).
    const wantDodge = inp.bP && inp.sy > 0.55 && inp.sy >= Math.abs(inp.sx) * 0.7;
    if (wantDodge && p.dodgeCd <= 0 && !p.ak && p.hold < 0) {
      p.dodge = DODGE_T; p.dodgeCd = DODGE_CD + DODGE_T;
      p.ff = false; p.dropT = 0;
      if (p.ground) p.vx = 0; else { p.vx *= 0.4; p.vy = Math.min(p.vy, 0) * 0.3; }
      g.sfx('whoosh', { pitch: 1.9, vol: 0.5 });
      g.ring(p.x, p.y, { player: p.i, r: p.r * 1.6 });
    } else if (inp.bP && !busyGround && !wantDodge && p.dodge <= 0) {
      // Jump, double jump, coyote (edge) jump.
      if (p.ground || p.coyote > 0) {
        p.vy = -JUMP; p.ground = false; p.coyote = 0;
        g.sfx('jump');
        g.burst(p.x, p.y + p.r, { color: '#ffffff', n: 6, speed: 160 });
      } else if (p.jumps > 0) {
        p.jumps--; p.vy = -DJUMP; p.ff = false;
        g.sfx('jump', { pitch: 1.35 });
        g.ring(p.x, p.y + p.r, { player: p.i, r: 60 });
      }
    }
    // Drop through thin platforms / fast fall.
    if (p.ground && p.onThin && down && !busyGround && p.dodge <= 0) { p.dropT = 0.22; p.ground = false; p.y += 3; }
    if (!p.ground && down && p.vy > -150 && !p.ff && p.dodge <= 0) { p.ff = true; g.sfx('whoosh', { pitch: 1.8, vol: 0.3 }); }
  }

  // Gravity.
  p.vy += GRAV * s.gm * dt;
  if (!stun) {
    if (p.ff) p.vy = Math.max(p.vy, FFALL * gs);
    else p.vy = Math.min(p.vy, FALL * gs);
  }

  // Integrate + collide (x then y).
  const wasGround = p.ground, pvy = p.vy, py = p.y;
  const r = p.r, hw = r * 0.78;
  p.x += p.vx * dt;
  if (p.x + hw > SX0 && p.x - hw < SX1 && p.y + r > STOP && p.y - r < SBOT) {
    if (p.y + r - STOP < r * 0.75) {
      // Feet just below the top: mantle onto the edge.
      p.y = STOP - r; p.vy = Math.min(p.vy, 0);
    } else {
      const left = p.x < SCX;
      p.x = left ? SX0 - hw : SX1 + hw;
      if (s.rubber) {
        // Rubber walls fling you up high.
        p.vx = (left ? -1 : 1) * 350; p.vy = -1350; p.jumps = 1; p.upUsed = false; p.ff = false;
        g.sfx('boing'); g.ring(p.x, p.y, { color: '#ff7ad9', r: 70 });
      } else p.vx = stun ? -p.vx * 0.4 : 0;
    }
  }
  // Ring ropes: bounce back inside.
  if (s.rubber && p.y + r * 0.4 > ROPE_TOP && p.y - r < STOP) {
    if (p.x > ROPE_L && p.x - hw < ROPE_L) {
      p.x = ROPE_L + hw;
      if (p.vx < -60) { p.vx = Math.min(2600, Math.max(-p.vx * 1.15, 650)); s.rope[0] = 1; g.sfx('boing', { pitch: 1.2 }); }
    } else if (p.x < ROPE_R && p.x + hw > ROPE_R) {
      p.x = ROPE_R - hw;
      if (p.vx > 60) { p.vx = -Math.min(2600, Math.max(p.vx * 1.15, 650)); s.rope[1] = 1; g.sfx('boing', { pitch: 1.2 }); }
    }
  }

  p.y += p.vy * dt;
  p.ground = false; p.onThin = false;
  if (p.x + hw > SX0 && p.x - hw < SX1 && p.y + r > STOP && p.y - r < SBOT) {
    if (py + r <= STOP + 1 || p.y < (STOP + SBOT) / 2) { p.y = STOP - r; p.vy = 0; p.ground = true; }
    else { p.y = SBOT + r; if (p.vy < 0) p.vy = stun ? -p.vy * 0.3 : 0; }
  }
  if (!p.ground && p.vy >= 0 && p.dropT <= 0 && !(p.ff && down)) {
    for (const t of THIN) {
      if (p.x > t.x0 - hw * 0.4 && p.x < t.x1 + hw * 0.4 && py + r <= t.y + 1 && p.y + r >= t.y) {
        p.y = t.y - r; p.vy = 0; p.ground = true; p.onThin = true; break;
      }
    }
  }

  if (p.ground && !wasGround) {
    if (stun && pvy > 650) {
      // Tumble: bounce off the floor.
      p.vy = -pvy * 0.45; p.ground = false;
      g.sfx('bonk'); g.burst(p.x, p.y + r, { color: '#fff', n: 10, speed: 260 }); g.shake(0.2);
    } else if (s.rubber && pvy > 450 && !p.onThin) {
      p.vy = -pvy * 0.78; p.ground = false; p.jumps = 1; p.upUsed = false; p.ff = false;
      s.mat = 1;
      g.sfx('boing', { pitch: 0.8 + Math.min(0.6, pvy / 3000) });
    } else {
      p.jumps = 1; p.ff = false; p.upUsed = false; p.landT = 0.14;
      if (stun) p.hitstun = Math.min(p.hitstun, 0.08);
      if (pvy > 500) { g.sfx('land', { vol: 0.6 }); g.burst(p.x, p.y + r, { color: '#d8ccff', n: 6, speed: 180 }); }
    }
  }
  if (wasGround && !p.ground && p.vy >= 0) p.coyote = 0.1;
}

// Damage card position along the top of the screen, in seat order (like the match HUD).
function cardX(i, n) {
  const order = [...Array(Math.max(2, n)).keys()];
  const slot = Math.max(0, order.indexOf(i));
  return 150 + (slot * (W - 300)) / Math.max(1, order.length - 1);
}

export default {
  id: 'smash',
  name: 'Rissa sul Ponte Levatoio',
  rule: 'Mena gli altri e buttali giù dal ponte nel fossato!',
  verb: 'MENA!',
  inspired: 'Super Smash Bros',
  cam: 'side',
  split: false,
  players: 4,
  world: { w: W, h: H },
  controls: { dir: 'free', a: 'Attacco', b: 'Salto' },
  help: {
    goal: 'Butta gli avversari giù dal ponte 2 volte: più danni (%) hanno, più volano lontano. Vince l\'ultimo in piedi.',
    dir: 'Corri e sterza in aria. ▼ a terra scende dalle impalcature, in aria cade veloce.',
    a: 'ATTACCO: tocco = colpo (▲ montante, ▼ in aria schiacciata). Tieni premuto e lascia = SBAM caricato. Con maglio o bombarda: colpisci / lancia.',
    b: 'SALTO (anche doppio in aria). ▼ + B = SCHIVATA: per un attimo sei intoccabile.',
    tips: ['Il montante ▲+A in aria ti fa risalire se stai cadendo', 'Chi ha perso una vita va in FURIA 🔥 e picchia più forte', 'Dal secondo 45 ASSEDIO: tutti partono da 150% e piovono bombarde'],
  },
  duration: 60,
  supports: ['gravity', 'scale'],
  variants: [
    { id: 'martelli', name: 'Pioggia di Magli', desc: 'Solo magli da fabbro: ne cade uno ogni 3 secondi!' },
    { id: 'bombe', name: 'Assedio!', desc: "Le catapulte bombardano il ponte di continuo: occhio all'ombra!" },
    { id: 'gommoso', name: 'Giostra di Paglia', desc: 'Corde e paglia elastiche: si vola altissimi!' },
  ],

  init(g) {
    const n = g.n || 2;
    const sc = g.mods.scale || Array(n).fill(1);
    const gm = g.mods.gravity || 1;
    return {
      n,
      p: [...Array(n).keys()].map((i) => makePlayer(i, sc[i] ?? 1, n)),
      gm, gs: Math.sqrt(gm),
      rubber: g.variant === 'gommoso',
      kbMul: g.variant === 'gommoso' ? 1.5 : 1,
      crates: [], items: [], bombs: [], booms: [], kos: [],
      crateT: 5, hamDropT: 1.5, rainT: 2,
      sd: false, last: -1, tick: 0, cheer: 0, mat: 0, rope: [0, 0],
    };
  },

  step(s, inp, g) {
    const dt = g.dt;
    const G = GRAV * s.gm;
    s.tick++;

    // Sudden death: the siege.
    if (!s.sd && g.t >= SD_T && !g.ended) {
      s.sd = true;
      for (const p of s.p) p.dmg = Math.max(p.dmg, 150);
      g.say('ASSEDIO! MORTE IMPROVVISA!', { big: true });
      g.sfx('horn'); g.flash('#ff3030', 0.5); g.shake(0.4);
      s.rainT = 0.6;
    }

    // Spawners: crates, mallet rain, bomb rain.
    if (!g.ended) {
      if (g.variant !== 'martelli') {
        s.crateT -= dt;
        if (s.crateT <= 0) {
          s.crateT = g.rng.range(7, 9);
          if (s.crates.length < 2) {
            s.crates.push({ x: g.rng.range(SX0 + 80, SX1 - 80), y: -100, vy: 0, life: 15 });
            g.sfx('whoosh', { pitch: 0.7 });
          }
        }
      } else {
        s.hamDropT -= dt;
        if (s.hamDropT <= 0) {
          s.hamDropT = 3;
          if (s.items.length < 5) {
            s.items.push({ k: 'hammer', x: g.rng.range(SX0 + 60, SX1 - 60), y: -80, vx: 0, vy: 200, life: 12, fuse: 0 });
            g.sfx('whoosh', { pitch: 0.6 });
          }
        }
      }
      if (g.variant === 'bombe' || s.sd) {
        s.rainT -= dt;
        if (s.rainT <= 0) {
          s.rainT = s.sd ? g.rng.range(0.45, 0.75) : g.rng.range(0.8, 1.4);
          let x = g.rng.range(SX0 - 80, SX1 + 80);
          const alive = s.p.filter((p) => p.st === 'alive');
          if (s.sd && alive.length && g.rng.chance(0.6)) x = clamp(g.rng.pick(alive).x + g.rng.range(-130, 130), SX0 - 80, SX1 + 80);
          s.bombs.push({ x, y: -140, vx: 0, vy: 250, own: -1, t: 0, rain: true });
        }
      }
    }

    for (const p of s.p) updatePlayer(s, g, p, inp[p.i], dt);

    // Soft body push between fighters (every pair).
    for (let x = 0; x < s.n; x++) {
      for (let y = x + 1; y < s.n; y++) {
        const a = s.p[x], b = s.p[y];
        if (a.st !== 'alive' || b.st !== 'alive') continue;
        const dx = b.x - a.x, minx = (a.r + b.r) * 0.7;
        if (Math.abs(dx) < minx && Math.abs(b.y - a.y) < (a.r + b.r) * 0.6) {
          const dir = dx !== 0 ? sign(dx) : s.tick % 2 ? 1 : -1;
          const push = Math.min(minx - Math.abs(dx), 500 * dt) * 0.5;
          a.x -= dir * push; b.x += dir * push;
        }
      }
    }

    // Combat: gather hits first so trades are fair, then apply.
    const hits = [];
    const toBoom = [];
    for (const p of s.p) {
      if (p.st !== 'alive' || !p.ak) continue;
      const hb = hitbox(p);
      if (!hb) continue;
      for (const q of s.p) {
        if (q === p) continue;
        const bit = 1 << q.i;
        if (!(p.ahit & bit) && q.st === 'alive' && q.inv <= 0 && dist(hb.x, hb.y, q.x, q.y) < hb.r + q.r * 0.85) {
          if (q.dodge > 0) {
            // Clean dodge: the attack whiffs, the dodger gets a free moment.
            p.ahit |= bit;
            g.text(q.x, q.y - q.r - 60, 'SCHIVATA!', { player: q.i, size: 46 });
            g.sfx('whoosh', { pitch: 0.7 }); g.slowmo(0.5, 0.25);
          } else hits.push([p, q, p.ak, p.apw]);
        }
      }
      for (const c of s.crates) if (!c.dead && circleRect(hb.x, hb.y, hb.r, c.x - CRATE_H, c.y - CRATE_H, CRATE_H * 2, CRATE_H * 2)) breakCrate(s, g, c);
      for (const o of s.items) if (!o.dead && o.k === 'bomb' && dist(hb.x, hb.y, o.x, o.y) < hb.r + ITEM_R) { o.dead = true; toBoom.push([o.x, o.y, p.i]); }
    }
    for (const [p, q, ak, pw] of hits) { p.ahit |= 1 << q.i; strike(s, g, p, q, ak, pw); }
    for (const [x, y, own] of toBoom) explode(s, g, x, y, 1, own, false);

    // Crates.
    for (const c of s.crates) {
      if (c.dead) continue;
      c.life -= dt;
      const py = c.y;
      c.vy = Math.min(c.vy + G * dt, 1400);
      c.y += c.vy * dt;
      const fast = c.vy > 500;
      if (landObj(c, CRATE_H, py) && fast) { g.sfx('land', { pitch: 0.7 }); g.burst(c.x, c.y + CRATE_H, { color: '#d8ccff', n: 8, speed: 200 }); }
      if (c.y > BB || c.life <= 0) {
        if (c.life <= 0) g.burst(c.x, c.y, { color: '#c98a3b', n: 8, speed: 160 });
        c.dead = true;
      }
    }

    // Items: physics, fuses, pickup (pickup priority rotates every tick).
    const order = s.p.map((_, k) => s.p[(k + s.tick) % s.n]);
    for (const o of s.items) {
      if (o.dead) continue;
      o.life -= dt;
      const py = o.y;
      o.vy = Math.min(o.vy + G * dt, 1400);
      o.x += o.vx * dt; o.y += o.vy * dt;
      if (landObj(o, ITEM_R, py)) o.vx = 0;
      if (o.fuse > 0) { o.fuse -= dt; if (o.fuse <= 0) { o.dead = true; explode(s, g, o.x, o.y, 1, -1, false); continue; } }
      if (o.y > BB || o.life <= 0) { o.dead = true; continue; }
      for (const p of order) {
        if (p.st !== 'alive' || p.hitstun > 0 || p.item || p.hold >= 0) continue;
        if (dist(p.x, p.y, o.x, o.y) < p.r + ITEM_R) {
          o.dead = true;
          p.item = o.k;
          if (o.k === 'hammer') { p.hamT = 5; p.wobT = 0; g.say('MAGLIO!'); g.sfx('powerup'); }
          else g.sfx('pickup');
          g.burst(o.x, o.y, { color: o.k === 'hammer' ? '#ffcf3f' : '#ff6b3d', n: 12, speed: 260 });
          g.vibrate(p.i, 50);
          break;
        }
      }
    }

    // Live bombs (thrown or raining): explode on contact with anything.
    for (const bo of s.bombs) {
      if (bo.dead) continue;
      bo.t += dt;
      const py = bo.y;
      bo.vy = Math.min(bo.vy + G * dt * (bo.rain ? 0.7 : 1), 1500);
      bo.vx *= damp(0.8, dt);
      bo.x += bo.vx * dt; bo.y += bo.vy * dt;
      let boom = landObj(bo, BOMB_R, py) || circleRect(bo.x, bo.y, BOMB_R, SX0, STOP, SX1 - SX0, SBOT - STOP);
      if (!boom) {
        for (const q of s.p) {
          if (q.st !== 'alive' || (q.i === bo.own && bo.t < 0.3)) continue;
          if (dist(q.x, q.y, bo.x, bo.y) < q.r + BOMB_R) { boom = true; break; }
        }
      }
      if (!boom) for (const c of s.crates) if (!c.dead && circleRect(bo.x, bo.y, BOMB_R, c.x - CRATE_H, c.y - CRATE_H, CRATE_H * 2, CRATE_H * 2)) { boom = true; break; }
      if (boom) { bo.dead = true; explode(s, g, bo.x, bo.y, bo.rain ? 0.9 : 1, bo.own, bo.t < 0.35); continue; }
      if (bo.y > BB || bo.x < BL - 200 || bo.x > BR + 200) bo.dead = true;
    }

    s.crates = s.crates.filter((c) => !c.dead);
    s.items = s.items.filter((o) => !o.dead);
    s.bombs = s.bombs.filter((bo) => !bo.dead);

    // Blast zones.
    if (!g.ended) {
      for (const p of s.p) {
        if (p.st !== 'alive') continue;
        const out = p.x < BL || p.x > BR || p.y > BB || (p.y < BT && (p.hitstun > 0 || p.y < BT - 300));
        if (out) { ko(s, g, p); if (g.ended) break; }
      }
    }

    // Effect timers.
    for (const bm of s.booms) bm.t += dt;
    for (const k of s.kos) k.t += dt;
    s.booms = s.booms.filter((bm) => bm.t < 0.4);
    s.kos = s.kos.filter((k) => k.t < 1.1);
    s.cheer = Math.max(0, s.cheer - dt);
    s.mat = Math.max(0, s.mat - dt * 2.5);
    s.rope[0] = Math.max(0, s.rope[0] - dt * 2); s.rope[1] = Math.max(0, s.rope[1] - dt * 2);
  },

  timeout(s, g) {
    // Most lives, then least damage, then the last one who landed a hit, then a coin toss.
    const top = Math.max(...s.p.map((p) => p.lives));
    let c = s.p.filter((p) => p.lives === top);
    if (c.length === 1) return c[0].i;
    const low = Math.min(...c.map((p) => Math.floor(p.dmg)));
    c = c.filter((p) => Math.floor(p.dmg) === low);
    if (c.length === 1) return c[0].i;
    if (c.some((p) => p.i === s.last)) return s.last;
    return c[g.rng.int(0, c.length - 1)].i;
  },

  view(s) {
    return {
      p: s.p.map((p) => {
        const A = ATK[p.ak];
        return {
          x: r1(p.x), y: r1(p.y), r: r1(p.r), f: p.face, d: Math.floor(p.dmg),
          s: p.st === 'alive' ? 0 : p.st === 'ko' ? (p.lives <= 0 && p.koT <= 0 ? 3 : 1) : 2,
          k: AK.indexOf(p.ak), a: A ? r2(clamp(p.at / A.dur, 0, 1)) : 0,
          c: p.hold >= HOLD_MIN ? r2(clamp((p.hold - HOLD_MIN) / 0.9, 0.05, 1)) : 0,
          fl: r2(p.flash), iv: p.inv > 0 ? 1 : 0, hs: p.hitstun > 0 ? 1 : 0,
          it: p.item === 'hammer' ? 1 : p.item === 'bomb' ? 2 : 0, ht: r1(p.hamT),
          g: p.ground ? 1 : 0, l: r2(p.landT), vy: Math.round(p.vy), vx: Math.round(p.vx), hp: p.happy > 0 ? 1 : 0,
          dg: p.dodge > 0 ? 1 : 0,
        };
      }),
      cr: s.crates.map((c) => [r1(c.x), r1(c.y), c.life < 2 ? 1 : 0]),
      it: s.items.map((o) => [o.k === 'hammer' ? 1 : 2, r1(o.x), r1(o.y), o.life < 2 ? 1 : 0, o.fuse > 0 ? 1 : 0]),
      bo: s.bombs.map((bo) => [r1(bo.x), r1(bo.y), bo.rain ? 1 : 0]),
      bm: s.booms.map((bm) => [r1(bm.x), r1(bm.y), r2(bm.t)]),
      ko: s.kos.map((k) => [r1(k.x), r1(k.y), k.i, r2(k.t)]),
      sd: s.sd ? 1 : 0, rb: s.rubber ? 1 : 0, mt: r2(s.mat), rp: [r2(s.rope[0]), r2(s.rope[1])], ch: r2(s.cheer),
      rg: s.p.map((p) => (p.lives > 0 && p.lives < Math.max(...s.p.filter((q) => q !== p).map((q) => q.lives)) ? 1 : 0)),
      hud: { p: s.p.map((p) => p.lives), max: LIVES, label: 'Vite' },
    };
  },

  focus(v) {
    return v.p.map((p) => ({ x: clamp(p.x, 0, W), y: clamp(p.y, 0, H) }));
  },

  render3d: {
    assets: [
      'medieval/mountain_A_grass_trees', 'medieval/mountain_B_grass_trees', 'medieval/mountain_C_grass_trees', 'medieval/hills_A_trees', 'medieval/hills_B_trees',
      'medieval/building_castle_red', 'medieval/building_tower_A_blue', 'medieval/building_tower_A_yellow', 'medieval/building_tower_B_red', 'medieval/building_tower_B_blue',
      'medieval/wall_straight', 'medieval/wall_straight_gate', 'medieval/trees_A_large', 'medieval/trees_B_large', 'medieval/tree_single_A', 'medieval/tree_single_B',
      'medieval/tent', 'medieval/flag_red', 'medieval/flag_blue', 'medieval/flag_green', 'medieval/flag_yellow', 'medieval/building_market_red', 'medieval/building_market_blue',
      'medieval/building_stage_B', 'medieval/building_archeryrange_red', 'medieval/target', 'medieval/cloud_big', 'medieval/cloud_small', 'medieval/crate_A_big',
      'medieval/waterlily_A', 'medieval/waterplant_B', 'dungeon/torch_lit', 'dungeon/banner_patternA_red', 'dungeon/banner_patternA_blue',
    ],
    // Gentle camera follow: the far scenery (at different depths) slides with parallax.
    cam: {
      target(v) {
        let sx = 0, sy = 0, n = 0;
        for (const p of v.p) { const st = Math.round(p.s); if (st !== 1 && st !== 3) { sx += clamp(p.x, 0, W); sy += clamp(p.y, 0, H); n++; } }
        CAM_T.x = W / 2 + (n ? clamp((sx / n - W / 2) * 0.07, -32, 32) : 0);
        CAM_T.y = H / 2 + (n ? clamp((sy / n - H / 2) * 0.05, -18, 18) : 0);
        return CAM_T;
      },
    },
    build(K) {
      const T3 = K.THREE;
      const n = Math.max(2, K.n || 2), lo = K.quality === 0;
      const o = { n };
      // --- sunset over the castle moat ---
      K.theme('tramonto', { fogNear: 1.7, fogFar: 4.6 });
      o.sunCol = K.sun ? K.sun.color.clone() : null;
      o.hemiCol = K.hemi ? K.hemi.color.clone() : null;
      o.siegeC = new T3.Color('#ff4a2a');
      const sunM = K.glow('#ffd79a', { opacity: 0.95 }); sunM.fog = false;
      K.place(K.ball(330, sunM, { cast: false }), SCX + 1500, 520, -6500);
      const sunH = K.glow('#ff9a5a', { opacity: 0.22, add: true }); sunH.fog = false;
      K.place(K.ball(700, sunH, { cast: false }), SCX + 1500, 520, -6600);
      // Horizontal planes (side cam: three Y = -world y, Z = depth).
      const hplane = (x0, x1, z0, z1, y, mat) => {
        const me = K.mesh(new T3.PlaneGeometry(x1 - x0, z0 - z1).rotateX(-Math.PI / 2), mat, { cast: false });
        me.userData.ownGeo = true;
        me.position.set((x0 + x1) / 2, -y, (z0 + z1) / 2);
        return me;
      };
      // Far bank (grass) and the moat (animated water) in front of it.
      hplane(-3800, 5000, -880, -6000, 832, K.texMat('erba', [44, 26], { color: '#b9c98a' }));
      const wtex = K.tex('acqua', { rep: [30, 6], seed: 5 });
      const wm = new T3.MeshStandardMaterial({ map: wtex, color: '#cfe8ff', roughness: 0.18, metalness: 0.15, transparent: true, opacity: 0.92, emissive: '#0a3a5a', emissiveIntensity: 0.3 });
      hplane(-3800, 5000, 900, -880, 852, wm);
      K.ticks.push((dt, t) => { if (wtex) { wtex.offset.x = (t * 0.01) % 1; wtex.offset.y = (t * 0.025) % 1; } });
      // Stone quay along the far bank.
      K.place(K.box(8800, 40, 60, K.texMat('muro', [110, 0.6], { color: '#b8ab98' })), SCX, 852, -880);
      // Mountains, hills and the castle.
      const mts = [];
      for (let k = 0; k < (lo ? 6 : 10); k++) mts.push({ x: -2100 + k * 560 + (k % 2) * 140, y: 840, h: -2900 - (k % 3) * 260, rot: k * 1.3, s: 0.85 + (k % 4) * 0.12 });
      ['medieval/mountain_A_grass_trees', 'medieval/mountain_B_grass_trees', 'medieval/mountain_C_grass_trees'].forEach((m, q) => K.scatter(m, mts.filter((_, k) => k % 3 === q), { size: 820 }));
      const hills = [];
      for (let k = 0; k < (lo ? 5 : 9); k++) hills.push({ x: -1700 + k * 520, y: 836, h: -2200 - (k % 2) * 250, rot: k * 2.1, s: 0.9 + (k % 3) * 0.15 });
      K.scatter('medieval/hills_A_trees', hills.filter((_, k) => k % 2 === 0), { size: 560 });
      K.scatter('medieval/hills_B_trees', hills.filter((_, k) => k % 2 === 1), { size: 520 });
      const castle = K.model('medieval/building_castle_red', { height: 1150 });
      K.place(castle, SCX + 80, 834, -1900);
      castle.rotation.y = 0.35;
      K.scatter('medieval/building_tower_A_blue', [{ x: SCX - 820, y: 834, h: -1700, rot: 0.4 }], { height: 640 });
      K.scatter('medieval/building_tower_A_yellow', [{ x: SCX + 980, y: 834, h: -1700, rot: -0.4 }], { height: 640 });
      const walls = [];
      for (let k = -4; k <= 4; k++) if (k) walls.push({ x: SCX + 80 + k * 400, y: 834, h: -1600 });
      K.scatter('medieval/wall_straight', walls, { size: 400 });
      K.scatter('medieval/wall_straight_gate', [{ x: SCX + 80, y: 834, h: -1600 }], { size: 400 });
      // Tournament camp on the far bank: tents, flags, market stalls, archery range.
      const tents = [{ x: -380, y: 834, h: -1080, rot: 0.3 }, { x: 70, y: 834, h: -1250, rot: 1.2 }, { x: 1340, y: 834, h: -1150, rot: -0.2 }, { x: 1750, y: 834, h: -1030, rot: 0.8 }];
      K.scatter('medieval/tent', tents, { size: 200 });
      ['red', 'blue', 'green', 'yellow'].forEach((c, k) => K.scatter(`medieval/flag_${c}`, [{ x: tents[k].x, y: 834 - 190, h: tents[k].h, rot: Math.PI / 2 }, { x: -760 + k * 860, y: 834, h: -960, rot: Math.PI / 2 }], { height: 180 }));
      K.scatter('medieval/building_market_red', [{ x: 520, y: 834, h: -1150, rot: 0.15 }], { size: 300 });
      K.scatter('medieval/building_market_blue', [{ x: 2150, y: 834, h: -1250, rot: -0.3 }], { size: 300 });
      K.scatter('medieval/building_stage_B', [{ x: 940, y: 834, h: -1080 }], { size: 260 });
      K.scatter('medieval/building_archeryrange_red', [{ x: -980, y: 834, h: -1250, rot: 0.5 }], { size: 340 });
      K.scatter('medieval/target', [{ x: -700, y: 834, h: -1000 }, { x: -620, y: 834, h: -1040 }], { height: 70 });
      const trees = [];
      for (let k = 0; k < (lo ? 8 : 16); k++) trees.push({ x: -1500 + k * 260 + (k % 3) * 60, y: 834, h: -1350 - (k % 4) * 90, rot: k, s: 0.8 + (k % 5) * 0.12 });
      K.scatter('medieval/tree_single_A', trees.filter((_, k) => k % 2 === 0), { height: 330 });
      K.scatter('medieval/tree_single_B', trees.filter((_, k) => k % 2 === 1), { height: 300 });
      K.scatter('medieval/trees_A_large', [{ x: -1400, y: 834, h: -1900 }, { x: 2600, y: 834, h: -1900, rot: 2 }], { size: 600 });
      K.scatter('medieval/waterlily_A', [{ x: -260, y: 852, h: -300 }, { x: 1550, y: 852, h: -420, rot: 1 }, { x: 1700, y: 852, h: -160, rot: 2 }, { x: -480, y: 852, h: -620 }], { size: 90 });
      // Clouds drifting.
      o.clouds = [0, 1, 2].map((k) => ({ g: softCloud(K, K.model(k === 1 ? 'medieval/cloud_small' : 'medieval/cloud_big', { size: 620 - k * 80, cast: false })), x: -900 + k * 1100, y: -120 + k * 70, z: -2700 - k * 300, v: 14 + k * 6 }));
      // Bridge towers rising out of the moat, at both ends of the bridge.
      for (const [x, c, rot] of [[SX0 - 210, 'red', 0.5], [SX1 + 210, 'blue', -0.5]]) {
        const foot = K.mesh(new T3.CylinderGeometry(118, 132, 70, 16), K.texMat('muro', [3, 0.5], { color: '#a99c88' }));
        foot.userData.ownGeo = true;
        K.place(foot, x, 835, -560);
        const tw = K.model(`medieval/building_tower_B_${c}`, { height: 700 });
        K.place(tw, x, 800, -560);
        tw.rotation.y = rot;
      }
      // --- the stone bridge (main stage) ---
      const SW = SX1 - SX0, SD = 240;
      o.SD = SD;
      K.place(K.box(SW, SBOT - STOP, SD, K.texMat('muro', [SW / 110, 1], { color: '#cbbca6' })), SCX, (STOP + SBOT) / 2, 0);
      o.trim = K.box(SW + 16, 16, SD + 16, K.texMat('legno', [SW / 70, 2], { color: '#e0b98c' }));
      K.place(o.trim, SCX, STOP + 6, 0);
      K.place(K.box(SW + 18, 5, 5, K.mat('#4a3a2a', { metal: 0.4, rough: 0.5 })), SCX, STOP - 1, SD / 2 + 9);
      // Arch under the bridge + piers down into the moat.
      const archM = K.texMat('muro', [1 / 95, 1 / 95], { color: '#b5a690' });
      const under = K.prism([SX0 + 20, SBOT - 4, SX1 - 20, SBOT - 4, SX1 - 60, SBOT + 70, SX1 - 200, SBOT + 70, SCX + 200, SBOT + 40, SCX, SBOT + 30, SCX - 200, SBOT + 40, SX0 + 200, SBOT + 70, SX0 + 60, SBOT + 70], SD - 40, archM, { bevel: 4 });
      K.place(under, 0, 0, -(SD - 40) / 2);
      for (const x of [SX0 + 130, SX1 - 130]) K.place(K.box(130, 870 - SBOT - 60, SD - 60, archM), x, (SBOT + 60 + 870) / 2, 0);
      // Front face: painted stone blocks with heraldic shields.
      K.layer({ x0: SX0, x1: SX1, y0: STOP + 14, y1: SBOT, h: -(SD / 2 + 0.6), transparent: true, once: true, maxPx: 1024, draw: (d) => drawStageFront3d(d) });
      // Crenellated parapet at the back of the bridge (behind the fighters).
      const pts = [SX0, STOP];
      for (let x = SX0; x < SX1 - 10; x += 94) { pts.push(x, STOP - 46, x + 52, STOP - 46, x + 52, STOP - 26, Math.min(SX1, x + 94), STOP - 26); }
      pts.push(SX1, STOP - 46, SX1, STOP);
      K.place(K.prism(pts, 26, K.texMat('muro', [1 / 80, 1 / 80], { color: '#d1c3ad' }), { bevel: 2 }), 0, 0, -SD / 2 - 2);
      // Torches on the parapet.
      const torchX = lo ? [SCX] : [SX0 + 50, SCX, SX1 - 50];
      K.scatter('dungeon/torch_lit', [SX0 + 50, SCX, SX1 - 50].map((x) => ({ x, y: STOP - 46, h: -SD / 2 + 12 })), { height: 74 });
      for (const x of torchX) K.light(x, STOP - 140, -SD / 2 + 60, '#ffa04a', 1.3, { flicker: 0.55, dist: 620 });
      // Wooden scaffolds (thin pass-through platforms): plank deck, posts behind, banners hanging below.
      const plank = K.texMat('legno', [3, 2], { color: '#d6a874' });
      const postM = K.mat('#6b4426', { rough: 0.8 });
      THIN.forEach((t, k) => {
        const w = t.x1 - t.x0, cx = (t.x0 + t.x1) / 2;
        K.place(K.box(w, 16, 170, plank), cx, t.y + 4, 0);
        K.place(K.box(w + 6, 6, 6, K.glow('#ffe2a8')), cx, t.y - 4, 86);
        K.place(K.box(w + 6, 5, 6, K.mat('#3a2a1a', { metal: 0.3 })), cx, t.y + 11, 86);
        for (const x of [t.x0 + 18, t.x1 - 18]) K.place(K.box(12, STOP - t.y - 12, 12, postM), x, (t.y + 12 + STOP) / 2, -74);
        const br = K.box(Math.hypot(w - 36, STOP - t.y - 12) * 0.98, 8, 8, postM);
        K.place(br, cx, (t.y + STOP) / 2, -80); br.rotation.z = (k ? 1 : -1) * Math.atan2(STOP - t.y - 12, w - 36);
        const ban = K.model(`dungeon/banner_patternA_${k ? 'blue' : 'red'}`, { height: 104 });
        K.place(ban, cx, t.y + 14 + 104, -60);
      });
      // Hay joust ring (gommoso): straw mat in heraldic stripes, wooden posts, hemp ropes.
      o.ring = K.group();
      o.mat = [];
      for (let k = 0; k < 10; k++) o.mat.push(K.box(SW / 10 + 1, 22, SD + 18, K.mat(k % 2 ? '#c8352f' : '#f2c94c', { rough: 0.85 }), { parent: o.ring }));
      const pg = new T3.CylinderGeometry(8, 8, STOP - ROPE_TOP, 10); pg.translate(0, -(STOP - ROPE_TOP) / 2, 0);
      for (const x of [ROPE_L, ROPE_R]) for (const z of [-SD / 2 + 14, SD / 2 - 14]) {
        K.place(K.mesh(pg, K.mat('#7a5230', { rough: 0.8 }), { parent: o.ring }), x, ROPE_TOP, z);
        K.place(K.ball(13, K.mat('#e2b04a', { rough: 0.3, metal: 0.6 }), { parent: o.ring }), x, ROPE_TOP, z);
      }
      const ropeMat = K.mat('#d9b26a', { rough: 0.9 });
      const bg = new T3.CylinderGeometry(4, 4, ROPE_R - ROPE_L, 8); bg.rotateZ(Math.PI / 2);
      for (let k = 0; k < 3; k++) K.place(K.mesh(bg, ropeMat, { parent: o.ring }), SCX, ROPE_TOP + 15 + k * 40, -SD / 2 + 14);
      o.ropes = [[], []];
      for (let s2 = 0; s2 < 2; s2++) for (let k = 0; k < 3; k++) o.ropes[s2].push(K.cyl(5, SD - 28, ropeMat, { center: true, parent: o.ring, seg: 10 }));
      // --- crates (KayKit crate + a gold "?" plate) ---
      o.crates = [];
      for (let k = 0; k < 3; k++) {
        const c = K.model('medieval/crate_A_big', { size: CRATE_H * 2 });
        const q = K.emoji('❓', 40, { parent: c });
        q.position.set(0, CRATE_H, CRATE_H + 4);
        o.crates.push(c);
      }
      // --- items, bombs, warnings, explosions, KO beams ---
      o.items = [];
      for (let k = 0; k < 6; k++) o.items.push({ ham: makeHammer3d(K), bomb: makeBomb3d(K, o) });
      o.bombs = [];
      for (let k = 0; k < 14; k++) o.bombs.push(makeBomb3d(K, o));
      o.warn = [];
      for (let k = 0; k < 10; k++) {
        const sh = K.disc(1, K.glow('#000000', { opacity: 0.4 }));
        const rg = K.disc(1, K.glow('#ff4040'), { r0: 0.86 });
        sh.rotation.x = rg.rotation.x = -Math.PI / 2;
        o.warn.push([sh, rg]);
      }
      o.booms = [];
      for (let k = 0; k < 4; k++) {
        o.booms.push([
          K.ball(1, K.glow('#ffbe46', { add: true, unique: true }), { cast: false }),
          K.ball(1, K.glow('#ffffdc', { add: true, unique: true }), { cast: false }),
          K.torus(1, 0.05, K.glow('#ff5a28', { add: true, unique: true }), { cast: false }),
        ]);
      }
      o.beams = [];
      const beamPts = (wa, wb) => [0, -wa, 1, -wb, 1, wb, 0, wa];
      for (let k = 0; k < 2; k++) {
        o.beams.push([
          K.prism(beamPts(0.03, 0.22), 1, K.glow('#ffffff', { add: true, unique: true }), { cast: false }),
          K.prism(beamPts(0.012, 0.077), 1, K.glow('#ffffff', { add: true, unique: true }), { cast: false }),
        ]);
      }
      // Siege light (sudden death).
      o.siege = K.light(SCX, -200, 300, '#ff3a1a', 0, { dist: 2400 });
      K.ambient('foglie', { n: lo ? 20 : 40, h: 300 });
      // --- fighters ---
      o.pl = [...Array(n).keys()].map((i) => {
        const P = {
          av: K.avatar(i),
          ham: makeHammer3d(K),
          bomb: makeBomb3d(K, o),
          charge: K.ball(1, K.glow(K.col(i, 'light'), { opacity: 0.3, add: true }), { cast: false }),
          flash: K.ball(1, K.glow('#ffffff', { opacity: 0.45, add: true }), { cast: false }),
          slash: K.torus(1, 0.09, K.glow(K.col(i, 'light'), { opacity: 0.85, add: true }), { arc: Math.PI * 0.9, cast: false }),
          slash2: K.torus(1, 0.04, K.glow('#ffffff', { opacity: 0.9, add: true }), { arc: Math.PI * 0.9, cast: false }),
          trail: [0.26, 0.18, 0.1].map((a) => K.ball(1, K.glow(K.col(i, 'light'), { opacity: a, add: true }), { cast: false })),
          dodge: K.torus(1, 0.06, K.glow('#ffffff', { opacity: 0.85 }), { cast: false }),
          halo: K.box(170, 12, 130, K.glow(K.col(i, 'light'), { opacity: 0.8 }), { cast: false }),
          timer: K.billboard(96, 96, 46, (d, w, h, nn) => { if (nn) d.text('' + nn, w / 2, h / 2 + 4, { size: 70, color: '#ffcf3f' }); }),
          lastN: -1, atkN: 0, lastK: '', lastA: 0,
          ind: K.decal(220, { px: K.quality > 0 ? 256 : 160 }),
          card: K.layer({ x0: cardX(i, n) - 150, x1: cardX(i, n) + 150, y0: 0, y1: 130, h: 0, transparent: true, lit: false, z: 6, maxPx: 512,
            draw: (d, v) => { if (v.p[i]) drawDamageCard(d, v.p[i], i, K.t, v.rg ? v.rg[i] : 0, n); },
            key: (v) => { const p = v.p[i]; if (!p) return '-'; const rg = v.rg ? v.rg[i] : 0; return `${Math.round(p.s)}|${p.d}|${p.hs}|${rg}|${p.fl > 0 || rg ? Math.floor(K.t * 30) : 0}`; } }),
        };
        P.all = [P.ham, P.bomb.g, P.charge, P.flash, P.slash, P.slash2, ...P.trail, P.dodge, P.halo, P.timer];
        for (const m of [P.ind.mesh, P.card.mesh]) { m.material.depthTest = false; m.renderOrder = 30; }
        P.timer.material.depthTest = false; P.timer.renderOrder = 31;
        return P;
      });
      return o;
    },

    update(K, o, v) {
      const T = K.t;
      // Clouds.
      for (const c of o.clouds) K.place(c.g, ((c.x + T * c.v + 2400) % 4800) - 1800, c.y, c.z);
      // Siege: the sky turns red.
      if (K.sun && o.sunCol) {
        const sd = v.sd ? 1 : 0;
        K.sun.color.copy(o.sunCol).lerp(o.siegeC, sd * 0.7);
        if (o.hemiCol) K.hemi.color.copy(o.hemiCol).lerp(o.siegeC, sd * 0.5);
        o.siege.intensity = sd * (1.2 + 0.4 * Math.sin(T * 5));
      }
      // Hay ring.
      const rb = !!v.rb;
      o.ring.visible = rb;
      o.trim.visible = !rb;
      if (rb) {
        const wob = Math.sin(T * 30) * 8 * v.mt, SW = SX1 - SX0;
        o.mat.forEach((m, k) => K.place(m, SX0 + ((k + 0.5) * SW) / 10, STOP + 8 + wob * Math.sin((k / 9) * Math.PI), 0));
        for (let s2 = 0; s2 < 2; s2++) {
          const x = s2 ? ROPE_R : ROPE_L;
          const wb = Math.sin(T * 40) * 22 * v.rp[s2] * (s2 ? 1 : -1);
          o.ropes[s2].forEach((r, k) => K.place(r, x + wb * Math.sin(((k + 1) / 4) * Math.PI), ROPE_TOP + 15 + k * 40, 0));
        }
      }
      // Crates.
      o.crates.forEach((c, k) => {
        const cr = v.cr[k];
        c.visible = !!cr && !(cr[2] && Math.floor(T * 8) % 2);
        if (c.visible) { K.place(c, cr[0], cr[1] + CRATE_H, 0); c.rotation.y = Math.sin(T * 1.5 + k) * 0.25; }
      });
      // Items on the ground.
      o.items.forEach((it, k) => {
        const e = v.it[k];
        const vis = !!e && !(e[3] && Math.floor(T * 8) % 2);
        const ham = vis && Math.round(e[0]) === 1;
        it.ham.visible = ham;
        it.bomb.g.visible = vis && !ham;
        if (!vis) return;
        if (ham) {
          K.place(it.ham, e[1] - 42, e[2] - 10 + Math.sin(T * 4 + k) * 4, 0);
          K.face(it.ham, 0.2);
          it.ham.rotation.y = Math.sin(T * 2 + k) * 0.6;
          it.ham.scale.setScalar(0.9);
        } else setBomb3d(K, o, it.bomb, e[1], e[2], ITEM_R, e[4] ? 3 : 1, 0);
      });
      // Live bombs + falling-bomb warnings on the floor below.
      let wn = 0;
      o.bombs.forEach((b, k) => {
        const e = v.bo[k];
        b.g.visible = !!e;
        if (!e) return;
        setBomb3d(K, o, b, e[0], e[1], BOMB_R, e[2] ? 2 : 1.5, T * 8);
        if (e[2] && wn < o.warn.length) {
          const sy = surfaceBelow(e[0], e[1]);
          if (sy !== null) {
            const kk = clamp(1 - (sy - e[1]) / 900, 0.25, 1);
            const [sh, rg] = o.warn[wn++];
            sh.visible = true; rg.visible = Math.floor(T * 10) % 2 === 1;
            K.place(sh, e[0], sy - 1, 0); sh.scale.set(44 * kk, 44 * kk, 1);
            K.place(rg, e[0], sy - 2, 0); rg.scale.set(42 * kk, 42 * kk, 1);
          }
        }
      });
      for (; wn < o.warn.length; wn++) o.warn[wn][0].visible = o.warn[wn][1].visible = false;
      // Explosions.
      o.booms.forEach((b, k) => {
        const e = v.bm[k];
        for (const m of b) m.visible = !!e;
        if (!e) return;
        const kk = clamp(e[2] / 0.4, 0, 1);
        K.place(b[0], e[0], e[1], 0); b[0].scale.setScalar(ER * (0.35 + 0.65 * kk)); b[0].material.opacity = 0.85 * (1 - kk);
        K.place(b[1], e[0], e[1], 0); b[1].scale.setScalar(ER * (0.2 + 0.4 * kk)); b[1].material.opacity = 0.9 * (1 - kk);
        K.place(b[2], e[0], e[1], 30); b[2].scale.setScalar(ER * (0.5 + 0.6 * kk)); b[2].material.opacity = 1 - kk;
      });
      // KO beams.
      o.beams.forEach((bm, k) => {
        const e = v.ko[k];
        bm[0].visible = bm[1].visible = !!e;
        if (!e) return;
        const [x, y, i, t] = e;
        const a = Math.atan2(H / 2 - y, W / 2 - x), L = 1000 * (1 - t * 0.5), w = 1000 * Math.max(0.001, 1 - t);
        bm.forEach((m, q) => {
          K.place(m, x, y, 20 + q);
          K.face(m, a);
          m.scale.set(L, w, 1);
          m.material.color.set(q ? '#ffffff' : K.col(Math.round(i), 'light'));
          m.material.opacity = (q ? 0.8 : 0.7) * (1 - t);
        });
      });
      // Fighters (eliminated ones sit on the parapet and watch).
      let seat = 0;
      v.p.forEach((p, i) => { if (o.pl[i]) updateFighter3d(K, o, o.pl[i], p, i, T, Math.round(p.s) === 3 ? seat++ : 0); });
    },
  },

  render(d, v, r) {
    const T = d.t;
    const n = v.p.length;
    drawBackground(d, v, T);
    if (v.rb) drawRopes(d, v, T, true);
    drawStage(d, v, T);
    // Rain bomb warning shadows.
    for (const [x, y, rain] of v.bo) {
      if (!rain) continue;
      const sy = surfaceBelow(x, y);
      if (sy === null) continue;
      const k = clamp(1 - (sy - y) / 900, 0.25, 1);
      d.shadow(x, sy, 44 * k, 12 * k, 0.55 * k);
      if (Math.floor(T * 10) % 2) d.circle(x, sy, 40 * k, null, '#ff4040', 4);
    }
    // Player ground shadows.
    for (const p of v.p) {
      if (Math.round(p.s) === 1 || Math.round(p.s) === 3) continue;
      const sy = surfaceBelow(p.x, p.y);
      if (sy === null) continue;
      const k = clamp(1 - (sy - p.y - p.r) / 500, 0.2, 1);
      d.shadow(p.x, sy, p.r * 0.85 * k, 10 * k, 0.35 * k);
    }
    for (const [x, y, blink] of v.cr) {
      if (blink && Math.floor(T * 8) % 2) continue;
      drawCrate(d, x, y);
    }
    for (const [k, x, y, blink, fuse] of v.it) {
      if (blink && Math.floor(T * 8) % 2) continue;
      if (Math.round(k) === 1) drawHammer(d, x, y + 6, 0.2, 0.9);
      else drawBomb(d, x, y, ITEM_R, T, fuse ? 3 : 1);
    }
    v.p.forEach((p, i) => drawFighter(d, p, i, T));
    for (const [x, y, rain] of v.bo) drawBomb(d, x, y, BOMB_R, T, rain ? 2 : 1.5, T * 8);
    if (v.rb) drawRopes(d, v, T, false);
    // Explosions.
    for (const [x, y, t] of v.bm) {
      const k = clamp(t / 0.4, 0, 1);
      d.circle(x, y, ER * (0.35 + 0.65 * k), 'rgba(255,190,70,' + r2(0.85 * (1 - k)) + ')');
      d.circle(x, y, ER * (0.2 + 0.4 * k), 'rgba(255,255,220,' + r2(0.9 * (1 - k)) + ')');
      d.ring(x, y, ER * (0.5 + 0.6 * k), 'rgba(255,90,40,' + r2(1 - k) + ')', 8);
    }
    // KO beams from the blast line toward the stage.
    for (const [x, y, i, t] of v.ko) drawKoBeam(d, x, y, Math.round(i), t);
    // Player tags above heads (no overlapping numbers), damage cards along the top (Smash style).
    v.p.forEach((p, i) => {
      if (Math.round(p.s) === 1 || Math.round(p.s) === 3) return;
      const ty = p.y - p.r - 26 + Math.sin(T * 6 + i) * 3;
      d.poly([p.x - 16, ty - 14, p.x + 16, ty - 14, p.x, ty + 6], d.col(i), '#000', 3);
      if (p.it === 1) d.text(Math.ceil(p.ht) + '', p.x, ty - 40, { size: 40, color: '#ffcf3f' });
    });
    v.p.forEach((p, i) => drawDamageCard(d, p, i, T, v.rg ? v.rg[i] : 0, n));
    // Off-screen indicators.
    v.p.forEach((p, i) => {
      if (Math.round(p.s) !== 0) return;
      if (p.x > 0 && p.x < W && p.y > 0 && p.y < VIS_B) return;
      const cx = clamp(p.x, 80, W - 80), cy = clamp(p.y, 80, VIS_B - 70);
      const a = Math.atan2(p.y - cy, p.x - cx);
      d.poly([cx + Math.cos(a) * 92, cy + Math.sin(a) * 92, cx + Math.cos(a + 0.45) * 62, cy + Math.sin(a + 0.45) * 62, cx + Math.cos(a - 0.45) * 62, cy + Math.sin(a - 0.45) * 62], d.col(i));
      d.circle(cx, cy, 62, 'rgba(10,6,30,0.75)', d.col(i), 6);
      d.avatar(cx, cy, 38, i, { mood: 'scared', look: a });
    });
  },
};

// ---------- drawing helpers (browser only) ----------

const ah = (a) => Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, '0');

// Deterministic crowd layout.
const CROWD = [];
for (let row = 0; row < 3; row++) {
  for (let k = 0; k < 34; k++) {
    const x = -220 + k * 62 + (row % 2) * 31;
    CROWD.push({ x, y: 750 + row * 40, ph: (k * 1.7 + row * 2.3) % 6.28, c: ['#3a2a6a', '#47327e', '#2e2358', '#55398c'][(k + row) % 4], stick: (k * 7 + row * 3) % 9 === 0 ? ['#ff3d7f', '#2ee6ff', '#ffd23f'][(k + row) % 3] : null });
  }
}

function drawBackground(d, v, T) {
  const { ctx } = d;
  const grad = ctx.createLinearGradient(0, -400, 0, H);
  grad.addColorStop(0, '#120c33');
  grad.addColorStop(0.55, '#3b1f66');
  grad.addColorStop(1, v.sd ? '#a8233a' : '#d9567a');
  ctx.fillStyle = grad;
  ctx.fillRect(-700, -900, W + 1400, 1900);
  // Stars.
  for (let k = 0; k < 14; k++) {
    const x = (k * 263) % 1340 - 50, y = 30 + ((k * 137) % 260);
    d.circle(x, y, 2.5 + (k % 3), 'rgba(255,255,255,' + r2(0.4 + 0.3 * Math.sin(T * 2 + k)) + ')');
  }
  // Big moon / stadium screen glow.
  d.circle(905, 215, 70, 'rgba(255,230,190,0.18)');
  d.circle(905, 215, 48, 'rgba(255,235,200,0.35)');
  // Spotlights sweeping.
  for (let k = 0; k < 2; k++) {
    const bx = k === 0 ? 60 : W - 60, sw = Math.sin(T * 0.7 + k * 2.1) * 220;
    const tx = (k === 0 ? 520 : W - 520) + sw;
    d.poly([bx, H, tx - 90, -300, tx + 90, -300], 'rgba(255,255,255,0.05)');
  }
  // Stands + crowd.
  d.rect(-700, 720, W + 1400, 700, '#1a1236');
  const hype = 1 + v.ch * 2.5;
  for (const c of CROWD) {
    const bob = Math.abs(Math.sin(T * (4 + hype) + c.ph)) * 6 * hype;
    d.rrect(c.x - 22, c.y - 6 - bob, 44, 50, 16, c.c);
    d.circle(c.x, c.y - 22 - bob, 17, c.c);
    if (c.stick) {
      const sa = Math.sin(T * 5 + c.ph) * 0.6;
      const sx = c.x + Math.sin(sa) * 34, sy = c.y - 44 - bob - Math.cos(sa) * 26;
      d.line(c.x + 10, c.y - 10 - bob, sx, sy, '#888', 4);
      d.circle(sx, sy, 9, c.stick);
    }
  }
}

function drawStage(d, v, T) {
  const w = SX1 - SX0;
  // Underside of the floating island.
  d.poly([SX0 + 30, SBOT - 4, SX1 - 30, SBOT - 4, SX1 - 200, SBOT + 90, SCX + 60, SBOT + 130, SCX - 60, SBOT + 130, SX0 + 200, SBOT + 90], '#231a45');
  d.rect(SX0, STOP, w, SBOT - STOP, '#2e2458');
  // Front lights.
  for (let k = 0; k < 15; k++) {
    const x = SX0 + 35 + k * ((w - 70) / 14);
    const on = (Math.floor(T * 3) + k) % 3 === 0;
    d.circle(x, STOP + 58, 8, on ? (k % 2 ? '#2ee6ff' : '#ff3d7f') : '#4a3d80');
  }
  if (v.rb) {
    // Trampoline mat with wobble.
    const wob = Math.sin(T * 30) * 8 * v.mt;
    for (let k = 0; k < 10; k++) d.rect(SX0 + (k * w) / 10, STOP - 4 + wob * Math.sin((k / 9) * Math.PI), w / 10 + 1, 26, k % 2 ? '#ff7ad9' : '#7ad7ff');
    d.neon(() => d.line(SX0, STOP - 4 + wob, SX1, STOP - 4 + wob, '#ffffff', 4), '#ff7ad9');
  } else {
    d.rrect(SX0 - 8, STOP - 6, w + 16, 26, 12, '#7d6bff');
    d.neon(() => d.line(SX0, STOP - 5, SX1, STOP - 5, '#bff6ff', 5), '#5ef2ff');
  }
  // Thin platforms.
  for (const t of THIN) {
    d.rrect(t.x0, t.y - 6, t.x1 - t.x0, 18, 9, '#4b3d8f');
    d.line(t.x0 + 8, t.y - 4, t.x1 - 8, t.y - 4, '#d6ccff', 4);
    d.circle(t.x0 + 20, t.y + 18, 6, 'rgba(94,242,255,0.5)');
    d.circle(t.x1 - 20, t.y + 18, 6, 'rgba(94,242,255,0.5)');
  }
}

// Gommoso ring: back ropes behind fighters, posts + side ropes in front.
function drawRopes(d, v, T, back) {
  const { ctx } = d;
  if (back) {
    for (let k = 0; k < 3; k++) d.line(ROPE_L, ROPE_TOP + 15 + k * 40, ROPE_R, ROPE_TOP + 15 + k * 40, 'rgba(255,122,217,0.25)', 5);
    return;
  }
  for (let side = 0; side < 2; side++) {
    const x = side ? ROPE_R : ROPE_L;
    const wob = Math.sin(T * 40) * 22 * v.rp[side] * (side ? 1 : -1);
    ctx.strokeStyle = '#ff7ad9';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(x, ROPE_TOP);
    ctx.quadraticCurveTo(x + wob, (ROPE_TOP + STOP) / 2, x, STOP);
    ctx.stroke();
    d.rect(x - 7, ROPE_TOP, 14, STOP - ROPE_TOP, 'rgba(255,255,255,0.15)');
    d.circle(x, ROPE_TOP, 13, '#ffd23f', '#7a4b00', 3);
  }
}

function drawCrate(d, x, y) {
  const h = CRATE_H;
  d.rrect(x - h, y - h, h * 2, h * 2, 8, '#c98a3b', '#6b3f12', 5);
  d.line(x - h + 6, y - h + 6, x + h - 6, y + h - 6, '#8a5a24', 5);
  d.line(x - h + 6, y + h - 6, x + h - 6, y - h + 6, '#8a5a24', 5);
  d.circle(x, y, 20, '#ffd23f', '#6b3f12', 3);
  d.text('?', x, y + 1, { size: 30, color: '#6b3f12' });
}

// Hammer with handle base at (x,y), handle direction angle a (world radians), size scale k.
function drawHammer(d, x, y, a, k) {
  const { ctx } = d;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  d.rrect(0, -6 * k, 70 * k, 12 * k, 5 * k, '#8b5a2b', '#4a2c10', 3);
  d.rrect(62 * k, -32 * k, 40 * k, 64 * k, 10 * k, '#ffcf3f', '#7a4b00', 4);
  d.rect(66 * k, -32 * k, 8 * k, 64 * k, 'rgba(255,255,255,0.35)');
  ctx.restore();
}

function drawBomb(d, x, y, r, T, fuse, spin = 0) {
  d.circle(x, y, r, '#26222e', '#000', 4);
  d.circle(x - r * 0.35, y - r * 0.35, r * 0.25, 'rgba(255,255,255,0.35)');
  d.rect(x - 7, y - r - 8, 14, 10, '#666');
  const fx = x + Math.sin(spin) * 4 + 8, fy = y - r - 18;
  d.line(x, y - r - 6, fx, fy, '#c9a46a', 3);
  if (Math.floor(T * 14 * fuse) % 2 === 0) d.star(fx, fy, 9, '#ffd23f', 6);
  else d.star(fx, fy, 6, '#ff6b3d', 5);
}

// Damage card along the top (see cardX). Shakes and grows on hits, colour heats up with damage.
function drawDamageCard(d, p, i, T, rage, n = 2) {
  const ko = Math.round(p.s) === 1 || Math.round(p.s) === 3;
  const dmg = ko ? 0 : Math.max(0, Math.round(p.d));
  const col = dmg < 50 ? '#ffffff' : dmg < 100 ? '#ffd23f' : dmg < 150 ? '#ff8a3c' : '#ff3c3c';
  const hit = p.fl > 0 ? p.fl / 0.3 : 0;
  const jx = hit ? Math.sin(T * 70) * 10 * hit : 0, jy = hit ? Math.cos(T * 63) * 6 * hit : 0;
  const cx = cardX(i, n), cy = 62;
  d.rrect(cx - 128 + jx, cy - 46 + jy, 256, 92, 26, 'rgba(10,6,30,0.72)', d.col(i), 5);
  if (rage) d.rrect(cx - 136 + jx, cy - 54 + jy, 272, 108, 30, null, '#ff5a2a' + (Math.sin(T * 10) > 0 ? 'ff' : '88'), 4);
  d.avatar(cx - 82 + jx, cy + jy, 32, i, { mood: ko ? 'dead' : p.hs ? 'hurt' : dmg >= 120 ? 'scared' : 'ok', look: cx < W / 2 ? 0 : Math.PI });
  const size = 64 + 26 * hit;
  d.text(ko ? 'KO' : dmg + '%', cx + 34 + jx + 3, cy + jy + 4, { size, color: 'rgba(0,0,0,0.55)' });
  d.text(ko ? 'KO' : dmg + '%', cx + 34 + jx, cy + jy, { size, color: ko ? '#9a8cc8' : col });
  if (rage) d.text('🔥', cx + 118 + jx, cy - 40 + jy, { size: 34 });
}

function drawKoBeam(d, x, y, i, t) {
  const a = Math.atan2(H / 2 - y, W / 2 - x);
  const L = 1000 * (1 - t * 0.5), wEnd = 220 * (1 - t), w0 = 30 * (1 - t);
  const cx = Math.cos(a), cy = Math.sin(a), nx = -cy, ny = cx;
  const ex = x + cx * L, ey = y + cy * L;
  d.poly([x + nx * w0, y + ny * w0, ex + nx * wEnd, ey + ny * wEnd, ex - nx * wEnd, ey - ny * wEnd, x - nx * w0, y - ny * w0], d.col(i, 'light') + ah(0.7 * (1 - t)));
  d.poly([x + nx * w0 * 0.4, y + ny * w0 * 0.4, ex + nx * wEnd * 0.35, ey + ny * wEnd * 0.35, ex - nx * wEnd * 0.35, ey - ny * wEnd * 0.35, x - nx * w0 * 0.4, y - ny * w0 * 0.4], '#ffffff' + ah(0.8 * (1 - t)));
}

function drawFighter(d, p, i, T) {
  const st = Math.round(p.s);
  if (st === 1 || st === 3) return;
  const r = p.r, f = p.f >= 0 ? 1 : -1;
  let x = p.x, y = p.y;
  // Respawn halo platform.
  if (st === 2) d.neon(() => d.rrect(x - 85, y + r + 2, 170, 16, 8, d.col(i, 'light')), d.col(i));
  // Charge tremble.
  if (p.c > 0) { x += Math.sin(T * 95) * 4 * (0.5 + p.c); y += Math.cos(T * 83) * 2 * p.c; }
  // Launch trail: ghost copies behind a fighter flying in hitstun.
  if (p.hs && Math.hypot(p.vx || 0, p.vy) > 700) {
    for (let k = 3; k >= 1; k--) d.circle(x - (p.vx || 0) * 0.018 * k, y - p.vy * 0.018 * k, r * (1 - k * 0.15), d.col(i, 'light') + ah(0.32 - k * 0.08));
  }
  if (p.dg) {
    // Dodge: see-through with a bright outline and a sideways afterimage.
    d.circle(x - f * 26, y, r, '#ffffff22');
    d.ring(x, y, r + 8, '#ffffffcc', 4);
  }
  const baseA = p.dg ? 0.4 : p.iv && Math.floor(T * 12) % 2 ? 0.45 : 1;
  d.ctx.globalAlpha = baseA;

  const k = Math.round(p.k);
  const kind = AK[k] || '';
  // Punch extension: wind-up, out, back.
  const a = p.a;
  const ext = !kind ? 0 : a < 0.25 ? a / 0.25 : a < 0.6 ? 1 : (1 - a) / 0.4;
  let dx = f, dy = 0;
  if (kind === 'up' || kind === 'usmash') { dx = f * 0.25; dy = -1; }
  else if (kind === 'down') { dx = f * 0.15; dy = 1; }
  else if (kind === 'throw') { dx = f * 0.8; dy = -0.6; }
  const big = kind === 'smash' || kind === 'usmash';
  const run = p.g && Math.abs(p.vy) < 1 ? Math.sin(T * 14) * 4 : 0;
  // Back fist.
  const bfx = x - f * r * 0.8, bfy = y + r * 0.3 - run;
  d.line(x - f * r * 0.5, y + r * 0.2, bfx, bfy, d.col(i, 'dark'), 9);
  d.circle(bfx, bfy, r * 0.3, '#e9e4ff', d.col(i, 'dark'), 4);

  if (p.c > 0) d.glow(d.col(i, 'light'), 18 + 22 * p.c, () => d.circle(x, y, r + 6 + 4 * Math.sin(T * 30), d.col(i, 'light') + '55'));
  const squash = p.l > 0 ? 0.25 * (p.l / 0.14) : !p.g ? clamp(-Math.abs(p.vy) / 4000, -0.2, 0) : 0;
  const mood = p.hs ? (p.fl > 0 ? 'hurt' : 'dizzy') : p.hp ? 'happy' : p.c > 0 || big || kind === 'ham' ? 'angry' : p.d >= 120 ? 'scared' : 'ok';
  const look = dy !== 0 && kind ? Math.atan2(dy, dx) : f > 0 ? 0 : Math.PI;
  d.avatar(x, y, r, i, { look, mood, squash });
  if (p.fl > 0 && Math.floor(T * 30) % 2 === 0) d.circle(x, y, r, 'rgba(255,255,255,0.75)');

  // Front fist / weapon.
  if (Math.round(p.it) === 1) {
    const hx = x + f * r * 0.55, hy = y + r * 0.15;
    let ang = -1.25;
    if (kind === 'ham') { const e = clamp(a / 0.55, 0, 1); ang = lerp(-2.4, 0.7, 1 - (1 - e) ** 3); }
    const wa = Math.atan2(Math.sin(ang), f * Math.cos(ang));
    if (p.ht < 1.2 && Math.floor(T * 10) % 2) d.ctx.globalAlpha = baseA * 0.5;
    drawHammer(d, hx, hy, wa, r / 46 * 1.25);
    d.ctx.globalAlpha = baseA;
    d.circle(hx, hy, r * 0.3, '#e9e4ff', d.col(i, 'dark'), 4);
  } else {
    const reach = r * 0.75 + ext * r * (big ? 1.05 : 0.8);
    const ffx = kind ? x + dx * reach : x + f * r * 0.85, ffy = kind ? y + dy * reach + r * 0.1 : y + r * 0.3 + run;
    const fr = r * (0.32 + (big ? 0.18 * ext : 0.06 * ext));
    d.line(x + f * r * 0.4, y + r * 0.2, ffx, ffy, d.col(i, 'dark'), 10);
    if (big && ext > 0.6) d.circle(ffx, ffy, fr * 1.8, d.col(i, 'light') + '66');
    d.circle(ffx, ffy, fr, '#ffffff', d.col(i, 'dark'), 4);
  }
  if (Math.round(p.it) === 2) drawBomb(d, x, y - r - 30, BOMB_R, T, 1.5);
  d.ctx.globalAlpha = 1;
}

// ---------- 3D helpers (render3d) ----------

const CAM_T = { x: W / 2, y: H / 2 };
// Character clips for each attack (KayKit adventurers / skeletons) and their playback speed.
const ATK_ANIM = {
  jab: ['1H_Melee_Attack_Stab', 2.4], up: ['1H_Melee_Attack_Slice_Diagonal', 2.2], down: ['2H_Melee_Attack_Chop', 2.2],
  smash: ['2H_Melee_Attack_Slice', 1.7], usmash: ['2H_Melee_Attack_Spin', 1.7], ham: ['2H_Melee_Attack_Chop', 2.0], throw: ['Throw', 2.4],
};

// Blacksmith's mallet: oak handle along local +X from the pivot (the hand), iron-banded golden head across it.
function makeHammer3d(K) {
  const T3 = K.THREE;
  const g = K.group();
  K.place(K.box(70, 12, 12, K.mat('#7a4a22', { rough: 0.7 }), { parent: g }), 35, 0, 0);
  if (!K._hamGeo) {
    K._hamGeo = new T3.CylinderGeometry(21, 21, 64, 22);
    K._hamBand = new T3.CylinderGeometry(22.5, 22.5, 9, 22);
  }
  const head = K.mesh(K._hamGeo, K.mat('#e8b23a', { rough: 0.3, metal: 0.5, emissive: '#6a4000', ei: 0.3 }), { parent: g });
  K.place(head, 82, 0, 0);
  K.outline(head, '#5a3a00', 0.06);
  for (const dy of [-22, 22]) K.place(K.mesh(K._hamBand, K.mat('#4a4a52', { rough: 0.35, metal: 0.7 }), { parent: g }), 82, dy, 0);
  return g;
}

// Bombard ball (unit radius, scaled to the real one): body, highlight, cap, fuse and a blinking spark.
function makeBomb3d(K, o) {
  const g = K.group();
  const body = K.ball(1, K.mat('#2a2633', { rough: 0.3, metal: 0.3 }), { parent: g });
  K.outline(body, '#000000', 0.08);
  K.place(K.ball(0.25, K.glow('#ffffff', { opacity: 0.5 }), { parent: g, cast: false }), -0.38, -0.38, 0.8);
  K.place(K.box(0.55, 0.35, 0.55, K.mat('#8a7a5a', { metal: 0.5, rough: 0.3 }), { parent: g }), 0, -1.08, 0);
  const fuse = K.box(0.12, 0.6, 0.12, K.mat('#c9a46a'), { parent: g, cast: false });
  K.place(fuse, 0.14, -1.45, 0); fuse.rotation.z = -0.45;
  if (!o.sparkMats) o.sparkMats = [K.glow('#ffd23f', { add: true }), K.glow('#ff6b3d', { add: true })];
  const spark = K.ball(1, o.sparkMats[0], { parent: g, cast: false });
  K.place(spark, 0.3, -1.72, 0);
  return { g, spark };
}

function setBomb3d(K, o, b, x, y, r, fuse, spin) {
  K.place(b.g, x, y, 0);
  b.g.scale.setScalar(r);
  b.g.rotation.z = Math.sin(spin) * 0.15;
  const on = Math.floor(K.t * 14 * fuse) % 2 === 0;
  b.spark.material = o.sparkMats[on ? 0 : 1];
  b.spark.scale.setScalar(on ? 0.4 : 0.26);
}

// seat = index among eliminated fighters (they sit on the parapet as spectators).
function updateFighter3d(K, o, P, p, i, T, seat) {
  for (const m of P.all) m.visible = false;
  P.ind.show(false);
  const st = Math.round(p.s);
  if (st === 1) { P.av.set(0, 0, { visible: false }); return; }
  if (st === 3) {
    // Out of the tournament: a translucent spectator sitting on the parapet, cheering now and then.
    const left = seat % 2 === 0, k = Math.floor(seat / 2);
    const x = SX0 + 26 + (left ? k : 9 - k) * 94;
    P.av.set(x, STOP - 46 - 36, { r: 36, h: -(o.SD / 2) + 14, look: left ? 0.6 : Math.PI - 0.6, alpha: 0.55, anim: Math.sin(T * 0.7 + i) > 0.6 ? 'Cheer' : 'Sit_Floor_Idle', gear: false });
    return;
  }
  const r = p.r, f = p.f >= 0 ? 1 : -1;
  let x = p.x, y = p.y;
  if (st === 2) { P.halo.visible = true; K.place(P.halo, x, y + r + 8, 0); }
  if (p.c > 0) { x += Math.sin(T * 95) * 4 * (0.5 + p.c); y += Math.cos(T * 83) * 2 * p.c; }
  const vx = p.vx || 0, sp = Math.hypot(vx, p.vy);
  const flying = p.hs && sp > 700;
  if (flying) {
    P.trail.forEach((b, k) => {
      const kk = k + 1;
      b.visible = true;
      K.place(b, x - vx * 0.022 * kk, y - p.vy * 0.022 * kk, -kk * 6);
      b.scale.setScalar(r * (1 - kk * 0.15));
    });
  }
  if (p.dg) { P.dodge.visible = true; K.place(P.dodge, x, y, 0); P.dodge.scale.setScalar(r * 1.25); P.dodge.rotation.y = T * 6; }
  const alpha = p.dg ? 0.4 : p.iv && Math.floor(T * 12) % 2 ? 0.45 : 1;
  const kind = AK[Math.round(p.k)] || '';
  const a = p.a;
  let dx = f, dy = 0;
  if (kind === 'up' || kind === 'usmash') { dx = f * 0.25; dy = -1; }
  else if (kind === 'down') { dx = f * 0.15; dy = 1; }
  else if (kind === 'throw') { dx = f * 0.8; dy = -0.6; }
  const squash = p.l > 0 ? 0.2 * (p.l / 0.14) : 0;
  const mood = p.hs ? 'hurt' : p.hp ? 'happy' : 'ok';
  const look = kind && dy !== 0 ? Math.atan2(dy * 0.4, dx) : f > 0 ? 0 : Math.PI;
  // Animation: attack clips restart on every new swing (also back-to-back swings of the same kind).
  if (kind && (kind !== P.lastK || a < P.lastA - 0.2)) P.atkN++;
  P.lastK = kind; P.lastA = a;
  let anim, animSpeed, animKey;
  if (p.hs) anim = flying ? 'Hit_B' : 'Hit_A';
  else if (p.dg) { anim = 'Dodge_Backward'; animSpeed = 2; }
  else if (kind && ATK_ANIM[kind]) { anim = ATK_ANIM[kind][0]; animSpeed = ATK_ANIM[kind][1] * (p.c ? 1 : 1); animKey = P.atkN; }
  else if (p.c > 0) anim = '2H_Melee_Idle';
  else if (st === 0 && !p.g) anim = 'Jump_Idle';
  const it = Math.round(p.it);
  P.av.set(x, y, { r, look, mood, squash, alpha, walk: p.g ? clamp(Math.abs(vx) / RUN, 0, 1) : 0, spin: flying ? T * 16 : 0, anim, animSpeed, animKey, gear: it === 0 });
  if (p.c > 0) { P.charge.visible = true; K.place(P.charge, x, y - r * 0.15, 0); P.charge.scale.setScalar(r * 1.15 + 5 * Math.sin(T * 30)); }
  if (p.fl > 0 && Math.floor(T * 30) % 2 === 0) { P.flash.visible = true; K.place(P.flash, x, y - r * 0.15, 0); P.flash.scale.setScalar(r * 1.2); }
  // Slash arc on the active frames of the attack (the hitbox, readable).
  const A = ATK[kind];
  if (A && A.hr && a * A.dur >= A.a0 - 0.02 && a * A.dur <= A.a1 + 0.04) {
    const hx = x + f * A.ox * r, hy = y + A.oy * r, dir = Math.atan2(A.oy, f * Math.max(0.2, A.ox));
    const big = kind === 'smash' || kind === 'usmash' || kind === 'ham';
    for (const m of [P.slash, P.slash2]) {
      m.visible = true;
      K.place(m, hx - Math.cos(dir) * A.hr * r * 0.5, hy - Math.sin(dir) * A.hr * r * 0.5, r * 0.6);
      K.face(m, dir - Math.PI * 0.45);
      m.scale.setScalar(A.hr * r * (big ? 1.25 : 1));
    }
  }
  // Mallet in hand / bomb above the head.
  if (it === 1) {
    const hx = x + f * r * 0.55, hy = y + r * 0.15;
    let ang = -1.25;
    if (kind === 'ham') { const e = clamp(a / 0.55, 0, 1); ang = lerp(-2.4, 0.7, 1 - (1 - e) ** 3); }
    P.ham.visible = !(p.ht < 1.2 && Math.floor(T * 10) % 2);
    K.place(P.ham, hx, hy, r * 0.7);
    K.face(P.ham, Math.atan2(Math.sin(ang), f * Math.cos(ang)));
    P.ham.rotation.y = 0;
    P.ham.scale.setScalar((r / 46) * 1.25);
    const nn = Math.max(0, Math.ceil(p.ht));
    if (nn !== P.lastN) { P.lastN = nn; P.timer.redraw(nn); }
    P.timer.visible = true;
    K.place(P.timer, p.x, p.y - r * 1.3 - 70, 20);
  }
  if (it === 2) { P.bomb.g.visible = true; setBomb3d(K, o, P.bomb, x, y - r * 1.3 - BOMB_R - 12, BOMB_R, 1.5, 0); }
  // Off-screen indicator.
  if (st === 0 && !(p.x > 0 && p.x < W && p.y > 0 && p.y < VIS_B)) {
    const cx = clamp(p.x, 80, W - 80), cy = clamp(p.y, 80, VIS_B - 70);
    const an = Math.atan2(p.y - cy, p.x - cx);
    P.ind.show(true).at(cx, cy, 60).paint((d) => {
      d.poly([Math.cos(an) * 96, Math.sin(an) * 96, Math.cos(an + 0.45) * 62, Math.sin(an + 0.45) * 62, Math.cos(an - 0.45) * 62, Math.sin(an - 0.45) * 62], d.col(i), '#000', 3);
      d.circle(0, 0, 62, 'rgba(10,6,30,0.8)', d.col(i), 6);
      d.avatar(0, 0, 38, i, { mood: 'scared', look: an });
    });
  }
}

// Front face of the stone bridge: ashlar blocks, a dark arch band and painted heraldic shields.
function drawStageFront3d(d) {
  const { ctx } = d;
  const w = SX1 - SX0, y0 = STOP + 14, y1 = SBOT;
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, '#cdbda5'); g.addColorStop(1, '#9d8d78');
  ctx.fillStyle = g;
  ctx.fillRect(SX0, y0, w, y1 - y0);
  for (let row = 0; row < 3; row++) {
    const yy = y0 + row * ((y1 - y0) / 3);
    d.line(SX0, yy, SX1, yy, 'rgba(60,45,30,0.45)', 2);
    for (let x = SX0 + (row % 2) * 35; x < SX1; x += 70) d.line(x, yy, x, yy + (y1 - y0) / 3, 'rgba(60,45,30,0.35)', 2);
  }
  const cols = ['#c8352f', '#2f6fd0', '#3d9a3a', '#e0a92a'];
  for (let k = 0; k < 4; k++) {
    const cx = SX0 + w * (0.17 + k * 0.22), cy = (y0 + y1) / 2 + 2;
    d.poly([cx - 20, cy - 26, cx + 20, cy - 26, cx + 20, cy + 2, cx, cy + 26, cx - 20, cy + 2], cols[k], '#3a2a1a', 3);
    d.line(cx, cy - 22, cx, cy + 18, 'rgba(255,240,200,0.7)', 4);
    d.line(cx - 15, cy - 8, cx + 15, cy - 8, 'rgba(255,240,200,0.7)', 4);
  }
  d.line(SX0, y1 - 2, SX1, y1 - 2, 'rgba(40,30,20,0.6)', 4);
}

// Clouds lit from below look grey: give them their own bright, slightly glowing material (never touch the shared one).
function softCloud(K, g) {
  const m = K.mat('#ffffff', { rough: 1, emissive: '#fff0f2', ei: 0.55 });
  g.traverse((x) => { if (x.isMesh) x.material = m; });
  return g;
}
