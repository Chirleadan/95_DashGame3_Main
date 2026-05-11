import * as THREE from 'three';
import { CONFIG } from './config.ts';
import { clampToArena, segmentHitsThickSegment } from './Collision.ts';
import {
  computeEnemyMoveDirectionAvoidingStorages,
  type StorageObstacleCircle,
} from './ObstacleAvoidance.ts';

/** `vault` = игровое «Хранилище» (шестигранник с щитами на рёбрах). */
export type EnemyKind = 'normal' | 'tank' | 'vault';

/** Same fill for normal / tank body and tank outline (must match visually). */
const ENEMY_BODY_COLOR = 0xff3344;

function disposeObject3DTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material;
    if (!mat) return;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
  });
}

/**
 * Rim corners of `CylinderGeometry(R,R,h,6)` in XZ (same formula as Three.js torso:
 * x = R*sin(θ), z = R*cos(θ), θ = 0, π/3, … — first corner on +Z).
 */
function hexVerticesXZ(R: number): { x: number; z: number }[] {
  const v: { x: number; z: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const theta = (i * Math.PI * 2) / 6;
    v.push({ x: R * Math.sin(theta), z: R * Math.cos(theta) });
  }
  return v;
}

export type DashSweepSeg = { ax: number; az: number; bx: number; bz: number };

export class Enemy {
  readonly mesh: THREE.Group;
  readonly kind: EnemyKind;
  /** Remaining HP (body). Хранилище: 1 после снятия всех щитов; щиты отдельно. */
  hitsRemaining: number;
  /** Last `player.getDashHitSerial()` that already applied a dash hit to this enemy. */
  damagedInDashHitSerial = 0;
  /** Tank outline ring; hidden after first damage. */
  private tankOutline: THREE.Mesh | null = null;
  /** Хранилище: щиты на рёбрах гекса; скрываются при попадании деша. */
  private vaultShieldMeshes: THREE.Mesh[] | null = null;
  private vaultEdgeHalfLen = 0;

  constructor(scene: THREE.Scene, x: number, z: number, kind: EnemyKind = 'normal') {
    this.kind = kind;
    this.mesh = new THREE.Group();
    this.mesh.position.set(x, CONFIG.floorY + 0.04, z);

    if (kind === 'vault') {
      this.hitsRemaining = 1;
      const R = CONFIG.vaultHexCircumradius;
      const verts = hexVerticesXZ(R);
      const v0 = verts[0]!;
      const v1 = verts[1]!;
      this.vaultEdgeHalfLen = 0.5 * Math.hypot(v1.x - v0.x, v1.z - v0.z);

      const bodyMat = new THREE.MeshStandardMaterial({
        color: CONFIG.vaultBodyColor,
        metalness: 0.35,
        roughness: 0.45,
        emissive: CONFIG.vaultBodyEmissive,
        emissiveIntensity: 0.25,
      });
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(R, R, CONFIG.vaultBodyThickness, 6),
        bodyMat,
      );
      body.position.y = CONFIG.vaultBodyThickness * 0.5;
      body.castShadow = true;
      this.mesh.add(body);

      const stripMat = new THREE.MeshBasicMaterial({
        color: CONFIG.vaultStripColor,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      });
      const shields: THREE.Mesh[] = [];
      const xAxis = new THREE.Vector3(1, 0, 0);
      const along = new THREE.Vector3();
      for (let i = 0; i < 6; i++) {
        const a = verts[i]!;
        const b = verts[(i + 1) % 6]!;
        const mx = (a.x + b.x) * 0.5;
        const mz = (a.z + b.z) * 0.5;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        along.set(dx, 0, dz).normalize();
        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(
            this.vaultEdgeHalfLen * 2,
            CONFIG.vaultShieldStripHeight,
            CONFIG.vaultShieldStripDepth,
          ),
          stripMat.clone(),
        );
        strip.quaternion.setFromUnitVectors(xAxis, along);
        strip.position.set(mx, CONFIG.vaultShieldStripY, mz);
        strip.renderOrder = 3;
        this.mesh.add(strip);
        shields.push(strip);
      }
      this.vaultShieldMeshes = shields;
      scene.add(this.mesh);
      return;
    }

    this.hitsRemaining = kind === 'tank' ? CONFIG.tankHitsToKill : 1;

    const segs = 10;
    const r =
      kind === 'tank'
        ? CONFIG.enemyRadius * CONFIG.tankRadiusScale
        : CONFIG.enemyRadius;

    const mat = new THREE.MeshBasicMaterial({
      color: ENEMY_BODY_COLOR,
      transparent: true,
      opacity: 0.95,
      depthWrite: true,
    });

    const body = new THREE.Mesh(new THREE.CircleGeometry(r, segs), mat);
    body.rotation.x = -Math.PI / 2;
    body.castShadow = false;
    body.receiveShadow = false;
    this.mesh.add(body);

    if (kind === 'tank') {
      const gap = CONFIG.tankOutlineGap;
      const stroke = CONFIG.tankOutlineStroke;
      const ringInner = r + gap;
      const ringOuter = r + gap + stroke;
      const outlineMat = new THREE.MeshBasicMaterial({
        color: ENEMY_BODY_COLOR,
        transparent: true,
        opacity: 0.96,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const outline = new THREE.Mesh(
        new THREE.RingGeometry(ringInner, ringOuter, segs),
        outlineMat,
      );
      outline.rotation.x = -Math.PI / 2;
      outline.position.y = 0.02;
      this.mesh.add(outline);
      this.tankOutline = outline;
    }

    scene.add(this.mesh);
  }

  get bodyRadius(): number {
    if (this.kind === 'vault') return CONFIG.vaultHexCircumradius;
    if (this.kind === 'tank') return CONFIG.enemyRadius * CONFIG.tankRadiusScale;
    return CONFIG.enemyRadius;
  }

  isTank(): boolean {
    return this.kind === 'tank';
  }

  /** Игровое «Хранилище». */
  isVault(): boolean {
    return this.kind === 'vault';
  }

  /** Активные щиты (только у Хранилища). */
  getActiveShieldCount(): number {
    if (!this.vaultShieldMeshes) return 0;
    let n = 0;
    for (const m of this.vaultShieldMeshes) {
      if (m.visible) n += 1;
    }
    return n;
  }

  /**
   * Хранилище: если сегмент деша попал в живой щит — скрыть щит, вернуть true.
   * Серийник деша не проверяется — вызывающий код ограничивает один раз за деш.
   */
  tryBreakVaultShieldWithDash(seg: DashSweepSeg, joinRadius: number): boolean {
    if (!this.vaultShieldMeshes) return false;
    for (const strip of this.vaultShieldMeshes) {
      if (!strip.visible) continue;
      strip.updateWorldMatrix(true, false);
      const hw = this.vaultEdgeHalfLen - 1e-4;
      const axl = new THREE.Vector3(-hw, 0, 0);
      const bxl = new THREE.Vector3(hw, 0, 0);
      axl.applyMatrix4(strip.matrixWorld);
      bxl.applyMatrix4(strip.matrixWorld);
      const ax = axl.x;
      const az = axl.z;
      const bx = bxl.x;
      const bz = bxl.z;
      if (
        segmentHitsThickSegment(seg.ax, seg.az, seg.bx, seg.bz, ax, az, bx, bz, joinRadius)
      ) {
        strip.visible = false;
        return true;
      }
    }
    return false;
  }

  applyDamage(amount: number): boolean {
    const n = Math.max(0, Math.floor(amount));
    if (n <= 0) return false;
    if (this.kind === 'vault' && this.getActiveShieldCount() > 0) {
      return false;
    }
    this.hitsRemaining -= n;
    if (this.tankOutline) {
      this.tankOutline.visible = false;
    }
    return this.hitsRemaining <= 0;
  }

  takeDashHit(): boolean {
    return this.applyDamage(1);
  }

  update(
    dt: number,
    targetX: number,
    targetZ: number,
    speedMultiplier = 1,
    storageObstacles: readonly StorageObstacleCircle[] | null = null,
  ): void {
    if (this.kind === 'vault') {
      return;
    }
    let mx = targetX - this.mesh.position.x;
    let mz = targetZ - this.mesh.position.z;
    let len = Math.hypot(mx, mz);
    if (len > 1e-4 && storageObstacles && storageObstacles.length > 0) {
      const dir = computeEnemyMoveDirectionAvoidingStorages(
        this.mesh.position.x,
        this.mesh.position.z,
        targetX,
        targetZ,
        storageObstacles,
        CONFIG.enemyAvoidanceLookahead,
        this.bodyRadius,
      );
      mx = dir.dx;
      mz = dir.dz;
      len = Math.hypot(mx, mz);
    }
    if (len > 1e-4) {
      const sm =
        Number.isFinite(speedMultiplier) && speedMultiplier > 0 ? speedMultiplier : 1;
      const s = (CONFIG.enemySpeed * sm * dt) / len;
      this.mesh.position.x += mx * s;
      this.mesh.position.z += mz * s;
    }
    const c = clampToArena(this.mesh.position.x, this.mesh.position.z);
    this.mesh.position.x = c.x;
    this.mesh.position.z = c.z;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    disposeObject3DTree(this.mesh);
  }
}
