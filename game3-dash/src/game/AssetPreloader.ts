import {
  getCoreGameAssetManifest,
  getDeferredTrackManifest,
  getLvlupAssetManifest,
  getTrackStageAssets,
  type PreloadAsset,
  type PreloadAssetKind,
} from './assetManifest.ts';
import type { TrackStage } from './TrackCatalog.ts';
import { getGameTexture } from './TextureCache.ts';

export type PreloadProgress = {
  loaded: number;
  total: number;
  fraction: number;
};

const loadedUrls = new Set<string>();
let lvlupPreloadStarted = false;
let lvlupPreloadDone = false;

function bump(
  onProgress: ((p: PreloadProgress) => void) | undefined,
  loaded: number,
  total: number,
): void {
  onProgress?.({
    loaded,
    total,
    fraction: total > 0 ? loaded / total : 1,
  });
}

export function isGameAssetUrlLoaded(url: string): boolean {
  return loadedUrls.has(url.trim());
}

async function preloadImage(url: string): Promise<void> {
  if (loadedUrls.has(url)) return;
  await new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      loadedUrls.add(url);
      resolve();
    };
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
  getGameTexture(url);
}

async function preloadAudio(url: string): Promise<void> {
  if (loadedUrls.has(url)) return;
  await new Promise<void>((resolve, reject) => {
    const audio = new Audio();
    audio.preload = 'auto';
    const finish = () => {
      loadedUrls.add(url);
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error(`Failed to load audio: ${url}`));
    };
    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', finish);
      audio.removeEventListener('canplaythrough', finish);
      audio.removeEventListener('error', fail);
    };
    audio.addEventListener('loadedmetadata', finish);
    audio.addEventListener('canplaythrough', finish);
    audio.addEventListener('error', fail);
    audio.src = url;
    audio.load();
  });
}

async function preloadJson(url: string): Promise<void> {
  if (loadedUrls.has(url)) return;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load JSON (${res.status}): ${url}`);
  }
  await res.json();
  loadedUrls.add(url);
}

async function preloadFont(url: string): Promise<void> {
  if (loadedUrls.has(url)) return;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load font (${res.status}): ${url}`);
  }
  await res.arrayBuffer();
  loadedUrls.add(url);
}

async function preloadOne(asset: PreloadAsset): Promise<void> {
  switch (asset.kind) {
    case 'image':
      await preloadImage(asset.url);
      return;
    case 'audio':
      await preloadAudio(asset.url);
      return;
    case 'json':
      await preloadJson(asset.url);
      return;
    case 'font':
      await preloadFont(asset.url);
      return;
    default: {
      const _exhaustive: never = asset.kind;
      throw new Error(`Unknown asset kind: ${String(_exhaustive)}`);
    }
  }
}

const PRELOAD_CONCURRENCY = 6;

export type PreloadGameAssetsResult = {
  failed: { url: string; kind: PreloadAssetKind; essential: boolean; message: string }[];
};

export async function preloadAssets(
  manifest: readonly PreloadAsset[],
  onProgress?: (progress: PreloadProgress) => void,
): Promise<PreloadGameAssetsResult> {
  const total = manifest.length;
  let loaded = 0;
  const failed: PreloadGameAssetsResult['failed'] = [];

  bump(onProgress, 0, total);

  for (let i = 0; i < manifest.length; i += PRELOAD_CONCURRENCY) {
    const batch = manifest.slice(i, i + PRELOAD_CONCURRENCY);
    await Promise.all(
      batch.map(async (asset) => {
        try {
          await preloadOne(asset);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn('[Preload]', message);
          failed.push({
            url: asset.url,
            kind: asset.kind,
            essential: asset.essential,
            message,
          });
        } finally {
          loaded += 1;
          bump(onProgress, loaded, total);
        }
      }),
    );
  }

  return { failed };
}

export async function preloadCoreGameAssets(
  selectedStage: TrackStage,
  onProgress?: (progress: PreloadProgress) => void,
): Promise<PreloadGameAssetsResult> {
  return preloadAssets(getCoreGameAssetManifest(selectedStage), onProgress);
}

/** Ensures one tape stage is cached (menu selection / before run). */
export async function ensureStageTrackAssetsLoaded(
  stage: TrackStage,
): Promise<PreloadGameAssetsResult> {
  return preloadAssets(getTrackStageAssets(stage, true));
}

/** Background warm-up for tapes not selected at boot. */
export function preloadDeferredTrackAssets(excludeStageId: string): void {
  const manifest = getDeferredTrackManifest(excludeStageId);
  if (manifest.length === 0) return;
  void preloadAssets(manifest).then((result) => {
    const essentialFailures = result.failed.filter((f) => f.essential);
    if (essentialFailures.length > 0) {
      console.warn(
        '[Preload] deferred track failures:',
        essentialFailures.map((f) => f.url).join(', '),
      );
    }
  });
}

/** First run level-up overlay: load perk icons once. */
export async function ensureLvlupAssetsLoaded(): Promise<void> {
  if (lvlupPreloadDone) return;
  if (!lvlupPreloadStarted) {
    lvlupPreloadStarted = true;
    const result = await preloadAssets(getLvlupAssetManifest());
    lvlupPreloadDone = true;
    if (result.failed.length > 0) {
      console.warn(
        '[Preload] lvlup icon failures:',
        result.failed.map((f) => f.url).join(', '),
      );
    }
    return;
  }
  while (!lvlupPreloadDone) {
    await new Promise((resolve) => window.setTimeout(resolve, 16));
  }
}

export function getEssentialPreloadFailures(
  result: PreloadGameAssetsResult,
): PreloadGameAssetsResult['failed'] {
  return result.failed.filter((entry) => entry.essential);
}
