"""Bake the procedural pod into one texture atlas and export the game model.

  blender -b --factory-startup --python bake_export.py -- [--size 2048] [--samples 16]

Output (homokfutam/assets/):
  pod_player.glb    meshes, pivots (extras = moving-part settings), materials PodAtlas / PodGlass / PodGlow;
                    meshopt-compressed with gltfpack when Node (npx) is available
  pod_livery.png    R = primary paint mask, G = accent mask; the game multiplies the base colour
                    by the livery colours through these
The baked .blend and raw bake images go to models/pod/build/ (not committed).
"""
import math
import os
import shutil
import subprocess
import sys
import time

import bmesh
import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_pod  # noqa: E402

ASSETS = os.path.normpath(os.path.join(HERE, '..', '..', 'assets'))
BUILD = os.path.join(HERE, 'build')
NO_BAKE = ('GLASS', 'GLOW')


def args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opt = {'size': 2048, 'samples': 16}
    for i in range(0, len(argv) - 1, 2):
        opt[argv[i].lstrip('-')] = int(argv[i + 1])
    return opt


def pod_objects():
    return list(bpy.data.collections[build_pod.COLL].objects)


def subtree(ob):
    out = [ob]
    for ch in ob.children:
        out += subtree(ch)
    return out


def apply_modifiers():
    """Apply modifiers and triangulate n-gons, so the baked tangent space matches the exported one."""
    dg = bpy.context.evaluated_depsgraph_get()
    for ob in pod_objects():
        if ob.type != 'MESH':
            continue
        if ob.modifiers:
            me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
            old = ob.data
            name = old.name
            ob.modifiers.clear()
            ob.data = me
            bpy.data.meshes.remove(old)
            me.name = name
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
        bm.to_mesh(ob.data)
        bm.free()


def uses_only(ob, names):
    idx = {build_pod.M[n] for n in names}
    mats = np.zeros(len(ob.data.polygons), np.int32)
    ob.data.polygons.foreach_get('material_index', mats)
    return len(mats) and set(mats.tolist()) <= idx


def select(objs, active=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]


def unwrap(objs):
    select(objs)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(rotate=True, margin=0.004)
    bpy.ops.object.mode_set(mode='OBJECT')


def new_image(name, size, color=True):
    old = bpy.data.images.get(name)
    if old:
        bpy.data.images.remove(old)
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    img.colorspace_settings.name = 'sRGB' if color else 'Non-Color'
    return img


class BakeRig:
    """Per material: an active image node to bake into, and an Emission node to show one channel."""

    def __init__(self):
        self.mats = [bpy.data.materials[n] for n in build_pod.MATS]
        self.nodes = {}
        for mat in self.mats:
            nt = mat.node_tree
            tex = nt.nodes.new('ShaderNodeTexImage')
            em = nt.nodes.new('ShaderNodeEmission')
            out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
            bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
            grp = next((n for n in nt.nodes if n.type == 'GROUP'), None)
            self.nodes[mat.name] = (nt, tex, em, out, bsdf, grp)

    def target(self, img):
        for nt, tex, *_ in self.nodes.values():
            tex.image = img
            nt.nodes.active = tex

    def show(self, channel):
        """channel = a PodSurface output name, or None for the normal BSDF."""
        for name, (nt, tex, em, out, bsdf, grp) in self.nodes.items():
            surf = out.inputs['Surface']
            for l in list(surf.links):
                nt.links.remove(l)
            for l in list(em.inputs['Color'].links):
                nt.links.remove(l)
            if channel is None or grp is None:
                nt.links.new(bsdf.outputs[0], surf)
            else:
                nt.links.new(grp.outputs[channel], em.inputs['Color'])
                nt.links.new(em.outputs[0], surf)


def bake(objs, typ, samples):
    scn = bpy.context.scene
    scn.cycles.samples = samples
    select(objs)
    t = time.time()
    kw = {'type': typ, 'margin': 8, 'use_clear': True}
    if typ == 'NORMAL':
        kw['normal_space'] = 'TANGENT'
    bpy.ops.object.bake(**kw)
    print(f'  baked {typ} in {time.time() - t:.1f}s')


def pixels(img):
    a = np.empty(img.size[0] * img.size[1] * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(-1, 4)


def save(img, path):
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()


def gltf_output_group():
    ng = bpy.data.node_groups.get('glTF Material Output')
    if ng is None:
        ng = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        ng.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
        ng.interface.new_socket('Thickness', in_out='INPUT', socket_type='NodeSocketFloat')
        ng.nodes.new('NodeGroupInput')
    return ng


def export_materials(img_color, img_orm, img_normal):
    atlas = bpy.data.materials.new('PodAtlas')
    atlas.use_backface_culling = True
    nt = atlas.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tc = nt.nodes.new('ShaderNodeTexImage')
    tc.image = img_color
    nt.links.new(tc.outputs['Color'], bsdf.inputs['Base Color'])
    to = nt.nodes.new('ShaderNodeTexImage')
    to.image = img_orm
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(to.outputs['Color'], sep.inputs[0])
    nt.links.new(sep.outputs[1], bsdf.inputs['Roughness'])
    nt.links.new(sep.outputs[2], bsdf.inputs['Metallic'])
    occ = nt.nodes.new('ShaderNodeGroup')
    occ.node_tree = gltf_output_group()
    nt.links.new(sep.outputs[0], occ.inputs['Occlusion'])
    tn = nt.nodes.new('ShaderNodeTexImage')
    tn.image = img_normal
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])

    glass = bpy.data.materials.new('PodGlass')
    b = next(n for n in glass.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (0.16, 0.13, 0.09, 1)
    b.inputs['Roughness'].default_value = 0.06
    b.inputs['Alpha'].default_value = 0.38
    try:
        glass.surface_render_method = 'BLENDED'
    except (AttributeError, TypeError):
        glass.blend_method = 'BLEND'

    glow = bpy.data.materials.new('PodGlow')
    glow.use_backface_culling = True
    b = next(n for n in glow.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (0, 0, 0, 1)
    b.inputs['Emission Color'].default_value = (1.0, 0.30, 0.06, 1)
    b.inputs['Emission Strength'].default_value = 1.0
    return atlas, glass, glow


def reassign(objs, atlas, glass, glow):
    """Collapse the 12 procedural slots into PodAtlas / PodGlass / PodGlow."""
    remap = np.array([1 if n == 'GLASS' else 2 if n == 'GLOW' else 0 for n in build_pod.MATS], np.int32)
    for ob in objs:
        if ob.type != 'MESH':
            continue
        me = ob.data
        idx = np.zeros(len(me.polygons), np.int32)
        me.polygons.foreach_get('material_index', idx)
        used = sorted(set(remap[idx].tolist()))
        compact = {u: i for i, u in enumerate(used)}
        me.polygons.foreach_set('material_index', np.array([compact[u] for u in remap[idx]], np.int32))
        me.materials.clear()
        for u in used:
            me.materials.append((atlas, glass, glow)[u])


def compress(src, dst):
    """Meshopt-compress the geometry with gltfpack (needs Node). Named nodes, materials and extras
    must survive: the game finds pivots and materials by name and reads the moving-part extras."""
    npx = shutil.which('npx')
    if npx:
        r = subprocess.run([npx, '-y', 'gltfpack@0.24', '-i', src, '-o', dst, '-cc', '-kn', '-km', '-ke'],
                           capture_output=True, text=True)
        if r.returncode == 0:
            return
        print('gltfpack failed, exporting uncompressed:', r.stderr[-500:])
    else:
        print('npx not found, exporting uncompressed')
    shutil.copyfile(src, dst)


def main():
    opt = args()
    size = opt['size']
    os.makedirs(BUILD, exist_ok=True)
    os.makedirs(ASSETS, exist_ok=True)
    t0 = time.time()

    scn = bpy.context.scene
    for ob in list(bpy.data.objects):
        if ob.name in ('Cube', 'Light', 'Camera'):
            bpy.data.objects.remove(ob, do_unlink=True)
    scn.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'OPTIX'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == 'OPTIX'
        scn.cycles.device = 'GPU'
    except Exception as e:
        print('GPU unavailable, baking on CPU:', e)
    if scn.world is None:
        scn.world = bpy.data.worlds.new('World')
    scn.world.light_settings.distance = 0.6

    build_pod.build()
    body = bpy.data.objects['Body']
    eng_l = bpy.data.objects['Engine_L']
    # the right engine is rebuilt after unwrapping so it inherits the left engine's UVs
    for ob in reversed(subtree(bpy.data.objects['Engine_R'])):
        data = ob.data
        bpy.data.objects.remove(ob, do_unlink=True)
        if data is not None and data.users == 0:
            bpy.data.meshes.remove(data)
    apply_modifiers()

    bake_objs = [o for o in pod_objects() if o.type == 'MESH' and not uses_only(o, NO_BAKE)]
    print('unwrapping', len(bake_objs), 'objects')
    unwrap(bake_objs)
    build_pod.mirror_engine(eng_l, body)

    rig = BakeRig()
    passes = [('color', 'Color', True), ('rough', 'Roughness', False), ('metal', 'Metallic', False),
              ('maskp', 'MaskPaint', False), ('maskt', 'MaskTrim', False)]
    imgs = {}
    for key, channel, srgb in passes:
        imgs[key] = new_image(f'bake_{key}', size, srgb)
        rig.target(imgs[key])
        rig.show(channel)
        bake(bake_objs, 'EMIT', opt['samples'])
    rig.show(None)
    imgs['normal'] = new_image('bake_normal', size, False)
    rig.target(imgs['normal'])
    bake(bake_objs, 'NORMAL', opt['samples'])
    imgs['ao'] = new_image('bake_ao', size, False)
    rig.target(imgs['ao'])
    bake(bake_objs, 'AO', max(64, opt['samples']))

    # pack ORM and the livery mask
    ao, rough, metal = pixels(imgs['ao']), pixels(imgs['rough']), pixels(imgs['metal'])
    orm = new_image('pod_orm', size, False)
    o = np.ones_like(ao)
    o[:, 0] = 0.35 + 0.65 * ao[:, 0]  # keep some ambient in the deepest cavities
    o[:, 1] = rough[:, 0]
    o[:, 2] = metal[:, 0]
    orm.pixels.foreach_set(o.ravel())
    mp, mt = pixels(imgs['maskp']), pixels(imgs['maskt'])
    liv = new_image('pod_livery_full', size, False)
    l = np.zeros_like(mp)
    l[:, 0], l[:, 1], l[:, 3] = mp[:, 0], mt[:, 0], 1.0
    liv.pixels.foreach_set(l.ravel())
    liv.scale(size // 2, size // 2)
    save(liv, os.path.join(ASSETS, 'pod_livery.png'))
    for key, img in list(imgs.items()) + [('orm', orm)]:
        save(img, os.path.join(BUILD, f'{img.name}.png'))

    atlas, glass, glow = export_materials(imgs['color'], orm, imgs['normal'])
    reassign(pod_objects(), atlas, glass, glow)

    raw = os.path.join(BUILD, 'pod_raw.glb')
    out = os.path.join(ASSETS, 'pod_player.glb')
    select(pod_objects(), bpy.data.objects['Pod'])
    bpy.ops.export_scene.gltf(
        filepath=raw, export_format='GLB', use_selection=True, export_extras=True, export_yup=True,
        export_apply=False, export_tangents=True, export_materials='EXPORT', export_image_format='WEBP',
        export_image_quality=88, export_animations=False, export_cameras=False, export_lights=False)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(BUILD, 'pod_baked.blend'))
    compress(raw, out)

    dg = bpy.context.evaluated_depsgraph_get()
    tris = 0
    for ob in pod_objects():
        if ob.type == 'MESH':
            me = ob.evaluated_get(dg).to_mesh()
            me.calc_loop_triangles()
            tris += len(me.loop_triangles)
            ob.evaluated_get(dg).to_mesh_clear()
    print(f'exported {out}: {os.path.getsize(out) / 1e6:.2f} MB, {tris} tris, {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
