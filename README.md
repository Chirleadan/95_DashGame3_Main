# A-037

Arena dash game with rhythm tapes, vault fragments, and an optional online leaderboard.

**Live demo:** [https://a-037.vercel.app/](https://a-037.vercel.app/)

| | |
|---|---|
| **Source code** | [MIT License](LICENSE) |
| **Music & visual assets** | Not open source — [used with permission / all rights reserved](ASSETS_LICENSE.md) |

Production hosting: **frontend on [Vercel](https://vercel.com/)**, **API on [Render](https://render.com/)** with PostgreSQL. See [game3-dash/DEPLOY.md](game3-dash/DEPLOY.md) for deployment details.

## Local development

Requirements: **Node.js 20+**, npm.

```bash
cd game3-dash
npm install
npm install --prefix backend
npm run dev:all
```

- Game: [http://localhost:5173](http://localhost:5173)
- API: [http://localhost:3001](http://localhost:3001) (SQLite leaderboard DB, no `DATABASE_URL` needed)

Optional: copy [game3-dash/.env.example](game3-dash/.env.example) to `game3-dash/.env.local` to set `VITE_API_BASE_URL` for the global leaderboard in dev.

### Build & test

```bash
cd game3-dash
npm run build
npm run build:backend
npm run test:leaderboard
npm run test:e2e
```

## Repository layout

| Path | Description |
|------|-------------|
| `game3-dash/` | Vite + Three.js frontend |
| `game3-dash/backend/` | Express leaderboard API |
| `game3-dash/render.yaml` | Render blueprint (API + Postgres) |
| `vercel.json` | Vercel monorepo config (frontend only) |

## Credits

### Music

Soundtrack used with permission from:

- **Varia.fx**
- **Ohota**

### Development & art

- **Code:** Larik (Codex, Cursor)
- **Art:** Larik / Nastya Trems

In-game credits are also available under **Main menu → TITLES**.

## License summary

- **Code:** MIT — see [LICENSE](LICENSE)
- **Music & assets:** See [ASSETS_LICENSE.md](ASSETS_LICENSE.md) — not for redistribution or reuse outside this project
