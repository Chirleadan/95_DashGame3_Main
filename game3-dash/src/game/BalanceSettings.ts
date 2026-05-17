const STORAGE_KEY = 'game3-dash-upgrades-v1';
const UNLOCK_STORAGE_KEY = 'game3-dash-upgrade-unlocks-v1';
const FIXED_DASH_DURATION_SEC = 0.115;

export const BALANCE_DISCRETE_LEVELS = {
  dashCooldownSec: [0.65, 0.5, 0.35],
  dashNominalLengthWorld: [6, 7, 8, 9, 10],
  dashKillRadiusScale: [1.5, 2.75, 4, 5.25, 6.5],
  playerSpeed: [7, 8.5, 10, 11.5, 13],
  playerMaxHp: [1, 2, 3, 4, 5],
} as const;

const DISCRETE_LEVELS = BALANCE_DISCRETE_LEVELS;

export type BalanceDiscreteStatKey = keyof typeof BALANCE_DISCRETE_LEVELS;

export type BalanceSettingsState = {
  /** Main dash active time (seconds); enemy freeze matches this in gameplay. */
  dashDurationSec: number;
  /** Delay after dash start before another dash can begin (seconds). */
  dashCooldownSec: number;
  /**
   * Nominal dash travel distance in world XZ at length-mult `1` over `dashDurationSec`.
   * Effective dash speed = this / `dashDurationSec` (see `getEffectiveDashSpeed`).
   */
  dashNominalLengthWorld: number;
  /** Dash kill sweep: `playerRadius * this`. */
  dashKillRadiusScale: number;
  playerSpeed: number;
  playerMaxHp: number;
};

const LIMITS = {
  dashDurationSec: { min: FIXED_DASH_DURATION_SEC, max: FIXED_DASH_DURATION_SEC },
  dashCooldownSec: { min: 0.35, max: 0.65 },
  dashNominalLengthWorld: { min: 6, max: 10 },
  dashKillRadiusScale: { min: 1.5, max: 6.5 },
  playerSpeed: { min: 7, max: 13 },
  playerMaxHp: { min: 1, max: 5 },
} as const;

function defaults(): BalanceSettingsState {
  return {
    dashDurationSec: FIXED_DASH_DURATION_SEC,
    dashCooldownSec: DISCRETE_LEVELS.dashCooldownSec[0]!,
    dashNominalLengthWorld: DISCRETE_LEVELS.dashNominalLengthWorld[0]!,
    dashKillRadiusScale: DISCRETE_LEVELS.dashKillRadiusScale[0]!,
    playerSpeed: DISCRETE_LEVELS.playerSpeed[0]!,
    playerMaxHp: DISCRETE_LEVELS.playerMaxHp[0]!,
  };
}

function resetUpgradeUnlocksToMinimum(): void {
  for (const key of Object.keys(BALANCE_DISCRETE_LEVELS) as BalanceDiscreteStatKey[]) {
    maxUnlockedLevelIndex[key] = 0;
  }
  vaultMaxUnlockedLevel = 0;
}

/** Active tier cannot exceed the highest purchased tier. */
function clampActiveBalanceToUnlocks(): void {
  let changed = false;
  for (const key of Object.keys(BALANCE_DISCRETE_LEVELS) as BalanceDiscreteStatKey[]) {
    const maxIdx = maxUnlockedLevelIndex[key];
    const activeIdx = getDiscreteLevelIndex(key, current[key]);
    if (activeIdx > maxIdx) {
      current[key] = getDiscreteLevelValue(key, maxIdx);
      changed = true;
    }
  }
  if (changed) {
    saveBalanceSettings();
  }
}

let current: BalanceSettingsState = defaults();

/** Highest purchased tier index per stat (separate from the active tier). */
let maxUnlockedLevelIndex: Record<BalanceDiscreteStatKey, number> = {
  dashCooldownSec: 0,
  dashNominalLengthWorld: 0,
  dashKillRadiusScale: 0,
  playerSpeed: 0,
  playerMaxHp: 0,
};

/** `0` = off only; `1` = storage pointer was purchased (can toggle off/on freely). */
let vaultMaxUnlockedLevel = 0;

/** Added to `dashNominalLengthWorld` for the current run only (cleared on new run / menu). */
let runBonusDashNominalLengthWorld = 0;
/** Added to `playerMaxHp` for the current run only. */
let runBonusPlayerMaxHp = 0;
/** Added to `playerSpeed` for the current run only. */
let runBonusPlayerSpeed = 0;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function snapToDiscreteLevel<T extends readonly number[]>(n: number, levels: T): T[number] {
  const fallback = levels[0]!;
  if (!Number.isFinite(n)) return fallback;
  let best = fallback;
  let bestDist = Math.abs(n - best);
  for (const level of levels) {
    const dist = Math.abs(n - level);
    if (dist < bestDist) {
      best = level;
      bestDist = dist;
    }
  }
  return best;
}

function sanitize(p: BalanceSettingsState): BalanceSettingsState {
  return {
    dashDurationSec: FIXED_DASH_DURATION_SEC,
    dashCooldownSec: snapToDiscreteLevel(
      clamp(p.dashCooldownSec, LIMITS.dashCooldownSec.min, LIMITS.dashCooldownSec.max),
      DISCRETE_LEVELS.dashCooldownSec,
    ),
    dashNominalLengthWorld: snapToDiscreteLevel(
      clamp(
        p.dashNominalLengthWorld,
        LIMITS.dashNominalLengthWorld.min,
        LIMITS.dashNominalLengthWorld.max,
      ),
      DISCRETE_LEVELS.dashNominalLengthWorld,
    ),
    dashKillRadiusScale: snapToDiscreteLevel(
      clamp(
        p.dashKillRadiusScale,
        LIMITS.dashKillRadiusScale.min,
        LIMITS.dashKillRadiusScale.max,
      ),
      DISCRETE_LEVELS.dashKillRadiusScale,
    ),
    playerSpeed: snapToDiscreteLevel(
      clamp(p.playerSpeed, LIMITS.playerSpeed.min, LIMITS.playerSpeed.max),
      DISCRETE_LEVELS.playerSpeed,
    ),
    playerMaxHp: snapToDiscreteLevel(
      clamp(p.playerMaxHp, LIMITS.playerMaxHp.min, LIMITS.playerMaxHp.max),
      DISCRETE_LEVELS.playerMaxHp,
    ),
  };
}

function loadUpgradeUnlocks(): void {
  try {
    const raw = localStorage.getItem(UNLOCK_STORAGE_KEY);
    if (!raw) {
      resetUpgradeUnlocksToMinimum();
      return;
    }
    const o = JSON.parse(raw) as {
      maxLevelIndex?: Partial<Record<BalanceDiscreteStatKey, number>>;
      vaultMaxLevel?: number;
    };
    for (const key of Object.keys(BALANCE_DISCRETE_LEVELS) as BalanceDiscreteStatKey[]) {
      const levels = BALANCE_DISCRETE_LEVELS[key];
      const n = Math.floor(Number(o.maxLevelIndex?.[key]));
      maxUnlockedLevelIndex[key] = Number.isFinite(n)
        ? Math.max(0, Math.min(levels.length - 1, n))
        : 0;
    }
    const vaultN = Math.floor(Number(o.vaultMaxLevel));
    vaultMaxUnlockedLevel = vaultN >= 1 ? 1 : 0;
  } catch {
    resetUpgradeUnlocksToMinimum();
  }
}

function saveUpgradeUnlocks(): void {
  try {
    localStorage.setItem(
      UNLOCK_STORAGE_KEY,
      JSON.stringify({
        maxLevelIndex: maxUnlockedLevelIndex,
        vaultMaxLevel: vaultMaxUnlockedLevel,
      }),
    );
  } catch {
    /* ignore quota */
  }
}

/** Call once before `Player` / `UI` read balance (e.g. start of `Game` constructor). */
export function loadBalanceSettings(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      current = defaults();
    } else {
      const o = JSON.parse(raw) as Partial<BalanceSettingsState>;
      current = sanitize({ ...defaults(), ...o });
    }
  } catch {
    current = defaults();
  }
  loadUpgradeUnlocks();
  clampActiveBalanceToUnlocks();
}

export function saveBalanceSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* ignore quota */
  }
}

export function getDashDurationSec(): number {
  return current.dashDurationSec;
}

export function getDashCooldownSec(): number {
  return current.dashCooldownSec;
}

export function getDashNominalLengthWorld(): number {
  const sum = current.dashNominalLengthWorld + runBonusDashNominalLengthWorld;
  return clamp(
    sum,
    LIMITS.dashNominalLengthWorld.min,
    LIMITS.dashNominalLengthWorld.max,
  );
}

/** World units per second so that `speed × dashDurationSec` matches nominal dash length. */
export function getEffectiveDashSpeed(): number {
  const t = current.dashDurationSec;
  if (!(t > 1e-8)) return 0;
  return getDashNominalLengthWorld() / t;
}

export function getDashKillRadiusScale(): number {
  return current.dashKillRadiusScale;
}

export function getPlayerSpeed(): number {
  const sum = current.playerSpeed + runBonusPlayerSpeed;
  return clamp(sum, LIMITS.playerSpeed.min, LIMITS.playerSpeed.max);
}

export function getPlayerMaxHp(): number {
  return Math.round(
    clamp(
      current.playerMaxHp + runBonusPlayerMaxHp,
      LIMITS.playerMaxHp.min,
      LIMITS.playerMaxHp.max,
    ),
  );
}

/** Reset in-run bonuses (new run or return to menu). */
export function clearRunBalanceBonuses(): void {
  runBonusDashNominalLengthWorld = 0;
  runBonusPlayerMaxHp = 0;
  runBonusPlayerSpeed = 0;
}

export function addRunDashNominalLengthBonus(delta: number): void {
  if (Number.isFinite(delta) && delta !== 0) {
    runBonusDashNominalLengthWorld += delta;
  }
}

export function addRunPlayerMaxHpBonus(delta: number): void {
  const n = Math.round(delta);
  if (n !== 0) {
    runBonusPlayerMaxHp += n;
  }
}

export function addRunPlayerSpeedBonus(delta: number): void {
  if (Number.isFinite(delta) && delta !== 0) {
    runBonusPlayerSpeed += delta;
  }
}

export function getBalanceSnapshot(): BalanceSettingsState {
  return { ...current };
}

export function setBalancePatch(patch: Partial<BalanceSettingsState>): void {
  current = sanitize({ ...current, ...patch });
  saveBalanceSettings();
}

export function balanceLimits(): typeof LIMITS {
  return LIMITS;
}

export function getDiscreteLevels(key: BalanceDiscreteStatKey): readonly number[] {
  return BALANCE_DISCRETE_LEVELS[key];
}

export function getDiscreteLevelIndex(key: BalanceDiscreteStatKey, value: number): number {
  const levels = BALANCE_DISCRETE_LEVELS[key];
  const snapped = snapToDiscreteLevel(value, levels);
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] === snapped) return i;
  }
  return 0;
}

export function getDiscreteLevelValue(key: BalanceDiscreteStatKey, index: number): number {
  const levels = BALANCE_DISCRETE_LEVELS[key];
  const i = Math.max(0, Math.min(levels.length - 1, Math.floor(index)));
  return levels[i]!;
}

export function getMaxUnlockedLevelIndex(key: BalanceDiscreteStatKey): number {
  return maxUnlockedLevelIndex[key];
}

export function setMaxUnlockedLevelIndex(key: BalanceDiscreteStatKey, index: number): void {
  const levels = BALANCE_DISCRETE_LEVELS[key];
  const i = Math.max(0, Math.min(levels.length - 1, Math.floor(index)));
  maxUnlockedLevelIndex[key] = Math.max(maxUnlockedLevelIndex[key], i);
  saveUpgradeUnlocks();
}

export function getVaultMaxUnlockedLevel(): number {
  return vaultMaxUnlockedLevel;
}

export function unlockVaultMaxLevel(): void {
  vaultMaxUnlockedLevel = 1;
  saveUpgradeUnlocks();
}
