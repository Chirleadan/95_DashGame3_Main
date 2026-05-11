import { CONFIG } from './config.ts';
import { segmentHitsCircle } from './Collision.ts';

/**
 * Circular «Хранилище» / Storage obstacle in XZ (not physics — navigation only).
 * `r` is the combined no-go radius for enemy **center** (storage + padding + caller may add body).
 */
export type StorageObstacleCircle = { x: number; z: number; r: number };

function normalize2d(x: number, z: number): { x: number; z: number } {
  const l = Math.hypot(x, z);
  if (l < 1e-10) return { x: 0, z: 0 };
  return { x: x / l, z: z / l };
}

/** True if the open segment from A toward B enters the closed disk (C, cr). */
function segmentApproachesDisk(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  cr: number,
): boolean {
  return segmentHitsCircle(ax, az, bx, bz, cx, cz, cr);
}

function directionClearForAll(
  ex: number,
  ez: number,
  dirx: number,
  dirz: number,
  lookahead: number,
  obstacles: readonly StorageObstacleCircle[],
  enemyBodyRadius: number,
): boolean {
  const bx = ex + dirx * lookahead;
  const bz = ez + dirz * lookahead;
  for (const o of obstacles) {
    const rr = o.r + enemyBodyRadius;
    if (segmentApproachesDisk(ex, ez, bx, bz, o.x, o.z, rr)) return false;
  }
  return true;
}

/**
 * Unit direction for enemy at (ex,ez) seeking (tx,tz), steering around Storage disks.
 * Inflates each obstacle by `enemyBodyRadius` so enemy centers stay outside the no-go zone.
 */
export function computeEnemyMoveDirectionAvoidingStorages(
  ex: number,
  ez: number,
  tx: number,
  tz: number,
  obstacles: readonly StorageObstacleCircle[],
  lookahead: number,
  enemyBodyRadius: number,
): { dx: number; dz: number } {
  const toTx = tx - ex;
  const toTz = tz - ez;
  const g = normalize2d(toTx, toTz);
  if (obstacles.length === 0) return { dx: g.x, dz: g.z };

  const gx = g.x;
  const gz = g.z;

  if (directionClearForAll(ex, ez, gx, gz, lookahead, obstacles, enemyBodyRadius)) {
    return { dx: gx, dz: gz };
  }

  const leftPx = -gz;
  const leftPz = gx;
  let bestDx = gx;
  let bestDz = gz;
  let bestScore = -Number.POSITIVE_INFINITY;

  const weights = [0.12, 0.22, 0.38, 0.55, 0.8, 1.15, 1.6, 2.2];
  let found = false;
  for (const w of weights) {
    for (const sign of [-1, 1] as const) {
      const cx = gx + sign * w * leftPx;
      const cz = gz + sign * w * leftPz;
      const c = normalize2d(cx, cz);
      if (c.x === 0 && c.z === 0) continue;
      if (!directionClearForAll(ex, ez, c.x, c.z, lookahead, obstacles, enemyBodyRadius)) {
        continue;
      }
      found = true;
      const align = c.x * gx + c.z * gz;
      const tipx = ex + c.x * lookahead;
      const tipz = ez + c.z * lookahead;
      const distTip = Math.hypot(tx - tipx, tz - tipz);
      const score = align * 10 - distTip;
      if (score > bestScore) {
        bestScore = score;
        bestDx = c.x;
        bestDz = c.z;
      }
    }
  }

  if (found) {
    return { dx: bestDx, dz: bestDz };
  }

  let nx = obstacles[0]!.x;
  let nz = obstacles[0]!.z;
  let bestD = Number.POSITIVE_INFINITY;
  for (const o of obstacles) {
    const d = Math.hypot(ex - o.x, ez - o.z);
    if (d < bestD) {
      bestD = d;
      nx = o.x;
      nz = o.z;
    }
  }
  const rx = ex - nx;
  const rz = ez - nz;
  const rl = Math.hypot(rx, rz);
  if (rl < 1e-8) return { dx: gx, dz: gz };
  const ux = rx / rl;
  const uz = rz / rl;
  const pLx = -uz;
  const pLz = ux;
  const pRx = uz;
  const pRz = -ux;
  const dotL = pLx * gx + pLz * gz;
  const dotR = pRx * gx + pRz * gz;
  const pick = dotL >= dotR ? normalize2d(pLx + gx * 0.35, pLz + gz * 0.35) : normalize2d(pRx + gx * 0.35, pRz + gz * 0.35);
  return { dx: pick.x, dz: pick.z };
}

/** Disk parameters for navigation from CONFIG (world XZ). */
export function getConfiguredStorageObstacleDisk(
  centerX: number,
  centerZ: number,
): StorageObstacleCircle {
  return {
    x: centerX,
    z: centerZ,
    r: CONFIG.storageObstacleRadius + CONFIG.storageObstaclePadding,
  };
}
