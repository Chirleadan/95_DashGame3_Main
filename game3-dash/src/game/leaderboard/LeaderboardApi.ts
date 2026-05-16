import type { StoredPlayer } from './PlayerProfile.ts';

export type LeaderboardEntry = {
  playerId: string;
  nickname: string;
  score: number;
  trackId: string | null;
  trackName: string | null;
  cheatMode: boolean;
  updatedAt: string;
};

export type LeaderboardSubmitPayload = {
  playerId: string;
  score: number;
  trackId: string;
  trackName: string;
  cheatMode: boolean;
};

let loggedApiUnavailable = false;

function apiBaseUrl(): string | null {
  const base = import.meta.env.VITE_API_BASE_URL?.trim();
  if (!base) return null;
  return base.replace(/\/+$/, '');
}

function logApiUnavailableOnce(): void {
  if (loggedApiUnavailable) return;
  loggedApiUnavailable = true;
  console.info(
    '[Leaderboard] API unavailable — local high scores only (VITE_API_BASE_URL not set)',
  );
}

async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  const base = apiBaseUrl();
  if (!base) {
    logApiUnavailableOnce();
    return null;
  }

  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(
        `[Leaderboard] ${init?.method ?? 'GET'} ${path} failed:`,
        res.status,
        text,
      );
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(
      `[Leaderboard] ${init?.method ?? 'GET'} ${path} error:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export function isLeaderboardApiConfigured(): boolean {
  return Boolean(apiBaseUrl());
}

export async function createPlayer(
  nickname: string,
): Promise<StoredPlayer | null> {
  const data = await apiFetch<{ playerId: string; nickname: string }>(
    '/api/player/create',
    {
      method: 'POST',
      body: JSON.stringify({ nickname }),
    },
  );
  if (!data?.playerId || !data.nickname) return null;
  return { playerId: data.playerId, nickname: data.nickname };
}

export async function updatePlayerNickname(
  playerId: string,
  nickname: string,
): Promise<StoredPlayer | null> {
  const data = await apiFetch<{ playerId: string; nickname: string }>(
    '/api/player/nickname',
    {
      method: 'PATCH',
      body: JSON.stringify({ playerId, nickname }),
    },
  );
  if (!data?.playerId || !data.nickname) return null;
  return { playerId: data.playerId, nickname: data.nickname };
}

/** `true` = new best on server, `false` = not improved, `null` = API error. */
export async function submitLeaderboardScore(
  payload: LeaderboardSubmitPayload,
): Promise<boolean | null> {
  const data = await apiFetch<{ improved: boolean }>(
    '/api/leaderboard/submit',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
  if (!data) return null;
  return Boolean(data.improved);
}

/** `null` = API error, otherwise entries (may be empty). */
export async function fetchLeaderboard(
  cheatMode: boolean,
  limit = 50,
): Promise<LeaderboardEntry[] | null> {
  const cheat = cheatMode ? 'true' : 'false';
  const data = await apiFetch<{ entries: LeaderboardEntry[] }>(
    `/api/leaderboard?cheatMode=${cheat}&limit=${limit}`,
  );
  if (!data) return null;
  return data.entries ?? [];
}
