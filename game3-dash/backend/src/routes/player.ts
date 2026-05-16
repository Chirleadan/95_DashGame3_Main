import { Router, type Request, type Response } from 'express';
import {
  getDbDriver,
  newPlayerId,
  query,
  toIsoTimestamp,
} from '../db.js';

export const playerRouter = Router();

const NICKNAME_MIN = 1;
const NICKNAME_MAX = 24;

function sanitizeNickname(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const nickname = raw.trim().replace(/\s+/g, ' ');
  if (nickname.length < NICKNAME_MIN || nickname.length > NICKNAME_MAX) {
    return null;
  }
  return nickname;
}

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

playerRouter.post('/create', async (req: Request, res: Response) => {
  const nickname = sanitizeNickname(req.body?.nickname);
  if (!nickname) {
    res.status(400).json({ error: 'Invalid nickname' });
    return;
  }

  try {
    const result =
      getDbDriver() === 'postgres'
        ? await query<{ id: string; nickname: string }>(
            `INSERT INTO players (nickname)
             VALUES ($1)
             RETURNING id, nickname`,
            [nickname],
          )
        : await query<{ id: string; nickname: string }>(
            `INSERT INTO players (id, nickname)
             VALUES ($1, $2)
             RETURNING id, nickname`,
            [newPlayerId(), nickname],
          );
    const row = result.rows[0];
    if (!row) {
      res.status(500).json({ error: 'Failed to create player' });
      return;
    }
    res.status(201).json({ playerId: row.id, nickname: row.nickname });
  } catch (err) {
    console.error('[player/create]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

playerRouter.patch('/nickname', async (req: Request, res: Response) => {
  const playerId = parseUuid(req.body?.playerId);
  const nickname = sanitizeNickname(req.body?.nickname);
  if (!playerId || !nickname) {
    res.status(400).json({ error: 'Invalid playerId or nickname' });
    return;
  }

  try {
    const updatedAtSql =
      getDbDriver() === 'postgres'
        ? `NOW()`
        : `datetime('now')`;
    const result = await query<{ id: string; nickname: string }>(
      `UPDATE players
       SET nickname = $2, updated_at = ${updatedAtSql}
       WHERE id = $1
       RETURNING id, nickname`,
      [playerId, nickname],
    );
    const row = result.rows[0];
    if (!row) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }
    res.json({ playerId: row.id, nickname: row.nickname });
  } catch (err) {
    console.error('[player/nickname]', err);
    res.status(500).json({ error: 'Server error' });
  }
});

playerRouter.get('/me', async (req: Request, res: Response) => {
  const playerId = parseUuid(req.query.playerId);
  if (!playerId) {
    res.status(400).json({ error: 'Invalid playerId' });
    return;
  }

  try {
    const playerResult = await query<{
      id: string;
      nickname: string;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `SELECT id, nickname, created_at, updated_at
       FROM players
       WHERE id = $1`,
      [playerId],
    );
    const player = playerResult.rows[0];
    if (!player) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }

    const scoresResult = await query<{
      best_score: number;
      track_id: string | null;
      track_name: string | null;
      cheat_mode: boolean | number;
      updated_at: Date | string;
    }>(
      `SELECT best_score, track_id, track_name, cheat_mode, updated_at
       FROM leaderboard_scores
       WHERE player_id = $1
       ORDER BY cheat_mode ASC`,
      [playerId],
    );

    res.json({
      player: {
        playerId: player.id,
        nickname: player.nickname,
        createdAt: toIsoTimestamp(player.created_at),
        updatedAt: toIsoTimestamp(player.updated_at),
      },
      scores: scoresResult.rows.map((row) => ({
        score: row.best_score,
        trackId: row.track_id,
        trackName: row.track_name,
        cheatMode: row.cheat_mode,
        updatedAt: toIsoTimestamp(row.updated_at),
      })),
    });
  } catch (err) {
    console.error('[player/me]', err);
    res.status(500).json({ error: 'Server error' });
  }
});
