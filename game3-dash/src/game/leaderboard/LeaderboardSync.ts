import { getHighScore } from '../HighScores.ts';
import { submitLeaderboardScore } from './LeaderboardApi.ts';
import { getStoredPlayer } from './PlayerProfile.ts';

export type RunLeaderboardSubmit = {
  score: number;
  trackId: string;
  trackName: string;
  cheatMode: boolean;
};

/** Push a single run result when local highscore improved. */
export async function syncRunToLeaderboard(
  submit: RunLeaderboardSubmit,
): Promise<void> {
  const player = getStoredPlayer();
  if (!player) {
    console.info(
      '[Leaderboard] score not submitted — no playerId (choose a nickname first)',
    );
    return;
  }

  const score = Math.max(0, Math.floor(submit.score));
  if (score <= 0) return;

  const result = await submitLeaderboardScore({
    playerId: player.playerId,
    score,
    trackId: submit.trackId,
    trackName: submit.trackName,
    cheatMode: submit.cheatMode,
  });

  if (result === null) {
    console.warn('[Leaderboard] score submit failed — API unavailable');
    return;
  }
  if (result) {
    console.info('[Leaderboard] score submitted:', {
      score,
      cheatMode: submit.cheatMode,
      trackName: submit.trackName,
    });
  } else {
    console.info('[Leaderboard] score unchanged on server (not a new personal best)');
  }
}

/** After registration, upload any existing local bests (best-effort). */
export async function syncAllLocalHighScoresToLeaderboard(): Promise<void> {
  const player = getStoredPlayer();
  if (!player) return;

  for (const board of ['normal', 'cheat'] as const) {
    const rec = getHighScore(board);
    if (!rec) continue;
    const score = Math.max(0, Math.floor(rec.score));
    if (score <= 0) continue;
    const result = await submitLeaderboardScore({
      playerId: player.playerId,
      score,
      trackId: rec.trackLabel,
      trackName: `${rec.trackLabel} / ${rec.stageLabel}`,
      cheatMode: board === 'cheat',
    });
    if (result === null) {
      console.warn('[Leaderboard] sync local scores failed — API unavailable');
      return;
    }
    if (result) {
      console.info('[Leaderboard] synced local best to server:', {
        board,
        score,
      });
    }
  }
}
