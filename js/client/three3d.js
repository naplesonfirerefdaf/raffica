// 3D stage: a WebGL canvas UNDER the 2D canvas. Games with `render3d` are drawn here; HUD, menus and
// world effects (particles, floating texts, rings) stay on the 2D canvas, projected onto the 3D scene.
// The kit `K` (see makeKit) is the only API a game's render3d should use — documented in docs/ARCHITETTURA.md.
import * as THREE from '../../vendor/three.module.min.js';
import { makeDraw } from './draw.js';
import { PLAYER_COLORS, DEFAULT_CHARS } from '../core/proto.js';
import { cloneStatic, instanced, assetInfo, makeCharacter, charAssets, preload, assetsDone } from './models.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hasDoc = typeof document !== 'undefined';

function newCanvas(w, h) {
  if (!hasDoc) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function disposeTree(obj) {
  obj.traverse((o) => {
    const shared = o.userData.shared; // geometry/textures owned by the model cache (models.js)
    if (o.geometry && !shared) o.geometry.dispose();
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (shared && !o.userData.ownMat) continue;
      if (m.map && !shared) m.map.dispose();
      m.dispose();
    }
  });
}
const markShared = (root, ownMat = false) => root.traverse((o) => { o.userData.shared = true; if (ownMat) o.userData.ownMat = true; });

// Small deterministic RNG for procedural textures/scatter (same look on every device).
function prng(seed) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------- kit
// cam: 'top' → world (x, y) lies on the ground plane XZ, h = height (up = +Y).
//      'side' → world (x, y) is the vertical plane XY (Y = -y), h = depth toward the camera (+Z).
// roster: one entry per seat (game player index): { char: 'knight', color: slotIndex }.
export function makeKit({ world, cam = 'top', quality = 1, scene = new THREE.Scene(), mockDraw = null, roster = null } = {}) {
  const side = cam === 'side';
  const root = new THREE.Group();
  scene.add(root);
  const mats = new Map();
  const geos = new Map();
  const layers = [];
  const texCache = new Map();

  roster = roster && roster.length ? roster : [0, 1].map((k) => ({ char: DEFAULT_CHARS[k], color: k }));
  const K = {
    THREE, scene, root, world, cam, side, quality, layers, mockDraw, roster,
    n: roster.length,
    t: 0, dt: 0,
    ticks: [], // internal per-frame animations (characters, particles, water, flickering lights)
    shadows: quality > 0,
    col: (p, shade = 'main') => {
      const C = PLAYER_COLORS[roster[p]?.color ?? p] || PLAYER_COLORS[0];
      return C[shade] || C.main;
    },
    clamp,
    lerp: (a, b, k) => a + (b - a) * k,
  };

  addLights(K);
  K.bg = (c) => { scene.background = c === null ? null : new THREE.Color(c); };
  K.fog = (c, near, far) => { scene.fog = c === null ? null : new THREE.Fog(c, near, far); };

  // --- coordinates ---
  K.p = (x, y, h = 0, out = new THREE.Vector3()) => (side ? out.set(x, -y, h) : out.set(x, h, y));
  K.dir = (dx, dy, out = new THREE.Vector3()) => (side ? out.set(dx, -dy, 0) : out.set(dx, 0, dy));
  K.place = (obj, x, y, h = 0) => { K.p(x, y, h, obj.position); return obj; };
  // Turn an object so its local +X points along the world angle a (atan2(dy, dx)).
  K.face = (obj, a) => { if (side) obj.rotation.z = -a; else obj.rotation.y = -a; return obj; };
  // Rotate geometry built along +Y (three's default for cylinders/cones) to the kit's "height" axis.
  const upAxis = (geo) => { if (side) geo.rotateX(Math.PI / 2); return geo; };

  // --- materials (cached by key; pass {unique:true} for one you will animate) ---
  K.mat = (color = '#ffffff', o = {}) => {
    const key = o.unique || o.map ? null : `s|${color}|${o.rough ?? 0.55}|${o.metal ?? 0}|${o.emissive || ''}|${o.ei ?? 1}|${o.opacity ?? 1}|${o.flat ? 1 : 0}|${o.side || 0}`;
    if (key && mats.has(key)) return mats.get(key);
    const m = new THREE.MeshStandardMaterial({
      color, roughness: o.rough ?? 0.55, metalness: o.metal ?? 0, flatShading: !!o.flat,
      emissive: o.emissive || '#000000', emissiveIntensity: o.ei ?? 1,
      transparent: (o.opacity ?? 1) < 1 || !!o.transparent, opacity: o.opacity ?? 1,
      side: o.side === 2 ? THREE.DoubleSide : o.side === 1 ? THREE.BackSide : THREE.FrontSide,
      map: o.map || null, // e.g. K.canvasTex(…) for stripes/patterns
    });
    if (key) mats.set(key, m);
    return m;
  };
  // Unlit material: neon, glows, UI-like markers.
  K.glow = (color = '#ffffff', o = {}) => {
    const key = o.unique ? null : `g|${color}|${o.opacity ?? 1}|${o.add ? 1 : 0}`;
    if (key && mats.has(key)) return mats.get(key);
    const m = new THREE.MeshBasicMaterial({
      color, transparent: (o.opacity ?? 1) < 1 || !!o.add, opacity: o.opacity ?? 1, depthWrite: !o.add,
      blending: o.add ? THREE.AdditiveBlending : THREE.NormalBlending, side: THREE.DoubleSide,
    });
    if (key) mats.set(key, m);
    return m;
  };
  const geo = (key, make) => { let g = geos.get(key); if (!g) { g = make(); geos.set(key, g); } return g; };
  const mesh = (g, m, o = {}) => {
    const me = new THREE.Mesh(g, typeof m === 'string' ? K.mat(m) : m);
    me.castShadow = o.cast ?? true;
    me.receiveShadow = o.receive ?? true;
    if (o.parent !== null) (o.parent || root).add(me);
    return me;
  };
  K.mesh = mesh;

  // --- primitives (sizes in world units; "h" = height for top games, depth for side games) ---
  // Every primitive is added to `o.parent` (default: the root; pass parent:null to keep it detached).
  K.group = (parent = root) => { const g = new THREE.Group(); if (parent) parent.add(g); return g; };
  K.box = (wx, wy, h, m, o = {}) => {
    const g = geo(`box|${wx}|${wy}|${h}|${side}`, () => (side ? new THREE.BoxGeometry(wx, wy, h) : new THREE.BoxGeometry(wx, h, wy)));
    return mesh(g, m, o);
  };
  K.ball = (r, m, o = {}) => mesh(geo(`ball|${r}|${o.seg || 0}`, () => new THREE.SphereGeometry(r, o.seg || 24, Math.round((o.seg || 24) * 0.75))), m, o);
  // Cylinder standing on the ground (top) / sticking out of the back plane (side); base at h=0 unless o.center.
  K.cyl = (r, h, m, o = {}) => mesh(geo(`cyl|${r}|${o.r2 ?? r}|${h}|${o.seg || 32}|${o.center ? 1 : 0}|${side}|${o.open ? 1 : 0}`, () => {
    const g = new THREE.CylinderGeometry(r, o.r2 ?? r, h, o.seg || 32, 1, !!o.open);
    if (!o.center) g.translate(0, h / 2, 0);
    return upAxis(g);
  }), m, o);
  K.cone = (r, h, m, o = {}) => mesh(geo(`cone|${r}|${h}|${o.seg || 24}|${side}`, () => { const g = new THREE.ConeGeometry(r, h, o.seg || 24); g.translate(0, h / 2, 0); return upAxis(g); }), m, o);
  // Flat ring / disc lying on the ground (or on the back plane for side games).
  K.disc = (r, m, o = {}) => mesh(geo(`disc|${r}|${o.r0 || 0}|${o.seg || 48}|${o.a0 ?? 0}|${o.a1 ?? TAU}|${side}`, () => {
    // Angles follow the 2D world (x right, y down): three's CCW angle θ shows up as world angle -θ.
    const a0 = o.a0 ?? 0, a1 = o.a1 ?? TAU;
    const g = o.r0 ? new THREE.RingGeometry(o.r0, r, o.seg || 48, 1, -a1, a1 - a0) : new THREE.CircleGeometry(r, o.seg || 48, -a1, a1 - a0);
    if (!side) g.rotateX(-Math.PI / 2); // lie flat on the ground
    return g;
  }), m, { cast: false, ...o });
  K.torus = (r, tube, m, o = {}) => mesh(geo(`torus|${r}|${tube}|${o.arc ?? TAU}|${side}`, () => {
    const g = new THREE.TorusGeometry(r, tube, 12, 48, o.arc ?? TAU);
    g.rotateZ(-(o.a0 ?? 0) - (o.arc ?? TAU)); // arc covers world angles a0 … a0+arc
    if (!side) g.rotateX(-Math.PI / 2);
    return g;
  }), m, o);
  // Extruded 2D shape: pts = [x0,y0,x1,y1,…] in world coords relative to (0,0); depth along the height axis.
  K.prism = (pts, h, m, o = {}) => {
    const sh = new THREE.Shape();
    sh.moveTo(pts[0], side ? -pts[1] : pts[1]);
    for (let k = 2; k < pts.length; k += 2) sh.lineTo(pts[k], side ? -pts[k + 1] : pts[k + 1]);
    const g = new THREE.ExtrudeGeometry(sh, { depth: h, bevelEnabled: !!o.bevel, bevelSize: o.bevel || 0, bevelThickness: o.bevel || 0, bevelSegments: 2 });
    if (!side) g.rotateX(Math.PI / 2), g.translate(0, h, 0); // shape on XZ, extruded upward
    const me = mesh(g, m, o);
    me.userData.ownGeo = true;
    return me;
  };
  // Cartoon outline: an inverted hull behind a mesh (works on spheres / rounded shapes).
  K.outline = (me, color = '#1a0b2e', w = 0.06) => {
    const o = new THREE.Mesh(me.geometry, new THREE.MeshBasicMaterial({ color, side: THREE.BackSide }));
    o.scale.setScalar(1 + w);
    o.castShadow = false;
    me.add(o);
    return o;
  };

  // --- textures drawn with the 2D helper API ---
  K.canvasTex = (w, h, draw) => {
    const c = newCanvas(w, h);
    if (!c) return null;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    if (draw) { const d = makeDraw(c.getContext('2d')); d.quality = quality; draw(d, c.getContext('2d'), w, h); tex.needsUpdate = true; }
    return tex;
  };
  // Billboard sprite of an emoji (always faces the camera). size in world units.
  K.emoji = (ch, size = 60, o = {}) => {
    let tex = texCache.get('e|' + ch);
    if (!tex && hasDoc) {
      tex = K.canvasTex(128, 128, (d, ctx) => {
        ctx.font = "100px system-ui, 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif";
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(ch, 64, 72);
      });
      texCache.set('e|' + ch, tex);
    }
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex || null, transparent: true, depthWrite: false, depthTest: o.depthTest ?? true }));
    sp.scale.set(size, size, 1);
    sp.center.set(0.5, o.base ? 0.12 : 0.5);
    if (o.parent !== null) (o.parent || root).add(sp);
    return sp;
  };
  // Billboard drawn with the 2D API: draw(d, w, h) in a w×h canvas (pixels). Call sp.redraw() to repaint.
  K.billboard = (wPx, hPx, size, draw, o = {}) => {
    const tex = K.canvasTex(wPx, hPx, null);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: o.depthTest ?? true }));
    sp.scale.set(size, (size * hPx) / wPx, 1);
    let lastDraw = -1e9;
    sp.redraw = (...args) => {
      if (!tex) { if (K.mockDraw) draw(K.mockDraw, wPx, hPx, ...args); return; }
      // At most 30 repaints/s: each one re-uploads the texture to the GPU.
      const now = performance.now();
      if (now - lastDraw < 33) return;
      lastDraw = now;
      const ctx = tex.image.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, wPx, hPx);
      const d = makeDraw(ctx); d.quality = quality; d.t = K.t;
      draw(d, wPx, hPx, ...args);
      tex.needsUpdate = true;
    };
    sp.redraw();
    if (o.parent !== null) (o.parent || root).add(sp);
    return sp;
  };
  // Soft round shadow on the ground (used when real shadows are off, or to show jump height).
  K.blob = (r, o = {}) => {
    let tex = texCache.get('blob');
    if (!tex && hasDoc) {
      tex = K.canvasTex(64, 64, (d, ctx) => {
        const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        g.addColorStop(0, 'rgba(0,0,0,0.6)'); g.addColorStop(0.6, 'rgba(0,0,0,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
      });
      texCache.set('blob', tex);
    }
    const m = new THREE.MeshBasicMaterial({ map: tex || null, color: tex ? '#ffffff' : '#000000', transparent: true, opacity: o.opacity ?? 0.8, depthWrite: false });
    const g = geo('blobplane', () => { const p = new THREE.PlaneGeometry(2, 2); if (!side) p.rotateX(-Math.PI / 2); return p; });
    const me = new THREE.Mesh(g, m);
    me.scale.set(r, side ? r : 1, side ? 1 : r);
    me.renderOrder = 1;
    me.always = !!o.always;
    me.visible = me.always || !K.shadows;
    (o.parent || root).add(me);
    return me;
  };

  // Flat painted layer (floor, back wall, markings, dynamic indicators) drawn with the 2D `d` API in WORLD coords.
  // o: { x0, y0, x1, y1 (world rect, default world + 300 margin), res (px per world unit, default auto), h (elevation),
  //      draw(d, v, r, K) (repaint), key(v, r) → string (repaint only when it changes; omit = every frame),
  //      once: true (paint only at build), lit: true (lit by the lights) , transparent, opacity }
  K.layer = (o = {}) => {
    const M = o.margin ?? 300;
    const x0 = o.x0 ?? -M, y0 = o.y0 ?? -M, x1 = o.x1 ?? world.w + M, y1 = o.y1 ?? world.h + M;
    const ww = x1 - x0, hh = y1 - y0;
    // Dynamic layers re-upload their whole canvas every time they repaint (16 MB at 2048²): keep them at 1024.
    const maxPx = Math.min(o.maxPx ?? 4096, o.once ? (quality > 0 ? 2048 : 1024) : (quality > 0 ? 1024 : 512));
    const res = Math.min(o.res ?? maxPx / Math.max(ww, hh), maxPx / Math.max(ww, hh));
    const cw = Math.max(2, Math.round(ww * res)), ch = Math.max(2, Math.round(hh * res));
    const c = newCanvas(cw, ch);
    const tex = c ? new THREE.CanvasTexture(c) : null;
    if (tex) { tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = quality > 0 ? 8 : 2; }
    const transparent = o.transparent ?? false;
    const matO = { map: tex, transparent, opacity: o.opacity ?? 1, depthWrite: !transparent };
    const m = o.lit === false ? new THREE.MeshBasicMaterial(matO) : new THREE.MeshLambertMaterial(matO);
    if (transparent) { m.polygonOffset = true; m.polygonOffsetFactor = -1 - (o.z || 0); m.polygonOffsetUnits = -4; }
    const g = new THREE.PlaneGeometry(ww, hh);
    if (!side) g.rotateX(-Math.PI / 2);
    const me = new THREE.Mesh(g, m);
    me.userData.ownGeo = true;
    me.receiveShadow = o.lit !== false;
    me.renderOrder = transparent ? 1 + (o.z || 0) : 0;
    K.place(me, x0 + ww / 2, y0 + hh / 2, o.h ?? 0);
    if (side) me.position.z = -(o.h ?? 0);
    (o.parent || root).add(me);
    const ctx = c ? c.getContext('2d') : null;
    const d = ctx ? makeDraw(ctx) : null;
    if (d) d.quality = quality;
    const L = {
      mesh: me, canvas: c, ctx, d, lastKey: undefined, painted: false, lastPaint: -1e9, o,
      paint(v, r) {
        if (!o.draw) return;
        if (!ctx) { if (K.mockDraw) o.draw(K.mockDraw, v, r, K); return; } // headless tests
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        ctx.setTransform(cw / ww, 0, 0, ch / hh, (-x0 * cw) / ww, (-y0 * ch) / hh);
        d.t = K.t; d.px = ww / cw; d.textRot = 0;
        ctx.save();
        try { o.draw(d, v, r, K); } finally { ctx.restore(); }
        tex.needsUpdate = true;
        L.painted = true;
        if (typeof window !== 'undefined' && window.__perf) window.__perf.add('upKpx', (cw * ch) / 1000);
      },
      update(v, r) {
        if (o.once) { if (!L.painted) L.paint(v, r); return; }
        // Every repaint re-uploads the whole canvas to the GPU: cap the rate (o.hz; default 12 for big layers,
        // 30 for small ones) or a key that changes every frame makes the game stutter.
        const now = typeof performance !== 'undefined' ? performance.now() : 0;
        if (L.painted && now - L.lastPaint < 1000 / (o.hz ?? (cw * ch > 300000 ? 12 : 30))) return;
        if (o.key) { const k = o.key(v, r); if (k === L.lastKey && L.painted) return; L.lastKey = k; }
        L.lastPaint = now;
        L.paint(v, r);
      },
    };
    layers.push(L);
    return L;
  };

  // Small movable painted patch on the ground (cooldown rings, arrows, markers under a player).
  // size = world units across; draw with dec.paint((d) => …) in LOCAL world units centered on (0,0); move with dec.at(x, y).
  K.decal = (size, o = {}) => {
    const px = o.px ?? (quality > 0 ? 256 : 128);
    const c = newCanvas(px, px);
    const tex = c ? new THREE.CanvasTexture(c) : null;
    if (tex) tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: o.opacity ?? 1 });
    m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -8;
    const g = new THREE.PlaneGeometry(size, size);
    if (!side) g.rotateX(-Math.PI / 2);
    const me = new THREE.Mesh(g, m);
    me.userData.ownGeo = true;
    me.renderOrder = 2;
    (o.parent || root).add(me);
    const ctx = c ? c.getContext('2d') : null;
    const d = ctx ? makeDraw(ctx) : null;
    const h0 = o.h ?? 0.8;
    return {
      mesh: me,
      lastPaint: -1e9,
      at(x, y, h = h0) { K.place(me, x, y, side ? 0 : h); if (side) me.position.z = h; return this; },
      paint(fn) {
        if (!ctx) { if (K.mockDraw) fn(K.mockDraw); return this; }
        // At most 30 repaints/s: each one re-uploads the texture to the GPU.
        const now = performance.now();
        if (now - this.lastPaint < 33) return this;
        this.lastPaint = now;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, px, px);
        const k = px / size;
        ctx.setTransform(k, 0, 0, k, px / 2, px / 2);
        d.t = K.t; d.px = 1 / k; d.quality = quality;
        fn(d);
        tex.needsUpdate = true;
        return this;
      },
      show(v) { me.visible = v; return this; },
    };
  };

  // --- 3D models (KayKit CC0 packs). Declare them in render3d.assets so they are loaded before build. ---
  // K.model('medieval/building_tavern_red', { size | height | s, parent, cast, ground }) → Group standing on h = 0.
  //   size = max horizontal extent in world units, height = total height, s = raw scale (model units → world).
  // Missing/unloaded model → brown placeholder box of the same footprint (never crashes).
  K.model = (name, o = {}) => {
    const g = new THREE.Group();
    if (o.parent !== null) (o.parent || root).add(g);
    const info = assetInfo(name) || { min: new THREE.Vector3(-0.5, 0, -0.5), size: new THREE.Vector3(1, 1, 1) };
    const s = o.size ? o.size / Math.max(info.size.x, info.size.z, 1e-6) : o.height ? o.height / Math.max(info.size.y, 1e-6) : (o.s ?? 1);
    let node = cloneStatic(name);
    if (node) markShared(node);
    else node = new THREE.Mesh(geo('phbox', () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)), K.mat('#8a6f4e'));
    if (!node.isMesh) node.scale.setScalar(s); else node.scale.set(info.size.x * s, info.size.y * s, info.size.z * s);
    if (o.ground !== false && !node.isMesh) node.position.y = -info.min.y * s;
    node.traverse((m) => { if (m.isMesh) { m.castShadow = o.cast ?? true; m.receiveShadow = true; } });
    g.add(node);
    g.userData.dims = { w: info.size.x * s, d: info.size.z * s, h: info.size.y * s, s };
    return g;
  };
  // Many copies of one model in very few draw calls (forests, rocks, barrels, crowds of props).
  // items: [{ x, y, h?, rot? (radians, world angle like K.face), s? (extra scale) }]; o like K.model (size/height/s).
  K.scatter = (name, items, o = {}) => {
    const info = assetInfo(name) || { min: new THREE.Vector3(-0.5, 0, -0.5), size: new THREE.Vector3(1, 1, 1) };
    const base = o.size ? o.size / Math.max(info.size.x, info.size.z, 1e-6) : o.height ? o.height / Math.max(info.size.y, 1e-6) : (o.s ?? 1);
    const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const mats4 = items.map((it) => {
      const k = base * (it.s ?? 1);
      K.p(it.x, it.y, it.h ?? 0, p);
      p.y += (o.ground !== false ? -info.min.y * k : 0);
      q.setFromAxisAngle(up, -(it.rot ?? 0));
      return new THREE.Matrix4().compose(p, q, sc.set(k, k, k));
    });
    let g = instanced(name, mats4);
    if (g) markShared(g);
    else {
      // Placeholder: plain boxes (tests / missing asset).
      g = new THREE.Group();
      for (const m of mats4) { const b = new THREE.Mesh(geo('phbox', () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)), K.mat('#6f8a4e')); b.applyMatrix4(m); b.scale.multiply(info.size); g.add(b); }
    }
    g.traverse((m) => { if (m.isMesh) { m.castShadow = o.cast ?? true; m.receiveShadow = true; } });
    (o.parent || root).add(g);
    return g;
  };

  // --- procedural medieval textures (repeating). kind: erba, prato, pietra, lastre, legno, terra, sabbia, muro,
  //     tetto, paglia, acqua, lava, neve, tappeto, ghiaccio. o.rep = [rx, ry] repeats; o.seed varies the pattern.
  K.tex = (kind, o = {}) => {
    const rep = o.rep || [1, 1];
    const key = `tex|${kind}|${rep[0]}|${rep[1]}|${o.seed || 0}`;
    if (texCache.has(key)) return texCache.get(key);
    const S = quality > 0 ? 512 : 256;
    const tex = K.canvasTex(S, S, (d, ctx) => paintTexture(ctx, S, kind, prng(1234 + (o.seed || 0) * 97 + kind.length * 13)));
    if (tex) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(rep[0], rep[1]); tex.anisotropy = quality > 0 ? 8 : 2; }
    texCache.set(key, tex);
    return tex;
  };
  // Big textured floor under (and well beyond) the world. o: { margin (1500), tile (world units per texture tile, 160),
  // color (tint), h, rough }. Returns the mesh.
  K.ground = (kind, o = {}) => {
    const M = o.margin ?? 1500;
    const ww = world.w + 2 * M, hh = world.h + 2 * M;
    const tile = o.tile ?? 160;
    const tex = K.tex(kind, { rep: [ww / tile, hh / tile], seed: o.seed });
    const m = new THREE.MeshStandardMaterial({ map: tex, color: o.color || '#ffffff', roughness: o.rough ?? 0.92, metalness: 0 });
    const g = new THREE.PlaneGeometry(ww, hh);
    if (!side) g.rotateX(-Math.PI / 2);
    const me = new THREE.Mesh(g, m);
    me.userData.ownGeo = true;
    me.receiveShadow = true;
    K.place(me, world.w / 2, world.h / 2, o.h ?? -0.5);
    if (side) me.position.z = -(o.h ?? 0);
    root.add(me);
    return me;
  };
  // Textured material shortcut: K.texMat('pietra', [4, 1], { color, rough }).
  K.texMat = (kind, rep = [1, 1], o = {}) => new THREE.MeshStandardMaterial({ map: K.tex(kind, { rep, seed: o.seed }), color: o.color || '#ffffff', roughness: o.rough ?? 0.85, metalness: o.metal ?? 0 });

  // --- atmosphere: sky dome + fog + light colors. name: giorno | tramonto | notte | grotta | nebbia | alba | tempesta
  K.theme = (name = 'giorno', o = {}) => {
    const T = THEMES[name] || THEMES.giorno;
    const span = Math.max(world.w, world.h);
    scene.background = new THREE.Color(T.horizon);
    K.hemi.color.set(T.hemiSky); K.hemi.groundColor.set(T.hemiGround); K.hemi.intensity = T.hemi;
    K.sun.color.set(T.sun); K.sun.intensity = T.sunI;
    K.rim.color.set(T.rim); K.rim.intensity = T.rimI;
    if (T.sunPos) {
      const [a, el] = T.sunPos; // azimuth (world angle), elevation
      const c = K.p(world.w / 2, world.h / 2, 0);
      const d = span * 1.5;
      if (side) K.sun.position.set(c.x + Math.cos(a) * d * 0.6, c.y + Math.sin(el) * d, d * 0.9);
      else K.sun.position.set(c.x + Math.cos(a) * Math.cos(el) * d, Math.sin(el) * d, c.z + Math.sin(a) * Math.cos(el) * d);
    }
    if (o.fog !== false) scene.fog = new THREE.Fog(T.horizon, span * (o.fogNear ?? 1.8), span * (o.fogFar ?? 5));
    // Gradient sky dome (visible in side games and at the horizon of tilted cameras).
    if (hasDoc && o.sky !== false) {
      const tex = K.canvasTex(4, 256, (d, ctx) => {
        const gr = ctx.createLinearGradient(0, 0, 0, 256);
        gr.addColorStop(0, T.top); gr.addColorStop(0.55, T.mid || T.horizon); gr.addColorStop(1, T.horizon);
        ctx.fillStyle = gr; ctx.fillRect(0, 0, 4, 256);
        if (T.stars) { ctx.fillStyle = '#ffffff'; }
      });
      const dome = new THREE.Mesh(new THREE.SphereGeometry(span * 9, 32, 16), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false }));
      dome.userData.ownGeo = true;
      dome.position.copy(K.p(world.w / 2, world.h / 2, 0));
      dome.renderOrder = -10;
      root.add(dome);
      if (T.stars) {
        const r = prng(7), N = 500, pos = new Float32Array(N * 3);
        for (let k = 0; k < N; k++) {
          const u = r() * TAU, v = 0.08 + r() * 0.9;
          pos[k * 3] = Math.cos(u) * Math.cos(v) * span * 8; pos[k * 3 + 1] = Math.sin(v) * span * 8; pos[k * 3 + 2] = Math.sin(u) * Math.cos(v) * span * 8;
        }
        const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 2, sizeAttenuation: false, fog: false }));
        stars.position.copy(dome.position);
        root.add(stars);
      }
    }
    return T;
  };

  // --- ambient particles: foglie | lucciole | neve | braci | polvere | petali | pioggia.
  // o: { n, x0, y0, x1, y1 (area, default world + 200), h (max height/depth range), size }
  K.ambient = (kind, o = {}) => {
    const A = AMBIENT[kind] || AMBIENT.polvere;
    const n = Math.round((o.n ?? A.n) * (quality > 0 ? 1 : 0.5));
    const x0 = o.x0 ?? -200, y0 = o.y0 ?? -200, x1 = o.x1 ?? world.w + 200, y1 = o.y1 ?? world.h + 200;
    const H = o.h ?? A.h;
    const r = prng(kind.length * 31 + n);
    const pos = new Float32Array(n * 3), seed = new Float32Array(n);
    // Top games: X/Z horizontal, Y = height 0..H. Side games: Y = -world y (screen up), Z = a slab of depth around the play plane.
    const top = side ? -y0 : H, bottom = side ? -y1 : 0;
    const reset = (k, edge) => {
      const i = k * 3;
      pos[i] = x0 + r() * (x1 - x0);
      const v = edge ? (A.rise ? bottom : top) : bottom + r() * (top - bottom);
      if (side) { pos[i + 1] = v; pos[i + 2] = -150 + r() * 400; } else { pos[i + 1] = v; pos[i + 2] = y0 + r() * (y1 - y0); }
    };
    for (let k = 0; k < n; k++) { reset(k, false); seed[k] = r() * 100; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color: A.color, size: o.size ?? A.size, map: K.dotTex(), transparent: true, depthWrite: false,
      blending: A.add ? THREE.AdditiveBlending : THREE.NormalBlending, opacity: A.opacity ?? 0.9 });
    const pts = new THREE.Points(g, m);
    pts.userData.ownGeo = true;
    pts.frustumCulled = false;
    root.add(pts);
    K.ticks.push((dt, t) => {
      if (!dt) return;
      for (let k = 0; k < n; k++) {
        const i = k * 3, sd = seed[k];
        pos[i] += (Math.sin(t * 0.7 + sd) * A.sway + A.wind) * dt;
        const vy = A.rise ? A.speed : -A.speed;
        pos[i + 1] += vy * dt * (0.6 + (sd % 1) * 0.8);
        if (A.drift) pos[i + 2] += Math.cos(t * 0.9 + sd) * A.sway * dt;
        if (!A.rise && pos[i + 1] < bottom) reset(k, true);
        if (A.rise && pos[i + 1] > top) reset(k, true);
        if (A.wander) { pos[i + 1] += Math.sin(t * 1.3 + sd * 2) * A.wander * dt; }
      }
      g.attributes.position.needsUpdate = true;
      if (A.twinkle) m.opacity = (A.opacity ?? 0.9) * (0.75 + 0.25 * Math.sin(t * 3));
    });
    return pts;
  };
  K.dotTex = () => {
    let tex = texCache.get('dot');
    if (!tex && hasDoc) {
      tex = K.canvasTex(64, 64, (d, ctx) => {
        const gr = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gr; ctx.fillRect(0, 0, 64, 64);
      });
      texCache.set('dot', tex);
    }
    return tex || null;
  };

  // --- point light (torches, braziers, magic). No shadows. o: { flicker (0..1), dist } ---
  K.light = (x, y, h, color = '#ffb35c', intensity = 2, o = {}) => {
    const L = new THREE.PointLight(color, intensity, o.dist ?? 450, 0);
    K.place(L, x, y, h);
    root.add(L);
    if (o.flicker) {
      const ph = x * 0.013 + y * 0.007;
      K.ticks.push((dt, t) => { L.intensity = intensity * (1 - o.flicker * 0.5 + o.flicker * 0.5 * (Math.sin(t * 13 + ph) * 0.5 + Math.sin(t * 7.3 + ph * 2) * 0.5)); });
    }
    return L;
  };
  // Animated water/lava surface over a world rect. o: { kind: 'acqua'|'lava', h, tile, opacity, flow: [vx, vy] }
  K.water = (x0, y0, x1, y1, o = {}) => {
    const kind = o.kind || 'acqua';
    const tile = o.tile ?? 220;
    const base = K.tex(kind, { rep: [(x1 - x0) / tile, (y1 - y0) / tile], seed: 3 });
    const tex = base ? base.clone() : null; // null in Node tests (no canvas)
    if (tex) { tex.needsUpdate = true; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set((x1 - x0) / tile, (y1 - y0) / tile); }
    const lava = kind === 'lava';
    const m = new THREE.MeshStandardMaterial({ map: tex, color: '#ffffff', roughness: lava ? 0.6 : 0.15, metalness: lava ? 0 : 0.1,
      transparent: !lava, opacity: o.opacity ?? (lava ? 1 : 0.88), emissive: lava ? '#ff5a10' : '#0a3a5a', emissiveIntensity: lava ? 0.9 : 0.25, emissiveMap: lava ? tex : null });
    const g = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
    if (!side) g.rotateX(-Math.PI / 2);
    const me = new THREE.Mesh(g, m);
    me.userData.ownGeo = true;
    me.receiveShadow = true;
    K.place(me, (x0 + x1) / 2, (y0 + y1) / 2, o.h ?? 2);
    root.add(me);
    const flow = o.flow || [0.012, 0.02];
    K.ticks.push((dt, t) => { if (tex) { tex.offset.x = (t * flow[0]) % 1; tex.offset.y = (t * flow[1]) % 1; } });
    return me;
  };

  // --- the player character: animated KayKit model of the chosen character in the seat's team color ---
  // Falls back to the old blob avatar while the model is not loaded (or in Node tests).
  K.avatar = (p, o = {}) => makeHero(K, p, o) || makeAvatar(K, p, o);
  K.blobAvatar = (p, o = {}) => makeAvatar(K, p, o);
  // Extra animated character that is NOT a player (crowd, painter, farmer, king…): same set() API as K.avatar.
  // char = one of the 9 character ids; color = team color index for its ring/gem (o.marker false hides them).
  // Declare its model in render3d.assets with npcAssets(char) names, e.g. 'chars/Mage' (+ weapons for skeletons).
  K.npc = (char, o = {}) => {
    const idx = K.roster.length + (K._npc = (K._npc || 0) + 1);
    const saved = K.roster[idx];
    K.roster[idx] = { char, color: o.color ?? 0 };
    const av = makeHero(K, idx, o) || makeAvatar(K, idx, o);
    if (saved === undefined) delete K.roster[idx]; else K.roster[idx] = saved;
    return av;
  };

  K.dispose = () => {
    disposeTree(root);
    for (const m of mats.values()) m.dispose();
    for (const g of geos.values()) g.dispose();
    for (const t of texCache.values()) t?.dispose();
    for (const L of layers) L.mesh.material.map?.dispose();
  };
  return K;
}

// ---------------------------------------------------------------- avatar
function makeAvatar(K, p, opt) {
  const { THREE } = K;
  const C = PLAYER_COLORS[K.roster[p]?.color ?? p] || PLAYER_COLORS[0];
  const OUT = C.dark, BL = C.light;
  const g = new THREE.Group();
  (opt.parent || K.root).add(g);
  const tilt = new THREE.Group();   // lean / squash pivot at the feet
  g.add(tilt);
  const own = [];                   // per-avatar materials (alpha fades)
  const M = (color, o = {}) => { const m = new THREE.MeshStandardMaterial({ color, roughness: o.rough ?? 0.4, metalness: 0, emissive: o.emissive || '#000', emissiveIntensity: o.ei ?? 1 }); own.push(m); return m; };
  const B = (color) => { const m = new THREE.MeshBasicMaterial({ color }); own.push(m); return m; };
  const add = (geo, mat, parent = tilt, cast = true) => { const me = new THREE.Mesh(geo, mat); me.castShadow = cast; me.receiveShadow = false; parent.add(me); return me; };

  const bodyMat = M(C.main, { rough: 0.32, emissive: C.main, ei: 0.12 });
  const body = add(new THREE.SphereGeometry(1, 32, 24), bodyMat);
  body.position.y = 1;
  const hull = add(body.geometry, (() => { const m = new THREE.MeshBasicMaterial({ color: OUT, side: THREE.BackSide }); own.push(m); return m; })(), body, false);
  hull.scale.setScalar(1.07);
  // Belly highlight.
  const belly = add(new THREE.SphereGeometry(0.62, 20, 14), M(C.light, { rough: 0.5 }), body, false);
  belly.position.set(0.5, -0.35, 0); belly.scale.set(0.5, 0.75, 0.95);

  // Face (local +X = forward). Eyes sit high so a camera from above still sees them.
  const face = new THREE.Group(); body.add(face);
  const white = M('#ffffff', { rough: 0.2 }), ink = B('#1a0b2e');
  const eyes = [], pupils = [], lids = [];
  for (const s of [-1, 1]) {
    const e = add(new THREE.SphereGeometry(0.27, 18, 14), white, face, false);
    e.position.set(0.8, 0.38, s * 0.34); e.scale.set(0.55, 1.1, 0.9);
    const pu = add(new THREE.SphereGeometry(0.15, 14, 10), ink, e, false);
    pu.position.set(0.22, 0.02, 0);
    const shine = add(new THREE.SphereGeometry(0.05, 8, 6), B('#ffffff'), pu, false);
    shine.position.set(0.12, 0.07, s * 0.04);
    const lid = add(new THREE.BoxGeometry(0.12, 0.08, 0.42), ink, face, false); // angry brow
    lid.position.set(0.86, 0.72, s * 0.32); lid.rotation.x = s * 0.45;
    eyes.push(e); pupils.push(pu); lids.push(lid);
  }
  const cheekMat = M(BL, { rough: 0.7 });
  for (const s of [-1, 1]) { const ch = add(new THREE.SphereGeometry(0.13, 10, 8), cheekMat, face, false); ch.position.set(0.86, 0.02, s * 0.55); ch.scale.set(0.3, 0.6, 1); }
  const smile = add(new THREE.TorusGeometry(0.2, 0.045, 8, 20, Math.PI), ink, face, false);
  smile.position.set(0.96, 0.05, 0); smile.rotation.set(0, Math.PI / 2, Math.PI);
  const oMouth = add(new THREE.SphereGeometry(0.12, 12, 10), ink, face, false);
  oMouth.position.set(0.95, -0.05, 0); oMouth.scale.set(0.4, 1.2, 0.9);

  // Accessories.
  const deco = [];
  if (p % 2 === 0) {
    const hornMat = M('#ffd0e2', { rough: 0.35 });
    for (const s of [-1, 1]) {
      const h = add(new THREE.ConeGeometry(0.26, 0.85, 16), hornMat, body);
      h.position.set(-0.05, 0.95, s * 0.45); h.rotation.set(s * -0.6, 0, 0.12);
      const tip = add(new THREE.ConeGeometry(0.11, 0.3, 12), M('#ffffff', { rough: 0.3 }), h, false);
      tip.position.y = 0.3;
      deco.push(h);
    }
  } else {
    const stem = add(new THREE.CylinderGeometry(0.05, 0.07, 0.75, 8), M(C.dark), body);
    stem.position.set(-0.05, 1.3, 0);
    const bulbMat = M(C.light, { emissive: C.light, ei: 0.9 });
    const bulb = add(new THREE.SphereGeometry(0.24, 16, 12), bulbMat, stem, false);
    bulb.position.y = 0.45;
    deco.push(stem, bulb);
  }
  // Stubby feet.
  const feet = [];
  const footMat = M(C.dark, { rough: 0.6 });
  for (const s of [-1, 1]) { const f = add(new THREE.SphereGeometry(0.3, 12, 8), footMat); f.position.set(0.32, 0.12, s * 0.42); f.scale.set(1.3, 0.55, 0.9); feet.push(f); }

  for (const m of own) m.transparent = true; // fades never rebuild shaders
  const blob = K.blob(1);
  blob.userData.off = !!opt.parent || opt.blob === false; // inside a vehicle/group: the ground shadow is the parent's job
  let curAlpha = 1, curMood = '';
  const st = { phase: p * 1.7 };

  const A = {
    group: g, body, blob, bodyMat,
    // o: { r, h (height above ground), look (world angle), mood, squash, alpha, lean, visible, spin, walk (0..1) }
    set(x, y, o = {}) {
      const r = o.r ?? 40;
      const sq = clamp(o.squash || 0, -0.45, 0.45);
      const vis = o.visible !== false && (o.alpha ?? 1) > 0.01 && r > 0.5;
      g.visible = vis;
      blob.visible = vis && !blob.userData.off && (blob.always || !K.shadows || (o.h ?? 0) > 2);
      if (!vis) return A;
      const t = K.t + st.phase;
      const mood = o.mood || 'ok';
      const h = o.h ?? 0;
      // Top: (x, y) = point on the ground under the body. Side: (x, y) = body center, like d.avatar.
      if (K.side) { K.place(g, x, y + r * (1 - sq * 0.5)); g.position.z = h; } else K.place(g, x, y, h);
      g.scale.setScalar(r);
      // Facing: top games turn toward `look`; side games face the camera, turned toward left/right.
      const look = o.look ?? (K.side ? 0 : defaultLook(p));
      if (K.side) { g.rotation.set(0, -Math.PI / 2 + Math.cos(look) * 0.9, 0); }
      else g.rotation.set(0, -look, 0);
      if (o.spin) g.rotation.y += o.spin;
      const br = mood === 'dead' ? 0 : Math.sin(t * 2.6) * 0.03;
      tilt.scale.set(1 + sq, (1 - sq) * (1 + br), 1 + sq);
      tilt.rotation.set(0, 0, -(o.lean || 0));
      // Walk bob of the feet.
      const wk = o.walk || 0;
      feet[0].position.y = 0.12 + Math.max(0, Math.sin(t * 14)) * 0.18 * wk;
      feet[1].position.y = 0.12 + Math.max(0, -Math.sin(t * 14)) * 0.18 * wk;
      // Shadow.
      if (blob.visible) {
        K.place(blob, x, y, K.side ? 0 : 0.6);
        const k = 1 / (1 + h / (r * 4));
        const s = r * 1.05 * k;
        if (K.side) { blob.position.y = -(y + r); blob.scale.set(s, s * 0.3, 1); blob.position.z = h - r; }
        else blob.scale.set(s, 1, s);
        blob.material.opacity = 0.75 * k;
      }
      // Face by mood.
      if (mood !== curMood) {
        curMood = mood;
        const shut = mood === 'hurt' || mood === 'dead';
        for (const e of eyes) e.scale.set(0.55, mood === 'happy' ? 0.55 : shut ? 0.18 : 1.1, 0.9);
        for (const pu of pupils) pu.visible = !shut;
        for (const l of lids) l.visible = mood === 'angry';
        smile.visible = mood === 'ok' || mood === 'happy' || mood === 'angry';
        smile.scale.setScalar(mood === 'happy' ? 1.35 : mood === 'angry' ? 0.8 : 1);
        smile.rotation.z = mood === 'angry' ? 0 : Math.PI;
        oMouth.visible = !smile.visible;
        bodyMat.emissiveIntensity = mood === 'dead' ? 0 : 0.12;
        bodyMat.color.set(mood === 'dead' ? C.dark : C.main);
      }
      // Pupils: scared jitter, dizzy spin, blink.
      const blinkP = (t % (p ? 4.3 : 3.7));
      const blink = (mood === 'ok' || mood === 'angry') && blinkP < 0.12;
      for (let k = 0; k < 2; k++) {
        const pu = pupils[k];
        if (mood === 'dizzy') pu.position.set(0.22, Math.sin(t * 9 + k) * 0.08, Math.cos(t * 9 + k) * 0.08);
        else if (mood === 'scared') { pu.position.set(0.22, 0.02, Math.sin(t * 47) * 0.03); pu.scale.setScalar(0.65); }
        else { pu.position.set(0.22, 0.02, 0); pu.scale.setScalar(1); }
        if (blink) eyes[k].scale.y = 0.12; else if (mood === 'ok' || mood === 'angry') eyes[k].scale.y = 1.1;
      }
      if (p % 2 === 1 && deco[0]) deco[0].rotation.z = Math.sin(t * 3.1) * 0.25 + sq;
      // Fade.
      const al = clamp(o.alpha ?? 1, 0, 1);
      if (al !== curAlpha) {
        curAlpha = al;
        for (const m of own) { m.opacity = al; m.depthWrite = al >= 1; }
      }
      return A;
    },
  };
  return A;
}

// Locks every material of a scene in the transparent pipeline (see Stage3D.warm). Writes to .transparent are ignored
// afterwards, so fades/blinks only change opacity. Opaque-looking things keep depthWrite, so they still occlude correctly.
function lockMaterials(scene) {
  scene.traverse((o) => {
    const m = o.material;
    if (!m) return;
    for (const x of Array.isArray(m) ? m : [m]) {
      if (x.userData.__locked) continue;
      x.userData.__locked = true;
      if (!x.transparent) { x.transparent = true; x.needsUpdate = true; }
      x.forceSinglePass = true; // transparent + double sided would otherwise draw twice
      Object.defineProperty(x, 'transparent', { get: () => true, set: () => {}, configurable: true });
    }
  });
}

// Default facing of seat p in top games: toward the center from its home side (bottom, top, left, right).
const defaultLook = (p) => [-Math.PI / 2, Math.PI / 2, 0, Math.PI][p] ?? -Math.PI / 2;

// ---------------------------------------------------------------- animated character (KayKit)
// set(x, y, o): same contract as the blob avatar + animation control:
//   o.anim  = clip name to play (see docs/BRIEF-MEDIEVALE.md); omitted → chosen from walk/mood/h
//   o.animKey = change it to restart a one-shot clip (e.g. a new attack), o.animSpeed = playback speed (1)
//   o.gear = false hides weapons/shields, o.marker = false hides the team ring/gem
function makeHero(K, p, opt) {
  const ro = K.roster[p] || { char: DEFAULT_CHARS[p] || 'knight', color: p };
  const ch = makeCharacter(ro.char);
  if (!ch) return null;
  const { THREE } = K;
  const C = PLAYER_COLORS[ro.color] || PLAYER_COLORS[0];
  markShared(ch.model, true);
  const g = new THREE.Group();
  (opt.parent || K.root).add(g);
  const pivot = new THREE.Group(); // squash / lean at the feet
  g.add(pivot);
  pivot.add(ch.model);
  const Hm = Math.max(0.5, ch.info.size.y);
  const gear = [];
  ch.model.traverse((o) => { if (o.isMesh && o.visible && !/(Body|Head|Arm|Leg|Cape|Cloak|Hat|Helmet|Eyes|Jaw|Skull|Hood)/.test(o.name)) gear.push(o); });
  // Team marker: glowing ring at the feet (top games) and a small floating gem above the head (always).
  const markMat = new THREE.MeshBasicMaterial({ color: C.main, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 1.05, 40).rotateX(-Math.PI / 2), markMat);
  ring.renderOrder = 2;
  ring.userData.ownGeo = true;
  if (!K.side) g.add(ring);
  const gemMat = new THREE.MeshStandardMaterial({ color: C.main, emissive: C.main, emissiveIntensity: 0.8, roughness: 0.3 });
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), gemMat);
  gem.scale.set(0.16, 0.24, 0.16);
  gem.castShadow = false;
  g.add(gem);
  for (const m of [...ch.mats, gemMat]) m.transparent = true; // fades never rebuild shaders
  const blob = K.blob(1);
  blob.userData.off = !!opt.parent || opt.blob === false;
  let cur = null, curName = '', curKey, lastT = null, curAlpha = 1, gearOn = true;
  const play = (name, key, speed) => {
    if (!ch.clips.has(name)) name = ch.clips.has('Idle') ? 'Idle' : [...ch.clips.keys()][0];
    if (name === curName && key === curKey) { if (cur) cur.timeScale = speed; return; }
    const act = ch.mixer.clipAction(ch.clips.get(name));
    const loop = ch.loops.test(name);
    act.reset();
    act.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    act.clampWhenFinished = !loop;
    act.timeScale = speed;
    act.enabled = true;
    if (cur && cur !== act) { act.crossFadeFrom(cur, 0.14, false); }
    act.play();
    cur = act; curName = name; curKey = key;
  };
  play('Idle', undefined, 1);
  const A = {
    group: g, blob, model: ch.model, mixer: ch.mixer, hero: true,
    play: (name, key, speed = 1) => play(name, key, speed),
    set(x, y, o = {}) {
      const r = o.r ?? 40;
      const sq = clamp(o.squash || 0, -0.45, 0.45);
      const vis = o.visible !== false && (o.alpha ?? 1) > 0.01 && r > 0.5;
      g.visible = vis;
      blob.visible = vis && !blob.userData.off && (blob.always || !K.shadows || (o.h ?? 0) > 2);
      if (!vis) { lastT = K.t; return A; }
      const h = o.h ?? 0;
      const mood = o.mood || 'ok';
      const hk = K.side ? 2.3 : 2.7;             // character height in units of r
      const scale = (r * hk) / Hm;
      if (K.side) { K.place(g, x, y + r * (1 - sq * 0.5)); g.position.z = h; } else K.place(g, x, y, h);
      ch.model.scale.setScalar(scale);
      ring.scale.setScalar(r * 0.95);
      ring.position.y = 0.8 - h; // stays on the ground while jumping
      ring.visible = o.marker !== false && !K.side && h < r * 3;
      gem.visible = o.marker !== false;
      gem.position.set(0, r * hk + r * 0.45 + Math.sin(K.t * 3 + p) * r * 0.06, 0);
      gem.rotation.y = K.t * 2;
      gem.scale.set(r * 0.16, r * 0.24, r * 0.16);
      const look = o.look ?? (K.side ? 0 : defaultLook(p));
      // KayKit models face +Z: rotation.y = π/2 - a turns them toward world angle a (top games).
      if (K.side) g.rotation.set(0, Math.cos(look) * 1.1, 0);
      else g.rotation.set(0, Math.PI / 2 - look, 0);
      if (o.spin) g.rotation.y += o.spin;
      pivot.scale.set(1 + sq, 1 - sq, 1 + sq);
      pivot.rotation.set(o.lean || 0, 0, mood === 'dizzy' ? Math.sin(K.t * 6) * 0.12 : 0);
      if ((o.gear !== false) !== gearOn) { gearOn = o.gear !== false; for (const m of gear) m.visible = gearOn; }
      // Animation: explicit, else from state.
      let name = o.anim;
      if (!name) {
        const walk = o.walk || 0;
        if (mood === 'dead') name = 'Death_A';
        else if (mood === 'hurt') name = 'Hit_A';
        else if (!K.side && h > r * 0.6) name = 'Jump_Idle';
        else if (walk > 0.55) name = 'Running_A';
        else if (walk > 0.12) name = 'Walking_A';
        else if (mood === 'happy') name = 'Cheer';
        else if (mood === 'scared') name = 'Blocking';
        else name = 'Idle';
      }
      const walk = o.walk || 0;
      const speed = o.animSpeed ?? (name === 'Running_A' ? 0.8 + walk * 0.5 : name === 'Walking_A' ? 0.7 + walk * 1.2 : 1);
      play(name, o.animKey, speed);
      const dt = lastT === null ? 0 : clamp(K.t - lastT, 0, 0.1);
      lastT = K.t;
      ch.mixer.update(dt);
      if (blob.visible) {
        K.place(blob, x, y, K.side ? 0 : 0.6);
        const k = 1 / (1 + h / (r * 4));
        const s2 = r * 0.9 * k;
        if (K.side) { blob.position.y = -(y + r); blob.scale.set(s2, s2 * 0.3, 1); blob.position.z = h - r; }
        else blob.scale.set(s2, 1, s2);
        blob.material.opacity = 0.75 * k;
      }
      const al = clamp(o.alpha ?? 1, 0, 1);
      if (al !== curAlpha) {
        curAlpha = al;
        for (const m of [...ch.mats, gemMat]) { m.opacity = al; m.depthWrite = al >= 1; }
        markMat.opacity = 0.9 * al;
      }
      return A;
    },
  };
  return A;
}

// ---------------------------------------------------------------- atmosphere presets
const THEMES = {
  giorno: { top: '#3d82d6', mid: '#86bdf0', horizon: '#d8ecff', hemiSky: '#e6f3ff', hemiGround: '#6b5a3a', hemi: 1.25, sun: '#fff1d6', sunI: 2.5, rim: '#ffd9a8', rimI: 0.4, sunPos: [-2.2, 0.95] },
  alba: { top: '#5a6fc0', mid: '#e9a3b8', horizon: '#ffd7a8', hemiSky: '#ffe2cc', hemiGround: '#5a4a5a', hemi: 1.15, sun: '#ffd0a0', sunI: 2.2, rim: '#a8c4ff', rimI: 0.5, sunPos: [-2.6, 0.6] },
  tramonto: { top: '#2e2a6b', mid: '#c8577a', horizon: '#ffa25e', hemiSky: '#ffd2b0', hemiGround: '#40304a', hemi: 1.05, sun: '#ffab66', sunI: 2.3, rim: '#8f7bff', rimI: 0.7, sunPos: [-0.4, 0.5] },
  notte: { top: '#03061a', mid: '#0d1a3f', horizon: '#1d2f5c', hemiSky: '#7f96d6', hemiGround: '#120e22', hemi: 0.75, sun: '#a9bfff', sunI: 1.0, rim: '#5a7dff', rimI: 0.6, sunPos: [-2.0, 0.9], stars: true },
  grotta: { top: '#0d0806', mid: '#1c120c', horizon: '#24170f', hemiSky: '#ffcf9a', hemiGround: '#140c08', hemi: 0.55, sun: '#ffcf9a', sunI: 1.0, rim: '#ff8a3d', rimI: 0.5, sunPos: [-2.0, 1.1] },
  nebbia: { top: '#7d8a96', mid: '#a9b4bd', horizon: '#c9d0d6', hemiSky: '#eef2f5', hemiGround: '#5a5f63', hemi: 1.3, sun: '#f2f2f0', sunI: 1.3, rim: '#ffffff', rimI: 0.3, sunPos: [-2.2, 1.0] },
  tempesta: { top: '#1d2230', mid: '#3a4256', horizon: '#5d667a', hemiSky: '#b8c2d8', hemiGround: '#2a2a30', hemi: 1.0, sun: '#cfd8ff', sunI: 1.2, rim: '#8fa8ff', rimI: 0.6, sunPos: [-2.0, 1.0] },
};
const AMBIENT = {
  foglie: { n: 70, h: 500, color: '#d98a2b', size: 14, speed: 40, sway: 60, wind: 25, drift: true, opacity: 0.95 },
  petali: { n: 80, h: 500, color: '#ffb7d0', size: 10, speed: 35, sway: 50, wind: 20, drift: true, opacity: 0.95 },
  lucciole: { n: 60, h: 160, color: '#fff27a', size: 12, speed: 0, sway: 25, wind: 0, drift: true, add: true, wander: 30, twinkle: true },
  neve: { n: 220, h: 700, color: '#ffffff', size: 9, speed: 70, sway: 30, wind: 10, drift: true },
  braci: { n: 90, h: 500, color: '#ff8a2a', size: 9, speed: 80, sway: 30, wind: 0, rise: true, add: true, twinkle: true },
  polvere: { n: 90, h: 300, color: '#fff5d8', size: 6, speed: 6, sway: 12, wind: 4, drift: true, opacity: 0.55 },
  pioggia: { n: 300, h: 800, color: '#a8c8ff', size: 5, speed: 900, sway: 0, wind: 60, opacity: 0.6 },
};

// Procedural textures (seamless: every element is also drawn shifted by ±S).
function paintTexture(ctx, S, kind, r) {
  const wrap = (fn) => { for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) { ctx.save(); ctx.translate(dx, dy); fn(); ctx.restore(); } };
  const noise = (base, amp, n, size) => {
    ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);
    for (let k = 0; k < n; k++) {
      const x = r() * S, y = r() * S, s = size * (0.4 + r());
      const l = (r() - 0.5) * amp;
      ctx.fillStyle = l > 0 ? `rgba(255,255,255,${l})` : `rgba(0,0,0,${-l})`;
      wrap(() => { ctx.beginPath(); ctx.arc(x, y, s, 0, TAU); ctx.fill(); });
    }
  };
  const stones = (rows, cols, base, mortar, jitter, round, vary) => {
    ctx.fillStyle = mortar; ctx.fillRect(0, 0, S, S);
    const cw = S / cols, rh = S / rows;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const off = (i % 2) * cw * 0.5;
        const x = j * cw + off + (r() - 0.5) * jitter * cw, y = i * rh + (r() - 0.5) * jitter * rh;
        const w = cw * (0.86 + r() * 0.08), h = rh * (0.84 + r() * 0.1);
        const c = new THREE.Color(base).offsetHSL((r() - 0.5) * 0.03, (r() - 0.5) * 0.1, (r() - 0.5) * vary);
        wrap(() => {
          ctx.fillStyle = '#' + c.getHexString();
          ctx.beginPath(); ctx.roundRect(x + (cw - w) / 2, y + (rh - h) / 2, w, h, Math.min(w, h) * round); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.10)';
          ctx.beginPath(); ctx.roundRect(x + (cw - w) / 2 + 3, y + (rh - h) / 2 + 2, w * 0.7, h * 0.3, Math.min(w, h) * round); ctx.fill();
          ctx.fillStyle = 'rgba(0,0,0,0.12)';
          ctx.beginPath(); ctx.roundRect(x + (cw - w) / 2 + w * 0.2, y + (rh - h) / 2 + h * 0.72, w * 0.75, h * 0.25, Math.min(w, h) * round); ctx.fill();
        });
      }
    }
  };
  switch (kind) {
    case 'prato':
    case 'erba': {
      noise(kind === 'prato' ? '#5f9e3a' : '#4f8f34', 0.12, 160, S * 0.05);
      for (let k = 0; k < S * 5; k++) {
        const x = r() * S, y = r() * S, len = S * (0.012 + r() * 0.02);
        const c = new THREE.Color(r() < 0.5 ? '#6fb043' : '#3d7a28').offsetHSL(0, 0, (r() - 0.5) * 0.12);
        ctx.strokeStyle = '#' + c.getHexString(); ctx.lineWidth = Math.max(1, S / 300);
        const a = -Math.PI / 2 + (r() - 0.5) * 0.9;
        wrap(() => { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); ctx.stroke(); });
      }
      if (kind === 'prato') for (let k = 0; k < 40; k++) {
        const x = r() * S, y = r() * S; ctx.fillStyle = ['#fff6a8', '#ffffff', '#ffb3d1', '#c7b3ff'][Math.floor(r() * 4)];
        wrap(() => { ctx.beginPath(); ctx.arc(x, y, S / 160, 0, TAU); ctx.fill(); });
      }
      break;
    }
    case 'pietra': stones(8, 8, '#8f8a82', '#4a443d', 0.25, 0.45, 0.14); break;
    case 'lastre': stones(4, 4, '#a39d92', '#5a534b', 0.08, 0.08, 0.1); break;
    case 'muro': stones(10, 5, '#9a8f80', '#463f37', 0.04, 0.1, 0.12); break;
    case 'legno': {
      ctx.fillStyle = '#5a3a20'; ctx.fillRect(0, 0, S, S);
      const n = 6, h = S / n;
      for (let i = 0; i < n; i++) {
        const c = new THREE.Color('#a8723f').offsetHSL((r() - 0.5) * 0.02, 0, (r() - 0.5) * 0.12);
        ctx.fillStyle = '#' + c.getHexString(); ctx.fillRect(0, i * h + 2, S, h - 4);
        for (let k = 0; k < 14; k++) {
          ctx.strokeStyle = `rgba(60,30,10,${0.15 + r() * 0.2})`; ctx.lineWidth = 1 + r() * 2;
          const y = i * h + 4 + r() * (h - 8);
          ctx.beginPath(); ctx.moveTo(0, y); for (let x = 0; x <= S; x += S / 8) ctx.lineTo(x, y + Math.sin(x * 0.03 + k) * 2); ctx.stroke();
        }
        const cut = r() * S; ctx.fillStyle = '#3a2412'; ctx.fillRect(cut, i * h + 2, 3, h - 4);
        ctx.fillStyle = '#2a1a0c'; for (const nx of [cut + 10, cut - 10]) { ctx.beginPath(); ctx.arc((nx + S) % S, i * h + h / 2, 3, 0, TAU); ctx.fill(); }
      }
      break;
    }
    case 'terra': noise('#8a6440', 0.14, 260, S * 0.03); for (let k = 0; k < 60; k++) { const x = r() * S, y = r() * S; ctx.fillStyle = `rgba(70,50,30,0.6)`; wrap(() => { ctx.beginPath(); ctx.ellipse(x, y, S / 90, S / 130, r() * 3, 0, TAU); ctx.fill(); }); } break;
    case 'sabbia': noise('#e3c98f', 0.08, 400, S * 0.015); break;
    case 'neve': noise('#eef4fb', 0.06, 200, S * 0.04); break;
    case 'ghiaccio': {
      noise('#bfe3f5', 0.08, 120, S * 0.06);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5;
      for (let k = 0; k < 18; k++) { const x = r() * S, y = r() * S; const a = r() * TAU; wrap(() => { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * S * 0.15, y + Math.sin(a) * S * 0.15); ctx.stroke(); }); }
      break;
    }
    case 'paglia': {
      ctx.fillStyle = '#c9a24a'; ctx.fillRect(0, 0, S, S);
      for (let k = 0; k < S * 3; k++) {
        const x = r() * S, y = r() * S, len = S * (0.04 + r() * 0.06), a = (r() - 0.5) * 0.6;
        ctx.strokeStyle = r() < 0.5 ? '#e8c768' : '#9c7a2e'; ctx.lineWidth = 1.5;
        wrap(() => { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); ctx.stroke(); });
      }
      break;
    }
    case 'tetto': {
      ctx.fillStyle = '#6e2a1c'; ctx.fillRect(0, 0, S, S);
      const rows = 8, cols = 8, w = S / cols, h = S / rows;
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
        const x = j * w + (i % 2) * w / 2, y = i * h;
        const c = new THREE.Color('#b5503a').offsetHSL(0, 0, (r() - 0.5) * 0.1);
        wrap(() => { ctx.fillStyle = '#' + c.getHexString(); ctx.beginPath(); ctx.ellipse(x + w / 2, y + h * 0.55, w * 0.48, h * 0.6, 0, 0, Math.PI); ctx.fill(); });
      }
      break;
    }
    case 'tappeto': {
      ctx.fillStyle = '#8c1c22'; ctx.fillRect(0, 0, S, S);
      ctx.strokeStyle = '#d9a43a'; ctx.lineWidth = S / 40; ctx.strokeRect(S * 0.06, S * 0.06, S * 0.88, S * 0.88);
      ctx.lineWidth = S / 120; ctx.strokeRect(S * 0.12, S * 0.12, S * 0.76, S * 0.76);
      ctx.fillStyle = '#d9a43a';
      for (let k = 0; k < 4; k++) { ctx.save(); ctx.translate(S / 2, S / 2); ctx.rotate(k * Math.PI / 2); ctx.beginPath(); ctx.moveTo(0, -S * 0.22); ctx.lineTo(S * 0.06, 0); ctx.lineTo(-S * 0.06, 0); ctx.fill(); ctx.restore(); }
      break;
    }
    case 'lava':
    case 'acqua': {
      const lava = kind === 'lava';
      ctx.fillStyle = lava ? '#b8320a' : '#2a7fb8'; ctx.fillRect(0, 0, S, S);
      for (let k = 0; k < 90; k++) {
        const x = r() * S, y = r() * S, rx = S * (0.03 + r() * 0.08), ry = rx * (0.3 + r() * 0.4);
        ctx.strokeStyle = lava ? `rgba(255,200,60,${0.3 + r() * 0.4})` : `rgba(200,240,255,${0.15 + r() * 0.3})`;
        ctx.lineWidth = S / 200 + r() * 2;
        wrap(() => { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, r() * 0.4, 0, Math.PI * (1 + r())); ctx.stroke(); });
      }
      if (lava) for (let k = 0; k < 30; k++) { const x = r() * S, y = r() * S; ctx.fillStyle = 'rgba(40,10,5,0.5)'; wrap(() => { ctx.beginPath(); ctx.ellipse(x, y, S * 0.06, S * 0.03, r() * 3, 0, TAU); ctx.fill(); }); }
      break;
    }
    default: noise('#888888', 0.1, 200, S * 0.03);
  }
}

// ---------------------------------------------------------------- stage
export class Stage3D {
  constructor(canvas, { low = false } = {}) {
    this.canvas = canvas;
    this.low = low;
    this.ok = false;
    this.key = null;
    this.stages = new Map(); // field (null|0|1) → { scene, K, o }
    this.cams = [];
    this.errors = new Set();
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !low, alpha: true, powerPreference: 'high-performance' });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.renderer.shadowMap.enabled = !low;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.setClearColor(0x000000, 0);
      // Shader error checks call getProgramInfoLog, which forces a synchronous wait for the driver's compile
      // (100–400 ms freezes the first time an effect appears). Only useful while developing.
      this.renderer.debug.checkShaderErrors = /[?&]shaderdebug/.test(typeof location !== 'undefined' ? location.search : '');
      this.ok = true;
    } catch (err) {
      console.warn('[3d] WebGL non disponibile, uso la grafica 2D', err);
    }
    this.W = 0; this.H = 0; this.dpr = 1;
  }

  resize(W, H, dpr) {
    if (!this.ok) return;
    const pr = Math.min(dpr, this.low ? 1.5 : 2);
    if (W === this.W && H === this.H && pr === this.dpr) return;
    this.W = W; this.H = H; this.dpr = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(W, H, true);
  }

  hide() {
    if (this.canvas.style.visibility !== 'hidden') { this.canvas.style.visibility = 'hidden'; this.renderer?.clear(); }
    if (this.key) this.teardown();
  }

  teardown() {
    for (const s of this.stages.values()) { try { s.K.dispose(); } catch { /* ignore */ } }
    this.stages.clear();
    this.key = null;
  }

  build(def, fields, r0) {
    this.builds = (this.builds || 0) + 1; // diagnostics: must be 1 per game instance
    this.teardown();
    const quality = this.low ? 0 : 1;
    for (const field of fields) {
      const scene = new THREE.Scene();
      const K = makeKit({ world: def.world, cam: def.cam || 'top', quality, scene, roster: r0.roster });
      scene.background = new THREE.Color('#0b0618');
      const r = { ...r0, field };
      let o = null;
      try { o = def.render3d.build(K, r) || {}; } catch (err) { this.fail(def, err); }
      this.stages.set(field, { scene, K, o });
    }
    this.warm();
  }

  // Shader compilation on Windows/ANGLE can freeze a frame for 100–500 ms. Two rules make it happen only here:
  // 1) every material renders in the "transparent" variant forever (locked): games fade/blink things by
  //    toggling material.transparent, which would otherwise switch shader program mid-game;
  // 2) right after build (behind the rule card) the whole scene is really DRAWN once into a tiny off-screen target
  //    with every hidden object shown and culling off: on Windows/ANGLE that is what actually compiles + links the
  //    shaders (shadow variants too) and uploads every texture, so nothing is left to do mid-game.
  warm() {
    const R = this.renderer;
    const t0 = performance.now();
    const rt = new THREE.WebGLRenderTarget(64, 64);
    for (const st of this.stages.values()) {
      lockMaterials(st.scene);
      const W = st.K.world;
      const cam = new THREE.PerspectiveCamera(60, 1, 1, 1e6);
      const c = st.K.p(W.w / 2, W.h / 2, 0);
      if (st.K.side) cam.position.set(c.x, c.y, Math.max(W.w, W.h) * 2); else cam.position.set(c.x, Math.max(W.w, W.h) * 2, c.z + 1);
      cam.lookAt(c);
      const hidden = [], culled = [];
      st.scene.traverse((o) => {
        if (!o.visible) { hidden.push(o); o.visible = true; }
        if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; }
      });
      try {
        st.scene.updateMatrixWorld(true);
        R.compile(st.scene, cam);
        R.setRenderTarget(rt);
        R.render(st.scene, cam);
      } catch (err) { console.warn('[3d] warm-up', err); }
      finally {
        R.setRenderTarget(null);
        for (const o of hidden) o.visible = false;
        for (const o of culled) o.frustumCulled = true;
      }
    }
    rt.dispose();
    this.warmMs = Math.round(performance.now() - t0);
  }

  fail(def, err) {
    if (!this.errors.has(def.id)) { this.errors.add(def.id); console.error(`[render3d] ${def.id}:`, err); }
  }

  // views: layout views; ctx: { def, gview, gameKey, gt, dt, r (base render info), mods (array), shake(view) → {x,y,r} px, mode }
  // Returns one projector per view (for 2D effects), or null if 3D failed.
  render(c) {
    if (!this.ok) return null;
    const { def, gview, views } = c;
    const fields = [...new Set(views.map((v) => (Number.isInteger(v.field) ? v.field : null)))];
    const roster = c.r.roster || [];
    const key = `${c.gameKey}|${fields.join(',')}|${roster.map((q) => q.char + q.color).join(',')}`;
    if (key !== this.key) {
      // Models first: the game's declared assets + the players' characters (a failed download never blocks).
      const need = [...(def.render3d.assets || []), ...roster.flatMap((q) => charAssets(q.char))];
      if (!assetsDone(need)) {
        if (this.loadingKey !== key) { this.loadingKey = key; preload(need); }
        this.loading = true;
        this.hide();
        return null; // caller draws its loading screen (or the 2D fallback) while models download
      }
      this.loading = false;
      this.build(def, fields, c.r); this.key = key;
    }
    if (this.errors.has(def.id)) return null;
    if (this.warming) { this.loading = true; return null; } // shaders still compiling: the caller shows "Caricamento…"
    this.loading = false;
    if ((this.frameNo = (this.frameNo || 0) + 1) % 30 === 0) for (const st of this.stages.values()) lockMaterials(st.scene);
    this.canvas.style.visibility = 'visible';
    const R = this.renderer;
    // Update every stage once.
    for (const [field, s] of this.stages) {
      s.K.t = c.gt; s.K.dt = c.dt;
      const r = { ...c.r, field, viewer: views.find((v) => (v.field ?? null) === field)?.viewer ?? null };
      try {
        const P = typeof window !== 'undefined' ? window.__perf : null;
        let t = P ? performance.now() : 0;
        def.render3d.update(s.K, s.o, gview, r);
        if (P) { const n = performance.now(); P.add('upd', n - t); t = n; }
        for (const L of s.K.layers) L.update(gview, r);
        if (P) { const n = performance.now(); P.add('layers', n - t); t = n; }
        for (const f of s.K.ticks) f(c.dt, c.gt);
        if (P) P.add('ticks', performance.now() - t);
      } catch (err) { this.fail(def, err); return null; }
      const mir = c.mods.includes('specchio');
      s.scene.scale.x = mir ? -1 : 1;
      s.scene.position.x = mir ? def.world.w : 0;
    }
    R.setScissorTest(false);
    R.clear();
    R.setScissorTest(true);
    const out = [];
    views.forEach((v, idx) => {
      const s = this.stages.get(Number.isInteger(v.field) ? v.field : null);
      const cam = this.cams[idx] || (this.cams[idx] = new THREE.PerspectiveCamera(40, 1, 5, 20000));
      this.placeCamera(cam, s, v, c);
      const y = this.H - v.y - v.h;
      R.setViewport(v.x, y, v.w, v.h);
      R.setScissor(v.x, y, v.w, v.h);
      R.render(s.scene, cam);
      out.push(makeProjector(s, cam, v));
    });
    R.setScissorTest(false);
    return out;
  }

  placeCamera(cam, s, v, c) {
    const { def, gview, mods, gt } = c;
    const K = s.K;
    const has = (m) => mods.includes(m);
    const side = K.side;
    const shared = c.mode === 'shared' && (v.viewer === null || v.viewer === undefined);
    const cfg = { tilt: side ? 0.1 : shared ? 0 : 0.62, fov: side ? 30 : 38, fit: side ? 1 : 1.04, h: 0, ...(def.render3d.cam || {}) };
    if (shared && def.render3d.cam?.sharedTilt !== undefined) cfg.tilt = def.render3d.cam.sharedTilt;
    let rot = (v.rot * Math.PI) / 2;
    let zoom = 1;
    let cx = def.world.w / 2, cy = def.world.h / 2;
    if (cfg.target) { try { const tg = cfg.target(gview, v); if (tg) { cx = tg.x; cy = tg.y; if (tg.zoom) zoom *= tg.zoom; } } catch { /* keep center */ } }
    if (has('sottosopra')) rot += gt * 0.35;
    if (has('ubriaco')) { rot += Math.sin(gt * 1.3) * 0.1; zoom *= 1 + Math.sin(gt * 0.9) * 0.06; }
    if (has('disco')) zoom *= 1 + Math.max(0, Math.sin(gt * Math.PI * 4)) * 0.03;
    if (has('cugino') && c.focus && c.focus.length) { zoom *= 1.7; cx = c.focus.reduce((a, q) => a + q.x, 0) / c.focus.length; cy = c.focus.reduce((a, q) => a + q.y, 0) / c.focus.length; }
    if (has('specchio')) cx = def.world.w - cx; // the scene is mirrored around the world center
    const sc = v.scale * zoom;
    const sh = c.shake ? c.shake(v) : { x: 0, y: 0, r: 0 };
    rot += sh.r;
    // Screen axes expressed in world 2D coordinates.
    const dn = { x: Math.sin(rot), y: Math.cos(rot) }, rt = { x: Math.cos(rot), y: -Math.sin(rot) };
    cx -= (sh.x * rt.x + sh.y * dn.x) / sc;
    cy -= (sh.x * rt.y + sh.y * dn.y) / sc;
    const fov = cfg.fov;
    const hv = v.h / sc;
    const D = (hv / (2 * Math.tan((fov * Math.PI) / 360))) * cfg.fit;
    const target = K.p(cx, cy, cfg.h);
    const dn3 = K.dir(dn.x, dn.y);
    const out3 = side ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const tilt = cfg.tilt;
    const pos = target.clone().addScaledVector(out3, Math.cos(tilt) * D).addScaledVector(dn3, (side ? -1 : 1) * Math.sin(tilt) * D);
    cam.fov = fov;
    cam.aspect = v.w / v.h;
    cam.near = Math.max(1, D * 0.05);
    cam.far = D * 12 + 4000;
    cam.position.copy(pos);
    cam.up.copy(dn3).multiplyScalar(-1);
    cam.lookAt(target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // Keep the key light's shadow box centered on the play area.
    const sun = K.sun;
    if (sun) { sun.target.position.copy(K.p(def.world.w / 2, def.world.h / 2, 0)); sun.target.updateMatrixWorld(); }
  }
}

function addLights(K) {
  const { THREE } = K;
  const W = K.world.w, H = K.world.h;
  const hemi = new THREE.HemisphereLight('#fff3e6', '#4a3a2a', 1.4);
  K.scene.add(hemi);
  const sun = new THREE.DirectionalLight('#ffffff', 2.1);
  const span = Math.max(W, H);
  if (K.side) sun.position.set(W * 0.25, span * 0.9, span * 1.3);
  else sun.position.set(W * 0.5 - span * 0.45, span * 1.2, H * 0.5 - span * 0.6);
  sun.castShadow = K.shadows;
  if (sun.castShadow) {
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -span * 0.85; sc.right = span * 0.85; sc.top = span * 0.85; sc.bottom = -span * 0.85;
    sc.near = 10; sc.far = span * 4;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 1.5;
  }
  K.scene.add(sun);
  K.scene.add(sun.target);
  const rim = new THREE.DirectionalLight('#ffd9a8', 0.5);
  rim.position.set(W * 0.5 + span, span * 0.5, K.side ? -span : H * 0.5 + span);
  K.scene.add(rim);
  K.hemi = hemi; K.sun = sun; K.rim = rim;
}

// Maps world points to CSS pixels of the 2D canvas for one view (used to draw 2D effects over the 3D scene).
function makeProjector(s, cam, v) {
  const K = s.K;
  const tmp = new K.THREE.Vector3();
  const lift = K.side ? 0 : 36; // effects float around body height on top-down games
  const proj = (x, y, h = lift) => {
    K.p(x, y, h, tmp);
    tmp.applyMatrix4(s.scene.matrixWorld);
    tmp.project(cam);
    return { x: v.x + ((tmp.x + 1) / 2) * v.w, y: v.y + ((1 - tmp.y) / 2) * v.h, ok: tmp.z < 1 && tmp.z > -1 };
  };
  const E = 8;
  return {
    proj,
    // Local affine approximation of the projection around (x, y): draw world-space 2D stuff there.
    at(ctx, dpr, x, y, h) {
      const a = proj(x, y, h), bx = proj(x + E, y, h), by = proj(x, y + E, h);
      if (!a.ok) return false;
      const m11 = (bx.x - a.x) / E, m12 = (bx.y - a.y) / E, m21 = (by.x - a.x) / E, m22 = (by.y - a.y) / E;
      ctx.setTransform(dpr * m11, dpr * m12, dpr * m21, dpr * m22, dpr * (a.x - m11 * x - m21 * y), dpr * (a.y - m12 * x - m22 * y));
      return true;
    },
    // Upright transform (rotated for the viewer) with the local scale, mapping (x, y) to its projection.
    upright(ctx, dpr, x, y, ang, h) {
      const a = proj(x, y, h), bx = proj(x + E, y, h);
      if (!a.ok) return false;
      const s = Math.max(0.05, Math.hypot(bx.x - a.x, bx.y - a.y) / E);
      const c = Math.cos(ang) * s, si = Math.sin(ang) * s;
      ctx.setTransform(dpr * c, dpr * si, -dpr * si, dpr * c, dpr * (a.x - c * x + si * y), dpr * (a.y - si * x - c * y));
      return true;
    },
    scaleAt(x, y, h) { const a = proj(x, y, h), b = proj(x + E, y, h); return Math.hypot(b.x - a.x, b.y - a.y) / E; },
  };
}
