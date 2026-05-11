import { CONFIG } from './config.ts';

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

export function clampToArena(x: number, z: number): { x: number; z: number } {
  const h = CONFIG.arenaHalfSize - 0.5;
  return {
    x: Math.max(-h, Math.min(h, x)),
    z: Math.max(-h, Math.min(h, z)),
  };
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
