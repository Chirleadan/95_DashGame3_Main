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
      this.spawnOne(px, pz, 0);
    }
  }

  /** If no vault yet and a slot is free, spawn one (used at round start). */
  spawnGuaranteedVaultIfRoom(px: number, pz: number, maxEnemySlots: number): void {
    if (this.enemies.length >= maxEnemySlots) return;
    if (this.enemies.some((e) => e.isVault())) return;
    const angle = Math.random() * Math.PI * 2;
    const dist =
      CONFIG.spawnMinDist +
      Math.random() * (CONFIG.spawnMaxDist - CONFIG.spawnMinDist);
    let x = px + Math.cos(angle) * dist;
    let z = pz + Math.sin(angle) * dist;
    const c = clampSpawnToArena(x, z);
    this.spawnTotal += 1;
    this.enemies.push(new Enemy(this.scene, c.x, c.z, 'vault'));
  }

  private spawnOne(px: number, pz: number, runElapsedSec: number): void {
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
    const runOk =
      Number.isFinite(runElapsedSec) && runElapsedSec >= CONFIG.tankMinRunSecBeforeSpawn;
    if (this.spawnTotal % CONFIG.tankEveryNthSpawn === 0 && runOk) {
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
    runElapsedSec: number,
  ): void {
    const m =
      Number.isFinite(difficultyMult) && difficultyMult > 0 ? difficultyMult : 1;
    if (this.enemies.length >= maxEnemySlots) return;
    const decay = CONFIG.spawnStartIntervalMultDecaySec;
    const mult0 = CONFIG.spawnStartIntervalMult;
    const u = decay > 1e-6 ? Math.min(1, Math.max(0, runElapsedSec) / decay) : 1;
    const startEase = 1 + (mult0 - 1) * (1 - u);
    const interval = Math.max(
      CONFIG.difficultyMinSpawnIntervalSec,
      (CONFIG.spawnInterval * startEase) / m,
    );
    this.acc += dt;
    while (this.acc >= interval && this.enemies.length < maxEnemySlots) {
      this.acc -= interval;
      this.spawnOne(px, pz, runElapsedSec);
    }
  }
}
