import { CONFIG } from './config.ts';

export type RunUpgradeLibraryEntry = {
  id: string;
  label: string;
  description: string;
  accentColor?: string;
};

export const RUN_UPGRADE_COLOR_UTILITY = '#a36eff';
export const RUN_UPGRADE_COLOR_ARTIFACT = '#ffd35c';
export const RUN_UPGRADE_COLOR_RARE_ARTIFACT = '#e00b3d';
export const RUN_UPGRADE_COLOR_DEFAULT = '#f7fbff';

/** All in-run level-up spells for the main-menu Library. */
export const RUN_UPGRADE_LIBRARY: readonly RunUpgradeLibraryEntry[] = [
  {
    id: 'dash',
    label: 'Dash Range',
    description: 'Longer main dash.',
  },
  {
    id: 'speed',
    label: 'Character Speed',
    description: 'Move faster.',
  },
  {
    id: 'shields',
    label: 'Shields',
    description: 'Adds max shield and restores one.',
    accentColor: RUN_UPGRADE_COLOR_UTILITY,
  },
  {
    id: 'shieldRegen',
    label: 'Shield Regen',
    description: `Faster passive shield recovery. Minimum interval: ${CONFIG.shieldRegenMinIntervalSec} s.`,
    accentColor: RUN_UPGRADE_COLOR_UTILITY,
  },
  {
    id: 'enemySlow',
    label: 'Enemy Slow',
    description: 'Slows all enemies. Stacks up to 5 levels in a run.',
    accentColor: RUN_UPGRADE_COLOR_UTILITY,
  },
  {
    id: 'rockets',
    label: 'Rockets',
    description: 'Random visible explosions. Higher levels trigger more often.',
    accentColor: RUN_UPGRADE_COLOR_ARTIFACT,
  },
  {
    id: 'artifactLightning',
    label: 'Artifact: Lightning',
    description:
      'Auto-dashes into nearby enemies after enough dashes. Higher levels trigger faster and add more hits.',
    accentColor: RUN_UPGRADE_COLOR_ARTIFACT,
  },
  {
    id: 'artifactSideDashes',
    label: 'Artifact: Claw-Dash',
    description: 'Adds delayed claw dashes beside your main dash. Level two adds the other side.',
    accentColor: RUN_UPGRADE_COLOR_ARTIFACT,
  },
  {
    id: 'artifactOrbitShield',
    label: 'Artifact: Projectile Shields',
    description: 'Rotating projectile shield. Each level adds another segment.',
    accentColor: RUN_UPGRADE_COLOR_UTILITY,
  },
  {
    id: 'artifactPhaseDash',
    label: 'Artifact: Phase Dash',
    description: 'Dash through normal mobs and shooters.',
    accentColor: RUN_UPGRADE_COLOR_RARE_ARTIFACT,
  },
  {
    id: 'artifactSpiral',
    label: 'Artifact: Spiral',
    description: 'Hold mouse and draw an arc. Your dash follows the drawn curve.',
    accentColor: RUN_UPGRADE_COLOR_RARE_ARTIFACT,
  },
];

export function findRunUpgradeLibraryEntry(id: string): RunUpgradeLibraryEntry | null {
  return RUN_UPGRADE_LIBRARY.find((entry) => entry.id === id) ?? null;
}
