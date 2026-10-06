"""Quick Cycles look at models from rocks.glb / props.glb, lined up under a low sun.

  blender -b --factory-startup --python homokfutam/models/world/preview.py -- <rocks.blend|file.glb> <out.png> [name_prefix,...]
(the meshopt-compressed .glb files can't be imported by Blender: use the .blend the build saves)
"""
import math
import os
import sys

import bpy
from mathutils import Vector


def main():
    argv = sys.argv[sys.argv.index('--') + 1:]
    glb, out = argv[0], argv[1]
    prefixes = argv[2].split(',') if len(argv) > 2 and argv[2] else []
    w, h = 1600, 700
    if glb.endswith('.blend'):
        bpy.ops.wm.open_mainfile(filepath=glb)
    else:
        for ob in list(bpy.data.objects):
            bpy.data.objects.remove(ob, do_unlink=True)
        bpy.ops.import_scene.gltf(filepath=glb)
    obs = [o for o in bpy.context.scene.objects if o.type == 'MESH' and (not prefixes or any(o.name.startswith(p) for p in prefixes))]
    for o in bpy.context.scene.objects:
        if o.type == 'MESH' and o not in obs:
            o.hide_render = True
    mat = bpy.data.materials.new('vc')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    ca = nt.nodes.new('ShaderNodeVertexColor')
    mul = nt.nodes.new('ShaderNodeMix')
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    nt.links.new(ca.outputs['Color'], mul.inputs[6])
    nt.links.new(ca.outputs['Alpha'], mul.inputs[7])
    nt.links.new(mul.outputs[2], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.85
    x = 0.0
    groups = {}
    for o in obs:                       # parts of one module (name_material) move together
        o.data.materials.clear()
        o.data.materials.append(mat)
        key = o.name.rsplit('_', 1)[0] if any(o.name.endswith('_' + m) for m in ('stone', 'plaster', 'wood', 'cloth', 'metal', 'dark')) else o.name
        groups.setdefault(key, []).append(o)
    for key in sorted(groups):
        bb = [o.matrix_world @ Vector(c) for o in groups[key] for c in o.bound_box]
        sx = max(v.x for v in bb) - min(v.x for v in bb)
        dx, dz = x - min(v.x for v in bb), -min(v.z for v in bb)
        for o in groups[key]:
            o.location.x += dx
            o.location.z += dz
        x += sx * 1.15
    bpy.context.view_layer.update()
    allbb = [o.matrix_world @ Vector(c) for o in obs for c in o.bound_box]
    lo = Vector((min(v.x for v in allbb), min(v.y for v in allbb), min(v.z for v in allbb)))
    hi = Vector((max(v.x for v in allbb), max(v.y for v in allbb), max(v.z for v in allbb)))
    ctr, size = (lo + hi) / 2, hi - lo
    # ground
    bpy.ops.mesh.primitive_plane_add(size=max(size.x, size.y) * 4, location=(ctr.x, ctr.y, size.z * 0.03))
    g = bpy.context.active_object
    gm = bpy.data.materials.new('ground')
    gm.use_nodes = True
    gb = next(n for n in gm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    gb.inputs['Base Color'].default_value = (0.55, 0.36, 0.2, 1)
    g.data.materials.append(gm)
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 4.5
    sun.color = (1.0, 0.85, 0.68)
    sun.angle = math.radians(1.5)
    so = bpy.data.objects.new('sun', sun)
    bpy.context.scene.collection.objects.link(so)
    so.rotation_euler = (math.radians(62), 0, math.radians(-35))
    world = bpy.context.scene.world or bpy.data.worlds.new('w')
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = (0.42, 0.55, 0.78, 1)
    bg.inputs['Strength'].default_value = 0.7
    cam = bpy.data.cameras.new('cam')
    cam.lens = 50
    co = bpy.data.objects.new('cam', cam)
    bpy.context.scene.collection.objects.link(co)
    d = max(size.x / (2 * math.tan(math.radians(17.5))) * 1.05, size.z * 1.6)
    co.location = (ctr.x, ctr.y - d, ctr.z + size.z * 0.15)
    cam.clip_end = d * 6
    cam.clip_start = d * 0.01
    co.rotation_euler = (math.radians(86), 0, 0)
    scn = bpy.context.scene
    scn.camera = co
    scn.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'OPTIX'
        prefs.get_devices()
        for dv in prefs.devices:
            dv.use = dv.type == 'OPTIX'
        scn.cycles.device = 'GPU'
    except Exception:  # noqa: BLE001
        pass
    scn.cycles.samples = 48
    scn.render.resolution_x, scn.render.resolution_y = w, h
    scn.render.filepath = out
    scn.view_settings.view_transform = 'AgX'
    bpy.ops.render.render(write_still=True)
    print('wrote', out)


main()
