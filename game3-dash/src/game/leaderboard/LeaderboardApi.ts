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

export type LeaderboardFetchFailure =
  | 'not_configured'
  | 'network'
  | 'cors'
  | 'http';

async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T } | { error: LeaderboardFetchFailure }> {
  const base = apiBaseUrl();
  if (!base) {
    logApiUnavailableOnce();
    return { error: 'not_configured' };
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
      return { error: 'http' };
    }
    return { data: (await res.json()) as T };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Leaderboard] ${init?.method ?? 'GET'} ${path} error:`, msg);
    const failure: LeaderboardFetchFailure =
      msg.includes('Failed to fetch') || msg.includes('NetworkError')
        ? 'cors'
        : 'network';
    return { error: failure };
  }
}

export function isLeaderboardApiConfigured(): boolean {
  return Boolean(apiBaseUrl());
}

export async function createPlayer(
  nickname: string,
): Promise<StoredPlayer | null> {
  const result = await apiFetch<{ playerId: string; nickname: string }>(
    '/api/player/create',
    {
      method: 'POST',
      body: JSON.stringify({ nickname }),
    },
  );
  if ('error' in result) return null;
  const data = result.data;
  if (!data?.playerId || !data.nickname) return null;
  return { playerId: data.playerId, nickname: data.nickname };
}

export async function updatePlayerNickname(
  playerId: string,
  nickname: string,
): Promise<StoredPlayer | null> {
  const result = await apiFetch<{ playerId: string; nickname: string }>(
    '/api/player/nickname',
    {
      method: 'PATCH',
      body: JSON.stringify({ playerId, nickname }),
    },
  );
  if ('error' in result) return null;
  const data = result.data;
  if (!data?.playerId || !data.nickname) return null;
  return { playerId: data.playerId, nickname: data.nickname };
}

/** `true` = new best on server, `false` = not improved, `null` = API error. */
export async function submitLeaderboardScore(
  payload: LeaderboardSubmitPayload,
): Promise<boolean | null> {
  const result = await apiFetch<{ improved: boolean }>(
    '/api/leaderboard/submit',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
  if ('error' in result) return null;
  return Boolean(result.data.improved);
}

export type FetchLeaderboardResult =
  | { ok: true; entries: LeaderboardEntry[] }
  | { ok: false; reason: LeaderboardFetchFailure };

/** `ok: false` = API error; `ok: true` with empty entries = no scores yet. */
export async function fetchLeaderboard(
  cheatMode: boolean,
  limit = 50,
): Promise<FetchLeaderboardResult> {
  const cheat = cheatMode ? 'true' : 'false';
  const result = await apiFetch<{ entries: LeaderboardEntry[] }>(
    `/api/leaderboard?cheatMode=${cheat}&limit=${limit}`,
  );
  if ('error' in result) {
    return { ok: false, reason: result.error };
  }
  return { ok: true, entries: result.data.entries ?? [] };
}
