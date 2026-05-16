import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { getDbDriver, getSqliteFilePath, pingDatabase, runMigrations } from './db.js';
import { leaderboardRouter } from './routes/leaderboard.js';
import { playerRouter } from './routes/player.js';

const PORT = Number(process.env.PORT) || 3001;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const app = express();

app.use(
  cors({
    origin: FRONTEND_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  }),
);
app.use(express.json({ limit: '32kb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    db: getDbDriver(),
  });
});

app.use('/api/player', playerRouter);
app.use('/api/leaderboard', leaderboardRouter);

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('[server]', err);
    res.status(500).json({ error: 'Server error' });
  },
);

async function start(): Promise<void> {
  const hasDatabaseUrl = Boolean(process.env.DATABASE_URL?.trim());

  if (IS_PRODUCTION && !hasDatabaseUrl) {
    console.error(
      '[server] DATABASE_URL is required in production (Render PostgreSQL)',
    );
    process.exit(1);
  }

  const kind = getDbDriver();
  if (kind === 'postgres') {
    console.log('[server] using postgres');
  } else {
    console.log(`[server] using sqlite (${getSqliteFilePath()})`);
  }

  await runMigrations();
  console.log('[server] migration completed');

  await pingDatabase();
  console.log('[server] database ready');

  app.listen(PORT, () => {
    console.log(`[server] server listening on port ${PORT}`);
    console.log(`[server] CORS allowed origins: ${FRONTEND_ORIGIN}`);
  });
}

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
