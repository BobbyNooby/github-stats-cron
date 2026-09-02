# github-stats-cron

Self-hosted GitHub stats snapshotter. A daily cron pulls your public GitHub stats
(languages, stars, forks, followers, contributions) into SQLite, and serves them over
a small JSON API — your own caching/history layer on top of the GitHub API. Pair with
[github-stats-charts](https://github.com/your-name/github-stats-charts) for SVG charts.

GitHub does **not** keep historical language/star data — this snapshots it yourself,
so history starts accumulating from day one.

## How it works

- On boot: if the newest snapshot is older than `INTERVAL_HOURS` (default 24), ingest immediately
- Then an hourly check re-ingests when stale
- Ingestion failures are logged and never crash the server — it keeps serving the
  last snapshot from SQLite

Two ingestion modes, chosen automatically:

| | `GITHUB_TOKEN` set | no token |
|---|---|---|
| API | GraphQL (1 request/snapshot) | REST (~1 request per repo, chunked) |
| Rate limit | 5,000 req/hr | 60 req/hr — fine for daily snapshots |
| Contribution calendar | included | not available (`null`) |
| Language colors | from GitHub | from a bundled linguist color map |

## Configuration

Only `GITHUB_USERNAME` is required. Everything else has a working default:

```sh
GITHUB_USERNAME=your-username
```

| Variable | Default | Description |
|---|---|---|
| `GITHUB_USERNAME` | — (required) | Your GitHub login |
| `GITHUB_TOKEN` | _(none → REST mode)_ | Any PAT, no scopes needed. Enables GraphQL mode |
| `API_SECRET` | _(public)_ | If set, all `/api/*` routes require `Authorization: Bearer <key>` |
| `REFRESH_SECRET` | _(endpoint disabled)_ | If set, enables `POST /api/refresh` |
| `PORT` | `3000` | HTTP port |
| `INTERVAL_HOURS` | `24` | Snapshot staleness threshold |
| `CORS_ORIGIN` | `*` | CORS allowlist (comma-separated) |
| `DB_PATH` | `/data/stats.db` | SQLite file location |
| `GITHUB_API_BASE` | `https://api.github.com` | REST base URL (override for testing) |
| `GITHUB_API_URL` | `https://api.github.com/graphql` | GraphQL URL (override for testing) |

## API

Interactive docs at `/swagger` (OpenAPI JSON at `/swagger/json`).

| Route | Description |
|---|---|
| `GET /api/stats` | Latest snapshot: languages `{name, bytes, color, pct}` + totals |
| `GET /api/history` | Every snapshot ever taken (trend-chart data) |
| `GET /api/repos` | Per-repo breakdown from the latest snapshot |
| `GET /api/contributions` | Contribution calendar (`null` in tokenless mode) |
| `POST /api/refresh` | Force an ingest now (needs `REFRESH_SECRET`) |
| `GET /health` | Public liveness + last snapshot date |

Example:

```sh
curl https://stats.yourdomain.dev/api/stats
# {"taken_at":"2026-09-01","languages":[{"name":"TypeScript","bytes":110000,
#  "color":"#3178c6","pct":45.5},...],"totals":{"stars":5,"forks":2,...}}

# private mode
curl -H "Authorization: Bearer $API_SECRET" https://stats.yourdomain.dev/api/stats
```

## Run locally (Bun)

```sh
cp .env.example .env   # only GITHUB_USERNAME is needed
bun install
bun run dev            # server + scheduler
bun run ingest         # one-shot snapshot, then exit (for system cron users)
bun run mock           # fake GitHub API (graphql + rest) on :9999 — test with zero setup:
GITHUB_API_BASE=http://localhost:9999 GITHUB_USERNAME=mockuser DB_PATH=/tmp/t.db bun run dev
```

## Run with Docker

```sh
cp .env.example .env   # fill in GITHUB_USERNAME
docker compose up -d --build
```

Data persists in `./data/stats.db` (mounted at `/data`).

## Deploy on Coolify

1. New resource → Docker Compose (or Dockerfile) → point at this repo
2. Set `GITHUB_USERNAME` — that's it. Add `GITHUB_TOKEN` for contribution history,
   `API_SECRET` if you want the API private
3. Attach a persistent volume at `/data` (the compose file already mounts `./data`)
4. Expose port 3000, give it a domain (e.g. `stats.yourdomain.dev`)

Point [github-stats-charts](https://github.com/your-name/github-stats-charts) at this
service's URL (internal Coolify hostname like `http://github-stats-cron:3000` works too).

## Storage model

One row per day, raw response kept for future re-analysis:

```sql
snapshots(taken_at PK, raw_json, languages, total_stars, total_forks, followers, repo_count)
```

Re-running a snapshot the same day UPSERTs that day's row — never destructive.

## License

[MIT](./LICENSE). Fork it, host it, make it yours.
