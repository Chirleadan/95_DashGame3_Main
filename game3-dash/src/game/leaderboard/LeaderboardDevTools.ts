import { submitHighScore } from '../HighScores.ts';
import { syncRunToLeaderboard } from './LeaderboardSync.ts';
import { clearStoredPlayer, getStoredPlayer } from './PlayerProfile.ts';

export type LeaderboardDevSubmitResult = {
  improved: boolean;
  player: ReturnType<typeof getStoredPlayer>;
};

export type GameDevApi = {
  clearPlayer: () => void;
  clearLocalScores: () => void;
  clearAll: () => void;
  getPlayer: () => ReturnType<typeof getStoredPlayer>;
  submitTestScore: (opts: {
    cheatMode: boolean;
    score: number;
    trackId?: string;
    trackName?: string;
    trackLabel?: string;
    stageLabel?: string;
  }) => Promise<LeaderboardDevSubmitResult>;
  openBestScoreMenu: () => void;
  reloadGlobalLeaderboard: (cheatMode?: boolean) => void;
};

declare global {
  interface Window {
    __gameDev?: GameDevApi;
  }
}

function clearLocalScores(): void {
  try {
    localStorage.removeItem('game3-dash-high-scores-v3');
  } catch {
    /* ignore */
  }
}

export function installLeaderboardDevTools(hooks: {
  openBestScoreMenu: () => void;
  reloadGlobalLeaderboard: (cheatMode: boolean) => void;
}): void {
  if (!import.meta.env.DEV) return;

  const api: GameDevApi = {
    clearPlayer() {
      clearStoredPlayer();
    },
    clearLocalScores,
    clearAll() {
      clearStoredPlayer();
      clearLocalScores();
    },
    getPlayer() {
      return getStoredPlayer();
    },
    async submitTestScore(opts) {
      const trackLabel = opts.trackLabel ?? 'Track 1';
      const stageLabel = opts.stageLabel ?? 'Stage 1';
      const trackId = opts.trackId ?? 'track-1';
      const trackName = opts.trackName ?? `${trackLabel} / ${stageLabel}`;
      const score = Math.max(0, Math.floor(opts.score));
      const improved = submitHighScore({
        cheatMode: opts.cheatMode,
        score,
        trackLabel,
        stageLabel,
      });
      if (improved) {
        await syncRunToLeaderboard({
          score,
          trackId,
          trackName,
          cheatMode: opts.cheatMode,
        });
      }
      return { improved, player: getStoredPlayer() };
    },
    openBestScoreMenu() {
      hooks.openBestScoreMenu();
    },
    reloadGlobalLeaderboard(cheatMode = false) {
      hooks.reloadGlobalLeaderboard(cheatMode);
    },
  };

  window.__gameDev = api;
  mountDevPanel(api);
}

function mountDevPanel(api: GameDevApi): void {
  if (document.getElementById('leaderboard-dev-tools')) return;

  const panel = document.createElement('div');
  panel.id = 'leaderboard-dev-tools';
  panel.className = 'leaderboard-dev-tools';
  panel.innerHTML = `
    <span class="leaderboard-dev-tools__label">LB dev</span>
    <button type="button" data-action="normal">Normal score</button>
    <button type="button" data-action="cheat">Cheat score</button>
    <button type="button" data-action="best">Open BEST SCORE</button>
    <button type="button" data-action="reload">Reload board</button>
  `;
  document.body.appendChild(panel);

  panel.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-action]',
    );
    if (!btn) return;
    const action = btn.dataset.action;
    void (async () => {
      if (action === 'normal') {
        await api.submitTestScore({ cheatMode: false, score: 2500 });
      } else if (action === 'cheat') {
        await api.submitTestScore({ cheatMode: true, score: 9900 });
      } else if (action === 'best') {
        api.openBestScoreMenu();
      } else if (action === 'reload') {
        api.reloadGlobalLeaderboard(false);
      }
    })();
  });
}
