import * as THREE from 'three';
import { CONFIG, isDebugDashPastTankEnabled } from './config.ts';
import {
  getDashDurationSec,
  getDashCooldownSec,
  getDashNominalLengthWorld,
  getEffectiveDashSpeed,
  getPlayerMaxHp,
  getPlayerSpeed,
} from './BalanceSettings.ts';
import type { Input } from './Input.ts';
import { clampToArena, circlesOverlap, rayExitFromCircleXZ } from './Collision.ts';
import { Dash } from './Dash.ts';
import type { Enemy } from './Enemy.ts';
import { getGameTexture } from './TextureCache.ts';

export type DashSweepSegment = { ax: number; az: number; bx: number; bz: number };

export type SpiralDashInput =
  | { mode: 'path'; points: readonly { x: number; z: number }[]; drawDurationSec: number }
  | { mode: 'click'; x: number; z: number };

const PLAYER_IDLE_TEXTURE = getGameTexture('/assets/player/player_idle_1.webp');
const PLAYER_DASH_TEXTURE = getGameTexture('/assets/player/player_dash_1.webp');
const PLAYER_STEP_1_TEXTURE = getGameTexture('/assets/player/player_step_1.webp');
const PLAYER_STEP_2_TEXTURE = getGameTexture('/assets/player/player_step_2.webp');
const PLAYER_STEP_3_TEXTURE = getGameTexture('/assets/player/player_step_3.webp');
const PLAYER_STEP_4_TEXTURE = getGameTexture('/assets/player/player_step_4.webp');

export class Player {
  readonly mesh: THREE.Group;
  private readonly body: THREE.Mesh;
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly ring: THREE.Mesh;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly aimPivot: THREE.Group;
  private readonly spritePivot: THREE.Group;
  private readonly sprite: THREE.Mesh;
  private readonly spriteMat: THREE.MeshBasicMaterial;
  private currentSpriteMode: 'idle' | 'dash' | 'walk1' | 'walk2' | 'walk3' | 'walk4' = 'idle';
  private spriteWalkTimeSec = 0;
  private spriteWalkingThisFrame = false;
  readonly dash = new Dash();

  private readonly trailPoints: THREE.Vector3[] = [];
  /** Preallocated ribbon vertices: (maxPoints-1) segments × 2 tris × 3 verts × xyz */
  private readonly trailPositions: Float32Array;
  private readonly trailRibbonGeo: THREE.BufferGeometry;
  private readonly trailRibbon: THREE.Mesh;
  private readonly tailPoint: THREE.Mesh;
  private readonly tailRibbonSegmentCount = 8;
  private readonly tailRibbonPositions = new Float32Array(8 * 6 * 3);
  private readonly tailRibbonGeo: THREE.BufferGeometry;
  private readonly tailRibbon: THREE.Mesh;
  private readonly secondTailPoint: THREE.Mesh;
  private readonly secondTailRibbonPositions = new Float32Array(8 * 6 * 3);
  private readonly secondTailRibbonGeo: THREE.BufferGeometry;
  private readonly secondTailRibbon: THREE.Mesh;
  private readonly tailBase = new THREE.Vector3();
  private readonly tailVisual = new THREE.Vector3();
  private readonly secondTailBase = new THREE.Vector3();
  private readonly secondTailVisual = new THREE.Vector3();
  private tailDirX = 0;
  private tailDirZ = -1;
  private tailWagOffsetA = 0;
  private tailWagOffsetB = 0;
  private tailMotionAmount = 0;
  private secondTailMotionAmount = 0;

  hp: number = getPlayerMaxHp();

  private lastAimDirX = 0;
  private lastAimDirZ = -1;

  /** Remaining post-dash invulnerability (seconds). */
  private postDashInvulnLeft = 0;
  /** Remaining invulnerability after taking damage (seconds). */
  private damageInvulnLeft = 0;

  /** Backward micro-dash after main dash (seconds remaining). */
  private microDashTimeLeft = 0;
  /** Speed (world units/s) opposite to main dash direction during micro-dash. */
  private microDashSpeed = 0;
  /** Distance traveled this main dash (for micro-dash length). */
  private mainDashTravel = 0;
  /** Remaining enemy freeze window from dash start (seconds). */
  private dashEnemyFreezeLeft = 0;

  /** Segment for this frame's dash movement (world XZ), for kill checks. */
  private dashSweep: DashSweepSegment | null = null;
  private spiralDashPath: { x: number; z: number }[] | null = null;
  private spiralDashPathIndex = 0;
  private spiralTeleportStartedThisFrame = false;
  /** Set each frame from Game when Spiral artifact is unlocked (no dash enemy-freeze). */
  private spiralArtifactActive = false;

  /** True while building the current dash polyline (reset when dash ends). */
  private dashTrailBuilding = false;

  /** Set on the frame main dash begins; consumed by Game for beat timing. */
  private mainDashStartedThisFrame = false;

  /** Length & trail width scale for the current main dash (e.g. on-beat ×2). */
  private activeDashLenWidthMult = 1;

  /**
   * Increments on each new main dash start. Dash kills use it so each enemy
   * takes at most one dash-hit per dash (not once per animation frame).
   */
  private dashHitSerial = 0;

  /** True during the auto reverse dash from the Reverse Dash artifact (after a normal dash). */
  private artifactReverseDashInProgress = false;

  /** Set when a main dash segment ends (landing XZ); consumed by Game for Bomb artifact pulse. */
  private pendingDashLandPulse: { x: number; z: number } | null = null;

  /** Time without damage toward next passive shield (seconds). */
  private shieldRegenNoDamageSec = 0;
  /** Current regen interval (seconds); reduced by in-run upgrades, reset on new run. */
  private shieldRegenIntervalSec: number = CONFIG.shieldRegenBaseIntervalSec;

  /**
   * Dash hit tank / vault clip: glide from current XZ to exit (same target as old snap), then resume main dash.
   * Wall-clock timing.
   */
  private tankClipSlideActive = false;
  private tankClipSlideStartMs = 0;
  private tankClipSlideDurSec = 0;
  private tankClipSlideFromX = 0;
  private tankClipSlideFromZ = 0;
  private tankClipSlideToX = 0;
  private tankClipSlideToZ = 0;
  private tankClipResumeTimeLeft = 0;
  private tankClipResumeEnemyFreeze = 0;
  private tankClipResumeLenMult = 1;

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.Group();
    this.mesh.position.y = CONFIG.floorY + CONFIG.playerRadius;

    const geo = new THREE.CapsuleGeometry(
      CONFIG.playerRadius * 0.55,
      CONFIG.playerRadius * 1.1,
      6,
      12,
    );
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: 0x1a3d5c,
      emissive: 0x22aaff,
      emissiveIntensity: 0.85,
      metalness: 0.2,
      roughness: 0.35,
    });
    this.body = new THREE.Mesh(geo, this.bodyMat);
    this.body.castShadow = true;
    this.body.renderOrder = 5;
    this.body.visible = false;
    this.mesh.add(this.body);

    this.spriteMat = new THREE.MeshBasicMaterial({
      map: PLAYER_IDLE_TEXTURE,
      transparent: true,
      alphaTest: 0.08,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const spriteSize = CONFIG.playerRadius * 6.4;
    this.sprite = new THREE.Mesh(
      new THREE.PlaneGeometry(spriteSize, spriteSize),
      this.spriteMat,
    );
    this.sprite.rotation.x = -Math.PI / 2;
    this.sprite.position.y = -CONFIG.playerRadius + 0.12;
    this.sprite.renderOrder = 9;
    this.spritePivot = new THREE.Group();
    this.spritePivot.add(this.sprite);
    this.mesh.add(this.spritePivot);

    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0x66ccff,
      transparent: true,
      opacity: 0.5,
    });
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(CONFIG.playerRadius * 1.05, 0.04, 8, 32),
      this.ringMat,
    );
    this.ring.rotation.x = Math.PI / 2;
    this.ring.position.y = -CONFIG.playerRadius * 0.2;
    this.ring.visible = false;
    this.mesh.add(this.ring);

    this.aimPivot = new THREE.Group();
    this.aimPivot.position.set(0, -CONFIG.playerRadius * 0.82, 0);
    const z0 = CONFIG.playerRadius * 0.28;
    const z1 = CONFIG.playerRadius * 0.28 + 0.52;
    const aimGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.02, z0),
      new THREE.Vector3(0, 0.02, z1),
    ]);
    const aimLine = new THREE.Line(
      aimGeo,
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92 }),
    );
    aimLine.visible = false;
    this.aimPivot.add(aimLine);
    this.mesh.add(this.aimPivot);

    const maxSeg = Math.max(1, CONFIG.dashTrailMaxPoints - 1);
    this.trailPositions = new Float32Array(maxSeg * 6 * 3);
    this.trailRibbonGeo = new THREE.BufferGeometry();
    this.trailRibbonGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.trailPositions, 3),
    );
    const trailMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.94,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.trailRibbon = new THREE.Mesh(this.trailRibbonGeo, trailMat);
    this.trailRibbon.visible = false;
    this.trailRibbon.frustumCulled = false;
    this.trailRibbon.renderOrder = 10;
    scene.add(this.trailRibbon);

    const tailMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
      depthTest: false,
      depthWrite: false,
    });
    this.tailPoint = new THREE.Mesh(
      new THREE.SphereGeometry(CONFIG.playerRadius * 0.16, 10, 8),
      tailMat,
    );
    this.tailPoint.frustumCulled = false;
    this.tailPoint.renderOrder = 8;
    this.tailPoint.visible = false;
    scene.add(this.tailPoint);

    this.tailRibbonGeo = new THREE.BufferGeometry();
    this.tailRibbonGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.tailRibbonPositions, 3),
    );
    this.tailRibbon = new THREE.Mesh(
      this.tailRibbonGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.86,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.tailRibbon.frustumCulled = false;
    this.tailRibbon.renderOrder = 7;
    this.tailRibbon.visible = false;
    scene.add(this.tailRibbon);

    this.secondTailPoint = new THREE.Mesh(
      new THREE.SphereGeometry(CONFIG.playerRadius * 0.11, 10, 8),
      tailMat.clone(),
    );
    this.secondTailPoint.frustumCulled = false;
    this.secondTailPoint.renderOrder = 8;
    this.secondTailPoint.visible = false;
    scene.add(this.secondTailPoint);

    this.secondTailRibbonGeo = new THREE.BufferGeometry();
    this.secondTailRibbonGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(this.secondTailRibbonPositions, 3),
    );
    this.secondTailRibbon = new THREE.Mesh(
      this.secondTailRibbonGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.78,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.secondTailRibbon.frustumCulled = false;
    this.secondTailRibbon.renderOrder = 7;
    this.secondTailRibbon.visible = false;
    scene.add(this.secondTailRibbon);
    this.resetTailVisual();

    scene.add(this.mesh);
  }

  get x(): number {
    return this.mesh.position.x;
  }
  get z(): number {
    return this.mesh.position.z;
  }

  get dashCooldownRemaining(): number {
    return this.dash.cooldownLeft;
  }

  get isDashing(): boolean {
    return this.dash.timeLeft > 0 || this.tankClipSlideActive;
  }

  isInvulnerable(): boolean {
    return (
      this.postDashInvulnLeft > 0 ||
      this.damageInvulnLeft > 0 ||
      this.dash.timeLeft > 0 ||
      this.microDashTimeLeft > 0 ||
      this.tankClipSlideActive
    );
  }

  areEnemiesFrozenByDash(): boolean {
    if (this.spiralArtifactActive) return false;
    return this.dashEnemyFreezeLeft > 0;
  }

  get isMicroDashing(): boolean {
    return this.microDashTimeLeft > 0;
  }

  getDashHitSerial(): number {
    return this.dashHitSerial;
  }

  forceStartAutoDashToward(targetX: number, targetZ: number, durationMult = 1): boolean {
    if (this.hp <= 0 || this.isDashing || this.microDashTimeLeft > 0) return false;
    let dx = targetX - this.mesh.position.x;
    let dz = targetZ - this.mesh.position.z;
    const len = Math.hypot(dx, dz);
    if (len <= 1e-4) return false;
    dx /= len;
    dz /= len;
    const mult = Number.isFinite(durationMult) && durationMult > 0 ? durationMult : 1;
    this.dash.dirX = dx;
    this.dash.dirZ = dz;
    this.dash.timeLeft = getDashDurationSec() * mult;
    this.dash.cooldownLeft = getDashCooldownSec();
    if (!this.spiralArtifactActive) {
      this.dashEnemyFreezeLeft = getDashDurationSec() * mult;
    }
    this.activeDashLenWidthMult = mult;
    this.dashHitSerial += 1;
    this.lastAimDirX = dx;
    this.lastAimDirZ = dz;
    this.mainDashStartedThisFrame = false;
    this.artifactReverseDashInProgress = false;
    this.microDashTimeLeft = 0;
    this.dashTrailBuilding = false;
    this.spiralDashPath = null;
    this.spiralDashPathIndex = 0;
    this.trailPoints.length = 0;
    return true;
  }

  getProjectedDashEndXZ(): { x: number; z: number } {
    if (
      this.dash.timeLeft <= 0 ||
      this.artifactReverseDashInProgress ||
      this.tankClipSlideActive
    ) {
      return { x: this.mesh.position.x, z: this.mesh.position.z };
    }
    const remainingDist = getEffectiveDashSpeed() * this.dash.timeLeft;
    return clampToArena(
      this.mesh.position.x + this.dash.dirX * remainingDist,
      this.mesh.position.z + this.dash.dirZ * remainingDist,
    );
  }

  /** Clears post-dash cooldown (on-beat dash, clip/slide past tank or vault, overlap snap). */
  clearDashCooldownAfterOnBeatHit(): void {
    this.dash.cooldownLeft = 0;
  }

  private startSpiralClickTeleport(
    x: number,
    z: number,
    aimX: number,
    aimZ: number,
  ): void {
    const start = clampToArena(x, z);
    this.mesh.position.x = start.x;
    this.mesh.position.z = start.z;
    this.spiralTeleportStartedThisFrame = true;
    this.spiralDashPath = null;
    this.spiralDashPathIndex = 0;
    this.dashTrailBuilding = false;
    this.trailPoints.length = 0;
    const len = Math.hypot(aimX, aimZ);
    if (len > 1e-5) {
      this.dash.dirX = aimX / len;
      this.dash.dirZ = aimZ / len;
    }
  }

  private static polylineLengthXZ(points: readonly { x: number; z: number }[]): number {
    let len = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      len += Math.hypot(b.x - a.x, b.z - a.z);
    }
    return len;
  }

  private startSpiralDashPath(
    points: readonly { x: number; z: number }[],
    drawDurationSec: number,
  ): void {
    const start = clampToArena(points[0]!.x, points[0]!.z);
    this.mesh.position.x = start.x;
    this.mesh.position.z = start.z;
    this.spiralTeleportStartedThisFrame = true;
    const path: { x: number; z: number }[] = [{ x: start.x, z: start.z }];
    let used = 0;
    let prev = path[0]!;
    const maxDist = Math.max(0.5, CONFIG.spiralPathMaxLengthWorld);
    const minSeg = 0.08;
    for (let i = 1; i < points.length; i++) {
      const p = clampToArena(points[i]!.x, points[i]!.z);
      const dx = p.x - prev.x;
      const dz = p.z - prev.z;
      const d = Math.hypot(dx, dz);
      if (d < minSeg) continue;
      if (used + d > maxDist) {
        const remain = maxDist - used;
        if (remain > minSeg) {
          path.push({ x: prev.x + (dx / d) * remain, z: prev.z + (dz / d) * remain });
        }
        break;
      }
      path.push({ x: p.x, z: p.z });
      used += d;
      prev = path[path.length - 1]!;
    }
    if (path.length < 2) {
      this.spiralDashPath = null;
      this.spiralDashPathIndex = 0;
      return;
    }
    this.spiralDashPath = path;
    this.spiralDashPathIndex = 1;
    this.dashTrailBuilding = false;
    this.trailPoints.length = 0;
    const next = path[1]!;
    const dx = next.x - this.mesh.position.x;
    const dz = next.z - this.mesh.position.z;
    const len = Math.hypot(dx, dz);
    if (len > 1e-5) {
      this.dash.dirX = dx / len;
      this.dash.dirZ = dz / len;
    }
    const pathLen = Player.polylineLengthXZ(path);
    const speed = Math.max(1e-3, getEffectiveDashSpeed());
    const drawSec = Number.isFinite(drawDurationSec) && drawDurationSec > 0 ? drawDurationSec : 0;
    const drawBonus = drawSec * CONFIG.spiralDrawTimeToDashTimeMult;
    const duration = THREE.MathUtils.clamp(
      pathLen / speed + drawBonus,
      CONFIG.spiralMinDashSec,
      CONFIG.spiralMaxDashSec,
    );
    this.dash.timeLeft = duration;
  }

  private advanceAlongSpiralDash(distance: number): void {
    let remaining = Math.max(0, distance);
    while (remaining > 1e-6 && this.spiralDashPath && this.spiralDashPathIndex < this.spiralDashPath.length) {
      const target = this.spiralDashPath[this.spiralDashPathIndex]!;
      const dx = target.x - this.mesh.position.x;
      const dz = target.z - this.mesh.position.z;
      const d = Math.hypot(dx, dz);
      if (d <= 1e-5) {
        this.spiralDashPathIndex += 1;
        continue;
      }
      this.dash.dirX = dx / d;
      this.dash.dirZ = dz / d;
      const step = Math.min(remaining, d);
      this.mesh.position.x += this.dash.dirX * step;
      this.mesh.position.z += this.dash.dirZ * step;
      remaining -= step;
      if (step >= d - 1e-5) {
        this.spiralDashPathIndex += 1;
      }
    }
    if (this.spiralDashPath && this.spiralDashPathIndex >= this.spiralDashPath.length) {
      this.spiralDashPath = null;
    }
  }

  /**
   * Dash damage vs tank / large vault: pause main dash (`dash.timeLeft` → 0), glide to exit
   * along chord over `CONFIG.dashPastTankClipSlideDurationMs` (does not change main-dash speed),
   * then restore remaining main-dash time (capped), freeze timer, and length mult so movement
   * and trail continue as one dash.
   * Optional `minAlongDashFromObstacleCenter`: push at least this far from obstacle center along dash (vault).
   */
  clipDashPastTank(
    tankX: number,
    tankZ: number,
    tankBodyRadius: number,
    minAlongDashFromObstacleCenter?: number,
  ): void {
    if (this.tankClipSlideActive) return;
    // Do not require dash.timeLeft > 0: resolveDashKills runs before tickDashAfterHits; last-tick kills can have timeLeft === 0 while the sweep still hits.
    const debug = isDebugDashPastTankEnabled();
    const timeLeftBeforeCap = debug ? this.dash.timeLeft : 0;
    const mult = this.activeDashLenWidthMult;
    const cap =
      getDashDurationSec() * mult * CONFIG.dashPastTankRemainingFraction;
    const resumeTime = Math.min(this.dash.timeLeft, cap);

    const exit = this.computeDashPastTankExitXZ(
      tankX,
      tankZ,
      tankBodyRadius,
      minAlongDashFromObstacleCenter,
    );
    const fx = this.mesh.position.x;
    const fz = this.mesh.position.z;
    const dist = Math.hypot(exit.x - fx, exit.z - fz);
    const durationMs = CONFIG.dashPastTankClipSlideDurationMs;

    if (dist < 1e-5) {
      this.snapDashPastTankPosition(
        tankX,
        tankZ,
        tankBodyRadius,
        minAlongDashFromObstacleCenter,
      );
      this.dash.timeLeft = resumeTime;
      this.clearDashCooldownAfterOnBeatHit();
      if (debug) {
        console.log('[dash-past-tank] clipDashPastTank instant', {
          tankX,
          tankZ,
          tankBodyRadius,
          timeLeftBeforeCap,
          timeLeftAfterClip: this.dash.timeLeft,
          remainingCap: cap,
          activeDashLenWidthMult: mult,
        });
      }
      return;
    }

    if (!(durationMs > 0)) {
      this.snapDashPastTankPosition(
        tankX,
        tankZ,
        tankBodyRadius,
        minAlongDashFromObstacleCenter,
      );
      this.dash.timeLeft = resumeTime;
      this.clearDashCooldownAfterOnBeatHit();
      if (debug) {
        console.log('[dash-past-tank] clipDashPastTank instant', {
          tankX,
          tankZ,
          tankBodyRadius,
          timeLeftBeforeCap,
          timeLeftAfterClip: this.dash.timeLeft,
          remainingCap: cap,
          activeDashLenWidthMult: mult,
        });
      }
      return;
    }

    const dur = durationMs / 1000;

    this.tankClipSlideFromX = fx;
    this.tankClipSlideFromZ = fz;
    this.tankClipSlideToX = exit.x;
    this.tankClipSlideToZ = exit.z;
    this.tankClipSlideStartMs = performance.now();
    this.tankClipSlideDurSec = dur;
    this.tankClipResumeTimeLeft = resumeTime;
    this.tankClipResumeEnemyFreeze = this.spiralArtifactActive ? 0 : this.dashEnemyFreezeLeft;
    this.tankClipResumeLenMult = mult;
    this.tankClipSlideActive = true;
    this.dash.timeLeft = 0;
    this.dashSweep = null;

    if (debug) {
      console.log('[dash-past-tank] clipDashPastTank slide', {
        tankX,
        tankZ,
        tankBodyRadius,
        timeLeftBeforeCap,
        resumeDashAfterSlide: resumeTime,
        remainingCap: cap,
        dist,
        durSec: dur,
        durationMs,
      });
    }
  }

  /**
   * If still overlapping a tank while main-dashing (e.g. tangential clip), push past
   * without changing dash timer — call after `resolveDashKills` each frame.
   */
  resolveTankOverlapWhileDashing(enemies: readonly Enemy[]): void {
    if (this.tankClipSlideActive) return;
    if (!this.dash.isDashingForMovement()) return;
    for (const e of enemies) {
      if (!e.isTank() && !e.isAngel()) continue;
      const tx = e.mesh.position.x;
      const tz = e.mesh.position.z;
      const tr = e.bodyRadius;
      if (
        !circlesOverlap(
          this.mesh.position.x,
          this.mesh.position.z,
          CONFIG.playerRadius,
          tx,
          tz,
          tr,
        )
      ) {
        continue;
      }
      this.snapDashPastTankPosition(tx, tz, tr);
      this.clearDashCooldownAfterOnBeatHit();
    }
  }

  private snapDashPastTankPosition(
    tankX: number,
    tankZ: number,
    tankBodyRadius: number,
    minAlongDashFromObstacleCenter?: number,
  ): void {
    const p = this.computeDashPastTankExitXZ(
      tankX,
      tankZ,
      tankBodyRadius,
      minAlongDashFromObstacleCenter,
    );
    this.mesh.position.x = p.x;
    this.mesh.position.z = p.z;
  }

  /** Exit XZ for dash clip past tank/vault obstacle (same geometry as legacy snap). */
  private computeDashPastTankExitXZ(
    tankX: number,
    tankZ: number,
    tankBodyRadius: number,
    minAlongDashFromObstacleCenter?: number,
  ): { x: number; z: number } {
    const ox = this.mesh.position.x;
    const oz = this.mesh.position.z;
    const margin = CONFIG.dashPastTankBehindOffset;
    const exitR = tankBodyRadius + CONFIG.playerRadius + margin;
    let behind =
      tankBodyRadius + CONFIG.playerRadius + margin;
    if (
      minAlongDashFromObstacleCenter !== undefined &&
      Number.isFinite(minAlongDashFromObstacleCenter) &&
      minAlongDashFromObstacleCenter > behind
    ) {
      behind = minAlongDashFromObstacleCenter;
    }

    const rayHit = rayExitFromCircleXZ(
      ox,
      oz,
      this.dash.dirX,
      this.dash.dirZ,
      tankX,
      tankZ,
      exitR,
    );

    let nx: number;
    let nz: number;
    if (rayHit) {
      const vx = ox - tankX;
      const vz = oz - tankZ;
      const dLen = Math.hypot(this.dash.dirX, this.dash.dirZ);
      const inv = dLen > 1e-10 ? 1 / dLen : 0;
      const dnx = this.dash.dirX * inv;
      const dnz = this.dash.dirZ * inv;
      const vd = vx * dnx + vz * dnz;
      let t = rayHit.t;
      if (
        minAlongDashFromObstacleCenter !== undefined &&
        Number.isFinite(minAlongDashFromObstacleCenter)
      ) {
        const tAlong = minAlongDashFromObstacleCenter - vd;
        if (tAlong > t) t = tAlong;
      }
      nx = ox + dnx * t;
      nz = oz + dnz * t;
    } else {
      nx = tankX + this.dash.dirX * behind;
      nz = tankZ + this.dash.dirZ * behind;
    }

    return clampToArena(nx, nz);
  }

  /** Full reset for a new run (menu / after death). */
  resetForNewRun(): void {
    this.tankClipSlideActive = false;
    this.hp = getPlayerMaxHp();
    this.mesh.position.set(0, CONFIG.floorY + CONFIG.playerRadius, 0);
    this.dash.reset();
    this.postDashInvulnLeft = 0;
    this.damageInvulnLeft = 0;
    this.microDashTimeLeft = 0;
    this.microDashSpeed = 0;
    this.mainDashTravel = 0;
    this.dashEnemyFreezeLeft = 0;
    this.dashSweep = null;
    this.dashTrailBuilding = false;
    this.spiralDashPath = null;
    this.spiralDashPathIndex = 0;
    this.spiralTeleportStartedThisFrame = false;
    this.mainDashStartedThisFrame = false;
    this.activeDashLenWidthMult = 1;
    this.dashHitSerial = 0;
    this.artifactReverseDashInProgress = false;
    this.pendingDashLandPulse = null;
    this.shieldRegenNoDamageSec = 0;
    this.shieldRegenIntervalSec = CONFIG.shieldRegenBaseIntervalSec;
    this.trailPoints.length = 0;
    this.trailRibbonGeo.setDrawRange(0, 0);
    this.trailRibbon.visible = false;
    this.resetTailVisual();
    this.lastAimDirX = 0;
    this.lastAimDirZ = -1;
    this.applyNormalColors();
  }

  /** Sweep segment for dash kills this frame; consumed by Game after reading. */
  consumeDashSweep(): DashSweepSegment | null {
    const s = this.dashSweep;
    this.dashSweep = null;
    return s;
  }

  /** True once when a new main dash starts this frame (then cleared). */
  consumeMainDashStarted(): boolean {
    const v = this.mainDashStartedThisFrame;
    this.mainDashStartedThisFrame = false;
    return v;
  }

  /** Landing XZ of the last finished main-dash segment, or null (Bomb artifact). */
  consumeDashLandingPulseXZ(): { x: number; z: number } | null {
    const p = this.pendingDashLandPulse;
    this.pendingDashLandPulse = null;
    return p;
  }

  consumeSpiralTeleportStarted(): boolean {
    const v = this.spiralTeleportStartedThisFrame;
    this.spiralTeleportStartedThisFrame = false;
    return v;
  }

  /**
   * Run after `resolveDashKills` so `clipDashPastTank` can still see `dash.timeLeft > 0` on the frame a sweep hits.
   */
  tickDashAfterHits(dt: number, reverseDashArtifactEnabled: boolean): void {
    this.damageInvulnLeft = Math.max(0, this.damageInvulnLeft - dt);
    if (this.tankClipSlideActive) {
      this.postDashInvulnLeft = Math.max(0, this.postDashInvulnLeft - dt);
      this.applyInvulnVisualAndPulse();
      return;
    }

    if (this.hp <= 0) {
      return;
    }

    const beforeTick = this.dash.timeLeft;
    this.dash.tickAfterMove(dt);

    if (beforeTick > 0 && this.dash.timeLeft <= 0) {
      this.pendingDashLandPulse = {
        x: this.mesh.position.x,
        z: this.mesh.position.z,
      };
      const mult =
        Number.isFinite(this.activeDashLenWidthMult) && this.activeDashLenWidthMult > 0
          ? this.activeDashLenWidthMult
          : 1;
      const dirX = this.dash.dirX;
      const dirZ = this.dash.dirZ;

      if (this.artifactReverseDashInProgress) {
        this.artifactReverseDashInProgress = false;
        if (CONFIG.microDashEnabled) {
          const backDist =
            CONFIG.microDashDistanceFraction * this.mainDashTravel;
          if (backDist > 1e-4) {
            this.microDashTimeLeft = CONFIG.microDashDuration;
            this.microDashSpeed = backDist / CONFIG.microDashDuration;
          } else {
            this.postDashInvulnLeft = CONFIG.postDashInvulnerability;
          }
        } else {
          this.postDashInvulnLeft = CONFIG.postDashInvulnerability;
        }
      } else if (reverseDashArtifactEnabled) {
        const nx = -dirX;
        const nz = -dirZ;
        const len = Math.hypot(nx, nz);
        if (len > 1e-5) {
          this.dash.dirX = nx / len;
          this.dash.dirZ = nz / len;
          const revDur = Math.max(
            1e-4,
            Math.min(1, CONFIG.reverseDashArtifactDurationFraction),
          );
          this.dash.timeLeft = getDashDurationSec() * mult * revDur;
          this.dash.cooldownLeft = getDashCooldownSec();
          if (!this.spiralArtifactActive) {
            this.dashEnemyFreezeLeft = getDashDurationSec() * mult * revDur;
          }
          this.dashHitSerial += 1;
          this.artifactReverseDashInProgress = true;
        } else if (CONFIG.microDashEnabled) {
          const backDist =
            CONFIG.microDashDistanceFraction * this.mainDashTravel;
          if (backDist > 1e-4) {
            this.microDashTimeLeft = CONFIG.microDashDuration;
            this.microDashSpeed = backDist / CONFIG.microDashDuration;
          } else {
            this.postDashInvulnLeft = CONFIG.postDashInvulnerability;
          }
        } else {
          this.postDashInvulnLeft = CONFIG.postDashInvulnerability;
        }
      } else if (CONFIG.microDashEnabled) {
        const backDist =
          CONFIG.microDashDistanceFraction * this.mainDashTravel;
        if (backDist > 1e-4) {
          this.microDashTimeLeft = CONFIG.microDashDuration;
          this.microDashSpeed = backDist / CONFIG.microDashDuration;
        } else {
          this.postDashInvulnLeft = CONFIG.postDashInvulnerability;
        }
      } else {
        this.postDashInvulnLeft = CONFIG.postDashInvulnerability;
      }
    }

    if (CONFIG.microDashEnabled) {
      const wasInMicro = this.microDashTimeLeft > 0;
      this.microDashTimeLeft = Math.max(0, this.microDashTimeLeft - dt);
      if (wasInMicro && this.microDashTimeLeft <= 0) {
        this.postDashInvulnLeft = CONFIG.postDashInvulnerability;
      }
    }

    this.postDashInvulnLeft = Math.max(0, this.postDashInvulnLeft - dt);
    this.dashEnemyFreezeLeft = Math.max(0, this.dashEnemyFreezeLeft - dt);
    this.applyInvulnVisualAndPulse();
  }

  private applyInvulnVisualAndPulse(): void {
    if (this.isInvulnerable()) {
      this.bodyMat.color.setHex(0xffffff);
      this.bodyMat.emissive.setHex(0xffffff);
      this.bodyMat.emissiveIntensity = 0.4;
      this.ringMat.color.setHex(0xffffff);
      this.ringMat.opacity = 0.9;
    } else {
      this.applyNormalColors();
    }
    const pulse = 1 + Math.sin(performance.now() * 0.004) * 0.04;
    this.body.scale.setScalar(pulse);
  }

  private resetTailVisual(): void {
    const x = this.mesh.position.x - this.tailDirX * CONFIG.playerTailFollowDistance;
    const z = this.mesh.position.z - this.tailDirZ * CONFIG.playerTailFollowDistance;
    const sideX = -this.tailDirZ * CONFIG.playerRadius * 0.78;
    const sideZ = this.tailDirX * CONFIG.playerRadius * 0.78;
    const y = CONFIG.floorY + 0.2;
    this.tailBase.set(x, y, z);
    this.tailVisual.copy(this.tailBase);
    this.secondTailBase.set(
      this.mesh.position.x - this.tailDirX * CONFIG.playerTailFollowDistance * 0.5 + sideX,
      y,
      this.mesh.position.z - this.tailDirZ * CONFIG.playerTailFollowDistance * 0.5 + sideZ,
    );
    this.secondTailVisual.copy(this.secondTailBase);
    this.tailPoint.position.copy(this.tailVisual);
    this.secondTailPoint.position.copy(this.secondTailVisual);
    this.tailPoint.visible = this.hp > 0;
    this.tailRibbon.visible = this.hp > 0;
    this.secondTailPoint.visible = this.hp > 0;
    this.secondTailRibbon.visible = this.hp > 0;
    this.rebuildTailRibbon();
    this.rebuildSecondTailRibbon();
  }

  private updateTailVisual(dt: number, prevX: number, prevZ: number): void {
    if (this.hp <= 0) {
      this.tailPoint.visible = false;
      this.tailRibbon.visible = false;
      this.secondTailPoint.visible = false;
      this.secondTailRibbon.visible = false;
      return;
    }

    const px = this.mesh.position.x;
    const pz = this.mesh.position.z;
    const dx = px - prevX;
    const dz = pz - prevZ;
    const moveLen = Math.hypot(dx, dz);
    if (moveLen > 1e-4) {
      this.tailDirX = dx / moveLen;
      this.tailDirZ = dz / moveLen;
    }
    const moving = moveLen > 0.025;
    const longTailSettle = 0.15;
    const shortTailSettle = 0.1;
    const longTarget = moving ? 1 : 0;
    const shortTarget = moving ? 1 : 0;
    const longFollow = moving
      ? 1
      : 1 - Math.exp(-Math.max(0.001, 4.6 / longTailSettle) * dt);
    const shortFollow = moving
      ? 1
      : 1 - Math.exp(-Math.max(0.001, 4.6 / shortTailSettle) * dt);
    this.tailMotionAmount += (longTarget - this.tailMotionAmount) * longFollow;
    this.secondTailMotionAmount +=
      (shortTarget - this.secondTailMotionAmount) * shortFollow;

    const targetX = px - this.tailDirX * CONFIG.playerTailFollowDistance;
    const targetZ = pz - this.tailDirZ * CONFIG.playerTailFollowDistance;
    const sideX = -this.tailDirZ * CONFIG.playerRadius * 0.78;
    const sideZ = this.tailDirX * CONFIG.playerRadius * 0.78;
    const target2X = px - this.tailDirX * CONFIG.playerTailFollowDistance * 0.5 + sideX;
    const target2Z = pz - this.tailDirZ * CONFIG.playerTailFollowDistance * 0.5 + sideZ;
    const follow = 1 - Math.exp(-Math.max(0.001, CONFIG.playerTailFollowSharpness) * dt);
    this.tailBase.x += (targetX - this.tailBase.x) * follow;
    this.tailBase.z += (targetZ - this.tailBase.z) * follow;
    this.tailBase.y = CONFIG.floorY + 0.2;
    const follow2 = 1 - Math.exp(-Math.max(0.001, CONFIG.playerTailFollowSharpness * 1.25) * dt);
    this.secondTailBase.x += (target2X - this.secondTailBase.x) * follow2;
    this.secondTailBase.z += (target2Z - this.secondTailBase.z) * follow2;
    this.secondTailBase.y = CONFIG.floorY + 0.2;

    const time = performance.now() * 0.001;
    const phase = Math.PI * 2 * CONFIG.playerTailWagHz * time;
    const wag =
      (Math.sin(phase) +
        Math.sin(phase * 1.73 + 1.9) * 0.42 +
        Math.sin(phase * 0.57 + 4.1) * 0.28) *
      CONFIG.playerTailWagAmplitude *
      0.72 *
      this.tailMotionAmount;
    this.tailWagOffsetA =
      (Math.sin(phase * 1.31 + 0.7) + Math.sin(phase * 2.11 + 2.6) * 0.35) *
      CONFIG.playerTailWagAmplitude *
      0.85 *
      this.tailMotionAmount;
    this.tailWagOffsetB =
      (Math.sin(phase * 0.83 + 3.4) + Math.sin(phase * 1.91 + 0.2) * 0.48) *
      CONFIG.playerTailWagAmplitude *
      0.9 *
      this.tailMotionAmount;
    const perpX = -this.tailDirZ;
    const perpZ = this.tailDirX;
    this.tailVisual.set(
      this.tailBase.x + perpX * wag,
      this.tailBase.y,
      this.tailBase.z + perpZ * wag,
    );
    const wag2 =
      (Math.sin(phase * 1.18 + 1.3) + Math.sin(phase * 1.9 + 3.2) * 0.32) *
      CONFIG.playerTailWagAmplitude *
      0.36 *
      this.secondTailMotionAmount;
    this.secondTailVisual.set(
      this.secondTailBase.x + perpX * wag2,
      this.secondTailBase.y,
      this.secondTailBase.z + perpZ * wag2,
    );
    this.tailPoint.position.copy(this.tailVisual);
    this.secondTailPoint.position.copy(this.secondTailVisual);
    this.tailPoint.visible = true;
    this.tailRibbon.visible = true;
    this.secondTailPoint.visible = true;
    this.secondTailRibbon.visible = true;
    this.rebuildTailRibbon();
    this.rebuildSecondTailRibbon();
  }

  private rebuildTailRibbon(): void {
    const px = this.mesh.position.x - this.tailDirX * CONFIG.playerRadius * 0.25;
    const pz = this.mesh.position.z - this.tailDirZ * CONFIG.playerRadius * 0.25;
    const tx = this.tailVisual.x;
    const tz = this.tailVisual.z;
    const curvePerpX = -this.tailDirZ;
    const curvePerpZ = this.tailDirX;
    const bendA = this.tailWagOffsetA * CONFIG.playerTailCurveBendMult;
    const bendB = this.tailWagOffsetB * CONFIG.playerTailCurveBendMult;
    const c1x = px + (tx - px) * 0.33 + curvePerpX * bendA;
    const c1z = pz + (tz - pz) * 0.33 + curvePerpZ * bendA;
    const c2x = px + (tx - px) * 0.66 + curvePerpX * bendB;
    const c2z = pz + (tz - pz) * 0.66 + curvePerpZ * bendB;
    const halfPlayer = CONFIG.playerTailRibbonWidth * 0.34;
    const halfTail = CONFIG.playerTailRibbonWidth * 0.5;
    const y0 = CONFIG.floorY + 0.17;
    const y1 = CONFIG.floorY + 0.2;
    const arr = this.tailRibbonPositions;
    let o = 0;

    const sample = (t: number): { x: number; z: number; y: number; px: number; pz: number; w: number } => {
      const inv = 1 - t;
      const inv2 = inv * inv;
      const t2 = t * t;
      const x = inv2 * inv * px + 3 * inv2 * t * c1x + 3 * inv * t2 * c2x + t2 * t * tx;
      const z = inv2 * inv * pz + 3 * inv2 * t * c1z + 3 * inv * t2 * c2z + t2 * t * tz;
      const y = y0 + (y1 - y0) * t;
      let dx = 3 * inv2 * (c1x - px) + 6 * inv * t * (c2x - c1x) + 3 * t2 * (tx - c2x);
      let dz = 3 * inv2 * (c1z - pz) + 6 * inv * t * (c2z - c1z) + 3 * t2 * (tz - c2z);
      const len = Math.hypot(dx, dz);
      if (len < 1e-5) {
        dx = -this.tailDirX;
        dz = -this.tailDirZ;
      } else {
        dx /= len;
        dz /= len;
      }
      const endBloom = Math.pow(Math.max(0, Math.min(1, t)), 1.7);
      const w = (halfPlayer + (halfTail - halfPlayer) * t) * (0.62 + 0.54 * endBloom);
      return { x, z, y, px: -dz, pz: dx, w };
    };

    for (let i = 0; i < this.tailRibbonSegmentCount; i++) {
      const a = sample(i / this.tailRibbonSegmentCount);
      const b = sample((i + 1) / this.tailRibbonSegmentCount);
      const alx = a.x - a.px * a.w;
      const alz = a.z - a.pz * a.w;
      const arx = a.x + a.px * a.w;
      const arz = a.z + a.pz * a.w;
      const blx = b.x - b.px * b.w;
      const blz = b.z - b.pz * b.w;
      const brx = b.x + b.px * b.w;
      const brz = b.z + b.pz * b.w;

      arr[o++] = alx;
      arr[o++] = a.y;
      arr[o++] = alz;
      arr[o++] = brx;
      arr[o++] = b.y;
      arr[o++] = brz;
      arr[o++] = arx;
      arr[o++] = a.y;
      arr[o++] = arz;

      arr[o++] = alx;
      arr[o++] = a.y;
      arr[o++] = alz;
      arr[o++] = blx;
      arr[o++] = b.y;
      arr[o++] = blz;
      arr[o++] = brx;
      arr[o++] = b.y;
      arr[o++] = brz;
    }

    const posAttr = this.tailRibbonGeo.attributes.position as THREE.BufferAttribute;
    posAttr.needsUpdate = true;
    this.tailRibbonGeo.setDrawRange(0, this.tailRibbonSegmentCount * 6);
    this.tailRibbonGeo.computeBoundingSphere();
  }

  private rebuildSecondTailRibbon(): void {
    const sideX = -this.tailDirZ * CONFIG.playerRadius * 0.46;
    const sideZ = this.tailDirX * CONFIG.playerRadius * 0.46;
    const px = this.mesh.position.x - this.tailDirX * CONFIG.playerRadius * 0.16 + sideX;
    const pz = this.mesh.position.z - this.tailDirZ * CONFIG.playerRadius * 0.16 + sideZ;
    const tx = this.secondTailVisual.x;
    const tz = this.secondTailVisual.z;
    const curvePerpX = -this.tailDirZ;
    const curvePerpZ = this.tailDirX;
    const bendA = this.tailWagOffsetA * CONFIG.playerTailCurveBendMult * 0.42;
    const bendB = this.tailWagOffsetB * CONFIG.playerTailCurveBendMult * 0.42;
    const c1x = px + (tx - px) * 0.33 + curvePerpX * bendA;
    const c1z = pz + (tz - pz) * 0.33 + curvePerpZ * bendA;
    const c2x = px + (tx - px) * 0.66 + curvePerpX * bendB;
    const c2z = pz + (tz - pz) * 0.66 + curvePerpZ * bendB;
    const halfPlayer = CONFIG.playerTailRibbonWidth * 0.34;
    const halfTail = CONFIG.playerTailRibbonWidth * 0.5;
    const y0 = CONFIG.floorY + 0.16;
    const y1 = CONFIG.floorY + 0.2;
    const arr = this.secondTailRibbonPositions;
    let o = 0;

    const sample = (t: number): { x: number; z: number; y: number; px: number; pz: number; w: number } => {
      const inv = 1 - t;
      const inv2 = inv * inv;
      const t2 = t * t;
      const x = inv2 * inv * px + 3 * inv2 * t * c1x + 3 * inv * t2 * c2x + t2 * t * tx;
      const z = inv2 * inv * pz + 3 * inv2 * t * c1z + 3 * inv * t2 * c2z + t2 * t * tz;
      const y = y0 + (y1 - y0) * t;
      let dx = 3 * inv2 * (c1x - px) + 6 * inv * t * (c2x - c1x) + 3 * t2 * (tx - c2x);
      let dz = 3 * inv2 * (c1z - pz) + 6 * inv * t * (c2z - c1z) + 3 * t2 * (tz - c2z);
      const len = Math.hypot(dx, dz);
      if (len < 1e-5) {
        dx = -this.tailDirX;
        dz = -this.tailDirZ;
      } else {
        dx /= len;
        dz /= len;
      }
      const endBloom = Math.pow(Math.max(0, Math.min(1, t)), 1.7);
      const w = (halfPlayer + (halfTail - halfPlayer) * t) * (0.62 + 0.54 * endBloom);
      return { x, z, y, px: -dz, pz: dx, w };
    };

    for (let i = 0; i < this.tailRibbonSegmentCount; i++) {
      const a = sample(i / this.tailRibbonSegmentCount);
      const b = sample((i + 1) / this.tailRibbonSegmentCount);
      const alx = a.x - a.px * a.w;
      const alz = a.z - a.pz * a.w;
      const arx = a.x + a.px * a.w;
      const arz = a.z + a.pz * a.w;
      const blx = b.x - b.px * b.w;
      const blz = b.z - b.pz * b.w;
      const brx = b.x + b.px * b.w;
      const brz = b.z + b.pz * b.w;

      arr[o++] = alx; arr[o++] = a.y; arr[o++] = alz;
      arr[o++] = brx; arr[o++] = b.y; arr[o++] = brz;
      arr[o++] = arx; arr[o++] = a.y; arr[o++] = arz;
      arr[o++] = alx; arr[o++] = a.y; arr[o++] = alz;
      arr[o++] = blx; arr[o++] = b.y; arr[o++] = blz;
      arr[o++] = brx; arr[o++] = b.y; arr[o++] = brz;
    }

    const posAttr = this.secondTailRibbonGeo.attributes.position as THREE.BufferAttribute;
    posAttr.needsUpdate = true;
    this.secondTailRibbonGeo.setDrawRange(0, this.tailRibbonSegmentCount * 6);
    this.secondTailRibbonGeo.computeBoundingSphere();
  }

  update(
    dt: number,
    input: Input,
    aimGroundWorld: THREE.Vector3 | null,
    aimGroundValid: boolean,
    dashLenWidthMult: number,
    playerSpeedMult: number,
    enemies: readonly Enemy[],
    spiralDashEnabled = false,
    spiralDashInput: SpiralDashInput | null = null,
  ): void {
    this.spiralArtifactActive = spiralDashEnabled;
    if (this.tankClipSlideActive) {
      this.advanceTankClipSlide();
      this.spriteWalkingThisFrame = false;
      this.syncSpriteState(0);
      return;
    }

    if (this.hp <= 0) {
      this.microDashTimeLeft = 0;
      this.spiralDashPath = null;
      this.spiralDashPathIndex = 0;
      this.spiralTeleportStartedThisFrame = false;
      this.mainDashStartedThisFrame = false;
      this.activeDashLenWidthMult = 1;
      this.tailPoint.visible = false;
      this.tailRibbon.visible = false;
      this.secondTailPoint.visible = false;
      this.secondTailRibbon.visible = false;
      this.sprite.visible = false;
      this.applyNormalColors();
      return;
    }
    this.sprite.visible = true;

    const inMicro = this.microDashTimeLeft > 0;
    const prevDashTimeLeft = this.dash.timeLeft;

    let prevX = this.mesh.position.x;
    let prevZ = this.mesh.position.z;

    const mv = input.movementVector();
    const walkLen = Math.hypot(mv.x, mv.z);

    let aimX = this.lastAimDirX;
    let aimZ = this.lastAimDirZ;
    if (aimGroundValid && aimGroundWorld) {
      const dx = aimGroundWorld.x - this.mesh.position.x;
      const dz = aimGroundWorld.z - this.mesh.position.z;
      const al = Math.hypot(dx, dz);
      if (al > 1e-4) {
        aimX = dx / al;
        aimZ = dz / al;
        this.lastAimDirX = aimX;
        this.lastAimDirZ = aimZ;
      }
    }

    const facingY = Math.atan2(aimX, aimZ);
    this.aimPivot.rotation.y = facingY;
    this.spritePivot.rotation.y = facingY;

    const keyDashTrigger = input.consumeDashTrigger(!spiralDashEnabled);
    let spiralDashTrigger = false;
    let spiralClickTrigger = false;
    if (spiralDashEnabled) {
      input.consumePointerDashTrigger();
      if (spiralDashInput?.mode === 'path') {
        spiralDashTrigger = spiralDashInput.points.length >= 2;
      } else if (spiralDashInput?.mode === 'click') {
        spiralClickTrigger = true;
      }
    }
    const dashTrigger = keyDashTrigger || spiralDashTrigger || spiralClickTrigger;
    const mult =
      Number.isFinite(dashLenWidthMult) && dashLenWidthMult > 0 ? dashLenWidthMult : 1;
    if (this.microDashTimeLeft <= 0) {
      this.dash.tryStart(dashTrigger, aimX, aimZ, mult);
      if (
        spiralDashTrigger &&
        this.dash.timeLeft > 0 &&
        this.dash.cooldownLeft > 0 &&
        spiralDashInput?.mode === 'path'
      ) {
        this.startSpiralDashPath(spiralDashInput.points, spiralDashInput.drawDurationSec);
        prevX = this.mesh.position.x;
        prevZ = this.mesh.position.z;
      } else if (
        spiralClickTrigger &&
        this.dash.timeLeft > 0 &&
        this.dash.cooldownLeft > 0 &&
        spiralDashInput?.mode === 'click'
      ) {
        this.startSpiralClickTeleport(
          spiralDashInput.x,
          spiralDashInput.z,
          aimX,
          aimZ,
        );
        prevX = this.mesh.position.x;
        prevZ = this.mesh.position.z;
      }
    }

    const useDash = this.dash.isDashingForMovement();
    const reverseArtifactStationary = useDash && this.artifactReverseDashInProgress;
    this.spriteWalkingThisFrame = !useDash && !inMicro && walkLen > 1e-3;
    if (prevDashTimeLeft <= 0 && useDash && !this.artifactReverseDashInProgress) {
      if (!this.spiralArtifactActive) {
        this.dashEnemyFreezeLeft = getDashDurationSec() * mult;
      }
      this.mainDashStartedThisFrame = true;
      this.activeDashLenWidthMult = mult;
      this.dashHitSerial += 1;
    }

    let vx = 0;
    let vz = 0;
    const spiralActive = useDash && !reverseArtifactStationary && !!this.spiralDashPath;
    if (useDash && !reverseArtifactStationary) {
      const dashSp = getEffectiveDashSpeed();
      if (!spiralActive) {
        vx = this.dash.dirX * dashSp;
        vz = this.dash.dirZ * dashSp;
      }
    } else if (inMicro) {
      vx = -this.dash.dirX * this.microDashSpeed;
      vz = -this.dash.dirZ * this.microDashSpeed;
    } else if (walkLen > 1e-3) {
      const speedMult =
        Number.isFinite(playerSpeedMult) && playerSpeedMult > 0 ? playerSpeedMult : 1;
      vx = (mv.x / walkLen) * getPlayerSpeed() * speedMult;
      vz = (mv.z / walkLen) * getPlayerSpeed() * speedMult;
    }

    if (spiralActive) {
      const rawN = Math.floor(CONFIG.dashMovementSubstepCount);
      const n = Math.min(4, Math.max(1, rawN));
      const subDt = dt / n;
      for (let si = 0; si < n; si++) {
        this.advanceAlongSpiralDash(getEffectiveDashSpeed() * subDt);
        const c = clampToArena(this.mesh.position.x, this.mesh.position.z);
        this.mesh.position.x = c.x;
        this.mesh.position.z = c.z;
        this.resolveTankOverlapWhileDashing(enemies);
      }
    } else if (useDash && !reverseArtifactStationary) {
      const rawN = Math.floor(CONFIG.dashMovementSubstepCount);
      const n = Math.min(4, Math.max(1, rawN));
      const subDt = dt / n;
      for (let si = 0; si < n; si++) {
        this.mesh.position.x += vx * subDt;
        this.mesh.position.z += vz * subDt;
        const c = clampToArena(this.mesh.position.x, this.mesh.position.z);
        this.mesh.position.x = c.x;
        this.mesh.position.z = c.z;
        this.resolveTankOverlapWhileDashing(enemies);
      }
    } else {
      this.mesh.position.x += vx * dt;
      this.mesh.position.z += vz * dt;
      const c = clampToArena(this.mesh.position.x, this.mesh.position.z);
      this.mesh.position.x = c.x;
      this.mesh.position.z = c.z;
    }

    this.updateTailVisual(dt, prevX, prevZ);

    if (useDash) {
      const revSweepMult = this.artifactReverseDashInProgress
        ? Math.max(0, CONFIG.reverseDashArtifactSweepNominalMult)
        : 1;
      const nominalDashLen =
        getDashNominalLengthWorld() * this.activeDashLenWidthMult * revSweepMult;
      const beyond =
        CONFIG.dashBeyondNominalLengthFraction * nominalDashLen;
      const extX = this.dash.dirX * beyond;
      const extZ = this.dash.dirZ * beyond;
      const sweepEnd = clampToArena(
        this.mesh.position.x + extX,
        this.mesh.position.z + extZ,
      );
      this.dashSweep = {
        ax: prevX,
        az: prevZ,
        bx: sweepEnd.x,
        bz: sweepEnd.z,
      };
      if (!this.dashTrailBuilding) {
        this.dashTrailBuilding = true;
        this.mainDashTravel = 0;
        this.trailPoints.length = 0;
        this.pushDashTrailPoint(prevX, prevZ);
      }
      this.mainDashTravel += Math.hypot(
        this.mesh.position.x - prevX,
        this.mesh.position.z - prevZ,
      );
      this.pushDashTrailPoint(sweepEnd.x, sweepEnd.z);
      this.trailRibbon.visible = true;
    } else {
      this.dashTrailBuilding = false;
      this.spiralDashPath = null;
      this.spiralDashPathIndex = 0;
      this.activeDashLenWidthMult = 1;
      this.dashSweep = null;
      if (this.trailPoints.length > 0) {
        this.trailPoints.length = 0;
      }
      this.trailRibbonGeo.setDrawRange(0, 0);
      this.trailRibbon.visible = false;
    }
    this.syncSpriteState(dt);
  }

  /**
   * Passive shield regen: no damage for `shieldRegenIntervalSec` → +1 `hp` (capped).
   * Call from `Game` each playing frame after movement/dash ticks.
   */
  tickShieldRegen(dt: number): boolean {
    if (this.hp <= 0 || this.hp >= getPlayerMaxHp()) {
      this.shieldRegenNoDamageSec = 0;
      return false;
    }
    this.shieldRegenNoDamageSec += dt;
    if (this.shieldRegenNoDamageSec >= this.shieldRegenIntervalSec) {
      this.shieldRegenNoDamageSec = 0;
      this.hp = Math.min(getPlayerMaxHp(), this.hp + 1);
      return true;
    }
    return false;
  }

  /** In-run upgrade: shorten shield regen interval (floored at `CONFIG.shieldRegenMinIntervalSec`). */
  accelerateShieldRegenFromUpgrade(): void {
    this.shieldRegenIntervalSec = Math.max(
      CONFIG.shieldRegenMinIntervalSec,
      this.shieldRegenIntervalSec - CONFIG.shieldRegenUpgradeStepSec,
    );
  }

  private advanceTankClipSlide(): void {
    const px = this.mesh.position.x;
    const pz = this.mesh.position.z;
    const dur = this.tankClipSlideDurSec;
    const elapsedSec = (performance.now() - this.tankClipSlideStartMs) / 1000;
    const u = dur > 1e-8 ? Math.min(1, elapsedSec / dur) : 1;
    this.mesh.position.x =
      this.tankClipSlideFromX + (this.tankClipSlideToX - this.tankClipSlideFromX) * u;
    this.mesh.position.z =
      this.tankClipSlideFromZ + (this.tankClipSlideToZ - this.tankClipSlideFromZ) * u;
    this.mainDashTravel += Math.hypot(this.mesh.position.x - px, this.mesh.position.z - pz);
    this.updateTailVisual(Math.max(0.001, 1 / 60), px, pz);
    this.trailRibbon.visible = true;
    this.pushDashTrailPoint(this.mesh.position.x, this.mesh.position.z);
    if (u >= 1) {
      this.mesh.position.x = this.tankClipSlideToX;
      this.mesh.position.z = this.tankClipSlideToZ;
      this.tankClipSlideActive = false;
      this.dash.timeLeft = this.tankClipResumeTimeLeft;
      this.dashEnemyFreezeLeft = this.tankClipResumeEnemyFreeze;
      this.activeDashLenWidthMult = this.tankClipResumeLenMult;
      this.clearDashCooldownAfterOnBeatHit();
    }
  }

  private applyNormalColors(): void {
    this.bodyMat.color.setHex(0x1a3d5c);
    this.bodyMat.emissive.setHex(0x22aaff);
    this.bodyMat.emissiveIntensity = 0.85;
    this.ringMat.color.setHex(0x66ccff);
    this.ringMat.opacity = 0.5;
  }

  private syncSpriteState(dt: number): void {
    if (this.spriteWalkingThisFrame && !this.isDashing) {
      this.spriteWalkTimeSec += Math.max(0, dt);
    } else {
      this.spriteWalkTimeSec = 0;
    }

    const walkFrame = [0, 1, 2, 3, 2, 1][
      Math.floor(this.spriteWalkTimeSec / 0.175) % 6
    ]!;
    const mode = this.isDashing
      ? 'dash'
      : this.spriteWalkingThisFrame
        ? walkFrame === 0
          ? 'walk1'
          : walkFrame === 1
            ? 'walk2'
            : walkFrame === 2
              ? 'walk3'
              : 'walk4'
        : 'idle';
    if (mode === this.currentSpriteMode) return;
    this.currentSpriteMode = mode;
    this.spriteMat.map =
      mode === 'dash'
        ? PLAYER_DASH_TEXTURE
        : mode === 'walk1'
          ? PLAYER_STEP_1_TEXTURE
          : mode === 'walk2'
            ? PLAYER_STEP_2_TEXTURE
            : mode === 'walk3'
              ? PLAYER_STEP_3_TEXTURE
              : mode === 'walk4'
                ? PLAYER_STEP_4_TEXTURE
                : PLAYER_IDLE_TEXTURE;
    this.spriteMat.needsUpdate = true;
  }

  /** World XZ on floor, shifted slightly behind dash direction (trail “behind” the hero). */
  private pushDashTrailPoint(x: number, z: number): void {
    const y = CONFIG.floorY + 0.22;
    const behind = CONFIG.dashTrailBehind * this.activeDashLenWidthMult;
    const bx = x - this.dash.dirX * behind;
    const bz = z - this.dash.dirZ * behind;
    this.trailPoints.push(new THREE.Vector3(bx, y, bz));
    const max = CONFIG.dashTrailMaxPoints;
    while (this.trailPoints.length > max) {
      this.trailPoints.shift();
    }
    if (this.trailPoints.length >= 2) {
      this.rebuildTrailRibbon();
    }
  }

  /** XZ ribbon along polyline — reliable with orthographic top-down (unlike Line2). */
  private rebuildTrailRibbon(): void {
    const pts = this.trailPoints;
    const n = pts.length;
    if (n < 2) {
      this.trailRibbonGeo.setDrawRange(0, 0);
      return;
    }
    const halfW = CONFIG.dashTrailWidth * 0.5 * this.activeDashLenWidthMult;
    const arr = this.trailPositions;
    let o = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      let px: number;
      let pz: number;
      if (len < 1e-6) {
        px = 0;
        pz = 1;
      } else {
        const inv = 1 / len;
        px = -dz * inv;
        pz = dx * inv;
      }
      const aw = halfW * this.getTrailTaperAtPoint(i, n);
      const bw = halfW * this.getTrailTaperAtPoint(i + 1, n);
      const apx = px * aw;
      const apz = pz * aw;
      const bpx = px * bw;
      const bpz = pz * bw;
      const y0 = a.y;
      const y1 = b.y;
      const alx = a.x - apx;
      const alz = a.z - apz;
      const arx = a.x + apx;
      const arz = a.z + apz;
      const blx = b.x - bpx;
      const blz = b.z - bpz;
      const brx = b.x + bpx;
      const brz = b.z + bpz;

      arr[o++] = alx;
      arr[o++] = y0;
      arr[o++] = alz;
      arr[o++] = brx;
      arr[o++] = y1;
      arr[o++] = brz;
      arr[o++] = arx;
      arr[o++] = y0;
      arr[o++] = arz;

      arr[o++] = alx;
      arr[o++] = y0;
      arr[o++] = alz;
      arr[o++] = blx;
      arr[o++] = y1;
      arr[o++] = blz;
      arr[o++] = brx;
      arr[o++] = y1;
      arr[o++] = brz;
    }
    const vertCount = o / 3;
    this.trailRibbonGeo.setDrawRange(0, vertCount);
    const posAttr = this.trailRibbonGeo.attributes.position as THREE.BufferAttribute;
    posAttr.needsUpdate = true;
    this.trailRibbonGeo.computeBoundingSphere();
  }

  /** 0…1: progress toward next passive shield (for bottom bar UI). */
  private getTrailTaperAtPoint(index: number, pointCount: number): number {
    if (pointCount <= 1) return 0;
    const t = index / (pointCount - 1);
    return Math.sin(Math.PI * Math.max(0, Math.min(1, t)));
  }

  getShieldRegenVisualProgress(): number {
    if (this.hp <= 0 || this.hp >= getPlayerMaxHp()) return 0;
    const t = this.shieldRegenIntervalSec;
    if (!(t > 1e-8)) return 0;
    return Math.min(1, this.shieldRegenNoDamageSec / t);
  }

  takeDamage(amount: number, ignoreInvulnerability = false): void {
    if (!ignoreInvulnerability && this.isInvulnerable()) return;
    const before = this.hp;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp < before) {
      this.shieldRegenNoDamageSec = 0;
      this.damageInvulnLeft = CONFIG.damageInvulnerabilitySec;
    }
    if (this.hp <= 0) {
      this.postDashInvulnLeft = 0;
      this.damageInvulnLeft = 0;
      this.microDashTimeLeft = 0;
      this.applyNormalColors();
    }
  }
}
