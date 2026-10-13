// Unified input: two configurable keyboard sets, PS5/Xbox gamepads (Gamepad API) and multi-touch controls.
// Gamepads are identified by their stable `gamepad.index`; press counters never go backwards
// (even if a controller disconnects), so no presses are lost or invented.
// Events (on): press {src:'kb'|'pad'|'touch', idx, btn}, dir {src:'kb'|'pad', idx, dir} (per device, used by
// the "Unisciti!" screen), nav {act} (menu focus), pause, music.
import { toLocal, enterRect } from './layout.js';
import { FONT } from './draw.js';

export const ACTIONS = ['up', 'down', 'left', 'right', 'a', 'b'];
export const DEFAULT_PAD = { a: [0, 2], b: [1, 3] }; // ✕ □ = A, ○ △ = B
export const PAD_NAMES = ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3'];
export const DEFAULT_KEYS = [
  { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], a: ['KeyF', 'Space'], b: ['KeyG', 'ShiftLeft'] },
  { up: ['ArrowUp', 'Numpad8'], down: ['ArrowDown', 'Numpad5', 'Numpad2'], left: ['ArrowLeft', 'Numpad4'], right: ['ArrowRight', 'Numpad6'],
    a: ['KeyK', 'Numpad0', 'Numpad1'], b: ['KeyL', 'NumpadDecimal', 'Numpad3'] },
];
const NAV_KEYS = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  Enter: 'ok', NumpadEnter: 'ok', Space: 'ok', Escape: 'back', Backspace: 'back',
};
const DEAD = 0.22;
const JOY_R = 56; // CSS px of full joystick deflection

function deadzone(x, y) {
  const m = Math.hypot(x, y);
  if (m < DEAD) return { x: 0, y: 0 };
  const k = Math.min(1, (m - DEAD) / (1 - DEAD)) / m;
  return { x: x * k, y: y * k };
}

// Human-readable key name (Italian-friendly).
export function keyName(code) {
  if (!code) return '—';
  const map = { Space: 'Spazio', ShiftLeft: 'Shift sx', ShiftRight: 'Shift dx', ControlLeft: 'Ctrl sx', ControlRight: 'Ctrl dx',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Enter: 'Invio', NumpadEnter: 'Invio tn', AltLeft: 'Alt', Tab: 'Tab',
    Comma: ',', Period: '.', Slash: '-', Semicolon: 'ò', Quote: 'à', BracketLeft: 'è', BracketRight: '+', Backslash: 'ù', Minus: "'", Equal: 'ì' };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

export class Input {
  constructor(target) {
    this.keys = DEFAULT_KEYS.map((m) => cloneMap(m));
    this.down = new Set();
    this.kbPress = [{ a: 0, b: 0 }, { a: 0, b: 0 }];
    this.padPress = new Map(); // gamepad.index -> {a,b} (kept after disconnect: counters stay monotonic)
    this.padPrev = new Map();
    this.padNames = new Map();
    this.touchPress = [{ a: 0, b: 0 }, { a: 0, b: 0 }];
    this.touchState = [this.blankTouch(), this.blankTouch()];
    this.pointers = new Map();
    this.controls = [];      // touch control rects from the layout (c.t = touch pad index 0/1)
    this.cfg = [null, null]; // per touch pad: {dir, a, b}
    this.listeners = new Set();
    this.lastTouchAt = -Infinity;
    this.capture = null;     // fn(code) while remapping keys
    this.padCapture = null;  // fn(buttonIndex) while remapping controller buttons
    this.padMap = { a: [...DEFAULT_PAD.a], b: [...DEFAULT_PAD.b] };

    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => this.down.clear());
    if (target) {
      target.addEventListener('pointerdown', (e) => this.onPointer(e, 'down'), { passive: false });
      target.addEventListener('pointermove', (e) => this.onPointer(e, 'move'), { passive: false });
      target.addEventListener('pointerup', (e) => this.onPointer(e, 'up'), { passive: false });
      target.addEventListener('pointercancel', (e) => this.onPointer(e, 'up'), { passive: false });
      target.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  setPadMap(m) {
    const ok = (l) => Array.isArray(l) && l.length && l.every((i) => Number.isInteger(i) && i >= 0 && i < 12);
    this.padMap = { a: ok(m?.a) ? m.a.slice(0, 2) : [...DEFAULT_PAD.a], b: ok(m?.b) ? m.b.slice(0, 2) : [...DEFAULT_PAD.b] };
  }

  setKeys(maps) {
    this.keys = [0, 1].map((k) => sanitizeMap(maps?.[k], DEFAULT_KEYS[k]));
  }

  blankTouch() { return { jx: 0, jy: 0, a: false, b: false, na: 0, nb: 0, joy: null }; }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) fn(ev); }

  typing() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  onKey(e, isDown) {
    if (this.capture && isDown) {
      e.preventDefault();
      const fn = this.capture;
      this.capture = null;
      fn(e.code);
      return;
    }
    if (this.typing()) return;
    const code = e.code;
    if (isDown) {
      if (!this.down.has(code)) {
        this.keys.forEach((set, k) => {
          if (set.a.includes(code)) { this.kbPress[k].a++; this.emit({ type: 'press', src: 'kb', idx: k, btn: 'a' }); }
          if (set.b.includes(code)) { this.kbPress[k].b++; this.emit({ type: 'press', src: 'kb', idx: k, btn: 'b' }); }
          for (const d of ['up', 'down', 'left', 'right']) if (set[d].includes(code)) this.emit({ type: 'dir', src: 'kb', idx: k, dir: d });
        });
        let nav = NAV_KEYS[code];
        if (!nav && this.keys.some((s) => s.a.includes(code))) nav = 'ok';
        if (nav) this.emit({ type: 'nav', act: nav, src: 'kb', code });
        if (code === 'Escape' || code === 'KeyP') this.emit({ type: 'pause' });
        if (code === 'KeyM') this.emit({ type: 'music' });
      }
      this.down.add(code);
      // Keep game keys from scrolling the page or activating focused buttons.
      if (code.startsWith('Arrow') || code === 'Space' || (this.inGame && (code === 'Enter' || code === 'NumpadEnter'))) e.preventDefault();
    } else this.down.delete(code);
  }

  // ---------- touch ----------
  setTouch(controls, cfg) {
    this.controls = controls || [];
    this.cfg = cfg || [null, null];
  }

  zoneAt(px, py) {
    for (const c of this.controls) {
      if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) {
        const loc = toLocal(c, px, py);
        const cfg = this.cfg[c.t];
        if (!cfg) return null;
        for (const z of touchZones(loc.w, loc.h, cfg)) {
          if (loc.x >= z.x && loc.x <= z.x + z.w && loc.y >= z.y && loc.y <= z.y + z.h) return { c, z, loc };
        }
      }
    }
    return null;
  }

  onPointer(e, kind) {
    if (e.pointerType === 'mouse' && !this.controls.length) return;
    if (e.pointerType !== 'mouse') this.lastTouchAt = performance.now();
    if (kind === 'down') {
      const hit = this.zoneAt(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      const slot = hit.c.t, st = this.touchState[slot];
      if (hit.z.kind === 'joy') {
        if (st.joy) return; // the stick already has a thumb on it
        st.joy = { ox: hit.loc.x, oy: hit.loc.y, id: e.pointerId };
        st.jx = 0; st.jy = 0;
      } else {
        const k = hit.z.kind;
        st['n' + k]++;
        st[k] = true;
        this.touchPress[slot][k]++;
        this.emit({ type: 'press', src: 'touch', idx: slot, btn: k });
        if (navigator.vibrate) try { navigator.vibrate(8); } catch { /* not allowed */ }
      }
      this.pointers.set(e.pointerId, { slot, kind: hit.z.kind, c: hit.c });
      try { e.target.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
      return;
    }
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const st = this.touchState[p.slot];
    if (kind === 'move') {
      if (p.kind === 'joy' && st.joy && st.joy.id === e.pointerId) {
        const loc = toLocal(p.c, e.clientX, e.clientY);
        let dx = loc.x - st.joy.ox, dy = loc.y - st.joy.oy;
        const m = Math.hypot(dx, dy);
        // Drag the origin along when the thumb goes past the rim (floating stick).
        if (m > JOY_R) { st.joy.ox += (dx / m) * (m - JOY_R); st.joy.oy += (dy / m) * (m - JOY_R); dx = (dx / m) * JOY_R; dy = (dy / m) * JOY_R; }
        st.jx = dx / JOY_R; st.jy = dy / JOY_R;
      }
      return;
    }
    // up / cancel
    if (p.kind === 'joy') {
      if (st.joy && st.joy.id === e.pointerId) { st.joy = null; st.jx = 0; st.jy = 0; }
    } else {
      st['n' + p.kind] = Math.max(0, st['n' + p.kind] - 1);
      st[p.kind] = st['n' + p.kind] > 0;
    }
    this.pointers.delete(e.pointerId);
  }

  // ---------- polling ----------
  pads() {
    const list = [];
    const gp = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const g of gp || []) if (g && g.connected) list.push(g);
    return list;
  }

  padLabel(index) {
    const id = this.padNames.get(index);
    return id ? `${padKind(id)} ${index + 1}` : `Controller ${index + 1}`;
  }

  pollPads() {
    const pads = this.pads();
    for (const g of pads) {
      this.padNames.set(g.index, g.id);
      const b = (i) => !!g.buttons[i]?.pressed;
      const prev = this.padPrev.get(g.index) || {};
      if (this.padCapture) {
        const prevBtns = this.padPrev.get(g.index)?.btns || [];
        for (let i = 0; i < 12; i++) {
          if (b(i) && !prevBtns[i]) { const fn = this.padCapture; this.padCapture = null; fn(i); break; }
        }
      }
      const now = {
        a: this.padMap.a.some(b), b: this.padMap.b.some(b), up: b(12), down: b(13), left: b(14), right: b(15), start: b(9),
        ax: g.axes[0] || 0, ay: g.axes[1] || 0, btns: Array.from({ length: 12 }, (_, i) => b(i)),
      };
      const cnt = this.padPress.get(g.index) || { a: 0, b: 0 };
      if (now.a && !prev.a) { cnt.a++; this.emit({ type: 'press', src: 'pad', idx: g.index, btn: 'a' }); this.emit({ type: 'nav', act: 'ok', src: 'pad', pad: g.index }); }
      if (now.b && !prev.b) { cnt.b++; this.emit({ type: 'press', src: 'pad', idx: g.index, btn: 'b' }); this.emit({ type: 'nav', act: 'back', src: 'pad', pad: g.index }); }
      if (now.start && !prev.start) this.emit({ type: 'pause' });
      const dir = now.up || now.ay < -0.6 ? 'up' : now.down || now.ay > 0.6 ? 'down' : now.left || now.ax < -0.6 ? 'left' : now.right || now.ax > 0.6 ? 'right' : null;
      if (dir && dir !== prev.dir) {
        this.emit({ type: 'dir', src: 'pad', idx: g.index, dir });
        this.emit({ type: 'nav', act: dir, src: 'pad', pad: g.index });
      }
      now.dir = dir;
      this.padPress.set(g.index, cnt);
      this.padPrev.set(g.index, now);
    }
    return pads;
  }

  // Read one player's sources. who = {kb:[setIdx...], pads:[gamepad.index...]|'all', touch:slot|null}
  read(who, pads) {
    let x = 0, y = 0, a = false, b = false, pa = 0, pb = 0;
    for (const k of who.kb || []) {
      const s = this.keys[k], has = (l) => l.some((c) => this.down.has(c));
      x += (has(s.right) ? 1 : 0) - (has(s.left) ? 1 : 0);
      y += (has(s.down) ? 1 : 0) - (has(s.up) ? 1 : 0);
      a = a || has(s.a); b = b || has(s.b);
      pa += this.kbPress[k].a; pb += this.kbPress[k].b;
    }
    const all = who.pads === 'all';
    const want = all ? null : new Set(who.pads || []);
    for (const g of pads) {
      if (!all && !want.has(g.index)) continue;
      const dz = deadzone(g.axes[0] || 0, g.axes[1] || 0);
      const bt = (i) => !!g.buttons[i]?.pressed;
      x += dz.x + (bt(15) ? 1 : 0) - (bt(14) ? 1 : 0);
      y += dz.y + (bt(13) ? 1 : 0) - (bt(12) ? 1 : 0);
      a = a || this.padMap.a.some(bt); b = b || this.padMap.b.some(bt);
    }
    // Counters include disconnected pads so the sum never decreases.
    for (const [idx, c] of this.padPress) {
      if (all || want.has(idx)) { pa += c.a; pb += c.b; }
    }
    if (who.touch === 0 || who.touch === 1) {
      const t = this.touchState[who.touch];
      x += t.jx; y += t.jy;
      a = a || t.a; b = b || t.b;
      pa += this.touchPress[who.touch].a; pb += this.touchPress[who.touch].b;
    }
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    return { x, y, a, b, pa, pb };
  }

  hasTouchRecently() { return performance.now() - this.lastTouchAt < 30000; }
}

function cloneMap(m) {
  const o = {};
  for (const k of ACTIONS) o[k] = [...(m[k] || [])];
  return o;
}

function sanitizeMap(m, def) {
  const o = cloneMap(def);
  if (m && typeof m === 'object') {
    for (const k of ACTIONS) if (Array.isArray(m[k]) && m[k].length && m[k].every((c) => typeof c === 'string')) o[k] = m[k].slice(0, 3);
  }
  return o;
}

export function padKind(id) {
  const s = String(id || '').toLowerCase();
  if (s.includes('dualsense') || s.includes('054c') || s.includes('wireless controller')) return 'PS5';
  if (s.includes('xbox') || s.includes('xinput')) return 'Xbox';
  return 'Controller';
}

// Touch zones inside a control rect (local, upright frame of that player).
export function touchZones(w, h, cfg) {
  const zones = [];
  const hasDir = !!cfg.dir;
  const btns = [cfg.a ? 'a' : null, cfg.b ? 'b' : null].filter(Boolean);
  const bx = hasDir ? w * 0.48 : 0;
  const bw = w - bx;
  if (hasDir) zones.push({ kind: 'joy', x: 0, y: 0, w: w * 0.48, h });
  if (btns.length === 1) zones.push({ kind: btns[0], x: bx, y: 0, w: bw, h });
  if (btns.length === 2) {
    if (hasDir) {
      zones.push({ kind: 'b', x: bx, y: 0, w: bw * 0.44, h });
      zones.push({ kind: 'a', x: bx + bw * 0.44, y: 0, w: bw * 0.56, h });
    } else {
      zones.push({ kind: 'a', x: 0, y: 0, w: w / 2, h });
      zones.push({ kind: 'b', x: w / 2, y: 0, w: w / 2, h });
    }
  }
  return zones;
}

// Draw touch controls for every control rect of the layout. colorOf(control) -> {main, light, dark}.
export function drawTouch(ctx, L, cfgs, input, colorOf) {
  for (const c of L.controls) {
    const cfg = cfgs[c.t];
    if (!cfg) continue;
    const { w, h } = enterRect(ctx, c);
    const col = colorOf(c);
    if (!c.overlay) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      // Dark oak panel with planks, a gold trim and the team color band (medieval look).
      g.addColorStop(0, '#3a2414');
      g.addColorStop(1, '#24160c');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 2;
      for (let y = 22; y < h; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      ctx.fillStyle = col.main;
      ctx.fillRect(0, 0, w, 6);
      ctx.fillStyle = '#e8c35a';
      ctx.fillRect(0, 6, w, 2);
    }
    const st = input.touchState[c.t];
    for (const z of touchZones(w, h, cfg)) {
      const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
      if (z.kind === 'joy') {
        const r = Math.min(z.w, z.h) * 0.36;
        if (st.joy) {
          ctx.globalAlpha = 0.35;
          circle(ctx, st.joy.ox, st.joy.oy, JOY_R, null, col.light, 3);
          ctx.globalAlpha = 0.9;
          circle(ctx, st.joy.ox + st.jx * JOY_R, st.joy.oy + st.jy * JOY_R, 26, col.main, GOLD, 3);
          ctx.globalAlpha = 1;
        } else {
          ctx.globalAlpha = c.overlay ? 0.25 : 0.4;
          circle(ctx, cx, cy, r, null, col.light, 3);
          circle(ctx, cx, cy, 20, col.main, null);
          ctx.globalAlpha = 1;
        }
        const label = cfg.dir === 'h' ? '◀  ▶' : cfg.dir === 'v' ? '▲▼' : '';
        if (label) txt(ctx, label, cx, z.y + z.h - 16, 18, 'rgba(255,255,255,0.5)');
        if (cfg.dirLabel) txt(ctx, cfg.dirLabel, cx, z.y + 16, 15, 'rgba(255,255,255,0.55)');
        continue;
      }
      const pressed = st[z.kind];
      const r = Math.max(26, Math.min(z.w * 0.4, z.h * 0.36, 70));
      ctx.globalAlpha = c.overlay ? 0.45 : 1;
      circle(ctx, cx, cy + (pressed ? 3 : 0), r, pressed ? col.light : z.kind === 'a' ? col.main : col.dark, GOLD, pressed ? 6 : 4);
      ctx.globalAlpha = 1;
      txt(ctx, z.kind.toUpperCase(), cx, cy - r * 0.12 + (pressed ? 3 : 0), r * 0.62, '#fff');
      const label = cfg[z.kind];
      if (typeof label === 'string') txt(ctx, label, cx, cy + r * 0.45 + (pressed ? 3 : 0), Math.max(11, r * 0.24), '#fff');
    }
    ctx.restore();
  }
}

const GOLD = '#e8c35a';
function circle(ctx, x, y, r, fill, stroke, lw = 3) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}

function txt(ctx, s, x, y, size, color) {
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}
