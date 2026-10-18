#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PAJZSUGRAS: turn a UT2004 map (.ut2) built from plain box brushes into a PAJZSUGRAS map file, for LOCAL use only.

    python -I pajzsugras/tools/ut2004_map.py <map.ut2> [--out DIR] [--name NAME] [--no-git-check]

Writes pajzsugras/local-maps/<name>.json: the editor's own document format (editor/model.js, v1), and keeps local-maps/index.json = { "v": 1, "maps": [files] }
up to date. The folder is git-ignored and never deployed, because the map is somebody else's work. The game (main.js, editor/local-maps.js) reads the index and
imports the maps by itself, but only when the page is served from this machine (localhost); by hand: main menu -> Szerkesztő -> Importálás (.json).
The .ut2 is only read, never run or modified (parse only; run it with python -I and pass the path as an argument). The output is written atomically,
and the run refuses to write into a folder that git would not ignore (unless --no-git-check). Standard library only; the package reader is ut2004_extract.py.

What is converted (a UT2004 level is a solid world that CSG brushes carve and fill, in the order of the Level's actor list):
  - the brushes with CsgOper Add / Subtract, replayed in that order on a grid made of all brush planes: every cell starts solid ("the rock"), a Subtract
    empties it, an Add makes it solid again (and remembers the brush). Only the part around the empty space is kept: the empty cells' bounding box + 64 UU
    (1.28 m) on every side, the rest of the rock is not built. The solid cells are merged greedily into boxes (z, then x, then y; same owner only) = blocks.
  - the PlayerStart (position, yaw) = the start; the first *FinishVolume = the finish box (its brush model's bounding box).
  - nothing else: pickups, weapon bases, lights, static meshes, emitters, start volumes ... are listed and left out. The textures are not ported:
    the blocks get the editor's own materials (see _material) and the theme 'kikepzes'.
Refused with a message that names the actor (the result would not play like the original): a brush that is not an axis aligned box, rotated or scaled
brushes, polygons that are not solid (NotSolid / Semisolid / Portal), Mover / JumpPad / Teleporter / TerrainInfo / BlockingVolume, a map without PlayerStart.

Units and axes: 50 UU = 1 m (as in ut2004_extract.py). UT is left handed, X forward, Y right, Z up; ours is three.js: Y up. (X, Y, Z)_UT -> (X, Z, Y) / 50.
A UT yaw (65536 = 360 deg, 0 = +X, turning towards +Y) is our yaw -90 - yaw deg (our yaw 0 looks along -z, -90 along +x).
The byte layouts follow UE Viewer's readers (UnModel.cpp / UnPoly) and were checked against DPM-HoppHopp.

Layout of this file: scene reader (actors, brush models, polys), CSG grid, document, command line.
"""
import argparse
import contextlib
import json
import math
import os
import re
import struct
import sys
import unicodedata
from array import array
from bisect import bisect_left
from collections import Counter, namedtuple
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # (python -I does not put the script folder on the path)
import ut2004_extract as X   # noqa: E402

OUT_MAPS = X.ROOT / 'local-maps'
UU = X.UU_PER_METRE
AXES = (0, 2, 1)                         # our (x, y, z) = UT (X, Z, Y) / 50
THEME = 'kikepzes'                       # the only theme the editor keeps (editor/themes.js)
NAME_LEN = 40                            # editor/model.js LIM.nameLen
PAD = 64                                 # UU kept around the empty space
FOOT_DROP = 44                           # PlayerStart location -> feet (xPawn: the hull's half height)
SNAP = 64                                # the start is put onto a solid top at most this far below its feet
SMALL = 128                              # an Add brush with all dimensions up to this is a 'trim' piece
THIN = 5                                 # a box thinner than this (UU) becomes the editor's smallest block (0.1 m)
EMPTY = 0xFFFF                           # grid cell value: empty; 0 = the rock, n = the solid of Add brush n - 1

# input limits
MAX_FILE = 64 * 1024 * 1024
MAX_ACTORS = 200_000
MAX_POLYS = 10_000
MAX_VERTS = 16
MAX_CELLS = 4_000_000                    # CSG grid cells
# the editor's limits (editor/model.js LIM, sim/trace.js CELL): a bigger document is refused by the importer
MAX_ITEMS = 2000
MAX_COORD = 1500.0
SIZE_MAX = 400.0
MAX_COLLISION_CELLS = 1_000_000
CELL = 8.0

POLY_NOT_SOLID, POLY_SEMISOLID, POLY_PORTAL = 0x08, 0x20, 0x04000000
CSG_ADD, CSG_SUB = 1, 2
DEVICE = re.compile(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9]|index)$')   # (Windows device names, as in tools/add-map.mjs; 'index': index.json is the list's own file)
INDEX_NAME = 'index.json'
MAP_FILE = re.compile(r'^[a-z0-9-]{1,24}\.json$')   # (the file names the game accepts from the index, editor/local-maps.js)
REFUSE_CLASSES = ('mover', 'jumppad', 'teleporter', 'terraininfo', 'blockingvolume')

Brush = namedtuple('Brush', 'name op lo hi mat')   # op 'add' | 'sub'; lo, hi: whole UU (X, Y, Z); mat: the lower-cased material names of its polygons


def refuse(actor, cls, why):
    raise X.ExtractError('A(z) „%s” (%s) objektum nem vihető át: %s.' % (actor, cls, why))


# ====================================================================================================================
# scene reader: the Level's actor list -> brushes in CSG order, PlayerStart, FinishVolume
# ====================================================================================================================
def _obj_name(pkg, i):
    if 0 < i <= len(pkg.exports):
        return pkg.exports[i - 1].name
    if i < 0 and -i <= len(pkg.imports):
        return pkg.imports[-i - 1].name
    return ''


def _actor_props(pkg, exp):
    return X.read_properties(pkg.reader(exp, state_frame=True), raw_structs=True)


def _bad_type(exp, key, what):
    refuse(exp.name, exp.cls, 'a(z) %s tulajdonság nem %s (hibás vagy idegen fájl)' % (key, what))


def _struct_prop(exp, props, key, name, fmt, default):
    """A struct property (raw_structs) decoded with `fmt`; the default when the actor does not carry it, a refusal when it is not that struct."""
    v = props.get(key)
    if v is None:
        return default
    if not (isinstance(v, tuple) and v[0] == name and len(v[1]) == struct.calcsize(fmt)):
        _bad_type(exp, key, '%s típusú' % name)
    return struct.unpack(fmt, v[1])


def _num_prop(exp, props, key, kinds, default, what):
    """A Byte / Int / Float property that must be one of the number types `kinds` (a tag of another type comes back as a tuple, bytes, a bool ...)."""
    v = props.get(key)
    if v is None:
        return default
    if isinstance(v, bool) or not isinstance(v, kinds):
        _bad_type(exp, key, what)
    return v


def _scale_is_identity(pkg, v):
    """MainScale / PostScale (struct Scale = tagged Scale vector, SheerRate, SheerAxis): True / False; None when it cannot be decoded."""
    if v is None:
        return True
    try:
        sub = X.read_properties(X.Reader(v[1], 0, pkg), raw_structs=True)
        scale = struct.unpack('<3f', sub['Scale'][1]) if 'Scale' in sub else (1.0, 1.0, 1.0)
        rate = sub.get('SheerRate') or 0.0
    except (X.ExtractError, struct.error, IndexError, KeyError, TypeError, ValueError):
        return None
    return all(abs(s - 1) < 1e-4 for s in scale) and abs(rate) < 1e-6


def _check_plain(pkg, exp, props, warns):
    """The actor must sit in the world as it is: no rotation, no scaling (it would not be a box any more)."""
    name, cls = exp.name, exp.cls
    if any(a % 65536 for a in _struct_prop(exp, props, 'Rotation', 'Rotator', '<3i', (0, 0, 0))):
        refuse(name, cls, 'el van forgatva (Rotation)')
    scale = _num_prop(exp, props, 'DrawScale', (int, float), 1, 'szám')
    if not abs(scale - 1) <= 1e-4:   # (written so that NaN is refused too)
        refuse(name, cls, 'át van méretezve (DrawScale)')
    if not all(abs(s - 1) <= 1e-4 for s in _struct_prop(exp, props, 'DrawScale3D', 'Vector', '<3f', (1.0, 1.0, 1.0))):
        refuse(name, cls, 'át van méretezve (DrawScale3D)')
    for key in ('MainScale', 'PostScale'):
        v = props.get(key)
        if v is not None and not (isinstance(v, tuple) and v[0] == 'Scale'):
            _bad_type(exp, key, 'Scale típusú')
        state = _scale_is_identity(pkg, v)
        if state is False:
            refuse(name, cls, 'át van méretezve (%s)' % key)
        if state is None:
            warns.append('A(z) „%s” %s értéke nem olvasható ki, az eredeti (nem méretezett) értéket feltételeztem.' % (name, key))


def _read_polys(pkg, polys_idx):
    """UPolys: props, DbNum i32, DbMax i32, then per FPoly: NumVertices idx, Base / Normal / TextureU / TextureV (4 vectors), Vertex[N], PolyFlags u32,
    Actor idx, Material idx, ItemName idx, iLink idx, iBrushPoly idx, LightMapScale f32. -> [(vertices, PolyFlags, lower-cased material name)]."""
    X.check(0 < polys_idx <= len(pkg.exports) and pkg.exports[polys_idx - 1].cls == 'Polys', 'a brush model does not point to a Polys object')
    r = pkg.reader(pkg.exports[polys_idx - 1], state_frame=True)
    X.read_properties(r)
    n = r.i32()
    r.i32()   # DbMax
    X.check(0 <= n <= MAX_POLYS, 'implausible polygon count %d' % n)
    out = []
    for _ in range(n):
        nv = r.idx()
        X.check(3 <= nv <= MAX_VERTS, 'a polygon with %d vertices' % nv)
        r.p += 48
        verts = [struct.unpack_from('<3f', r.b, r.p + 12 * k) for k in range(nv)]
        r.p += 12 * nv
        flags = r.u32()
        r.idx()   # Actor
        material = r.idx()
        r.idx(); r.idx(); r.idx()   # ItemName, iLink, iBrushPoly
        r.p += 4   # LightMapScale
        out.append((verts, flags, _obj_name(pkg, material).lower()))
    return out


def _brush_polys(pkg, exp, model_idx):
    """A brush's Model: props, UPrimitive BoundingBox (25 B) + BoundingSphere (16 B), five empty arrays (Vectors, Points, Nodes, Surfs, Verts),
    NumSharedSides i32, NumZones i32, then the Polys object."""
    if not (0 < model_idx <= len(pkg.exports) and pkg.exports[model_idx - 1].cls == 'Model'):
        refuse(exp.name, exp.cls, 'a Brush tulajdonsága nem Model objektum (hibás vagy idegen fájl)')
    r = pkg.reader(pkg.exports[model_idx - 1], state_frame=True)
    X.read_properties(r)
    r.p += 41
    counts = [r.idx() for _ in range(5)]
    r.i32()   # NumSharedSides
    zones = r.i32()
    if any(counts) or zones != 0:
        refuse(exp.name, exp.cls, 'a modellje már felépített BSP-t tartalmaz, nem egyszerű ecset')
    return _read_polys(pkg, r.idx())


def _box_bounds(polys, eps=0.01):
    """(lo, hi) of a brush that is an axis aligned box (6 quads, one on each face, every vertex a corner), else None."""
    if len(polys) != 6 or any(len(p[0]) != 4 for p in polys):
        return None
    verts = [v for p in polys for v in p[0]]
    lo = tuple(min(v[a] for v in verts) for a in range(3))
    hi = tuple(max(v[a] for v in verts) for a in range(3))
    if not all(math.isfinite(c) for c in lo + hi) or any(h - l < eps for l, h in zip(lo, hi)):
        return None
    faces = set()
    for vs, _flags, _mat in polys:
        if not all(any(abs(v[a] - b) < eps for b in (lo[a], hi[a])) for v in vs for a in range(3)):
            return None
        face = [(a, s) for a in range(3) for s, b in enumerate((lo[a], hi[a])) if all(abs(v[a] - b) < eps for v in vs)]
        if len(face) != 1:
            return None
        faces.add(face[0])
    return (lo, hi) if len(faces) == 6 else None


def _uu(x, what):
    """A float coordinate -> whole UU (the CSG works on integers)."""
    X.check(math.isfinite(x) and abs(x) < 1e7, '%s: unusable coordinate %r' % (what, x))
    return round(x)


def _read_brush(pkg, exp, props, op, warns):
    name, cls = exp.name, exp.cls
    _check_plain(pkg, exp, props, warns)
    model = props.get('Brush')
    X.check(isinstance(model, int), '%s has no brush model' % name)
    polys = _brush_polys(pkg, exp, model)
    flags = _num_prop(exp, props, 'PolyFlags', (int,), 0, 'egész szám')   # (the Add Special flags of UnrealEd: the build ORs them into every polygon)
    for p in polys:
        flags |= p[1]
    flags &= 0xFFFFFFFF
    if flags & (POLY_NOT_SOLID | POLY_SEMISOLID | POLY_PORTAL):
        refuse(name, cls, 'a lapjai nem tömörek (PolyFlags 0x%x: NotSolid / Semisolid / Portal)' % flags)
    box = _box_bounds(polys)
    if box is None:
        refuse(name, cls, 'nem tengelyirányú téglatest ecset (%d lap): csak a dobozokat tudom átvenni' % len(polys))
    loc = _struct_prop(exp, props, 'Location', 'Vector', '<3f', (0.0, 0.0, 0.0))
    pre = _struct_prop(exp, props, 'PrePivot', 'Vector', '<3f', (0.0, 0.0, 0.0))
    shift = [l - p for l, p in zip(loc, pre)]   # world = Location - PrePivot + local vertex
    world = [[box[s][a] + shift[a] for a in range(3)] for s in (0, 1)]
    lo = tuple(_uu(v, name) for v in world[0])
    hi = tuple(_uu(v, name) for v in world[1])
    if any(abs(v - round(v)) > 0.01 for w in world for v in w):
        warns.append('A(z) „%s” ecset határai nem egész UU-n vannak: egészre kerekítettem.' % name)
    X.check(all(l < h for l, h in zip(lo, hi)), '%s: the brush is thinner than 1 UU' % name)
    return Brush(name, 'add' if op == CSG_ADD else 'sub', lo, hi, ' '.join(sorted({p[2] for p in polys if p[2]})))


def _read_finish(pkg, exp, props, warns):
    """The FinishVolume's box: Location - PrePivot + its Model's bounding box (UPrimitive: Min vector, Max vector, IsValid byte, right after the props)."""
    _check_plain(pkg, exp, props, warns)
    model = props.get('Brush')
    X.check(isinstance(model, int) and 0 < model <= len(pkg.exports) and pkg.exports[model - 1].cls == 'Model', '%s has no brush model' % exp.name)
    r = pkg.reader(pkg.exports[model - 1], state_frame=True)
    X.read_properties(r)
    lo, hi, valid = r.vec(), r.vec(), r.u8()
    if valid != 1:
        warns.append('A(z) „%s” céltérfogat határolódoboza érvénytelen: cél nélkül készül a pálya.' % exp.name)
        return None
    loc = _struct_prop(exp, props, 'Location', 'Vector', '<3f', (0.0, 0.0, 0.0))
    pre = _struct_prop(exp, props, 'PrePivot', 'Vector', '<3f', (0.0, 0.0, 0.0))
    shift = [l - p for l, p in zip(loc, pre)]
    return (tuple(lo[a] + shift[a] for a in range(3)), tuple(hi[a] + shift[a] for a in range(3)))


def read_map(path):
    """The .ut2 -> a scene: { brushes (Add / Subtract, Level order), start: { loc (UU), yaw (UT units) }, finish: (lo, hi) in UU or None,
    skipped: Counter of the classes left out, warnings: [text] }. Raises ExtractError (Hungarian text for a map that cannot be ported)."""
    path = Path(path)
    X.check(path.is_file(), '%s nem fájl' % path)
    X.check(path.stat().st_size <= MAX_FILE, 'A fájl túl nagy (%d MB, a határ %d MB).' % (path.stat().st_size >> 20, MAX_FILE >> 20))
    pkg = X.Package(path)
    with X.damaged(path, 'the map'):
        return _read_scene(pkg)


def _read_scene(pkg):
    levels = [e for e in pkg.exports if e.cls == 'Level']
    X.check(len(levels) == 1, 'Ez nem pálya: a csomagban nincs (pontosan egy) Level objektum.')
    r = pkg.reader(levels[0], state_frame=True)
    X.read_properties(r)
    num = r.i32()
    r.i32()   # Max
    X.check(0 <= num <= MAX_ACTORS and num <= len(pkg.data) - r.p, 'implausible actor count %d' % num)
    refs = [r.idx() for _ in range(num)]   # the actor list = the order the CSG brushes are applied in
    brushes, skipped, warns = [], Counter(), []
    start, finish, finish_seen = None, None, False
    seen, repeated = set(), False
    for ref in refs:
        if not 0 < ref <= len(pkg.exports):
            continue
        if ref in seen:
            repeated = True   # (a crafted list could repeat one big actor many times: each is read once)
            continue
        seen.add(ref)
        exp = pkg.exports[ref - 1]
        cls, low = exp.cls, exp.cls.lower()
        if cls == 'Brush':
            props = _actor_props(pkg, exp)
            op = _num_prop(exp, props, 'CsgOper', (int,), 0, 'egész szám')
            if not op:
                skipped['Brush (építő ecset)'] += 1   # no CsgOper: the editor's builder brush
            elif op not in (CSG_ADD, CSG_SUB):
                refuse(exp.name, cls, 'ismeretlen CSG művelet (%d): csak az összeadó és a kivonó ecset támogatott' % op)
            else:
                brushes.append(_read_brush(pkg, exp, props, op, warns))
        elif any(w in low for w in REFUSE_CLASSES):
            refuse(exp.name, cls, 'az ilyen elemet a szerkesztő nem ismeri, nélküle más lenne a pálya')
        elif 'finishvolume' in low and not finish_seen:
            finish_seen = True
            finish = _read_finish(pkg, exp, _actor_props(pkg, exp), warns)
        elif low.endswith('playerstart') and start is None:
            props = _actor_props(pkg, exp)
            rot = _struct_prop(exp, props, 'Rotation', 'Rotator', '<3i', (0, 0, 0))
            start = {'loc': _struct_prop(exp, props, 'Location', 'Vector', '<3f', (0.0, 0.0, 0.0)), 'yaw': rot[1]}
        else:
            if low.endswith('playerstart'):
                warns.append('Több PlayerStart is van: az elsőt használom.')
            skipped[cls] += 1
    if repeated:
        warns.append('A Level actorlistája ismétlődő bejegyzéseket tartalmaz: mindegyik objektumot egyszer vettem figyelembe.')
    if start is None:
        raise X.ExtractError('A pályán nincs PlayerStart (rajtpont), nincs honnan indulni.')
    if not finish_seen:
        warns.append('A pályán nincs FinishVolume: cél nélkül készül (a szerkesztőben kell egy célt tenni rá).')
    return {'brushes': brushes, 'start': start, 'finish': finish, 'skipped': skipped, 'warnings': warns}


# ====================================================================================================================
# CSG: replay the brushes on a grid of all their planes, merge the solid cells into boxes
# ====================================================================================================================
def _planes(brushes, lo, hi):
    """Sorted plane coordinates per axis: every brush bound inside [lo, hi] plus lo and hi themselves."""
    out = []
    for a in range(3):
        s = {lo[a], hi[a]}
        for b in brushes:
            for v in (b.lo[a], b.hi[a]):
                if lo[a] <= v <= hi[a]:
                    s.add(v)
        out.append(sorted(s))
    return out


def _grid_check(planes):
    n = 1
    for p in planes:
        n *= len(p) - 1
    X.check(n <= MAX_CELLS, 'A pálya túl bonyolult az átalakításhoz (%d rácscella, a határ %d).' % (n, MAX_CELLS))


def _classify(brushes, planes):
    """The cell values of the grid (x-major, z fastest: cell (i, j, k) at (i * ny + j) * nz + k): the brushes applied in order on the solid world."""
    nx, ny, nz = (len(p) - 1 for p in planes)
    cells = array('H', bytes(2 * nx * ny * nz))
    for bi, b in enumerate(brushes):
        rng = []
        for a in range(3):
            p = planes[a]
            lo, hi = max(b.lo[a], p[0]), min(b.hi[a], p[-1])
            if lo >= hi:
                break
            rng.append((bisect_left(p, lo), bisect_left(p, hi)))
        else:
            (i0, i1), (j0, j1), (k0, k1) = rng
            fill = array('H', [EMPTY if b.op == 'sub' else bi + 1]) * (k1 - k0)
            for i in range(i0, i1):
                for j in range(j0, j1):
                    s = (i * ny + j) * nz
                    cells[s + k0:s + k1] = fill
    return cells


def _empty_bounds(cells, planes):
    """(lo, hi) of the empty cells in UU, or None when nothing is empty."""
    nx, ny, nz = (len(p) - 1 for p in planes)
    lo = [None] * 3
    hi = [None] * 3

    def grow(a, first, last):   # (cell indices: last is exclusive)
        lo[a] = first if lo[a] is None else min(lo[a], first)
        hi[a] = last if hi[a] is None else max(hi[a], last)
    for i in range(nx):
        for j in range(ny):
            s = (i * ny + j) * nz
            row = cells[s:s + nz]
            if EMPTY not in row:
                continue
            grow(0, i, i + 1)
            grow(1, j, j + 1)
            grow(2, row.index(EMPTY), nz - row[::-1].index(EMPTY))
    if lo[0] is None:
        return None
    return tuple(planes[a][lo[a]] for a in range(3)), tuple(planes[a][hi[a]] for a in range(3))


def _merge(cells, planes):
    """Greedy boxes of equal solid cells: from the first free solid cell extend along z, then x, then y. -> [(lo, hi, owner)], owner -1 = the rock,
    else the index of the Add brush."""
    nx, ny, nz = (len(p) - 1 for p in planes)
    seen = bytearray(len(cells))
    boxes = []

    def free(i, j, k0, k1, o):
        s = (i * ny + j) * nz
        return cells[s + k0:s + k1].count(o) == k1 - k0 and not any(seen[s + k0:s + k1])
    for i in range(nx):
        for j in range(ny):
            base = (i * ny + j) * nz
            k = 0
            while k < nz:
                o = cells[base + k]
                if o == EMPTY or seen[base + k]:
                    k += 1
                    continue
                k1 = k + 1
                while k1 < nz and cells[base + k1] == o and not seen[base + k1]:
                    k1 += 1
                i1 = i + 1
                while i1 < nx and free(i1, j, k, k1, o):
                    i1 += 1
                j1 = j + 1
                while j1 < ny and all(free(ii, j1, k, k1, o) for ii in range(i, i1)):
                    j1 += 1
                ones = b'\x01' * (k1 - k)
                for ii in range(i, i1):
                    for jj in range(j, j1):
                        s = (ii * ny + jj) * nz
                        seen[s + k:s + k1] = ones
                boxes.append(((planes[0][i], planes[1][j], planes[2][k]), (planes[0][i1], planes[1][j1], planes[2][k1]), o - 1))
                k = k1
    return boxes


def csg_boxes(brushes, pad=PAD):
    """Brush list (Level order; ints, lo < hi) -> the solid space around the empty space as boxes [(lo, hi, owner)] (UU, UT axes).
    Pass 1 finds the bounding box of the empty space on a grid of all brush planes; pass 2 replays the brushes on a grid refined by that box
    +- pad, clipped to it, so the rock is only built `pad` UU thick."""
    X.check(brushes, 'A pályán nincs CSG ecset (összeadó / kivonó), nincs mit átvenni.')
    X.check(len(brushes) < EMPTY - 1, 'Túl sok ecset (%d).' % len(brushes))
    for b in brushes:
        X.check(all(l < h for l, h in zip(b.lo, b.hi)), '%s: empty brush' % b.name)
    lo = tuple(min(b.lo[a] for b in brushes) for a in range(3))
    hi = tuple(max(b.hi[a] for b in brushes) for a in range(3))
    planes = _planes(brushes, lo, hi)
    _grid_check(planes)
    empty = _empty_bounds(_classify(brushes, planes), planes)
    X.check(empty is not None, 'A pályán nincs üres tér (nincs kivonó ecset, vagy az összeadók mindent kitöltenek), nincs mit járni.')
    lo = tuple(v - pad for v in empty[0])
    hi = tuple(v + pad for v in empty[1])
    planes = _planes(brushes, lo, hi)
    _grid_check(planes)
    return _merge(_classify(brushes, planes), planes)


# ====================================================================================================================
# document (editor/model.js v1)
# ====================================================================================================================
def r2(v):
    """Round to 0.01 like the editor; a whole number is written as an int (JSON "24", not "24.0": the same text the editor's own export gives)."""
    v = round(v, 2) + 0.0   # (+ 0.0 turns -0.0 into 0.0)
    return int(v) if v == int(v) else v


def _material(brushes, lo, hi, owner):
    """The editor material of a box (the textures are not ported): a brush with a grate texture -> grate; a small added piece (all dimensions up to
    128 UU, e.g. the steps) -> trim; any other added solid -> metal; the rock -> wall when the box is taller than it is wide, else floor."""
    if owner >= 0:
        b = brushes[owner]
        if 'grate' in b.mat:
            return 'grate'
        return 'trim' if all(h - l <= SMALL for l, h in zip(b.lo, b.hi)) else 'metal'
    return 'wall' if hi[2] - lo[2] > min(hi[0] - lo[0], hi[1] - lo[1]) else 'floor'


def _block(lo, hi):
    """UT box -> our centre + size in metres (a box thinner than 5 UU becomes 0.1 m around its middle)."""
    c = [r2((lo[a] + hi[a]) / (2 * UU)) for a in AXES]
    size = [0.1 if hi[a] - lo[a] < THIN else r2((hi[a] - lo[a]) / UU) for a in AXES]
    return c, size


def _start_pos(start, boxes):
    """The feet position (our axes) of a PlayerStart: 44 UU under its location. A start that begins inside a solid (a PlayerStart less than 44 UU above the
    floor) is lifted onto the top of it, when that is at most 44 UU up; then the feet are put onto the highest solid top below if that is within 64 UU."""
    px, py, pz = start['loc']
    feet0 = feet = pz - FOOT_DROP
    column = [(lo[2], hi[2]) for lo, hi, _o in boxes if lo[0] <= px <= hi[0] and lo[1] <= py <= hi[1]]
    while True:   # (solids stacked on each other: out of every one, together at most 44 UU up)
        up = [hi for lo, hi in column if lo < feet + 1 < hi <= feet0 + FOOT_DROP]
        if not up:
            break
        feet = max(up)
    tops = [hi for _lo, hi in column if hi <= feet + 1]
    if tops and feet - max(tops) <= SNAP:
        feet = max(tops)
    return [r2(px / UU), r2(feet / UU), r2(py / UU)]


def _collision_cells(items):
    """What editor/model.js docCells counts: the 8 m cells that the solid blocks touch."""
    n = 0
    for it in items:
        if it['t'] != 'block':
            continue
        k = 1
        for c, s in zip(it['c'], it['size']):
            k *= math.floor((c + s / 2) / CELL) - math.floor((c - s / 2) / CELL) + 1
        n += k
    return n


def clean_name(name):
    """The name the way the editor's cleanText (editor/model.js, text.js stripText) leaves it, so importDoc keeps it as it is: no C0 / DEL / C1 controls,
    no U+2028 / 2029, no bidi controls, no < >, trimmed (JavaScript's trim: also U+FEFF), at most 40 UTF-16 units (an astral character counts 2)."""
    name = re.sub('[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069<>]', '', name)
    name = re.sub(r'^[\s\ufeff]+|[\s\ufeff]+$', '', name)
    out, units = [], 0
    for ch in name:
        units += 2 if ord(ch) > 0xFFFF else 1
        if units > NAME_LEN:
            break
        out.append(ch)
    return ''.join(out) or 'Névtelen pálya'


def slug(name):
    """The map id and the output file name: lower case letters and digits in groups; a Windows device name (con.json is no file there) or 'index' (the list's own file) gets '-palya'."""
    s = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode('ascii').lower()
    s = re.sub(r'[^a-z0-9]+', '-', s).strip('-')[:24].strip('-') or 'palya'
    return s + '-palya' if DEVICE.match(s) else s


def default_name(path):
    """DPM-HoppHopp-v35-r1.ut2 -> HoppHopp (the game-type prefix and the version suffix cut off)."""
    stem = Path(path).stem
    cut = re.sub(r'-v\d.*$', '', re.sub(r'^[A-Za-z0-9]+-', '', stem, count=1)).strip()
    return cut or stem


def build_doc(scene, name):
    """scene (read_map) -> (editor document, info). info: { blocks, mats (Counter), start (our feet), finish (c, size) | None, warnings }."""
    brushes = scene['brushes']
    boxes = csg_boxes(brushes)
    warnings = list(scene['warnings'])
    name = clean_name(name)
    items, mats = [], Counter()
    for lo, hi, owner in boxes:
        mat = _material(brushes, lo, hi, owner)
        c, size = _block(lo, hi)
        items.append({'id': len(items) + 1, 't': 'block', 'c': c, 'size': size, 'yaw': 0, 'mat': mat})
        mats[mat] += 1
    finish = None
    if scene['finish'] is not None:
        X.check(all(abs(v) / UU <= MAX_COORD for v in scene['finish'][0] + scene['finish'][1]),
                'A cél a szerkesztő határain kívül van (a határ: 1500 m a középtől).')   # (written so that NaN / inf are refused too)
        c, size = _block(*scene['finish'])
        finish = (c, size)
        items.append({'id': len(items) + 1, 't': 'finish', 'c': c, 'size': size})
    X.check(len(items) <= MAX_ITEMS, 'A pálya túl sok tömbből áll (%d, a határ %d).' % (len(items), MAX_ITEMS))
    for it in items:
        X.check(all(abs(c) + s / 2 <= MAX_COORD for c, s in zip(it['c'], it['size'])) and all(s <= SIZE_MAX for s in it['size']),
                'A pálya túl nagy a szerkesztőhöz (a határ: 1500 m a középtől, 400 m egy tömb).')
    cells = _collision_cells(items)
    X.check(cells <= MAX_COLLISION_CELLS, 'A pálya túl nagy az ütközési rácshoz (%d cella, a határ %d).' % (cells, MAX_COLLISION_CELLS))
    X.check(all(abs(v) / UU <= MAX_COORD for v in scene['start']['loc']), 'A rajtpont a szerkesztő határain kívül van (a határ: 1500 m a középtől).')
    pos = _start_pos(scene['start'], boxes)
    X.check(all(abs(v) <= MAX_COORD for v in pos), 'A rajtpont a szerkesztő határain kívül van (a határ: 1500 m a középtől).')
    yaw = r2((-90 - scene['start']['yaw'] * 360 / 65536) % 360)
    doc = {
        'v': 1, 'id': slug(name), 'name': name, 'theme': THEME,
        'start': {'pos': pos, 'yaw': yaw},
        'items': items, 'nextId': len(items) + 1,
        'cam': {'pos': [pos[0], r2(pos[1] + 2), pos[2]], 'yaw': yaw, 'pitch': -20},
        'created': 0, 'updated': 0,
    }
    return doc, {'blocks': len(boxes), 'mats': mats, 'start': pos, 'finish': finish, 'warnings': warnings}


# ====================================================================================================================
# command line
# ====================================================================================================================
def write_index(out_dir, written):
    """(Re)write out_dir/index.json = { "v": 1, "maps": [file names] }: the files of the old index (when it is readable) plus `written`, sorted, unique, only the
    names the game accepts that exist in out_dir. The folder was checked for git-ignore by main() before anything was written. -> the list."""
    old = []
    try:
        data = json.loads((out_dir / INDEX_NAME).read_text(encoding='utf-8'))
        if isinstance(data, dict) and isinstance(data.get('maps'), list):
            old = data['maps']
    except (OSError, ValueError):
        pass   # (no index yet, or a damaged one: it is built again from `written`)
    names = sorted({n for n in [*old, written] if isinstance(n, str) and n != INDEX_NAME and MAP_FILE.match(n) and (out_dir / n).is_file()})
    X.write_atomic(out_dir / INDEX_NAME, (json.dumps({'v': 1, 'maps': names}, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))
    return names


def report(doc, info, scene, path, log=print):
    log('%s -> %s' % (doc['name'], path))
    log('  %d tömb (%s)' % (info['blocks'], ', '.join('%s %d' % (m, n) for m, n in sorted(info['mats'].items()))))
    log('  Rajt: láb (%g, %g, %g) m, irány %g fok' % (*info['start'], doc['start']['yaw']))
    if info['finish'] is None:
        log('  Cél: nincs')
    else:
        log('  Cél: közép (%g, %g, %g) m, méret (%g, %g, %g) m' % (*info['finish'][0], *info['finish'][1]))
    if scene['skipped']:
        log('  Kihagyott objektumok: %s' % ', '.join('%s x%d' % (c, n) for c, n in sorted(scene['skipped'].items())))
    for w in info['warnings']:
        log('  FIGYELEM: %s' % w)
    log('Betöltés: ha a játék ezen a gépen fut (localhost), a pálya magától megjelenik a saját pályáid között (újraindítás / frissítés után).')
    log('Kézzel: játék főmenü -> Szerkesztő -> Importálás (.json) -> válaszd ki ezt a fájlt.')


def main(argv=None):
    ap = argparse.ArgumentParser(description='Turn a UT2004 map made of box brushes into a PAJZSUGRAS map file (editor JSON) in the git-ignored local-maps/ folder.')
    ap.add_argument('map', help='the .ut2 file (read only)')
    ap.add_argument('--out', help='output folder (default: pajzsugras/local-maps)')
    ap.add_argument('--name', help='the map\'s name in the game (default: the file name without its game-type prefix and version suffix)')
    ap.add_argument('--no-git-check', action='store_true', help='write even if the output folder is not git-ignored')
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(AttributeError, ValueError):
            stream.reconfigure(errors='replace')
    try:
        out_dir = Path(args.out).resolve() if args.out else OUT_MAPS
        if not args.no_git_check:
            X.require_git_ignored(out_dir)
        scene = read_map(args.map)
        doc, info = build_doc(scene, args.name or default_name(args.map))
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / (doc['id'] + '.json')
        X.write_atomic(path, (json.dumps(doc, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))
        write_index(out_dir, path.name)
        report(doc, info, scene, path)
    except (X.ExtractError, struct.error, IndexError, OSError) as e:
        print('ut2004_map: %s' % e, file=sys.stderr)
        return 1
    except (ValueError, ArithmeticError, TypeError, KeyError) as e:   # (NaN / Inf, an absurd number or a value of an unexpected type out of a corrupt file)
        print('ut2004_map: the file holds data that cannot be used (%s: %s)' % (type(e).__name__, e), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
