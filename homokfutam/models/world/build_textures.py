"""Tileable PBR texture sets for the HOMOKFUTAM map, designed in numpy and baked in Cycles.

  blender -b --factory-startup --python homokfutam/models/world/build_textures.py -- [--size 2048] [--only sand_ripple,gravel] [--samples 64]
  ... -- --repack 1      only redo the 1K game maps and the KTX2 files from the 2K masters in build/

For every material a recipe (below) builds a periodic height field, albedo and roughness
(plus real 3D stones for the gravel). Blender turns that into a displaced mesh with a margin
of wrapped neighbours and bakes it onto a flat plane ("selected to active"): albedo, roughness,
tangent-space normal, ambient occlusion and height. The results are packed per material:

  <name>_c.png   RGB = albedo (sRGB), A = height (0..1 over the material's relief)
  <name>_n.png   RG = tangent normal xy, B = roughness, A = ambient occlusion

and then encoded with toktx (KTX-Software) into texture arrays in homokfutam/assets/tex/:

  ground_c.ktx2 / ground_n.ktx2   planar ground layers (GROUND order below)
  rock_c.ktx2 / rock_n.ktx2       triplanar rock layers (ROCK order below)
  arena_c.ktx2 / arena_n.ktx2     arena building materials (ARENA order below)

Bakes run at 2048 px (kept in build/ as *_2k.png masters); the game gets 1024 px, which is
already finer than a screen pixel at the chase camera's distance, at a fraction of the download.

Albedo goes to ETC1S (small download), normals to UASTC (they need the precision). Row 0 of
each array image is v = 0 (toktx --lower_left_maps_to_s0t0), which is the game's +x / +z frame.
Raw bakes and previews go to models/world/build/tex/ (not committed).
"""
import json
import math
import os
import shutil
import subprocess
import sys
import time

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import texlib as tl  # noqa: E402

ASSETS = os.path.normpath(os.path.join(HERE, '..', '..', 'assets', 'tex'))
BUILD = os.path.join(HERE, 'build', 'tex')

GROUND = ['sand_ripple', 'sand_soft', 'gravel', 'hardpan', 'packed', 'slickrock', 'paving']
ROCK = ['cliff', 'boulder']


def args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opt = {'size': 2048, 'samples': 64, 'only': '', 'encode': 1, 'repack': 0}
    for i in range(0, len(argv) - 1, 2):
        k, v = argv[i].lstrip('-'), argv[i + 1]
        opt[k] = v if k == 'only' else int(v)
    return opt


# ======================================================================================
#  Recipes. Each returns dict(T=tile metres, H=height m, albedo=linear RGB, rough=0..1,
#  ao=AO distance m, stones=optional 3D stones). n = texture size in pixels.
# ======================================================================================

def ripple_profile(t, crest=0.72):
    """Asymmetric wind ripple: long gentle stoss side, short steep lee side, sharp crest."""
    up = np.power(np.clip(t / crest, 0, 1), 1.25)
    down = np.power(np.clip((1 - t) / (1 - crest), 0, 1), 1.7)
    return np.where(t < crest, up, down)


def grain(n, seed, amp_px=0.00035, amp_fine=0.0005):
    rng = np.random.default_rng(seed)
    return rng.standard_normal((n, n)).astype(np.float32) * amp_px + tl.spectral(n, n / 16, n / 3, 0.5, seed + 1) * amp_fine


def speckle(n, seed, base, colours, density):
    """Sand grains of other minerals: sparse per-pixel colour flecks (linear RGB)."""
    rng = np.random.default_rng(seed)
    out = base.copy()
    r = rng.random((n, n))
    acc = 0.0
    for col, d in zip(colours, density):
        m = (r >= acc) & (r < acc + d)
        out[m] = out[m] * 0.35 + np.asarray(col, np.float32) * 0.65
        acc += d
    return out


def sand_ripple(n):
    T = 4.0
    U, V = tl.uv(n)
    w1 = tl.spectral(n, 1, 4, 2.0, 11) * 0.38
    w2 = tl.spectral(n, 3, 14, 1.5, 12) * 0.07
    f = 16                                                    # ripples per tile: 25 cm wavelength
    phase = V * f + U * 1 + w1 + w2
    t = phase - np.floor(phase)
    amp = 0.011 * (0.55 + 0.45 * tl.unit(tl.spectral(n, 1, 3, 2.0, 13)))
    breaks = tl.smoothstep(-1.1, -0.35, tl.spectral(n, 2, 9, 1.6, 14))          # crests that end
    h_rip = amp * breaks * ripple_profile(t)
    p2 = V * 37 + U * 2 + w1 * 2.1 + tl.spectral(n, 4, 20, 1.4, 15) * 0.3
    h2 = 0.0018 * ripple_profile(p2 - np.floor(p2), 0.65) * (1 - breaks * 0.6)
    H = h_rip + h2 + grain(n, 16)
    # a few small pebbles and coarse grains lying in the troughs
    xs, ys, rs = tl.dart_throw(T, 70, 0.003, 0.012, 17, power=2.5)
    hs = rs * 0.9
    stone, ids = tl.stamp_bumps(H, T, xs, ys, rs, hs, embed=0.5, shape=2.5)
    # colour: coarse dark grains gather on the crests, fine pale sand in the troughs
    crest = tl.smoothstep(0.55, 0.85, ripple_profile(t)) * breaks
    base = tl.hexcol('#d7a56b')[None, None, :] * np.ones((n, n, 1), np.float32)
    var = 1 + tl.spectral(n, 2, 30, 1.2, 18)[..., None] * 0.035
    base = base * var * (1 - crest[..., None] * 0.09) + tl.hexcol('#b4703f') * crest[..., None] * 0.05
    alb = speckle(n, 19, base, [tl.hexcol('#4a3022'), tl.hexcol('#f4e7d2'), tl.hexcol('#8f4a2c')], [0.012, 0.02, 0.015])
    rng = np.random.default_rng(20)
    pcol = np.array([tl.hexcol(c) for c in ('#5b4232', '#8b5a3a', '#b89a78', '#d9cfbf')], np.float32)
    sc = pcol[rng.integers(0, len(pcol), len(xs))]
    m = stone[..., None]
    alb = np.where(ids[..., None] >= 0, alb * (1 - m) + sc[np.maximum(ids, 0)] * m, alb)
    rough = 0.9 - crest * 0.04 - stone * 0.15
    return dict(T=T, H=H, albedo=alb, rough=rough, ao=0.02)


def sand_soft(n):
    T = 4.0
    U, V = tl.uv(n)
    H = tl.spectral(n, 1, 5, 2.0, 31) * 0.004
    # wind streaks: long along v (the wind direction; ripple crests run along u)
    streak = tl.spectral(n, 2, 24, 1.6, 32, ax=0.3, ay=1.0)
    H += streak * 0.0005
    # faint young ripples in patches
    w = tl.spectral(n, 1, 5, 2.0, 33) * 0.6
    p = V * 26 + U * 1 + w
    patch = tl.smoothstep(0.2, 1.2, tl.spectral(n, 1, 4, 2.0, 34))
    H += 0.0022 * ripple_profile(p - np.floor(p), 0.7) * patch
    # small avalanche tongues / grain flows: soft lobes along v
    lob = tl.spectral(n, 3, 12, 1.8, 35, ax=1.0, ay=0.35)
    H += np.maximum(lob, 0) * 0.0016
    H += grain(n, 36, 0.0003, 0.0004)
    base = tl.hexcol('#dcae76')[None, None, :] * (1 + tl.spectral(n, 1, 20, 1.3, 37)[..., None] * 0.03)
    base = base * (1 + streak[..., None] * 0.006)
    alb = speckle(n, 38, base, [tl.hexcol('#56392a'), tl.hexcol('#f6ead6')], [0.006, 0.02])
    rough = 0.92 + 0 * H
    return dict(T=T, H=H, albedo=alb, rough=rough, ao=0.02)


def gravel(n):
    """Desert pavement: a mosaic of flat, varnished stones on fine sand (real 3D stones)."""
    T = 3.0
    H = tl.spectral(n, 1, 6, 2.0, 41) * 0.006 + tl.spectral(n, 6, 40, 1.4, 42) * 0.0012 + grain(n, 43)
    xs, ys, rs = tl.dart_throw(T, 20000, 0.005, 0.05, 44, power=1.6, overlap=0.3, max_tries=400000)
    rng = np.random.default_rng(45)
    pal = [('#3f2f25', 0.22), ('#5b4130', 0.22), ('#7a4e34', 0.16), ('#93603e', 0.12), ('#b89a78', 0.12),
           ('#d6ccbc', 0.06), ('#6d6863', 0.10)]
    cols = np.array([tl.hexcol(c) for c, _ in pal], np.float32)
    w = np.array([p for _, p in pal])
    pick = rng.choice(len(pal), len(xs), p=w / w.sum())
    shade = 0.8 + 0.4 * rng.random(len(xs))
    stones = dict(
        x=xs, y=ys, r=rs, aspect=0.7 + 0.6 * rng.random(len(xs)), angle=rng.random(len(xs)) * math.pi,
        flat=0.32 + 0.22 * rng.random(len(xs)), embed=0.35 + 0.25 * rng.random(len(xs)),
        tilt=rng.standard_normal((len(xs), 2)) * 0.12, seed=rng.integers(0, 1 << 30, len(xs)),
        col=np.clip(cols[pick] * shade[:, None], 0, 1),
        rough=np.where(pick <= 2, 0.45 + 0.2 * rng.random(len(xs)), 0.62 + 0.25 * rng.random(len(xs))),
    )
    base = tl.hexcol('#c79f70')[None, None, :] * (1 + tl.spectral(n, 2, 30, 1.2, 46)[..., None] * 0.04)
    alb = speckle(n, 47, base, [tl.hexcol('#3e2a1f'), tl.hexcol('#efe2cc')], [0.03, 0.03])
    rough = 0.9 + 0 * H
    return dict(T=T, H=H, albedo=alb, rough=rough, ao=0.03, stones=stones)


def hardpan(n):
    """Cracked clay playa: curling polygonal plates, sand in some cracks, salt bloom."""
    T = 4.0
    U, V = tl.uv(n)
    dU = tl.spectral(n, 2, 10, 1.6, 51) * 0.012
    dV = tl.spectral(n, 2, 10, 1.6, 52) * 0.012
    vor = tl.voronoi(n, 15, 53, 0.95)
    # warp the edge field a little so the cracks wander
    edge = tl.warp(vor['edge'], dU * n, dV * n) * (T / 15)                      # metres to border
    cr = tl.cell_rand(vor, 54, 4)
    wc = 0.003 + 0.006 * tl.unit(tl.spectral(n, 2, 12, 1.4, 55))              # crack half-width
    plate = tl.smoothstep(wc * 0.6, wc * 1.4, edge)
    curl = (1 - tl.smoothstep(0.0, 0.045, edge)) * (0.003 + 0.007 * cr[..., 0])
    tiltx = (cr[..., 1] - 0.5) * 0.02
    tilty = (cr[..., 2] - 0.5) * 0.02
    ccx, ccy = vor['cx'] / 15, vor['cy'] / 15
    tilt = tiltx * (U - ccx) * T + tilty * (V - ccy) * T
    surf = tl.spectral(n, 8, 120, 1.2, 56) * 0.0006
    # fine secondary cracks inside the plates
    vor2 = tl.voronoi(n, 70, 57, 0.9)
    e2 = vor2['edge'] * (T / 70)
    fine = (1 - tl.smoothstep(0.0, 0.0018, e2)) * tl.smoothstep(0.1, 0.9, tl.spectral(n, 2, 8, 1.6, 58))
    top = 0.008 + curl + tilt + surf - fine * 0.0018
    bottom = -0.006 + tl.spectral(n, 10, 80, 1.0, 59) * 0.001
    H = bottom * (1 - plate) + top * plate
    # wind-blown sand drifted over parts of the crust
    drift = tl.smoothstep(0.55, 1.4, tl.spectral(n, 1, 6, 2.0, 60))
    sandh = 0.003 + tl.spectral(n, 1, 6, 2.0, 60) * 0.004 + grain(n, 61)
    H = np.maximum(H, sandh * (drift > 0.02) - (1 - drift) * 0.02)
    sandm = tl.smoothstep(0.0, 0.002, sandh - H + 0.0005) * (drift > 0.02)
    # colour
    pc = tl.hexcol('#d9c4a1') * (1 - cr[..., 3:4] * 0.12) + tl.hexcol('#c2a27b') * cr[..., 3:4] * 0.12
    pc = pc * (1 + tl.spectral(n, 4, 60, 1.2, 62)[..., None] * 0.03)
    salt = tl.smoothstep(0.6, 1.5, tl.spectral(n, 3, 25, 1.4, 63)) * plate
    pc = pc * (1 - salt[..., None] * 0.5) + tl.hexcol('#f1ebe0') * salt[..., None] * 0.5
    crack = tl.hexcol('#8a6748')
    alb = crack * (1 - plate[..., None]) + pc * plate[..., None]
    alb = alb * (1 - fine[..., None] * 0.25)
    sc = speckle(n, 64, np.broadcast_to(tl.hexcol('#d2a571'), (n, n, 3)).copy(), [tl.hexcol('#4a3022')], [0.01])
    alb = alb * (1 - sandm[..., None]) + sc * sandm[..., None]
    rough = 0.86 - salt * 0.1 + sandm * 0.06
    return dict(T=T, H=H, albedo=alb, rough=rough, ao=0.03)


def packed(n):
    """Track base: sand packed hard by the pods. u = across the track, v = along it."""
    T = 4.0
    U, V = tl.uv(n)
    H = tl.spectral(n, 1, 8, 2.0, 71) * 0.003 + tl.spectral(n, 8, 60, 1.6, 70) * 0.0008
    # a few scrapes along the driving direction (v), not a uniform grain
    scr = tl.spectral(n, 10, 140, 1.0, 72, ax=1.0, ay=10.0)
    smask = tl.smoothstep(0.3, 1.2, tl.spectral(n, 1, 5, 2.0, 69))
    scrape = np.maximum(np.abs(scr) - 1.4, 0) * smask
    H -= scrape * 0.0012
    # micro cracks of the dried crust
    vor = tl.voronoi(n, 9, 73, 0.9)
    e = vor['edge'] * (T / 9)
    cmask = tl.smoothstep(0.1, 1.0, tl.spectral(n, 1, 6, 1.8, 74))
    crack = (1 - tl.smoothstep(0.0, 0.0022, e)) * cmask
    H -= crack * 0.0025
    # grit and small stones pressed into the surface
    rng = np.random.default_rng(76)
    xs, ys, rs = tl.dart_throw(T, 2600, 0.0015, 0.016, 75, power=2.8, max_tries=60000)
    stone, ids = tl.stamp_bumps(H, T, xs, ys, rs, rs * 0.35, embed=0.65, shape=2.5,
                                aspect=0.7 + 0.6 * rng.random(len(xs)), angle=rng.random(len(xs)) * 3.14)
    # loose sand in small ripple patches (the large drifts come from the shader, at track scale,
    # so nothing big repeats with the tile)
    loose = tl.smoothstep(1.1, 1.9, tl.spectral(n, 8, 30, 1.6, 77))
    p = V * 20 + U * 1 + tl.spectral(n, 1, 5, 2.0, 78) * 0.3
    H += loose * (0.001 + 0.002 * ripple_profile(p - np.floor(p)))
    H += grain(n, 79, 0.00025, 0.0003)
    base = tl.hexcol('#b88a5c') * (1 + tl.spectral(n, 8, 60, 1.2, 80)[..., None] * 0.04)
    base = base * (1 + tl.spectral(n, 30, 300, 0.8, 83)[..., None] * 0.03)
    alb = speckle(n, 81, base, [tl.hexcol('#3d2a1f'), tl.hexcol('#e8d6b8'), tl.hexcol('#8a5032')], [0.025, 0.015, 0.02])
    alb = alb * (1 - crack[..., None] * 0.3) * (1 - scrape[..., None] * 0.08)
    pcol = np.array([tl.hexcol(c) for c in ('#4f3a2c', '#7c5136', '#a88b6c', '#cfc2ae', '#5e5650')], np.float32)
    sc = pcol[rng.integers(0, 5, len(xs))]
    m = stone[..., None]
    alb = np.where(ids[..., None] >= 0, alb * (1 - m) + sc[np.maximum(ids, 0)] * m, alb)
    alb = alb * (1 - loose[..., None]) + tl.hexcol('#d0a26d') * loose[..., None] * (1 + tl.spectral(n, 4, 60, 1, 82)[..., None] * 0.03)
    rough = 0.76 - scrape * 0.05 + loose * 0.13 - stone * 0.12
    return dict(T=T, H=H, albedo=alb, rough=rough, ao=0.025)


def slickrock(n):
    """Bare sandstone bedrock: cross-bedded laminae, joints, shallow pits, sand in the lows."""
    T = 6.0
    U, V = tl.uv(n)
    warpf = tl.spectral(n, 1, 4, 2.0, 91) * 0.45
    sets = tl.cell_rand(tl.voronoi(n, 3, 92, 0.9), 93)
    lam = np.where(sets < 0.5, V * 40 + U * 6, V * 34 - U * 9) + warpf
    lamf = lam - np.floor(lam)
    H = tl.spectral(n, 1, 6, 2.0, 94) * 0.02 + tl.spectral(n, 6, 60, 1.5, 95) * 0.002
    H += (np.abs(lamf - 0.5) - 0.25) * 0.0012
    # joints: long straight-ish cracks
    vor = tl.voronoi(n, 4, 96, 0.8)
    e = tl.warp(vor['edge'], tl.spectral(n, 2, 8, 1.8, 97) * n * 0.006, tl.spectral(n, 2, 8, 1.8, 98) * n * 0.006) * (T / 4)
    joint = 1 - tl.smoothstep(0.004, 0.03, e)
    H -= joint * 0.03
    # rounded weathering pits
    vp = tl.voronoi(n, 22, 99, 1.0)
    pit = (1 - tl.smoothstep(0.0, 0.45, vp['f1'])) * tl.smoothstep(0.3, 1.2, tl.spectral(n, 1, 8, 1.6, 100))
    H -= pit * 0.012
    H += grain(n, 101, 0.0003, 0.0005)
    low = tl.smoothstep(0.003, -0.012, H - tl.blur(H, 24))
    sand = np.maximum(low, joint * 0.8)
    H = np.maximum(H, tl.blur(H, 24) - 0.004) * sand + H * (1 - sand)
    return dict(T=T, H=H, albedo=None, rough=None, ao=0.08, _lam=lamf, _sets=sets, _sand=sand, _pit=pit)


def _slickrock_colour(d, n):
    lamf, sets, sand, pit = d.pop('_lam'), d.pop('_sets'), d.pop('_sand'), d.pop('_pit')
    c1, c2, c3 = tl.hexcol('#c98654'), tl.hexcol('#ddae7e'), tl.hexcol('#b56c43')
    band = tl.smoothstep(0.3, 0.7, lamf)[..., None] * 0.22 + tl.unit(tl.spectral(n, 1, 6, 2.0, 105))[..., None] * 0.5
    base = c1 * (1 - band) + c2 * band
    base = base * (1 - sets[..., None] * 0.15) + c3 * sets[..., None] * 0.15
    base = base * (1 + tl.spectral(n, 2, 40, 1.2, 102)[..., None] * 0.05)
    varn = tl.smoothstep(0.7, 1.6, tl.spectral(n, 2, 14, 1.5, 103))[..., None]
    base = base * (1 - varn * 0.35) + tl.hexcol('#5a3a28') * varn * 0.2
    base = base * (1 - pit[..., None] * 0.15)
    sc = speckle(n, 104, np.broadcast_to(tl.hexcol('#d4a670'), (n, n, 3)).copy(), [tl.hexcol('#4a3022')], [0.01])
    d['albedo'] = base * (1 - sand[..., None]) + sc * sand[..., None]
    d['rough'] = 0.82 - varn[..., 0] * 0.12 + sand * 0.08
    return d


def paving(n):
    """Arena floor: worn sandstone slabs in running courses, sand in the joints."""
    T = 4.0
    U, V = tl.uv(n)
    rng = np.random.default_rng(111)
    rows = 5
    hts = rng.random(rows) * 0.5 + 0.75
    edges_v = np.concatenate([[0], np.cumsum(hts / hts.sum())])
    row = np.clip(np.searchsorted(edges_v, V, side='right') - 1, 0, rows - 1)
    v0, v1 = edges_v[row], edges_v[row + 1]
    slab_id = np.zeros_like(row)
    du = np.zeros_like(U)
    off = 0
    for r in range(rows):
        k = rng.integers(3, 6)
        w = rng.random(k) * 0.7 + 0.65
        e = np.concatenate([[0], np.cumsum(w / w.sum())]) + rng.random()
        e = e - np.floor(e[0])
        m = row == r
        uu = (U[m] - e[0]) % 1.0 + e[0]
        j = np.clip(np.searchsorted(e, uu, side='right') - 1, 0, k - 1)
        slab_id[m] = off + j
        du[m] = np.minimum(uu - e[j], e[j + 1] - uu)
        off += k
    dv = np.minimum(V - v0, v1 - V)
    dedge = np.minimum(du, dv) * T                                             # metres to the joint
    jw = 0.008 + 0.006 * tl.unit(tl.spectral(n, 4, 30, 1.2, 112))
    chip = tl.spectral(n, 8, 90, 1.0, 113) * 0.006 - np.maximum(tl.spectral(n, 10, 60, 1.2, 123), 0) * 0.01
    slab = tl.smoothstep(jw, jw + 0.012, dedge + chip)
    sr = np.random.default_rng(114).random((off, 4)).astype(np.float32)[slab_id]
    top = 0.012 + (sr[..., 0] - 0.5) * 0.006 + (sr[..., 1] - 0.5) * 0.01 * (U - 0.5) + tl.spectral(n, 6, 80, 1.3, 115) * 0.0008
    wear = tl.spectral(n, 1, 6, 2.0, 116)
    top -= np.maximum(wear, 0) * 0.002
    H = top * slab + (-0.004 + grain(n, 117)) * (1 - slab)
    # cracks across a few slabs
    vc = tl.voronoi(n, 6, 118, 0.9)
    crk = (1 - tl.smoothstep(0.0, 0.004, vc['edge'] * T / 6)) * (sr[..., 2] > 0.7)
    H -= crk * slab * 0.006
    sc1, sc2, sc3 = tl.hexcol('#d4b48a'), tl.hexcol('#c9a275'), tl.hexcol('#dcc6a2')
    pick = sr[..., 3:4]
    col = np.where(pick < 0.45, sc1, np.where(pick < 0.8, sc2, sc3))
    col = col * (1 + (sr[..., 0:1] - 0.5) * 0.08)
    col = col * (1 + tl.spectral(n, 4, 80, 1.1, 119)[..., None] * 0.05) * (1 + np.maximum(wear, 0)[..., None] * 0.04)
    edgeDark = 1 - (1 - tl.smoothstep(0.0, 0.05, dedge)) * 0.12
    col = col * edgeDark[..., None] * (1 - crk[..., None] * 0.4)
    joint = speckle(n, 120, np.broadcast_to(tl.hexcol('#c99a64'), (n, n, 3)).copy(), [tl.hexcol('#4a3022')], [0.02])
    # wind-blown sand dusting the slabs, thicker near the joints; a few dark stains
    dust = np.clip(tl.smoothstep(0.2, 1.6, tl.spectral(n, 2, 20, 1.5, 121)) + (1 - tl.smoothstep(0.0, 0.08, dedge)) * 0.5, 0, 0.85)
    col = col * (1 - dust[..., None] * 0.55) + tl.hexcol('#d1a46e') * dust[..., None] * 0.55
    stain = tl.smoothstep(1.5, 2.6, tl.spectral(n, 3, 24, 1.4, 122))
    col = col * (1 - stain[..., None] * 0.35)
    alb = col * slab[..., None] + joint * (1 - slab[..., None])
    rough = (0.7 - np.maximum(wear, 0) * 0.05 + dust * 0.15 - stain * 0.1) * slab + 0.9 * (1 - slab)
    return dict(T=T, H=H, albedo=alb, rough=rough, ao=0.05)


def cliff(n):
    """Layered sandstone face for triplanar use: v is up, strata run along u."""
    T = 12.0
    U, V = tl.uv(n)
    rng = np.random.default_rng(131)
    # beds of varying thickness and hardness (hard beds stand out, soft beds recess)
    k = 14
    th = rng.random(k) ** 1.6 + 0.25
    edges = np.concatenate([[0], np.cumsum(th / th.sum())])
    hard = rng.random(k)
    wv = V + tl.spectral(n, 1, 4, 2.0, 132) * 0.004
    bed = np.clip(np.searchsorted(edges, wv % 1.0, side='right') - 1, 0, k - 1)
    e0, e1 = edges[bed], edges[bed + 1]
    pos = (wv % 1.0 - e0) / (e1 - e0)                                          # 0..1 inside the bed
    hb = hard[bed]
    # soft beds weather to a concave notch, hard beds keep square, slightly rounded lips
    notch = np.sin(np.clip(pos, 0, 1) * math.pi) ** (0.6 + hb)
    H = hb * 0.12 - (1 - hb) * notch * 0.09
    H += -tl.smoothstep(0.0, 0.06, -(pos - 0.06)) * 0.02 - tl.smoothstep(0.94, 1.0, pos) * 0.02
    # cross-bedding laminae inside the beds
    lam = (U * 2 + V * 9) + hb * 7 + tl.spectral(n, 1, 6, 1.8, 133) * 0.4
    lamf = lam - np.floor(lam * 6) / 6
    H += (np.abs((lam * 6) % 1.0 - 0.5) - 0.25) * 0.004
    # vertical joints that cut some beds
    joint = np.zeros_like(U)
    jr = np.random.default_rng(134)
    for j in range(9):
        u0, vs, ln, wd = jr.random(), jr.random(), 0.15 + 0.45 * jr.random(), 0.01 + 0.02 * jr.random()
        wob = tl.spectral(n, 1, 10, 1.6, 300 + j) * 0.003
        du = ((U - u0 - wob + 0.5) % 1.0 - 0.5) * T
        vv = (V - vs) % 1.0
        inside = tl.smoothstep(0.0, 0.04, vv) * tl.smoothstep(ln, ln - 0.04, vv)
        joint = np.maximum(joint, (1 - tl.smoothstep(wd * 0.3, wd, np.abs(du))) * inside)
    H -= joint * 0.06
    # honeycomb (tafoni) pits in the soft beds
    vp = tl.voronoi(n, 70, 137, 1.0)
    pit = (1 - tl.smoothstep(0.0, 0.5, vp['f1'])) * (1 - hb) * tl.smoothstep(0.2, 1.1, tl.spectral(n, 2, 10, 1.6, 138))
    H -= pit * 0.03
    H += tl.spectral(n, 4, 40, 1.6, 139) * 0.01 + tl.spectral(n, 40, 400, 1.0, 140) * 0.0015
    tone = rng.random(k)
    c_light, c_mid, c_dark, c_cream = tl.hexcol('#d39a68'), tl.hexcol('#bf7e4f'), tl.hexcol('#9a5a38'), tl.hexcol('#e2c39a')
    t = tone[bed][..., None]
    col = np.where(t < 0.3, c_mid, np.where(t < 0.55, c_light, np.where(t < 0.8, c_cream, c_dark)))
    col = col * 0.5 + c_light * 0.5
    # desert varnish: dark streaks running down from some ledges
    streak = np.zeros_like(U)
    sr_ = np.random.default_rng(142)
    for j in range(14):
        u0, vt, ln, wd = sr_.random(), sr_.random(), 0.05 + 0.3 * sr_.random(), 0.006 + 0.04 * sr_.random()
        wob = tl.spectral(n, 1, 6, 1.6, 400 + j) * 0.004
        du = np.abs((U - u0 - wob + 0.5) % 1.0 - 0.5)
        below = (vt - V) % 1.0
        fade = tl.smoothstep(ln, 0.0, below) * (below < ln)
        streak = np.maximum(streak, (1 - tl.smoothstep(wd * 0.4, wd, du)) * fade * (0.5 + 0.5 * sr_.random()))
    col = col * (1 - streak[..., None] * 0.45) + tl.hexcol('#3e2a1e') * streak[..., None] * 0.12
    col = col * (1 + (np.abs((lam * 6) % 1.0 - 0.5) - 0.25)[..., None] * 0.12)
    col = col * (1 + tl.spectral(n, 3, 60, 1.2, 141)[..., None] * 0.05) * (1 - pit[..., None] * 0.2)
    col = col * (1 - joint[..., None] * 0.25)
    rough = 0.86 + (1 - hb) * 0.06 - streak * 0.18
    return dict(T=T, H=H, albedo=col, rough=rough, ao=0.25)


def boulder(n):
    """Fractured rock skin for boulders: facets at two scales, chipped edges, varnish."""
    T = 6.0
    U, V = tl.uv(n)
    # fracture facets: each cell is a tilted plane, so neighbouring cells meet in steps and ridges
    wu = tl.spectral(n, 2, 10, 1.6, 150) * n * 0.012
    wv = tl.spectral(n, 2, 10, 1.6, 149) * n * 0.012

    def facets(cells, seed, slope, lift):
        vo = tl.voronoi(n, cells, seed, 1.0)
        cr = tl.cell_rand(vo, seed + 1, 3)
        f = ((cr[..., 0] - 0.5) * slope * (U - vo['cx'] / cells) * T + (cr[..., 1] - 0.5) * slope * (V - vo['cy'] / cells) * T
             + cr[..., 2] * lift)
        return tl.warp(f, wu, wv), tl.warp(cr[..., 2], wu, wv)

    f1, tone = facets(6, 151, 0.22, 0.06)
    f2, _ = facets(26, 153, 0.12, 0.012)
    H = tl.blur(f1, 2) + tl.blur(f2, 1)
    H += tl.spectral(n, 2, 20, 1.8, 155) * 0.015 + tl.spectral(n, 20, 300, 1.2, 156) * 0.0015
    pits = (1 - tl.smoothstep(0.0, 0.35, tl.voronoi(n, 110, 157, 1.0)['f1'])) * tl.smoothstep(0.4, 1.2, tl.spectral(n, 2, 10, 1.6, 158))
    H -= pits * 0.006
    # freshly broken faces are paler, old exposed faces carry dark varnish
    col = tl.hexcol('#b87a4d') * (1 - tone[..., None] * 0.3) + tl.hexcol('#d5a777') * tone[..., None] * 0.3
    col = col * (1 + tl.spectral(n, 3, 80, 1.1, 159)[..., None] * 0.06) * (1 + tl.spectral(n, 60, 500, 0.8, 161)[..., None] * 0.04)
    varn = (tl.smoothstep(0.5, 1.4, tl.spectral(n, 2, 16, 1.5, 160)) * (1 - tone))[..., None]
    col = col * (1 - varn * 0.45) + tl.hexcol('#4a3326') * varn * 0.18
    rough = 0.8 - varn[..., 0] * 0.18
    return dict(T=T, H=H, albedo=col, rough=rough, ao=0.15)


# ---------------------------------------------------------------------------------- arena

def ashlar(n):
    """Dressed sandstone blocks in running courses (arena walls and towers). v is up."""
    T = 4.0
    U, V = tl.uv(n)
    rng = np.random.default_rng(171)
    rows = 8                                                   # 0.5 m courses
    row = np.minimum((V * rows).astype(int), rows - 1)
    rv = V * rows - row
    bid = np.zeros_like(row)
    du = np.zeros_like(U)
    off = 0
    for r in range(rows):
        k = int(rng.integers(3, 5))
        w = rng.random(k) * 0.8 + 0.6
        e = np.concatenate([[0], np.cumsum(w / w.sum())]) + rng.random()
        e = e - np.floor(e[0])
        m = row == r
        uu = (U[m] - e[0]) % 1.0 + e[0]
        j = np.clip(np.searchsorted(e, uu, side='right') - 1, 0, k - 1)
        bid[m] = off + j
        du[m] = np.minimum(uu - e[j], e[j + 1] - uu)
        off += k
    dv = np.minimum(rv, 1 - rv) / rows
    dedge = np.minimum(du, dv) * T
    br = np.random.default_rng(172).random((off, 4)).astype(np.float32)[bid]
    chip = tl.spectral(n, 10, 120, 1.0, 173) * 0.005 - np.maximum(tl.spectral(n, 12, 80, 1.2, 174), 0) * 0.008
    block = tl.smoothstep(0.006, 0.022, dedge + chip)
    face = 0.02 + (br[..., 0] - 0.5) * 0.008 + tl.spectral(n, 30, 300, 1.0, 175) * 0.0012     # chisel marks
    face -= (1 - tl.smoothstep(0.0, 0.05, dedge)) * 0.006                                      # worn arrises
    H = face * block + (0.006 + grain(n, 176)) * (1 - block)
    tone = br[..., 1:2]
    col = tl.hexcol('#d9bd93') * (1 - tone * 0.2) + tl.hexcol('#c69a6c') * tone * 0.2
    col = col * (1 + (br[..., 2:3] - 0.5) * 0.1) * (1 + tl.spectral(n, 6, 120, 1.1, 177)[..., None] * 0.04)
    streak = tl.smoothstep(0.6, 1.5, tl.spectral(n, 3, 30, 1.4, 178, ax=1.0, ay=0.15))[..., None]   # rain stains run down
    col = col * (1 - streak * 0.18)
    mortar = tl.hexcol('#bfa27f') * (1 + tl.spectral(n, 40, 300, 0.8, 179)[..., None] * 0.08)
    alb = col * block[..., None] + mortar * (1 - block[..., None])
    rough = 0.78 * block + 0.92 * (1 - block)
    return dict(T=T, H=H, albedo=alb, rough=rough, ao=0.04)


def plaster(n):
    """Lime-washed adobe render with cracks, fallen patches showing the mud bricks behind."""
    T = 4.0
    U, V = tl.uv(n)
    H = tl.spectral(n, 2, 20, 1.8, 181) * 0.003 + tl.spectral(n, 20, 200, 1.2, 182) * 0.0008
    vor = tl.voronoi(n, 7, 183, 0.9)
    crack = (1 - tl.smoothstep(0.0, 0.003, vor['edge'] * T / 7)) * tl.smoothstep(0.2, 1.0, tl.spectral(n, 2, 8, 1.6, 184))
    H -= crack * 0.003
    # where the render has fallen off: mud bricks (0.36 x 0.12 m, staggered)
    lost = tl.smoothstep(1.9, 2.3, tl.spectral(n, 1, 4, 2.0, 185))
    by = V * T / 0.12
    bx = U * T / 0.36 + 0.5 * (np.floor(by) % 2)
    joint = np.maximum(1 - tl.smoothstep(0.0, 0.08, np.abs(by - np.round(by))), 1 - tl.smoothstep(0.0, 0.03, np.abs(bx - np.round(bx))))
    brick = -0.012 - joint * 0.006 + tl.spectral(n, 30, 200, 1.0, 186) * 0.001
    H = H * (1 - lost) + brick * lost
    base = tl.hexcol('#e2c9a2') * (1 + tl.spectral(n, 3, 60, 1.3, 187)[..., None] * 0.04)
    stain = tl.smoothstep(0.4, 1.4, tl.spectral(n, 2, 24, 1.4, 188, ax=1.0, ay=0.2))[..., None]
    base = base * (1 - stain * 0.15) * (1 - crack[..., None] * 0.3)
    mud = tl.hexcol('#a87a52') * (1 - joint[..., None] * 0.25) * (1 + tl.spectral(n, 20, 150, 1, 189)[..., None] * 0.06)
    alb = base * (1 - lost[..., None]) + mud * lost[..., None]
    rough = 0.86 + lost * 0.06
    return dict(T=T, H=H, albedo=alb, rough=rough, ao=0.03)


def wood(n):
    """Weathered planks (benches, frames): planks run along u."""
    T = 2.0
    U, V = tl.uv(n)
    k = 11                                                     # ~18 cm planks
    pv = V * k
    pid = np.floor(pv).astype(int) % k
    pr = np.random.default_rng(191).random((k, 3)).astype(np.float32)[pid]
    gap = 1 - tl.smoothstep(0.0, 0.06, np.minimum(pv - np.floor(pv), np.ceil(pv) - pv))
    grain_ = tl.spectral(n, 2, 200, 1.1, 192, ax=0.05, ay=1.0)
    H = grain_ * 0.0008 + (pr[..., 0] - 0.5) * 0.002 - gap * 0.008
    # nail heads at plank ends
    xs, ys, rs = [], [], []
    for p in range(k):
        for u0 in (0.03, 0.53):
            xs += [(u0 + pr[0, 0, 0] * 0) * T]; ys += [(p + 0.3) / k * T]; rs += [0.006]
            xs += [u0 * T]; ys += [(p + 0.7) / k * T]; rs += [0.006]
    stone, ids = tl.stamp_bumps(H, T, np.array(xs), np.array(ys), np.array(rs), np.full(len(xs), 0.002), embed=0.0)
    col = tl.hexcol('#8f7356') * (1 - pr[..., 1:2] * 0.25) + tl.hexcol('#a99a86') * pr[..., 1:2] * 0.25
    col = col * (1 + grain_[..., None] * 0.07) * (1 - gap[..., None] * 0.6)
    col = col * (1 - stone[..., None]) + tl.hexcol('#3a2f28') * stone[..., None]
    rough = 0.82 - stone * 0.3
    return dict(T=T, H=H, albedo=col, rough=rough, ao=0.02)


def cloth(n):
    """Awning canvas: stripes along u, coarse weave, a few wrinkles and stains."""
    T = 2.0
    U, V = tl.uv(n)
    stripe = (np.floor(U * 8) % 2).astype(np.float32)
    weave = (np.sin(U * n * 0.7) * np.sin(V * n * 0.7)) * 0.00015
    wr = tl.spectral(n, 1, 8, 2.0, 195, ax=1.0, ay=0.3) * 0.002
    H = weave + wr
    c1, c2 = tl.hexcol('#ece0c8'), tl.hexcol('#b4512e')
    col = c1 * (1 - stripe[..., None]) + c2 * stripe[..., None]
    col = col * (1 + tl.spectral(n, 4, 100, 1.2, 196)[..., None] * 0.05)
    dirt = tl.smoothstep(0.5, 1.6, tl.spectral(n, 2, 16, 1.5, 197))[..., None]
    col = col * (1 - dirt * 0.2)
    rough = 0.92 + 0 * H
    return dict(T=T, H=H, albedo=col, rough=rough, ao=0.02)


def metal(n):
    """Riveted panels, chipped paint over rust (gantry, frames, lamp housings)."""
    T = 2.0
    U, V = tl.uv(n)
    pu, pv = U * 2, V * 3
    seam = np.maximum(1 - tl.smoothstep(0.0, 0.01, np.abs(pu - np.round(pu)) / 2), 1 - tl.smoothstep(0.0, 0.01, np.abs(pv - np.round(pv)) / 3))
    H = -seam * 0.003 + tl.spectral(n, 4, 60, 1.6, 201) * 0.0005
    xs, ys = [], []
    for i in range(2):
        for j in range(3):
            for t in np.linspace(0.05, 0.95, 8):
                xs += [(i + t) / 2 * T, (i + 0.04) / 2 * T]; ys += [(j + 0.04) / 3 * T, (j + t) / 3 * T]
    rv, ids = tl.stamp_bumps(H, T, np.array(xs), np.array(ys), np.full(len(xs), 0.008), np.full(len(xs), 0.004), embed=0.0)
    chip = tl.smoothstep(1.5, 2.1, tl.spectral(n, 6, 60, 1.3, 202) + seam * 1.8 + tl.spectral(n, 1, 5, 2.0, 206) * 0.6)
    paint = tl.hexcol('#556157') * (1 + tl.spectral(n, 3, 50, 1.2, 203)[..., None] * 0.06)
    rust = tl.hexcol('#7c4a2b') * (1 + tl.spectral(n, 20, 200, 1, 204)[..., None] * 0.15)
    runs = tl.smoothstep(0.5, 1.4, tl.spectral(n, 4, 40, 1.4, 205, ax=1.0, ay=0.1))[..., None]
    col = paint * (1 - chip[..., None]) + rust * chip[..., None]
    col = col * (1 - runs * 0.3) + rust * runs * 0.25
    H -= chip * 0.0004
    rough = 0.55 + chip * 0.3
    return dict(T=T, H=H, albedo=col, rough=rough, ao=0.01)


ARENA = ['ashlar', 'plaster', 'wood', 'cloth', 'metal']

RECIPES = {
    'sand_ripple': sand_ripple, 'sand_soft': sand_soft, 'gravel': gravel, 'hardpan': hardpan,
    'packed': packed, 'slickrock': lambda n: _slickrock_colour(slickrock(n), n), 'paving': paving,
    'cliff': cliff, 'boulder': boulder,
    'ashlar': ashlar, 'plaster': plaster, 'wood': wood, 'cloth': cloth, 'metal': metal,
}


# ======================================================================================
#  Blender: displaced mesh + stones -> bake onto a plane
# ======================================================================================

def setup():
    scn = bpy.context.scene
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    scn.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'OPTIX'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == 'OPTIX'
        scn.cycles.device = 'GPU'
    except Exception as e:  # noqa: BLE001
        print('GPU unavailable, baking on CPU:', e)
    if scn.world is None:
        scn.world = bpy.data.worlds.new('World')
    scn.cycles.use_denoising = False


def float_image(name, arr):
    """arr: (h, w, 4) or (h, w) float -> Blender float image (linear, rows bottom-up = row 0 first)."""
    old = bpy.data.images.get(name)
    if old:
        bpy.data.images.remove(old)
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=True, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    if arr.ndim == 2:
        arr = np.stack([arr, arr, arr, np.ones_like(arr)], -1)
    elif arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones(arr.shape[:2] + (1,), np.float32)], -1)
    img.pixels.foreach_set(arr.astype(np.float32).ravel())
    img.pack()
    return img


def target_image(name, n):
    old = bpy.data.images.get(name)
    if old:
        bpy.data.images.remove(old)
    img = bpy.data.images.new(name, n, n, alpha=True, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    return img


def read(img):
    n_x, n_y = img.size
    a = np.empty(n_x * n_y * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(n_y, n_x, 4)


def mesh_from_arrays(name, co, faces_flat, loops_per_face, uvs=None, attrs=None):
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(co))
    me.vertices.foreach_set('co', co.astype(np.float32).ravel())
    nl = len(faces_flat)
    nf = nl // loops_per_face
    me.loops.add(nl)
    me.loops.foreach_set('vertex_index', faces_flat.astype(np.int32))
    me.polygons.add(nf)
    me.polygons.foreach_set('loop_start', np.arange(0, nl, loops_per_face, dtype=np.int32))
    try:
        me.polygons.foreach_set('loop_total', np.full(nf, loops_per_face, np.int32))
    except (AttributeError, TypeError, RuntimeError):
        pass
    if uvs is not None:
        uvl = me.uv_layers.new(name='UVMap')
        uvl.data.foreach_set('uv', uvs.astype(np.float32).ravel())
    for aname, (domain, data) in (attrs or {}).items():
        typ = 'FLOAT_COLOR' if data.ndim == 2 else 'FLOAT'
        at = me.attributes.new(aname, typ, domain)
        at.data.foreach_set('color' if typ == 'FLOAT_COLOR' else 'value', data.astype(np.float32).ravel())
    me.update(calc_edges=True)
    me.polygons.foreach_set('use_smooth', np.ones(nf, bool))
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def ground_mesh(H, T, margin):
    """Vertices on the pixel centres of the (wrapped) height map, `margin` pixels past each edge."""
    n = H.shape[0]
    px = T / n
    idx = np.arange(-margin, n + margin)
    X, Y = np.meshgrid((idx + 0.5) * px, (idx + 0.5) * px)
    Z = H[np.ix_(idx % n, idx % n)]
    m = len(idx)
    co = np.stack([X, Y, Z], -1).reshape(-1, 3)
    i = (np.arange(m - 1)[:, None] * m + np.arange(m - 1)[None, :]).ravel()
    quads = np.stack([i, i + 1, i + m + 1, i + m], -1)
    uvv = np.stack([X / T, Y / T], -1).reshape(-1, 2)
    uvs = uvv[quads.ravel()]
    return mesh_from_arrays('Ground', co, quads.ravel(), 4, uvs)


_ICO = {}


def ico(level):
    if level not in _ICO:
        import bmesh
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=level, radius=1.0)
        v = np.array([x.co[:] for x in bm.verts], np.float32)
        f = np.array([[l.vert.index for l in face.loops] for face in bm.faces], np.int32)
        bm.free()
        _ICO[level] = (v, f)
    return _ICO[level]


def stones_mesh(st, H, T, margin_m, level=3, subset=None, name='Stones'):
    """Flat, lumpy pebbles (one mesh), duplicated across the tile edges they overlap."""
    v0, f0 = ico(level)
    n = H.shape[0]
    px = T / n
    xs, ys, rs = st['x'], st['y'], st['r']
    # copies across edges
    items = []
    for k in (range(len(xs)) if subset is None else subset):
        for ox in (-T, 0, T):
            for oy in (-T, 0, T):
                x, y = xs[k] + ox, ys[k] + oy
                if -margin_m - rs[k] <= x <= T + margin_m + rs[k] and -margin_m - rs[k] <= y <= T + margin_m + rs[k]:
                    items.append((k, x, y))
    P = len(items)
    V = len(v0)
    co = np.empty((P, V, 3), np.float32)
    col = np.empty((P, V, 4), np.float32)
    rough = np.empty((P, V), np.float32)
    for j, (k, x, y) in enumerate(items):
        rng = np.random.default_rng(int(st['seed'][k]))
        a, ang, flat = st['aspect'][k], st['angle'][k], st['flat'][k]
        p = v0.copy()
        # lumpy, slightly faceted pebble
        d = np.ones(V, np.float32)
        for _ in range(4):
            dirn = rng.standard_normal(3)
            dirn /= np.linalg.norm(dirn)
            d += np.maximum(p @ dirn - 0.55, 0) * -(0.3 + 0.4 * rng.random())
        d += np.sin(p @ rng.standard_normal(3) * 3 + rng.random() * 6) * 0.05
        p *= d[:, None]
        p[:, 0] *= a
        p[:, 1] /= a
        p[:, 2] *= flat
        p[:, 2] = np.where(p[:, 2] > 0, p[:, 2] * 1.0, p[:, 2] * 0.6)
        ca, sa = math.cos(ang), math.sin(ang)
        p[:, :2] = p[:, :2] @ np.array([[ca, sa], [-sa, ca]], np.float32)
        tx, ty = st['tilt'][k]
        p[:, 2] += p[:, 0] * tx + p[:, 1] * ty
        p *= rs[k]
        ix, iy = int(x / px) % n, int(y / px) % n
        z0 = H[iy, ix] - st['embed'][k] * flat * rs[k] + flat * rs[k] * 0.5
        co[j] = p + np.array([x, y, z0], np.float32)
        c = st['col'][k]
        shade = 1 + (p[:, 2] / (rs[k] * flat + 1e-6)) * 0.08
        col[j, :, :3] = np.clip(c[None, :] * shade[:, None], 0, 1)
        col[j, :, 3] = 1
        rough[j] = st['rough'][k]
    faces = (f0[None, :, :] + (np.arange(P) * V)[:, None, None]).reshape(-1)
    return mesh_from_arrays(name, co.reshape(-1, 3), faces, 3, attrs={
        'Col': ('POINT', col.reshape(-1, 4)), 'Rough': ('POINT', rough.reshape(-1))})


def material_ground(alb_img, rough_img):
    m = bpy.data.materials.new('GroundMat')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(nd for nd in nt.nodes if nd.type == 'BSDF_PRINCIPLED')
    ta = nt.nodes.new('ShaderNodeTexImage')
    ta.image = alb_img
    ta.interpolation = 'Linear'
    tr = nt.nodes.new('ShaderNodeTexImage')
    tr.image = rough_img
    nt.links.new(ta.outputs['Color'], bsdf.inputs['Base Color'])
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(tr.outputs['Color'], sep.inputs[0])
    nt.links.new(sep.outputs[0], bsdf.inputs['Roughness'])
    return m


def material_stones():
    m = bpy.data.materials.new('StoneMat')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(nd for nd in nt.nodes if nd.type == 'BSDF_PRINCIPLED')
    ac = nt.nodes.new('ShaderNodeAttribute')
    ac.attribute_name = 'Col'
    ar = nt.nodes.new('ShaderNodeAttribute')
    ar.attribute_name = 'Rough'
    nt.links.new(ac.outputs['Color'], bsdf.inputs['Base Color'])
    nt.links.new(ar.outputs['Fac'], bsdf.inputs['Roughness'])
    return m


def material_height(zmin, zmax):
    m = bpy.data.materials.new('HeightMat')
    m.use_nodes = True
    nt = m.node_tree
    for nd in list(nt.nodes):
        if nd.type != 'OUTPUT_MATERIAL':
            nt.nodes.remove(nd)
    out = next(nd for nd in nt.nodes if nd.type == 'OUTPUT_MATERIAL')
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = zmin
    mr.inputs['From Max'].default_value = zmax
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(geo.outputs['Position'], sep.inputs[0])
    nt.links.new(sep.outputs['Z'], mr.inputs['Value'])
    nt.links.new(mr.outputs['Result'], em.inputs['Color'])
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    return m


def bake_plane(T, z):
    co = np.array([[0, 0, z], [T, 0, z], [T, T, z], [0, T, z]], np.float32)
    ob = mesh_from_arrays('BakePlane', co, np.array([0, 1, 2, 3]), 4, np.array([[0, 0], [1, 0], [1, 1], [0, 1]], np.float32))
    m = bpy.data.materials.new('BakeTarget')
    m.use_nodes = True
    node = m.node_tree.nodes.new('ShaderNodeTexImage')
    m.node_tree.nodes.active = node
    ob.data.materials.append(m)
    for attr in ('visible_camera', 'visible_diffuse', 'visible_glossy', 'visible_transmission', 'visible_shadow'):
        if hasattr(ob, attr):
            setattr(ob, attr, False)
    return ob, node


def bake_material(name, n, samples):
    t0 = time.time()
    d = RECIPES[name](n)
    T, H = d['T'], d['H'].astype(np.float32)
    print(f'[{name}] recipe {time.time() - t0:.1f}s  relief {H.min() * 1000:.1f}..{H.max() * 1000:.1f} mm')
    setup()
    scn = bpy.context.scene
    margin = max(8, n // 24)
    alb = float_image(name + '_alb', np.clip(d['albedo'], 0, 1))
    rgh = float_image(name + '_rgh', np.clip(d['rough'], 0, 1))
    ground = ground_mesh(H, T, margin)
    ground.data.materials.append(material_ground(alb, rgh))
    highs = [ground]
    if d.get('stones'):
        S = d['stones']
        big = np.nonzero(S['r'] >= 0.018)[0]
        small = np.nonzero(S['r'] < 0.018)[0]
        sm = material_stones()
        for lvl, sub, nm in ((3, big, 'StonesBig'), (2, small, 'StonesSmall')):
            if len(sub):
                st = stones_mesh(S, H, T, margin * T / n, lvl, sub, nm)
                st.data.materials.append(sm)
                highs.append(st)
    zmin = min(float(o.bound_box[0][2]) for o in highs)
    zmax = max(max(v[2] for v in o.bound_box) for o in highs)
    plane, node = bake_plane(T, zmin - 0.002)
    ext = (zmax - zmin) + 0.01
    scn.render.bake.use_selected_to_active = True
    scn.render.bake.cage_extrusion = ext
    scn.render.bake.max_ray_distance = ext + 0.01
    scn.render.bake.margin = 0
    scn.world.light_settings.distance = d['ao']
    bpy.ops.object.select_all(action='DESELECT')
    for o in highs:
        o.select_set(True)
    plane.select_set(True)
    bpy.context.view_layer.objects.active = plane

    out = {}

    def run(kind, typ, spp, **kw):
        img = target_image(f'{name}_{kind}', n)
        node.image = img
        scn.cycles.samples = spp
        t = time.time()
        bpy.ops.object.bake(type=typ, use_selected_to_active=True, cage_extrusion=ext, max_ray_distance=ext + 0.01,
                            margin=0, use_clear=True, **kw)
        out[kind] = read(img)
        print(f'[{name}]   {kind} {time.time() - t:.1f}s')

    run('albedo', 'DIFFUSE', 4, pass_filter={'COLOR'})
    run('rough', 'ROUGHNESS', 4)
    run('normal', 'NORMAL', 8, normal_space='TANGENT')
    run('ao', 'AO', samples)
    hm = material_height(zmin, zmax)
    saved = {o.name: list(o.data.materials) for o in highs}
    for o in highs:
        o.data.materials.clear()
        o.data.materials.append(hm)
    run('height', 'EMIT', 1)
    for o in highs:
        o.data.materials.clear()
        for m in saved[o.name]:
            o.data.materials.append(m)
    return pack(name, out, T, zmax - zmin)


def save_png(arr, path):
    """arr: (h, w, 4) floats already in the file's encoding (0..1), row 0 = bottom."""
    h, w = arr.shape[:2]
    img = bpy.data.images.new('save_tmp', w, h, alpha=True, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    img.pixels.foreach_set(np.clip(arr, 0, 1).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def downsample(a):
    return (a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2]) * 0.25


def smooth3(a, passes=1):
    """Periodic [1 2 1] blur: takes the bake noise out of occlusion/roughness (it only costs bits)."""
    k = (0.25, 0.5, 0.25)
    for _ in range(passes):
        for ax in (0, 1):
            a = k[0] * np.roll(a, -1, ax) + k[1] * a + k[2] * np.roll(a, 1, ax)
    return a


def write_game_maps(name, c, nn):
    """2K masters -> the 1K maps the game loads (the camera never resolves more on the ground)."""
    nn = nn.copy()
    nn[..., 2] = smooth3(nn[..., 2], 1)
    nn[..., 3] = smooth3(nn[..., 3], 2)
    save_png(downsample(c), os.path.join(BUILD, f'{name}_c.png'))
    save_png(downsample(nn), os.path.join(BUILD, f'{name}_n.png'))


def pack(name, o, T, relief):
    alb = o['albedo'][..., :3]
    h = o['height'][..., 0]
    nrm = o['normal'][..., :2]
    rough = o['rough'][..., 0]
    ao = o['ao'][..., 0]
    c = np.concatenate([tl.linear_to_srgb(alb), h[..., None]], -1)
    nn = np.concatenate([nrm, rough[..., None], ao[..., None]], -1)
    os.makedirs(BUILD, exist_ok=True)
    save_png(c, os.path.join(BUILD, f'{name}_c_2k.png'))
    save_png(nn, os.path.join(BUILD, f'{name}_n_2k.png'))
    write_game_maps(name, c, nn)
    # lit preview (sun from the upper left, low) for a quick look
    nx, ny = nrm[..., 0] * 2 - 1, nrm[..., 1] * 2 - 1
    nz = np.sqrt(np.clip(1 - nx * nx - ny * ny, 0, 1))
    L = np.array([-0.55, 0.45, 0.7])
    L /= np.linalg.norm(L)
    lit = np.clip(nx * L[0] + ny * L[1] + nz * L[2], 0, 1)
    prev = alb * (0.25 * ao[..., None] + 0.9 * lit[..., None])
    p = downsample(np.concatenate([tl.linear_to_srgb(prev), np.ones_like(h)[..., None]], -1))
    save_png(p, os.path.join(BUILD, f'{name}_preview.png'))
    meta = {'tile_m': T, 'relief_m': float(relief), 'mean_albedo': tl.linear_to_srgb(alb.reshape(-1, 3).mean(0)).tolist()}
    print(f'[{name}] packed, relief {relief * 1000:.1f} mm')
    return meta


def load_png(path):
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = 'Non-Color'
    a = read(img)
    bpy.data.images.remove(img)
    return a


def repack(name):
    """Redo the game maps from the 2K masters in build/ without baking again."""
    c = load_png(os.path.join(BUILD, f'{name}_c_2k.png'))
    nn = load_png(os.path.join(BUILD, f'{name}_n_2k.png'))
    write_game_maps(name, c, nn)
    print(f'[{name}] repacked')


def encode():
    tool = shutil.which('toktx')
    if not tool:
        print('toktx not found (KTX-Software), KTX2 files not written')
        return
    os.makedirs(ASSETS, exist_ok=True)
    for group, names in (('ground', GROUND), ('rock', ROCK), ('arena', ARENA)):
        cs = [os.path.join(BUILD, f'{n}_c.png') for n in names]
        ns = [os.path.join(BUILD, f'{n}_n.png') for n in names]
        if not all(os.path.exists(p) for p in cs + ns):
            print('missing bakes for', group)
            continue
        common = [tool, '--t2', '--genmipmap', '--lower_left_maps_to_s0t0', '--layers', str(len(names))]
        jobs = [
            common + ['--encode', 'etc1s', '--clevel', '4', '--qlevel', '255', '--assign_oetf', 'srgb',
                      os.path.join(ASSETS, f'{group}_c.ktx2')] + cs,
            common + ['--encode', 'uastc', '--uastc_quality', '2', '--uastc_rdo_l', '2', '--zcmp', '20',
                      '--assign_oetf', 'linear', os.path.join(ASSETS, f'{group}_n.ktx2')] + ns,
        ]
        for cmd in jobs:
            t = time.time()
            r = subprocess.run(cmd, capture_output=True, text=True)
            print(os.path.basename(cmd[-len(names) - 1]), f'{time.time() - t:.1f}s', r.returncode, r.stderr[-300:])


def main():
    opt = args()
    n = opt['size']
    names = [s for s in opt['only'].split(',') if s] or list(RECIPES)
    os.makedirs(BUILD, exist_ok=True)
    meta_path = os.path.join(BUILD, 'meta.json')
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    t0 = time.time()
    for name in names:
        if opt['repack']:
            repack(name)
            continue
        meta[name] = bake_material(name, n, opt['samples'])
        json.dump(meta, open(meta_path, 'w'), indent=1)
    if opt['encode']:
        encode()
    print(f'done in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
