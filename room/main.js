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
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { el, folderNodes } from './folders.js';
import { createOutside } from './outside.js';

window.roomReady = true;   // index.html shows the "no 3D" page if this never happens (the CDN didn't load)

const $ = id => document.getElementById(id);
const TOUCH = matchMedia('(pointer: coarse)').matches;
const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PR = Math.min(devicePixelRatio, 1.25);                    // a little soft on purpose (and much faster on phones)
const clamp = THREE.MathUtils.clamp, rad = THREE.MathUtils.degToRad;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const nearest = (from, to) => from + (to - from) - Math.PI * 2 * Math.round((to - from) / (Math.PI * 2));
const rand = (() => { let a = 20261105; return () => {   // the same "random" every visit, so the room never changes
  a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();

const FIXED_HOUR = Number.parseFloat(new URLSearchParams(location.search).get('t'));
function now() {
  const d = new Date();
  if (Number.isFinite(FIXED_HOUR)) d.setHours(Math.floor(FIXED_HOUR) % 24, Math.round((FIXED_HOUR % 1) * 60), 0);
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
renderer.setPixelRatio(PR);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
scene.fog = new THREE.Fog(0x000000, 90, 1000);         // only the city outside is far enough to fade (haze)
const baseFov = () => (innerWidth < innerHeight ? 70 : 58);
const camera = new THREE.PerspectiveCamera(baseFov(), innerWidth / innerHeight, 0.02, 520);
camera.rotation.order = 'YXZ';

// ------------------------------------------------------------------ small helpers for shapes and pictures
const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...extra });
function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
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

const FLOOR_REPEAT = [FULL / 1.6, LEN / 1.6];                    // the photo covers 1.6 m of floor
const floorMat = std('#7d5d45', { roughness: 0.75 });
photo(floorMat, 'map', 'wood_floor_diff_1k.jpg', FLOOR_REPEAT, '#e8ddd0');
photo(floorMat, 'normalMap', 'wood_floor_nor_gl_1k.jpg', FLOOR_REPEAT);
photo(floorMat, 'roughnessMap', 'wood_floor_arm_1k.jpg', FLOOR_REPEAT);
const plaster = (tint, plain) => {
  const m = std(plain, { roughness: 0.95, normalScale: new THREE.Vector2(0.5, 0.5) });
  photo(m, 'map', 'plastered_wall_04_diff_1k.jpg', [2.5, 2], tint);
  return photo(m, 'normalMap', 'plastered_wall_04_nor_gl_1k.jpg', [2.5, 2]);
};
const woodMat = (tint = '#b9997e') => photo(std('#8a6a50', { roughness: 0.55 }), 'map', 'oak_veneer_01_diff_1k.jpg', [1, 1], tint);

const wallMat = plaster('#e4d9c7', '#b8ad9b');                               // warm greige paint on plaster
const trimMat = std('#ebe4d8', { roughness: 0.6 });
world.add(box(FULL, 0.1, LEN, floorMat, 0, -0.05, MIDZ));
world.add(box(FULL, T, LEN, plaster('#efe8dc', '#cfc7ba'), 0, H + T / 2, MIDZ));
world.add(box(T, H, LEN, wallMat, W + T / 2, H / 2, MIDZ), box(T, H, LEN, wallMat, -W - T / 2, H / 2, MIDZ));
world.add(box(FULL, H, T, wallMat, 0, H / 2, BACK + T / 2));
// the wall in front of you, built around the window
world.add(box(FULL, WIN.y0, T, wallMat, 0, WIN.y0 / 2, FZ), box(FULL, H - WIN.y1, T, wallMat, 0, (H + WIN.y1) / 2, FZ));
world.add(box(WIN.x0 + W + T, WIN.y1 - WIN.y0, T, wallMat, (WIN.x0 - W - T) / 2, (WIN.y0 + WIN.y1) / 2, FZ));
world.add(box(W + T - WIN.x1, WIN.y1 - WIN.y0, T, wallMat, (WIN.x1 + W + T) / 2, (WIN.y0 + WIN.y1) / 2, FZ));
// skirting boards
world.add(box(2 * W, 0.08, 0.015, trimMat, 0, 0.04, FRONT + 0.0075));
world.add(box(0.015, 0.08, BACK - FRONT, trimMat, W - 0.0075, 0.04, MIDZ), box(0.015, 0.08, BACK - FRONT, trimMat, -W + 0.0075, 0.04, MIDZ));
// the window: frame, bars, sill, faint glass, short curtains on a rod
{
  const wx = (WIN.x0 + WIN.x1) / 2, wy = (WIN.y0 + WIN.y1) / 2, ww = WIN.x1 - WIN.x0, wh = WIN.y1 - WIN.y0;
  world.add(box(ww, 0.05, T + 0.02, trimMat, wx, WIN.y1 - 0.025, FZ), box(ww, 0.05, T + 0.02, trimMat, wx, WIN.y0 + 0.025, FZ));
  world.add(box(0.05, wh, T + 0.02, trimMat, WIN.x0 + 0.025, wy, FZ), box(0.05, wh, T + 0.02, trimMat, WIN.x1 - 0.025, wy, FZ));
  world.add(box(0.035, wh, 0.04, trimMat, wx, wy, FZ), box(ww, 0.035, 0.04, trimMat, wx, WIN.y0 + wh * 0.68, FZ));
  world.add(box(ww + 0.16, 0.035, 0.2, trimMat, wx, WIN.y0 - 0.0175, FRONT + 0.05));
  const glass = noShadow(new THREE.Mesh(new THREE.PlaneGeometry(ww, wh),
    new THREE.MeshBasicMaterial({ color: '#cfe6ee', transparent: true, opacity: 0.05, depthWrite: false })));
  glass.position.set(wx, wy, FZ);
  world.add(glass);
  const CZ = FRONT + 0.18, rodMat = std('#5a4636');                // curtains hang in front of the sill
  world.add(rod([WIN.x0 - 0.38, WIN.y1 + 0.12, CZ], [WIN.x1 + 0.3, WIN.y1 + 0.12, CZ], 0.011, rodMat));
  for (const x of [WIN.x0 - 0.33, WIN.x1 + 0.25]) world.add(rod([x, WIN.y1 + 0.12, FRONT], [x, WIN.y1 + 0.12, CZ], 0.008, rodMat));
  const curtainMat = std('#c9a98a', { roughness: 1, side: THREE.DoubleSide });
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
  const rug = new THREE.Mesh(new THREE.CircleGeometry(1.05, 48), std('#7f8f86', { roughness: 1 }));
  rug.rotation.x = -Math.PI / 2; rug.position.set(0, 0.004, 0.45); rug.receiveShadow = true; world.add(rug);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 0.96, 48), std('#d7c5b2', { roughness: 1 }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(0, 0.005, 0.45); ring.receiveShadow = true; world.add(ring);
}
// cables from the things on the desk, over the back edge and down behind it (they follow objects.json's positions)
{
  const cable = (pts, colour = '#1c1c1e') => {
    const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)));
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.0028, 5), std(colour, { roughness: 0.6 }));
    m.castShadow = true; m.receiveShadow = true; world.add(m);
  };
  cable([[-0.05, 0.768, -0.49], [-0.07, 0.763, -0.6], [-0.14, 0.763, -0.75], [-0.2, 0.763, -0.93], [-0.21, 0.745, -0.99], [-0.21, 0.35, -0.995]]); // keyboard
  cable([[0, 0.83, -0.885], [0.03, 0.766, -0.93], [0.06, 0.763, -0.965], [0.07, 0.74, -0.993], [0.07, 0.3, -0.995]]);                             // monitor
  cable([[0.6, 0.77, -0.86], [0.63, 0.763, -0.94], [0.65, 0.745, -0.99], [0.65, 0.3, -0.995]]);                                                   // lamp
  cable([[0.58, 0.766, -0.51], [0.6, 0.763, -0.62], [0.69, 0.763, -0.78], [0.72, 0.763, -0.93], [0.73, 0.745, -0.99], [0.73, 0.3, -0.995]], '#ecebe7'); // phone charger
}
// string lights along the top of the front wall
const fairyMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.6, 0.85) });
const fairyLight = new THREE.PointLight('#ffc27a', 0.6, 4.5, 2);
{
  const anchors = [[-2.15, 2.44], [-0.95, 2.47], [0.35, 2.44], [1.45, 2.47], [2.15, 2.44]], pts = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, y0] = anchors[i], [x1, y1] = anchors[i + 1];
    for (let s = 0; s < 14; s++) {
      const u = s / 14;
      pts.push(new THREE.Vector3(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u - Math.sin(u * Math.PI) * 0.15, FRONT + 0.03));
    }
  }
  pts.push(new THREE.Vector3(anchors.at(-1)[0], anchors.at(-1)[1], FRONT + 0.03));
  const curve = new THREE.CatmullRomCurve3(pts);
  world.add(noShadow(new THREE.Mesh(new THREE.TubeGeometry(curve, 200, 0.003, 4), std('#2b2a2e'))));
  const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.014, 10, 8), fairyMat, 40);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < bulbs.count; i++) {
    dummy.position.copy(curve.getPointAt((i + 0.5) / bulbs.count)).add(new THREE.Vector3(0, -0.014, 0.008));
    dummy.updateMatrix(); bulbs.setMatrixAt(i, dummy.matrix);
  }
  bulbs.raycast = () => {};
  bulbs.frustumCulled = false;
  world.add(bulbs);
  fairyLight.position.set(-0.3, 2.25, -0.75);
  world.add(fairyLight);
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
  for (const l of lamps) { l.light.intensity = l.power * glow; l.shade.emissiveIntensity = 0.1 + glow * 0.5; }
  fairyLight.intensity = 0.7 * glow;
  fairyMat.color.setRGB(0.7 + 1.6 * glow, 0.6 + 1.1 * glow, 0.45 + 0.45 * glow);
  const u = sky.material.uniforms;
  blend(u.top.value, 'top', w); blend(u.horizon.value, 'horizon', w); blend(u.bottom.value, 'bottom', w);
  blend(u.glow.value, 'light', w).multiplyScalar(mixN(w, 0.08, 1.2, 0.6));   // the moon's halo stays small: the sky is in the window
  u.sunDir.value.copy(lightDir);
  scene.fog.color.copy(u.horizon.value);
  scene.fog.far = mixN(w, 1100, 800, 1000);                        // a light tropical haze; clearer at night
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
const desktopItems = () => [...content.folders.filter(f => f.desktop), ...(content.cvs || []).map(c => ({ icon: '📄', name: c.name }))];

const screenTex = canvasTexture(1024, 596, (ctx, w, h) => {      // a picture of the desktop (the real one is HTML)
  let g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#22302a'); g.addColorStop(1, '#121815');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  g = ctx.createRadialGradient(w * 0.85, h * 0.1, 0, w * 0.85, h * 0.1, w * 0.6);
  g.addColorStop(0, 'rgba(213,244,249,0.22)'); g.addColorStop(1, 'rgba(213,244,249,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  g = ctx.createRadialGradient(0, h, 0, 0, h, w * 0.6);
  g.addColorStop(0, 'rgba(183,198,194,0.35)'); g.addColorStop(1, 'rgba(183,198,194,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, w, 34);
  ctx.fillStyle = '#fff'; ctx.font = `600 15px ${SANS}`; ctx.textBaseline = 'middle';
  const d = now();
  ctx.textAlign = 'left'; ctx.fillText('kai@desk', 16, 17);
  ctx.textAlign = 'center'; ctx.fillText(`${d.toLocaleDateString([], { weekday: 'short' })} ${timeText(d)}`, w / 2, 17);
  ctx.textAlign = 'right'; ctx.fillText('Stand up ✕', w - 16, 17);
  ctx.textAlign = 'center';
  desktopItems().forEach((f, i) => {
    const x = 74 + Math.floor(i / 4) * 116, y = 64 + (i % 4) * 128;
    ctx.font = `46px ${EMOJI}`; ctx.fillText(f.icon, x, y + 30);
    ctx.font = `600 15px ${SANS}`; ctx.fillStyle = '#fff'; ctx.fillText(f.name, x, y + 78);
  });
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = '400 72px Anton, Impact, sans-serif'; ctx.fillText("HI, I'M KAI LE.", w * 0.5, h * 0.38);
  ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = `400 20px ${SANS}`;
  ctx.fillText('Mechanical Engineering and Computing at NUS.', w * 0.5, h * 0.38 + 48);
  ctx.fillText('Open a folder, or grab a CV.', w * 0.5, h * 0.38 + 78);
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

// ------------------------------------------------------------------ placeholder shapes (until your own models replace them)
// Each returns a group in metres: things that stand (desk, shelves, lamps, and what sits on the desk) have their origin
// on the floor or desk top; things on a wall have their origin at their centre. All face +z (towards you).
function lampShade(rTop, rBottom, height, y, power) {    // a fabric drum shade that glows, with a warm bulb inside
  const g = new THREE.Group();
  const mat = std('#efe0c6', { side: THREE.DoubleSide, emissive: '#ffb468', emissiveIntensity: 0.8, roughness: 1 });
  g.add(cyl(rTop, rBottom, height, mat, 0, y, 0, 40, true));
  const light = new THREE.PointLight('#ffbf7a', power, 5, 2);
  light.position.y = y - height * 0.1; g.add(light);
  lamps.push({ light, shade: mat, power });
  return g;
}
function motorbike() {      // a sports bike, real size (2 m long, front wheel at +x); the miniature scales it down
  const g = new THREE.Group();
  const paint = std('#b8322a', { metalness: 0.35, roughness: 0.3 }), dark = std('#2a2829', { roughness: 0.55 });
  const tyre = std('#141414', { roughness: 0.9 }), metal = std('#9aa0a4', { metalness: 0.85, roughness: 0.3 });
  const chrome = std('#d8dcde', { metalness: 1, roughness: 0.18 });
  for (const x of [-0.68, 0.68]) {
    for (const ring of [new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.065, 14, 40), tyre), new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.018, 8, 40), metal)]) {
      ring.position.set(x, 0.365, 0); g.add(ring);
    }
    for (let i = 0; i < 5; i++) {                                     // cast wheel spokes
      const a = (i / 5) * Math.PI * 2;
      g.add(rod([x, 0.365, 0], [x + Math.cos(a) * 0.23, 0.365 + Math.sin(a) * 0.23, 0], 0.016, metal));
    }
    const hub = cyl(0.05, 0.05, 0.12, metal, x, 0.365, 0); hub.rotation.x = Math.PI / 2; g.add(hub);
  }
  const brake = cyl(0.16, 0.16, 0.012, chrome, 0.68, 0.365, 0.07); brake.rotation.x = Math.PI / 2; g.add(brake);
  // tank, seat and tail as one outline, made thick
  const body = new THREE.Shape();
  body.moveTo(0.36, 0.74);
  body.quadraticCurveTo(0.38, 0.95, 0.22, 1.0);
  body.quadraticCurveTo(0.05, 1.05, -0.15, 0.92);
  body.lineTo(-0.55, 0.9);
  body.quadraticCurveTo(-0.8, 0.95, -0.95, 1.02);
  body.lineTo(-0.92, 0.92);
  body.quadraticCurveTo(-0.6, 0.78, -0.2, 0.72);
  body.lineTo(0.36, 0.74);
  g.add(extrude(body, 0.2, 0.04, paint));
  const seat = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.3, 4, 10), dark);
  seat.rotation.z = Math.PI / 2 + 0.06; seat.scale.set(1, 1, 2.2); seat.position.set(-0.37, 0.93, 0); g.add(seat);
  // the fairing around the headlight, and its screen
  const nose = new THREE.Shape();
  nose.moveTo(0.36, 0.74); nose.quadraticCurveTo(0.62, 0.78, 0.66, 1.0); nose.lineTo(0.5, 1.12);
  nose.quadraticCurveTo(0.4, 1.0, 0.34, 0.95); nose.lineTo(0.36, 0.74);
  g.add(extrude(nose, 0.22, 0.035, paint));
  const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.055, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.5, 1.2) }));
  lamp.position.set(0.672, 0.94, 0); lamp.rotation.y = Math.PI / 2; g.add(lamp);
  const visor = box(0.04, 0.16, 0.2, std('#3b4a55', { metalness: 0.5, roughness: 0.15 }), 0.56, 1.12, 0); visor.rotation.z = 0.5; g.add(visor);
  // engine, frame, swingarm, forks, bars, exhaust, mudguard, tail light
  g.add(box(0.42, 0.34, 0.26, dark, 0.02, 0.52, 0));
  for (let i = 0; i < 4; i++) g.add(box(0.44, 0.02, 0.28, metal, 0.02, 0.6 + i * 0.045, 0));
  g.add(rod([0.45, 1.0, 0], [-0.05, 0.62, 0], 0.035, metal));
  g.add(rod([-0.05, 0.45, 0.08], [-0.68, 0.365, 0.08], 0.03, metal), rod([-0.05, 0.45, -0.08], [-0.68, 0.365, -0.08], 0.03, metal));
  for (const z of [-0.08, 0.08]) g.add(rod([0.47, 1.05, z], [0.68, 0.365, z], 0.025, chrome));
  g.add(rod([0.44, 1.08, -0.32], [0.44, 1.08, 0.32], 0.014, dark));
  g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0.12, 0.38, 0.1),
    new THREE.Vector3(-0.15, 0.32, 0.16), new THREE.Vector3(-0.5, 0.5, 0.17), new THREE.Vector3(-0.78, 0.66, 0.17)]), 30, 0.035, 10), chrome));
  const can = cyl(0.06, 0.05, 0.3, metal, -0.72, 0.62, 0.17); can.rotation.z = Math.PI / 2 - 0.45; g.add(can);
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.02, 6, 24, Math.PI * 0.5), paint);
  guard.position.set(0.68, 0.365, 0); guard.rotation.z = Math.PI * 0.3; g.add(guard);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.12), new THREE.MeshBasicMaterial({ color: new THREE.Color(2, 0.2, 0.15) }));
  tail.position.set(-0.96, 0.97, 0); g.add(tail);
  return g;
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
  g.add(extrude(upper, 0.056, 0.013, std(upperColour, { roughness: 0.75 })));
  g.add(extrude(rubber, 0.062, 0.0135, std('#1b1a1b', { roughness: 0.95 })));
  const strapMat = std('#2c3238', { roughness: 0.8 });
  for (const [x, y, a] of [[0.1, 0.074, -0.05], [0.15, 0.068, -0.35]]) {      // two velcro straps over the instep
    const s = box(0.018, 0.006, 0.092, strapMat, x, y, 0); s.rotation.z = a; g.add(s);
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
    g.add(box(0.42, 0.71, 0.66, wood, 0.52, 0.355, 0));                 // drawers
    for (const y of [0.18, 0.42, 0.62]) g.add(box(0.12, 0.015, 0.012, dark, 0.52, y, 0.336));
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
    g.add(box(0.25, 0.004, 0.21, std('#33403a', { roughness: 1 }), 0, 0.002, 0));
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
    const base = new THREE.Mesh(new THREE.CircleGeometry(0.038, 28), clay); base.rotation.x = -Math.PI / 2; base.position.y = 0.002; g.add(base);
    const tea = new THREE.Mesh(new THREE.CircleGeometry(0.04, 28), std('#9a5f2c', { roughness: 0.2 }));
    tea.rotation.x = -Math.PI / 2; tea.position.y = 0.085; g.add(tea);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.008, 8, 20), clay); handle.position.set(0.046, 0.052, 0); g.add(handle);
    return g;
  },
  book() {                               // two textbooks, spines towards you: mech eng under, CS on top
    const g = new THREE.Group();
    const one = (w, t, d, cover, ink, title, y, rot) => {
      const b = new THREE.Group(), c = std(cover, { roughness: 0.7 });
      b.add(box(w, 0.004, d, c, 0, 0.002, 0), box(w, 0.004, d, c, 0, t - 0.002, 0), box(0.008, t, d, c, -w / 2 + 0.004, t / 2, 0));
      b.add(box(w - 0.012, t - 0.008, d - 0.01, std('#efe9dd'), 0.004, t / 2, 0));
      const spine = new THREE.Mesh(new THREE.PlaneGeometry(d, t), std('#ffffff', { roughness: 0.7, map: canvasTexture(1024, Math.round(1024 * t / d), (ctx, cw, ch) => {
        ctx.fillStyle = cover; ctx.fillRect(0, 0, cw, ch);
        ctx.fillStyle = ink; ctx.fillRect(40, 0, 10, ch); ctx.fillRect(cw - 50, 0, 10, ch);
        ctx.font = `700 ${Math.round(ch * 0.42)}px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(title, cw / 2, ch / 2 + 3);
      }, { fonts: true }) }));
      spine.rotation.y = -Math.PI / 2; spine.position.set(-w / 2 - 0.0006, t / 2, 0); b.add(spine);
      b.position.y = y; b.rotation.y = Math.PI / 2 + rot; return b;
    };
    g.add(one(0.19, 0.036, 0.26, '#26364f', '#e8d9b0', 'MECHANICS OF MATERIALS', 0, 0),
          one(0.165, 0.03, 0.235, '#b4532c', '#f6efe2', 'ALGORITHMS', 0.036, 0.1));
    return g;
  },
  clock() {
    const g = new THREE.Group();
    g.add(box(0.17, 0.08, 0.07, std('#262427', { roughness: 0.4 }), 0, 0.04, 0));
    const face = noShadow(new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.064),
      new THREE.MeshBasicMaterial({ map: clockTex, color: new THREE.Color(3, 3, 3) })));   // bright enough to glow
    face.name = 'clock-face'; face.position.set(0, 0.042, 0.0355); g.add(face);
    return g;
  },
  phone() {
    const g = new THREE.Group();
    g.add(box(0.075, 0.009, 0.155, std('#1b1b1d', { roughness: 0.3, metalness: 0.4 }), 0, 0.0045, 0));
    const screen = noShadow(new THREE.Mesh(new THREE.PlaneGeometry(0.068, 0.145), new THREE.MeshBasicMaterial({ map: phoneTex })));
    screen.name = 'phone-screen'; screen.rotation.x = -Math.PI / 2; screen.position.y = 0.0092; g.add(screen);
    return g;
  },
  desklamp() {                           // a ceramic table lamp with a glowing fabric shade
    const g = new THREE.Group();
    const profile = [[0, 0], [0.07, 0], [0.075, 0.02], [0.085, 0.08], [0.07, 0.15], [0.03, 0.2], [0.018, 0.21], [0, 0.21]];
    g.add(new THREE.Mesh(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 32), std('#8fa79c', { roughness: 0.35 })));
    g.add(cyl(0.008, 0.008, 0.14, std('#b8955a', { metalness: 0.8, roughness: 0.3 }), 0, 0.27, 0, 10));
    g.add(lampShade(0.1, 0.14, 0.17, 0.39, 1.4));
    return g;
  },
  bed() {                                // a single bed, head at -z: frame, mattress, duvet with a folded edge, pillows, a throw
    const g = new THREE.Group(), wood = woodMat();
    const soft = (w, h, d, colour, x, y, z, r = 0.04) => {
      const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), std(colour, { roughness: 1 }));
      m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m;
    };
    g.add(box(1.0, 0.08, 1.98, wood, 0, 0.24, 0));
    for (const [x, z] of [[-0.46, -0.95], [0.46, -0.95], [-0.46, 0.95], [0.46, 0.95]]) g.add(box(0.06, 0.2, 0.06, wood, x, 0.1, z));
    g.add(soft(1.04, 0.62, 0.07, '#8e7b6a', 0, 0.55, -0.97, 0.03));                  // upholstered headboard
    g.add(soft(0.96, 0.18, 1.9, '#efe9df', 0, 0.37, 0.02));                           // mattress
    g.add(soft(0.98, 0.08, 1.38, '#9fb0a6', 0, 0.48, 0.3, 0.035));                    // duvet
    g.add(soft(0.99, 0.07, 0.2, '#e9e4da', 0, 0.5, -0.32, 0.03));                     // its folded-back edge
    const p1 = soft(0.42, 0.11, 0.3, '#f4f1ec', -0.23, 0.52, -0.72, 0.05); p1.rotation.x = -0.25;
    const p2 = soft(0.42, 0.11, 0.3, '#d7c5b2', 0.23, 0.52, -0.72, 0.05); p2.rotation.x = -0.25;
    g.add(p1, p2, soft(1.0, 0.03, 0.5, '#b5643c', 0, 0.535, 0.72, 0.012));            // pillows, a rust throw at the foot
    return g;
  },
  wallshelf() {                          // a floating shelf with two books and a small plant
    const g = new THREE.Group();
    g.add(box(0.72, 0.025, 0.2, woodMat()));
    g.add(box(0.035, 0.2, 0.15, std('#26364f'), -0.31, 0.1125, 0), box(0.03, 0.18, 0.14, std('#d7c5b2'), -0.275, 0.1025, 0));
    g.add(cyl(0.04, 0.032, 0.07, std('#b5643c', { roughness: 0.9 }), -0.17, 0.0475, 0));
    const leafMat = std('#5d8a55', { roughness: 0.7 });
    for (let i = 0; i < 7; i++) {
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8), leafMat);
      leaf.position.set(-0.17 + Math.cos(i * 2.4) * 0.022, 0.095 + (i % 3) * 0.012, Math.sin(i * 2.4) * 0.022); g.add(leaf);
    }
    return g;
  },
  bookshelf() {
    const g = new THREE.Group(), wood = woodMat();
    g.add(box(0.03, 1.5, 0.32, wood, -0.42, 0.75, 0), box(0.03, 1.5, 0.32, wood, 0.42, 0.75, 0), box(0.87, 1.5, 0.015, wood, 0, 0.75, -0.155));
    for (const y of [0.05, 0.55, 1.02, 1.49]) g.add(box(0.87, 0.03, 0.32, wood, 0, y, 0));
    const colours = ['#9f8d8b', '#b7c6c2', '#d7c5b2', '#302b2f', '#7d9bb0', '#9e3b2c', '#d7c5b2', '#26364f', '#c46a3a'];
    for (const [shelfY, n, x0] of [[0.065, 9, -0.37], [0.565, 6, -0.37], [1.035, 4, 0.08]]) {
      for (let i = 0; i < n; i++) {
        const h = 0.2 + ((i * 7) % 5) * 0.03;
        const b = box(0.055, h, 0.22, std(colours[(i + n) % colours.length]), x0 + i * 0.075, shelfY + h / 2, 0);
        if (i === n - 1 && n < 9) { b.rotation.z = 0.25; b.position.x += 0.02; }   // one leaning
        g.add(b);
      }
    }
    g.add(cyl(0.07, 0.06, 0.14, std('#d7c5b2', { roughness: 0.6 }), -0.25, 1.505 + 0.07, 0));   // a vase on top
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
    const cork = std('#ffffff', { roughness: 1, map: canvasTexture(512, 380, (ctx, w, h) => {
      ctx.fillStyle = '#b88a5c'; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) {
        const r = rand();
        ctx.fillStyle = r < 0.45 ? 'rgba(90,55,25,0.35)' : r < 0.8 ? 'rgba(225,180,130,0.35)' : 'rgba(60,35,15,0.4)';
        ctx.fillRect(rand() * w, rand() * h, 1 + rand() * 2.2, 1 + rand() * 2.2);
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
    const g = new THREE.Group(), gold = std('#d8b25a', { metalness: 0.85, roughness: 0.28 });
    g.add(box(0.15, 0.05, 0.15, std('#302b2f'), 0, 0.025, 0), cyl(0.018, 0.026, 0.09, gold, 0, 0.095, 0));
    const cup = new THREE.Mesh(new THREE.LatheGeometry([0, 0.03, 0.055, 0.075, 0.08].map((r, i) => new THREE.Vector2(r, i * 0.035)), 32), gold);
    cup.position.y = 0.14; g.add(cup);
    for (const s of [-1, 1]) {
      const h = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 8, 20, Math.PI), gold);
      h.position.set(s * 0.085, 0.23, 0); h.rotation.z = s * Math.PI / 2; g.add(h);
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
  shoes() {                              // a pair of climbing shoes hanging by their heel loops from a hook
    const g = new THREE.Group(), dark = std('#2b2a2e');
    const hook = cyl(0.007, 0.007, 0.06, dark, 0, 0.12, -0.02); hook.rotation.x = Math.PI / 2; g.add(hook);
    const biner = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.004, 8, 20), std('#c9862f', { metalness: 0.7, roughness: 0.3 }));
    biner.scale.set(0.7, 1, 1); biner.position.set(0, 0.095, 0.01); g.add(biner);
    for (const [s, colour] of [[-1, '#f2a516'], [1, '#eb9a12']]) {          // yellow uppers, like classic bouldering shoes
      const pivot = new THREE.Group(), shoe = climbingShoe(colour);
      shoe.position.set(-0.018, -0.096, 0);           // hang from the heel loop
      pivot.add(shoe);
      pivot.position.set(s * 0.05, 0.08, 0.03);
      pivot.rotation.set(0, s * 0.18, -Math.PI / 2 + s * 0.22);
      g.add(pivot);
    }
    return g;
  },
};

// ------------------------------------------------------------------ objects from objects.json (your models, or the placeholders)
const interactive = [];              // things that open a folder ("opens") or say something on hover ("tip")
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
const STANDING = new Set(['desk', 'monitor', 'keyboard', 'mouse', 'mug', 'book', 'clock', 'phone', 'desklamp', 'trophy', 'bookshelf', 'bed']);
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
  if (o.opens || o.tip) {
    group.userData.entry = o;
    group.userData.glowMeshes = [];
    group.traverse(m => {
      if (m.isMesh && m.material?.emissive) {
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
function buildDesktop() {
  const icons = content.folders.filter(f => f.desktop).map(f => {
    const b = el('button', null, { className: 'icon', type: 'button' });
    b.append(el('span', f.icon, { className: 'glyph' }), el('span', f.name));
    b.addEventListener('click', () => openFolder(f.id));
    return b;
  });
  for (const cv of content.cvs || []) {
    const a = el('a', null, { className: 'icon', href: cv.file, download: '' });
    a.append(el('span', '📄', { className: 'glyph' }), el('span', `${cv.name}.pdf`));
    icons.push(a);
  }
  $('icons').replaceChildren(...icons);
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
function groupAt(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  let o = ray.intersectObject(world, true)[0]?.object;          // the nearest thing, so walls hide what's behind them
  while (o && !o.userData.entry) o = o.parent;
  return o || null;
}
function labelOf(g) {
  const { label, opens, tip } = g.userData.entry, f = folders[opens];
  if (!opens) return tip || label || '';
  return f && label && label !== f.name ? `${label} · ${f.name}` : label || f?.name || '';
}
function showTip(text, x, y) {
  const tip = $('tip');
  tip.textContent = text;
  tip.classList.toggle('on', !!text);
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
function hover(e) {
  const g = mode === 'room' ? groupAt(e.clientX, e.clientY) : null;
  hovered = g;
  canvas.style.cursor = g?.userData.entry.opens ? 'pointer' : 'grab';
  showTip(g ? labelOf(g) : '', e.clientX, e.clientY);
}
function tap(e, type) {
  if (mode !== 'room') return;
  const g = groupAt(e.clientX, e.clientY);
  if (!g) { hideSheet(); if (isOn('win')) closeWin(); return; }
  if (!g.userData.entry.opens) {                               // something that only has a tip, like the mug
    if (type !== 'mouse') {
      showTip(labelOf(g), Math.max(12, e.clientX - 120), e.clientY - 70);
      clearTimeout(tipTimer); tipTimer = setTimeout(() => $('tip').classList.remove('on'), 2500);
    }
    return;
  }
  if (type === 'mouse') act(g); else askFirst(g);              // on a phone: "Open Hobbies?" first
}
function act(g) {
  opened = true;
  $('hint').style.opacity = 0;
  if (g.userData.entry.opens === 'desktop') sitDown();
  else openFolder(g.userData.entry.opens, g);
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
  $('win-path').textContent = `~/Desktop/${f.name}`;
  $('win-content').replaceChildren(...folderNodes(f));
  $('win-content').scrollTop = 0;
  $('win').classList.toggle('side', mode !== 'computer');
  show('win');
  if (from && mode === 'room') turnTo(from);
  $('win-close').focus({ preventScroll: true });
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
$('desktop').addEventListener('click', e => { if (e.target === $('desktop')) standUp(); });
$('win-close').addEventListener('click', closeWin);
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

// ------------------------------------------------------------------ the "2010s memory" look: soft bloom, then fade, vignette, colour fringes
// (the grain is the CSS .grain-layer, see room/folders.css)
const target = new THREE.WebGLRenderTarget(innerWidth * PR, innerHeight * PR, { type: THREE.HalfFloatType, samples: TOUCH ? 0 : 4 });
const composer = new EffectComposer(renderer, target);
composer.setPixelRatio(PR);
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.4, 0.35, 0.85));
composer.addPass(new OutputPass());
composer.addPass(new ShaderPass({
  uniforms: { tDiffuse: { value: null } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      vec2 shift = c * dot(c, c) * 0.02;                               // colour fringes, stronger towards the edges
      vec3 col = vec3(texture2D(tDiffuse, vUv + shift).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - shift).b);
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(l), 0.14);                                   // a little less colour
      col *= vec3(1.04, 1.0, 0.92);                                    // warmer
      col = mix(vec3(0.075, 0.065, 0.07), vec3(0.97, 0.94, 0.88), col); // faded: blacks lifted, whites softened
      col *= 1.0 - 0.45 * smoothstep(0.3, 0.95, length(c * vec2(1.15, 1.0)) * 1.3);   // vignette
      col += vec3(1.0, 0.5, 0.25) * 0.05 * smoothstep(0.8, 0.0, distance(vUv, vec2(1.0)));  // a warm light leak
      gl_FragColor = vec4(col, 1.0);
    }`,
}));

// ------------------------------------------------------------------ every frame (drawing only when something changed); the clocks; resizing
const timer = new THREE.Clock();
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
  const pulse = opened || STILL ? 0 : Math.pow(Math.max(0, Math.sin(t * 0.95 - 1)), 8) * 0.1;
  for (const g of interactive) setGlow(g, g === hovered || g === pending ? 0.16 : g.userData.entry.opens ? pulse : 0);
  if (!dirty) return;
  dirty = false;
  camera.position.copy(view.pos);
  camera.rotation.set(view.pitch, view.yaw, 0);
  if (camera.fov !== view.fov) { camera.fov = view.fov; camera.updateProjectionMatrix(); }
  composer.render(dt);
});

let lastMinute = -1;
function tick() {
  const d = now();
  clockTex.redraw();                                   // every second: the colon blinks
  if (d.getMinutes() !== lastMinute) {
    lastMinute = d.getMinutes();
    screenTex.redraw(); phoneTex.redraw();
    $('clock').textContent = `${d.toLocaleDateString([], { weekday: 'short' })} ${timeText(d)}`;
  }
  if (d.getSeconds() % 30 === 0) applyTime();
}
applyTime();
tick();
setInterval(tick, 1000);

addEventListener('resize', () => {                       // always the visitor's window size (and zoom level)
  const pr = Math.min(devicePixelRatio, 1.25);
  renderer.setPixelRatio(pr); composer.setPixelRatio(pr);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  if (mode === 'room' && !isOn('win')) view.fovT = baseFov();
  invalidate();
});
