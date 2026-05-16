import * as THREE from 'three';

/** Top-down orthographic follow: fixed height/offset, smooth lerp, lookAt player on the floor. */
export class CameraController {
  /** World-space offset from player (XZ follow, Y height). */
  readonly cameraOffset = new THREE.Vector3(0, 42, 0);

  private readonly targetPosition = new THREE.Vector3();
  /** Smoothed follow position (shake applied on top, not fed back into lerp). */
  private readonly smoothedPosition = new THREE.Vector3(0, 42, 0);
  private smoothedLookX = 0;
  private smoothedLookZ = 0;
  private catchUpDurationSec = 0;
  private catchUpElapsedSec = 0;
  private readonly catchUpFromPosition = new THREE.Vector3();
  private catchUpFromLookX = 0;
  private catchUpFromLookZ = 0;
  private lookInitialized = false;

  beginTeleportCatchUp(durationSec = 0.6): void {
    this.catchUpDurationSec = Math.max(0, durationSec);
    this.catchUpElapsedSec = 0;
    this.catchUpFromPosition.copy(this.smoothedPosition);
    this.catchUpFromLookX = this.smoothedLookX;
    this.catchUpFromLookZ = this.smoothedLookZ;
  }

  update(
    camera: THREE.OrthographicCamera,
    dt: number,
    playerX: number,
    playerZ: number,
    shakeX: number,
    shakeZ: number,
  ): void {
    if (!this.lookInitialized) {
      this.smoothedLookX = playerX;
      this.smoothedLookZ = playerZ;
      this.lookInitialized = true;
    }

    this.targetPosition.set(
      playerX + this.cameraOffset.x,
      this.cameraOffset.y,
      playerZ + this.cameraOffset.z,
    );

    if (this.catchUpDurationSec > 0) {
      this.catchUpElapsedSec += Math.max(0, dt);
      const u = Math.min(1, this.catchUpElapsedSec / this.catchUpDurationSec);
      const ease = u * u * (3 - 2 * u);
      this.smoothedPosition.lerpVectors(this.catchUpFromPosition, this.targetPosition, ease);
      this.smoothedLookX = THREE.MathUtils.lerp(this.catchUpFromLookX, playerX, ease);
      this.smoothedLookZ = THREE.MathUtils.lerp(this.catchUpFromLookZ, playerZ, ease);
      if (u >= 1) {
        this.catchUpDurationSec = 0;
      }
    } else {
      const t = 1 - Math.pow(0.001, dt);
      this.smoothedPosition.lerp(this.targetPosition, t);
      this.smoothedLookX = playerX;
      this.smoothedLookZ = playerZ;
    }

    camera.position.copy(this.smoothedPosition);
    camera.position.x += shakeX;
    camera.position.z += shakeZ;
    camera.up.set(0, 0, -1);
    camera.lookAt(this.smoothedLookX, 0, this.smoothedLookZ);
  }
}
