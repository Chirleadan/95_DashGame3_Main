import * as THREE from 'three';
import { CONFIG } from './config.ts';
import type { Input } from './Input.ts';
import { clampToArena } from './Collision.ts';
import { Dash } from './Dash.ts';

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

  hp: number = CONFIG.playerMaxHp;

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
      color: 0x55eeff,
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
    return this.dash.timeLeft > 0;
  }

  isInvulnerable(): boolean {
    return (
      this.postDashInvulnLeft > 0 ||
      this.dash.timeLeft > 0 ||
      this.microDashTimeLeft > 0
    );
  }

  areEnemiesFrozenByDash(): boolean {
    return this.dashEnemyFreezeLeft > 0;
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

  update(
    dt: number,
    input: Input,
    aimGroundWorld: THREE.Vector3 | null,
    aimGroundValid: boolean,
  ): void {
    if (this.hp <= 0) {
      this.microDashTimeLeft = 0;
      this.mainDashStartedThisFrame = false;
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
    if (this.microDashTimeLeft <= 0) {
      this.dash.tryStart(dashTrigger, aimX, aimZ);
    }

    const useDash = this.dash.isDashingForMovement();
    if (prevDashTimeLeft <= 0 && useDash) {
      this.dashEnemyFreezeLeft = CONFIG.dashEnemyFreezeDuration;
      this.mainDashStartedThisFrame = true;
    }

    let vx = 0;
    let vz = 0;
    if (useDash) {
      vx = this.dash.dirX * CONFIG.dashSpeed;
      vz = this.dash.dirZ * CONFIG.dashSpeed;
    } else if (inMicro) {
      vx = -this.dash.dirX * this.microDashSpeed;
      vz = -this.dash.dirZ * this.microDashSpeed;
    } else if (walkLen > 1e-3) {
      vx = (mv.x / walkLen) * CONFIG.playerSpeed;
      vz = (mv.z / walkLen) * CONFIG.playerSpeed;
    }

    this.mesh.position.x += vx * dt;
    this.mesh.position.z += vz * dt;
    const c = clampToArena(this.mesh.position.x, this.mesh.position.z);
    this.mesh.position.x = c.x;
    this.mesh.position.z = c.z;

    if (useDash) {
      const nominalDashLen = CONFIG.dashSpeed * CONFIG.dashDuration;
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
      this.dashSweep = null;
      if (this.trailPoints.length > 0) {
        this.trailPoints.length = 0;
      }
      this.trailRibbonGeo.setDrawRange(0, 0);
      this.trailRibbon.visible = false;
    }

    this.dash.tickAfterMove(dt);

    if (prevDashTimeLeft > 0 && this.dash.timeLeft <= 0) {
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
    const bx = x - this.dash.dirX * CONFIG.dashTrailBehind;
    const bz = z - this.dash.dirZ * CONFIG.dashTrailBehind;
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
    const halfW = CONFIG.dashTrailWidth * 0.5;
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
        pz = halfW;
      } else {
        const inv = halfW / len;
        px = -dz * inv;
        pz = dx * inv;
      }
      const y0 = a.y;
      const y1 = b.y;
      const alx = a.x - px;
      const alz = a.z - pz;
      const arx = a.x + px;
      const arz = a.z + pz;
      const blx = b.x - px;
      const blz = b.z - pz;
      const brx = b.x + px;
      const brz = b.z + pz;

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

  takeDamage(amount: number): void {
    if (this.isInvulnerable()) return;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp <= 0) {
      this.postDashInvulnLeft = 0;
      this.microDashTimeLeft = 0;
      this.applyNormalColors();
    }
  }
}
