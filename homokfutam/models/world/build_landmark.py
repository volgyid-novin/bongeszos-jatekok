"""The landmark of the HOMOKFUTAM map (docs/visual-next-steps.md E6), modelled in Blender from code.

  blender -b --factory-startup --python homokfutam/models/world/build_landmark.py

The wreck of a colossal bucket-wheel excavator, the biggest crawler there ever was, abandoned in the dunes: its
main boom has collapsed and the 36 m wheel lies half buried at its end, the lattice pylon still stands (~80 m)
with stay cables to the booms (some snapped and hanging), the counterweight boom reared up behind; the machine
house on its turntable, three track units sunk in the sand, the whole thing listing. The silhouette is the
image of the place: a great wheel, a long diagonal, a lattice tower with its cables.

Weathered industrial paint (faded ochre-yellow), rust, bare steel, dark machinery; sand on whatever faces up.

Writes homokfutam/assets/world/landmark.glb: wreck_lod0 (full lattice), wreck_lod1 (the main members only),
wreck_lod2 (solid beams and a plain wheel, for the far distance). Real metres, +Z up (exported +Y up); the origin
is on the ground under the turntable (the game sinks it a little into the dune). Vertex colour = tint, alpha =
baked ambient occlusion (the game splits it off).
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
from build_props import tube_mesh  # noqa: E402
from build_course import Parts, box  # noqa: E402

OUT = os.path.normpath(os.path.join(HERE, '..', '..', 'assets', 'world', 'landmark.glb'))

PAINT, RUST, STEEL, DARK, SAND = R.srgb('#7e6136'), R.srgb('#6e4127'), R.srgb('#7d7368'), R.srgb('#2b2622'), R.srgb('#d8bb92')

# the key points of the machine (metres): the turntable's top, the main boom's root and the wheel's hub (the boom
# has come down: the wheel lies in the sand), the pylon's head, the counterweight boom's end
TT = np.array([0.0, 0.0, 9.0])
BOOM0, HUB = np.array([12.0, 0.0, 24.0]), np.array([104.0, 6.0, 13.0])
PYLON = np.array([-6.0, 0.0, 82.0])
CW = np.array([-74.0, -4.0, 46.0])
WHEEL_R = 18.0


def frame(a, b):
    """Unit axis from a to b and two perpendiculars (u roughly horizontal, v roughly up)."""
    t = (b - a) / np.linalg.norm(b - a)
    u = np.cross(t, [0, 0, 1.0])
    if np.linalg.norm(u) < 1e-3:
        u = np.cross(t, [0, 1.0, 0])
    u /= np.linalg.norm(u)
    v = np.cross(u, t)
    return t, u, v


def member(P, a, b, r, col, sides=4):
    rv, rf = tube_mesh([([tuple(a), tuple(b)], np.array([r, r]))], sides)
    P.add(rv, rf, col)


def truss(P, a, b, w, h, bays, detail, col, chord=0.7, brace=0.32, taper=1.0, rng=None, broken=0.0):
    """A lattice boom from a to b: four chords on a w x h section (tapering to taper x at b), diagonal bracing on
    its four faces; detail 0: a solid box beam instead (the far distance)."""
    t, u, v = frame(a, b)
    L = np.linalg.norm(b - a)
    if detail == 0:
        k = (1 + taper) / 2
        c = (a + b) / 2
        m = np.stack([t, u, v], 1)
        bv, bf = box((0, 0, 0), (L, w * k, h * k))
        P.add(bv @ m.T + c, bf, col)
        return
    corner = lambda s, cu, cv: a + t * L * s + u * cu * w / 2 * (1 + (taper - 1) * s) + v * cv * h / 2 * (1 + (taper - 1) * s)
    cs = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    for cu, cv in cs:
        member(P, corner(0, cu, cv), corner(1, cu, cv), chord, col)
    if detail < 2:
        # only the bays' frames
        for k in range(1, bays):
            s = k / bays
            for j in range(4):
                member(P, corner(s, *cs[j]), corner(s, *cs[(j + 1) % 4]), brace, col)
        return
    for k in range(bays):
        s0, s1 = k / bays, (k + 1) / bays
        for j in range(4):
            if rng is not None and rng.random() < broken:
                continue                                    # a brace rusted through
            c0, c1 = cs[j], cs[(j + 1) % 4]
            if k % 2:
                member(P, corner(s0, *c0), corner(s1, *c1), brace, col)
            else:
                member(P, corner(s0, *c1), corner(s1, *c0), brace, col)
            member(P, corner(s1, *c0), corner(s1, *c1), brace * 0.8, col)


def wheel(P, detail, rng):
    """The bucket wheel at the hub: two rims, spokes, the buckets round the rim (some torn off)."""
    t, u, v = frame(BOOM0, HUB)
    ax = u                                                    # the wheel turns about the boom's horizontal perpendicular
    e1 = t - ax * np.dot(t, ax)                               # in the wheel's plane: e1 along the boom, e2 across it
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(ax, e1)
    n = 18
    for side in (-1.6, 1.6):
        pts = [tuple(HUB + ax * side + (e1 * math.cos(a) + e2 * math.sin(a)) * WHEEL_R) for a in np.linspace(0, 2 * math.pi, 37)]
        rv, rf = tube_mesh([(pts, np.full(len(pts), 0.9 if detail else 1.6))], 6 if detail else 4)
        P.add(rv, rf, PAINT)
    spokes = 8 if detail else 4
    for k in range(spokes):
        a = k / spokes * 2 * math.pi
        for side in ((-1.4, 1.4) if detail else (0.0,)):
            member(P, HUB + ax * side * 0.4, HUB + ax * side + (e1 * math.cos(a) + e2 * math.sin(a)) * (WHEEL_R - 0.6), 0.55 if detail else 1.0, PAINT, 5 if detail else 4)
    # the hub and its shaft
    hv, hf = tube_mesh([([tuple(HUB - ax * 3.4), tuple(HUB + ax * 3.4)], np.array([2.6, 2.6]))], 10 if detail else 6)
    P.add(hv, hf, DARK)
    if not detail:
        return
    for k in range(n):
        if rng.random() < 0.18:
            continue                                          # torn off
        a = k / n * 2 * math.pi
        rad = e1 * math.cos(a) + e2 * math.sin(a)
        tan = -e1 * math.sin(a) + e2 * math.cos(a)
        c = HUB + rad * (WHEEL_R + 1.4)
        m = np.stack([tan, ax, rad], 1)
        # a bucket: an open scoop, wider at its mouth (towards tan), teeth on the lip
        bv, bf = box((0, 0, 0), (3.6, 3.4, 2.6))
        bv[:, 2] *= np.where(bv[:, 0] > 0, 1.0, 0.65)
        bv[:, 0] += np.where(bv[:, 2] > 0, 0.6, 0)
        P.add(bv @ m.T + c, bf, DARK if rng.random() < 0.4 else RUST)


def body(P, detail, rng):
    """Three track units sunk in the sand, the turntable, the machine house, the operator's cab under the boom."""
    for (cx, cy, rot) in ((-14.0, -15.0, 0.1), (-14.0, 15.0, -0.05), (20.0, 0.0, 1.57)):
        v, f = box((cx, cy, 2.5), (30, 10, 9), rot)
        P.add(v, f, DARK)
        if detail:
            for k in range(7):                                  # the track's shoes standing proud
                xx = -12 + k * 4
                ca, sa = math.cos(rot), math.sin(rot)
                v, f = box((cx + ca * xx, cy + sa * xx, 7.2), (1.2, 10.6, 0.8), rot)
                P.add(v, f, RUST)
    tv, tf = tube_mesh([([(0, 0, 4), (0, 0, TT[2])], np.array([19.0, 19.0]))], 24 if detail else 12)
    P.add(tv, tf, STEEL)
    for c, s, col in (((-6, 0, 19), (40, 26, 20), PAINT),           # the machine house
                      ((-6, 0, 30.5), (36, 22, 3), STEEL),           # its roof
                      ((14, -9, 22), (8, 7, 8), PAINT),             # the operator's cab
                      ((18.05, -9, 23), (0.3, 6, 3), DARK)):        # its windows
        v, f = box(c, s)
        P.add(v, f, col)
    if detail:
        # louvres and doors on the house
        for k in range(8):
            v, f = box((-24 + k * 5, 13.05, 18 + (k % 2) * 4), (3, 0.3, 4), 0)
            P.add(v, f, DARK)
        for k in range(5):
            v, f = box((rng.uniform(-22, 10), rng.uniform(-9, 9), 32.5 + rng.uniform(0, 1)), (rng.uniform(2, 5), rng.uniform(2, 4), rng.uniform(1.5, 3)))
            P.add(v, f, STEEL)


def cables(P, detail, rng):
    """Stays from the pylon's head to the booms; two have snapped and hang slack."""
    t, u, v = frame(BOOM0, HUB)
    ends = [(BOOM0 + (HUB - BOOM0) * 0.62 + u * 2, False), (BOOM0 + (HUB - BOOM0) * 0.62 - u * 2, True),
            (BOOM0 + (HUB - BOOM0) * 0.35 + u * 2, False), (CW + np.array([0, 2, 2]), False), (CW + np.array([0, -2, 2]), False),
            (BOOM0 + (HUB - BOOM0) * 0.35 - u * 2, True)]
    for end, snapped in ends:
        a = PYLON + np.array([0, np.sign(end[1] + 1e-3) * 1.5, -1])
        if snapped and detail:
            # hanging from the pylon, curled at its loose end
            pts = [a]
            d = (end - a) * 0.45
            for k in range(1, 9):
                s = k / 8
                pts.append(a + d * s + np.array([0, 0, -40 * s * s]))
            rv, rf = tube_mesh([([tuple(p) for p in pts], np.full(len(pts), 0.28))], 4)
            P.add(rv, rf, DARK)
            continue
        if snapped:
            continue
        pts = [a + (end - a) * s + np.array([0, 0, -2.5 * math.sin(math.pi * s)]) for s in np.linspace(0, 1, 9 if detail else 3)]
        rv, rf = tube_mesh([([tuple(p) for p in pts], np.full(len(pts), 0.3 if detail else 0.5))], 4)
        P.add(rv, rf, DARK)


def build(detail):
    """detail 2: the full lattice; 1: the main members; 0: solid beams (the far distance)."""
    rng = np.random.default_rng(4711)
    P = Parts()
    body(P, detail, rng)
    # the main boom, from the house down to the wheel lying in the sand
    truss(P, BOOM0, HUB, 9.0, 7.0, 14, detail, PAINT, taper=0.75, rng=rng, broken=0.12)
    wheel(P, detail, rng)
    # the counterweight boom, reared up behind, and its block
    cw0 = np.array([-20.0, 0.0, 30.0])
    truss(P, cw0, CW, 8.0, 6.0, 9, detail, PAINT, taper=0.8, rng=rng, broken=0.1)
    v, f = box(tuple(CW + np.array([-6, 0, -4])), (14, 12, 12))
    P.add(v, f, STEEL)
    # the pylon: an A-frame of two lattice legs from the house's roof to the head
    for side in (-1, 1):
        truss(P, np.array([-6.0, side * 9.0, 32.0]), PYLON + np.array([0, side * 1.5, 0]), 3.0, 3.0, 10, detail, PAINT, chord=0.55, brace=0.26, rng=rng, broken=0.08)
    member(P, PYLON + np.array([0, -2.5, 0]), PYLON + np.array([0, 2.5, 0]), 1.2, PAINT)
    cables(P, detail, rng)
    # the discharge boom off the side (the conveyor that carried the spoil away): broken, its end in the sand
    d0, d1 = np.array([-14.0, -13.0, 14.0]), np.array([-40.0, -62.0, 2.0])
    truss(P, d0, d1, 4.5, 3.5, 8, detail, PAINT, chord=0.5, brace=0.25, taper=0.9, rng=rng, broken=0.2)
    return P


def colour(v, nrm, base):
    """Faded paint going to rust, bare steel where the sand has scoured it; sand on what faces up."""
    n1 = R.fbm3(v / 7.0, 3, 41)
    n2 = R.fbm3(v / 2.0, 2, 42)
    k_rust = R.smoothstep(0.36, 0.58, n1 * 0.7 + n2 * 0.3)
    c = base * (1 - k_rust[:, None]) + RUST[None, :] * k_rust[:, None] * (base.mean(1, keepdims=True) / PAINT.mean()) ** 0.5
    # sand-blasted pale low down (the wind's sand reaches ~10 m)
    kb = R.smoothstep(12.0, 2.0, v[:, 2]) * 0.35
    c = c * (1 - kb[:, None]) + STEEL[None, :] * 1.15 * kb[:, None]
    c *= (0.85 + 0.3 * R.fbm3(v * np.array([0.4, 0.4, 0.08]), 2, 43))[:, None]
    ks = R.smoothstep(0.55, 0.9, nrm[:, 2]) * (0.55 + 0.45 * n2)
    c = c * (1 - ks[:, None]) + SAND[None, :] * ks[:, None]
    return np.clip(c, 0, 1)


def make(detail, name):
    P = build(detail)
    v = np.concatenate(P.v)
    base = np.concatenate(P.c)
    ob = R.mesh_obj(name, v, P.f)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    # listing: one track unit has sunk
    ax, ay = math.radians(4.5), math.radians(-2.5)
    Rx = np.array([[1, 0, 0], [0, math.cos(ax), -math.sin(ax)], [0, math.sin(ax), math.cos(ax)]])
    Ry = np.array([[math.cos(ay), 0, math.sin(ay)], [0, 1, 0], [-math.sin(ay), 0, math.cos(ay)]])
    c = R.co(ob) @ (Ry @ Rx).T
    R.set_co(ob, c)
    ao = R.bake_ao(ob, 18.0 if detail else 25.0, 64)
    R.set_colors(ob, colour(c, R.vnormals(ob), base), ao)
    R.shade(ob, 30)
    print(f'  {name}: {R.tris(ob)} tris, top at {c[:, 2].max():.0f} m, {c[:, 0].min():.0f}..{c[:, 0].max():.0f} m long')
    return ob


def main():
    R.reset()
    t0 = time.time()
    lods = [make(2, 'wreck_lod0'), make(1, 'wreck_lod1'), make(0, 'wreck_lod2')]
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    R.export_glb(lods, OUT)
    print(f'wrote {OUT}: {os.path.getsize(OUT) / 1024:.0f} KB in {time.time() - t0:.0f}s')
    os.makedirs(os.path.join(HERE, 'build'), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'build', 'landmark.blend'))


if __name__ == '__main__':
    main()
