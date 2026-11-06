// Kai's room. You sit at the desk (first person): drag or swipe to look around (about 180 degrees), scroll or pinch to
// zoom, click the monitor to use the computer, click things in the room to open the folder they belong to. Three.js
// comes from a CDN (the import map in index.html): no build step, no npm.
//
// Where things are:
//   room/content.json   every word the folders say (edit the text there, not here)
//   room/objects.json   what stands where, what it opens ("opens") or says on hover ("tip"); your own .glb models
//                       go in room/models/
//   room/folders.js     turns a folder into a window (shared with classic.html, the text version)
//   this file           the room, the view outside, light by time of day, looking and clicking, the "old photo" look
//
// Preview another time of day: index.html?t=21.5 (hours, 0 to 24). Deep links: index.html#projects opens a folder,
// index.html#computer sits you at the computer.
//
// Speed: the scene is drawn only when something changes (you look around, the clock ticks, a lamp turns on). The film
// grain is a CSS layer on top, so it moves without redrawing the room.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { el, folderNodes, iconArt } from './folders.js';
import { createOutside } from './outside.js';

window.roomReady = true;   // index.html shows the "no 3D" page if this never happens (the CDN didn't load)

const $ = id => document.getElementById(id);
const TOUCH = matchMedia('(pointer: coarse)').matches;
const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = THREE.MathUtils.clamp, rad = THREE.MathUtils.degToRad;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const nearest = (from, to) => from + (to - from) - Math.PI * 2 * Math.round((to - from) / (Math.PI * 2));
const rand = (() => { let a = 20261105; return () => {   // the same "random" every visit, so the room never changes
  a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();

let fixedHour = Number.parseFloat(new URLSearchParams(location.search).get('t'));   // ?t=, or the day / night button
function now() {
  const d = new Date();
  if (Number.isFinite(fixedHour)) d.setHours(Math.floor(fixedHour) % 24, Math.round((fixedHour % 1) * 60), 0);
  return d;
}

// ------------------------------------------------------------------ no WebGL 2: the text version instead
function webglOK() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}
if (!webglOK()) {
  $('loading').classList.add('done');
  $('fallback').classList.add('on');
  throw new Error('WebGL 2 is not available');
}
$('fallback').classList.remove('on');
$('hint').textContent = TOUCH ? 'Swipe to look around · tap things' : 'Drag to look around · click the monitor';

// ------------------------------------------------------------------ renderer, scene, camera
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;           // the cheaper filter: the soft look hides the difference
renderer.shadowMap.autoUpdate = false;                 // nothing moves, so shadows are redrawn only when told
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.prepend(renderer.domElement);

let dirty = true;                                      // draw the next frame? (set by anything that changes the picture)
const invalidate = () => { dirty = true; };
const reshadow = () => { renderer.shadowMap.needsUpdate = true; dirty = true; };

// Lazy loading: the room appears at once in plain colours, and what has to download (photo textures, models) is
// added when it arrives, so nobody waits on a loading screen and nothing stutters.
const texLoader = new THREE.TextureLoader();
const later = cb => (window.requestIdleCallback ? requestIdleCallback(cb, { timeout: 1500 }) : setTimeout(cb, 300));
const photoFiles = new Map();
// Put a photo texture (CC0, Poly Haven; assets/textures) on a material once it has downloaded. Detail comes from these
// pictures (colour, bumps, shine), not from extra triangles. tint: the material's colour once the photo is on.
function photo(mat, slot, file, repeat = [1, 1], tint = null) {
  if (!photoFiles.has(file)) photoFiles.set(file, texLoader.loadAsync(`assets/textures/${file}`));
  photoFiles.get(file).then(src => {
    const t = src.clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); t.anisotropy = 8; t.needsUpdate = true;
    if (slot === 'map') t.colorSpace = THREE.SRGBColorSpace;
    mat[slot] = t;
    if (tint) mat.color.set(tint);
    mat.needsUpdate = true;
    reshadow();
  }).catch(err => console.warn(`room: ${file} didn't load`, err));
  return mat;
}

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x000000, 0.0022);       // only the city outside is far enough to fade (haze)
const baseFov = () => (innerWidth < innerHeight ? 70 : 58);
const camera = new THREE.PerspectiveCamera(baseFov(), innerWidth / innerHeight, 0.02, 520);
camera.rotation.order = 'YXZ';

// ------------------------------------------------------------------ small helpers for shapes and pictures
const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...extra });
// Photo textures are laid on in metres (material.userData.tile = metres per copy of the picture), not stretched over
// each box: the wall pieces around the window, a desk top and its legs all show the texture at one size and line up
// across pieces. userData.grain: wood, whose grain (the picture's up) runs along each face's longer side.
function planarUV(geo, [ox, oy, oz], tile, grain) {
  const { width: w, height: h, depth: d } = geo.parameters;
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + ox, y = p.getY(i) + oy, z = p.getZ(i) + oz;
    let [a, b, la, lb] = Math.abs(n.getX(i)) > 0.5 ? [z, y, d, h] : Math.abs(n.getY(i)) > 0.5 ? [x, z, w, d] : [x, y, w, h];
    if (grain && la > lb) [a, b] = [b, a];
    uv.setXY(i, a / tile, b / tile);
  }
}
function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const geo = new THREE.BoxGeometry(w, h, d);
  if (mat.userData.tile) planarUV(geo, [x, y, z], mat.userData.tile, mat.userData.grain);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  return m;
}
function cyl(rt, rb, h, mat, x = 0, y = 0, z = 0, seg = 24, open = false) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  return m;
}
const UP = new THREE.Vector3(0, 1, 0);
function rod(a, b, r, mat) {                           // a cylinder from point a to point b
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A);
  const m = cyl(r, r, d.length(), mat, ...A.clone().add(B).multiplyScalar(0.5).toArray(), 12);
  m.quaternion.setFromUnitVectors(UP, d.normalize());
  return m;
}
function extrude(shape, depth, bevel, mat) {           // a flat outline made thick, rounded edges, centred on z
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: 4, curveSegments: 16 });
  geo.translate(0, 0, -depth / 2);
  const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true;
  return m;
}
// An outline made thick like extrude(), but as wide as width(x, y) says at each point (full width, metres), with rounded
// edges inside the outline: a fairing wide in the middle and narrow at the nose and the tail. Shaded smooth.
function sculpt(shape, width, mat, edge = 0.035) {
  const D = 0.1, B = 0.04;
  let geo = new THREE.ExtrudeGeometry(shape, { depth: D, bevelEnabled: true, bevelThickness: B, bevelSize: edge, bevelOffset: -edge, bevelSegments: 5, curveSegments: 8 });
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, (((p.getZ(i) - D / 2) / (D / 2 + B)) * width(p.getX(i), p.getY(i))) / 2);
  geo.deleteAttribute('normal'); geo.deleteAttribute('uv');
  geo = mergeVertices(geo, 1e-4); geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true;
  return m;
}
// Smooth runs of points (x, y), a sharp corner where one run ends and the next begins.
function outline(start, ...runs) {
  const s = new THREE.Shape(); s.moveTo(...start);
  for (const run of runs) s.splineThru(run.map(([x, y]) => new THREE.Vector2(x, y)));
  return s;
}
// Many small parts drawn as one shape per material (fewer draw calls), in the group's own space.
function bake(group) {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert(), byMat = new Map();
  group.traverse(m => {
    if (!m.isMesh) return;
    const geo = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
    geo.applyMatrix4(inv.clone().multiply(m.matrixWorld));
    if (!byMat.has(m.material)) byMat.set(m.material, []);
    byMat.get(m.material).push(geo);
  });
  const out = new THREE.Group();
  for (const [mat, geos] of byMat) { const m = new THREE.Mesh(mergeGeometries(geos), mat); m.castShadow = true; m.receiveShadow = true; out.add(m); }
  return out;
}
const noShadow = m => { m.castShadow = false; m.receiveShadow = false; m.raycast = () => {}; return m; };

// A picture drawn with the 2D canvas, used as a texture. tex.redraw() draws it again (the clocks do every minute).
const redrawWithFonts = [];
function canvasTexture(w, h, draw, { fonts = false } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  tex.redraw = () => { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.setLineDash([]); draw(ctx, w, h); tex.needsUpdate = true; invalidate(); };
  tex.redraw();
  if (fonts) redrawWithFonts.push(tex);                // drawn again once Anton / Plus Jakarta Sans have loaded
  return tex;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}
function speckle(ctx, w, h, n = 2500) {           // paper texture
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.09)';
    ctx.fillRect(rand() * w, rand() * h, 1.6, 1.6);
  }
}
const SANS = '"Plus Jakarta Sans", system-ui, sans-serif';
const EMOJI = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
const H12 = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12;
const timeText = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ------------------------------------------------------------------ the room: floor, walls, the window left of the desk
const world = new THREE.Group();       // everything inside the room (what you can click is in here too)
scene.add(world);
const W = 2.2, FRONT = -1.0, BACK = 2.4, H = 2.7, T = 0.12;   // half width, front and back wall, ceiling, wall thickness
const MIDZ = (FRONT + BACK) / 2, LEN = BACK - FRONT + 2 * T, FULL = 2 * W + 2 * T;
const WIN = { x0: -1.75, x1: -0.8, y0: 0.95, y1: 2.05 };       // the window hole in the front wall
const FZ = FRONT - T / 2;

const floorMat = std('#7d5d45', { roughness: 0.75 });
floorMat.userData.tile = 1.6;                                    // the photo covers 1.6 m of floor
// The wood (floor and furniture) is a small, softened copy of the photo, colour only: closer to the flat colours of the
// rest of the room (owner, 2026-11-06: the 1k photos with bumps and shine stood out).
photo(floorMat, 'map', 'wood_floor_diff_256.jpg', [1, 1], '#e8ddd0');
// Painted walls and ceiling: smooth emulsion paint, as in a real flat (owner, 2026-11-06: the photo plaster looked like
// stained concrete). A picture drawn once, nearly white so the colour is the paint's: a faint, wide unevenness (roller
// marks, light bouncing off the floor) and a fine grain.
const paintTex = (() => {
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f4f4'; ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 70; i++) {                                 // soft patches, drawn wrapped round so the picture tiles
    const x = rand() * S, y = rand() * S, r = 40 + rand() * 130, tone = rand() < 0.5 ? '0,0,0,0.03' : '255,255,255,0.05';
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
      const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      g.addColorStop(0, `rgba(${tone})`); g.addColorStop(1, `rgba(${tone.replace(/[\d.]+$/, '0')})`);
      ctx.fillStyle = g; ctx.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
    }
  }
  for (let i = 0; i < 26000; i++) { ctx.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.04)'; ctx.fillRect(rand() * S, rand() * S, 1, 1); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
})();
const paint = colour => {
  const m = std(colour, { roughness: 0.92, map: paintTex });
  m.userData.tile = 2.0;                                         // 2 m of wall per copy, the same on every wall
  return m;
};
// Woven cloth for the bedding, curtains, rug and lampshade: a fine weave, loose fibres and a faint unevenness, nearly
// white so the colour is the material's. The room's things all have a surface now, like the wood and the floor, not
// flat pastel colour (owner, 2026-11-06). cloth(colour, across, down): copies of the weave across and down each face.
const fabricTex = (() => {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f0f0f0'; ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) {                                 // unevenness, wrapped round so the picture tiles
    const x = rand() * S, y = rand() * S, r = 10 + rand() * 35, tone = rand() < 0.5 ? '0,0,0,0.025' : '255,255,255,0.03';
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
      const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      g.addColorStop(0, `rgba(${tone})`); g.addColorStop(1, `rgba(${tone.replace(/[\d.]+$/, '0')})`);
      ctx.fillStyle = g; ctx.fillRect(x + dx - r, y + dy - r, 2 * r, 2 * r);
    }
  }
  for (let y = 0; y < S; y += 2) { ctx.fillStyle = `rgba(0,0,0,${0.03 + rand() * 0.04})`; ctx.fillRect(0, y, S, 1); }   // weft
  for (let x = 0; x < S; x += 2) { ctx.fillStyle = `rgba(0,0,0,${0.02 + rand() * 0.04})`; ctx.fillRect(x, 0, 1, S); }   // warp
  for (let i = 0; i < 2500; i++) { ctx.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.1)'; ctx.fillRect(rand() * S, rand() * S, 1 + rand() * 2, 1); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  return t;
})();
const cloth = (colour, across = 1, down = 1, extra = {}) => {
  const map = fabricTex.clone(); map.repeat.set(across, down);
  return std(colour, { roughness: 1, map, ...extra });
};
const woodMat = (tint = '#b9997e') => {
  const m = std('#8a6a50', { roughness: 0.55 });
  Object.assign(m.userData, { tile: 1.0, grain: true });          // 1 m of veneer per copy, grain along each board
  return photo(m, 'map', 'oak_veneer_01_diff_256.jpg', [1, 1], tint);
};

const wallMat = paint('#e6dfd3');                                          // warm off-white
const ceilingMat = paint('#f0ede7');                                       // plain white
// The walls cast shadows from their outer face (three.js uses the inner one by default): where two walls meet, a point
// on one sat right against the other's shadow-casting face, inside the bias, and a thin line of light leaked down the
// corner (owner, 2026-11-06).
wallMat.shadowSide = ceilingMat.shadowSide = THREE.FrontSide;
const trimMat = std('#ebe4d8', { roughness: 0.6 });
world.add(box(FULL, 0.1, LEN, floorMat, 0, -0.05, MIDZ));
world.add(box(FULL, T, LEN, ceilingMat, 0, H + T / 2, MIDZ));
world.add(box(T, H, LEN, wallMat, W + T / 2, H / 2, MIDZ), box(T, H, LEN, wallMat, -W - T / 2, H / 2, MIDZ));
world.add(box(FULL, H, T, wallMat, 0, H / 2, BACK + T / 2));
// the wall in front of you, built around the window
world.add(box(FULL, WIN.y0, T, wallMat, 0, WIN.y0 / 2, FZ), box(FULL, H - WIN.y1, T, wallMat, 0, (H + WIN.y1) / 2, FZ));
world.add(box(WIN.x0 + W + T, WIN.y1 - WIN.y0, T, wallMat, (WIN.x0 - W - T) / 2, (WIN.y0 + WIN.y1) / 2, FZ));
world.add(box(W + T - WIN.x1, WIN.y1 - WIN.y0, T, wallMat, (WIN.x1 + W + T) / 2, (WIN.y0 + WIN.y1) / 2, FZ));
// A soft shade into every corner and along the ceiling, as light falls off there in a real room: the corners read
// clearly instead of the walls running into one another (owner, 2026-11-06). Strips of black, fading out, over the paint.
{
  const fade = canvasTexture(64, 4, (ctx, w, h) => {      // grey levels: an alpha map reads the green channel
    const g = ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 8; i++) { const v = Math.round(255 * (1 - i / 8) ** 2); g.addColorStop(i / 8, `rgb(${v},${v},${v})`); }
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  });
  fade.colorSpace = THREE.NoColorSpace;
  const strip = (strength, a, b, away) => {               // dark along the edge a-b, faded out by the time it has moved `away`
    const [A, B, V] = [a, b, away].map(v => new THREE.Vector3(...v)), geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([A, B, A.clone().add(V), B.clone().add(V)].flatMap(v => v.toArray()), 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0, 1, 1], 2));
    geo.setIndex([0, 2, 1, 2, 3, 1]);
    world.add(noShadow(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: fade, transparent: true, opacity: strength,
      depthWrite: false, side: THREE.DoubleSide }))));
  };
  const e = 0.003, CW = 0.32, TOP = 0.25;                   // just off the paint; how far each shade reaches
  for (const sx of [-1, 1]) for (const [z, dz] of [[FRONT, 1], [BACK, -1]]) {        // the four upright corners, both walls
    strip(0.2, [sx * (W - e), 0, z], [sx * (W - e), H, z], [0, 0, dz * CW]);
    strip(0.2, [sx * W, 0, z + dz * e], [sx * W, H, z + dz * e], [-sx * CW, 0, 0]);
  }
  for (const [z, dz] of [[FRONT, 1], [BACK, -1]]) {                                 // where the walls meet the ceiling
    strip(0.13, [-W, H, z + dz * e], [W, H, z + dz * e], [0, -TOP, 0]);
    strip(0.13, [-W, H - e, z], [W, H - e, z], [0, 0, dz * TOP]);
  }
  for (const sx of [-1, 1]) {
    strip(0.13, [sx * (W - e), H, FRONT], [sx * (W - e), H, BACK], [0, -TOP, 0]);
    strip(0.13, [sx * W, H - e, FRONT], [sx * W, H - e, BACK], [-sx * TOP, 0, 0]);
  }
}
// skirting boards
world.add(box(2 * W, 0.08, 0.015, trimMat, 0, 0.04, FRONT + 0.0075));
world.add(box(0.015, 0.08, BACK - FRONT, trimMat, W - 0.0075, 0.04, MIDZ), box(0.015, 0.08, BACK - FRONT, trimMat, -W + 0.0075, 0.04, MIDZ));
// the window: a slim aluminium frame set towards the outside of the wall, so the painted reveal shows around it as in a
// real flat (it was a deep white box with the glass in the middle, which read oddly), a stone sill, faint glass, short
// curtains on a rod
{
  const wx = (WIN.x0 + WIN.x1) / 2, wy = (WIN.y0 + WIN.y1) / 2, ww = WIN.x1 - WIN.x0, wh = WIN.y1 - WIN.y0;
  const OZ = FRONT - T + 0.035, f = 0.045, alu = std('#d4d8d7', { roughness: 0.4, metalness: 0.4 });   // OZ: the frame's middle
  world.add(box(ww, f, 0.05, alu, wx, WIN.y1 - f / 2, OZ), box(ww, f, 0.05, alu, wx, WIN.y0 + f / 2, OZ));
  world.add(box(f, wh - 2 * f, 0.05, alu, WIN.x0 + f / 2, wy, OZ), box(f, wh - 2 * f, 0.05, alu, WIN.x1 - f / 2, wy, OZ));
  world.add(box(0.03, wh - 2 * f, 0.04, alu, wx, wy, OZ), box(ww - 2 * f, 0.03, 0.04, alu, wx, WIN.y0 + wh * 0.68, OZ));
  const sillBack = OZ + 0.025, sillFront = FRONT + 0.035;          // from the frame to 3.5 cm into the room, its ends into the wall
  world.add(box(ww + 0.08, 0.025, sillFront - sillBack, std('#e3dfd8', { roughness: 0.5 }), wx, WIN.y0 + 0.0125, (sillBack + sillFront) / 2));
  const glass = noShadow(new THREE.Mesh(new THREE.PlaneGeometry(ww, wh),
    new THREE.MeshBasicMaterial({ color: '#cfe6ee', transparent: true, opacity: 0.05, depthWrite: false })));
  glass.position.set(wx, wy, OZ);
  world.add(glass);
  const CZ = FRONT + 0.1, rodMat = std('#5a4636');                 // curtains hang just in front of the wall
  world.add(rod([WIN.x0 - 0.38, WIN.y1 + 0.12, CZ], [WIN.x1 + 0.3, WIN.y1 + 0.12, CZ], 0.011, rodMat));
  for (const x of [WIN.x0 - 0.33, WIN.x1 + 0.25]) world.add(rod([x, WIN.y1 + 0.12, FRONT], [x, WIN.y1 + 0.12, CZ], 0.008, rodMat));
  const curtainMat = cloth('#c9a98a', 1.5, 5, { side: THREE.DoubleSide });
  for (const x of [WIN.x0 - 0.17, WIN.x1 + 0.13]) {
    const geo = new THREE.PlaneGeometry(0.3, 1.25, 20, 1);        // down to the sill, gathered in folds
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin(p.getX(i) * 50) * 0.018);
    geo.computeVertexNormals();
    const c = new THREE.Mesh(geo, curtainMat);
    c.position.set(x, WIN.y1 + 0.12 - 0.625, CZ); c.castShadow = true;
    world.add(c);
  }
}
// a rug under the chair
{
  const rug = new THREE.Mesh(new THREE.CircleGeometry(1.05, 48), cloth('#7f8f86', 7, 7));
  rug.rotation.x = -Math.PI / 2; rug.position.set(0, 0.004, 0.45); rug.receiveShadow = true; world.add(rug);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 0.96, 48), cloth('#d7c5b2', 7, 7));
  ring.rotation.x = -Math.PI / 2; ring.position.set(0, 0.005, 0.45); ring.receiveShadow = true; world.add(ring);
}
// Cables, and where they go (they follow objects.json's positions): the keyboard into the back of the monitor; the
// monitor, the lamp and the phone charger over the back of the desk, down the wall and into a power strip on the floor
// under the desk, which is plugged into the wall. Nothing ends in mid-air (owner, 2026-11-06).
{
  const cable = (pts, colour = '#1c1c1e') => {
    const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)));
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.0028, 5), std(colour, { roughness: 0.6 }));
    m.castShadow = true; m.receiveShadow = true; world.add(m);
  };
  const B = FRONT + 0.005, F = FRONT + 0.03;                       // down the wall; along the floor in front of the skirting
  // the keyboard, round the left of the monitor's foot and up into its back
  cable([[-0.05, 0.768, -0.49], [-0.08, 0.763, -0.62], [-0.14, 0.763, -0.75], [-0.15, 0.763, -0.86], [-0.06, 0.766, -0.94],
    [0.04, 0.8, -0.92], [0.06, 0.9, -0.885], [0.05, 0.99, -0.86]]);
  // the monitor: out of its back, left of the stand (you see it hang between the screen and the desk), to the strip
  cable([[-0.1, 1.02, -0.857], [-0.11, 0.9, -0.87], [-0.12, 0.8, -0.9], [-0.15, 0.765, -0.95], [-0.16, 0.745, B - 0.003],
    [-0.16, 0.4, B], [-0.13, 0.12, B], [-0.08, 0.095, F - 0.01], [-0.05, 0.068, -0.955]]);
  // the lamp, from the back of its base, behind the drawers, along the floor to the strip
  cable([[0.6, 0.77, -0.83], [0.63, 0.763, -0.93], [0.65, 0.745, B - 0.003], [0.655, 0.3, B], [0.65, 0.12, B], [0.635, 0.092, FRONT + 0.02],
    [0.6, 0.012, F - 0.008], [0.4, 0.004, F - 0.008], [0.27, 0.02, F - 0.008], [0.21, 0.08, -0.96], [0.19, 0.068, -0.955]]);
  // the phone charger: out of the bottom of the phone (its port), round the phone, behind the lamp, down to the strip
  const ph = new THREE.Vector3(0.55, 0.7645, -0.44), along = new THREE.Vector3(Math.sin(rad(-25)), 0, Math.cos(rad(-25)));
  const port = ph.clone().addScaledVector(along, 0.0775), out = ph.clone().addScaledVector(along, 0.11);
  cable([port.toArray(), [out.x, 0.7635, out.z], [0.6, 0.763, -0.3], [0.69, 0.763, -0.4], [0.72, 0.763, -0.6], [0.725, 0.763, -0.85],
    [0.73, 0.745, B - 0.003], [0.735, 0.3, B], [0.73, 0.12, B], [0.715, 0.092, FRONT + 0.025], [0.68, 0.012, F + 0.006], [0.4, 0.004, F + 0.006],
    [0.27, 0.03, F + 0.006], [0.14, 0.09, -0.952], [0.11, 0.068, -0.955]], '#ecebe7');
  // the power strip: four sockets, three plugs in (the phone's a white charger), and its own cable to the wall socket
  const white = std('#ecebe7', { roughness: 0.5 }), black = std('#222124', { roughness: 0.5 });
  world.add(box(0.32, 0.035, 0.05, white, 0.08, 0.0175, -0.955));
  world.add(box(0.03, 0.03, 0.04, black, -0.05, 0.05, -0.955), box(0.03, 0.03, 0.04, black, 0.19, 0.05, -0.955));
  world.add(box(0.032, 0.03, 0.032, white, 0.11, 0.05, -0.955));
  world.add(box(0.03, 0.006, 0.04, std('#3a3a3c'), 0.03, 0.0375, -0.955));       // the empty socket
  world.add(box(0.09, 0.09, 0.01, white, -0.3, 0.3, FRONT + 0.005), box(0.04, 0.055, 0.03, white, -0.3, 0.3, FRONT + 0.025));
  cable([[-0.08, 0.0175, -0.955], [-0.14, 0.012, -0.965], [-0.24, 0.02, F - 0.004], [-0.29, 0.1, F - 0.004], [-0.3, 0.2, FRONT + 0.03], [-0.3, 0.272, FRONT + 0.025]], '#ecebe7');
}
// String lights all the way round the room, just under the ceiling (owner, 2026-11-06): hooks about every 1.1 m, a
// little slack between them, round each corner. They only glow (and bloom): the one light that stood in for them lit a
// single patch of wall and ceiling, a glow from nowhere (owner, 2026-11-06).
const fairyMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.6, 0.85) });
let fairyBulbs, fairyPick;
{
  const x0 = -W + 0.03, x1 = W - 0.03, z0 = FRONT + 0.03, z1 = BACK - 0.03, corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];
  const pts = [], hookY = h => (h % 2 ? 2.47 : 2.44);
  let hook = 0;
  for (let c = 0; c < 4; c++) {
    const [ax, az] = corners[c], [bx, bz] = corners[c + 1], len = Math.hypot(bx - ax, bz - az), spans = Math.round(len / 1.1);
    for (let k = 0; k < spans; k++, hook++) {
      const y0 = hookY(hook), y1 = hookY(hook + 1), sag = 0.12 * (len / spans);
      for (let s = 0; s < 14; s++) {
        const u = s / 14, along = (k + u) / spans;
        pts.push(new THREE.Vector3(ax + (bx - ax) * along, y0 + (y1 - y0) * u - Math.sin(u * Math.PI) * sag, az + (bz - az) * along));
      }
    }
  }
  const curve = new THREE.CatmullRomCurve3(pts, true);
  world.add(noShadow(new THREE.Mesh(new THREE.TubeGeometry(curve, 900, 0.003, 4, true), std('#2b2a2e'))));
  const bulbs = fairyBulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.014, 10, 8), fairyMat, Math.round(curve.getLength() / 0.11));
  const dummy = new THREE.Object3D();
  for (let i = 0; i < bulbs.count; i++) {
    const p = curve.getPointAt((i + 0.5) / bulbs.count);
    const [, ox, oz] = [[p.x - x0, 1, 0], [x1 - p.x, -1, 0], [p.z - z0, 0, 1], [z1 - p.z, 0, -1]].sort((a, b) => a[0] - b[0])[0];   // off the nearest wall
    dummy.position.set(p.x + ox * 0.008, p.y - 0.014, p.z + oz * 0.008);
    dummy.updateMatrix(); bulbs.setMatrixAt(i, dummy.matrix);
    bulbs.setColorAt(i, new THREE.Color(1, 1, 1));               // full brightness; twinkle() dims them in a wave
  }
  bulbs.raycast = () => {};
  bulbs.frustumCulled = false;
  world.add(bulbs);
  // the bulbs are too small to click: an invisible tube 10 cm thick along the wire takes the clicks (see DOES)
  fairyPick = new THREE.Mesh(new THREE.TubeGeometry(curve, 300, 0.05, 6, true), new THREE.MeshBasicMaterial({ visible: false }));
  fairyPick.userData = { entry: { does: 'twinkle' }, glowMeshes: [] };
  world.add(fairyPick);
}

// ------------------------------------------------------------------ outside: sky, sun, moon, stars (the city: room/outside.js)
const sky = new THREE.Mesh(new THREE.SphereGeometry(440, 32, 16), new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, bottom: { value: new THREE.Color() },
    glow: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) } },
  vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform vec3 top, horizon, bottom, glow, sunDir; varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      vec3 col = d.y > 0.0 ? mix(horizon, top, pow(min(d.y * 1.6, 1.0), 0.6)) : mix(horizon, bottom, min(-d.y * 4.0, 1.0));
      float s = max(dot(d, sunDir), 0.0);
      col += glow * (pow(s, 6.0) * 0.45 + pow(s, 90.0) * 1.2);
      gl_FragColor = vec4(col, 1.0);
    }`,
}));
sky.frustumCulled = false;
scene.add(sky);

const outside = createOutside(scene, { touch: TOUCH });         // HDB blocks, the CBD, clouds: see room/outside.js
const disc = (r, color) => {
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 40), new THREE.MeshBasicMaterial({ color, fog: false, transparent: true }));
  scene.add(m); return m;
};
const sunDisc = disc(11, new THREE.Color(4, 3.6, 3)), moonDisc = disc(7, new THREE.Color(1.7, 1.8, 2));
const stars = (() => {
  const pts = [];
  while (pts.length < 600) {                               // only the brightest few: it's Singapore, the sky glows
    const v = new THREE.Vector3(rand() * 2 - 1, rand(), rand() * 2 - 1);
    if (v.length() > 1 || v.y < 0.12) continue;
    v.normalize().multiplyScalar(420); pts.push(v.x, v.y, v.z);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, transparent: true, fog: false, depthWrite: false }));
  scene.add(p); return p;
})();
// The room is drawn first and the outside after it, the sky last: the city behind the walls is then skipped by the
// graphics chip instead of painted and covered up (it was being drawn first, nearly a whole screen's worth).
for (const o of scene.children) if (o !== world) o.traverse(m => { if (!m.material?.transparent) m.renderOrder = m === sky ? 2 : 1; });

// ------------------------------------------------------------------ light: the sun or moon through the window, sky light, lamps
const sun = new THREE.DirectionalLight('#ffffff', 2);
sun.castShadow = true;
sun.shadow.mapSize.set(TOUCH ? 1024 : 2048, TOUCH ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -3.6, right: 3.6, top: 3.6, bottom: -3.6, near: 2, far: 24 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.025;
sun.target.position.set(0, 1.0, 0);
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight('#cfe0ea', '#9a8a76', 1);   // second colour: light bounced up off the floor
scene.add(hemi);
const lamps = [];                     // lamps register here: { light, shade, power }
let lampOn = true;                    // click the desk lamp (DOES.lamp)

// Time of day from the visitor's clock. e = how high the sun is: 1 at 13:00, 0 at 07:00 and 19:00, below 0 at night.
const C = hex => new THREE.Color(hex);
const PALETTE = {          //  night               dusk                day       (night: the orange-purple glow of a city sky)
  top:     [C('#05060c'), C('#2a3460'), C('#3d7fd0')],
  horizon: [C('#271f2c'), C('#ee9a6a'), C('#a9c9e6')],
  bottom:  [C('#121017'), C('#3a2c38'), C('#a9bccb')],
  light:   [C('#9db4dc'), C('#ffab6e'), C('#fff1da')],
};
function blend(target, key, w) {
  const [n, d, y] = PALETTE[key];
  return target.setRGB(n.r * w[0] + d.r * w[1] + y.r * w[2], n.g * w[0] + d.g * w[1] + y.g * w[2], n.b * w[0] + d.b * w[1] + y.b * w[2]);
}
const mixN = (w, night, dusk, day) => night * w[0] + dusk * w[1] + day * w[2];
const towards = (az, el) => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
const sunDir = new THREE.Vector3(), moonDir = towards(-0.6, 0.3);   // the moon sits where you can see it from the chair
function applyTime() {
  const d = now(), h = d.getHours() + d.getMinutes() / 60;
  const e = Math.sin(((h - 7) / 12) * Math.PI);
  const day = smooth(0, 0.45, e), night = 1 - smooth(-0.3, 0, e), w = [night, Math.max(0, 1 - day - night), day];
  sunDir.copy(towards(-0.62 + clamp((h - 13) / 6, -1, 1) * 0.18, Math.max(0.05, e) * 1.15));   // crosses the window
  const lightDir = night > 0.5 ? moonDir : sunDir;
  sun.position.copy(sun.target.position).addScaledVector(lightDir, 12);
  blend(sun.color, 'light', w);
  sun.intensity = mixN(w, 0.8, 2.2, 3.6);
  blend(hemi.color, 'horizon', w).lerp(blend(new THREE.Color(), 'top', w), 0.4);
  hemi.intensity = mixN(w, 0.55, 1.4, 2.6);
  const glow = mixN(w, 1, 0.75, 0.2);                                // the lamps matter most after dark
  for (const l of lamps) { l.light.intensity = lampOn ? l.power * glow : 0; l.shade.emissiveIntensity = lampOn ? 0.1 + glow * 0.5 : 0; }
  fairyMat.color.setRGB(0.7 + 1.6 * glow, 0.6 + 1.1 * glow, 0.45 + 0.45 * glow);
  const u = sky.material.uniforms;
  blend(u.top.value, 'top', w); blend(u.horizon.value, 'horizon', w); blend(u.bottom.value, 'bottom', w);
  blend(u.glow.value, 'light', w).multiplyScalar(mixN(w, 0.08, 1.2, 0.6));   // the moon's halo stays small: the sky is in the window
  u.sunDir.value.copy(lightDir);
  scene.fog.color.copy(u.horizon.value);
  scene.fog.density = mixN(w, 0.0016, 0.0022, 0.0019);             // a tropical haze, thicker with distance; clearer at night
  outside.update(w);
  sunDisc.position.copy(sunDir).multiplyScalar(420); sunDisc.lookAt(0, 0, 0);
  sunDisc.material.opacity = smooth(-0.1, 0.02, e); sunDisc.visible = e > -0.1;
  blend(sunDisc.material.color, 'light', w).multiplyScalar(4);
  moonDisc.position.copy(moonDir).multiplyScalar(420); moonDisc.lookAt(0, 0, 0);
  moonDisc.material.opacity = night; moonDisc.visible = night > 0.02;
  stars.material.opacity = night * 0.55; stars.visible = night > 0.02;
  renderer.toneMappingExposure = mixN(w, 1.25, 1.1, 1.1);
  reshadow();
}

// ------------------------------------------------------------------ pictures drawn on things: the screen, the clock, the phone, posters
let content = { folders: [] }, folders = {};
const desktopItems = () => [...content.folders.filter(f => f.desktop), ...(content.cvs || []).map(c => ({ pdf: true, name: `${c.name}.pdf` }))];

// A picture of the desktop for the monitor in the room, drawn like the real one (index.html, the HTML desktop): the
// wallpaper, the menu bar, folder and PDF icons, the two widgets and the dock.
function wrapText(ctx, text, x, y, maxW, lineH) {
  let line = '';
  for (const word of text.split(' ')) {
    if (line && ctx.measureText(`${line} ${word}`).width > maxW) { ctx.fillText(line, x, y); line = word; y += lineH; }
    else line = line ? `${line} ${word}` : word;
  }
  ctx.fillText(line, x, y);
}
function drawFolder(ctx, x, y, symbol) {                       // 58 x 50 at (x, y)
  ctx.fillStyle = '#3f8fd8'; roundRect(ctx, x + 3, y - 5, 24, 10, 4); ctx.fill();
  const g = ctx.createLinearGradient(0, y, 0, y + 50); g.addColorStop(0, '#80c4f8'); g.addColorStop(1, '#4c9fe8');
  ctx.fillStyle = g; roundRect(ctx, x, y, 58, 46, 6); ctx.fill();
  ctx.save(); ctx.globalAlpha = 0.5; ctx.filter = 'grayscale(1) brightness(0.5)';
  ctx.font = `20px ${EMOJI}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(symbol, x + 29, y + 26);
  ctx.restore();
}
function drawPdf(ctx, x, y) {                                  // 40 x 52 at (x, y)
  ctx.fillStyle = '#fbfbf9';
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 28, y); ctx.lineTo(x + 40, y + 12); ctx.lineTo(x + 40, y + 52); ctx.lineTo(x, y + 52); ctx.fill();
  ctx.fillStyle = '#d8d6d0'; ctx.beginPath(); ctx.moveTo(x + 28, y); ctx.lineTo(x + 28, y + 12); ctx.lineTo(x + 40, y + 12); ctx.fill();
  ctx.fillStyle = '#b9b6ae'; for (let i = 0; i < 4; i++) ctx.fillRect(x + 7, y + 16 + i * 4, 25, 1.5);
  ctx.fillStyle = '#e0443a'; roundRect(ctx, x + 4, y + 36, 22, 11, 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = '800 8.5px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('PDF', x + 7, y + 41.5);
}
const screenTex = canvasTexture(1024, 596, (ctx, w, h) => {
  ctx.fillStyle = '#25303a'; ctx.fillRect(0, 0, w, h);
  let g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#1f3b3b'); g.addColorStop(1, '#2b2635');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  for (const [px, py, r, c] of [[0.12, 0.18, 0.55, '79,127,120'], [0.88, 0.92, 0.6, '201,138,94'], [0.72, 0.22, 0.42, '159,188,180'], [0.3, 0.95, 0.5, '109,90,122']]) {
    g = ctx.createRadialGradient(px * w, py * h, 0, px * w, py * h, r * w);
    g.addColorStop(0, `rgba(${c},1)`); g.addColorStop(1, `rgba(${c},0)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
  // the menu bar
  ctx.fillStyle = 'rgba(18,20,22,0.42)'; ctx.fillRect(0, 0, w, 24);
  ctx.fillStyle = '#b7c6c2'; ctx.beginPath(); ctx.arc(16, 12, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.font = `700 12px ${SANS}`; ctx.fillText('Desktop', 30, 12);
  ctx.font = `500 12px ${SANS}`; ctx.fillStyle = 'rgba(255,255,255,0.88)'; ctx.fillText('File', 96, 12); ctx.fillText('Edit', 130, 12); ctx.fillText('View', 164, 12);
  const d = now();
  ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.fillText('Stand up', w - 12, 12);
  ctx.font = `600 12px ${SANS}`; ctx.fillText(`${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}  ${timeText(d)}`, w - 84, 12);
  ctx.fillStyle = 'rgba(255,255,255,0.9)'; roundRect(ctx, w - 262, 7, 20, 10, 3); ctx.fill();                 // battery
  ctx.beginPath(); ctx.arc(w - 284, 18, 9, Math.PI * 1.25, Math.PI * 1.75); ctx.lineTo(w - 284, 18); ctx.fill();   // wi-fi
  // the icons, in columns of four
  desktopItems().forEach((f, i) => {
    const cx = 60 + Math.floor(i / 4) * 92, y = 44 + (i % 4) * 92;
    if (f.pdf) drawPdf(ctx, cx - 20, y); else drawFolder(ctx, cx - 29, y + 4, f.icon || '');
    ctx.font = `500 11.5px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 3; ctx.fillStyle = '#fff'; ctx.fillText(f.name, cx, y + 70); ctx.shadowBlur = 0;
  });
  // the widgets
  const wx = w - 330, ww = 306;
  const card = (y, hh) => {
    ctx.fillStyle = 'rgba(28,32,34,0.45)'; roundRect(ctx, wx, y, ww, hh, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1; ctx.stroke();
  };
  card(40, 172);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#fff'; ctx.font = `700 25px ${SANS}`; ctx.fillText("Hi, I'm Kai Le.", wx + 18, 78);
  ctx.fillStyle = 'rgba(255,255,255,0.82)'; ctx.font = `400 12.5px ${SANS}`;
  wrapText(ctx, 'Mechanical Engineering and Computing at NUS, on the CDE Engineering Scholars Programme. I build trading systems and research market microstructure. Looking for engineering and quant internships, summer 2027 or 2028.', wx + 18, 104, ww - 36, 19);
  card(226, 74);
  ctx.fillStyle = '#fff'; ctx.font = `300 40px ${SANS}`; const t = timeText(d).replace(/\s?[ap]\.?m\.?$/i, '');
  ctx.fillText(t, wx + 18, 278);
  const tw = ctx.measureText(t).width;
  ctx.fillStyle = '#ff8a65'; ctx.font = `700 10.5px ${SANS}`; ctx.fillText(d.toLocaleDateString([], { weekday: 'long' }).toUpperCase(), wx + 34 + tw, 256);
  ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = `400 12.5px ${SANS}`; ctx.fillText(d.toLocaleDateString([], { day: 'numeric', month: 'long' }), wx + 34 + tw, 276);
  // the dock
  const tiles = [['#5db4ff', '#1d6fe0'], ['#ffffff', '#eceae6'], ['#3b3f45', '#1d1f23'], ['#2a86d6', '#0a5eb0'], null, ['#5a5d63', '#34363b']];
  const dw = 5 * 46 + 4 * 8 + 18 + 18, dx = (w - dw) / 2, dy = h - 66;
  ctx.fillStyle = 'rgba(255,255,255,0.18)'; roundRect(ctx, dx, dy, dw, 58, 18); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.stroke();
  let x = dx + 9;
  for (const c of tiles) {
    if (!c) { ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(x + 1, dy + 12, 1, 34); x += 12; continue; }
    g = ctx.createLinearGradient(0, dy + 6, 0, dy + 52); g.addColorStop(0, c[0]); g.addColorStop(1, c[1]);
    ctx.fillStyle = g; roundRect(ctx, x, dy + 6, 46, 46, 11); ctx.fill();
    x += 54;
  }
  ctx.fillStyle = '#fff'; ctx.fillRect(dx + 21, dy + 20, 22, 16);                                          // mail
  g = ctx.createConicGradient ? ctx.createConicGradient(0, dx + 86, dy + 29) : null;                       // photos
  if (g) { ['#f5a524', '#f3d33c', '#7cc35a', '#3fa3d8', '#6c6fd9', '#d9558d', '#f5a524'].forEach((c, i) => g.addColorStop(i / 6, c)); ctx.fillStyle = g; }
  else ctx.fillStyle = '#7cc35a';
  ctx.beginPath(); ctx.arc(dx + 86, dy + 29, 14, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = `800 20px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('</>', dx + 140, dy + 29); ctx.fillText('in', dx + 194, dy + 30);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(dx + 260, dy + 31, 9, -Math.PI * 0.3, Math.PI * 1.3); ctx.stroke();               // power
  ctx.beginPath(); ctx.moveTo(dx + 260, dy + 18); ctx.lineTo(dx + 260, dy + 28); ctx.stroke();
}, { fonts: true });

const SEGMENTS = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
function sevenSeg(ctx, digit, x, y, w, h, on, off) {   // one digit of an old alarm clock
  const t = w * 0.2, hh = h / 2;
  const seg = {
    a: [x + t, y, w - 2 * t, t], g: [x + t, y + hh - t / 2, w - 2 * t, t], d: [x + t, y + h - t, w - 2 * t, t],
    f: [x, y + t, t, hh - 1.5 * t], b: [x + w - t, y + t, t, hh - 1.5 * t],
    e: [x, y + hh + t / 2, t, hh - 1.5 * t], c: [x + w - t, y + hh + t / 2, t, hh - 1.5 * t],
  };
  const lit = digit == null ? '' : SEGMENTS[digit];
  for (const k in seg) { ctx.fillStyle = lit.includes(k) ? on : off; ctx.fillRect(...seg[k]); }
}
const clockTex = canvasTexture(512, 220, (ctx, w, h) => {
  ctx.fillStyle = '#0c0b0b'; ctx.fillRect(0, 0, w, h);
  const d = now();
  let hr = d.getHours(); const min = d.getMinutes();
  if (H12) hr = hr % 12 || 12;
  ctx.setTransform(1, 0, -0.08, 1, 14, 0);              // the slight slant of segment digits
  const on = '#ff4a2e', off = '#2a100c', y = 34, dw = 78, dh = 150;
  sevenSeg(ctx, hr >= 10 ? Math.floor(hr / 10) : (H12 ? null : 0), 34, y, dw, dh, on, off);
  sevenSeg(ctx, hr % 10, 128, y, dw, dh, on, off);
  ctx.fillStyle = d.getSeconds() % 2 ? off : on;        // the colon blinks
  ctx.fillRect(225, y + 38, 16, 16); ctx.fillRect(225, y + 96, 16, 16);
  sevenSeg(ctx, Math.floor(min / 10), 262, y, dw, dh, on, off);
  sevenSeg(ctx, min % 10, 356, y, dw, dh, on, off);
  if (H12) { ctx.fillStyle = on; ctx.font = `700 22px ${SANS}`; ctx.textBaseline = 'top'; ctx.fillText(d.getHours() < 12 ? 'AM' : 'PM', 448, y + 4); }
});

const phoneTex = canvasTexture(256, 546, (ctx, w, h) => {       // the lock screen
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#3b5560'); g.addColorStop(1, '#171e19');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  const d = now();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = `600 16px ${SANS}`; ctx.fillText(d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }), w / 2, 92);
  ctx.font = `300 72px ${SANS}`; ctx.fillText(timeText(d).replace(/\s?[ap]\.?m\.?$/i, ''), w / 2, 166);
  ctx.fillStyle = 'rgba(255,255,255,0.16)'; roundRect(ctx, 14, 228, w - 28, 92, 16); ctx.fill();
  ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.font = `600 15px ${SANS}`; ctx.fillText('✉️  New message', 30, 262);
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = `400 14px ${SANS}`; ctx.fillText('Say hello: tap the phone', 30, 292);
}, { fonts: true });

// The keyboard: raised keycaps with their legends, merged into one shape (about 1,000 triangles, drawn in one go).
const U = 0.019, KEY_COLS = 15, KEY_ROWS = 6, KW = KEY_COLS * U, KD = KEY_ROWS * U;    // key pitch, key area
const keyLayout = (() => {
  const ones = str => [...str].map(k => [k, 1]);
  const rows = [
    [['Esc', 1], ...'F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12'.split(' ').map(k => [k, 1]), ['Del', 1], ['Home', 1]],
    [...ones('`1234567890-='), ['⌫', 2]],
    [['Tab', 1.5], ...ones('QWERTYUIOP[]'), ['\\', 1.5]],
    [['Caps', 1.75], ...ones("ASDFGHJKL;'"), ['Enter', 2.25]],
    [['Shift', 2.25], ...ones('ZXCVBNM,./'), ['Shift', 1.75], ['↑', 1]],
    [['Ctrl', 1.25], ['Win', 1.25], ['Alt', 1.25], ['', 6.25], ['Alt', 1], ['Fn', 1], ['←', 1], ['↓', 1], ['→', 1]],
  ];
  const keys = [];
  rows.forEach((row, r) => { let x = 0; for (const [label, w] of row) { keys.push({ label, x, r, w }); x += w; } });
  return keys;
})();
const keyTex = canvasTexture(1024, 410, (ctx, w, h) => {          // the legends sheet: one patch per key
  const px = w / KEY_COLS, py = h / KEY_ROWS;
  for (const k of keyLayout) {
    const mod = k.w !== 1 || /^(Esc|Del|Home|Fn|Alt|[←↓→↑])$/.test(k.label);
    ctx.fillStyle = k.label === 'Esc' ? '#d9673b' : mod ? '#a8a297' : '#ece6db';
    ctx.fillRect(k.x * px, k.r * py, k.w * px, py);
    const g = ctx.createLinearGradient(0, k.r * py, 0, (k.r + 1) * py);       // a little shading, like a dished keycap
    g.addColorStop(0, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = g; ctx.fillRect(k.x * px, k.r * py, k.w * px, py);
    ctx.fillStyle = '#3b3936'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.font = `600 ${k.label.length > 2 ? 14 : 20}px ${SANS}`;
    ctx.fillText(k.label, k.x * px + 9, k.r * py + 9);
  }
}, { fonts: true });
function keycapGeometry() {
  const parts = keyLayout.map(k => {
    const g = new THREE.BoxGeometry(k.w * U - 0.0026, 0.007, U - 0.0026);
    g.translate((k.x + k.w / 2) * U - KW / 2, 0, (k.r + 0.5) * U - KD / 2);
    const pos = g.attributes.position, uv = g.attributes.uv;
    const uc = (k.x + k.w / 2) / KEY_COLS, vc = 1 - (k.r + 0.5) / KEY_ROWS;
    for (let i = 0; i < pos.count; i++) {
      if (i >= 8 && i < 12) uv.setXY(i, (pos.getX(i) + KW / 2) / KW, 1 - (pos.getZ(i) + KD / 2) / KD);  // top: its own patch
      else uv.setXY(i, uc, vc);                                                                            // sides: its colour
    }
    return g;
  });
  return mergeGeometries(parts);
}

const flagTex = canvasTexture(600, 400, (ctx, w, h) => {        // Singapore: red over white, crescent and five stars
  ctx.fillStyle = '#ef3340'; ctx.fillRect(0, 0, w, h / 2);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, h / 2, w, h / 2);
  ctx.beginPath(); ctx.arc(128, 100, 62, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ef3340'; ctx.beginPath(); ctx.arc(154, 100, 60, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 5; i++) {                                     // the stars, in a ring
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5, cx = 186 + Math.cos(a) * 30, cy = 98 + Math.sin(a) * 30;
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const r = k % 2 ? 4.6 : 11, b = -Math.PI / 2 + (k * Math.PI) / 5;
      ctx.lineTo(cx + Math.cos(b) * r, cy + Math.sin(b) * r);
    }
    ctx.fill();
  }
});

// The books on the bookshelf: a book per course in the degree plan (content.json "bookshelf"), a shelf per year (owner,
// 2026-11-06). Spines, covers and page edges are drawn on one sheet, a slot per book: cloth hardbacks with gilt rules
// and a serif title, paperbacks with printed bands; the course's full name runs down the spine, its code at the foot.
const SLOT_W = 80, SPINE_H = 600, COVER_H = 40, CELL_H = 720;
const SERIF = 'Georgia, "Times New Roman", serif';
const BOOK_COLOURS = [['#1f2f4d', '#d8b45c'], ['#6e1f24', '#e2c27a'], ['#e9e1cf', '#2d5e63'], ['#2f4a3a', '#d8c79a'], ['#c08a2c', '#1d1c1e'],
  ['#1d1c1e', '#e8e2d6'], ['#f1ece2', '#a8322d'], ['#2d5e63', '#f0e6d0'], ['#b4532c', '#f6efe2'], ['#6b6e72', '#f2f0ea'],
  ['#a8322d', '#f4ead6'], ['#5a4030', '#e6cf9a'], ['#ece7dc', '#1f2f4d']];
const paleCover = hex => new THREE.Color(hex).getHSL({}).l > 0.6;           // a pale cover: printed like a paperback
function bookAtlas(books) {                                                  // books: [[code, full name]]
  const cols = Math.max(1, Math.ceil(Math.sqrt((books.length * CELL_H) / SLOT_W))), rows = Math.max(1, Math.ceil(books.length / cols));
  const W = cols * SLOT_W, H = rows * CELL_H, at = i => [(i % cols) * SLOT_W, Math.floor(i / cols) * CELL_H];
  const tex = canvasTexture(W, H, ctx => books.forEach(([code, title], i) => {
    const [x, y] = at(i), [cover, ink] = BOOK_COLOURS[(i * 5) % BOOK_COLOURS.length], paper = paleCover(cover);
    ctx.fillStyle = cover; ctx.fillRect(x, y, SLOT_W, SPINE_H + COVER_H);
    for (let k = 0; k < 900; k++) {                                     // cloth or paper grain, a little wear
      ctx.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.09)' : 'rgba(255,255,255,0.07)';
      ctx.fillRect(x + rand() * SLOT_W, y + rand() * (SPINE_H + COVER_H), 1.5, 1.5);
    }
    ctx.fillStyle = ink;
    if (paper) { ctx.fillRect(x, y, SLOT_W, 52); ctx.fillRect(x, y + SPINE_H - 118, SLOT_W, 118); }   // printed bands
    else for (const b of [24, 34, SPINE_H - 132, SPINE_H - 122]) ctx.fillRect(x + 6, y + b, SLOT_W - 12, 4);   // gilt rules
    // the full name, down the spine (read with your head tilted right), on two lines if it is long
    const len = SPINE_H - 230, face = paper ? SANS : SERIF, weight = paper ? 700 : 600;
    const width = (text, size) => { ctx.font = `${weight} ${size}px ${face}`; return ctx.measureText(text).width; };
    let size = Math.round(SLOT_W * 0.36), lines = [title];
    if (width(title, size) > len) {
      size = Math.round(SLOT_W * 0.27);
      const words = title.split(' ');
      let best = Infinity;
      for (let k = 1; k < words.length; k++) {                         // the break that keeps the longer line shortest
        const two = [words.slice(0, k).join(' '), words.slice(k).join(' ')], w = Math.max(...two.map(t => width(t, size)));
        if (w < best) { best = w; lines = two; }
      }
    }
    ctx.save(); ctx.translate(x + SLOT_W / 2, y + (paper ? 64 : 48) + len / 2); ctx.rotate(Math.PI / 2);
    ctx.font = `${weight} ${size}px ${face}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = paper ? '#2b2a2e' : ink;
    lines.forEach((t, k) => ctx.fillText(t, 0, (k - (lines.length - 1) / 2) * size * 1.08, len));
    ctx.restore();
    ctx.save(); ctx.translate(x + SLOT_W / 2, y + SPINE_H - 58); ctx.rotate(Math.PI / 2);   // the course code at the foot
    ctx.font = `700 ${Math.round(SLOT_W * 0.22)}px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = paper ? cover : ink; ctx.fillText(code, 0, 0, 100);
    ctx.restore();
    const top = y + SPINE_H + COVER_H, ph = CELL_H - SPINE_H - COVER_H;  // the page edges, seen from above
    ctx.fillStyle = '#ebe3d0'; ctx.fillRect(x, top, SLOT_W, ph);
    for (let px = 4; px < SLOT_W - 4; px += 2) { ctx.fillStyle = `rgba(90,70,40,${0.05 + rand() * 0.09})`; ctx.fillRect(x + px, top, 1, ph); }
    ctx.fillStyle = cover; ctx.fillRect(x, top, 5, ph); ctx.fillRect(x + SLOT_W - 5, top, 5, ph); ctx.fillRect(x, top + ph - 6, SLOT_W, 6);
  }), { fonts: true });
  // One book (thickness t across, height h, depth d), its faces mapped to slot i: the spine faces +z, pages on top.
  const geometry = (i, t, h, d) => {
    const g = new THREE.BoxGeometry(t, h, d), uv = g.attributes.uv, [x, y] = at(i);
    const u0 = (x + 1) / W, u1 = (x + SLOT_W - 1) / W, v = py => 1 - (y + py) / H;
    const part = { spine: [v(SPINE_H), v(0)], cover: [v(SPINE_H + COVER_H), v(SPINE_H)], pages: [v(CELL_H), v(SPINE_H + COVER_H)] };
    ['cover', 'cover', 'pages', 'cover', 'spine', 'cover'].forEach((name, f) => {   // BoxGeometry's faces: +x -x +y -y +z -z
      const [v0, v1] = part[name];
      for (let k = f * 4; k < f * 4 + 4; k++) uv.setXY(k, u0 + uv.getX(k) * (u1 - u0), v0 + uv.getY(k) * (v1 - v0));
    });
    return g;
  };
  return { tex, geometry };
}

// ------------------------------------------------------------------ placeholder shapes (until your own models replace them)
// Each returns a group in metres: things that stand (desk, shelves, lamps, and what sits on the desk) have their origin
// on the floor or desk top; things on a wall have their origin at their centre. All face +z (towards you).
function lampShade(rTop, rBottom, height, y, power) {    // a fabric drum shade that glows, with a warm bulb inside
  const g = new THREE.Group();
  const mat = cloth('#efe0c6', 6, 1, { side: THREE.DoubleSide, emissive: '#ffb468', emissiveIntensity: 0.8 });
  g.add(cyl(rTop, rBottom, height, mat, 0, y, 0, 40, true));
  // The bulb's light leaves through the open bottom and top of the shade, not sideways: a cone down (the pool on the
  // desk) and a weaker one up (the wash on the wall above). A bare bulb lit the wall behind the shade into a hot spot
  // that glowed (owner, 2026-11-06). The bulb holder under it shades the lamp's own base, as in a real lamp (the base
  // was the next bright spot); that cone casts shadows, drawn once like all the others.
  const bulbY = y + 0.01;
  g.add(cyl(0.017, 0.017, 0.04, std('#3a3330', { roughness: 0.5 }), 0, bulbY - 0.055, 0, 16));
  for (const [dir, share, angle] of [[-1, 1, 0.85], [1, 0.22, 1.05]]) {     // the wash up the wall: faint and wide, no bright cone
    const light = new THREE.SpotLight('#ffbf7a', power * share, 6, angle, 1, 2);
    light.position.y = bulbY; light.target.position.set(0, bulbY + dir, 0);
    if (dir < 0) {
      light.castShadow = true; light.shadow.mapSize.set(512, 512);
      Object.assign(light.shadow.camera, { near: 0.02, far: 3 });
      light.shadow.bias = -0.002; light.shadow.normalBias = 0.01;
    }
    g.add(light, light.target);
    lamps.push({ light, shade: mat, power: power * share });
  }
  return g;
}
function motorbike() {      // a supersport, real size (2.05 m long, 1.4 m between the axles, front wheel at +x); the model on the wall shelf scales it down
  const g = new THREE.Group();
  const paint = std('#b3141c', { metalness: 0.3, roughness: 0.24 }), gloss = std('#1a1a1c', { metalness: 0.2, roughness: 0.3 });
  const matte = std('#202022', { roughness: 0.9 }), tyre = std('#161616', { roughness: 0.92 }), engine = std('#3a3b3e', { metalness: 0.5, roughness: 0.45 });
  const alu = std('#b9bdc0', { metalness: 0.8, roughness: 0.35 }), chrome = std('#dfe2e4', { metalness: 1, roughness: 0.15 });
  const gold = std('#c9a043', { metalness: 0.85, roughness: 0.3 }), rim = std('#2a2a2c', { metalness: 0.6, roughness: 0.4 });
  const glass = std('#1d2428', { metalness: 0.3, roughness: 0.05, transparent: true, opacity: 0.62 });   // smoked screen
  const silencer = std('#2c2c2e', { metalness: 0.55, roughness: 0.4, flatShading: true }), titanium = std('#6a655e', { metalness: 0.7, roughness: 0.35 });
  const lit = colour => new THREE.MeshBasicMaterial({ color: colour });
  const at = (m, x, y, z = 0) => { m.position.set(x, y, z); m.castShadow = true; return m; };
  const axial = m => { m.rotation.x = Math.PI / 2; return m; };              // a cylinder turned to lie along z
  const flatRing = (r, w, mat) => { const m = new THREE.Mesh(new THREE.TorusGeometry(r, w / 2, 4, 40), mat); m.scale.z = 0.006 / w; return m; };
  // the wheels: round-shouldered tyres on 17-inch rims, five split spokes, discs and gold calipers
  const wheel = (x, r, w, discs) => {
    const a = 0.075, rc = r - a, rimR = rc + a * Math.cos(1.86), prof = [];
    for (let k = 0; k <= 18; k++) { const th = -1.86 + (3.72 * k) / 18; prof.push(new THREE.Vector2(rc + a * Math.cos(th), (w / 2) * Math.sin(th))); }
    const t = at(new THREE.Mesh(new THREE.LatheGeometry(prof, 48), tyre), x, r); t.rotation.x = Math.PI / 2; g.add(t);
    for (const z of [-1, 1]) { const lip = at(new THREE.Mesh(new THREE.TorusGeometry(rimR, 0.009, 6, 40), rim), x, r, z * w * 0.45); g.add(lip); }
    for (let i = 0; i < 5; i++) {
      const s0 = (i / 5) * Math.PI * 2 + 0.3;
      for (const d of [-0.14, 0.14]) g.add(rod([x + Math.cos(s0) * 0.05, r + Math.sin(s0) * 0.05, 0], [x + Math.cos(s0 + d) * (rimR - 0.008), r + Math.sin(s0 + d) * (rimR - 0.008), 0], 0.011, rim));
    }
    g.add(axial(cyl(0.045, 0.045, w * 0.9, alu, x, r)));
    for (const [z, dr, ang] of discs) {
      g.add(at(flatRing(dr - 0.03, 0.06, chrome), x, r, z));
      const cal = at(box(0.075, 0.034, 0.03, gold), x + Math.cos(ang) * (dr - 0.025), r + Math.sin(ang) * (dr - 0.025), z + Math.sign(z) * 0.012);
      cal.rotation.z = ang + Math.PI / 2; g.add(cal);
    }
  };
  wheel(0.7, 0.3, 0.12, [[0.072, 0.16, 2.3], [-0.072, 0.16, 2.3]]);
  wheel(-0.7, 0.31, 0.19, [[0.108, 0.11, -1.2]]);
  g.add(axial(cyl(0.1, 0.1, 0.008, gloss, -0.7, 0.31, -0.11)));             // the rear sprocket
  // the front fork (raked 24 degrees: gold outer tubes, chrome sliders), the top yoke, clip-on bars with grips and levers
  const rake = [-Math.sin(rad(24)), Math.cos(rad(24))], along = k => [0.7 + rake[0] * k, 0.3 + rake[1] * k];
  for (const z of [-0.105, 0.105]) {
    g.add(rod([...along(-0.03), z], [...along(0.27), z], 0.021, chrome), rod([...along(0.25), z], [...along(0.66), z], 0.03, gold));
    g.add(at(box(0.05, 0.06, 0.04, gloss), ...along(0), z));                                  // the axle clamp
  }
  const yoke = at(box(0.09, 0.022, 0.28, alu), ...along(0.65)); yoke.rotation.z = rad(24); g.add(yoke);
  const [bx, by] = along(0.6);
  for (const s of [-1, 1]) {
    g.add(rod([bx, by, s * 0.1], [bx - 0.045, by - 0.02, s * 0.3], 0.012, gloss), rod([bx - 0.028, by - 0.012, s * 0.22], [bx - 0.048, by - 0.022, s * 0.31], 0.019, matte));
    g.add(rod([bx + 0.02, by - 0.004, s * 0.17], [bx - 0.01, by - 0.03, s * 0.3], 0.006, alu));
  }
  const guard = at(new THREE.Mesh(new THREE.TorusGeometry(0.335, 0.02, 6, 24, 1.15), paint), 0.7, 0.3);   // front mudguard
  guard.rotation.z = 0.55; guard.scale.z = 3.2; g.add(guard);
  const hugger = at(new THREE.Mesh(new THREE.TorusGeometry(0.345, 0.02, 6, 24, 1.2), gloss), -0.7, 0.31);  // rear hugger
  hugger.rotation.z = 0.85; hugger.scale.z = 5; g.add(hugger);
  // frame spar, engine, swingarm, chain, the rear shock under the seat
  g.add(sculpt(outline([0.34, 0.97], [[0.16, 0.92], [0.02, 0.84], [-0.08, 0.73], [-0.13, 0.6], [-0.15, 0.47]], [[-0.05, 0.45]],
    [[-0.04, 0.56], [0.0, 0.66], [0.1, 0.77], [0.34, 0.885]]), () => 0.32, alu, 0.015));
  g.add(at(new THREE.Mesh(new RoundedBoxGeometry(0.4, 0.36, 0.26, 3, 0.04), engine), 0.1, 0.43));
  const arm = outline([-0.1, 0.505], [[-0.3, 0.475], [-0.52, 0.405], [-0.71, 0.345]], [[-0.745, 0.31], [-0.71, 0.275]], [[-0.5, 0.335], [-0.3, 0.4], [-0.11, 0.425]]);
  for (const z of [-0.135, 0.135]) g.add(at(extrude(arm, 0.025, 0.007, alu), 0, 0, z));
  g.add(axial(cyl(0.024, 0.024, 0.34, alu, -0.12, 0.465)), axial(cyl(0.02, 0.02, 0.32, alu, -0.7, 0.31)));   // pivot, rear axle
  const chain = new THREE.CatmullRomCurve3([[-0.02, 0.475], [-0.36, 0.44], [-0.7, 0.41], [-0.8, 0.31], [-0.7, 0.21], [-0.36, 0.31], [-0.02, 0.385], [0.025, 0.43]]
    .map(([x, y]) => new THREE.Vector3(x, y, -0.115)), true);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(chain, 80, 0.007, 5, true), gloss));
  g.add(sculpt(outline([-0.1, 0.87], [[-0.3, 0.86], [-0.48, 0.865]], [[-0.45, 0.76], [-0.32, 0.68], [-0.2, 0.66]], [[-0.12, 0.7]]), () => 0.2, matte, 0.015));
  g.add(rod([-0.155, 0.5, 0], [-0.22, 0.71, 0], 0.033, gold), rod([-0.15, 0.48, 0], [-0.23, 0.74, 0], 0.014, chrome));
  // the bodywork: fairing and tank in one piece, a black belly pan, the seat, the raised tail, the smoked screen
  const bodyW = (x, y) => (x > 0.66 ? 0.4 - 0.28 * smooth(0.66, 0.9, x) : x > 0.05 ? 0.4 + 0.03 * smooth(0.6, 0.3, x) : 0.43 - 0.13 * smooth(0.05, -0.13, x))
    * (1 - 0.28 * smooth(0.92, 1.1, y));
  g.add(sculpt(outline([0.885, 0.845],
    [[0.82, 0.885], [0.74, 0.925], [0.62, 0.965], [0.52, 1.0], [0.43, 1.04], [0.32, 1.085], [0.2, 1.105], [0.08, 1.09], [-0.02, 1.045], [-0.1, 0.97], [-0.13, 0.925]],
    [[-0.06, 0.875], [0.02, 0.8], [0.08, 0.7], [0.16, 0.6], [0.26, 0.52]],          // the engine shows below
    [[0.33, 0.475], [0.38, 0.47], [0.438, 0.562], [0.544, 0.635], [0.668, 0.669], [0.777, 0.67]],     // clear of the front wheel
    [[0.84, 0.745], [0.87, 0.8]]), bodyW, paint, 0.045));
  g.add(sculpt(outline([0.46, 0.66], [[0.36, 0.635], [0.28, 0.69]], [[0.36, 0.74], [0.47, 0.75]]), (x, y) => bodyW(x, y) + 0.008, matte, 0.012));   // a vent in the side
  g.add(sculpt(outline([0.4, 0.45], [[0.37, 0.34], [0.3, 0.25], [0.18, 0.205], [0.03, 0.2], [-0.06, 0.23]], [[-0.08, 0.3], [-0.03, 0.36]],
    [[0.1, 0.41], [0.26, 0.44]]), (x, y) => 0.32 - 0.12 * smooth(0.36, 0.2, y), gloss, 0.03));
  g.add(sculpt(outline([-0.115, 0.935], [[-0.17, 0.895], [-0.27, 0.878], [-0.38, 0.882], [-0.47, 0.905]], [[-0.48, 0.86]], [[-0.3, 0.85], [-0.13, 0.86]]),
    x => 0.27 - 0.05 * smooth(-0.2, -0.47, x), matte, 0.02));
  g.add(sculpt(outline([-0.13, 0.87], [[-0.3, 0.86], [-0.46, 0.875], [-0.56, 0.93], [-0.7, 0.97], [-0.84, 1.005], [-0.94, 1.03]], [[-0.95, 1.0]],
    [[-0.86, 0.96], [-0.72, 0.9], [-0.58, 0.83], [-0.42, 0.775], [-0.25, 0.77], [-0.14, 0.81]]),
    x => 0.3 - 0.04 * smooth(-0.13, -0.5, x) - 0.15 * smooth(-0.55, -0.95, x), paint, 0.03));
  g.add(sculpt(outline([0.8, 0.895], [[0.74, 0.96], [0.64, 1.04], [0.55, 1.095], [0.485, 1.125]], [[0.455, 1.11]], [[0.53, 1.01], [0.66, 0.955]]),
    (x, y) => 0.24 - 0.12 * smooth(0.92, 1.12, y), glass, 0.015));
  // the face: LED eyes either side of a ram-air intake; mirrors on stalks; the tail light and the plate under the tail
  const eyeMat = lit(new THREE.Color(1.7, 1.7, 1.55)); eyeMat.name = 'headlight';   // flashes when clicked (DOES.flash)
  for (const s of [-1, 1]) {
    const eye = at(box(0.075, 0.016, 0.01, eyeMat), 0.8, 0.8, s * 0.114); eye.rotation.set(0, s * 0.7, 0.35); g.add(eye);
    g.add(rod([0.64, 0.97, s * 0.16], [0.62, 1.01, s * 0.24], 0.008, gloss));
    const mirror = at(new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 10), paint), 0.61, 1.02, s * 0.27); mirror.scale.set(1.2, 0.5, 0.9); g.add(mirror);
    g.add(rod([-0.21, 0.43, s * 0.15], [-0.21, 0.43, s * 0.22], 0.012, alu), at(box(0.1, 0.06, 0.008, alu), -0.2, 0.47, s * 0.15));   // footpegs
  }
  g.add(at(box(0.03, 0.04, 0.08, gloss), 0.875, 0.81));
  g.add(at(box(0.03, 0.018, 0.09, lit(new THREE.Color(2, 0.15, 0.1))), -0.935, 0.995));
  g.add(rod([-0.84, 0.955, 0], [-0.9, 0.74, 0], 0.01, gloss));
  const plate = at(box(0.004, 0.1, 0.17, gloss), -0.905, 0.7); plate.rotation.z = -0.2; g.add(plate);
  // the exhaust on the right: a header under the belly pan to a short hexagonal silencer beside the back wheel, tipped up
  const canDir = new THREE.Vector3(-0.9, 0.42, 0).normalize(), canAt = new THREE.Vector3(-0.42, 0.56, 0.2);
  const pipe = new THREE.CatmullRomCurve3([[0.28, 0.42, 0.06], [0.24, 0.25, 0.09], [0.08, 0.21, 0.12], [-0.08, 0.26, 0.16], [-0.2, 0.38, 0.19]]
    .map(v => new THREE.Vector3(...v)).concat(canAt.clone().addScaledVector(canDir, -0.13)));
  g.add(new THREE.Mesh(new THREE.TubeGeometry(pipe, 30, 0.026, 10), titanium));
  const can = new THREE.Mesh(new THREE.CylinderGeometry(0.056, 0.064, 0.28, 6), silencer);
  can.position.copy(canAt); can.quaternion.setFromUnitVectors(UP, canDir); g.add(can);
  const tip = cyl(0.042, 0.042, 0.03, chrome); tip.position.copy(canAt).addScaledVector(canDir, 0.15); tip.quaternion.copy(can.quaternion); g.add(tip);
  return bake(g);
}
function climbingShoe(upperColour) {   // a downturned climbing shoe: its side outline made thick (toe at +x)
  const g = new THREE.Group();
  const upper = new THREE.Shape();
  upper.moveTo(0.0, 0.012);
  upper.quadraticCurveTo(-0.014, 0.045, 0.004, 0.08);
  upper.lineTo(0.03, 0.088);
  upper.quadraticCurveTo(0.06, 0.064, 0.09, 0.07);
  upper.quadraticCurveTo(0.15, 0.078, 0.2, 0.05);
  upper.quadraticCurveTo(0.245, 0.03, 0.262, 0.008);
  upper.quadraticCurveTo(0.25, -0.004, 0.225, 0.0);
  upper.quadraticCurveTo(0.15, 0.03, 0.09, 0.018);
  upper.quadraticCurveTo(0.04, 0.0, 0.0, 0.012);
  const rubber = new THREE.Shape();                    // the black rand and sole wrapping the toe and heel
  rubber.moveTo(0.0, 0.012);
  rubber.quadraticCurveTo(-0.014, 0.045, 0.004, 0.074);
  rubber.quadraticCurveTo(0.02, 0.034, 0.06, 0.024);
  rubber.quadraticCurveTo(0.14, 0.032, 0.19, 0.036);
  rubber.quadraticCurveTo(0.225, 0.038, 0.24, 0.028);
  rubber.quadraticCurveTo(0.25, 0.022, 0.262, 0.008);
  rubber.quadraticCurveTo(0.25, -0.004, 0.225, 0.0);
  rubber.quadraticCurveTo(0.15, 0.03, 0.09, 0.018);
  rubber.quadraticCurveTo(0.04, 0.0, 0.0, 0.012);
  // rounded across like the bike's fairing: a narrow heel, a broad forefoot, a pointed toe, narrower towards the top
  const across = (x, y) => (x < 0.17 ? 0.06 + 0.022 * smooth(0, 0.17, x) : 0.082 - 0.045 * smooth(0.17, 0.265, x)) * (1 - 0.3 * clamp(y / 0.09, 0, 1) ** 2);
  g.add(sculpt(upper, across, std(upperColour, { roughness: 0.75 }), 0.012));
  g.add(sculpt(rubber, (x, y) => across(x, y) + 0.006, std('#1b1a1b', { roughness: 0.95 }), 0.012));
  const strapMat = std('#2c3238', { roughness: 0.8, side: THREE.DoubleSide });
  for (const [x, y, a] of [[0.1, 0.074, -0.05], [0.15, 0.068, -0.35]]) {      // two velcro straps over the instep, wrapping it
    const r = across(x, y - 0.01) / 2 + 0.003;
    const s = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.018, 16, 1, true, 0, Math.PI), strapMat);
    s.position.set(x, y - r + 0.004, 0); s.rotation.z = Math.PI / 2 + a; g.add(s);
  }
  const loop = new THREE.Mesh(new THREE.TorusGeometry(0.012, 0.003, 6, 14), strapMat);
  loop.position.set(0.018, 0.096, 0); g.add(loop);
  return g;
}

const PLACEHOLDERS = {
  desk() {
    const g = new THREE.Group(), wood = woodMat(), dark = std('#302b2f');
    g.add(box(1.5, 0.05, 0.72, wood, 0, 0.735, 0));
    for (const z of [-0.32, 0.32]) g.add(box(0.05, 0.71, 0.05, wood, -0.7, 0.355, z));
    g.add(box(0.42, 0.71, 0.66, wood, 0.52, 0.355, 0));                 // the drawer unit
    g.add(box(0.41, 0.69, 0.002, dark, 0.52, 0.355, 0.331));            // dark behind the fronts: the gaps between drawers
    const metal = std('#2a2829', { metalness: 0.6, roughness: 0.35 });
    for (const [y0, y1] of [[0.035, 0.27], [0.275, 0.49], [0.495, 0.705]]) {   // three drawer fronts, a bar pull on each
      const y = (y0 + y1) / 2, top = y1 - 0.045;
      g.add(box(0.405, y1 - y0 - 0.004, 0.018, wood, 0.52, y, 0.341));
      g.add(rod([0.45, top, 0.364], [0.59, top, 0.364], 0.0055, metal));
      for (const x of [0.46, 0.58]) g.add(rod([x, top, 0.35], [x, top, 0.364], 0.004, metal));
    }
    return g;
  },
  monitor() {
    const g = new THREE.Group(), dark = std('#302b2f', { roughness: 0.4 });
    g.add(box(0.24, 0.015, 0.17, dark, 0, 0.008, 0), box(0.04, 0.2, 0.04, dark, 0, 0.11, -0.02), box(0.66, 0.4, 0.03, dark, 0, 0.4, 0));
    const screen = noShadow(new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.36), new THREE.MeshBasicMaterial({ map: screenTex })));
    screen.name = 'screen'; screen.position.set(0, 0.4, 0.016); g.add(screen);
    const fill = new THREE.PointLight('#bfe8f2', 0.3, 2.2, 2);      // the screen's glow on the desk
    fill.position.set(0, 0.4, 0.3); g.add(fill);
    return g;
  },
  keyboard() {
    const g = new THREE.Group();
    g.add(box(KW + 0.018, 0.016, KD + 0.018, std('#2b2a2e', { roughness: 0.6 }), 0, 0.008, 0));       // the case
    const caps = new THREE.Mesh(keycapGeometry(), std('#ffffff', { map: keyTex, roughness: 0.55 }));
    caps.position.y = 0.0195; caps.castShadow = true; caps.receiveShadow = true; g.add(caps);
    return g;
  },
  mouse() {                              // a mouse pad and a mouse: an egg-shaped outline, rounded on top
    const g = new THREE.Group();
    g.add(box(0.25, 0.004, 0.21, cloth('#33403a', 2, 2), 0, 0.002, 0));
    const outline = new THREE.Shape(); outline.absellipse(0, 0, 0.022, 0.04, 0, Math.PI * 2);
    const geo = new THREE.ExtrudeGeometry(outline, { depth: 0.008, bevelEnabled: true, bevelThickness: 0.016, bevelSize: 0.012, bevelSegments: 8, curveSegments: 32 });
    geo.rotateX(-Math.PI / 2);
    const body = new THREE.Mesh(geo, std('#e6e1d8', { roughness: 0.45 }));
    body.scale.y = 0.75; body.position.y = 0.004 + 0.016 * 0.75; body.castShadow = true; g.add(body);
    const wheel = cyl(0.006, 0.006, 0.006, std('#3a3a3c'), 0, 0.03, -0.022, 16); wheel.rotation.z = Math.PI / 2; g.add(wheel);
    g.add(box(0.0015, 0.004, 0.035, std('#9a958d'), 0, 0.0335, -0.024));
    return g;
  },
  mug() {
    const g = new THREE.Group(), clay = std('#d7c5b2', { roughness: 0.5, side: THREE.DoubleSide });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.038, 0.1, 28, 1, true), clay);
    body.position.y = 0.05; g.add(body);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.0405, 0.0028, 6, 28), clay);   // the lip: the mug has a thickness
    rim.rotation.x = Math.PI / 2; rim.position.y = 0.1; g.add(rim);
    const base = new THREE.Mesh(new THREE.CircleGeometry(0.038, 28), clay); base.rotation.x = -Math.PI / 2; base.position.y = 0.002; g.add(base);
    const tea = new THREE.Mesh(new THREE.CircleGeometry(0.04, 28), std('#9a5f2c', { roughness: 0.2 }));
    tea.rotation.x = -Math.PI / 2; tea.position.y = 0.085; g.add(tea);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.008, 8, 20), clay); handle.position.set(0.046, 0.052, 0); g.add(handle);
    return g;
  },
  clock() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new RoundedBoxGeometry(0.17, 0.08, 0.07, 3, 0.012), std('#262427', { roughness: 0.4 }));
    body.position.y = 0.04; g.add(body);
    const face = noShadow(new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.064),
      new THREE.MeshBasicMaterial({ map: clockTex, color: new THREE.Color(3, 3, 3) })));   // bright enough to glow
    face.name = 'clock-face'; face.position.set(0, 0.042, 0.0355); g.add(face);
    return g;
  },
  phone() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.009, 0.155, 2, 0.0042), std('#1b1b1d', { roughness: 0.3, metalness: 0.4 }));
    body.position.y = 0.0045; g.add(body);
    const screen = noShadow(new THREE.Mesh(new THREE.PlaneGeometry(0.068, 0.145), new THREE.MeshBasicMaterial({ map: phoneTex })));
    screen.name = 'phone-screen'; screen.rotation.x = -Math.PI / 2; screen.position.y = 0.0092; g.add(screen);
    return g;
  },
  desklamp() {                           // a ceramic table lamp with a glowing fabric shade
    const g = new THREE.Group();
    const profile = new THREE.SplineCurve([[0, 0], [0.064, 0], [0.072, 0.008], [0.08, 0.05], [0.084, 0.09], [0.074, 0.14], [0.048, 0.185],
      [0.025, 0.204], [0.017, 0.212], [0, 0.214]].map(([r, y]) => new THREE.Vector2(r, y))).getPoints(60);   // a smooth glazed pot
    g.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 40), std('#8fa79c', { roughness: 0.35 })));
    g.add(cyl(0.008, 0.008, 0.14, std('#b8955a', { metalness: 0.8, roughness: 0.3 }), 0, 0.27, 0, 10));
    g.add(lampShade(0.1, 0.14, 0.17, 0.39, 1.4));
    return g;
  },
  bed() {                                // a single bed, head at -z: frame, mattress, duvet with a folded edge, pillows, a throw
    const g = new THREE.Group(), wood = woodMat();
    const soft = (w, h, d, colour, x, y, z, r = 0.04) => {
      const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), cloth(colour, w / 0.3, d / 0.3));
      m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m;
    };
    g.add(box(1.0, 0.08, 1.98, wood, 0, 0.24, 0));
    for (const [x, z] of [[-0.46, -0.95], [0.46, -0.95], [-0.46, 0.95], [0.46, 0.95]]) g.add(box(0.06, 0.2, 0.06, wood, x, 0.1, z));
    g.add(soft(1.0, 0.62, 0.07, '#8e7b6a', 0, 0.55, -0.955, 0.03));                  // upholstered headboard (clear of both walls)
    g.add(soft(0.96, 0.18, 1.9, '#efe9df', 0, 0.37, 0.02));                           // mattress
    // head to foot, nothing overlapping: pillows against the headboard, the cushions (objects.json) leaning on them, then the duvet
    // (the cushions are measured against all of these: none of them pokes into another, owner 2026-11-06)
    g.add(soft(0.98, 0.08, 1.13, '#9fb0a6', 0, 0.48, 0.405, 0.035));                  // duvet
    g.add(soft(0.025, 0.19, 1.13, '#9fb0a6', -0.495, 0.385, 0.405, 0.011));           // hanging over the room side
    g.add(soft(0.99, 0.07, 0.2, '#e9e4da', 0, 0.5, -0.06, 0.03));                     // its folded-back edge
    const p1 = soft(0.42, 0.11, 0.3, '#f4f1ec', -0.23, 0.52, -0.76, 0.05); p1.rotation.x = -0.18;
    const p2 = soft(0.42, 0.11, 0.3, '#d7c5b2', 0.23, 0.52, -0.76, 0.05); p2.rotation.x = -0.18;
    g.add(p1, p2);                                                                     // pillows
    // A rust throw across the foot: it lies on the duvet from the wall side, bends over the room-side edge and hangs
    // down in soft folds (deeper towards the hem). A plane bent into shape, along u (across the bed) and v (along it).
    const top = 0.527, edge = -0.535, r = 0.04, flat = 1.0, arc = (r * Math.PI) / 2, drop = 0.2, len = flat + arc + drop;
    const throwGeo = new THREE.PlaneGeometry(1, 0.46, 48, 10), q = throwGeo.attributes.position;
    for (let i = 0; i < q.count; i++) {
      const u = (q.getX(i) + 0.5) * len, v = q.getY(i);
      let x, y;
      if (u < flat) [x, y] = [edge + flat - u, top];
      else if (u < flat + arc) { const a = (u - flat) / r; [x, y] = [edge - r * Math.sin(a), top - r + r * Math.cos(a)]; }
      else [x, y] = [edge - r, top - r - (u - flat - arc)];
      const hang = Math.max(0, u - flat) / (arc + drop);
      q.setXYZ(i, x - 0.012 * hang * Math.sin(v * 40), y + 0.002 * Math.sin(u * 9) * (1 - hang), 0.7 + v);
    }
    throwGeo.computeVertexNormals();
    g.add(new THREE.Mesh(throwGeo, cloth('#b5643c', len / 0.3, 0.46 / 0.3, { side: THREE.DoubleSide })));
    return g;
  },
  wallshelf() {                          // a floating shelf with two books and a small succulent
    const g = new THREE.Group();
    g.add(box(0.72, 0.025, 0.2, woodMat()));
    g.add(box(0.035, 0.2, 0.15, std('#26364f'), -0.31, 0.1125, 0), box(0.03, 0.18, 0.14, std('#d7c5b2'), -0.275, 0.1025, 0));
    const plant = new THREE.Group();     // a snake plant (you look up at the shelf: its leaves stand tall) in a terracotta pot
    const pot = new THREE.SplineCurve([[0.028, 0], [0.033, 0.004], [0.037, 0.05], [0.038, 0.053], [0.043, 0.055], [0.044, 0.07], [0.04, 0.072],
      [0.037, 0.066], [0, 0.062]].map(([r, y]) => new THREE.Vector2(r, y))).getPoints(40);
    pot.unshift(new THREE.Vector2(0, 0));
    plant.add(new THREE.Mesh(new THREE.LatheGeometry(pot, 28), std('#b5643c', { roughness: 0.9 })));
    const blade = new THREE.ConeGeometry(1, 1, 10).translate(0, 0.5, 0), leafMat = std('#4f7a4a', { roughness: 0.55 });
    for (const [a, h, lean] of [[0, 0.2, 0.06], [1.3, 0.16, 0.2], [2.4, 0.18, 0.14], [3.5, 0.13, 0.26], [4.4, 0.17, 0.16], [5.4, 0.14, 0.22], [0.7, 0.12, 0.3]]) {
      const leaf = new THREE.Mesh(blade, leafMat);
      leaf.scale.set(0.0045, h, 0.013);                  // a flat, pointed blade, its face outwards, leaning out towards a
      leaf.rotation.set(0, -a, -lean, 'YXZ');
      leaf.position.set(Math.cos(a) * 0.012, 0.055, Math.sin(a) * 0.012);
      plant.add(leaf);
    }
    const baked = bake(plant); baked.position.set(-0.17, 0.0125, 0); g.add(baked);
    return g;
  },
  bookshelf() {
    const g = new THREE.Group(), wood = woodMat();
    g.add(box(0.03, 1.5, 0.32, wood, -0.42, 0.75, 0), box(0.03, 1.5, 0.32, wood, 0.42, 0.75, 0), box(0.87, 1.5, 0.015, wood, 0, 0.75, -0.155));
    for (const y of [0.05, 0.55, 1.02, 1.49]) g.add(box(0.87, 0.03, 0.32, wood, 0, y, 0));
    // A shelf per year of the degree, the top one first, a book per course (content.json "bookshelf"): they stand in a row
    // from the left, the last one leaning; on a shelf with room to spare the last two lie in a stack, then a basket.
    // The books are one shape; hovering one says its name (userData.titles, twelve triangles a book).
    const shelves = (content.bookshelf?.shelves || []).slice(0, 3), all = shelves.flatMap(sh => sh.books || []);
    if (!all.length) return g;
    const atlas = bookAtlas(all), parts = [], titles = [];
    const put = (t, h, d, x, y, z, rz = 0, ry = 0) => {
      const geo = atlas.geometry(parts.length, t, h, d);
      geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0, ry, rz)).setPosition(x, y, z));
      titles.push(all[parts.length].join(' · ')); parts.push(geo);
    };
    const depth = h => clamp(h * 0.72, 0.14, 0.22), zOf = d => 0.145 - d / 2 - rand() * 0.008;   // spines near the front
    shelves.forEach((shelf, i) => {
      const top = [1.035, 0.565, 0.065][i], books = (shelf.books || []).map(([code, title]) => {
        const h = /^LA/.test(code) ? 0.215 + rand() * 0.02 : 0.245 + rand() * 0.055;   // the language courses: slim workbooks
        return [h, clamp(0.024 + title.length * 0.00045 + rand() * 0.008, 0.024, 0.05)];
      });
      const total = books.reduce((sum, [, t]) => sum + t + 0.002, 0), spare = 0.8 - total;
      const stack = spare > 0.45 && books.length > 3 ? books.splice(-2) : [];
      let x = -0.395;
      books.forEach(([h, t], k) => {
        const d = depth(h);
        if (k === books.length - 1 && !stack.length && spare > 0.12) {    // the last one leans on its neighbour
          const a = 0.2;
          put(t, h, d, x + (t / 2) * Math.cos(a) + (h / 2) * Math.sin(a), top + (t / 2) * Math.sin(a) + (h / 2) * Math.cos(a), zOf(d), a);
        } else { put(t, h, d, x + t / 2, top + h / 2, zOf(d)); x += t + 0.002; }
      });
      if (stack.length) {
        const cx = x + 0.03 + Math.max(...stack.map(([h]) => h)) / 2;
        let y = top;
        for (const [h, t] of stack) { const d = depth(h); put(t, h, d, cx + (rand() - 0.5) * 0.012, y + t / 2, zOf(d), Math.PI / 2, (rand() - 0.5) * 0.08); y += t; }
        if (0.395 - (cx + 0.16) > 0.24) {                                     // a woven basket in the space left, a blanket folded in it
          const bx = 0.395 - 0.13, bz = -0.005, bw = 0.26, bh = 0.19, bd = 0.27, t = 0.01, y = top + bh / 2;
          const weave = canvasTexture(128, 128, (ctx, w) => {                 // basket weave: three strands a square, turning each square
            ctx.fillStyle = '#4e3c29'; ctx.fillRect(0, 0, w, w);
            const c = w / 8;
            for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) for (let k = 0; k < 3; k++) {
              ctx.fillStyle = ['#b08d5e', '#a07e4e', '#bd9c69'][k];
              const o = 1 + (k * (c - 2)) / 3, s = (c - 2) / 3 - 1;
              if ((i + j) % 2) ctx.fillRect(i * c + 1, j * c + o, c - 2, s); else ctx.fillRect(i * c + o, j * c + 1, s, c - 2);
            }
          });
          weave.wrapS = weave.wrapT = THREE.RepeatWrapping; weave.repeat.set(2, 1.5);
          const wicker = std('#ffffff', { map: weave, roughness: 0.9 }), rim = std('#8a6c45', { roughness: 0.85 });
          g.add(box(bw, t, bd, wicker, bx, top + t / 2, bz));
          for (const s of [-1, 1]) g.add(box(bw, bh, t, wicker, bx, y, bz + s * (bd - t) / 2), box(t, bh, bd, wicker, bx + s * (bw - t) / 2, y, bz));
          const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => [bx + (sx * (bw - t)) / 2, top + bh, bz + (sz * (bd - t)) / 2]);
          C.forEach((p, k) => g.add(rod(p, C[(k + 1) % 4], 0.008, rim)));      // a rolled rim
          const blanket = new THREE.Mesh(new RoundedBoxGeometry(bw - 2 * t - 0.006, 0.13, bd - 2 * t - 0.006, 3, 0.035), cloth('#e6dccb', 2, 2));
          blanket.position.set(bx, top + bh - 0.075, bz); g.add(blanket);
        }
      }
      const label = canvasTexture(256, 64, (ctx, w, h) => {                  // a label-maker strip on the shelf's edge
        ctx.fillStyle = '#1d1d1f'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#f2f0ea'; ctx.font = `700 34px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText((shelf.label || '').toUpperCase(), w / 2, h / 2 + 1);
      }, { fonts: true });
      const tape = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.02), std('#ffffff', { map: label, roughness: 0.5 }));
      tape.position.set(-0.3, top - 0.015, 0.1606); g.add(tape);
    });
    const books = new THREE.Mesh(mergeGeometries(parts), std('#ffffff', { map: atlas.tex, roughness: 0.75 }));
    books.castShadow = true; books.receiveShadow = true; books.userData.titles = titles; g.add(books);
    const vase = new THREE.SplineCurve([[0.045, 0], [0.06, 0.03], [0.068, 0.075], [0.058, 0.13], [0.034, 0.165], [0.03, 0.19], [0.034, 0.2],
      [0.029, 0.2], [0.025, 0.185], [0, 0.18]].map(([r, y]) => new THREE.Vector2(r, y))).getPoints(50);
    vase.unshift(new THREE.Vector2(0, 0));
    const pot = new THREE.Mesh(new THREE.LatheGeometry(vase, 32), std('#d7c5b2', { roughness: 0.45 }));     // a stoneware vase on top
    pot.position.set(-0.25, 1.505, 0); g.add(pot);
    return g;
  },
  flag() {                               // a cloth flag hung from a thin rod, with a gentle ripple
    const g = new THREE.Group();
    const geo = new THREE.PlaneGeometry(0.72, 0.48, 24, 1), p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, 0.012 + Math.sin(p.getX(i) * 14) * 0.008);
    geo.computeVertexNormals();
    const cloth = new THREE.Mesh(geo, std('#ffffff', { map: flagTex, roughness: 0.95, side: THREE.DoubleSide }));
    g.add(cloth);
    g.add(rod([-0.4, 0.255, 0.02], [0.4, 0.255, 0.02], 0.007, std('#b8955a', { metalness: 0.8, roughness: 0.3 })));
    return g;
  },
  poster(o) {                            // a print: the picture (o.image) above a title band, or the picture alone (o.fullbleed)
    const img = new Image();
    const tex = canvasTexture(512, 716, (ctx, w, h) => {
      const band = o.fullbleed ? 0 : 200, ah = h - band;
      ctx.fillStyle = '#14161c'; ctx.fillRect(0, 0, w, h);
      if (img.naturalWidth) {                                       // cover the space above the band
        const k = Math.max(w / img.naturalWidth, ah / img.naturalHeight), dw = img.naturalWidth * k, dh = img.naturalHeight * k;
        ctx.drawImage(img, (w - dw) / 2, (ah - dh) / 2, dw, dh);
      }
      if (band) {
        ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'alphabetic';
        let size = 104; ctx.font = `400 ${size}px Anton, Impact, sans-serif`;
        const tw = ctx.measureText(o.title || '').width;
        if (tw > w - 70) { size *= (w - 70) / tw; ctx.font = `400 ${size}px Anton, Impact, sans-serif`; }
        ctx.save(); ctx.translate(40, ah + 120); ctx.transform(1, 0, -0.2, 1, 0, 0); ctx.fillText(o.title || '', 0, 0); ctx.restore();
        ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.font = `600 20px ${SANS}`; ctx.fillText((o.caption || '').toUpperCase(), 36, h - 36);
      }
      speckle(ctx, w, h, 1200);
    }, { fonts: true });
    if (o.image) { img.onload = () => tex.redraw(); img.src = o.image; }      // lazy: the picture arrives later
    const g = new THREE.Group();
    g.add(box(0.52, 0.72, 0.008, std('#e9e4da'), 0, 0, -0.004));
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.7), std('#ffffff', { map: tex, roughness: 0.9 }));
    sheet.position.z = 0.0005; g.add(sheet);
    return g;
  },
  frame(o) {
    const g = new THREE.Group();
    const border = box(0.66, 0.46, 0.025, std('#2b2a2e', { roughness: 0.5 }));
    const mat = new THREE.Mesh(new THREE.PlaneGeometry(0.63, 0.43), std('#f1ece3'));
    const pic = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.4), std('#ffffff', { roughness: 0.8 }));
    mat.position.z = 0.013; pic.position.z = 0.0135; g.add(border, mat, pic);
    if (o.image) texLoader.load(o.image, tex => {
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      const a = tex.image.width / tex.image.height, [w, h] = a >= 1 ? [0.6, 0.6 / a] : [0.6 * a, 0.6];
      pic.geometry.dispose(); pic.geometry = new THREE.PlaneGeometry(w, h);
      mat.geometry.dispose(); mat.geometry = new THREE.PlaneGeometry(w + 0.04, h + 0.04);
      border.scale.set((w + 0.08) / 0.66, (h + 0.08) / 0.46, 1);
      pic.material.map = tex; pic.material.needsUpdate = true;
      reshadow();
    });
    return g;
  },
  corkboard(o) {                         // a cork pinboard: polaroids of the folder named in o.photos (content.json), pinned crooked
    const g = new THREE.Group(), BW = 0.62, BH = 0.46, f = 0.022, wood = woodMat('#c9ab8c');
    const cork = std('#ffffff', { roughness: 1, map: canvasTexture(192, 142, (ctx, w, h) => {   // plain cork, a faint grain
      ctx.fillStyle = '#b88a5c'; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 1400; i++) {
        ctx.fillStyle = rand() < 0.55 ? 'rgba(90,55,25,0.16)' : 'rgba(225,180,130,0.16)';
        ctx.fillRect(rand() * w, rand() * h, 1 + rand(), 1 + rand());
      }
    }) });
    g.add(box(BW, BH, 0.012, cork, 0, 0, 0.006));
    g.add(box(BW + 2 * f, f, 0.02, wood, 0, BH / 2 + f / 2, 0.01), box(BW + 2 * f, f, 0.02, wood, 0, -BH / 2 - f / 2, 0.01),
          box(f, BH, 0.02, wood, -BW / 2 - f / 2, 0, 0.01), box(f, BH, 0.02, wood, BW / 2 + f / 2, 0, 0.01));
    const SPOTS = [[-0.215, 0.085, -5], [-0.072, 0.09, 3], [0.072, 0.08, -2], [0.215, 0.088, 6], [-0.15, -0.095, 4], [0, -0.09, -4], [0.15, -0.097, 2]];
    const PINS = ['#c8402f', '#e2b23c', '#3f8a7a', '#f2efe8', '#3f6fb5'];
    const PW = 0.118, PH = 0.142;                       // an instant photo (a little bigger than life, to read from the chair)
    (folders[o.photos]?.items || []).slice(0, SPOTS.length).forEach((it, i) => {
      const img = new Image();
      const tex = canvasTexture(256, 307, (ctx, w, h) => {
        const m = 14, s = w - 2 * m;
        ctx.fillStyle = '#f6f2e9'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#2b2a2e'; ctx.fillRect(m, m, s, s);
        if (img.naturalWidth) {
          const k = Math.min(img.naturalWidth, img.naturalHeight);
          ctx.drawImage(img, (img.naturalWidth - k) / 2, (img.naturalHeight - k) / 2, k, k, m, m, s, s);
        }
        ctx.fillStyle = '#2d2b30'; ctx.font = '600 30px Caveat, "Segoe Print", cursive';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(it.title || '', w / 2, (m + s + h) / 2 + 1);
        speckle(ctx, w, h, 300);
      }, { fonts: true });
      if (it.thumb || it.image) { img.onload = () => tex.redraw(); img.src = it.thumb || it.image; }   // lazy
      const [x, y, deg] = SPOTS[i], pin = new THREE.Group(), hang = new THREE.Group();
      const snap = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), std('#ffffff', { map: tex, roughness: 0.75 }));
      snap.position.y = -PH / 2 + 0.01; snap.castShadow = true; snap.receiveShadow = true;
      hang.rotation.x = -0.06; hang.add(snap);                                // hangs from the pin: the bottom lifts a little
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.0065, 12, 8), std(PINS[i % PINS.length], { roughness: 0.35 }));
      head.position.z = 0.007; head.castShadow = true;
      pin.add(hang, head);
      pin.position.set(x, y + PH / 2 - 0.01, 0.0135 + i * 0.0008); pin.rotation.z = rad(deg);
      g.add(pin);
    });
    return g;
  },
  trophy() {
    // A loving cup on a stepped plinth: one turned shape (foot, stem with a knop, the bowl and its lip, hollow inside),
    // ear handles, a brass plate. Gold with no reflections to show reads as brown when fully metallic, so: half.
    const g = new THREE.Group(), gold = std('#dcae55', { metalness: 0.5, roughness: 0.3 }), base = std('#2a2628', { roughness: 0.45 });
    g.add(box(0.13, 0.032, 0.13, base, 0, 0.016, 0), box(0.1, 0.03, 0.1, base, 0, 0.047, 0));
    g.add(box(0.064, 0.018, 0.002, std('#c9a45a', { metalness: 0.4, roughness: 0.4 }), 0, 0.017, 0.066));
    const cup = new THREE.SplineCurve([[0.034, 0], [0.034, 0.006], [0.02, 0.014], [0.009, 0.03], [0.008, 0.045], [0.016, 0.053], [0.008, 0.061],
      [0.009, 0.075], [0.03, 0.085], [0.05, 0.1], [0.06, 0.125], [0.064, 0.155], [0.066, 0.162], [0.061, 0.162], [0.056, 0.13],
      [0.04, 0.1], [0, 0.092]].map(([r, y]) => new THREE.Vector2(r, y))).getPoints(90);
    cup.unshift(new THREE.Vector2(0, 0));
    const turned = new THREE.Mesh(new THREE.LatheGeometry(cup, 40), gold); turned.position.y = 0.062; g.add(turned);
    for (const s of [-1, 1]) {                       // an ear from low on the bowl, out and up, back in under the lip
      const path = [[0.046, 0.1], [0.07, 0.096], [0.088, 0.115], [0.086, 0.142], [0.062, 0.15]].map(([x, y]) => new THREE.Vector3(s * x, 0.062 + y, 0));
      g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(path), 24, 0.0055, 8), gold));
    }
    return g;
  },
  minibike() {                           // a model motorbike on a little wall shelf, turned a little towards you
    const g = new THREE.Group(), bike = motorbike();
    bike.scale.setScalar(0.22); bike.position.y = 0.011; bike.rotation.y = 0.2; g.add(bike);
    g.add(box(0.56, 0.022, 0.17, woodMat(), 0, 0, -0.015));
    for (const x of [-0.2, 0.2]) g.add(box(0.02, 0.1, 0.02, std('#302b2f'), x, -0.06, -0.09));
    return g;
  },
  shoes() {                              // a pair of climbing shoes on a little shelf of their own, beside the bike's
    const g = new THREE.Group();
    g.add(box(0.5, 0.022, 0.22, woodMat(), 0, 0, 0.01));               // from the wall (z -0.1) out 22 cm
    for (const x of [-0.2, 0.2]) g.add(box(0.02, 0.1, 0.02, std('#302b2f'), x, -0.06, -0.09));
    // life size, side by side and well apart along the shelf, so from the chair you see two shoes, not one (toes at +x)
    for (const [x, z, turn] of [[-0.215, -0.05, 0], [-0.045, 0.055, -0.05]]) {
      const shoe = climbingShoe('#f0a214');                          // yellow, like classic bouldering shoes
      shoe.position.set(x, 0, z); shoe.rotation.y = turn;
      shoe.position.y = 0.011 - new THREE.Box3().setFromObject(shoe).min.y;   // standing on the shelf
      g.add(shoe);
    }
    return g;
  },
  lion() {                               // a plush lion (NUS's mascot is a lion) in an NUS-blue scarf: opens Education
    const g = new THREE.Group();
    const fur = cloth('#d9a243', 3, 3), mane = cloth('#9e5a2c', 3, 3), cream = cloth('#f0dfc0', 2, 2);
    const ink = std('#231c1a', { roughness: 0.35 });
    const ball = (parent, r, mat, x, y, z, sx = 1, sy = 1, sz = 1) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), mat);
      m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
    };
    ball(g, 0.05, fur, 0, 0.05, -0.005, 1, 1.05, 0.95);                // body, sitting
    for (const s of [-1, 1]) {
      ball(g, 0.022, fur, s * 0.036, 0.02, 0.035, 1, 0.85, 1.45);       // back legs, stuck out in front
      ball(g, 0.014, cream, s * 0.038, 0.018, 0.066, 1, 0.9, 0.6);      // their paws
      ball(g, 0.015, fur, s * 0.026, 0.05, 0.042, 1, 1.7, 1);           // front legs
    }
    const tail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([[0, 0.02, -0.05], [0.04, 0.015, -0.07],
      [0.07, 0.04, -0.06], [0.075, 0.07, -0.045]].map(p => new THREE.Vector3(...p))), 16, 0.005, 6), fur);
    tail.castShadow = true; g.add(tail);
    ball(g, 0.012, mane, 0.075, 0.075, -0.043);                        // the tuft
    const head = new THREE.Group(); head.position.set(0, 0.128, 0.01); g.add(head);
    ball(head, 0.05, mane, 0, 0, -0.016, 1, 1, 0.55);                  // the mane: a disc behind the face, with a ruff
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; ball(head, 0.021, mane, Math.cos(a) * 0.045, Math.sin(a) * 0.045, -0.006, 1, 1, 0.75); }
    ball(head, 0.039, fur, 0, 0, 0.01);                                // face
    for (const s of [-1, 1]) {
      ball(head, 0.012, fur, s * 0.032, 0.034, 0.004, 1, 1, 0.6);       // ears
      ball(head, 0.0055, ink, s * 0.015, 0.01, 0.045);                  // eyes
    }
    ball(head, 0.018, cream, 0, -0.013, 0.04, 1.25, 0.85, 0.8);        // muzzle
    ball(head, 0.0075, ink, 0, -0.004, 0.056, 1.3, 0.9, 0.8);          // nose
    const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.037, 0.009, 8, 28), cloth('#003d7c', 4, 1));
    scarf.rotation.x = Math.PI / 2; scarf.position.set(0, 0.092, 0.002); scarf.castShadow = true; g.add(scarf);
    const end = box(0.02, 0.045, 0.007, std('#ef7c00', { roughness: 0.95 }), 0.017, 0.07, 0.042); end.rotation.z = 0.25; g.add(end);
    return g;
  },
};

// ------------------------------------------------------------------ objects from objects.json (your models, or the placeholders)
const interactive = [];              // things that open a folder ("opens"), say something on hover ("tip") or do something ("does")
interactive.push(fairyPick);
const gltf = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/');
gltf.setDRACOLoader(draco);

// In your own models, name a mesh "screen", "clock-face" or "phone-screen" and the live picture goes on it.
const LIVE = { screen: screenTex, 'clock-face': clockTex, 'phone-screen': phoneTex };

const blobTex = canvasTexture(128, 128, (ctx, w, h) => {
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(0.55, 'rgba(0,0,0,0.22)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
});
const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
const STANDING = new Set(['desk', 'monitor', 'keyboard', 'mouse', 'mug', 'clock', 'phone', 'desklamp', 'trophy', 'bookshelf', 'bed', 'lion']);
function contactShadow(group) {
  const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
  const blob = noShadow(new THREE.Mesh(new THREE.PlaneGeometry(size.x * 1.3 + 0.04, size.z * 1.3 + 0.04), blobMat));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.002;
  group.add(blob);
}

function place(group, o) {
  if (STANDING.has(o.placeholder)) contactShadow(group);          // measured before the group is moved into place
  const [x, y, z] = o.position || [0, 0, 0], [rx, ry, rz] = (o.rotation || [0, 0, 0]).map(rad);
  group.position.set(x, y, z);
  group.rotation.set(rx, ry, rz);
  group.scale.setScalar(o.scale || 1);
  group.traverse(m => {
    if (!m.isMesh) return;
    if (o.model && LIVE[m.name]) m.material = new THREE.MeshBasicMaterial({ map: LIVE[m.name] });
    if (m.raycast !== THREE.Mesh.prototype.raycast) return;       // screens and glass: no shadows
    m.castShadow = true; m.receiveShadow = true;
  });
  world.add(group);
  if (o.opens || o.tip || o.does) {
    group.userData.entry = o;
    group.userData.glowMeshes = [];
    group.traverse(m => {
      if (m.isMesh && m.material?.emissive && !lamps.some(l => l.shade === m.material)) {
        m.userData.e0 = { c: m.material.emissive.clone(), i: m.material.emissiveIntensity };
        group.userData.glowMeshes.push(m);
      }
    });
    interactive.push(group);
  }
  reshadow();
  return group;
}
function unplace(group) {
  world.remove(group);
  if (interactive.includes(group)) interactive.splice(interactive.indexOf(group), 1);
  reshadow();
}
// The placeholder shows at once; a model (if any) downloads when the browser is idle and then takes its place.
function build(o) {
  const stand = PLACEHOLDERS[o.placeholder] ? place(PLACEHOLDERS[o.placeholder](o), o) : null;
  if (!o.model) return;
  later(() => gltf.load(`room/models/${o.model.replace(/^models\//, '')}`, res => {
    if (stand) unplace(stand);
    place(res.scene, o);
  }, undefined, err => console.warn(`room: ${o.model} didn't load (${err?.message || err}); keeping the placeholder`)));
}

const getJSON = url => fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .catch(err => { console.error(`room: ${url} could not be read`, err); return null; });
Promise.all([getJSON('room/content.json'), getJSON('room/objects.json')]).then(([c, o]) => {
  if (c?.folders) content = c;
  folders = Object.fromEntries(content.folders.map(f => [f.id, f]));
  buildDesktop();
  screenTex.redraw();
  for (const obj of o?.objects || []) {
    try { build(obj); } catch (err) { console.error(`room: couldn't build ${obj.id}`, err); }
  }
  applyTime();                                         // the lamps exist now
  requestAnimationFrame(finishLoading);                // the room is drawn: lift the loading screen
});
Promise.all([document.fonts.load('80px Anton'), document.fonts.load('600 30px Caveat')]).then(() => document.fonts.ready)
  .then(() => redrawWithFonts.forEach(t => t.redraw())).catch(() => {});

let ready = false;
function finishLoading() {
  if (ready) return;
  ready = true;
  $('bar').style.width = '100%';
  setTimeout(() => $('loading').classList.add('done'), 150);
  const id = decodeURIComponent(location.hash.slice(1));      // index.html#projects, #computer
  if (id === 'computer') sitDown();
  else if (folders[id]) { sitDown(); setTimeout(() => openFolder(id), STILL ? 0 : 700); }
}
setTimeout(finishLoading, 6000);                             // never stay stuck on the loading screen

// ------------------------------------------------------------------ the computer's desktop and its window (HTML over the room)
// The desktop's icons (folders, then the CVs as PDFs) and the folder window's sidebar: the same folders, so you can go
// from one to another without closing the window, and the CVs to download.
function buildDesktop() {
  const desk = content.folders.filter(f => f.desktop), cvs = content.cvs || [];
  const icons = desk.map(f => {
    const b = el('button', null, { className: 'icon', type: 'button' });
    b.append(iconArt('folder', f.icon), el('span', f.name, { className: 'name' }));
    b.addEventListener('click', () => openFolder(f.id));
    return b;
  });
  for (const cv of cvs) {
    const a = el('a', null, { className: 'icon', href: cv.file, download: '' });
    a.append(iconArt('pdf'), el('span', `${cv.name}.pdf`, { className: 'name' }));
    icons.push(a);
  }
  $('icons').replaceChildren(...icons);
  const places = [el('h4', 'Desktop')];
  for (const f of desk) {
    const b = el('button', null, { type: 'button' });
    b.dataset.id = f.id;
    b.append(el('span', f.icon), f.name);
    b.addEventListener('click', () => openFolder(f.id));
    places.push(b);
  }
  if (cvs.length) places.push(el('h4', 'Downloads'));
  for (const cv of cvs) {
    const a = el('a', null, { href: cv.file, download: '' });
    a.append(el('span', '📄'), `${cv.name}.pdf`);
    places.push(a);
  }
  $('win-places').replaceChildren(...places);
}
const isOn = id => $(id).classList.contains('on');
function show(id) { $(id).classList.add('on'); $(id).setAttribute('aria-hidden', 'false'); }
function hide(id) { $(id).classList.remove('on'); $(id).setAttribute('aria-hidden', 'true'); }

// ------------------------------------------------------------------ where you look: drag / swipe, wheel / pinch, the arrow keys
const SEAT = new THREE.Vector3(0, 1.2, 0.72);
const PITCH = [-0.8, 0.6], FOV = [35, 72];
const startYaw = () => (innerWidth > innerHeight ? 0.2 : 0);      // wide screens see the window and the desk at once
const view = { pos: SEAT.clone(), posT: SEAT.clone(), yaw: startYaw(), yawT: startYaw(), pitch: -0.05, pitchT: -0.05, fov: baseFov(), fovT: baseFov() };
// You can turn until the edge of the picture is about 97 degrees to either side: the front half of the room, no more.
const yawLimit = () => Math.max(0.2, rad(97) - Math.atan(Math.tan(rad(view.fov) / 2) * camera.aspect));
let mode = 'room';             // 'room': looking around; 'computer': sitting at the desktop
let opened = false;            // has the visitor opened anything yet? (until then, clickable things glow now and then)
let hovered = null, pending = null, sitTimer = 0, tipTimer = 0;
const canvas = renderer.domElement;
canvas.style.cursor = 'grab';
const pointers = new Map();
let press = null, pinch = 0;
const spread = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) press = { moved: 0, type: e.pointerType };
  else { press = null; pinch = spread(); }
  if (e.pointerType === 'mouse') canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('pointermove', e => {
  const p = pointers.get(e.pointerId);
  if (!p) { if (e.pointerType === 'mouse') hover(e); return; }
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (mode !== 'room') return;
  if (pointers.size === 1) {
    const k = (TOUCH ? 0.006 : 0.0045) * (view.fov / 58);      // slower when zoomed in
    view.yawT += dx * k;
    view.pitchT = clamp(view.pitchT + dy * k, ...PITCH);
    if (press && (press.moved += Math.abs(dx) + Math.abs(dy)) > 6) $('hint').style.opacity = 0;
  } else if (pointers.size === 2) {
    const s = spread();
    view.fovT = clamp(view.fovT * (pinch / s), ...FOV);
    pinch = s;
  }
});
function release(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (e.type === 'pointerup' && press && pointers.size === 0 && press.moved <= (press.type === 'mouse' ? 6 : 12)) tap(e, press.type);
  if (pointers.size === 0) press = null;
  if (e.pointerType === 'mouse') canvas.style.cursor = hovered?.userData.entry.opens ? 'pointer' : 'grab';
}
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('pointerleave', () => { if (!pointers.size) { hovered = null; $('tip').classList.remove('on'); } });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (mode === 'room') view.fovT = clamp(view.fovT + e.deltaY * 0.02, ...FOV);
}, { passive: false });

addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (isOn('sheet')) hideSheet(); else if (isOn('win')) closeWin(); else if (mode === 'computer') standUp();
    return;
  }
  if (mode !== 'room' || e.target.closest?.('#win, #sheet, a, button')) return;
  const turn = { ArrowLeft: [0.3, 0], ArrowRight: [-0.3, 0], ArrowUp: [0, 0.2], ArrowDown: [0, -0.2] }[e.key];
  if (turn) { view.yawT += turn[0]; view.pitchT = clamp(view.pitchT + turn[1], ...PITCH); e.preventDefault(); }
});

// ------------------------------------------------------------------ pointing at things, clicking, tapping
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function hitAt(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.intersectObject(world, true)[0] || null;          // the nearest thing, so walls hide what's behind them
}
function groupOf(hit) {
  let o = hit?.object;
  while (o && !o.userData.entry) o = o.parent;
  return o || null;
}
const groupAt = (x, y) => groupOf(hitAt(x, y));
// What the pointer says: a book its own name (the shelf's books are one shape, twelve triangles a book), else the thing's.
const tipOf = (hit, g) => hit?.object.userData.titles?.[Math.floor(hit.faceIndex / 12)] ?? (g ? labelOf(g) : '');
function labelOf(g) {
  const { label, opens, tip, does } = g.userData.entry, f = folders[opens];
  if (!opens) return DOES[does]?.tip?.() || tip || label || '';
  return f && label && label !== f.name ? `${label} · ${f.name}` : label || f?.name || '';
}
function showTip(text, x, y) {
  const tip = $('tip');
  tip.textContent = text;
  tip.classList.toggle('on', !!text);
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
function hover(e) {
  const hit = mode === 'room' ? hitAt(e.clientX, e.clientY) : null, g = groupOf(hit);
  hovered = g;
  canvas.style.cursor = g?.userData.entry.opens || g?.userData.entry.does ? 'pointer' : 'grab';
  showTip(tipOf(hit, g), e.clientX, e.clientY);
}
function tap(e, type) {
  if (mode !== 'room') return;
  const hit = hitAt(e.clientX, e.clientY), g = groupOf(hit);
  if (!g) { hideSheet(); if (isOn('win')) closeWin(); return; }
  if (g.userData.entry.does && !g.userData.entry.opens) {        // the lamp, the lights: do it, and say what a click does now
    DOES[g.userData.entry.does].run(g);
    if (type === 'mouse') showTip(tipOf(hit, g), e.clientX, e.clientY);
    return;
  }
  if (!g.userData.entry.opens) {                               // something that only has a tip, like the mug or a book
    if (type !== 'mouse') {
      showTip(tipOf(hit, g), Math.max(12, e.clientX - 120), e.clientY - 70);
      clearTimeout(tipTimer); tipTimer = setTimeout(() => $('tip').classList.remove('on'), 2500);
    }
    return;
  }
  if (type === 'mouse') act(g); else askFirst(g);              // on a phone: "Open Hobbies?" first
}
function act(g) {
  DOES[g.userData.entry.does]?.run(g);                         // the lion hops, the bike flashes its headlight
  opened = true;
  $('hint').style.opacity = 0;
  if (g.userData.entry.opens === 'desktop') sitDown();
  else openFolder(g.userData.entry.opens, g);
}
// Things that do something when clicked (objects.json "does"). Small on purpose: each is a toggle or a second of motion.
const DOES = {
  lamp: { tip: () => (lampOn ? 'Turn the lamp off' : 'Turn the lamp on'), run: () => { lampOn = !lampOn; applyTime(); } },
  twinkle: { tip: () => 'Make them twinkle', run: () => twinkle() },
  hop: { run: g => hop(g) },
  flash: { run: g => flash(g) },
};
function twinkle() {                   // a wave of light runs round the string lights for two seconds
  const t0 = performance.now(), n = fairyBulbs.count, c = new THREE.Color();
  anims.add(() => {
    const s = (performance.now() - t0) / 1000, done = s > 2.2;
    for (let i = 0; i < n; i++) c.setScalar(done ? 1 : 0.2 + 0.8 * (0.5 + 0.5 * Math.cos((i / n) * Math.PI * 16 - s * 10)) ** 2), fairyBulbs.setColorAt(i, c);
    fairyBulbs.instanceColor.needsUpdate = true;
    return !done;
  });
}
function hop(g) {                      // two little hops (everything but its shadow on the desk)
  const parts = g.children.filter(c => c.material !== blobMat), t0 = performance.now();
  for (const p of parts) p.userData.y0 ??= p.position.y;
  anims.add(() => {
    const s = (performance.now() - t0) / 1000, up = s < 0.7 ? Math.abs(Math.sin((s / 0.7) * Math.PI * 2)) * 0.03 * (1 - s / 1.4) : 0;
    for (const p of parts) p.position.y = p.userData.y0 + up / g.scale.y;
    return s < 0.7;
  });
}
function flash(g) {                    // the headlight blinks twice
  const mats = [];
  g.traverse(m => { if (m.material?.name === 'headlight' && !mats.includes(m.material)) mats.push(m.material); });
  const base = mats.map(m => m.color.clone()), t0 = performance.now();
  anims.add(() => {
    const s = (performance.now() - t0) / 1000, on = s < 0.12 || (s > 0.24 && s < 0.36);
    mats.forEach((m, i) => m.color.copy(base[i]).multiplyScalar(on && s < 0.5 ? 3.5 : 1));
    return s < 0.5;
  });
}
function askFirst(g) {
  const { opens, label } = g.userData.entry;
  const computer = opens === 'desktop';
  $('sheet-text').replaceChildren(computer ? 'Use the computer?' : `Open ${folders[opens]?.name ?? opens}?`,
    el('small', computer ? 'Experience, projects, skills and my CVs' : label || ''));
  pending = g;
  show('sheet');
}
function hideSheet() { pending = null; hide('sheet'); }
$('sheet-open').addEventListener('click', () => { const g = pending; hideSheet(); if (g) act(g); });
$('sheet-cancel').addEventListener('click', hideSheet);

// Turn your head towards a thing (leaving room for the window on the right), or sit at the computer.
function turnTo(group) {
  const c = new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3()).sub(view.pos);
  view.fovT = baseFov() * 0.82;
  let off = 0;
  if (innerWidth > 760) {
    const frac = (Math.min(640, innerWidth * 0.92) + 24) / innerWidth;
    const half = Math.atan(Math.tan(rad(view.fovT) / 2) * camera.aspect);
    off = Math.atan(frac * Math.tan(half));
  }
  view.yawT = nearest(view.yaw, Math.atan2(-c.x, -c.z) - off);
  view.pitchT = clamp(Math.atan2(c.y, Math.hypot(c.x, c.z)), ...PITCH);
}
function openFolder(id, from = null) {
  const f = folders[id];
  if (!f) return;
  $('win-path').textContent = f.name;
  $('win-content').replaceChildren(...folderNodes(f));
  $('win-content').scrollTop = 0;
  const n = f.items?.length || 0;
  $('win-status').textContent = `${n} ${n === 1 ? 'item' : 'items'}`;
  for (const b of $('win-places').querySelectorAll('button')) b.classList.toggle('on', b.dataset.id === id);
  $('win').classList.toggle('side', mode !== 'computer');
  show('win');
  if (from && mode === 'room') turnTo(from);
  $('win-content').focus({ preventScroll: true });               // the keys scroll it; Escape closes it
}
function closeWin() {
  hide('win');
  if (mode === 'room') { document.activeElement?.blur(); view.fovT = baseFov(); }
}
function sitDown() {
  hideSheet(); hide('win'); $('tip').classList.remove('on');
  mode = 'computer'; hovered = null; opened = true;
  $('hint').style.opacity = 0;
  const screen = world.getObjectByName('screen');
  if (screen) {
    const p = screen.getWorldPosition(new THREE.Vector3());
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(screen.getWorldQuaternion(new THREE.Quaternion()));
    view.posT.copy(p).addScaledVector(n, 0.4);
    view.yawT = nearest(view.yaw, Math.atan2(n.x, n.z));
    view.pitchT = 0; view.fovT = 50;
  }
  clearTimeout(sitTimer);
  sitTimer = setTimeout(() => { show('desktop'); $('icons').querySelector('.icon')?.focus({ preventScroll: true }); }, screen && !STILL ? 650 : 0);
}
function standUp() {
  clearTimeout(sitTimer);
  hide('desktop'); hide('win');
  document.activeElement?.blur();
  mode = 'room';
  view.posT.copy(SEAT); view.fovT = baseFov(); view.pitchT = -0.05;
}
$('open-desktop').addEventListener('click', e => { e.preventDefault(); sitDown(); });
$('open-contact').addEventListener('click', e => {
  e.preventDefault(); opened = true; $('hint').style.opacity = 0;
  openFolder('contact', mode === 'room' ? interactive.find(g => g.userData.entry.opens === 'contact') : null);
});
$('stand-up').addEventListener('click', standUp);
$('dock-stand').addEventListener('click', standUp);
for (const b of document.querySelectorAll('.dock [data-open]')) b.addEventListener('click', () => openFolder(b.dataset.open));
$('desktop').addEventListener('click', e => { if (e.target === $('desktop')) standUp(); });
$('win-close-dot').addEventListener('click', closeWin);

// Things you can click light up under the mouse (and pulse gently until the visitor has opened something).
const GLOW = new THREE.Color('#fff0d6');                       // a soft warm highlight
function setGlow(group, amount) {
  if (Math.abs((group.userData.glow ?? 0) - amount) < 0.004) return;
  group.userData.glow = amount;
  invalidate();
  for (const m of group.userData.glowMeshes) {
    if (amount > 0.004) { m.material.emissive.copy(GLOW); m.material.emissiveIntensity = amount; }
    else { m.material.emissive.copy(m.userData.e0.c); m.material.emissiveIntensity = m.userData.e0.i; }
  }
}

// ------------------------------------------------------------------ the "2010s memory" look: soft glow, then fade, vignette, colour fringes
// (the grain is the CSS .grain-layer, see room/folders.css)
// Speed, measured in Firefox on a laptop's built-in Intel graphics (2026-11-06): the room itself is cheap (shadows,
// lamps and textures hardly matter); what cost the most was edge smoothing and the steps after the room, each going over
// the whole screen again (31 frames a second). Now: no edge smoothing (the film look and the grain hide the edges), the
// room drawn once, the glow blurred at a quarter of the size and smaller, and the rest (glow, colours, the look) one last
// pass straight to the screen: 60 frames a second, the screen's limit.
// How sharp: phones 1.25x their screen's pixels at most; computers 1x, and at most 2 million pixels on a large screen.
const pixelRatio = () => (TOUCH ? Math.min(devicePixelRatio, 1.25) : Math.min(1, Math.sqrt(2e6 / (innerWidth * innerHeight))));
const HDR = { type: THREE.HalfFloatType };
const roomRT = new THREE.WebGLRenderTarget(1, 1, HDR);
const BLOOM = [4, 8, 16].map(div => ({ div, a: new THREE.WebGLRenderTarget(1, 1, HDR), b: new THREE.WebGLRenderTarget(1, 1, HDR) }));
const FULL_VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const pass = (uniforms, fragmentShader) => new FullScreenQuad(new THREE.ShaderMaterial({ uniforms, vertexShader: FULL_VS, fragmentShader, depthTest: false, depthWrite: false }));
// smaller: each pixel the average of the 4x4 below it; the first step keeps only what is brighter than `bright`
const shrink = pass({ src: { value: null }, texel: { value: new THREE.Vector2() }, bright: { value: 0 } }, `
  uniform sampler2D src; uniform vec2 texel; uniform float bright; varying vec2 vUv;
  void main() {
    vec3 c = 0.25 * (texture2D(src, vUv - texel).rgb + texture2D(src, vUv + texel).rgb
      + texture2D(src, vUv + vec2(texel.x, -texel.y)).rgb + texture2D(src, vUv + vec2(-texel.x, texel.y)).rgb);
    gl_FragColor = vec4(c * smoothstep(bright, bright + 0.25, dot(c, vec3(0.2126, 0.7152, 0.0722))), 1.0);
  }`);
const blur = pass({ src: { value: null }, step: { value: new THREE.Vector2() } }, `
  uniform sampler2D src; uniform vec2 step; varying vec2 vUv;   // a 9-tap Gaussian in 5 reads (one direction)
  void main() {
    vec3 c = texture2D(src, vUv).rgb * 0.227027;
    c += (texture2D(src, vUv + step * 1.384615).rgb + texture2D(src, vUv - step * 1.384615).rgb) * 0.316216;
    c += (texture2D(src, vUv + step * 3.230769).rgb + texture2D(src, vUv - step * 3.230769).rgb) * 0.070270;
    gl_FragColor = vec4(c, 1.0);
  }`);
const look = pass({ room: { value: roomRT.texture }, g1: { value: BLOOM[0].a.texture }, g2: { value: BLOOM[1].a.texture }, g3: { value: BLOOM[2].a.texture } }, `
  uniform sampler2D room, g1, g2, g3; varying vec2 vUv;
  void main() {
    vec2 c = vUv - 0.5;
    vec2 shift = c * dot(c, c) * 0.02;                                 // colour fringes, stronger towards the edges
    vec3 col = vec3(texture2D(room, vUv + shift).r, texture2D(room, vUv).g, texture2D(room, vUv - shift).b);
    col += 0.5 * (texture2D(g1, vUv).rgb + 0.85 * texture2D(g2, vUv).rgb + 0.7 * texture2D(g3, vUv).rgb);   // the glow
    col = linearToOutputTexel(vec4(toneMapping(col), 1.0)).rgb;        // the renderer's tone mapping and sRGB
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(l), 0.14);                                     // a little less colour
    col *= vec3(1.04, 1.0, 0.92);                                      // warmer
    col = mix(vec3(0.075, 0.065, 0.07), vec3(0.97, 0.94, 0.88), col);  // faded: blacks lifted, whites softened
    col *= 1.0 - 0.45 * smoothstep(0.3, 0.95, length(c * vec2(1.15, 1.0)) * 1.3);    // vignette
    col += vec3(1.0, 0.5, 0.25) * 0.05 * smoothstep(0.8, 0.0, distance(vUv, vec2(1.0)));   // a warm light leak
    gl_FragColor = vec4(col, 1.0);
  }`);
function fitScreen() {
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(innerWidth, innerHeight);
  const { x: w, y: h } = renderer.getDrawingBufferSize(new THREE.Vector2());
  roomRT.setSize(w, h);
  for (const g of BLOOM) { g.a.setSize(Math.ceil(w / g.div), Math.ceil(h / g.div)); g.b.setSize(Math.ceil(w / g.div), Math.ceil(h / g.div)); }
  invalidate();
}
fitScreen();
function draw() {
  renderer.setRenderTarget(roomRT);
  renderer.render(scene, camera);
  let src = roomRT;
  for (const [i, g] of BLOOM.entries()) {
    const u = shrink.material.uniforms, b = blur.material.uniforms;
    u.src.value = src.texture; u.texel.value.set(1 / src.width, 1 / src.height); u.bright.value = i ? -1 : 0.85;
    renderer.setRenderTarget(g.a); shrink.render(renderer);
    b.src.value = g.a.texture; b.step.value.set(1 / g.a.width, 0);
    renderer.setRenderTarget(g.b); blur.render(renderer);
    b.src.value = g.b.texture; b.step.value.set(0, 1 / g.a.height);
    renderer.setRenderTarget(g.a); blur.render(renderer);
    src = g.a;
  }
  renderer.setRenderTarget(null);
  look.render(renderer);
}

// ------------------------------------------------------------------ every frame (drawing only when something changed); the clocks; resizing
const timer = new THREE.Clock();
// Behind the door (index.html) the room loads and is drawn, so it's ready when picked; the "click me" glow waits, and
// its 20 seconds start when the visitor walks in.
let entered = !!window.roomEntered;
const anims = new Set();               // running animations (twinkle, hop, flash): each runs every frame until it returns false
addEventListener('room-enter', () => { entered = true; timer.start(); invalidate(); });
renderer.setAnimationLoop(() => {
  const dt = Math.min(timer.getDelta(), 0.1), t = timer.elapsedTime;
  const lim = yawLimit();
  view.yawT = clamp(view.yawT, -lim, lim);
  const k = STILL ? 1 : 1 - Math.exp(-dt * 7), kp = STILL ? 1 : 1 - Math.exp(-dt * 5);
  const moving = Math.abs(view.yawT - view.yaw) + Math.abs(view.pitchT - view.pitch) + Math.abs(view.fovT - view.fov) * 0.01
    + view.pos.distanceTo(view.posT) > 1e-4;
  if (moving) {
    view.yaw += (view.yawT - view.yaw) * k;
    view.pitch += (view.pitchT - view.pitch) * k;
    view.fov += (view.fovT - view.fov) * k;
    view.pos.lerp(view.posT, kp);
    dirty = true;
  }
  // clickable things glow three times to show they're there, then stop (each glow redraws the room for a second or so)
  const pulse = opened || STILL || !entered || t > 20 ? 0 : Math.pow(Math.max(0, Math.sin(t * 0.95 - 1)), 8) * 0.1;
  for (const g of interactive) setGlow(g, g === hovered || g === pending ? 0.16 : g.userData.entry.opens ? pulse : 0);
  if (anims.size) { for (const a of anims) if (!a()) anims.delete(a); dirty = true; }
  if (!dirty) return;
  dirty = false;
  camera.position.copy(view.pos);
  camera.rotation.set(view.pitch, view.yaw, 0);
  if (camera.fov !== view.fov) { camera.fov = view.fov; camera.updateProjectionMatrix(); }
  draw();
});

// Day or night: most visitors come by day and never see the room lit up at night. The button flips the room's hour
// to 9:30 pm or 2 pm (the clocks follow); reloading goes back to the visitor's own time.
const isNight = () => { const d = now(), h = d.getHours() + d.getMinutes() / 60; return h >= 18.75 || h < 6.75; };
function showDayNight() {
  const night = isNight(), b = $('daynight');
  if (!b) return;                                       // an older index.html still in the browser's cache (no button)
  b.classList.toggle('night', night);
  b.setAttribute('aria-label', night ? 'Switch to day' : 'Switch to night'); b.title = b.getAttribute('aria-label');
}
$('daynight')?.addEventListener('click', () => {
  const toNight = !isNight();
  fixedHour = toNight ? 21.5 : 14;
  lastMinute = -1; applyTime(); tick(); showDayNight();
  if (toNight) twinkle();
});
let lastMinute = -1;
function tick() {
  const d = now();
  clockTex.redraw();                                   // every second: the colon blinks
  if (d.getMinutes() !== lastMinute) {
    lastMinute = d.getMinutes();
    screenTex.redraw(); phoneTex.redraw();
    $('clock').textContent = `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}  ${timeText(d)}`;
    $('w-time').textContent = timeText(d).replace(/\s?[ap]\.?m\.?$/i, '');                     // the widget
    $('w-day').textContent = d.toLocaleDateString([], { weekday: 'long' });
    $('w-date').textContent = d.toLocaleDateString([], { day: 'numeric', month: 'long' });
  }
  if (d.getSeconds() % 30 === 0) applyTime();
}
applyTime();
tick();
showDayNight();
setInterval(tick, 1000);

addEventListener('resize', () => {                       // always the visitor's window size (and zoom level)
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  fitScreen();
  if (mode === 'room' && !isOn('win')) view.fovT = baseFov();
});
