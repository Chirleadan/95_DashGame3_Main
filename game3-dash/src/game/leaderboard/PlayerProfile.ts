const STORAGE_KEY = 'game3-dash-player-v1';

export type StoredPlayer = {
  playerId: string;
  nickname: string;
};

type PersistedProfile = {
  nickname?: string;
  playerId?: string;
};

let cache: PersistedProfile | null | undefined;

function readProfile(): PersistedProfile | null {
  if (cache !== undefined) {
    return cache;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = null;
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedProfile;
    const nickname =
      typeof parsed.nickname === 'string' ? parsed.nickname.trim() : '';
    const playerId =
      typeof parsed.playerId === 'string' ? parsed.playerId.trim() : '';
    if (!nickname && !playerId) {
      cache = null;
      return null;
    }
    cache = {
      ...(nickname ? { nickname } : {}),
      ...(playerId ? { playerId } : {}),
    };
    return cache;
  } catch {
    cache = null;
    return null;
  }
}

function writeProfile(profile: PersistedProfile | null): void {
  cache = profile;
  try {
    if (!profile || (!profile.nickname && !profile.playerId)) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    /* ignore quota */
  }
}

/** Nickname chosen by the player (saved locally even if the API is offline). */
export function getRememberedNickname(): string | null {
  const nickname = readProfile()?.nickname?.trim();
  return nickname && nickname.length > 0 ? nickname : null;
}

export function saveRememberedNickname(nickname: string): void {
  const trimmed = nickname.trim();
  if (!trimmed) return;
  const prev = readProfile();
  writeProfile({
    nickname: trimmed,
    playerId: prev?.playerId,
  });
}

export function getStoredPlayer(): StoredPlayer | null {
  const profile = readProfile();
  const playerId = profile?.playerId?.trim() ?? '';
  const nickname = profile?.nickname?.trim() ?? '';
  if (!playerId || !nickname) {
    return null;
  }
  return { playerId, nickname };
}

export function saveStoredPlayer(player: StoredPlayer): void {
  writeProfile({
    playerId: player.playerId.trim(),
    nickname: player.nickname.trim(),
  });
}

export function clearStoredPlayer(): void {
  writeProfile(null);
}
