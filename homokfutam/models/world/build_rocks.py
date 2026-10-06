"""Sandstone formations for the HOMOKFUTAM map, modelled in Blender from code.

  blender -b --factory-startup --python homokfutam/models/world/build_rocks.py -- [--only spire,arch]

Writes homokfutam/assets/world/rocks.glb (meshopt-compressed with gltfpack when Node is there):

  spire0..7_lod0..2   hoodoos / spires, 100 m tall at scale 1 (the game scales them per instance):
                      beds of hard and soft sandstone (soft beds neck in), caprocks that overhang,
                      vertical fluting and joints, a flared foot that disappears into the sand
  mesa0..3            buttes for the horizon: talus slope, two cliff bands with a bench, caprock
  arch_lod0..1        the natural arch over the track: a 150 m sandstone fin with a parabolic
                      opening 60 m wide at the ground and 36 m high (the game fits it to the track)
  bridge              the rock bridge across the canyon, 96 m long (ends sit inside the walls)
  boulder0..5_lod0..1 boulders ~2 m across: rounded, blocky, slab, shard, split, pitted
  talus0..1_lod0..1   piles of fallen blocks for the feet of the spires

Vertex colour = sandstone tint (linear RGB) with the baked ambient occlusion in alpha; the game
splits the alpha off. No UVs: the game textures rock triplanar.
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

OUT = os.path.normpath(os.path.join(HERE, '..', '..', 'assets', 'world', 'rocks.glb'))

PAL = {k: R.srgb(v) for k, v in {
    'cream': '#e4c79f', 'tan': '#d6a873', 'orange': '#c98a57', 'rose': '#b9714f', 'red': '#a65c3c',
    'pale': '#e8d6b4', 'dark': '#8c5236',
}.items()}


def args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opt = {'only': ''}
    for i in range(0, len(argv) - 1, 2):
        opt[argv[i].lstrip('-')] = argv[i + 1]
    return opt


# ---------------------------------------------------------------------------- lathe

def lathe(name, z, radius, cx, cy, top_lift=0.6, bottom=True):
    """Surface of revolution with a per-vertex radius: radius (ny, nt), centre offsets (ny)."""
    ny, nt = radius.shape
    th = np.linspace(0, 2 * math.pi, nt, endpoint=False)
    X = cx[:, None] + np.cos(th)[None, :] * radius
    Y = cy[:, None] + np.sin(th)[None, :] * radius
    Z = np.repeat(z[:, None], nt, 1)
    verts = list(np.stack([X, Y, Z], -1).reshape(-1, 3))
    faces = []
    for j in range(ny - 1):
        for i in range(nt):
            a, b = j * nt + i, j * nt + (i + 1) % nt
            faces.append((a, b, b + nt, a + nt))
    top = len(verts)
    verts.append(np.array([cx[-1], cy[-1], z[-1] + top_lift]))
    for i in range(nt):
        faces.append(((ny - 1) * nt + i, (ny - 1) * nt + (i + 1) % nt, top))
    if bottom:
        bot = len(verts)
        verts.append(np.array([cx[0], cy[0], z[0] - 1]))
        for i in range(nt):
            faces.append(((i + 1) % nt, i, bot))
    return R.mesh_obj(name, np.array(verts), faces)


def beds(rng, H, tmin, tmax, cap_t=0.0):
    edges = [0.0]
    while edges[-1] < H:
        edges.append(edges[-1] + rng.uniform(tmin, tmax))
    edges = np.array(edges) * (H / edges[-1])
    if cap_t > 0:
        edges = edges[edges < H - cap_t - 1.5]
        edges = np.append(edges, [H - cap_t, H])
    hard = rng.random(len(edges) - 1)
    if cap_t > 0:
        hard[-1] = 1.0
    return edges, hard


def bed_at(edges, z):
    k = np.clip(np.searchsorted(edges, z, side='right') - 1, 0, len(edges) - 2)
    s = (z - edges[k]) / np.maximum(edges[k + 1] - edges[k], 1e-6)
    return k, np.clip(s, 0, 1)


def strata_rgb(z, edges, hard, rng, scheme):
    """Colour per bed (hard beds paler, soft beds warmer), laminae and a little noise."""
    k, s = bed_at(edges, np.clip(z, 0, edges[-1] - 1e-3))
    names = scheme
    pick = (np.arange(len(hard)) * 7 + (hard * 3).astype(int)) % len(names)
    base = np.array([PAL[names[p]] for p in pick])
    soft = np.array([PAL['orange'], PAL['rose'], PAL['tan']])[(np.arange(len(hard)) * 5) % 3]
    tint = np.where(hard[:, None] > 0.5, base, soft * 0.6 + base * 0.4)
    tint = tint * 0.55 + tint.mean(0, keepdims=True) * 0.45            # keep the bands subtle
    col = tint[k] * (0.95 + 0.08 * s)[:, None]                          # each bed darker at its base
    lam = 1 + 0.03 * np.sin(z * 2 * math.pi / 1.1 + np.sin(z * 0.37) * 2)
    col = col * lam[:, None]
    return col


def bed_coord(x, y, z, dip, phi, seed):
    """Height in bed space: the beds dip gently (slope dip towards phi) and wander a few metres."""
    w = R.fbm3(np.stack([x / 25.0, y / 25.0, z / 40.0], -1), 2, seed + 21) - 0.5
    return z + dip * (x * math.cos(phi) + y * math.sin(phi)) + w * 2.5


# ---------------------------------------------------------------------------- spires

SPIRES = [
    # seed, caprock, slenderness, neck strength, lean, scheme
    (11, True, 1.0, 1.0, 0.25, ('cream', 'orange', 'tan')),
    (23, False, 0.85, 1.2, -0.4, ('tan', 'rose', 'orange')),
    (37, True, 1.15, 0.8, 0.1, ('pale', 'orange', 'red')),
    (41, False, 0.7, 1.4, 0.6, ('cream', 'rose', 'tan')),
    (53, True, 0.95, 1.1, -0.2, ('tan', 'orange', 'cream')),
    (67, False, 1.2, 0.6, 0.0, ('orange', 'cream', 'rose')),
    (79, True, 0.8, 1.3, 0.45, ('pale', 'tan', 'orange')),
    (83, False, 1.05, 0.9, -0.55, ('cream', 'red', 'tan')),
]


def spire(idx):
    seed, cap, slender, necks, lean, scheme = SPIRES[idx]
    rng = np.random.default_rng(seed)
    H, R0 = 100.0, 13.0 * slender
    cap_t = rng.uniform(6, 9) if cap else 0.0
    edges, hard = beds(rng, H, 7, 19, cap_t)
    ny, nt = 230, 128
    z = np.linspace(-8, H, ny)
    th = np.linspace(0, 2 * math.pi, nt, endpoint=False)
    # The beds dip and wander (bed_coord), so the necks and bands tilt and vary round the column instead
    # of stacking up as level rings; each bed necks by its own amount (most a little, a few a lot) at its
    # own height, and the windward side weathers deeper.
    dip, phi, wind = rng.uniform(0.04, 0.12), rng.uniform(0, 2 * math.pi), rng.uniform(0, 2 * math.pi)
    nk = rng.uniform(0.15, 1.0, len(hard)) ** 1.5
    skew = rng.uniform(0.6, 1.6, len(hard))
    taper = 1 - 0.42 * np.clip(z / H, 0, 1) ** 1.25
    cx = lean * (np.clip(z, 0, H) / H) ** 2 * H * 0.12
    cy = lean * 0.4 * (np.clip(z, 0, H) / H) ** 2.5 * H * 0.12
    X = cx[:, None] + (R0 * taper)[:, None] * np.cos(th)[None, :]
    Y = cy[:, None] + (R0 * taper)[:, None] * np.sin(th)[None, :]
    zb = bed_coord(X.ravel(), Y.ravel(), np.repeat(z, nt), dip, phi, seed).reshape(ny, nt)
    k, s = bed_at(edges, np.clip(zb, 0, H - 1e-3))
    soft = 1 - hard[k]
    face = 0.55 + 0.45 * np.cos(th - wind)[None, :]
    neck = np.sin(math.pi * s ** skew[k]) ** 1.2 * R.smoothstep(0.35, 0.6, soft) * nk[k] * face
    prof = taper[:, None] * (1 - necks * (0.08 + 0.3 * soft) * neck)                  # soft beds weather into necks
    prof *= 1 + 0.015 * hard[k] * np.exp(-((1 - s) / 0.15) ** 2)                      # slight lips on hard beds
    prof *= (1 + 0.32 * R.smoothstep(11, -3, z))[:, None]                              # foot spreading into the talus
    if cap:
        zc = H - cap_t
        below = prof[np.argmin(np.abs(z - (zc - 0.5)))]
        inc = (z >= zc)[:, None]
        prof = np.where(inc, below[None, :] * rng.uniform(1.25, 1.45) * (1 - 0.06 * (z - zc) / cap_t)[:, None], prof)
        prof *= np.where(z > H - 2.2, np.sqrt(np.clip(1 - ((z - (H - 2.2)) / 2.4) ** 2, 0.05, 1)), 1)[:, None]
    else:
        prof *= np.where(z > H - 10, np.sqrt(np.clip(1 - ((z - (H - 10)) / 10.5) ** 2, 0.03, 1)), 1)[:, None]
    P = np.stack([np.repeat(np.cos(th)[None, :] * 1.4, ny, 0), np.repeat(np.sin(th)[None, :] * 1.4, ny, 0),
                  np.repeat(z[:, None] / 30, nt, 1)], -1).reshape(-1, 3)
    lob = (R.fbm3(P + seed * 3.1, 3, seed) - 0.5) * 2
    P2 = np.stack([P[:, 0] * 2.5, P[:, 1] * 2.5, P[:, 2] * 3.3], -1)
    lob2 = (R.fbm3(P2 + seed, 2, seed + 7) - 0.5) * 2
    radius = R0 * prof * (1 + 0.17 * lob.reshape(ny, nt) + 0.06 * lob2.reshape(ny, nt))
    ob = lathe(f'spire{idx}', z, radius, cx, cy, 0.8)
    R.remesh(ob, 0.45)

    def detail(c, n):
        zz = c[:, 2]
        kk, ss = bed_at(edges, np.clip(bed_coord(c[:, 0], c[:, 1], zz, dip, phi, seed), 0, H - 1e-3))
        sft = 1 - hard[kk]
        d = (R.fbm3(c / 9.0, 3, seed + 1) - 0.5) * 2.4
        flute = R.ridged3(c * np.array([1 / 2.4, 1 / 2.4, 1 / 18.0]), 2, seed + 2)
        d -= 0.45 * flute ** 2 * (0.3 + 0.7 * sft)
        crack = R.ridged3(c * np.array([1 / 7.0, 1 / 7.0, 1 / 50.0]), 2, seed + 3)
        d -= 1.3 * crack ** 14
        d += 0.12 * hard[kk] * np.exp(-((1 - ss) * (edges[kk + 1] - edges[kk]) / 0.9) ** 2)   # ledges
        d += (R.fbm3(c / 1.6, 2, seed + 4) - 0.5) * 0.3
        d += 0.05 * np.sin(zz * 2 * math.pi / 1.3 + R.fbm3(c / 9.0, 1, seed + 5) * 6)
        return d * R.smoothstep(-6, 0, zz)
    R.displace(ob, detail)
    R.smooth(ob, 0.35, 1)
    c = R.co(ob)
    rgb = strata_rgb(bed_coord(c[:, 0], c[:, 1], c[:, 2], dip, phi, seed), edges, hard, rng, scheme)
    rgb *= (1 + (R.fbm3(c / 5.0, 2, seed + 9) - 0.5) * 0.18)[:, None]
    ao = R.bake_ao(ob, 9.0, 48)
    R.set_colors(ob, rgb, ao)
    R.shade(ob)
    out = []
    for lod, t in enumerate((12000, 3500, 1000)):
        o = R.duplicate(ob, f'spire{idx}_lod{lod}')
        R.decimate(o, t)
        out.append(o)
    bpy.data.objects.remove(ob, do_unlink=True)
    return out


# ---------------------------------------------------------------------------- mesas

def mesa(idx):
    seed = 101 + idx * 13
    rng = np.random.default_rng(seed)
    H, R0 = 200.0, 200.0
    ny, nt = 140, 200
    z = np.linspace(-25, H, ny)
    p = np.clip(z / H, 0, 1)
    bench = rng.uniform(0.5, 0.62)
    prof = np.select(
        [p < 0.28, p < bench, p < bench + 0.05, p < 0.88, p < 0.92],
        [1.38 - 0.38 * (p / 0.28) ** 0.55, 1.0 - 0.03 * (p - 0.28) / (bench - 0.28),
         0.97 - 0.07 * (p - bench) / 0.05, 0.9 - 0.02 * (p - bench - 0.05) / (0.83 - bench), 0.88 - 0.04 * (p - 0.88) / 0.04],
        0.84)
    prof = np.where(z < 0, 1.38 + (-z / 25) * 0.15, prof)
    th = np.linspace(0, 2 * math.pi, nt, endpoint=False)
    P = np.stack([np.cos(th) * 1.6, np.sin(th) * 1.6, np.zeros(nt)], -1) + seed
    lob = (R.fbm3(P, 3, seed) - 0.5) * 2
    notch = np.zeros(nt)
    for a in rng.uniform(0, 2 * math.pi, 3):
        dth = np.angle(np.exp(1j * (th - a)))
        notch += np.exp(-(dth / 0.06) ** 2)
    rr = (1 + 0.3 * lob)[None, :] - 0.16 * notch[None, :] * R.smoothstep(0.15, 0.35, p)[:, None]
    radius = R0 * prof[:, None] * rr
    ob = lathe(f'mesa{idx}', z, radius, np.zeros(ny), np.zeros(ny), 1.5)
    R.remesh(ob, 1.8)

    def detail(c, n):
        zz = c[:, 2]
        pp = np.clip(zz / H, 0, 1)
        cliff = R.smoothstep(0.26, 0.32, pp) * (1 - R.smoothstep(0.97, 1.0, pp))
        d = (R.fbm3(c / 25.0, 3, seed + 1) - 0.5) * 6
        flute = R.ridged3(c * np.array([1 / 7.0, 1 / 7.0, 1 / 60.0]), 2, seed + 2)
        d -= 2.5 * flute ** 3 * cliff
        d += 1.2 * np.sin(zz * 2 * math.pi / 9.0 + R.fbm3(c / 40.0, 1, seed) * 4) * cliff
        d += (R.fbm3(c / 4.0, 2, seed + 3) - 0.5) * 1.5 * (1 - cliff)
        return d
    R.displace(ob, detail)
    c = R.co(ob)
    edges, hard = beds(rng, H, 8, 22)
    rgb = strata_rgb(c[:, 2], edges, hard, rng, ('cream', 'orange', 'rose', 'tan'))
    top = R.smoothstep(0.97, 1.0, c[:, 2] / H)
    rgb = rgb * (1 - top[:, None] * 0.3) + PAL['pale'] * top[:, None] * 0.3
    talus = 1 - R.smoothstep(0.2, 0.3, c[:, 2] / H)
    rgb = rgb * (1 - talus[:, None] * 0.4) + PAL['tan'] * talus[:, None] * 0.4
    ao = R.bake_ao(ob, 40.0, 32)
    R.set_colors(ob, rgb, ao)
    R.shade(ob)
    R.decimate(ob, 7000)
    return [ob]


# ---------------------------------------------------------------------------- arch + bridge

W_ARCH, H_ARCH = 30.0, 36.0       # opening: half width at the ground, apex height (track clearance)


def fin_height(x):
    """Top of the sandstone fin the arch is cut through, along its length."""
    ax = np.abs(x)
    return np.where(ax < 22, 53.0, 53.0 - (ax - 22) * 0.62) - 3 * np.cos(x * 0.09)


def arch():
    seed = 301
    rng = np.random.default_rng(seed)
    # a fin of overlapping blobs, 150 m long and ~24 m thick, highest over the track
    els = []
    for x in np.arange(-76, 77, 5.0):
        top = float(fin_height(np.array([x]))[0])
        for y in (-6.0, 0.0, 6.0):
            for z in np.arange(-6, top - 4, 7.0):
                els.append({'co': (x + rng.uniform(-1, 1), y * (1 - 0.2 * z / 55) + rng.uniform(-1, 1), z),
                            'radius': 10.5, 'size': (1, 1, 1), 'type': 'BALL'})
    ob = R.metaball_mesh('arch', els, 1.4)
    R.remesh(ob, 0.8)
    # the opening: a parabolic prism through the fin
    xs = np.linspace(-W_ARCH, W_ARCH, 61)
    zs = H_ARCH * (1 - (xs / W_ARCH) ** 2)
    prof = [(x, z) for x, z in zip(xs, zs)] + [(W_ARCH, -15.0), (-W_ARCH, -15.0)]
    verts, faces = [], []
    n = len(prof)
    for y in (-40.0, 40.0):
        verts += [(x, y, z) for x, z in prof]
    for k in range(n):
        a, b = k, (k + 1) % n
        faces.append((a, b, b + n, a + n))
    faces.append(tuple(range(n - 1, -1, -1)))
    faces.append(tuple(range(n, 2 * n)))
    cut = R.mesh_obj('arch_cut', np.array(verts), faces)
    m = ob.modifiers.new('cut', 'BOOLEAN')
    m.operation = 'DIFFERENCE'
    m.object = cut
    m.solver = 'EXACT'
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
        bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.data.objects.remove(cut, do_unlink=True)
    R.remesh(ob, 0.5)
    R.smooth(ob, 0.6, 3)
    edges, hard = beds(rng, 60, 2.5, 7)

    def detail(c, n):
        zz = c[:, 2]
        kk, ss = bed_at(edges, np.clip(zz, 0, 60 - 1e-3))
        side = np.abs(n[:, 2]) < 0.6
        d = (R.fbm3(c / 10.0, 3, seed) - 0.5) * 3.0
        d += 0.35 * hard[kk] * np.exp(-((1 - ss) * (edges[kk + 1] - edges[kk]) / 0.8) ** 2) * side
        d -= 0.5 * (1 - hard[kk]) * np.sin(math.pi * ss) ** 2 * side
        flute = R.ridged3(c * np.array([1 / 2.6, 1 / 2.6, 1 / 15.0]), 2, seed + 2)
        d -= 0.55 * flute ** 2 * side
        d -= 1.2 * R.ridged3(c * np.array([1 / 8.0, 1 / 8.0, 1 / 40.0]), 2, seed + 3) ** 14
        d += (R.fbm3(c / 1.6, 2, seed + 4) - 0.5) * 0.35
        under = R.smoothstep(-0.3, -0.7, n[:, 2])                  # the smooth, paler underside
        return d * (1 - under * 0.7)
    R.displace(ob, detail)
    c = R.co(ob)
    for lim in (19.0, 23.0):
        over = (np.abs(c[:, 0]) < lim) & (np.abs(c[:, 1]) < 14) & (c[:, 2] > 1)
        if over.any():
            print(f'  arch: lowest rock within {lim:.0f} m of the centre line: {c[over, 2].min():.1f} m up')
    rgb = strata_rgb(np.clip(c[:, 2], 0, 59), edges, hard, rng, ('tan', 'orange', 'cream', 'rose'))
    nrm = R.vnormals(ob)
    under = R.smoothstep(-0.3, -0.8, nrm[:, 2])[:, None]
    rgb = rgb * (1 - under * 0.4) + PAL['pale'] * under * 0.4
    ao = R.bake_ao(ob, 14.0, 64)
    R.set_colors(ob, rgb, ao)
    R.shade(ob)
    out = []
    for lod, t in enumerate((34000, 8000)):
        o = R.duplicate(ob, f'arch_lod{lod}')
        R.decimate(o, t)
        out.append(o)
    bpy.data.objects.remove(ob, do_unlink=True)
    return out


def bridge():
    seed = 401
    els = []
    for x in np.linspace(-48, 48, 49):
        zc = -4.5 * (1 - (x / 40) ** 2) if abs(x) < 40 else 0.0
        T = 8.5 + 4 * (abs(x) / 48) ** 3
        els.append({'co': (x, 0, zc), 'radius': T * 0.62, 'size': (1, 1.9, 1)})
    ob = R.metaball_mesh('bridge', els, 1.0)
    R.remesh(ob, 0.45)
    rng = np.random.default_rng(seed)
    edges, hard = beds(rng, 20, 1.5, 4)

    def detail(c, n):
        zz = c[:, 2] + 10
        kk, ss = bed_at(edges, np.clip(zz, 0, 20 - 1e-3))
        d = (R.fbm3(c / 7.0, 3, seed) - 0.5) * 2.0
        d += 0.4 * hard[kk] * np.exp(-((1 - ss) * (edges[kk + 1] - edges[kk]) / 0.6) ** 2)
        d += (R.fbm3(c / 1.3, 2, seed + 4) - 0.5) * 0.3
        return d
    R.displace(ob, detail)
    c = R.co(ob)
    rgb = strata_rgb(np.clip(c[:, 2] + 10, 0, 19.9), edges, hard, rng, ('orange', 'tan', 'rose'))
    ao = R.bake_ao(ob, 8.0, 48)
    R.set_colors(ob, rgb, ao)
    R.shade(ob)
    R.decimate(ob, 9000)
    ob.name = ob.data.name = 'bridge'
    return [ob]


# ---------------------------------------------------------------------------- boulders

BOULDERS = [
    # seed, scale (x, y, z), cuts, weathering, tone
    (501, (1.0, 0.9, 0.78), 7, 1.0, 'orange'),       # rounded, weathered
    (502, (1.1, 0.95, 0.85), 14, 0.4, 'tan'),        # blocky, fractured
    (503, (1.35, 1.0, 0.42), 10, 0.5, 'tan'),        # slab
    (504, (0.55, 0.5, 1.45), 11, 0.5, 'orange'),     # shard
    (505, (1.05, 0.9, 0.8), 12, 0.5, 'tan'),         # split
    (506, (1.0, 0.95, 0.7), 8, 0.8, 'orange'),       # pitted
]


def rock_core(seed, scale, cuts, rng):
    v, f = ico(5)
    p = v * np.array(scale)
    for _ in range(cuts):
        n = rng.standard_normal(3)
        n[2] *= 0.7
        n /= np.linalg.norm(n)
        d = rng.uniform(0.45, 0.8) * np.abs(p @ n).max()
        over = p @ n - d
        p -= np.maximum(over, 0)[:, None] * n
    bottom = -0.3 * scale[2]
    p[:, 2] = np.where(p[:, 2] < bottom, bottom + (p[:, 2] - bottom) * 0.25, p[:, 2])
    return p, f


_ICO = {}


def ico(level):
    if level not in _ICO:
        import bmesh
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=level, radius=1.0)
        v = np.array([x.co[:] for x in bm.verts])
        f = [tuple(x.vert.index for x in face.loops) for face in bm.faces]
        bm.free()
        _ICO[level] = (v, f)
    return _ICO[level]


def boulder(idx):
    seed, scale, cuts, noise, tone = BOULDERS[idx]
    rng = np.random.default_rng(seed)
    p, f = rock_core(seed, scale, cuts, rng)
    if idx == 4:                                       # split boulder: two halves with a gap
        a = p[:, 0] > 0.05
        p[a, 0] += 0.09
        p[~a, 0] -= 0.09
    ob = R.mesh_obj(f'boulder{idx}', p, f)
    R.remesh(ob, 0.022)

    def detail(c, n):
        # weathering rounds a little, then chips and cracks only ever cut in, so the fracture
        # planes stay flat and the edges stay crisp
        d = (R.fbm3(c / 0.7, 2, seed) - 0.5) * 0.03 * noise
        d -= 0.07 * R.smoothstep(0.58, 0.82, R.fbm3(c / 0.3, 2, seed + 6))
        d -= 0.045 * R.ridged3(c / 0.45, 2, seed + 2) ** 14
        bed = c[:, 2] / 0.17 + (R.fbm3(c / 0.8, 1, seed + 7) - 0.5) * 0.8
        d -= 0.012 * R.smoothstep(0.82, 0.97, bed - np.floor(bed))          # sandstone bedding notches
        d += (R.fbm3(c / 0.09, 2, seed + 1) - 0.5) * 0.012
        if idx == 5:                                   # tafoni pits
            d -= 0.09 * R.smoothstep(0.6, 0.85, R.fbm3(c / 0.16, 1, seed + 3))
        return d
    R.displace(ob, detail)
    c = R.co(ob)
    base = PAL[tone]
    rgb = base[None, :] * (1 + 0.06 * np.sin(c[:, 2] * 2 * math.pi / 0.35 + c[:, 0] * 0.8))[:, None]
    rgb *= (1 + (R.fbm3(c / 0.6, 2, seed + 5) - 0.5) * 0.25)[:, None]
    ao = R.bake_ao(ob, 0.8, 64)
    R.set_colors(ob, rgb, ao)
    R.shade(ob, 50)
    out = []
    for lod, t in enumerate((2400, 600)):
        o = R.duplicate(ob, f'boulder{idx}_lod{lod}')
        R.decimate(o, t)
        out.append(o)
    bpy.data.objects.remove(ob, do_unlink=True)
    return out


def talus(idx):
    """A pile of fallen blocks (~10 m across) for the feet of spires and cliffs."""
    seed = 601 + idx
    rng = np.random.default_rng(seed)
    allv, allf, off = [], [], 0
    for k in range(16 + idx * 6):
        sc = np.array([rng.uniform(0.7, 1.3), rng.uniform(0.7, 1.2), rng.uniform(0.4, 0.9)]) * rng.uniform(0.35, 1.5)
        p, f = rock_core(seed * 10 + k, sc, int(rng.integers(5, 10)), rng)
        v, _ = ico(5)
        a = rng.uniform(0, 2 * math.pi)
        rot = np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1]])
        r = rng.uniform(0, 5.5) * (1 - k / 40)
        b = rng.uniform(0, 2 * math.pi)
        pos = np.array([math.cos(b) * r, math.sin(b) * r, max(0.0, 1.6 - r * 0.35) * rng.uniform(0.5, 1)])
        allv.append(p @ rot.T + pos)
        allf += [tuple(i + off for i in face) for face in f]
        off += len(p)
    ob = R.mesh_obj(f'talus{idx}', np.concatenate(allv), allf)
    R.remesh(ob, 0.06)

    def detail(c, n):
        return (R.fbm3(c / 0.5, 3, seed) - 0.5) * 0.08 + (R.fbm3(c / 0.13, 2, seed + 1) - 0.5) * 0.025
    R.displace(ob, detail)
    c = R.co(ob)
    tones = np.array([PAL['orange'], PAL['tan'], PAL['rose'], PAL['cream']])
    pick = (R.fbm3(c / 1.2, 1, seed + 2) * 4).astype(int).clip(0, 3)
    rgb = tones[pick] * (1 + (R.fbm3(c / 0.4, 2, seed + 3) - 0.5) * 0.2)[:, None]
    ao = R.bake_ao(ob, 1.5, 48)
    R.set_colors(ob, rgb, ao)
    R.shade(ob, 50)
    out = []
    for lod, t in enumerate((7000, 1500)):
        o = R.duplicate(ob, f'talus{idx}_lod{lod}')
        R.decimate(o, t)
        out.append(o)
    bpy.data.objects.remove(ob, do_unlink=True)
    return out


def main():
    opt = args()
    only = [s for s in opt['only'].split(',') if s]
    R.reset()
    t0 = time.time()
    objs = []
    jobs = [('spire', lambda: [o for i in range(len(SPIRES)) for o in spire(i)]),
            ('mesa', lambda: [o for i in range(4) for o in mesa(i)]),
            ('arch', arch), ('bridge', bridge),
            ('boulder', lambda: [o for i in range(len(BOULDERS)) for o in boulder(i)]),
            ('talus', lambda: [o for i in range(2) for o in talus(i)])]
    for name, fn in jobs:
        if only and name not in only:
            continue
        t = time.time()
        made = fn()
        objs += made
        print(f'{name}: {len(made)} meshes, {sum(R.tris(o) for o in made)} tris, {time.time() - t:.0f}s')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    path = OUT if not only else OUT.replace('.glb', '_' + '_'.join(only) + '.glb')
    R.export_glb(objs, path)
    print(f'wrote {path}: {len(objs)} meshes, {sum(R.tris(o) for o in objs)} tris, '
          f'{os.path.getsize(path) / 1024:.0f} KB in {time.time() - t0:.0f}s')
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'build', 'rocks.blend'))


if __name__ == '__main__':
    main()
