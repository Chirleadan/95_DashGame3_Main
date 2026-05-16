# Online leaderboard

Public demo leaderboard: Vite frontend (Vercel) + Express API (Render) + database.

## Local development (one command)

From the **game root**:

```bash
npm install
cd backend && npm install && cd ..
npm run dev:all
```

This will:

1. Create/update `.env.local` with `VITE_API_BASE_URL=http://localhost:3001` (automatic — no manual editing).
2. Start the **backend** on port 3001 (SQLite at `backend/data/leaderboard.sqlite`, no `DATABASE_URL`).
3. Start the **Vite** frontend (usually `http://localhost:5173`).

Open the game, enter a nickname when prompted, play a run, then check **BEST SCORE** for the global leaderboard.

**Smoke test API only** (backend must be running):

```bash
npm run test:leaderboard
```

**Browser UI test** (starts backend + Vite, runs Playwright):

```bash
npm run test:e2e
```

Without `npm run dev:all`, the game still works offline; `VITE_API_BASE_URL` is only set when you use `dev:all` (or `npm run setup:local`).

## Production (Render + PostgreSQL)

**Full step-by-step deploy guide:** [DEPLOY.md](./DEPLOY.md)

Set on the Render web service:

| Variable | Value |
|----------|--------|
| `DATABASE_URL` | Render Postgres **Internal Database URL** |
| `FRONTEND_ORIGIN` | Your Vercel URL, e.g. `https://your-game.vercel.app` |
| `PORT` | Set by Render (optional) |

Build: `npm install && npm run build`  
Start: `npm run db:migrate && npm start` (migrate once on first deploy, or from Render shell)

When `DATABASE_URL` is set, the API uses **PostgreSQL** instead of SQLite.

## Vercel (frontend)

| Variable | Value |
|----------|--------|
| `VITE_API_BASE_URL` | Render API URL (no trailing slash), e.g. `https://your-api.onrender.com` |

## Scripts (backend)

| Script | Description |
|--------|-------------|
| `npm run dev` | Dev server (auto-migrate, SQLite or Postgres) |
| `npm run db:migrate` | Apply schema only |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm start` | Run compiled server |

## API summary

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | `{ ok, db: "sqlite" \| "postgres" }` |
| POST | `/api/player/create` | `{ nickname }` → `{ playerId, nickname }` |
| PATCH | `/api/player/nickname` | `{ playerId, nickname }` |
| GET | `/api/player/me?playerId=...` | Player + scores |
| POST | `/api/leaderboard/submit` | `{ playerId, score, trackId, trackName, cheatMode }` — only if higher |
| GET | `/api/leaderboard?cheatMode=false&limit=50` | Top players by `score` DESC |

Normal and cheat **game scores** are stored separately per player (`UNIQUE(player_id, cheat_mode)`).

**Schema note:** `leaderboard_scores.best_score` replaced `best_run_ms` (survival time). Local SQLite is reset automatically on first migrate after upgrade.
