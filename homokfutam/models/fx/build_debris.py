"""Debris for hard hits and crashes: fractured rock chunks, torn metal panels and small bits.

  blender -b --factory-startup --python build_debris.py

Output: homokfutam/assets/fx/debris.glb, meshes only (the game brings its own materials):
  Rock0..Rock3    faceted chunks, about 1 m across, flat fracture faces
  Shard0..Shard3  torn, bent hull panels, about 1 m across, 3 cm thick
  Bit0..Bit2      a bent pipe stub, a bracket and a flange: the dark mechanical parts
Every mesh is centred on its origin; the game scales them per piece.
"""
import math
import os
import random

import bmesh
import bpy
from mathutils import Matrix, Vector, noise

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', '..', 'assets', 'fx', 'debris.glb'))


def new_object(name, bm):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def centre(bm):
    c = sum((v.co for v in bm.verts), Vector()) / max(1, len(bm.verts))
    for v in bm.verts:
        v.co -= c
    ext = max(max(abs(v.co[i]) for v in bm.verts) for i in range(3))
    s = 0.5 / max(ext, 1e-4)
    for v in bm.verts:
        v.co *= s


def rock(seed):
    rnd = random.Random(seed)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=0.5)
    sc = Vector((1.0, 0.6 + rnd.random() * 0.35, 0.7 + rnd.random() * 0.3))
    off = Vector((rnd.random() * 50, rnd.random() * 50, rnd.random() * 50))
    for v in bm.verts:
        n = noise.noise(v.co * 2.6 + off)
        v.co = Vector((v.co.x * sc.x, v.co.y * sc.y, v.co.z * sc.z)) * (1 + 0.22 * n)
    # fracture faces: slice off caps with random planes and close the holes flat
    for _ in range(3 + seed % 3):
        nrm = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1))).normalized()
        co = nrm * rnd.uniform(0.12, 0.3)
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        res = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=nrm, clear_outer=True)
        edges = [e for e in res['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
        if edges:
            bmesh.ops.holes_fill(bm, edges=edges)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    centre(bm)
    return new_object(f'Rock{seed}', bm)


def shard(seed):
    """A torn panel: jagged outline, extruded, then curled like bent sheet metal."""
    rnd = random.Random(100 + seed)
    bm = bmesh.new()
    pts = []
    n = 7 + seed % 3
    for k in range(n):
        a = 2 * math.pi * k / n + rnd.uniform(-0.2, 0.2)
        r = 0.5 * (0.55 + 0.45 * rnd.random()) * (1.0 if k % 2 else 0.8)
        pts.append(bm.verts.new((math.cos(a) * r * 1.3, math.sin(a) * r * 0.8, 0)))
    face = bm.faces.new(pts)
    ext = bmesh.ops.extrude_face_region(bm, geom=[face])
    top = [v for v in ext['geom'] if isinstance(v, bmesh.types.BMVert)]
    for v in top:
        v.co.z += 0.03
    # curl around the y axis and twist a little: a ripped, bent skin panel
    curl, twist = rnd.uniform(0.6, 1.4), rnd.uniform(-0.5, 0.5)
    for v in bm.verts:
        x = v.co.x
        ang = x * curl
        rad = 1 / curl
        z = v.co.z
        v.co.x = math.sin(ang) * (rad - z)
        v.co.z = rad - math.cos(ang) * (rad - z)
        v.co = Matrix.Rotation(twist * v.co.x, 4, 'X') @ v.co
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    centre(bm)
    return new_object(f'Shard{seed}', bm)


def bit(kind):
    bm = bmesh.new()
    if kind == 0:   # bent pipe stub
        path = [Vector((0, 0, 0)), Vector((0.3, 0, 0.05)), Vector((0.55, 0, 0.22)), Vector((0.68, 0, 0.5))]
        rings = []
        for i, p in enumerate(path):
            d = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
            side = d.cross(Vector((0, 1, 0))).normalized()
            up = side.cross(d)
            rings.append([bm.verts.new(p + (side * math.cos(a) + up * math.sin(a)) * 0.09)
                          for a in [2 * math.pi * k / 8 for k in range(8)]])
        for A, B in zip(rings, rings[1:]):
            for k in range(8):
                bm.faces.new((A[k], B[k], B[(k + 1) % 8], A[(k + 1) % 8]))
        bm.faces.new(rings[0][::-1])
        bm.faces.new(rings[-1])
    elif kind == 1:  # L bracket with a lightening hole's worth of chunk
        bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation((0, 0, 0)) @ Matrix.Diagonal((0.7, 0.25, 0.05, 1)))
        bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation((0.33, 0, 0.2)) @ Matrix.Diagonal((0.05, 0.25, 0.42, 1)))
        bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation((-0.1, 0, 0.12)) @ Matrix.Rotation(0.7, 4, 'Y') @ Matrix.Diagonal((0.05, 0.08, 0.36, 1)))
    else:            # flange ring segment
        rings = []
        for r, z in ((0.5, 0), (0.5, 0.06), (0.36, 0.06), (0.36, 0)):
            rings.append([bm.verts.new((math.cos(a) * r, math.sin(a) * r, z))
                          for a in [math.radians(-55 + 110 * k / 8) for k in range(9)]])
        for i in range(4):
            A, B = rings[i], rings[(i + 1) % 4]
            for k in range(8):
                bm.faces.new((A[k], B[k], B[k + 1], A[k + 1]))
        bm.faces.new([rr[0] for rr in rings][::-1])
        bm.faces.new([rr[-1] for rr in rings])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    centre(bm)
    return new_object(f'Bit{kind}', bm)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    obs = [rock(i) for i in range(4)] + [shard(i) for i in range(4)] + [bit(i) for i in range(3)]
    for i, ob in enumerate(obs):        # spread out so the .blend is readable; the game ignores it
        ob.location = ((i % 4) * 1.5, (i // 4) * 1.5, 0)
    bpy.ops.object.select_all(action='SELECT')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', use_selection=True, export_materials='NONE',
                              export_normals=True, export_texcoords=False, export_animations=False, export_yup=True)
    tris = sum(len(ob.data.polygons) for ob in obs)
    print(f'wrote {OUT}: {len(obs)} meshes, {tris} tris, {os.path.getsize(OUT) / 1024:.0f} KB')


if __name__ == '__main__':
    main()
