import {
  findTrackForStage,
  TRACK_CATALOG,
  type TrackStage,
} from './TrackCatalog.ts';
import { TAPE_CASSETTES } from './TapeCatalog.ts';

const STORAGE_KEY = 'game3-dash-tape-stage-unlocks-v1';

/** Per-track bitmask: bit (stage-1) = stage unlocked. */
type UnlockStore = Record<string, number>;

let cache: UnlockStore | null = null;

function loadStore(): UnlockStore {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = {};
      return cache;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      cache = {};
      return cache;
    }
    const out: UnlockStore = {};
    for (const [trackId, mask] of Object.entries(parsed as Record<string, unknown>)) {
      const n = Math.floor(Number(mask));
      if (Number.isFinite(n) && n > 0) {
        out[trackId] = n;
      }
    }
    cache = out;
    return out;
  } catch {
    cache = {};
    return cache;
  }
}

function persist(store: UnlockStore): void {
  cache = store;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* ignore quota */
  }
}

function stageBit(stageNo: number): number {
  const s = Math.floor(stageNo);
  if (s < 1 || s > 31) return 0;
  return 1 << (s - 1);
}

export function isTapeStageUnlocked(trackId: string, stageNo: number): boolean {
  const mask = loadStore()[trackId] ?? 0;
  const bit = stageBit(stageNo);
  return bit > 0 && (mask & bit) !== 0;
}

export function isTapeStagePlayable(stage: TrackStage): boolean {
  const track = findTrackForStage(stage.id);
  if (!track || !stage.enabled) return false;
  return isTapeStageUnlocked(track.id, stage.stage);
}

export function unlockTapeStage(trackId: string, stageNo: number): boolean {
  const bit = stageBit(stageNo);
  if (bit <= 0) return false;
  const store = { ...loadStore() };
  const cur = store[trackId] ?? 0;
  if ((cur & bit) !== 0) return false;
  store[trackId] = cur | bit;
  persist(store);
  return true;
}

export type TapeFragmentUnlock = {
  trackId: string;
  stageNo: number;
  trackLabel: string;
  stageLabel: string;
};

/** Random locked stage on any tape; unlocks and returns info, or null if all unlocked. */
export function tryUnlockRandomTapeFragment(): TapeFragmentUnlock | null {
  const pool: { trackId: string; stageNo: number }[] = [];
  for (const tape of TAPE_CASSETTES) {
    const track = TRACK_CATALOG.find((entry) => entry.id === tape.trackId);
    if (!track) continue;
    for (const stage of track.stages) {
      if (!stage.enabled) continue;
      if (isTapeStageUnlocked(track.id, stage.stage)) continue;
      pool.push({ trackId: track.id, stageNo: stage.stage });
    }
  }
  if (pool.length <= 0) return null;
  const pick = pool[Math.floor(Math.random() * pool.length)]!;
  if (!unlockTapeStage(pick.trackId, pick.stageNo)) return null;
  const track = TRACK_CATALOG.find((entry) => entry.id === pick.trackId);
  const stage = track?.stages.find((s) => s.stage === pick.stageNo);
  return {
    trackId: pick.trackId,
    stageNo: pick.stageNo,
    trackLabel: track?.label ?? pick.trackId,
    stageLabel: stage?.label ?? `Stage ${pick.stageNo}`,
  };
}

export function getHighestUnlockedTrackStage(trackId: string): TrackStage | null {
  const track = TRACK_CATALOG.find((entry) => entry.id === trackId);
  if (!track) return null;
  let best: TrackStage | null = null;
  for (const stage of track.stages) {
    if (!stage.enabled) continue;
    if (!isTapeStageUnlocked(trackId, stage.stage)) continue;
    if (!best || stage.stage > best.stage) {
      best = stage;
    }
  }
  return best;
}

/** First unlocked stage in catalog order (for initial selection). */
export function getDefaultPlayableTrackStage(): TrackStage | null {
  for (const track of TRACK_CATALOG) {
    for (const stage of track.stages) {
      if (isTapeStagePlayable(stage)) {
        return stage;
      }
    }
  }
  return null;
}

export function getUnlockedStageCount(trackId: string): number {
  const track = TRACK_CATALOG.find((entry) => entry.id === trackId);
  if (!track) return 0;
  let n = 0;
  for (const stage of track.stages) {
    if (stage.enabled && isTapeStageUnlocked(trackId, stage.stage)) {
      n += 1;
    }
  }
  return n;
}

/** Dev / cheat: clear all tape stage unlocks. */
export function resetAllTapeStageUnlocks(): void {
  persist({});
}
