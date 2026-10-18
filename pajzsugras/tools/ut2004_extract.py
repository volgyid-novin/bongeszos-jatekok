#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PAJZSUGRAS: pull the Gorge character and a few sounds out of YOUR OWN UT2004 install, for LOCAL use only.

    python pajzsugras/tools/ut2004_extract.py <UT2004 dir> [--only sounds|model|weapon] [--tex 1024|512] [--force] [--no-git-check]

Writes (both folders are git-ignored and never deployed; without them the game keeps its synthesised sounds and the robot):
    pajzsugras/local-sounds/*.wav + sounds.json     the sounds audio.js can use instead of the synthesised ones
    pajzsugras/local-models/gorge.glb               mesh + skeleton + 36 animations + the two skins (PNG), glTF 2.0 binary
    pajzsugras/local-models/gorge-body.png, gorge-head.png   the same two skins as editable PNGs (the UV layout of the glb's textures): render/gorge.js
                                                    uses a PNG instead of the glb's own texture when it is there. They are the player's to repaint, so an
                                                    existing one is never overwritten (a sound file, too) unless --force
    pajzsugras/local-models/shieldgun-1st.glb       the shield gun's first person model + its 7 sequences (Idle, Select, PutDown, Charge, Charged, Fire, Shield)
    pajzsugras/local-models/shieldgun-3rd.glb       the third person model held by the characters (one pose), to be parented to the Gorge's Bone_weapon
    pajzsugras/local-models/shieldgun.png           its one skin (ShieldTex0, RGBA: the alpha is the specular mask) as an editable PNG, kept like the Gorge skins
The install is only read, never modified; the output is written atomically (temp file + rename), and the run refuses to write into a folder
that git would not ignore (unless --no-git-check). A damaged package gives an error that names the file. Standard library only.
Nothing of Epic's lives in this repository: the script reads the package files at run time. The byte layouts follow UE Viewer's readers (github.com/gildor2/UEViewer, Unreal/UnPackage*.cpp,
UnMesh2.cpp, UnAnim2.cpp, UnTexture2.cpp); the Unreal -> glTF conversion rules are written down at convert_* below.

Layout of this file: reader + package tables, property tags, sounds, skeletal mesh, animation, textures + PNG, conversion,
glTF writer + validator, command line.
"""
import argparse
import contextlib
import functools
import json
import math
import os
import struct
import subprocess
import sys
import zlib
from collections import namedtuple
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
ROOT = TOOLS_DIR.parent                     # pajzsugras/
OUT_SOUNDS = ROOT / 'local-sounds'
OUT_MODELS = ROOT / 'local-models'

PKG_TAG = 0x9E2A83C1
RF_HAS_STACK = 0x02000000
UU_PER_METRE = 50.0                         # UT2004: GroundSpeed 440 UU/s = our RUN 8.8 m/s
HULL_HALF_HEIGHT = 0.88                     # our hull centre above the feet (xPawn: 44 UU)
GLB_GENERATOR = 'pajzsugras/tools/ut2004_extract.py'
SKIN_PNG = (('body', 'gorge-body.png'), ('head', 'gorge-head.png'))   # a skin whose UT name contains the word -> the editable PNG (render/gorge.js reads these names)
WEAPON_PNG = (('shieldtex', 'shieldgun.png'),)                          # the same for the shield gun's one skin (render/shieldgun.js reads this name)
WEAPON_1ST, WEAPON_3RD = 'shieldgun-1st.glb', 'shieldgun-3rd.glb'
PNG_MAGIC = b'\x89PNG\r\n\x1a\n'

# the clip subset written to the glb (36 of the 87 JuggA sequences)
CLIPS = (['Idle_Rifle', 'Idle_Rest', 'RunF', 'RunB', 'RunL', 'RunR']
         + [pre + '_' + part for pre in ('Jump', 'JumpF', 'JumpB', 'JumpL', 'JumpR') for part in ('Takeoff', 'Mid', 'Land')]
         + ['DoubleJump', 'DoubleJumpF', 'DoubleJumpB', 'DoubleJumpL', 'DoubleJumpR']
         + ['DodgeF', 'DodgeB', 'DodgeL', 'DodgeR', 'WallDodgeF', 'WallDodgeB', 'WallDodgeL', 'WallDodgeR']
         + ['Rifle_Burst', 'gesture_cheer'])

# the shield gun (Weapons.ukx + WeaponSkins.utx): the first person mesh has 7 sequences, all kept; the third person one is a single pose.
# Idle and Charged are the loops (the charge wind-up, the release, the raise and the lowering are one-shots).
WEAPON_CLIPS_1ST = ['Idle', 'Select', 'PutDown', 'Charge', 'Charged', 'Fire', 'Shield']
WEAPON_CLIPS_3RD = ['Still']
WEAPON_LOOPS = ('Idle', 'Charged')

# (package file under the install, export name, file written, kind in sounds.json), in the order audio.js should list them
SOUNDS = (
    [('Sounds/WeaponSounds.uax', 'shieldgun_charge', 'shield-charge.wav', 'charge'),
     ('Sounds/WeaponSounds.uax', 'BShieldGunFire', 'shield-fire.wav', 'fire')]
    + [('Sounds/PlayerSounds.uax', 'MaleJump%d' % i, 'jump%d.wav' % i, 'jump') for i in (1, 2, 3)]
    + [('Sounds/PlayerSounds.uax', 'MaleDodge', 'dodge.wav', 'dodge')]
    + [('Sounds/PlayerSounds.uax', 'BFootstepMetal%d' % i, 'step%d.wav' % i, 'step') for i in range(1, 7)]
)


class ExtractError(Exception):
    """A file does not look like what the format notes promise: abort with a message instead of writing garbage."""


def check(cond, msg):
    if not cond:
        raise ExtractError(msg)


@contextlib.contextmanager
def damaged(path, what):
    """A reader that runs off the end of a file (IndexError / struct.error), a number that is not usable (ValueError / OverflowError / ...) or a
    failed check inside this block all mean one thing: the package is cut off or corrupt. Say which file, and what was being read."""
    base = os.path.basename(str(path))
    try:
        yield
    except ExtractError as e:
        if base in str(e):
            raise
        raise ExtractError('%s: %s' % (base, e)) from e
    except (IndexError, struct.error, ValueError, ArithmeticError, MemoryError) as e:   # (ArithmeticError: OverflowError, ZeroDivisionError)
        raise ExtractError('%s: %s is damaged or cut off (%s: %s)' % (base, what, type(e).__name__, e)) from e


def guarded(fn):
    """read_*(pkg, exp, ...) with errors that name the package file and the object."""
    @functools.wraps(fn)
    def wrapper(pkg, exp, *args, **kwargs):
        with damaged(getattr(pkg, 'path', '?'), exp.name):
            return fn(pkg, exp, *args, **kwargs)
    return wrapper


def write_atomic(path, data):
    """Write `data` to a temp file in the same folder, then os.replace it over `path`: a write that dies halfway (disk full) never leaves a
    half file behind, and never destroys the previous good one."""
    path = Path(path)
    tmp = path.with_name(path.name + '.tmp')
    try:
        with open(tmp, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def is_loop(clip):
    """Idle_*, Run* and *_Mid play in a loop (the glb gets a wrap key); everything else is one-shot."""
    return clip.startswith('Idle_') or clip.startswith('Run') or clip.endswith('_Mid')


# ====================================================================================================================
# reader + package tables (UE2: little-endian, compact indices, FName = index into the name table)
# ====================================================================================================================
class Reader:
    __slots__ = ('b', 'p', 'pkg')

    def __init__(self, data, pos=0, pkg=None):
        self.b = data
        self.p = pos
        self.pkg = pkg

    def u8(self):
        v = self.b[self.p]
        self.p += 1
        return v

    def u16(self):
        v = struct.unpack_from('<H', self.b, self.p)[0]
        self.p += 2
        return v

    def i32(self):
        v = struct.unpack_from('<i', self.b, self.p)[0]
        self.p += 4
        return v

    def u32(self):
        v = struct.unpack_from('<I', self.b, self.p)[0]
        self.p += 4
        return v

    def f32(self):
        v = struct.unpack_from('<f', self.b, self.p)[0]
        self.p += 4
        return v

    def vec(self):
        v = struct.unpack_from('<3f', self.b, self.p)
        self.p += 12
        return v

    def quat(self):
        v = struct.unpack_from('<4f', self.b, self.p)   # X, Y, Z, W
        self.p += 16
        return v

    def idx(self):
        """FCompactIndex: bit7 of the first byte = sign, bit6 = more bytes, 6 value bits; then 7 value bits per byte, bit7 = more."""
        x = self.u8()
        neg = x & 0x80
        v = x & 0x3F
        if x & 0x40:
            shift = 6
            for _ in range(4):   # (at most 5 bytes in all: a longer run is a crafted file, and the value would grow without end)
                y = self.u8()
                v |= (y & 0x7F) << shift
                shift += 7
                if not y & 0x80:
                    break
            else:
                raise ExtractError('a compact index is longer than 5 bytes')
        return -v if neg else v

    def blob(self):
        """A compact-index length + that many raw bytes (never past the end of the file; a negative length would walk the reader backwards)."""
        n = self.idx()
        check(0 <= n <= len(self.b) - self.p, 'data length %d does not fit the file (%d bytes left)' % (n, len(self.b) - self.p))
        data = bytes(self.b[self.p:self.p + n])
        self.p += n
        return data

    def name(self):
        i = self.idx()
        check(0 <= i < len(self.pkg.names), 'name index %d is out of range' % i)
        return self.pkg.names[i]

    def arr(self, fn):
        n = self.idx()
        check(0 <= n < 20_000_000 and n <= len(self.b) - self.p, 'implausible array length %d' % n)   # (every element is at least one byte)
        return [fn() for _ in range(n)]

    def lazy(self, fn):
        """TLazyArray: i32 SkipPos (the absolute offset just past the array) + the array; the skip position is verified."""
        skip = self.i32()
        out = self.arr(fn)
        check(self.p == skip, 'lazy array ends at %d, its skip position says %d' % (self.p, skip))
        return out


Export = namedtuple('Export', 'name cls flags size offset outer')
Import = namedtuple('Import', 'cls_package cls name outer')


def encode_index(v):
    """FCompactIndex writer (used by the tests to build synthetic packages)."""
    neg = v < 0
    v = abs(v)
    first = (0x80 if neg else 0) | (v & 0x3F)
    v >>= 6
    if v:
        first |= 0x40
    out = bytearray([first])
    while v:
        b = v & 0x7F
        v >>= 7
        if v:
            b |= 0x80
        out.append(b)
    return bytes(out)


class Package:
    """Header + name / import / export tables of one .ukx / .utx / .uax file (UnPackage2.cpp:6-80, 160-163, 203+)."""

    def __init__(self, path):
        self.path = str(path)
        self.data = data = Path(path).read_bytes()
        with damaged(path, 'the header and tables'):
            self._parse(data, path)

    def _parse(self, data, path):
        check(len(data) > 64, '%s: file too small' % path)
        tag, ver, lic, _flags, nc, no, ec, eo, ic, io_ = struct.unpack_from('<IHHIIIIIII', data, 0)
        check(tag == PKG_TAG, '%s: not an Unreal package' % path)
        check(117 <= ver <= 130, '%s: package version %d is not UT2003/UT2004' % (path, ver))
        check(max(no, eo, io_) <= len(data), '%s: the name / import / export tables lie outside the file (cut off?)' % path)
        self.ver, self.lic = ver, lic
        self.names = []
        r = Reader(data, no, self)
        for _ in range(nc):
            n = r.idx()
            check(0 < n <= len(data) - r.p, '%s: bad name length %d' % (path, n))
            self.names.append(data[r.p:r.p + n - 1].decode('latin-1'))
            r.p += n
            r.u32()   # name flags
        r.p = io_
        self.imports = []
        for _ in range(ic):
            cp, cn, outer, on = r.name(), r.name(), r.i32(), r.name()
            self.imports.append(Import(cp, cn, on, outer))
        r.p = eo
        raw = []
        for _ in range(ec):
            ci, _si, outer, on, fl, sz = r.idx(), r.idx(), r.i32(), r.name(), r.u32(), r.idx()
            off = r.idx() if sz > 0 else 0
            raw.append((on, ci, fl, sz, off, outer))
        self.exports = []
        for on, ci, fl, sz, off, outer in raw:
            cls = self.imports[-ci - 1].name if ci < 0 else (raw[ci - 1][0] if ci > 0 else 'Class')
            self.exports.append(Export(on, cls, fl, sz, off, outer))

    def find(self, name, cls):
        for e in self.exports:
            if e.name == name and e.cls == cls:
                return e
        raise ExtractError('%s: no %s named %s' % (os.path.basename(self.path), cls, name))

    def reader(self, exp, state_frame=False):
        """A reader at the start of an export's object data. The animation / mesh / sound packages have no state frame (RF_HasStack) and
        refuse one; a map's actors carry one, so ut2004_map.py passes state_frame=True: it is skipped (Node idx, StateNode idx, ProbeMask u64,
        LatentAction i32, and an Offset idx when Node is not 0), so the reader stands at the actor's properties."""
        check(state_frame or not exp.flags & RF_HAS_STACK, '%s has a state frame (RF_HasStack): not supported' % exp.name)
        check(exp.size >= 0 and exp.offset >= 0 and exp.offset + exp.size <= len(self.data), '%s lies outside the file (cut off?)' % exp.name)
        r = Reader(self.data, exp.offset, self)
        if state_frame and exp.flags & RF_HAS_STACK:
            node = r.idx()
            r.idx()
            r.p += 8 + 4
            if node != 0:
                r.idx()
        return r

    def object_package(self, import_index):
        """Name of the package an import (negative object index) lives in: follow the outer imports to the outermost one."""
        i = import_index
        check(i < 0, 'object index %d is not an import' % i)
        imp = self.imports[-i - 1]
        for _ in range(32):
            if imp.outer >= 0:
                return imp.name
            imp = self.imports[-imp.outer - 1]
        raise ExtractError('import %d has a cyclic outer chain' % i)


def find_file(ut_dir, folder, filename):
    """<ut_dir>/<folder>/<filename>, case-insensitively."""
    d = Path(ut_dir) / folder
    check(d.is_dir(), 'no %s folder in %s: is that a UT2004 install?' % (folder, ut_dir))
    for f in os.listdir(d):
        if f.lower() == filename.lower():
            return d / f
    raise ExtractError('%s not found in %s' % (filename, d))


# ====================================================================================================================
# property tags (UE1/UE2 FPropertyTag, UnObject.cpp:571-624, 977-988, 1024-1046)
# ====================================================================================================================
def read_properties(r, raw_structs=False):
    """Read tagged properties up to "None"; -> { name: value } with Byte / Int / Float / Object (as the raw index) / Bool decoded,
    everything else (structs, arrays, strings) skipped by its size. Array elements are stored as 'Name[i]'.
    raw_structs=True (the map reader): a Struct comes back as (struct name, payload bytes) and a String as its payload bytes, to be decoded by the caller."""
    props = {}
    while True:
        nm = r.name()
        if nm == 'None':
            return props
        info = r.u8()
        typ, size_code, is_arr = info & 0x0F, (info >> 4) & 7, bool(info & 0x80)
        struct_name = None
        if typ == 10:
            struct_name = r.name()
        if size_code < 5:
            size = (1, 2, 4, 12, 16)[size_code]
        elif size_code == 5:
            size = r.u8()
        elif size_code == 6:
            size = r.u16()
        else:
            size = r.i32()
        ai = 0
        if is_arr and typ != 3:
            b0 = r.u8()
            if b0 < 0x80:
                ai = b0
            elif not b0 & 0x40:
                ai = ((b0 << 8) | r.u8()) & 0x3FFF
            else:
                b1, b2, b3 = r.u8(), r.u8(), r.u8()
                ai = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) & 0x3FFFFF
        if typ == 3:
            value = is_arr   # a Bool IS its array bit; no payload follows
        else:
            start = r.p
            check(size >= 0 and start + size <= len(r.b), 'property %s has the size %d, which does not fit the file' % (nm, size))   # (a negative size would walk the reader backwards: endless loop)
            value = None
            if typ == 1 and size == 1:
                value = r.b[start]
            elif typ == 2 and size == 4:
                value = struct.unpack_from('<i', r.b, start)[0]
            elif typ == 4 and size == 4:
                value = struct.unpack_from('<f', r.b, start)[0]
            elif typ == 5:
                value = Reader(r.b, start, r.pkg).idx()
            elif raw_structs and typ == 10:
                value = (struct_name, bytes(r.b[start:start + size]))
            elif raw_structs and typ == 13:
                value = bytes(r.b[start:start + size])
            r.p = start + size
        props[nm if ai == 0 else '%s[%d]' % (nm, ai)] = value


# ====================================================================================================================
# sounds (USound: props, FileType name, f32 duration, TLazyArray<u8> RawData = a complete RIFF/WAVE file)
# ====================================================================================================================
@guarded
def read_sound(pkg, exp):
    r = pkg.reader(exp)
    read_properties(r)
    r.name()   # FileType ("WAV")
    if pkg.lic >= 2:
        r.f32()   # duration
    skip = r.i32()
    wav = r.blob()
    check(r.p == skip, '%s: sound data ends at %d, its skip position says %d' % (exp.name, r.p, skip))
    check(r.p <= exp.offset + exp.size, '%s: sound data runs past the export' % exp.name)
    check(wav[:4] == b'RIFF' and wav[8:12] == b'WAVE', '%s: the sound data is not a RIFF/WAVE file' % exp.name)
    return wav


def is_whole_wav(path):
    """A RIFF/WAVE file whose RIFF size says exactly what is on disk (a half file left by a dead run, an empty file or junk fails)."""
    try:
        b = Path(path).read_bytes()
    except OSError:
        return False
    return len(b) >= 44 and b[:4] == b'RIFF' and b[8:12] == b'WAVE' and struct.unpack_from('<I', b, 4)[0] + 8 == len(b)


def extract_sounds(ut_dir, out_dir, log=print, force=False):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pkgs, lists, count = {}, {}, 0
    for rel, export, filename, kind in SOUNDS:
        have = out_dir / filename
        if not force and have.is_file():
            if is_whole_wav(have):
                # a sound the player put there themselves (e.g. from a UT99 sound pack) stays; --force replaces it
                lists.setdefault(kind, []).append(filename)
                count += 1
                log('  %-18s kept (already there; --force replaces it)' % filename)
                continue
            log('  %-18s is not a whole WAV file (empty / cut off): extracting it again' % filename)
        folder, fname = rel.split('/')
        if rel not in pkgs:
            pkgs[rel] = Package(find_file(ut_dir, folder, fname))
        try:
            wav = read_sound(pkgs[rel], pkgs[rel].find(export, 'Sound'))
        except ExtractError as e:
            log('  skipped %s: %s' % (filename, e))
            continue
        write_atomic(have, wav)
        lists.setdefault(kind, []).append(filename)
        count += 1
        log('  %-18s %7d bytes  <- %s' % (filename, len(wav), export))
    check(count > 0, 'no sound could be extracted')
    write_atomic(out_dir / 'sounds.json', (json.dumps(lists, indent=2) + '\n').encode('utf-8'))
    log('%d sounds + sounds.json -> %s' % (count, out_dir))
    return lists


# ====================================================================================================================
# USkeletalMesh (UT2 branch of UnMesh2.cpp:68-206 ULodMesh + 357-617 USkeletalMesh); we use the BASE mesh
# ====================================================================================================================
@guarded
def read_skeletal_mesh(pkg, exp):
    r = pkg.reader(exp)
    read_properties(r)
    ver = pkg.ver
    r.vec(); r.vec(); r.u8(); r.vec(); r.f32()                        # UPrimitive: bounding box + sphere
    version = r.i32()
    r.i32()                                                           # VertexCount
    check(version >= 4, 'LodMesh version %d (UT2004 has 4)' % version)
    r.arr(r.u32)                                                      # Verts (empty for skeletal meshes)
    textures = r.arr(r.idx)                                           # skin slots: imports
    scale, origin = r.vec(), r.vec()
    rot = (r.i32(), r.i32(), r.i32())                                 # RotOrigin pitch, yaw, roll (65536 = 360 deg)
    r.arr(r.u16)                                                      # FaceLevel
    r.arr(lambda: (r.u16(), r.u16(), r.u16(), r.u16()))               # Faces (empty)
    r.arr(r.u16)                                                      # CollapseWedgeThus
    r.arr(lambda: (r.u16(), r.f32(), r.f32()))                        # Wedges (empty here)
    materials = r.arr(lambda: (r.u32(), r.i32()))                     # (PolyFlags, TextureIndex)
    for _ in range(3):
        r.f32()                                                       # MeshScaleMax, LODHysteresis, LODStrength
    r.i32(); r.f32(); r.f32()                                         # LODMinVerts, LODMorph, LODZDisplace
    r.i32(); r.idx(); r.vec(); r.i32(); r.i32(); r.i32(); r.vec(); r.u32(); r.i32(); r.i32(); r.i32()   # impostor (version >= 3)
    r.f32()                                                           # SkinTesselationFactor (version >= 4)
    r.arr(r.vec)                                                      # Points2 (empty)

    def bone():
        nm, flags, q, pos, _length, _size, nchildren, parent = r.name(), r.u32(), r.quat(), r.vec(), r.f32(), r.vec(), r.i32(), r.i32()
        return {'name': nm, 'q': q, 'pos': pos, 'parent': parent, 'nchildren': nchildren, 'flags': flags}
    bones = r.arr(bone)
    animation = r.idx()
    r.i32()                                                           # SkeletalDepth
    r.arr(lambda: (r.arr(r.u16), r.i32()))                            # WeightIndices (empty)
    r.arr(lambda: (r.u16(), r.u16()))                                 # BoneInfluences (empty)
    r.arr(r.name); r.arr(r.name); r.arr(lambda: (r.vec(), r.vec(), r.vec(), r.vec()))   # attach aliases / bones / coords

    def section():
        return tuple(r.u16() for _ in range(9))

    def lod():
        r.arr(r.u32); r.arr(lambda: (r.vec(), r.u32())); r.i32()      # SkinningData, SkinPoints, NumSoftWedges
        r.arr(section); r.arr(section)                                # soft / rigid sections
        r.arr(r.u16); r.i32(); r.arr(r.u16); r.i32()                  # soft / rigid index buffers (+ revision)
        r.i32(); r.i32(); r.i32(); r.arr(lambda: (r.vec(), r.vec(), r.f32(), r.f32()))   # vertex stream
        r.lazy(lambda: (r.f32(), r.u16(), r.u16())); r.lazy(lambda: (r.u16(), r.f32(), r.f32()))
        r.lazy(lambda: (r.u16(), r.u16(), r.u16(), r.u16())); r.lazy(r.vec)
        r.f32(); r.f32(); r.i32(); r.i32(); r.i32(); r.i32()
    r.arr(lod)
    r.idx()                                                           # f224
    points = r.lazy(r.vec)
    wedges = r.lazy(lambda: (r.u16(), r.f32(), r.f32()))              # (point, U, V)
    tris = r.lazy(lambda: (r.u16(), r.u16(), r.u16(), r.u8(), r.u8(), r.u32()))   # (w0, w1, w2, mat, aux mat, smoothing)
    infl = r.lazy(lambda: (r.f32(), r.u16(), r.u16()))                # (weight, point, bone)
    r.lazy(r.u16); r.lazy(r.u16)                                      # CollapseWedge, f1C8
    if ver >= 120:
        r.u32()                                                       # AuthKey
    if ver >= 122:
        r.idx()                                                       # KarmaProps

        def extras():
            if ver > 123:
                r.i32()
            if ver > 124:
                r.i32(); r.i32()
        r.arr(lambda: (r.name(), r.vec(), r.f32(), extras()))         # BoundingSpheres
        r.arr(lambda: (r.name(), r.vec(), r.vec(), extras()))         # BoundingBoxes
        r.arr(r.idx)
    if ver >= 127:
        r.idx()                                                       # CollisionMesh
    check(r.p == exp.offset + exp.size, '%s: the mesh parse ends at %d, the export ends at %d' % (exp.name, r.p, exp.offset + exp.size))
    check(scale[0] == scale[1] == scale[2], 'MeshScale %s is not uniform' % (scale,))
    return {'textures': textures, 'scale': scale[0], 'origin': origin, 'rot': rot, 'materials': materials, 'bones': bones,
            'animation': animation, 'points': points, 'wedges': wedges, 'tris': tris, 'influences': infl}


# ====================================================================================================================
# UMeshAnimation (UnMesh2.h:1246-1458, UnAnim2.cpp:21-75)
# ====================================================================================================================
@guarded
def read_animation(pkg, exp):
    r = pkg.reader(exp)
    read_properties(r)
    r.i32()                                                           # Version
    ref_bones = r.arr(lambda: (r.name(), r.u32(), r.i32()))           # (name, flags, parent)

    def track():
        return {'flags': r.u32(), 'q': r.arr(r.quat), 'p': r.arr(r.vec), 't': r.arr(r.f32)}

    def chunk():
        r.vec()                                                       # RootSpeed3D
        track_time = r.f32()
        r.i32(); r.u32(); r.arr(r.i32)                                # StartBone, Flags, BoneIndices
        tracks = r.arr(track)
        track()                                                       # RootTrack (empty for JuggA)
        return {'track_time': track_time, 'tracks': tracks}
    moves = r.arr(chunk)

    def notify():
        r.f32(); r.name()
        if pkg.ver >= 112:
            r.idx()

    def seq():
        if pkg.ver >= 115:
            r.f32()
        name = r.name()
        r.arr(r.name)                                                 # Groups
        start, frames = r.i32(), r.i32()
        r.arr(notify)
        return {'name': name, 'start': start, 'frames': frames, 'rate': r.f32()}
    seqs = r.arr(seq)
    check(r.p == exp.offset + exp.size, '%s: the animation parse ends at %d, the export ends at %d' % (exp.name, r.p, exp.offset + exp.size))
    check(len(moves) == len(seqs), 'animation: %d moves for %d sequences' % (len(moves), len(seqs)))
    for s, m in zip(seqs, moves):
        s['move'] = m
    return {'ref_bones': [b[0] for b in ref_bones], 'seqs': seqs}


# ====================================================================================================================
# textures (UTexture: props incl. Format / USize / VSize, TArray<FMipmap>; DXT1 / DXT3 / DXT5) + PNG
# ====================================================================================================================
TEX_FORMATS = {3: 'dxt1', 7: 'dxt3', 8: 'dxt5'}


@guarded
def read_texture(pkg, exp, size=1024):
    """-> (width, height, format name, compressed bytes) of the mip whose width is `size` (else the largest one not above it)."""
    r = pkg.reader(exp)
    props = read_properties(r)
    fmt = TEX_FORMATS.get(props.get('Format', 0))
    check(fmt is not None, '%s: texture format %s is not supported (DXT1/3/5 only)' % (exp.name, props.get('Format', 0)))

    def mip():
        skip = r.i32()
        data = r.blob()
        check(r.p == skip, '%s: mip data ends at %d, its skip position says %d' % (exp.name, r.p, skip))
        w, h = r.i32(), r.i32()
        r.u8(); r.u8()
        return (w, h, data)
    mips = r.arr(mip)
    check(r.p == exp.offset + exp.size, '%s: the texture parse ends at %d, the export ends at %d' % (exp.name, r.p, exp.offset + exp.size))
    fit = [m for m in mips if m[0] <= size and m[0] >= 4 and m[1] >= 4]
    check(fit, '%s: no mip of at most %d px' % (exp.name, size))
    w, h, data = max(fit, key=lambda m: m[0])
    return w, h, fmt, data


def _rgb565(c):
    r, g, b = (c >> 11) & 31, (c >> 5) & 63, c & 31
    return ((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2))


def _colors(c0, c1, four):
    """The four colours of a DXT colour block; `transparent` = index 3 is black with alpha 0 (DXT1, c0 <= c1)."""
    p0, p1 = _rgb565(c0), _rgb565(c1)
    if four or c0 > c1:
        return [p0, p1, tuple((2 * a + b) // 3 for a, b in zip(p0, p1)), tuple((a + 2 * b) // 3 for a, b in zip(p0, p1))], False
    return [p0, p1, tuple((a + b) // 2 for a, b in zip(p0, p1)), (0, 0, 0)], True


def _alpha5(a0, a1):
    if a0 > a1:
        return [a0, a1] + [((7 - i) * a0 + i * a1) // 7 for i in range(1, 7)]
    return [a0, a1] + [((5 - i) * a0 + i * a1) // 5 for i in range(1, 5)] + [0, 255]


def decode_dxt(data, width, height, fmt):
    """DXT1 / DXT3 / DXT5 -> (channels, rows): rows = every pixel row top to bottom, each prefixed with the PNG filter byte 0.
    channels is 3 (opaque RGB) or 4 (RGBA: DXT3 / DXT5, or a DXT1 texture that really uses its transparent index)."""
    bw, bh = (width + 3) // 4, (height + 3) // 4
    bsize = 8 if fmt == 'dxt1' else 16
    check(len(data) >= bw * bh * bsize, 'DXT data is too short for %dx%d' % (width, height))
    transparent = False
    if fmt == 'dxt1':
        for c0, c1, bits in struct.iter_unpack('<HHI', data[:bw * bh * 8]):
            if c0 <= c1 and bits & (bits >> 1) & 0x55555555:
                transparent = True
                break
    ch = 3 if fmt == 'dxt1' and not transparent else 4
    stride = 1 + width * ch
    out = bytearray(stride * height)
    pos = 0
    for by in range(bh):
        for bx in range(bw):
            a = None
            if fmt == 'dxt3':
                a = [((int.from_bytes(data[pos:pos + 8], 'little') >> (4 * i)) & 15) * 17 for i in range(16)]
            elif fmt == 'dxt5':
                lut = _alpha5(data[pos], data[pos + 1])
                ab = int.from_bytes(data[pos + 2:pos + 8], 'little')
                a = [lut[(ab >> (3 * i)) & 7] for i in range(16)]
            cpos = pos + (0 if fmt == 'dxt1' else 8)
            c0, c1, bits = struct.unpack_from('<HHI', data, cpos)
            cols, trans = _colors(c0, c1, fmt != 'dxt1')
            if ch == 3:
                px = [bytes(c) for c in cols]
            else:
                px = [bytes(c) + b'\xff' for c in cols]
                if trans:
                    px[3] = b'\x00\x00\x00\x00'
            nx = min(4, width - bx * 4)
            for y in range(min(4, height - by * 4)):
                if a is None:
                    row = b''.join([px[(bits >> (8 * y + 2 * x)) & 3] for x in range(nx)])
                else:
                    row = b''.join([px[(bits >> (8 * y + 2 * x)) & 3][:3] + bytes((a[4 * y + x],)) for x in range(nx)])
                o = (by * 4 + y) * stride + 1 + bx * 4 * ch
                out[o:o + nx * ch] = row
            pos += bsize
    return ch, bytes(out)


def png_encode(width, height, channels, rows):
    """A PNG from filter-prefixed rows (8-bit RGB or RGBA)."""
    check(channels in (3, 4) and len(rows) == (1 + width * channels) * height, 'PNG rows do not match %dx%dx%d' % (width, height, channels))

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2 if channels == 3 else 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(rows, 6)) + chunk(b'IEND', b'')


# ====================================================================================================================
# conversion: Unreal (left-handed, Z up, X forward, UU) -> glTF / three.js (right-handed, Y up, forward -Z at yaw 0, metres)
#   k = MeshScale / 50 metres per raw unit, O = MeshOrigin. The mesh's RotOrigin, the facing and the scale are baked in; a lift is added to
#   the height (the Gorge's feet origin: +0.88; a weapon has none). For the Gorge (RotOrigin yaw -90, lift 0.88):
#   points and the root bone translation:   C(x, y, z) = (-(x - Ox) k,  (z - Oz) k + 0.88,  -(y - Oy) k)
#   every other bone translation:           c(x, y, z) = (-x k,  z k,  -y k)
#   rotations (stored FQuat s, xyzw): UE2 stores the root bone's true rotation and every other bone CONJUGATED, and the map above
#   is a reflection (det -1), so   root: (s.x, -s.z, s.y, s.w)    others: (-s.x, s.z, -s.y, s.w)
#   In general the linear part is T = M . R(RotOrigin), M = Unreal (x, y, z) -> three (y, z, -x). With RotOrigin in quarter turns it is a signed
#   permutation of the axes, kept as a Frame: output component i = sign * input[source] (no rounding, so the Gorge's numbers stay as they were).
#   A direction maps by T, a rotation's axis by T too (negated for the root bone, as above).
#   The shield gun: first person RotOrigin (0, 0, 0) -> raw +x (the muzzle) = -z (forward), +y = +x, +z = +y; third person RotOrigin
#   (yaw 180, roll 180) -> raw +x = +z, +y = +x, +z = -y: its raw axes are those of the Gorge's Bone_weapon bone, so the gun is parented to that bone.
# ====================================================================================================================
Frame = namedtuple('Frame', 'axes lift')          # axes: for each three.js component (source index of the raw vector, sign); lift: added to the height of a point
_M = ((0, 1, 0), (0, 0, 1), (-1, 0, 0))           # Unreal -> three.js: right = Unreal Y, up = Unreal Z, back = -Unreal X


def _matmul(a, b):
    return tuple(tuple(sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)) for i in range(3))


def frame_from_rot(rot, lift=0.0):
    """The Frame of a mesh whose RotOrigin is `rot` (pitch, yaw, roll; 65536 = 360 deg). Only quarter turns of yaw and half turns of pitch / roll
    are supported (every UT2004 mesh we read has them; the sign of a quarter turn is the one verified on the Gorge, yaw -90 = 49152)."""
    pitch, yaw, roll = (int(r) % 65536 for r in rot)
    check(yaw % 16384 == 0 and pitch in (0, 32768) and roll in (0, 32768),
          'RotOrigin %s is not supported (yaw in quarter turns, pitch and roll 0 or 180 degrees)' % (tuple(rot),))
    c, s = (1, 0, -1, 0)[yaw // 16384], (0, 1, 0, -1)[yaw // 16384]
    t = ((c, -s, 0), (s, c, 0), (0, 0, 1))        # yaw: raw x axis -> (cos, sin, 0)
    if pitch:
        t = _matmul(t, ((-1, 0, 0), (0, 1, 0), (0, 0, -1)))
    if roll:
        t = _matmul(t, ((1, 0, 0), (0, -1, 0), (0, 0, -1)))
    t = _matmul(_M, t)
    axes = []
    for row in t:
        (j,) = [j for j in range(3) if row[j]]
        axes.append((j, row[j]))
    return Frame(tuple(axes), lift)


GORGE_FRAME = frame_from_rot((0, -16384, 0), HULL_HALF_HEIGHT)   # (-x, z, -y) + the lift: written out by hand above


def convert_point(p, origin, k, frame=GORGE_FRAME):
    (a, sa), (b, sb), (c, sc) = frame.axes
    return (sa * (p[a] - origin[a]) * k, sb * (p[b] - origin[b]) * k + frame.lift, sc * (p[c] - origin[c]) * k)


def convert_dir(v, k, frame=GORGE_FRAME):
    (a, sa), (b, sb), (c, sc) = frame.axes
    return (sa * v[a] * k, sb * v[b] * k, sc * v[c] * k)


def convert_rotation(s, is_root, frame=GORGE_FRAME):
    (a, sa), (b, sb), (c, sc) = frame.axes
    g = -1 if is_root else 1
    q = (g * sa * s[a], g * sb * s[b], g * sc * s[c], s[3])
    n = math.sqrt(sum(c * c for c in q))
    check(n > 1e-6, 'zero quaternion')
    return tuple(c / n for c in q)


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz)


def qrot(q, v):
    x, y, z, w = q
    vx, vy, vz = v
    tx, ty, tz = 2 * (y * vz - z * vy), 2 * (z * vx - x * vz), 2 * (x * vy - y * vx)
    return (vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx))


def world_transforms(parents, ts, qs):
    """Bone world (rotation, translation) from local ones; parents[i] < i, bone 0 is the root."""
    out = []
    for i, (t, q) in enumerate(zip(ts, qs)):
        if i == 0:
            out.append((q, tuple(t)))
        else:
            pq, pt = out[parents[i]]
            r = qrot(pq, t)
            out.append((qmul(pq, q), (pt[0] + r[0], pt[1] + r[1], pt[2] + r[2])))
    return out


def inverse_bind_matrix(q, t):
    """Column-major 4x4 of the inverse of the rigid transform (q, t): [R^T | -R^T t]."""
    x, y, z, w = q
    r = ((1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
         (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
         (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)))
    rt = tuple(tuple(r[j][i] for j in range(3)) for i in range(3))
    tt = tuple(-(rt[i][0] * t[0] + rt[i][1] * t[1] + rt[i][2] * t[2]) for i in range(3))
    m = [list(rt[0]) + [tt[0]], list(rt[1]) + [tt[1]], list(rt[2]) + [tt[2]], [0.0, 0.0, 0.0, 1.0]]
    return [m[row][col] for col in range(4) for row in range(4)]


def build_clip(seq, bone_map, origin, k, loop, frame=GORGE_FRAME):
    """One glb animation from a JuggA sequence: for EVERY bone a translation and a rotation channel (so a cross-fade never falls back to
    the bind pose). KeyTime is in frames (seconds = frame / Rate); a looped clip gets key 0 again at NumFrames / Rate; 1-key tracks stay
    1-key; a clip that is a single pose (all tracks 1 key) gets a second, identical key at 1 / Rate so it has a duration."""
    rate, frames, move = float(seq['rate']), seq['frames'], seq['move']
    check(rate > 0 and frames > 0, '%s: bad rate / frame count' % seq['name'])
    tscale = frames / move['track_time'] if move['track_time'] > 0 else 1.0
    channels = []
    for bi, ai in enumerate(bone_map):
        tr = move['tracks'][ai]
        times = [t * tscale for t in tr['t']]
        check(times and abs(times[0]) < 1e-6 and all(b > a for a, b in zip(times, times[1:])), '%s: bone %d key times are not increasing from 0' % (seq['name'], bi))
        for path, raw in (('translation', tr['p']), ('rotation', tr['q'])):
            check(len(raw) in (1, len(times)), '%s: bone %d has %d %s keys for %d times' % (seq['name'], bi, len(raw), path, len(times)))
            if path == 'translation':
                vals = [convert_point(v, origin, k, frame) if bi == 0 else convert_dir(v, k, frame) for v in raw]
            else:
                vals = [convert_rotation(v, bi == 0, frame) for v in raw]
                for i in range(1, len(vals)):   # shortest-arc slerp: keep neighbouring quaternions in the same hemisphere
                    if sum(a * b for a, b in zip(vals[i], vals[i - 1])) < 0:
                        vals[i] = tuple(-c for c in vals[i])
            if len(vals) == 1:
                ts = [0.0]
            else:
                ts = [t / rate for t in times]
                if loop:
                    check(times[-1] < frames, '%s: last key %.2f is not before NumFrames %d' % (seq['name'], times[-1], frames))
                    ts.append(frames / rate)
                    vals = vals + [vals[0]]
            channels.append({'node': bi, 'path': path, 'times': ts, 'values': vals})
    if max(c['times'][-1] for c in channels) == 0.0:
        for c in channels:
            c['times'] = [0.0, 1.0 / rate]
            c['values'] = c['values'] * 2
    return {'name': seq['name'], 'loop': loop, 'channels': channels}


def build_skeletal(ukx, ut_dir, mesh_name, clip_names, loop, lift, name, tex_size=1024, log=None, tex_cache=None, alpha=False):
    """Read one SkeletalMesh (+ the animation it points at + its textures) from the package `ukx` and convert it: -> the model dict write_glb()
    takes (plus 'stats' for the tests). `loop(clip name)` says which clips loop, `lift` is the Frame's height offset (the Gorge stands on its
    feet origin, a weapon does not), `name` the glb's root node, `alpha` allows textures with an alpha channel (RGBA PNG; the Gorge's skins are
    opaque), tex_cache = a dict that keeps decoded textures between two models of one run."""
    log = log or (lambda *a: None)
    tex_cache = {} if tex_cache is None else tex_cache
    mesh = read_skeletal_mesh(ukx, ukx.find(mesh_name, 'SkeletalMesh'))
    check(mesh['animation'] > 0, 'the mesh has no animation object')
    anim_exp = ukx.exports[mesh['animation'] - 1]
    check(anim_exp.cls == 'MeshAnimation', 'the mesh animation is a %s, not a MeshAnimation' % anim_exp.cls)
    anim = read_animation(ukx, anim_exp)
    bones, k, origin = mesh['bones'], mesh['scale'] / UU_PER_METRE, mesh['origin']
    frame = frame_from_rot(mesh['rot'], lift)
    nb = len(bones)
    check(0 < nb <= 255, '%d bones' % nb)
    check(bones[0]['parent'] == 0 and all(0 <= b['parent'] < i for i, b in enumerate(bones) if i), 'bones are not parent-first')
    # skeleton in the converted space
    cbones = []
    for i, b in enumerate(bones):
        t = convert_point(b['pos'], origin, k, frame) if i == 0 else convert_dir(b['pos'], k, frame)
        cbones.append({'name': b['name'], 'parent': b['parent'], 't': t, 'q': convert_rotation(b['q'], i == 0, frame)})
    # animation tracks by lower-cased bone name
    names = {n.lower(): i for i, n in enumerate(anim['ref_bones'])}
    check(len(names) == len(anim['ref_bones']), 'animation bone names are not unique when lower-cased')
    check(all(b['name'].lower() in names for b in bones), 'the animation lacks bones of the mesh')
    bone_map = [names[b['name'].lower()] for b in bones]
    seqs = {s['name']: s for s in anim['seqs']}
    missing = [c for c in clip_names if c not in seqs]
    check(not missing, 'sequences not in %s: %s' % (os.path.basename(ukx.path), ', '.join(missing)))
    clips = [build_clip(seqs[c], bone_map, origin, k, loop(c), frame) for c in clip_names]
    # vertices: one per wedge
    pts = [convert_point(p, origin, k, frame) for p in mesh['points']]
    per = [[] for _ in pts]
    for w, pi, bi in mesh['influences']:
        check(pi < len(pts) and bi < nb, 'vertex influence out of range')
        per[pi].append((w, bi))
    skin = []
    for lst in per:
        lst = sorted(lst, reverse=True)[:4]
        tot = sum(w for w, _ in lst)
        if not lst or tot <= 0:
            lst, tot = [(1.0, 0)], 1.0
        lst = [(w / tot, b) for w, b in lst] + [(0.0, 0)] * (4 - len(lst))
        skin.append(([b for _, b in lst], [w for w, _ in lst]))
    # smooth normals: area-weighted face normals accumulated per POINT (UV seams stay smooth), triangles keep their stored order
    wedges, tris = mesh['wedges'], mesh['tris']
    acc = [[0.0, 0.0, 0.0] for _ in pts]
    for w0, w1, w2, _m, _a, _s in tris:
        p0, p1, p2 = (wedges[w][0] for w in (w0, w1, w2))
        a, b, c = pts[p0], pts[p1], pts[p2]
        e1, e2 = (b[0] - a[0], b[1] - a[1], b[2] - a[2]), (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        n = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0])
        for p in (p0, p1, p2):
            acc[p][0] += n[0]; acc[p][1] += n[1]; acc[p][2] += n[2]
    normals = []
    for n in acc:
        l = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2)
        normals.append((n[0] / l, n[1] / l, n[2] / l) if l > 1e-12 else (0.0, 1.0, 0.0))
    verts = {
        'positions': [pts[w[0]] for w in wedges], 'normals': [normals[w[0]] for w in wedges], 'uvs': [(w[1], w[2]) for w in wedges],
        'joints': [skin[w[0]][0] for w in wedges], 'weights': [skin[w[0]][1] for w in wedges],
    }
    # one primitive per material index, one glTF material per distinct texture
    tex_slots = []   # texture slot -> glTF material index
    prims, materials, images = [], [], []
    stats_tex = []
    pkg_cache = {}
    for mi in sorted({t[3] for t in tris}):
        check(mi < len(mesh['materials']), 'triangle material index %d' % mi)
        slot = mesh['materials'][mi][1]
        check(0 <= slot < len(mesh['textures']), 'material texture index %d' % slot)
        if slot not in dict(tex_slots):
            ref = mesh['textures'][slot]
            check(ref < 0, 'texture slot %d is not an import' % slot)
            imp = ukx.imports[-ref - 1]
            pkg_name = ukx.object_package(ref)
            key = (pkg_name, imp.name, tex_size)
            if key not in tex_cache:
                if pkg_name not in pkg_cache:
                    pkg_cache[pkg_name] = Package(find_file(ut_dir, 'Textures', pkg_name + '.utx'))
                tp = pkg_cache[pkg_name]
                w, h, fmt, data = read_texture(tp, tp.find(imp.name, 'Texture'), tex_size)
                ch, rows = decode_dxt(data, w, h, fmt)
                check(ch == 3 or alpha, '%s uses transparent texels: not expected for the Gorge skins' % imp.name)
                tex_cache[key] = (w, h, fmt, ch, png_encode(w, h, ch, rows))
            w, h, fmt, ch, png = tex_cache[key]
            images.append(png)
            materials.append({'name': imp.name, 'image': len(images) - 1})
            tex_slots.append((slot, len(materials) - 1))
            stats_tex.append({'name': imp.name, 'width': w, 'height': h, 'format': fmt, 'channels': ch, 'png_bytes': len(png)})
            log('  texture %s %dx%d %s -> PNG %s, %d bytes' % (imp.name, w, h, fmt, 'RGBA' if ch == 4 else 'RGB', len(png)))
        prims.append({'indices': [w for t in tris if t[3] == mi for w in t[:3]], 'material': dict(tex_slots)[slot]})
    return {
        'name': name, 'bones': cbones, 'verts': verts, 'prims': prims, 'materials': materials, 'images': images, 'clips': clips,
        'stats': {'bones': nb, 'points': len(pts), 'wedges': len(wedges), 'tris': len(tris), 'textures': stats_tex,
                  'tris_per_material': {mi: sum(1 for t in tris if t[3] == mi) for mi in sorted({t[3] for t in tris})},
                  'sequences': len(anim['seqs']), 'influences': len(mesh['influences']), 'scale': mesh['scale'], 'origin': origin, 'rot': mesh['rot'],
                  'rate': {c: seqs[c]['rate'] for c in clip_names}, 'frames': {c: seqs[c]['frames'] for c in clip_names}},
    }


def build_model(ut_dir, tex_size=1024, clip_names=CLIPS, log=None):
    """Read JuggMaleA + JuggA + the two skins and convert them: -> the model dict write_glb() takes (plus 'stats' for the tests)."""
    ukx = Package(find_file(ut_dir, 'Animations', 'Jugg.ukx'))
    return build_skeletal(ukx, ut_dir, 'JuggMaleA', clip_names, is_loop, HULL_HALF_HEIGHT, 'Gorge', tex_size, log)


def build_weapon(ut_dir, which, tex_size=1024, log=None, tex_cache=None):
    """The shield gun, `which` = '1st' (the viewmodel with its 7 sequences) or '3rd' (the held model, one pose): the same dict as build_model."""
    check(which in ('1st', '3rd'), 'weapon model %r' % (which,))
    ukx = Package(find_file(ut_dir, 'Animations', 'Weapons.ukx'))
    clips = WEAPON_CLIPS_1ST if which == '1st' else WEAPON_CLIPS_3RD
    return build_skeletal(ukx, ut_dir, 'ShieldGun_' + which, clips, lambda c: c in WEAPON_LOOPS, 0.0, 'ShieldGun', tex_size, log, tex_cache, alpha=True)


# ====================================================================================================================
# glTF 2.0 binary writer + validator
# ====================================================================================================================
GL_FLOAT, GL_UBYTE, GL_USHORT = 5126, 5121, 5123
GL_ARRAY_BUFFER, GL_ELEMENT_ARRAY_BUFFER = 34962, 34963
COMP_SIZE = {GL_FLOAT: 4, GL_UBYTE: 1, GL_USHORT: 2}
TYPE_COUNT = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def _flat(rows):
    return [c for r in rows for c in r]


def f32(x):
    """x rounded to float32 (accessor min / max must be the values the file really holds)."""
    return struct.unpack('<f', struct.pack('<f', x))[0]


def write_glb(model):
    """The model dict (see build_model) -> bytes of a .glb. Nodes: 0 = the model's name ("Gorge", "ShieldGun"; children: the root bone node and the
    mesh node), node 1 + i = bone i, the last node = the skinned mesh (a child of node 0, never of a bone); skin joints = bones in order."""
    bones, verts = model['bones'], model['verts']
    nb, nv = len(bones), len(verts['positions'])
    buf = bytearray()
    views, accs = [], []

    def add_view(data, target=None):
        buf.extend(b'\0' * (-len(buf) % 4))
        v = {'buffer': 0, 'byteOffset': len(buf), 'byteLength': len(data)}
        if target:
            v['target'] = target
        buf.extend(data)
        views.append(v)
        return len(views) - 1

    def add_acc(data, comp, typ, count, target=None, minmax=None):
        a = {'bufferView': add_view(data, target), 'componentType': comp, 'count': count, 'type': typ}
        if minmax:
            a['min'], a['max'] = minmax
        accs.append(a)
        return len(accs) - 1

    def floats(rows, typ, target=None, minmax=None, count=None):
        flat = _flat(rows)
        return add_acc(struct.pack('<%df' % len(flat), *flat), GL_FLOAT, typ, count if count is not None else len(rows), target, minmax)

    pos = [tuple(f32(c) for c in p) for p in verts['positions']]
    mn = [min(p[i] for p in pos) for i in range(3)]
    mx = [max(p[i] for p in pos) for i in range(3)]
    attrs = {
        'POSITION': floats(pos, 'VEC3', GL_ARRAY_BUFFER, (mn, mx)),
        'NORMAL': floats(verts['normals'], 'VEC3', GL_ARRAY_BUFFER),
        'TEXCOORD_0': floats(verts['uvs'], 'VEC2', GL_ARRAY_BUFFER),
        'JOINTS_0': add_acc(bytes(_flat(verts['joints'])), GL_UBYTE, 'VEC4', nv, GL_ARRAY_BUFFER),
        'WEIGHTS_0': floats(verts['weights'], 'VEC4', GL_ARRAY_BUFFER),
    }
    primitives = []
    for p in model['prims']:
        idx = p['indices']
        check(all(i < nv for i in idx), 'index out of range')
        ia = add_acc(struct.pack('<%dH' % len(idx), *idx), GL_USHORT, 'SCALAR', len(idx), GL_ELEMENT_ARRAY_BUFFER)
        primitives.append({'attributes': dict(attrs), 'indices': ia, 'material': p['material'], 'mode': 4})
    # skeleton
    world = world_transforms([b['parent'] for b in bones], [b['t'] for b in bones], [b['q'] for b in bones])
    ibm = [inverse_bind_matrix(q, t) for q, t in world]
    ibm_acc = floats(ibm, 'MAT4')
    mesh_node = nb + 1
    nodes = [{'name': model.get('name', 'Gorge'), 'children': [1, mesh_node]}]
    for i, b in enumerate(bones):
        node = {'name': b['name'], 'translation': list(b['t']), 'rotation': list(b['q'])}
        kids = [j + 1 for j in range(1, nb) if bones[j]['parent'] == i]
        if kids:
            node['children'] = kids
        nodes.append(node)
    nodes.append({'name': model.get('name', 'Gorge') + 'Mesh', 'mesh': 0, 'skin': 0})
    # materials / images
    images = [{'bufferView': add_view(png), 'mimeType': 'image/png', 'name': m['name']} for png, m in zip(model['images'], model['materials'])]
    textures = [{'sampler': 0, 'source': m['image']} for m in model['materials']]
    materials = [{'name': m['name'], 'pbrMetallicRoughness': {'baseColorTexture': {'index': i}, 'metallicFactor': 0.0, 'roughnessFactor': 0.85}}
                 for i, m in enumerate(model['materials'])]
    # animations (identical key-time arrays share one input accessor)
    time_acc = {}
    animations = []
    for clip in model['clips']:
        samplers, channels = [], []
        for ch in clip['channels']:
            key = tuple(f32(t) for t in ch['times'])
            if key not in time_acc:
                time_acc[key] = add_acc(struct.pack('<%df' % len(key), *key), GL_FLOAT, 'SCALAR', len(key), None, ([min(key)], [max(key)]))
            out = floats(ch['values'], 'VEC3' if ch['path'] == 'translation' else 'VEC4')
            samplers.append({'input': time_acc[key], 'output': out, 'interpolation': 'LINEAR'})
            channels.append({'sampler': len(samplers) - 1, 'target': {'node': ch['node'] + 1, 'path': ch['path']}})
        animations.append({'name': clip['name'], 'samplers': samplers, 'channels': channels})
    gltf = {
        'asset': {'version': '2.0', 'generator': GLB_GENERATOR,
                  'extras': {'note': 'local copy made from the owner\'s own UT2004 install: never commit or deploy this file'}},
        'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': nodes,
        'skins': [{'joints': list(range(1, nb + 1)), 'skeleton': 1, 'inverseBindMatrices': ibm_acc}],
        'meshes': [{'name': model.get('name', 'Gorge'), 'primitives': primitives}],
        'materials': materials, 'textures': textures, 'images': images,
        'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}],
        'animations': animations, 'accessors': accs, 'bufferViews': views,
    }
    binary = bytes(buf) + b'\0' * (-len(buf) % 4)
    gltf['buffers'] = [{'byteLength': len(binary)}]
    js = json.dumps(gltf, separators=(',', ':'), allow_nan=False).encode('utf-8')
    js += b' ' * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    return (struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(js), 0x4E4F534A) + js
            + struct.pack('<II', len(binary), 0x004E4942) + binary)


def read_glb(data):
    """-> (json dict, BIN bytes) of a .glb, with the container checks."""
    check(len(data) >= 20, 'glb too small')
    magic, version, total = struct.unpack_from('<III', data, 0)
    check(magic == 0x46546C67 and version == 2, 'not a glTF 2 binary')
    check(total == len(data), 'glb length field %d != file size %d' % (total, len(data)))
    jl, jt = struct.unpack_from('<II', data, 12)
    check(jt == 0x4E4F534A and jl % 4 == 0, 'first chunk is not JSON')
    js = json.loads(data[20:20 + jl].decode('utf-8'))
    bl, bt = struct.unpack_from('<II', data, 20 + jl)
    check(bt == 0x004E4942 and bl % 4 == 0 and 28 + jl + bl == len(data), 'second chunk is not a BIN chunk that ends the file')
    return js, data[28 + jl:28 + jl + bl]


def accessor_values(js, binary, i):
    """Decode accessor i to a list of tuples (floats / ints), checking that it lies inside its buffer view."""
    a = js['accessors'][i]
    v = js['bufferViews'][a['bufferView']]
    ncomp = TYPE_COUNT[a['type']]
    size = COMP_SIZE[a['componentType']] * ncomp * a['count']
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    check(start % 4 == 0 and a.get('byteOffset', 0) + size <= v['byteLength'], 'accessor %d does not fit its buffer view' % i)
    check(v.get('byteOffset', 0) + v['byteLength'] <= len(binary), 'buffer view of accessor %d runs past the buffer' % i)
    fmt = {GL_FLOAT: 'f', GL_UBYTE: 'B', GL_USHORT: 'H'}[a['componentType']]
    flat = struct.unpack_from('<%d%s' % (ncomp * a['count'], fmt), binary, start)
    return [tuple(flat[j * ncomp:(j + 1) * ncomp]) for j in range(a['count'])]


def validate_glb(data):
    """Structural self-check of a glb written by write_glb: accessors inside their views, indices in range, joints < joint count,
    normals unit, weights sum 1, one inverse bind matrix per joint, animation times strictly increasing and quaternions unit,
    channel targets valid. Raises ExtractError; -> a small summary dict."""
    js, binary = read_glb(data)
    nodes, skin = js['nodes'], js['skins'][0]
    nj = len(skin['joints'])
    for v in js['bufferViews']:
        check(v.get('byteOffset', 0) % 4 == 0 and v.get('byteOffset', 0) + v['byteLength'] <= len(binary), 'bad buffer view')
    for i in range(len(js['accessors'])):
        accessor_values(js, binary, i)
    check(len(accessor_values(js, binary, skin['inverseBindMatrices'])) == nj, 'inverse bind matrices != joints')
    nv = 0
    for prim in js['meshes'][0]['primitives']:
        at = prim['attributes']
        pos = accessor_values(js, binary, at['POSITION'])
        nv = len(pos)
        a = js['accessors'][at['POSITION']]
        check(all(abs(min(p[i] for p in pos) - a['min'][i]) < 1e-5 and abs(max(p[i] for p in pos) - a['max'][i]) < 1e-5 for i in range(3)), 'POSITION min/max')
        check(all(abs(math.sqrt(sum(c * c for c in n)) - 1) < 1e-3 for n in accessor_values(js, binary, at['NORMAL'])), 'normals are not unit length')
        check(all(max(j) < nj for j in accessor_values(js, binary, at['JOINTS_0'])), 'joint index out of range')
        check(all(abs(sum(w) - 1) < 1e-4 for w in accessor_values(js, binary, at['WEIGHTS_0'])), 'weights do not sum to 1')
        check(all(i[0] < nv for i in accessor_values(js, binary, prim['indices'])), 'index out of range')
    for anim in js['animations']:
        for ch in anim['channels']:
            check(0 <= ch['target']['node'] < len(nodes), 'channel node out of range')
            s = anim['samplers'][ch['sampler']]
            times = [t[0] for t in accessor_values(js, binary, s['input'])]
            vals = accessor_values(js, binary, s['output'])
            check(len(times) == len(vals) and all(b > a for a, b in zip(times, times[1:])), '%s: key times not increasing' % anim['name'])
            ia = js['accessors'][s['input']]
            check(abs(ia['min'][0] - min(times)) < 1e-6 and abs(ia['max'][0] - max(times)) < 1e-6, '%s: input min/max' % anim['name'])
            if ch['target']['path'] == 'rotation':
                check(all(abs(math.sqrt(sum(c * c for c in q)) - 1) < 1e-4 for q in vals), '%s: rotation keys are not unit' % anim['name'])
    return {'nodes': len(nodes), 'joints': nj, 'vertices': nv, 'animations': len(js['animations']), 'accessors': len(js['accessors'])}


# ====================================================================================================================
# command line
# ====================================================================================================================
def require_git_ignored(path):
    """These folders hold somebody else's data (Epic's, or a ported third-party map): refuse to write into one that git would not ignore (so a
    careless `git add .` cannot pick it up). Silently fine when git is not around or the folder is not in a git checkout at all."""
    path = Path(path).absolute()
    where = path.parent
    while not where.is_dir() and where != where.parent:
        where = where.parent   # (a folder that does not exist yet, e.g. --out a/b: git runs from the nearest one that does, so only a missing git skips the check)
    try:
        res = subprocess.run(['git', 'check-ignore', '-q', str(path) + '/x'], cwd=str(where), capture_output=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return
    if res.returncode == 1:   # (0 = ignored, 128 = not a git checkout)
        raise ExtractError('%s is NOT git-ignored: not writing somebody else\'s data where git could pick it up. Add it to .gitignore, '
                           'or pass --no-git-check for a copy that is not in a git checkout.' % path)


def skin_png_name(material_name, table=SKIN_PNG):
    """The editable PNG a skin (glb material, e.g. JuggMaleABodyA) is exported as, or None for a skin that is neither body nor head
    (table = WEAPON_PNG: the shield gun's ShieldTex0)."""
    low = material_name.lower()
    for word, filename in table:
        if word in low:
            return filename
    return None


def export_skins(model, out_dir, force=False, log=print, table=SKIN_PNG):
    """Write the decoded skins as PNGs (the very bytes embedded in the glb, so the same size and UV layout) next to the glb, for the player to
    repaint. A file that is already there is the player's work: kept, whatever it holds (a warning if it is not a PNG), unless force.
    -> the list of file names written."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written, taken = [], set()
    for mat in model['materials']:
        name = skin_png_name(mat['name'], table)
        if name is None or name in taken:
            log('  skin %s has no PNG export' % mat['name'])
            continue
        taken.add(name)
        path = out_dir / name
        if not force and path.exists():
            try:
                ok = path.is_file() and path.read_bytes()[:8] == PNG_MAGIC
            except OSError:
                ok = False
            log('  %-18s kept (already there; --force replaces it)%s' % (name, '' if ok else '  WARNING: it is not a PNG file, the game will ignore it'))
            continue
        png = model['images'][mat['image']]
        write_atomic(path, png)
        written.append(name)
        log('  %-18s %7d bytes  <- skin %s (edit it in any image editor, keep the size and the layout)' % (name, len(png), mat['name']))
    return written


def extract_model(ut_dir, out_dir, tex_size=1024, log=print, force=False):
    out_dir = Path(out_dir)
    log('reading the Gorge from %s ...' % ut_dir)
    model = build_model(ut_dir, tex_size, log=log)
    data = write_glb(model)
    info = validate_glb(data)
    out_dir.mkdir(parents=True, exist_ok=True)
    write_atomic(out_dir / 'gorge.glb', data)
    export_skins(model, out_dir, force=force, log=log)
    s = model['stats']
    log('bones %d, points %d, wedges %d, triangles %d, influences %d' % (s['bones'], s['points'], s['wedges'], s['tris'], s['influences']))
    for c in model['clips']:
        last = max(ch['times'][-1] for ch in c['channels'])
        log('  clip %-16s %6.3f s %s' % (c['name'], last, 'loop' if c['loop'] else ''))
    log('gorge.glb: %d bytes, %d animations, %d vertices, validated -> %s' % (len(data), info['animations'], info['vertices'], out_dir))
    return model, data


def extract_weapon(ut_dir, out_dir, tex_size=1024, log=print, force=False):
    """The shield gun: shieldgun-1st.glb (viewmodel + sequences), shieldgun-3rd.glb (the held model) and the editable shieldgun.png (kept if it is
    already there, unless force). The two glbs carry the same texture (decoded once). -> {'1st': model, '3rd': model}."""
    out_dir = Path(out_dir)
    log('reading the shield gun from %s ...' % ut_dir)
    cache, models, datas = {}, {}, {}
    for which, filename in (('1st', WEAPON_1ST), ('3rd', WEAPON_3RD)):
        models[which] = build_weapon(ut_dir, which, tex_size, log=log, tex_cache=cache)
        datas[which] = write_glb(models[which])
        info = validate_glb(datas[which])
        s = models[which]['stats']
        log('%s: bones %d, points %d, wedges %d, triangles %d' % (filename, s['bones'], s['points'], s['wedges'], s['tris']))
        for c in models[which]['clips']:
            log('  clip %-8s %6.3f s %s' % (c['name'], max(ch['times'][-1] for ch in c['channels']), 'loop' if c['loop'] else ''))
        log('%s: %d bytes, %d animations, %d vertices, validated' % (filename, len(datas[which]), info['animations'], info['vertices']))
    out_dir.mkdir(parents=True, exist_ok=True)
    for which, filename in (('1st', WEAPON_1ST), ('3rd', WEAPON_3RD)):
        write_atomic(out_dir / filename, datas[which])
    export_skins(models['1st'], out_dir, force=force, log=log, table=WEAPON_PNG)
    log('shield gun -> %s' % out_dir)
    return models


def main(argv=None):
    ap = argparse.ArgumentParser(description='Extract Gorge (model, animations, skins), the shield gun (first / third person model, skin) and a few sounds from your own UT2004 install into the git-ignored local-models/ and local-sounds/ folders.')
    ap.add_argument('ut_dir', help='the UT2004 install folder (read only), e.g. E:\\UnrealTournament2004')
    ap.add_argument('--only', choices=('sounds', 'model', 'weapon'), help='extract only the sounds, only the Gorge model or only the shield gun')
    ap.add_argument('--tex', type=int, choices=(1024, 512), default=1024, help='skin texture size (512 = smaller file)')
    ap.add_argument('--force', action='store_true', help='overwrite sound files already in local-sounds/ and skin PNGs (gorge-body.png, gorge-head.png, shieldgun.png) already in local-models/ (kept by default: they may be yours)')
    ap.add_argument('--no-git-check', action='store_true', help='write even if the output folders are not git-ignored (a copy outside a git checkout)')
    args = ap.parse_args(argv)
    try:
        check(Path(args.ut_dir).is_dir(), '%s is not a folder' % args.ut_dir)
        if not args.no_git_check:
            for d in ([OUT_SOUNDS] if args.only in (None, 'sounds') else []) + ([OUT_MODELS] if args.only != 'sounds' else []):
                require_git_ignored(d)
        if args.only in (None, 'sounds'):
            extract_sounds(args.ut_dir, OUT_SOUNDS, force=args.force)
        if args.only in (None, 'model'):
            extract_model(args.ut_dir, OUT_MODELS, args.tex, force=args.force)
        if args.only in (None, 'weapon'):
            extract_weapon(args.ut_dir, OUT_MODELS, args.tex, force=args.force)
    except (ExtractError, struct.error, IndexError, OSError) as e:
        print('ut2004_extract: %s' % e, file=sys.stderr)
        return 1
    except (ValueError, ArithmeticError) as e:   # (NaN / Inf or an absurd number out of a corrupt file)
        print('ut2004_extract: unusable numbers in the files read (%s: %s)' % (type(e).__name__, e), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
