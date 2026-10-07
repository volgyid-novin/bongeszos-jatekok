import * as THREE from 'three';

// ============================================================
//  Birds on the canyon's rim (?gfx=wake:1, docs/visual-next-steps.md E7): a few small flocks perched along
//  the top edge of the walls, wings folded. When the pack comes into the canyon they startle, each a beat
//  apart: a burst of fast wingbeats out over the slot and up, then they circle on the rising air, and after
//  half a minute glide back down and settle again. One instanced mesh, the matrices set every frame.
// ============================================================
const TAU = Math.PI * 2;

// walls: main.js CANYON_WALLS (the profile per row); roofAt(s); avoid: arc lengths to keep clear of (the bridge)
export function buildBirds({ scene, walls, roofAt, rng, avoid = [], groups = 3, per = 7 }) {
  const rand = rng(9191);
  const flocks = [];
  for (let gi = 0; gi < groups; gi++) {
    const prof = walls[gi % walls.length];
    if (!prof) break;
    const rows = prof.rows.filter((r) => r.c > 0.9 && roofAt(r.s) < 0.02 && r.n > r.J && avoid.every((s) => Math.abs(r.s - s) > 60));
    if (!rows.length) break;
    const R0 = rows[Math.floor((gi + 0.5) / groups * rows.length)];
    const birds = [];
    for (let k = 0; k < per; k++) {
      // along the top edge, a metre or so apart
      const R = rows[Math.min(rows.length - 1, Math.max(0, rows.indexOf(R0) + Math.round((rand() - 0.5) * 6)))];
      const o = R.o[R.J] - 0.3 - rand() * 0.6;
      const perch = new THREE.Vector3(R.x + R.rx * o, R.y[R.J] + 0.05, R.z + R.rz * o);
      // out over the slot: towards the track
      const out = new THREE.Vector3(-R.rx, 0, -R.rz).normalize();
      birds.push({ perch, out, pos: perch.clone(), mode: 0, t: 0, delay: 0, yaw: rand() * TAU, ph: rand() * TAU, r: 22 + rand() * 18, w: (rand() < 0.5 ? -1 : 1) * (0.35 + rand() * 0.2), lift: 18 + rand() * 16 });
    }
    flocks.push({ birds, at: R0, centre: new THREE.Vector3(R0.x, R0.y[R0.J], R0.z) });
  }
  const n = flocks.reduce((a, f) => a + f.birds.length, 0);
  if (!n) return null;
  // a bird: two wings off a body along +z (as the vultures in world/dressing.js), smaller
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.45, 0, 0, -0.45, 1.1, 0.05, -0.15, 0, 0, 0.45, -1.1, 0.05, -0.15, 0, 0, -0.45], 3));
  geo.computeVertexNormals();
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: '#1f1814', side: THREE.DoubleSide, roughness: 1 }), n);
  // culled by a sphere round the perches and everywhere their flights go (~70 m out, ~50 m up)
  const c = new THREE.Vector3();
  for (const f of flocks) for (const b of f.birds) c.add(b.perch);
  c.divideScalar(n);
  let r = 0;
  for (const f of flocks) for (const b of f.birds) r = Math.max(r, c.distanceTo(b.perch));
  mesh.boundingSphere = new THREE.Sphere(c, r + 110);
  mesh.userData.dynamic = true;
  scene.add(mesh);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(0, 0, 0, 'YXZ'), S = new THREE.Vector3(), V = new THREE.Vector3(), prev = new THREE.Vector3();

  return {
    mesh, flocks,
    update(dt, racers) {
      let i = 0;
      for (const f of flocks) {
        // the pack within ~170 m and moving: they all go, each a beat apart
        let near = false;
        for (const r of racers) if (!r.gone && Math.abs(r.fwd) > 30 && Math.hypot(r.x - f.centre.x, r.z - f.centre.z) < 170) { near = true; break; }
        for (const b of f.birds) {
          if (near && b.mode === 0) { b.mode = 1; b.t = -Math.random() * 0.8; }
          prev.copy(b.pos);
          let flap = 0, fold = 1;
          if (b.mode === 0) {
            b.pos.copy(b.perch);
            fold = 0.3;                                   // wings folded
            b.yaw += Math.sin(b.ph + (b.t += dt) * 0.7) * dt * 0.3;
          } else {
            b.t += dt;
            const t = Math.max(0, b.t);
            if (t < 3) {
              // off the edge: a burst of wingbeats, out over the slot and up
              V.copy(b.out).multiplyScalar(t * 7).add(new THREE.Vector3(0, t * 2.5 + t * t * 1.4, 0));
              b.pos.copy(b.perch).add(V);
              flap = Math.sin(t * 24 + b.ph);
            } else if (t < 34) {
              // circling on the rising air above the slot, a flap now and then
              const c = b.perch.clone().addScaledVector(b.out, 21 + b.r * 0.4);
              const a = (t - 3) * b.w + b.ph;
              b.pos.set(c.x + Math.cos(a) * b.r, b.perch.y + 12 + Math.min(b.lift, (t - 3) * 1.5), c.z + Math.sin(a) * b.r);
              // (blend in from the climb)
              const k = Math.min(1, (t - 3) / 2);
              V.copy(b.out).multiplyScalar(21).add(new THREE.Vector3(0, 12, 0)).add(b.perch);
              b.pos.lerpVectors(V, b.pos, k);
              flap = Math.sin(t * 9 + b.ph) > 0.6 ? Math.sin(t * 20 + b.ph) : 0.1;
            } else if (t < 41) {
              // a long glide back down to the perch
              const k = (t - 34) / 7, s = k * k * (3 - 2 * k);
              const c = b.perch.clone().addScaledVector(b.out, 21 + b.r * 0.4);
              const a = 31 * b.w + b.ph;
              V.set(c.x + Math.cos(a) * b.r, b.perch.y + 12 + b.lift, c.z + Math.sin(a) * b.r);
              b.pos.lerpVectors(V, b.perch, s);
              flap = k > 0.85 ? Math.sin(t * 22 + b.ph) : 0.05;
            } else { b.mode = 0; b.t = 0; }
          }
          // face the way it moves (perched: its own way), bank into the turns
          const dx = b.pos.x - prev.x, dz = b.pos.z - prev.z;
          if (b.mode === 1 && dx * dx + dz * dz > 1e-6) b.yaw = Math.atan2(dx, dz);
          e.set(0, b.yaw, b.mode === 1 ? b.w * 0.5 : 0);
          // (the wing tips sit 5 cm up: stretching y beats them up and down)
          S.set(fold, 1 + flap * 9, 1);
          m.compose(b.pos, q.setFromEuler(e), S);
          mesh.setMatrixAt(i++, m);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
