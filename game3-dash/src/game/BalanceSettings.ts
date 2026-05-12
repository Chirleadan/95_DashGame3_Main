import { CONFIG } from './config.ts';

const STORAGE_KEY = 'game3-dash-upgrades-v1';

export type BalanceSettingsState = {
  /** Main dash active time (seconds); enemy freeze matches this in gameplay. */
  dashDurationSec: number;
  /** Dash kill sweep: `playerRadius * this`. */
  dashKillRadiusScale: number;
  playerSpeed: number;
  playerMaxHp: number;
};

const LIMITS = {
  dashDurationSec: { min: 0.08, max: 0.35 },
  dashKillRadiusScale: { min: 1, max: 10 },
  playerSpeed: { min: 6, max: 30 },
  playerMaxHp: { min: 1, max: 10 },
} as const;

function defaults(): BalanceSettingsState {
  return {
    dashDurationSec: CONFIG.dashDuration,
    dashKillRadiusScale: CONFIG.dashKillPlayerRadiusScale,
    playerSpeed: CONFIG.playerSpeed,
    playerMaxHp: CONFIG.playerMaxHp,
  };
}

let current: BalanceSettingsState = defaults();

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
    current = sanitize({ ...defaults(), ...o });
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

export function getDashKillRadiusScale(): number {
  return current.dashKillRadiusScale;
}

export function getPlayerSpeed(): number {
  return current.playerSpeed;
}

export function getPlayerMaxHp(): number {
  return current.playerMaxHp;
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
