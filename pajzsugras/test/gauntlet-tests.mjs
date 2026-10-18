// PAJZSUGRÁS' own shield gauntlet (render/gauntlet.js, built with render/hardkit.js and render/armour-mats.js): it builds in node, deterministically, within
// its triangle budgets, with every part the viewmodel binds to; the shield behaviour (prongs, fins, cell, micro-shake) works and uses no randomness; and the new
// modules carry no name of anyone else's game. Smoke level: what it looks like is checked by eye in the ?vitrin showcase (render/vitrin.js).
import fs from 'node:fs';
import * as THREE from 'three';
import { test, assert } from './harness.mjs';

const SRC = (f) => fs.readFileSync(new URL('../render/' + f, import.meta.url), 'utf8');
const meshes = (g) => { const out = []; g.group.traverse((o) => { if (o.isMesh) out.push(o); }); return out; };
async function kit() {
  const { buildGauntlet } = await import('../render/gauntlet.js');
  const { geometryHash } = await import('../render/hardkit.js');
  return { buildGauntlet, geometryHash };
}

test('gauntlet: builds in node at both levels of detail, inside the triangle budgets (first person 10 - 20k, third person 2 - 3k), with every part the viewmodel binds to', async () => {
  const { buildGauntlet } = await kit();
  const fp = buildGauntlet({ lod: 'fp' }), tp = buildGauntlet({ lod: 'tp' });
  assert.ok(fp.tris >= 10000 && fp.tris <= 20000, 'fp: ' + fp.tris);
  assert.ok(tp.tris >= 2000 && tp.tris <= 3000, 'tp: ' + tp.tris);
  for (const g of [fp, tp]) {
    const p = g.parts;
    assert.deepEqual(Object.keys(p).sort(), ['cell', 'core', 'fins', 'glow', 'muzzle', 'orbit', 'prongs', 'rings']);
    for (const k of ['core', 'glow', 'rings', 'fins', 'cell']) assert.ok(p[k] && p[k].isMesh && p[k].geometry.attributes.position.count > 0, g.lod + ' ' + k);
    assert.ok(p.orbit.isGroup && p.orbit.children.length >= (g.lod === 'fp' ? 2 : 1), g.lod + ' orbit');
    assert.equal(p.prongs.children.length, 3, 'three prongs');
    for (const pr of p.prongs.children) assert.ok(pr.userData.hinge && pr.userData.hinge.children.length >= 2, 'each prong hangs on a hinge');
    assert.ok(p.muzzle.isObject3D && p.muzzle.position.length() === 0, 'the muzzle is the origin');
    for (const k of ['core', 'glow', 'rings', 'fins', 'cell', 'prongs', 'orbit', 'muzzle']) assert.ok(g.group.getObjectById(p[k].id), k + ' is in the group');
  }
  // the emitter, the fins, the power cell, the shared armour set with the player's tint
  assert.ok(meshes(fp).find((m) => m.name === 'gauntlet:steel'), 'the steel parts');
  assert.ok(fp.parts.fins.geometry.attributes.position.count / 3 >= 8 * 20, 'fins: at least 8 plates');
  assert.ok(fp.group.getObjectByName('gauntlet:cell'), 'the power cell');
  assert.ok(fp.mats.paint.isMeshPhysicalMaterial && fp.mats.frame.isMeshStandardMaterial && fp.mats.steel && fp.mats.suit && fp.mats.trim && fp.mats.lens, 'the shared armour set');
  assert.equal(fp.mats.paint.color.getHex(), 0xff8a2a, 'player tint');
  const teal = buildGauntlet({ lod: 'tp', tint: 0x2ee6d4 });
  assert.equal(teal.mats.paint.color.getHex(), 0x2ee6d4);
  // sizes in metres: the muzzle plane at z = 0, the body runs back about 38 cm (the forearm in fp goes on to about 85 cm), the orbit ring is the widest part
  const box = new THREE.Box3().setFromObject(tp.group), boxFp = new THREE.Box3().setFromObject(fp.group);
  assert.ok(box.max.z > 0.4 && box.max.z < 0.5 && box.min.z > -0.2 && box.min.z < -0.1, 'tp z range ' + box.min.z + ' .. ' + box.max.z);
  assert.ok(boxFp.max.z > 0.8 && boxFp.max.z < 0.95, 'fp forearm ' + boxFp.max.z);
  assert.ok(box.max.x < 0.25 && box.max.y < 0.25 && box.min.x > -0.25, 'no part is further out than the orbit ring');
  for (const g of [fp, tp, teal]) g.dispose();
});

test('gauntlet: deterministic - two builds have the same geometry bit for bit (a hash of every position), the baked AO and edge wear too; all numbers are finite and the normals unit', async () => {
  const { buildGauntlet, geometryHash } = await kit();
  const geos = (g) => meshes(g).map((m) => m.geometry);
  const a = buildGauntlet({ lod: 'fp' }), b = buildGauntlet({ lod: 'fp' }), t = buildGauntlet({ lod: 'tp' });
  assert.equal(geometryHash(geos(a)), geometryHash(geos(b)), 'the same build twice');
  assert.notEqual(geometryHash(geos(a)), geometryHash(geos(t)));
  const colours = (g) => meshes(g).filter((m) => m.geometry.attributes.color).map((m) => Array.from(m.geometry.attributes.color.array.slice(0, 600)).join(','));
  assert.deepEqual(colours(a), colours(b), 'the baked AO / wear is deterministic too');
  for (const m of meshes(a)) {
    const pos = m.geometry.attributes.position.array, nor = m.geometry.attributes.normal ? m.geometry.attributes.normal.array : null;
    for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) assert.fail(m.name + ': a position is not finite');
    if (nor) for (let i = 0; i < nor.length; i += 3 * 7) { const l = Math.hypot(nor[i], nor[i + 1], nor[i + 2]); if (!(l > 0.98 && l < 1.02) && l !== 0) assert.fail(m.name + ': a normal of length ' + l); }
  }
  // the AO / wear bake darkens and lightens: the colour range is not flat
  const col = a.group.getObjectByName('gauntlet:paint').geometry.attributes.color.array;
  let lo = 9, hi = 0;
  for (const v of col) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(lo < 0.85 && hi > 1.1, 'AO and edge wear are in the vertex colours: ' + lo.toFixed(2) + ' .. ' + hi.toFixed(2));
  for (const g of [a, b, t]) g.dispose();
});

test('gauntlet: the shield behaviour - prongs open 10 degrees with the charge and snap shut on fire(), the fins glow and cool in 0.6 s, the cell pulses, the micro-shake grows with the charge; none of it is random', async () => {
  const { buildGauntlet } = await kit();
  const g = buildGauntlet({ lod: 'fp' }), h = buildGauntlet({ lod: 'fp' }), g2 = buildGauntlet({ lod: 'tp' }), g3 = buildGauntlet({ lod: 'tp' });
  const real = Math.random;
  Math.random = () => { throw new Error('Math.random is not allowed while the gauntlet runs'); };   // (three itself draws object ids from it when something is built, so only the running is guarded)
  try {
    const hinge = () => g.parts.prongs.children[0].userData.hinge.rotation.y;
    const run = (obj, n, t0, st) => { for (let i = 0; i < n; i++) obj.update(1 / 60, t0 + i / 60, st); };
    run(g, 30, 0, { charge: 0 });
    assert.ok(Math.abs(hinge()) < 1e-9, 'closed at rest');
    assert.equal(g.group.position.length(), 0, 'no shake at rest');
    run(g, 60, 1, { charge: 1 });
    assert.ok(Math.abs(hinge() + THREE.MathUtils.degToRad(10)) < 0.01, 'open 10 degrees (outwards): ' + hinge());
    const shake = (o) => { let m = 0; for (let i = 0; i < 40; i++) { o.update(1 / 60, 20 + i / 60, { charge: o === g ? 1 : 0.3 }); m = Math.max(m, o.group.position.length()); } return m; };
    const full = shake(g), third = shake(h);
    assert.ok(full > 0 && third < full * 0.5, 'a micro-shake that grows with the charge: ' + third.toFixed(5) + ' at 0.3, ' + full.toFixed(5) + ' at 1');
    g.fire();
    run(g, 4, 30, { charge: 0 });
    assert.ok(hinge() > -0.03, 'snapped shut: ' + hinge());
    const hot = g.mats.fin.emissiveIntensity;
    assert.ok(hot > 2, 'the fins are hot: ' + hot);
    run(g, 18, 31, { charge: 0 });
    assert.ok(g.mats.fin.emissiveIntensity < hot * 0.6 && g.mats.fin.emissiveIntensity > 0.2, 'cooling: ' + g.mats.fin.emissiveIntensity);
    run(g, 30, 32, { charge: 0 });
    assert.ok(g.mats.fin.emissiveIntensity < 0.05, 'cold after 0.6 s: ' + g.mats.fin.emissiveIntensity);
    assert.ok(Math.abs(hinge()) < 0.01, 'and the prongs settle closed again');
    // the cell pulses (its colour changes over time at a fixed charge); the same input gives the same state
    const cs = [];
    for (let i = 0; i < 12; i++) { g.update(1 / 60, 40 + i * 0.07, { charge: 0 }); cs.push(g.mats.cell.color.g); }
    assert.ok(Math.max(...cs) - Math.min(...cs) > 0.2, 'the power cell pulses');
    for (const x of [g2, g3]) { run(x, 20, 0, { charge: 0.9, flash: 0.5 }); x.fire(); run(x, 5, 1, { charge: 0.9 }); }
    assert.deepEqual(g2.group.position.toArray(), g3.group.position.toArray());
    assert.deepEqual(g2.parts.prongs.children[1].userData.hinge.rotation.toArray().slice(0, 3), g3.parts.prongs.children[1].userData.hinge.rotation.toArray().slice(0, 3));
  } finally { Math.random = real; }
  for (const x of [g, h, g2, g3]) x.dispose();
});

test('hardkit: the shapes face outward (lathe, loft, plate, chamfered block), the kit bakes one geometry per material and a mirrored part keeps its winding', async () => {
  const hk = await import('../render/hardkit.js');
  // every triangle faces the way its vertex normals do
  const facing = (g) => {
    const idx = g.index, P = g.attributes.position, N = g.attributes.normal, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    let bad = 0, total = 0;
    const tri = idx ? idx.count / 3 : P.count / 3;
    for (let t = 0; t < tri; t++) {
      const [i, j, k] = idx ? [idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)] : [t * 3, t * 3 + 1, t * 3 + 2];
      a.fromBufferAttribute(P, i); b.fromBufferAttribute(P, j); c.fromBufferAttribute(P, k);
      const fn = b.clone().sub(a).cross(c.clone().sub(a));
      if (fn.lengthSq() < 1e-18) continue;
      fn.normalize(); n.fromBufferAttribute(N, i);
      total++;
      if (fn.dot(n) < 0.1) bad++;
    }
    return { bad, total };
  };
  const lathe = hk.lathe([[0.05, -0.1], [0.109, -0.01], [0.109, 0], [0.105, 0], [0.08, -0.012], [0, -0.035]], 24);
  const ring = (z, s) => hk.rrect(0.1 * s, 0.08 * s, 0.02, 3).map(([x, y]) => [x, y, z]);
  const loft = hk.loft([ring(0, 1), ring(0.1, 0.9), ring(0.2, 0.8)]);
  for (const [name, g] of [['lathe', lathe], ['loft', loft], ['plate', hk.plate([[-0.05, -0.03], [0.05, -0.03], [0.04, 0.03], [-0.05, 0.03]])], ['cbox', hk.cbox(0.02, 0.03, 0.01, 0.002)]]) {
    const f = facing(g);
    assert.equal(f.bad, 0, `${name}: ${f.bad} of ${f.total} triangles face against their normals`);
  }
  // the kit: one bucket per key; a mirror (negative determinant) is flipped back so that the faces still point out
  const k = new hk.Kit(1);
  const mirror = new THREE.Matrix4().makeScale(-1, 1, 1);
  k.add('a', hk.cbox(0.02, 0.03, 0.01, 0.002), hk.m4({ p: [0.1, 0, 0] }), { wear: 'plate' });
  k.add('a', hk.cbox(0.02, 0.03, 0.01, 0.002), new THREE.Matrix4().multiplyMatrices(mirror, hk.m4({ p: [0.1, 0, 0] })), { wear: 'plate' });
  k.add('b', hk.rbox(0.02, 0.02, 0.02, 0.004, 1), new THREE.Matrix4(), { wear: 'box' });
  const geos = k.build();
  assert.deepEqual([...geos.keys()].sort(), ['a', 'b']);
  for (const g of geos.values()) { const f = facing(g); assert.equal(f.bad, 0, 'a baked geometry faces out'); assert.ok(g.attributes.color && g.attributes.uv); }
});

test('gauntlet: the new modules carry no name or file of anyone else\'s game, and no Math.random call', () => {
  for (const f of ['hardkit.js', 'armour-mats.js', 'gauntlet.js', 'vitrin.js']) {
    const src = SRC(f);
    assert.doesNotMatch(src, /gorge|Bone_|Bip01|local-(models|sounds)|shieldgun|\.glb/i, f + ' mentions something that is not ours');
    assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /Math\.random/, f + ' calls Math.random');
  }
});
