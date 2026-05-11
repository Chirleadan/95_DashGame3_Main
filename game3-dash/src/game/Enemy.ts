import * as THREE from 'three';
import { CONFIG } from './config.ts';
import { clampToArena } from './Collision.ts';

export class Enemy {
  readonly mesh: THREE.Mesh;

  constructor(scene: THREE.Scene, x: number, z: number) {
    const segs = 10;
    const geo = new THREE.CircleGeometry(CONFIG.enemyRadius, segs);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff3344,
      transparent: true,
      opacity: 0.95,
      depthWrite: true,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.position.set(x, CONFIG.floorY + 0.03, z);
    scene.add(this.mesh);
  }

  update(dt: number, targetX: number, targetZ: number): void {
    const dx = targetX - this.mesh.position.x;
    const dz = targetZ - this.mesh.position.z;
    const len = Math.hypot(dx, dz);
    if (len > 1e-4) {
      const s = (CONFIG.enemySpeed * dt) / len;
      this.mesh.position.x += dx * s;
      this.mesh.position.z += dz * s;
    }
    const c = clampToArena(this.mesh.position.x, this.mesh.position.z);
    this.mesh.position.x = c.x;
    this.mesh.position.z = c.z;

  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    const m = this.mesh.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose());
    else m.dispose();
  }
}
