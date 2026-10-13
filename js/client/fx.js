// Visual effects: particles (world space), floating texts, shake, flash, big announcements.
// Particles kinds: 'spark' (hot streak), 'dot' (glowing orb), 'star' (spinning star),
// 'flash' (short additive pop), confetti (conf: true). Glows use cached radial sprites drawn
// with 'lighter' compositing — no shadowBlur, no per-frame canvas creation.
import { PLAYER_COLORS } from '../core/proto.js';

const MAX_PARTICLES = 400;
const TAU = Math.PI * 2;
const isField = (f) => Number.isInteger(f) && f >= 0 && f < PLAYER_COLORS.length;
// Festive medieval confetti: the 4 team colors, gold leaf and cream petals.
const CONFETTI = ['#ff4b5c', '#3fa9ff', '#5fd35a', '#ffc53d', '#f6c94e', '#fff3d6', '#c8323e'];

// One small glow sprite per color, created once and reused.
const glowSprites = new Map();
function glowSprite(color) {
  let c = glowSprites.get(color);
  if (c) return c;
  if (typeof document === 'undefined') return null;
  if (glowSprites.size > 48) glowSprites.clear();
  c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  try { gr.addColorStop(0.18, color); gr.addColorStop(0.45, color); } catch { gr.addColorStop(0.3, '#ffffff'); }
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.globalAlpha = 1;
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  // Fade the colored middle so the sprite reads as a soft halo.
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(0.3, 'rgba(0,0,0,0.55)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mask;
  g.fillRect(0, 0, 64, 64);
  glowSprites.set(color, c);
  return c;
}

function starPath(ctx, x, y, r, rot) {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = rot + (k * Math.PI) / 5;
    const rr = k % 2 ? r * 0.42 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

export class Fx {
  constructor() {
    this.parts = [];
    this.texts = [];
    this.rings = [];
    this.says = [];
    this.trauma = 0;
    this.flashA = 0;
    this.flashColor = '#fff';
    this.seed = 1;
    this.seats = null; // seat -> slot of the running game: effect colors follow the team (slot) color
  }

  // Effects name a SEAT in `player`; the color is the one of the slot sitting there.
  colorOf(o, fallback = '#fff') {
    if (Number.isInteger(o.player) && o.player >= 0) {
      const slot = this.seats?.[o.player] ?? o.player;
      if (PLAYER_COLORS[slot]) return PLAYER_COLORS[slot].main;
    }
    return o.color || fallback;
  }

  rand() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  clearWorld() {
    this.parts.length = 0;
    this.texts.length = 0;
    this.rings.length = 0;
  }

  event(e, opts = {}) {
    if (e.k === 'shake') { if (opts.shake !== false) this.trauma = Math.min(1, this.trauma + (e.a ?? 0.5)); return; }
    if (e.k === 'flash') { this.flashA = Math.max(this.flashA, e.a ?? 0.6); this.flashColor = e.color || '#fff'; return; }
    if (e.k === 'say') { this.say(e.s, e); return; }
    if (e.k !== 'fx') return;
    const c = this.colorOf(e);
    const field = isField(e.field) ? e.field : null;
    const n0 = this.parts.length;
    switch (e.f) {
      case 'burst': this.burst(e.x, e.y, c, e.n ?? 14, e.speed ?? 260, e.size ?? 7); break;
      case 'confetti': this.confetti(e.x, e.y, e.n ?? 60); break;
      case 'ring': this.rings.push({ x: e.x, y: e.y, r: 4, max: e.r ?? 120, c, life: 0.5, t: 0, field }); break;
      case 'text': this.texts.push({ x: e.x, y: e.y, s: e.s, c, size: e.size ?? 44, t: 0, life: 1.15, field, wob: this.rand() * 2 - 1 }); break;
    }
    for (let k = n0; k < this.parts.length; k++) this.parts[k].field = field;
  }

  push(p) {
    if (this.parts.length >= MAX_PARTICLES) return false;
    this.parts.push(p);
    return true;
  }

  burst(x, y, color, n, speed, size) {
    // A quick additive pop at the origin.
    this.push({ x, y, vx: 0, vy: 0, s: size * 5, c: color, t: 0, life: 0.2, g: 0, drag: 1, kind: 'flash' });
    for (let k = 0; k < n && this.parts.length < MAX_PARTICLES; k++) {
      const a = this.rand() * TAU;
      const sp = speed * (0.3 + this.rand() * 0.95);
      const r = this.rand();
      const kind = r < 0.55 ? 'spark' : r < 0.85 ? 'dot' : 'star';
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        s: size * (kind === 'star' ? 1.3 : 0.55 + this.rand() * 0.9),
        c: kind === 'star' && this.rand() < 0.5 ? '#fff6b0' : color,
        t: 0, life: 0.35 + this.rand() * 0.5, g: 0, drag: kind === 'spark' ? 0.02 : 0.06,
        kind, rot: this.rand() * TAU, spin: (this.rand() - 0.5) * 14,
      });
    }
  }

  confetti(x, y, n) {
    for (let k = 0; k < n && this.parts.length < MAX_PARTICLES; k++) {
      const a = -Math.PI / 2 + (this.rand() - 0.5) * 2.2;
      const sp = 300 + this.rand() * 700;
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, s: 6 + this.rand() * 8,
        c: CONFETTI[k % CONFETTI.length], t: 0, life: 1.3 + this.rand() * 1.0, g: 900, drag: 0.6,
        conf: true, rot: this.rand() * 6, flip: this.rand() * 6, ph: this.rand() * TAU, shape: k % 5 === 0 ? 1 : 0,
      });
    }
  }

  say(text, o = {}) {
    this.says.push({ s: String(text), t: 0, life: o.big ? 0.95 : 1.6, big: !!o.big });
    if (this.says.length > 3) this.says.shift();
  }

  update(dt) {
    for (const p of this.parts) {
      p.t += dt;
      p.vy += p.g * dt;
      const k = Math.pow(p.drag, dt);
      p.vx *= k; p.vy *= k;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.conf) {
        p.rot += dt * 6;
        p.flip += dt * 9;
        p.x += Math.sin(p.t * 7 + p.ph) * 40 * dt; // flutter
      } else if (p.spin) p.rot += p.spin * dt;
    }
    this.parts = this.parts.filter((p) => p.t < p.life);
    for (const t of this.texts) t.t += dt;
    this.texts = this.texts.filter((t) => t.t < t.life);
    for (const r of this.rings) r.t += dt;
    this.rings = this.rings.filter((r) => r.t < r.life);
    for (const s of this.says) s.t += dt;
    this.says = this.says.filter((s) => s.t < s.life);
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.flashA = Math.max(0, this.flashA - dt * 2.5);
  }

  shakeOffset(time, scale) {
    const s = this.trauma * this.trauma * scale;
    return { x: Math.sin(time * 71) * s, y: Math.cos(time * 53) * s, r: Math.sin(time * 37) * s * 0.0015 };
  }

  // Draw world-space effects with the game's transform already applied.
  // P (3D games): projector { at(x, y, h?), upright(x, y) } that sets a local screen transform per item.
  drawWorld(d, field = null, P = null) {
    const { ctx } = d;
    const skip = (o) => field !== null && o.field !== null && o.field !== undefined && o.field !== field;
    const glow = d.quality > 0 || this.parts.length < 140;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Shockwave rings: soft filled disc + bright double ring.
    for (const r of this.rings) {
      if (skip(r) || (P && !P.at(r.x, r.y, 0))) continue;
      const k = r.t / r.life;
      const rad = r.r + (r.max - r.r) * (1 - Math.pow(1 - k, 3));
      ctx.globalAlpha = (1 - k) * 0.16;
      d.circle(r.x, r.y, rad, r.c);
      ctx.globalAlpha = 1 - k;
      d.ring(r.x, r.y, rad, r.c, 9 * (1 - k) + 1.5);
      ctx.globalAlpha = (1 - k) * 0.85;
      d.ring(r.x, r.y, rad * 0.86, '#ffffff', 3 * (1 - k) + 0.8);
    }

    // Additive halos (cheap sprites): sparks, orbs and pops glow on dark arenas.
    if (glow) {
      ctx.globalCompositeOperation = 'lighter';
      for (const p of this.parts) {
        if (p.conf || skip(p) || (P && !P.at(p.x, p.y))) continue;
        const k = 1 - p.t / p.life;
        const spr = glowSprite(p.c);
        if (!spr) break;
        let s;
        if (p.kind === 'flash') { s = p.s * (0.6 + (1 - k) * 0.9); ctx.globalAlpha = k; }
        else { s = p.s * 3.2 * k; ctx.globalAlpha = Math.min(1, k * 1.4) * 0.55; }
        if (s < 0.5) continue;
        ctx.drawImage(spr, p.x - s, p.y - s, s * 2, s * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // Solid bodies (readable on light arenas too).
    for (const p of this.parts) {
      if (skip(p) || p.kind === 'flash' || (P && !P.at(p.x, p.y))) continue;
      const k = 1 - p.t / p.life;
      ctx.globalAlpha = Math.min(1, k * 1.6);
      if (p.conf) {
        const fl = Math.cos(p.flip);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(1, Math.max(0.12, Math.abs(fl)));
        ctx.fillStyle = p.c;
        if (p.shape) { ctx.beginPath(); ctx.arc(0, 0, p.s * 0.4, 0, TAU); ctx.fill(); }
        else ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        if (fl < 0) { // back side is a bit darker
          ctx.fillStyle = 'rgba(0,0,0,0.28)';
          if (p.shape) ctx.fill(); else ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        }
        ctx.restore();
      } else if (p.kind === 'spark') {
        const w = Math.max(0.6, p.s * k);
        const tl = 0.045;
        ctx.beginPath();
        ctx.moveTo(p.x - p.vx * tl, p.y - p.vy * tl);
        ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = p.c;
        ctx.lineWidth = w;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x - p.vx * tl * 0.45, p.y - p.vy * tl * 0.45);
        ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = w * 0.45;
        ctx.stroke();
      } else if (p.kind === 'star') {
        starPath(ctx, p.x, p.y, Math.max(0.8, p.s * (0.4 + k * 0.6)), p.rot);
        ctx.fillStyle = p.c;
        ctx.fill();
      } else {
        const r = Math.max(0.5, p.s * k);
        ctx.fillStyle = p.c;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.arc(p.x - r * 0.25, p.y - r * 0.25, r * 0.4, 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Floating texts: elastic pop, gentle wobble, rise and fade.
    const baseRot = d.textRot;
    for (const t of this.texts) {
      if (skip(t) || (P && !P.upright(t.x, t.y))) continue;
      const k = t.t / t.life;
      ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
      const e = Math.min(1, k / 0.16);
      const pop = k < 0.16 ? 0.4 + e * 0.85 : 1.25 - Math.min(0.2, (k - 0.16) * 1.4);
      d.textRot = baseRot + Math.sin(t.t * 9) * 0.06 * (1 - k) + t.wob * 0.05;
      d.text(t.s, t.x, t.y - (1 - Math.pow(1 - k, 2)) * 70, { size: t.size * pop, color: t.c, strokeColor: 'rgba(30,12,3,0.9)' });
    }
    d.textRot = baseRot;
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}
