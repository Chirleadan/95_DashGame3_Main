/** Main dash active time (seconds); enemy freeze uses the same value. */
const DASH_DURATION_SEC = 0.140595;

/** Tunable gameplay and presentation constants. */
export const CONFIG = {
  arenaHalfSize: 26,
  floorY: 0,

  playerMaxHp: 100,
  playerSpeed: 14,
  playerRadius: 0.45,

  dashSpeed: 34,
  dashDuration: DASH_DURATION_SEC,
  /**
   * Trail and dash-kill segments extend past the clamped player position by this
   * fraction of nominal dash length (dashSpeed × dashDuration), along dash direction.
   */
  dashBeyondNominalLengthFraction: 0.5,
  dashCooldown: 0.025,
  /** Enemies are frozen for this long at dash start (seconds). Same as `dashDuration`. */
  dashEnemyFreezeDuration: DASH_DURATION_SEC,
  /** Invulnerability after main + micro dash (seconds). */
  postDashInvulnerability: 0.15,
  /** Set false to skip backward micro-dash (main dash unchanged). */
  microDashEnabled: false,
  /** Backward micro-dash duration after main dash (seconds). */
  microDashDuration: 0.15,
  /** Micro-dash distance as a fraction of the distance traveled during the main dash. */
  microDashDistanceFraction: 0.5,
  dashTrailMaxPoints: 48,
  /** Shift dash trail slightly behind movement (world units). */
  dashTrailBehind: 0.16,
  /** Half-width of dash trail ribbon (world units). */
  dashTrailWidth: 0.17,
  /** Camera shake impulse per dash kill (clamped in Game). */
  dashKillShakePerEnemy: 0.2,
  dashKillShakeCap: 0.55,
  /** Dash kill sweep uses `playerRadius * this` (enemy radius unchanged). */
  dashKillPlayerRadiusScale: 4,

  /** Beat lane: note x = center + (beatTime - audioTime) * this (px/s), right → left. */
  beatLaneScrollPxPerSec: 880,
  beatLaneHeightPx: 100,
  beatLaneNoteRadiusPx: 36,
  /** Lane width as a fraction of the mount (e.g. 0.5 = half screen, centered). */
  beatLaneWidthFraction: 0.5,
  /** Main dash start counts as on-beat if audio time is within [beat - before, beat + after]. */
  dashBeatWindowBeforeSec: 0.3,
  dashBeatWindowAfterSec: 0.1,
  /** When starting a dash that will newly register an on-beat hit, dash length & trail width × this. */
  dashOnBeatLengthWidthMult: 2,

  enemySpeed: 4.2,
  enemyRadius: 1.14,
  spawnInterval: 0.44,
  spawnMinDist: 11,
  spawnMaxDist: 19,
  maxEnemies: 48,
  /** Flat HP lost each game tick per overlapping enemy (not scaled by deltaTime). */
  contactDamagePerTick: 100,
  initialEnemyCount: 4,
} as const;
