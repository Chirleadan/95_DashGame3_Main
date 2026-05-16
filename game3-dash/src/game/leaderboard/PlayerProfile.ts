const STORAGE_KEY = 'game3-dash-player-v1';

export type StoredPlayer = {
  playerId: string;
  nickname: string;
};

let cache: StoredPlayer | null | undefined;

export function getStoredPlayer(): StoredPlayer | null {
  if (cache !== undefined) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = null;
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredPlayer>;
    const playerId =
      typeof parsed.playerId === 'string' ? parsed.playerId.trim() : '';
    const nickname =
      typeof parsed.nickname === 'string' ? parsed.nickname.trim() : '';
    if (!playerId || !nickname) {
      cache = null;
      return null;
    }
    cache = { playerId, nickname };
    return cache;
  } catch {
    cache = null;
    return null;
  }
}

export function saveStoredPlayer(player: StoredPlayer): void {
  cache = player;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(player));
  } catch {
    /* ignore quota */
  }
}

export function clearStoredPlayer(): void {
  cache = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
