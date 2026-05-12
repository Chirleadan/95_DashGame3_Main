import * as THREE from 'three';

/** Top-down orthographic follow: fixed height/offset, smooth lerp, lookAt player on the floor. */
export class CameraController {
  /** World-space offset from player (XZ follow, Y height). */
  readonly cameraOffset = new THREE.Vector3(0, 42, 0);

  private readonly targetPosition = new THREE.Vector3();
  /** Smoothed follow position (shake applied on top, not fed back into lerp). */
  private readonly smoothedPosition = new THREE.Vector3(0, 42, 0);

  update(
    camera: THREE.OrthographicCamera,
    dt: number,
    playerX: number,
    playerZ: number,
    shakeX: number,
    shakeZ: number,
  ): void {
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
