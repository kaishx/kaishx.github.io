// The view out of the window: Singapore from about the 16th floor of an HDB block. Blocks across the road and further
// off (open corridors that light up at night, lift cores, laundry on bamboo poles), green canopy between them, the CBD on
// the horizon with Marina Bay Sands and the Singapore Flyer, and big tropical clouds.
//
// It's a painted backdrop: everything is drawn nearer than it really is and shrunk to match, so from the chair it looks
// right (only the angles matter, and you never walk up to the window). Depth comes from the haze (main.js: the fog
// thickens with distance, so the CBD is paler than the blocks across the road). Cheap on purpose: two instanced meshes
// for every building, painted textures instead of geometry, nothing moves; main.js draws it after the room, so the
// part hidden by the walls costs nothing.
//
// main.js calls update(w) when the time of day changes; w = [night, dusk, day] weights that add up to 1.
import * as THREE from 'three';

const EYE = 48;                                       // the ground is this far below your eyes (m): about the 16th floor
const drawn = D => 40 + 360 * D / (D + 700);          // real distance (m) -> drawn distance; keeps near in front of far
const seeded = s => () => {                           // the same "random" every visit
  s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const R = seeded(1965);

function canvas(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}
function texture(c, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ------------------------------------------------------------------ an HDB facade: 8 bays x 16 floors, by day and lit at night
// Bays 0-4: the common corridor (a dark band over a white parapet; its ceiling lights make the stripes you see at night).
// Bay 5: the lift and stair core. Bays 6-7: flats (windows, air-con ledges, laundry). Tile = 28.8 m x 44.8 m.
const HDB_TILE = new THREE.Vector2(28.8, 44.8);
const CLOTHES = ['#c94f4f', '#3f6fb5', '#e8e4da', '#e2b23c', '#6aa37a', '#d77fa1', '#2e3440', '#f0f0f0'];
function hdbFacade(size) {
  const [dc, d] = canvas(size, size), [nc, n] = canvas(size, size);
  const bw = size / 8, fh = size / 16;
  d.fillStyle = '#e9e7e1'; d.fillRect(0, 0, size, size);
  n.fillStyle = '#000'; n.fillRect(0, 0, size, size);
  for (let f = 0; f < 16; f++) {
    const y = f * fh;
    for (let b = 0; b < 8; b++) {
      const x = b * bw;
      if (b < 5) {
        const top = y + fh * 0.08, rh = fh * 0.56;
        d.fillStyle = '#56606a'; d.fillRect(x, top, bw, rh);
        d.fillStyle = '#6d5a4c'; d.fillRect(x + bw * 0.16, top + fh * 0.08, bw * 0.16, rh * 0.86);
        d.fillStyle = '#80919c'; d.fillRect(x + bw * 0.46, top + fh * 0.12, bw * 0.36, rh * 0.42);
        d.fillStyle = '#f3f2ee'; d.fillRect(x, y + fh * 0.64, bw, fh * 0.36);
        d.fillStyle = '#d4d0c7'; d.fillRect(x, y, bw, fh * 0.08);
        n.fillStyle = 'rgba(190,205,228,0.5)'; n.fillRect(x, top, bw, rh);          // the lit corridor: a stripe per floor
        n.fillStyle = '#f2f6ff'; n.fillRect(x + bw * 0.38, top, bw * 0.24, fh * 0.08);
        if (R() < 0.45) { n.fillStyle = R() < 0.7 ? '#ffcf8f' : '#dfe7ff'; n.fillRect(x + bw * 0.46, top + fh * 0.12, bw * 0.36, rh * 0.42); }
      } else if (b === 5) {
        d.fillStyle = '#b8cfd2'; d.fillRect(x, y, bw, fh);
        d.fillStyle = '#5a666e'; d.fillRect(x + bw * 0.32, y + fh * 0.3, bw * 0.36, fh * 0.3);
        n.fillStyle = '#e6eeff'; n.fillRect(x + bw * 0.32, y + fh * 0.3, bw * 0.36, fh * 0.3);
      } else {
        d.fillStyle = '#e4e1da'; d.fillRect(x, y, bw, fh);
        d.fillStyle = '#cfcbc2'; d.fillRect(x, y + fh * 0.86, bw, fh * 0.14);
        d.fillStyle = '#6c7f8d'; d.fillRect(x + bw * 0.14, y + fh * 0.2, bw * 0.72, fh * 0.44);
        d.fillStyle = '#e4e1da'; d.fillRect(x + bw * 0.49, y + fh * 0.2, bw * 0.02, fh * 0.44);
        d.fillStyle = '#a9a69f'; d.fillRect(x + bw * 0.68, y + fh * 0.68, bw * 0.2, fh * 0.18);
        if (R() < 0.4) {                                  // laundry on bamboo poles
          d.fillStyle = '#5b5348'; d.fillRect(x + bw * 0.08, y + fh * 0.66, bw * 0.56, Math.max(1, fh * 0.03));
          for (let i = 0; i < 3; i++) {
            d.fillStyle = CLOTHES[Math.floor(R() * CLOTHES.length)];
            d.fillRect(x + bw * (0.1 + i * 0.18), y + fh * 0.69, bw * 0.12, fh * (0.1 + R() * 0.1));
          }
        }
        if (R() < 0.42) {
          const r = R();
          n.fillStyle = r < 0.6 ? '#ffd08c' : r < 0.9 ? '#e3ebff' : '#9fb4ff';
          n.fillRect(x + bw * 0.14, y + fh * 0.2, bw * 0.72, fh * 0.44);
        }
      }
    }
    d.fillStyle = 'rgba(0,0,0,0.07)'; d.fillRect(0, y, size, Math.max(1, fh * 0.03));
  }
  for (let i = 0; i < 40; i++) {                          // rain streaks: faint grime running down from the ledges
    const x = R() * size, y = R() * size, h = fh * (1 + R() * 4);
    const g = d.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(60,60,55,0.12)'); g.addColorStop(1, 'rgba(60,60,55,0)');
    d.fillStyle = g; d.fillRect(x, y, size / 200 + R() * size / 120, h);
  }
  return [texture(dc), texture(nc)];
}

// ------------------------------------------------------------------ an office tower's glass: 8 bays x 32 floors
const GLASS_TILE = new THREE.Vector2(36, 134.4);
function glassFacade(w, h) {
  const [dc, d] = canvas(w, h), [nc, n] = canvas(w, h);
  const g = d.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#8ea2b2'); g.addColorStop(1, '#73889a');
  d.fillStyle = g; d.fillRect(0, 0, w, h);
  n.fillStyle = '#000'; n.fillRect(0, 0, w, h);
  const cw = w / 8, fh = h / 32;
  for (let f = 0; f < 32; f++) {
    d.fillStyle = 'rgba(210,220,228,0.55)'; d.fillRect(0, f * fh, w, Math.max(1, fh * 0.14));
    const busy = R() < 0.5;
    for (let c = 0; c < 8; c++) {
      if (busy && R() < 0.7) { n.fillStyle = R() < 0.75 ? '#e4ecff' : '#ffe3b4'; n.fillRect(c * cw, f * fh + fh * 0.18, cw, fh * 0.7); }
    }
  }
  for (let c = 0; c <= 8; c++) { d.fillStyle = 'rgba(225,232,238,0.7)'; d.fillRect(c * cw - 1, 0, Math.max(1, cw * 0.08), h); }
  return [texture(dc), texture(nc)];
}

// Instanced boxes whose facade texture is measured in metres: the shader scales each box's UVs by its real size (the
// instance scale divided by aK, how much it was shrunk), shifts each building's pattern a few bays / floors so no two
// look alike, and paints the roofs plain.
function facadeMaterial([map, emissiveMap], tile, roof) {
  const m = new THREE.MeshStandardMaterial({ map, emissiveMap, emissive: '#ffffff', emissiveIntensity: 0, roughness: 0.9 });
  m.onBeforeCompile = sh => {
    sh.uniforms.tile = { value: tile };
    sh.uniforms.roofColour = { value: new THREE.Color(roof) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aK;\nuniform vec2 tile;\nvarying float vRoof;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        {
          vec3 s = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz)) / aK;
          vec2 face = abs(normal.x) > 0.5 ? s.zy : (abs(normal.y) > 0.5 ? s.xz : s.xy);
          float h = fract(sin(float(gl_InstanceID) * 12.9898 + 4.1) * 43758.5453);
          vec2 st = uv * face / tile + vec2(floor(h * 8.0) / 8.0, floor(fract(h * 37.0) * 16.0) / 16.0);
          vMapUv = st; vEmissiveMapUv = st;
          vRoof = step(0.5, abs(normal.y));
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 roofColour;\nvarying float vRoof;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, roofColour, vRoof);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= 1.0 - vRoof;');
  };
  m.customProgramCacheKey = () => `facade-${tile.x}-${tile.y}`;
  return m;
}

function instanced(list, material) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, list.length);
  const k = new Float32Array(list.length), dummy = new THREE.Object3D(), colour = new THREE.Color();
  list.forEach((b, i) => {
    const r = b.r ?? drawn(b.D), s = r / b.D;
    dummy.position.set(Math.sin(b.az) * r, ((b.base || 0) + b.h / 2 - EYE) * s, -Math.cos(b.az) * r);
    dummy.rotation.set(0, -b.az + (b.turn || 0), 0);         // the long side faces the window
    dummy.scale.set(b.w * s, b.h * s, b.d * s);
    dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, colour.set(b.tint || '#ffffff'));
    k[i] = s;
  });
  mesh.geometry.setAttribute('aK', new THREE.InstancedBufferAttribute(k, 1));
  mesh.frustumCulled = false; mesh.raycast = () => {};
  return mesh;
}

// ------------------------------------------------------------------ the ground far below: tree canopy, roads, street lights
function ground() {
  const [dc, d] = canvas(1024, 256), [nc, n] = canvas(1024, 256);
  d.fillStyle = '#4f6a48'; d.fillRect(0, 0, 1024, 256);
  n.fillStyle = '#000'; n.fillRect(0, 0, 1024, 256);
  for (let i = 0; i < 900; i++) {                         // canopy, roofs, open fields
    const r = R();
    d.fillStyle = r < 0.6 ? `rgba(${40 + R() * 40},${70 + R() * 50},${35 + R() * 30},0.8)` : r < 0.85 ? 'rgba(150,152,148,0.7)' : 'rgba(196,186,170,0.6)';
    d.beginPath(); d.arc(R() * 1024, R() * 256, 3 + R() * 14, 0, Math.PI * 2); d.fill();
  }
  for (let i = 0; i < 14; i++) {                          // roads, lined with orange street lights at night
    let x = R() * 1024, y = 0; const dx = (R() - 0.5) * 3;
    d.strokeStyle = 'rgba(120,122,124,0.9)'; d.lineWidth = 2; d.beginPath(); d.moveTo(x, y);
    while (y < 256) {
      x += dx + (R() - 0.5) * 2; y += 4; d.lineTo(x, y);
      if (R() < 0.5) { n.fillStyle = R() < 0.85 ? '#ffb45e' : '#f4f2ff'; n.fillRect(((x % 1024) + 1024) % 1024, y, 2, 2); }
    }
    d.stroke();
  }
  const A0 = -2.1, A1 = 0.7, RA = 34, RR = 30, pos = [], uv = [], idx = [];
  for (let j = 0; j <= RR; j++) {
    const r = 46 + (398 - 46) * Math.pow(j / RR, 0.8), D = 700 * (r - 40) / (400 - r);
    for (let i = 0; i <= RA; i++) {
      const a = A0 + (A1 - A0) * i / RA;
      pos.push(Math.sin(a) * r, -EYE * r / D, -Math.cos(a) * r);
      uv.push(i / RA * 3, Math.log(D) * 0.6);
    }
  }
  for (let j = 0; j < RR; j++) for (let i = 0; i < RA; i++) {
    const p = j * (RA + 1) + i;
    idx.push(p, p + RA + 1, p + 1, p + 1, p + RA + 1, p + RA + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx); geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ map: texture(dc), emissiveMap: texture(nc), emissive: '#ffffff', emissiveIntensity: 0, roughness: 1, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat); mesh.raycast = () => {};
  return mesh;
}

// ------------------------------------------------------------------ clouds: soft cumulus, tinted by the time of day
function cloudTexture(seed) {
  const r = seeded(seed), [c, g] = canvas(512, 256);
  for (let i = 0; i < 38; i++) {
    const x = 70 + r() * 372, spread = 1 - Math.abs(x - 256) / 256, y = 175 - r() * 95 * spread, rad = 26 + r() * 50 * (0.5 + spread);
    const grad = g.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)'); grad.addColorStop(0.6, 'rgba(255,255,255,0.55)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  g.globalCompositeOperation = 'source-atop';               // grey, flat-ish undersides
  const shade = g.createLinearGradient(0, 90, 0, 230);
  shade.addColorStop(0, 'rgba(150,160,178,0)'); shade.addColorStop(1, 'rgba(120,130,150,0.7)');
  g.fillStyle = shade; g.fillRect(0, 0, 512, 256);
  return texture(c, false);
}

// ------------------------------------------------------------------ build it
export function createOutside(scene, { touch = false } = {}) {
  const group = new THREE.Group();
  scene.add(group);

  // HDB blocks: [az (radians; the window is at about -0.6), real distance, width, depth, height, turn, tint]
  const PASTEL = ['#ffffff', '#f4ead8', '#e6eef0', '#f2e3dc', '#e8efe2', '#efe9f2', '#f6f0d8'];
  const hdb = [
    { az: -1.0, D: 78, w: 46, d: 14, h: 66, turn: 0.1, tint: '#f6efe0' },        // right across the road, on the left
    { az: -0.2, D: 100, w: 52, d: 14, h: 60, turn: -0.18, tint: '#e4edf0' },     // and on the right
    { az: -0.57, D: 190, w: 44, d: 14, h: 46, turn: 0.32, tint: '#f2e6dc' },     // lower, between them (below the skyline)
    { az: -1.32, D: 140, w: 40, d: 14, h: 72, turn: -0.3, tint: '#eef0e6' },
  ];
  for (let i = 0; i < 70; i++) {                         // the estate around: slabs and point blocks
    const D = 230 + Math.pow(R(), 1.3) * 900, az = -1.7 + R() * 2.3;
    const towardsCBD = Math.abs(az + 0.6) < 0.16;         // keep the skyline clear: only low blocks in front of it
    const point = R() < 0.35, h = towardsCBD ? 30 + R() * 22 : 33 + R() * 50 + (R() < 0.12 ? 45 : 0);
    hdb.push({ az, D, w: point ? 20 + R() * 6 : 34 + R() * 34, d: point ? 18 + R() * 5 : 13 + R() * 3, h, turn: (R() - 0.5) * 1.2,
      tint: PASTEL[Math.floor(R() * PASTEL.length)] });
  }
  for (let i = 0; i < 120; i++) {                        // the rest of the island, fading into the haze
    const D = 1100 + R() * 3600, az = -1.9 + R() * 2.6;
    if (Math.abs(az + 0.6) < 0.16 && D > 1500) continue;
    hdb.push({ az, D, w: 25 + R() * 45, d: 14 + R() * 8, h: 30 + R() * 70, turn: (R() - 0.5) * 1.4, tint: PASTEL[Math.floor(R() * PASTEL.length)] });
  }
  for (const b of hdb.slice(0, 74)) {                    // rooftops: the lift motor room and water tanks
    if (b.D > 700) continue;
    hdb.push({ ...b, base: b.h, h: 4.5, w: b.w * 0.22, d: b.d * 0.6, turn: b.turn, tint: '#d8d5ce' });
  }
  const hdbMat = facadeMaterial(hdbFacade(touch ? 512 : 1024), HDB_TILE, '#8d8f8f');
  hdbMat.color.set('#d4d1ca');                            // painted concrete, not paper-white
  group.add(instanced(hdb, hdbMat));

  // The CBD: office towers around Marina Bay Sands, with the Flyer. Drawn as if 3 km away (a little nearer than real,
  // so it reads from the chair); centred on the window.
  const CBD_D = 3000, CBD_R = drawn(CBD_D), s = CBD_R / CBD_D;
  const towers = [];
  for (let i = 0; i < 17; i++) {
    const az = -0.7 + R() * 0.15;
    towers.push({ az, D: CBD_D + (R() - 0.3) * 500, w: 40 + R() * 25, d: 40 + R() * 20, h: 140 + R() * 150, turn: R() * 0.8, tint: ['#ffffff', '#dfe8ef', '#c8d4dc', '#eef0f2'][i % 4] });
  }
  // Marina Bay Sands: three towers in a row, all drawn at the same scale so they stay lined up under the SkyPark
  const mbsAz = -0.53, axis = mbsAz + 0.25, along = new THREE.Vector3(Math.cos(axis), 0, Math.sin(axis));
  const mbsAt = off => {                                   // a point "off" metres along the hotel's long axis
    const c = new THREE.Vector3(Math.sin(mbsAz), 0, -Math.cos(mbsAz)).multiplyScalar(CBD_D).addScaledVector(along, off);
    const D = Math.hypot(c.x, c.z);
    return { az: Math.atan2(c.x, -c.z), D, r: D * s };
  };
  for (const off of [-100, 0, 100]) {
    const at = mbsAt(off);
    towers.push({ ...at, w: 52, d: 30, h: 194, turn: at.az - axis, tint: '#e9edf0' });
  }
  // No two towers inside each other: where they were, their windows flickered against each other (owner, 2026-11-06,
  // the tall one by Marina Bay Sands). Each office tower, in turn, steps back until it is clear of Marina Bay Sands and
  // of the towers already placed (footprints as circles, in drawn space).
  const spot = b => { const r = b.r ?? drawn(b.D), k = r / b.D; return [Math.sin(b.az) * r, -Math.cos(b.az) * r, 0.5 * Math.hypot(b.w, b.d) * k]; };
  const placed = towers.slice(17);
  for (const b of towers.slice(0, 17)) {
    const hits = () => { const [x, z, rad] = spot(b); return placed.some(o => { const [ox, oz, orad] = spot(o); return Math.hypot(x - ox, z - oz) < rad + orad; }); };
    while (hits()) b.D += 120;
    placed.push(b);
  }
  const glassMat = facadeMaterial(glassFacade(256, 512), GLASS_TILE, '#7d8790');
  group.add(instanced(towers, glassMat));
  // The SkyPark across the top, overhanging the north tower, lit along its edge at night
  const parkMat = new THREE.MeshStandardMaterial({ color: '#d9dee2', roughness: 0.6, emissive: '#cfe0ff', emissiveIntensity: 0 });
  const park = new THREE.Mesh(new THREE.BoxGeometry(340 * s, 9 * s, 38 * s), parkMat);
  const mid = mbsAt(44);                                   // 340 m long: over all three towers and 67 m beyond one
  park.position.set(Math.sin(mid.az) * mid.r, (198.5 - EYE) * s, -Math.cos(mid.az) * mid.r);
  park.rotation.y = -axis;
  park.raycast = () => {};
  group.add(park);
  // The Singapore Flyer: a 150 m wheel on legs
  const flyerMat = new THREE.MeshBasicMaterial({ color: '#c9d0d6' });
  const flyer = new THREE.Group();
  flyer.add(new THREE.Mesh(new THREE.TorusGeometry(75, 1.6, 4, 72), flyerMat));
  const spokes = [];
  for (let i = 0; i < 14; i++) { const a = i / 14 * Math.PI * 2; spokes.push(0, 0, 0, Math.cos(a) * 75, Math.sin(a) * 75, 0); }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(spokes, 3));
  const spokeMat = new THREE.LineBasicMaterial({ color: '#9aa3ab', transparent: true, opacity: 0.6 });
  flyer.add(new THREE.LineSegments(sg, spokeMat));
  for (const sx of [-1, 1]) {                             // an A-frame from the hub down to the ground
    const leg = new THREE.Mesh(new THREE.BoxGeometry(3, 93, 3), flyerMat);
    leg.position.set(sx * 12.5, -45, 0); leg.rotation.z = sx * 0.27; flyer.add(leg);
  }
  const fAz = -0.465;
  flyer.position.set(Math.sin(fAz) * CBD_R, (90 - EYE) * s, -Math.cos(fAz) * CBD_R);
  flyer.scale.setScalar(s); flyer.rotation.y = -fAz + 0.5;
  flyer.traverse(m => { m.raycast = () => {}; });
  group.add(flyer);

  const land = ground();
  group.add(land);

  // Red aircraft warning lights on the tallest roofs
  const warn = [];
  for (const b of [...hdb.slice(0, 4), ...towers]) {
    const r = b.r ?? drawn(b.D), k = r / b.D;
    warn.push(Math.sin(b.az) * r, ((b.base || 0) + b.h - EYE) * k + 0.05, -Math.cos(b.az) * r);
  }
  const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(warn, 3));
  const warnMat = new THREE.PointsMaterial({ color: new THREE.Color(3, 0.25, 0.2), size: 2.5, sizeAttenuation: false, transparent: true, depthWrite: false });
  const warnPts = new THREE.Points(wg, warnMat); warnPts.raycast = () => {}; group.add(warnPts);

  // Clouds
  const cloudMats = [];
  const cloudTex = [cloudTexture(11), cloudTexture(23), cloudTexture(37)];
  for (let i = 0; i < 9; i++) {
    const az = -1.5 + i * 0.22 + (R() - 0.5) * 0.12, el = 0.05 + R() * 0.24, r = 405 + R() * 20, w = 90 + R() * 90;
    const mat = new THREE.MeshBasicMaterial({ map: cloudTex[i % 3], transparent: true, depthWrite: false, fog: false, color: '#ffffff' });
    const c = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.5), mat);
    c.position.set(Math.sin(az) * Math.cos(el) * r, Math.sin(el) * r, -Math.cos(az) * Math.cos(el) * r);
    c.lookAt(0, c.position.y * 0.6, 0);
    c.raycast = () => {};
    group.add(c); cloudMats.push(mat);
  }

  const DAY = new THREE.Color('#ffffff'), DUSK = new THREE.Color('#ffc7a8'), NIGHT = new THREE.Color('#29242f');
  const FLYER_DAY = new THREE.Color('#c9d0d6'), FLYER_NIGHT = new THREE.Color(1.2, 1.7, 2.6);
  return {
    update([night, dusk, day]) {
      hdbMat.emissiveIntensity = night * 1.6 + dusk * 0.6;
      glassMat.emissiveIntensity = night * 1.1 + dusk * 0.7;
      parkMat.emissiveIntensity = night * 0.9 + dusk * 0.3;
      land.material.emissiveIntensity = night * 1.4 + dusk * 0.4;
      flyerMat.color.copy(FLYER_DAY).lerp(FLYER_NIGHT, night);
      spokeMat.color.copy(flyerMat.color).multiplyScalar(0.8);
      warnMat.opacity = night + dusk * 0.4; warnPts.visible = warnMat.opacity > 0.02;
      const tint = new THREE.Color().setRGB(
        NIGHT.r * night + DUSK.r * dusk + DAY.r * day, NIGHT.g * night + DUSK.g * dusk + DAY.g * day, NIGHT.b * night + DUSK.b * dusk + DAY.b * day);
      for (const m of cloudMats) { m.color.copy(tint).multiplyScalar(0.82); m.opacity = 0.92 - night * 0.45; }   // never bright enough to glow like a sun
    },
  };
}
