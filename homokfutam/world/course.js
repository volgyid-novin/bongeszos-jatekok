import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ATMO } from '../gfx/atmosphere.js';
import { WIND_DIR } from '../gfx/wind.js';
import { GPU, N } from '../gfx/backend.js';
import { clothMaterial } from './dressing.js';

// ============================================================
//  Out on the course (docs/visual-next-steps.md E4, E5): the props are assets/world/course.glb
//  (models/world/build_course.py).
//
//  Markers (?gfx=markers:1): without the chase lights the open stretches lost their rhythm of close things
//  rushing by. Weathered wooden poles every 25-40 m on both sides just past the berm, each with a strip of
//  faded cloth streaming downwind and flapping in the gusts (the one wind, E2), the odd one leaning or
//  snapped; stone cairns beside the chevron boards on the outsides of the corners; old drums half sunk in the
//  sand where the braking for a corner starts. Nothing blinks.
//
//  Camps (?gfx=camps:1): a real desert rally has people on every vantage point. Groups of spectators on the
//  stone bridge, on the canyon rim over the tunnel's gaps, on top of the arch and on a dune crest by a fast
//  corner; behind them tents, an awning, hover-bikes, a cargo crawler, a smoking fire and a banner strung
//  between two poles. They cheer as the pack comes by (each group on its own).
//
//  Draws: everything static is merged into two meshes (the props, the stones), the cloth into three
//  instanced meshes (strips, awnings, banners), plus one crowd draw per group.
// ============================================================
export const COURSE_URL = new URL('../assets/world/course.glb', import.meta.url).href;
const TAU = Math.PI * 2;
const C = (h) => new THREE.Color(h);
const WIND_YAW = Math.atan2(WIND_DIR.y, WIND_DIR.x);
const STRIPS = ['#b8452f', '#d9c7a5', '#c97a2e', '#4f6f86', '#a03a2a', '#d8b25a'].map(C);
const CANVAS = ['#e8dcc4', '#c96f3c', '#5d7e8c', '#b5523a', '#d9b26a', '#8a9a6c'].map(C);
const PAINT = ['#d0562a', '#3f78b0', '#e6c13c', '#e9e4da', '#5e8a4a', '#b0302c'].map(C);

// vertex colour tint, darkened by the occlusion Blender baked into aAO
function propMaterial(params = {}) {
  if (GPU) return N.propNodeMaterial(params);
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, ...params });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, ATMO);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAO;\nvarying float vAO;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAO = aAO;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAO;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix( 1.0, vAO, 0.75 );');
  };
  m.customProgramCacheKey = () => 'prop-ao';
  return m;
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ctx: { scene, TR, Q, groundQuery, surfaceAt, trackPoint, rng, models (course.glb), rockMat (stones with aAO),
//   dress (world/dressing.js: crowdGroup, shirts, boards), walls (main.js CANYON_WALLS), tunnel, arch: { mesh, s },
//   bridge, fx: { smoke(x, y, z) } }
export function buildCourse(ctx) {
  const { scene, TR, Q, surfaceAt, trackPoint, rng, models, rockMat, dress, walls, tunnel, arch, bridge, fx } = ctx;
  const groundQuery = ctx.groundQuery;
  const rand = rng(6060);
  const tp = { x: 0, y: 0, z: 0, yaw: 0, i: 0 };
  const at = (s, d) => { trackPoint(((s % TR.L) + TR.L) % TR.L, d, tp); return { x: tp.x, y: tp.y, z: tp.z, yaw: tp.yaw, i: tp.i }; };
  const open = (i) => TR.canyon[i] < 0.03 && TR.arena[i] < 0.03;
  const gapTo = (s, s1) => { const d = Math.abs(s - s1) % TR.L; return Math.min(d, TR.L - d); };
  const props = [], stones = [];                 // [geometry name, Matrix4, tint Color | null]
  const strips = [], awnings = [], banners = []; // Matrix4 + colour for the cloth
  const Y = new THREE.Vector3(0, 1, 0), P = new THREE.Vector3(), S = new THREE.Vector3(1, 1, 1);
  const place = (list, name, x, y, z, yaw = 0, tilt = 0, tiltDir = 0, scale = 1, tint = null) => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(tiltDir), 0, Math.sin(tiltDir)), tilt)
      .multiply(new THREE.Quaternion().setFromAxisAngle(Y, yaw));
    const m = new THREE.Matrix4().compose(P.set(x, y, z), q, S.setScalar(scale));
    if (models.get(name)) list.push([name, m, tint]);
    return m;
  };
  const out = { groups: [], counts: {} };

  // ---------------- markers ----------------
  if (Q.markers) {
    // poles with a cloth strip, on both sides of the open stretches, 25-40 m apart, just past the berm's ridge
    let poles = 0;
    for (const side of [-1, 1]) {
      for (let s = rand() * 30; s < TR.L; s += 25 + rand() * 15) {
        const c = at(s, 0);
        if (!open(c.i) || (arch && gapTo(s, arch.s) < 50)) continue;
        const d = side * (TR.hw[c.i] + 3.4 + rand() * 1.4), p = at(s, d);
        const y = surfaceAt(p.i, s, d, p.x, p.z);
        const snapped = rand() < 0.08, lean = !snapped && rand() < 0.18;
        const m = place(props, snapped ? 'marker_pole1' : 'marker_pole0', p.x, y - 0.15, p.z, rand() * TAU,
          lean ? 0.1 + rand() * 0.16 : rand() * 0.04, rand() * TAU, 0.9 + rand() * 0.2);
        poles++;
        // the strip is tied just under the top, and streams downwind
        if (!snapped) strips.push([new THREE.Matrix4().compose(new THREE.Vector3(0.03, 2.73, 0).applyMatrix4(m), new THREE.Quaternion().setFromAxisAngle(Y, -WIND_YAW), S.setScalar(1)),
          STRIPS[Math.floor(rand() * STRIPS.length)].clone().multiplyScalar(0.75 + rand() * 0.3)]);
      }
    }
    // cairns beside the chevron boards on the outsides of the corners (dressing.js puts the boards hw + 7 out)
    for (const [i, dir] of dress.boards || []) {
      const s = TR.s[i] + 3 + rand() * 2, d = (dir > 0 ? 1 : -1) * (TR.hw[i] + 9.5 + rand() * 1.5), p = at(s, d);
      place(stones, rand() < 0.6 ? 'cairn0' : 'cairn1', p.x, surfaceAt(p.i, s, d, p.x, p.z) - 0.08, p.z, rand() * TAU, rand() * 0.06, rand() * TAU, 0.9 + rand() * 0.35);
    }
    // drums where the braking for a corner starts (TR.vmax already brakes ahead of the corners): on its outside
    let drums = 0, last = -1e9;
    for (let i = 2; i < TR.N; i++) {
      if (!(TR.vmax[i] < TR.vmax[i - 1] - 0.05 && TR.vmax[i - 1] >= TR.vmax[i - 2])) continue;
      let lo = i;
      for (let k = 0; k < 60; k++) { const j = TR.idx(i + k); if (TR.vmax[j] < TR.vmax[lo]) lo = j; }
      if (TR.vmax[i - 1] - TR.vmax[lo] < 12 || !open(i) || TR.s[i] - last < 150) continue;
      last = TR.s[i];
      const side = TR.k[lo] > 0 ? 1 : -1;               // a left turn (k > 0) has its outside on the right (+d)
      for (let n = 0, cnt = 2 + Math.floor(rand() * 2); n < cnt; n++) {
        const s = TR.s[i] + (rand() - 0.5) * 9, d = side * (TR.hw[i] + 4.6 + rand() * 3), p = at(s, d);
        place(props, rand() < 0.5 ? 'drum0' : 'drum1', p.x, surfaceAt(p.i, s, d, p.x, p.z) - 0.25 - rand() * 0.25, p.z, rand() * TAU, rand() * 0.45, rand() * TAU);
        drums++;
      }
    }
    out.counts.poles = poles; out.counts.drums = drums;
  }

  // ---------------- camps ----------------
  // a group: people (feet positions) and a centre for the cheering; props go into the lists above
  const group = (name, people, centre) => {
    if (!people.length || !dress.crowdGroup) return;
    const pos = [], col = [];
    for (const p of people) {
      pos.push(p.x, p.y, p.z, rand() * 100);
      const c = dress.shirts[Math.floor(rand() * dress.shirts.length)], v = 0.75 + rand() * 0.4;
      col.push(c.r * v, c.g * v, c.b * v, rand());
    }
    const g = dress.crowdGroup(pos, col);
    out.groups.push({ name, ...g, centre, cheer: 0, n: people.length });
  };
  // a camp: laid out in a frame at o (A along the track, B away from it), heights from h(x, z)
  const camp = (o, A, B, h, { tents = 2, bikes = 2, crawler = false, awning = true, fire = true, banner = true } = {}) => {
    const pt = (a, b) => { const x = o.x + A.x * a + B.x * b, z = o.z + A.z * a + B.z * b; return { x, y: h(x, z), z }; };
    const facing = Math.atan2(-B.x, -B.z);      // three's yaw that turns +z towards the track
    for (let k = 0; k < tents; k++) {
      const p = pt(-12 + k * 7 + rand() * 2, 8 + rand() * 6);
      place(props, 'tent', p.x, p.y - 0.05, p.z, facing + Math.PI / 2 + (rand() - 0.5) * 0.6, 0, 0, 1, CANVAS[Math.floor(rand() * CANVAS.length)]);
    }
    for (let k = 0; k < bikes; k++) {
      const p = pt(4 + k * 2.6 + rand(), 3 + rand() * 3);
      place(props, 'bike', p.x, p.y, p.z, facing + Math.PI / 2 + (rand() - 0.5) * 0.4, 0, 0, 1, PAINT[Math.floor(rand() * PAINT.length)]);
    }
    if (crawler) { const p = pt(14 + rand() * 4, 14 + rand() * 4); place(props, 'crawler', p.x, p.y - 0.1, p.z, facing + Math.PI / 2 + (rand() - 0.5) * 0.5); }
    if (awning) {
      const p = pt(-3 + rand() * 2, 4 + rand() * 2), yaw = facing + (rand() - 0.5) * 0.3;
      const m = place(props, 'awning', p.x, p.y, p.z, yaw);
      // its canvas: tied along the high bar (Blender y -1.2 -> +z here, 2.3 m), loose over the low bar (1.9 m)
      const a = new THREE.Vector3(0, 2.3, 1.2), b = new THREE.Vector3(0, 1.9, -1.2);
      const X = b.clone().sub(a).normalize(), Yv = new THREE.Vector3(1, 0, 0), Z = X.clone().cross(Yv);
      awnings.push([m.clone().multiply(new THREE.Matrix4().makeBasis(X, Yv, Z).setPosition(a)), CANVAS[Math.floor(rand() * CANVAS.length)]]);
    }
    if (fire) {
      const p = pt(-2 + rand() * 2, 9 + rand() * 2);
      place(props, 'firepit', p.x, p.y - 0.04, p.z, rand() * TAU);
      out.fires.push(new THREE.Vector3(p.x, p.y + 0.2, p.z));
    }
    if (banner) {
      // two poles 5 m apart, the banner hanging between their tops, facing the track
      const p0 = pt(-8, 1.5), p1 = pt(-3, 1.5);
      place(props, 'marker_pole0', p0.x, p0.y - 0.3, p0.z, rand() * TAU, 0, 0, 1.35);
      place(props, 'marker_pole0', p1.x, p1.y - 0.3, p1.z, rand() * TAU, 0, 0, 1.35);
      const mid = new THREE.Vector3((p0.x + p1.x) / 2, Math.min(p0.y, p1.y) + 3.65, (p0.z + p1.z) / 2);
      banners.push([new THREE.Matrix4().makeBasis(A.clone(), new THREE.Vector3(0, 1, 0), B.clone().negate()).setPosition(mid), Math.floor(rand() * 4), C('#ffffff')]);
    }
  };
  out.fires = [];
  if (Q.camps) {
    const rc = new THREE.Raycaster(), DOWN = new THREE.Vector3(0, -1, 0);
    const down = (mesh, x, z, y0) => {
      rc.set(P.set(x, y0, z), DOWN); rc.far = 400;
      const h = rc.intersectObject(mesh.isLOD ? mesh.levels[0].object : mesh, false)[0];
      return h ? h.point.y : null;
    };
    const frame = (s) => { const c = at(s, 0); return { c, T: new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw)), R: new THREE.Vector3(-Math.cos(c.yaw), 0, Math.sin(c.yaw)) }; };

    // the stone bridge: people along both edges of its deck; two banners hang off the side facing the pack
    if (bridge?.userData.s !== undefined) {
      bridge.updateMatrixWorld(true);
      const { c, T, R } = frame(bridge.userData.s), hw = TR.hw[c.i], people = [];
      const top = bridge.position.y + 60;
      // right at the edges, where they show against the sky from the slot below (the deck is ~16 m deep)
      for (let k = 0; k < 18; k++) {
        const dir = k % 2 ? 1 : -1, d = (rand() * 2 - 1) * (hw + 6);
        let last = null;
        for (let a = 3; a < 14; a += 0.5) {
          const x = c.x + T.x * a * dir + R.x * d, z = c.z + T.z * a * dir + R.z * d, y = down(bridge, x, z, top);
          if (y !== null) last = { x, y, z, a }; else if (last) break;
        }
        if (last) {
          const a = last.a - 0.6 - rand() * 0.8, x = c.x + T.x * a * dir + R.x * d, z = c.z + T.z * a * dir + R.z * d, y = down(bridge, x, z, top);
          if (y !== null) people.push({ x, y, z });
        }
      }
      group('bridge', people, new THREE.Vector3(c.x, bridge.position.y, c.z));
      // the banners: off the deck's edge on the side the pods come from (the last hit stepping back along the track)
      for (const d of [-0.35 * hw, 0.4 * hw]) {
        let edge = null;
        for (let a = 0; a < 16; a += 0.5) {
          const x = c.x - T.x * a + R.x * d, z = c.z - T.z * a + R.z * d, y = down(bridge, x, z, top);
          if (y !== null) edge = { a, y }; else if (edge) break;
        }
        if (!edge) continue;
        const x = c.x - T.x * (edge.a + 0.6) + R.x * d, z = c.z - T.z * (edge.a + 0.6) + R.z * d;
        banners.push([new THREE.Matrix4().makeBasis(R.clone(), new THREE.Vector3(0, 1, 0), T.clone().negate()).setPosition(x, edge.y - 1.5, z), Math.floor(rand() * 4), C('#ffffff')]);
      }
    }

    // the canyon rim over the tunnel's gaps (and the tunnel's mouth): people at the edge, looking down into the
    // slot (silhouettes against the sky from below); their camp back from the edge on the rim's top
    const rimAt = (prof, s, o) => {
      let best = prof.rows[0];
      for (const r of prof.rows) if (Math.abs(r.s - s) < Math.abs(best.s - s)) best = r;
      const R = best, J = R.J;
      let y = R.y[J + 4];
      for (let j = J; j < J + 4; j++) if (o <= R.o[j + 1]) { y = R.y[j] + (R.y[j + 1] - R.y[j]) * (o - R.o[j]) / Math.max(R.o[j + 1] - R.o[j], 1e-3); break; }
      return { x: R.x + R.rx * o, y, z: R.z + R.rz * o, R };
    };
    const spots = [];
    for (let k = 0; k + 1 < tunnel.length; k++) spots.push((tunnel[k][1] + tunnel[k + 1][0]) / 2);
    if (tunnel.length) spots.push(tunnel[tunnel.length - 1][1] + 14);
    spots.forEach((s, n) => {
      const prof = walls[(n + 1) % walls.length];
      if (!prof) return;
      const people = [];
      // on the face's very top edge (the rim rises behind it and would hide them from the slot)
      for (let k = 0; k < 11; k++) {
        const ss = s + (rand() - 0.5) * 16;
        const r0 = rimAt(prof, ss, 0).R, o = r0.o[r0.J] - 0.2 + rand() * 1.2;
        const p = rimAt(prof, ss, o);
        people.push({ x: p.x, y: Math.max(p.y, r0.y[r0.J]) - 0.1, z: p.z });
      }
      const r0 = rimAt(prof, s, 0).R;
      const o = rimAt(prof, s, r0.hw + 34), A = new THREE.Vector3(Math.sin(at(s, 0).yaw), 0, Math.cos(at(s, 0).yaw)), B = new THREE.Vector3(r0.rx, 0, r0.rz);
      group('rim', people, new THREE.Vector3(o.x, o.y, o.z));
      // the rim's top, from the profile (between its points J+1 .. J+4), near enough flat for a camp
      const hAt = (x, z) => { const dx = x - r0.x, dz = z - r0.z; return rimAt(prof, s, dx * r0.rx + dz * r0.rz).y; };
      camp(o, A, B, hAt, { tents: 2, bikes: 2, crawler: n === 0, awning: true, fire: true, banner: n % 2 === 0 });
    });

    // on top of the arch
    if (arch?.mesh) {
      arch.mesh.updateMatrixWorld(true);
      // along its front and back edges (its top is broad and rounded: anywhere else the bulge hides them from the
      // road); most on the side the pack comes from
      const { c, T, R } = frame(arch.s), hw = TR.hw[c.i], people = [];
      for (let k = 0; k < 12; k++) {
        const dir = k % 3 ? -1 : 1, d = (rand() * 2 - 1) * (hw + 2);
        let last = null;
        for (let a = 0; a < 30; a += 0.75) {
          const x = c.x + T.x * a * dir + R.x * d, z = c.z + T.z * a * dir + R.z * d, y = down(arch.mesh, x, z, c.y + 200);
          if (y !== null && y > c.y + 15) last = { a }; else if (last) break;
        }
        if (!last) continue;
        const a = last.a - 1 - rand(), x = c.x + T.x * a * dir + R.x * d, z = c.z + T.z * a * dir + R.z * d, y = down(arch.mesh, x, z, c.y + 200);
        if (y !== null) people.push({ x, y, z });
      }
      group('arch', people, new THREE.Vector3(c.x, c.y + 30, c.z));
    }

    // a dune crest outside a fast corner on the open desert: the crowd along the crest, the camp behind it
    {
      let best = -1, bi = -1;
      const top = Math.max(...TR.vmax);
      for (let i = 0; i < TR.N; i++) {
        const k = Math.abs(TR.k[i]);
        if (!open(i) || k < 0.0025 || k > 0.009 || TR.vmax[i] < 0.75 * top) continue;
        if (arch && gapTo(TR.s[i], arch.s) < 200) continue;
        const sc = k * TR.vmax[i];
        if (sc > best) { best = sc; bi = i; }
      }
      if (bi >= 0) {
        const s = TR.s[bi], side = TR.k[bi] > 0 ? 1 : -1, hw = TR.hw[bi];
        let pick = null;
        for (let d = hw + 40; d <= hw + 95; d += 5) { const p = at(s, side * d), g = groundQuery(p.x, p.z); if (!pick || g > pick.g + 0.5) pick = { d, g, p }; }
        const c = at(s, 0), A = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw)), B = new THREE.Vector3(-Math.cos(c.yaw) * side, 0, Math.sin(c.yaw) * side);
        const people = [];
        for (let k = 0; k < 26; k++) {
          const a = (rand() - 0.5) * 34, b = (rand() - 0.5) * 3 - 1;
          const x = pick.p.x + A.x * a + B.x * b, z = pick.p.z + A.z * a + B.z * b;
          people.push({ x, y: groundQuery(x, z), z });
        }
        group('crest', people, new THREE.Vector3(pick.p.x, pick.g, pick.p.z));
        camp({ x: pick.p.x + B.x * 6, z: pick.p.z + B.z * 6 }, A, B, groundQuery, { tents: 3, bikes: 3, crawler: true, awning: true, fire: true, banner: true });
      }
    }
  }

  // ---------------- build ----------------
  const merge = (list, mat, name) => {
    if (!list.length) return null;
    const geos = list.map(([n, m, tint]) => {
      const g = models.get(n).clone().applyMatrix4(m);
      if (tint && g.attributes.color) {
        const c = g.attributes.color;
        for (let v = 0; v < c.count; v++) {
          // only the pale, painted parts take the copy's colour (the machinery and poles stay as they are)
          const r = c.getX(v), gg = c.getY(v), b = c.getZ(v), k = THREE.MathUtils.smoothstep((r + gg + b) / 3, 0.35, 0.6);
          c.setXYZ(v, r * (1 - k + k * tint.r / 0.75), gg * (1 - k + k * tint.g / 0.75), b * (1 - k + k * tint.b / 0.75));
        }
      }
      return g;
    });
    const g = mergeGeometries(geos);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = name;
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  };
  out.props = merge(props, propMaterial({ roughness: 0.85 }), 'course-props');
  out.stones = merge(stones, rockMat, 'course-stones');

  const cloth = (list, geo, mat, name) => {
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach(([m, c], n) => { im.setMatrixAt(n, m); im.setColorAt(n, c); });
    im.computeBoundingSphere();
    im.name = name;
    scene.add(im);
    return im;
  };
  out.strips = cloth(strips, new THREE.PlaneGeometry(1.15, 0.2, 12, 1).translate(0.575, 0, 0),
    clothMaterial({ color: '#ffffff', roughness: 0.9 }, { amp: 0.12, freq: 3.6, speed: 11, fixedEdge: 'x', length: 1.15 }), 'course-strips');
  out.awnings = cloth(awnings, new THREE.PlaneGeometry(2.43, 4.1, 8, 10).translate(1.215, 0, 0),
    clothMaterial({ color: '#ffffff', roughness: 0.9 }, { amp: 0.16, freq: 1.4, speed: 4, fixedEdge: 'x', length: 2.43 }), 'course-awnings');
  if (out.awnings) out.awnings.castShadow = true;
  if (banners.length) {
    // fan banners: four painted cells, each banner picks one through its uv
    const tex = canvasTexture(1024, 512, (g) => {
      const cells = [['HAJRÁ!', '#c8342c', '#f2e4c9'], ['HOMOKFUTAM', '#1b140e', '#ff7b2e'], ['GYERÜNK!', '#2f6fd0', '#f2e4c9'], ['★ 7 ★', '#e2b93b', '#1b140e']];
      cells.forEach(([txt, bg, fg], k) => {
        const x = (k % 2) * 512, y = (k >> 1) * 256;
        g.fillStyle = bg; g.fillRect(x, y, 512, 256);
        g.fillStyle = fg; g.fillRect(x, y + 14, 512, 10); g.fillRect(x, y + 232, 512, 10);
        g.font = `800 ${txt.length > 8 ? 74 : 110}px "Saira Condensed", "Arial Narrow", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(txt, x + 256, y + 132);
        // worn: sun-faded and sand-scoured
        g.fillStyle = 'rgba(230,215,190,0.18)'; g.fillRect(x, y, 512, 256);
        for (let n = 0; n < 220; n++) { g.fillStyle = `rgba(200,180,150,${Math.random() * 0.25})`; g.fillRect(x + Math.random() * 512, y + Math.random() * 256, 2 + Math.random() * 6, 1 + Math.random() * 2); }
      });
    });
    // one draw: each banner shows its cell of the atlas through a per-copy uv offset (iCell)
    const geo = new THREE.PlaneGeometry(4.6, 1.3, 14, 4).translate(0, -0.65, 0);
    geo.setAttribute('iCell', new THREE.InstancedBufferAttribute(new Float32Array(banners.flatMap(([, cell]) => [(cell % 2) * 0.5, 0.5 - (cell >> 1) * 0.5])), 2));
    const mat = clothMaterial({ map: tex, roughness: 0.85 }, { amp: 0.22, freq: 1.2, speed: 3, fixedEdge: 'y', length: 1.3, cells: true });
    out.banners = cloth(banners.map(([m, , c]) => [m, c]), geo, mat, 'course-banners');
    out.banners.castShadow = true;
  }
  out.counts.groups = out.groups.map((g) => `${g.name} ${g.n}`).join(', ');

  // ---------------- per frame ----------------
  let smokeT = 0;
  out.update = (dt, camPos, racers) => {
    for (const g of out.groups) {
      // the pack within ~160 m: they jump and wave; it fades over a few seconds after
      let near = 1e9;
      for (const r of racers) if (!r.gone) near = Math.min(near, Math.hypot(r.x - g.centre.x, r.z - g.centre.z));
      const goal = near < 160 ? 1 : 0;
      g.cheer += (goal - g.cheer) * Math.min(1, dt * (goal > g.cheer ? 2.5 : 0.4));
      g.uniforms.uCheer.value = g.cheer;
    }
    // thin smoke from the camp fires, near the camera
    smokeT -= dt;
    if (smokeT <= 0 && fx?.smoke) {
      smokeT = 0.25;
      for (const f of out.fires) if (f.distanceTo(camPos) < 700) fx.smoke(f.x + (Math.random() - 0.5) * 0.4, f.y, f.z + (Math.random() - 0.5) * 0.4);
    }
  };
  return out;
}
