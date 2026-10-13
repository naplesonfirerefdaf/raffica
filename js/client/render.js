// Frame renderer: game viewports (with crazy render mods), HUD, phase overlays, touch controls.
// Look: fairy-tale castle — a torch-lit great hall with the 4 team banners, parchment cards, carved wood, gold.
import { makeDraw, FONT, TITLE_FONT } from './draw.js';
import { Fx } from './fx.js';
import { Stage3D } from './three3d.js';
import { enterRect } from './layout.js';
import { drawTouch } from './input.js';
import { PLAYER_COLORS, CHAR_BY_ID, DEFAULT_CHARS } from '../core/proto.js';
import { BOT_LEVELS } from '../core/bots.js';
import { MOD_BY_ID } from '../core/mods.js';
import { TEAMS, snapColorMap, members, teamOf, teamScore } from './teams.js';

// C[slot] = color of a slot: its own color, or its team color in a 2 vs 2 match (set every frame).
// PC = the 4 fixed colors for decorations (hall banners, rose window, crest).
const PC = PLAYER_COLORS;
let C = PLAYER_COLORS;
const TAU = Math.PI * 2;
const GOLD = '#f6c94e';
const GOLD_HI = '#fff2b3';
const GOLD_D = '#a8700f';
const INK = '#2a170b';        // dark brown outlines
const PARCH_INK = '#3a2210';  // text on parchment
const PARCH_SOFT = '#6a4626';
const VIOLET = '#a77be8';     // magic (crazy rules)
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const easeOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const easeIn = (t) => Math.pow(clamp01(t), 3);
const easeBack = (t) => { t = clamp01(t); const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

// Phases that open with the castle-doors stinger.
const WIPE_PHASES = new Set(['pick', 'roulette', 'intro', 'countdown', 'final']);

// Deterministic decoration for the hall background (generated once).
function seeded(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
const EMBERS = (() => { const r = seeded(11); return Array.from({ length: 64 }, (_, k) => ({ torch: k % 4, sp: 0.12 + r() * 0.22, ph: r(), wob: r() * TAU, dx: (r() - 0.5) * 2, s: 0.8 + r() * 1.6 })); })();
const MOTES = (() => { const r = seeded(29); return Array.from({ length: 26 }, () => ({ x: r(), y: r(), z: 0.4 + r() * 0.6, ph: r() * TAU })); })();

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.d = makeDraw(this.ctx);
    this.fx = new Fx();
    this.dpr = 1;
    this.W = 0; this.H = 0;
    this.renderErrors = new Set();
    this.lowQuality = matchMedia('(pointer: coarse)').matches;
    this.d.quality = this.lowQuality ? 0 : 1;
    const c3 = document.getElementById('game3d');
    this.stage = c3 ? new Stage3D(c3, { low: this.lowQuality }) : null;
    this.force2d = /[?&]g2d/.test(location.search);
    this.gameKey = null;
    this.phase = null;
    this.prevPhase = null;
    this.phaseAt = -1e9;
    this.bgBusy = false;
    this.bgCanvas = null;
    this.bgKey = '';
    this.doorCanvas = null;
    this.doorKey = '';
    // Canvas text needs the web fonts loaded explicitly (vendored, works offline).
    try { for (const f of [`900 40px ${TITLE_FONT}`, `700 40px ${FONT}`, `600 40px ${FONT}`]) document.fonts?.load(f); } catch { /* old browser */ }
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.lowQuality ? 2 : 2.5);
    const W = window.innerWidth, H = window.innerHeight;
    if (W !== this.W || H !== this.H || dpr !== this.dpr) {
      this.W = W; this.H = H; this.dpr = dpr;
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
      this.canvas.style.width = W + 'px';
      this.canvas.style.height = H + 'px';
    }
    this.stage?.resize(W, H, dpr);
  }

  // f = { snap, gview, def, L, names (per slot), cfgs, input, mode, me (my slot), mySeat, seats, local, keys, games, now, dt, settings }
  // Games / layouts speak SEATS; scores, winners and colors belong to SLOTS (seats[seat] = slot).
  frame(f) {
    const { ctx } = this;
    ctx.reset?.(); // drop any canvas state a crashed game render may have leaked
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.fx.update(f.dt);
    const s = f.snap;
    this.seats = s?.seats?.length ? s.seats : [0, 1];
    this.d.seats = this.seats;
    this.d.chars = s?.pl ? s.pl.map((q) => q?.c) : null;
    this.fx.seats = this.seats;
    // 2 vs 2: every player wears a color of its team (red + gold / blue + green).
    this.cmap = snapColorMap(s);
    C = this.cmap.map((k) => PC[k] || PC[0]);
    this.d.cmap = this.cmap;
    this.fx.cmap = this.cmap;
    // One key per game instance: a new key rebuilds the whole 3D scene and clears the effects.
    const key = s?.g ? `${s.g.id}:${s.g.k ?? s.g.st}` : null;
    if (key !== this.gameKey) { this.gameKey = key; this.fx.clearWorld(); }
    const ph = s?.ph || null;
    if (ph !== this.phase) { this.prevPhase = this.phase; this.phase = ph; this.phaseAt = f.now; }

    this.bgBusy = !!(s?.g && f.def && f.gview);
    this.background(f.now);
    if (s?.g && f.def && f.gview) this.drawGame(f);
    else {
      this.stage?.hide();
      if (this.fx.parts.length) { this.d.textRot = 0; this.d.px = 1; this.fx.drawWorld(this.d); } // e.g. final-screen confetti
    }
    this.drawHud(f);
    for (const o of f.L.overlays) {
      const { w, h } = enterRect(ctx, o);
      this.overlay(f, o, w, h);
      ctx.restore();
    }
    this.transition(f);
    if (f.L.controls.length && f.cfgs) {
      drawTouch(ctx, f.L, f.cfgs, f.input, (c) => C[(f.L.mode === 'solo' || f.L.mode === 'pad' ? f.me : this.seats[c.seat]) ?? c.seat] || C[0]);
    }
    if (this.fx.flashA > 0.01) {
      ctx.globalAlpha = this.fx.flashA;
      ctx.fillStyle = this.fx.flashColor;
      ctx.fillRect(0, 0, this.W, this.H);
      ctx.globalAlpha = 1;
    }
  }

  // Stinger: the castle doors are shut on the phase change, the golden crest flashes, then they swing open.
  transition(f) {
    const ph = this.phase;
    if (!WIPE_PHASES.has(ph) || !this.prevPhase || this.prevPhase === 'pause' || this.prevPhase === ph) return;
    const t = (f.now - this.phaseAt) / 1000;
    const HOLD = 0.14, DUR = 0.68;
    if (t < 0 || t > DUR) return;
    const { ctx, W, H } = this;
    this.ensureDoor();
    const q = clamp01((t - HOLD) / (DUR - HOLD));
    const p = q * q * (3 - 2 * q); // smoothstep: the heavy doors start slowly, then swing wide
    const off = p * (W / 2 + 20);
    ctx.save();
    // Left door, then the mirrored right door, sliding apart with a slight swing (horizontal squash).
    const sq = 1 - p * 0.35;
    ctx.save();
    ctx.translate(-off, 0);
    ctx.scale(sq, 1);
    ctx.drawImage(this.doorCanvas, 0, 0, W / 2 + 1, H);
    ctx.restore();
    ctx.save();
    ctx.translate(W + off, 0);
    ctx.scale(-sq, 1);
    ctx.drawImage(this.doorCanvas, 0, 0, W / 2 + 1, H);
    ctx.restore();
    // Light spilling through the opening gap.
    if (p > 0) {
      const gx = W / 2, gw = off * 2;
      const g = ctx.createLinearGradient(gx - gw / 2, 0, gx + gw / 2, 0);
      g.addColorStop(0, 'rgba(255,200,110,0)');
      g.addColorStop(0.5, `rgba(255,220,150,${0.5 * (1 - p)})`);
      g.addColorStop(1, 'rgba(255,200,110,0)');
      ctx.fillStyle = g;
      ctx.fillRect(gx - gw / 2, 0, gw, H);
    }
    // Golden crest on the seam while the doors are shut.
    const la = 1 - clamp01((t - HOLD * 0.6) / 0.16);
    if (la > 0) {
      ctx.globalAlpha = la;
      const size = Math.min(W * 0.13, H * 0.16);
      const pop = easeBack(Math.min(1, t / 0.12));
      crest(ctx, W / 2, H / 2, size * 1.25 * pop);
      logoText(ctx, 'RAFFICA!', W / 2, H / 2 + size * 1.25 * pop, size * 0.55 * pop);
    }
    ctx.restore();
  }

  // One wooden castle door (left half of the screen), cached per size.
  ensureDoor() {
    const { W, H } = this;
    const key = `${W}x${H}`;
    if (this.doorKey === key && this.doorCanvas) return;
    this.doorKey = key;
    const c = this.doorCanvas || (this.doorCanvas = document.createElement('canvas'));
    const s = Math.min(this.dpr, 1.25);
    const w = Math.ceil(W / 2) + 1;
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(H * s));
    const g = c.getContext('2d');
    g.setTransform(s, 0, 0, s, 0, 0);
    const n = Math.max(3, Math.round(w / Math.max(60, Math.min(W, H) * 0.12)));
    const pw = w / n;
    const r = seeded(77);
    for (let k = 0; k < n; k++) {
      const x = k * pw;
      const pg = g.createLinearGradient(x, 0, x + pw, 0);
      const l = 0.85 + r() * 0.3;
      pg.addColorStop(0, shade('#7a4820', l * 0.8));
      pg.addColorStop(0.5, shade('#8e5a2a', l));
      pg.addColorStop(1, shade('#6a3c18', l * 0.75));
      g.fillStyle = pg;
      g.fillRect(x, 0, pw, H);
      g.save();
      g.translate(x, 0);
      g.rotate(Math.PI / 2);
      g.fillStyle = texPattern(g, 'wood');
      g.fillRect(0, -pw, H, pw);
      g.restore();
      g.fillStyle = 'rgba(20,8,2,0.85)';
      g.fillRect(x + pw - 2, 0, 3, H);
    }
    // Iron bands with rivets.
    for (const by of [0.17, 0.5, 0.83]) {
      const y = H * by, bh = Math.max(14, H * 0.035);
      const ig = g.createLinearGradient(0, y - bh / 2, 0, y + bh / 2);
      ig.addColorStop(0, '#6d6870');
      ig.addColorStop(0.45, '#3a363c');
      ig.addColorStop(1, '#1e1b20');
      g.fillStyle = ig;
      g.fillRect(0, y - bh / 2, w, bh);
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(0, y + bh / 2, w, 3);
      for (let x = pw / 2; x < w; x += pw / 2) rivet(g, x, y, bh * 0.2);
    }
    // Inner shadow toward the seam and the door ring.
    const sg = g.createLinearGradient(w - Math.min(W, H) * 0.08, 0, w, 0);
    sg.addColorStop(0, 'rgba(0,0,0,0)');
    sg.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = sg;
    g.fillRect(0, 0, w, H);
    const rr = Math.min(W, H) * 0.045;
    g.lineWidth = rr * 0.28;
    g.strokeStyle = '#1a1418';
    g.beginPath(); g.arc(w - rr * 1.9, H * 0.62, rr, 0, TAU); g.stroke();
    g.lineWidth = rr * 0.16;
    g.strokeStyle = GOLD;
    g.beginPath(); g.arc(w - rr * 1.9, H * 0.62, rr, 0, TAU); g.stroke();
    rivet(g, w - rr * 1.9, H * 0.62 - rr, rr * 0.35);
    const vg = g.createLinearGradient(0, 0, 0, H);
    vg.addColorStop(0, 'rgba(0,0,0,0.35)');
    vg.addColorStop(0.3, 'rgba(0,0,0,0)');
    vg.addColorStop(0.75, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = vg;
    g.fillRect(0, 0, w, H);
  }

  // Layout of the great hall for the current size (shared by the static and the animated layer).
  hall() {
    const { W, H } = this;
    const wide = W / H > 1.15;
    const U = Math.min(W, H) / 100;
    const hz = H * (wide ? 0.76 : 0.8);
    const aw = wide ? Math.min(W * 0.3, H * 0.62) : W * 0.62;
    return {
      wide, U, hz,
      arch: { x: W / 2, w: aw, top: H * (wide ? 0.07 : 0.1) },
      banners: (wide ? [0.135, 0.29, 0.71, 0.865] : [0.09, 0.3, 0.7, 0.91]).map((x, k) => ({ x: x * W, k })),
      bw: wide ? Math.min(W * 0.072, H * 0.13) : Math.min(W * 0.13, H * 0.075),
      bl: wide ? H * 0.38 : H * 0.24,
      torches: (wide ? [0.21, 0.79] : [0.2, 0.8]).map((x) => ({ x: x * W, y: H * (wide ? 0.5 : 0.42) })),
      windows: W / H > 1.5 ? [0.045, 0.955].map((x) => x * W) : [],
    };
  }

  // Static great hall (stone walls, arch with rose window, pillars, carpet), cached per size.
  ensureBg() {
    const { W, H } = this;
    const key = `${W}x${H}`;
    if (this.bgKey === key && this.bgCanvas) return;
    this.bgKey = key;
    const c = this.bgCanvas || (this.bgCanvas = document.createElement('canvas'));
    const s = Math.min(this.dpr, 1.25);
    c.width = Math.max(1, Math.round(W * s));
    c.height = Math.max(1, Math.round(H * s));
    const g = c.getContext('2d');
    g.setTransform(s, 0, 0, s, 0, 0);
    const L = this.hall();
    const { U, hz } = L;
    const r = seeded(5);
    // Stone wall.
    const wall = g.createLinearGradient(0, 0, 0, hz);
    wall.addColorStop(0, '#17111a');
    wall.addColorStop(0.55, '#2b2229');
    wall.addColorStop(1, '#3a2d31');
    g.fillStyle = wall;
    g.fillRect(0, 0, W, hz);
    const bh = Math.max(14, H / 24), bwid = bh * 2.3;
    for (let row = 0, y = 0; y < hz; row++, y += bh) {
      for (let x = row % 2 ? -bwid / 2 : 0; x < W; x += bwid) {
        const l = 0.75 + r() * 0.5;
        g.fillStyle = `rgba(${Math.round(70 * l)},${Math.round(58 * l)},${Math.round(66 * l)},${0.32 + (y / hz) * 0.25})`;
        g.fillRect(x + 1.5, y + 1.5, bwid - 3, bh - 3);
        g.fillStyle = 'rgba(255,230,200,0.05)';
        g.fillRect(x + 1.5, y + 1.5, bwid - 3, 1.5);
      }
    }
    // Tall side windows with the night sky.
    for (const wx of L.windows) {
      const ww = W * 0.045, wt = H * 0.16, wh = H * 0.36;
      g.save();
      archPath(g, wx, wt, ww, wh);
      const sky = g.createLinearGradient(0, wt, 0, wt + wh);
      sky.addColorStop(0, '#0d1838');
      sky.addColorStop(1, '#273a6e');
      g.fillStyle = sky;
      g.fill();
      g.clip();
      g.fillStyle = '#fff';
      for (let k = 0; k < 10; k++) g.fillRect(wx - ww / 2 + r() * ww, wt + r() * wh * 0.7, 1.4, 1.4);
      g.strokeStyle = '#1a1418';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(wx, wt); g.lineTo(wx, wt + wh);
      for (let y = wt + wh * 0.3; y < wt + wh; y += wh * 0.22) { g.moveTo(wx - ww, y); g.lineTo(wx + ww, y); }
      g.stroke();
      g.restore();
      archPath(g, wx, wt, ww, wh);
      g.lineWidth = Math.max(4, ww * 0.16);
      g.strokeStyle = '#6a5a5e';
      g.stroke();
    }
    // Great arch (throne alcove) with a stained-glass rose window.
    const A = L.arch;
    const ah = hz - A.top;
    g.save();
    archPath(g, A.x, A.top, A.w, ah);
    const rec = g.createLinearGradient(0, A.top, 0, hz);
    rec.addColorStop(0, '#0f0a10');
    rec.addColorStop(1, '#22181c');
    g.fillStyle = rec;
    g.fill();
    g.clip();
    const rr = A.w * 0.28, rcx = A.x, rcy = A.top + rr * 1.45;
    const rg = g.createRadialGradient(rcx, rcy, 0, rcx, rcy, rr * 3.2);
    rg.addColorStop(0, 'rgba(255,200,120,0.28)');
    rg.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = rg;
    g.fillRect(A.x - A.w, A.top, A.w * 2, ah);
    roseWindow(g, rcx, rcy, rr);
    g.restore();
    // Voussoir stones around the arch.
    archPath(g, A.x, A.top, A.w, ah);
    g.lineWidth = Math.max(8, A.w * 0.06);
    g.strokeStyle = '#5c4c50';
    g.stroke();
    g.setLineDash([Math.max(10, A.w * 0.07), 3]);
    g.lineWidth = Math.max(8, A.w * 0.06) - 3;
    g.strokeStyle = '#776569';
    g.stroke();
    g.setLineDash([]);
    // Pillars (with the torch sconces).
    for (const tc of L.torches) {
      const pw = Math.max(18, U * 5.2);
      const pg = g.createLinearGradient(tc.x - pw / 2, 0, tc.x + pw / 2, 0);
      pg.addColorStop(0, '#2c2328');
      pg.addColorStop(0.35, '#6a5a5c');
      pg.addColorStop(0.6, '#4c3f43');
      pg.addColorStop(1, '#221a1e');
      g.fillStyle = pg;
      g.fillRect(tc.x - pw / 2, 0, pw, hz);
      g.fillStyle = 'rgba(0,0,0,0.3)';
      for (let y = bh * 0.5; y < hz; y += bh * 1.6) g.fillRect(tc.x - pw / 2, y, pw, 2);
      g.fillStyle = '#5a4a4e';
      g.fillRect(tc.x - pw * 0.75, hz - U * 3, pw * 1.5, U * 3);
      // Iron sconce.
      g.fillStyle = '#1e1a1e';
      g.beginPath();
      g.moveTo(tc.x - U * 1.6, tc.y);
      g.lineTo(tc.x + U * 1.6, tc.y);
      g.lineTo(tc.x + U * 0.7, tc.y + U * 4.5);
      g.lineTo(tc.x - U * 0.7, tc.y + U * 4.5);
      g.closePath();
      g.fill();
      g.fillStyle = '#4a3020';
      g.fillRect(tc.x - U * 1.3, tc.y - U * 1.2, U * 2.6, U * 1.4);
      // Warm light baked on the wall.
      const lg = g.createRadialGradient(tc.x, tc.y - U * 3, 0, tc.x, tc.y - U * 3, U * 34);
      lg.addColorStop(0, 'rgba(255,150,60,0.32)');
      lg.addColorStop(0.4, 'rgba(255,120,40,0.1)');
      lg.addColorStop(1, 'rgba(255,120,40,0)');
      g.fillStyle = lg;
      g.fillRect(tc.x - U * 34, tc.y - U * 37, U * 68, U * 68);
    }
    // Banner rods (the cloth itself is animated).
    for (const b of L.banners) {
      const rw = L.bw * 1.35, ry = H * 0.045;
      const rg2 = g.createLinearGradient(0, ry - 4, 0, ry + 4);
      rg2.addColorStop(0, GOLD_HI);
      rg2.addColorStop(0.5, GOLD);
      rg2.addColorStop(1, GOLD_D);
      g.fillStyle = '#1e1a1e';
      g.fillRect(b.x - 1.5, 0, 3, ry);
      g.fillStyle = rg2;
      roundRect(g, b.x - rw / 2, ry - 4, rw, 8, 4); g.fill();
      for (const sd of [-1, 1]) { g.beginPath(); g.arc(b.x + sd * rw / 2, ry, 6, 0, TAU); g.fill(); g.strokeStyle = INK; g.lineWidth = 1.5; g.stroke(); }
    }
    // Floor: flagstones + the royal carpet.
    const fl = g.createLinearGradient(0, hz, 0, H);
    fl.addColorStop(0, '#3b2c28');
    fl.addColorStop(1, '#140d0c');
    g.fillStyle = fl;
    g.fillRect(0, hz, W, H - hz);
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 1.5;
    g.beginPath();
    for (let k = 1, y = hz; y < H; k++) {
      const step = (H - hz) * 0.06 * Math.pow(1.35, k);
      const y2 = Math.min(H, y + step);
      g.moveTo(0, y2); g.lineTo(W, y2);
      const tw = step * 3.2;
      for (let x = (k % 2) * tw * 0.5; x < W; x += tw) { g.moveTo(x, y); g.lineTo(x, y2); }
      y = y2;
    }
    g.stroke();
    const cwTop = A.w * 0.42, cwBot = Math.min(W * 0.62, A.w * 1.6);
    g.beginPath();
    g.moveTo(A.x - cwTop / 2, hz); g.lineTo(A.x + cwTop / 2, hz);
    g.lineTo(A.x + cwBot / 2, H); g.lineTo(A.x - cwBot / 2, H);
    g.closePath();
    const cg = g.createLinearGradient(0, hz, 0, H);
    cg.addColorStop(0, '#6a1018');
    cg.addColorStop(1, '#a51d29');
    g.fillStyle = cg;
    g.fill();
    g.lineWidth = Math.max(3, U * 0.8);
    g.strokeStyle = GOLD_D;
    g.stroke();
    g.beginPath();
    g.moveTo(A.x - cwTop * 0.38, hz); g.lineTo(A.x - cwBot * 0.4, H);
    g.moveTo(A.x + cwTop * 0.38, hz); g.lineTo(A.x + cwBot * 0.4, H);
    g.lineWidth = Math.max(1.5, U * 0.35);
    g.strokeStyle = 'rgba(246,201,78,0.7)';
    g.stroke();
    // Baseboard shadow, vignette, warm haze.
    const bs = g.createLinearGradient(0, hz - U * 4, 0, hz + U * 3);
    bs.addColorStop(0, 'rgba(0,0,0,0)');
    bs.addColorStop(0.55, 'rgba(0,0,0,0.5)');
    bs.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bs;
    g.fillRect(0, hz - U * 4, W, U * 7);
    const vig = g.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.3, W / 2, H * 0.45, Math.hypot(W, H) * 0.62);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(8,3,0,0.72)');
    g.fillStyle = vig;
    g.fillRect(0, 0, W, H);
  }

  background(now) {
    const { ctx, W, H } = this;
    this.ensureBg();
    ctx.drawImage(this.bgCanvas, 0, 0, W, H);
    if (this.bgBusy) return; // a game viewport covers the hall: skip the animated layers
    const t = now / 1000;
    const L = this.hall();
    const { U } = L;
    const lowQ = this.lowQuality;
    ctx.save();
    // Moonlight shafts from the rose window, with floating dust.
    const A = L.arch;
    const rcy = A.top + A.w * 0.28 * 1.45;
    ctx.globalCompositeOperation = 'lighter';
    for (let k = -1; k <= 1; k++) {
      const a = 0.035 + 0.015 * Math.sin(t * 0.7 + k * 2);
      const sg = ctx.createLinearGradient(0, rcy, 0, H);
      sg.addColorStop(0, `rgba(255,214,150,${a})`);
      sg.addColorStop(1, 'rgba(255,214,150,0)');
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.moveTo(A.x + k * A.w * 0.12 - A.w * 0.06, rcy);
      ctx.lineTo(A.x + k * A.w * 0.12 + A.w * 0.06, rcy);
      ctx.lineTo(A.x + k * A.w * 0.5 + A.w * 0.2, H);
      ctx.lineTo(A.x + k * A.w * 0.5 - A.w * 0.2, H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#ffe2b0';
    for (const m of MOTES) {
      const x = A.x + (m.x - 0.5) * A.w * 1.2 + Math.sin(t * 0.3 + m.ph) * U * 2;
      const y = rcy + ((m.y + t * 0.012 * m.z) % 1) * (H - rcy);
      ctx.globalAlpha = 0.25 + 0.35 * Math.abs(Math.sin(t * 0.8 + m.ph));
      ctx.fillRect(x, y, 1.6 * m.z, 1.6 * m.z);
    }
    ctx.globalAlpha = 1;
    // Torch glow (flickering) + embers.
    for (const [i, tc] of L.torches.entries()) {
      const fl = 1 + 0.06 * Math.sin(t * 9 + i * 3) + 0.04 * Math.sin(t * 23 + i);
      const gr = ctx.createRadialGradient(tc.x, tc.y - U * 3, 0, tc.x, tc.y - U * 3, U * 22 * fl);
      gr.addColorStop(0, 'rgba(255,170,70,0.3)');
      gr.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = gr;
      ctx.fillRect(tc.x - U * 25, tc.y - U * 28, U * 50, U * 50);
    }
    const nE = lowQ ? 24 : EMBERS.length;
    for (let k = 0; k < nE; k++) {
      const e = EMBERS[k];
      const tc = L.torches[e.torch % L.torches.length];
      const age = (t * e.sp + e.ph) % 1;
      const x = tc.x + e.dx * U * 1.2 + Math.sin(age * 7 + e.wob) * U * 2.2 * age;
      const y = tc.y - U * 4 - age * H * 0.32;
      ctx.globalAlpha = (1 - age) * (0.6 + 0.4 * Math.sin(t * 15 + k));
      ctx.fillStyle = age < 0.4 ? '#ffd27a' : '#ff8a3a';
      const sz = e.s * (1 - age * 0.6);
      ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // Torch flames.
    for (const [i, tc] of L.torches.entries()) flame(ctx, tc.x, tc.y - U * 1.1, U * 5.2, t, i * 1.7);
    // Waving team banners.
    for (const b of L.banners) clothBanner(ctx, b.x, H * 0.045 + 3, L.bw, L.bl, PC[b.k], t, b.k * 1.3, b.k);
    ctx.restore();
  }

  drawGame(f) {
    const { ctx, d, fx } = this;
    const { def, snap, gview, L } = f;
    const mods = snap.g.m || [];
    const has = (m) => mods.includes(m);
    const gt = snap.g.t;
    const focus = def.focus ? safe(() => def.focus(gview), null) : null;
    const shakeK = f.settings.shake === false ? 0 : 1;
    // Everything a game render receives is indexed by SEAT.
    const seats = this.seats, pl = snap.pl || [];
    const rBase = {
      field: null, viewer: null, T: gt, n: seats.length,
      roster: seats.map((s) => ({ char: pl[s]?.c || DEFAULT_CHARS[s], color: this.cmap?.[s] ?? s })),
      // Team of each seat in a team match of a team game (same as g.teams in the simulation), else null.
      teams: snap.tm && def.teams === true ? seats.map((s) => (pl[s]?.tm === 1 ? 1 : 0)) : null,
      colors: seats.map((s) => C[s].main),
      names: seats.map((s) => pl[s]?.n || f.names?.[s] || `Giocatore ${s + 1}`),
      variant: snap.g.v, mods: modFlagsClient(mods), ended: snap.ph === 'finish' || snap.ph === 'result',
    };
    f.rBase = rBase;
    let projs = null, loading = false;
    if (this.use3d(def, f)) {
      const t3 = performance.now();
      const out = this.stage.render({
        def, gview, views: L.views, gameKey: this.gameKey, gt, dt: f.dt, r: rBase, mods, mode: L.mode, focus,
        shake: (v) => fx.shakeOffset(f.now / 1000, Math.min(v.w, v.h) * 0.035 * shakeK),
      });
      // Models still downloading: no 2D fallback, just a "loading" card (the stage keeps its scene).
      if (out === 'loading' || (!out && this.stage.loading)) loading = true;
      else projs = out;
      if (window.__perf) window.__perf.add('r3d', performance.now() - t3);
    }
    if (!projs && !loading) this.stage?.hide();
    L.views.forEach((v, idx) => {
      if (loading) this.drawLoading(v, f.now);
      else if (projs) this.drawView3d(f, v, projs[idx], focus, has);
      else this.drawView2d(f, v, focus, has, mods, gt);
      // Screen-space overlays for this viewport.
      if (has('tubo')) this.crt(v, f.now);
      if (has('disco')) this.disco(v, gt);
      if (snap.ph === 'finish') this.vignette(v, 0.55);
      if (v.inset) {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 2;
        ctx.strokeRect(v.x, v.y, v.w, v.h);
      }
      // Split screens: a colored frame + name tag tells whose field is whose.
      if (v.field !== null && v.field !== undefined && L.views.length > 1) this.fieldTag(f, v);
    });
    if (L.empty) this.standings(f, L.empty);
  }

  drawLoading(v, now) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = '#160d08';
    ctx.fillRect(v.x, v.y, v.w, v.h);
    const cx = v.x + v.w / 2, cy = v.y + v.h / 2, r = Math.min(v.w, v.h) * 0.06;
    crest(ctx, cx, cy - r * 1.2, r * 1.3);
    const t = now / 1000;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(3, r * 0.22);
    ctx.strokeStyle = 'rgba(246,201,78,0.2)';
    ctx.beginPath(); ctx.arc(cx, cy - r * 1.2, r * 1.25, 0, TAU); ctx.stroke();
    ctx.strokeStyle = GOLD;
    ctx.beginPath(); ctx.arc(cx, cy - r * 1.2, r * 1.25, t * 5, t * 5 + 1.8); ctx.stroke();
    text(ctx, 'Caricamento' + '.'.repeat(1 + (Math.floor(t * 3) % 3)), cx, cy + r * 1.1, Math.max(14, Math.min(v.w, v.h) * 0.05), '#fff2d2', 'center', 800, true);
    ctx.restore();
  }

  // Colored border + name of the player owning a split field.
  fieldTag(f, v) {
    const { ctx } = this;
    const slot = this.seats[v.field];
    if (slot === undefined) return;
    const col = C[slot];
    ctx.save();
    ctx.strokeStyle = col.main;
    ctx.lineWidth = v.inset ? 3 : 4;
    ctx.strokeRect(v.x + 1.5, v.y + 1.5, v.w - 3, v.h - 3);
    const name = f.snap.pl?.[slot]?.n || '';
    const fs = Math.max(11, Math.min(18, v.h * 0.045));
    ctx.font = `800 ${fs}px ${FONT}`;
    const tw = ctx.measureText(name).width + fs * 2.2;
    ctx.fillStyle = col.dark + 'e6';
    roundRect(ctx, v.x + 6, v.y + 6, tw, fs * 1.6, fs * 0.5); ctx.fill();
    charBadge(ctx, v.x + 6 + fs * 0.85, v.y + 6 + fs * 0.8, fs * 0.62, slot, f.snap.pl?.[slot]?.c, { bot: f.snap.pl?.[slot]?.bot });
    text(ctx, name, v.x + 6 + fs * 1.65, v.y + 6 + fs * 0.82, fs, '#fff', 'left', 800);
    ctx.restore();
  }

  // Standings panel in the empty cell of a 3-player split screen.
  standings(f, r) {
    const { ctx } = this;
    const s = f.snap;
    ctx.save();
    woodPanel(ctx, r.x, r.y, r.w, r.h, 0, { shadow: false });
    const U = Math.min(r.h / 9, r.w / 7);
    outlined(ctx, '🏆 Classifica', r.x + r.w / 2, r.y + U * 1.2, U * 0.8, GOLD, 'center', 900, { depth: 0.05, font: TITLE_FONT });
    const rows = this.seats.slice().sort((a, b) => (s.sc?.[b] || 0) - (s.sc?.[a] || 0) || a - b);
    rows.forEach((slot, k) => {
      const y = r.y + U * (2.8 + k * 1.75);
      const x0 = r.x + r.w * 0.12;
      ctx.fillStyle = C[slot].main + '40';
      roundRect(ctx, x0 - U * 0.4, y - U * 0.7, r.w * 0.76 + U * 0.8, U * 1.4, U * 0.3); ctx.fill();
      ctx.strokeStyle = 'rgba(246,201,78,0.4)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      text(ctx, `${k + 1}°`, x0 + U * 0.3, y, U * 0.7, '#fff', 'center', 900);
      charBadge(ctx, x0 + U * 1.5, y, U * 0.55, slot, s.pl?.[slot]?.c, { bot: s.pl?.[slot]?.bot });
      text(ctx, s.pl?.[slot]?.n || '', x0 + U * 2.3, y, Math.min(U * 0.7, (r.w * 0.45 * 1.7) / Math.max(6, (s.pl?.[slot]?.n || '').length)), C[slot].light, 'left', 800);
      scoreChip(ctx, `${s.sc?.[slot] ?? 0}`, x0 + r.w * 0.76 - U * 0.4, y, U * 0.55, slot);
    });
    ctx.restore();
  }

  // Slot of whoever looks at an overlay (null = shared screen).
  viewerSlot(f, o) {
    if (o && o.viewer !== null && o.viewer !== undefined) return this.seats[o.viewer] ?? null;
    return f.mode === 'solo' || f.mode === 'pad' ? f.me : null;
  }

  use3d(def, f) {
    return !!(def.render3d && this.stage?.ok && !this.force2d && f.settings.gfx3d !== false && !this.stage.errors.has(def.id));
  }

  // 3D viewport: the WebGL canvas shows through; effects are projected over it.
  drawView3d(f, v, P, focus, has) {
    const { ctx, d, fx, dpr } = this;
    ctx.clearRect(v.x, v.y, v.w, v.h);
    const viewerRot = v.viewer === null || v.viewer === undefined ? 0 : f.L.physRot[v.viewer] || 0;
    const ang = (viewerRot * Math.PI) / 2;
    const wrap = {
      at: (x, y, h) => P.at(ctx, dpr, x, y, h),
      upright: (x, y) => P.upright(ctx, dpr, x, y, ang),
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.x, v.y, v.w, v.h);
    ctx.clip();
    d.t = f.snap.g.t;
    d.px = 1 / Math.max(0.01, P.scaleAt(f.def.world.w / 2, f.def.world.h / 2, 0));
    d.textRot = 0;
    fx.drawWorld(d, v.field ?? null, wrap);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (has('nebbia') && focus) {
      ctx.beginPath();
      ctx.rect(v.x, v.y, v.w, v.h);
      const r = Math.min(f.def.world.w, f.def.world.h) * (0.2 + 0.015 * Math.sin(f.snap.g.t * 2));
      for (const p of focus) {
        const a = P.proj(p.x, p.y, 0);
        const s = P.scaleAt(p.x, p.y, 0);
        ctx.moveTo(a.x + r * s, a.y);
        ctx.ellipse(a.x, a.y, r * s, r * s * 0.85, 0, 0, Math.PI * 2, true);
      }
      ctx.fillStyle = 'rgba(200,200,215,0.97)';
      ctx.fill('evenodd');
    }
    ctx.restore();
  }

  drawView2d(f, v, focus, has, mods, gt) {
    const { ctx, d, fx } = this;
    const { def, snap, gview, L } = f;
    {
      ctx.save();
      ctx.beginPath();
      ctx.rect(v.x, v.y, v.w, v.h);
      ctx.clip();
      ctx.fillStyle = '#160d08';
      ctx.fillRect(v.x, v.y, v.w, v.h);
      let rot = (v.rot * Math.PI) / 2;
      let zoom = 1;
      let cx = def.world.w / 2, cy = def.world.h / 2;
      if (has('sottosopra')) rot += gt * 0.35;
      if (has('ubriaco')) { rot += Math.sin(gt * 1.3) * 0.1; zoom *= 1 + Math.sin(gt * 0.9) * 0.06; }
      if (has('disco')) zoom *= 1 + Math.max(0, Math.sin(gt * Math.PI * 4)) * 0.03;
      if (has('cugino') && focus) { zoom *= 1.7; cx = (focus[0].x + focus[1].x) / 2; cy = (focus[0].y + focus[1].y) / 2; }
      const sh = fx.shakeOffset(f.now / 1000, Math.min(v.w, v.h) * 0.035 * (f.settings.shake === false ? 0 : 1));
      const sc = v.scale * zoom;
      ctx.translate(v.x + v.w / 2 + sh.x, v.y + v.h / 2 + sh.y);
      ctx.rotate(rot + sh.r);
      if (has('specchio')) ctx.scale(-1, 1);
      ctx.scale(sc, sc);
      ctx.translate(-cx, -cy);
      d.t = gt;
      d.px = 1 / sc;
      const viewerRot = v.viewer === null || v.viewer === undefined ? 0 : L.physRot[v.viewer] || 0;
      d.textRot = (viewerRot * Math.PI) / 2 - rot;
      const r = { ...f.rBase, field: v.field, viewer: v.viewer ?? null };
      try {
        ctx.save();
        def.render(d, gview, r);
        ctx.restore();
      } catch (err) {
        ctx.restore();
        if (!this.renderErrors.has(def.id)) { this.renderErrors.add(def.id); console.error(`[render] ${def.id}:`, err); }
      }
      ctx.globalAlpha = 1;
      fx.drawWorld(d, v.field ?? null);
      if (has('nebbia') && focus) this.fog(focus, def.world, gt);
      ctx.restore();
    }
  }

  fog(focus, world, t) {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-world.w, -world.h, world.w * 3, world.h * 3);
    const r = Math.min(world.w, world.h) * (0.2 + 0.015 * Math.sin(t * 2));
    for (const p of focus) { ctx.moveTo(p.x + r, p.y); ctx.arc(p.x, p.y, r, 0, Math.PI * 2, true); }
    ctx.fillStyle = 'rgba(200,200,215,0.97)';
    ctx.fill('evenodd');
    ctx.restore();
  }

  crt(v, now) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#000';
    for (let y = v.y; y < v.y + v.h; y += 4) ctx.fillRect(v.x, y, v.w, 2);
    ctx.globalAlpha = 0.07 + 0.04 * Math.sin(now / 60);
    ctx.fillStyle = '#7fff7f';
    ctx.fillRect(v.x, v.y, v.w, v.h);
    ctx.restore();
    this.vignette(v, 0.7);
  }

  disco(v, t) {
    const { ctx } = this;
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = `hsl(${(t * 140) % 360}, 90%, 55%)`;
    ctx.fillRect(v.x, v.y, v.w, v.h);
    ctx.restore();
  }

  vignette(v, a) {
    const { ctx } = this;
    const g = ctx.createRadialGradient(v.x + v.w / 2, v.y + v.h / 2, Math.min(v.w, v.h) * 0.3, v.x + v.w / 2, v.y + v.h / 2, Math.max(v.w, v.h) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${a})`);
    ctx.fillStyle = g;
    ctx.fillRect(v.x, v.y, v.w, v.h);
  }

  // ---------- HUD ----------
  // Top bar: a carved wooden beam with one plate per seat (character icon, name, match score, in-game value) around the timer.
  drawHud(f) {
    const s = f.snap;
    if (!s || s.ph === 'lobby') return;
    if (f.L.hudShared) return; // drawn inside each overlay region
    const { ctx, W } = this;
    const h = f.L.hudTop;
    if (!h) return;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#2c180a');
    g.addColorStop(0.45, '#4e2f16');
    g.addColorStop(1, '#2a1609');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, h);
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = texPattern(ctx, 'wood');
    ctx.fillRect(0, 0, W, h);
    ctx.restore();
    const seats = this.seats, n = seats.length;
    const fs = Math.round(h * 0.42);
    // 2 vs 2: Red team on the left, Blue team on the right, team scores next to the timer.
    const teams = !!s.tm && n === 4;
    const order = teams ? [0, 1].flatMap((t) => seats.map((sl, k) => (teamOf(s.pl?.[sl]) === t ? k : -1)).filter((k) => k >= 0)) : seats.map((_, k) => k);
    const centerW = fs * (teams ? 9.4 : 5.2);
    const nl = Math.ceil(n / 2), nr = n - nl;
    const cells = [];
    const lw = (W - centerW) / 2;
    for (let k = 0; k < nl; k++) cells.push({ x0: (lw / nl) * k, x1: (lw / nl) * (k + 1), align: 'left' });
    for (let k = 0; k < nr; k++) {
      const x0 = W - lw + (lw / nr) * k;
      cells.push({ x0, x1: x0 + lw / nr, align: n === 2 ? 'right' : 'left' });
    }
    // Team cloth hanging behind each plate.
    cells.forEach((c, k) => {
      const col = C[seats[order[k]]].main;
      const right = c.align === 'right';
      const x0 = right ? c.x1 : c.x0, dir = right ? -1 : 1, pw = (c.x1 - c.x0) * (n === 2 ? 1 : 0.92);
      const pg = ctx.createLinearGradient(x0, 0, x0 + dir * pw, 0);
      pg.addColorStop(0, col + '70');
      pg.addColorStop(1, col + '00');
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0 + dir * pw, 0);
      ctx.lineTo(x0 + dir * (pw - h * 0.7), h);
      ctx.lineTo(x0, h);
      ctx.closePath();
      ctx.fill();
      if (n > 2 && k) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(c.x0, h * 0.12, 2, h * 0.76); ctx.fillStyle = 'rgba(255,220,160,0.12)'; ctx.fillRect(c.x0 + 2, h * 0.12, 1, h * 0.76); }
    });
    // Gold trim + team colors along the bottom edge, soft shadow on the arena.
    ctx.fillStyle = '#140904';
    ctx.fillRect(0, h - 5, W, 5);
    const gg = ctx.createLinearGradient(0, h - 5, 0, h - 3);
    gg.addColorStop(0, GOLD_HI);
    gg.addColorStop(1, GOLD_D);
    ctx.fillStyle = gg;
    ctx.fillRect(0, h - 5, W, 2);
    const eg = ctx.createLinearGradient(0, 0, W, 0);
    order.forEach((q, k) => eg.addColorStop(n === 1 ? 0 : k / (n - 1), C[seats[q]].main));
    ctx.fillStyle = eg;
    ctx.fillRect(0, h - 2.5, W, 2.5);
    const sg = ctx.createLinearGradient(0, h, 0, h + 10);
    sg.addColorStop(0, 'rgba(0,0,0,0.5)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, h, W, 10);
    if (h > 30) for (const x of [7, W - 7]) rivet(ctx, x, h / 2, Math.min(4, h * 0.09));
    if (teams) {
      // A team pennant behind each half of the bar.
      for (const t of [0, 1]) {
        const x0 = t ? W - lw : 0, x1 = t ? W : lw;
        const tg = ctx.createLinearGradient(0, 0, 0, h);
        tg.addColorStop(0, TEAMS[t].main + '55');
        tg.addColorStop(1, TEAMS[t].dark + '20');
        ctx.fillStyle = tg;
        ctx.fillRect(x0, 0, x1 - x0, h - 5);
        ctx.fillStyle = TEAMS[t].main;
        ctx.fillRect(t ? x0 : x1 - 3, h * 0.08, 3, h * 0.8);
      }
    }
    cells.forEach((c, k) => this.hudPlate(f, order[k], c.x0, c.x1, c.align, h, fs));
    this.hudCenter(f, W / 2, h / 2, fs);
    if (teams) for (const t of [0, 1]) teamShield(ctx, W / 2 + (t ? 1 : -1) * fs * 3.55, h / 2 + 1, fs * 1.02, t, teamScore(s, t), s.ph === 'result' && s.x?.team === t);
  }

  hudPlate(f, seat, x0, x1, align, h, fs) {
    const { ctx } = this;
    const s = f.snap;
    const slot = this.seats[seat];
    const pl = s.pl?.[slot];
    const dir = align === 'left' ? 1 : -1;
    const pad = Math.max(10, fs * 0.45);
    const xa = align === 'left' ? x0 + pad : x1 - pad;
    const y = h / 2;
    const win = s.ph === 'result' && s.x?.w === slot;
    // Character icon on a team-colored shield disc.
    const br = h * 0.36;
    charBadge(ctx, xa + dir * br, y + 1, br, slot, pl?.c, { glow: win, dim: pl && !pl.on, bot: pl?.bot });
    const tx = xa + dir * (br * 2 + fs * 0.35);
    const avail = x1 - x0 - pad * 2 - br * 2 - fs * 0.35;
    // In-game value (lives, points…) goes on the inner side when there is room.
    const hud = f.gview?.hud;
    const hudFs = fs * 0.8;
    let hudW = 0;
    if (hud && s.g && (hud.bar || (hud.p && hud.p[seat] !== undefined && hud.p[seat] !== null))) {
      hudW = hud.bar ? hudFs * 3.2 : hud.max && hud.max <= 8 ? hud.max * hudFs * 0.2 * 2.7 : hudFs * 2.6;
      if (hudW > avail * 0.55) hudW = 0;
    }
    const textW = Math.max(20, avail - (hudW ? hudW + fs * 0.45 : 0));
    const me = f.mode === 'solo' && f.me === slot;
    const name = (me ? '★ ' : '') + (pl?.n || f.names?.[slot] || `Giocatore ${slot + 1}`);
    const ns = fitSize(ctx, name, textW, fs * 0.62, fs * 0.4, 700);
    outlined(ctx, ellipsize(ctx, name, textW, ns, 700), tx, y - fs * 0.32, ns, C[slot].light, align, 700, { depth: 0, stroke: 'rgba(20,8,2,0.95)', lw: 0.22 });
    // Match score: team gems, or a compact "3/5" when the plate is narrow.
    const tg = s.tg || 5;
    const sc = s.sc?.[slot] || 0;
    const r = Math.max(3, fs * 0.17);
    if (tg * r * 2.6 <= textW) {
      for (let k = 0; k < tg; k++) gem(ctx, tx + dir * (r + k * r * 2.6), y + fs * 0.42, r, k < sc ? C[slot].main : null);
    } else {
      text(ctx, `${sc}/${tg}`, tx, y + fs * 0.42, fs * 0.48, C[slot].light, align, 900, true);
    }
    if (hudW) this.hudValue(hud, seat, tx + dir * (textW + fs * 0.45), y + 1, hudFs, align);
  }

  // In-game value of a seat (hud.p[seat] / hud.bar[seat]) in that seat's team color.
  hudValue(hud, seat, x, y, fs, align) {
    const { ctx } = this;
    const col = C[this.seats[seat]] || C[0];
    const val = hud.p?.[seat];
    const dir = align === 'left' ? 1 : -1;
    if (hud.bar) {
      const w = fs * 3.2, h = fs * 0.4;
      const bx = align === 'left' ? x : x - w;
      ctx.fillStyle = 'rgba(20,8,2,0.7)';
      roundRect(ctx, bx - 2, y - h / 2 - 2, w + 4, h + 4, h / 2 + 2); ctx.fill();
      ctx.strokeStyle = 'rgba(246,201,78,0.6)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const k = clamp01(hud.bar[seat] || 0);
      if (k > 0.001) {
        const fx0 = align === 'left' ? bx : bx + w * (1 - k);
        const g = ctx.createLinearGradient(0, y - h / 2, 0, y + h / 2);
        g.addColorStop(0, col.light);
        g.addColorStop(0.5, col.main);
        g.addColorStop(1, col.dark);
        ctx.fillStyle = g;
        roundRect(ctx, fx0, y - h / 2, w * k, h, h / 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        roundRect(ctx, fx0 + h * 0.25, y - h * 0.38, Math.max(0, w * k - h * 0.5), h * 0.22, h * 0.11); ctx.fill();
      }
      return;
    }
    if (val === undefined || val === null) return;
    if (hud.max && hud.max <= 8) {
      const r = fs * 0.2;
      for (let k = 0; k < hud.max; k++) {
        const px = x + dir * (r + k * r * 2.7);
        gem(ctx, px, y, r, k < val ? GOLD : null);
      }
    } else {
      const str = `${hud.label ? hud.label + ' ' : ''}${typeof val === 'number' ? Math.round(val * 10) / 10 : val}`;
      const size = fs * 0.6;
      ctx.font = `800 ${size}px ${FONT}`;
      const tw = ctx.measureText(str).width;
      const ph = size * 1.35, pw = tw + size * 0.9;
      const bx = align === 'left' ? x - size * 0.45 : x - pw + size * 0.45;
      ctx.fillStyle = 'rgba(20,8,2,0.7)';
      roundRect(ctx, bx, y - ph / 2, pw, ph, ph * 0.3); ctx.fill();
      ctx.strokeStyle = col.main;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      text(ctx, str, x, y, size, GOLD_HI, align, 800);
    }
  }

  hudCenter(f, x, y, fs) {
    const { ctx } = this;
    const s = f.snap;
    if (s.g && (s.ph === 'play' || s.ph === 'finish' || s.ph === 'countdown' || s.ph === 'intro')) {
      const left = s.g.left;
      const urgent = left <= 5 && s.ph === 'play';
      const pulse = urgent ? 1 + 0.15 * Math.abs(Math.sin(left * Math.PI)) : 1;
      const dur = f.def?.duration || f.gameById?.(s.g.id)?.duration || 60;
      timerBadge(ctx, x, y + 1, fs * 0.98, left, dur, urgent, pulse);
      const mod = s.g.m?.[0] ? MOD_BY_ID[s.g.m[0]] : null;
      if (mod) iconChip(ctx, mod.icon, x - fs * 1.75, y + 1, fs * 0.62, VIOLET);
      if (s.g.v) iconChip(ctx, '🤪', x + fs * 1.75, y + 1, fs * 0.62, '#ff8a3d');
    } else {
      logoText(ctx, 'RAFFICA!', x, y + 1, fs * 0.8);
    }
  }

  // HUD strip inside a shared-layout overlay region (near the viewer). The shared phone is 2 seats.
  sharedHud(f, o, w, h) {
    const { ctx } = this;
    const s = f.snap;
    const me = o.viewer, other = 1 - me;
    const sm = this.seats[me] ?? me, so = this.seats[other] ?? other;
    const bh = Math.max(26, Math.min(36, h * 0.12));
    const y = h - bh / 2 - 2;
    const g = ctx.createLinearGradient(0, h - bh - 4, 0, h);
    g.addColorStop(0, 'rgba(46,26,10,0.78)');
    g.addColorStop(1, 'rgba(26,12,4,0.92)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h - bh - 4, w, bh + 4);
    const eg = ctx.createLinearGradient(0, 0, w, 0);
    eg.addColorStop(0, C[sm].main);
    eg.addColorStop(0.5, GOLD);
    eg.addColorStop(1, C[so].main);
    ctx.fillStyle = eg;
    ctx.fillRect(0, h - bh - 5, w, 2);
    const fs = bh * 0.62;
    scoreChip(ctx, `${s.sc?.[sm] ?? 0}`, 14 + fs * 0.55, y, fs * 0.62, sm);
    scoreChip(ctx, `${s.sc?.[so] ?? 0}`, w - 14 - fs * 0.55, y, fs * 0.62, so);
    const hud = f.gview?.hud;
    if (hud && s.g) {
      this.hudValue(hud, me, 14 + fs * 1.6, y, fs * 1.3, 'left');
      this.hudValue(hud, other, w - 14 - fs * 1.6, y, fs * 1.3, 'right');
    }
    if (s.g && (s.ph === 'play' || s.ph === 'finish')) {
      const left = s.g.left;
      const urgent = left <= 5 && s.ph === 'play';
      const dur = f.def?.duration || f.gameById?.(s.g.id)?.duration || 60;
      timerBadge(ctx, w / 2, y, bh * 0.5, left, dur, urgent, urgent ? 1 + 0.12 * Math.abs(Math.sin(left * Math.PI)) : 1);
      const mod = s.g.m?.[0] ? MOD_BY_ID[s.g.m[0]] : null;
      if (mod) iconChip(ctx, mod.icon, w / 2 - fs * 2.2, y, fs * 0.55, VIOLET);
    }
  }

  // ---------- overlays ----------
  overlay(f, o, w, h) {
    const s = f.snap;
    if (!s) return;
    const { ctx } = this;
    switch (s.ph) {
      case 'pick': this.pickOverlay(f, o, w, h); break;
      case 'roulette': this.rouletteOverlay(f, w, h); break;
      case 'intro': this.introOverlay(f, o, w, h); break;
      case 'countdown': this.countdownOverlay(s, w, h); break;
      case 'result': this.resultOverlay(f, o, w, h); break;
      case 'final': this.finalOverlay(f, o, w, h); break;
      case 'pause': this.pauseOverlay(f, o, w, h); break;
      default: break;
    }
    if (f.L.hudShared && ['countdown', 'play', 'finish', 'result'].includes(s.ph)) this.sharedHud(f, o, w, h);
    // Big announcements: golden engraved letters, slightly tilted.
    for (const sy of this.fx.says) {
      const k = sy.t / sy.life;
      const pop = easeBack(Math.min(1, sy.t / 0.18));
      ctx.globalAlpha = k > 0.75 ? (1 - k) / 0.25 : 1;
      const size = Math.min(w / Math.max(6, sy.s.length * 0.78), sy.big ? h * 0.28 : h * 0.12) * pop;
      if (size > 1) {
        ctx.save();
        ctx.translate(w / 2, h * (sy.big ? 0.45 : 0.3));
        ctx.rotate(sy.big ? -0.06 : -0.03);
        const gr = ctx.createLinearGradient(0, -size * 0.45, 0, size * 0.45);
        gr.addColorStop(0, sy.big ? '#fffbe6' : '#ffffff');
        gr.addColorStop(0.5, sy.big ? GOLD : '#fff2d2');
        gr.addColorStop(1, sy.big ? '#d27a12' : '#f2c98a');
        outlined(ctx, sy.s, 0, 0, size, gr, 'center', 900, { depth: 0.08, font: TITLE_FONT });
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  }

  pickOverlay(f, o, w, h) {
    const { ctx } = this;
    const s = f.snap, x = s.x;
    if (!x?.cards) return;
    const who = x.who;
    dim(ctx, w, h, 0.45);
    sunburst(ctx, w / 2, h * 0.52, Math.hypot(w, h), 14, s.pt * 0.15, C[who].main, 0.08);
    const vs = this.viewerSlot(f, o);
    const meIsPicker = vs === null || vs === who;
    const title = `${s.pl?.[who]?.n || 'Chi ha perso'} sceglie la sfida!`;
    const tsize = Math.min(h * 0.062, w * 0.05);
    ribbon(ctx, w / 2, h * 0.12, Math.min(w * 0.94, measure(ctx, title, tsize, 900, TITLE_FONT) + tsize * 2.4), tsize * 1.8, C[who].main, C[who].dark);
    outlined(ctx, title, w / 2, h * 0.12, tsize, '#fff', 'center', 900, { depth: 0.06, font: TITLE_FONT });
    const n = 3, gap = w * 0.03;
    const cw = Math.min((w - gap * 4) / n, h * 0.55), ch = Math.min(h * 0.62, cw * 1.35);
    const total = cw * n + gap * (n - 1);
    const enter = s.pt;
    x.cards.forEach((id, k) => {
      const def = f.gameById(id);
      const sel = k === x.sel;
      const a = easeBack((enter - k * 0.08) / 0.35);
      if (a <= 0.01) return;
      const cx = w / 2 - total / 2 + k * (cw + gap) + cw / 2;
      const bob = sel ? Math.sin(s.pt * 5) * h * 0.006 : 0;
      const cy = h * 0.52 + (sel ? -h * 0.025 : 0) + bob + (1 - a) * h * 0.3;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(sel ? Math.sin(s.pt * 3) * 0.012 : (k - 1) * 0.02);
      ctx.translate(-cx, -cy);
      this.gameCard(def, cx, cy, cw * (sel ? 1.06 : 0.94), ch * (sel ? 1.06 : 0.94), sel ? C[who].main : null, sel);
      ctx.restore();
    });
    // Timer: a candle-like bar on a wooden track.
    const k = clamp01(1 - s.pt / s.pd);
    const bx = w * 0.2, bw = w * 0.6, bh = Math.max(9, h * 0.016);
    ctx.fillStyle = '#2a1609';
    roundRect(ctx, bx - 3, h * 0.9 - 3, bw + 6, bh + 6, bh); ctx.fill();
    ctx.strokeStyle = GOLD_D;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (k > 0) {
      const g = ctx.createLinearGradient(0, h * 0.9, 0, h * 0.9 + bh);
      g.addColorStop(0, C[who].light);
      g.addColorStop(1, C[who].main);
      ctx.fillStyle = g;
      roundRect(ctx, bx, h * 0.9, bw * k, bh, bh / 2); ctx.fill();
    }
    const hs = Math.min(h * 0.04, w * 0.04);
    if (meIsPicker) hintLine(ctx, ['◀ ▶ scegli', '  ·  ', { b: 'A' }, 'conferma'], w / 2, h * 0.955, hs);
    else text(ctx, `${s.pl?.[who]?.n || 'L\'ultimo in classifica'} sta scegliendo…`, w / 2, h * 0.955, hs, '#fff2d2', 'center', 700, true);
  }

  // A game as a parchment card with a cloth header in the game's own hue.
  gameCard(def, cx, cy, cw, ch, border, glow) {
    const { ctx } = this;
    const x0 = cx - cw / 2, y0 = cy - ch / 2, rad = cw * 0.05;
    const hue = hueOf(def?.id || '?');
    if (glow && border && this.d.quality) {
      ctx.save();
      ctx.shadowColor = border;
      ctx.shadowBlur = 30;
      roundRect(ctx, x0, y0, cw, ch, rad);
      ctx.fillStyle = border;
      ctx.fill();
      ctx.restore();
    }
    parchment(ctx, x0, y0, cw, ch, rad, { frame: glow && border ? border : '#5a3416', lw: glow ? 5 : 3 });
    // Cloth header band with a zigzag hem.
    const hb = ch * 0.27;
    ctx.save();
    roundRect(ctx, x0, y0, cw, ch, rad);
    ctx.clip();
    const hg = ctx.createLinearGradient(0, y0, 0, y0 + hb);
    hg.addColorStop(0, `hsl(${hue},70%,50%)`);
    hg.addColorStop(1, `hsl(${(hue + 20) % 360},65%,32%)`);
    ctx.fillStyle = hg;
    hemPath(ctx, x0, y0, cw, hb, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(246,201,78,0.85)';
    ctx.lineWidth = Math.max(1.5, cw * 0.008);
    ctx.stroke();
    ctx.clip();
    stripes(ctx, x0, y0, cw, hb * 1.2, 'rgba(255,255,255,0.07)', cw * 0.09);
    ctx.restore();
    if (glow && border) { roundRect(ctx, x0, y0, cw, ch, rad); ctx.lineWidth = 5; ctx.strokeStyle = border; ctx.stroke(); }
    if (!def) return;
    const fs = cw * 0.11;
    outlined(ctx, def.name, cx, cy - ch * 0.37, Math.min(fs * 1.0, (cw * 1.28) / Math.max(6, def.name.length)), '#fff', 'center', 900, { depth: 0.07, font: TITLE_FONT });
    // Verb on a red wax-seal plaque.
    const vs = fs * 0.9;
    const verb = def.verb || '';
    if (verb) {
      ctx.save();
      ctx.translate(cx, cy - ch * 0.12);
      ctx.rotate(-0.06);
      const vw = Math.min(cw * 0.9, measure(ctx, verb, vs, 900) + vs * 1.2);
      ctx.fillStyle = 'rgba(60,20,4,0.35)';
      roundRect(ctx, -vw / 2 + 3, -vs * 0.75 + 4, vw, vs * 1.5, vs * 0.35); ctx.fill();
      const sg = ctx.createLinearGradient(0, -vs * 0.75, 0, vs * 0.75);
      sg.addColorStop(0, '#d84a4a');
      sg.addColorStop(1, '#8a1620');
      ctx.fillStyle = sg;
      roundRect(ctx, -vw / 2, -vs * 0.75, vw, vs * 1.5, vs * 0.35); ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = GOLD;
      ctx.stroke();
      outlined(ctx, verb, 0, vs * 0.04, Math.min(vs, ((cw * 0.85) / Math.max(4, verb.length)) * 1.8), '#fff6e0', 'center', 900, { depth: 0, lw: 0.14, stroke: '#4a0a10' });
      ctx.restore();
    }
    wrapText(ctx, def.rule, cx, cy + ch * 0.07, cw * 0.84, fs * 0.72, PARCH_INK);
    ctx.fillStyle = 'rgba(120,70,25,0.45)';
    ctx.fillRect(cx - cw * 0.3, cy + ch * 0.34, cw * 0.6, 1.5);
    text(ctx, def.inspired || '', cx, cy + ch * 0.41, Math.min(fs * 0.55, (cw * 1.8) / Math.max(8, (def.inspired || '').length)), PARCH_SOFT, 'center', 600);
  }

  rouletteOverlay(f, w, h) {
    const { ctx } = this;
    const s = f.snap, x = s.x;
    if (!x?.list) return;
    dim(ctx, w, h, 0.3);
    const t = s.pt;
    // Wooden sign with the round number.
    const ts = Math.min(h * 0.065, w * 0.07);
    const sw = Math.min(w * 0.7, ts * 7.5), shh = ts * 1.8;
    marquee(ctx, w / 2 - sw / 2, h * 0.14 - shh / 2, sw, shh, shh * 0.2, t);
    outlined(ctx, `ROUND ${s.rd}`, w / 2, h * 0.14, ts, GOLD, 'center', 900, { depth: 0.07, font: TITLE_FONT });
    const n = x.list.length;
    const pos = easeOut(s.pt / (s.pd * 0.85)) * (n - 1);
    const ch = Math.min(h * 0.16, 110);
    const cw = Math.min(w * 0.82, 520);
    // The wheel's window.
    const wx = w / 2 - cw / 2 - ch * 0.25, wy = h * 0.25, ww = cw + ch * 0.5, wh = h * 0.55;
    marquee(ctx, wx, wy - ch * 0.12, ww, wh + ch * 0.24, ch * 0.2, t);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, h * 0.25, w, h * 0.55);
    ctx.clip();
    for (let k = 0; k < n; k++) {
      const off = k - pos;
      if (Math.abs(off) > 2.2) continue;
      const y = h * 0.52 + off * ch * 1.05;
      const def = f.gameById(x.list[k]);
      const a = 1 - Math.min(1, Math.abs(off) * 0.55);
      const on = Math.abs(off) < 0.5;
      ctx.globalAlpha = a;
      const hue = hueOf(def?.id || '?');
      if (on) {
        const g = ctx.createLinearGradient(0, y - ch / 2, 0, y + ch * 0.42);
        g.addColorStop(0, `hsl(${hue},70%,50%)`);
        g.addColorStop(1, `hsl(${(hue + 20) % 360},65%,30%)`);
        ctx.fillStyle = g;
        roundRect(ctx, w / 2 - cw / 2, y - ch / 2, cw, ch * 0.92, 10);
        ctx.fill();
      } else parchment(ctx, w / 2 - cw / 2, y - ch / 2, cw, ch * 0.92, 10, { shadow: false, frame: 'rgba(90,52,22,0.8)', lw: 2 });
      roundRect(ctx, w / 2 - cw / 2, y - ch / 2, cw, ch * 0.92, 10);
      ctx.strokeStyle = on ? GOLD : 'rgba(90,52,22,0.9)';
      ctx.lineWidth = on ? 4 : 2;
      ctx.stroke();
      const nm = def?.name || '?';
      outlined(ctx, nm, w / 2, y - ch * 0.04, Math.min(ch * 0.34, (cw * 1.35) / Math.max(6, nm.length)), on ? '#fff' : PARCH_INK, 'center', 900, on ? { depth: 0.06, font: TITLE_FONT } : { depth: 0, lw: 0.0001, stroke: 'rgba(0,0,0,0)', font: TITLE_FONT });
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    // Shadowed edges of the window.
    for (const [y0, y1] of [[h * 0.25, h * 0.33], [h * 0.8, h * 0.72]]) {
      const g = ctx.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(0, 'rgba(36,18,6,0.95)');
      g.addColorStop(1, 'rgba(36,18,6,0)');
      ctx.fillStyle = g;
      ctx.fillRect(wx + 6, Math.min(y0, y1), ww - 12, Math.abs(y1 - y0));
    }
    // Pointer arrows.
    const bounce = Math.sin(t * 10) * 3;
    tri(ctx, w / 2 - cw / 2 - 18 + bounce, h * 0.52, 14, 1, GOLD);
    tri(ctx, w / 2 + cw / 2 + 18 - bounce, h * 0.52, 14, -1, GOLD);
  }

  introOverlay(f, o, w, h) {
    const { ctx } = this;
    const s = f.snap, x = s.x;
    const def = f.gameById(x?.id || s.g?.id);
    if (!def) return;
    const appear = easeBack(Math.min(1, s.pt / 0.35));
    dim(ctx, w, h, 0.7);
    const cw = Math.min(w * 0.93, 820), chh = Math.min(h * 0.94, 680);
    // Lay out once "dry" to measure, then shrink the unit until everything fits in the card.
    let U = chh / 100;
    for (let k = 0; k < 6; k++) {
      const used = this.introContent(f, o, def, w, h, cw, 0, U, true);
      if (used <= chh * 0.98) break;
      U *= (chh * 0.97) / used;
    }
    ctx.save();
    ctx.translate(w / 2, h / 2);
    // The scroll unrolls vertically while it pops in.
    ctx.scale(appear, Math.min(1.05, appear * appear));
    ctx.rotate((1 - Math.min(1, s.pt / 0.35)) * -0.06);
    ctx.translate(-w / 2, -h / 2);
    const top = h / 2 - chh / 2;
    const left = w / 2 - cw / 2;
    const rad = Math.min(10, cw * 0.02);
    parchment(ctx, left, top, cw, chh, rad);
    // Cloth header band behind round / name / verb.
    const hue = hueOf(def.id);
    ctx.save();
    roundRect(ctx, left, top, cw, chh, rad);
    ctx.clip();
    const hb = U * 24.6;
    const hg = ctx.createLinearGradient(0, top, 0, top + hb);
    hg.addColorStop(0, `hsl(${hue},68%,46%)`);
    hg.addColorStop(1, `hsl(${(hue + 25) % 360},62%,26%)`);
    ctx.fillStyle = hg;
    hemPath(ctx, left, top, cw, hb, 12);
    ctx.fill();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = Math.max(2, U * 0.5);
    ctx.stroke();
    ctx.clip();
    sunburst(ctx, w / 2, top + U * 14, cw, 18, s.pt * 0.2, '#ffe9b0', 0.08);
    stripes(ctx, left, top, cw, hb, 'rgba(255,255,255,0.05)', U * 4);
    ctx.restore();
    // Wooden rollers at both ends of the scroll.
    const rh = Math.max(10, U * 3.2);
    roller(ctx, left - rh * 0.7, top - rh * 0.55, cw + rh * 1.4, rh);
    roller(ctx, left - rh * 0.7, top + chh - rh * 0.45, cw + rh * 1.4, rh);
    this.introContent(f, o, def, w, h, cw, top, U, false, chh);
    ctx.restore();
  }

  // Draws (or only measures, when dry) the rule scroll content. Returns the used height.
  introContent(f, o, def, w, h, cw, top, U, dry, chh = 0) {
    const { ctx } = this;
    const s = f.snap, x = s.x || {};
    const T = (str, xx, yy, size, color, align = 'center', weight = 800, outline = false) => { if (!dry) text(ctx, str, xx, yy, size, color, align, weight, outline); };
    const help = def.help || {};
    const left = w / 2 - cw / 2;
    let y = top + U * 6.2;
    if (!dry) outlined(ctx, x.replay ? 'SPAREGGIO TURBO!' : `ROUND ${s.rd}`, w / 2, y, U * 3.3, 'rgba(255,246,220,0.95)', 'center', 900, { depth: 0, lw: 0.2, font: TITLE_FONT });
    y += U * 7.3;
    if (!dry) outlined(ctx, def.name, w / 2, y, Math.min(U * 8, (cw * 1.4) / Math.max(6, def.name.length)), '#fff', 'center', 900, { depth: 0.08, font: TITLE_FONT });
    y += U * 7.5;
    if (!dry) outlined(ctx, def.verb || '', w / 2, y, U * 5.6, GOLD, 'center', 900, { depth: 0.08 });
    y += U * 6.4;
    y = para(ctx, `🏆 ${help.goal || def.rule}`, w / 2, y, cw * 0.86, U * 4, PARCH_INK, 'center', 700, dry);
    y += U * 2.5;
    // Controls table: one row per input, with the real keys of whoever plays on this screen.
    const vs = this.viewerSlot(f, o);
    const who = vs !== null ? [vs] : (f.local || []).filter((sl) => this.seats.includes(sl));
    const c = def.controls || {};
    const rows = [];
    if (c.dir) rows.push({ k: 'dir', title: c.dirLabel || c.label || (c.dir === 'h' ? 'Sinistra / Destra' : c.dir === 'v' ? 'Su / Giù' : 'Muovi'), desc: help.dir });
    if (c.a) rows.push({ k: 'a', title: c.a, desc: help.a });
    if (c.b) rows.push({ k: 'b', title: c.b, desc: help.b });
    const colW = cw * 0.32, bx = left + cw * 0.06;
    const descX = bx + colW + U * 2.5, descW = cw * 0.88 - colW - U * 3;
    for (const r of rows) {
      const y0 = y;
      const badgeH = U * 5 + who.length * U * 3.4;
      const head = r.k === 'dir' ? `🕹️ ${r.title}` : `${r.k === 'a' ? 'Ⓐ' : 'Ⓑ'} ${r.title}`;
      const hs = Math.min(U * 3.4, (colW * 1.7) / Math.max(8, head.length));
      if (!dry) {
        const tint = r.k === 'a' ? ['rgba(246,201,78,0.38)', '#a8700f'] : r.k === 'b' ? ['rgba(160,156,176,0.32)', '#5e5a6a'] : ['rgba(140,90,40,0.14)', 'rgba(90,52,22,0.55)'];
        ctx.fillStyle = tint[0];
        roundRect(ctx, bx, y0, colW, badgeH, U * 1.2);
        ctx.fill();
        ctx.strokeStyle = tint[1];
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // Real-looking button / stick icon + the action name.
        ctx.font = `900 ${hs}px ${FONT}`;
        const tw = ctx.measureText(r.title).width;
        const ir = hs * 0.62, gap = hs * 0.35;
        const sx = bx + colW / 2 - (ir * 2 + gap + tw) / 2;
        if (r.k === 'dir') joyIcon(ctx, sx + ir, y0 + U * 2.6, ir);
        else btnIcon(ctx, sx + ir, y0 + U * 2.6, ir, r.k === 'a' ? 'A' : 'B');
        text(ctx, r.title, sx + ir * 2 + gap, y0 + U * 2.6, hs, PARCH_INK, 'left', 900);
      }
      who.forEach((p, i) => {
        const keys = f.keys?.[p]?.[r.k] || '—';
        const label = who.length > 1 ? `${s.pl?.[p]?.n || f.names[p]}: ${keys}` : keys;
        T(label, bx + colW / 2, y0 + U * 6 + i * U * 3.4, Math.min(U * 2.7, (colW * 1.8) / Math.max(8, label.length)), C[p].dark, 'center', 800);
      });
      const yd = para(ctx, r.desc || r.title, descX, y0 + U * 2.4, descW, U * 3.1, PARCH_INK, 'left', 600, dry);
      y = Math.max(y0 + badgeH, yd) + U * 1.4;
    }
    if (help.tips?.length) {
      y += U * 0.6;
      for (const tip of help.tips.slice(0, 3)) y = para(ctx, `💡 ${tip}`, w / 2, y, cw * 0.86, U * 2.9, '#7a3a0a', 'center', 600, dry) + U * 0.4;
    }
    y += U * 1.5;
    const variant = x.v ? def.variants?.find((q) => q.id === x.v) : null;
    const mod = x.m?.[0] ? MOD_BY_ID[x.m[0]] : null;
    const boxes = [];
    if (variant) boxes.push({ icon: '🤪', title: `REGOLA PAZZA: ${variant.name}`, desc: variant.desc, color: '#b34a00' });
    if (mod) boxes.push({ icon: mod.icon, title: mod.name, desc: mod.desc, color: '#6a2fa0' });
    for (const b of boxes) {
      const bh = U * 9.5;
      if (!dry) {
        const bx0 = w / 2 - cw * 0.44, bw = cw * 0.88;
        ctx.save();
        roundRect(ctx, bx0, y, bw, bh, 10);
        ctx.fillStyle = b.color + '22';
        ctx.fill();
        ctx.clip();
        stripes(ctx, bx0, y, bw, bh, b.color + '14', U * 3, -s.pt * U * 4);
        ctx.restore();
        roundRect(ctx, bx0, y, bw, bh, 10);
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([U * 1.4, U * 0.8]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      T(`${b.icon} ${b.title}`, w / 2, y + bh * 0.32, Math.min(U * 3.6, (cw * 1.5) / Math.max(10, b.title.length + 3)), b.color, 'center', 900);
      T(b.desc, w / 2, y + bh * 0.72, Math.min(U * 3, (cw * 1.65) / Math.max(10, b.desc.length)), PARCH_INK, 'center', 600);
      y += bh + U * 1.5;
    }
    // Ready pills: no timer, the round starts when every seated player presses A.
    y += U * 1.5;
    const py = dry ? y + U * 4 : Math.max(y + U * 4, top + chh - U * 8);
    const seats = this.seats, n = seats.length;
    seats.forEach((p, k) => {
      const rdy = s.pl?.[p]?.rdy;
      const pw = (cw * 0.9) / n - cw * 0.02, ph = U * 7;
      const px = w / 2 + (k - (n - 1) / 2) * (pw + cw * 0.02);
      const name = s.pl?.[p]?.n || f.names[p];
      const bot = !!s.pl?.[p]?.bot;
      const label = bot && !rdy ? `🤖 ${name} legge…` : n <= 2 ? (rdy ? `✓ ${name} è pronto` : `${name}: premi A quando hai letto`) : rdy ? `✓ ${name}` : `${name}: A`;
      if (!dry) {
        const pulse = rdy ? 1 : 0.7 + 0.3 * Math.abs(Math.sin(s.pt * 3));
        ctx.fillStyle = 'rgba(80,40,10,0.3)';
        roundRect(ctx, px - pw / 2, py - ph / 2 + 4, pw, ph, ph / 2); ctx.fill();
        if (rdy) {
          const g = ctx.createLinearGradient(0, py - ph / 2, 0, py + ph / 2);
          g.addColorStop(0, C[p].light);
          g.addColorStop(0.5, C[p].main);
          g.addColorStop(1, C[p].dark);
          ctx.fillStyle = g;
        } else ctx.fillStyle = '#fbf0d2';
        roundRect(ctx, px - pw / 2, py - ph / 2, pw, ph, ph / 2);
        ctx.fill();
        ctx.globalAlpha = pulse;
        ctx.strokeStyle = rdy ? GOLD : C[p].main;
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (!rdy && !bot) btnIcon(ctx, px - pw / 2 + ph * 0.55, py, ph * 0.3 * (0.94 + 0.06 * pulse), 'A');
        const lx = rdy || bot ? px : px + ph * 0.3;
        const ls = Math.min(U * 3, ((rdy || bot ? pw : pw - ph * 0.8) * 1.7) / Math.max(8, label.length));
        if (rdy) outlined(ctx, label, lx, py, ls, '#fff', 'center', 800, { depth: 0, lw: 0.18 });
        else text(ctx, label, lx, py, ls, C[p].dark, 'center', 800);
      }
    });
    return py + U * 5 - top;
  }

  countdownOverlay(s, w, h) {
    const { ctx } = this;
    const n = 3 - Math.floor(s.pt / 0.8);
    if (n < 1) return;
    const frac = (s.pt % 0.8) / 0.8;
    const col = n === 1 ? '#ff5a4a' : n === 2 ? GOLD : '#6cb8ff';
    const base = Math.min(w, h) * 0.42;
    const size = base * easeBack(Math.min(1, frac * 3)) * (1 - frac * 0.15);
    const fade = frac > 0.8 ? (1 - frac) / 0.2 : 1;
    // Shockwave ring + rays behind the numeral.
    ctx.save();
    ctx.globalAlpha = (1 - frac) * 0.9;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, base * (0.3 + easeOut(frac) * 0.9), 0, TAU);
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(2, base * 0.06 * (1 - frac));
    ctx.stroke();
    ctx.globalAlpha = fade * 0.5;
    sunburst(ctx, w / 2, h / 2, base * 1.1, 12, s.pt * 0.8, col, 0.35);
    ctx.restore();
    // Round wooden shield behind the numeral.
    ctx.save();
    ctx.globalAlpha = fade;
    const sr = size * 0.62;
    if (sr > 4) {
      ctx.beginPath();
      ctx.arc(w / 2, h / 2 + sr * 0.06, sr, 0, TAU);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill();
      const sg = ctx.createRadialGradient(w / 2 - sr * 0.3, h / 2 - sr * 0.35, sr * 0.1, w / 2, h / 2, sr);
      sg.addColorStop(0, '#9a6434');
      sg.addColorStop(1, '#3e220e');
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, sr, 0, TAU);
      ctx.fillStyle = sg;
      ctx.fill();
      ctx.lineWidth = sr * 0.09;
      ctx.strokeStyle = GOLD;
      ctx.stroke();
      ctx.lineWidth = Math.max(2, sr * 0.025);
      ctx.strokeStyle = INK;
      ctx.stroke();
      for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU + 0.4; rivet(ctx, w / 2 + Math.cos(a) * sr * 0.86, h / 2 + Math.sin(a) * sr * 0.86, sr * 0.04); }
    }
    const g = ctx.createLinearGradient(0, h / 2 - size * 0.45, 0, h / 2 + size * 0.45);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.45, col);
    g.addColorStop(1, col);
    outlined(ctx, String(n), w / 2, h / 2 + size * 0.02, size * 0.9, g, 'center', 900, { depth: 0.045, lw: 0.08, stroke: INK, font: TITLE_FONT });
    ctx.restore();
  }

  resultOverlay(f, o, w, h) {
    const { ctx, d } = this;
    const s = f.snap, x = s.x || {};
    const k = easeBack(Math.min(1, s.pt / 0.35));
    dim(ctx, w, h, 0.45 * Math.min(1, s.pt * 3));
    const wnr = x.w; // slot
    const has = Number.isInteger(wnr) && wnr >= 0 && !!C[wnr];
    const seats = this.seats, n = seats.length;
    // 2 vs 2: the whole team wins (x.team), the banner takes the team color.
    const team = s.tm && n === 4 ? (x.team === 0 || x.team === 1 ? x.team : has ? teamOf(s.pl?.[wnr]) : null) : null;
    const winSet = team !== null && has ? new Set(members(s, team)) : new Set(has ? [wnr] : []);
    const bh = Math.min(h * 0.36, 260);
    const pw = Math.min(w * 0.92, 900);
    const TC = team !== null && has ? TEAMS[team] : has ? C[wnr] : null;
    sunburst(ctx, w / 2, h * 0.45, Math.hypot(w, h) * 0.7, 16, s.pt * 0.3, TC ? TC.main : '#aaa', 0.12 * Math.min(1, s.pt * 3));
    ctx.save();
    ctx.translate(w / 2, h * 0.45);
    ctx.scale(k, k);
    ctx.rotate((1 - Math.min(1, s.pt / 0.35)) * 0.1);
    const main = TC ? TC.main : '#8a7a6a', dark = TC ? TC.dark : '#3a2e24';
    // Swallow-tailed ribbon ends (only when there is room on the sides).
    if (w * 0.98 > pw + bh * 0.3) {
      for (const sd of [-1, 1]) {
        ctx.beginPath();
        const ex = sd * (pw / 2 + bh * 0.16);
        ctx.moveTo(sd * pw * 0.44, -bh * 0.22);
        ctx.lineTo(ex, -bh * 0.22);
        ctx.lineTo(ex - sd * bh * 0.1, bh * 0.08);
        ctx.lineTo(ex, bh * 0.38);
        ctx.lineTo(sd * pw * 0.44, bh * 0.38);
        ctx.closePath();
        ctx.fillStyle = dark;
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = INK;
        ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    roundRect(ctx, -pw / 2 + 6, -bh / 2 + 8, pw, bh, 14); ctx.fill();
    const g = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
    g.addColorStop(0, main);
    g.addColorStop(1, dark);
    ctx.save();
    roundRect(ctx, -pw / 2, -bh / 2, pw, bh, 14);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.clip();
    // Woven cloth: faint vertical folds + moving sheen.
    stripes(ctx, -pw / 2, -bh / 2, pw, bh, 'rgba(255,255,255,0.06)', bh * 0.18, s.pt * bh * 0.2);
    const fold = ctx.createLinearGradient(-pw / 2, 0, pw / 2, 0);
    for (let i = 0; i <= 8; i++) fold.addColorStop(i / 8, i % 2 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.06)');
    ctx.fillStyle = fold;
    ctx.fillRect(-pw / 2, -bh / 2, pw, bh);
    ctx.restore();
    roundRect(ctx, -pw / 2, -bh / 2, pw, bh, 14);
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.stroke();
    roundRect(ctx, -pw / 2 + 6, -bh / 2 + 6, pw - 12, bh - 12, 10);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = GOLD;
    ctx.setLineDash([10, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    // Title for whoever looks: own device -> HAI VINTO / HAI PERSO, shared screen -> VINCE <name>.
    let title;
    if (has) {
      const name = team !== null ? `LA SQUADRA ${TEAMS[team].name.toUpperCase()}` : s.pl?.[wnr]?.n || f.names[wnr];
      const vs = this.viewerSlot(f, o);
      title = vs === null || !seats.includes(vs) ? `VINCE ${name.toUpperCase()}!` : winSet.has(vs) ? 'HAI VINTO!' : 'HAI PERSO!';
    } else title = x.replay ? 'PAREGGIO! SI RIGIOCA IN TURBO!' : 'PAREGGIO!';
    outlined(ctx, title, 0, -bh * 0.22, Math.min(bh * 0.24, (Math.min(w, pw * 1.05) * 1.25) / Math.max(8, title.length)), '#fff', 'center', 900, { depth: 0.08, font: TITLE_FONT });
    if (x.text) text(ctx, x.text, 0, bh * 0.03, Math.min(bh * 0.12, (pw * 1.4) / Math.max(10, x.text.length)), '#fff6e0', 'center', 700, true);
    // Scores of every seated player, in seat order (team colors).
    const sc = x.sc || s.sc || [];
    const r = bh * 0.17 * (n > 2 ? 0.85 : 1);
    if (s.tm && n === 4) {
      // Team score: two shields, "Rossi 3 – 2 Blu".
      const gap = Math.min(w * 0.12, pw * 0.14) * 2;
      for (const t of [0, 1]) {
        const pulse = t === team ? 1 + 0.06 * Math.sin(s.pt * 9) : 1;
        teamShield(ctx, (t ? 1 : -1) * gap / 2, bh * 0.28, bh * 0.15 * pulse, t, teamScore(s, t, sc), t === team);
      }
      text(ctx, '–', 0, bh * 0.28, bh * 0.2, '#fff', 'center', 900, true);
    } else {
      const gap = n === 2 ? Math.min(w * 0.12, pw * 0.14) * 2 : Math.min(pw * 0.8 / n, r * 3.4);
      seats.forEach((p, i) => {
        const pulse = p === wnr ? 1 + 0.06 * Math.sin(s.pt * 9) : 1;
        scoreChip(ctx, `${sc[p] ?? 0}`, (i - (n - 1) / 2) * gap, bh * 0.29, r * pulse, p);
      });
      if (n === 2) text(ctx, '–', 0, bh * 0.28, bh * 0.2, '#fff', 'center', 900, true);
    }
    // The blobs react along the top edge of the banner.
    d.textRot = 0; d.px = 1; d.t = s.pt;
    const ar = bh * (n > 2 ? 0.16 : 0.2);
    // Team match: the Red pair on the left, the Blue pair on the right.
    const shown = s.tm && n === 4 ? [...members(s, 0), ...members(s, 1)] : seats;
    shown.forEach((p, i) => {
      const win = winSet.has(p);
      const ax = n === 2 ? (i ? 1 : -1) * (pw / 2 - ar * 1.5) : -pw / 2 + ar * 1.6 + (i * (pw - ar * 3.2)) / (n - 1);
      const hop = win ? Math.abs(Math.sin(s.pt * 7)) * ar * 0.5 : 0;
      d.avatarSlot(ax, -bh / 2 - ar * 0.55 - hop, ar, p, { mood: has ? (win ? 'happy' : 'hurt') : 'dizzy', look: Math.PI / 2, squash: win ? Math.sin(s.pt * 14) * 0.06 : 0, hat: win ? 'crown' : null });
      botMark(ctx, ax + ar * 0.85, -bh / 2 - ar * 0.05 - hop, ar * 0.42, s.pl?.[p]?.bot);
    });
    ctx.restore();
    if (Number.isInteger(x.matchPoint) && x.matchPoint >= 0) {
      const pulse = 1 + 0.08 * Math.sin(s.pt * 12);
      const ms = Math.min(h * 0.08, w * 0.075) * pulse;
      ctx.save();
      ctx.translate(w / 2, h * 0.82);
      ctx.rotate(-0.05);
      const mw = measure(ctx, 'MATCH POINT!', ms, 900, TITLE_FONT) + ms * 1.4;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      roundRect(ctx, -mw / 2 + 4, -ms * 0.75 + 5, mw, ms * 1.5, ms * 0.25); ctx.fill();
      const mg = ctx.createLinearGradient(0, -ms * 0.75, 0, ms * 0.75);
      mg.addColorStop(0, '#e2464e');
      mg.addColorStop(1, '#7c111b');
      ctx.fillStyle = mg;
      roundRect(ctx, -mw / 2, -ms * 0.75, mw, ms * 1.5, ms * 0.25); ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = GOLD;
      ctx.stroke();
      outlined(ctx, 'MATCH POINT!', 0, 0, ms, '#fff6e0', 'center', 900, { depth: 0.06, font: TITLE_FONT });
      ctx.restore();
    }
  }

  // Final standings: stone podium with team banners (champion in the middle with the crown), names, points, awards.
  finalOverlay(f, o, w, h) {
    const { ctx, d } = this;
    const s = f.snap, x = s.x || {};
    const wnr = x.w;
    if (!(Number.isInteger(wnr) && wnr >= 0 && C[wnr])) return;
    if (s.tm && this.seats.length === 4) return this.finalTeamOverlay(f, o, w, h);
    dim(ctx, w, h, 0.35);
    const t = s.pt;
    const U = Math.min(h, w * 1.2) / 100;
    const sc = x.sc || s.sc || [];
    const seats = this.seats.includes(wnr) ? this.seats : [wnr, ...this.seats.filter((q) => q !== wnr)];
    const rank = seats.slice().sort((a, b) => (b === wnr) - (a === wnr) || (sc[b] || 0) - (sc[a] || 0) || a - b);
    // Glory rays + a light beam on the champion.
    sunburst(ctx, w / 2, h * 0.36, Math.hypot(w, h) * 0.8, 20, t * 0.25, C[wnr].main, 0.13);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const sg = ctx.createLinearGradient(0, 0, 0, h * 0.5);
    sg.addColorStop(0, 'rgba(255,220,150,0.0)');
    sg.addColorStop(1, 'rgba(255,220,150,0.2)');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.moveTo(w / 2 - U * 4, 0);
    ctx.lineTo(w / 2 + U * 4, 0);
    ctx.lineTo(w / 2 + U * 16, h * 0.5);
    ctx.lineTo(w / 2 - U * 16, h * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // Title ribbon + champion name.
    const ttl = '👑 CAMPIONE DEL REAME 👑';
    const ts = Math.min(U * 4.8, (w * 0.8) / Math.max(10, ttl.length * 0.72));
    ribbon(ctx, w / 2, h * 0.075, Math.min(w * 0.92, measure(ctx, ttl, ts, 900, TITLE_FONT) + ts * 2.2), ts * 1.75, '#e0a52a', '#8a5a0a');
    outlined(ctx, ttl, w / 2, h * 0.075, ts, '#fff', 'center', 900, { depth: 0.07, font: TITLE_FONT });
    const name = s.pl?.[wnr]?.n || f.names[wnr] || '';
    const ng = ctx.createLinearGradient(0, h * 0.17 - U * 4, 0, h * 0.17 + U * 4);
    ng.addColorStop(0, '#fff');
    ng.addColorStop(0.5, C[wnr].light);
    ng.addColorStop(1, C[wnr].main);
    outlined(ctx, name.toUpperCase(), w / 2, h * 0.17, Math.min(U * 7, (w * 1.3) / Math.max(5, name.length)), ng, 'center', 900, { depth: 0.08, font: TITLE_FONT });
    // Podium: 2nd, 1st, 3rd, 4th from left to right.
    const order = [1, 0, 2, 3].filter((k) => k < rank.length);
    const colW = Math.min(w * 0.21, U * 21);
    const baseY = h * 0.62;
    const heights = [U * 15, U * 10.5, U * 7, U * 4.5];
    d.textRot = 0; d.px = 1; d.t = t;
    order.forEach((rk, i) => {
      const slot = rank[rk];
      const cx = w / 2 + (i - (order.length - 1) / 2) * colW * 1.08;
      const ph = heights[rk];
      const top = baseY - ph;
      const appear = easeBack((t - 0.15 - (3 - rk) * 0.12) / 0.4);
      if (appear <= 0.01) return;
      ctx.save();
      ctx.translate(cx, baseY);
      ctx.scale(1, appear);
      ctx.translate(-cx, -baseY);
      stoneBlock(ctx, cx - colW / 2, top, colW, ph, U);
      // Team banner hanging on the front of the step.
      const bw = colW * 0.46, bl = ph * 0.9;
      const bg = ctx.createLinearGradient(0, top, 0, top + bl);
      bg.addColorStop(0, C[slot].main);
      bg.addColorStop(1, C[slot].dark);
      ctx.beginPath();
      ctx.moveTo(cx - bw / 2, top + U * 0.5);
      ctx.lineTo(cx + bw / 2, top + U * 0.5);
      ctx.lineTo(cx + bw / 2, top + bl);
      ctx.lineTo(cx, top + bl - Math.min(bw * 0.35, bl * 0.25));
      ctx.lineTo(cx - bw / 2, top + bl);
      ctx.closePath();
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = GOLD;
      ctx.stroke();
      ctx.fillStyle = GOLD;
      ctx.fillRect(cx - bw / 2 - U * 0.6, top + U * 0.2, bw + U * 1.2, Math.max(2, U * 0.7));
      outlined(ctx, `${rk + 1}`, cx, top + bl * 0.45, Math.min(bl * 0.5, bw * 0.8), rk === 0 ? GOLD_HI : '#fff', 'center', 900, { depth: 0.06, font: TITLE_FONT });
      ctx.restore();
      if (appear < 0.6) return;
      const ar = rk === 0 ? U * 7 : U * 5;
      const bounce = rk === 0 ? Math.abs(Math.sin(t * 4)) * U * 2 : 0;
      d.avatarSlot(cx, top - ar - bounce, ar, slot, {
        mood: rk === 0 ? 'happy' : rk === rank.length - 1 ? 'dizzy' : 'ok', look: Math.PI / 2,
        squash: rk === 0 ? Math.sin(t * 8) * 0.06 : 0, hat: rk === 0 ? 'crown' : null,
      });
      botMark(ctx, cx + ar * 0.85, top - ar * 0.45 - bounce, ar * 0.36, s.pl?.[slot]?.bot);
      const nm = s.pl?.[slot]?.n || f.names[slot] || '';
      text(ctx, nm, cx, baseY + U * 2.6, Math.min(U * 3, (colW * 1.7) / Math.max(6, nm.length)), C[slot].light, 'center', 800, true);
      text(ctx, `${sc[slot] ?? 0} punti`, cx, baseY + U * 5.4, U * 2.3, '#f6e6c4', 'center', 700, true);
    });
    // Awards on little parchment scrolls.
    (x.awards || []).forEach((a, k) => {
      const y = baseY + U * 10.5 + k * U * 6.8;
      const appear = easeBack((t - 0.9 - k * 0.25) / 0.35);
      if (appear <= 0.01 || !C[a.p]) return;
      const who = s.pl?.[a.p]?.n || f.names[a.p];
      const label = `${a.icon} ${a.name} — ${who}`;
      const cw = Math.min(w * 0.9, U * 80), chh = U * 6.2;
      ctx.save();
      ctx.translate(w / 2, y + U * 1.2);
      ctx.scale(appear, appear);
      parchment(ctx, -cw / 2, -chh / 2, cw, chh, U * 0.8, { lw: 2 });
      ctx.fillStyle = C[a.p].main;
      roundRect(ctx, -cw / 2 + 5, -chh / 2 + 5, Math.max(4, U * 1.1), chh - 10, U * 0.4); ctx.fill();
      ctx.translate(-w / 2, -y - U * 1.2);
      text(ctx, label, w / 2, y - U * 0.1, Math.min(U * 3.1, (w * 1.6) / Math.max(10, label.length)), C[a.p].dark, 'center', 800);
      text(ctx, a.desc, w / 2, y + U * 2.6, Math.min(U * 2.4, (w * 1.6) / Math.max(10, a.desc.length)), PARCH_INK, 'center', 600);
      ctx.restore();
    });
    const blink = 0.75 + 0.25 * Math.sin(t * 5);
    ctx.globalAlpha = blink;
    hintLine(ctx, [{ b: 'A' }, 'RIVINCITA', '   ·   ', { b: 'B' }, 'MENU'], w / 2, h * 0.955, Math.min(U * 3.6, w * 0.045));
    ctx.globalAlpha = 1;
    if (Math.random() < 0.15) this.fx.confetti(Math.random() * this.W, -10, 4);
  }

  // 2 vs 2 final: the champion team on the high step (both members crowned), the other team on the low one.
  finalTeamOverlay(f, o, w, h) {
    const { ctx, d } = this;
    const s = f.snap, x = s.x || {};
    const t = s.pt;
    const U = Math.min(h, w * 1.2) / 100;
    const sc = x.sc || s.sc || [];
    const win = teamOf(s.pl?.[x.w]), lose = 1 - win;
    const TW = TEAMS[win];
    dim(ctx, w, h, 0.35);
    sunburst(ctx, w / 2, h * 0.36, Math.hypot(w, h) * 0.8, 20, t * 0.25, TW.main, 0.13);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const sg = ctx.createLinearGradient(0, 0, 0, h * 0.5);
    sg.addColorStop(0, 'rgba(255,220,150,0.0)');
    sg.addColorStop(1, 'rgba(255,220,150,0.2)');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.moveTo(w / 2 - U * 6, 0);
    ctx.lineTo(w / 2 + U * 6, 0);
    ctx.lineTo(w / 2 + U * 22, h * 0.5);
    ctx.lineTo(w / 2 - U * 22, h * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    const ttl = '👑 CAMPIONI DEL REAME 👑';
    const ts = Math.min(U * 4.8, (w * 0.8) / Math.max(10, ttl.length * 0.72));
    ribbon(ctx, w / 2, h * 0.075, Math.min(w * 0.92, measure(ctx, ttl, ts, 900, TITLE_FONT) + ts * 2.2), ts * 1.75, '#e0a52a', '#8a5a0a');
    outlined(ctx, ttl, w / 2, h * 0.075, ts, '#fff', 'center', 900, { depth: 0.07, font: TITLE_FONT });
    const name = `SQUADRA ${TW.name.toUpperCase()}`;
    const ng = ctx.createLinearGradient(0, h * 0.17 - U * 4, 0, h * 0.17 + U * 4);
    ng.addColorStop(0, '#fff');
    ng.addColorStop(0.5, TW.light);
    ng.addColorStop(1, TW.main);
    outlined(ctx, name, w / 2, h * 0.165, Math.min(U * 7, (w * 1.3) / Math.max(5, name.length)), ng, 'center', 900, { depth: 0.08, font: TITLE_FONT });
    const wm = members(s, win), lm = members(s, lose);
    const pair = wm.map((q) => s.pl?.[q]?.n || f.names[q] || '').join(' & ');
    text(ctx, pair, w / 2, h * 0.165 + U * 5.2, Math.min(U * 3, (w * 1.4) / Math.max(8, pair.length)), '#fff2d2', 'center', 700, true);
    // Two wide steps: champions (left, high) and the other team (right, low).
    const colW = Math.min(w * 0.36, U * 38);
    const baseY = h * 0.66;
    const steps = [{ team: win, slots: wm, ph: U * 15, rk: 0 }, { team: lose, slots: lm, ph: U * 8, rk: 1 }];
    d.textRot = 0; d.px = 1; d.t = t;
    steps.forEach((st, i) => {
      const T = TEAMS[st.team];
      const cx = w / 2 + (i ? 1 : -1) * colW * 0.54;
      const top = baseY - st.ph;
      const appear = easeBack((t - 0.15 - st.rk * 0.18) / 0.4);
      if (appear <= 0.01) return;
      ctx.save();
      ctx.translate(cx, baseY);
      ctx.scale(1, appear);
      ctx.translate(-cx, -baseY);
      stoneBlock(ctx, cx - colW / 2, top, colW, st.ph, U);
      // Team banner on the front of the step, with the team score.
      const bw = colW * 0.3, bl = st.ph * 0.9;
      const bg = ctx.createLinearGradient(0, top, 0, top + bl);
      bg.addColorStop(0, T.main);
      bg.addColorStop(1, T.dark);
      ctx.beginPath();
      ctx.moveTo(cx - bw / 2, top + U * 0.5);
      ctx.lineTo(cx + bw / 2, top + U * 0.5);
      ctx.lineTo(cx + bw / 2, top + bl);
      ctx.lineTo(cx, top + bl - Math.min(bw * 0.35, bl * 0.25));
      ctx.lineTo(cx - bw / 2, top + bl);
      ctx.closePath();
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = GOLD;
      ctx.stroke();
      ctx.fillStyle = GOLD;
      ctx.fillRect(cx - bw / 2 - U * 0.6, top + U * 0.2, bw + U * 1.2, Math.max(2, U * 0.7));
      outlined(ctx, `${st.rk + 1}`, cx, top + bl * 0.42, Math.min(bl * 0.45, bw * 0.6), st.rk === 0 ? GOLD_HI : '#fff', 'center', 900, { depth: 0.06, font: TITLE_FONT });
      ctx.restore();
      if (appear < 0.6) return;
      const ar = st.rk === 0 ? U * 6.2 : U * 5;
      st.slots.forEach((slot, k) => {
        const ax = cx + (k ? 1 : -1) * colW * 0.27;
        const bounce = st.rk === 0 ? Math.abs(Math.sin(t * 4 + k * 1.3)) * U * 2 : 0;
        d.avatarSlot(ax, top - ar - bounce, ar, slot, {
          mood: st.rk === 0 ? 'happy' : 'dizzy', look: Math.PI / 2,
          squash: st.rk === 0 ? Math.sin(t * 8 + k) * 0.06 : 0, hat: st.rk === 0 ? 'crown' : null,
        });
        botMark(ctx, ax + ar * 0.85, top - ar * 0.45 - bounce, ar * 0.36, s.pl?.[slot]?.bot);
        const nm = s.pl?.[slot]?.n || f.names[slot] || '';
        text(ctx, nm, ax, baseY + U * 2.6, Math.min(U * 3, (colW * 0.85) / Math.max(6, nm.length * 0.55)), C[slot].light, 'center', 800, true);
      });
      const pts = teamScore(s, st.team, sc);
      text(ctx, `Squadra ${T.name} · ${pts} ${pts === 1 ? 'punto' : 'punti'}`, cx, baseY + U * 5.4, U * 2.3, '#f6e6c4', 'center', 700, true);
    });
    (x.awards || []).slice(0, 2).forEach((a, k) => {
      const y = baseY + U * 10.5 + k * U * 6.8;
      const appear = easeBack((t - 0.9 - k * 0.25) / 0.35);
      if (appear <= 0.01 || !C[a.p]) return;
      const who = s.pl?.[a.p]?.n || f.names[a.p];
      const label = `${a.icon} ${a.name} — ${who}`;
      const cw = Math.min(w * 0.9, U * 80), chh = U * 6.2;
      ctx.save();
      ctx.translate(w / 2, y + U * 1.2);
      ctx.scale(appear, appear);
      parchment(ctx, -cw / 2, -chh / 2, cw, chh, U * 0.8, { lw: 2 });
      ctx.fillStyle = C[a.p].main;
      roundRect(ctx, -cw / 2 + 5, -chh / 2 + 5, Math.max(4, U * 1.1), chh - 10, U * 0.4); ctx.fill();
      ctx.translate(-w / 2, -y - U * 1.2);
      text(ctx, label, w / 2, y - U * 0.1, Math.min(U * 3.1, (w * 1.6) / Math.max(10, label.length)), C[a.p].dark, 'center', 800);
      text(ctx, a.desc, w / 2, y + U * 2.6, Math.min(U * 2.4, (w * 1.6) / Math.max(10, a.desc.length)), PARCH_INK, 'center', 600);
      ctx.restore();
    });
    const blink = 0.75 + 0.25 * Math.sin(t * 5);
    ctx.globalAlpha = blink;
    hintLine(ctx, [{ b: 'A' }, 'RIVINCITA', '   ·   ', { b: 'B' }, 'MENU'], w / 2, h * 0.955, Math.min(U * 3.6, w * 0.045));
    ctx.globalAlpha = 1;
    if (Math.random() < 0.15) this.fx.confetti(Math.random() * this.W, -10, 4);
  }

  pauseOverlay(f, o, w, h) {
    const { ctx } = this;
    const s = f.snap, x = s.x || {};
    dim(ctx, w, h, 0.72);
    // A wooden sign hanging from two chains.
    const ps = Math.min(h * 0.13, w * 0.14);
    const sw = Math.min(w * 0.8, measure(ctx, 'PAUSA', ps, 900, TITLE_FONT) + ps * 1.8), shh = ps * 1.55;
    const sy = h * 0.3;
    const swing = Math.sin(Date.now() / 900) * 0.025;
    ctx.save();
    ctx.translate(w / 2, 0);
    ctx.rotate(swing);
    ctx.strokeStyle = '#8d8890';
    ctx.lineWidth = Math.max(2, ps * 0.05);
    ctx.setLineDash([ps * 0.12, ps * 0.06]);
    ctx.beginPath();
    for (const sd of [-1, 1]) { ctx.moveTo(sd * sw * 0.32, 0); ctx.lineTo(sd * sw * 0.32, sy - shh / 2 + 4); }
    ctx.stroke();
    ctx.setLineDash([]);
    woodPanel(ctx, -sw / 2, sy - shh / 2, sw, shh, ps * 0.18, { light: true });
    outlined(ctx, 'PAUSA', 0, sy + ps * 0.04, ps, GOLD, 'center', 900, { depth: 0.08, font: TITLE_FONT });
    ctx.restore();
    if (x.by === 'drop') {
      const gone = this.seats.filter((sl) => s.pl?.[sl] && !s.pl[sl].on);
      const name = gone.length ? gone.map((sl) => s.pl[sl].n).join(', ') : 'chi manca';
      text(ctx, `In attesa che ${name} si ${gone.length > 1 ? 'ricolleghino' : 'ricolleghi'}…`, w / 2, h * 0.5, Math.min(h * 0.05, w * 0.045), GOLD_HI, 'center', 700, true);
    } else {
      hintLine(ctx, [{ b: 'A' }, 'riprendi', '   ·   ', { b: 'B' }, 'esci'], w / 2, h * 0.5, Math.min(h * 0.05, w * 0.05), GOLD_HI);
    }
    const def = f.gameById(s.g?.id || x.id);
    if (def) {
      const U = Math.min(h, w) / 100;
      const pw = Math.min(w * 0.92, 760), py = h * 0.6, phh = h * 0.36;
      parchment(ctx, w / 2 - pw / 2, py, pw, phh, 10);
      outlined(ctx, def.name, w / 2, py + phh * 0.17, Math.min(U * 5, (pw * 1.4) / Math.max(6, def.name.length)), '#fff', 'center', 900, { depth: 0.06, font: TITLE_FONT, stroke: '#3a1d06' });
      wrapText(ctx, def.rule, w / 2, py + phh * 0.39, pw * 0.86, Math.min(U * 3.6, phh * 0.11), PARCH_INK);
      const ctl = controlsLine(def);
      text(ctx, ctl, w / 2, py + phh * 0.68, Math.min(U * 3.2, (pw * 1.8) / Math.max(10, ctl.length)), '#7a3a0a', 'center', 700);
      const variant = s.g?.v ? def.variants?.find((q) => q.id === s.g.v) : null;
      if (variant) text(ctx, `🤪 ${variant.name}: ${variant.desc}`, w / 2, py + phh * 0.86, Math.min(U * 2.8, (pw * 1.7) / Math.max(10, variant.desc.length + variant.name.length)), '#b34a00', 'center', 700);
    }
  }
}

// ---------- helpers ----------
function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }

function modFlagsClient(mods) {
  const f = {};
  for (const m of mods) f[m] = true;
  return f;
}

export function text(ctx, str, x, y, size, color, align = 'center', weight = 800, outline = false) {
  size = Math.max(6, size);
  ctx.font = `${weight} ${size}px ${FONT}`;
  if (ctx.wordSpacing && ctx.wordSpacing !== '0px') ctx.wordSpacing = '0px';
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  if (outline) {
    ctx.lineWidth = Math.max(3, size * 0.16);
    ctx.strokeStyle = 'rgba(26,12,3,0.88)';
    ctx.lineJoin = 'round';
    ctx.strokeText(str, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(str, x, y);
}

// Storybook title text: dark extrusion below, thick outline, then the fill (color or gradient). o.font = font family.
function outlined(ctx, str, x, y, size, fill, align = 'center', weight = 900, o = {}) {
  size = Math.max(6, size);
  str = String(str);
  ctx.font = `${weight} ${size}px ${o.font || FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  if ('wordSpacing' in ctx) ctx.wordSpacing = o.font === TITLE_FONT ? `${Math.round(size * 0.22)}px` : '0px'; // Cinzel's spaces are tight
  const lw = Math.max(3, Math.min(size * (o.lw ?? 0.17), 6 + size * 0.07)); // thinner on huge titles
  const ink = o.stroke || 'rgba(30,13,3,0.96)';
  const depth = o.depth ?? 0.07;
  if (depth > 0) {
    const dy = Math.max(2, Math.min(size * depth, 4 + size * 0.03));
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    ctx.lineWidth = lw;
    ctx.strokeText(str, x, y + dy);
    ctx.fillText(str, x, y + dy);
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = lw;
  ctx.strokeText(str, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(str, x, y);
}

// "RAFFICA!" in engraved gold letters.
function logoText(ctx, str, x, y, size) {
  const g = ctx.createLinearGradient(0, y - size * 0.5, 0, y + size * 0.5);
  g.addColorStop(0, '#fffbe6');
  g.addColorStop(0.4, '#ffd76a');
  g.addColorStop(0.55, '#c8841a');
  g.addColorStop(1, '#ffe58a');
  outlined(ctx, str, x, y, size, g, 'center', 900, { depth: 0.08, font: TITLE_FONT });
}

function measure(ctx, str, size, weight = 800, font = FONT) {
  ctx.font = `${weight} ${Math.max(6, size)}px ${font}`;
  if ('wordSpacing' in ctx) ctx.wordSpacing = font === TITLE_FONT ? `${Math.round(Math.max(6, size) * 0.22)}px` : '0px';
  return ctx.measureText(String(str)).width;
}

function hueOf(id) {
  let h = 7;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

function wrapText(ctx, str, x, y, maxW, size, color) {
  ctx.font = `600 ${size}px ${FONT}`;
  const words = String(str || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const wd of words) {
    const test = line ? line + ' ' + wd : wd;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = wd; } else line = test;
  }
  if (line) lines.push(line);
  lines.forEach((l, k) => text(ctx, l, x, y + k * size * 1.2, size, color, 'center', 600));
  return y + lines.length * size * 1.2;
}

// Wrapped paragraph; returns the y below it. When dry, only measures.
function para(ctx, str, x, y, maxW, size, color, align = 'center', weight = 600, dry = false) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  const words = String(str || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const wd of words) {
    const test = line ? line + ' ' + wd : wd;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = wd; } else line = test;
  }
  if (line) lines.push(line);
  if (!dry) lines.forEach((l, k) => text(ctx, l, x, y + k * size * 1.22, size, color, align, weight));
  return y + lines.length * size * 1.22;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function dim(ctx, w, h, a) {
  ctx.fillStyle = `rgba(14,7,3,${a})`;
  ctx.fillRect(0, 0, w, h);
}

// Arrow: dir 1 = pointing right, -1 = left, 'down' = pointing down.
function tri(ctx, x, y, s, dir, color) {
  ctx.beginPath();
  if (dir === 'down') {
    ctx.moveTo(x, y + s);
    ctx.lineTo(x - s, y - s * 0.6);
    ctx.lineTo(x + s, y - s * 0.6);
  } else {
    ctx.moveTo(x + dir * s, y);
    ctx.lineTo(x - dir * s * 0.6, y - s);
    ctx.lineTo(x - dir * s * 0.6, y + s);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, s * 0.22);
  ctx.strokeStyle = INK;
  ctx.stroke();
}

// Alternating light wedges around a point (rotating "rays of glory").
function sunburst(ctx, cx, cy, R, n, rot, color, alpha) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const a0 = rot + (k * TAU) / n, a1 = a0 + TAU / (n * 2);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R);
    ctx.lineTo(cx + Math.cos(a1) * R, cy + Math.sin(a1) * R);
    ctx.closePath();
  }
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
}

// Diagonal stripes over a rect (caller clips). `off` scrolls them.
function stripes(ctx, x, y, w, h, color, step, off = 0) {
  if (!(step > 1)) return;
  ctx.beginPath();
  const o = ((off % (step * 2)) + step * 2) % (step * 2);
  for (let sx = x - h - step * 2 + o; sx < x + w + step; sx += step * 2) {
    ctx.moveTo(sx, y + h);
    ctx.lineTo(sx + h, y);
    ctx.lineTo(sx + h + step, y);
    ctx.lineTo(sx + step, y + h);
    ctx.closePath();
  }
  ctx.fillStyle = color;
  ctx.fill();
}

// Rect whose bottom edge is a zigzag hem (cloth header bands).
function hemPath(ctx, x, y, w, h, teeth) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h * 0.92);
  for (let i = 1; i <= teeth; i++) ctx.lineTo(x + w - (i * w) / teeth, y + h * 0.92 + (i % 2 ? h * 0.07 : 0));
  ctx.closePath();
}

// A cloth ribbon with folded swallow-tailed ends and gold stitching.
function ribbon(ctx, cx, cy, w, h, main, dark) {
  const x0 = cx - w / 2;
  for (const sd of [-1, 1]) {
    const ex = cx + sd * (w / 2 + h * 0.6);
    ctx.beginPath();
    ctx.moveTo(cx + sd * (w / 2 - h * 0.3), cy - h * 0.3);
    ctx.lineTo(ex, cy - h * 0.3);
    ctx.lineTo(ex - sd * h * 0.3, cy + h * 0.15);
    ctx.lineTo(ex, cy + h * 0.6);
    ctx.lineTo(cx + sd * (w / 2 - h * 0.3), cy + h * 0.6);
    ctx.closePath();
    ctx.fillStyle = dark;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRect(ctx, x0 + 3, cy - h / 2 + 5, w, h, h * 0.12); ctx.fill();
  const g = ctx.createLinearGradient(0, cy - h / 2, 0, cy + h / 2);
  g.addColorStop(0, main);
  g.addColorStop(1, dark);
  roundRect(ctx, x0, cy - h / 2, w, h, h * 0.12);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = INK;
  ctx.stroke();
  roundRect(ctx, x0 + 5, cy - h / 2 + 5, w - 10, h - 10, h * 0.08);
  ctx.setLineDash([7, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,236,170,0.75)';
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  roundRect(ctx, x0 + h * 0.2, cy - h / 2 + h * 0.12, w - h * 0.4, h * 0.14, h * 0.07); ctx.fill();
}

// Wooden sign with golden studs lighting up in sequence (round sign, roulette frame).
function marquee(ctx, x, y, w, h, r, t) {
  woodPanel(ctx, x, y, w, h, r, { rivets: false });
  bulbs(ctx, x, y, w, h, r, Math.max(2, Math.min(4.5, h * 0.05)), t);
}

function bulbs(ctx, x, y, w, h, r, br, t) {
  const inset = br * 1.6;
  const per = 2 * (w + h);
  const step = Math.max(br * 5, 16);
  const n = Math.floor(per / step);
  const phase = Math.floor(t * 8);
  ctx.save();
  for (const on of [false, true]) {
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      if (((k + phase) % 3 === 0) !== on) continue;
      let d = (k / n) * per, px, py;
      if (d < w) { px = x + d; py = y + inset; }
      else if ((d -= w) < h) { px = x + w - inset; py = y + d; }
      else if ((d -= h) < w) { px = x + w - d; py = y + h - inset; }
      else { d -= w; px = x + inset; py = y + h - d; }
      // Keep studs off the rounded corners.
      px = Math.max(x + r * 0.6 + inset, Math.min(x + w - r * 0.6 - inset, px));
      py = Math.max(y + r * 0.6 + inset, Math.min(y + h - r * 0.6 - inset, py));
      ctx.moveTo(px + br, py);
      ctx.arc(px, py, br, 0, TAU);
    }
    ctx.fillStyle = on ? '#fff2b3' : '#8a6420';
    if (on) { ctx.shadowColor = 'rgba(255,200,90,0.9)'; ctx.shadowBlur = br * 3; }
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}

// Team gem: filled with `color`, or an empty iron socket when color is null.
function gem(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  if (color) {
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.32);
    ctx.strokeStyle = GOLD;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.38, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fill();
  } else {
    ctx.fillStyle = 'rgba(10,4,0,0.55)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.25);
    ctx.strokeStyle = 'rgba(246,201,78,0.35)';
    ctx.stroke();
  }
}

// Score coin in a player's color with a gold rim.
function scoreChip(ctx, str, x, y, r, p) {
  ctx.beginPath();
  ctx.arc(x, y + r * 0.12, r, 0, TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();
  const g = ctx.createLinearGradient(0, y - r, 0, y + r);
  g.addColorStop(0, C[p].light);
  g.addColorStop(0.5, C[p].main);
  g.addColorStop(1, C[p].dark);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.14);
  ctx.strokeStyle = GOLD;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r + Math.max(1, r * 0.07), 0, TAU);
  ctx.lineWidth = Math.max(1, r * 0.05);
  ctx.strokeStyle = INK;
  ctx.stroke();
  outlined(ctx, str, x, y + r * 0.04, r * 1.25, '#fff', 'center', 900, { depth: 0, lw: 0.2 });
}

// Character icon on a disc of the team (slot) color. o.glow = golden winner ring, o.dim = disconnected.
function charBadge(ctx, x, y, r, slot, charId, o = {}) {
  const col = C[slot] || C[0];
  const ch = CHAR_BY_ID[charId] || CHAR_BY_ID[DEFAULT_CHARS[slot]];
  ctx.save();
  if (o.dim) ctx.globalAlpha *= 0.45;
  ctx.beginPath();
  ctx.arc(x, y + r * 0.1, r, 0, TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  g.addColorStop(0, col.light);
  g.addColorStop(0.55, col.main);
  g.addColorStop(1, col.dark);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.13);
  ctx.strokeStyle = o.glow ? GOLD_HI : GOLD_D;
  ctx.stroke();
  if (o.glow) { ctx.lineWidth = Math.max(1, r * 0.08); ctx.strokeStyle = GOLD; ctx.beginPath(); ctx.arc(x, y, r * 1.2, 0, TAU); ctx.stroke(); }
  if (ch) text(ctx, ch.icon, x, y + r * 0.06, r * 1.15, '#fff', 'center', 400);
  ctx.restore();
  if (o.bot) botMark(ctx, x + r * 0.78, y + r * 0.72, Math.max(6, r * 0.48), o.bot, o.dim);
}

// Computer player marker: the level icon (🪵 Scudiero, ⚔️ Cavaliere, 👑 Re) on a small dark-wood seal with a gold rim.
function botMark(ctx, x, y, r, level, dim = false) {
  const L = BOT_LEVELS.find((l) => l.id === level);
  if (!L) return;
  ctx.save();
  if (dim) ctx.globalAlpha *= 0.45;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
  g.addColorStop(0, '#7a4a22');
  g.addColorStop(1, '#24130a');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(1.2, r * 0.16);
  ctx.strokeStyle = GOLD;
  ctx.stroke();
  text(ctx, L.icon, x, y + r * 0.06, r * 1.15, '#fff', 'center', 400);
  ctx.restore();
}

// Largest font size (between min and max) that fits str in maxW.
function fitSize(ctx, str, maxW, max, min, weight = 800) {
  const w = measure(ctx, str, max, weight);
  return w <= maxW ? max : Math.max(min, (max * maxW) / Math.max(1, w));
}

// Cut a string with "…" so it fits maxW at this size.
function ellipsize(ctx, str, maxW, size, weight = 800) {
  str = String(str);
  if (measure(ctx, str, size, weight) <= maxW) return str;
  let k = str.length;
  while (k > 1 && measure(ctx, str.slice(0, k) + '…', size, weight) > maxW) k--;
  return str.slice(0, k) + '…';
}

// Small emoji chip (mods / variant icons in the HUD).
function iconChip(ctx, icon, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = 'rgba(24,10,2,0.75)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  text(ctx, icon, x, y + r * 0.05, r * 1.15, '#fff', 'center', 400);
}

// Round timer: a gold medallion whose rim empties as time runs out.
function timerBadge(ctx, x, y, R, left, dur, urgent, pulse) {
  const k = clamp01(left / Math.max(1, dur));
  ctx.beginPath();
  ctx.arc(x, y + R * 0.08, R * 1.04, 0, TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, R * 1.02, 0, TAU);
  ctx.fillStyle = '#2a2226';
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, R * 0.06);
  ctx.strokeStyle = INK;
  ctx.stroke();
  if (k > 0) {
    ctx.beginPath();
    ctx.arc(x, y, R * 0.92, -Math.PI / 2, -Math.PI / 2 + k * TAU);
    ctx.strokeStyle = urgent ? '#ff4d4d' : k < 0.33 ? '#ff9a3d' : GOLD;
    ctx.lineWidth = Math.max(2.5, R * 0.19);
    ctx.stroke();
  }
  const g = ctx.createRadialGradient(x, y - R * 0.4, R * 0.1, x, y, R * 0.82);
  g.addColorStop(0, urgent ? '#8a1620' : '#6a4020');
  g.addColorStop(1, urgent ? '#2a0408' : '#24130a');
  ctx.beginPath();
  ctx.arc(x, y, R * 0.8, 0, TAU);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = Math.max(1, R * 0.05);
  ctx.strokeStyle = GOLD_D;
  ctx.stroke();
  outlined(ctx, Math.ceil(left).toString(), x, y + R * 0.04, R * 1.0 * pulse, urgent ? '#ffb0a0' : '#fff6e0', 'center', 900, { depth: 0, lw: 0.16 });
}

// Button icon: A = gold coin, B = silver coin.
function btnIcon(ctx, x, y, r, letter) {
  const a = letter === 'A';
  ctx.beginPath();
  ctx.arc(x, y + r * 0.18, r, 0, TAU);
  ctx.fillStyle = a ? '#8a5a08' : '#4a4654';
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.14);
  ctx.strokeStyle = INK;
  ctx.stroke();
  const g = ctx.createLinearGradient(0, y - r, 0, y + r);
  g.addColorStop(0, a ? '#fff2b3' : '#ffffff');
  g.addColorStop(0.5, a ? GOLD : '#c9c6d2');
  g.addColorStop(1, a ? '#c88a18' : '#7a7684');
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(x - r * 0.25, y - r * 0.42, r * 0.42, r * 0.2, -0.4, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fill();
  text(ctx, letter, x, y + r * 0.06, r * 1.25, a ? '#3a1f04' : '#1f1b24', 'center', 900);
}

// Little joystick icon (base + stick + ball).
function joyIcon(ctx, x, y, r) {
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.55, r, r * 0.42, 0, 0, TAU);
  ctx.fillStyle = '#3a2a1e';
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.12);
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y + r * 0.5);
  ctx.lineTo(x + r * 0.15, y - r * 0.3);
  ctx.lineWidth = r * 0.28;
  ctx.strokeStyle = '#8d8890';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.arc(x + r * 0.18, y - r * 0.45, r * 0.42, 0, TAU);
  ctx.fillStyle = PC[0].main;
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, r * 0.12);
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + r * 0.05, y - r * 0.6, r * 0.13, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fill();
}

// A centered line mixing text and button icons: parts = ['text', {b:'A'}, ...].
function hintLine(ctx, parts, cx, y, size, color = '#fff6e0') {
  const r = size * 0.62, gap = size * 0.3;
  const widths = parts.map((p) => (typeof p === 'string' ? measure(ctx, p, size, 700) : r * 2 + gap));
  let x = cx - widths.reduce((a, b) => a + b, 0) / 2;
  parts.forEach((p, k) => {
    if (typeof p === 'string') text(ctx, p, x, y, size, color, 'left', 700, true);
    else btnIcon(ctx, x + r, y, r, p.b);
    x += widths[k];
  });
}

function controlsLine(def) {
  const c = def.controls || {};
  const parts = [];
  if (c.dir) parts.push(`🕹️ ${c.dirLabel || c.label || (c.dir === 'h' ? 'Sinistra/Destra' : c.dir === 'v' ? 'Su/Giù' : 'Muovi')}`);
  if (c.a) parts.push(`Ⓐ ${c.a}`);
  if (c.b) parts.push(`Ⓑ ${c.b}`);
  return parts.join('     ');
}

// ---------- medieval kit ----------
function shade(hex, l) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v * l)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

// Tileable textures (paper specks, wood streaks), one pattern per context.
const PATTERNS = new WeakMap();
function texPattern(ctx, kind) {
  let m = PATTERNS.get(ctx);
  if (!m) PATTERNS.set(ctx, (m = {}));
  if (m[kind] !== undefined) return m[kind];
  const S = 160;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const r = seeded(kind === 'paper' ? 3 : 9);
  if (kind === 'paper') {
    for (let k = 0; k < 14; k++) {
      const x = r() * S, y = r() * S, rad = 8 + r() * 26;
      for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) {
        const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
        gr.addColorStop(0, 'rgba(150,90,30,0.09)');
        gr.addColorStop(1, 'rgba(150,90,30,0)');
        g.fillStyle = gr;
        g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2);
      }
    }
    for (let k = 0; k < 1100; k++) {
      g.fillStyle = r() < 0.6 ? `rgba(120,70,20,${0.05 + r() * 0.1})` : `rgba(255,252,236,${0.12 + r() * 0.15})`;
      g.fillRect(r() * S, r() * S, 1 + r() * 1.6, 1 + r() * 1.6);
    }
  } else {
    for (let k = 0; k < 70; k++) {
      const y = r() * S, amp = r() * 3, ph = r() * TAU, cyc = 1 + Math.floor(r() * 2);
      g.strokeStyle = r() < 0.65 ? `rgba(20,8,0,${0.08 + r() * 0.14})` : `rgba(255,214,160,${0.04 + r() * 0.07})`;
      g.lineWidth = 0.6 + r() * 1.6;
      g.beginPath();
      for (let x = 0; x <= S; x += 8) {
        const yy = y + Math.sin((x / S) * TAU * cyc + ph) * amp;
        if (x) g.lineTo(x, yy); else g.moveTo(x, yy);
      }
      g.stroke();
    }
  }
  m[kind] = ctx.createPattern(c, 'repeat');
  return m[kind];
}

// Aged parchment panel (light, dark ink on top) with a wooden frame line.
function parchment(ctx, x, y, w, h, rad, o = {}) {
  ctx.save();
  if (o.shadow !== false) { ctx.fillStyle = 'rgba(0,0,0,0.45)'; roundRect(ctx, x + 5, y + 8, w, h, rad); ctx.fill(); }
  const g = ctx.createRadialGradient(x + w / 2, y + h * 0.45, Math.min(w, h) * 0.1, x + w / 2, y + h * 0.45, Math.max(w, h) * 0.72);
  g.addColorStop(0, '#fff8e2');
  g.addColorStop(0.6, '#f4e3b8');
  g.addColorStop(0.9, '#e3c68e');
  g.addColorStop(1, '#cfa96c');
  roundRect(ctx, x, y, w, h, rad);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.translate(x, y);
  ctx.fillStyle = texPattern(ctx, 'paper');
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  roundRect(ctx, x + 3, y + 3, w - 6, h - 6, Math.max(0, rad - 3));
  ctx.strokeStyle = 'rgba(150,90,30,0.3)';
  ctx.lineWidth = 4;
  ctx.stroke();
  if (o.frame !== false) {
    roundRect(ctx, x, y, w, h, rad);
    ctx.strokeStyle = o.frame || '#5a3416';
    ctx.lineWidth = o.lw || 3;
    ctx.stroke();
  }
  ctx.restore();
}

// Carved wooden panel with a gold inlay and iron rivets.
function woodPanel(ctx, x, y, w, h, rad, o = {}) {
  ctx.save();
  if (o.shadow !== false) { ctx.fillStyle = 'rgba(0,0,0,0.45)'; roundRect(ctx, x + 4, y + 6, w, h, rad); ctx.fill(); }
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, o.light ? '#a06a38' : '#6e4220');
  g.addColorStop(0.5, o.light ? '#7e4c22' : '#4f2d14');
  g.addColorStop(1, o.light ? '#55301a' : '#33190b');
  roundRect(ctx, x, y, w, h, rad);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.translate(x, y);
  ctx.fillStyle = texPattern(ctx, 'wood');
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,220,170,0.14)';
  ctx.fillRect(0, 0, w, Math.min(h * 0.08, 5));
  ctx.restore();
  roundRect(ctx, x, y, w, h, rad);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#1c0f06';
  ctx.stroke();
  roundRect(ctx, x + 5, y + 5, w - 10, h - 10, Math.max(0, rad - 4));
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = o.trim || 'rgba(246,201,78,0.6)';
  ctx.stroke();
  if (o.rivets !== false && w > 60 && h > 36) {
    const ri = Math.max(2.5, Math.min(5, h * 0.06));
    for (const [px, py] of [[x + ri * 3, y + ri * 3], [x + w - ri * 3, y + ri * 3], [x + ri * 3, y + h - ri * 3], [x + w - ri * 3, y + h - ri * 3]]) rivet(ctx, px, py, ri);
  }
  ctx.restore();
}

function rivet(g, x, y, r) {
  g.beginPath();
  g.arc(x, y + r * 0.3, r, 0, TAU);
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fill();
  const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  gr.addColorStop(0, '#f6ead0');
  gr.addColorStop(0.5, '#8d8890');
  gr.addColorStop(1, '#2f2a2e');
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fillStyle = gr;
  g.fill();
}

// Wooden scroll roller with gold end caps.
function roller(ctx, x, y, w, h) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#5a3416');
  g.addColorStop(0.3, '#c08a50');
  g.addColorStop(0.6, '#7a4a20');
  g.addColorStop(1, '#2a1608');
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
  for (const cx of [x, x + w]) {
    const cg = ctx.createRadialGradient(cx - h * 0.2, y + h * 0.3, h * 0.05, cx, y + h / 2, h * 0.7);
    cg.addColorStop(0, GOLD_HI);
    cg.addColorStop(0.6, GOLD);
    cg.addColorStop(1, GOLD_D);
    ctx.beginPath();
    ctx.arc(cx, y + h / 2, h * 0.68, 0, TAU);
    ctx.fillStyle = cg;
    ctx.fill();
    ctx.stroke();
  }
}

// Stone podium step with mortar lines.
function stoneBlock(ctx, x, y, w, h, U) {
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  roundRect(ctx, x + 4, y + 6, w, h, U * 0.6); ctx.fill();
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#a49498');
  g.addColorStop(0.15, '#7c6d72');
  g.addColorStop(1, '#40363a');
  roundRect(ctx, x, y, w, h, U * 0.6);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = 'rgba(20,12,14,0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const bh = Math.max(8, U * 3.2), bw = bh * 2.2;
  for (let row = 0, yy = y + bh; yy < y + h; row++, yy += bh) {
    ctx.moveTo(x, yy); ctx.lineTo(x + w, yy);
    for (let xx = x + (row % 2 ? bw / 2 : 0); xx < x + w; xx += bw) { ctx.moveTo(xx, yy); ctx.lineTo(xx, Math.min(y + h, yy + bh)); }
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(x, y, w, Math.max(2, U * 0.6));
  ctx.restore();
  roundRect(ctx, x, y, w, h, U * 0.6);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#1e1618';
  ctx.stroke();
}

// Pointed (gothic) arch path: top = apex, h = total height to the sill.
function archPath(g, cx, top, w, h) {
  const spring = top + Math.min(h * 0.6, w * 0.62);
  g.beginPath();
  g.moveTo(cx - w / 2, top + h);
  g.lineTo(cx - w / 2, spring);
  g.quadraticCurveTo(cx - w / 2, top + w * 0.12, cx, top);
  g.quadraticCurveTo(cx + w / 2, top + w * 0.12, cx + w / 2, spring);
  g.lineTo(cx + w / 2, top + h);
  g.closePath();
}

// Stained-glass rose window in the 4 team colors.
function roseWindow(g, cx, cy, r) {
  g.save();
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  g.fillStyle = '#140e16';
  g.fill();
  const n = 8;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * TAU - Math.PI / 2, a1 = a0 + TAU / n;
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, r * 0.92, a0 + 0.05, a1 - 0.05);
    g.closePath();
    const col = PC[k % 4];
    const pg = g.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
    pg.addColorStop(0, col.light);
    pg.addColorStop(0.65, col.main);
    pg.addColorStop(1, col.dark);
    g.globalAlpha = 0.6;
    g.fillStyle = pg;
    g.fill();
    g.globalAlpha = 1;
  }
  g.strokeStyle = '#140e16';
  g.lineWidth = Math.max(2, r * 0.05);
  g.beginPath();
  g.arc(cx, cy, r * 0.48, 0, TAU);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU - Math.PI / 2 + TAU / n / 2;
    g.moveTo(cx + Math.cos(a) * r * 0.68 + r * 0.12, cy + Math.sin(a) * r * 0.68);
    g.arc(cx + Math.cos(a) * r * 0.68, cy + Math.sin(a) * r * 0.68, r * 0.12, 0, TAU);
  }
  g.stroke();
  const cg = g.createRadialGradient(cx, cy, 0, cx, cy, r * 0.22);
  cg.addColorStop(0, GOLD_HI);
  cg.addColorStop(1, GOLD_D);
  g.beginPath();
  g.arc(cx, cy, r * 0.2, 0, TAU);
  g.fillStyle = cg;
  g.fill();
  g.stroke();
  g.beginPath();
  g.arc(cx, cy, r, 0, TAU);
  g.lineWidth = Math.max(4, r * 0.12);
  g.strokeStyle = '#6a5a5e';
  g.stroke();
  g.restore();
}

// Flickering torch flame (three nested tongues).
function flame(ctx, x, y, s, t, ph) {
  const f1 = 1 + 0.14 * Math.sin(t * 13 + ph) + 0.08 * Math.sin(t * 29 + ph * 2);
  const sway = Math.sin(t * 7 + ph) * s * 0.09;
  const layers = [[1, 'rgba(255,90,20,0.9)', 'rgba(255,170,60,0.95)'], [0.68, 'rgba(255,180,70,0.95)', '#ffe9a0'], [0.36, '#fff6d8', '#ffffff']];
  for (const [k, c0, c1] of layers) {
    const h = s * k * f1, w = s * k * 0.42;
    const tip = x + sway * 1.8 * k;
    ctx.beginPath();
    ctx.moveTo(tip, y - h);
    ctx.bezierCurveTo(x + w * 0.8 + sway, y - h * 0.55, x + w, y - h * 0.08, x, y);
    ctx.bezierCurveTo(x - w, y - h * 0.08, x - w * 0.8 + sway, y - h * 0.55, tip, y - h);
    const g = ctx.createLinearGradient(0, y - h, 0, y);
    g.addColorStop(0, c0);
    g.addColorStop(1, c1);
    ctx.fillStyle = g;
    ctx.fill();
  }
}

// Heraldic shield outline centered at (x, y).
function shieldPath(ctx, x, y, w, h) {
  const t = y - h / 2;
  ctx.beginPath();
  ctx.moveTo(x - w / 2, t);
  ctx.lineTo(x + w / 2, t);
  ctx.lineTo(x + w / 2, t + h * 0.45);
  ctx.quadraticCurveTo(x + w / 2, t + h * 0.85, x, t + h);
  ctx.quadraticCurveTo(x - w / 2, t + h * 0.85, x - w / 2, t + h * 0.45);
  ctx.closePath();
}

// Team score on a heraldic shield in the team color (2 vs 2 HUD). glow = the team just scored.
function teamShield(ctx, x, y, R, t, score, glow = false) {
  const T = TEAMS[t];
  const w = R * 1.5, h = R * 1.8;
  ctx.save();
  shieldPath(ctx, x, y + h * 0.06, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fill();
  if (glow) { ctx.shadowColor = GOLD; ctx.shadowBlur = R * 0.8; }
  shieldPath(ctx, x, y, w, h);
  const g = ctx.createLinearGradient(x - w / 2, y - h / 2, x + w / 2, y + h / 2);
  g.addColorStop(0, T.light);
  g.addColorStop(0.45, T.main);
  g.addColorStop(1, T.dark);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(2, R * 0.13);
  ctx.strokeStyle = glow ? GOLD_HI : GOLD;
  ctx.stroke();
  ctx.lineWidth = Math.max(1, R * 0.05);
  ctx.strokeStyle = INK;
  ctx.stroke();
  outlined(ctx, String(score), x, y - h * 0.04, R * 1.05, '#fff', 'center', 800, { depth: 0, lw: 0.2 });
  ctx.restore();
}

// The RAFFICA! crest: a shield quartered in the 4 team colors with a golden cross.
function crest(ctx, x, y, h) {
  const w = h * 0.82;
  ctx.save();
  shieldPath(ctx, x, y + h * 0.05, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fill();
  shieldPath(ctx, x, y, w, h);
  ctx.save();
  ctx.clip();
  const t = y - h / 2;
  const q = [[x - w / 2, t, 0], [x, t, 1], [x - w / 2, y, 2], [x, y, 3]];
  for (const [qx, qy, k] of q) { ctx.fillStyle = PC[k].main; ctx.fillRect(qx, qy, w / 2, h / 2 + h * 0.02); }
  const sh = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
  sh.addColorStop(0, 'rgba(255,255,255,0.25)');
  sh.addColorStop(0.5, 'rgba(255,255,255,0)');
  sh.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = sh;
  ctx.fillRect(x - w / 2, t, w, h);
  ctx.fillStyle = GOLD;
  ctx.fillRect(x - h * 0.05, t, h * 0.1, h);
  ctx.fillRect(x - w / 2, y - h * 0.05, w, h * 0.1);
  ctx.restore();
  shieldPath(ctx, x, y, w, h);
  ctx.lineWidth = h * 0.07;
  ctx.strokeStyle = GOLD;
  ctx.stroke();
  ctx.lineWidth = Math.max(1.5, h * 0.02);
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.restore();
}

// A team banner waving from its rod (top = rod line). Folds travel down the cloth.
function clothBanner(ctx, x, top, w, len, col, t, ph, emblem) {
  const N = 12;
  const dx = (v) => Math.sin(t * 1.6 + ph - v * 3.2) * w * 0.14 * v + Math.sin(t * 0.7 + ph) * w * 0.05 * v;
  const Lp = [], Rp = [];
  for (let i = 0; i <= N; i++) {
    const v = i / N, yy = top + v * len * 0.86;
    const ww = w * (1 - 0.05 * v) * (1 + 0.04 * Math.sin(t * 2.1 + ph - v * 4));
    Lp.push([x + dx(v) - ww / 2, yy]);
    Rp.push([x + dx(v) + ww / 2, yy]);
  }
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(Lp[0][0], Lp[0][1]);
    for (const p of Lp) ctx.lineTo(p[0], p[1]);
    const xb = x + dx(1.05);
    ctx.lineTo(Lp[N][0] + dx(1.1) - dx(1), top + len);
    ctx.lineTo(xb, top + len * 0.8);
    ctx.lineTo(Rp[N][0] + dx(1.1) - dx(1), top + len);
    for (let i = N; i >= 0; i--) ctx.lineTo(Rp[i][0], Rp[i][1]);
    ctx.closePath();
  };
  // Drop shadow on the wall.
  ctx.save();
  ctx.translate(w * 0.1, w * 0.12);
  path();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();
  ctx.restore();
  path();
  const base = ctx.createLinearGradient(0, top, 0, top + len);
  base.addColorStop(0, col.main);
  base.addColorStop(1, col.dark);
  ctx.fillStyle = base;
  ctx.fill();
  // Folds: light/dark bands following the wave.
  const sh = ctx.createLinearGradient(0, top, 0, top + len);
  for (let i = 0; i <= 10; i++) {
    const v = i / 10;
    const c = Math.cos(t * 1.6 + ph - v * 3.2) * Math.min(1, v * 3);
    sh.addColorStop(v, c > 0 ? `rgba(255,240,220,${c * 0.2})` : `rgba(0,0,0,${-c * 0.32})`);
  }
  ctx.fillStyle = sh;
  ctx.fill();
  const edge = ctx.createLinearGradient(x - w * 0.7, 0, x + w * 0.7, 0);
  edge.addColorStop(0, 'rgba(0,0,0,0.35)');
  edge.addColorStop(0.3, 'rgba(0,0,0,0)');
  edge.addColorStop(0.7, 'rgba(0,0,0,0)');
  edge.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = edge;
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1.5, w * 0.045);
  ctx.strokeStyle = GOLD;
  ctx.stroke();
  // Gold band near the top and the emblem.
  ctx.beginPath();
  ctx.moveTo(Lp[1][0] + w * 0.06, Lp[1][1]);
  ctx.lineTo(Rp[1][0] - w * 0.06, Rp[1][1]);
  ctx.lineWidth = Math.max(1.5, w * 0.05);
  ctx.stroke();
  const ev = 0.42, ex = x + dx(ev), ey = top + ev * len * 0.86, es = w * 0.5;
  shieldPath(ctx, ex, ey, es * 0.82, es);
  const eg = ctx.createLinearGradient(0, ey - es / 2, 0, ey + es / 2);
  eg.addColorStop(0, GOLD_HI);
  eg.addColorStop(1, GOLD_D);
  ctx.fillStyle = eg;
  ctx.fill();
  ctx.lineWidth = Math.max(1, w * 0.025);
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.fillStyle = col.dark;
  const u = es * 0.14;
  ctx.beginPath();
  if (emblem === 0) { ctx.rect(ex - u * 0.5, ey - u * 2, u, u * 3.6); ctx.rect(ex - u * 1.6, ey - u * 0.9, u * 3.2, u); }
  else if (emblem === 1) { for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? u * 0.8 : u * 1.9; ctx.lineTo(ex + Math.cos(a) * rr, ey - u * 0.2 + Math.sin(a) * rr); } ctx.closePath(); }
  else if (emblem === 2) { ctx.moveTo(ex, ey - u * 2.1); ctx.lineTo(ex + u * 1.4, ey - u * 0.2); ctx.lineTo(ex, ey + u * 1.7); ctx.lineTo(ex - u * 1.4, ey - u * 0.2); ctx.closePath(); }
  else { ctx.arc(ex, ey - u * 0.2, u * 1.5, 0, TAU); }
  ctx.fill();
}
