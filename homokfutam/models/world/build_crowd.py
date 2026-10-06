"""Crowd sprite atlas for the arena stands (assets/crowd_atlas.png).

4 body types (columns) x 3 arm poses (rows: arms down, half raised, up), each cell 128 x 256 px,
the figure seen from the front, feet at the bottom of the cell; a cell is 1.1 m x 2.2 m.
Channels: R = shirt mask, G = skin mask, B = shading (soft key light + sky, ambient occlusion),
A = coverage. What is neither shirt nor skin is hair (head) or trousers (legs): the game tells
them apart by height and colours everything per spectator (world/dressing.js).

    blender -b --factory-startup --python homokfutam/models/world/build_crowd.py
"""
import math
import os
import tempfile

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'assets', 'crowd_atlas.png')
CW, CH = 128, 256                     # cell size in pixels (1.1 m x 2.2 m, see CELL_M)
CELL_M = 2.2
POSES = (0.15, 0.85, 2.6)             # shoulder angle in radians from hanging down: down, half, up
BODIES = [
    # height, shoulder half-width, hip half-width, head radius, hair: 'cap' | 'long' | 'hat' | 'bald'
    (1.74, 0.21, 0.15, 0.112, 'cap'),
    (1.80, 0.25, 0.18, 0.118, 'hat'),
    (1.62, 0.18, 0.16, 0.108, 'long'),
    (1.70, 0.23, 0.17, 0.115, 'bald'),
]


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 64
    sc.cycles.use_denoising = False
    sc.render.film_transparent = True
    sc.render.resolution_x, sc.render.resolution_y = CW, CH
    sc.render.resolution_percentage = 100
    sc.view_settings.view_transform = 'Standard'
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    if sc.world is None:
        sc.world = bpy.data.worlds.new('World')
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = CELL_M
    cam.location = (0, -6, CELL_M / 2)
    cam.rotation_euler = (math.pi / 2, 0, 0)
    sc.collection.objects.link(cam)
    sc.camera = cam
    return sc


def material(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    return m


def set_mode(mats, masks):
    """masks: flat emission R/G/B per part; else a white diffuse surface for the shading pass."""
    colors = {'shirt': (1, 0, 0), 'skin': (0, 1, 0), 'other': (0, 0, 1)}
    for part, m in mats.items():
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        if masks:
            em = nt.nodes.new('ShaderNodeEmission')
            em.inputs['Color'].default_value = (*colors[part], 1)
            nt.links.new(em.outputs[0], out.inputs['Surface'])
        else:
            bs = nt.nodes.new('ShaderNodeBsdfPrincipled')
            bs.inputs['Base Color'].default_value = (0.8, 0.8, 0.8, 1)
            bs.inputs['Roughness'].default_value = 0.85
            nt.links.new(bs.outputs[0], out.inputs['Surface'])


def capsule(name, a, b, r, mat):
    """a cylinder with round ends from point a to point b"""
    a, b = np.array(a, float), np.array(b, float)
    d = b - a
    L = float(np.linalg.norm(d))
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=r, depth=L, location=tuple((a + b) / 2))
    ob = bpy.context.object
    ob.name = name
    z = np.array([0, 0, 1.0])
    axis = np.cross(z, d / L)
    if np.linalg.norm(axis) > 1e-6:
        ob.rotation_mode = 'AXIS_ANGLE'
        ob.rotation_axis_angle = (math.acos(np.clip(np.dot(z, d / L), -1, 1)), *(axis / np.linalg.norm(axis)))
    ob.data.materials.append(mat)
    for p in (a, b):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=r, location=tuple(p))
        bpy.context.object.data.materials.append(mat)
    return ob


def person(body, pose, mats):
    H, sh, hip, hr, hair = body
    k = H / 1.74
    knee, waist, chest, neck = 0.48 * k, 0.95 * k, 1.28 * k, 1.47 * k
    # legs (trousers) and feet
    for s in (-1, 1):
        capsule('leg', (s * hip * 0.55, 0, 0.06), (s * hip * 0.6, 0, knee), 0.07 * k, mats['other'])
        capsule('thigh', (s * hip * 0.6, 0, knee), (s * hip * 0.65, 0, waist), 0.085 * k, mats['other'])
    # torso: a squashed tapered cylinder, shirt
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=hip * 1.05, radius2=sh * 0.92, depth=neck - waist - 0.03 * k,
                                    location=(0, 0, (waist + neck) / 2))
    t = bpy.context.object
    t.scale = (1, 0.62, 1)
    t.data.materials.append(mats['shirt'])
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=sh * 0.95, location=(0, 0, chest + 0.1 * k))
    s = bpy.context.object
    s.scale = (1, 0.6, 0.45)
    s.data.materials.append(mats['shirt'])
    # neck and head
    capsule('neck', (0, 0, neck - 0.02), (0, 0, neck + 0.08 * k), 0.05 * k, mats['skin'])
    hz = neck + 0.08 * k + hr * 0.95
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=hr, location=(0, 0, hz))
    h = bpy.context.object
    h.scale = (0.9, 1, 1.08)
    h.data.materials.append(mats['skin'])
    if hair in ('cap', 'long'):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=hr * 1.07, location=(0, 0.01, hz + hr * 0.18))
        c = bpy.context.object
        c.scale = (0.95, 1, 0.82 if hair == 'cap' else 1.25)
        c.data.materials.append(mats['other'])
    if hair == 'hat':
        bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=hr * 1.9, depth=0.02, location=(0, 0, hz + hr * 0.55))
        bpy.context.object.data.materials.append(mats['other'])
        bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=hr * 1.0, depth=hr * 0.9, location=(0, 0, hz + hr * 0.95))
        bpy.context.object.data.materials.append(mats['other'])
    # arms: upper arm in the sleeve (shirt), forearm and hand bare (skin)
    for side in (-1, 1):
        a = pose + (0.25 if pose > 2 else 0)
        sx, sz = side * sh * 1.02, neck - 0.07 * k
        dx, dz = side * math.sin(a), -math.cos(a)
        up, fore = 0.3 * k, 0.28 * k
        elbow = (sx + dx * up, 0, sz + dz * up)
        fa = a + (0.35 if pose > 0.5 else 0.05)                      # raised arms bend a little at the elbow
        ex, ez = side * math.sin(fa), -math.cos(fa)
        hand = (elbow[0] + ex * fore, 0, elbow[2] + ez * fore)
        capsule('upper', (sx, 0, sz), elbow, 0.055 * k, mats['shirt'])
        capsule('fore', elbow, hand, 0.045 * k, mats['skin'])
        bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=0.055 * k,
                                             location=(hand[0] + ex * 0.04, 0, hand[2] + ez * 0.04))
        bpy.context.object.data.materials.append(mats['skin'])


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    a = np.array(img.pixels[:], dtype=np.float32).reshape(CH, CW, 4)     # bottom row first
    bpy.data.images.remove(img)
    return a


def lights(on):
    sc = bpy.context.scene
    for o in [o for o in sc.objects if o.type == 'LIGHT']:
        bpy.data.objects.remove(o, do_unlink=True)
    nt = sc.world.node_tree if sc.world.use_nodes else None
    sc.world.use_nodes = True
    bg = sc.world.node_tree.nodes.get('Background')
    bg.inputs['Strength'].default_value = 0.35 if on else 0.0
    bg.inputs['Color'].default_value = (1, 1, 1, 1)
    if on:
        key = bpy.data.objects.new('key', bpy.data.lights.new('key', 'SUN'))
        key.data.energy = 3.0
        key.data.angle = math.radians(25)
        key.rotation_euler = (math.radians(55), math.radians(-25), math.radians(-20))   # from the front, above, a little to the side
        sc.collection.objects.link(key)


def main():
    reset()
    mats = {p: material(p) for p in ('shirt', 'skin', 'other')}
    atlas = np.zeros((CH * len(POSES), CW * len(BODIES), 4), np.float32)
    tmp = tempfile.mkdtemp()
    for c, body in enumerate(BODIES):
        for r, pose in enumerate(POSES):
            for o in [o for o in bpy.context.scene.objects if o.type == 'MESH']:
                bpy.data.objects.remove(o, do_unlink=True)
            person(body, pose, mats)
            set_mode(mats, masks=False)
            lights(True)
            shade = render(os.path.join(tmp, f's{c}{r}.png'))
            set_mode(mats, masks=True)
            lights(False)
            mask = render(os.path.join(tmp, f'm{c}{r}.png'))
            cell = np.zeros((CH, CW, 4), np.float32)
            cov = mask[..., 3]
            cell[..., 0] = mask[..., 0] / np.maximum(cov, 1e-4) * (cov > 0)
            cell[..., 1] = mask[..., 1] / np.maximum(cov, 1e-4) * (cov > 0)
            lum = shade[..., :3].mean(-1) / np.maximum(shade[..., 3], 1e-4)
            ref = np.percentile(lum[cov > 0.5], 95) if (cov > 0.5).any() else 1.0     # the lit side of the figure ~ 1
            cell[..., 2] = np.clip(lum / max(ref, 1e-4), 0, 1) * (cov > 0)
            cell[..., 3] = cov
            y0 = (len(POSES) - 1 - r) * CH            # pose 0 on the top row of the image
            atlas[y0:y0 + CH, c * CW:(c + 1) * CW] = cell
    img = bpy.data.images.new('crowd_atlas', atlas.shape[1], atlas.shape[0], alpha=True)
    img.colorspace_settings.name = 'Non-Color'
    img.pixels = atlas.ravel()
    img.filepath_raw = os.path.abspath(OUT)
    img.file_format = 'PNG'
    img.save()
    print(f'wrote {os.path.abspath(OUT)}: {atlas.shape[1]}x{atlas.shape[0]}')


main()
