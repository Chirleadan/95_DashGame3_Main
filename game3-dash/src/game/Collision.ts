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

function orientXZ(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

function onSegmentXZ(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  px: number,
  pz: number,
): boolean {
  const eps = 1e-9;
  return (
    px >= Math.min(ax, bx) - eps &&
    px <= Math.max(ax, bx) + eps &&
    pz >= Math.min(az, bz) - eps &&
    pz <= Math.max(az, bz) + eps &&
    Math.abs(orientXZ(ax, az, bx, bz, px, pz)) <= eps
  );
}

function segmentsIntersectXZ(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): boolean {
  const eps = 1e-9;
  const o1 = orientXZ(ax, az, bx, bz, cx, cz);
  const o2 = orientXZ(ax, az, bx, bz, dx, dz);
  const o3 = orientXZ(cx, cz, dx, dz, ax, az);
  const o4 = orientXZ(cx, cz, dx, dz, bx, bz);

  if (o1 * o2 < -eps && o3 * o4 < -eps) return true;
  if (Math.abs(o1) <= eps && onSegmentXZ(ax, az, bx, bz, cx, cz)) return true;
  if (Math.abs(o2) <= eps && onSegmentXZ(ax, az, bx, bz, dx, dz)) return true;
  if (Math.abs(o3) <= eps && onSegmentXZ(cx, cz, dx, dz, ax, az)) return true;
  if (Math.abs(o4) <= eps && onSegmentXZ(cx, cz, dx, dz, bx, bz)) return true;
  return false;
}

function sqDistSegmentSegmentXZ(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): number {
  if (segmentsIntersectXZ(ax, az, bx, bz, cx, cz, dx, dz)) return 0;
  return Math.min(
    sqDistPointSegmentXZ(ax, az, cx, cz, dx, dz),
    sqDistPointSegmentXZ(bx, bz, cx, cz, dx, dz),
    sqDistPointSegmentXZ(cx, cz, ax, az, bx, bz),
    sqDistPointSegmentXZ(dx, dz, ax, az, bx, bz),
  );
}

/**
 * True if segment AB passes within `joinRadius` of segment CD (XZ).
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
  const safeR = Number.isFinite(joinRadius) ? Math.max(0, joinRadius) : 0;
  return sqDistSegmentSegmentXZ(ax, az, bx, bz, cx, cz, dx, dz) <= safeR * safeR;
}
