import * as THREE from 'three';
import { CONFIG, isDebugDashPastTankEnabled } from './config.ts';
import {
  getDashDurationSec,
  getDashNominalLengthWorld,
  getEffectiveDashSpeed,
  getPlayerMaxHp,
  getPlayerSpeed,
} from './BalanceSettings.ts';
import type { Input } from './Input.ts';
import { clampToArena, circlesOverlap, rayExitFromCircleXZ } from './Collision.ts';
import { Dash } from './Dash.ts';
import type { Enemy } from './Enemy.ts';

export type DashSweepSegment = { ax: number; az: number; bx: number; bz: number };

export class Player {
  readonly mesh: THREE.Group;
  private readonly body: THREE.Mesh;
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly ring: THREE.Mesh;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly aimPivot: THREE.Group;
  readonly dash = new Dash();

  private readonly trailPoints: THREE.Vector3[] = [];
  /** Preallocated ribbon vertices: (maxPoints-1) segments × 2 tris × 3 verts × xyz */
  private readonly trailPositions: Float32Array;
  private readonly trailRibbonGeo: THREE.BufferGeometry;
  private readonly trailRibbon: THREE.Mesh;

  hp: number = getPlayerMaxHp();

  private lastAimDirX = 0;
  private lastAimDirZ = -1;

  /** Remaining post-dash invulnerability (seconds). */
  private postDashInvulnLeft = 0;

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
    this.mesh.add(this.body);

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
      this.dash.timeLeft > 0 ||
      this.microDashTimeLeft > 0 ||
      this.tankClipSlideActive
    );
  }

  areEnemiesFrozenByDash(): boolean {
    return this.dashEnemyFreezeLeft > 0;
  }

  get isMicroDashing(): boolean {
    return this.microDashTimeLeft > 0;
  }

  getDashHitSerial(): number {
    return this.dashHitSerial;
  }

  /** Clears post-dash cooldown (on-beat dash, clip/slide past tank or vault, overlap snap). */
  clearDashCooldownAfterOnBeatHit(): void {
    this.dash.cooldownLeft = 0;
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
    this.tankClipResumeEnemyFreeze = this.dashEnemyFreezeLeft;
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
    this.microDashTimeLeft = 0;
    this.microDashSpeed = 0;
    this.mainDashTravel = 0;
    this.dashEnemyFreezeLeft = 0;
    this.dashSweep = null;
    this.dashTrailBuilding = false;
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

  /**
   * Run after `resolveDashKills` so `clipDashPastTank` can still see `dash.timeLeft > 0` on the frame a sweep hits.
   */
  tickDashAfterHits(dt: number, reverseDashArtifactEnabled: boolean): void {
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
          this.dash.cooldownLeft = CONFIG.dashCooldown;
          this.dashEnemyFreezeLeft = getDashDurationSec() * mult * revDur;
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

  update(
    dt: number,
    input: Input,
    aimGroundWorld: THREE.Vector3 | null,
    aimGroundValid: boolean,
    dashLenWidthMult: number,
    playerSpeedMult: number,
    enemies: readonly Enemy[],
  ): void {
    if (this.tankClipSlideActive) {
      this.advanceTankClipSlide();
      return;
    }

    if (this.hp <= 0) {
      this.microDashTimeLeft = 0;
      this.mainDashStartedThisFrame = false;
      this.activeDashLenWidthMult = 1;
      this.applyNormalColors();
      return;
    }

    const inMicro = this.microDashTimeLeft > 0;
    const prevDashTimeLeft = this.dash.timeLeft;

    const prevX = this.mesh.position.x;
    const prevZ = this.mesh.position.z;

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

    this.aimPivot.rotation.y = Math.atan2(aimX, aimZ);

    const dashTrigger = input.consumeDashTrigger();
    const mult =
      Number.isFinite(dashLenWidthMult) && dashLenWidthMult > 0 ? dashLenWidthMult : 1;
    if (this.microDashTimeLeft <= 0) {
      this.dash.tryStart(dashTrigger, aimX, aimZ, mult);
    }

    const useDash = this.dash.isDashingForMovement();
    const reverseArtifactStationary = useDash && this.artifactReverseDashInProgress;
    if (prevDashTimeLeft <= 0 && useDash && !this.artifactReverseDashInProgress) {
      this.dashEnemyFreezeLeft = getDashDurationSec() * mult;
      this.mainDashStartedThisFrame = true;
      this.activeDashLenWidthMult = mult;
      this.dashHitSerial += 1;
    }

    let vx = 0;
    let vz = 0;
    if (useDash && !reverseArtifactStationary) {
      const dashSp = getEffectiveDashSpeed();
      vx = this.dash.dirX * dashSp;
      vz = this.dash.dirZ * dashSp;
    } else if (inMicro) {
      vx = -this.dash.dirX * this.microDashSpeed;
      vz = -this.dash.dirZ * this.microDashSpeed;
    } else if (walkLen > 1e-3) {
      const speedMult =
        Number.isFinite(playerSpeedMult) && playerSpeedMult > 0 ? playerSpeedMult : 1;
      vx = (mv.x / walkLen) * getPlayerSpeed() * speedMult;
      vz = (mv.z / walkLen) * getPlayerSpeed() * speedMult;
    }

    if (useDash && !reverseArtifactStationary) {
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
      this.activeDashLenWidthMult = 1;
      this.dashSweep = null;
      if (this.trailPoints.length > 0) {
        this.trailPoints.length = 0;
      }
      this.trailRibbonGeo.setDrawRange(0, 0);
      this.trailRibbon.visible = false;
    }
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

  takeDamage(amount: number): void {
    if (this.isInvulnerable()) return;
    const before = this.hp;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp < before) {
      this.shieldRegenNoDamageSec = 0;
    }
    if (this.hp <= 0) {
      this.postDashInvulnLeft = 0;
      this.microDashTimeLeft = 0;
      this.applyNormalColors();
    }
  }
}
