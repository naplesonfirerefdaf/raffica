// Screen layouts for 2–4 players. Rotations are quarter turns clockwise (0..3), screen y points down.
// Everything here is indexed by SEAT (player 0..n-1 of the running game), never by connection slot.
//  pc     : one screen, every player in front of it (keyboards / controllers)
//  shared : phone/tablet on the table, 2 players at the two short ends (P2 sees it rotated 180°). Only n = 2.
//  solo   : own device in network play (`me` = my seat)
//  tv     : big screen spectator
//  pad    : controller-only phone (network, with a TV showing the game)

// Starting side of each seat in top-down worlds: bottom, top, left, right -> rotation that puts it at the bottom.
export const SIDE_ROT = [0, 2, 3, 1];

export const rotVec = (x, y, k) => {
  k = ((k % 4) + 4) % 4;
  if (k === 0) return { x, y };
  if (k === 1) return { x: -y, y: x };
  if (k === 2) return { x: -x, y: -y };
  return { x: y, y: -x };
};

export function fit(rect, world, rot) {
  const ww = rot % 2 ? world.h : world.w;
  const wh = rot % 2 ? world.w : world.h;
  return Math.min(rect.w / ww, rect.h / wh);
}

function bestRot(rect, world, candidates) {
  let best = candidates[0], bestS = -1;
  for (const r of candidates) {
    const s = fit(rect, world, r);
    if (s > bestS * 1.04) { best = r; bestS = s; }
  }
  return best;
}

// Rotation of a top-down world on a shared big screen: portrait worlds lie down on landscape screens.
export function screenRot(world, landscape) {
  if (world.h > world.w * 1.05) return landscape ? 1 : 0;
  if (world.w > world.h * 1.05) return landscape ? 0 : 1;
  return 0;
}

const view = (rect, rot, field, viewer, world) => ({ ...rect, rot, field, viewer, scale: fit(rect, world, rot), world });
const fill = (n, v) => Array.from({ length: n }, () => v);

// n = number of seated players (2..4). Controls carry `t` (touch pad index 0/1) and `seat`.
export function computeLayout({ W, H, mode, me = 0, n = 2, def = null, touch = false }) {
  n = Math.max(2, Math.min(4, n | 0 || 2));
  if (mode === 'shared' && n > 2) mode = 'pc'; // the table phone is a 1v1 thing
  me = Math.max(0, Math.min(n - 1, me | 0));
  const world = def?.world || { w: 1000, h: 1000 };
  const cam = def?.cam || 'top';
  const split = !!def?.split;
  const L = { mode, W, H, n, views: [], overlays: [], controls: [], physRot: fill(n, 0), viewRot: fill(n, 0), hudTop: 0, empty: null };
  const portrait = H >= W;

  if (mode === 'pad') {
    L.controls.push({ t: 0, seat: me, x: 0, y: H * 0.18, w: W, h: H * 0.82, rot: 0 });
    L.overlays.push({ x: 0, y: 0, w: W, h: H, rot: 0, viewer: me });
    // The game is on a landscape TV: use the same rotation the TV picks.
    if (cam === 'top' && !split) L.viewRot = fill(n, screenRot(world, true));
    return L;
  }

  if (mode === 'shared' && W > H * 1.2) {
    // Device lying in landscape: players at the left and right short ends (P1 right, P2 left).
    const sw = Math.round(Math.max(96, Math.min(W * 0.19, 190)));
    L.controls.push({ t: 0, seat: 0, x: W - sw, y: 0, w: sw, h: H, rot: 3 });
    L.controls.push({ t: 1, seat: 1, x: 0, y: 0, w: sw, h: H, rot: 1 });
    L.physRot = [3, 1];
    const mid = { x: sw, y: 0, w: W - sw * 2, h: H };
    const right = { x: mid.x + mid.w / 2, y: 0, w: mid.w / 2, h: H };
    const left = { x: mid.x, y: 0, w: mid.w / 2, h: H };
    if (cam === 'top' && !split) {
      L.views.push(view(mid, 3, null, null, world));
      L.viewRot = [3, 3];
    } else {
      L.views.push(view(right, 3, split ? 0 : null, 0, world));
      L.views.push(view(left, 1, split ? 1 : null, 1, world));
      L.viewRot = [3, 1];
    }
    L.overlays.push({ ...right, rot: 3, viewer: 0 });
    L.overlays.push({ ...left, rot: 1, viewer: 1 });
    L.hudShared = true;
    return L;
  }

  if (mode === 'shared') {
    const sh = Math.round(Math.max(96, Math.min(H * 0.19, 190)));
    L.controls.push({ t: 0, seat: 0, x: 0, y: H - sh, w: W, h: sh, rot: 0 });
    L.controls.push({ t: 1, seat: 1, x: 0, y: 0, w: W, h: sh, rot: 2 });
    L.physRot = [0, 2];
    const mid = { x: 0, y: sh, w: W, h: H - sh * 2 };
    const bottom = { x: 0, y: mid.y + mid.h / 2, w: W, h: mid.h / 2 };
    const top = { x: 0, y: mid.y, w: W, h: mid.h / 2 };
    if (cam === 'top' && !split) {
      L.views.push(view(mid, 0, null, null, world));
      L.viewRot = [0, 0];
    } else {
      L.views.push(view(bottom, 0, split ? 0 : null, 0, world));
      L.views.push(view(top, 2, split ? 1 : null, 1, world));
      L.viewRot = [0, 2];
    }
    L.overlays.push({ ...bottom, rot: 0, viewer: 0 });
    L.overlays.push({ ...top, rot: 2, viewer: 1 });
    L.hudShared = true;
    return L;
  }

  // pc / tv / solo share a top HUD bar.
  const hudH = Math.round(Math.max(40, Math.min(64, H * 0.08)));
  L.hudTop = hudH;
  let area = { x: 0, y: hudH, w: W, h: H - hudH };
  const solo = mode === 'solo';

  if (solo && touch) {
    if (portrait) {
      const cs = Math.round(Math.max(130, Math.min(H * 0.3, 280)));
      L.controls.push({ t: 0, seat: me, x: 0, y: H - cs, w: W, h: cs, rot: 0 });
      area = { x: 0, y: hudH, w: W, h: H - hudH - cs };
    } else {
      L.controls.push({ t: 0, seat: me, x: 0, y: hudH, w: W, h: H - hudH, rot: 0, overlay: true });
    }
  }

  if (split) {
    if (solo) {
      // My field big, the others as small insets stacked on the right.
      L.views.push(view(area, 0, me, me, world));
      const others = [...Array(n).keys()].filter((s) => s !== me);
      const gap = 8;
      const ih = Math.min(area.h * 0.3, (area.h - gap * (others.length + 1)) / others.length);
      const iw = Math.min(area.w * 0.3, ih * Math.max(0.6, world.w / world.h));
      others.forEach((s, k) => {
        const r = { x: area.x + area.w - iw - gap, y: area.y + gap + k * (ih + gap), w: iw, h: ih };
        L.views.push({ ...view(r, 0, s, me, world), inset: true, owner: s });
      });
    } else if (n === 2) {
      const half = area.w / 2;
      L.views.push(view({ x: area.x, y: area.y, w: half - 2, h: area.h }, 0, 0, 0, world));
      L.views.push(view({ x: area.x + half + 2, y: area.y, w: half - 2, h: area.h }, 0, 1, 1, world));
    } else {
      // 2×2 grid: seat 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right. With 3 players the
      // last cell shows the standings (L.empty).
      const cw = area.w / 2, ch = area.h / 2;
      const cell = (k) => ({ x: area.x + (k % 2) * cw + (k % 2 ? 2 : 0), y: area.y + Math.floor(k / 2) * ch + (k >= 2 ? 2 : 0), w: cw - 2, h: ch - 2 });
      for (let s = 0; s < n; s++) L.views.push(view(cell(s), 0, s, s, world));
      if (n === 3) L.empty = cell(3);
    }
  } else if (cam === 'top') {
    const base = SIDE_ROT[me] || 0;
    // Shared screens (PC/TV) use a fixed rule so joypad phones can match it; own phones put their side at the bottom.
    const rot = solo ? bestRot(area, world, [base, (base + 1) % 4, (base + 3) % 4]) : screenRot(world, W > H);
    L.views.push(view(area, rot, null, solo ? me : null, world));
    L.viewRot = fill(n, rot);
  } else {
    L.views.push(view(area, 0, null, solo ? me : null, world));
  }
  L.overlays.push({ x: 0, y: hudH, w: W, h: H - hudH, rot: 0, viewer: solo ? me : null });
  return L;
}

// Convert a player's stick (their own frame) into a world direction for the current layout.
export function stickToWorld(L, seat, sx, sy) {
  const s = rotVec(sx, sy, L.physRot[seat] || 0);
  return rotVec(s.x, s.y, -(L.viewRot[seat] || 0));
}

// Map a screen point into a rect's local frame (accounting for the rect rotation). Returns {x,y,w,h}.
export function toLocal(rect, px, py) {
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const v = rotVec(px - cx, py - cy, -(rect.rot || 0));
  const lw = rect.rot % 2 ? rect.h : rect.w, lh = rect.rot % 2 ? rect.w : rect.h;
  return { x: v.x + lw / 2, y: v.y + lh / 2, w: lw, h: lh };
}

// Apply a rect's transform to ctx so drawing happens in its local (upright for the viewer) frame.
export function enterRect(ctx, rect) {
  const lw = rect.rot % 2 ? rect.h : rect.w, lh = rect.rot % 2 ? rect.w : rect.h;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
  ctx.rotate(((rect.rot || 0) * Math.PI) / 2);
  ctx.translate(-lw / 2, -lh / 2);
  return { w: lw, h: lh };
}
