"""Simulate (Mantaflow) and render the particle flipbooks the game uses for smoke, dust and fire.

  blender -b --factory-startup --python build_flipbooks.py -- [--only smoke|fire] [--res 0] [--samples 64]

Output (homokfutam/assets/fx/):
  smoke.webp  8x8 cells of 192 px: two puff simulations, 32 frames each (rows 0-3 and 4-7)
  fire.webp   8x8 cells of 192 px: one fireball, 64 frames
Channels ("6-way" lightmaps cut down to the directions that matter for a low sun):
  smoke  R = lit from the right, G = lit from the left, B = lit from above, A = coverage
  fire   R = lit from the right, G = lit from the left, B = flame emission, A = coverage
R/G/B are stored as sqrt() for 8-bit precision; the shader squares them. Lighting is
un-premultiplied (radiance per unit of coverage), emission is premultiplied (it adds light).
Every frame is cropped around the puff and scaled to fill its cell, so the game controls the
growth with the particle size; the flipbook carries only the change of shape.

The simulation caches, raw EXR frames and preview sheets go to models/fx/build/ (not committed).
"""
import math
import os
import shutil
import sys
import time

import subprocess

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.normpath(os.path.join(HERE, '..', '..', 'assets', 'fx'))
BUILD = os.path.join(HERE, 'build')
CELL = 256          # px per flipbook cell
RENDER = 512        # px per raw frame (cropped down to CELL)
GRID = 8


def args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    opt = {'only': '', 'res': 0, 'samples': 64}
    for i in range(0, len(argv) - 1, 2):
        k = argv[i].lstrip('-')
        opt[k] = argv[i + 1] if k == 'only' else int(argv[i + 1])
    return opt


# ============================================================
#  scene
# ============================================================
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn = bpy.context.scene
    try:
        scn.render.engine = 'CYCLES'
    except TypeError as e:
        print('Cycles unavailable:', e)
        raise
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'OPTIX'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == 'OPTIX'
        scn.cycles.device = 'GPU'
    except Exception as e:  # noqa: BLE001
        print('GPU unavailable, rendering on CPU:', e)
    scn.render.film_transparent = True
    scn.render.resolution_x = scn.render.resolution_y = RENDER
    scn.render.resolution_percentage = 100
    scn.render.image_settings.file_format = 'OPEN_EXR'
    scn.render.image_settings.color_depth = '16'
    scn.render.image_settings.color_mode = 'RGBA'
    # denoised: cleaner shading and far smaller WebP files (render noise compresses badly)
    scn.cycles.use_denoising = True
    try:
        scn.cycles.denoiser = 'OPENIMAGEDENOISE'
    except TypeError:
        pass
    scn.cycles.volume_step_rate = 0.5
    scn.cycles.volume_max_steps = 512
    scn.cycles.max_bounces = 8
    scn.cycles.volume_bounces = 2
    scn.cycles.transparent_max_bounces = 8
    scn.world = bpy.data.worlds.new('Black')
    scn.world.color = (0, 0, 0)
    if scn.world.node_tree:
        bg = next((n for n in scn.world.node_tree.nodes if n.type == 'BACKGROUND'), None)
        if bg:
            bg.inputs['Strength'].default_value = 0.0
    return scn


def add_lights():
    """Red from the right (+x), green from the left (-x), blue from above. Volume scattering is
    linear in the light colour, so one render holds three lighting directions."""
    lights = []
    for name, col, rot in (('Right', (1, 0, 0), (0, math.radians(90), 0)),
                           ('Left', (0, 1, 0), (0, math.radians(-90), 0)),
                           ('Top', (0, 0, 1), (0, 0, 0))):
        ld = bpy.data.lights.new(name, 'SUN')
        ld.color = col
        ld.energy = 3.0
        ld.angle = math.radians(2)
        ob = bpy.data.objects.new(name, ld)
        ob.rotation_euler = rot
        bpy.context.collection.objects.link(ob)
        lights.append(ob)
    return lights


def add_camera(size, zc):
    cd = bpy.data.cameras.new('Cam')
    cd.type = 'ORTHO'
    cd.ortho_scale = size
    cd.clip_start, cd.clip_end = 0.1, 100
    cam = bpy.data.objects.new('Cam', cd)
    cam.location = (0, -20, zc)
    cam.rotation_euler = (math.radians(90), 0, 0)   # looks along +y: right = +x, up = +z
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


def cube(name, size, loc):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return ob


def sphere(name, r, loc, subdiv=3):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=r, location=loc)
    ob = bpy.context.active_object
    ob.name = name
    return ob


def domain_material(dom, kind, k_density, k_flame=0.0):
    """kind 'lit': white-ish scattering smoke. kind 'emit': black absorbing smoke + flame emission."""
    mat = bpy.data.materials.new(f'{dom.name}_{kind}')
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    att = nt.nodes.new('ShaderNodeAttribute')
    att.attribute_name = 'density'
    mul = nt.nodes.new('ShaderNodeMath')
    mul.operation = 'MULTIPLY'
    mul.inputs[1].default_value = k_density
    nt.links.new(att.outputs['Fac'], mul.inputs[0])
    if kind == 'lit':
        sc = nt.nodes.new('ShaderNodeVolumeScatter')
        sc.inputs['Color'].default_value = (0.85, 0.85, 0.85, 1)
        sc.inputs['Anisotropy'].default_value = 0.25
        nt.links.new(mul.outputs[0], sc.inputs['Density'])
        ab = nt.nodes.new('ShaderNodeVolumeAbsorption')
        ab.inputs['Color'].default_value = (0, 0, 0, 1)
        m2 = nt.nodes.new('ShaderNodeMath')
        m2.operation = 'MULTIPLY'
        m2.inputs[1].default_value = 0.15
        nt.links.new(mul.outputs[0], m2.inputs[0])
        nt.links.new(m2.outputs[0], ab.inputs['Density'])
        add = nt.nodes.new('ShaderNodeAddShader')
        nt.links.new(sc.outputs[0], add.inputs[0])
        nt.links.new(ab.outputs[0], add.inputs[1])
        nt.links.new(add.outputs[0], out.inputs['Volume'])
    else:
        ab = nt.nodes.new('ShaderNodeVolumeAbsorption')
        ab.inputs['Color'].default_value = (0, 0, 0, 1)
        nt.links.new(mul.outputs[0], ab.inputs['Density'])
        # flame^2.5 * temperature: hot cores and bright fingers instead of an evenly lit ball
        fl = nt.nodes.new('ShaderNodeAttribute')
        fl.attribute_name = 'flame'
        pw = nt.nodes.new('ShaderNodeMath')
        pw.operation = 'POWER'
        pw.inputs[1].default_value = 2.5
        nt.links.new(fl.outputs['Fac'], pw.inputs[0])
        tp = nt.nodes.new('ShaderNodeAttribute')
        tp.attribute_name = 'temperature'
        tm = nt.nodes.new('ShaderNodeMath')
        tm.operation = 'MULTIPLY'
        nt.links.new(pw.outputs[0], tm.inputs[0])
        nt.links.new(tp.outputs['Fac'], tm.inputs[1])
        fm = nt.nodes.new('ShaderNodeMath')
        fm.operation = 'MULTIPLY'
        fm.inputs[1].default_value = k_flame
        nt.links.new(tm.outputs[0], fm.inputs[0])
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Color'].default_value = (1, 1, 1, 1)
        nt.links.new(fm.outputs[0], em.inputs['Strength'])
        add = nt.nodes.new('ShaderNodeAddShader')
        nt.links.new(ab.outputs[0], add.inputs[0])
        nt.links.new(em.outputs[0], add.inputs[1])
        nt.links.new(add.outputs[0], out.inputs['Volume'])
    return mat


# ============================================================
#  simulations
# ============================================================
def make_domain(name, size, loc, res, cache):
    dom = cube(name, (size, size, size), loc)
    mod = dom.modifiers.new('Fluid', 'FLUID')
    mod.fluid_type = 'DOMAIN'
    ds = mod.domain_settings
    ds.domain_type = 'GAS'
    ds.resolution_max = res
    ds.use_noise = True
    ds.noise_scale = 2
    ds.noise_strength = 1.2
    ds.cache_type = 'ALL'
    ds.cache_directory = cache
    ds.cache_frame_start = 1
    ds.cache_frame_end = 64
    for side in ('front', 'back', 'left', 'right', 'top', 'bottom'):
        setattr(ds, f'use_collision_border_{side}', False)
    return dom, ds


def make_flow(ob, flow_type, frames_on, vel, rnd, density=1.0, fuel=1.0, temp=1.0, seed=0.0):
    mod = ob.modifiers.new('Fluid', 'FLUID')
    mod.fluid_type = 'FLOW'
    fs = mod.flow_settings
    fs.flow_type = flow_type
    fs.flow_behavior = 'INFLOW'
    fs.flow_source = 'MESH'
    fs.surface_distance = 0.6
    fs.volume_density = 1.0
    fs.subframes = 2
    fs.density = density
    fs.temperature = temp
    if flow_type in ('FIRE', 'BOTH'):
        fs.fuel_amount = fuel
    fs.use_initial_velocity = True
    fs.velocity_normal = vel
    fs.velocity_random = rnd
    # clumpy emission: a cloud texture modulates the density
    tex = bpy.data.textures.new(f'{ob.name}_clouds', 'CLOUDS')
    tex.noise_scale = 0.35
    tex.noise_depth = 2
    fs.use_texture = True
    fs.noise_texture = tex
    fs.texture_map_type = 'AUTO'
    fs.texture_size = 1.0
    fs.texture_offset = seed
    # emit only for the first few frames: a burst, not a stream
    fs.use_inflow = True
    fs.keyframe_insert('use_inflow', frame=1)
    fs.keyframe_insert('use_inflow', frame=frames_on)
    fs.use_inflow = False
    fs.keyframe_insert('use_inflow', frame=frames_on + 1)
    return fs


def bake(dom):
    scn = bpy.context.scene
    bpy.ops.object.select_all(action='DESELECT')
    dom.select_set(True)
    bpy.context.view_layer.objects.active = dom
    t = time.time()
    with bpy.context.temp_override(scene=scn, object=dom, active_object=dom):
        bpy.ops.fluid.bake_all()
    print(f'  baked {dom.name} in {time.time() - t:.0f}s')


def sim_smoke(variant, res, cache):
    """A burst of dust/smoke that rolls outward and slowly rises."""
    size = 5.0
    dom, ds = make_domain(f'Smoke{variant}', size, (0, 0, 0.6), res or 72, cache)
    ds.vorticity = 0.35 if variant == 0 else 0.5
    ds.alpha = 0.0
    ds.beta = 0.35
    ds.use_dissolve_smoke = True
    ds.use_dissolve_smoke_log = True
    ds.dissolve_speed = 45
    ds.time_scale = 0.8
    em = sphere(f'SmokeEmit{variant}', 0.32 if variant == 0 else 0.26, (0, 0, -0.9), 3)
    if variant == 1:
        em.scale = (1.3, 1.0, 0.8)
        em2 = sphere('SmokeEmit1b', 0.2, (0.35, 0.1, -0.75), 2)
        make_flow(em2, 'SMOKE', 3, 3.2, 0.8, seed=3.7)
    make_flow(em, 'SMOKE', 3, 3.6 if variant == 0 else 3.0, 0.6 if variant == 0 else 0.9, seed=variant * 1.9)
    for ob in list(bpy.data.objects):
        if ob.name.startswith('SmokeEmit'):
            ob.hide_render = True
    return dom, size


def sim_fire(res, cache):
    """A fuel burst that ignites into a fireball and rolls up into dark smoke."""
    size = 7.0
    dom, ds = make_domain('Fire', size, (0, 0, 1.6), res or 96, cache)
    ds.vorticity = 0.55
    ds.alpha = 0.0
    ds.beta = 1.4
    ds.burning_rate = 0.42
    ds.flame_smoke = 2.6
    ds.flame_vorticity = 1.3
    ds.flame_max_temp = 3.0
    ds.flame_ignition = 1.2
    ds.noise_strength = 2.0
    ds.use_dissolve_smoke = True
    ds.use_dissolve_smoke_log = True
    ds.dissolve_speed = 55
    ds.time_scale = 0.75
    # a lumpy fireball: a core burst and three lobes thrown out a moment later
    em = sphere('FireEmit', 0.36, (0, 0, -1.0), 3)
    make_flow(em, 'BOTH', 4, 5.0, 1.2, density=0.6, fuel=2.2, temp=2.0, seed=0.7)
    for k, (x, y, z, r) in enumerate(((0.45, 0.1, -0.75, 0.22), (-0.4, -0.2, -0.8, 0.25), (0.05, 0.3, -0.55, 0.2))):
        lobe = sphere(f'FireEmit{k}', r, (x, y, z), 2)
        make_flow(lobe, 'BOTH', 6 + k, 7.0, 1.4, density=0.8, fuel=1.8, temp=2.0, seed=1.3 + k)
    for ob in list(bpy.data.objects):
        if ob.name.startswith('FireEmit'):
            ob.hide_render = True
    return dom, size


# ============================================================
#  render + pack
# ============================================================
def render_frames(prefix, frames, samples):
    scn = bpy.context.scene
    scn.cycles.samples = samples
    paths = []
    for f in frames:
        scn.frame_set(f)
        path = f'{prefix}_{f:03d}.exr'
        scn.render.filepath = path
        bpy.ops.render.render(write_still=True)
        paths.append(path)
    return paths


def load_exr(path):
    img = bpy.data.images.load(path, check_existing=False)
    a = np.empty(img.size[0] * img.size[1] * 4, np.float32)
    img.pixels.foreach_get(a)
    w, h = img.size
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)


def bilinear(img, x0, y0, side, out):
    """Sample a square crop (x0, y0, side in px, may leave the image) into out x out."""
    h, w = img.shape[:2]
    t = (np.arange(out) + 0.5) / out * side
    xs = x0 + t - 0.5
    ys = y0 + t - 0.5
    xi = np.floor(xs).astype(int)
    yi = np.floor(ys).astype(int)
    fx = (xs - xi)[None, :, None]
    fy = (ys - yi)[:, None, None]

    def g(yy, xx):
        ok = ((yy >= 0) & (yy < h))[:, None] & ((xx >= 0) & (xx < w))[None, :]
        v = img[np.clip(yy, 0, h - 1)][:, np.clip(xx, 0, w - 1)]
        return v * ok[..., None]
    return (g(yi, xi) * (1 - fx) * (1 - fy) + g(yi, xi + 1) * fx * (1 - fy)
            + g(yi + 1, xi) * (1 - fx) * fy + g(yi + 1, xi + 1) * fx * fy)


def box_blur(img, r):
    if r < 1:
        return img
    k = 2 * r + 1
    p = np.pad(img, ((r, r), (r, r), (0, 0)), mode='constant')
    c = np.cumsum(np.cumsum(p, 0), 1)
    c = np.pad(c, ((1, 0), (1, 0), (0, 0)))
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def crops(alphas):
    """Per frame: a square around the puff (alpha-weighted centre, ~98th percentile radius),
    smoothed over time so the cells do not jitter."""
    n = len(alphas)
    h, w = alphas[0].shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32) + 0.5
    cx, cy, rad = np.zeros(n), np.zeros(n), np.zeros(n)
    for i, a in enumerate(alphas):
        m = np.where(a > 0.01, a, 0)
        s = m.sum()
        if s < 1:
            cx[i], cy[i], rad[i] = w / 2, h / 2, 32
            continue
        cx[i] = (m * xx).sum() / s
        cy[i] = (m * yy).sum() / s
        d = np.hypot(xx - cx[i], yy - cy[i])[a > 0.06]
        rad[i] = np.percentile(d, 97) if len(d) else 32
    k = np.array([1, 2, 3, 2, 1], np.float64)
    k /= k.sum()
    sm = lambda v: np.convolve(np.pad(v, 2, mode='edge'), k, mode='valid')  # noqa: E731
    rad = np.maximum.accumulate(sm(rad))   # never shrink: the puff only thins out
    return sm(cx), sm(cy), np.maximum(rad * 1.04, 24)


def pack(lit_paths, emit_paths, name):
    """Build the cells for one simulation. Returns a list of CELL x CELL x 4 float arrays."""
    lit = [load_exr(p) for p in lit_paths]
    emit = [load_exr(p) for p in emit_paths] if emit_paths else None
    alphas = [f[..., 3] for f in lit]
    cx, cy, rad = crops(alphas)
    # fade out towards the cell border so no puff ever shows a square edge
    t = (np.arange(CELL) + 0.5) / CELL * 2 - 1
    edge = np.clip((1.0 - np.hypot(t[None, :], t[:, None])) / 0.18, 0, 1)
    cells = []
    for i, f in enumerate(lit):
        side = 2 * rad[i]
        blur = max(0, int(side / CELL / 2))      # prefilter when shrinking more than 2x
        src = box_blur(f, blur)
        c = bilinear(src, cx[i] - rad[i], cy[i] - rad[i], side, CELL)
        a = np.clip(c[..., 3], 0, 1) * edge
        rgb = c[..., :3] / np.maximum(a, 1e-3)[..., None]            # un-premultiply lighting
        rgb *= (a > 0.004)[..., None]
        cell = np.zeros((CELL, CELL, 4), np.float32)
        cell[..., 0], cell[..., 1], cell[..., 3] = rgb[..., 0], rgb[..., 1], a
        if emit is None:
            cell[..., 2] = rgb[..., 2]
        else:
            e = bilinear(box_blur(emit[i], blur), cx[i] - rad[i], cy[i] - rad[i], side, CELL)
            cell[..., 2] = e[..., :3].mean(-1) * edge                  # emission stays premultiplied
        cells.append(cell)
    print(f'  {name}: {len(cells)} cells, radius {rad.min():.0f}..{rad.max():.0f} px')
    return cells


def normalise(cells, emit):
    """Scale lighting (and emission) so the bright end sits near 1, then store sqrt()."""
    st = np.stack(cells)
    covered = st[..., 3] > 0.25
    lk = np.percentile(st[..., 0:2][covered], 99.5)
    st[..., 0:2] /= max(lk, 1e-4)
    if emit:
        ek = np.percentile(st[..., 2][st[..., 2] > 1e-3], 99.9) if (st[..., 2] > 1e-3).any() else 1
        st[..., 2] /= max(ek, 1e-4)
    else:
        st[..., 2] /= max(lk, 1e-4)
    st[..., :3] = np.sqrt(np.clip(st[..., :3], 0, 1))
    # keep a sliver of alpha under visible flame so the encoder does not drop its colour
    st[..., 3] = np.where(st[..., 2] > 0.02, np.maximum(st[..., 3], 3 / 255), st[..., 3])
    print(f'  lighting scale {lk:.3f}')
    return list(st)


def atlas(cells):
    out = np.zeros((GRID * CELL, GRID * CELL, 4), np.float32)
    for i, c in enumerate(cells[:GRID * GRID]):
        r, k = divmod(i, GRID)
        # rows from the top of the image: bpy pixel rows start at the bottom, so flip
        y0 = (GRID - 1 - r) * CELL
        out[y0:y0 + CELL, k * CELL:(k + 1) * CELL] = c
    return out


def save_image(px, path, fmt, quality=90):
    h, w = px.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    img.alpha_mode = 'STRAIGHT'
    img.pixels.foreach_set(np.clip(px, 0, 1).ravel())
    img.filepath_raw = path
    img.file_format = fmt
    try:
        img.save(filepath=path, quality=quality)
    except TypeError:
        img.save()
    bpy.data.images.remove(img)
    print(f'  wrote {path} ({os.path.getsize(path) / 1024:.0f} KB)')


def save_webp(px, name, quality, width=GRID * CELL):
    """PNG into build/, then WebP into assets/fx/ through sharp (npx, needs Node). Blender's own
    WebP writer is the fallback; it ignores the quality setting and writes much larger files."""
    png = os.path.join(BUILD, name + '.png')
    out = os.path.join(ASSETS, name + '.webp')
    save_image(px, png, 'PNG')
    npx = shutil.which('npx')
    if npx:
        cmd = [npx, '-y', 'sharp-cli@5', '-i', png, '-o', out, '-f', 'webp', '-q', str(quality), '--smartSubsample']
        if width != GRID * CELL:
            cmd += ['resize', str(width)]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode == 0 and os.path.exists(out):
            print(f'  wrote {out} ({os.path.getsize(out) / 1024:.0f} KB)')
            return
        print('sharp failed, using Blender WebP:', r.stderr[-400:])
    save_image(px, out, 'WEBP', quality)


def preview(px, path, fire):
    """What the game will roughly draw: low sun from the right, warm tint, over grey."""
    rgb = px[..., :3] ** 2
    light = rgb[..., 0] * 1.0 + rgb[..., 1] * 0.25 + (0.5 * (rgb[..., 0] + rgb[..., 1]) if fire else rgb[..., 2]) * 0.55
    smoke = np.stack([light * 0.95 + 0.18, light * 0.82 + 0.16, light * 0.68 + 0.15], -1)
    if fire:
        smoke *= 0.35
    a = px[..., 3:4]
    col = smoke * a + np.full_like(smoke, 0.32) * (1 - a)
    if fire:
        e = rgb[..., 2:3]
        col += e * np.array([4.0, 1.6, 0.45]) * 1.4
    out = np.concatenate([np.clip(col / (1 + col), 0, 1) ** (1 / 2.2), np.ones_like(a)], -1)
    save_image(out, path, 'PNG')


# ============================================================
def build_smoke(opt):
    cells = []
    for v in (0, 1):
        scn = reset()
        cache = os.path.join(BUILD, f'cache_smoke{v}')
        shutil.rmtree(cache, ignore_errors=True)
        dom, size = sim_smoke(v, opt['res'], cache)
        bake(dom)
        add_lights()
        add_camera(size, dom.location.z)
        dom.data.materials.append(domain_material(dom, 'lit', 14.0))
        frames = list(range(3, 67, 2))[:32]
        scn.frame_end = 64
        paths = render_frames(os.path.join(BUILD, 'frames', f'smoke{v}_lit'), [min(f, 64) for f in frames], opt['samples'])
        cells += pack(paths, None, f'smoke{v}')
    st = normalise(cells, False)
    px = atlas(st)
    save_webp(px, 'smoke', 85, 1536)
    preview(px, os.path.join(BUILD, 'smoke_preview.png'), False)


def build_fire(opt):
    scn = reset()
    cache = os.path.join(BUILD, 'cache_fire')
    shutil.rmtree(cache, ignore_errors=True)
    dom, size = sim_fire(opt['res'], cache)
    bake(dom)
    lights = add_lights()
    add_camera(size, dom.location.z)
    lit_mat = domain_material(dom, 'lit', 12.0)
    emit_mat = domain_material(dom, 'emit', 18.0, 6.0)
    dom.data.materials.append(lit_mat)
    frames = list(range(3, 67))
    frames = [min(f, 64) for f in frames]
    lit = render_frames(os.path.join(BUILD, 'frames', 'fire_lit'), frames, opt['samples'])
    dom.data.materials[0] = emit_mat
    for l in lights:
        l.hide_render = True
    emit = render_frames(os.path.join(BUILD, 'frames', 'fire_emit'), frames, max(16, opt['samples'] // 2))
    st = normalise(pack(lit, emit, 'fire'), True)
    px = atlas(st)
    save_webp(px, 'fire', 88, 1536)
    preview(px, os.path.join(BUILD, 'fire_preview.png'), True)


def main():
    opt = args()
    os.makedirs(os.path.join(BUILD, 'frames'), exist_ok=True)
    os.makedirs(ASSETS, exist_ok=True)
    t0 = time.time()
    if opt['only'] in ('', 'smoke'):
        build_smoke(opt)
    if opt['only'] in ('', 'fire'):
        build_fire(opt)
    print(f'done in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
