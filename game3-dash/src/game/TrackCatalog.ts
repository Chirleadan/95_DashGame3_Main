import { CONFIG } from './config.ts';

/**
 * New files live under `public/audio` and `public/beatmaps`.
 * Catalog URLs are web paths, e.g. `public/audio/foo.mp3` -> `/audio/foo.mp3`.
 */

export type TrackStageBoost = {
  /** Added to the lens slider amount while the selected track is playing. */
  lensDistortionWhilePlaying: number;
  /** Multiplies every main dash length while this track is playing. */
  dashLengthMultWhilePlaying: number;
  /** Multiplies player walk speed while this track is playing. */
  playerSpeedMultWhilePlaying: number;
  /** Main dash length and trail width multiplier for a new on-beat dash. */
  onBeatDashLengthWidthMult: number;
  /** Whether a successful on-beat dash instantly clears dash cooldown. */
  resetDashCooldownOnBeat: boolean;
  /** Creates a pulse on every dash landing; `0` disables it. `3` = 3x reference pulse size. */
  dashLandingPulseRadiusMult: number;
  /**
   * Track 3: on-beat dash spawns this many phantom strikes (`0` = off).
   * Fired sequentially in-game with a short delay between each.
   */
  phantomBeatDashCount: number;
};

export type TrackStage = {
  id: string;
  stage: number;
  label: string;
  beatmapUrl: string;
  audioUrl: string;
  enabled: boolean;
  boost: TrackStageBoost;
};

export type TrackEntry = {
  id: string;
  label: string;
  stages: TrackStage[];
};

export const DEFAULT_TRACK_SELECTION = {
  trackId: 'track-1',
  stageId: 'track-1-stage-3',
} as const;

const TRACK_1_STAGE_3_BOOST: TrackStageBoost = {
  lensDistortionWhilePlaying: CONFIG.lensDistortionWhileTrackPlaysBoost,
  dashLengthMultWhilePlaying: 1,
  playerSpeedMultWhilePlaying: 1,
  onBeatDashLengthWidthMult: CONFIG.dashOnBeatLengthWidthMult,
  resetDashCooldownOnBeat: true,
  dashLandingPulseRadiusMult: 0,
  phantomBeatDashCount: 0,
};

const TRACK_2_BASE_BOOST = {
  lensDistortionWhilePlaying: 0.08,
  dashLengthMultWhilePlaying: 0.25,
  playerSpeedMultWhilePlaying: 0.5,
  onBeatDashLengthWidthMult: 1,
  resetDashCooldownOnBeat: true,
} as const;

const TRACK_2_STAGE_BOOSTS: Record<number, TrackStageBoost> = {
  1: {
    ...TRACK_2_BASE_BOOST,
    dashLandingPulseRadiusMult: 1.75,
    phantomBeatDashCount: 0,
  },
  2: {
    ...TRACK_2_BASE_BOOST,
    dashLandingPulseRadiusMult: 2.25,
    phantomBeatDashCount: 0,
  },
  3: {
    ...TRACK_2_BASE_BOOST,
    dashLandingPulseRadiusMult: 3,
    phantomBeatDashCount: 0,
  },
};

const TRACK_3_STAGE_BOOSTS: Record<number, TrackStageBoost> = {
  1: {
    lensDistortionWhilePlaying: 0,
    dashLengthMultWhilePlaying: 1,
    playerSpeedMultWhilePlaying: 1,
    onBeatDashLengthWidthMult: 1,
    resetDashCooldownOnBeat: true,
    dashLandingPulseRadiusMult: 0,
    phantomBeatDashCount: 1,
  },
  2: {
    lensDistortionWhilePlaying: 0,
    dashLengthMultWhilePlaying: 1,
    playerSpeedMultWhilePlaying: 1,
    onBeatDashLengthWidthMult: 1,
    resetDashCooldownOnBeat: true,
    dashLandingPulseRadiusMult: 0,
    phantomBeatDashCount: 2,
  },
  3: {
    lensDistortionWhilePlaying: 0,
    dashLengthMultWhilePlaying: 1,
    playerSpeedMultWhilePlaying: 1,
    onBeatDashLengthWidthMult: 1,
    resetDashCooldownOnBeat: true,
    dashLandingPulseRadiusMult: 0,
    phantomBeatDashCount: 3,
  },
};

const STAGE_PLACEHOLDER_BOOSTS: Record<number, TrackStageBoost> = {
  1: {
    lensDistortionWhilePlaying: 0.08,
    dashLengthMultWhilePlaying: 1,
    playerSpeedMultWhilePlaying: 1,
    onBeatDashLengthWidthMult: 1.25,
    resetDashCooldownOnBeat: true,
    dashLandingPulseRadiusMult: 0,
    phantomBeatDashCount: 0,
  },
  2: {
    lensDistortionWhilePlaying: 0.14,
    dashLengthMultWhilePlaying: 1,
    playerSpeedMultWhilePlaying: 1,
    onBeatDashLengthWidthMult: 1.6,
    resetDashCooldownOnBeat: true,
    dashLandingPulseRadiusMult: 0,
    phantomBeatDashCount: 0,
  },
  3: TRACK_1_STAGE_3_BOOST,
};

function makeStage(
  trackNo: number,
  stageNo: number,
  opts: {
    beatmapUrl?: string;
    audioUrl?: string;
    enabled?: boolean;
    boost?: TrackStageBoost;
  } = {},
): TrackStage {
  return {
    id: `track-${trackNo}-stage-${stageNo}`,
    stage: stageNo,
    label: `Stage ${stageNo}`,
    beatmapUrl: opts.beatmapUrl ?? `/beatmaps/track-${trackNo}-stage-${stageNo}.json`,
    audioUrl: opts.audioUrl ?? `/audio/track-${trackNo}-stage-${stageNo}.mp3`,
    enabled: opts.enabled ?? false,
    boost: opts.boost ?? STAGE_PLACEHOLDER_BOOSTS[stageNo] ?? STAGE_PLACEHOLDER_BOOSTS[1]!,
  };
}

export const TRACK_CATALOG: readonly TrackEntry[] = [
  {
    id: 'track-1',
    label: 'Track 1',
    stages: [
      makeStage(1, 1, { enabled: true }),
      makeStage(1, 2, { enabled: true }),
      makeStage(1, 3, {
        enabled: true,
        boost: TRACK_1_STAGE_3_BOOST,
      }),
    ],
  },
  {
    id: 'track-2',
    label: 'Track 2',
    stages: [
      makeStage(2, 1, { enabled: true, boost: TRACK_2_STAGE_BOOSTS[1]! }),
      makeStage(2, 2, { enabled: true, boost: TRACK_2_STAGE_BOOSTS[2]! }),
      makeStage(2, 3, { enabled: true, boost: TRACK_2_STAGE_BOOSTS[3]! }),
    ],
  },
  {
    id: 'track-3',
    label: 'Track 3',
    stages: [
      makeStage(3, 1, {
        audioUrl: '/audio/track-3-stage-1.mp3.OPUS',
        enabled: true,
        boost: TRACK_3_STAGE_BOOSTS[1]!,
      }),
      makeStage(3, 2, {
        audioUrl: '/audio/track-3-stage2.mp3',
        enabled: true,
        boost: TRACK_3_STAGE_BOOSTS[2]!,
      }),
      makeStage(3, 3, { enabled: true, boost: TRACK_3_STAGE_BOOSTS[3]! }),
    ],
  },
];

export function findTrackStage(trackId: string, stageId: string): TrackStage | null {
  const track = TRACK_CATALOG.find((entry) => entry.id === trackId);
  if (!track) return null;
  return track.stages.find((stage) => stage.id === stageId) ?? null;
}

/** Highest `stage` number among file-ready stages for this track (ignores player unlocks). */
export function getHighestEnabledTrackStage(trackId: string): TrackStage | null {
  const track = TRACK_CATALOG.find((entry) => entry.id === trackId);
  if (!track) return null;
  let best: TrackStage | null = null;
  for (const stage of track.stages) {
    if (!stage.enabled) continue;
    if (!best || stage.stage > best.stage) {
      best = stage;
    }
  }
  return best;
}

export function findTrackForStage(stageId: string): TrackEntry | null {
  return (
    TRACK_CATALOG.find((entry) =>
      entry.stages.some((stage) => stage.id === stageId),
    ) ?? null
  );
}

export function getDefaultTrackStage(): TrackStage {
  return (
    findTrackStage(
      DEFAULT_TRACK_SELECTION.trackId,
      DEFAULT_TRACK_SELECTION.stageId,
    ) ?? TRACK_CATALOG[0]!.stages[0]!
  );
}
