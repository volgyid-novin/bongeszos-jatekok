"""HOMOKFUTAM player pod: procedural Blender build.

Run inside Blender: live (exec this file) or headless through bake_export.py.

Frames
  Blender: Z up, the pod's nose points to -Y.
  Game (three.js, after glTF export): +z forward, +x left, +y up.
  game (x, y, z) == blender (x, z, -y)

Layout follows buildPod() in homokfutam/main.js: two engines at game (+-1.75, 0.15, 5.4),
cockpit tub centred at game z = -2.2. The engine empties must stay exactly there with
identity rotation, because racerFx() overwrites their position.y and rotation.z.

Moving parts are empties with custom properties that the glTF exporter writes as extras
(three.js userData): anim = fan | brake | flap | flare | lean, axis, sign, max.
"""
import math
from math import pi, sin, cos, radians

import bmesh
import bpy
from mathutils import Matrix, Vector

COLL = 'HF_Pod'
MATS = ['PAINT', 'PAINT_HULL', 'TRIM', 'STEEL_DARK', 'STEEL_BARE', 'BRASS', 'RUBBER',
        'LEATHER', 'CLOTH', 'SPINNER', 'GLASS', 'GLOW', 'BEAM']
M = {n: i for i, n in enumerate(MATS)}
ENGINE_POS = Vector((1.75, -5.4, 0.15))
HULL_C, HULL_RY, HULL_SX, HULL_SZ = 2.2, 2.05, 1.05, 0.66

D, B, P, T, BR, RB, LT = 'STEEL_DARK', 'STEEL_BARE', 'PAINT', 'TRIM', 'BRASS', 'RUBBER', 'LEATHER'


# ============================================================
#  bmesh helpers: every helper writes into bm and returns the new verts
# ============================================================
def _faces_of(verts):
    return {f for v in verts for f in v.link_faces}


def _finish(bm, verts, mat, mtx=None):
    if mtx is not None:
        bmesh.ops.transform(bm, matrix=mtx, verts=list(verts))
    if mat is not None:
        for f in _faces_of(verts):
            f.material_index = M[mat]
    return verts


def rot_to(axis):
    """Rotation matrix taking +Z to axis."""
    return Vector((0, 0, 1)).rotation_difference(Vector(axis).normalized()).to_matrix().to_4x4()


def box(bm, size, loc=(0, 0, 0), mat=D, rot=None):
    vs = bmesh.ops.create_cube(bm, size=1.0)['verts']
    m = Matrix.Translation(loc) @ (rot if rot is not None else Matrix()) @ Matrix.Diagonal((*size, 1))
    return _finish(bm, vs, mat, m)


def cyl(bm, r1, r2, depth, loc=(0, 0, 0), axis=(0, 0, 1), segs=12, mat=D, caps=True):
    vs = bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=segs,
                               radius1=r1, radius2=r2, depth=depth)['verts']
    return _finish(bm, vs, mat, Matrix.Translation(loc) @ rot_to(axis))


def sphere(bm, radius, loc=(0, 0, 0), scale=(1, 1, 1), segs=16, rings=8, mat=D, rot=None):
    vs = bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=radius)['verts']
    m = Matrix.Translation(loc) @ (rot if rot is not None else Matrix()) @ Matrix.Diagonal((*scale, 1))
    return _finish(bm, vs, mat, m)


def lathe(bm, prof, segs=40, a0=0.0, a1=2 * pi, caps=False, mtx=None):
    """Revolve a profile [(r, y, mat), ...] around +Y. Angle 0 is +X, pi/2 is +Z.
    A segment uses the material of its first point. Normals face the right-hand side of the
    profile direction: walking +y they face out, walking -r they face +y."""
    full = abs(a1 - a0) >= 2 * pi - 1e-6
    n = segs if full else segs + 1
    closed = len(prof) > 2 and tuple(prof[0][:2]) == tuple(prof[-1][:2])
    rings, made = [], []
    for i, p in enumerate(prof):
        r, y = p[0], p[1]
        if closed and i == len(prof) - 1:
            rings.append(rings[0])
            continue
        if r < 1e-6:
            v = bm.verts.new((0, y, 0))
            ring = [v] * n
            made.append(v)
        else:
            ring = []
            for k in range(n):
                a = a0 + (a1 - a0) * k / segs
                ring.append(bm.verts.new((r * cos(a), y, r * sin(a))))
            made += ring
        rings.append(ring)
    mat = None
    for i in range(len(prof) - 1):
        if len(prof[i]) > 2:
            mat = prof[i][2]
        A, Bv = rings[i], rings[i + 1]
        for k in range(segs):
            k2 = (k + 1) % n if full else k + 1
            quad = [A[k], Bv[k], Bv[k2], A[k2]]
            uniq = []
            for v in quad:
                if v not in uniq:
                    uniq.append(v)
            if len(uniq) >= 3:
                f = bm.faces.new(uniq)
                f.material_index = M[mat or D]
    if caps and not full:
        for k in (0, n - 1):
            loop = []
            for rr in rings[:-1] if closed else rings:
                if rr[k] not in loop:
                    loop.append(rr[k])
            if len(loop) >= 3:
                f = bm.faces.new(loop)
                f.material_index = M[prof[0][2] if len(prof[0]) > 2 else D]
        bmesh.ops.recalc_face_normals(bm, faces=list(_faces_of(made)))
    if mtx is not None:
        bmesh.ops.transform(bm, matrix=mtx, verts=list(set(made)))
    return made


def prism(bm, pts, t, to3d, mat=D, mats=None):
    """Extrude a 2D polygon by thickness t. to3d(u, v, w) -> xyz, w in [0, t].
    mats = (front_mat, back_mat, side_mat) overrides mat per face group."""
    lo = [bm.verts.new(to3d(u, v, 0.0)) for u, v in pts]
    hi = [bm.verts.new(to3d(u, v, t)) for u, v in pts]
    fm, bk, sd = mats or (mat, mat, mat)
    f0 = bm.faces.new(list(reversed(lo)))
    f1 = bm.faces.new(hi)
    f0.material_index, f1.material_index = M[bk], M[fm]
    sides = []
    for i in range(len(pts)):
        j = (i + 1) % len(pts)
        f = bm.faces.new([lo[i], lo[j], hi[j], hi[i]])
        f.material_index = M[sd]
        sides.append(f)
    faces = [f0, f1] + sides
    bmesh.ops.recalc_face_normals(bm, faces=faces)
    return lo + hi


def catmull(pts, n=8):
    pts = [Vector(p) for p in pts]
    ext = [pts[0] * 2 - pts[1]] + pts + [pts[-1] * 2 - pts[-2]]
    out = []
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        for k in range(n):
            t = k / n
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(pts[-1])
    return out


def sweep(bm, pts, radius, sides=8, mat=RB, caps=True, flat=1.0, up=(0, 0, 1)):
    """Tube along points with parallel-transport frames. radius may be a float or f(u).
    flat < 1 squashes the section into a ribbon (normal direction keeps radius*flat)."""
    pts = [Vector(p) for p in pts]
    tans = []
    for i in range(len(pts)):
        a, b = pts[max(i - 1, 0)], pts[min(i + 1, len(pts) - 1)]
        tans.append((b - a).normalized())
    nrm = Vector(up).cross(tans[0])
    if nrm.length < 1e-4:
        nrm = Vector((1, 0, 0)).cross(tans[0])
    nrm.normalize()
    rings, made = [], []
    for i, p in enumerate(pts):
        if i:
            q = tans[i - 1].rotation_difference(tans[i])
            nrm = (q @ nrm).normalized()
        bin_ = tans[i].cross(nrm).normalized()
        rad = radius(i / (len(pts) - 1)) if callable(radius) else radius
        ring = []
        for k in range(sides):
            a = 2 * pi * k / sides
            ring.append(bm.verts.new(p + (nrm * cos(a) * flat + bin_ * sin(a)) * rad))
        rings.append(ring)
        made += ring
    faces = []
    for i in range(len(rings) - 1):
        for k in range(sides):
            k2 = (k + 1) % sides
            faces.append(bm.faces.new([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]]))
    if caps:
        faces.append(bm.faces.new(list(reversed(rings[0]))))
        faces.append(bm.faces.new(rings[-1]))
    for f in faces:
        f.material_index = M[mat]
    bmesh.ops.recalc_face_normals(bm, faces=faces)
    return made


# ============================================================
#  objects
# ============================================================
def get_coll():
    c = bpy.data.collections.get(COLL)
    if c is None:
        c = bpy.data.collections.new(COLL)
        bpy.context.scene.collection.children.link(c)
    return c


def clear():
    c = bpy.data.collections.get(COLL)
    if c is None:
        return
    for ob in list(c.objects):
        data = ob.data
        bpy.data.objects.remove(ob, do_unlink=True)
        if data is not None and data.users == 0:
            bpy.data.meshes.remove(data)


def empty(name, parent=None, loc=(0, 0, 0), **props):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = 'PLAIN_AXES'
    ob.empty_display_size = 0.25
    ob.location = loc
    ob.parent = parent
    for k, v in props.items():
        ob[k] = v
    get_coll().objects.link(ob)
    return ob


def smooth_by_angle(me, angle=35.0):
    bm = bmesh.new()
    bm.from_mesh(me)
    lim = radians(angle)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0.0) < lim
    bm.to_mesh(me)
    bm.free()


def mesh_obj(name, bm, parent=None, loc=(0, 0, 0), angle=35.0, bevel=0.0):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    for m in MATS:
        me.materials.append(bpy.data.materials[m])
    smooth_by_angle(me, angle)
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    ob.parent = parent
    get_coll().objects.link(ob)
    if bevel:
        bv = ob.modifiers.new('Bevel', 'BEVEL')
        bv.width = bevel
        bv.segments = 1
        bv.limit_method = 'ANGLE'
        bv.angle_limit = radians(40)
        bv.harden_normals = True
    return ob


# ============================================================
#  materials: one shared grime group, a thin wrapper per surface type
# ============================================================
class NB:
    """Tiny node-graph builder. Arguments may be sockets or constants."""

    def __init__(self, nt):
        self.nt = nt

    def node(self, typ, **props):
        n = self.nt.nodes.new(typ)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def link(self, src, dst):
        if isinstance(src, bpy.types.NodeSocket):
            self.nt.links.new(src, dst)
        elif isinstance(src, (tuple, list)):
            dst.default_value = tuple(src) + ((1.0,) if len(src) == 3 and len(dst.default_value) == 4 else ())
        else:
            dst.default_value = src

    def math(self, op, a, b=None, clamp=False):
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.link(a, n.inputs[0])
        if b is not None:
            self.link(b, n.inputs[1])
        return n.outputs[0]

    def add(self, a, b, clamp=False):
        return self.math('ADD', a, b, clamp)

    def sub(self, a, b, clamp=False):
        return self.math('SUBTRACT', a, b, clamp)

    def mul(self, a, b, clamp=False):
        return self.math('MULTIPLY', a, b, clamp)

    def smooth(self, x, lo, hi):
        n = self.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', clamp=True)
        ins = {s.identifier: s for s in n.inputs}
        self.link(x, ins['Value'])
        self.link(lo, ins['From Min'])
        self.link(hi, ins['From Max'])
        return n.outputs['Result']

    def mixf(self, fac, a, b):
        n = self.node('ShaderNodeMix', data_type='FLOAT', clamp_factor=True)
        ins = {s.identifier: s for s in n.inputs}
        self.link(fac, ins['Factor_Float'])
        self.link(a, ins['A_Float'])
        self.link(b, ins['B_Float'])
        return {s.identifier: s for s in n.outputs}['Result_Float']

    def mixc(self, fac, a, b, blend='MIX'):
        n = self.node('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_factor=True)
        ins = {s.identifier: s for s in n.inputs}
        self.link(fac, ins['Factor_Float'])
        self.link(a, ins['A_Color'])
        self.link(b, ins['B_Color'])
        return {s.identifier: s for s in n.outputs}['Result_Color']

    def noise(self, vec, scale, detail=4.0, rough=0.5, dist=0.0):
        n = self.node('ShaderNodeTexNoise')
        self.link(vec, n.inputs['Vector'])
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = rough
        n.inputs['Distortion'].default_value = dist
        return n.outputs['Fac']

    def mapping(self, vec, scale):
        n = self.node('ShaderNodeMapping')
        self.link(vec, n.inputs['Vector'])
        n.inputs['Scale'].default_value = scale
        return n.outputs['Vector']

    def sep(self, vec):
        n = self.node('ShaderNodeSeparateXYZ')
        self.link(vec, n.inputs[0])
        return n.outputs['X'], n.outputs['Y'], n.outputs['Z']


SURF_IN = [  # name, socket type, default
    ('Base', 'NodeSocketColor', (0.8, 0.8, 0.8, 1.0)),
    ('Metallic', 'NodeSocketFloat', 0.0),
    ('Roughness', 'NodeSocketFloat', 0.5),
    ('Paint', 'NodeSocketFloat', 0.0),
    ('Trim', 'NodeSocketFloat', 0.0),
    ('Under', 'NodeSocketColor', (0.36, 0.35, 0.33, 1.0)),
    ('Wear', 'NodeSocketFloat', 0.5),
    ('Grime', 'NodeSocketFloat', 1.0),
    ('Dust', 'NodeSocketFloat', 1.0),
    ('Rust', 'NodeSocketFloat', 0.0),
    ('Soot', 'NodeSocketFloat', 1.0),
    ('Panel', 'NodeSocketFloat', 0.0),
]
SURF_OUT = [('Color', 'NodeSocketColor'), ('Metallic', 'NodeSocketFloat'), ('Roughness', 'NodeSocketFloat'),
            ('MaskPaint', 'NodeSocketFloat'), ('MaskTrim', 'NodeSocketFloat'), ('Normal', 'NodeSocketVector')]

LIVERY_PAINT = (0.807, 0.184, 0.027)   # '#e8772e' (ROSTER[0]) in linear
LIVERY_TRIM = (0.905, 0.838, 0.745)    # '#f4ece0'
GRIME_COL = (0.040, 0.031, 0.022)
RUST_COL = (0.26, 0.10, 0.04)
SOOT_COL = (0.016, 0.014, 0.013)
DUST_COL = (0.56, 0.43, 0.29)
HEAT_COL = (0.30, 0.20, 0.42)


def build_surface_group():
    old = bpy.data.node_groups.get('PodSurface')
    if old:
        bpy.data.node_groups.remove(old)
    ng = bpy.data.node_groups.new('PodSurface', 'ShaderNodeTree')
    for name, typ, dflt in SURF_IN:
        s = ng.interface.new_socket(name, in_out='INPUT', socket_type=typ)
        s.default_value = dflt
    for name, typ in SURF_OUT:
        ng.interface.new_socket(name, in_out='OUTPUT', socket_type=typ)
    nb = NB(ng)
    gi = nb.node('NodeGroupInput')
    go = nb.node('NodeGroupOutput')
    I = gi.outputs
    geo = nb.node('ShaderNodeNewGeometry')
    pos, nrm = geo.outputs['Position'], geo.outputs['Normal']
    px, py, pz = nb.sep(pos)
    nx, ny, nz = nb.sep(nrm)

    n_big = nb.noise(pos, 1.3, 5, 0.55)
    n_mid = nb.noise(pos, 4.5, 8, 0.6)
    n_fine = nb.noise(pos, 22.0, 6, 0.6)
    n_chip = nb.noise(pos, 11.0, 12, 0.72, 0.25)
    n_rust = nb.noise(pos, 2.8, 10, 0.65, 0.2)
    n_streak = nb.noise(nb.mapping(pos, (7, 7, 0.8)), 1.0, 6, 0.6, 0.4)
    n_dirt = nb.noise(pos, 2.2, 8, 0.62, 0.3)
    n_scr = nb.noise(nb.mapping(pos, (70, 1.2, 70)), 1.0, 3, 0.5)

    # convex edges: bevelled normal leans away from the true normal near an edge
    bev = nb.node('ShaderNodeBevel', samples=8)
    bev.inputs['Radius'].default_value = 0.022
    dot = nb.node('ShaderNodeVectorMath', operation='DOT_PRODUCT')
    nb.link(bev.outputs['Normal'], dot.inputs[0])
    nb.link(nrm, dot.inputs[1])
    edge = nb.smooth(nb.sub(1.0, dot.outputs['Value']), 0.004, 0.10)

    ao = nb.node('ShaderNodeAmbientOcclusion', samples=16)
    ao.inputs['Distance'].default_value = 0.4
    crev = nb.sub(1.0, ao.outputs['AO'])

    grime = nb.smooth(nb.add(crev, nb.mul(nb.sub(n_big, 0.5), 0.5)), 0.04, 0.42)
    grime = nb.math('MAXIMUM', grime, nb.mul(I['Panel'], 0.95))
    grime = nb.mul(grime, I['Grime'])

    # glossy oil / grease stains
    n_oil = nb.noise(pos, 3.4, 6, 0.7, 0.8)
    oil = nb.mul(nb.smooth(n_oil, 0.64, 0.72), I['Grime'])

    chip_raw = nb.add(nb.mul(edge, 1.1), nb.mul(nb.sub(n_chip, 0.5), 1.5))
    chip_raw = nb.add(chip_raw, nb.mul(nb.sub(n_big, 0.5), 0.5))
    chip = nb.smooth(nb.mul(chip_raw, I['Wear']), 0.34, 0.40)

    # blotchy road dirt, heavier on the undersides (sand thrown up by the repulsors)
    under_side = nb.smooth(nz, 0.1, -0.7)
    dirt = nb.smooth(nb.add(n_dirt, nb.mul(under_side, 0.25)), 0.48, 0.70)
    dirt = nb.mul(dirt, I['Grime'])

    up = nb.smooth(nz, 0.25, 0.9)
    dust_patch = nb.smooth(nb.add(n_big, nb.mul(nb.sub(n_mid, 0.5), 0.7)), 0.52, 0.72)
    dust = nb.add(nb.mul(up, nb.mul(dust_patch, 0.7)), nb.mul(nb.mul(crev, up), 0.7))
    dust = nb.add(dust, 0.03)
    dust = nb.mul(dust, I['Dust'], clamp=True)

    # sun-bleached paint: large soft patches lose saturation
    fade = nb.smooth(nb.noise(pos, 0.6, 3, 0.5), 0.35, 0.75)

    rust = nb.mul(nb.smooth(nb.add(n_rust, nb.mul(crev, 0.4)), 0.60, 0.68), I['Rust'])

    # engine exhaust soot: rear 1.6 m of each engine (world y -3.8 .. -1.8, |x| > 0.85)
    s_y = nb.mul(nb.smooth(py, -3.85, -2.2), nb.smooth(py, -1.65, -1.95))
    s_x = nb.smooth(nb.math('ABSOLUTE', px), 0.82, 0.97)
    hot = nb.mul(s_y, s_x)
    soot = nb.mul(nb.mul(hot, nb.add(0.55, nb.mul(n_mid, 0.45))), I['Soot'])
    soot = nb.smooth(soot, 0.15, 0.85)
    dust = nb.mul(dust, nb.sub(1.0, soot))

    paintlike = nb.math('MAXIMUM', I['Paint'], I['Trim'])
    scratch = nb.smooth(n_scr, 0.64, 0.70)
    # sand scour: the finest scratches go through the paint
    scour = nb.mul(nb.smooth(n_scr, 0.71, 0.74), nb.mul(I['Wear'], nb.smooth(n_big, 0.35, 0.6)))
    chip = nb.math('MAXIMUM', chip, scour)

    # ---- colour
    under = nb.mixc(nb.mul(rust, 0.7), I['Under'], RUST_COL)
    c = nb.mixc(nb.mul(chip, paintlike), I['Base'], under)
    bright = nb.mixc(1.0, I['Base'], (0.06, 0.06, 0.06), 'ADD')
    bright = nb.mixc(0.6, bright, bright, 'ADD')
    c = nb.mixc(nb.mul(nb.mul(edge, I['Wear']), nb.mul(nb.sub(1.0, paintlike), 0.55)), c, bright)
    c = nb.mixc(nb.mul(rust, nb.mul(nb.sub(1.0, paintlike), 0.85)), c, RUST_COL)
    c = nb.mixc(nb.mul(nb.mul(hot, I['Soot']), 0.35), c, HEAT_COL, 'MULTIPLY')
    var = nb.add(0.84, nb.mul(n_fine, 0.32))
    vnode = nb.node('ShaderNodeCombineXYZ')
    for k in range(3):
        nb.link(var, vnode.inputs[k])
    c = nb.mixc(1.0, c, vnode.outputs[0], 'MULTIPLY')
    c = nb.mixc(nb.mul(grime, 0.92), c, GRIME_COL)
    c = nb.mixc(nb.mul(dirt, 0.55), c, (0.13, 0.09, 0.055))
    c = nb.mixc(nb.mul(nb.smooth(n_streak, 0.52, 0.72), nb.mul(I['Grime'], 0.45)), c, GRIME_COL)
    c = nb.mixc(nb.mul(oil, 0.7), c, (0.018, 0.015, 0.012))
    c = nb.mixc(nb.mul(soot, 0.93), c, SOOT_COL)
    c = nb.mixc(nb.mul(dust, 0.75), c, DUST_COL)

    # ---- livery masks: how much clean paint is left
    clean = nb.mul(nb.sub(1.0, chip), nb.sub(1.0, nb.mul(dust, 0.8)))
    clean = nb.mul(clean, nb.sub(1.0, nb.mul(soot, 0.85)))
    clean = nb.mul(clean, nb.sub(1.0, nb.mul(fade, 0.35)))
    clean = nb.mul(clean, nb.sub(1.0, nb.mul(dirt, 0.3)))
    mask_p = nb.mul(I['Paint'], clean)
    mask_t = nb.mul(I['Trim'], clean)

    # ---- metallic / roughness
    met = nb.mixf(nb.mul(chip, paintlike), I['Metallic'], 0.95)
    met = nb.mul(met, nb.sub(1.0, nb.mul(rust, 0.9)))
    met = nb.mul(met, nb.sub(1.0, nb.mul(dust, 0.85)))
    met = nb.mul(met, nb.sub(1.0, nb.mul(soot, 0.5)), clamp=True)
    rgh = nb.add(I['Roughness'], nb.mul(nb.sub(n_fine, 0.5), 0.14))
    rgh = nb.mixf(nb.mul(chip, paintlike), rgh, 0.36)
    rgh = nb.mixf(nb.mul(scratch, nb.mul(I['Metallic'], 0.6)), rgh, 0.18)
    rgh = nb.mixf(rust, rgh, 0.9)
    rgh = nb.mixf(nb.mul(grime, 0.6), rgh, 0.78)
    rgh = nb.mixf(nb.mul(oil, 0.8), rgh, 0.22)
    rgh = nb.mixf(dust, rgh, 0.96)
    rgh = nb.mixf(soot, rgh, 0.85)

    # ---- normal: dents, recessed chips, panel grooves, pitted rust, on top of bevelled edges
    h = nb.mul(n_mid, 0.35)
    h = nb.sub(h, nb.mul(nb.mul(chip, paintlike), 0.6))
    h = nb.sub(h, nb.mul(I['Panel'], 1.4))
    h = nb.add(h, nb.mul(nb.mul(rust, n_fine), 0.5))
    bump = nb.node('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.6
    bump.inputs['Distance'].default_value = 0.004
    nb.link(h, bump.inputs['Height'])
    nb.link(bev.outputs['Normal'], bump.inputs['Normal'])

    O = go.inputs
    nb.link(c, O['Color'])
    nb.link(met, O['Metallic'])
    nb.link(rgh, O['Roughness'])
    nb.link(mask_p, O['MaskPaint'])
    nb.link(mask_t, O['MaskTrim'])
    nb.link(bump.outputs['Normal'], O['Normal'])
    return ng


PAINT_SPEC = dict(Base=(0.74, 0.72, 0.69), Metallic=0.12, Roughness=0.5, Under=(0.30, 0.29, 0.27),
                  Wear=1.0, Grime=1.0, Dust=1.0, Rust=0.45, Soot=1.0)
SPECS = {
    'PAINT': dict(PAINT_SPEC, Paint=1.0),
    'PAINT_HULL': dict(PAINT_SPEC, Paint=1.0),
    'TRIM': dict(PAINT_SPEC, Trim=1.0),
    'STEEL_DARK': dict(Base=(0.075, 0.07, 0.064), Metallic=0.8, Roughness=0.5, Wear=0.8, Grime=1.0,
                       Dust=0.8, Rust=0.5, Soot=1.0),
    'STEEL_BARE': dict(Base=(0.40, 0.39, 0.37), Metallic=1.0, Roughness=0.36, Wear=0.4, Grime=0.9,
                       Dust=0.6, Rust=0.3, Soot=1.0),
    'BRASS': dict(Base=(0.58, 0.40, 0.18), Metallic=1.0, Roughness=0.36, Wear=0.4, Grime=1.0, Dust=0.6,
                  Rust=0.15, Soot=1.0),
    'RUBBER': dict(Base=(0.03, 0.028, 0.026), Metallic=0.0, Roughness=0.78, Wear=0.15, Grime=0.5, Dust=0.9),
    'LEATHER': dict(Base=(0.20, 0.11, 0.06), Metallic=0.0, Roughness=0.6, Wear=0.6, Grime=0.8, Dust=0.7),
    'CLOTH': dict(Base=(0.80, 0.78, 0.74), Metallic=0.0, Roughness=0.92, Trim=1.0, Wear=0.0, Grime=0.6,
                  Dust=0.8),
    'SPINNER': dict(PAINT_SPEC, Wear=0.6),
}
HULL_PANEL_Y = (0.95, 1.42, 3.48, 3.95)


def _panel_lines(nb, pos):
    """Groove mask for the hull: rings at HULL_PANEL_Y, a seam along |x| = 0.8 and a waist at z = -0.18."""
    px, py, pz = nb.sep(pos)
    lines = []
    for y in HULL_PANEL_Y:
        lines.append(nb.math('ABSOLUTE', nb.sub(py, y)))
    lines.append(nb.math('ABSOLUTE', nb.sub(nb.math('ABSOLUTE', px), 0.80)))
    lines.append(nb.math('ABSOLUTE', nb.sub(pz, -0.18)))
    d = lines[0]
    for l in lines[1:]:
        d = nb.math('MINIMUM', d, l)
    return nb.sub(1.0, nb.smooth(d, 0.004, 0.011))


def _spinner_inputs(nb, grp):
    """Painted spiral on the fan spinner, in object space so it turns with the fan."""
    tc = nb.node('ShaderNodeTexCoord')
    ox, oy, oz = nb.sep(tc.outputs['Object'])
    ang = nb.math('ARCTAN2', oz, ox)
    u = nb.add(nb.math('DIVIDE', ang, 2 * pi), nb.mul(oy, 1.1))
    f = nb.math('FRACT', u)
    stripe = nb.mul(nb.smooth(f, 0.0, 0.03), nb.smooth(f, 0.42, 0.39))
    nb.link(stripe, grp.inputs['Paint'])
    nb.link(nb.mixc(stripe, (0.52, 0.51, 0.49), (0.80, 0.78, 0.75)), grp.inputs['Base'])
    nb.link(nb.mixf(stripe, 1.0, 0.12), grp.inputs['Metallic'])
    nb.link(nb.mixf(stripe, 0.30, 0.45), grp.inputs['Roughness'])


def build_materials():
    ng = build_surface_group()
    for name in MATS:
        mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        nt = mat.node_tree
        nt.nodes.clear()
        nb = NB(nt)
        out = nb.node('ShaderNodeOutputMaterial')
        bsdf = nb.node('ShaderNodeBsdfPrincipled')
        nb.link(bsdf.outputs[0], out.inputs['Surface'])
        if name == 'GLASS':
            bsdf.inputs['Base Color'].default_value = (0.20, 0.16, 0.10, 1)
            bsdf.inputs['Roughness'].default_value = 0.08
            bsdf.inputs['Alpha'].default_value = 0.4
            try:
                mat.surface_render_method = 'BLENDED'
            except (AttributeError, TypeError):
                pass
            continue
        if name == 'GLOW':
            bsdf.inputs['Base Color'].default_value = (0, 0, 0, 1)
            bsdf.inputs['Emission Color'].default_value = (1.0, 0.30, 0.06, 1)
            bsdf.inputs['Emission Strength'].default_value = 1.2
            continue
        if name == 'BEAM':   # the energy-beam emitter: electrode and coils, driven by the game
            bsdf.inputs['Base Color'].default_value = (0.05, 0.02, 0.05, 1)
            bsdf.inputs['Emission Color'].default_value = (1.0, 0.18, 0.75, 1)
            bsdf.inputs['Emission Strength'].default_value = 3.0
            continue
        grp = nb.node('ShaderNodeGroup')
        grp.node_tree = ng
        grp.name = 'PodSurface'
        for k, v in SPECS[name].items():
            nb.link(v, grp.inputs[k])
        if name == 'PAINT_HULL':
            geo = nb.node('ShaderNodeNewGeometry')
            nb.link(_panel_lines(nb, geo.outputs['Position']), grp.inputs['Panel'])
        if name == 'SPINNER':
            _spinner_inputs(nb, grp)
        # preview tint = what the game shader does with the livery masks
        tint = nb.mixc(grp.outputs['MaskPaint'], (1, 1, 1), LIVERY_PAINT)
        tint = nb.mixc(1.0, tint, nb.mixc(grp.outputs['MaskTrim'], (1, 1, 1), LIVERY_TRIM), 'MULTIPLY')
        nb.link(nb.mixc(1.0, grp.outputs['Color'], tint, 'MULTIPLY'), bsdf.inputs['Base Color'])
        nb.link(grp.outputs['Metallic'], bsdf.inputs['Metallic'])
        nb.link(grp.outputs['Roughness'], bsdf.inputs['Roughness'])
        nb.link(grp.outputs['Normal'], bsdf.inputs['Normal'])
        # viewport colour so solid mode reads like the livery
        mat.diffuse_color = {'PAINT': (0.85, 0.35, 0.1, 1), 'PAINT_HULL': (0.85, 0.35, 0.1, 1),
                             'TRIM': (0.9, 0.86, 0.78, 1), 'CLOTH': (0.9, 0.86, 0.78, 1)}.get(
            name, tuple(SPECS[name].get('Base', (0.5, 0.5, 0.5))[:3]) + (1,))


# ============================================================
#  engine (left; the right one is a mirrored copy)
# ============================================================
def engine_housing_profile():
    prof = [
        (0.20, -2.62, D), (0.60, -2.62, D), (0.63, -2.80, D), (0.645, -3.30, B),
        (0.70, -3.45, B), (0.78, -3.50, B), (0.845, -3.45, T), (0.855, -3.32, T),
        (0.835, -3.10, T), (0.77, -2.93, D), (0.745, -2.82, D), (0.79, -2.80, D), (0.79, -2.56, D),
        (0.74, -2.54, P), (0.715, -2.42, P), (0.705, -1.68, P), (0.688, -1.66, P), (0.688, -1.58, P),
        (0.705, -1.56, P), (0.705, -1.40, D), (0.785, -1.38, D), (0.785, -1.06, D), (0.70, -1.04, D),
        (0.66, -1.00, D),
    ]
    for k in range(9):
        y0 = -0.94 + k * 0.15
        prof += [(0.66, y0, D), (0.80, y0 + 0.008, B), (0.80, y0 + 0.042, D), (0.66, y0 + 0.05, D)]
    prof += [
        (0.66, 0.40, D), (0.715, 0.44, P), (0.725, 1.00, P), (0.725, 1.02, D), (0.805, 1.04, D),
        (0.805, 1.36, D), (0.735, 1.38, P), (0.74, 2.20, P), (0.725, 2.23, P), (0.725, 2.29, P),
        (0.745, 2.32, D), (0.795, 2.36, D), (0.795, 2.74, D), (0.70, 2.78, D), (0.60, 2.785, D),
        (0.57, 2.52, D), (0.24, 2.50, D),
    ]
    return prof


def radial(phi):
    """Matrix rotating +X onto the radial direction at angle phi (around +Y)."""
    return Matrix.Rotation(-phi, 4, 'Y')


def build_engine_static(bm):
    lathe(bm, engine_housing_profile(), segs=40)

    # straps across the radiator ribs
    for phi in (radians(35), radians(145), radians(215), radians(325)):
        v = box(bm, (0.045, 1.42, 0.07), (0, 0, 0), D)
        bmesh.ops.transform(bm, matrix=radial(phi) @ Matrix.Translation((0.83, -0.30, 0)), verts=v)
        for y in (-0.88, -0.30, 0.28):
            v = cyl(bm, 0.014, 0.010, 0.02, (0, 0, 0), (1, 0, 0), 6, B)
            bmesh.ops.transform(bm, matrix=radial(phi) @ Matrix.Translation((0.86, y, 0)), verts=v)

    # dorsal hinge rail for the air-brakes, with hinge knuckles. Nothing hangs under the engines:
    # the pod banks up to ~0.55 rad and anything below the shell would cut into the sand.
    box(bm, (0.10, 2.8, 0.22), (0, 0.25, 0.76), D)
    for y in (-0.85, 0.35, 1.45):
        cyl(bm, 0.035, 0.035, 0.18, (0, y, 0.885), (0, 1, 0), 10, B)

    # access hatch on the outboard side (+x), with bolts
    hatch = [(0.69, -2.32), (0.728, -2.30), (0.728, -1.76), (0.69, -1.74), (0.69, -2.32)]
    lathe(bm, [(r, y, T) for r, y in hatch], segs=6, a0=-radians(20), a1=radians(20), caps=True)
    for a in (-17, 17):
        for y in (-2.26, -2.03, -1.80):
            v = cyl(bm, 0.017, 0.017, 0.02, (0, 0, 0), (1, 0, 0), 6, B)
            bmesh.ops.transform(bm, matrix=radial(radians(a)) @ Matrix.Translation((0.735, y, 0)), verts=v)

    # louvres on the rear housing, top-outboard
    for i in range(6):
        y = 1.52 + i * 0.11
        v = box(bm, (0.035, 0.05, 0.26), (0, 0, 0), D)
        bmesh.ops.transform(bm, matrix=radial(radians(58)) @ Matrix.Translation((0.755, y, 0))
                            @ Matrix.Rotation(radians(-30), 4, 'Z'), verts=v)

    # beam emitter on the inboard side (-x); its tip is BeamAnchor. The electrode, the face of the
    # brass collar and three coils around the neck are BEAM: the game lights them with the beam
    emit_mtx = Matrix.Translation((0, -1.95, 0)) @ Matrix.Rotation(radians(90), 4, 'Z')
    emit = [(0.18, 0.64, D), (0.18, 0.73, D), (0.14, 0.75, D), (0.14, 0.77, BR), (0.165, 0.78, BR),
            (0.165, 0.82, 'BEAM'), (0.10, 0.83, D), (0.07, 0.86, 'BEAM'), (0.035, 0.93, 'BEAM'), (0.0, 0.95, 'BEAM')]
    lathe(bm, emit, segs=20, mtx=emit_mtx)
    for y0 in (0.66, 0.69, 0.72):
        ring = [(0.192 + 0.014 * cos(a), y0 + 0.011 * sin(a), 'BEAM') for a in [2 * pi * k / 8 for k in range(8)]]
        lathe(bm, ring + [ring[0]], segs=20, mtx=emit_mtx)
    for k in range(3):  # prongs around the electrode
        a = radians(90 + k * 120)
        tip = Vector((-0.90, -1.95 + 0.11 * cos(a), 0.11 * sin(a)))
        base = Vector((-0.80, -1.95 + 0.13 * cos(a), 0.13 * sin(a)))
        sweep(bm, [base, tip], 0.014, 6, B)

    # cable socket on the inboard rear
    box(bm, (0.08, 0.34, 0.24), (-0.74, 2.02, -0.06), D)
    cyl(bm, 0.092, 0.092, 0.26, (-0.77, 2.08, -0.06), (0, 1, 0), 12, BR)
    cyl(bm, 0.10, 0.10, 0.04, (-0.77, 2.20, -0.06), (0, 1, 0), 12, D)

    # outboard stabiliser (the flap is a separate moving part)
    stab = [(0.70, 1.42), (0.70, 2.33), (1.30, 2.33), (1.30, 1.95)]
    prism(bm, stab, 0.06, lambda u, v, w: (u, v, w - 0.03), P, mats=(P, P, D))
    box(bm, (0.035, 0.55, 0.30), (1.315, 2.13, 0.03), T)  # end plate

    # fuel lines along the rear housing
    for phi in (radians(28), radians(45)):
        pts = []
        for r, y in ((0.70, 1.40), (0.80, 1.47), (0.835, 1.58), (0.835, 2.18), (0.81, 2.30), (0.77, 2.36)):
            pts.append(radial(phi) @ Vector((r, y, 0)))
        sweep(bm, catmull(pts, 4), 0.026, 8, BR)
        for y in (1.75, 2.05):
            v = box(bm, (0.04, 0.05, 0.09), (0, 0, 0), D)
            bmesh.ops.transform(bm, matrix=radial(phi) @ Matrix.Translation((0.80, y, 0)), verts=v)

    # rivets along both edges of the two bands
    for r, ys in ((0.785, (-1.37, -1.07)), (0.805, (1.05, 1.35))):
        for y in ys:
            for k in range(24):
                a = 2 * pi * (k + 0.5) / 24
                v = cyl(bm, 0.013, 0.008, 0.014, (0, 0, 0), (1, 0, 0), 6, B)
                bmesh.ops.transform(bm, matrix=radial(a) @ Matrix.Translation((r + 0.004, y, 0)), verts=v)

    # turbine stator vanes around the glowing core
    for k in range(12):
        v = box(bm, (0.33, 0.10, 0.018), (0, 0, 0), D)
        bmesh.ops.transform(bm, matrix=radial(2 * pi * k / 12) @ Matrix.Translation((0.405, 2.55, 0))
                            @ Matrix.Rotation(radians(30), 4, 'X'), verts=v)


def build_glow(bm):
    lathe(bm, [(0.25, 2.49, 'GLOW'), (0.18, 2.58, 'GLOW'), (0.07, 2.65, 'GLOW'), (0.0, 2.66, 'GLOW')], segs=20)


def build_fan(bm):
    """In fan-pivot space (engine y = -2.95)."""
    spin = [(0.0, -1.30, 'SPINNER'), (0.06, -1.24), (0.14, -1.08), (0.24, -0.82), (0.33, -0.50),
            (0.40, -0.18), (0.42, 0.0, D), (0.42, 0.08, D), (0.25, 0.12, D), (0.0, 0.12, D)]
    lathe(bm, spin, segs=32)
    for k in range(14):
        v = box(bm, (0.22, 0.15, 0.018), (0, 0, 0), B)
        bmesh.ops.transform(bm, matrix=radial(2 * pi * k / 14) @ Matrix.Translation((0.51, 0.02, 0))
                            @ Matrix.Rotation(radians(38), 4, 'X'), verts=v)


def build_nozzle(bm):
    """In nozzle-pivot space (engine y = 2.78). 16 overlapping petals plus actuator rods."""
    for k in range(16):
        a0 = 2 * pi * k / 16 - 0.015
        a1 = 2 * pi * (k + 1) / 16 + 0.015
        o = 0.006 if k % 2 else 0.0
        pet = [(0.75 + o, 0.0, D), (0.70 + o, 0.40, D), (0.62 + o, 0.76, D), (0.595 + o, 0.76, D),
               (0.675 + o, 0.40, D), (0.725 + o, 0.0, D), (0.75 + o, 0.0, D)]
        lathe(bm, pet, segs=3, a0=a0, a1=a1, caps=True)
    lathe(bm, [(0.775, -0.02, BR), (0.775, 0.10, BR), (0.745, 0.12, BR)], segs=40)
    for k in range(8):
        a = 2 * pi * (k + 0.5) / 8
        p0 = radial(a) @ Vector((0.80, -0.20, 0))
        p1 = radial(a) @ Vector((0.735, 0.34, 0))
        sweep(bm, [p0, p1], 0.018, 6, B)


def build_leaf(bm, side):
    """Dorsal air-brake leaf in its hinge-pivot space. side = +1 sits on +x, -1 on -x."""
    pts = [(-1.05, 0.0), (1.28, 0.0), (1.28, 0.52), (1.12, 0.60), (0.15, 0.60)]
    x0 = 0.004 * side
    t = 0.034 * side
    prism(bm, pts, abs(t), lambda u, v, w: (x0 + w * side, u, v), P, mats=(P, T, P))
    # inner faces (towards the other leaf) take the accent colour, visible when braking
    for f in bm.faces:
        c = f.calc_center_median()
        if abs(f.normal.x) > 0.9 and f.normal.x * side < 0:
            f.material_index = M[T]
        elif abs(f.normal.x) > 0.9:
            f.material_index = M[P]
    # stiffeners on the outer face
    for y in (-0.3, 0.55):
        box(bm, (0.02, 0.05, 0.5), (x0 + (abs(t) + 0.01) * side, y, 0.30), D)


def build_flap(bm):
    """In flap-pivot space (engine (1.0, 2.33, 0))."""
    pts = [(-0.19, 0.0), (0.30, 0.0), (0.30, 0.26), (-0.19, 0.30)]
    prism(bm, pts, 0.04, lambda u, v, w: (u, v, w - 0.02), T)
    cyl(bm, 0.025, 0.025, 0.5, (0.055, 0.0, 0), (1, 0, 0), 8, D)


def build_engine(parent, side_name='L'):
    eng = empty(f'Engine_{side_name}', parent, ENGINE_POS)
    bm = bmesh.new()
    build_engine_static(bm)
    mesh_obj(f'Engine_{side_name}_static', bm, eng)
    bm = bmesh.new()
    build_glow(bm)
    mesh_obj(f'Engine_{side_name}_glow', bm, eng, bevel=0)

    fan = empty(f'Fan_{side_name}', eng, (0, -2.95, 0), anim='fan', axis='z', sign=1.0, max=1.0)
    bm = bmesh.new()
    build_fan(bm)
    mesh_obj(f'Fan_{side_name}_mesh', bm, fan)

    noz = empty(f'Nozzle_{side_name}', eng, (0, 2.78, 0), anim='flare', axis='xy', sign=1.0, max=0.16)
    bm = bmesh.new()
    build_nozzle(bm)
    mesh_obj(f'Nozzle_{side_name}_mesh', bm, noz)

    flap = empty(f'Flap_{side_name}', eng, (1.0, 2.33, 0), anim='flap', axis='x', sign=1.0, max=0.45)
    bm = bmesh.new()
    build_flap(bm)
    mesh_obj(f'Flap_{side_name}_mesh', bm, flap, bevel=0.006)

    # split dorsal air-brake: P/N = leaf on +x/-x; sign = three.js rotation.z that opens it outward
    for side in (1, -1):
        tag = 'P' if side > 0 else 'N'
        piv = empty(f'Brake_{side_name}_{tag}', eng, (0, 0.35, 0.87), anim='brake', axis='z', sign=-float(side), max=0.75)
        bm = bmesh.new()
        build_leaf(bm, side)
        mesh_obj(f'Brake_{side_name}_{tag}_mesh', bm, piv, bevel=0.006)

    empty(f'BeamAnchor_{side_name}', eng, (-0.93, -1.95, 0))
    empty(f'FlameAnchor_{side_name}', eng, (0, 3.5, 0))
    return eng


# ============================================================
#  cockpit tub, cables, pilot
# ============================================================
def hull_r(t):
    s = max(sin(t), 0.0)
    return s ** (1.2 if t < pi / 2 else 0.55)


def hull_surface_z(x, y):
    """Top surface height of the (unflattened) hull at (x, y)."""
    c = max(-1.0, min(1.0, (HULL_C - y) / HULL_RY))
    r = hull_r(math.acos(c))
    q = 1 - (x / (HULL_SX * r)) ** 2 if r > 1e-4 else 0
    return HULL_SZ * r * math.sqrt(max(q, 0.0))


def ws(u, v):
    """Windscreen surface: u in [-1, 1] across, v in [0, 1] up. Sits on the deck ahead of the cockpit."""
    x = (0.50 - 0.10 * v) * u
    y = 1.28 + 0.26 * v + 0.08 * u * u * (0.4 + v)
    zb = hull_surface_z(abs(0.50 * u), 1.28 + 0.032 * u * u)
    return Vector((x, y, zb + 0.012 + 0.30 * v))


def build_hull(coll_parent):
    bm = bmesh.new()
    prof = []
    N = 30
    for i in range(N + 1):
        t = pi * (i / N) ** 1.0
        y = HULL_C - HULL_RY * cos(t)
        prof.append((hull_r(t), y, 'PAINT_HULL'))
    lathe(bm, prof, segs=40)
    for v in bm.verts:
        v.co.x *= HULL_SX
        v.co.z *= HULL_SZ
        if v.co.z < 0:
            v.co.z *= 0.78
    # livery: a deck stripe from the nose to the cockpit and a band behind it
    for f in bm.faces:
        c = f.calc_center_median()
        if (c.y < 1.5 and abs(c.x) < 0.17 and c.z > 0) or (3.48 < c.y < 3.95 and c.z > -0.18):
            f.material_index = M[T]
    hull_me = bpy.data.meshes.new('hull_tmp')
    bm.to_mesh(hull_me)
    bm.free()
    for m in MATS:
        hull_me.materials.append(bpy.data.materials[m])
    hull = bpy.data.objects.new('hull_tmp', hull_me)
    get_coll().objects.link(hull)

    # cockpit pocket: rounded-rectangle prism cut down to a floor at z = 0.28
    bm = bmesh.new()
    pts = []
    hx, y0, y1, rc = 0.60, 1.52, 3.38, 0.28
    corners = ((hx - rc, y1 - rc, 0), (-hx + rc, y1 - rc, 90), (-hx + rc, y0 + rc, 180), (hx - rc, y0 + rc, 270))
    for cx, cy, a0 in corners:
        for k in range(7):
            a = radians(a0 + 90 * k / 6)
            pts.append((cx + rc * cos(a), cy + rc * sin(a)))
    prism(bm, pts, 2.0, lambda u, v, w: (u, v, 0.28 + w), D)
    cut_me = bpy.data.meshes.new('cut_tmp')
    bm.to_mesh(cut_me)
    bm.free()
    for m in MATS:
        cut_me.materials.append(bpy.data.materials[m])
    cutter = bpy.data.objects.new('cut_tmp', cut_me)
    get_coll().objects.link(cutter)
    cutter.hide_render = True
    mod = hull.modifiers.new('cut', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.object = cutter
    try:
        mod.solver = 'EXACT'
    except TypeError:
        pass
    try:
        mod.material_mode = 'INDEX'
    except (AttributeError, TypeError):
        pass
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    me = bpy.data.meshes.new_from_object(hull.evaluated_get(dg))
    bpy.data.objects.remove(hull, do_unlink=True)
    bpy.data.objects.remove(cutter, do_unlink=True)
    bpy.data.meshes.remove(hull_me)
    bpy.data.meshes.remove(cut_me)
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    # pocket walls/floor came from the cutter (STEEL_DARK); make sure the rest kept hull paint
    return bm


def build_body(body):
    bm = build_hull(body)

    # padded leather coaming around the cockpit opening, sitting on the cut edge
    hx, y0, y1, rc = 0.62, 1.50, 3.40, 0.30
    path = []
    corners = ((hx - rc, y1 - rc, 0), (-hx + rc, y1 - rc, 90), (-hx + rc, y0 + rc, 180), (hx - rc, y0 + rc, 270))
    for cx, cy, a0 in corners:
        for k in range(9):
            a = radians(a0 + 90 * k / 8)
            x, y = cx + rc * cos(a), cy + rc * sin(a)
            path.append(Vector((x, y, hull_surface_z(x, y) + 0.01)))
    path.append(path[0])
    sweep(bm, path, 0.05, 10, LT, caps=False)

    # ram-scoop nose
    nose = [(0.0, -0.15, D), (0.25, -0.20, D), (0.28, -0.44, B), (0.32, -0.48, B), (0.36, -0.46, T),
            (0.35, -0.42, T), (0.42, -0.25, T), (0.50, 0.05, T), (0.56, 0.35, T), (0.58, 0.62, T)]
    lathe(bm, nose, segs=32, mtx=Matrix.Translation((0, 0, -0.03)) @ Matrix.Diagonal((1, 1, 0.62, 1)))
    for k in range(5):
        z = (-0.16 + k * 0.08) * 0.62 - 0.03
        w = 0.27 * math.sqrt(max(0.0, 1 - ((k - 2) / 2.6) ** 2))
        box(bm, (2 * w, 0.03, 0.018), (0, -0.30, z), D)
    for k in range(16):
        a = 2 * pi * k / 16
        v = cyl(bm, 0.014, 0.009, 0.014, (0, 0, 0), (1, 0, 0), 6, B)
        bmesh.ops.transform(bm, matrix=Matrix.Translation((0, 0, -0.03)) @ Matrix.Diagonal((1, 1, 0.62, 1))
                            @ radial(a) @ Matrix.Translation((0.578, 0.55, 0)), verts=v)

    # windscreen frame (glass is its own object, built from the same ws() surface)
    for s in (1, -1):
        sweep(bm, [ws(s, v / 4) for v in range(5)], 0.022, 8, D)
    sweep(bm, [ws(u / 6 - 1, 1.0) for u in range(13)], 0.022, 8, D)

    # dashboard with gauges, control levers
    box(bm, (0.90, 0.20, 0.20), (0, 1.68, 0.40), D)
    for i, x in enumerate((-0.30, -0.10, 0.10, 0.30)):
        cyl(bm, 0.055, 0.055, 0.03, (x, 1.79, 0.45), (0, 1, 0.6), 14, BR)
        cyl(bm, 0.045, 0.045, 0.032, (x, 1.795, 0.45), (0, 1, 0.6), 14, T if i % 2 else B)
    for s in (1, -1):
        sweep(bm, [(s * 0.24, 2.10, 0.28), (s * 0.25, 2.02, 0.45), (s * 0.26, 1.99, 0.56)], 0.022, 8, B)
        cyl(bm, 0.035, 0.035, 0.12, (s * 0.26, 1.99, 0.60), (0, 0, 1), 8, RB)

    # low seat back (the chase camera looks over it at the pilot), roll hoop with braces
    box(bm, (0.66, 0.10, 0.45), (0, 3.14, 0.55), D, rot=Matrix.Rotation(radians(-12), 4, 'X'))
    box(bm, (0.56, 0.08, 0.38), (0, 3.07, 0.56), LT, rot=Matrix.Rotation(radians(-12), 4, 'X'))
    box(bm, (0.60, 0.50, 0.10), (0, 2.82, 0.33), LT)
    hoop = [Vector((0.70 * cos(a), 3.26, 0.40 + 1.0 * sin(a))) for a in [pi * i / 18 for i in range(19)]]
    sweep(bm, hoop, 0.045, 10, B)
    for s in (1, -1):
        sweep(bm, [(s * 0.40, 3.26, 1.22), (s * 0.42, 3.92, 0.40)], 0.03, 8, B)

    # side vents on the flanks
    for s in (1, -1):
        for i in range(5):
            y = 0.95 + i * 0.13
            v = box(bm, (0.04, 0.05, 0.24), (0, 0, 0), D)
            nx = s * (HULL_SX * hull_r(math.acos((HULL_C - y) / HULL_RY)) - 0.02)
            bmesh.ops.transform(bm, matrix=Matrix.Translation((nx, y, 0.08)) @ Matrix.Rotation(radians(-25), 4, 'Z'),
                                verts=v)

    # stub wings with end plates
    for s in (1, -1):
        wing = [(0.70, 2.35), (0.70, 3.75), (1.70, 3.55), (1.70, 3.00)]
        v = prism(bm, wing, 0.07, lambda u, v_, w: (u, v_, w - 0.035), P, mats=(P, P, D))
        m = Matrix.Translation((0, 0, -0.10)) @ Matrix.Rotation(radians(-10), 4, 'Y')
        if s < 0:
            m = Matrix.Diagonal((-1, 1, 1, 1)) @ m
        bmesh.ops.transform(bm, matrix=m, verts=v)
        if s < 0:
            bmesh.ops.reverse_faces(bm, faces=list(_faces_of(v)))
        box(bm, (0.04, 0.70, 0.40), (s * 1.68, 3.30, 0.12), T)

    # cable sockets on the front flanks
    for s in (1, -1):
        box(bm, (0.16, 0.30, 0.24), (s * 0.60, 0.62, -0.04), D)
        cyl(bm, 0.092, 0.092, 0.24, (s * 0.64, 0.42, -0.04), (s * 0.15, -1, 0), 12, BR)

    # rear: exhaust stubs, grille, antenna
    for s in (1, -1):
        sweep(bm, catmull([(s * 0.30, 3.90, 0.30), (s * 0.34, 4.22, 0.50), (s * 0.37, 4.45, 0.60)], 4),
              0.075, 12, B)
        cyl(bm, 0.062, 0.062, 0.02, (s * 0.372, 4.46, 0.605), (0.1 * s, 1, 0.4), 12, D)
    box(bm, (0.72, 0.06, 0.32), (0, 4.24, -0.08), D)
    for k in range(5):
        box(bm, (0.70, 0.04, 0.025), (0, 4.28, -0.20 + k * 0.06), B)
    cyl(bm, 0.012, 0.008, 1.25, (-0.62, 3.70, 1.02), (0, 0.12, 1), 6, B)

    # skids under the belly
    for s in (1, -1):
        box(bm, (0.12, 2.6, 0.08), (s * 0.42, 2.3, -0.52), D)

    mesh_obj('Body_static', bm, body, bevel=0.006)

    # pennant on the antenna (accent cloth)
    bm = bmesh.new()
    pts = [Vector((-0.62, 3.76 + 0.55 * u, 1.60 - 0.10 * u + 0.03 * sin(u * 9))) for u in [i / 10 for i in range(11)]]
    sweep(bm, pts, lambda u: 0.11 * (1 - u) + 0.01, 4, 'CLOTH', flat=0.08)
    mesh_obj('Body_pennant', bm, body, bevel=0)

    # glass
    bm = bmesh.new()
    rows = [[bm.verts.new(ws(i / 6 - 1, j / 3)) for i in range(13)] for j in range(4)]
    for j in range(3):
        for i in range(12):
            f = bm.faces.new([rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]])
            f.material_index = M['GLASS']
    mesh_obj('Body_glass', bm, body, bevel=0)


def build_cables(body):
    bm = bmesh.new()
    for s in (1, -1):
        main = [(0.68, 0.30, -0.04), (0.78, -0.40, -0.26), (0.80, -1.30, -0.36), (0.86, -2.30, -0.30),
                (0.92, -2.92, -0.08), (0.98, -3.30, 0.09)]
        main = [Vector((s * x, y, z)) for x, y, z in main]
        path = catmull(main, 8)
        sweep(bm, path, 0.065, 10, RB)
        # clamps
        acc = 0.0
        for i in range(1, len(path) - 1):
            acc += (path[i] - path[i - 1]).length
            if acc > 0.55 and 2 < i < len(path) - 4:
                acc = 0.0
                tan = (path[i + 1] - path[i - 1]).normalized()
                cyl(bm, 0.082, 0.082, 0.07, path[i], tan, 10, BR)
        for off, rad in (((0.07, 0, 0.075), 0.026), ((-0.05, 0, 0.09), 0.02)):
            o = Vector((off[0] * s, off[1], off[2]))
            pts = [p + o * min(1.0, 4 * min(k, len(main) - 1 - k) / (len(main) - 1)) for k, p in enumerate(main)]
            sweep(bm, catmull(pts, 8), rad, 6, RB)
    mesh_obj('Body_cables', bm, body, angle=60, bevel=0)


def build_pilot(body):
    piv = empty('Pilot', body, (0, 2.75, 0.30), anim='lean', axis='z', sign=1.0, max=0.16)
    bm = bmesh.new()
    lean = Matrix.Rotation(radians(10), 4, 'X')  # hunched forward
    # in pivot space: z up from the seat
    sphere(bm, 0.30, (0, 0.0, 0.30), (0.95, 0.75, 1.0), 16, 10, LT, rot=lean)           # torso
    sphere(bm, 0.20, (0, -0.02, 0.47), (1.65, 0.95, 0.75), 16, 8, LT)                   # shoulders
    cyl(bm, 0.075, 0.07, 0.14, (0, -0.04, 0.58), (0, 0, 1), 10, LT)                    # neck
    sphere(bm, 0.15, (0, -0.06, 0.74), (1.0, 1.12, 0.95), 18, 10, LT)                   # helmet
    for s in (1, -1):                                                                     # ear flaps
        sphere(bm, 0.07, (s * 0.128, -0.05, 0.665), (0.30, 0.85, 1.25), 10, 6, LT,
               rot=Matrix.Rotation(radians(-12 * s), 4, 'Y'))
    box(bm, (0.035, 0.30, 0.025), (0, -0.04, 0.88), D, rot=Matrix.Rotation(radians(5), 4, 'X'))  # crest
    sweep(bm, [Vector((0.158 * cos(a), -0.06 + 0.165 * sin(a), 0.75)) for a in
               [2 * pi * i / 24 for i in range(25)]], 0.014, 6, RB, caps=False, flat=1.0)  # goggle strap
    for s in (1, -1):
        cyl(bm, 0.052, 0.048, 0.06, (s * 0.06, -0.205, 0.75), (0, -1, 0), 12, B)       # goggle cups
        # arms: shoulder -> elbow -> hand on lever (levers at body (+-0.23, 1.95, 0.56))
        sh = Vector((s * 0.27, -0.02, 0.44))
        el = Vector((s * 0.34, -0.30, 0.22))
        ha = Vector((s * 0.23, -0.66, 0.26))
        sweep(bm, catmull([sh, el, ha], 4), lambda u: 0.068 - 0.024 * u, 10, LT)
        sphere(bm, 0.048, ha, (1, 1.2, 1), 10, 6, RB)                                    # glove
    # scarf: wrap plus two tails streaming back
    sweep(bm, [Vector((0.115 * cos(a), -0.04 + 0.11 * sin(a), 0.60)) for a in
               [2 * pi * i / 20 for i in range(21)]], 0.045, 8, 'CLOTH', caps=False, flat=0.6)
    # tails stream back and out to the side so they do not hide the helmet from behind
    for k, s in enumerate((1, -1)):
        pts = [Vector((s * (0.08 + 0.22 * u) + 0.02 * sin(u * 7 + k), 0.06 + 0.62 * u,
                       0.58 - 0.06 * u + 0.04 * sin(u * 6 + k))) for u in [i / 10 for i in range(11)]]
        sweep(bm, pts, lambda u: 0.055 - 0.025 * u, 6, 'CLOTH', flat=0.18, up=(0, 0, 1))
    grow = Matrix.Scale(1.15, 4)
    bmesh.ops.transform(bm, matrix=grow, verts=bm.verts[:])
    mesh_obj('Pilot_mesh', bm, piv, angle=50)
    bm = bmesh.new()
    for s in (1, -1):
        cyl(bm, 0.045, 0.045, 0.01, (s * 0.06, -0.24, 0.75), (0, -1, 0), 12, 'GLASS')
    bmesh.ops.transform(bm, matrix=grow, verts=bm.verts[:])
    mesh_obj('Pilot_glass', bm, piv, bevel=0)
    return piv


# ============================================================
#  mirror the left engine into the right one
# ============================================================
def mirror_engine(eng_l, body):
    """Duplicate Engine_L and every child, mirrored in x. Mesh data is copied (not instanced)
    so the right side shares the left side's UVs and texture, with geometry flipped."""
    flip = Matrix.Diagonal((-1, 1, 1, 1))
    eng_r = empty('Engine_R', body, (-ENGINE_POS.x, ENGINE_POS.y, ENGINE_POS.z))
    mapping = {eng_l: eng_r}

    def copy(ob, parent_r):
        name = ob.name.replace('_L', '_R')
        if ob.type == 'EMPTY':
            new = empty(name, parent_r, (-ob.location.x, ob.location.y, ob.location.z))
            for k in ob.keys():
                new[k] = ob[k]
            if 'anim' in ob.keys():
                # mirroring flips the handedness of rotations about z (fan spin, leaf opening);
                # the flaps keep their sign but should deflect differentially with steering
                if ob['axis'] in ('z', 'x'):
                    new['sign'] = -ob['sign']
        else:
            me = ob.data.copy()
            me.name = name
            me.transform(flip)
            me.flip_normals()
            new = bpy.data.objects.new(name, me)
            new.parent = parent_r
            new.location = (-ob.location.x, ob.location.y, ob.location.z)
            get_coll().objects.link(new)
            for mod in ob.modifiers:
                m2 = new.modifiers.new(mod.name, mod.type)
                for attr in ('width', 'segments', 'limit_method', 'angle_limit', 'harden_normals'):
                    if hasattr(mod, attr):
                        setattr(m2, attr, getattr(mod, attr))
        mapping[ob] = new
        for ch in ob.children:
            copy(ch, new)

    for ch in eng_l.children:
        copy(ch, eng_r)
    return eng_r


# ============================================================
def build():
    clear()
    build_materials()
    root = empty('Pod', None, (0, 0, 0))
    body = empty('Body', root)
    build_body(body)
    build_cables(body)
    build_pilot(body)
    eng_l = build_engine(body, 'L')
    mirror_engine(eng_l, body)
    return root


if __name__ == '__main__':
    build()
