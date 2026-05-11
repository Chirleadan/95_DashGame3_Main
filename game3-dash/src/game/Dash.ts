import { CONFIG } from './config.ts';

/** Dash timers and locked dash direction (aim-based). */
export class Dash {
  timeLeft = 0;
  cooldownLeft = 0;
  /** Unit vector in XZ used for the active dash. */
  dirX = 0;
  dirZ = -1;

  /**
   * Starts dash on trigger edge when cooldown allows.
   * `aimDirX/Z` should be a non-zero world aim direction in XZ (normalized by caller).
   */
  tryStart(
    trigger: boolean,
    aimDirX: number,
    aimDirZ: number,
    durationMult: number = 1,
  ): void {
    if (!trigger || this.cooldownLeft > 0 || this.timeLeft > 0) {
      return;
    }
    let nx = aimDirX;
    let nz = aimDirZ;
    const len = Math.hypot(nx, nz);
    if (len < 1e-5) {
      nx = 0;
      nz = -1;
    } else {
      nx /= len;
      nz /= len;
    }
    this.dirX = nx;
    this.dirZ = nz;
    const m = Number.isFinite(durationMult) && durationMult > 0 ? durationMult : 1;
    this.timeLeft = CONFIG.dashDuration * m;
    this.cooldownLeft = CONFIG.dashCooldown;
  }

  /** True while dash movement should apply (before this frame's timer decay). */
  isDashingForMovement(): boolean {
    return this.timeLeft > 0;
  }

  tickAfterMove(dt: number): void {
    if (this.timeLeft > 0) {
      this.timeLeft = Math.max(0, this.timeLeft - dt);
    }
    if (this.cooldownLeft > 0) {
      this.cooldownLeft = Math.max(0, this.cooldownLeft - dt);
    }
  }

  /** Clear dash state (e.g. new run from menu). */
  reset(): void {
    this.timeLeft = 0;
    this.cooldownLeft = 0;
    this.dirX = 0;
    this.dirZ = -1;
  }
}
