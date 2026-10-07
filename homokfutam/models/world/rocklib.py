"""Helpers for modelling rock in Blender from code: numpy 3D noise, mesh in/out, modifiers,
vertex-colour ambient occlusion and the glTF export. Blender is Z-up here; the export turns
it into the game's Y-up."""
import math
import os
import shutil
import subprocess

import bpy
import numpy as np

# ------------------------------------------------------------------ noise (numpy, 3D)

def _hash(ix, iy, iz, seed):
    h = (ix.astype(np.uint64) * np.uint64(374761393) + iy.astype(np.uint64) * np.uint64(668265263)
         + iz.astype(np.uint64) * np.uint64(2246822519) + np.uint64(seed * 3266489917 & 0xffffffff)) & np.uint64(0xffffffff)
    h = ((h ^ (h >> np.uint64(13))) * np.uint64(1274126177)) & np.uint64(0xffffffff)
    h = h ^ (h >> np.uint64(16))
    return (h & np.uint64(0xffffff)).astype(np.float64) / 16777216.0


def vnoise3(p, seed=0):
    """Value noise in [0, 1] at points p (N, 3)."""
    p = np.asarray(p, np.float64)
    i = np.floor(p).astype(np.int64)
    f = p - i
    u = f * f * (3 - 2 * f)
    i = i + (1 << 20)                      # keep the hash inputs positive
    out = 0.0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (u[:, 0] if dx else 1 - u[:, 0]) * (u[:, 1] if dy else 1 - u[:, 1]) * (u[:, 2] if dz else 1 - u[:, 2])
                out = out + w * _hash(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
    return out


def fbm3(p, octaves=4, seed=0, lac=2.03, gain=0.5):
    p = np.asarray(p, np.float64)
    s, a, n = 0.0, 0.5, 0.0
    for o in range(octaves):
        s = s + a * vnoise3(p * (lac ** o) + o * 17.17, seed + o * 31)
        n += a
        a *= gain
    return s / n


def ridged3(p, octaves=3, seed=0):
    return 1 - np.abs(fbm3(p, octaves, seed) * 2 - 1)


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, np.float64) - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------ scene / mesh

def reset():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        bpy.data.meshes.remove(me)
    scn = bpy.context.scene
    scn.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'OPTIX'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == 'OPTIX'
        scn.cycles.device = 'GPU'
    except Exception as e:  # noqa: BLE001
        print('GPU unavailable:', e)
    if scn.world is None:
        scn.world = bpy.data.worlds.new('World')


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def mesh_obj(name, verts, faces):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in np.asarray(verts, np.float64)], [], [tuple(f) for f in faces])
    me.update()
    return link(bpy.data.objects.new(name, me))


def co(ob):
    me = ob.data
    a = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get('co', a)
    return a.reshape(-1, 3).astype(np.float64)


def set_co(ob, c):
    ob.data.vertices.foreach_set('co', np.asarray(c, np.float32).ravel())
    ob.data.update()


def vnormals(ob):
    me = ob.data
    a = np.empty(len(me.vertices) * 3, np.float32)
    me.vertex_normals.foreach_get('vector', a)
    return a.reshape(-1, 3).astype(np.float64)


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def apply_mod(ob, kind, **props):
    m = ob.modifiers.new(kind.lower(), kind)
    for k, v in props.items():
        setattr(m, k, v)
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
        bpy.ops.object.modifier_apply(modifier=m.name)
    return ob


def remesh(ob, voxel):
    return apply_mod(ob, 'REMESH', mode='VOXEL', voxel_size=voxel, adaptivity=0.0)


def decimate(ob, target_tris):
    t = tris(ob)
    if t > target_tris:
        apply_mod(ob, 'DECIMATE', decimate_type='COLLAPSE', ratio=target_tris / t, use_collapse_triangulate=True)
    return ob


def smooth(ob, factor=0.5, iterations=1):
    return apply_mod(ob, 'SMOOTH', factor=factor, iterations=iterations)


def displace(ob, fn):
    """Move every vertex along its normal by fn(positions, normals) metres."""
    c, n = co(ob), vnormals(ob)
    set_co(ob, c + n * fn(c, n)[:, None])


def duplicate(ob, name):
    o = ob.copy()
    o.data = ob.data.copy()
    o.name = name
    o.data.name = name
    return link(o)


def shade(ob, angle=None):
    me = ob.data
    me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), bool))
    if angle is not None:
        with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
            try:
                bpy.ops.object.shade_auto_smooth(angle=math.radians(angle))
            except Exception:  # noqa: BLE001
                pass
    me.update()


def metaball_mesh(name, elements, resolution, threshold=0.6):
    """elements: list of dicts (co, radius, size=(sx, sy, sz), type). Returns a mesh object."""
    mb = bpy.data.metaballs.new(name)
    mb.resolution = resolution
    mb.render_resolution = resolution
    mb.threshold = threshold
    for e in elements:
        el = mb.elements.new(type=e.get('type', 'ELLIPSOID'))
        el.co = e['co']
        el.radius = e['radius']
        sx, sy, sz = e.get('size', (1, 1, 1))
        el.size_x, el.size_y, el.size_z = sx, sy, sz
        el.stiffness = e.get('stiffness', 2.0)
    ob = link(bpy.data.objects.new(name, mb))
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.metaballs.remove(mb)
    out = link(bpy.data.objects.new(name, me))
    return out


# ------------------------------------------------------------------ colour + occlusion

def bake_ao(ob, distance, samples=64):
    """Cycles ambient occlusion of the object on its own, per vertex (0..1)."""
    scn = bpy.context.scene
    others = [o for o in scn.objects if o is not ob and not o.hide_render]
    for o in others:
        o.hide_render = True
    me = ob.data
    ca = me.color_attributes.new('AO', 'FLOAT_COLOR', 'POINT')
    me.color_attributes.active_color = ca
    scn.world.light_settings.distance = distance
    scn.cycles.samples = samples
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.bake(type='AO', target='VERTEX_COLORS', use_selected_to_active=False, use_clear=True)
    a = np.empty(len(me.vertices) * 4, np.float32)
    ca.data.foreach_get('color', a)
    me.color_attributes.remove(ca)
    for o in others:
        o.hide_render = False
    return a.reshape(-1, 4)[:, 0].astype(np.float64)


def set_colors(ob, rgb, alpha):
    """Vertex colour 'Col' (linear RGB) with the occlusion in alpha (the game splits it off)."""
    me = ob.data
    if 'Col' in me.color_attributes:
        me.color_attributes.remove(me.color_attributes['Col'])
    ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    c = np.concatenate([np.clip(rgb, 0, 1), np.clip(alpha, 0, 1)[:, None]], 1).astype(np.float32)
    ca.data.foreach_set('color', c.ravel())
    me.color_attributes.active_color = ca
    try:
        me.color_attributes.render_color_index = me.color_attributes.active_color_index
    except Exception:  # noqa: BLE001
        pass


def srgb(h):
    h = h.lstrip('#')
    c = np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


# ------------------------------------------------------------------ export

def export_glb(objs, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    raw = path.replace('.glb', '_raw.glb')
    bpy.ops.export_scene.gltf(filepath=raw, export_format='GLB', use_selection=True, export_materials='NONE',
                              export_normals=True, export_texcoords=False, export_animations=False, export_yup=True,
                              export_vertex_color='ACTIVE', export_active_vertex_color_when_no_material=True,
                              export_apply=True, export_cameras=False, export_lights=False)
    npx = shutil.which('npx')
    if npx:
        r = subprocess.run([npx, '-y', 'gltfpack@0.24', '-i', raw, '-o', path, '-cc', '-kn', '-vp', '16'],
                           capture_output=True, text=True)
        if r.returncode == 0:
            try:
                os.remove(raw)
            except OSError as e:          # (Windows: a file watcher may still hold it)
                print('could not remove', raw, e)
            return path
        print('gltfpack failed, keeping uncompressed:', r.stderr[-400:])
    shutil.move(raw, path)
    return path
