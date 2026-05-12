const STORAGE_KEY = 'game3-dash-artifacts-v1';

/** Ordered list of artifact ids (drives UI and saves). */
export const ARTIFACT_IDS = ['vaultBearing', 'reverseDash', 'bomb'] as const;
export type ArtifactId = (typeof ARTIFACT_IDS)[number];

export const ARTIFACT_LABELS: Record<ArtifactId, string> = {
  vaultBearing: 'Указатель на хранилище',
  reverseDash: 'Обратный дэш (авто)',
  bomb: 'Бомба',
};

const DEFAULTS: Record<ArtifactId, boolean> = {
  vaultBearing: true,
  reverseDash: false,
  bomb: false,
};

let enabled: Record<ArtifactId, boolean> = { ...DEFAULTS };

/** Merge saved flags with defaults (new artifacts default on). */
export function loadArtifacts(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      enabled = { ...DEFAULTS };
      return;
    }
    const o = JSON.parse(raw) as Record<string, unknown>;
    const next: Record<ArtifactId, boolean> = { ...DEFAULTS };
    for (const id of ARTIFACT_IDS) {
      const v = o[id];
      if (typeof v === 'boolean') {
        next[id] = v;
      }
    }
    enabled = next;
  } catch {
    enabled = { ...DEFAULTS };
  }
}

export function saveArtifacts(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(enabled));
  } catch {
    /* ignore quota */
  }
}

export function isArtifactEnabled(id: ArtifactId): boolean {
  return enabled[id] !== false;
}

export function setArtifactEnabled(id: ArtifactId, value: boolean): void {
  enabled = { ...enabled, [id]: value };
  saveArtifacts();
}
