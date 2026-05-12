import * as THREE from 'three';
import { CONFIG } from './config.ts';

/** Top-down orthographic follow: fixed height/offset, smooth lerp, lookAt player on the floor. */
export class CameraController {
  /** World-space offset from player (XZ follow, Y height). */
  readonly cameraOffset = new THREE.Vector3(0, 42, 0);

  private readonly targetPosition = new THREE.Vector3();
  /** Smoothed follow position (shake applied on top, not fed back into lerp). */
  private readonly smoothedPosition = new THREE.Vector3(0, 42, 0);

  private teleportPanActive = false;
  private teleportStartMs = 0;
  private readonly camFrom = new THREE.Vector3();
  private readonly camTo = new THREE.Vector3();
  private lookFromX = 0;
  private lookFromZ = 0;
  private lookToX = 0;
  private lookToZ = 0;

  private teleportPanDur: number = CONFIG.teleportDurationSec;

  /** Start a fixed-duration pan so camera and hero reach the destination together (beat `tp`). */
  beginSyncedTeleportPan(
    playerFromX: number,
    playerFromZ: number,
    playerToX: number,
    playerToZ: number,
    durationSec: number,
  ): void {
    this.teleportPanActive = true;
    this.teleportStartMs = performance.now();
    this.teleportPanDur =
      Number.isFinite(durationSec) && durationSec > 1e-4
        ? durationSec
        : CONFIG.teleportDurationSec;
    this.camFrom.copy(this.smoothedPosition);
    this.camTo.set(
      playerToX + this.cameraOffset.x,
      this.cameraOffset.y,
      playerToZ + this.cameraOffset.z,
    );
    this.lookFromX = playerFromX;
    this.lookFromZ = playerFromZ;
    this.lookToX = playerToX;
    this.lookToZ = playerToZ;
  }

  isTeleportPanning(): boolean {
    return this.teleportPanActive;
  }

  /** Stop an in-flight pan (death / menu / new run). */
  clearTeleportPan(): void {
    this.teleportPanActive = false;
  }

  updateTeleportPan(
    camera: THREE.OrthographicCamera,
    _dt: number,
    shakeX: number,
    shakeZ: number,
  ): void {
    if (!this.teleportPanActive) return;
    const dur = this.teleportPanDur;
    const elapsedSec = (performance.now() - this.teleportStartMs) / 1000;
    const u = Math.min(1, elapsedSec / dur);
    const lx = this.lookFromX + (this.lookToX - this.lookFromX) * u;
    const lz = this.lookFromZ + (this.lookToZ - this.lookFromZ) * u;
    this.smoothedPosition.lerpVectors(this.camFrom, this.camTo, u);
    camera.position.copy(this.smoothedPosition);
    camera.position.x += shakeX;
    camera.position.z += shakeZ;
    camera.up.set(0, 0, -1);
    camera.lookAt(lx, 0, lz);
    if (u >= 1) {
      this.teleportPanActive = false;
      this.smoothedPosition.copy(this.camTo);
    }
  }

  update(
    camera: THREE.OrthographicCamera,
    dt: number,
    playerX: number,
    playerZ: number,
    shakeX: number,
    shakeZ: number,
  ): void {
    if (this.teleportPanActive) {
      this.updateTeleportPan(camera, dt, shakeX, shakeZ);
      return;
    }
    this.targetPosition.set(
      playerX + this.cameraOffset.x,
      this.cameraOffset.y,
      playerZ + this.cameraOffset.z,
    );
    const t = 1 - Math.pow(0.001, dt);
    this.smoothedPosition.lerp(this.targetPosition, t);
    camera.position.copy(this.smoothedPosition);
    camera.position.x += shakeX;
    camera.position.z += shakeZ;
    camera.up.set(0, 0, -1);
    camera.lookAt(playerX, 0, playerZ);
  }
}
