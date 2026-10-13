// Drawing helpers handed to mini-games as `d` (see docs/ARCHITETTURA.md).
import { PLAYER_COLORS, CHAR_BY_ID, DEFAULT_CHARS } from '../core/proto.js';

export const FONT = "'Fredoka', 'Trebuchet MS', 'Arial Rounded MT Bold', system-ui, sans-serif";
// Medieval display font for big titles (vendored in public/vendor/fonts, see fonts.css).
export const TITLE_FONT = "'Cinzel Decorative', 'MedievalSharp', Georgia, 'Times New Roman', serif";

const SHADES = PLAYER_COLORS.map((c) => ({ main: c.main, light: c.light, dark: c.dark }));

export function makeDraw(ctx) {
  const d = {
    ctx,
    t: 0,
    px: 1,          // one screen pixel in world units
    textRot: 0,     // radians applied to text so it reads upright for the viewer
    quality: 1,     // 0 = low (no blur glow), 1 = high
    seats: null,    // seat -> slot of the running game (team colors follow the slot); set by the renderer
    chars: null,    // slot -> character id (snapshot pl[slot].c); set by the renderer
  };
  // Games talk in seats (player 0..n-1); colors belong to the slot that seat is sitting in.
  const slotOf = (p) => { const s = d.seats?.[p]; return Number.isInteger(s) ? s : p; };
  d.slotOf = slotOf;

  const fillStroke = (fill, stroke, lw) => {
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw ?? 3; ctx.stroke(); }
  };

  d.circle = (x, y, r, fill, stroke, lw) => {
    if (!(r > 0)) return;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    fillStroke(fill, stroke, lw);
  };
  d.ring = (x, y, r, color, lw = 3) => d.circle(x, y, r, null, color, lw);
  d.arc = (x, y, r, a0, a1, color, lw = 3) => {
    if (!(r > 0)) return;
    ctx.beginPath();
    ctx.arc(x, y, r, a0, a1);
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.stroke();
  };
  d.rect = (x, y, w, h, fill, stroke, lw) => {
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    fillStroke(fill, stroke, lw);
  };
  d.rrect = (x, y, w, h, rad, fill, stroke, lw) => {
    rad = Math.max(0, Math.min(rad, Math.abs(w) / 2, Math.abs(h) / 2));
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, rad);
    else {
      ctx.moveTo(x + rad, y);
      ctx.arcTo(x + w, y, x + w, y + h, rad);
      ctx.arcTo(x + w, y + h, x, y + h, rad);
      ctx.arcTo(x, y + h, x, y, rad);
      ctx.arcTo(x, y, x + w, y, rad);
      ctx.closePath();
    }
    fillStroke(fill, stroke, lw);
  };
  d.line = (x1, y1, x2, y2, color, lw = 3) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round';
    ctx.stroke();
  };
  d.poly = (pts, fill, stroke, lw) => {
    if (!pts || pts.length < 2) return;
    ctx.beginPath();
    if (typeof pts[0] === 'number') {
      ctx.moveTo(pts[0], pts[1]);
      for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
    } else {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
    }
    ctx.closePath();
    ctx.lineJoin = 'round';
    fillStroke(fill, stroke, lw);
  };
  d.star = (x, y, r, fill, points = 5) => {
    ctx.beginPath();
    for (let k = 0; k < points * 2; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / points;
      const rr = k % 2 ? r * 0.45 : r;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    fillStroke(fill, null);
  };
  d.text = (str, x, y, o = {}) => {
    const size = o.size ?? 40;
    ctx.save();
    ctx.translate(x, y);
    if (d.textRot) ctx.rotate(d.textRot);
    ctx.font = `${o.bold === false ? 500 : 700} ${size}px ${FONT}`;
    if (ctx.wordSpacing && ctx.wordSpacing !== '0px') ctx.wordSpacing = '0px';
    ctx.textAlign = o.align || 'center';
    ctx.textBaseline = o.baseline || 'middle';
    if (o.stroke !== false) {
      ctx.lineWidth = Math.max(2, size * 0.14);
      ctx.strokeStyle = o.strokeColor || 'rgba(30,14,4,0.8)';
      ctx.lineJoin = 'round';
      ctx.strokeText(String(str), 0, 0);
    }
    ctx.fillStyle = o.color || '#fff';
    ctx.fillText(String(str), 0, 0);
    ctx.restore();
  };
  d.emoji = (ch, x, y, size = 40) => {
    ctx.save();
    ctx.translate(x, y);
    if (d.textRot) ctx.rotate(d.textRot);
    ctx.font = `${size}px system-ui, 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  };
  d.glow = (color, blur, fn) => {
    if (!fn) return;
    if (d.quality < 1) { fn(); return; }
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = blur / Math.max(0.0001, d.px);
    fn();
    ctx.restore();
  };
  d.neon = (fn, color = '#fff') => d.glow(color, 14, fn);
  d.col = (p, shade = 'main') => (SHADES[slotOf(p)] || SHADES[0])[shade] || SHADES[0].main;
  d.grid = (step, color = 'rgba(255,255,255,0.05)', w = 4000, h = 4000) => {
    ctx.beginPath();
    for (let x = -w; x <= w; x += step) { ctx.moveTo(x, -h); ctx.lineTo(x, h); }
    for (let y = -h; y <= h; y += step) { ctx.moveTo(-w, y); ctx.lineTo(w, y); }
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  };
  d.shadow = (x, y, rx, ry, alpha = 0.3) => {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry ?? rx * 0.5), 0, 0, Math.PI * 2);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
  };
  d.avatar = (x, y, r, p, o = {}) => drawAvatar(d, x, y, r, slotOf(p), o);
  d.avatarSlot = (x, y, r, slot, o = {}) => drawAvatar(d, x, y, r, slot, o); // framework HUD: slot colors directly
  return d;
}

// ---------- The shared player character ----------
// A glossy neon blob with big expressive eyes. Everything is drawn in a unit space (radius 1)
// so the gradients are created once per context and reused every frame (no per-frame allocations,
// no shadowBlur).
const OUTLINE = ['#3b0619', '#03283a', '#0e3a0c', '#4a3000'];
const BLUSH = ['#ff1f63', '#ff5fa8', '#ff6f6f', '#ff8a4a'];
const TAU = Math.PI * 2;

function avatarCache(d) {
  if (d._av) return d._av;
  const { ctx } = d;
  const body = SHADES.map((s) => {
    const g = ctx.createRadialGradient(-0.36, -0.42, 0.04, -0.08, -0.08, 1.08);
    g.addColorStop(0, s.light);
    g.addColorStop(0.42, s.main);
    g.addColorStop(0.86, s.dark);
    g.addColorStop(1, s.dark);
    return g;
  });
  const shine = ctx.createLinearGradient(0, -0.86, 0, -0.46);
  shine.addColorStop(0, 'rgba(255,255,255,0.85)');
  shine.addColorStop(1, 'rgba(255,255,255,0)');
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  halo.addColorStop(0, 'rgba(200,250,255,0.9)');
  halo.addColorStop(0.35, 'rgba(46,230,255,0.35)');
  halo.addColorStop(1, 'rgba(46,230,255,0)');
  const horn = ctx.createLinearGradient(0, -1.32, 0, -0.62);
  horn.addColorStop(0, '#fff3f8');
  horn.addColorStop(0.5, SHADES[0].light);
  horn.addColorStop(1, SHADES[0].main);
  const gold = ctx.createLinearGradient(0, -0.62, 0, 0.05);
  gold.addColorStop(0, '#fff6b0');
  gold.addColorStop(0.5, '#ffd23f');
  gold.addColorStop(1, '#e09a00');
  d._av = { body, shine, halo, horn, gold };
  return d._av;
}

function starPath(ctx, x, y, r, rot = 0) {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = rot - Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

function drawAvatar(d, x, y, r, p, o) {
  if (!(r > 0)) return;
  const { ctx } = d;
  p = p >= 0 && p < SHADES.length ? p | 0 : 0;
  // Medieval portrait of the player's character; the blob is only the last-resort fallback.
  const ch = CHAR_BY_ID[d.chars?.[p]] || CHAR_BY_ID[DEFAULT_CHARS[p]];
  if (ch && !o.blob) { drawPortrait(d, x, y, r, p, ch, o); return; }
  const cache = avatarCache(d);
  const sh = SHADES[p];
  const ink = OUTLINE[p];
  const mood = o.mood || 'ok';
  const t = d.t || 0;
  const dead = mood === 'dead';
  const scared = mood === 'scared';
  const sq = Math.max(-0.45, Math.min(0.45, o.squash || 0));
  // Idle "breathing" (the blob stretches up a little) — not when knocked out.
  const br = dead ? 0 : Math.sin(t * 2.6 + p * 1.7) * 0.028;
  const sx = (1 + sq) * (1 - br * 0.6), sy = (1 - sq) * (1 + br);
  const lw = Math.max(0.085, (1.3 * (d.px || 1)) / r); // outline width, in unit space
  ctx.save();
  ctx.translate(x, y);
  if (o.alpha !== undefined) ctx.globalAlpha *= Math.max(0, Math.min(1, o.alpha));
  ctx.scale(r * sx, r * sy);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // --- accessories behind the body (one per team color) ---
  if (p === 2) {
    // A little sprout with two leaves.
    const sway = dead ? 0.3 : Math.sin(t * 2.7 + 1.1) * 0.12 + sq * 0.3;
    ctx.beginPath();
    ctx.moveTo(0, -0.88);
    ctx.quadraticCurveTo(sway * 0.5, -1.12, sway, -1.3);
    ctx.lineWidth = lw * 2.2;
    ctx.strokeStyle = ink;
    ctx.stroke();
    ctx.lineWidth = lw * 0.95;
    ctx.strokeStyle = sh.light;
    ctx.stroke();
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.translate(sway, -1.3);
      ctx.rotate(s * 0.9 + sway);
      ctx.beginPath();
      ctx.ellipse(0, -0.2, 0.12, 0.24, 0, 0, TAU);
      ctx.fillStyle = s < 0 ? sh.main : sh.light;
      ctx.fill();
      ctx.lineWidth = lw;
      ctx.strokeStyle = ink;
      ctx.stroke();
      ctx.restore();
    }
  } else if (p === 3) {
    // Two round bear ears.
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * 0.62, -0.7, 0.3, 0, TAU);
      ctx.fillStyle = sh.main;
      ctx.fill();
      ctx.lineWidth = lw;
      ctx.strokeStyle = ink;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(s * 0.62, -0.7, 0.15, 0, TAU);
      ctx.fillStyle = sh.dark;
      ctx.fill();
    }
  } else if (p === 0) {
    // Two curved pink horns.
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s * 0.2, -0.82);
      ctx.quadraticCurveTo(s * 0.32, -1.2, s * 0.66, -1.32);
      ctx.quadraticCurveTo(s * 0.56, -1.0, s * 0.76, -0.58);
      ctx.closePath();
      ctx.fillStyle = cache.horn;
      ctx.fill();
      ctx.lineWidth = lw;
      ctx.strokeStyle = ink;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s * 0.4, -0.97);
      ctx.quadraticCurveTo(s * 0.45, -1.13, s * 0.58, -1.22);
      ctx.lineWidth = lw * 0.55;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.stroke();
    }
  } else {
    // A wobbly antenna with a glowing bulb.
    const sway = dead ? 0.25 : Math.sin(t * 3.1 + 0.6) * 0.1 + sq * 0.3;
    const bx = 0.16 + sway, by = -1.46;
    ctx.beginPath();
    ctx.moveTo(0, -0.85);
    ctx.quadraticCurveTo(0.28 + sway * 0.4, -1.2, bx, by);
    ctx.lineWidth = lw * 2.4;
    ctx.strokeStyle = ink;
    ctx.stroke();
    ctx.lineWidth = lw * 1.05;
    ctx.strokeStyle = sh.main;
    ctx.stroke();
    if (!dead) {
      ctx.save();
      ctx.translate(bx, by);
      const hs = 0.44 + Math.sin(t * 5) * 0.06;
      ctx.scale(hs, hs);
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, TAU);
      ctx.fillStyle = cache.halo;
      ctx.fill();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(bx, by, 0.17, 0, TAU);
    ctx.fillStyle = dead ? sh.dark : sh.light;
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = ink;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(bx - 0.05, by - 0.05, 0.055, 0, TAU);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }

  // --- body ---
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, TAU);
  ctx.fillStyle = cache.body[p];
  ctx.fill();
  if (dead) { ctx.fillStyle = 'rgba(30,20,50,0.38)'; ctx.fill(); }
  ctx.lineWidth = lw * 1.2;
  ctx.strokeStyle = ink;
  ctx.stroke();
  // Rim light (bottom-right) and glossy highlight (top-left).
  ctx.beginPath();
  ctx.arc(0, 0, 0.83, 0.1 * Math.PI, 0.62 * Math.PI);
  ctx.lineWidth = 0.09;
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.stroke();
  ctx.save();
  ctx.rotate(-0.6);
  ctx.beginPath();
  ctx.ellipse(0, -0.66, 0.4, 0.19, 0, 0, TAU);
  ctx.fillStyle = cache.shine;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(0.32, -0.7, 0.06, 0, TAU);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fill();

  // --- face ---
  const hasLook = o.look !== undefined && o.look !== null;
  const lx = hasLook ? Math.cos(o.look) : Math.sin(t * 0.7 + p * 2) * 0.3;
  const ly = hasLook ? Math.sin(o.look) : 0;
  const fx = lx * 0.13, fy = ly * 0.09;

  // Cheeks.
  const blushA = mood === 'happy' ? 0.75 : scared || dead ? 0.15 : mood === 'angry' ? 0.7 : 0.45;
  const a0 = ctx.globalAlpha;
  ctx.globalAlpha = a0 * blushA;
  ctx.fillStyle = BLUSH[p];
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(s * 0.56 + fx * 0.7, 0.2 + fy, 0.14, 0.085, 0, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = a0;

  // Eyes.
  const ex = 0.34, ey = -0.1 + fy;
  const blinkP = (t + p * 1.37) % (p ? 4.3 : 3.7);
  const open = mood === 'ok' || mood === 'angry' ? Math.min(1, Math.abs(blinkP / 0.07 - 1)) : 1;
  const jit = scared ? Math.sin(t * 47) * 0.012 : 0;
  ctx.strokeStyle = ink;
  for (const s of [-1, 1]) {
    const cx = s * ex + fx + jit, cy = ey;
    if (mood === 'hurt') { // squeezed > <
      ctx.beginPath();
      ctx.moveTo(cx + s * 0.15, cy - 0.12);
      ctx.lineTo(cx - s * 0.12, cy);
      ctx.lineTo(cx + s * 0.15, cy + 0.12);
      ctx.lineWidth = lw * 1.1;
      ctx.stroke();
      continue;
    }
    if (dead) { // X
      ctx.beginPath();
      ctx.moveTo(cx - 0.13, cy - 0.13); ctx.lineTo(cx + 0.13, cy + 0.13);
      ctx.moveTo(cx + 0.13, cy - 0.13); ctx.lineTo(cx - 0.13, cy + 0.13);
      ctx.lineWidth = lw * 1.1;
      ctx.stroke();
      continue;
    }
    if (mood === 'happy') { // ^ ^
      ctx.beginPath();
      ctx.arc(cx, cy + 0.08, 0.15, Math.PI * 1.12, Math.PI * 1.88);
      ctx.lineWidth = lw * 1.15;
      ctx.stroke();
      continue;
    }
    const rx = scared ? 0.26 : 0.24, ry = (scared ? 0.32 : 0.28) * open;
    if (open < 0.2) { // closed lid while blinking
      ctx.beginPath();
      ctx.moveTo(cx - rx * 0.8, cy + 0.02);
      ctx.quadraticCurveTo(cx, cy + 0.1, cx + rx * 0.8, cy + 0.02);
      ctx.lineWidth = lw;
      ctx.stroke();
      continue;
    }
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = lw * 0.85;
    ctx.stroke();
    if (mood === 'dizzy') {
      ctx.beginPath();
      for (let k = 0; k < 16; k++) {
        const a = k * 0.75 + t * 9 * s;
        const rr = (k / 16) * 0.19;
        ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * open);
      }
      ctx.lineWidth = lw * 0.7;
      ctx.stroke();
      continue;
    }
    const pr = scared ? 0.08 : 0.14;
    const px = cx + lx * 0.08, py = cy + ly * 0.08 * open;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(px, py, pr + 0.035, 0, TAU);
    ctx.fillStyle = sh.dark;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, TAU);
    ctx.fillStyle = '#120818';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px - pr * 0.4, py - pr * 0.45, pr * 0.42, 0, TAU);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px + pr * 0.42, py + pr * 0.4, pr * 0.18, 0, TAU);
    ctx.fill();
    // Angry: heavy upper lid slanting toward the nose.
    if (mood === 'angry') {
      ctx.beginPath();
      ctx.moveTo(cx - rx - 0.05, cy - ry - 0.05);
      ctx.lineTo(cx + rx + 0.05, cy - ry - 0.05);
      ctx.lineTo(cx + rx + 0.05, cy + (s > 0 ? -ry * 0.75 : -ry * 0.05)); // outer corner
      ctx.lineTo(cx - rx - 0.05, cy + (s > 0 ? -ry * 0.05 : -ry * 0.75));
      ctx.closePath();
      ctx.fillStyle = sh.main;
      ctx.fill();
    }
    ctx.restore();
  }

  // Brows.
  ctx.lineWidth = lw * 1.1;
  ctx.strokeStyle = ink;
  ctx.beginPath();
  for (const s of [-1, 1]) {
    if (mood === 'angry') {
      ctx.moveTo(fx + s * 0.1, fy - 0.36); ctx.lineTo(fx + s * 0.56, fy - 0.54);
    } else if (scared || mood === 'hurt') {
      ctx.moveTo(fx + s * 0.14, fy - 0.62); ctx.quadraticCurveTo(fx + s * 0.34, fy - 0.62, fx + s * 0.52, fy - 0.48);
    } else if (mood === 'happy') {
      ctx.moveTo(fx + s * 0.18, fy - 0.46); ctx.quadraticCurveTo(fx + s * 0.34, fy - 0.6, fx + s * 0.5, fy - 0.48);
    } else if (mood === 'dizzy') {
      ctx.moveTo(fx + s * 0.18, fy - 0.5 + s * 0.06); ctx.lineTo(fx + s * 0.5, fy - 0.5 - s * 0.06);
    } else if (!dead) {
      ctx.moveTo(fx + s * 0.2, fy - 0.47); ctx.quadraticCurveTo(fx + s * 0.35, fy - 0.54, fx + s * 0.5, fy - 0.47);
    }
  }
  ctx.stroke();

  // Mouth.
  const mx = fx, my = 0.38 + fy;
  ctx.lineWidth = lw;
  ctx.strokeStyle = ink;
  if (mood === 'happy') {
    ctx.beginPath();
    ctx.moveTo(mx - 0.24, my - 0.06);
    ctx.quadraticCurveTo(mx, my - 0.02, mx + 0.24, my - 0.06);
    ctx.quadraticCurveTo(mx + 0.2, my + 0.26, mx, my + 0.27);
    ctx.quadraticCurveTo(mx - 0.2, my + 0.26, mx - 0.24, my - 0.06);
    ctx.closePath();
    ctx.fillStyle = '#4a0820';
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.beginPath();
    ctx.ellipse(mx, my + 0.25, 0.14, 0.1, 0, 0, TAU);
    ctx.fillStyle = '#ff6f91';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(mx - 0.22, my - 0.08, 0.44, 0.07);
    ctx.restore();
    ctx.stroke();
  } else if (mood === 'angry') {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(mx - 0.2, my - 0.04, 0.4, 0.15, 0.05); else ctx.rect(mx - 0.2, my - 0.04, 0.4, 0.15);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(mx - 0.2, my + 0.035); ctx.lineTo(mx + 0.2, my + 0.035);
    ctx.moveTo(mx - 0.07, my - 0.04); ctx.lineTo(mx - 0.07, my + 0.11);
    ctx.moveTo(mx + 0.07, my - 0.04); ctx.lineTo(mx + 0.07, my + 0.11);
    ctx.lineWidth = lw * 0.5;
    ctx.stroke();
  } else if (scared) {
    const wob = 1 + Math.sin(t * 22) * 0.08;
    ctx.beginPath();
    ctx.ellipse(mx, my + 0.04, 0.1 * wob, 0.14 / wob, 0, 0, TAU);
    ctx.fillStyle = '#4a0820';
    ctx.fill();
    ctx.stroke();
  } else if (mood === 'hurt') {
    ctx.beginPath();
    ctx.moveTo(mx - 0.22, my + 0.06);
    for (let k = 1; k <= 6; k++) ctx.lineTo(mx - 0.22 + (k * 0.44) / 6, my + 0.06 + (k % 2 ? -0.07 : 0.0));
    ctx.lineTo(mx + 0.2, my + 0.14);
    ctx.quadraticCurveTo(mx, my + 0.22, mx - 0.2, my + 0.14);
    ctx.closePath();
    ctx.fillStyle = '#4a0820';
    ctx.fill();
    ctx.stroke();
  } else if (mood === 'dizzy') {
    ctx.beginPath();
    ctx.moveTo(mx - 0.2, my + 0.04);
    for (let k = 1; k <= 8; k++) ctx.lineTo(mx - 0.2 + (k * 0.4) / 8, my + 0.04 + Math.sin(k * 1.6 + t * 6) * 0.045);
    ctx.stroke();
  } else if (dead) {
    ctx.beginPath();
    ctx.moveTo(mx - 0.18, my + 0.04); ctx.lineTo(mx + 0.18, my + 0.04);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(mx + 0.02, my + 0.04);
    ctx.lineTo(mx + 0.02, my + 0.16);
    ctx.arc(mx + 0.1, my + 0.16, 0.08, Math.PI, 0, true);
    ctx.lineTo(mx + 0.18, my + 0.04);
    ctx.fillStyle = '#ff6f91';
    ctx.fill();
    ctx.lineWidth = lw * 0.7;
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(mx, my - 0.1, 0.16, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();
  }

  // Extras: sweat drop, orbiting stars, hat.
  if (scared || mood === 'hurt') {
    const k = (t * 1.3 + p * 0.5) % 1;
    ctx.globalAlpha = a0 * (1 - k * 0.6);
    const dx = 0.78, dy = -0.5 + k * 0.25;
    ctx.beginPath();
    ctx.moveTo(dx, dy - 0.2);
    ctx.quadraticCurveTo(dx + 0.12, dy, dx, dy + 0.06);
    ctx.quadraticCurveTo(dx - 0.12, dy, dx, dy - 0.2);
    ctx.fillStyle = '#bff3ff';
    ctx.fill();
    ctx.lineWidth = lw * 0.6;
    ctx.strokeStyle = '#1b4f7a';
    ctx.stroke();
    ctx.globalAlpha = a0;
  }
  if (mood === 'dizzy') {
    for (let k = 0; k < 3; k++) {
      const a = t * 4 + (k * TAU) / 3;
      starPath(ctx, Math.cos(a) * 0.75, -1.0 + Math.sin(a) * 0.18, 0.17, a);
      ctx.fillStyle = '#ffe14d';
      ctx.fill();
      ctx.lineWidth = lw * 0.6;
      ctx.strokeStyle = '#7a4a00';
      ctx.stroke();
    }
  }
  if (o.hat) drawHat(ctx, o.hat, cache, lw, t);
  ctx.restore();
}

// Optional hat: 'party' cone, anything else truthy = golden crown.
// Character portrait: the character icon on a team-colored shield disc with a gold rim (same look as the
// HUD badges); the mood shows as a tint, a small wobble and a little symbol next to the face.
const MOOD_MARK = { happy: '✨', hurt: '💢', angry: '💢', scared: '💦', dizzy: '💫', dead: '✖️' };
function drawPortrait(d, x, y, r, p, ch, o) {
  const { ctx } = d;
  const cache = avatarCache(d);
  const mood = o.mood || 'ok';
  const t = d.t || 0;
  const dead = mood === 'dead';
  const sq = Math.max(-0.45, Math.min(0.45, o.squash || 0));
  const br = dead ? 0 : Math.sin(t * 2.6 + p * 1.7) * 0.028;
  const sx = (1 + sq) * (1 - br * 0.6), sy = (1 - sq) * (1 + br);
  const lw = Math.max(0.06, (1.2 * (d.px || 1)) / r);
  ctx.save();
  ctx.translate(x, y);
  if (o.alpha !== undefined) ctx.globalAlpha *= Math.max(0, Math.min(1, o.alpha));
  if (dead) ctx.globalAlpha *= 0.75;
  ctx.save();
  ctx.scale(r * sx, r * sy);
  ctx.beginPath();
  ctx.arc(0, 0.1, 1, 0, TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, TAU);
  ctx.fillStyle = dead ? '#6a6268' : cache.body[p];
  ctx.fill();
  if (mood === 'hurt' || mood === 'angry') { ctx.fillStyle = 'rgba(255,40,30,0.28)'; ctx.fill(); }
  ctx.lineWidth = 0.14;
  ctx.strokeStyle = cache.gold;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 1.07, 0, TAU);
  ctx.lineWidth = lw;
  ctx.strokeStyle = '#2a170b';
  ctx.stroke();
  if (o.hat) drawHat(ctx, o.hat, cache, lw, t);
  ctx.restore();
  // Icon and mood mark stay upright for the viewer.
  ctx.rotate(d.textRot || 0);
  const wob = mood === 'dizzy' ? Math.sin(t * 9) * 0.25 : mood === 'scared' ? Math.sin(t * 50) * 0.06 : mood === 'hurt' ? Math.sin(t * 40) * 0.08 : 0;
  const hop = mood === 'happy' ? -Math.abs(Math.sin(t * 6)) * r * 0.08 : 0;
  ctx.save();
  ctx.translate(0, hop);
  ctx.rotate(wob);
  ctx.font = `${r * 1.05}px system-ui, 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (dead) ctx.filter = 'grayscale(1)';
  ctx.fillText(ch.icon, 0, r * 0.06);
  ctx.filter = 'none';
  ctx.restore();
  const mark = MOOD_MARK[mood];
  if (mark) {
    ctx.font = `${r * 0.6}px system-ui, 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(mark, r * 0.78, -r * 0.72 + Math.sin(t * 5) * r * 0.05);
  }
  ctx.restore();
}

function drawHat(ctx, kind, cache, lw, t) {
  ctx.save();
  ctx.translate(0, kind === 'party' ? -0.86 : -0.8);
  ctx.rotate(-0.12 + Math.sin(t * 3) * 0.05);
  if (kind === 'party') {
    ctx.beginPath();
    ctx.moveTo(-0.34, 0.02); ctx.lineTo(0, -0.82); ctx.lineTo(0.34, 0.02);
    ctx.quadraticCurveTo(0, 0.12, -0.34, 0.02);
    ctx.fillStyle = '#b56bff';
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 0.09;
    for (let k = -2; k < 4; k++) { ctx.beginPath(); ctx.moveTo(-0.5, k * 0.25 - 0.2); ctx.lineTo(0.5, k * 0.25 - 0.45); ctx.stroke(); }
    ctx.restore();
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#2a0b45';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -0.84, 0.1, 0, TAU);
    ctx.fillStyle = '#ff3d7f';
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(-0.46, 0.05);
    ctx.lineTo(-0.52, -0.5); ctx.lineTo(-0.24, -0.24);
    ctx.lineTo(0, -0.62); ctx.lineTo(0.24, -0.24);
    ctx.lineTo(0.52, -0.5); ctx.lineTo(0.46, 0.05);
    ctx.closePath();
    ctx.fillStyle = cache.gold;
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#6b3d00';
    ctx.stroke();
    for (const [gx, gy, gc] of [[-0.25, -0.08, '#ff3d7f'], [0, -0.1, '#2ee6ff'], [0.25, -0.08, '#7cff6b']]) {
      ctx.beginPath();
      ctx.arc(gx, gy, 0.075, 0, TAU);
      ctx.fillStyle = gc;
      ctx.fill();
      ctx.lineWidth = lw * 0.5;
      ctx.stroke();
    }
    for (const [tx, ty] of [[-0.52, -0.5], [0, -0.62], [0.52, -0.5]]) {
      ctx.beginPath();
      ctx.arc(tx, ty, 0.07, 0, TAU);
      ctx.fillStyle = '#fff6b0';
      ctx.fill();
      ctx.lineWidth = lw * 0.5;
      ctx.stroke();
    }
  }
  ctx.restore();
}
