# Deploy: Vercel (game) + Render (API + PostgreSQL)

This project is ready to deploy without code changes.

| Environment | Frontend | Backend DB |
|-------------|----------|------------|
| Local | Vite (`npm run dev:all`) | SQLite (automatic, no `DATABASE_URL`) |
| Production | Vercel | Render PostgreSQL (`DATABASE_URL`) |

---

## 1. Render — PostgreSQL

1. Open [Render Dashboard](https://dashboard.render.com/) → **New** → **PostgreSQL**.
2. Name it e.g. `game3-dash-db`, choose a plan, create.
3. Copy the **Internal Database URL** (use this on the web service in the same region).

Or use the repo **Blueprint**: **New** → **Blueprint** → connect Git repo → Render reads `render.yaml` and creates DB + API.

---

## 2. Render — Backend API

### Option A — Blueprint (recommended)

1. **New** → **Blueprint** → select this repository.
2. Root of the repo should contain `render.yaml` (this folder if the game is the repo root).
3. After deploy, open the **game3-dash-api** service → **Environment**.
4. Set **`FRONTEND_ORIGIN`** to your Vercel URL (no trailing slash), e.g.  
   `https://your-game.vercel.app`  
   Multiple origins: comma-separated.
5. Note the public API URL, e.g. `https://game3-dash-api.onrender.com`.

### Option B — Manual web service

| Setting | Value |
|---------|--------|
| **Root Directory** | `backend` |
| **Runtime** | Node |
| **Build Command** | `npm ci && npm run build` |
| **Start Command** | `npm start` |
| **Health Check Path** | `/health` |

**Environment variables:**

| Variable | Required | Example |
|----------|----------|---------|
| `DATABASE_URL` | Yes | Render Postgres internal URL |
| `FRONTEND_ORIGIN` | Yes | `https://your-game.vercel.app` |
| `NODE_ENV` | Recommended | `production` |
| `PORT` | No | Set automatically by Render |

**Start behavior (automatic):**

- Detects `DATABASE_URL` → **PostgreSQL** (never SQLite in production).
- Runs migrations on every start.
- Logs: `using postgres` → `migration completed` → `server listening on port …`

**Verify API:**

```bash
curl https://YOUR-API.onrender.com/health
```

Expected:

```json
{ "ok": true, "db": "postgres" }
```

---

## 3. Vercel — Frontend

1. [vercel.com](https://vercel.com) → **Add New** → **Project** → import Git repo.
2. If the game lives in a subfolder, set **Root Directory** to that folder (e.g. `game3-dash`).
3. Framework preset: **Vite** (or use `vercel.json` in repo).

| Setting | Value |
|---------|--------|
| **Build Command** | `npm run build` |
| **Output Directory** | `dist` |
| **Install Command** | `npm ci` or `npm install` |

**Environment variable (required for online leaderboard):**

| Variable | Value |
|----------|--------|
| `VITE_API_BASE_URL` | Render API URL, **no trailing slash**, e.g. `https://game3-dash-api.onrender.com` |

4. Deploy. Redeploy after changing env vars (Vite embeds `VITE_*` at build time).

**Production build notes:**

- Dev leaderboard panel (`LB dev`) and `window.__gameDev` are **not** included (`import.meta.env.DEV`).
- Without `VITE_API_BASE_URL`, the game still runs with **local** high scores only.

---

## 4. CORS checklist

On Render, `FRONTEND_ORIGIN` must match the browser origin exactly:

- `https://your-game.vercel.app` — correct  
- `https://your-game.vercel.app/` — avoid trailing slash  
- Preview URLs: add `https://your-game-xxx.vercel.app` if you test previews

---

## 5. Production verification checklist

After both services are live:

- [ ] Open the deployed Vercel game URL — no console errors blocking play.
- [ ] First visit: **nickname modal** appears (no `playerId` yet).
- [ ] Enter a nickname → OK → check DevTools → Application → Local Storage → `game3-dash-player-v1` has `playerId` + `nickname`.
- [ ] Play a run until death with a **new personal best Score** (HUD top shows Score, not time).
- [ ] Console (optional): `[Leaderboard] score submitted` when local best improves.
- [ ] Main menu → **BEST SCORE**.
- [ ] **Global Leaderboard** section loads (not hidden).
- [ ] **Normal** tab shows your nickname and numeric **score**.
- [ ] **Cheat Mode** tab — enable cheat before a run, set a cheat best, confirm cheat scores appear only on this tab (with CHEAT badge).
- [ ] Confirm Normal and Cheat tabs do not mix scores.
- [ ] `curl https://YOUR-API/health` → `{ "ok": true, "db": "postgres" }`.

---

## 6. Local vs production scripts

**Root (`game3-dash/`):**

```bash
npm run dev:all          # local frontend + backend (SQLite)
npm run build            # production frontend → dist/
npm run build:backend    # compile API → backend/dist/
npm run test:leaderboard # API smoke test (backend must be up)
npm run test:e2e         # Playwright UI test
```

**Backend (`backend/`):**

```bash
npm run dev        # SQLite, hot reload
npm run build      # tsc → dist/
npm start          # migrate + listen (uses DATABASE_URL or SQLite)
npm run db:migrate # schema only
```

---

## 7. Troubleshooting

| Symptom | Fix |
|---------|-----|
| CORS error in browser | Set `FRONTEND_ORIGIN` on Render to exact Vercel URL |
| Global leaderboard hidden | Set `VITE_API_BASE_URL` on Vercel, redeploy |
| API 500 on submit | Check Render logs; confirm Postgres is running |
| `DATABASE_URL is required in production` | Add Postgres URL on Render, `NODE_ENV=production` |
| Render free tier sleep | First request after idle may take ~30s |

---

See also: [LEADERBOARD.md](./LEADERBOARD.md) for API routes and local development.
