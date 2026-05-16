import { CONFIG } from './config.ts';

const STORAGE_KEY = 'game3-dash-upgrades-v1';
const FIXED_DASH_DURATION_SEC = 0.115;

const DISCRETE_LEVELS = {
  dashNominalLengthWorld: [6, 7, 8, 9, 10],
  dashKillRadiusScale: [1.5, 2.75, 4, 5.25, 6.5],
  playerSpeed: [7, 8.5, 10, 11.5, 13],
  playerMaxHp: [1, 2, 3, 4, 5],
} as const;

export type BalanceSettingsState = {
  /** Main dash active time (seconds); enemy freeze matches this in gameplay. */
  dashDurationSec: number;
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
  dashNominalLengthWorld: { min: 6, max: 10 },
  dashKillRadiusScale: { min: 1.5, max: 6.5 },
  playerSpeed: { min: 7, max: 13 },
  playerMaxHp: { min: 1, max: 5 },
} as const;

function defaults(): BalanceSettingsState {
  return {
    dashDurationSec: FIXED_DASH_DURATION_SEC,
    dashNominalLengthWorld: snapToDiscreteLevel(
      CONFIG.dashSpeed * FIXED_DASH_DURATION_SEC,
      DISCRETE_LEVELS.dashNominalLengthWorld,
    ),
    dashKillRadiusScale: snapToDiscreteLevel(
      CONFIG.dashKillPlayerRadiusScale,
      DISCRETE_LEVELS.dashKillRadiusScale,
    ),
    playerSpeed: snapToDiscreteLevel(CONFIG.playerSpeed, DISCRETE_LEVELS.playerSpeed),
    playerMaxHp: snapToDiscreteLevel(CONFIG.playerMaxHp, DISCRETE_LEVELS.playerMaxHp),
  };
}

let current: BalanceSettingsState = defaults();

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

/** Call once before `Player` / `UI` read balance (e.g. start of `Game` constructor). */
export function loadBalanceSettings(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      current = defaults();
      return;
    }
    const o = JSON.parse(raw) as Partial<BalanceSettingsState>;
    const merged: BalanceSettingsState = { ...defaults(), ...o };
    if (
      typeof o.dashNominalLengthWorld !== 'number' ||
      !Number.isFinite(o.dashNominalLengthWorld)
    ) {
      merged.dashNominalLengthWorld = CONFIG.dashSpeed * FIXED_DASH_DURATION_SEC;
    }
    current = sanitize(merged);
  } catch {
    current = defaults();
  }
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
