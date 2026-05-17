/** Icons for in-run level-up cards (`public/assets/lvlup`). */
const LVLUP_BASE = '/assets/lvlup';

function lvlupIcon(fileName: string): string {
  return `${LVLUP_BASE}/${encodeURIComponent(fileName)}`;
}

/** Upgrade choice `id` → icon URL. Choices without art keep the empty framed slot. */
export const RUN_UPGRADE_ART_BY_ID: Readonly<Record<string, string>> = {
  dash: lvlupIcon('Dash Range.png'),
  speed: lvlupIcon('Character  Speed.png'),
  shields: lvlupIcon('Shields.png'),
  shieldRegen: lvlupIcon('Shield Regen.png'),
  enemySlow: lvlupIcon('Enemy Slow.png'),
  rockets: lvlupIcon('Rockets.png'),
  artifactLightning: lvlupIcon('Artifact  Lightning.png'),
  artifactSideDashes: lvlupIcon('Claw-Dash.png'),
  artifactOrbitShield: lvlupIcon('Projectile Shields.png'),
  artifactPhaseDash: lvlupIcon('Phase Dash.png'),
  artifactSpiral: lvlupIcon('spiral.png'),
};

export function getRunUpgradeArtUrl(choiceId: string): string | undefined {
  return RUN_UPGRADE_ART_BY_ID[choiceId];
}
