"""Things people left out on the HOMOKFUTAM course (docs/visual-next-steps.md E4, E5), modelled in Blender from code.

  blender -b --factory-startup --python homokfutam/models/world/build_course.py

Writes homokfutam/assets/world/course.glb:
  - marker_pole0 (a weathered wooden pole, 3 m, a rope wrap near the top where a cloth strip is tied),
    marker_pole1 (the same, snapped off at ~1.7 m, a splintered top)
  - cairn0, cairn1 (stacked stones, ~1.2 and ~0.9 m)
  - drum0, drum1 (oil drums, dented, the paint going to rust; the game sinks them half into the sand)
  - tent (a ridge tent, canvas), awning (its frame: four poles and two bars; the canvas is cloth in the game),
    bike (a hover-bike on its skids), crawler (a cargo crawler: tracks, cab, ribbed cargo box, mast),
    firepit (a ring of stones, charred logs, ash)
Sizes are real metres, +Z up (exported +Y up). Vertex colour = tint, alpha = baked ambient occlusion (the game
splits it off). Painted parts are pale and neutral where the game tints each copy (tent, bike).
"""
import math
import os
import sys
import time

import bmesh
import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rocklib as R  # noqa: E402
from build_rocks import PAL, ico  # noqa: E402
from build_props import tube_mesh  # noqa: E402

OUT = os.path.normpath(os.path.join(HERE, '..', '..', 'assets', 'world', 'course.glb'))


class Parts:
    """Accumulates mesh parts with a colour per vertex, so one object can carry several materials' tints."""

    def __init__(self):
        self.v, self.f, self.c = [], [], []

    def add(self, verts, faces, rgb):
        base = sum(len(v) for v in self.v)
        verts = np.asarray(verts, float)
        self.v.append(verts)
        self.f += [tuple(i + base for i in face) for face in faces]
        rgb = np.asarray(rgb, float)
        self.c.append(np.repeat(rgb[None, :], len(verts), 0) if rgb.ndim == 1 else rgb)

    def build(self, name, ao_dist, tint_fn=None, angle=40, target=None):
        v = np.concatenate(self.v)
        ob = R.mesh_obj(name, v, self.f)
        # every closed part facing out, whatever winding it was written with (the vertex order stays)
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(ob.data)
        bm.free()
        ob.data.update()
        rgb = np.concatenate(self.c)
        if tint_fn is not None:
            rgb = rgb * tint_fn(v)[:, None]
        ao = R.bake_ao(ob, ao_dist, 64)
        R.set_colors(ob, rgb, ao)
        R.shade(ob, angle)
        if target:
            R.decimate(ob, target)
        return ob


def box(c, s, rot=0.0):
    """An axis-aligned box (centre c, size s), turned rot about z."""
    hx, hy, hz = np.asarray(s, float) / 2
    v = np.array([[x, y, z] for z in (-hz, hz) for y in (-hy, hy) for x in (-hx, hx)])
    if rot:
        ca, sa = math.cos(rot), math.sin(rot)
        v = v @ np.array([[ca, sa, 0], [-sa, ca, 0], [0, 0, 1]])
    v += np.asarray(c, float)
    f = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    return v, f


def stone(rng, size, flat=0.6, level=2):
    """A stone: an icosphere cut flat in a few places, a little lumpy."""
    v, f = ico(level)
    sc = np.array([1.0, rng.uniform(0.75, 0.95), flat])
    p = v * sc
    for _ in range(int(rng.integers(3, 6))):
        n = rng.standard_normal(3)
        n /= np.linalg.norm(n)
        d = rng.uniform(0.6, 0.85) * np.abs(p @ n).max()
        p -= np.maximum(p @ n - d, 0)[:, None] * n
    p *= (1 + (R.fbm3(p * 2.2, 2, int(rng.integers(0, 99))) - 0.5) * 0.18)[:, None]
    return p * size, f


def rot_z(p, a):
    ca, sa = math.cos(a), math.sin(a)
    return p @ np.array([[ca, sa, 0], [-sa, ca, 0], [0, 0, 1]])


# ------------------------------------------------------------------ the trackside markers (E5)

def marker_pole(idx):
    """A weathered wooden pole, a little crooked, the grain opened up by sand and sun; idx 1 is snapped off."""
    rng = np.random.default_rng(1200 + idx)
    H = 3.0
    rings, sides = 16, 8
    pts, rads = [], []
    for k in range(rings):
        t = k / (rings - 1)
        pts.append((0.035 * math.sin(t * 2.1 + 0.7), 0.025 * math.sin(t * 3.3), t * H))
        rads.append(0.078 * (1 - 0.2 * t))
    v, f = tube_mesh([(pts, rads)], sides)
    if idx == 1:
        # snapped at ~1.7 m: everything above comes down onto a jagged, splintered break
        cut = 1.7
        top = v[:, 2] > cut
        v[top, 2] = cut + rng.uniform(-0.05, 0.28, top.sum()) * (1 + 0.6 * np.sin(np.arctan2(v[top, 1], v[top, 0]) * 3))
    P = Parts()
    P.add(v, f, R.srgb('#8b7b66'))
    if idx == 0:
        # the rope wrap the cloth strip is tied with
        rv, rf = tube_mesh([([(0.03, 0.0, H - 0.32), (0.03, 0.0, H - 0.18)], np.array([0.088, 0.088]))], 8)
        P.add(rv, rf, R.srgb('#a8946e'))
    ob = P.build(f'marker_pole{idx}', 0.25, lambda c: (
        # sun-bleached up top, sand-blasted dark at the foot, open grain along the pole
        (0.82 + 0.3 * np.clip(c[:, 2] / H, 0, 1)) * (1 - 0.25 * R.smoothstep(0.35, 0.0, c[:, 2]))
        * (0.85 + 0.3 * R.fbm3(c * np.array([28.0, 28.0, 0.9]), 2, 11 + idx))), angle=50)
    R.displace(ob, lambda c, n: (R.fbm3(c * np.array([30.0, 30.0, 1.2]), 2, 5 + idx) - 0.5) * 0.012)
    return ob


def cairn(idx):
    """Stones stacked on the outside of a corner: broad at the foot, each a little off the one below."""
    rng = np.random.default_rng(1300 + idx)
    P = Parts()
    z, r0 = 0.0, (0.42 if idx == 0 else 0.34)
    n = 6 if idx == 0 else 5
    tones = [PAL['tan'], PAL['orange'], PAL['rose'], R.srgb('#8a7a6a'), R.srgb('#b49a7a')]
    off = np.zeros(2)
    for k in range(n):
        size = r0 * (1 - k * 0.12) * rng.uniform(0.88, 1.08)
        flat = rng.uniform(0.42, 0.6)
        p, f = stone(rng, size, flat)
        p = rot_z(p, rng.uniform(0, 2 * math.pi))
        h = p[:, 2].max() - p[:, 2].min()
        off += rng.normal(0, 0.035, 2)
        p += np.array([off[0], off[1], z - p[:, 2].min()])
        z += h * 0.86
        P.add(p, f, tones[int(rng.integers(0, len(tones)))] * rng.uniform(0.85, 1.1))
    return P.build(f'cairn{idx}', 0.4, lambda c: 1 + (R.fbm3(c / 0.25, 2, 7 + idx) - 0.5) * 0.25, angle=40, target=1600)


def drum(idx):
    """An oil drum: rolled rims, two rolling hoops, dents; the paint (red, blue) going to rust."""
    rng = np.random.default_rng(1400 + idx)
    r, h = 0.29, 0.88
    prof = [(0.0, r - 0.012), (0.01, r + 0.008), (0.03, r), (0.27, r), (0.285, r + 0.012), (0.3, r), (0.58, r), (0.595, r + 0.012),
            (0.61, r), (0.85, r), (0.87, r + 0.008), (h, r - 0.012)]
    seg = 22
    v, f = [], []
    for z, rr in prof:
        for s in range(seg):
            a = s / seg * 2 * math.pi
            v.append((math.cos(a) * rr, math.sin(a) * rr, z))
    for k in range(len(prof) - 1):
        for s in range(seg):
            i0, i1 = k * seg + s, k * seg + (s + 1) % seg
            f.append((i0, i1, i1 + seg, i0 + seg))
    # the lids, a little recessed
    for z, sgn in ((0.012, -1), (h - 0.012, 1)):
        base = len(v)
        for s in range(seg):
            a = s / seg * 2 * math.pi
            v.append((math.cos(a) * (r - 0.02), math.sin(a) * (r - 0.02), z))
        v.append((0, 0, z - sgn * 0.006))
        c = len(v) - 1
        for s in range(seg):
            a, b = base + s, base + (s + 1) % seg
            f.append((a, b, c) if sgn > 0 else (b, a, c))
    v = np.array(v, float)
    # dents
    for _ in range(3):
        a, z0 = rng.uniform(0, 2 * math.pi), rng.uniform(0.15, 0.75)
        d = np.array([math.cos(a), math.sin(a)])
        w = np.exp(-(((v[:, :2] @ d) - r) ** 2) / 0.01) * np.exp(-((v[:, 2] - z0) ** 2) / 0.02) * np.exp(-np.sum((v[:, :2] / r - d) ** 2, 1) / 0.25)
        v[:, :2] -= (w * rng.uniform(0.02, 0.05))[:, None] * d
    paint = R.srgb('#7a2f22') if idx == 0 else R.srgb('#2f4f6a')
    rust = R.srgb('#6a3d22')
    P = Parts()
    P.add(v, f, paint)
    def tint(c):
        k = R.smoothstep(0.42, 0.68, R.fbm3(c / 0.18, 3, 21 + idx))
        return (1 - 0.15 * R.smoothstep(0.5, 0.0, c[:, 2])) * (0.9 + 0.2 * R.fbm3(c / 0.05, 1, 3))
    ob = P.build(f'drum{idx}', 0.3, tint, angle=35)
    # rust over the paint where the noise says so (in the colour itself, not just its brightness)
    me = ob.data
    col = me.color_attributes['Col']
    a = np.empty(len(me.vertices) * 4, np.float32)
    col.data.foreach_get('color', a)
    a = a.reshape(-1, 4)
    c = R.co(ob)
    k = R.smoothstep(0.42, 0.68, R.fbm3(c / 0.18, 3, 21 + idx))[:, None]
    a[:, :3] = a[:, :3] * (1 - k) + rust[None, :] * k * a[:, :3].mean(1, keepdims=True) / max(paint.mean(), 1e-3)
    col.data.foreach_set('color', a.ravel())
    return ob


# ------------------------------------------------------------------ the spectators' camps (E4)

def tent():
    """A ridge tent, 3.2 x 2.4 m, 1.7 m high: the canvas sags between the poles and bellies in on its sides."""
    L, W, Ht = 3.2, 2.4, 1.7
    nu, nw = 14, 7
    P = Parts()
    canvas = R.srgb('#dcd1bb')
    for s in (-1, 1):
        v, f = [], []
        for j in range(nw + 1):
            w = j / nw
            for i in range(nu + 1):
                u = i / nu
                x = (u - 0.5) * L
                y = s * ((1 - w) * W / 2 - 0.09 * math.sin(math.pi * w) * math.sin(math.pi * u))
                z = w * Ht - 0.11 * math.sin(math.pi * u) * w
                v.append((x, y, z))
        for j in range(nw):
            for i in range(nu):
                a = j * (nu + 1) + i
                q = (a, a + 1, a + nu + 2, a + nu + 1)
                f.append(q if s < 0 else q[::-1])
        P.add(v, f, canvas)
    # the back wall, closed; the front is open, its flaps tied back
    v = [(-L / 2, -W / 2, 0), (-L / 2, W / 2, 0), (-L / 2, 0, Ht)]
    P.add(v, [(0, 1, 2)], canvas * 0.95)
    for s in (-1, 1):
        v = [(L / 2, s * W / 2, 0), (L / 2 + 0.25, s * W * 0.28, 0), (L / 2, s * W * 0.16, Ht * 0.62)]
        P.add(v, [(0, 1, 2) if s > 0 else (1, 0, 2)], canvas * 0.9)
    # the poles, poking out above the ridge
    for x in (-L / 2, L / 2):
        pv, pf = tube_mesh([([(x, 0, 0), (x, 0, Ht + 0.18)], np.array([0.025, 0.025]))], 6)
        P.add(pv, pf, R.srgb('#3a3430'))
    ob = P.build('tent', 0.9, lambda c: 1 - 0.3 * R.smoothstep(0.35, 0.0, c[:, 2]) * (0.6 + 0.4 * R.fbm3(c / 0.3, 2, 4)), angle=60)
    R.apply_mod(ob, 'SOLIDIFY', thickness=0.012, offset=0)
    return ob


def awning():
    """An awning's frame: four poles and two bars (2.4 x 4 m, 2.3 m high); its canvas is cloth in the game."""
    P = Parts()
    pole = R.srgb('#4a423a')
    for x in (-2.0, 2.0):
        for y in (-1.2, 1.2):
            h = 2.3 if y < 0 else 1.9
            pv, pf = tube_mesh([([(x, y, 0), (x, y, h)], np.array([0.03, 0.028]))], 6)
            P.add(pv, pf, pole)
    for y, h in ((-1.2, 2.3), (1.2, 1.9)):
        pv, pf = tube_mesh([([(-2.05, y, h), (2.05, y, h)], np.array([0.025, 0.025]))], 6)
        P.add(pv, pf, pole)
    return P.build('awning', 0.5, angle=40)


def loft(rings, sides=12):
    """A body lofted along x through elliptical sections: rings = [(x, cy, cz, ry, rz)]; closed at both ends."""
    v, f = [], []
    for x, cy, cz, ry, rz in rings:
        for s in range(sides):
            a = s / sides * 2 * math.pi
            v.append((x, cy + math.cos(a) * ry, cz + math.sin(a) * rz))
    n = len(rings)
    for k in range(n - 1):
        for s in range(sides):
            i0, i1 = k * sides + s, k * sides + (s + 1) % sides
            f.append((i0, i1, i1 + sides, i0 + sides))
    f.append(tuple(range(sides - 1, -1, -1)))
    f.append(tuple((n - 1) * sides + s for s in range(sides)))
    return np.array(v, float), f


def bike():
    """A hover-bike on its skids: a long tapering nose, the seat, two engine pods low on the sides, a tail fin."""
    P = Parts()
    paint, dark = np.array([0.75, 0.75, 0.75]), R.srgb('#26221f')
    # the body, pale on top (tinted per copy in the game), the belly dark
    body = [(-1.1, 0, 0.86, 0.1, 0.08), (-0.85, 0, 0.86, 0.24, 0.18), (-0.45, 0, 0.83, 0.31, 0.23), (0.0, 0, 0.79, 0.33, 0.23),
            (0.45, 0, 0.75, 0.29, 0.2), (0.85, 0, 0.71, 0.22, 0.15), (1.12, 0, 0.67, 0.12, 0.09), (1.28, 0, 0.65, 0.02, 0.02)]
    v, f = loft(body, 14)
    P.add(v, f, np.where((v[:, 2] > 0.74)[:, None], paint[None, :], dark[None, :]))
    # the seat
    v, f = loft([(-0.75, 0, 1.0, 0.05, 0.03), (-0.6, 0, 1.03, 0.2, 0.07), (-0.15, 0, 1.0, 0.19, 0.07), (0.05, 0, 0.97, 0.05, 0.03)], 10)
    P.add(v, f, R.srgb('#3a2c22'))
    # the engine pods, their mouths at the back
    for y in (-0.42, 0.42):
        v, f = loft([(-1.05, y, 0.62, 0.15, 0.15), (-0.95, y, 0.62, 0.19, 0.19), (-0.3, y, 0.63, 0.18, 0.18), (0.2, y, 0.66, 0.11, 0.11), (0.35, y, 0.67, 0.03, 0.03)], 12)
        P.add(v, f, np.where((v[:, 0] < -0.9)[:, None], dark[None, :] * 0.6, paint[None, :] * 0.85))
    # the tail fin
    v, f = box((-0.95, 0, 1.08), (0.4, 0.04, 0.3))
    P.add(v, f, paint)
    for y in (-0.32, 0.32):
        sv, sf = tube_mesh([([(-0.9, y, 0.08), (0.9, y, 0.08), (1.05, y, 0.16)], np.array([0.03, 0.03, 0.03]))], 6)
        P.add(sv, sf, dark)
        for x in (-0.6, 0.6):
            lv, lf = tube_mesh([([(x, y, 0.08), (x, y * 0.8, 0.5)], np.array([0.025, 0.025]))], 5)
            P.add(lv, lf, dark)
    # the handlebar and a little screen
    hv, hf = tube_mesh([([(0.55, -0.32, 1.12), (0.62, 0, 1.08), (0.55, 0.32, 1.12)], np.array([0.02, 0.02, 0.02]))], 5)
    P.add(hv, hf, dark)
    return P.build('bike', 0.5, angle=45, target=2400)


def crawler():
    """A cargo crawler, ~9 x 3.6 m, 3.9 m high: two track units, the cab up front, a ribbed cargo box, a mast."""
    P = Parts()
    rust, body, dark, glass = R.srgb('#7a5236'), R.srgb('#9c8a6c'), R.srgb('#2a2522'), R.srgb('#14181c')
    # track units: a stadium in side view, extruded across
    for y in (-1.45, 1.45):
        prof = []
        for k in range(10):
            a = math.pi / 2 + k / 9 * math.pi
            prof.append((-3.6 + math.cos(a) * 0.6, 0.62 + math.sin(a) * 0.6))
        for k in range(10):
            a = -math.pi / 2 + k / 9 * math.pi
            prof.append((3.6 + math.cos(a) * 0.6, 0.62 + math.sin(a) * 0.6))
        n = len(prof)
        v = [(x, y - 0.38, z) for x, z in prof] + [(x, y + 0.38, z) for x, z in prof]
        f = [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
        f.append(tuple(range(n - 1, -1, -1)))
        f.append(tuple(range(n, 2 * n)))
        P.add(v, f, dark)
        # the road wheels' hubs
        for x in np.linspace(-3.2, 3.2, 6):
            hv, hf = tube_mesh([([(x, y - 0.4, 0.62), (x, y - 0.48, 0.62)], np.array([0.26, 0.26]))], 10)
            P.add(hv, hf, rust * 0.8)
    for c, s, col in (((0.0, 0, 1.45), (8.6, 2.6, 0.5), rust),          # chassis
                      ((3.3, 0, 2.45), (2.0, 2.5, 1.6), body),          # cab
                      ((4.31, 0, 2.7), (0.04, 2.1, 0.7), glass),        # windscreen
                      ((-1.2, 0, 2.85), (5.6, 3.0, 2.3), body)):        # cargo box
        v, f = box(c, s)
        P.add(v, f, col)
    for x in np.linspace(-3.8, 1.4, 7):                                  # the cargo box's ribs
        v, f = box((x, 0, 2.86), (0.14, 3.12, 2.42))
        P.add(v, f, rust)
    v, f = box((-1.2, 0, 4.06), (5.4, 2.6, 0.12))                        # roof rack
    P.add(v, f, dark)
    mv, mf = tube_mesh([([(2.6, 0.9, 3.2), (2.6, 0.9, 6.4)], np.array([0.05, 0.03]))], 6)
    P.add(mv, mf, dark)
    ev, ef = tube_mesh([([(2.3, -1.1, 3.2), (2.3, -1.1, 4.6)], np.array([0.11, 0.11]))], 8)
    P.add(ev, ef, dark)
    return P.build('crawler', 2.0, lambda c: (0.88 + 0.24 * R.fbm3(c / 0.9, 2, 31)) * (1 - 0.25 * R.smoothstep(1.2, 0.2, c[:, 2])), angle=30)


def firepit():
    """A ring of stones round charred logs and ash."""
    rng = np.random.default_rng(1500)
    P = Parts()
    for k in range(9):
        a = k / 9 * 2 * math.pi + rng.normal(0, 0.08)
        p, f = stone(rng, rng.uniform(0.14, 0.2), 0.55)
        p = rot_z(p, rng.uniform(0, 6.3)) + np.array([math.cos(a) * 0.62, math.sin(a) * 0.62, 0.05])
        P.add(p, f, PAL['tan'] * rng.uniform(0.7, 0.95))
    for k in range(3):
        a = k / 3 * math.pi + rng.normal(0, 0.2)
        d = np.array([math.cos(a), math.sin(a), 0])
        lv, lf = tube_mesh([([tuple(-d * 0.42 + [0, 0, 0.1]), tuple(d * 0.42 + [0, 0, 0.16 + 0.04 * k])], np.array([0.06, 0.05]))], 7)
        P.add(lv, lf, R.srgb('#1c1612'))
    av, af = ico(2)
    P.add(av * np.array([0.42, 0.42, 0.06]) + np.array([0, 0, 0.02]), af, R.srgb('#5c5650'))
    return P.build('firepit', 0.3, angle=40)


def main():
    R.reset()
    t0 = time.time()
    objs = [marker_pole(0), marker_pole(1), cairn(0), cairn(1), drum(0), drum(1), tent(), awning(), bike(), crawler(), firepit()]
    for o in objs:
        print(f'  {o.name}: {R.tris(o)} tris')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    R.export_glb(objs, OUT)
    print(f'wrote {OUT}: {len(objs)} meshes, {sum(R.tris(o) for o in objs)} tris, {os.path.getsize(OUT) / 1024:.0f} KB in {time.time() - t0:.0f}s')
    os.makedirs(os.path.join(HERE, 'build'), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'build', 'course.blend'))


if __name__ == '__main__':
    main()
