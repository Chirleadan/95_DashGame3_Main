export type HighScoreBoardId = 'normal' | 'cheat';

export type RunHighScoreRecord = {
  survivedSec: number;
  trackLabel: string;
  stageLabel: string;
  achievedAtMs: number;
};

export type RunHighScoreSubmit = {
  /** Whether cheat mode was enabled when the run started. */
  cheatMode: boolean;
  survivedSec: number;
  trackLabel: string;
  stageLabel: string;
};

const STORAGE_KEY = 'game3-dash-high-scores-v2';

type StoredBoards = Partial<Record<HighScoreBoardId, RunHighScoreRecord>>;

let cache: StoredBoards | null = null;

function boardId(cheatMode: boolean): HighScoreBoardId {
  return cheatMode ? 'cheat' : 'normal';
}

function sanitizeRecord(raw: unknown): RunHighScoreRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<RunHighScoreRecord>;
  const survivedSec = Math.max(0, Number(o.survivedSec));
  const trackLabel = typeof o.trackLabel === 'string' ? o.trackLabel.trim() : '';
  const stageLabel = typeof o.stageLabel === 'string' ? o.stageLabel.trim() : '';
  const achievedAtMs = Math.floor(Number(o.achievedAtMs));
  if (
    !Number.isFinite(survivedSec) ||
    !Number.isFinite(achievedAtMs) ||
    !trackLabel ||
    !stageLabel
  ) {
    return null;
  }
  return { survivedSec, trackLabel, stageLabel, achievedAtMs };
}

function loadBoards(): StoredBoards {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = {};
      return cache;
    }
    const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>;
    const out: StoredBoards = {};
    const normal = sanitizeRecord(parsed.normal);
    const cheat = sanitizeRecord(parsed.cheat);
    if (normal) out.normal = normal;
    if (cheat) out.cheat = cheat;
    cache = out;
    return out;
  } catch {
    cache = {};
    return cache;
  }
}

function persist(boards: StoredBoards): void {
  cache = boards;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(boards));
  } catch {
    /* ignore quota */
  }
}

export function getHighScore(board: HighScoreBoardId): RunHighScoreRecord | null {
  return loadBoards()[board] ?? null;
}

/** Longer survival time wins. */
export function compareSurvivalTime(aSec: number, bSec: number): number {
  return aSec - bSec;
}

/**
 * Records the run on the normal or cheat board (from `cheatMode` only).
 * Returns whether this run set a new best time on that board.
 */
export function submitHighScore(submit: RunHighScoreSubmit): boolean {
  const board = boardId(submit.cheatMode);
  const survivedSec = Math.max(0, submit.survivedSec);
  const trackLabel = submit.trackLabel.trim() || 'Track';
  const stageLabel = submit.stageLabel.trim() || 'Stage';

  const boards = { ...loadBoards() };
  const prev = boards[board] ?? null;
  if (prev && compareSurvivalTime(survivedSec, prev.survivedSec) <= 0) {
    return false;
  }
  boards[board] = {
    survivedSec,
    trackLabel,
    stageLabel,
    achievedAtMs: Date.now(),
  };
  persist(boards);
  return true;
}

export function formatHighScoreTime(sec: number): string {
  const s = Math.max(0, sec);
  if (s < 60) return `${s.toFixed(2)} s`;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

export function formatHighScoreTape(rec: RunHighScoreRecord): string {
  return `${rec.trackLabel} / ${rec.stageLabel}`;
}
