import {
  createPlayer,
  isLeaderboardApiConfigured,
} from './LeaderboardApi.ts';
import { syncAllLocalHighScoresToLeaderboard } from './LeaderboardSync.ts';
import {
  getStoredPlayer,
  saveStoredPlayer,
  type StoredPlayer,
} from './PlayerProfile.ts';

export type NicknamePrompt = () => Promise<string | null>;

const NICKNAME_MIN = 1;
const NICKNAME_MAX = 24;

export function sanitizeNicknameInput(raw: string): string | null {
  const nickname = raw.trim().replace(/\s+/g, ' ');
  if (nickname.length < NICKNAME_MIN || nickname.length > NICKNAME_MAX) {
    return null;
  }
  return nickname;
}

/**
 * Ensures a backend player exists when the API is configured.
 * Returns stored player, or null if API is off / user cancelled / offline.
 */
export async function ensureOnlinePlayer(
  promptNickname: NicknamePrompt,
): Promise<StoredPlayer | null> {
  if (!isLeaderboardApiConfigured()) {
    console.info(
      '[Leaderboard] API unavailable — local high scores only (VITE_API_BASE_URL not set)',
    );
    return getStoredPlayer();
  }

  const existing = getStoredPlayer();
  if (existing) {
    console.info(
      '[Leaderboard] player loaded from localStorage:',
      existing.playerId,
      `(${existing.nickname})`,
    );
    return existing;
  }

  const raw = await promptNickname();
  if (raw === null) {
    console.info('[Leaderboard] nickname skipped — online leaderboard disabled for this session');
    return null;
  }

  const nickname = sanitizeNicknameInput(raw);
  if (!nickname) {
    console.warn('[Leaderboard] invalid nickname, skipping registration');
    return null;
  }

  const created = await createPlayer(nickname);
  if (!created) {
    console.warn('[Leaderboard] could not create player — API unavailable or error');
    return null;
  }

  saveStoredPlayer(created);
  console.info(
    '[Leaderboard] player created:',
    created.playerId,
    `(${created.nickname})`,
  );
  void syncAllLocalHighScoresToLeaderboard();
  return created;
}
