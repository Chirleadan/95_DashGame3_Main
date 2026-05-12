/** Main dash active time (seconds); enemy freeze uses the same value. */
const DASH_DURATION_SEC = 0.140595;

/** Tunable gameplay and presentation constants. */
export const CONFIG = {
  /**
   * Half-extent of the floor plane / grid / shadow frustum (world XZ). Gameplay is not
   * clamped to this; only visuals — use a large value so the ground reads as unlimited.
   */
  arenaFloorVisualHalfExtent: 5000,
  /** Orthographic camera half-height (world); frustum top/bottom ±this, sides × aspect. */
  cameraViewHalfExtent: 18,
  floorY: 0,

  playerMaxHp: 3,
  /** Contact damage pulse hit radius = playerRadius × this (XZ). */
  playerDamagePulseRadiusMult: 25,
  /** White ring max outer radius ≈ playerRadius × this (XZ, visual only). */
  playerDamagePulseVisualRadiusMult: 15,
  /** HP subtracted from each enemy inside the pulse radius when the hero takes damage. */
  playerDamagePulseEnemyDamage: 3,
  playerSpeed: 14,
  playerRadius: 0.45,

  dashSpeed: 34,
  dashDuration: DASH_DURATION_SEC,
  /**
   * Trail and dash-kill segments extend past the clamped player position by this
   * fraction of nominal dash length (dashSpeed × dashDuration), along dash direction.
   */
  dashBeyondNominalLengthFraction: 0.5,
  dashCooldown: 0.5,
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

  /** When beatmap audio is playing, add this to the UI lens distortion (clamped with slider sum to 0.5). */
  lensDistortionWhileTrackPlaysBoost: 0.2,

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
  /** Beat `tp` with explicit `x`/`z`: wall-clock travel time (2000 ms). */
  teleportDurationSec: 2000 / 1000,
  /** Beat `tp` without coords (mirror «за спину»): wall-clock travel time (2000 ms). */
  teleportBehindDurationSec: 2000 / 1000,

  /** After death, show death screen this long (seconds) then return to main menu. */
  deathScreenToMenuDelaySec: 2.5,

  enemySpeed: 4.2,
  enemyRadius: 1.14,
  spawnInterval: 0.44,
  spawnMinDist: 22,
  spawnMaxDist: 38,
  maxEnemies: 48,
  /** Difficulty multiplier grows as `1 + runSeconds / this` (at 60s run → ×2). */
  difficultyRampTimeSec: 60,
  /** Cap on difficulty multiplier (speed / spawn / max count scale). */
  difficultyMaxMultiplier: 8,
  /** Hard cap on scaled max enemy count (performance). */
  difficultyMaxEnemyCountCap: 160,
  /** Do not scale spawn interval below this (seconds). */
  difficultyMinSpawnIntervalSec: 0.08,
  /** Flat HP lost each game tick per overlapping enemy (not scaled by deltaTime). */
  contactDamagePerTick: 1,
  initialEnemyCount: 4,

  /** Every N-th spawn is a vault / «Хранилище» (unless same tick is also a tank spawn). */
  vaultEveryNthSpawn: 75,
  /** Max «Хранилище» on the field at once (extra cadence spawns become normal). */
  vaultMaxSimultaneous: 2,
  /** Navigation: base disk radius around each Storage (XZ, world units). */
  storageObstacleRadius: 6.55,
  /** Extra margin added to `storageObstacleRadius` for enemy pathing (enemy centers stay outside). */
  storageObstaclePadding: 0.5,
  /** How far ahead (world units) to test seek segment vs Storage disks. */
  enemyAvoidanceLookahead: 5.5,
  /** Хранилище: flat hex prism; circumradius in XZ (matches cylinder radial extent). */
  vaultHexCircumradius: 6.15,
  vaultBodyThickness: 0.33,
  vaultBodyColor: 0x2a3044,
  vaultBodyEmissive: 0x0a0c12,
  vaultStripColor: 0x7ecbff,
  vaultShieldStripHeight: 0.33,
  vaultShieldStripDepth: 0.24,
  vaultShieldStripY: 0.285,
  /** Dash sweep vs shield segment join distance (XZ, world units). */
  vaultShieldDashJoinRadius: 2.46,

  /** Every N-th enemy spawn is a tank ("здоровяк"); only after `tankMinRunSecBeforeSpawn`. */
  tankEveryNthSpawn: 3,
  /** Run time (seconds) before any tank can spawn (cadence still uses `tankEveryNthSpawn`). */
  tankMinRunSecBeforeSpawn: 30,
  /** Tank body radius = `enemyRadius * this`. */
  tankRadiusScale: 3,
  tankHitsToKill: 2,
  /** Clear ring between tank body (radius r) and red outline (world units). */
  tankOutlineGap: 0.14,
  /** Radial thickness of the red outline ring (world units). */
  tankOutlineStroke: 0.16,
  /**
   * After dash damage hits a tank: snap past him along dash dir and set remaining
   * main-dash time to this fraction of full dash (scaled by on-beat mult).
   */
  dashPastTankRemainingFraction: 0.35,
  /** Gap behind tank center along dash dir when snapping past (world units). */
  dashPastTankBehindOffset: 0.18,
} as const;
