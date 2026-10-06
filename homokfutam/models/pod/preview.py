"""Cycles preview renders of the pod, framed like the game's cameras.

  blender -b --factory-startup --python preview.py -- OUT_DIR [view ...] [--glb PATH] [--samples N]

Without --glb the pod is built procedurally (build_pod.py); with --glb the exported model is
imported instead, so the baked result can be checked. Use build/pod_raw.glb for that: the game copy in
assets/ is meshopt-compressed, which Blender's importer cannot read.
Views: chase, chase_close, hero, side, cockpit, rear.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# eye, target, vertical fov (deg). Chase cams mirror CAMS in main.js: d behind, h above, look 12 m ahead.
VIEWS = {
    'chase': ((0, 13.0, 4.3), (0, -12.0, 1.8), 60),
    'chase_close': ((0, 8.2, 2.5), (0, -12.0, 1.3), 60),
    'hero': ((8.5, -13.5, 3.2), (0, -3.0, 0.1), 38),
    'side': ((13.0, -2.6, 1.2), (0, -2.6, 0.1), 52),
    'cockpit': ((2.6, 5.6, 2.7), (0, 2.4, 0.55), 38),
    'rear': ((3.2, 1.0, 1.6), (1.75, -3.6, 0.15), 40),
}
LIVERY_PAINT = (0.807, 0.184, 0.027)
LIVERY_TRIM = (0.905, 0.838, 0.745)


def setup_scene(samples):
    scn = bpy.context.scene
    for ob in list(bpy.data.objects):
        if ob.name in ('Cube', 'Light', 'Camera'):
            bpy.data.objects.remove(ob, do_unlink=True)
    try:
        scn.render.engine = 'CYCLES'
    except TypeError as e:
        print('engine', e)
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'OPTIX'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == 'OPTIX'
        scn.cycles.device = 'GPU'
    except Exception as e:  # CPU fallback
        print('gpu', e)
    scn.cycles.samples = samples
    scn.cycles.use_denoising = True
    scn.render.resolution_x, scn.render.resolution_y = 1280, 720
    for vt in ('Khronos PBR Neutral', 'Standard'):  # the list comes from the OCIO config at runtime
        try:
            scn.view_settings.view_transform = vt
            break
        except TypeError:
            pass

    world = bpy.data.worlds.new('desert')
    scn.world = world
    nt = world.node_tree
    bg = next(n for n in nt.nodes if n.type == 'BACKGROUND')
    sky = nt.nodes.new('ShaderNodeTexSky')
    try:
        sky.sky_type = 'NISHITA'
    except TypeError:
        pass
    for attr, val in (('sun_elevation', math.radians(38)), ('sun_rotation', math.radians(140)), ('sun_disc', False)):
        if hasattr(sky, attr):
            setattr(sky, attr, val)
    nt.links.new(sky.outputs[0], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = 0.22

    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 3.4
    sun.color = (1.0, 0.94, 0.85)
    sun.angle = math.radians(1.5)
    so = bpy.data.objects.new('HF_Sun', sun)
    so.rotation_euler = (math.radians(52), 0, math.radians(140))
    scn.collection.objects.link(so)

    me = bpy.data.meshes.new('ground')
    s = 400
    me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
    gm = bpy.data.materials.new('sand')
    b = next(n for n in gm.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (0.62, 0.42, 0.25, 1)
    b.inputs['Roughness'].default_value = 1.0
    me.materials.append(gm)
    g = bpy.data.objects.new('HF_Ground', me)
    g.location.z = -1.55  # HOVER in main.js
    scn.collection.objects.link(g)

    cam = bpy.data.cameras.new('cam')
    cam.sensor_fit = 'VERTICAL'
    co = bpy.data.objects.new('HF_Cam', cam)
    scn.collection.objects.link(co)
    scn.camera = co
    return co


def aim(cam_ob, view):
    eye, tgt, fov = VIEWS[view]
    cam_ob.location = eye
    d = Vector(tgt) - Vector(eye)
    cam_ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    cam_ob.data.angle = math.radians(fov)


def import_glb(path):
    """Import the exported pod and apply the player livery the way the game does."""
    bpy.ops.import_scene.gltf(filepath=path)
    livery = os.path.join(HERE, '..', '..', 'assets', 'pod_livery.png')
    if not os.path.exists(livery):
        return
    img = bpy.data.images.load(livery)
    img.colorspace_settings.name = 'Non-Color'
    mat = bpy.data.materials.get('PodAtlas')
    if mat is None:
        return
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    link = next(l for l in nt.links if l.to_socket == bsdf.inputs['Base Color'])
    base = link.from_socket
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(tex.outputs['Color'], sep.inputs[0])

    def mixc(fac, a, b, blend):
        n = nt.nodes.new('ShaderNodeMix')
        n.data_type, n.blend_type, n.clamp_factor = 'RGBA', blend, True
        ins = {s.identifier: s for s in n.inputs}
        if isinstance(fac, float):
            ins['Factor_Float'].default_value = fac
        else:
            nt.links.new(fac, ins['Factor_Float'])
        for key, v in (('A_Color', a), ('B_Color', b)):
            if isinstance(v, tuple):
                ins[key].default_value = v + (1.0,)
            else:
                nt.links.new(v, ins[key])
        return {s.identifier: s for s in n.outputs}['Result_Color']

    tp = mixc(sep.outputs[0], (1.0, 1.0, 1.0), LIVERY_PAINT, 'MIX')
    tt = mixc(sep.outputs[1], (1.0, 1.0, 1.0), LIVERY_TRIM, 'MIX')
    tint = mixc(1.0, tp, tt, 'MULTIPLY')
    nt.links.new(mixc(1.0, base, tint, 'MULTIPLY'), bsdf.inputs['Base Color'])


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    out = argv[0] if argv else os.path.join(HERE, 'build', 'preview')
    glb, samples, views = None, 96, []
    i = 1
    while i < len(argv):
        if argv[i] == '--glb':
            glb = argv[i + 1]
            i += 2
        elif argv[i] == '--samples':
            samples = int(argv[i + 1])
            i += 2
        else:
            views.append(argv[i])
            i += 1
    views = views or ['chase', 'hero']
    os.makedirs(out, exist_ok=True)
    cam = setup_scene(samples)
    if glb:
        import_glb(glb)
    else:
        import build_pod
        build_pod.build()
    for v in views:
        aim(cam, v)
        bpy.context.scene.render.filepath = os.path.join(out, f'{v}{"_glb" if glb else ""}.png')
        bpy.ops.render.render(write_still=True)
        print('wrote', bpy.context.scene.render.filepath)


if __name__ == '__main__':
    main()
