import type { Scene } from 'three';
import { CONFIG } from './config.ts';
import { clampSpawnToArena } from './Collision.ts';
import { Enemy } from './Enemy.ts';

export class EnemySpawner {
  private acc = 0;
  /** Total spawns this run (for tank cadence). */
  private spawnTotal = 0;
  private readonly scene: Scene;
  private readonly enemies: Enemy[];

  constructor(scene: Scene, enemies: Enemy[]) {
    this.scene = scene;
    this.enemies = enemies;
  }

  reset(): void {
    this.acc = 0;
    this.spawnTotal = 0;
  }

  spawnBurstAround(px: number, pz: number, count: number, maxEnemySlots: number): void {
    for (let i = 0; i < count; i++) {
      if (this.enemies.length >= maxEnemySlots) break;
      this.spawnOne(px, pz);
    }
  }

  private spawnOne(px: number, pz: number): void {
    const angle = Math.random() * Math.PI * 2;
    const dist =
      CONFIG.spawnMinDist +
      Math.random() * (CONFIG.spawnMaxDist - CONFIG.spawnMinDist);
    let x = px + Math.cos(angle) * dist;
    let z = pz + Math.sin(angle) * dist;
    const c = clampSpawnToArena(x, z);
    x = c.x;
    z = c.z;
    this.spawnTotal += 1;
    let kind: 'normal' | 'tank' | 'vault' = 'normal';
    if (this.spawnTotal % CONFIG.tankEveryNthSpawn === 0) {
      kind = 'tank';
    } else if (this.spawnTotal % CONFIG.vaultEveryNthSpawn === 0) {
      const vaultN = this.enemies.reduce((n, e) => n + (e.isVault() ? 1 : 0), 0);
      if (vaultN < CONFIG.vaultMaxSimultaneous) {
        kind = 'vault';
      }
    }
    this.enemies.push(new Enemy(this.scene, x, z, kind));
  }

  update(
    dt: number,
    px: number,
    pz: number,
    difficultyMult: number,
    maxEnemySlots: number,
  ): void {
    const m =
      Number.isFinite(difficultyMult) && difficultyMult > 0 ? difficultyMult : 1;
    if (this.enemies.length >= maxEnemySlots) return;
    const interval = Math.max(
      CONFIG.difficultyMinSpawnIntervalSec,
      CONFIG.spawnInterval / m,
    );
    this.acc += dt;
    while (this.acc >= interval && this.enemies.length < maxEnemySlots) {
      this.acc -= interval;
      this.spawnOne(px, pz);
    }
  }
}
