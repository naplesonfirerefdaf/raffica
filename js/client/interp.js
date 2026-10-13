// Generic snapshot interpolation between two game views of the same shape.
// Only continuous quantities are blended (positions, angles, sizes — recognised by key name);
// everything else (states, indices, counters) takes the newer value, so discrete codes never become fractions.
// - arrays of objects with `id` are matched by id, otherwise by index
// - big jumps (teleports, wrap-around) snap to the newer value
const ANGLE_KEYS = new Set(['a', 'ang', 'angle', 'rot', 'heading']);
const LERP_KEY = /^(x|y|z|r|w|h|vx|vy|s|sc|scale|size|rad|len|[a-z]?[xy]\d?|[a-z]+[XY]|x\d|y\d|pts|trail|tr|path|line)$/;
const SNAP_DIST = 160;

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

const lerpable = (key) => ANGLE_KEYS.has(key) || LERP_KEY.test(key);

export function interp(a, b, t, key = '', inherit = false) {
  if (t >= 1 || a === undefined || a === null) return b;
  if (typeof b === 'number') {
    if (typeof a !== 'number' || !(inherit || lerpable(key))) return b;
    if (ANGLE_KEYS.has(key)) return lerpAngle(a, b, t);
    if (Math.abs(b - a) > SNAP_DIST) return b;
    return a + (b - a) * t;
  }
  if (Array.isArray(b)) {
    if (!Array.isArray(a)) return b;
    const byId = b.length && b[0] && typeof b[0] === 'object' && 'id' in b[0];
    if (byId) {
      const map = new Map();
      for (const o of a) if (o && typeof o === 'object') map.set(o.id, o);
      return b.map((o) => (map.has(o.id) ? interp(map.get(o.id), o, t) : o));
    }
    if (a.length !== b.length) return b;
    // Plain number arrays (e.g. point lists) are blended only under a positional key.
    const numeric = typeof b[0] === 'number';
    return b.map((v, k) => interp(a[k], v, t, key, numeric ? lerpable(key) : false));
  }
  if (b && typeof b === 'object') {
    if (!a || typeof a !== 'object') return b;
    if (b.noLerp) return b;
    const out = {};
    for (const k in b) out[k] = interp(a[k], b[k], t, k);
    return out;
  }
  return b;
}
