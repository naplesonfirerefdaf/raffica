// Small math & collision helpers shared by mini-games (pure functions).
export const TAU = Math.PI * 2;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
export const dist2 = (ax, ay, bx, by) => (bx - ax) ** 2 + (by - ay) ** 2;
export const len = (x, y) => Math.hypot(x, y);
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);
export const approach = (v, target, step) => (v < target ? Math.min(v + step, target) : Math.max(v - step, target));

// Wrap angle to (-PI, PI].
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
export const angleDiff = (a, b) => wrapAngle(b - a);
export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;

export function norm(x, y) {
  const l = Math.hypot(x, y);
  return l > 1e-9 ? { x: x / l, y: y / l } : { x: 0, y: 0 };
}

// Exponential damping factor for velocity: v *= damp(k, dt). k = fraction kept per second.
export const damp = (keepPerSecond, dt) => Math.pow(keepPerSecond, dt);

export function circleCircle(ax, ay, ar, bx, by, br) {
  return dist2(ax, ay, bx, by) < (ar + br) ** 2;
}

// Push two circles apart and exchange velocity along the normal (elastic-ish).
// a, b: {x,y,vx,vy,r,m?}. Returns impact speed (0 if no contact).
export function collideCircles(a, b, restitution = 0.9) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy), min = a.r + b.r;
  if (d >= min || d === 0) return 0;
  const nx = dx / d, ny = dy / d;
  const ma = a.m ?? 1, mb = b.m ?? 1;
  const overlap = min - d;
  a.x -= nx * overlap * (mb / (ma + mb));
  a.y -= ny * overlap * (mb / (ma + mb));
  b.x += nx * overlap * (ma / (ma + mb));
  b.y += ny * overlap * (ma / (ma + mb));
  const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rv > 0) return 0;
  const j = (-(1 + restitution) * rv) / (1 / ma + 1 / mb);
  a.vx -= (j * nx) / ma; a.vy -= (j * ny) / ma;
  b.vx += (j * nx) / mb; b.vy += (j * ny) / mb;
  return -rv;
}

// Closest point on axis-aligned rect to (px,py).
export function closestOnRect(px, py, rx, ry, rw, rh) {
  return { x: clamp(px, rx, rx + rw), y: clamp(py, ry, ry + rh) };
}

export function circleRect(cx, cy, r, rx, ry, rw, rh) {
  const c = closestOnRect(cx, cy, rx, ry, rw, rh);
  return dist2(cx, cy, c.x, c.y) < r * r;
}

// Resolve a moving circle {x,y,vx,vy,r} against rect; reflects velocity. Returns normal or null.
export function bounceCircleRect(o, rx, ry, rw, rh, restitution = 1) {
  const c = closestOnRect(o.x, o.y, rx, ry, rw, rh);
  let dx = o.x - c.x, dy = o.y - c.y;
  let d = Math.hypot(dx, dy);
  if (d >= o.r) return null;
  let nx, ny;
  if (d === 0) {
    // Center inside rect: push out along the shallowest axis.
    const left = o.x - rx, right = rx + rw - o.x, top = o.y - ry, bottom = ry + rh - o.y;
    const m = Math.min(left, right, top, bottom);
    if (m === left) { nx = -1; ny = 0; d = -left; }
    else if (m === right) { nx = 1; ny = 0; d = -right; }
    else if (m === top) { nx = 0; ny = -1; d = -top; }
    else { nx = 0; ny = 1; d = -bottom; }
  } else { nx = dx / d; ny = dy / d; }
  const push = o.r - d;
  o.x += nx * push; o.y += ny * push;
  const vn = o.vx * nx + o.vy * ny;
  if (vn < 0) { o.vx -= (1 + restitution) * vn * nx; o.vy -= (1 + restitution) * vn * ny; }
  return { nx, ny };
}

// Keep circle inside [0,w]x[0,h]; bounce. Returns true if it hit a wall.
export function bounceInBounds(o, w, h, restitution = 1) {
  let hit = false;
  if (o.x < o.r) { o.x = o.r; if (o.vx < 0) o.vx = -o.vx * restitution; hit = true; }
  if (o.x > w - o.r) { o.x = w - o.r; if (o.vx > 0) o.vx = -o.vx * restitution; hit = true; }
  if (o.y < o.r) { o.y = o.r; if (o.vy < 0) o.vy = -o.vy * restitution; hit = true; }
  if (o.y > h - o.r) { o.y = h - o.r; if (o.vy > 0) o.vy = -o.vy * restitution; hit = true; }
  return hit;
}

// Segment-segment intersection; returns t along first segment or -1.
export function segSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return -1;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

// Distance from point to segment.
export function pointSegDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const l2 = vx * vx + vy * vy;
  const t = l2 ? clamp(((px - ax) * vx + (py - ay) * vy) / l2, 0, 1) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

// Round to 1 decimal (or given step) to keep snapshots small.
export const r1 = (v) => Math.round(v * 10) / 10;
export const r2 = (v) => Math.round(v * 100) / 100;
export const r3 = (v) => Math.round(v * 1000) / 1000;
