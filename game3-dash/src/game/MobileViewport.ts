import { CONFIG } from './config.ts';

/** Touch-first / coarse-pointer devices (phones, most tablets). */
export function isMobileGameViewport(): boolean {
  return !window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

function isPhysicalLandscape(): boolean {
  return window.matchMedia('(orientation: landscape)').matches;
}

/**
 * Effective layout size for game/canvas when mobile portrait is forced
 * (CSS may rotate the page while `window.inner*` stays landscape).
 */
export function getGameViewportSize(): { width: number; height: number } {
  const mount = document.getElementById('app');
  const mw = mount?.clientWidth ?? 0;
  const mh = mount?.clientHeight ?? 0;
  if (mw > 0 && mh > 0) {
    return { width: mw, height: mh };
  }

  let w = window.innerWidth;
  let h = window.innerHeight;
  if (
    document.documentElement.classList.contains('mobile-game') &&
    document.documentElement.classList.contains('mobile-game-physical-landscape')
  ) {
    [w, h] = [h, w];
  }
  return { width: w, height: h };
}

/** Sync `html.mobile-game` (+ portrait lock classes) for mobile-only CSS. */
export function syncMobileGameRootClass(): void {
  const mobile = isMobileGameViewport();
  const physicalLandscape = mobile && isPhysicalLandscape();
  const root = document.documentElement;
  root.classList.toggle('mobile-game', mobile);
  // Mobile always uses portrait layout; landscape class is never applied on phones.
  root.classList.toggle('mobile-game-portrait', mobile);
  root.classList.toggle('mobile-game-landscape', false);
  root.classList.toggle('mobile-game-physical-landscape', physicalLandscape);
}

let portraitLockBound = false;

/** Request OS/browser portrait lock (works in fullscreen / installed PWA on many devices). */
export function tryLockMobilePortraitOrientation(): void {
  if (!isMobileGameViewport()) return;
  const orientation = screen.orientation;
  if (!orientation?.lock) return;
  void orientation.lock('portrait-primary').catch(() => {
    void orientation.lock('portrait').catch(() => {});
  });
}

/** Retry orientation lock after the first user gesture (required on some browsers). */
export function bindMobilePortraitOrientationLock(): void {
  if (!isMobileGameViewport() || portraitLockBound) return;
  portraitLockBound = true;

  const onGesture = (): void => {
    tryLockMobilePortraitOrientation();
  };

  document.addEventListener('pointerdown', onGesture, { once: true, passive: true });
  document.addEventListener('touchstart', onGesture, { once: true, passive: true });
  document.addEventListener('click', onGesture, { once: true, passive: true });

  tryLockMobilePortraitOrientation();
}

/** Beat lane height / note radius scale on touch viewports (1 on desktop). */
export function getMobileBeatLaneScale(): number {
  return isMobileGameViewport() ? CONFIG.mobileBeatLaneScale : 1;
}

/** Beat lane width fraction on touch viewports. */
export function getMobileBeatLaneWidthFraction(): number {
  return isMobileGameViewport()
    ? CONFIG.mobileBeatLaneWidthFraction
    : CONFIG.beatLaneWidthFraction;
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
