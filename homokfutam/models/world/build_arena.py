"""Arena building kit for HOMOKFUTAM, modelled in Blender from code.

  blender -b --factory-startup --python homokfutam/models/world/build_arena.py

Writes homokfutam/assets/world/arena.glb (meshopt-compressed with gltfpack when Node is there).
Every module is split by material into objects called <module>_<material>, material being
stone / plaster / wood / cloth / metal / dark; the game textures them triplanar with the arena
texture set (build_textures.py, ARENA). Vertex colour = tint, alpha = baked ambient occlusion.

Module frames (Blender, Z up; the export turns Y into the game's -Z):
  bay      front-wall bay, 8 m along X, face towards the track at Y = 0 (outward is +Y),
           Z = 0 at track level: an arched niche with a dark doorway, pilasters, plinth, cornice
  awning   16 m along X, origin at the inner top edge of the back wall: a striped canopy on
           cantilevered beams, sloping down towards the track (-Y) over the top rows
  merlon   one battlement block for the top of the back wall
  tower    gate tower, 14 m square at the base, origin at its foot centre
  gantry   the bridge over the start line, 70 m along X (the game stretches it to the span),
           Z = 0 at track level; lamp recesses on the -Y face, sign band on both faces
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

OUT = os.path.normpath(os.path.join(HERE, '..', '..', 'assets', 'world', 'arena.glb'))
MATS = ['stone', 'plaster', 'wood', 'cloth', 'metal', 'dark']
TINT = {'stone': '#f2e6d2', 'plaster': '#fbf3e6', 'wood': '#ffffff', 'cloth': '#ffffff', 'metal': '#ffffff', 'dark': '#3a2c22'}


# ---------------------------------------------------------------------------- building blocks

class Part:
    """Collects boxes / cylinders as bmesh geometry with a material index."""

    def __init__(self):
        self.bm = bmesh.new()

    def box(self, lo, hi, mat):
        lo, hi = np.array(lo, float), np.array(hi, float)
        r = bmesh.ops.create_cube(self.bm, size=1.0)
        for v in r['verts']:
            v.co = (lo + (np.array(v.co) + 0.5) * (hi - lo)).tolist()
        for f in {f for v in r['verts'] for f in v.link_faces}:
            f.material_index = MATS.index(mat)
        return r['verts']

    def cyl(self, centre, r0, r1, h, mat, seg=16):
        r = bmesh.ops.create_cone(self.bm, cap_ends=True, segments=seg, radius1=r0, radius2=r1, depth=h)
        for v in r['verts']:
            v.co.z += h / 2
            v.co += __import__('mathutils').Vector(centre)
        for f in {f for v in r['verts'] for f in v.link_faces}:
            f.material_index = MATS.index(mat)
        return r['verts']

    def sphere(self, centre, rad, mat, half=True):
        r = bmesh.ops.create_uvsphere(self.bm, u_segments=24, v_segments=12, radius=rad)
        for f in {f for v in r['verts'] for f in v.link_faces}:
            f.material_index = MATS.index(mat)
        kill = [v for v in r['verts'] if half and v.co.z < -1e-4]
        for v in r['verts']:
            v.co += __import__('mathutils').Vector(centre)
        bmesh.ops.delete(self.bm, geom=kill, context='VERTS')

    def obj(self, name):
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        ob = R.link(bpy.data.objects.new(name, me))
        for m in MATS:
            mat = bpy.data.materials.get(m) or bpy.data.materials.new(m)
            ob.data.materials.append(mat)
        return ob


def cut(ob, cutter):
    m = ob.modifiers.new('cut', 'BOOLEAN')
    m.operation = 'DIFFERENCE'
    m.object = cutter
    m.solver = 'EXACT'
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
        bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def prism(name, profile, y0, y1):
    """Closed prism from an XZ profile (list of (x, z)), extruded along Y."""
    n = len(profile)
    verts = [(x, y0, z) for x, z in profile] + [(x, y1, z) for x, z in profile]
    faces = [(k, (k + 1) % n, (k + 1) % n + n, k + n) for k in range(n)]
    faces += [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    return R.mesh_obj(name, np.array(verts), faces)


def arch_profile(w, h_spring, h_apex, z0=0.0, segs=24):
    """Opening: vertical sides to the springing line, then a round-ish arch."""
    pts = [(-w / 2, z0), (w / 2, z0)]
    for k in range(segs + 1):
        a = k / segs * math.pi
        pts.append((math.cos(a) * w / 2, h_spring + math.sin(a) * (h_apex - h_spring)))
    return pts


def bevel(ob, width, segs=2):
    R.apply_mod(ob, 'BEVEL', width=width, segments=segs, limit_method='ANGLE', angle_limit=math.radians(40))


def finish(ob, module, ao_dist):
    """Weathering noise, tint + baked occlusion, then split into <module>_<material> objects."""
    me = ob.data
    c = R.co(ob)
    ao = R.bake_ao(ob, ao_dist, 64)
    # by name: booleans add an empty slot (the cut faces, which are stone) and separating
    # by material keeps only the slots each piece uses
    slot = [MATS.index(m.name) if m is not None and m.name in MATS else 0 for m in me.materials]
    mats = np.zeros(len(me.vertices), int)
    for p in me.polygons:
        for v in p.vertices:
            mats[v] = slot[p.material_index] if p.material_index < len(slot) else 0
    tint = np.array([R.srgb(TINT[MATS[m]]) for m in mats])
    tint *= (1 + (R.fbm3(c / 1.7, 2, 7) - 0.5) * 0.12)[:, None]
    R.set_colors(ob, tint, ao)
    R.shade(ob, 35)
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.separate(type='MATERIAL')
    bpy.ops.object.mode_set(mode='OBJECT')
    out, groups = [], {}
    for o in list(bpy.context.selected_objects):
        used = {p.material_index for p in o.data.polygons}
        if not used:
            bpy.data.objects.remove(o, do_unlink=True)
            continue
        m = o.data.materials[used.pop()]
        groups.setdefault(m.name if m is not None and m.name in MATS else 'stone', []).append(o)
    for mat, objs in groups.items():          # the empty slot and real stone end up together
        if len(objs) > 1:
            bpy.ops.object.select_all(action='DESELECT')
            for o in objs:
                o.select_set(True)
            bpy.context.view_layer.objects.active = objs[0]
            bpy.ops.object.join()
        o = objs[0]
        o.name = o.data.name = f'{module}_{mat}'
        o.data.materials.clear()
        out.append(o)
    bpy.ops.object.select_all(action='DESELECT')
    return out


# ---------------------------------------------------------------------------- modules

def bay():
    p = Part()
    p.box((-4, 0, -0.6), (4, 1.6, 3.0), 'stone')                     # wall
    p.box((-4.05, -0.18, -0.6), (4.05, 1.6, 0.35), 'stone')          # plinth
    for sx in (-1, 1):
        p.box((sx * 4 - 0.35, -0.22, 0.35), (sx * 4 + 0.35, 1.6, 3.0), 'stone')   # pilasters
    p.box((-4.1, -0.32, 3.0), (4.1, 1.6, 3.18), 'stone')             # cornice
    p.box((-4.0, -0.22, 3.18), (4.0, 1.6, 3.42), 'stone')
    ob = p.obj('bay')
    niche = prism('niche', arch_profile(2.6, 1.7, 2.85, 0.35), -0.5, 0.55)
    cut(ob, niche)
    door = Part()
    door.box((-1.25, 0.5, 0.35), (1.25, 0.62, 2.8), 'dark')
    d = door.obj('door')
    bpy.ops.object.select_all(action='DESELECT')
    for o in (ob, d):
        o.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.join()
    bevel(ob, 0.04)
    return finish(ob, 'bay', 1.5)


def awning():
    p = Part()
    # cantilever beams from a post at the back wall, ropes implied by the sag of the cloth
    for x in (-7.6, 7.6):
        p.box((x - 0.18, 0.2, 0), (x + 0.18, 0.6, 5.2), 'wood')                    # posts
        p.box((x - 0.12, -12.4, 4.6), (x + 0.12, 0.6, 4.85), 'wood')              # beam
    p.box((-8, 0.15, 4.85), (8, 0.55, 5.1), 'wood')                               # back rail
    # the canopy: a sagging sheet with a scalloped front edge, given a little thickness
    nx, ny = 33, 14
    grid = []
    for j in range(ny):
        t = j / (ny - 1)
        y = 0.4 - t * 12.6
        row = []
        for i in range(nx):
            u = i / (nx - 1)
            x = -8 + u * 16
            sag = math.sin(u * math.pi) * 0.45 * (0.3 + 0.7 * t)
            z = 4.95 - t * 3.0 - sag - (0.18 * math.sin(u * math.pi * 4) ** 2 if j == ny - 1 else 0)
            row.append(p.bm.verts.new((x, y, z)))
        grid.append(row)
    faces = []
    for j in range(ny - 1):
        for i in range(nx - 1):
            f = p.bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
            f.material_index = MATS.index('cloth')
            faces.append(f)
    bmesh.ops.recalc_face_normals(p.bm, faces=faces)
    bmesh.ops.solidify(p.bm, geom=faces, thickness=0.04)
    ob = p.obj('awning')
    return finish(ob, 'awning', 3.0)


def merlon():
    p = Part()
    p.box((-0.8, 0, 0), (0.8, 0.8, 1.3), 'stone')
    p.box((-0.9, -0.05, 1.3), (0.9, 0.85, 1.45), 'stone')
    ob = p.obj('merlon')
    bevel(ob, 0.05)
    return finish(ob, 'merlon', 0.8)


def tower():
    p = Part()
    p.box((-7.4, -7.4, -1), (7.4, 7.4, 2.0), 'stone')                     # plinth
    # tapering plastered shaft with stone quoins and two string courses
    shaft = p.box((-7, -7, 2.0), (7, 7, 24), 'plaster')
    for v in shaft:
        if v.co.z > 10:
            k = 1 - (v.co.z - 2) / 22 * 0.14
            v.co.x *= k
            v.co.y *= k
    for z in (9.0, 17.0):
        k = 1 - (z - 2) / 22 * 0.14
        p.box((-7.25 * k, -7.25 * k, z), (7.25 * k, 7.25 * k, z + 0.6), 'stone')
    # stone quoins up the corners
    for sx in (-1, 1):
        for sy in (-1, 1):
            for n_, z in enumerate(np.arange(2.0, 23.5, 1.1)):
                k = 1 - (z + 0.5 - 2) / 22 * 0.14          # the shaft tapers linearly to 0.86 at the top
                w = 1.5 if n_ % 2 else 0.9                 # alternating long and short quoins
                x0, y0 = sx * (7 * k + 0.08), sy * (7 * k + 0.08)
                xa, xb = sorted((x0, x0 - sx * w))
                ya, yb = sorted((y0, y0 - sy * 0.9))
                p.box((xa, ya, z), (xb, yb, z + 1.0), 'stone')
                xa, xb = sorted((x0, x0 - sx * 0.9))
                ya, yb = sorted((y0, y0 - sy * w))
                p.box((xa, ya, z), (xb, yb, z + 1.0), 'stone')
    # parapet with merlons, drum, dome and finial
    k = 0.86
    p.box((-7.3 * k, -7.3 * k, 24), (7.3 * k, 7.3 * k, 25.0), 'stone')
    for a in range(4):
        for t in np.linspace(-0.8, 0.8, 4):
            ca, sa = math.cos(a * math.pi / 2), math.sin(a * math.pi / 2)
            x, y = ca * 6.0 + -sa * t * 6.0, sa * 6.0 + ca * t * 6.0
            p.box((x - 0.55, y - 0.55, 25.0), (x + 0.55, y + 0.55, 26.4), 'stone')
    p.cyl((0, 0, 24.8), 4.6, 4.6, 2.2, 'plaster', 32)
    p.sphere((0, 0, 27.0), 4.6, 'plaster')
    p.cyl((0, 0, 31.4), 0.35, 0.05, 3.2, 'metal', 8)
    ob = p.obj('tower')
    # slit windows and a doorway, cut through
    cutters = []
    for a in range(4):
        for z in (11.0, 19.0):
            ca, sa = math.cos(a * math.pi / 2), math.sin(a * math.pi / 2)
            c = Part()
            c.box((-0.35, -8.5, z), (0.35, -5.0, z + 3.2), 'dark')
            o = c.obj('slit')
            o.rotation_euler.z = a * math.pi / 2
            cutters.append(o)
    for o in cutters:
        with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]):
            bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
        cut(ob, o)
    # dark backs for the slits
    backs = Part()
    for a in range(4):
        for z in (11.0, 19.0):
            ca, sa = math.cos(a * math.pi / 2), math.sin(a * math.pi / 2)
            k2 = 1 - (z - 2) / 22 * 0.14
            d = 7 * k2 - 0.6
            lo = np.array([-0.36, -d - 0.05, z]); hi = np.array([0.36, -d + 0.05, z + 3.2])
            vs = backs.box(lo, hi, 'dark')
            for v in vs:
                x, y = v.co.x, v.co.y
                v.co.x, v.co.y = x * math.cos(a * math.pi / 2) - y * math.sin(a * math.pi / 2), x * math.sin(a * math.pi / 2) + y * math.cos(a * math.pi / 2)
    bo = backs.obj('backs')
    bpy.ops.object.select_all(action='DESELECT')
    for o in (ob, bo):
        o.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.join()
    bevel(ob, 0.06)
    return finish(ob, 'tower', 4.0)


def gantry():
    p = Part()
    L = 35.0
    p.box((-L, -2.5, 14.5), (L, 2.5, 19.5), 'plaster')                   # rendered box girder
    p.box((-L, -2.8, 19.5), (L, 2.8, 19.9), 'stone')                     # top cornice
    p.box((-L, -2.7, 14.2), (L, 2.7, 14.5), 'stone')                     # bottom moulding
    for x in np.arange(-L + 2, L - 1, 4.0):
        p.box((x - 0.15, -2.62, 14.5), (x + 0.15, 2.62, 19.5), 'metal')  # stiffeners
    for k in range(5):                                                   # lamp housings
        x = (k - 2) * 2.6
        p.box((x - 1.15, -2.9, 14.4), (x + 1.15, -2.5, 16.8), 'dark')
    for sx in (-1, 1):                                                   # stone corbels at the towers
        lo = (sx * L - 3.0, -3.0, 13.0) if sx > 0 else (sx * L, -3.0, 13.0)
        hi = (sx * L, 3.0, 20.2) if sx > 0 else (sx * L + 3.0, 3.0, 20.2)
        p.box(lo, hi, 'stone')
    ob = p.obj('gantry')
    bevel(ob, 0.03)
    return finish(ob, 'gantry', 2.5)


def main():
    R.reset()
    t0 = time.time()
    objs = []
    for fn in (bay, awning, merlon, tower, gantry):
        t = time.time()
        made = fn()
        objs += made
        print(f'{fn.__name__}: {[o.name for o in made]}, {sum(R.tris(o) for o in made)} tris, {time.time() - t:.0f}s')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    R.export_glb(objs, OUT)
    print(f'wrote {OUT}: {len(objs)} meshes, {sum(R.tris(o) for o in objs)} tris, {os.path.getsize(OUT) / 1024:.0f} KB in {time.time() - t0:.0f}s')
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, 'build', 'arena.blend'))


if __name__ == '__main__':
    main()
