"""Tileable texture building blocks in numpy (no Blender needed here).

Everything is periodic over the tile, so the baked textures repeat without seams.
Arrays are [row, col] = [v, u] with row 0 at v = 0 (Blender's image row order).
Heights are in metres, colours are linear RGB.
"""
import numpy as np


def srgb_to_linear(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def hexcol(h):
    h = h.lstrip('#')
    return srgb_to_linear([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def uv(n):
    """Pixel-centre coordinates in [0, 1): (U, V) arrays, U along columns, V along rows."""
    c = (np.arange(n, dtype=np.float32) + 0.5) / n
    return np.meshgrid(c, c)


def spectral(n, kmin, kmax, beta=1.0, seed=0, ax=1.0, ay=1.0):
    """Periodic band-limited noise with power ~ k^-beta between kmin and kmax (cycles per tile).
    ax / ay stretch the spectrum: ay > 1 makes features long along u... (k_eff = hypot(kx*ax, ky*ay)).
    Returned with zero mean and unit standard deviation."""
    rng = np.random.default_rng(seed)
    F = np.fft.rfft2(rng.standard_normal((n, n)).astype(np.float32))
    ky = (np.fft.fftfreq(n) * n)[:, None]
    kx = (np.fft.rfftfreq(n) * n)[None, :]
    k = np.sqrt((kx * ax) ** 2 + (ky * ay) ** 2)
    lo = smoothstep(kmin * 0.7, kmin, k)
    hi = 1 - smoothstep(kmax, kmax * 1.4, k)
    filt = lo * hi * np.power(np.maximum(k, 1e-3), -beta / 2)
    filt[0, 0] = 0
    out = np.fft.irfft2(F * filt, s=(n, n)).astype(np.float32)
    s = out.std()
    return out / (s if s > 0 else 1)


def unit(x):
    """Map roughly normal noise to [0, 1]."""
    return np.clip(0.5 + x * 0.22, 0, 1)


def sample(img, x, y):
    """Bilinear, wrapping lookup; x / y in pixels."""
    n_y, n_x = img.shape[:2]
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = (x - x0).astype(np.float32)
    fy = (y - y0).astype(np.float32)
    if img.ndim == 3:
        fx = fx[..., None]
        fy = fy[..., None]
    x0 %= n_x
    y0 %= n_y
    x1 = (x0 + 1) % n_x
    y1 = (y0 + 1) % n_y
    return (img[y0, x0] * (1 - fx) + img[y0, x1] * fx) * (1 - fy) + (img[y1, x0] * (1 - fx) + img[y1, x1] * fx) * fy


def warp(img, dx, dy):
    """img sampled at (pixel + d), d in pixels."""
    n = img.shape[0]
    X, Y = np.meshgrid(np.arange(n, dtype=np.float32), np.arange(n, dtype=np.float32))
    return sample(img, X + dx, Y + dy)


def blur(img, r):
    """Periodic box blur (3 passes ~ gaussian), r in pixels."""
    if r < 1:
        return img
    out = img.astype(np.float32)
    for _ in range(3):
        for ax in (0, 1):
            acc = np.zeros_like(out)
            for o in range(-r, r + 1):
                acc += np.roll(out, o, axis=ax)
            out = acc / (2 * r + 1)
    return out


def voronoi(n, cells, seed, jitter=0.9, cells_y=None):
    """Periodic Voronoi on a jittered grid (cells per tile along u, cells_y along v).
    Returns dict: f1 (distance to nearest point, cell units), edge (distance to the nearest
    border, cell units), id (int cell id), cx / cy (nearest point, cell units, unwrapped)."""
    cy_n = cells_y or cells
    rng = np.random.default_rng(seed)
    px = (np.arange(cells)[None, :] + 0.5 + (rng.random((cy_n, cells)) - 0.5) * jitter).astype(np.float32)
    py = (np.arange(cy_n)[:, None] + 0.5 + (rng.random((cy_n, cells)) - 0.5) * jitter).astype(np.float32)
    U, V = uv(n)
    X, Y = U * cells, V * cy_n
    ix, iy = np.floor(X).astype(np.int64), np.floor(Y).astype(np.int64)
    f1 = np.full(X.shape, 1e9, np.float32)
    mx = np.zeros_like(X)
    my = np.zeros_like(X)
    cid = np.zeros(X.shape, np.int64)
    R = 2
    for dy in range(-R, R + 1):
        for dx in range(-R, R + 1):
            cx, cyy = ix + dx, iy + dy
            wx, wy = cx % cells, cyy % cy_n
            qx = px[wy, wx] + (cx - wx)
            qy = py[wy, wx] + (cyy - wy)
            d = np.hypot(X - qx, Y - qy)
            m = d < f1
            f1 = np.where(m, d, f1)
            mx = np.where(m, qx, mx)
            my = np.where(m, qy, my)
            cid = np.where(m, wy * cells + wx, cid)
    edge = np.full(X.shape, 1e9, np.float32)
    for dy in range(-R, R + 1):
        for dx in range(-R, R + 1):
            cx, cyy = ix + dx, iy + dy
            wx, wy = cx % cells, cyy % cy_n
            qx = px[wy, wx] + (cx - wx)
            qy = py[wy, wx] + (cyy - wy)
            ex, ey = qx - mx, qy - my
            l2 = ex * ex + ey * ey
            ok = l2 > 1e-8
            l = np.sqrt(np.where(ok, l2, 1))
            d = ((qx + mx) * 0.5 - X) * ex / l + ((qy + my) * 0.5 - Y) * ey / l
            edge = np.where(ok, np.minimum(edge, d), edge)
    return {'f1': f1, 'edge': edge, 'id': cid, 'cx': mx, 'cy': my, 'cells': (cells, cy_n)}


def cell_rand(vor, seed, k=1):
    """Per-cell random values in [0, 1), shape like the image (+ k channels if k > 1)."""
    cells = vor['cells'][0] * vor['cells'][1]
    r = np.random.default_rng(seed).random((cells, k)).astype(np.float32)
    out = r[vor['id']]
    return out[..., 0] if k == 1 else out


def ridged(x):
    return 1 - np.abs(x)


def dart_throw(T, count, rmin, rmax, seed, power=2.2, overlap=0.25, max_tries=None):
    """Random discs on a periodic square of side T; radius skewed towards rmin.
    Returns arrays x, y, r (metres). Discs may overlap by `overlap` of the smaller radius."""
    rng = np.random.default_rng(seed)
    cell = rmax * 2
    G = max(1, int(T / cell))
    cell = T / G
    grid = [[[] for _ in range(G)] for _ in range(G)]
    xs, ys, rs = [], [], []
    tries = 0
    max_tries = max_tries or count * 30
    while len(xs) < count and tries < max_tries:
        tries += 1
        r = rmin + (rmax - rmin) * rng.random() ** power
        x, y = rng.random() * T, rng.random() * T
        gx, gy = int(x / cell) % G, int(y / cell) % G
        ok = True
        for oy in (-1, 0, 1):
            for ox in (-1, 0, 1):
                for j in grid[(gy + oy) % G][(gx + ox) % G]:
                    dx = (xs[j] - x + T / 2) % T - T / 2
                    dy = (ys[j] - y + T / 2) % T - T / 2
                    if dx * dx + dy * dy < ((r + rs[j]) - overlap * min(r, rs[j])) ** 2:
                        ok = False
                        break
                if not ok:
                    break
            if not ok:
                break
        if ok:
            grid[gy][gx].append(len(xs))
            xs.append(x)
            ys.append(y)
            rs.append(r)
    return np.array(xs, np.float32), np.array(ys, np.float32), np.array(rs, np.float32)


def stamp_bumps(H, T, xs, ys, rs, heights, embed=0.35, shape=2.0, aspect=None, angle=None):
    """Press rounded stones (periodic) into the height map H (tile side T metres), in place.
    Each stone sits `embed` of its height below the surface at its centre.
    Returns (mask, ids): mask = how much each pixel is stone (0..1), ids = stone index or -1."""
    n = H.shape[0]
    px = T / n
    mask = np.zeros_like(H)
    ids = np.full(H.shape, -1, np.int64)
    for k, (x, y, r, h) in enumerate(zip(xs, ys, rs, heights)):
        a = 1.0 if aspect is None else aspect[k]
        ang = 0.0 if angle is None else angle[k]
        rp = int(np.ceil(r * max(a, 1 / a) / px)) + 2
        cx, cy = x / px - 0.5, y / px - 0.5
        ix = np.arange(int(cx) - rp, int(cx) + rp + 2)
        iy = np.arange(int(cy) - rp, int(cy) + rp + 2)
        dx = (ix[None, :] - cx) * px
        dy = (iy[:, None] - cy) * px
        ca, sa = np.cos(ang), np.sin(ang)
        ex = (dx * ca + dy * sa) / (r * a)
        ey = (-dx * sa + dy * ca) / (r / a)
        d2 = ex * ex + ey * ey
        prof = np.power(np.clip(1 - d2, 0, 1), 1 / shape)
        sl = np.ix_(iy % n, ix % n)
        base = H[int(cy) % n, int(cx) % n]
        top = np.where(d2 < 1, base - embed * h + prof * h, -1e9)
        cur = H[sl]
        win = top > cur
        H[sl] = np.where(win, top, cur)
        mask[sl] = np.where(win, np.clip((1 - d2) * 6, 0, 1), mask[sl])
        ids[sl] = np.where(win, k, ids[sl])
    return mask, ids
