import { CONFIG } from './config.ts';

/** Touch-first / coarse-pointer devices (phones, most tablets). */
export function isMobileGameViewport(): boolean {
  return !window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/** Sync `html.mobile-game` for mobile-only CSS (level-up scale, etc.). */
export function syncMobileGameRootClass(): void {
  document.documentElement.classList.toggle('mobile-game', isMobileGameViewport());
}

export function getDefaultCameraViewHalfExtent(): number {
  if (!isMobileGameViewport()) return CONFIG.cameraViewHalfExtent;
  return CONFIG.cameraViewHalfExtent * CONFIG.mobileCameraViewHalfExtentMult;
}

export function getCameraZoomHalfExtentLimits(): { min: number; max: number } {
  const mult = isMobileGameViewport() ? CONFIG.mobileCameraViewHalfExtentMult : 1;
  return {
    min: CONFIG.cameraZoomMinHalfExtent * mult,
    max: CONFIG.cameraZoomMaxHalfExtent * mult,
  };
}
