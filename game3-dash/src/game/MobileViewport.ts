import { CONFIG } from './config.ts';

/** Touch-first / coarse-pointer devices (phones, most tablets). */
export function isMobileGameViewport(): boolean {
  return !window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/** Sync `html.mobile-game` (+ portrait/landscape) for mobile-only CSS. */
export function syncMobileGameRootClass(): void {
  const mobile = isMobileGameViewport();
  const portrait = mobile && window.matchMedia('(orientation: portrait)').matches;
  const root = document.documentElement;
  root.classList.toggle('mobile-game', mobile);
  root.classList.toggle('mobile-game-portrait', portrait);
  root.classList.toggle('mobile-game-landscape', mobile && !portrait);
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
