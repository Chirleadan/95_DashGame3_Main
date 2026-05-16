import { Router, type Request, type Response } from 'express';
import { getDbDriver, newRowId, query, toIsoTimestamp } from '../db.js';

export const leaderboardRouter = Router();

function parseUuid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    return null;
  }
  return id;
}

function parseScore(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 2_000_000_000);
}

function parsePositiveInt(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function nowSql(): string {
  return getDbDriver() === 'postgres' ? 'NOW()' : `datetime('now')`;
}

leaderboardRouter.post('/submit', async (req: Request, res: Response) => {
  const playerId = parseUuid(req.body?.playerId);
  const score = parseScore(req.body?.score);
  const cheatMode = Boolean(req.body?.cheatMode);
  const trackId =
    typeof req.body?.trackId === 'string' ? req.body.trackId.trim() : null;
  const trackName =
    typeof req.body?.trackName === 'string' ? req.body.trackName.trim() : null;

  if (!playerId || score <= 0) {
    res.status(400).json({ error: 'Invalid playerId or score' });
    return;
  }

  try {
    const playerExists = await query<{ id: string }>(
      `SELECT id FROM players WHERE id = $1`,
      [playerId],
    );
    if (!playerExists.rows[0]) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }

    const updatedAt = nowSql();
    const result =
      getDbDriver() === 'postgres'
        ? await query<{
            best_score: number;
            track_id: string | null;
            track_name: string | null;
            cheat_mode: boolean | number;
            updated_at: Date | string;
          }>(
            `INSERT INTO leaderboard_scores (
               player_id, best_score, track_id, track_name, cheat_mode, updated_at
             )
             VALUES ($1, $2, $3, $4, $5, ${updatedAt})
             ON CONFLICT (player_id, cheat_mode)
             DO UPDATE SET
               best_score = EXCLUDED.best_score,
               track_id = EXCLUDED.track_id,
               track_name = EXCLUDED.track_name,
               updated_at = ${updatedAt}
             WHERE EXCLUDED.best_score > leaderboard_scores.best_score
             RETURNING best_score, track_id, track_name, cheat_mode, updated_at`,
            [playerId, score, trackId, trackName, cheatMode],
          )
        : await query<{
            best_score: number;
            track_id: string | null;
            track_name: string | null;
            cheat_mode: boolean | number;
            updated_at: Date | string;
          }>(
            `INSERT INTO leaderboard_scores (
               id, player_id, best_score, track_id, track_name, cheat_mode, updated_at
             )
             VALUES ($6, $1, $2, $3, $4, $5, ${updatedAt})
             ON CONFLICT (player_id, cheat_mode)
             DO UPDATE SET
               best_score = excluded.best_score,
               track_id = excluded.track_id,
               track_name = excluded.track_name,
               updated_at = ${updatedAt}
             WHERE excluded.best_score > leaderboard_scores.best_score
             RETURNING best_score, track_id, track_name, cheat_mode, updated_at`,
            [playerId, score, trackId, trackName, cheatMode, newRowId()],
          );

    const improved = Boolean(result.rows[0]);
    res.json({ improved, score: result.rows[0] ?? null });
  } catch (err) {
    console.error('[leaderboard/submit]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

leaderboardRouter.get('/', async (req: Request, res: Response) => {
  const cheatMode = req.query.cheatMode === 'true';
  const limit = parsePositiveInt(req.query.limit, 50, 100);

  try {
    const result = await query<{
      player_id: string;
      nickname: string;
      best_score: number;
      track_id: string | null;
      track_name: string | null;
      cheat_mode: boolean | number;
      updated_at: Date | string;
    }>(
      `SELECT
         ls.player_id,
         p.nickname,
         ls.best_score,
         ls.track_id,
         ls.track_name,
         ls.cheat_mode,
         ls.updated_at
       FROM leaderboard_scores ls
       INNER JOIN players p ON p.id = ls.player_id
       WHERE ls.cheat_mode = $1
       ORDER BY ls.best_score DESC, ls.updated_at ASC
       LIMIT $2`,
      [cheatMode, limit],
    );

    res.json({
      cheatMode,
      entries: result.rows.map((row) => ({
        playerId: row.player_id,
        nickname: row.nickname,
        score: row.best_score,
        trackId: row.track_id,
        trackName: row.track_name,
        cheatMode: row.cheat_mode,
        updatedAt: toIsoTimestamp(row.updated_at),
      })),
    });
  } catch (err) {
    console.error('[leaderboard/get]', err);
    res.status(500).json({ error: 'Server error' });
  }
});
