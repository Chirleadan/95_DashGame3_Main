import {
  getDefaultTrackStage,
  type TrackStage,
  TRACK_CATALOG,
} from './TrackCatalog.ts';
import { getDefaultPlayableTrackStage } from './TapeStageUnlocks.ts';

const STORAGE_KEY = 'game3-dash-selected-tape-stage-id';

export function findTrackStageById(stageId: string): TrackStage | null {
  for (const track of TRACK_CATALOG) {
    const stage = track.stages.find((s) => s.id === stageId);
    if (stage) return stage;
  }
  return null;
}

export function loadSelectedTrackStageId(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const id = JSON.parse(raw);
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export function saveSelectedTrackStageId(stageId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stageId));
  } catch {
    /* ignore quota */
  }
}

/** Last chosen cassette (persisted), or first playable / catalog default. */
export function resolveStoredOrDefaultTrackStage(): TrackStage {
  const savedId = loadSelectedTrackStageId();
  if (savedId) {
    const stage = findTrackStageById(savedId);
    if (stage?.enabled) return stage;
  }
  return getDefaultPlayableTrackStage() ?? getDefaultTrackStage();
}
