import {
  getGameAssetManifest,
  type PreloadAsset,
  type PreloadAssetKind,
} from './assetManifest.ts';

export type PreloadProgress = {
  loaded: number;
  total: number;
  fraction: number;
};

const loadedUrls = new Set<string>();

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

export async function preloadGameAssets(
  onProgress?: (progress: PreloadProgress) => void,
): Promise<PreloadGameAssetsResult> {
  const manifest = getGameAssetManifest();
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

export function getEssentialPreloadFailures(
  result: PreloadGameAssetsResult,
): PreloadGameAssetsResult['failed'] {
  return result.failed.filter((entry) => entry.essential);
}
