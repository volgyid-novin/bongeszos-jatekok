// ============================================================
//  Physically based sky (Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere
//  Rendering Technique"), baked on the CPU at load: the sun never moves, so the lookup tables are
//  computed once and both renderers read the same textures.
//   transmittance   256 x 64   sun light left after the air between a point and the sun
//   multi-scatter    32 x 32   the isotropic light of all higher scattering orders (psi_ms)
//   sky view        192 x 112  sky radiance by azimuth from the sun and elevation, at ground level
//  Air: Rayleigh, a thin aerosol layer that takes more blue than red (its forward glow round the sun is
//  kept modest: at a fixed exposure a strong one blooms over everything near the sun) and ozone, over a
//  planet of sand. The low, dense dust that the game calls
//  its height fog (ATMO hfFogDensity / hfFogFalloff, ~180 m scale height) is not in the tables: it is
//  integrated analytically per pixel (gfx/atmosphere.js) and laid over them, with its in-scattering
//  lit by the same sun transmittance and multiple scattering.
// ============================================================
const PI = Math.PI;
const RG = 6360, RT = 6460;                       // km: ground and top of the atmosphere

export const AIR = {
  rayleigh: [5.802e-3, 13.558e-3, 33.1e-3],       // per km at sea level
  rayleighH: 8,                                   // km
  mieS: 3.996e-3, mieA: 4.4e-3, mieH: 1.2, mieG: 0.65,
  dust: 0.8,                                      // aerosol amount relative to Hillaire's clear sky
  dustAbs: [0.8, 1.0, 1.55],                      // aerosol absorption by channel (iron oxides take the blue)
  ozone: [1.3e-3, 3.76e-3, 0.17e-3],             // twice the standard column: a deeper blue overhead
  ground: [0.42, 0.31, 0.2],                      // sand albedo, for the light bounced back up
};

function medium(hKm, out) {
  const r = Math.exp(-hKm / AIR.rayleighH), m = Math.exp(-hKm / AIR.mieH) * AIR.dust;
  const o = Math.max(0, 1 - Math.abs(hKm - 25) / 15);
  out.rs0 = AIR.rayleigh[0] * r; out.rs1 = AIR.rayleigh[1] * r; out.rs2 = AIR.rayleigh[2] * r;
  out.ms = AIR.mieS * m;
  out.e0 = out.rs0 + out.ms + AIR.mieA * m * AIR.dustAbs[0] + AIR.ozone[0] * o;
  out.e1 = out.rs1 + out.ms + AIR.mieA * m * AIR.dustAbs[1] + AIR.ozone[1] * o;
  out.e2 = out.rs2 + out.ms + AIR.mieA * m * AIR.dustAbs[2] + AIR.ozone[2] * o;
}

export const miePhase = (c, g = AIR.mieG) => {
  const g2 = g * g;
  return (3 / (8 * PI)) * ((1 - g2) * (1 + c * c)) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * c, 1.5));
};
export const rayleighPhase = (c) => (3 / (16 * PI)) * (1 + c * c);

// distance along (ro + t rd) to the sphere of radius rad, -1 if none (from inside: the far hit)
function hitSphere(px, py, pz, dx, dy, dz, rad) {
  const b = px * dx + py * dy + pz * dz, c = px * px + py * py + pz * pz - rad * rad;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  if (disc > b * b) return -b + Math.sqrt(disc);
  return -b - Math.sqrt(disc);
}

// bilinear fetch from an RGBA float table, uv in 0..1 (clamped)
function fetch(tab, W, H, u, v, out) {
  const x = Math.min(Math.max(u * W - 0.5, 0), W - 1), y = Math.min(Math.max(v * H - 0.5, 0), H - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1);
  const fx = x - x0, fy = y - y0;
  const a = (y0 * W + x0) * 4, b = (y0 * W + x1) * 4, c = (y1 * W + x0) * 4, d = (y1 * W + x1) * 4;
  for (let k = 0; k < 3; k++) out[k] = (tab[a + k] * (1 - fx) + tab[b + k] * fx) * (1 - fy) + (tab[c + k] * (1 - fx) + tab[d + k] * fx) * fy;
  return out;
}

const TW = 256, TH = 64, MW = 32, MH = 32;
export const SKY_W = 192, SKY_H = 112;

// table uv from the cosine of the sun's zenith angle and the height in km
const tU = (mu) => Math.min(Math.max(0.5 + 0.5 * mu, 0), 1), tV = (h) => Math.min(Math.max(h / (RT - RG), 0), 1);

export function bakeSky(sunDir) {
  const t0 = performance.now();
  const M = {};
  // --- transmittance -----------------------------------------------------
  const trans = new Float32Array(TW * TH * 4);
  for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) {
    const mu = ((i + 0.5) / TW) * 2 - 1, h = ((j + 0.5) / TH) * (RT - RG);
    const px = 0, py = RG + h, pz = 0, dx = Math.sqrt(Math.max(0, 1 - mu * mu)), dy = mu, dz = 0;
    let t0r = 1, t1r = 1, t2r = 1;
    if (hitSphere(px, py, pz, dx, dy, dz, RG) <= 0) {
      const D = hitSphere(px, py, pz, dx, dy, dz, RT), N = 40;
      let t = 0, o0 = 0, o1 = 0, o2 = 0;
      for (let s = 0; s < N; s++) {
        const nt = ((s + 0.3) / N) * D, dt = nt - t; t = nt;
        const x = px + dx * t, y = py + dy * t;
        medium(Math.sqrt(x * x + y * y) - RG, M);
        o0 += M.e0 * dt; o1 += M.e1 * dt; o2 += M.e2 * dt;
      }
      t0r = Math.exp(-o0); t1r = Math.exp(-o1); t2r = Math.exp(-o2);
    } else { t0r = t1r = t2r = 0; }
    const k = (j * TW + i) * 4;
    trans[k] = t0r; trans[k + 1] = t1r; trans[k + 2] = t2r; trans[k + 3] = 1;
  }
  const sunT = (x, y, z, out) => {
    const h = Math.sqrt(x * x + y * y + z * z), mu = (x * sunDir.x + y * sunDir.y + z * sunDir.z) / h;
    return fetch(trans, TW, TH, tU(mu), tV(h - RG), out);
  };

  // --- multiple scattering (psi_ms) ----------------------------------------
  const ms = new Float32Array(MW * MH * 4), ST = [0, 0, 0];
  const SQ = 8, NS = 20;
  for (let j = 0; j < MH; j++) for (let i = 0; i < MW; i++) {
    const mu = ((i + 0.5) / MW) * 2 - 1, h = Math.max(((j + 0.5) / MH) * (RT - RG), 0.01);
    const sx = 0, sy = mu, sz = -Math.sqrt(Math.max(0, 1 - mu * mu));
    const px = 0, py = RG + h, pz = 0;
    let L0 = 0, L1 = 0, L2 = 0, F0 = 0, F1 = 0, F2 = 0;
    for (let a = 0; a < SQ; a++) for (let b = 0; b < SQ; b++) {
      const th = PI * (a + 0.5) / SQ, ph = Math.acos(Math.min(1, Math.max(-1, 1 - 2 * (b + 0.5) / SQ)));
      const dx = Math.sin(ph) * Math.sin(th), dy = Math.cos(ph), dz = Math.sin(ph) * Math.cos(th);
      const atmo = hitSphere(px, py, pz, dx, dy, dz, RT), gnd = hitSphere(px, py, pz, dx, dy, dz, RG);
      const tMax = gnd > 0 ? gnd : atmo;
      const c = dx * sx + dy * sy + dz * sz;
      const pm = miePhase(c), pr = rayleighPhase(-c);
      let T0 = 1, T1 = 1, T2 = 1, l0 = 0, l1 = 0, l2 = 0, f0 = 0, f1 = 0, f2 = 0, t = 0;
      for (let s = 0; s < NS; s++) {
        const nt = ((s + 0.3) / NS) * tMax, dt = nt - t; t = nt;
        const x = px + dx * t, y = py + dy * t, z = pz + dz * t;
        medium(Math.sqrt(x * x + y * y + z * z) - RG, M);
        const s0 = Math.exp(-dt * M.e0), s1 = Math.exp(-dt * M.e1), s2 = Math.exp(-dt * M.e2);
        f0 += T0 * (M.rs0 + M.ms) * (1 - s0) / M.e0; f1 += T1 * (M.rs1 + M.ms) * (1 - s1) / M.e1; f2 += T2 * (M.rs2 + M.ms) * (1 - s2) / M.e2;
        // sun light at the sample (direction relative to this frame's sun)
        const hh = Math.sqrt(x * x + y * y + z * z), muS = (x * sx + y * sy + z * sz) / hh;
        fetch(trans, TW, TH, tU(muS), tV(hh - RG), ST);
        l0 += T0 * (M.rs0 * pr + M.ms * pm) * ST[0] * (1 - s0) / M.e0;
        l1 += T1 * (M.rs1 * pr + M.ms * pm) * ST[1] * (1 - s1) / M.e1;
        l2 += T2 * (M.rs2 * pr + M.ms * pm) * ST[2] * (1 - s2) / M.e2;
        T0 *= s0; T1 *= s1; T2 *= s2;
      }
      if (gnd > 0) {
        const x = px + dx * gnd, y = py + dy * gnd, z = pz + dz * gnd, hh = Math.sqrt(x * x + y * y + z * z);
        const muS = (x * sx + y * sy + z * sz) / hh;
        fetch(trans, TW, TH, tU(muS), 0, ST);
        const lam = Math.max(muS, 0) / PI;           // Lambertian sand lit by the sun
        l0 += T0 * AIR.ground[0] * ST[0] * lam; l1 += T1 * AIR.ground[1] * ST[1] * lam; l2 += T2 * AIR.ground[2] * ST[2] * lam;
      }
      const w = 1 / (SQ * SQ);
      L0 += l0 * w; L1 += l1 * w; L2 += l2 * w; F0 += f0 * w; F1 += f1 * w; F2 += f2 * w;
    }
    const k = (j * MW + i) * 4;
    ms[k] = L0 / (1 - F0); ms[k + 1] = L1 / (1 - F1); ms[k + 2] = L2 / (1 - F2); ms[k + 3] = 1;
  }
  const psi = (x, y, z, out) => {
    const h = Math.sqrt(x * x + y * y + z * z), mu = (x * sunDir.x + y * sunDir.y + z * sunDir.z) / h;
    return fetch(ms, MW, MH, tU(mu), tV(h - RG), out);
  };

  // --- sky view at ground level ---------------------------------------------
  // u: azimuth from the sun 0..pi (the sky is symmetric about the sun's vertical plane)
  // v: elevation, denser near the horizon: v = 0.5 + 0.5 sign(e) sqrt(|e| / (pi/2))
  const sky = new Float32Array(SKY_W * SKY_H * 4), PS = [0, 0, 0];
  const h0 = 0.02, px = 0, py = RG + h0, pz = 0;
  const sunAz = Math.atan2(sunDir.z, sunDir.x);
  for (let j = 0; j < SKY_H; j++) for (let i = 0; i < SKY_W; i++) {
    const v = (j + 0.5) / SKY_H, c = 2 * v - 1, el = Math.sign(c) * c * c * PI / 2;
    const az = sunAz + ((i + 0.5) / SKY_W) * PI;
    const dx = Math.cos(el) * Math.cos(az), dy = Math.sin(el), dz = Math.cos(el) * Math.sin(az);
    const atmo = hitSphere(px, py, pz, dx, dy, dz, RT), gnd = hitSphere(px, py, pz, dx, dy, dz, RG);
    const tMax = gnd > 0 ? gnd : atmo;
    const cs = dx * sunDir.x + dy * sunDir.y + dz * sunDir.z;
    const pm = miePhase(cs), pr = rayleighPhase(cs);
    const N = 40;
    let T0 = 1, T1 = 1, T2 = 1, l0 = 0, l1 = 0, l2 = 0, t = 0;
    for (let s = 0; s < N; s++) {
      // denser steps near the eye (the air is densest there)
      const q = (s + 0.3) / N, nt = q * q * tMax, dt = nt - t; t = nt;
      const x = px + dx * t, y = py + dy * t, z = pz + dz * t;
      medium(Math.sqrt(x * x + y * y + z * z) - RG, M);
      const s0 = Math.exp(-dt * M.e0), s1 = Math.exp(-dt * M.e1), s2 = Math.exp(-dt * M.e2);
      sunT(x, y, z, ST); psi(x, y, z, PS);
      l0 += T0 * (M.rs0 * (pr * ST[0] + PS[0]) + M.ms * (pm * ST[0] + PS[0])) * (1 - s0) / M.e0;
      l1 += T1 * (M.rs1 * (pr * ST[1] + PS[1]) + M.ms * (pm * ST[1] + PS[1])) * (1 - s1) / M.e1;
      l2 += T2 * (M.rs2 * (pr * ST[2] + PS[2]) + M.ms * (pm * ST[2] + PS[2])) * (1 - s2) / M.e2;
      T0 *= s0; T1 *= s1; T2 *= s2;
    }
    const k = (j * SKY_W + i) * 4;
    sky[k] = l0; sky[k + 1] = l1; sky[k + 2] = l2; sky[k + 3] = 1;
  }

  // --- constants for the per-pixel aerial perspective near the ground --------
  const g = [0, 0, 0], gp = [0, 0, 0];
  sunT(0, RG + h0, 0, g);
  psi(0, RG + h0, 0, gp);
  medium(h0, M);
  return {
    trans, ms, sky, skyW: SKY_W, skyH: SKY_H,
    sunT: g, psi: gp,
    // Rayleigh scattering per metre at the ground
    rayS: [M.rs0 * 1e-3, M.rs1 * 1e-3, M.rs2 * 1e-3],
    time: performance.now() - t0,
  };
}
