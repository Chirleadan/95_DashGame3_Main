import { CONFIG } from './config.ts';

const STORAGE_KEY = 'game3-dash-upgrades-v1';

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
  dashDurationSec: { min: 0.08, max: 0.35 },
  dashNominalLengthWorld: { min: 2, max: 45 },
  dashKillRadiusScale: { min: 1, max: 10 },
  playerSpeed: { min: 6, max: 30 },
  playerMaxHp: { min: 1, max: 10 },
} as const;

function defaults(): BalanceSettingsState {
  return {
    dashDurationSec: CONFIG.dashDuration,
    dashNominalLengthWorld: CONFIG.dashSpeed * CONFIG.dashDuration,
    dashKillRadiusScale: CONFIG.dashKillPlayerRadiusScale,
    playerSpeed: CONFIG.playerSpeed,
    playerMaxHp: CONFIG.playerMaxHp,
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

function sanitize(p: BalanceSettingsState): BalanceSettingsState {
  return {
    dashDurationSec: clamp(
      p.dashDurationSec,
      LIMITS.dashDurationSec.min,
      LIMITS.dashDurationSec.max,
    ),
    dashNominalLengthWorld: clamp(
      p.dashNominalLengthWorld,
      LIMITS.dashNominalLengthWorld.min,
      LIMITS.dashNominalLengthWorld.max,
    ),
    dashKillRadiusScale: clamp(
      p.dashKillRadiusScale,
      LIMITS.dashKillRadiusScale.min,
      LIMITS.dashKillRadiusScale.max,
    ),
    playerSpeed: clamp(p.playerSpeed, LIMITS.playerSpeed.min, LIMITS.playerSpeed.max),
    playerMaxHp: Math.round(
      clamp(p.playerMaxHp, LIMITS.playerMaxHp.min, LIMITS.playerMaxHp.max),
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
      merged.dashNominalLengthWorld = CONFIG.dashSpeed * merged.dashDurationSec;
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
