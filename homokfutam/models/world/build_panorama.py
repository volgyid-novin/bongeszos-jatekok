"""The far horizon for HOMOKFUTAM: desert ranges rendered in Blender as a 360-degree band.

  blender -b --factory-startup --python homokfutam/models/world/build_panorama.py -- [--samples 64]

A polar terrain from 6 km to 40 km out (ridged ranges, terraced plateaus, dune seas in the low
ground) is lit by a sun at the game's elevation and azimuth and rendered by an equirectangular
camera over elevations -3..+9 degrees with a transparent sky. The game puts the band on a ring
around the world and adds its own height fog.

Writes homokfutam/assets/world/panorama.ktx2 (8192 x 512) and panorama_4k.ktx2 (4096 x 256):
RGB colour, A coverage. Column 0 = game azimuth 0 (+x), increasing towards +z (atan2(z, x)).
"""
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
import rocklib as R  # noqa: E402

ASSETS = os.path.normpath(os.path.join(HERE, '..', '..', 'assets', 'world'))
BUILD = os.path.join(HERE, 'build')
SUN_EL, SUN_AZ = 0.36, -0.62           # gfx/atmosphere.js
LAT_MIN, LAT_MAX = -3.0, 9.0            # degrees


def args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opt = {'samples': 64}
    for i in range(0, len(argv) - 1, 2):
        opt[argv[i].lstrip('-')] = int(argv[i + 1])
    return opt


def terrain():
    nt, nr = 1024, 220
    r = 6000 * (40000 / 6000) ** np.linspace(0, 1, nr)            # denser near, sparser far
    th = np.linspace(0, 2 * math.pi, nt, endpoint=False)
    T, Rr = np.meshgrid(th, r)
    X, Y = Rr * np.cos(T), Rr * np.sin(T)
    P = np.stack([X, Y, np.zeros_like(X)], -1).reshape(-1, 3)
    ridge = R.ridged3(P / 5200.0, 5, 11)
    big = R.fbm3(P / 14000.0, 3, 12)
    rng_mask = R.smoothstep(0.35, 0.7, big)                       # where the ranges stand
    plateau = R.fbm3(P / 1500.0 + 50, 3, 13)
    h = rng_mask * (ridge ** 2.2) * 1500 * R.smoothstep(6500, 14000, Rr.ravel())
    # terraced mesas on the plateaus
    mesa = R.smoothstep(0.6, 0.66, plateau) * (160 + 220 * R.fbm3(P / 6000.0, 2, 15)) * (1 - rng_mask * 0.6)
    tz = mesa / 45.0
    mesa = (np.floor(tz) + R.smoothstep(0.75, 1.0, tz - np.floor(tz))) * 45.0
    h = np.maximum(h, mesa)
    h += R.fbm3(P / 900.0, 3, 14) * 70 - 35
    Z = h.reshape(nr, nt)
    verts = np.stack([X, Y, Z], -1).reshape(-1, 3)
    faces = []
    for j in range(nr - 1):
        for i in range(nt):
            a, b = j * nt + i, j * nt + (i + 1) % nt
            faces.append((a, b, b + nt, a + nt))
    ob = R.mesh_obj('ranges', verts, faces)
    R.shade(ob)
    return ob, h, rng_mask


def material(ob):
    """Sandstone ranges: banded reds and oranges, pale dune sand in the low ground, dark varnish on steep faces."""
    m = bpy.data.materials.new('ranges')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Roughness'].default_value = 0.95
    ca = nt.nodes.new('ShaderNodeVertexColor')
    ca.layer_name = 'Col'
    nt.links.new(ca.outputs['Color'], bsdf.inputs['Base Color'])
    ob.data.materials.append(m)
    c = R.co(ob)
    n = R.vnormals(ob)
    z = c[:, 2]
    steep = R.smoothstep(0.75, 0.45, n[:, 2])
    band = (np.sin(z / 38.0 * 2 * math.pi + R.fbm3(c / 4000.0, 2, 3) * 8) * 0.5 + 0.5)
    rock = R.srgb('#b56a42') * (1 - band[:, None] * 0.35) + R.srgb('#d79a64') * band[:, None] * 0.35
    rock = rock * (1 - steep[:, None] * 0.35)
    sand = R.srgb('#d8a873') * (1 + (R.fbm3(c / 2500.0, 2, 4) - 0.5) * 0.15)[:, None]
    low = R.smoothstep(60, 15, z) * R.smoothstep(0.85, 0.97, n[:, 2])
    col = rock * (1 - low[:, None]) + sand[None, :] * low[:, None] if sand.ndim == 1 else rock * (1 - low[:, None]) + sand * low[:, None]
    R.set_colors(ob, col, np.ones(len(c)))


def render(samples):
    scn = bpy.context.scene
    cam_d = bpy.data.cameras.new('pano')
    cam_d.type = 'PANO'
    # Blender 4+: panorama settings live on the camera data
    for k, v in (('panorama_type', 'EQUIRECTANGULAR'), ('latitude_min', math.radians(LAT_MIN)), ('latitude_max', math.radians(LAT_MAX)),
                 ('longitude_min', -math.pi), ('longitude_max', math.pi)):
        setattr(cam_d, k, v)
    cam_d.clip_end = 100000
    cam = R.link(bpy.data.objects.new('pano', cam_d))
    cam.location = (0, 0, 40)
    cam.rotation_euler = (math.radians(90), 0, math.radians(-90))     # looking along +X, Z up
    scn.camera = cam
    # sun from the game's direction (game x = Blender x, game z = -Blender y)
    sx, sz = math.cos(SUN_EL) * math.cos(SUN_AZ), math.cos(SUN_EL) * math.sin(SUN_AZ)
    sdir = np.array([sx, -sz, math.sin(SUN_EL)])
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 4.0
    sun.color = (1.0, 0.82, 0.62)
    sun.angle = math.radians(0.6)
    so = R.link(bpy.data.objects.new('sun', sun))
    so.rotation_euler = (0, 0, 0)
    from mathutils import Vector
    so.rotation_euler = Vector(-sdir).to_track_quat('-Z', 'Y').to_euler()
    world = scn.world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (0.55, 0.62, 0.78, 1)
    bg.inputs['Strength'].default_value = 0.55
    scn.render.film_transparent = True
    scn.cycles.samples = samples
    scn.cycles.use_denoising = True
    scn.render.resolution_x, scn.render.resolution_y = 8192, 512
    scn.view_settings.view_transform = 'Standard'
    scn.render.image_settings.file_format = 'PNG'
    scn.render.image_settings.color_mode = 'RGBA'
    out = os.path.join(BUILD, 'panorama.png')
    scn.render.filepath = out
    bpy.ops.render.render(write_still=True)
    return out


def encode(png):
    """Shift so column 0 is game azimuth 0, then KTX2 (ETC1S, with alpha) at 8k and 4k."""
    img = bpy.data.images.load(png)
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    a = a.reshape(h, w, 4)
    # equirect columns run from longitude -pi (left) to +pi; the camera looks along +X (game +x)
    # at the centre column. Longitude increases to the left in Blender (towards +Y = game -z), so
    # flip to make columns increase with game azimuth atan2(z, x) and roll the centre to 0.
    a = a[:, ::-1]
    a = np.roll(a, -w // 2, axis=1)
    os.makedirs(ASSETS, exist_ok=True)
    tool = shutil.which('toktx')
    for name, scale in (('panorama', 1), ('panorama_4k', 2)):
        b = a if scale == 1 else a.reshape(h // 2, 2, w // 2, 2, 4).mean((1, 3))
        o = bpy.data.images.new('o', b.shape[1], b.shape[0], alpha=True)
        o.pixels.foreach_set(b.ravel())
        p = os.path.join(BUILD, f'{name}_game.png')
        o.filepath_raw = p
        o.file_format = 'PNG'
        o.save()
        if tool:
            r = subprocess.run([tool, '--t2', '--encode', 'etc1s', '--clevel', '4', '--qlevel', '200', '--genmipmap',
                                '--lower_left_maps_to_s0t0', '--assign_oetf', 'srgb', os.path.join(ASSETS, f'{name}.ktx2'), p],
                               capture_output=True, text=True)
            print(name, r.returncode, r.stderr[-300:])


def main():
    opt = args()
    os.makedirs(BUILD, exist_ok=True)
    R.reset()
    t0 = time.time()
    ob, h, _ = terrain()
    material(ob)
    print(f'terrain {R.tris(ob)} tris, {time.time() - t0:.0f}s')
    png = render(opt['samples'])
    print(f'rendered in {time.time() - t0:.0f}s')
    encode(png)
    print(f'done in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
