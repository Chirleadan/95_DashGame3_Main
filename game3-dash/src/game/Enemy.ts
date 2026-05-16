import * as THREE from 'three';
import { CONFIG } from './config.ts';
import { clampToArena, segmentHitsThickSegment } from './Collision.ts';
import {
  computeEnemyMoveDirectionAvoidingStorages,
  type StorageObstacleCircle,
} from './ObstacleAvoidance.ts';

/** `vault` = игровое «Хранилище» (шестигранник с щитами на рёбрах). */
export type EnemyKind =
  | 'normal'
  | 'shooter'
  | 'tank'
  | 'angel'
  | 'vault'
  | 'goldSack'
  | 'manaSack';

/** Same fill for normal / tank body. */
const ENEMY_BODY_COLOR = 0xff3344;
const SHOOTER_BODY_COLOR = 0x58d7ff;
const ENEMY_TEXTURE_LOADER = new THREE.TextureLoader();
const ENEMY_SPRITE_URLS: Partial<Record<EnemyKind, string>> = {
  normal: '/assets/enemies/normal/idle.png',
  shooter: '/assets/enemies/shooter/idle.png',
  tank: '/assets/enemies/tank/idle.png',
  angel: '/assets/enemies/angel/idle.png',
};
const ENEMY_DEATH_SPRITE_URLS: Partial<Record<EnemyKind, string>> = {
  normal: '/assets/enemies/normal/mob_death.png',
  shooter: '/assets/enemies/shooter/shooter_death.png',
  tank: '/assets/enemies/tank/tank_death.png',
  angel: '/assets/enemies/angel/angel_death.png',
};

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

function rollIntInclusive(min: number, max: number): number {
  const a = Math.ceil(min);
  const b = Math.floor(max);
  if (b < a) return a;
  return a + Math.floor(Math.random() * (b - a + 1));
}

function createCurvedAngelShieldGeometry(
  halfLen: number,
  height: number,
  depth: number,
  curveSign: number,
): THREE.BufferGeometry {
  const segs = 10;
  const bulge = depth * 1.45;
  const verts: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const x = -halfLen + halfLen * 2 * t;
    const u = t * 2 - 1;
    const z = curveSign * bulge * (1 - u * u);
    verts.push(
      x, height * 0.5, z + depth * 0.5,
      x, height * 0.5, z - depth * 0.5,
      x, -height * 0.5, z + depth * 0.5,
      x, -height * 0.5, z - depth * 0.5,
    );
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 4;
    const b = a + 4;
    indices.push(
      a, b, a + 1, a + 1, b, b + 1,
      a + 2, a + 3, b + 2, a + 3, b + 3, b + 2,
      a, a + 2, b, a + 2, b + 2, b,
      a + 1, b + 1, a + 3, a + 3, b + 1, b + 3,
    );
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function addEnemySprite(
  root: THREE.Group,
  kind: EnemyKind,
  radius: number,
  y = 0.08,
  scale = 1,
): { pivot: THREE.Group; mat: THREE.MeshBasicMaterial } | null {
  const url = ENEMY_SPRITE_URLS[kind];
  if (!url) return null;
  const tex = ENEMY_TEXTURE_LOADER.load(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const visualRadius = radius * scale;
  const sprite = new THREE.Mesh(
    new THREE.PlaneGeometry(visualRadius * 2, visualRadius * 2),
    mat,
  );
  sprite.rotation.x = -Math.PI / 2;
  sprite.position.y = y;
  sprite.renderOrder = 4;
  const pivot = new THREE.Group();
  pivot.add(sprite);
  root.add(pivot);
  return { pivot, mat };
}

export type DashSweepSeg = { ax: number; az: number; bx: number; bz: number };

export class Enemy {
  readonly mesh: THREE.Group;
  readonly kind: EnemyKind;
  /** Remaining HP (body). Хранилище: 1 после снятия всех щитов; щиты отдельно. */
  hitsRemaining: number;
  /** Last `player.getDashHitSerial()` that already applied a dash hit to this enemy. */
  damagedInDashHitSerial = 0;
  /**
   * Vault: last dash serial for which `clipDashPastTank` ran (shielded overlap or bare body),
   * so we do not double-teleport when shields drop and body damage runs same dash.
   */
  vaultLastClipDashSerial = 0;
  /** Tank outline rings: count matches extra HP beyond the last hit. */
  private tankOutlines: THREE.Mesh[] = [];
  /** Хранилище: щиты на рёбрах гекса; скрываются при попадании деша. */
  private vaultShieldMeshes: THREE.Mesh[] | null = null;
  private vaultEdgeHalfLen = 0;
  private angelShieldLayersPerSide = 1;
  /** Tank: wall-clock times (`performance.now()`) when queued dash body damage applies. */
  private pendingTankDashDamageAt: number[] = [];
  /** Angel shield regen accumulator (seconds). */
  private angelShieldRegenAccSec = 0;
  private shooterShotCooldownSec = CONFIG.shooterShotIntervalSec * 0.5;
  private facingSpritePivot: THREE.Group | null = null;
  private spriteMat: THREE.MeshBasicMaterial | null = null;

  constructor(
    scene: THREE.Scene,
    x: number,
    z: number,
    kind: EnemyKind = 'normal',
    tankHitsToKillOverride?: number,
    angelShieldLayersOverride?: number,
  ) {
    this.kind = kind;
    this.mesh = new THREE.Group();
    this.mesh.position.set(x, CONFIG.floorY + 0.04, z);

    if (kind === 'vault' || kind === 'angel') {
      this.hitsRemaining = 1;
      const isAngel = kind === 'angel';
      this.angelShieldLayersPerSide = isAngel
        ? Math.max(
            1,
            Math.min(
              CONFIG.angelShieldLayerMax,
              Math.floor(angelShieldLayersOverride ?? 1),
            ),
          )
        : 1;
      const R = isAngel
        ? CONFIG.enemyRadius * CONFIG.tankRadiusScale * CONFIG.angelRadiusScale
        : CONFIG.vaultHexCircumradius;
      const verts = hexVerticesXZ(R);
      const v0 = verts[0]!;
      const v1 = verts[1]!;
      this.vaultEdgeHalfLen = 0.5 * Math.hypot(v1.x - v0.x, v1.z - v0.z);

      const bodyMat = new THREE.MeshStandardMaterial({
        color: isAngel ? 0x4a567a : CONFIG.vaultBodyColor,
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
      const spriteScale = isAngel ? 1 / 1.25 : 1;
      const sprite = addEnemySprite(this.mesh, kind, R, 0.08, spriteScale);
      if (sprite) {
        this.facingSpritePivot = sprite.pivot;
        this.spriteMat = sprite.mat;
        body.visible = false;
      }

      const stripMat = new THREE.MeshBasicMaterial({
        color: isAngel ? CONFIG.angelShieldColorA : CONFIG.vaultStripColor,
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
        const q = new THREE.Quaternion().setFromUnitVectors(xAxis, along);
        const radial = new THREE.Vector3(mx, 0, mz).normalize();
        const localZWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
        const curveSign = localZWorld.dot(radial) >= 0 ? 1 : -1;
        const layers = isAngel ? this.angelShieldLayersPerSide : 1;
        for (let layer = 0; layer < layers; layer++) {
          const shieldGeo = isAngel
            ? createCurvedAngelShieldGeometry(
                this.vaultEdgeHalfLen * (0.82 + layer * CONFIG.angelShieldLayerLengthStep),
                CONFIG.vaultShieldStripHeight,
                CONFIG.vaultShieldStripDepth,
                curveSign,
              )
            : new THREE.BoxGeometry(
                this.vaultEdgeHalfLen * 2,
                CONFIG.vaultShieldStripHeight,
                CONFIG.vaultShieldStripDepth,
              );
          const strip = new THREE.Mesh(
            shieldGeo,
            stripMat.clone(),
          );
          if (isAngel) {
            const mat = strip.material as THREE.MeshBasicMaterial;
            mat.color.setHex(
              i % 2 === 0 ? CONFIG.angelShieldColorA : CONFIG.angelShieldColorB,
            );
            mat.opacity = Math.max(0.48, 0.92 - layer * 0.1);
            strip.userData.shieldSide = i;
            strip.userData.shieldLayer = layer;
          }
          strip.quaternion.copy(q);
          strip.position.set(
            mx + radial.x * CONFIG.angelShieldLayerGap * layer,
            CONFIG.vaultShieldStripY + layer * 0.018,
            mz + radial.z * CONFIG.angelShieldLayerGap * layer,
          );
          strip.renderOrder = 3 + layer;
          this.mesh.add(strip);
          shields.push(strip);
        }
      }
      this.vaultShieldMeshes = shields;
      scene.add(this.mesh);
      return;
    }

    if (kind === 'goldSack' || kind === 'manaSack') {
      this.hitsRemaining = 1;
      const segs = 10;
      const r = CONFIG.enemyRadius;
      const isGold = kind === 'goldSack';
      const mat = new THREE.MeshBasicMaterial({
        color: isGold ? 0xc9a227 : 0x4a6bdc,
        transparent: true,
        opacity: 0.95,
        depthWrite: true,
      });
      const body = new THREE.Mesh(new THREE.CircleGeometry(r, segs), mat);
      body.rotation.x = -Math.PI / 2;
      body.castShadow = false;
      body.receiveShadow = false;
      this.mesh.add(body);
      scene.add(this.mesh);
      return;
    }

    const tankHits =
      typeof tankHitsToKillOverride === 'number' && Number.isFinite(tankHitsToKillOverride)
        ? tankHitsToKillOverride
        : rollIntInclusive(CONFIG.tankHitsToKillMin, CONFIG.tankHitsToKillMax);
    this.hitsRemaining = kind === 'tank' ? Math.max(1, Math.floor(tankHits)) : 1;

    const segs = kind === 'tank' ? 40 : 10;
    const r =
      kind === 'tank'
        ? CONFIG.enemyRadius * CONFIG.tankRadiusScale
        : kind === 'normal'
          ? CONFIG.enemyRadius * CONFIG.normalEnemyRadiusScale
        : CONFIG.enemyRadius;

    const mat = new THREE.MeshBasicMaterial({
      color: kind === 'shooter' ? SHOOTER_BODY_COLOR : ENEMY_BODY_COLOR,
      transparent: true,
      opacity: 0.95,
      depthWrite: true,
    });

    const body = new THREE.Mesh(new THREE.CircleGeometry(r, segs), mat);
    body.rotation.x = -Math.PI / 2;
    body.castShadow = false;
    body.receiveShadow = false;
    this.mesh.add(body);
    if (ENEMY_SPRITE_URLS[kind]) {
      body.visible = false;
    }

    if (kind === 'shooter') {
      const barrelMat = new THREE.MeshBasicMaterial({
        color: 0xd7f8ff,
        transparent: true,
        opacity: 0.92,
        depthWrite: true,
      });
      const barrel = new THREE.Mesh(
        new THREE.BoxGeometry(r * 0.34, 0.08, r * 1.05),
        barrelMat,
      );
      barrel.position.z = r * 0.34;
      barrel.position.y = 0.04;
      barrel.visible = false;
      this.mesh.add(barrel);
    }
    const spriteScale = kind === 'tank' ? 1 / 1.1 : 1;
    const sprite = addEnemySprite(this.mesh, kind, r, 0.08, spriteScale);
    if (sprite) {
      this.facingSpritePivot = sprite.pivot;
      this.spriteMat = sprite.mat;
    }

    if (kind === 'tank') {
      const gap = CONFIG.tankOutlineGap;
      const stroke = CONFIG.tankOutlineStroke;
      const extraHp = Math.max(0, this.hitsRemaining - 1);
      for (let i = 0; i < extraHp; i++) {
        const ringInner = r + gap + i * (stroke + gap * 0.6);
        const ringOuter = ringInner + stroke;
        const outlineMat = new THREE.MeshBasicMaterial({
          color: CONFIG.tankOutlineColor,
          transparent: true,
          opacity: 0.96,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const outline = new THREE.Mesh(
          new THREE.RingGeometry(ringInner, ringOuter, 56),
          outlineMat,
        );
        outline.rotation.x = -Math.PI / 2;
        outline.position.y = 0.02 + i * 0.002;
        this.mesh.add(outline);
        this.tankOutlines.push(outline);
      }
      this.syncTankOutlinesToHp();
    }

    scene.add(this.mesh);
  }

  get bodyRadius(): number {
    if (this.kind === 'vault') return CONFIG.vaultHexCircumradius;
    if (this.kind === 'angel') {
      return CONFIG.enemyRadius * CONFIG.tankRadiusScale * CONFIG.angelRadiusScale;
    }
    if (this.kind === 'tank') {
      return CONFIG.enemyRadius * CONFIG.tankRadiusScale;
    }
    if (this.kind === 'normal') {
      return CONFIG.enemyRadius * CONFIG.normalEnemyRadiusScale;
    }
    return CONFIG.enemyRadius;
  }

  isTank(): boolean {
    return this.kind === 'tank';
  }

  isShooter(): boolean {
    return this.kind === 'shooter';
  }

  isAngel(): boolean {
    return this.kind === 'angel';
  }

  /** Игровое «Хранилище». */
  isVault(): boolean {
    return this.kind === 'vault';
  }

  isGoldSack(): boolean {
    return this.kind === 'goldSack';
  }

  isManaSack(): boolean {
    return this.kind === 'manaSack';
  }

  /** Статичные мешки золота/маны: без урона по герою, не двигаются. */
  isResourceSack(): boolean {
    return this.kind === 'goldSack' || this.kind === 'manaSack';
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
    const pick = this.pickShieldHitByDash(seg, joinRadius, true);
    if (!pick) return false;
    pick.visible = false;
    return true;
  }

  private pickShieldHitByDash(
    seg: DashSweepSeg,
    joinRadius: number,
    requireVisible: boolean,
  ): THREE.Mesh | null {
    if (!this.vaultShieldMeshes) return null;
    if (this.kind === 'angel') {
      return this.pickShieldByIncomingSide(seg, requireVisible);
    }
    // Prefer the shield on the incoming side; this removes "neighbor shield broke" artifacts.
    const incomingSide = this.pickShieldByIncomingSide(seg, requireVisible);
    if (incomingSide) {
      incomingSide.updateWorldMatrix(true, false);
      const hw = this.vaultEdgeHalfLen - 1e-4;
      const axl = new THREE.Vector3(-hw, 0, 0);
      const bxl = new THREE.Vector3(hw, 0, 0);
      axl.applyMatrix4(incomingSide.matrixWorld);
      bxl.applyMatrix4(incomingSide.matrixWorld);
      if (
        segmentHitsThickSegment(
          seg.ax,
          seg.az,
          seg.bx,
          seg.bz,
          axl.x,
          axl.z,
          bxl.x,
          bxl.z,
          joinRadius,
        )
      ) {
        return incomingSide;
      }
    }
    const dirX = seg.bx - seg.ax;
    const dirZ = seg.bz - seg.az;
    const len2 = dirX * dirX + dirZ * dirZ;
    const mid = new THREE.Vector3();
    let best: THREE.Mesh | null = null;
    let bestT = Number.POSITIVE_INFINITY;
    for (const strip of this.vaultShieldMeshes) {
      if (requireVisible && !strip.visible) continue;
      if (!requireVisible && strip.visible) continue;
      strip.updateWorldMatrix(true, false);
      const hw = this.vaultEdgeHalfLen - 1e-4;
      const axl = new THREE.Vector3(-hw, 0, 0);
      const bxl = new THREE.Vector3(hw, 0, 0);
      axl.applyMatrix4(strip.matrixWorld);
      bxl.applyMatrix4(strip.matrixWorld);
      if (
        !segmentHitsThickSegment(
          seg.ax,
          seg.az,
          seg.bx,
          seg.bz,
          axl.x,
          axl.z,
          bxl.x,
          bxl.z,
          joinRadius,
        )
      ) {
        continue;
      }
      strip.getWorldPosition(mid);
      const t = len2 > 1e-8 ? ((mid.x - seg.ax) * dirX + (mid.z - seg.az) * dirZ) / len2 : 0;
      const tClamped = Math.max(0, Math.min(1, t));
      if (tClamped < bestT) {
        bestT = tClamped;
        best = strip;
      }
    }
    return best;
  }

  private pickShieldByIncomingSide(
    seg: DashSweepSeg,
    requireVisible: boolean,
  ): THREE.Mesh | null {
    if (!this.vaultShieldMeshes || this.vaultShieldMeshes.length <= 0) return null;
    const side = this.pickShieldSideByIncomingSide(seg);
    if (side < 0) return null;
    if (this.kind === 'angel') {
      return requireVisible
        ? this.pickOutermostVisibleAngelShieldOnSide(side)
        : this.isAngelShieldSideOpen(side)
          ? this.pickInnermostHiddenAngelShieldOnSide(side)
          : null;
    }
    const vaultShield = this.vaultShieldMeshes[side] ?? null;
    if (!vaultShield) return null;
    if (requireVisible && !vaultShield.visible) return null;
    if (!requireVisible && vaultShield.visible) return null;
    return vaultShield;
  }

  private pickShieldSideByIncomingSide(seg: DashSweepSeg): number {
    if (!this.vaultShieldMeshes || this.vaultShieldMeshes.length <= 0) return -1;
    const cx = this.mesh.position.x;
    const cz = this.mesh.position.z;
    let inX = seg.ax - cx;
    let inZ = seg.az - cz;
    const inLen = Math.hypot(inX, inZ);
    if (inLen <= 1e-8) return -1;
    inX /= inLen;
    inZ /= inLen;

    let bestSide = -1;
    let bestScore = -Number.POSITIVE_INFINITY;
    const mid = new THREE.Vector3();
    const sideCount = this.kind === 'angel' ? 6 : this.vaultShieldMeshes.length;
    for (let side = 0; side < sideCount; side++) {
      const strip =
        this.kind === 'angel'
          ? this.pickOutermostVisibleAngelShieldOnSide(side) ??
            this.pickInnermostHiddenAngelShieldOnSide(side)
          : this.vaultShieldMeshes[side] ?? null;
      if (!strip) continue;
      strip.getWorldPosition(mid);
      let sx = mid.x - cx;
      let sz = mid.z - cz;
      const sl = Math.hypot(sx, sz);
      if (sl <= 1e-8) continue;
      sx /= sl;
      sz /= sl;
      const score = sx * inX + sz * inZ;
      if (score > bestScore) {
        bestScore = score;
        bestSide = side;
      }
    }
    return bestSide;
  }

  private pickOutermostVisibleAngelShieldOnSide(side: number): THREE.Mesh | null {
    if (!this.vaultShieldMeshes) return null;
    let best: THREE.Mesh | null = null;
    let bestLayer = -1;
    for (const strip of this.vaultShieldMeshes) {
      if (!strip.visible || strip.userData.shieldSide !== side) continue;
      const layer = Number(strip.userData.shieldLayer ?? 0);
      if (layer > bestLayer) {
        bestLayer = layer;
        best = strip;
      }
    }
    return best;
  }

  private pickInnermostHiddenAngelShieldOnSide(side: number): THREE.Mesh | null {
    if (!this.vaultShieldMeshes) return null;
    let best: THREE.Mesh | null = null;
    let bestLayer = Number.POSITIVE_INFINITY;
    for (const strip of this.vaultShieldMeshes) {
      if (strip.visible || strip.userData.shieldSide !== side) continue;
      const layer = Number(strip.userData.shieldLayer ?? 0);
      if (layer < bestLayer) {
        bestLayer = layer;
        best = strip;
      }
    }
    return best;
  }

  private isAngelShieldSideOpen(side: number): boolean {
    if (!this.vaultShieldMeshes) return false;
    return !this.vaultShieldMeshes.some(
      (strip) => strip.userData.shieldSide === side && strip.visible,
    );
  }

  /**
   * Angel-only gate: dash body damage while shields are up is allowed only when
   * the attack approaches from an already-open (broken) side.
   */
  canDashDamageFromOpenShieldSide(seg: DashSweepSeg, joinRadius: number): boolean {
    if (this.kind !== 'angel' || !this.vaultShieldMeshes || this.vaultShieldMeshes.length <= 0) {
      return false;
    }
    return this.pickShieldHitByDash(seg, joinRadius, false) !== null;
  }

  applyDamage(amount: number, bypassShieldGate = false): boolean {
    const n = Math.max(0, Math.floor(amount));
    if (n <= 0) return false;
    if ((this.kind === 'vault' || this.kind === 'angel') && this.getActiveShieldCount() > 0 && !bypassShieldGate) {
      return false;
    }
    this.hitsRemaining -= n;
    this.syncTankOutlinesToHp();
    return this.hitsRemaining <= 0;
  }

  private syncTankOutlinesToHp(): void {
    if (this.kind !== 'tank' || this.tankOutlines.length <= 0) return;
    const visibleCount = Math.max(0, this.hitsRemaining - 1);
    for (let i = 0; i < this.tankOutlines.length; i++) {
      this.tankOutlines[i]!.visible = i < visibleCount;
    }
  }

  takeDashHit(bypassShieldGate = false): boolean {
    return this.applyDamage(1, bypassShieldGate);
  }

  /** Tank only: queue one dash body hit after `CONFIG.tankDashDamageDelayMs`. */
  scheduleDeferredTankDashDamage(): void {
    if (this.kind !== 'tank') return;
    this.pendingTankDashDamageAt.push(performance.now() + CONFIG.tankDashDamageDelayMs);
  }

  /**
   * Apply due deferred tank dash damage. Call from Game each frame.
   * @returns true if this unit died and should be removed from the arena.
   */
  tickDeferredTankDashDamage(): boolean {
    if (this.kind !== 'tank' || this.pendingTankDashDamageAt.length === 0) return false;
    const now = performance.now();
    let died = false;
    while (this.pendingTankDashDamageAt.length > 0 && now >= this.pendingTankDashDamageAt[0]!) {
      this.pendingTankDashDamageAt.shift();
      if (this.hitsRemaining <= 0) {
        this.pendingTankDashDamageAt.length = 0;
        break;
      }
      if (this.takeDashHit()) {
        died = true;
        this.pendingTankDashDamageAt.length = 0;
        break;
      }
    }
    return died;
  }

  update(
    dt: number,
    targetX: number,
    targetZ: number,
    speedMultiplier = 1,
    storageObstacles: readonly StorageObstacleCircle[] | null = null,
  ): void {
    this.faceTarget(targetX, targetZ);
    if (this.kind === 'vault' || this.kind === 'goldSack' || this.kind === 'manaSack') {
      return;
    }
    let mx = targetX - this.mesh.position.x;
    let mz = targetZ - this.mesh.position.z;
    let len = Math.hypot(mx, mz);
    let steerTargetX = targetX;
    let steerTargetZ = targetZ;
    if (this.kind === 'shooter' && len > 1e-4) {
      const desired = CONFIG.shooterKeepDistance;
      if (len < desired * 0.85) {
        mx = -mx;
        mz = -mz;
        steerTargetX = this.mesh.position.x + mx;
        steerTargetZ = this.mesh.position.z + mz;
      } else if (len <= desired * 1.08) {
        mx = 0;
        mz = 0;
      }
      len = Math.hypot(mx, mz);
    }
    if (len > 1e-4 && storageObstacles && storageObstacles.length > 0) {
      const dir = computeEnemyMoveDirectionAvoidingStorages(
        this.mesh.position.x,
        this.mesh.position.z,
        steerTargetX,
        steerTargetZ,
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
      const tankMult =
        this.kind === 'tank' || this.kind === 'angel' ? CONFIG.tankEnemyMoveSpeedMult : 1;
      const s = (CONFIG.enemySpeed * sm * tankMult * dt) / len;
      this.mesh.position.x += mx * s;
      this.mesh.position.z += mz * s;
    }
    const c = clampToArena(this.mesh.position.x, this.mesh.position.z);
    this.mesh.position.x = c.x;
    this.mesh.position.z = c.z;
    this.tickAngelShieldRegen(dt);
  }

  faceTarget(targetX: number, targetZ: number): void {
    if (!this.facingSpritePivot) return;
    const dx = targetX - this.mesh.position.x;
    const dz = targetZ - this.mesh.position.z;
    if (Math.hypot(dx, dz) <= 1e-4) return;
    this.facingSpritePivot.rotation.y = Math.atan2(dx, dz);
  }

  showDeathSprite(): void {
    if (!this.spriteMat) return;
    const url = ENEMY_DEATH_SPRITE_URLS[this.kind];
    if (!url) return;
    const oldMap = this.spriteMat.map;
    const tex = ENEMY_TEXTURE_LOADER.load(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.spriteMat.map = tex;
    this.spriteMat.needsUpdate = true;
    oldMap?.dispose();
  }

  tickShooterShotCooldown(dt: number): boolean {
    if (this.kind !== 'shooter') return false;
    this.shooterShotCooldownSec -= Math.max(0, dt);
    if (this.shooterShotCooldownSec > 0) return false;
    this.shooterShotCooldownSec += CONFIG.shooterShotIntervalSec;
    if (this.shooterShotCooldownSec <= 0) {
      this.shooterShotCooldownSec = CONFIG.shooterShotIntervalSec;
    }
    return true;
  }

  /** Passive shield regen tick for Angel (safe no-op for other kinds). */
  tickAngelShieldRegenOnly(dt: number): void {
    this.tickAngelShieldRegen(dt);
  }

  private tickAngelShieldRegen(dt: number): void {
    if (this.kind !== 'angel' || !this.vaultShieldMeshes) return;
    if (this.getActiveShieldCount() >= this.vaultShieldMeshes.length) {
      this.angelShieldRegenAccSec = 0;
      return;
    }
    this.angelShieldRegenAccSec += Math.max(0, dt);
    const step = Math.max(1e-4, CONFIG.angelShieldRegenSec);
    while (this.angelShieldRegenAccSec >= step) {
      this.angelShieldRegenAccSec -= step;
      const dead = this.vaultShieldMeshes.find((m) => !m.visible);
      if (!dead) break;
      dead.visible = true;
    }
  }

  dispose(scene: THREE.Scene): void {
    this.pendingTankDashDamageAt.length = 0;
    this.vaultLastClipDashSerial = 0;
    scene.remove(this.mesh);
    disposeObject3DTree(this.mesh);
  }
}
