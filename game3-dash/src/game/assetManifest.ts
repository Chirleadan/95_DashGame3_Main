import { BUTTON_SFX_ALL_URLS } from './ButtonSfxCatalog.ts';
import { CONFIG } from './config.ts';
import { RUN_UPGRADE_ART_BY_ID } from './RunUpgradeArt.ts';
import { TAPE_CASSETTES } from './TapeCatalog.ts';
import { TRACK_CATALOG, type TrackStage } from './TrackCatalog.ts';

export type PreloadAssetKind = 'image' | 'audio' | 'json' | 'font';

export type PreloadAsset = {
  url: string;
  kind: PreloadAssetKind;
  essential: boolean;
};

const PLAYER_TEXTURE_URLS = [
  '/assets/player/player_idle_1.png',
  '/assets/player/player_dash_1.png',
  '/assets/player/player_step_1.png',
  '/assets/player/player_step_2.png',
  '/assets/player/player_step_3.png',
  '/assets/player/player_step_4.png',
] as const;

const ENEMY_TEXTURE_URLS = [
  '/assets/enemies/normal/idle.png',
  '/assets/enemies/normal/mob_death.png',
  '/assets/enemies/shooter/idle.png',
  '/assets/enemies/shooter/shooter_death.png',
  '/assets/enemies/tank/idle.png',
  '/assets/enemies/tank/tank_death.png',
  '/assets/enemies/angel/idle.png',
  '/assets/enemies/angel/angel_death.png',
  '/assets/enemies/vault/vault_1.png',
] as const;

const GAME_SFX_URLS = [
  '/audio/dash_1.mp3',
  '/audio/death_1.mp3',
  '/audio/hit_1.mp3',
  '/audio/hit_2.mp3',
  '/audio/hit_3.mp3',
] as const;

const UI_IMAGE_URLS = ['/assets/back 1.png'] as const;

const FONT_URLS = [
  '/fonts/Pulsewidth-1.0.0.otf',
  '/fonts/FA-1-Regular.otf',
  '/fonts/bjork.ttf',
] as const;

function mergeManifestAssets(
  entries: Iterable<PreloadAsset>,
): PreloadAsset[] {
  const byUrl = new Map<string, PreloadAsset>();
  for (const asset of entries) {
    const normalized = asset.url.trim();
    if (!normalized) continue;
    const existing = byUrl.get(normalized);
    if (!existing) {
      byUrl.set(normalized, { ...asset, url: normalized });
      continue;
    }
    if (asset.essential) {
      existing.essential = true;
    }
  }
  return [...byUrl.values()];
}

export function getTrackStageAssets(
  stage: TrackStage,
  essential = true,
): PreloadAsset[] {
  return [
    { url: stage.beatmapUrl, kind: 'json', essential },
    { url: stage.audioUrl, kind: 'audio', essential },
  ];
}

/** Beatmap + audio for enabled stages except the one already in core preload. */
export function getDeferredTrackManifest(excludeStageId: string): PreloadAsset[] {
  const entries: PreloadAsset[] = [];
  for (const track of TRACK_CATALOG) {
    for (const stage of track.stages) {
      if (!stage.enabled || stage.id === excludeStageId) continue;
      entries.push(...getTrackStageAssets(stage, false));
    }
  }
  return mergeManifestAssets(entries);
}

export function getLvlupAssetManifest(): PreloadAsset[] {
  return mergeManifestAssets(
    Object.values(RUN_UPGRADE_ART_BY_ID).map((url) => ({
      url,
      kind: 'image' as const,
      essential: false,
    })),
  );
}

/**
 * Assets required before the main menu: gameplay sprites, menu UI, selected tape only.
 */
export function getCoreGameAssetManifest(selectedStage: TrackStage): PreloadAsset[] {
  const entries: PreloadAsset[] = [];

  const add = (url: string, kind: PreloadAssetKind, essential = true): void => {
    entries.push({ url, kind, essential });
  };

  for (const url of PLAYER_TEXTURE_URLS) add(url, 'image');
  for (const url of ENEMY_TEXTURE_URLS) add(url, 'image');
  for (const url of GAME_SFX_URLS) add(url, 'audio');
  for (const url of BUTTON_SFX_ALL_URLS) add(url, 'audio');
  for (const url of UI_IMAGE_URLS) add(url, 'image');
  for (const url of FONT_URLS) add(url, 'font');

  add(CONFIG.menuMusicUrl, 'audio');
  add(CONFIG.backgroundMusicUrl, 'audio');

  for (const tape of TAPE_CASSETTES) {
    add(tape.imageUrl, 'image');
  }

  entries.push(...getTrackStageAssets(selectedStage, true));
  entries.push(...getLvlupAssetManifest().map((asset) => ({ ...asset, essential: true })));

  return mergeManifestAssets(entries);
}
