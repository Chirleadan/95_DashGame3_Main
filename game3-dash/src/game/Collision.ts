export function circlesOverlap(
  ax: number,
  az: number,
  ar: number,
  bx: number,
  bz: number,
  br: number,
): boolean {
  const dx = ax - bx;
  const dz = az - bz;
  const r = ar + br;
  return dx * dx + dz * dz <= r * r;
}

/** No world bounds — positions are used as-is (legacy name kept for call sites). */
export function clampToArena(x: number, z: number): { x: number; z: number } {
  return { x, z };
}

/** Spawn position is not clamped to a map edge. */
export function clampSpawnToArena(x: number, z: number): { x: number; z: number } {
  return { x, z };
}

/** Closest-point-on-segment vs circle (XZ). `cr` is combined radius (e.g. player + enemy). */
export function segmentHitsCircle(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  cr: number,
): boolean {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = cx - ax;
  const apz = cz - az;
  const abLen2 = abx * abx + abz * abz;
  const t =
    abLen2 > 1e-10
      ? Math.max(0, Math.min(1, (apx * abx + apz * abz) / abLen2))
      : 0;
  const qx = ax + abx * t;
  const qz = az + abz * t;
  const dx = cx - qx;
  const dz = cz - qz;
  return dx * dx + dz * dz <= cr * cr;
}

/**
 * Smallest t > 0 along ray (ox, oz) + t*(dirX, dirZ) in XZ where distance to (cx, cz)
 * equals `radius` (first exit from the closed disk when starting inside or on it).
 * Direction is normalized internally. Returns null if the ray never meets the circle
 * ahead (e.g. zero direction or negative discriminant).
 */
export function rayExitFromCircleXZ(
  ox: number,
  oz: number,
  dirX: number,
  dirZ: number,
  cx: number,
  cz: number,
  radius: number,
): { t: number; x: number; z: number } | null {
  if (!(radius > 0) || !Number.isFinite(radius)) return null;
  let dx = dirX;
  let dz = dirZ;
  const dLen = Math.hypot(dx, dz);
  if (dLen < 1e-10) return null;
  dx /= dLen;
  dz /= dLen;

  const vx = ox - cx;
  const vz = oz - cz;
  const vd = vx * dx + vz * dz;
  const v2 = vx * vx + vz * vz;
  const r2 = radius * radius;
  const disc = vd * vd - v2 + r2;
  if (disc < -1e-8) return null;
  const sqrtDisc = Math.sqrt(Math.max(0, disc));
  const t0 = -vd - sqrtDisc;
  const t1 = -vd + sqrtDisc;

  const eps = 1e-5;
  let t: number | null = null;

  if (v2 <= r2 + eps) {
    // Inside or on the disk of radius `radius`
    if (v2 < r2 - 1e-8) {
      // Strictly inside: one negative root, one positive — forward exit is t1
      if (t1 > eps) t = t1;
      else if (t0 > eps) t = t0;
    } else {
      // On/near boundary
      if (vd > eps) {
        // Moving outward along the ray: advance slightly past the boundary
        t = eps * 4;
      } else if (t1 > eps) {
        t = t1;
      } else if (t0 > eps) {
        t = t0;
      } else {
        t = eps * 4;
      }
    }
  } else {
    // Starting outside the expanded disk: smallest positive hit (reaches shell ahead)
    const cand = [t0, t1].filter((u) => u > eps);
    if (cand.length > 0) t = Math.min(...cand);
  }

  if (t === null || !Number.isFinite(t)) return null;
  return {
    t,
    x: ox + dx * t,
    z: oz + dz * t,
  };
}

function sqDistPointSegmentXZ(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const abLen2 = abx * abx + abz * abz;
  const t =
    abLen2 > 1e-12
      ? Math.max(0, Math.min(1, (apx * abx + apz * abz) / abLen2))
      : 0;
  const qx = ax + abx * t;
  const qz = az + abz * t;
  const dx = px - qx;
  const dz = pz - qz;
  return dx * dx + dz * dz;
}

/**
 * True if segment AB passes within `joinRadius` of segment CD (XZ), sampled + endpoint checks.
 */
export function segmentHitsThickSegment(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
  joinRadius: number,
): boolean {
  const r2 = joinRadius * joinRadius;
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = ax + (bx - ax) * t;
    const pz = az + (bz - az) * t;
    if (sqDistPointSegmentXZ(px, pz, cx, cz, dx, dz) <= r2) return true;
  }
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    const px = cx + (dx - cx) * t;
    const pz = cz + (dz - cz) * t;
    if (sqDistPointSegmentXZ(px, pz, ax, az, bx, bz) <= r2) return true;
  }
  return false;
}
