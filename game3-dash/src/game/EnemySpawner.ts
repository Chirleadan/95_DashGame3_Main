import type { Scene } from 'three';
import { CONFIG } from './config.ts';
import { Enemy } from './Enemy.ts';

export class EnemySpawner {
  private acc = 0;
  private readonly scene: Scene;
  private readonly enemies: Enemy[];

  constructor(scene: Scene, enemies: Enemy[]) {
    this.scene = scene;
    this.enemies = enemies;
  }

  reset(): void {
    this.acc = 0;
  }

  spawnBurstAround(px: number, pz: number, count: number): void {
    for (let i = 0; i < count; i++) {
      if (this.enemies.length >= CONFIG.maxEnemies) break;
      this.spawnOne(px, pz);
    }
  }

  private spawnOne(px: number, pz: number): void {
    const angle = Math.random() * Math.PI * 2;
    const dist =
      CONFIG.spawnMinDist +
      Math.random() * (CONFIG.spawnMaxDist - CONFIG.spawnMinDist);
    const x = px + Math.cos(angle) * dist;
    const z = pz + Math.sin(angle) * dist;
    this.enemies.push(new Enemy(this.scene, x, z));
  }

  update(dt: number, px: number, pz: number): void {
    if (this.enemies.length >= CONFIG.maxEnemies) return;
    this.acc += dt;
    while (this.acc >= CONFIG.spawnInterval && this.enemies.length < CONFIG.maxEnemies) {
      this.acc -= CONFIG.spawnInterval;
      this.spawnOne(px, pz);
    }
  }
}
