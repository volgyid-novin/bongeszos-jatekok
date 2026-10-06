"""Small things lying around the HOMOKFUTAM map, modelled in Blender from code.

  blender -b --factory-startup --python homokfutam/models/world/build_props.py

Writes homokfutam/assets/world/props.glb: pebble0..2 (~10 cm), stone0..2 (~40 cm), bush0..1
(dry shrubs ~1.6 m), carcass (a long-dead animal: spine, ribs, skull), bones (a few scattered),
scrap_panel / scrap_pipe / scrap_engine (pieces of crashed pods). Sizes are real metres.
Vertex colour = tint, alpha = baked ambient occlusion (the game splits it off).
"""
import math
import os
import sys
import time

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rocklib as R  # noqa: E402
from build_rocks import rock_core, PAL  # noqa: E402

OUT = os.path.normpath(os.path.join(HERE, '..', '..', 'assets', 'world', 'props.glb'))


def tube_mesh(paths, sides=5):
    """paths: list of (points (n, 3), radii (n,)) -> verts, faces of simple tubes with end caps."""
    verts, faces = [], []
    for pts, rad in paths:
        pts = np.asarray(pts, float)
        n = len(pts)
        base = len(verts)
        for k in range(n):
            t = pts[min(k + 1, n - 1)] - pts[max(k - 1, 0)]
            t /= np.linalg.norm(t) + 1e-9
            a = np.cross(t, [0, 0, 1]) if abs(t[2]) < 0.9 else np.cross(t, [1, 0, 0])
            a /= np.linalg.norm(a)
            b = np.cross(t, a)
            for s in range(sides):
                ang = s / sides * 2 * math.pi
                verts.append(pts[k] + (a * math.cos(ang) + b * math.sin(ang)) * rad[k])
        for k in range(n - 1):
            for s in range(sides):
                i0 = base + k * sides + s
                i1 = base + k * sides + (s + 1) % sides
                faces.append((i0, i1, i1 + sides, i0 + sides))
        faces.append(tuple(base + s for s in range(sides - 1, -1, -1)))
        faces.append(tuple(base + (n - 1) * sides + s for s in range(sides)))
    return np.array(verts), faces


def finish(ob, rgb_fn, ao_dist, target=None, angle=None):
    c = R.co(ob)
    ao = R.bake_ao(ob, ao_dist, 64)
    R.set_colors(ob, rgb_fn(c), ao)
    R.shade(ob, angle)
    if target:
        R.decimate(ob, target)
    return ob


def pebble(idx, size, name, ico_level, target):
    rng = np.random.default_rng(700 + idx * 7 + int(size * 100))
    sc = np.array([1.0, rng.uniform(0.7, 0.95), rng.uniform(0.45, 0.7)])
    p, f = rock_core(0, sc, int(rng.integers(4, 8)), rng)
    from build_rocks import ico
    v, f = ico(ico_level)
    p = v * sc
    for _ in range(int(rng.integers(3, 7))):
        n = rng.standard_normal(3)
        n /= np.linalg.norm(n)
        d = rng.uniform(0.55, 0.85) * np.abs(p @ n).max()
        p -= np.maximum(p @ n - d, 0)[:, None] * n
    p[:, 2] = np.maximum(p[:, 2], -0.35 * sc[2])
    ob = R.mesh_obj(name, p * size, f)
    R.displace(ob, lambda c, n: (R.fbm3(c / (size * 0.6), 2, idx) - 0.5) * size * 0.12)
    tone = [PAL['orange'], PAL['tan'], PAL['rose'], R.srgb('#5d4636'), R.srgb('#8a8079')][idx % 5]
    return finish(ob, lambda c: tone[None, :] * (1 + (R.fbm3(c / size, 2, idx + 3) - 0.5) * 0.3)[:, None], size * 0.6, target, 45)


def bush(idx):
    """Dead desert shrub: a few stems from the root crown, forking twice, thin twigs at the ends."""
    rng = np.random.default_rng(800 + idx)
    paths = []

    def grow(p0, d, length, rad, depth):
        n = 5
        pts, rads = [p0], [rad]
        p = np.array(p0, float)
        for k in range(1, n):
            d = d + rng.normal(0, 0.18, 3)
            d[2] += 0.05
            d /= np.linalg.norm(d)
            p = p + d * length / (n - 1)
            pts.append(p.copy())
            rads.append(rad * (1 - k / n * 0.7))
        paths.append((pts, rads))
        if depth < 3:
            for _ in range(int(rng.integers(2, 4))):
                k = int(rng.integers(2, n))
                nd = d + rng.normal(0, 0.55, 3)
                nd[2] = abs(nd[2]) * 0.6 + 0.2
                nd /= np.linalg.norm(nd)
                grow(pts[k], nd, length * rng.uniform(0.45, 0.7), rads[k] * 0.65, depth + 1)
    for s in range(int(rng.integers(5, 8))):
        a = rng.uniform(0, 2 * math.pi)
        d = np.array([math.cos(a) * 0.55, math.sin(a) * 0.55, 0.8])
        grow(np.array([math.cos(a) * 0.05, math.sin(a) * 0.05, -0.05]), d / np.linalg.norm(d), rng.uniform(0.7, 1.0), 0.028, 0)
    v, f = tube_mesh(paths, 4)
    ob = R.mesh_obj(f'bush{idx}', v, f)
    grey = R.srgb('#7d6e60')
    return finish(ob, lambda c: grey[None, :] * (0.75 + 0.35 * np.clip(c[:, 2] / 1.2, 0, 1))[:, None], 0.4, None, 70)


def carcass():
    rng = np.random.default_rng(901)
    paths = []
    spine = np.array([[x, 0.05 * math.sin(x * 1.3), 0.12 + 0.05 * math.sin(x * 2.0)] for x in np.linspace(-1.2, 1.4, 22)])
    paths.append((spine, np.full(len(spine), 0.045)))
    # the rib cage lies open to the sky: ribs curve out from the spine and up, each a little different
    for k in range(11):
        x = -0.65 + k * 0.13 + rng.normal(0, 0.015)
        size = 1 - abs(k - 4) / 11
        for side in (-1, 1):
            lean = rng.normal(0, 0.06)
            reach = rng.uniform(0.75, 1.0) * size
            pts = []
            for t in np.linspace(0, 1, 7):
                ang = t * math.pi * 0.62
                y = side * (0.05 + math.sin(ang) * 0.42 * reach)
                z = 0.12 + (1 - math.cos(ang)) * 0.62 * reach
                pts.append([x + t * (0.06 + lean), y, z])
            if rng.random() < 0.25:                        # some ribs broken off
                pts = pts[:int(rng.integers(3, 5))]
            paths.append((pts, np.linspace(0.022, 0.012, len(pts))))
    v, f = tube_mesh(paths, 5)
    from build_rocks import ico
    sv, sf = ico(2)
    skull = sv * np.array([0.32, 0.16, 0.14]) + np.array([1.62, 0.15, 0.12])
    skull[:, 0] += np.where(sv[:, 0] > 0, sv[:, 0] * 0.12, 0)
    f2 = [tuple(i + len(v) for i in face) for face in sf]
    ob = R.mesh_obj('carcass', np.concatenate([v, skull]), f + f2)
    bone = R.srgb('#dcd0b8')
    return finish(ob, lambda c: bone[None, :] * (1 - 0.18 * R.fbm3(c / 0.2, 2, 3))[:, None], 0.3, None, 60)


def bones():
    paths = []
    for p0, p1, r in (((0, 0, 0.03), (0.55, 0.12, 0.03), 0.028), ((0.2, -0.3, 0.025), (0.45, 0.05, 0.03), 0.02), ((-0.3, 0.2, 0.02), (-0.1, 0.45, 0.02), 0.018)):
        p0, p1 = np.array(p0), np.array(p1)
        pts = [p0 + (p1 - p0) * t for t in np.linspace(0, 1, 6)]
        rads = [r * (1.6 if t in (0, 1) else 1.0) for t in np.linspace(0, 1, 6)]
        paths.append((pts, rads))
    v, f = tube_mesh(paths, 5)
    ob = R.mesh_obj('bones', v, f)
    bone = R.srgb('#d8cbb2')
    return finish(ob, lambda c: bone[None, :] * np.ones((len(c), 1)), 0.2, None, 60)


def scrap_panel():
    rng = np.random.default_rng(951)
    nx, ny = 14, 9
    verts, faces = [], []
    for j in range(ny):
        for i in range(nx):
            u, w = i / (nx - 1), j / (ny - 1)
            x, y = (u - 0.5) * 2.2, (w - 0.5) * 1.3
            z = 0.25 * math.sin(u * 2.6) * (1 - w * 0.4) + 0.08 * math.sin(w * 5 + u * 3) + (0.1 if i > nx - 4 and j > 4 else 0)
            verts.append((x, y, z + 0.05))
    for j in range(ny - 1):
        for i in range(nx - 1):
            if (i - 9) ** 2 + (j - 5) ** 2 < 3 and rng.random() < 0.7:      # torn hole
                continue
            a = j * nx + i
            faces.append((a, a + 1, a + nx + 1, a + nx))
    ob = R.mesh_obj('scrap_panel', np.array(verts), faces)
    R.apply_mod(ob, 'SOLIDIFY', thickness=0.03)
    paint = R.srgb('#b4532e')
    return finish(ob, lambda c: paint[None, :] * (1 - 0.4 * R.smoothstep(0.45, 0.7, R.fbm3(c / 0.4, 2, 5)))[:, None], 0.3, None, 40)


def scrap_pipe():
    pts = [(math.cos(t) * 1.2 - 1.2, math.sin(t) * 0.3, 0.09 + 0.03 * math.sin(t * 3)) for t in np.linspace(0, 1.3, 10)]
    v, f = tube_mesh([(pts, np.full(10, 0.08))], 8)
    ob = R.mesh_obj('scrap_pipe', v, f)
    metal = R.srgb('#6e6458')
    return finish(ob, lambda c: metal[None, :] * np.ones((len(c), 1)), 0.3, None, 40)


def scrap_engine():
    """A burnt-out engine fragment: a broken cylinder with cooling rings and a torn intake."""
    paths = []
    shell = [(x, 0, 0.55) for x in np.linspace(-1.4, 1.3, 9)]
    v, f = tube_mesh([(shell, np.array([0.5, 0.56, 0.58, 0.58, 0.58, 0.57, 0.55, 0.5, 0.42]))], 14)
    ob = R.mesh_obj('scrap_engine', v, f)
    rings = []
    for x in np.linspace(-1.0, 0.9, 6):
        rv, rf = tube_mesh([([(x, 0, 0.55 + 0.6), (x, 0.0, 0.55 + 0.6)], np.array([0.05, 0.05]))], 4)
    R.displace(ob, lambda c, n: -0.06 * R.smoothstep(0.6, 0.8, R.fbm3(c / 0.5, 2, 9)) + (R.fbm3(c / 0.15, 1, 2) - 0.5) * 0.02)
    soot = R.srgb('#2e2925')
    paint = R.srgb('#8c7a5c')
    return finish(ob, lambda c: (paint * 0.6 + soot * 0.4)[None, :] * (1 - 0.5 * R.smoothstep(0.4, 0.7, R.fbm3(c / 0.4, 2, 7)))[:, None], 0.6, None, 35)


def main():
    R.reset()
    t0 = time.time()
    objs = []
    for k in range(3):
        objs.append(pebble(k, 0.1, f'pebble{k}', 2, 80))
    for k in range(3):
        objs.append(pebble(k + 3, 0.4, f'stone{k}', 3, 220))
    objs += [bush(0), bush(1), carcass(), bones(), scrap_panel(), scrap_pipe(), scrap_engine()]
    for o in objs:
        print(f'  {o.name}: {R.tris(o)} tris')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    R.export_glb(objs, OUT)
    print(f'wrote {OUT}: {len(objs)} meshes, {sum(R.tris(o) for o in objs)} tris, {os.path.getsize(OUT) / 1024:.0f} KB in {time.time() - t0:.0f}s')
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'build', 'props.blend'))


if __name__ == '__main__':
    main()
