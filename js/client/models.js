// 3D models (KayKit CC0 packs in public/assets): loading cache, static model clones, instanced scatter and
// animated characters. Browser-only loading; in Node (tests) every model falls back to a placeholder.
import * as THREE from '../../vendor/three.module.min.js';
import { CHAR_BY_ID, CHARACTERS } from '../core/proto.js';

const hasDoc = typeof document !== 'undefined';
const cache = new Map(); // name -> { status: 'loading'|'ok'|'err', gltf, info, promise }
let libsP = null;
let SUcache = null; // SkeletonUtils, ready after the first load

// Asset names: 'chars/Knight', 'medieval/building_castle_red', 'dungeon/torch_lit', 'weapons/Skeleton_Blade'.
export function assetUrl(name) {
  const i = name.indexOf('/');
  const pack = name.slice(0, i), file = name.slice(i + 1);
  if (pack === 'chars') return `assets/chars/${file}.glb`;
  if (pack === 'dungeon') return `assets/dungeon/${file}.gltf.glb`;
  return `assets/${pack}/${file}.gltf`;
}

function libs() {
  if (!libsP) {
    libsP = Promise.all([
      import('../../vendor/three-addons/GLTFLoader.js'),
      import('../../vendor/three-addons/SkeletonUtils.js'),
    ]).then(([a, b]) => ({ loader: new a.GLTFLoader(), SU: b }));
  }
  return libsP;
}

export function loadAsset(name) {
  let e = cache.get(name);
  if (e) return e.promise;
  e = { status: 'loading', gltf: null, info: null, promise: null };
  cache.set(name, e);
  if (!hasDoc) { e.status = 'err'; e.promise = Promise.resolve(null); return e.promise; }
  e.promise = libs().then(({ loader, SU }) => { SUcache = SU; return loader.loadAsync(assetUrl(name)); }).then((gltf) => {
    gltf.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    gltf.scene.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      // KayKit textures are tiny atlases: keep them crisp and in sRGB.
      const m = o.material;
      if (m && m.map) { m.map.colorSpace = THREE.SRGBColorSpace; m.map.anisotropy = 4; }
    });
    e.gltf = gltf; e.info = { min: box.min.clone(), max: box.max.clone(), size };
    e.status = 'ok';
    return gltf;
  }).catch((err) => {
    console.warn('[models] non riesco a caricare', name, err);
    e.status = 'err';
    return null;
  });
  return e.promise;
}

export const preload = (names) => Promise.all([...new Set(names)].map(loadAsset));
// true when every asset finished (loaded or failed: a failed one becomes a placeholder, never blocks the game).
export const assetsDone = (names) => names.every((n) => { const s = cache.get(n)?.status; return s === 'ok' || s === 'err'; });
export const assetOk = (name) => cache.get(name)?.status === 'ok';
export const assetInfo = (name) => cache.get(name)?.info || null;
export const charAsset = (id) => `chars/${(CHAR_BY_ID[id] || CHARACTERS[0]).file}`;

// Gear shown by each character (everything else held in the model is hidden) + extra weapons for skeletons.
const GEAR = {
  knight: { show: ['1H_Sword', 'Round_Shield'] },
  barbarian: { show: ['1H_Axe', 'Barbarian_Round_Shield'] },
  mage: { show: ['2H_Staff'] },
  rogue: { show: ['Knife', 'Knife_Offhand'] },
  hooded: { show: ['1H_Crossbow'] },
  skwarrior: { attach: { r: 'weapons/Skeleton_Blade', l: 'weapons/Skeleton_Shield_Small_A' } },
  skmage: { attach: { r: 'weapons/Skeleton_Staff' } },
  skrogue: { attach: { r: 'weapons/Skeleton_Crossbow' } },
  skminion: { attach: { r: 'weapons/Skeleton_Axe' } },
};
const BODY_PART = /(Body|Head|Arm|Leg|Cape|Cloak|Hat|Helmet|Eyes|Jaw|Skull|Hood)/;
export const charAssets = (id) => {
  const g = GEAR[id] || {};
  return [charAsset(id), ...Object.values(g.attach || {})];
};

// Looping clips; every other clip plays once and holds its last frame (attacks, hits, deaths, throws…).
const LOOPS = /^(Idle|Idle_B|Idle_Combat|Running_|Walking_|Jump_Idle|Blocking|Cheer|Sit_.*_Idle|Lie_Idle|Spellcasting|2H_Melee_Idle|.*_Aiming|Unarmed_Idle|1H_Ranged_Shooting|2H_Ranged_Shooting|2H_Melee_Attack_Spinning|Taunt)/;

// Static clone of a loaded model, or null.
export function cloneStatic(name) {
  const e = cache.get(name);
  if (!e || e.status !== 'ok') return null;
  return e.gltf.scene.clone(true);
}

// Instanced copies of one static model: one InstancedMesh per sub-mesh (a forest = a handful of draw calls).
// items: [{ m: THREE.Matrix4 }] already in the target space.
export function instanced(name, matrices) {
  const e = cache.get(name);
  if (!e || e.status !== 'ok') return null;
  const group = new THREE.Group();
  const tmp = new THREE.Matrix4();
  e.gltf.scene.updateMatrixWorld(true);
  e.gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const im = new THREE.InstancedMesh(o.geometry, o.material, matrices.length);
    matrices.forEach((m, k) => im.setMatrixAt(k, tmp.multiplyMatrices(m, o.matrixWorld)));
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true; im.receiveShadow = true;
    im.computeBoundingSphere();
    group.add(im);
  });
  return group;
}

// Animated character. Returns null if the model is not loaded (caller falls back to the blob avatar).
export function makeCharacter(charId) {
  const name = charAsset(charId);
  const e = cache.get(name);
  if (!e || e.status !== 'ok' || !SUcache) return null;
  const model = SUcache.clone(e.gltf.scene);
  const gear = GEAR[charId] || {};
  const show = new Set(gear.show || []);
  const mats = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (!BODY_PART.test(o.name) && !show.has(o.name)) { o.visible = false; return; }
    o.material = o.material.clone(); // own materials: per-avatar fades
    mats.push(o.material);
    o.castShadow = true; o.receiveShadow = false;
    o.frustumCulled = false; // skinned bounds are the bind pose: never pop out while animating
  });
  // Weapons for the skeletons, attached to the hand slots.
  for (const [hand, asset] of Object.entries(gear.attach || {})) {
    // GLTFLoader sanitizes node names ('handslot.r' → 'handslotr'): accept both.
    const bone = model.getObjectByName(hand === 'r' ? 'handslotr' : 'handslotl') || model.getObjectByName(hand === 'r' ? 'handslot.r' : 'handslot.l');
    const w = cloneStatic(asset);
    if (bone && w) {
      w.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); mats.push(o.material); o.castShadow = true; } });
      bone.add(w);
    }
  }
  const mixer = new THREE.AnimationMixer(model);
  const clips = new Map(e.gltf.animations.map((c) => [c.name, c]));
  return { model, mixer, clips, mats, info: e.info, loops: LOOPS };
}

