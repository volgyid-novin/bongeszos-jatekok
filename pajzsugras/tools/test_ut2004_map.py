#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests of pajzsugras/tools/ut2004_map.py (UT2004 .ut2 box-brush map -> editor map document).   python -I pajzsugras/tools/test_ut2004_map.py

Synthetic cases build their own tiny UT2004-like packages in code (Level actor list, brushes with RF_HasStack state frames, brush Model + Polys,
PlayerStart, FinishVolume): no Epic or third-party data lives in the repository. Everything is written into temporary folders; the real default output
folder pajzsugras/local-maps/ is never touched (git is only asked about it). Cases:
  - csg_boxes on small fixtures against a brute-force replay of the brushes (voxel by voxel), the document numbers, the axis / yaw mapping;
  - a synthetic .ut2 end to end (read_map, build_doc, the command line), the refusals, junk / cut off / corrupt files, the git-ignore guard;
  - a cross-check in node (needs `node`): the editor's own importDoc leaves the file unchanged, toDef(doc).def.build() works, the player can stand
    at the start, the start looks the way the PlayerStart looked (test_ut2004_map_check.mjs);
  - test_BUG_* reproduce bugs found while testing: they fail until the bug is fixed (their docstrings say where the cause is);
  - the real DPM-HoppHopp map, ONLY when the environment variable PJ_UT2_MAP points at the .ut2 (no personal path lives in the repository). The file is
    only read; the result goes into a temporary folder.
"""
import contextlib
import hashlib
import io
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # (python -I does not put the script folder on the path)
import ut2004_extract as X   # noqa: E402
import ut2004_map as M   # noqa: E402
from test_ut2004_extract import build_package   # noqa: E402  (the same synthetic package writer; only the function is imported: no TestCase of that file runs here)

TOOLS = Path(__file__).resolve().parent
REPO = X.ROOT.parent
UU = X.UU_PER_METRE
REAL_MAP = os.environ.get('PJ_UT2_MAP')
NODE = shutil.which('node')


# ---------------------------------------------------------------------------------------------------------------------
# a tiny UT2004 package writer: names / imports / exports through build_package, actors with a state frame, tagged properties
# ---------------------------------------------------------------------------------------------------------------------
def box_quads(lo, hi):
    """The six faces of an axis aligned box, one quad each (every vertex a corner)."""
    (x0, y0, z0), (x1, y1, z1) = lo, hi
    return [
        [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)],
        [(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)],
        [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)],
        [(x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0)],
        [(x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0)],
        [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)],
    ]


class Ut2:
    """Collects names, imports and exports; data() is the package file. Object indices (what a Level actor list and the Brush property hold) are
    1 + the export number; an import is -(1 + its number)."""

    def __init__(self):
        self.names = ['None', 'Core', 'Class', 'Engine']
        self.imports, self.exports, self._cls = [], [], {}

    def n(self, s):
        if s not in self.names:
            self.names.append(s)
        return self.names.index(s)

    def imp(self, cls, name, pkg='Engine'):
        self.imports.append((self.n(pkg), self.n(cls), 0, self.n(name)))
        return -len(self.imports)

    def klass(self, name):
        if name not in self._cls:
            self._cls[name] = self.imp('Class', name)
        return self._cls[name]

    def export(self, cls, name, payload, flags=0):
        self.exports.append((self.klass(cls), 0, self.n(name), flags, payload))
        return len(self.exports)

    # -- tagged properties (size code 5: one size byte follows every tag; enough for all of these)
    def tag(self, name, typ, payload=b'', struct_name=None):
        out = X.encode_index(self.n(name)) + bytes([typ | 0x50])
        if typ == 10:
            out += X.encode_index(self.n(struct_name))
        return out + bytes([len(payload)]) + payload

    def props(self, *tags):
        return b''.join(tags) + X.encode_index(0)

    def byte(self, name, v):
        return self.tag(name, 1, bytes([v]))

    def flt(self, name, v):
        return self.tag(name, 4, struct.pack('<f', v))

    def obj(self, name, idx):
        return self.tag(name, 5, X.encode_index(idx))

    def vector(self, name, v):
        return self.tag(name, 10, struct.pack('<3f', *v), 'Vector')

    def rotator(self, name, v):
        return self.tag(name, 10, struct.pack('<3i', *v), 'Rotator')

    def scale(self, name, scale=(1.0, 1.0, 1.0), sheer=0.0):
        """MainScale / PostScale: a struct Scale = a tagged Scale vector, SheerRate ... None."""
        return self.tag(name, 10, self.tag('Scale', 10, struct.pack('<3f', *scale), 'Vector') + self.tag('SheerRate', 4, struct.pack('<f', sheer)) + X.encode_index(0), 'Scale')

    # -- objects
    def actor(self, cls, name, *tags):
        """An actor carries a state frame (RF_HasStack): Node idx, StateNode idx, ProbeMask u64, LatentAction i32 - then its properties."""
        return self.export(cls, name, X.encode_index(0) * 2 + bytes(12) + self.props(*tags), X.RF_HAS_STACK)

    def polys(self, name, polys):
        """polys: [(vertices, PolyFlags, material object index)]"""
        body = self.props() + struct.pack('<ii', len(polys), len(polys))
        for verts, flags, material in polys:
            body += (X.encode_index(len(verts)) + bytes(48) + b''.join(struct.pack('<3f', *v) for v in verts) + struct.pack('<I', flags)
                     + X.encode_index(0) + X.encode_index(material) + X.encode_index(0) * 3 + bytes(4))
        return self.export('Polys', name, body)

    def model(self, name, polys_idx, bbox=((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), 1)):
        """A brush Model: props, UPrimitive BoundingBox (Min, Max, IsValid = 25 B) + BoundingSphere (16 B), five empty arrays, NumSharedSides, NumZones, Polys."""
        lo, hi, valid = bbox
        body = (self.props() + struct.pack('<3f', *lo) + struct.pack('<3f', *hi) + bytes([valid]) + bytes(16)
                + X.encode_index(0) * 5 + struct.pack('<ii', 0, 0) + X.encode_index(polys_idx))
        return self.export('Model', name, body)

    def brush(self, name, op, lo, hi, loc=None, pre=(0.0, 0.0, 0.0), polys=None, flags=0, material=0, tags=()):
        """A Brush actor holding the box lo..hi (world UU). world vertex = Location - PrePivot + local vertex. op 0: no CsgOper (the builder brush)."""
        if loc is None:
            loc = tuple((a + b) / 2 for a, b in zip(lo, hi))
        shift = [l - p for l, p in zip(loc, pre)]
        if polys is None:
            polys = [(q, flags, material) for q in box_quads([a - s for a, s in zip(lo, shift)], [b - s for b, s in zip(hi, shift)])]
        model = self.model('Model_' + name, self.polys('Polys_' + name, polys))
        t = [self.byte('CsgOper', op)] if op else []
        t += [self.obj('Brush', model), self.vector('Location', loc)]
        if any(pre):
            t.append(self.vector('PrePivot', pre))
        return self.actor('Brush', name, *t, *tags)

    def volume(self, cls, name, loc, bb_lo, bb_hi, valid=1):
        """A volume whose Model carries only the bounding box that matters (the converter reads nothing else of it)."""
        model = self.model('Model_' + name, 0, (bb_lo, bb_hi, valid))
        return self.actor(cls, name, self.obj('Brush', model), self.vector('Location', loc))

    def level(self, refs):
        return self.export('Level', 'myLevel', self.props() + struct.pack('<ii', len(refs), len(refs)) + b''.join(X.encode_index(r) for r in refs))

    def data(self):
        return build_package(self.names, self.imports, self.exports, ver=128)


# the standard fixture: a 10.24 m room with a pillar and a trim step; everything is a multiple of 32 UU
ROOM = ((-256, -256, 0), (256, 256, 256))
PILLAR = ((-64, -64, 0), (64, 64, 192))
STEP = ((192, -256, 0), (256, -192, 32))
TINY_BRUSHES = [M.Brush('Brush2', 'sub', *ROOM, ''), M.Brush('Brush3', 'add', *PILLAR, 'grateshader'), M.Brush('Brush4', 'add', *STEP, '')]
FINISH_BOX = ((-32.0, 160.0, 0.0), (32.0, 224.0, 96.0))   # = FinishVolume Location (0, 192, 48) + its model's bounding box +-(32, 32, 48)


def tapered(lo, hi, inset=8):
    """Six quads, but the top face is smaller than the bottom: not a box (every vertex of the top is off the bounding box in x and y)."""
    quads = box_quads(lo, hi)
    (x0, y0, _z0), (x1, y1, z1) = lo, hi
    quads[5] = [(x0 + inset, y0 + inset, z1), (x1 - inset, y0 + inset, z1), (x1 - inset, y1 - inset, z1), (x0 + inset, y1 - inset, z1)]
    return [(q, 0, 0) for q in quads]


def tiny_map(*, yaw=-432, start=True, start_loc=(50.0, -200.0, 46.0), finish=True, step_tags=None, step_polys=None, step_flags=0, extra=None):
    """The standard fixture as package bytes. Level order: builder brush, room (subtract), pillar (add, grate texture), step (add, with a PrePivot), PlayerStart,
    FinishVolume, two static meshes, a light, a health pack. step_*: variations of the step brush; extra(pk, refs): more actors."""
    pk = Ut2()
    grate = pk.imp('Shader', 'GrateShader')
    refs = [pk.brush('Brush1', 0, (-64, -64, -64), (64, 64, 64)),
            pk.brush('Brush2', M.CSG_SUB, *ROOM),
            pk.brush('Brush3', M.CSG_ADD, *PILLAR, material=grate),
            pk.brush('Brush4', M.CSG_ADD, *STEP, loc=(229.0, -224.0, 16.0), pre=(5.0, 0.0, 0.0), flags=step_flags,
                     polys=step_polys(*STEP) if step_polys else None, tags=step_tags(pk) if step_tags else ())]
    if start:
        refs.append(pk.actor('xPlayerStart', 'PlayerStart0', pk.vector('Location', start_loc), pk.rotator('Rotation', (0, yaw, 0))))
    if finish:
        refs.append(pk.volume('FinishVolume', 'FinishVolume0', (0.0, 192.0, 48.0), (-32.0, -32.0, -48.0), (32.0, 32.0, 48.0)))
    refs += [pk.actor('StaticMeshActor', 'StaticMeshActor0'), pk.actor('StaticMeshActor', 'StaticMeshActor1'), pk.actor('Light', 'Light0'), pk.actor('MiniHealthPack', 'MiniHealthPack0')]
    if extra:
        extra(pk, refs)
    pk.level(refs)
    return pk.data()


# ---------------------------------------------------------------------------------------------------------------------
# the oracle: replay the brushes voxel by voxel, the way UnrealEd does (the world is solid, Subtract empties, Add fills, in order)
# ---------------------------------------------------------------------------------------------------------------------
def ut_state(brushes, p):
    """None = empty, -1 = the rock (the default solid world), n = solid of the Add brush n."""
    s = -1
    for i, b in enumerate(brushes):
        if all(b.lo[a] <= p[a] < b.hi[a] for a in range(3)):
            s = None if b.op == 'sub' else i
    return s


def assert_exact(tc, brushes, boxes, vox, pad=M.PAD):
    """`boxes` ([(lo, hi, owner)], UU, UT axes) never overlap and cover exactly the solid voxels of the replayed brushes inside (the bounds of the empty
    space +- pad), each with the owner of the voxel. Every brush coordinate and pad is a multiple of vox."""
    coords = [c for b in brushes for c in b.lo + b.hi]
    rng = range(min(coords), max(coords), vox)
    centre = lambda x, y, z: (x + vox / 2, y + vox / 2, z + vox / 2)   # noqa: E731
    empties = [(x, y, z) for x in rng for y in rng for z in rng if ut_state(brushes, centre(x, y, z)) is None]
    tc.assertTrue(empties, 'the fixture has no empty space')
    rlo = [min(e[a] for e in empties) - pad for a in range(3)]
    rhi = [max(e[a] for e in empties) + vox + pad for a in range(3)]
    cover = {}
    for lo, hi, owner in boxes:
        tc.assertTrue(all(l < h for l, h in zip(lo, hi)), 'an empty box %r' % ((lo, hi),))
        tc.assertTrue(all(c % vox == 0 for c in lo + hi), 'a box off the grid %r' % ((lo, hi),))
        for x in range(lo[0], hi[0], vox):
            for y in range(lo[1], hi[1], vox):
                for z in range(lo[2], hi[2], vox):
                    tc.assertNotIn((x, y, z), cover, 'two boxes overlap at %r' % ((x, y, z),))
                    cover[(x, y, z)] = owner
    expect = {}
    for x in range(rlo[0], rhi[0], vox):
        for y in range(rlo[1], rhi[1], vox):
            for z in range(rlo[2], rhi[2], vox):
                s = ut_state(brushes, centre(x, y, z))
                if s is not None:
                    expect[(x, y, z)] = s
    missing, extra = sorted(expect.keys() - cover.keys()), sorted(cover.keys() - expect.keys())
    tc.assertEqual((missing[:3], extra[:3]), ([], []), 'solid voxels not built / voxels built that are empty or outside the kept region')
    wrong = [k for k in expect if expect[k] != cover[k]]
    tc.assertEqual(wrong[:3], [], 'voxels with the wrong owner')
    return cover


def doc_boxes(doc, owner_of_mat):
    """The blocks of a document back in UU and UT axes (our (x, y, z) = UT (X, Z, Y) / 50): [(lo, hi, owner)]."""
    out = []
    for it in doc['items']:
        if it['t'] != 'block':
            continue
        c, s = it['c'], it['size']
        lo = (c[0] - s[0] / 2, c[2] - s[2] / 2, c[1] - s[1] / 2)
        hi = (c[0] + s[0] / 2, c[2] + s[2] / 2, c[1] + s[1] / 2)
        out.append((tuple(round(v * UU) for v in lo), tuple(round(v * UU) for v in hi), owner_of_mat[it['mat']]))
    return out


def scene_of(brushes, loc=(0.0, 0.0, 44.0), yaw=0, finish=None):
    return {'brushes': brushes, 'start': {'loc': loc, 'yaw': yaw}, 'finish': finish, 'skipped': Counter(), 'warnings': []}


def B(name, op, lo, hi, mat=''):
    return M.Brush(name, op, tuple(lo), tuple(hi), mat)


# ---------------------------------------------------------------------------------------------------------------------
# the CSG
# ---------------------------------------------------------------------------------------------------------------------
class TestCsgBoxes(unittest.TestCase):
    def test_a_room_minus_nothing_is_a_shell_of_rock_64_uu_thick(self):
        brushes = [B('room', 'sub', (0, 0, 0), (128, 128, 64))]
        boxes = M.csg_boxes(brushes)
        assert_exact(self, brushes, boxes, 16)
        self.assertEqual({o for _lo, _hi, o in boxes}, {-1}, 'only the rock')
        self.assertEqual((min(b[0][0] for b in boxes), max(b[1][0] for b in boxes)), (-64, 192), 'the rock is kept 64 UU around the room, not further')
        self.assertEqual((min(b[0][2] for b in boxes), max(b[1][2] for b in boxes)), (-64, 128))
        self.assertLessEqual(len(boxes), 8, 'the 26 grid cells of the shell are merged into a few boxes')

    def test_a_room_with_an_add_box_inside_keeps_the_box_as_its_own_solid(self):
        brushes = [B('room', 'sub', (0, 0, 0), (160, 160, 96)), B('pillar', 'add', (32, 32, 0), (96, 96, 64))]
        boxes = M.csg_boxes(brushes)
        assert_exact(self, brushes, boxes, 16)
        self.assertEqual([(lo, hi) for lo, hi, o in boxes if o == 1], [((32, 32, 0), (96, 96, 64))], 'the added box comes out whole, with its brush as owner')

    def test_the_order_of_the_brushes_matters(self):
        room, a, b = B('room', 'sub', (0, 0, 0), (128, 128, 128)), B('A', 'add', (32, 32, 32), (96, 96, 96)), B('B', 'sub', (48, 48, 48), (80, 80, 80))
        for order, solid_at_centre in (([room, a, b], False), ([room, b, a], True)):   # add A then dig B out of it / dig B, then A fills it again
            cover = assert_exact(self, order, M.csg_boxes(order), 16)
            self.assertEqual((64, 64, 64) in cover, solid_at_centre, 'the voxel in the middle of B, order ' + ' '.join(x.name for x in order))
        # the room level: dug first, the block added afterwards stays; added first, the room swallows it
        self.assertTrue(any(o == 1 for _l, _h, o in M.csg_boxes([room, a])))
        self.assertFalse(any(o == 0 for _l, _h, o in M.csg_boxes([a, room])), 'an Add brush that the later room swallowed leaves no solid of its own')

    def test_a_thin_sliver_survives_the_csg_exactly_and_becomes_the_editors_smallest_block(self):
        brushes = [B('room', 'sub', (0, 0, 0), (32, 32, 32)), B('sliver', 'add', (0, 0, 15), (32, 32, 17))]
        boxes = M.csg_boxes(brushes, pad=4)
        assert_exact(self, brushes, boxes, 1, pad=4)
        self.assertEqual([(lo, hi) for lo, hi, o in boxes if o == 1], [((0, 0, 15), (32, 32, 17))], 'a 2 UU slab is one box of exactly 2 UU')
        doc, _info = M.build_doc(scene_of(brushes), 'Sliver')
        slab = [it for it in doc['items'] if it['size'][1] == 0.1 and it['c'][1] == 0.32]
        self.assertEqual(len(slab), 1, 'the 2 UU slab becomes the editor\'s 0.1 m block around its middle')
        self.assertEqual((slab[0]['c'], slab[0]['size']), ([0.32, 0.32, 0.32], [0.64, 0.1, 0.64]))
        self.assertEqual(M._block((0, 0, 0), (10, 10, 5)), ([0.1, 0.05, 0.1], [0.2, 0.1, 0.2]), '5 UU is the first thickness that is kept as it is')
        self.assertEqual(M._block((0, 0, 0), (10, 10, 4))[1], [0.2, 0.1, 0.2], '4 UU becomes 0.1 m')

    def test_merged_boxes_never_overlap_and_cover_exactly_the_solid(self):
        brushes = [B('room', 'sub', (0, 0, 0), (192, 192, 128)), B('pillar', 'add', (64, 64, 0), (128, 128, 128)),
                   B('tunnel', 'sub', (48, 0, 32), (144, 192, 64)), B('step', 'add', (0, 0, 0), (32, 32, 16)),
                   B('niche', 'sub', (160, 160, 16), (256, 208, 64)), B('lip', 'add', (160, 160, 16), (176, 176, 32)),
                   B('slab', 'add', (96, 0, 96), (192, 64, 112))]
        boxes = M.csg_boxes(brushes)
        assert_exact(self, brushes, boxes, 16)
        self.assertEqual({o for _l, _h, o in boxes}, {-1, 1, 3, 5, 6}, 'every Add brush that survived owns some boxes; the others own none')


# ---------------------------------------------------------------------------------------------------------------------
# the document: numbers, axes, yaw
# ---------------------------------------------------------------------------------------------------------------------
class TestDocument(unittest.TestCase):
    def test_every_number_of_the_document_is_an_exact_0_01_multiple(self):
        brushes = [B('room', 'sub', (3, 5, 7), (93, 87, 61)), B('odd', 'add', (11, 13, 7), (47, 41, 33)), B('thin', 'add', (60, 20, 7), (62, 60, 40))]
        scene = scene_of(brushes, loc=(13.37, -77.77, 91.91), yaw=-12345, finish=((11.3, 5.7, 7.1), (60.9, 40.1, 55.55)))
        doc, _info = M.build_doc(scene, 'Páratlan')
        text = json.dumps(doc, ensure_ascii=False, separators=(',', ':'))
        self.assertEqual(re.findall(r'-?\d+\.\d{3,}', text), [], 'a number with more than two decimals')

        def walk(v):
            if isinstance(v, bool):
                return
            if isinstance(v, (int, float)):
                self.assertEqual(round(v, 2), v, v)
                self.assertTrue(math.isfinite(v))
            elif isinstance(v, list):
                for x in v:
                    walk(x)
            elif isinstance(v, dict):
                for x in v.values():
                    walk(x)
        walk(doc)
        sizes = [s for it in doc['items'] for s in it['size']]
        self.assertTrue(len(sizes) > 6 and min(sizes) >= 0.1, 'no size under the editor\'s 0.1 m')
        self.assertEqual(doc['nextId'], len(doc['items']) + 1)
        self.assertEqual([it['id'] for it in doc['items']], list(range(1, len(doc['items']) + 1)))

    def test_ut_axes_x_y_z_become_x_z_y_in_metres(self):
        brushes = [B('room', 'sub', (-64, -64, 0), (192, 192, 192)), B('piece', 'add', (10, 20, 0), (42, 84, 96), 'x')]
        doc, _info = M.build_doc(scene_of(brushes, loc=(150.0, -30.0, 44.0 + 96)), 'Axes')
        trim = [it for it in doc['items'] if it['mat'] == 'trim']
        self.assertEqual(len(trim), 1)
        self.assertEqual(trim[0]['c'], [0.52, 0.96, 1.04], 'centre: UT (26, 52, 48) -> (x, z, y) / 50 = (0.52, 0.96, 1.04)')   # y = UT Z centre: 48 / 50 = 0.96
        self.assertEqual(trim[0]['size'], [0.64, 1.92, 1.28], 'size: UT 32 x 64 x 96 -> x, height (UT Z), depth (UT Y)')
        self.assertEqual(doc['start']['pos'], [3, 1.92, -0.6], 'a PlayerStart at UT (150, -30, 140): x 3 m, feet 96 UU = 1.92 m up, z = UT Y = -0.6 m')

    def test_the_start_yaw_ut_0_is_plus_x_and_16384_is_plus_ut_y(self):
        """A UT yaw (65536 = 360 deg, 0 = +X, towards +Y) is our yaw -90 - yaw deg: fwdOf(yaw) = (-sin, 0, -cos), so UT 0 -> our yaw 270 looks along +x
        and UT 16384 -> yaw 180 looks along +z (UT +Y = our +z). The editor view of this is checked in node (TestEditorCrossCheck)."""
        for ut_yaw, ours in ((0, 270), (16384, 180), (49152, 0)):   # (49152: -90 - 270 = -360 wraps to 0, not 360)
            with self.subTest(ut_yaw=ut_yaw):
                doc, _ = M.build_doc(scene_of([B('room', 'sub', (0, 0, 0), (128, 128, 64))], yaw=ut_yaw), 'Yaw')
                self.assertEqual(doc['start']['yaw'], ours)
                self.assertEqual(doc['cam']['yaw'], ours)
                rad = math.radians(doc['start']['yaw'])
                fwd = (-math.sin(rad), -math.cos(rad))   # sim/math.js fwdOf: (x, z)
                want = math.radians(ut_yaw * 360 / 65536)
                self.assertAlmostEqual(fwd[0], math.cos(want), delta=1e-3)
                self.assertAlmostEqual(fwd[1], math.sin(want), delta=1e-3)

    def test_the_start_is_dropped_onto_the_solid_below_only_when_it_is_close(self):
        room = [B('room', 'sub', (0, 0, 0), (256, 256, 256))]
        near = M.build_doc(scene_of(room, loc=(100.0, 100.0, 44.0 + 60)), 'N')[0]['start']['pos']   # feet 60 UU over the floor: within 64 -> on the floor
        far = M.build_doc(scene_of(room, loc=(100.0, 100.0, 44.0 + 70)), 'F')[0]['start']['pos']    # 70 UU: left in the air
        self.assertEqual((near, far), ([2, 0, 2], [2, 1.4, 2]))

    def test_a_start_that_begins_inside_the_floor_is_lifted_onto_it_when_that_is_close(self):
        room = [B('room', 'sub', (0, 0, 0), (256, 256, 256))]
        pos = lambda z: M.build_doc(scene_of(room, loc=(100.0, 100.0, z)), 'L')[0]['start']['pos']   # noqa: E731  (feet = z - 44 UU; the floor top is at 0)
        self.assertEqual(pos(44.0 - 20), [2, 0, 2], 'a PlayerStart 24 UU above the floor: the feet would be 20 UU inside it')
        self.assertEqual(pos(44.0 - 44), [2, 0, 2], 'exactly 44 UU inside')
        self.assertEqual(pos(44.0 - 50), [2, -1, 2], '50 UU inside: too deep to be a rounding of the editor, left as it is (the editor warns)')
        stacked = [B('room', 'sub', (0, 0, 0), (256, 256, 256)), B('a', 'add', (64, 64, 0), (192, 192, 16)), B('b', 'add', (64, 64, 16), (192, 192, 32), 'x')]   # two owners on top of each other
        self.assertEqual(M.build_doc(scene_of(stacked, loc=(100.0, 100.0, 44.0 + 8)), 'S')[0]['start']['pos'], [2, 0.64, 2], 'out of both pieces')

    def test_a_windows_device_name_is_not_used_as_the_map_id_or_file_name(self):
        for n in ('CON', 'nul', 'Prn', 'AUX', 'COM1', 'lpt9'):
            self.assertEqual(M.slug(n), n.lower() + '-palya', n)
        self.assertEqual([M.slug(n) for n in ('Console', 'com0', 'COM10', 'con-1', '???')], ['console', 'com0', 'com10', 'con-1', 'palya'])
        self.assertEqual(M.build_doc(scene_of([B('room', 'sub', (0, 0, 0), (128, 128, 64))]), 'CON')[0]['id'], 'con-palya')


# ---------------------------------------------------------------------------------------------------------------------
# a synthetic .ut2 end to end
# ---------------------------------------------------------------------------------------------------------------------
class CliCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix='ut map ')   # (a space in the path on purpose)
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)

    def ut2(self, data, name='DM-Tiny Map-v3.ut2'):
        d = self.tmp / 'in'
        d.mkdir(exist_ok=True)
        p = d / name
        p.write_bytes(data)
        return p

    def run_main(self, path, *args, out=None):
        out_dir = Path(out) if out else self.tmp / 'out'
        o, e = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(o), contextlib.redirect_stderr(e):
            rc = M.main([str(path), '--out', str(out_dir), '--no-git-check', *args])
        return rc, o.getvalue(), e.getvalue(), out_dir

    def assert_refused(self, data, *needles, name='DM-Tiny Map-v3.ut2'):
        rc, out, err, out_dir = self.run_main(self.ut2(data, name))
        self.assertEqual(rc, 1, out + err)
        self.assertTrue(err.startswith('ut2004_map: '), err)
        self.assertNotIn('Traceback', err)
        for n in needles:
            self.assertIn(n, err)
        self.assertEqual(os.listdir(out_dir) if out_dir.exists() else [], [], 'a refused map wrote something')
        return err


class TestSyntheticMap(CliCase):
    def test_a_tiny_map_gives_the_expected_document(self):
        path = self.ut2(tiny_map())
        scene = M.read_map(path)
        self.assertEqual(scene['brushes'], TINY_BRUSHES, 'Level order; the builder brush (no CsgOper) is not a brush; the PrePivot of Brush4 cancels out')
        self.assertEqual(scene['start'], {'loc': (50.0, -200.0, 46.0), 'yaw': -432})
        self.assertEqual(scene['finish'], FINISH_BOX, 'FinishVolume: Location + its model\'s bounding box')
        before = path.read_bytes()
        rc, out, err, out_dir = self.run_main(path)
        self.assertEqual((rc, err), (0, ''), out)
        self.assertEqual(path.read_bytes(), before, 'the map file is only read')
        self.assertEqual(sorted(os.listdir(out_dir)), ['index.json', 'tiny-map.json'], 'named after the file (game type prefix and version cut off), the index next to it, no .tmp left behind')
        text = (out_dir / 'tiny-map.json').read_text(encoding='utf-8')
        doc = json.loads(text)
        self.assertEqual({k: doc[k] for k in ('v', 'id', 'name', 'theme', 'created', 'updated')}, {'v': 1, 'id': 'tiny-map', 'name': 'Tiny Map', 'theme': 'kikepzes', 'created': 0, 'updated': 0})
        self.assertEqual(doc['start'], {'pos': [1, 0, -4], 'yaw': 272.37}, 'feet = the PlayerStart 44 UU down, onto the floor; yaw -90 + 432 * 360 / 65536')
        self.assertEqual(doc['cam'], {'pos': [1, 2, -4], 'yaw': 272.37, 'pitch': -20})
        fin = doc['items'][-1]
        self.assertEqual(fin, {'id': len(doc['items']), 't': 'finish', 'c': [0, 0.96, 3.84], 'size': [1.28, 1.92, 1.28]})
        self.assertEqual(doc['nextId'], len(doc['items']) + 1)
        self.assertEqual(list(doc), ['v', 'id', 'name', 'theme', 'start', 'items', 'nextId', 'cam', 'created', 'updated'], 'the key order of the editor\'s own export')
        for it in doc['items'][:-1]:
            self.assertEqual((list(it), it['t'], it['yaw']), (['id', 't', 'c', 'size', 'yaw', 'mat'], 'block', 0))
        owner = {'floor': -1, 'wall': -1, 'grate': 1, 'trim': 2}
        boxes = doc_boxes(doc, owner)
        assert_exact(self, TINY_BRUSHES, boxes, 32)
        self.assertEqual(Counter(it['mat'] for it in doc['items'] if it['t'] == 'block')['grate'], 1, 'the grate-textured pillar is one grate block')
        self.assertEqual([it['size'] for it in doc['items'] if it.get('mat') == 'trim'], [[1.28, 0.64, 1.28]], 'the 64 x 64 x 32 step is a trim block')
        self.assertIn('Tiny Map', out)
        self.assertIn('Importálás', out, 'the import steps are printed')

    def test_the_index_lists_every_written_map_sorted_unique_and_only_files_that_exist(self):
        index = lambda: json.loads((out_dir / 'index.json').read_text(encoding='utf-8'))   # noqa: E731
        data = self.ut2(tiny_map())
        for args in ((), ('--name', 'Alpha'), ()):   # (tiny-map again: no duplicate)
            rc, out, err, out_dir = self.run_main(data, *args)
            self.assertEqual((rc, err), (0, ''), out)
        self.assertEqual(index(), {'v': 1, 'maps': ['alpha.json', 'tiny-map.json']})
        self.assertEqual(sorted(os.listdir(out_dir)), ['alpha.json', 'index.json', 'tiny-map.json'], 'no .tmp left behind')
        # a map that was deleted, junk and names the game would refuse drop out of the list; a damaged index is built again
        (out_dir / 'alpha.json').unlink()
        (out_dir / 'index.json').write_text(json.dumps({'v': 1, 'maps': ['alpha.json', 'ghost.json', 'Tiny-Map.json', '../x.json', 'index.json', 7, 'tiny-map.json']}), encoding='utf-8')
        rc, out, err, _ = self.run_main(data, '--name', 'Index')   # ('index' would be the list's own file name)
        self.assertEqual((rc, err), (0, ''), out)
        self.assertEqual(index(), {'v': 1, 'maps': ['index-palya.json', 'tiny-map.json']})
        (out_dir / 'index.json').write_text('{not json', encoding='utf-8')
        self.run_main(data)
        self.assertEqual(index(), {'v': 1, 'maps': ['tiny-map.json']}, 'a damaged index starts again from the map that was just written')

    def test_the_index_ignores_unrelated_files_in_the_folder_and_survives_a_binary_old_index(self):
        out_dir = self.tmp / 'out'
        (out_dir / 'dir.json').mkdir(parents=True)   # a folder that looks like a map file
        unrelated = {'README.txt': b'notes', 'notes.json': b'{"not":"a map"}', 'Upper.json': b'{}', 'x.json.tmp': b'half'}
        for name, body in unrelated.items():
            (out_dir / name).write_bytes(body)
        (out_dir / 'index.json').write_text(json.dumps({'v': 1, 'maps': ['dir.json', 'tiny-map.json', 'tiny-map.json', ['tiny-map.json'], None]}), encoding='utf-8')
        rc, out, err, _ = self.run_main(self.ut2(tiny_map()))
        self.assertEqual((rc, err), (0, ''), out)
        self.assertEqual(json.loads((out_dir / 'index.json').read_text(encoding='utf-8')), {'v': 1, 'maps': ['tiny-map.json']}, 'a folder, a duplicate, a list and null drop out; unrelated files are not adopted')
        self.assertEqual({n: (out_dir / n).read_bytes() for n in unrelated}, unrelated, 'files the converter did not write are left alone')
        self.assertTrue((out_dir / 'dir.json').is_dir())
        (out_dir / 'index.json').write_bytes(bytes([0xFF, 0xFE, 0x00]) + b'{"v":1,"maps":["tiny-map.json"]}')   # not valid UTF-8
        rc, out, err, _ = self.run_main(self.ut2(tiny_map()), '--name', 'Beta')
        self.assertEqual((rc, err), (0, ''), out)
        self.assertEqual(json.loads((out_dir / 'index.json').read_text(encoding='utf-8')), {'v': 1, 'maps': ['beta.json']}, 'a binary index is built again from the map that was just written (the old list is lost, nothing crashes)')

    def test_what_is_not_ported_is_listed_instead_of_silently_dropped(self):
        rc, out, err, _ = self.run_main(self.ut2(tiny_map()))
        self.assertEqual(rc, 0, err)
        self.assertIn('Kihagyott objektumok: Brush (építő ecset) x1, Light x1, MiniHealthPack x1, StaticMeshActor x2', out)

    def test_maps_the_converter_cannot_reproduce_are_refused_in_hungarian_and_nothing_is_written(self):
        cases = [
            ('rotated brush', dict(step_tags=lambda pk: (pk.rotator('Rotation', (0, 16384, 0)),)), ('„Brush4”', 'nem vihető át', 'el van forgatva')),
            ('not a box', dict(step_polys=tapered), ('„Brush4”', 'nem vihető át', 'nem tengelyirányú téglatest')),
            ('NotSolid polygon', dict(step_flags=M.POLY_NOT_SOLID), ('„Brush4”', 'nem vihető át', 'nem tömörek', 'NotSolid')),
            ('a Mover', dict(extra=lambda pk, refs: refs.append(pk.actor('Mover', 'Mover0'))), ('„Mover0” (Mover)', 'nem vihető át')),
            ('no PlayerStart', dict(start=False), ('nincs PlayerStart',)),
        ]
        # the solidity chosen in UnrealEd (Add Special) is the PolyFlags property of the Brush ACTOR: the build ORs it into every polygon
        for label, flag in (('NotSolid', M.POLY_NOT_SOLID), ('Semisolid', M.POLY_SEMISOLID), ('Portal', M.POLY_PORTAL)):
            cases.append((label + ' on the actor', dict(step_tags=lambda pk, f=flag: (pk.tag('PolyFlags', 2, struct.pack('<i', f)),)), ('„Brush4”', 'nem vihető át', 'nem tömörek', 'PolyFlags 0x%x' % flag)))
        for label, kw, needles in cases:
            with self.subTest(label):
                self.assert_refused(tiny_map(**kw), *needles)
        rc, _out, err, _ = self.run_main(self.ut2(tiny_map(step_tags=lambda pk: (pk.tag('PolyFlags', 2, struct.pack('<i', 1)),))))
        self.assertEqual((rc, err), (0, ''), 'a flag that does not change the collision (Invisible, 0x1) is no reason to refuse')

    def test_a_level_list_that_repeats_an_actor_reads_it_once(self):
        scene = M.read_map(self.ut2(tiny_map(extra=lambda pk, refs: refs.extend([refs[1]] * 50))))   # (refs[1] = the room brush)
        self.assertEqual(scene['brushes'], TINY_BRUSHES)
        self.assertEqual(sum('ismétlődő' in w for w in scene['warnings']), 1, scene['warnings'])

    def test_junk_cut_off_and_corrupt_files_end_with_exit_1_and_no_traceback(self):
        good = tiny_map()
        pk = Ut2()   # a Level that claims an absurd number of actors, inside otherwise intact tables
        pk.brush('Brush2', M.CSG_SUB, *ROOM)
        pk.level([1])
        body = bytearray(pk.data())
        level = pk.exports[-1][4]
        at = bytes(body).find(level)
        body[at + 1:at + 5] = struct.pack('<i', 0x7FFFFFF0)   # NumActors
        cases = [('junk', b'x' * 5000), ('cut off in the tables', good[:len(good) - 10]), ('absurd actor count', bytes(body))]
        for label, data in cases:
            with self.subTest(label):
                self.assert_refused(data)

    def test_BUG_properties_of_an_unexpected_type_end_in_a_traceback_instead_of_exit_1(self):
        """BUG (low): a CsgOper or DrawScale property that is not a byte / float (a corrupt or foreign file: one flipped bit in the tag's type nibble) comes back
        from read_properties(raw_structs=True) as a (name, bytes) tuple; `'%d' % op` (ut2004_map.py:277) and `abs(scale - 1)` (ut2004_map.py:124) then raise
        TypeError, which neither damaged() nor main() catches. Expected: exit 1 with a message (or the property ignored), never an exception."""
        cases = [('CsgOper is a struct', lambda pk: (pk.tag('CsgOper', 10, bytes(12), 'Vector'),)), ('DrawScale is a struct', lambda pk: (pk.tag('DrawScale', 10, bytes(12), 'Vector'),))]
        for label, tags in cases:
            with self.subTest(label):
                try:
                    rc, out, err, _ = self.run_main(self.ut2(tiny_map(step_tags=tags)))
                except TypeError as e:
                    self.fail('main() raised %s: %s' % (type(e).__name__, e))
                self.assertIn(rc, (0, 1))
                self.assertNotIn('Traceback', err)

    def test_output_that_the_editor_would_refuse_is_refused_here(self):
        huge = [B('hall', 'sub', (0, 0, 0), (30000, 1000, 1000))]   # a 600 m hall: its rock blocks are bigger than the editor's 400 m
        with self.assertRaises(X.ExtractError) as cm:
            M.build_doc(scene_of(huge, loc=(100.0, 100.0, 44.0)), 'Huge')
        self.assertIn('túl nagy', str(cm.exception))
        many = [B('room', 'sub', (0, 0, 0), (8400, 32, 32))] + [B('c%d' % i, 'add', (4 * i, 8, 8), (4 * i + 2, 10, 10)) for i in range(2100)]   # 2100 loose 2 UU cubes
        with self.assertRaises(X.ExtractError) as cm:
            M.build_doc(scene_of(many, loc=(100.0, 10.0, 44.0)), 'Many')
        self.assertIn('túl sok tömb', str(cm.exception))

    def test_a_start_or_finish_outside_the_editors_limits_is_refused_instead_of_being_clamped_by_the_importer(self):
        """The editor clamps every coordinate to +-1500 m (75000 UU) without a word: a PlayerStart at UT (1e9, 1e9, 1e9) would land at (1500, 1500, 1500)."""
        room = [B('room', 'sub', (0, 0, 0), (256, 256, 256))]
        cases = [('start at 1e9', dict(loc=(1e9, 1e9, 1e9))), ('start 1600 m away', dict(loc=(80000.0, 100.0, 44.0))), ('start NaN', dict(loc=(float('nan'), 100.0, 44.0))),
                 ('start inf', dict(loc=(100.0, float('inf'), 44.0))), ('finish at 1e9', dict(finish=((0.0, 0.0, 0.0), (1e9, 32.0, 32.0))))]
        for label, kw in cases:
            with self.subTest(label):
                with self.assertRaises(X.ExtractError) as cm:
                    M.build_doc(scene_of(room, **kw), 'Far')
                self.assertIn('szerkesztő határain kívül', str(cm.exception))
        edge = M.build_doc(scene_of(room, loc=(74999.0, 100.0, 44.0)), 'Edge')[0]   # 1499.98 m: inside the limit
        self.assertEqual(edge['start']['pos'][0], 1499.98)
        self.assert_refused(tiny_map(start_loc=(1e9, 1e9, 1e9)), 'rajtpont', 'határain kívül')   # (the command line: exit 1, nothing written)

    def test_the_name_is_cleaned_like_the_editors_cleanText_so_the_import_keeps_it(self):
        """editor/model.js cleanText: stripText (text.js: C0 / DEL / C1, U+2028 / 2029, bidi controls, < >), trim, at most 40 UTF-16 units."""
        self.assertEqual(M.clean_name('\ufeff \tA\u202eB<i>\x00\x7f\x85\u2028\u2029\u2066C\u2069 '), 'ABiC')
        self.assertEqual(M.clean_name('x' * 60), 'x' * 40)
        self.assertEqual(M.clean_name('ab' + '\U0001F600' * 30), 'ab' + '\U0001F600' * 19, 'an astral character is two UTF-16 units: 2 + 38 = 40')
        self.assertEqual(M.clean_name(' \x00<> '), 'Névtelen pálya', 'nothing left: the editor\'s default name')
        doc, _info = M.build_doc(scene_of([B('room', 'sub', (0, 0, 0), (128, 128, 64))]), 'Z\u202e<b>é' + 'q' * 50)
        self.assertEqual((doc['name'], doc['id']), ('Zbé' + 'q' * 37, 'zbe' + 'q' * 21))


class TestExtractHooks(unittest.TestCase):
    def test_a_compact_index_is_at_most_five_bytes_long(self):
        ok = X.encode_index(0x7FFFFFF0)
        self.assertEqual((len(ok), X.Reader(ok + b'\x00').idx()), (5, 0x7FFFFFF0))
        with self.assertRaises(X.ExtractError):
            X.Reader(b'\x40' + b'\xff' * 5000 + b'\x00').idx()   # a crafted run of continuation bytes: refused at once, not parsed into a huge number

    def test_the_opt_in_hooks_of_ut2004_extract_do_what_they_say_and_the_defaults_stay_as_they_were(self):
        pk = Ut2()
        frame = X.encode_index(5) + X.encode_index(0) + bytes(12) + X.encode_index(77)   # a state frame with a Node (so an Offset idx follows)
        pk.export('Brush', 'Flagged', frame + pk.props(pk.vector('Location', (1.0, 2.0, 3.0)), pk.flt('Ratio', 1.5), pk.tag('Names', 13, b'abc')), X.RF_HAS_STACK)
        pk.export('Thing', 'Plain', pk.props(pk.byte('Format', 3), pk.vector('Location', (4.0, 5.0, 6.0))))
        with tempfile.TemporaryDirectory(prefix='ut hooks ') as d:
            path = Path(d) / 'x.ut2'
            path.write_bytes(pk.data())
            pkg = X.Package(path)
        flagged, plain = pkg.exports
        with self.assertRaises(X.ExtractError):
            pkg.reader(flagged)   # the default: a state frame is refused, as before
        props = X.read_properties(pkg.reader(flagged, state_frame=True), raw_structs=True)
        self.assertEqual(props, {'Location': ('Vector', struct.pack('<3f', 1, 2, 3)), 'Ratio': 1.5, 'Names': b'abc'})
        props = X.read_properties(pkg.reader(flagged, state_frame=True))   # raw_structs off (the default): structs and arrays are skipped, as before
        self.assertEqual(props, {'Location': None, 'Ratio': 1.5, 'Names': None})
        r = pkg.reader(plain, state_frame=True)   # nothing to skip without the flag
        self.assertEqual(r.p, plain.offset)
        self.assertEqual(X.read_properties(r, raw_structs=True)['Format'], 3)


# ---------------------------------------------------------------------------------------------------------------------
# the command line: the git-ignore guard, the console
# ---------------------------------------------------------------------------------------------------------------------
class TestCommandLine(CliCase):
    def git(self, *args, cwd):
        return subprocess.run(['git', *args], cwd=str(cwd), capture_output=True, timeout=60)

    def test_the_converter_writes_only_into_git_ignored_folders_and_its_default_folder_is_ignored(self):
        if not shutil.which('git'):
            self.skipTest('git is not available')
        res = self.git('check-ignore', '-q', 'pajzsugras/local-maps/x.json', cwd=REPO)
        if res.returncode == 128:
            self.skipTest('not a git checkout')
        self.assertEqual((res.returncode, M.OUT_MAPS), (0, REPO / 'pajzsugras' / 'local-maps'), 'the default output folder is git-ignored')
        self.assertEqual(self.git('ls-files', 'pajzsugras/local-maps', cwd=REPO).stdout.strip(), b'', 'nothing of local-maps is tracked')
        repo = self.tmp / 'repo'
        repo.mkdir()
        self.git('init', '-q', cwd=repo)
        data = self.ut2(tiny_map())
        tool = str(TOOLS / 'ut2004_map.py')
        env = dict(os.environ, PYTHONIOENCODING='ascii')   # a console that cannot print Hungarian letters must not crash the run
        # not ignored -> refused, nothing written, and the message says why (also in a console that cannot print the letters)
        res = subprocess.run([sys.executable, '-I', tool, str(data), '--out', str(repo / 'maps')], capture_output=True, env=env, timeout=60)
        self.assertEqual(res.returncode, 1, res.stdout + res.stderr)
        self.assertIn(b'NOT git-ignored', res.stderr)
        self.assertNotIn(b'Traceback', res.stderr)
        self.assertFalse((repo / 'maps').exists(), 'something was written although git would not ignore the folder')
        # ignored -> written
        (repo / '.gitignore').write_text('maps/\n')
        res = subprocess.run([sys.executable, '-I', tool, str(data), '--out', str(repo / 'maps')], capture_output=True, env=env, timeout=60)
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertNotIn(b'Traceback', res.stderr)
        self.assertEqual(sorted(os.listdir(repo / 'maps')), ['index.json', 'tiny-map.json'])
        self.assertEqual(json.loads((repo / 'maps' / 'tiny-map.json').read_text(encoding='utf-8'))['name'], 'Tiny Map')

    def test_BUG_a_not_yet_existing_parent_of_the_out_folder_switches_the_git_guard_off(self):
        """BUG (low): require_git_ignored() runs git with cwd = the out folder's parent; when that does not exist yet, the OSError is taken for 'git is not
        around' and the guard returns silently, so `--out <repo>/a/b` (a missing) writes into a folder git does not ignore. (ut2004_extract.py:1103-1105)"""
        if not shutil.which('git'):
            self.skipTest('git is not available')
        repo = self.tmp / 'repo'
        repo.mkdir()
        self.git('init', '-q', cwd=repo)
        data = self.ut2(tiny_map())
        o, e = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(o), contextlib.redirect_stderr(e):
            rc = M.main([str(data), '--out', str(repo / 'a' / 'b')])   # (no --no-git-check: the guard is what is tested)
        self.assertEqual((rc, 'NOT git-ignored' in e.getvalue()), (1, True), 'written into a folder that git does not ignore: ' + o.getvalue()[:80])
        self.assertFalse((repo / 'a').exists(), 'folders were created in the repository')


# ---------------------------------------------------------------------------------------------------------------------
# the editor's own code on the result (node)
# ---------------------------------------------------------------------------------------------------------------------
def node_check(doc_path, probes=()):
    res = subprocess.run([NODE, str(TOOLS / 'test_ut2004_map_check.mjs'), str(doc_path), str(X.ROOT), json.dumps(list(probes))], capture_output=True, timeout=300)
    out = res.stdout.decode('utf-8', 'replace').strip().splitlines()
    return json.loads(out[-1]) if out else {'error': 'no output: ' + res.stderr.decode('utf-8', 'replace')}


@unittest.skipUnless(NODE, 'node is not available')
class TestEditorCrossCheck(CliCase):
    def test_the_editor_takes_the_file_unchanged_builds_it_and_the_start_looks_where_the_playerstart_looked(self):
        for ut_yaw, fwd in ((0, (1, 0)), (16384, (0, 1))):   # UT +X -> our +x, UT +Y -> our +z
            with self.subTest(ut_yaw=ut_yaw):
                rc, out, err, out_dir = self.run_main(self.ut2(tiny_map(yaw=ut_yaw)), out=self.tmp / ('out%d' % ut_yaw))
                self.assertEqual(rc, 0, err)
                doc_path = out_dir / 'tiny-map.json'
                # probes (the hull's feet): inside the pillar, in the open room, inside the floor slab, in the open room where the finish box is
                r = node_check(doc_path, [[0, 1, 0], [3, 0.02, 3], [3, -1, 3], [0, 0.5, 3.84]])
                self.assertNotIn('error', r, r.get('error'))
                self.assertTrue(r['unchanged'], 'importDoc / serialise change the document')
                self.assertTrue(r['builds'] and r['hasFinish'] and r['themeIsKikepzes'])
                self.assertLessEqual(r['cells'], r['cellLimit'])
                self.assertEqual(r['validate']['errors'], [], r['validate'])
                self.assertTrue(r['startFree'], 'the hull cannot stand at the start')
                self.assertTrue(r['solidBelow'], 'the start is not on a solid top')
                self.assertAlmostEqual(r['fwd'][0], fwd[0], delta=1e-6)
                self.assertAlmostEqual(r['fwd'][2], fwd[1], delta=1e-6)
                self.assertEqual(r['probes'], [True, False, True, False])

    def test_a_hostile_or_long_name_comes_out_as_the_editor_would_keep_it(self):
        for label, name in (('controls, bidi, markup, long', 'Z\u202e<b>é\x00\u2028' + 'q' * 50), ('astral characters', 'ab' + '\U0001F600' * 30)):
            with self.subTest(label):
                out = self.tmp / ('out_' + str(abs(hash(label))))
                rc, _o, err, out_dir = self.run_main(self.ut2(tiny_map()), '--name', name, out=out)
                self.assertEqual(rc, 0, err)
                (doc_file,) = [f for f in os.listdir(out_dir) if f != 'index.json']
                r = node_check(out_dir / doc_file)
                self.assertNotIn('error', r, r.get('error'))
                self.assertTrue(r['unchanged'], 'importDoc changes the name that was written')


# ---------------------------------------------------------------------------------------------------------------------
# the real map (opt-in)
# ---------------------------------------------------------------------------------------------------------------------
@unittest.skipUnless(REAL_MAP and os.path.isfile(REAL_MAP), 'set PJ_UT2_MAP to the DPM-HoppHopp .ut2 to run the real map case')
class TestRealMap(CliCase):
    def test_dpm_hopphopp(self):
        src = Path(REAL_MAP)
        folder_before = sorted(os.listdir(src.parent))
        sha = hashlib.sha256(src.read_bytes()).hexdigest()
        rc, out, err, out_dir = self.run_main(src)
        self.assertEqual((rc, err), (0, ''), out)
        self.assertEqual(hashlib.sha256(src.read_bytes()).hexdigest(), sha, 'the map was modified')
        self.assertEqual(sorted(os.listdir(src.parent)), folder_before, 'something was written next to the downloaded map')
        self.assertEqual(sorted(os.listdir(out_dir)), ['hopphopp.json', 'index.json'])
        doc = json.loads((out_dir / 'hopphopp.json').read_text(encoding='utf-8'))
        self.assertEqual((doc['name'], doc['id'], doc['theme']), ('HoppHopp', 'hopphopp', 'kikepzes'))
        blocks = [it for it in doc['items'] if it['t'] == 'block']
        trim = [it for it in blocks if it['mat'] == 'trim']
        self.assertEqual((len(trim), {tuple(it['size']) for it in trim}), (14, {(1.28, 0.64, 1.28)}), 'the corner steps')
        fin = [it for it in doc['items'] if it['t'] == 'finish']
        self.assertEqual([(f['c'], f['size']) for f in fin], [([11.2, 28.96, 14.88], [1.92, 2.24, 2.24])])
        pos = doc['start']['pos']
        self.assertEqual(pos, [-0.01, -10.24, -7.68])
        inside = lambda it, p, eps=1e-9: all(abs(p[a] - it['c'][a]) < it['size'][a] / 2 - eps for a in range(3))   # noqa: E731
        floor = [it for it in blocks if abs(it['c'][1] + it['size'][1] / 2 - pos[1]) < 1e-9 and abs(pos[0] - it['c'][0]) <= it['size'][0] / 2 and abs(pos[2] - it['c'][2]) <= it['size'][2] / 2]
        self.assertTrue(floor, 'the start stands on a solid top')
        self.assertFalse([it for it in blocks if any(inside(it, [pos[0], pos[1] + dy, pos[2]]) for dy in (0.1, 0.5, 1.0, 1.7))], 'the start is inside solid')
        column = [it for it in blocks if inside(it, [0, 0, 0])]
        self.assertEqual([(it['mat'], it['size']) for it in column], [('grate', [10.24, 20.32, 10.24])], 'the central column is solid')
        if NODE:
            r = node_check(out_dir / 'hopphopp.json', [[0, 0, 0], [0, -5, 0], [0, 9, 0], [-0.01, -10.22, -7.68]])
            self.assertNotIn('error', r, r.get('error'))
            self.assertTrue(r['unchanged'] and r['builds'] and r['startFree'] and r['solidBelow'] and r['themeIsKikepzes'])
            self.assertEqual(r['probes'], [True, True, True, False], 'column solid at three heights, the start free')
            self.assertEqual(r['validate']['errors'], [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
