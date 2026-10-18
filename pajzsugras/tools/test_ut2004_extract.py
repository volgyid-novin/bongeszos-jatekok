#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Tests of pajzsugras/tools/ut2004_extract.py.   python -I pajzsugras/tools/test_ut2004_extract.py   (or python -m unittest in this folder)

Synthetic cases build their own tiny packages / blocks in code (no Epic data lives in the repository). The real-install cases run when
the UT2004_DIR environment variable points at an install, or E:\\UnrealTournament2004 exists; otherwise they are skipped. They only
read the install and write into temporary folders (the test never touches pajzsugras/local-*), except the git-ignore check, which
asks git about the default output paths.
"""
import builtins
import io
import json
import math
import os
import random
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import zlib
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # (python -I does not put the script folder on the path)
import ut2004_extract as X   # noqa: E402

UT_DIR = os.environ.get('UT2004_DIR') or (r'E:\UnrealTournament2004' if os.path.isdir(r'E:\UnrealTournament2004') else None)
REPO = X.ROOT.parent


# ---------------------------------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------------------------------
class FakePkg:
    def __init__(self, names):
        self.names = names


def reader(data, names=('None',)):
    return X.Reader(bytes(data), 0, FakePkg(list(names)))


def build_package(names, imports, exports, ver=122, lic=29):
    """A minimal package: header | payloads | names | imports | exports. imports: (class package idx, class idx, outer, name idx);
    exports: (class index, outer, name idx, flags, payload bytes)."""
    body = bytearray(b'\0' * 64)
    offsets = []
    for e in exports:
        offsets.append(len(body))
        body.extend(e[4])
    name_off = len(body)
    for n in names:
        body.extend(X.encode_index(len(n) + 1) + n.encode('latin-1') + b'\0' + struct.pack('<I', 0))
    imp_off = len(body)
    for cp, cn, outer, nm in imports:
        body.extend(X.encode_index(cp) + X.encode_index(cn) + struct.pack('<i', outer) + X.encode_index(nm))
    exp_off = len(body)
    for (ci, outer, nm, fl, payload), off in zip(exports, offsets):
        body.extend(X.encode_index(ci) + X.encode_index(0) + struct.pack('<i', outer) + X.encode_index(nm) + struct.pack('<I', fl)
                    + X.encode_index(len(payload)) + (X.encode_index(off) if payload else b''))
    body[0:36] = struct.pack('<IHHIIIIIII', X.PKG_TAG, ver, lic, 0, len(names), name_off, len(exports), exp_off, len(imports), imp_off)
    return bytes(body)


def png_decode(data):
    """Independent PNG reader for the round trip: -> (width, height, channels, rows without the filter bytes)."""
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    pos, idat, ihdr = 8, b'', None
    while pos < len(data):
        n, t = struct.unpack_from('>I4s', data, pos)
        body = data[pos + 8:pos + 8 + n]
        crc, = struct.unpack_from('>I', data, pos + 8 + n)
        assert crc == zlib.crc32(t + body) & 0xFFFFFFFF, 'bad CRC in ' + t.decode()
        if t == b'IHDR':
            ihdr = struct.unpack('>IIBBBBB', body)
        elif t == b'IDAT':
            idat += body
        pos += 12 + n
    w, h, depth, ctype, comp, filt, inter = ihdr
    assert (depth, comp, filt, inter) == (8, 0, 0, 0)
    ch = {2: 3, 6: 4}[ctype]
    raw = zlib.decompress(idat)
    stride = 1 + w * ch
    assert len(raw) == stride * h
    rows = []
    for y in range(h):
        assert raw[y * stride] == 0, 'only filter 0 expected'
        rows.append(raw[y * stride + 1:(y + 1) * stride])
    return w, h, ch, rows


def qconj(q):
    return (-q[0], -q[1], -q[2], q[3])


def rand_unit_quat(rng):
    q = [rng.gauss(0, 1) for _ in range(4)]
    n = math.sqrt(sum(c * c for c in q))
    return tuple(c / n for c in q)


def close(a, b, eps=1e-6):
    return all(abs(x - y) < eps for x, y in zip(a, b))


def pixel(rows, x, y, ch):
    return tuple(rows[y][x * ch:(x + 1) * ch])


# ---------------------------------------------------------------------------------------------------------------------
# synthetic: reader, package, property tags
# ---------------------------------------------------------------------------------------------------------------------
def tiny_wav(n=100):
    """A valid, whole RIFF/WAVE file (44-byte header + n bytes of silence): what a player's own replacement sound looks like."""
    return b'RIFF' + struct.pack('<I', 36 + n) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 1, 22050, 44100, 2, 16) + b'data' + struct.pack('<I', n) + bytes(n)


def finishes(fn, seconds=5):
    """Run fn() in a daemon thread: -> ('returned' | 'raised', value) or ('hung', None). A reader that walks backwards must fail, never spin."""
    box = []

    def run():
        try:
            box.append(('returned', fn()))
        except BaseException as e:   # noqa: BLE001
            box.append(('raised', e))
    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(seconds)
    return box[0] if box else ('hung', None)


class TestReaderAndPackage(unittest.TestCase):
    def test_compact_index_round_trip(self):
        for v in (0, 1, 5, 63, 64, 65, 8191, 8192, 8193, 524287, 1_000_000, 134217727, -1, -63, -64, -100000):
            r = reader(X.encode_index(v))
            self.assertEqual(r.idx(), v)
            self.assertEqual(r.p, len(X.encode_index(v)))

    def test_compact_index_known_bytes(self):
        self.assertEqual(reader(b'\x3f').idx(), 63)
        self.assertEqual(reader(b'\x40\x01').idx(), 64)          # 6 low bits = 0, more bit, next byte << 6
        self.assertEqual(reader(b'\x41\x01').idx(), 65)
        self.assertEqual(reader(b'\x81').idx(), -1)
        self.assertEqual(reader(b'\xc1\x01').idx(), -65)
        self.assertEqual(reader(b'\x7f\x81\x01').idx(), 63 + (1 << 6) + (1 << 13))

    def test_lazy_array_checks_its_skip_position(self):
        good = struct.pack('<i', 4 + 1 + 8) + X.encode_index(2) + struct.pack('<2I', 7, 9)
        r = reader(good)
        self.assertEqual(r.lazy(r.u32), [7, 9])
        bad = struct.pack('<i', 99) + X.encode_index(2) + struct.pack('<2I', 7, 9)
        r = reader(bad)
        with self.assertRaises(X.ExtractError):
            r.lazy(r.u32)

    def test_package_tables_and_lookup(self):
        names = ['None', 'Core', 'Class', 'Texture', 'Foo', 'Bar', 'Package', 'Pkg']
        imports = [(1, 2, 0, 3), (1, 2, -3, 4), (1, 6, 0, 7)]   # import 1 = class "Texture"; import 2 = "Foo" inside import 3; import 3 = Package Pkg
        exports = [(-1, 0, 5, 0x000F0004, b'\x00abc'), (0, 0, 4, 0, b'')]
        data = build_package(names, imports, exports)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'x.utx'
            p.write_bytes(data)
            pkg = X.Package(p)
        self.assertEqual((pkg.ver, pkg.lic), (122, 29))
        self.assertEqual(pkg.names, names)
        e = pkg.find('Bar', 'Texture')
        self.assertEqual((e.size, e.flags), (4, 0x000F0004))
        self.assertEqual(pkg.data[e.offset:e.offset + e.size], b'\x00abc')
        self.assertEqual(pkg.exports[1].cls, 'Class')             # class index 0 = a UClass
        self.assertEqual(pkg.exports[1].size, 0)
        with self.assertRaises(X.ExtractError):
            pkg.find('Bar', 'Sound')
        self.assertEqual(pkg.object_package(-2), 'Pkg')           # follows outer imports to the package

    def test_state_frame_flag_is_refused(self):
        data = build_package(['None', 'Core', 'Class', 'Thing', 'Obj'], [(1, 2, 0, 3)], [(-1, 0, 4, X.RF_HAS_STACK | 4, b'\x00')])
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'x.utx'
            p.write_bytes(data)
            pkg = X.Package(p)
        with self.assertRaises(X.ExtractError):
            pkg.reader(pkg.exports[0])

    def test_cyclic_outer_imports_do_not_hang(self):
        data = build_package(['None', 'Core', 'Class', 'Texture', 'Loop'], [(1, 2, 0, 3), (1, 2, -2, 4)], [(-1, 0, 4, 4, b'\x00')])
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'x.utx'
            p.write_bytes(data)
            pkg = X.Package(p)
        with self.assertRaises(X.ExtractError):
            pkg.object_package(-2)   # import 2 is its own outer

    def test_not_a_package(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'junk.utx'
            p.write_bytes(b'x' * 200)
            with self.assertRaises(X.ExtractError):
                X.Package(p)


class TestPropertyTags(unittest.TestCase):
    NAMES = ['None', 'Format', 'Count', 'Scale', 'Flag', 'Color', 'Arr', 'Tex', 'Strs', 'Big', 'Elem', 'Elem2', 'Elem3', 'Color_t']

    @staticmethod
    def tag(name, typ, size_code, is_arr=False, extra=b'', payload=b''):
        """name index (< 64, one byte) + info byte + extra (struct name / size bytes / array index) + payload"""
        info = typ | (size_code << 4) | (0x80 if is_arr else 0)
        return bytes([name, info]) + extra + payload

    def test_scalar_types_and_bool(self):
        T = self.tag
        data = (T(1, 1, 0, payload=b'\x03')                                   # Byte
                + T(2, 2, 2, payload=struct.pack('<i', -70000))                # Int
                + T(3, 4, 2, payload=struct.pack('<f', 1.5))                   # Float
                + T(4, 3, 0, is_arr=True)                                      # Bool true: the array bit IS the value, no payload
                + T(5, 3, 0, is_arr=False)                                     # Bool false
                + T(7, 5, 0, payload=X.encode_index(-2))                       # Object -> import 1 (index -2)
                + b'\x00')
        r = reader(data, self.NAMES)
        props = X.read_properties(r)
        self.assertEqual(props, {'Format': 3, 'Count': -70000, 'Scale': 1.5, 'Flag': True, 'Color': False, 'Tex': -2})
        self.assertEqual(r.p, len(data))

    def test_struct_array_string_sizes_are_skipped(self):
        T = self.tag
        data = (T(13, 10, 2, extra=bytes([13]), payload=b'\xff\xff\xff\x00')       # struct: its name follows the info byte; size code 2 = 4 bytes
                + T(6, 9, 5, extra=bytes([6]), payload=b'abcdef')                  # array, size code 5: a u8 size follows (6)
                + T(8, 7, 6, extra=struct.pack('<H', 300), payload=b'z' * 300)      # string, size code 6: u16 size
                + T(9, 13, 7, extra=struct.pack('<i', 70000), payload=b'q' * 70000)  # size code 7: i32 size
                + T(1, 1, 0, payload=b'\x09') + b'\x00')
        r = reader(data, self.NAMES)
        props = X.read_properties(r)
        self.assertEqual(props['Format'], 9)
        self.assertEqual(r.p, len(data))

    def test_size_codes(self):
        T = self.tag
        for code, size in ((0, 1), (1, 2), (2, 4), (3, 12), (4, 16)):
            data = T(6, 9, code, payload=b'\xaa' * size) + T(1, 1, 0, payload=b'\x05') + b'\x00'
            r = reader(data, self.NAMES)
            self.assertEqual(X.read_properties(r), {'Arr': None, 'Format': 5})
            self.assertEqual(r.p, len(data))

    def test_array_index_forms(self):
        T = self.tag
        data = (T(10, 1, 0, is_arr=True, extra=bytes([5]), payload=b'\x01')                  # one byte: 5
                + T(11, 1, 0, is_arr=True, extra=bytes([0x81, 0x23]), payload=b'\x02')       # two bytes: ((0x81 << 8) | 0x23) & 0x3FFF = 291
                + T(12, 1, 0, is_arr=True, extra=bytes([0xC0, 0x01, 0x02, 0x03]), payload=b'\x03')   # four bytes: & 0x3FFFFF = 0x010203
                + b'\x00')
        names = list(self.NAMES)
        r = reader(data, names)
        props = X.read_properties(r)
        self.assertEqual(props, {'Elem[5]': 1, 'Elem2[291]': 2, 'Elem3[66051]': 3})
        self.assertEqual(r.p, len(data))

    def test_element_zero_of_an_array_property_is_stored_plain(self):
        data = self.tag(1, 1, 0, is_arr=True, extra=bytes([0]), payload=b'\x07') + b'\x00'
        self.assertEqual(X.read_properties(reader(data, self.NAMES)), {'Format': 7})


# ---------------------------------------------------------------------------------------------------------------------
# synthetic: textures + PNG
# ---------------------------------------------------------------------------------------------------------------------
RED, BLUE = 0xF800, 0x001F


def dxt1_block(c0, c1, indices):
    """indices: 16 values in pixel order (y * 4 + x)"""
    bits = 0
    for i, v in enumerate(indices):
        bits |= v << (2 * i)
    return struct.pack('<HHI', c0, c1, bits)


class TestTextures(unittest.TestCase):
    def test_rgb565_expansion(self):
        self.assertEqual(X._rgb565(0xFFFF), (255, 255, 255))
        self.assertEqual(X._rgb565(0), (0, 0, 0))
        self.assertEqual(X._rgb565(RED), (255, 0, 0))
        self.assertEqual(X._rgb565(0x07E0), (0, 255, 0))
        self.assertEqual(X._rgb565(0x8410), (132, 130, 132))     # r5 = 16 -> 132, g6 = 32 -> 130, b5 = 16 -> 132

    def test_dxt1_four_colour_mode_and_pixel_order(self):
        # row 0: indices 0 1 2 3, row 1: 3 2 1 0, rows 2-3 all index 1
        idx = [0, 1, 2, 3, 3, 2, 1, 0] + [1] * 8
        ch, rows = X.decode_dxt(dxt1_block(RED, BLUE, idx), 4, 4, 'dxt1')
        self.assertEqual(ch, 3)
        w, h, ch2, img = png_decode(X.png_encode(4, 4, ch, rows))
        self.assertEqual((w, h, ch2), (4, 4, 3))
        self.assertEqual(pixel(img, 0, 0, 3), (255, 0, 0))
        self.assertEqual(pixel(img, 1, 0, 3), (0, 0, 255))
        self.assertEqual(pixel(img, 2, 0, 3), (170, 0, 85))      # (2 c0 + c1) / 3
        self.assertEqual(pixel(img, 3, 0, 3), (85, 0, 170))      # (c0 + 2 c1) / 3
        self.assertEqual(pixel(img, 0, 1, 3), (85, 0, 170))
        self.assertEqual(pixel(img, 3, 1, 3), (255, 0, 0))
        self.assertEqual(pixel(img, 2, 3, 3), (0, 0, 255))

    def test_dxt1_three_colour_mode_with_transparent_index(self):
        idx = [0, 1, 2, 3] + [0] * 12
        ch, rows = X.decode_dxt(dxt1_block(BLUE, RED, idx), 4, 4, 'dxt1')   # c0 <= c1
        self.assertEqual(ch, 4)                                            # a transparent texel promotes the image to RGBA
        self.assertEqual(pixel(rows_without_filter(rows, 4, 4, 4), 2, 0, 4), (127, 0, 127, 255))   # (c0 + c1) / 2
        self.assertEqual(pixel(rows_without_filter(rows, 4, 4, 4), 3, 0, 4)[3], 0)
        self.assertEqual(pixel(rows_without_filter(rows, 4, 4, 4), 0, 0, 4), (0, 0, 255, 255))

    def test_dxt1_three_colour_mode_without_index_3_stays_rgb(self):
        ch, rows = X.decode_dxt(dxt1_block(BLUE, RED, [0, 1, 2] * 5 + [0]), 4, 4, 'dxt1')
        self.assertEqual(ch, 3)

    def test_block_layout_row_major_top_to_bottom(self):
        # 8 x 8: blocks (0,0) red, (1,0) blue, (0,1) green, (1,1) white
        solid = lambda c: dxt1_block(c, c, [0] * 16)
        data = solid(RED) + solid(BLUE) + solid(0x07E0) + solid(0xFFFF)
        ch, rows = X.decode_dxt(data, 8, 8, 'dxt1')
        img = rows_without_filter(rows, 8, 8, 3)
        self.assertEqual(pixel(img, 0, 0, 3), (255, 0, 0))
        self.assertEqual(pixel(img, 7, 3, 3), (0, 0, 255))
        self.assertEqual(pixel(img, 0, 7, 3), (0, 255, 0))
        self.assertEqual(pixel(img, 7, 7, 3), (255, 255, 255))

    def test_dxt3_alpha_nibbles_and_forced_four_colour_mode(self):
        alpha = 0
        for i, a in enumerate([0xF, 0x8, 0x0, 0x3] + [0xF] * 12):
            alpha |= a << (4 * i)
        block = struct.pack('<Q', alpha) + dxt1_block(BLUE, RED, [0, 1, 2, 3] + [0] * 12)   # c0 <= c1 but DXT3 never uses the 3-colour mode
        ch, rows = X.decode_dxt(block, 4, 4, 'dxt3')
        img = rows_without_filter(rows, 4, 4, 4)
        self.assertEqual(ch, 4)
        self.assertEqual([pixel(img, x, 0, 4)[3] for x in range(4)], [255, 136, 0, 51])
        self.assertEqual(pixel(img, 2, 0, 4)[:3], (85, 0, 170))   # 4-colour: (2 c0 + c1) / 3 with c0 = blue
        self.assertEqual(pixel(img, 3, 0, 4)[:3], (170, 0, 85))

    def test_dxt5_alpha_modes(self):
        def block(a0, a1, ids):
            bits = 0
            for i, v in enumerate(ids):
                bits |= v << (3 * i)
            return bytes([a0, a1]) + bits.to_bytes(6, 'little') + dxt1_block(RED, RED, [0] * 16)
        ch, rows = X.decode_dxt(block(255, 0, [0, 1, 2, 7] + [0] * 12), 4, 4, 'dxt5')   # a0 > a1: 8 levels
        a = [pixel(rows_without_filter(rows, 4, 4, 4), x, 0, 4)[3] for x in range(4)]
        self.assertEqual(a, [255, 0, 218, 36])                       # (6 * 255) / 7, (1 * 255) / 7
        ch, rows = X.decode_dxt(block(0, 255, [0, 1, 2, 6, 7] + [0] * 11), 4, 4, 'dxt5')   # a0 <= a1: 6 levels + 0 + 255
        a = [pixel(rows_without_filter(rows, 4, 4, 4), x, 0, 4)[3] for x in range(4)] + [pixel(rows_without_filter(rows, 4, 4, 4), 0, 1, 4)[3]]
        self.assertEqual(a, [0, 255, 51, 0, 255])

    def test_non_multiple_of_four_and_short_data(self):
        ch, rows = X.decode_dxt(dxt1_block(RED, RED, [0] * 16), 2, 2, 'dxt1')
        self.assertEqual(len(rows), (1 + 2 * 3) * 2)
        with self.assertRaises(X.ExtractError):
            X.decode_dxt(b'\0' * 7, 4, 4, 'dxt1')

    def test_png_round_trip(self):
        rng = random.Random(5)
        for w, h, ch in ((1, 1, 3), (5, 3, 3), (4, 4, 4), (33, 2, 4)):
            pix = [bytes(rng.randrange(256) for _ in range(w * ch)) for _ in range(h)]
            rows = b''.join(b'\x00' + r for r in pix)
            out = png_decode(X.png_encode(w, h, ch, rows))
            self.assertEqual(out, (w, h, ch, pix))
        with self.assertRaises(X.ExtractError):
            X.png_encode(2, 2, 3, b'\0' * 5)


def rows_without_filter(rows, w, h, ch):
    stride = 1 + w * ch
    return [rows[y * stride + 1:(y + 1) * stride] for y in range(h)]


# ---------------------------------------------------------------------------------------------------------------------
# synthetic: conversion, clips, glb
# ---------------------------------------------------------------------------------------------------------------------
def reflect(v):          # the linear part of the Unreal -> glTF map: (x, y, z) -> (-x, z, -y), det -1
    return (-v[0], v[2], -v[1])


def reflect_inv(v):
    return (-v[0], -v[2], v[1])


class TestConversion(unittest.TestCase):
    def test_point_and_direction_formulas(self):
        k = 0.36 / 50
        self.assertTrue(close(X.convert_point((0, 0, 126), (0, 0, 126), k), (0, 0.88, 0)))     # the mesh origin sits at hull centre height
        self.assertTrue(close(X.convert_point((10, 20, 136), (0, 0, 126), k), (-10 * k, 10 * k + 0.88, -20 * k)))
        self.assertTrue(close(X.convert_dir((1, 2, 3), 0.5), (-0.5, 1.5, -1.0)))
        # raw +Y (the way the Gorge faces) must become -Z (our forward), raw +X (its left) must become -X
        self.assertLess(X.convert_dir((0, 1, 0), 1)[2], 0)
        self.assertLess(X.convert_dir((1, 0, 0), 1)[0], 0)

    def test_rotation_rule_is_the_conjugated_reflection(self):
        rng = random.Random(11)
        for _ in range(25):
            true = rand_unit_quat(rng)   # a TRUE local rotation in Unreal space
            probe = [(1, 0, 0), (0, 1, 0), (0, 0, 1), (0.3, -0.5, 0.8)]
            want = [reflect(X.qrot(true, reflect_inv(v))) for v in probe]   # M R M^-1 applied to v
            root = X.convert_rotation(true, True)                        # UE2 stores the root bone's true rotation as is
            other = X.convert_rotation(qconj(true), False)               # and every other bone conjugated
            for q in (root, other):
                self.assertAlmostEqual(sum(c * c for c in q), 1.0, places=9)
                self.assertTrue(all(close(X.qrot(q, v), w, 1e-9) for v, w in zip(probe, want)))
            # the two wrong rules must NOT reproduce it for a generic rotation
            wrong = X.convert_rotation(true, False)
            self.assertFalse(all(close(X.qrot(wrong, v), w, 1e-6) for v, w in zip(probe, want)))

    def test_the_gorge_frame_is_the_hand_written_map(self):
        """frame_from_rot((0, -90 deg, 0)) is exactly the map the Gorge was converted with before the weapons came: (-x, z, -y) and the lift."""
        self.assertEqual(X.GORGE_FRAME, X.frame_from_rot((0, -16384, 0), X.HULL_HALF_HEIGHT))
        self.assertEqual(X.GORGE_FRAME.axes, ((0, -1), (2, 1), (1, -1)))
        self.assertEqual(X.GORGE_FRAME.lift, X.HULL_HALF_HEIGHT)
        self.assertEqual(X.frame_from_rot((0, 49152, 0)), X.frame_from_rot((0, -16384, 0)))   # (a rotator is mod 65536)

    @staticmethod
    def matrix(frame):
        """The 3x3 integer matrix (rows) of a Frame's axes."""
        return [[sign if j == src else 0 for j in range(3)] for src, sign in frame.axes]

    def test_every_supported_rotator_gives_a_reflecting_signed_permutation(self):
        for rot in [(0, y, 0) for y in (0, 16384, 32768, -16384)] + [(32768, 0, 0), (0, 0, 32768), (0, 32768, 32768), (32768, 16384, 32768)]:
            f = X.frame_from_rot(rot)
            m = self.matrix(f)
            self.assertEqual(sorted(src for src, _ in f.axes), [0, 1, 2], rot)
            self.assertTrue(all(sign in (1, -1) for _, sign in f.axes), rot)
            det = (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                   + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]))
            self.assertEqual(det, -1, 'Unreal is left-handed, three.js right-handed: the map is a reflection %s' % (rot,))

    def test_the_two_shield_gun_frames(self):
        """First person RotOrigin (0, 0, 0): raw +x (the muzzle) is forward (-z), +y right (+x), +z up (+y). Third person (yaw 180, roll 180):
        raw +x is +z, +y is +x, +z is -y (the gun is in the frame of the Gorge's Bone_weapon bone)."""
        first, third = X.frame_from_rot((0, 0, 0)), X.frame_from_rot((0, 32768, 32768))
        self.assertTrue(close(X.convert_dir((1, 0, 0), 1, first), (0, 0, -1)))
        self.assertTrue(close(X.convert_dir((0, 1, 0), 1, first), (1, 0, 0)))
        self.assertTrue(close(X.convert_dir((0, 0, 1), 1, first), (0, 1, 0)))
        self.assertTrue(close(X.convert_dir((1, 0, 0), 1, third), (0, 0, 1)))
        self.assertTrue(close(X.convert_dir((0, 1, 0), 1, third), (1, 0, 0)))
        self.assertTrue(close(X.convert_dir((0, 0, 1), 1, third), (0, -1, 0)))
        self.assertTrue(close(X.convert_point((10, 20, 30), (0, 0, 0), 0.02, first), (0.4, 0.6, -0.2)))   # no lift for a weapon

    def test_unsupported_rotators_are_refused_with_a_message(self):
        for rot in ((0, 8192, 0), (16384, 0, 0), (0, 0, 16384), (0, 0, -16384), (5, 0, 0)):
            with self.assertRaises(X.ExtractError) as cm:
                X.frame_from_rot(rot)
            self.assertIn('RotOrigin', str(cm.exception))

    def test_the_rotation_rule_holds_in_every_frame(self):
        """A true rotation Q of the bone (the root stores it as is, every other bone conjugated) must come out as T Q T^-1 for the frame's linear map T."""
        rng = random.Random(21)
        for rot in ((0, -16384, 0), (0, 0, 0), (0, 32768, 32768), (0, 16384, 0), (32768, 0, 0)):
            f = X.frame_from_rot(rot)
            m = self.matrix(f)
            apply = lambda v: tuple(sum(m[i][j] * v[j] for j in range(3)) for i in range(3))
            unapply = lambda v: tuple(sum(m[j][i] * v[j] for j in range(3)) for i in range(3))   # (the transpose is the inverse)
            for _ in range(10):
                true = rand_unit_quat(rng)
                probe = [(1, 0, 0), (0, 1, 0), (0.3, -0.5, 0.8)]
                want = [apply(X.qrot(true, unapply(v))) for v in probe]
                for q in (X.convert_rotation(true, True, f), X.convert_rotation(qconj(true), False, f)):
                    self.assertTrue(all(close(X.qrot(q, v), w, 1e-9) for v, w in zip(probe, want)), rot)

    def test_inverse_bind_matrix_inverts_the_bind_transform(self):
        rng = random.Random(3)
        q, t = rand_unit_quat(rng), (1.5, -2.0, 0.25)
        m = X.inverse_bind_matrix(q, t)
        self.assertEqual(len(m), 16)
        for v in ((0, 0, 0), (1, 2, 3), (-0.5, 0.1, 4)):
            w = X.qrot(q, v)
            w = (w[0] + t[0], w[1] + t[1], w[2] + t[2])                 # bind transform of v
            back = tuple(m[0 + r] * w[0] + m[4 + r] * w[1] + m[8 + r] * w[2] + m[12 + r] for r in range(3))   # column-major
            self.assertTrue(close(back, v, 1e-9), (back, v))

    def test_world_transforms_chain(self):
        s = math.sqrt(0.5)
        qz90 = (0, 0, s, s)
        w = X.world_transforms([0, 0, 1], [(0, 1, 0), (1, 0, 0), (1, 0, 0)], [qz90, (0, 0, 0, 1), (0, 0, 0, 1)])
        self.assertTrue(close(w[1][1], (0, 2, 0), 1e-9))                # the child offset (1,0,0) is rotated by the parent to (0,1,0), plus the root t
        self.assertTrue(close(w[2][1], (0, 3, 0), 1e-9))


def toy_seq(frames, rate, track_time, tracks, name='Toy'):
    return {'name': name, 'frames': frames, 'rate': rate, 'move': {'track_time': track_time, 'tracks': tracks}}


class TestClips(unittest.TestCase):
    Q0 = (0.0, 0.0, 0.0, 1.0)

    def tracks(self):
        qa = (0.0, 0.0, 0.0, 1.0)
        qb = (0.0, 0.0, 0.0, -1.0)         # the same rotation as qa on the other side of the sphere
        qc = (0.0, 0.0, math.sin(0.2), math.cos(0.2))
        moving = {'q': [qa, qb, qc], 'p': [(0, 0, 130), (0, 1, 130), (0, 2, 130)], 't': [0.0, 1.0, 2.0]}
        still = {'q': [qa], 'p': [(5, 0, 0)], 't': [0.0, 1.0, 2.0]}
        return [moving, still]

    def test_one_shot_and_loop_keys(self):
        one = X.build_clip(toy_seq(3, 10.0, 3.0, self.tracks()), [0, 1], (0, 0, 126), 0.02, False)
        loop = X.build_clip(toy_seq(3, 10.0, 3.0, self.tracks()), [0, 1], (0, 0, 126), 0.02, True)
        chs = {(c['node'], c['path']): c for c in one['channels']}
        self.assertEqual(len(one['channels']), 4)                       # translation + rotation for every bone
        self.assertTrue(close(chs[(0, 'translation')]['times'], (0.0, 0.1, 0.2)))
        self.assertEqual(chs[(1, 'translation')]['times'], [0.0])       # constant tracks stay one key
        self.assertEqual(chs[(1, 'rotation')]['times'], [0.0])
        lc = {(c['node'], c['path']): c for c in loop['channels']}
        self.assertTrue(close(lc[(0, 'translation')]['times'], (0.0, 0.1, 0.2, 0.3)))   # the wrap key sits at NumFrames / Rate
        self.assertEqual(lc[(0, 'translation')]['values'][-1], lc[(0, 'translation')]['values'][0])
        self.assertEqual(lc[(0, 'rotation')]['values'][-1], lc[(0, 'rotation')]['values'][0])
        self.assertEqual(lc[(1, 'rotation')]['times'], [0.0])           # (a 1-key track is not wrapped)

    def test_root_translation_uses_the_point_rule_and_others_the_direction_rule(self):
        clip = X.build_clip(toy_seq(3, 10.0, 3.0, self.tracks()), [0, 1], (0, 0, 126), 0.02, False)
        chs = {(c['node'], c['path']): c for c in clip['channels']}
        self.assertTrue(close(chs[(0, 'translation')]['values'][0], X.convert_point((0, 0, 130), (0, 0, 126), 0.02)))
        self.assertTrue(close(chs[(1, 'translation')]['values'][0], X.convert_dir((5, 0, 0), 0.02)))

    def test_quaternions_are_unit_and_stay_in_one_hemisphere(self):
        clip = X.build_clip(toy_seq(3, 10.0, 3.0, self.tracks()), [0, 1], (0, 0, 126), 0.02, False)
        rot = [c for c in clip['channels'] if c['node'] == 0 and c['path'] == 'rotation'][0]['values']
        for q in rot:
            self.assertAlmostEqual(sum(c * c for c in q), 1.0, places=9)
        for a, b in zip(rot, rot[1:]):
            self.assertGreaterEqual(sum(x * y for x, y in zip(a, b)), 0)

    def test_track_time_rescales_key_times(self):
        clip = X.build_clip(toy_seq(3, 10.0, 6.0, self.tracks()), [0, 1], (0, 0, 126), 0.02, False)   # TrackTime 6 for 3 frames: keys * 0.5
        t = [c for c in clip['channels'] if c['node'] == 0 and c['path'] == 'translation'][0]['times']
        self.assertTrue(close(t, (0.0, 0.05, 0.1)))

    def test_single_pose_gets_a_duration(self):
        still = [{'q': [self.Q0], 'p': [(0, 0, 130)], 't': [0.0]}, {'q': [self.Q0], 'p': [(1, 0, 0)], 't': [0.0]}]
        clip = X.build_clip(toy_seq(1, 20.0, 1.0, still), [0, 1], (0, 0, 126), 0.02, False)
        for c in clip['channels']:
            self.assertEqual(c['times'], [0.0, 0.05])
            self.assertEqual(len(c['values']), 2)
            self.assertEqual(c['values'][0], c['values'][1])

    def test_bad_key_times_are_refused(self):
        bad = self.tracks()
        bad[0]['t'] = [0.0, 2.0, 1.0]
        with self.assertRaises(X.ExtractError):
            X.build_clip(toy_seq(3, 10.0, 3.0, bad), [0, 1], (0, 0, 126), 0.02, False)

    def test_the_shield_gun_clip_lists(self):
        self.assertEqual(X.WEAPON_CLIPS_1ST, ['Idle', 'Select', 'PutDown', 'Charge', 'Charged', 'Fire', 'Shield'])
        self.assertEqual(X.WEAPON_CLIPS_3RD, ['Still'])
        self.assertEqual(X.WEAPON_LOOPS, ('Idle', 'Charged'))
        self.assertTrue(set(X.WEAPON_LOOPS) <= set(X.WEAPON_CLIPS_1ST))

    def test_clip_list_and_loop_rule(self):
        self.assertEqual(len(X.CLIPS), 36)
        self.assertEqual(len(set(X.CLIPS)), 36)
        self.assertEqual(sorted(c for c in X.CLIPS if X.is_loop(c)),
                         sorted(['Idle_Rifle', 'Idle_Rest', 'RunF', 'RunB', 'RunL', 'RunR'] + [p + '_Mid' for p in ('Jump', 'JumpF', 'JumpB', 'JumpL', 'JumpR')]))
        self.assertFalse(X.is_loop('DodgeF'))
        self.assertFalse(X.is_loop('Jump_Takeoff'))


def toy_model():
    png = X.png_encode(1, 1, 3, b'\x00\xff\x80\x10')
    ident = (0.0, 0.0, 0.0, 1.0)
    bones = [{'name': 'Root', 'parent': 0, 't': (0.0, 1.0, 0.0), 'q': ident}, {'name': 'Tip', 'parent': 0, 't': (0.0, 1.0, 0.0), 'q': ident}]
    verts = {'positions': [(0.0, 1.0, 0.0), (1.0, 1.0, 0.0), (0.0, 2.0, 0.0), (1.0, 2.0, 0.0)],
             'normals': [(0.0, 0.0, 1.0)] * 4, 'uvs': [(0.0, 0.0), (1.27, 0.0), (0.0, 1.0), (1.27, 1.0)],
             'joints': [[0, 0, 0, 0], [0, 1, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0]],
             'weights': [[1.0, 0.0, 0.0, 0.0], [0.5, 0.5, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0]]}
    ch = lambda node, path, times, vals: {'node': node, 'path': path, 'times': times, 'values': vals}
    clip = {'name': 'Wave', 'loop': True, 'channels': [
        ch(0, 'translation', [0.0, 0.5, 1.0], [(0.0, 1.0, 0.0), (0.0, 1.2, 0.0), (0.0, 1.0, 0.0)]), ch(0, 'rotation', [0.0], [ident]),
        ch(1, 'translation', [0.0], [(0.0, 1.0, 0.0)]), ch(1, 'rotation', [0.0, 0.5, 1.0], [ident, (0.0, 0.0, 0.2, 0.9798), ident])]}
    return {'bones': bones, 'verts': verts, 'prims': [{'indices': [0, 1, 2, 1, 3, 2], 'material': 0}],
            'materials': [{'name': 'Skin', 'image': 0}], 'images': [png], 'clips': [clip]}


class TestGlbWriter(unittest.TestCase):
    def test_two_bone_toy(self):
        data = X.write_glb(toy_model())
        js, binary = X.read_glb(data)
        self.assertEqual(struct.unpack_from('<III', data, 0), (0x46546C67, 2, len(data)))
        self.assertEqual(len(data) % 4, 0)
        self.assertEqual([n['name'] for n in js['nodes']], ['Gorge', 'Root', 'Tip', 'GorgeMesh'])
        self.assertEqual(js['nodes'][0]['children'], [1, 3])            # the mesh hangs off the top node, never off a bone
        self.assertEqual(js['nodes'][1]['children'], [2])
        self.assertEqual(js['nodes'][3], {'name': 'GorgeMesh', 'mesh': 0, 'skin': 0})
        self.assertEqual(js['skins'][0]['joints'], [1, 2])
        self.assertEqual(js['skins'][0]['skeleton'], 1)
        # inverse bind matrices: Root bind world = (0,1,0) -> inverse translates by -1; Tip = (0,2,0) -> -2
        ibm = X.accessor_values(js, binary, js['skins'][0]['inverseBindMatrices'])
        self.assertEqual(len(ibm), 2)
        self.assertTrue(close(ibm[0][12:16], (0, -1, 0, 1)))
        self.assertTrue(close(ibm[1][12:16], (0, -2, 0, 1)))
        # attributes
        prim = js['meshes'][0]['primitives'][0]
        self.assertEqual(sorted(prim['attributes']), ['JOINTS_0', 'NORMAL', 'POSITION', 'TEXCOORD_0', 'WEIGHTS_0'])
        self.assertEqual(js['accessors'][prim['attributes']['JOINTS_0']]['componentType'], X.GL_UBYTE)
        self.assertEqual(js['accessors'][prim['indices']]['componentType'], X.GL_USHORT)
        self.assertEqual(js['accessors'][prim['attributes']['POSITION']]['min'], [0.0, 1.0, 0.0])
        self.assertEqual(js['accessors'][prim['attributes']['POSITION']]['max'], [1.0, 2.0, 0.0])
        self.assertEqual(X.accessor_values(js, binary, prim['indices'])[:3], [(0,), (1,), (2,)])
        # material + image + sampler
        self.assertEqual(js['materials'][0]['name'], 'Skin')
        self.assertEqual(js['materials'][0]['pbrMetallicRoughness']['metallicFactor'], 0.0)
        img = js['images'][0]
        v = js['bufferViews'][img['bufferView']]
        self.assertEqual(img['mimeType'], 'image/png')
        self.assertEqual(binary[v['byteOffset']:v['byteOffset'] + v['byteLength']], toy_model()['images'][0])
        self.assertEqual(js['samplers'][0], {'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497})
        # animation: 4 channels, LINEAR, the identical time arrays share an accessor
        anim = js['animations'][0]
        self.assertEqual(anim['name'], 'Wave')
        self.assertEqual(len(anim['channels']), 4)
        self.assertTrue(all(s['interpolation'] == 'LINEAR' for s in anim['samplers']))
        self.assertEqual(anim['samplers'][0]['input'], anim['samplers'][3]['input'])
        self.assertEqual({c['target']['node'] for c in anim['channels']}, {1, 2})
        for view in js['bufferViews']:
            self.assertEqual(view['byteOffset'] % 4, 0)
            self.assertNotIn('byteStride', view)
        info = X.validate_glb(data)
        self.assertEqual((info['joints'], info['vertices'], info['animations']), (2, 4, 1))

    def test_the_root_node_carries_the_models_name(self):
        m = toy_model()
        m['name'] = 'ShieldGun'
        js, _ = X.read_glb(X.write_glb(m))
        self.assertEqual([n['name'] for n in js['nodes']], ['ShieldGun', 'Root', 'Tip', 'ShieldGunMesh'])
        self.assertEqual(js['meshes'][0]['name'], 'ShieldGun')
        self.assertEqual(X.write_glb(toy_model()), X.write_glb({**toy_model(), 'name': 'Gorge'}), 'no name = the Gorge, byte for byte')

    def test_a_texture_with_alpha_goes_into_the_glb_as_an_rgba_png(self):
        rgba = X.png_encode(2, 2, 4, (b'\0' + bytes([10, 20, 30, 40] * 2)) * 2)
        m = toy_model()
        m['images'] = [rgba]
        js, binary = X.read_glb(X.write_glb(m))
        v = js['bufferViews'][js['images'][0]['bufferView']]
        w, h, ch, rows = png_decode(binary[v['byteOffset']:v['byteOffset'] + v['byteLength']])
        self.assertEqual((w, h, ch, pixel(rows, 1, 1, 4)), (2, 2, 4, (10, 20, 30, 40)))
        self.assertNotIn('alphaMode', js['materials'][0], 'alpha is the specular mask, not transparency: the glTF default (OPAQUE) ignores it')

    def test_validator_rejects_damage(self):
        data = bytearray(X.write_glb(toy_model()))
        with self.assertRaises(X.ExtractError):
            X.validate_glb(bytes(data[:-4]))                            # length field no longer matches
        bad = bytearray(data)
        bad[0] = 0
        with self.assertRaises(X.ExtractError):
            X.validate_glb(bytes(bad))
        m = toy_model()
        m['verts']['weights'][0] = [0.7, 0.0, 0.0, 0.0]
        with self.assertRaises(X.ExtractError):
            X.validate_glb(X.write_glb(m))                              # weights must sum to 1
        m = toy_model()
        m['clips'][0]['channels'][0]['times'] = [0.0, 1.0, 0.5]
        with self.assertRaises(X.ExtractError):
            X.validate_glb(X.write_glb(m))                              # key times must increase
        m = toy_model()
        m['prims'][0]['indices'][0] = 9
        with self.assertRaises(X.ExtractError):
            X.write_glb(m)                                              # index past the vertex count


class TestCorruptPackages(unittest.TestCase):
    """Sizes and lengths out of a corrupt package must fail fast with an ExtractError that names the file: never walk the reader backwards
    (an endless loop), never spin for millions of elements."""
    NAMES = ['None', 'Format', 'Foo', 'Texture', 'Sound', 'Core', 'Class']
    PAYLOAD_AT = 64   # build_package puts the first export's data right behind the 64-byte header

    def write_pkg(self, d, filename, payload, cls_name_idx=3):
        data = build_package(self.NAMES, [(5, 6, 0, cls_name_idx)], [(-1, 0, 2, 0, payload)])
        p = Path(d) / filename
        p.write_bytes(data)
        return X.Package(p)

    def test_property_size_that_points_back_to_the_tag_fails_fast(self):
        # the tag [name 1, info 0x72 (Int, size code 7 = an i32 size follows), i32 -6]: the old reader jumped back to the tag start for ever
        r = reader(bytes([1, 0x72]) + struct.pack('<i', -6) + bytes(8), self.NAMES)
        verdict, err = finishes(lambda: X.read_properties(r))
        self.assertEqual(verdict, 'raised', 'read_properties %s' % verdict)
        self.assertIsInstance(err, X.ExtractError)

    def test_property_sizes_past_the_end_of_the_file_are_refused(self):
        for tag in (bytes([1, 0x72]) + struct.pack('<i', 0x7FFFFFF0), bytes([1, 0x62]) + struct.pack('<H', 60000), bytes([1, 0x52, 200])):
            with self.subTest(tag=tag.hex()):
                verdict, err = finishes(lambda: X.read_properties(reader(tag + bytes(10), self.NAMES)))
                self.assertEqual(verdict, 'raised')
                self.assertIsInstance(err, X.ExtractError)

    def test_blob_and_array_lengths_are_checked_against_the_file(self):
        for n in (-15, -1, 1 << 30):
            with self.subTest(n=n):
                with self.assertRaises(X.ExtractError):
                    reader(X.encode_index(n) + bytes(64)).blob()
        self.assertEqual(reader(X.encode_index(3) + b'abc').blob(), b'abc')
        with self.assertRaises(X.ExtractError):
            reader(X.encode_index(1_000_000) + bytes(64)).arr(lambda: None)   # (an element is at least one byte: this cannot fit)

    def test_negative_mip_length_does_not_spin(self):
        # thousands of mips whose data length is -15: each one moves the reader by 4 + 1 - 15 + 10 = 0 bytes when its skip position agrees
        head = bytes([1, 0x01, 3]) + b'\x00' + X.encode_index(6000)
        start = self.PAYLOAD_AT + len(head)
        mip = struct.pack('<i', start - 10) + X.encode_index(-15) + bytes(11)
        with tempfile.TemporaryDirectory() as d:
            pkg = self.write_pkg(d, 'Skins.utx', head + mip + bytes(8000))
            verdict, err = finishes(lambda: X.read_texture(pkg, pkg.exports[0]))
        self.assertEqual(verdict, 'raised', 'read_texture %s' % verdict)
        self.assertIsInstance(err, X.ExtractError)
        self.assertIn('Skins.utx', str(err))
        self.assertIn('-15', str(err))

    def test_negative_sound_length_is_refused_and_names_the_file(self):
        payload = b'\x00' + b'\x00' + struct.pack('<f', 1.0) + struct.pack('<i', 0) + X.encode_index(-20) + bytes(100)
        with tempfile.TemporaryDirectory() as d:
            pkg = self.write_pkg(d, 'Sounds1.uax', payload, cls_name_idx=4)
            verdict, err = finishes(lambda: X.read_sound(pkg, pkg.exports[0]))
        self.assertEqual(verdict, 'raised')
        self.assertIsInstance(err, X.ExtractError)
        self.assertIn('Sounds1.uax', str(err))

    def test_a_texture_cut_off_in_its_first_mip_names_the_file(self):
        payload = bytes([1, 0x01, 3]) + b'\x00' + X.encode_index(2) + struct.pack('<i', 0)
        with tempfile.TemporaryDirectory() as d:
            pkg = self.write_pkg(d, 'Cutoff.utx', payload)
            with self.assertRaises(X.ExtractError) as cm:
                X.read_texture(pkg, pkg.exports[0])
        self.assertIn('Cutoff.utx', str(cm.exception))

    def test_damaged_context_wraps_every_reader_failure(self):
        for exc in (IndexError('x'), struct.error('y'), ValueError('nan'), OverflowError('huge'), MemoryError()):
            with self.subTest(exc=type(exc).__name__):
                with self.assertRaises(X.ExtractError) as cm:
                    with X.damaged(os.path.join('some', 'dir', 'Jugg.ukx'), 'JuggMaleA'):
                        raise exc
                self.assertIn('Jugg.ukx', str(cm.exception))
                self.assertIn('JuggMaleA', str(cm.exception))
        with self.assertRaises(X.ExtractError) as cm:   # an ExtractError without the file name gets it
            with X.damaged('Jugg.ukx', 'JuggMaleA'):
                raise X.ExtractError('bad thing')
        self.assertIn('Jugg.ukx', str(cm.exception))
        self.assertIn('bad thing', str(cm.exception))

    def test_a_package_cut_off_inside_its_tables_names_the_file(self):
        names = ['None', 'Core', 'Class', 'Texture', 'Foo']
        data = build_package(names, [(1, 2, 0, 3)], [(-1, 0, 4, 0, b'\x00abc'), (-1, 0, 4, 0, b'\x00abc')])
        with tempfile.TemporaryDirectory() as d:
            for cut in (len(data) - 3, len(data) - 12, 70, 40):
                with self.subTest(cut=cut):
                    p = Path(d) / 'Cut.ukx'
                    p.write_bytes(data[:cut])
                    with self.assertRaises(X.ExtractError) as cm:
                        X.Package(p)
                    self.assertIn('Cut.ukx', str(cm.exception))

    def test_export_with_a_negative_size_or_offset_is_refused(self):
        data = build_package(['None', 'Core', 'Class', 'Texture', 'Foo'], [(1, 2, 0, 3)], [(-1, 0, 4, 0, b'\x00abc')])
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'x.utx'
            p.write_bytes(data)
            pkg = X.Package(p)
        e = pkg.exports[0]
        for bad in (e._replace(size=-4), e._replace(offset=-8)):
            with self.assertRaises(X.ExtractError):
                pkg.reader(bad)

    def test_nan_or_inf_from_a_corrupt_file_is_a_clean_failure(self):
        for exc in (ValueError('Out of range float values are not JSON compliant'), OverflowError('cannot convert float infinity to integer')):
            with self.subTest(exc=type(exc).__name__):
                with tempfile.TemporaryDirectory() as d, mock.patch.object(X, 'extract_sounds', side_effect=exc):
                    err = io.StringIO()
                    with mock.patch.object(sys, 'stderr', err):
                        self.assertEqual(X.main([d, '--only', 'sounds', '--no-git-check']), 1)
                    self.assertIn('ut2004_extract:', err.getvalue())


class TestSoundFiles(unittest.TestCase):
    def test_is_whole_wav(self):
        with tempfile.TemporaryDirectory() as d:
            good = Path(d) / 'good.wav'
            good.write_bytes(tiny_wav())
            self.assertTrue(X.is_whole_wav(good))
            w = tiny_wav()
            cases = {'empty': b'', 'riff only': b'RIFF', 'junk': b'RIFFmine', 'cut off': w[:-10], 'trailing bytes': w + b'\0\0',
                     'not wave': w[:8] + b'AVI ' + w[12:], 'text': b'<html>no</html>' * 10}
            for label, blob in cases.items():
                p = Path(d) / (label.replace(' ', '_') + '.wav')
                p.write_bytes(blob)
                self.assertFalse(X.is_whole_wav(p), label)
            self.assertFalse(X.is_whole_wav(Path(d) / 'missing.wav'))

    def test_a_dying_write_of_sounds_json_keeps_the_old_one(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / 'sounds.json'
            target.write_text('{"old": []}', encoding='utf-8')
            with mock.patch.object(os, 'replace', side_effect=OSError(28, 'No space left on device')):
                with self.assertRaises(OSError):
                    X.write_atomic(target, b'{"new": []}')
            self.assertEqual(target.read_text(encoding='utf-8'), '{"old": []}')
            self.assertEqual(os.listdir(d), ['sounds.json'], 'a temp file is left behind')


def toy_skins():
    """A model dict with only what export_skins reads: two skins named like the Gorge's (body, head) and a third that is neither; tiny PNGs."""
    def png(v):
        return X.png_encode(2, 2, 3, (b'\0' + bytes([v, v, v] * 2)) * 2)
    return {'materials': [{'name': 'JuggMaleABodyA', 'image': 0}, {'name': 'JuggMaleAHeadA', 'image': 1}, {'name': 'SomethingElse', 'image': 2}],
            'images': [png(10), png(20), png(30)]}


class TestSkinPngs(unittest.TestCase):
    def test_skin_names_map_to_the_two_files_the_game_reads(self):
        self.assertEqual(X.skin_png_name('JuggMaleABodyA'), 'gorge-body.png')
        self.assertEqual(X.skin_png_name('JuggMaleAHeadA'), 'gorge-head.png')
        self.assertEqual(X.skin_png_name('jugg_BODY_2'), 'gorge-body.png')
        self.assertIsNone(X.skin_png_name('JuggMaleAArmor'))
        self.assertIsNone(X.skin_png_name(''))

    def test_the_shield_gun_skin_has_its_own_table(self):
        self.assertEqual(X.skin_png_name('ShieldTex0', X.WEAPON_PNG), 'shieldgun.png')
        self.assertEqual(X.skin_png_name('shieldtex0', X.WEAPON_PNG), 'shieldgun.png')
        self.assertIsNone(X.skin_png_name('LinkTex0', X.WEAPON_PNG))
        self.assertIsNone(X.skin_png_name('ShieldTex0'), 'the Gorge table knows nothing of the gun')
        self.assertIsNone(X.skin_png_name('JuggMaleABodyA', X.WEAPON_PNG))

    def test_the_shield_gun_png_is_kept_like_the_gorge_skins(self):
        rgba = lambda v: X.png_encode(2, 2, 4, (b'\0' + bytes([v, v, v, 200] * 2)) * 2)
        model = {'materials': [{'name': 'ShieldTex0', 'image': 0}], 'images': [rgba(10)]}
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            self.assertEqual(X.export_skins(model, out, log=lambda *a: None, table=X.WEAPON_PNG), ['shieldgun.png'])
            self.assertEqual((out / 'shieldgun.png').read_bytes(), model['images'][0], 'the very image of the glb, alpha included')
            (out / 'shieldgun.png').write_bytes(b'my own gun skin')
            logs = []
            self.assertEqual(X.export_skins(model, out, log=logs.append, table=X.WEAPON_PNG), [])
            self.assertEqual((out / 'shieldgun.png').read_bytes(), b'my own gun skin')
            self.assertTrue(any('shieldgun.png' in l and 'kept' in l and 'WARNING' in l for l in logs), 'not a PNG: kept, with a warning')
            self.assertEqual(X.export_skins(model, out, force=True, log=lambda *a: None, table=X.WEAPON_PNG), ['shieldgun.png'])
            self.assertEqual((out / 'shieldgun.png').read_bytes(), model['images'][0])
            self.assertEqual(os.listdir(out), ['shieldgun.png'])

    def test_the_png_is_the_very_image_of_the_glb_and_nothing_else_is_written(self):
        model = toy_skins()
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / 'local-models'   # (does not exist yet)
            logs = []
            written = X.export_skins(model, out, log=logs.append)
            self.assertEqual(written, ['gorge-body.png', 'gorge-head.png'])
            self.assertEqual(sorted(os.listdir(out)), ['gorge-body.png', 'gorge-head.png'], 'no temp file, no file for the third skin')
            self.assertEqual((out / 'gorge-body.png').read_bytes(), model['images'][0])
            self.assertEqual((out / 'gorge-head.png').read_bytes(), model['images'][1])
            w, h, ch, rows = png_decode((out / 'gorge-head.png').read_bytes())
            self.assertEqual((w, h, ch, pixel(rows, 1, 1, 3)), (2, 2, 3, (20, 20, 20)))
            self.assertTrue(any('SomethingElse' in l for l in logs), 'the skipped skin is mentioned')

    def test_an_existing_png_is_the_players_work_and_is_not_overwritten_without_force(self):
        model = toy_skins()
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            mine = X.png_encode(2, 2, 3, (b'\0' + bytes([200, 100, 50] * 2)) * 2)   # a repainted skin
            (out / 'gorge-body.png').write_bytes(mine)
            logs = []
            written = X.export_skins(model, out, log=logs.append)
            self.assertEqual(written, ['gorge-head.png'], 'only the missing one is written')
            self.assertEqual((out / 'gorge-body.png').read_bytes(), mine)
            self.assertTrue(any('gorge-body.png' in l and 'kept' in l for l in logs))
            self.assertFalse(any('WARNING' in l for l in logs), 'a real PNG gets no warning')
            # again: everything is kept, nothing is written
            before = {f: (out / f).stat().st_mtime_ns for f in os.listdir(out)}
            self.assertEqual(X.export_skins(model, out, log=lambda *a: None), [])
            self.assertEqual({f: (out / f).stat().st_mtime_ns for f in os.listdir(out)}, before)
            # --force puts the originals back
            self.assertEqual(X.export_skins(model, out, force=True, log=lambda *a: None), ['gorge-body.png', 'gorge-head.png'])
            self.assertEqual((out / 'gorge-body.png').read_bytes(), model['images'][0])

    def test_a_file_that_is_not_a_png_is_kept_too_with_a_warning(self):
        model = toy_skins()
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            (out / 'gorge-body.png').write_bytes(b'')
            (out / 'gorge-head.png').write_bytes(b'<html>oops</html>')
            logs = []
            self.assertEqual(X.export_skins(model, out, log=logs.append), [])
            self.assertEqual((out / 'gorge-body.png').read_bytes(), b'')
            self.assertEqual((out / 'gorge-head.png').read_bytes(), b'<html>oops</html>')
            self.assertEqual(sum('WARNING' in l for l in logs), 2)
            self.assertEqual(sorted(X.export_skins(model, out, force=True, log=lambda *a: None)), ['gorge-body.png', 'gorge-head.png'])
            self.assertEqual((out / 'gorge-head.png').read_bytes(), model['images'][1])

    def test_a_dying_write_keeps_the_old_png_and_leaves_no_temp_file(self):
        model = toy_skins()
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            (out / 'gorge-body.png').write_bytes(b'old')
            with mock.patch.object(os, 'replace', side_effect=OSError(28, 'No space left on device')):
                with self.assertRaises(OSError):
                    X.export_skins(model, out, force=True, log=lambda *a: None)
            self.assertEqual((out / 'gorge-body.png').read_bytes(), b'old')
            self.assertEqual(os.listdir(out), ['gorge-body.png'], 'a temp file is left behind')

    def test_force_reaches_the_skins_and_only_sounds_leaves_them_alone(self):
        with tempfile.TemporaryDirectory() as d:
            for args, want in ((['--only', 'model'], False), (['--only', 'model', '--force'], True), (['--force'], True)):
                with mock.patch.object(X, 'extract_model') as em, mock.patch.object(X, 'extract_sounds'), mock.patch.object(X, 'extract_weapon'):
                    self.assertEqual(X.main([d, '--no-git-check', *args]), 0)
                    self.assertEqual(em.call_args.kwargs.get('force'), want, args)
            with mock.patch.object(X, 'extract_model') as em, mock.patch.object(X, 'extract_sounds') as es, mock.patch.object(X, 'extract_weapon') as ew:
                self.assertEqual(X.main([d, '--no-git-check', '--only', 'sounds']), 0)
                em.assert_not_called()
                ew.assert_not_called()
                es.assert_called_once()

    def test_the_weapon_is_part_of_the_default_run_and_has_its_own_only_choice(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(X, 'extract_model') as em, mock.patch.object(X, 'extract_sounds') as es, mock.patch.object(X, 'extract_weapon') as ew:
                self.assertEqual(X.main([d, '--no-git-check']), 0)
                self.assertEqual((em.call_count, es.call_count, ew.call_count), (1, 1, 1), 'a plain run extracts everything')
                self.assertEqual(ew.call_args.kwargs.get('force'), False)
            for args, want in ((['--only', 'weapon'], False), (['--only', 'weapon', '--force'], True)):
                with mock.patch.object(X, 'extract_model') as em, mock.patch.object(X, 'extract_sounds') as es, mock.patch.object(X, 'extract_weapon') as ew:
                    self.assertEqual(X.main([d, '--no-git-check', *args]), 0)
                    em.assert_not_called()
                    es.assert_not_called()
                    self.assertEqual(ew.call_args.kwargs.get('force'), want, args)
            with mock.patch.object(X, 'extract_model') as em, mock.patch.object(X, 'extract_sounds'), mock.patch.object(X, 'extract_weapon') as ew:
                self.assertEqual(X.main([d, '--no-git-check', '--only', 'model']), 0)
                ew.assert_not_called()
                em.assert_called_once()
            with mock.patch.object(X, 'extract_weapon') as ew:
                with self.assertRaises(SystemExit):
                    X.main([d, '--only', 'nonsense'])
                ew.assert_not_called()


class TestCommandLine(unittest.TestCase):
    def test_missing_install_is_a_clean_error(self):
        self.assertEqual(X.main([os.path.join(tempfile.gettempdir(), 'no-such-ut2004-folder-xyz')]), 1)

    def test_folder_without_the_game_is_a_clean_error(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(X.main([d, '--only', 'model']), 1)

    def test_the_tools_hold_no_embedded_data(self):
        for f in X.TOOLS_DIR.iterdir():
            if f.is_file() and f.suffix == '.py':
                self.assertLess(f.stat().st_size, 150_000, f.name + ' is suspiciously big')


class TestRepoHygiene(unittest.TestCase):
    def test_nothing_of_epics_is_visible_to_git(self):
        """Every file git would track or add under pajzsugras/ (ignored folders excluded) is free of Unreal package, WAV and glb magic."""
        try:
            res = subprocess.run(['git', 'ls-files', '-c', '-o', '--exclude-standard', 'pajzsugras'], cwd=str(REPO), capture_output=True, timeout=60)
        except (OSError, subprocess.SubprocessError):
            self.skipTest('git is not available')
        if res.returncode != 0:
            self.skipTest('not a git checkout')
        files = [f for f in res.stdout.decode('utf-8', 'replace').splitlines() if f]
        self.assertGreater(len(files), 20)
        for f in files:
            self.assertFalse(f.startswith('pajzsugras/local-'), f + ' is under an ignored folder yet listed')
            p = REPO / f
            if not p.is_file():
                continue
            blob = p.read_bytes()
            self.assertNotEqual(blob[:4], b'glTF', f)
            self.assertNotEqual(blob[:4], b'RIFF', f)
            self.assertNotIn(bytes([0xC1, 0x83, 0x2A, 0x9E]), blob, f)   # the Unreal package tag


# ---------------------------------------------------------------------------------------------------------------------
# the real install
# ---------------------------------------------------------------------------------------------------------------------
@unittest.skipUnless(UT_DIR, 'no UT2004 install (set UT2004_DIR)')
class TestRealShieldGun(unittest.TestCase):
    """Weapons.ukx (package version 126) + WeaponSkins.utx (127): ShieldGun_1st (the viewmodel, 7 sequences), ShieldGun_3rd (the held model, 1 pose),
    ShieldTex0 (DXT5, the alpha is the specular mask)."""

    @classmethod
    def setUpClass(cls):
        cache = {}
        cls.m1 = X.build_weapon(UT_DIR, '1st', 1024, tex_cache=cache)
        cls.m3 = X.build_weapon(UT_DIR, '3rd', 1024, tex_cache=cache)
        cls.g1, cls.g3 = X.write_glb(cls.m1), X.write_glb(cls.m3)
        cls.cache = cache
        cls.ukx = X.Package(X.find_file(UT_DIR, 'Animations', 'Weapons.ukx'))

    def world(self, model):
        b = model['bones']
        return X.world_transforms([x['parent'] for x in b], [x['t'] for x in b], [x['q'] for x in b])

    def pose(self, model, clip, t=0.0):
        """Bone world transforms of a clip at time t (linear keys, normalised slerp-ish: good enough for a pose check)."""
        c = next(c for c in model['clips'] if c['name'] == clip)
        ts, qs = [], []
        for bi in range(len(model['bones'])):
            def at(path):
                ch = next(x for x in c['channels'] if x['node'] == bi and x['path'] == path)
                times, vs = ch['times'], ch['values']
                if len(times) == 1 or t <= times[0]:
                    return vs[0]
                if t >= times[-1]:
                    return vs[-1]
                j = next(j for j in range(1, len(times)) if t <= times[j])
                f = (t - times[j - 1]) / (times[j] - times[j - 1])
                return tuple(a + (b - a) * f for a, b in zip(vs[j - 1], vs[j]))
            ts.append(at('translation'))
            q = at('rotation')
            n = math.sqrt(sum(x * x for x in q))
            qs.append(tuple(x / n for x in q))
        return X.world_transforms([x['parent'] for x in model['bones']], ts, qs)

    def test_package_versions_and_raw_numbers(self):
        self.assertEqual((self.ukx.ver, self.ukx.lic), (126, 29))
        r1 = X.read_skeletal_mesh(self.ukx, self.ukx.find('ShieldGun_1st', 'SkeletalMesh'))
        r3 = X.read_skeletal_mesh(self.ukx, self.ukx.find('ShieldGun_3rd', 'SkeletalMesh'))
        self.assertEqual((r1['rot'], r3['rot']), ((0, 0, 0), (0, 32768, 32768)))
        for r in (r1, r3):
            self.assertEqual((r['scale'], tuple(r['origin'])), (1.0, (0.0, 0.0, 0.0)))
            self.assertEqual([b['name'] for b in r['bones']][:3], ['Bone_weapon', 'Bone_antenna', 'Bone_Flash'])
            self.assertEqual(len(r['bones']), 11)
            self.assertEqual(r['materials'], [(0, 0)])
        utx = X.Package(X.find_file(UT_DIR, 'Textures', 'WeaponSkins.utx'))
        self.assertEqual(utx.ver, 127)

    def test_exact_counts(self):
        s1, s3 = self.m1['stats'], self.m3['stats']
        self.assertEqual((s1['bones'], s1['points'], s1['wedges'], s1['tris']), (11, 896, 1413, 1478))
        self.assertEqual((s3['bones'], s3['points'], s3['wedges'], s3['tris']), (11, 514, 994, 824))
        self.assertEqual((s1['sequences'], s3['sequences']), (7, 1))
        self.assertEqual((s1['tris_per_material'], s3['tris_per_material']), ({0: 1478}, {0: 824}))
        for m in (self.m1, self.m3):
            self.assertEqual(m['name'], 'ShieldGun')
            self.assertEqual([x['name'] for x in m['materials']], ['ShieldTex0'])

    def test_sequences_names_durations_and_loops(self):
        clips = {c['name']: c for c in self.m1['clips']}
        self.assertEqual(list(clips), X.WEAPON_CLIPS_1ST)
        dur = lambda n: max(ch['times'][-1] for ch in clips[n]['channels'])
        self.assertAlmostEqual(dur('Idle'), 59 / 20, places=5)          # 59 frames at 20 fps, looped: the wrap key sits at NumFrames / Rate
        self.assertAlmostEqual(dur('Select'), 9 / 20, places=5)         # one-shots end at their last key
        self.assertAlmostEqual(dur('PutDown'), 9 / 20, places=5)
        self.assertAlmostEqual(dur('Charge'), 59 / 60, places=5)
        self.assertAlmostEqual(dur('Charged'), 60 / 60, places=5)       # looped
        self.assertAlmostEqual(dur('Fire'), 29 / 60, places=5)
        self.assertAlmostEqual(dur('Shield'), 59 / 60, places=5)
        self.assertEqual({n for n, c in clips.items() if c['loop']}, {'Idle', 'Charged'})
        for c in clips.values():
            self.assertEqual(len(c['channels']), 22)                    # translation + rotation for each of the 11 bones
        still = self.m3['clips']
        self.assertEqual([c['name'] for c in still], ['Still'])
        self.assertGreater(max(ch['times'][-1] for ch in still[0]['channels']), 0, 'a single pose still has a duration')

    def test_the_texture_is_dxt5_with_a_real_specular_alpha(self):
        (key, (w, h, fmt, ch, png)), = self.cache.items()
        self.assertEqual((key[0], key[1], w, h, fmt, ch), ('WeaponSkins', 'ShieldTex0', 1024, 1024, 'dxt5', 4))
        pw, ph, pch, rows = png_decode(png)
        self.assertEqual((pw, ph, pch), (1024, 1024, 4))
        alpha = [px for r in rows[::16] for px in r[3::4][::16]]
        self.assertTrue(min(alpha) == 0 and max(alpha) > 200, 'the alpha channel is a mask with real values (min %d max %d)' % (min(alpha), max(alpha)))
        self.assertLess(sum(1 for a in alpha if a == 255) / len(alpha), 0.5, 'not an opaque texture saved as RGBA')
        self.assertEqual(len(self.cache), 1, 'the two glbs share one decode')
        self.assertEqual(self.m1['images'], self.m3['images'])

    def test_the_gorge_refuses_a_texture_with_alpha_but_the_weapon_takes_it(self):
        with self.assertRaises(X.ExtractError) as cm:
            X.build_skeletal(self.ukx, UT_DIR, 'ShieldGun_3rd', X.WEAPON_CLIPS_3RD, lambda c: False, 0.0, 'ShieldGun', 512)
        self.assertIn('transparent', str(cm.exception))

    def test_the_first_person_gun_points_forward_and_sits_right_and_low(self):
        """RotOrigin 0: raw +x is forward. The muzzle bone is far ahead (-z) of the origin in the bind pose, and in every sequence's first pose it is still
        ahead, to the right (+x) and below the eye (-y) of the camera at the origin: the placement UT2004's own view gives the gun."""
        w = self.world(self.m1)
        flash = w[2][1]
        self.assertLess(flash[2], -1.0)
        self.assertLess(abs(flash[0]), 0.2)
        for clip in ('Idle', 'Charge', 'Charged', 'Fire', 'Shield'):
            x, y, z = self.pose(self.m1, clip)[2][1]
            self.assertTrue(x > 0.3 and y < 0.2 and z < -1.5, '%s: muzzle at %s' % (clip, (x, y, z)))
        sel = self.pose(self.m1, 'Select', 0.0)[2][1]
        up = self.pose(self.m1, 'Select', 0.45)[2][1]
        self.assertLess(sel[1], up[1] - 0.5, 'Select raises the gun (it starts low)')
        down = self.pose(self.m1, 'PutDown', 0.45)[2][1]
        self.assertLess(down[1], self.pose(self.m1, 'PutDown', 0.0)[2][1][1] - 0.5, 'PutDown lowers it')

    def test_charge_winds_up_and_ends_where_charged_starts(self):
        a = self.pose(self.m1, 'Charge', 0.0)[1][1]       # the antenna
        b = self.pose(self.m1, 'Charge', 59 / 60)[1][1]
        c = self.pose(self.m1, 'Charged', 0.0)[1][1]
        self.assertGreater(math.dist(a, b), 0.03, 'the gun moves while it charges')
        self.assertTrue(close(b, c, 0.01), 'Charge ends in the pose Charged holds: %s %s' % (b, c))

    def test_the_held_gun_in_the_gorges_hand_points_forward(self):
        """The third person glb is in its own actor frame; the Gorge's 'righthand' attach coordinates (X (0,0,1), Y (-1,0,0), Z (0,-1,0) in the
        bone's frame) turn it into the Bone_weapon bone's: the rotation in render/shieldgun.js (ATTACH). With it the barrel points along the
        figure's forward axis (-z), level, in the Idle_Rifle pose - and the wrong turns (none, the other direction) do not."""
        src = (REPO / 'pajzsugras' / 'render' / 'shieldgun.js').read_text(encoding='utf-8')
        nums = re.search(r'ATTACH = new THREE\.Matrix4\(\)\.set\(([^)]*)\)', src)
        self.assertTrue(nums, 'ATTACH not found in render/shieldgun.js')
        v = [int(x) for x in nums.group(1).split(',')]
        self.assertEqual(len(v), 16)
        S = [v[0:3], v[4:7], v[8:11]]                              # three.js Matrix4.set takes rows
        gorge = X.build_model(UT_DIR, 512, clip_names=['Idle_Rifle'])
        names = [b['name'] for b in gorge['bones']]
        iw = names.index('Bone_weapon')
        q, pos = self.pose(gorge, 'Idle_Rifle', 0.0)[iw]
        gun = self.world(self.m3)
        tip = tuple(sum(S[i][j] * gun[2][1][j] for j in range(3)) for i in range(3))   # the muzzle in the bone's frame
        d = X.qrot(q, tip)
        self.assertLess(d[2], -0.4 * 3, 'the muzzle is well ahead of the hand: %s' % (d,))
        self.assertLess(abs(d[1]), 0.5, 'level, not pointing up or down: %s' % (d,))
        self.assertLess(abs(d[0]), 0.5)
        for wrong in ([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[0, 0, 1], [-1, 0, 0], [0, -1, 0]]):
            t2 = tuple(sum(wrong[i][j] * gun[2][1][j] for j in range(3)) for i in range(3))
            d2 = X.qrot(q, t2)
            self.assertFalse(d2[2] < -1.2 and abs(d2[1]) < 0.5 and abs(d2[0]) < 0.5, 'the check cannot tell the right turn from %s: %s' % (wrong, d2))

    def test_the_glbs_validate_and_are_independently_readable(self):
        i1, i3 = X.validate_glb(self.g1), X.validate_glb(self.g3)
        self.assertEqual((i1['joints'], i1['vertices'], i1['animations']), (11, 1413, 7))
        self.assertEqual((i3['joints'], i3['vertices'], i3['animations']), (11, 994, 1))
        for data, nanim in ((self.g1, 7), (self.g3, 1)):
            self.assertEqual(struct.unpack_from('<III', data, 0), (0x46546C67, 2, len(data)))
            jl, _ = struct.unpack_from('<II', data, 12)
            js = json.loads(data[20:20 + jl].decode('utf-8'))
            binary = data[28 + jl:]
            self.assertEqual(js['nodes'][0]['name'], 'ShieldGun')
            self.assertEqual(js['nodes'][-1]['name'], 'ShieldGunMesh')
            self.assertEqual(len(js['animations']), nanim)
            self.assertEqual([m['name'] for m in js['materials']], ['ShieldTex0'])
            self.assertEqual(len(js['meshes'][0]['primitives']), 1)
            names = [re.sub(r'[\[\]\.:/]', '', re.sub(r'\s', '_', n['name'])) for n in js['nodes']]
            self.assertEqual(len(set(names)), len(names), 'bone names collide after three.js sanitises them (Bone_probe 01 ...)')
            self.assertIn('Bone_Flash', names)
            self.assertIn('Bone_weapon', names)
            v = js['bufferViews'][js['images'][0]['bufferView']]
            png = binary[v['byteOffset']:v['byteOffset'] + v['byteLength']]
            self.assertEqual(png[:8], X.PNG_MAGIC)
            self.assertEqual(png[25], 6, 'colour type 6: RGBA')
        self.assertLess(len(self.g1), 3_000_000)
        self.assertLess(len(self.g3), 3_000_000)

    def test_extract_weapon_writes_two_glbs_and_the_editable_png_and_keeps_the_players_png(self):
        with tempfile.TemporaryDirectory() as d:
            models = X.extract_weapon(UT_DIR, d, 512, log=lambda *a: None)
            self.assertEqual(sorted(os.listdir(d)), ['shieldgun-1st.glb', 'shieldgun-3rd.glb', 'shieldgun.png'])
            g1 = (Path(d) / 'shieldgun-1st.glb').read_bytes()
            self.assertEqual(g1, X.write_glb(models['1st']))
            self.assertEqual(X.validate_glb((Path(d) / 'shieldgun-3rd.glb').read_bytes())['animations'], 1)
            png = (Path(d) / 'shieldgun.png').read_bytes()
            self.assertEqual(png, models['1st']['images'][0])
            self.assertEqual(png_decode(png)[:3], (512, 512, 4))
            (Path(d) / 'shieldgun.png').write_bytes(b'repainted')
            X.extract_weapon(UT_DIR, d, 512, log=lambda *a: None)
            self.assertEqual((Path(d) / 'shieldgun.png').read_bytes(), b'repainted', 'a second run leaves the gun skin alone')
            self.assertEqual((Path(d) / 'shieldgun-1st.glb').read_bytes(), g1, 'the glb is rewritten with the same bytes')
            X.extract_weapon(UT_DIR, d, 512, log=lambda *a: None, force=True)
            self.assertEqual((Path(d) / 'shieldgun.png').read_bytes(), png)

    def test_a_weapon_extract_never_writes_the_gorge_files(self):
        with tempfile.TemporaryDirectory() as d:
            for f in ('gorge.glb', 'gorge-body.png', 'gorge-head.png'):
                (Path(d) / f).write_bytes(b'mine ' + f.encode())
            X.extract_weapon(UT_DIR, d, 512, log=lambda *a: None, force=True)
            for f in ('gorge.glb', 'gorge-body.png', 'gorge-head.png'):
                self.assertEqual((Path(d) / f).read_bytes(), b'mine ' + f.encode(), f + ' was touched, even with force')


@unittest.skipUnless(UT_DIR, 'no UT2004 install (set UT2004_DIR)')
class TestRealInstall(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model = X.build_model(UT_DIR)
        cls.glb = X.write_glb(cls.model)
        cls.stats = cls.model['stats']
        ukx = X.Package(X.find_file(UT_DIR, 'Animations', 'Jugg.ukx'))
        cls.raw = X.read_skeletal_mesh(ukx, ukx.find('JuggMaleA', 'SkeletalMesh'))

    # ---- counts ----
    def test_exact_counts(self):
        s = self.stats
        self.assertEqual((s['bones'], s['points'], s['wedges'], s['tris']), (28, 1271, 1943, 2059))
        self.assertEqual(s['tris_per_material'], {0: 1801, 1: 258})
        self.assertEqual((s['sequences'], s['influences']), (87, 1367))
        self.assertAlmostEqual(s['scale'], 0.36, places=6)
        self.assertEqual(tuple(s['origin']), (0.0, 0.0, 126.0))
        self.assertEqual(self.raw['rot'], (0, -16384, 0))
        self.assertEqual([m['name'] for m in self.model['materials']], ['JuggMaleABodyA', 'JuggMaleAHeadA'])
        self.assertEqual([(t['width'], t['height'], t['format']) for t in s['textures']], [(1024, 1024, 'dxt1')] * 2)

    def test_skin_weights(self):
        v = self.model['verts']
        for ws, js in zip(v['weights'], v['joints']):
            self.assertEqual(len(ws), 4)
            self.assertAlmostEqual(sum(ws), 1.0, places=5)
            self.assertTrue(all(w >= 0 for w in ws))
            self.assertLessEqual(sum(1 for w in ws if w > 0), 3)    # the file never has more than 3 influences per point
            self.assertTrue(all(0 <= j < 28 for j in js))
        for n in v['normals']:
            self.assertAlmostEqual(math.sqrt(sum(c * c for c in n)), 1.0, places=5)

    # ---- the conversion, against the geometry ----
    def bind_world(self, rule=None):
        bones = self.model['bones']
        if rule is None:
            return X.world_transforms([b['parent'] for b in bones], [b['t'] for b in bones], [b['q'] for b in bones])
        qs = [rule(b['q'], i) for i, b in enumerate(self.raw['bones'])]
        k, o = self.raw['scale'] / 50.0, self.raw['origin']
        ts = [X.convert_point(b['pos'], o, k) if i == 0 else X.convert_dir(b['pos'], k) for i, b in enumerate(self.raw['bones'])]
        return X.world_transforms([b['parent'] for b in self.raw['bones']], ts, qs)

    def centroid_error(self, world):
        """Mean distance (raw units) from the centroid of each bone's rigidly skinned vertices to that bone's segment."""
        v = self.model['verts']
        seen, groups = set(), {}
        for p, j, w in zip(v['positions'], v['joints'], v['weights']):
            if p in seen:
                continue
            seen.add(p)
            if w[0] > 0.99:
                groups.setdefault(j[0], []).append(p)
        bones = self.model['bones']
        kids = {i: [j for j in range(1, len(bones)) if bones[j]['parent'] == i] for i in range(len(bones))}
        errs = []
        for bi, pts in groups.items():
            c = [sum(p[d] for p in pts) / len(pts) for d in range(3)]
            bp = world[bi][1]
            best = math.dist(bp, c)
            for kk in kids[bi]:
                cp = world[kk][1]
                for s in range(21):
                    f = s / 20
                    best = min(best, math.dist([bp[d] + (cp[d] - bp[d]) * f for d in range(3)], c))
            errs.append(best)
        return sum(errs) / len(errs) / (self.raw['scale'] / 50.0)

    def test_skinning_centroids_sit_on_their_bones(self):
        err = self.centroid_error(self.bind_world())
        self.assertLess(err, 10.0, 'mean vertex-cluster-to-bone distance %.1f raw units' % err)

    def test_the_wrong_rotation_rules_fail_that_check(self):
        root_rule_for_all = lambda s, i: X.convert_rotation(s, True)
        other_rule_for_all = lambda s, i: X.convert_rotation(s, False)
        self.assertGreater(self.centroid_error(self.bind_world(root_rule_for_all)), 50.0)
        self.assertGreater(self.centroid_error(self.bind_world(other_rule_for_all)), 50.0)

    def test_faces_point_away_from_the_skeleton(self):
        """Stored triangle order is counter-clockwise-front in the converted space: most face normals point away from the bones."""
        v = self.model['verts']
        world = self.bind_world()
        segs = []
        bones = self.model['bones']
        for i in range(1, len(bones)):
            segs.append((world[bones[i]['parent']][1], world[i][1]))
        pos = v['positions']
        out = total = 0
        for prim in self.model['prims']:
            ix = prim['indices']
            for a, b, c in zip(ix[0::3], ix[1::3], ix[2::3]):
                pa, pb, pc = pos[a], pos[b], pos[c]
                e1 = [pb[d] - pa[d] for d in range(3)]
                e2 = [pc[d] - pa[d] for d in range(3)]
                n = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0])
                cen = [(pa[d] + pb[d] + pc[d]) / 3 for d in range(3)]
                best, bestp = 1e9, None
                for s0, s1 in segs:
                    dv = [s1[d] - s0[d] for d in range(3)]
                    ll = sum(x * x for x in dv) or 1e-12
                    t = max(0.0, min(1.0, sum((cen[d] - s0[d]) * dv[d] for d in range(3)) / ll))
                    q = [s0[d] + dv[d] * t for d in range(3)]
                    dist = math.dist(q, cen)
                    if dist < best:
                        best, bestp = dist, q
                total += 1
                out += sum(n[d] * (cen[d] - bestp[d]) for d in range(3)) > 0
        self.assertGreater(out / total, 0.78, '%d of %d faces face away from the bones' % (out, total))   # the spec measured 1725 / 2059 = 0.84

    def pose(self, clip_name, key=0):
        clip = next(c for c in self.model['clips'] if c['name'] == clip_name)
        ts, qs = [None] * 28, [None] * 28
        for ch in clip['channels']:
            val = ch['values'][min(key, len(ch['values']) - 1)]
            (ts if ch['path'] == 'translation' else qs)[ch['node']] = val
        bones = self.model['bones']
        w = X.world_transforms([b['parent'] for b in bones], ts, qs)
        return {b['name'].lower(): w[i][1] for i, b in enumerate(bones)}

    def test_facing_and_left_right(self):
        p = self.pose('Idle_Rifle')
        # left limbs at -X, right at +X; the toes point to -Z (our forward) and the hand holding the rifle is in front
        self.assertLess(p['bip01 l foot'][0], 0)
        self.assertGreater(p['bip01 r foot'][0], 0)
        self.assertLess(p['bip01 l toe0'][2], p['bip01 l foot'][2] - 0.1)
        self.assertLess(p['bip01 l hand'][2], p['bip01 pelvis'][2] - 0.2)
        self.assertAlmostEqual(p['bip01 head'][0], 0.0, delta=0.1)
        self.assertGreater(p['bip01 head'][1], 1.3)
        self.assertLess(p['bip01 head'][1], 1.6)
        self.assertGreater(p['bip01 pelvis'][1], 0.8)
        run = self.pose('RunF')
        self.assertLess(run['bip01 l toe0'][2], run['bip01 l foot'][2])   # the toes lead
        # bind pose, arms out: the left hand is at -X, the right one at +X
        bones = self.model['bones']
        bind = {b['name'].lower(): w[1] for b, w in zip(bones, self.bind_world())}
        self.assertLess(bind['bip01 l hand'][0], -0.5)
        self.assertGreater(bind['bip01 r hand'][0], 0.5)

    def test_bind_pose_height_and_feet(self):
        v = self.model['verts']['positions']
        ys = [p[1] for p in v]
        self.assertGreater(min(ys), -0.06)
        self.assertLess(min(ys), 0.0)                                   # the same 2.7 cm sink UT2004 draws
        self.assertAlmostEqual(max(ys) - min(ys), 1.717, delta=0.03)
        xs = [p[0] for p in v]
        self.assertAlmostEqual(max(xs), 0.80, delta=0.1)
        self.assertAlmostEqual(min(xs), -0.80, delta=0.1)

    # ---- clips ----
    def test_clip_set(self):
        clips = {c['name']: c for c in self.model['clips']}
        self.assertEqual(list(clips), X.CLIPS)
        for c in clips.values():
            self.assertEqual(len(c['channels']), 56)                    # translation + rotation for each of the 28 bones
        dur = lambda n: max(ch['times'][-1] for ch in clips[n]['channels'])
        for n in ('RunF', 'RunB', 'RunL', 'RunR'):
            self.assertAlmostEqual(dur(n), 20 / 30, places=5)
            self.assertTrue(clips[n]['loop'])
        self.assertAlmostEqual(dur('Idle_Rifle'), 4.0, places=5)
        self.assertAlmostEqual(dur('Idle_Rest'), 8.0, places=5)
        self.assertAlmostEqual(dur('JumpF_Mid'), 0.3, places=5)
        self.assertAlmostEqual(dur('DodgeF'), 12 / 30, places=5)         # one-shots end at their last key
        self.assertAlmostEqual(dur('DoubleJumpL'), 9 / 20, places=5)
        self.assertAlmostEqual(dur('gesture_cheer'), 36 / 15, places=5)
        self.assertGreater(dur('JumpF_Land'), 0)                         # a single pose still has a duration
        self.assertFalse(clips['DodgeF']['loop'])

    def test_run_loop_has_the_wrap_key(self):
        clip = next(c for c in self.model['clips'] if c['name'] == 'RunF')
        wrapped = 0
        for ch in clip['channels']:
            self.assertTrue(all(b > a for a, b in zip(ch['times'], ch['times'][1:])))
            if len(ch['times']) > 1:
                wrapped += 1
                self.assertAlmostEqual(ch['times'][-1], 20 / 30, places=6)
                self.assertEqual(ch['values'][-1], ch['values'][0])
        self.assertGreater(wrapped, 20)

    # ---- the glb ----
    def test_glb_validates(self):
        info = X.validate_glb(self.glb)
        self.assertEqual((info['joints'], info['vertices'], info['animations'], info['nodes']), (28, 1943, 36, 30))
        js, binary = X.read_glb(self.glb)
        self.assertEqual(len(js['skins'][0]['joints']), 28)
        self.assertEqual(len(X.accessor_values(js, binary, js['skins'][0]['inverseBindMatrices'])), 28)
        prims = js['meshes'][0]['primitives']
        self.assertEqual([js['accessors'][p['indices']]['count'] for p in prims], [1801 * 3, 258 * 3])
        self.assertEqual([m['name'] for m in js['materials']], ['JuggMaleABodyA', 'JuggMaleAHeadA'])
        self.assertEqual(js['asset']['generator'], X.GLB_GENERATOR)
        for img in js['images']:
            v = js['bufferViews'][img['bufferView']]
            w, h, ch, _rows = png_decode(binary[v['byteOffset']:v['byteOffset'] + v['byteLength']])
            self.assertEqual((w, h, ch), (1024, 1024, 3))
        # inverse bind x bind world = identity for the real skeleton
        ibm = X.accessor_values(js, binary, js['skins'][0]['inverseBindMatrices'])
        for (q, t), m in zip(self.bind_world(), ibm):
            for v in ((0, 0, 0), (0.3, 0.2, -0.1)):
                w = X.qrot(q, v)
                w = (w[0] + t[0], w[1] + t[1], w[2] + t[2])
                back = tuple(m[r] * w[0] + m[4 + r] * w[1] + m[8 + r] * w[2] + m[12 + r] for r in range(3))
                self.assertTrue(close(back, v, 1e-4))

    def test_glb_structure_read_without_the_tools_own_validator(self):
        """A second, independent reader (no X.read_glb / X.validate_glb): the node graph is a forest rooted in the scene with the mesh outside
        the skeleton, bone names stay unique after three.js sanitises them, every clip targets each joint's translation and rotation exactly
        once, loop clips wrap and every clip lasts what NumFrames / Rate says, joints / weights / indices agree, UVs past 0..1 have a repeating sampler."""
        d = self.glb
        self.assertEqual(struct.unpack_from('<III', d, 0), (0x46546C67, 2, len(d)))
        jl, jt = struct.unpack_from('<II', d, 12)
        js = json.loads(d[20:20 + jl].decode('utf-8'))
        bl, bt = struct.unpack_from('<II', d, 20 + jl)
        self.assertEqual((jt, bt, 28 + jl + bl), (0x4E4F534A, 0x004E4942, len(d)))
        binary = d[28 + jl:28 + jl + bl]
        acc, views = js['accessors'], js['bufferViews']

        def vals(i):
            a, v = acc[i], views[acc[i]['bufferView']]
            n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
            f = {5126: 'f', 5121: 'B', 5123: 'H'}[a['componentType']]
            self.assertLessEqual(a.get('byteOffset', 0) + struct.calcsize('<' + f) * n * a['count'], v['byteLength'], 'accessor %d overruns its view' % i)
            flat = struct.unpack_from('<%d%s' % (n * a['count'], f), binary, v['byteOffset'] + a.get('byteOffset', 0))
            return [flat[k * n:(k + 1) * n] for k in range(a['count'])]
        # node graph
        nodes = js['nodes']
        parent = {}
        for i, n in enumerate(nodes):
            for c in n.get('children', []):
                self.assertNotIn(c, parent, 'node %d has two parents' % c)
                parent[c] = i
        self.assertEqual([i for i in range(len(nodes)) if i not in parent], js['scenes'][0]['nodes'], 'one root, and it is the scene')
        skin = js['skins'][0]
        joints = skin['joints']
        for j in joints:
            k = j
            while k != skin['skeleton']:
                self.assertIn(k, parent, 'joint %d is not below the skeleton root' % j)
                k = parent[k]
        mesh_nodes = [i for i, n in enumerate(nodes) if 'mesh' in n]
        self.assertEqual([parent[i] for i in mesh_nodes], [0], 'the skinned mesh hangs on the scene root, never on a bone')
        names = [re.sub(r'[\[\]\.:/]', '', re.sub(r'\s', '_', n['name'])) for n in nodes]   # (what three's PropertyBinding makes of them)
        self.assertEqual(len(set(names)), len(names), 'node names collide: animation tracks would bind to the wrong node')
        # animations
        want = {(j, p) for j in joints for p in ('translation', 'rotation')}
        for anim in js['animations']:
            name = anim['name']
            self.assertEqual({(c['target']['node'], c['target']['path']) for c in anim['channels']}, want, name)
            self.assertEqual(len(anim['channels']), len(want), name + ': a target is animated twice')
            end = 0.0
            for c in anim['channels']:
                s = anim['samplers'][c['sampler']]
                t, o = [x[0] for x in vals(s['input'])], vals(s['output'])
                self.assertEqual(len(t), len(o), name)
                self.assertTrue(all(b > a for a, b in zip(t, t[1:])) and t[0] == 0.0 or len(t) == 1, name + ': times')
                self.assertTrue(all(math.isfinite(x) for v in o for x in v), name)
                self.assertEqual(acc[s['input']]['max'], [t[-1]], name + ': input max')
                end = max(end, t[-1])
                if len(t) > 1 and X.is_loop(name):
                    self.assertEqual(o[0], o[-1], name + ': a loop clip must end on its first pose')
            frames, rate = self.stats['frames'][name], self.stats['rate'][name]
            if X.is_loop(name):
                self.assertAlmostEqual(end, frames / rate, places=5, msg=name)
            else:
                self.assertTrue(0 < end <= frames / rate + 1e-5, '%s lasts %.4f s, NumFrames / Rate = %.4f' % (name, end, frames / rate))
        # vertices / triangles
        nj = len(joints)
        for prim in js['meshes'][0]['primitives']:
            at = prim['attributes']
            nv = acc[at['POSITION']]['count']
            for jn, wt in zip(vals(at['JOINTS_0']), vals(at['WEIGHTS_0'])):
                self.assertTrue(all(w >= 0 for w in wt) and abs(sum(wt) - 1) < 1e-4)
                self.assertTrue(all(j < nj for j in jn))
                live = [j for j, w in zip(jn, wt) if w > 0]
                self.assertEqual(len(live), len(set(live)), 'a joint listed twice with weight')
            idx = [i[0] for i in vals(prim['indices'])]
            self.assertTrue(len(idx) % 3 == 0 and max(idx) < nv)
        uv = [c for p in vals(js['meshes'][0]['primitives'][0]['attributes']['TEXCOORD_0']) for c in p]
        self.assertTrue(all(math.isfinite(c) for c in uv))
        if min(uv) < 0 or max(uv) > 1:
            self.assertIn(js['samplers'][0]['wrapS'], (10497, 33648))
            self.assertIn(js['samplers'][0]['wrapT'], (10497, 33648))

    def test_glb_size_is_reasonable(self):
        self.assertLess(len(self.glb), 6_000_000)
        small = X.write_glb(X.build_model(UT_DIR, 512, clip_names=['Idle_Rifle', 'RunF']))
        self.assertLess(len(small), len(self.glb))
        info = X.validate_glb(small)
        self.assertEqual(info['animations'], 2)

    # ---- sounds + output folders ----
    def test_sounds(self):
        with tempfile.TemporaryDirectory() as d:
            lists = X.extract_sounds(UT_DIR, d, log=lambda *a: None)
            expected = {'charge': ['shield-charge.wav'], 'fire': ['shield-fire.wav'], 'jump': ['jump1.wav', 'jump2.wav', 'jump3.wav'],
                        'dodge': ['dodge.wav'], 'step': ['step%d.wav' % i for i in range(1, 7)]}
            self.assertEqual(lists, expected)
            self.assertEqual(json.loads((Path(d) / 'sounds.json').read_text(encoding='utf-8')), expected)
            for files in expected.values():
                self.assertLessEqual(len(files), 12)                      # audio.js reads at most 12 per kind
                for f in files:
                    self.assertRegex(f, r'^[\w.-]+\.wav$')                # ... and only plain wav names
                    b = (Path(d) / f).read_bytes()
                    self.assertEqual((b[:4], b[8:12]), (b'RIFF', b'WAVE'))
                    self.assertGreater(len(b), 1000)

    def test_extract_model_writes_the_glb(self):
        with tempfile.TemporaryDirectory() as d:
            model, data = X.extract_model(UT_DIR, d, 512, log=lambda *a: None)
            self.assertEqual((Path(d) / 'gorge.glb').read_bytes(), data)
            self.assertEqual(sorted(os.listdir(d)), ['gorge-body.png', 'gorge-head.png', 'gorge.glb'])
            # the editable skins are the images embedded in the glb: same bytes, so the same size and UV layout
            names = {m['name']: m['image'] for m in model['materials']}
            self.assertEqual((Path(d) / 'gorge-body.png').read_bytes(), model['images'][names['JuggMaleABodyA']])
            self.assertEqual((Path(d) / 'gorge-head.png').read_bytes(), model['images'][names['JuggMaleAHeadA']])
            for f in ('gorge-body.png', 'gorge-head.png'):
                w, h, ch, rows = png_decode((Path(d) / f).read_bytes())
                self.assertEqual((w, h, ch), (512, 512, 3), f)
            # a second run leaves a repainted skin alone (and rewrites the glb with the same bytes); --force puts the original back
            (Path(d) / 'gorge-body.png').write_bytes(b'repainted')
            X.extract_model(UT_DIR, d, 512, log=lambda *a: None)
            self.assertEqual((Path(d) / 'gorge-body.png').read_bytes(), b'repainted')
            self.assertEqual((Path(d) / 'gorge.glb').read_bytes(), data)
            X.extract_model(UT_DIR, d, 512, log=lambda *a: None, force=True)
            self.assertEqual((Path(d) / 'gorge-body.png').read_bytes(), model['images'][names['JuggMaleABodyA']])

    def test_private_extracts_are_ignored_but_deployed_models_are_trackable(self):
        for sub in ('local-models/_backup/gorge.glb', 'local-models/other.glb', 'local-sounds/jump1.wav'):
            try:
                res = subprocess.run(['git', 'check-ignore', '-q', 'pajzsugras/' + sub], cwd=str(REPO), capture_output=True, timeout=30)
            except (OSError, subprocess.SubprocessError):
                self.skipTest('git is not available')
            self.assertEqual(res.returncode, 0, 'pajzsugras/%s is not git-ignored' % sub)
        for name in ('gorge.glb', 'gorge-body.png', 'gorge-head.png', 'shieldgun-1st.glb', 'shieldgun-3rd.glb', 'shieldgun.png'):
            res = subprocess.run(['git', 'check-ignore', '-q', '--no-index', 'pajzsugras/local-models/' + name], cwd=str(REPO), capture_output=True, timeout=30)
            self.assertEqual(res.returncode, 1, name + ' must be available to the deploy checkout')
        res = subprocess.run(['git', 'ls-files', 'pajzsugras/local-sounds'], cwd=str(REPO), capture_output=True, timeout=30)
        self.assertEqual(res.stdout.strip(), b'', 'Local sounds are tracked by git')


# ---------------------------------------------------------------------------------------------------------------------
# the command line end to end (a subprocess, in a throw-away copy of the repository layout, against a throw-away copy of the install),
# damaged inputs, interrupted writes
# ---------------------------------------------------------------------------------------------------------------------
class TestWriteSafety(unittest.TestCase):
    def test_a_failed_write_leaves_the_old_glb_or_the_whole_new_one_never_half_of_it(self):
        """BUG: extract_model() writes gorge.glb with write_bytes(): a write that dies halfway (disk full) destroys the previous good file and
        leaves a truncated one that still starts with 'glTF', so the game's loader accepts it and fails later. Write to a temp file + os.replace."""
        with tempfile.TemporaryDirectory(prefix='ut extract ') as d:
            out = Path(d) / 'local-models'
            out.mkdir()
            old = b'glTF' + bytes(5000)
            new = b'glTF' + b'\x01' * 20000
            (out / 'gorge.glb').write_bytes(old)
            real_open = io.open

            class Dying:
                def __init__(self, f):
                    self.f = f

                def write(self, data):
                    self.f.write(data[:len(data) // 2])
                    self.f.flush()
                    raise OSError(28, 'No space left on device')

                def __getattr__(self, k):
                    return getattr(self.f, k)

                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    self.f.close()
                    return False

            def dying_open(file, mode='r', *a, **k):
                f = real_open(file, mode, *a, **k)
                return Dying(f) if any(c in mode for c in 'wxa') else f
            fake_model = {'clips': [], 'materials': [], 'images': [], 'stats': {'bones': 0, 'points': 0, 'wedges': 0, 'tris': 0, 'influences': 0}}
            with mock.patch.object(X, 'build_model', return_value=fake_model), mock.patch.object(X, 'write_glb', return_value=new), \
                    mock.patch.object(X, 'validate_glb', return_value={'animations': 0, 'vertices': 0}), \
                    mock.patch.object(io, 'open', dying_open), mock.patch.object(builtins, 'open', dying_open):
                try:
                    X.extract_model('nowhere', out, 1024, log=lambda *a: None)
                except OSError:
                    pass
            now = (out / 'gorge.glb').read_bytes()
            self.assertTrue(now == old or now == new, 'gorge.glb is half written: %d bytes (the old file had %d, the new one %d)' % (len(now), len(old), len(new)))
            self.assertEqual(sorted(os.listdir(out)), ['gorge.glb'], 'a stray temp file is left in local-models')


@unittest.skipUnless(UT_DIR, 'no UT2004 install (set UT2004_DIR)')
class TestCommandLineEndToEnd(unittest.TestCase):
    PACKAGES = (('Animations', 'Jugg.ukx'), ('Textures', 'PlayerSkins.utx'), ('Sounds', 'PlayerSounds.uax'), ('Sounds', 'WeaponSounds.uax'),
                ('Animations', 'Weapons.ukx'), ('Textures', 'WeaponSkins.utx'))
    WAVS = ['shield-charge.wav', 'shield-fire.wav', 'jump1.wav', 'jump2.wav', 'jump3.wav', 'dodge.wav'] + ['step%d.wav' % i for i in range(1, 7)]

    @classmethod
    def setUpClass(cls):
        # (every path has a space in it; the install is a COPY of the six packages the tool reads: the real one is never written to)
        cls.tmp = tempfile.mkdtemp(prefix='ut extract ')
        cls.install = os.path.join(cls.tmp, 'UT 2004 copy')
        for folder, name in cls.PACKAGES:
            os.makedirs(os.path.join(cls.install, folder), exist_ok=True)
            shutil.copyfile(X.find_file(UT_DIR, folder, name), os.path.join(cls.install, folder, name))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def make_repo(self, name, ignore=True):
        repo = Path(self.tmp) / name
        tools = repo / 'pajzsugras' / 'tools'
        tools.mkdir(parents=True)
        shutil.copyfile(X.TOOLS_DIR / 'ut2004_extract.py', tools / 'ut2004_extract.py')
        try:
            subprocess.run(['git', 'init', '-q', str(repo)], check=True, capture_output=True, timeout=60)
        except (OSError, subprocess.SubprocessError):
            self.skipTest('git is not available')
        if ignore:
            (repo / '.gitignore').write_text('pajzsugras/local-sounds/\npajzsugras/local-models/\n')
        return repo

    def run_cli(self, repo, *args, install=None):
        res = subprocess.run([sys.executable, '-I', str(repo / 'pajzsugras' / 'tools' / 'ut2004_extract.py'), install or self.install, *args],
                             capture_output=True, timeout=300)
        return res.returncode, res.stdout.decode('utf-8', 'replace'), res.stderr.decode('utf-8', 'replace')

    @staticmethod
    def tree(root):
        out = {}
        for dp, dn, fn in os.walk(root):
            dn[:] = [x for x in dn if x != '.git']
            for f in fn:
                p = os.path.join(dp, f)
                st = os.stat(p)
                out[Path(os.path.relpath(p, root)).as_posix()] = (st.st_size, st.st_mtime_ns)
        return out

    def test_full_run_then_again_stays_in_its_two_folders_and_is_idempotent(self):
        repo = self.make_repo('repo ignored')
        pk_before = self.tree(self.install)
        before = self.tree(repo)
        rc, out, err = self.run_cli(repo)
        self.assertEqual((rc, err), (0, ''), out)
        self.assertNotIn('WARNING', out, 'the folders are git-ignored in this repo')
        after = self.tree(repo)
        self.assertEqual({k: v for k, v in before.items() if after.get(k) != v}, {}, 'an existing file changed')
        want = sorted(['pajzsugras/local-models/gorge.glb', 'pajzsugras/local-models/gorge-body.png', 'pajzsugras/local-models/gorge-head.png',
                       'pajzsugras/local-models/shieldgun-1st.glb', 'pajzsugras/local-models/shieldgun-3rd.glb', 'pajzsugras/local-models/shieldgun.png',
                       'pajzsugras/local-sounds/sounds.json'] + ['pajzsugras/local-sounds/' + w for w in self.WAVS])
        self.assertEqual(sorted(set(after) - set(before)), want, 'only the two output folders get files')
        self.assertEqual(self.tree(self.install), pk_before, 'the install was touched')
        glb = (repo / 'pajzsugras' / 'local-models' / 'gorge.glb').read_bytes()
        self.assertEqual(X.validate_glb(glb)['animations'], 36)
        gun_glbs = {f: (repo / 'pajzsugras' / 'local-models' / f).read_bytes() for f in ('shieldgun-1st.glb', 'shieldgun-3rd.glb')}
        self.assertEqual([X.validate_glb(gun_glbs[f])['animations'] for f in ('shieldgun-1st.glb', 'shieldgun-3rd.glb')], [7, 1])
        self.assertEqual(png_decode((repo / 'pajzsugras' / 'local-models' / 'shieldgun.png').read_bytes())[:3], (1024, 1024, 4))
        lists = json.loads((repo / 'pajzsugras' / 'local-sounds' / 'sounds.json').read_text(encoding='utf-8'))
        self.assertEqual(sorted(f for v in lists.values() for f in v), sorted(self.WAVS))
        # again: the glb is byte-identical, every sound is kept, sounds.json still lists all twelve
        rc, out2, err = self.run_cli(repo)
        self.assertEqual((rc, err), (0, ''), out2)
        self.assertEqual(out2.count('kept'), 15, 'twelve sounds and the three skin PNGs (two Gorge, one gun) are kept')
        self.assertEqual((repo / 'pajzsugras' / 'local-models' / 'gorge.glb').read_bytes(), glb)
        for f in ('shieldgun-1st.glb', 'shieldgun-3rd.glb'):
            self.assertEqual((repo / 'pajzsugras' / 'local-models' / f).read_bytes(), gun_glbs[f], f + ': rewritten with the same bytes')
        self.assertEqual(json.loads((repo / 'pajzsugras' / 'local-sounds' / 'sounds.json').read_text(encoding='utf-8')), lists)
        self.assertEqual({k: v for k, v in self.tree(repo).items() if k.endswith('.wav')}, {k: v for k, v in after.items() if k.endswith('.wav')}, 'a kept sound was rewritten')
        # a skin the player repainted stays until --force (the glb is rewritten with the same bytes either way), and so does a sound
        body = repo / 'pajzsugras' / 'local-models' / 'gorge-body.png'
        original = body.read_bytes()
        self.assertEqual(png_decode(original)[:3], (1024, 1024, 3))
        body.write_bytes(b'my own skin')
        rc, out_s, err = self.run_cli(repo, '--only', 'model')
        self.assertEqual((rc, err), (0, ''), out_s)
        self.assertEqual(body.read_bytes(), b'my own skin')
        self.assertIn('gorge-body.png', out_s)
        self.assertEqual((repo / 'pajzsugras' / 'local-models' / 'gorge.glb').read_bytes(), glb)
        rc, out_s, err = self.run_cli(repo, '--only', 'model', '--force')
        self.assertEqual((rc, err), (0, ''), out_s)
        self.assertEqual(body.read_bytes(), original)
        # a sound the player replaced stays until --force, which puts the original back
        jump2 = repo / 'pajzsugras' / 'local-sounds' / 'jump2.wav'
        mine = tiny_wav(300)
        jump2.write_bytes(mine)
        self.run_cli(repo, '--only', 'sounds')
        self.assertEqual(jump2.read_bytes(), mine)
        rc, out3, err = self.run_cli(repo, '--only', 'sounds', '--force')
        self.assertEqual((rc, err), (0, ''), out3)
        self.assertEqual(jump2.read_bytes()[8:12], b'WAVE')
        self.assertGreater(jump2.stat().st_size, 1000)
        # --only weapon: the gun only; a repainted gun skin stays until --force, and nothing of the Gorge or the sounds is touched
        gun = repo / 'pajzsugras' / 'local-models' / 'shieldgun.png'
        original_gun = gun.read_bytes()
        before = {k: v for k, v in self.tree(repo).items() if not k.startswith('pajzsugras/local-models/shieldgun')}
        gun.write_bytes(b'my own gun')
        rc, out_w, err = self.run_cli(repo, '--only', 'weapon')
        self.assertEqual((rc, err), (0, ''), out_w)
        self.assertIn('shieldgun.png', out_w)
        self.assertEqual(gun.read_bytes(), b'my own gun')
        self.assertEqual({k: v for k, v in self.tree(repo).items() if not k.startswith('pajzsugras/local-models/shieldgun')}, before, 'only the gun files may change')
        rc, out_w, err = self.run_cli(repo, '--only', 'weapon', '--force')
        self.assertEqual((rc, err), (0, ''), out_w)
        self.assertEqual(gun.read_bytes(), original_gun)

    def test_a_repo_that_does_not_ignore_the_folders_is_refused_unless_no_git_check(self):
        repo = self.make_repo('repo open', ignore=False)
        for only, folder, other in (('sounds', 'local-sounds', 'local-models'), ('model', 'local-models', 'local-sounds')):
            rc, out, err = self.run_cli(repo, '--only', only)
            self.assertEqual(rc, 1, out + err)
            self.assertIn('NOT git-ignored', err)
            self.assertIn(folder, err)
            self.assertNotIn('Traceback', err)
            self.assertFalse((repo / 'pajzsugras' / folder).exists(), 'something was written although git would not ignore it')
        # (only the folders the run would write to are checked: .gitignore covering one of them is enough for --only on that one)
        (repo / '.gitignore').write_text('pajzsugras/local-sounds/\n')
        self.assertEqual(self.run_cli(repo, '--only', 'sounds')[0], 0)
        rc, out, err = self.run_cli(repo, '--only', 'model')
        self.assertEqual(rc, 1, out + err)
        self.assertFalse((repo / 'pajzsugras' / 'local-models').exists())
        # the explicit override for a copy outside git
        rc, out, err = self.run_cli(repo, '--only', 'model', '--tex', '512', '--no-git-check')
        self.assertEqual(rc, 0, err)
        self.assertTrue((repo / 'pajzsugras' / 'local-models' / 'gorge.glb').is_file())

    def test_a_folder_that_is_not_a_git_checkout_at_all_is_fine(self):
        repo = Path(self.tmp) / 'no git here'
        tools = repo / 'pajzsugras' / 'tools'
        tools.mkdir(parents=True)
        shutil.copyfile(X.TOOLS_DIR / 'ut2004_extract.py', tools / 'ut2004_extract.py')
        env_probe = subprocess.run(['git', '-C', str(repo), 'rev-parse', '--git-dir'], capture_output=True)
        if env_probe.returncode == 0:
            self.skipTest('the temp folder is inside a git checkout')
        rc, out, err = self.run_cli(repo, '--only', 'sounds')
        self.assertEqual(rc, 0, err)
        self.assertTrue((repo / 'pajzsugras' / 'local-sounds' / 'sounds.json').is_file())

    def test_only_sounds_and_only_model_leave_the_other_folder_alone(self):
        a = self.make_repo('repo only sounds')
        self.assertEqual(self.run_cli(a, '--only', 'sounds')[0], 0)
        self.assertTrue((a / 'pajzsugras' / 'local-sounds' / 'sounds.json').is_file())
        self.assertFalse((a / 'pajzsugras' / 'local-models').exists())
        b = self.make_repo('repo only model')
        rc, out, err = self.run_cli(b, '--only', 'model', '--tex', '512')
        self.assertEqual(rc, 0, err)
        self.assertFalse((b / 'pajzsugras' / 'local-sounds').exists())
        size = (b / 'pajzsugras' / 'local-models' / 'gorge.glb').stat().st_size
        self.assertLess(size, 1_600_000, '--tex 512 should roughly halve the 2.7 MB file')
        self.assertIn('512x512', out)
        self.assertEqual(sorted(os.listdir(b / 'pajzsugras' / 'local-models')), ['gorge-body.png', 'gorge-head.png', 'gorge.glb'], '--only model leaves the gun alone')
        c = self.make_repo('repo only weapon')
        rc, out, err = self.run_cli(c, '--only', 'weapon', '--tex', '512')
        self.assertEqual(rc, 0, err)
        self.assertFalse((c / 'pajzsugras' / 'local-sounds').exists())
        self.assertEqual(sorted(os.listdir(c / 'pajzsugras' / 'local-models')), ['shieldgun-1st.glb', 'shieldgun-3rd.glb', 'shieldgun.png'], '--only weapon writes only the gun')
        self.assertIn('512x512', out)

    def test_damaged_installs_fail_with_a_message_that_names_the_culprit_and_write_nothing(self):
        jugg = X.find_file(UT_DIR, 'Animations', 'Jugg.ukx').read_bytes()
        junk = bytes(random.Random(5).randrange(256) for _ in range(300_000))
        cases = [
            ('truncated Jugg.ukx', 'Jugg.ukx', {'Animations/Jugg.ukx': jugg[:len(jugg) // 2]}),
            ('no Textures folder at all', 'Textures', {'Animations/Jugg.ukx': jugg}),
            ('PlayerSkins.utx is junk', 'PlayerSkins.utx', {'Animations/Jugg.ukx': jugg, 'Textures/PlayerSkins.utx': junk}),
            ('JuggMaleA is not in Jugg.ukx', 'JuggMaleA', {'Animations/Jugg.ukx': jugg.replace(b'JuggMaleA\0', b'JuggMaleZ\0', 1)}),
        ]
        weapons = X.find_file(UT_DIR, 'Animations', 'Weapons.ukx').read_bytes()
        cases = [c + ('model',) for c in cases] + [
            ('truncated Weapons.ukx', 'Weapons.ukx', {'Animations/Weapons.ukx': weapons[:len(weapons) // 2]}, 'weapon'),
            ('no Textures folder for the gun', 'Textures', {'Animations/Weapons.ukx': weapons}, 'weapon'),
            ('WeaponSkins.utx is junk', 'WeaponSkins.utx', {'Animations/Weapons.ukx': weapons, 'Textures/WeaponSkins.utx': junk}, 'weapon'),
            ('ShieldGun_1st is not in Weapons.ukx', 'ShieldGun_1st', {'Animations/Weapons.ukx': weapons.replace(b'ShieldGun_1st\0', b'ShieldGun_9st\0', 1)}, 'weapon'),
        ]
        for label, culprit, files, only in cases:
            with self.subTest(label):
                install = os.path.join(self.tmp, 'broken install ' + re.sub(r'\W+', '_', label))
                for rel, data in files.items():
                    os.makedirs(os.path.dirname(os.path.join(install, rel)), exist_ok=True)
                    with open(os.path.join(install, rel), 'wb') as f:
                        f.write(data)
                repo = self.make_repo('repo ' + re.sub(r'\W+', '_', label))
                rc, out, err = self.run_cli(repo, '--only', only, install=install)
                self.assertEqual(rc, 1, out + err)
                self.assertNotIn('Traceback', err)
                self.assertIn(culprit.lower(), err.lower(), 'the message should say what is wrong: %r' % err)
                models = repo / 'pajzsugras' / 'local-models'
                self.assertEqual(os.listdir(models) if models.exists() else [], [], 'a failed run wrote something into local-models')

    def test_a_sound_file_that_is_empty_or_cut_off_is_not_kept(self):
        """BUG (low): extract_sounds() keeps ANY existing file without --force, so the half file a dead run left behind is kept forever."""
        with tempfile.TemporaryDirectory(prefix='ut extract ') as d:
            X.extract_sounds(UT_DIR, d, log=lambda *a: None)
            full = (Path(d) / 'step1.wav').read_bytes()
            (Path(d) / 'step1.wav').write_bytes(b'')
            (Path(d) / 'step2.wav').write_bytes(b'RIFF')
            (Path(d) / 'step3.wav').write_bytes(full[:len(full) // 2])
            X.extract_sounds(UT_DIR, d, log=lambda *a: None)
            for n in ('step1.wav', 'step2.wav', 'step3.wav'):
                b = (Path(d) / n).read_bytes()
                self.assertTrue(len(b) > 1000 and b[8:12] == b'WAVE' and struct.unpack_from('<I', b, 4)[0] + 8 == len(b),
                                '%s was kept although it is %d bytes and not a whole RIFF file' % (n, len(b)))


if __name__ == '__main__':
    unittest.main(verbosity=2)
