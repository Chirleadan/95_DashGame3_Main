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
