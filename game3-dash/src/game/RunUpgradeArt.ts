/** Icons for in-run level-up cards (`public/assets/lvlup`). */
const LVLUP_BASE = '/assets/lvlup';

function lvlupIcon(fileName: string): string {
  return `${LVLUP_BASE}/${encodeURIComponent(fileName)}`;
}

/** Upgrade choice `id` → icon URL. Choices without art keep the empty framed slot. */
export const RUN_UPGRADE_ART_BY_ID: Readonly<Record<string, string>> = {
  dash: lvlupIcon('Dash Range.webp'),
  speed: lvlupIcon('Character  Speed.webp'),
  shields: lvlupIcon('Shields.webp'),
  shieldRegen: lvlupIcon('Shield Regen.webp'),
  enemySlow: lvlupIcon('Enemy Slow.webp'),
  rockets: lvlupIcon('Rockets.webp'),
  artifactLightning: lvlupIcon('Artifact  Lightning.webp'),
  artifactSideDashes: lvlupIcon('Claw-Dash.webp'),
  artifactOrbitShield: lvlupIcon('Projectile Shields.webp'),
  artifactPhaseDash: lvlupIcon('Phase Dash.webp'),
  artifactSpiral: lvlupIcon('spiral.webp'),
};

export function getRunUpgradeArtUrl(choiceId: string): string | undefined {
  return RUN_UPGRADE_ART_BY_ID[choiceId];
}
