import { initDb, latestSnapshot } from "./db";
import { ingest } from "./ingest";
import { createServer } from "./server";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

function log(...args: unknown[]) {
  console.log("[github-stats-cron]", ...args);
}

const USERNAME = env("GITHUB_USERNAME");
const TOKEN = env("GITHUB_TOKEN");
const PORT = Number(env("PORT") ?? 3000);
const DB_PATH = env("DB_PATH") ?? "/data/stats.db";
const INTERVAL_HOURS = Number(env("INTERVAL_HOURS") ?? 24);
const API_SECRET = env("API_SECRET");
const REFRESH_SECRET = env("REFRESH_SECRET");
const CORS_ORIGIN = env("CORS_ORIGIN") ?? "*";

const ingestOnly = process.argv.includes("--ingest-only");

if (!USERNAME) {
  throw new Error("GITHUB_USERNAME is required");
}
if (!TOKEN) {
  log(
    "no GITHUB_TOKEN set — using unauthenticated REST (60 req/hr, fine for daily snapshots).",
    "Set GITHUB_TOKEN to switch to GraphQL (1 req/day, includes contribution history)."
  );
}

initDb(DB_PATH);

const runIngest = async (): Promise<void> => {
  try {
    const result = await ingest(USERNAME, TOKEN);
    log(
      `snapshot saved (${result.mode}): ${result.taken_at} — ${result.repos_fetched} repos, ${result.languages} languages`
    );
  } catch (err) {
    log("ingest failed, keeping last snapshot:", err instanceof Error ? err.message : err);
  }
}

function isStale(): boolean {
  const latest = latestSnapshot();
  if (!latest) return true;
  const ageMs = Date.now() - Date.parse(`${latest.taken_at}T00:00:00Z`);
  return ageMs > INTERVAL_HOURS * 3_600_000;
}

if (ingestOnly) {
  await runIngest();
  process.exit(0);
}

log("taking startup snapshot...");
await runIngest();

const startedAt = new Date();
const app = createServer({
  corsOrigin: CORS_ORIGIN,
  username: USERNAME,
  token: TOKEN,
  apiSecret: API_SECRET,
  refreshSecret: REFRESH_SECRET,
  startedAt,
});
app.listen(PORT);

log(
  `serving on http://localhost:${app.server?.port} (db: ${DB_PATH}, interval: ${INTERVAL_HOURS}h,` +
    ` api: ${API_SECRET ? "private (API_SECRET)" : "public"}, docs: /swagger)`
);

const CHECK_MS = 60 * 60 * 1000;
setInterval(() => {
  if (isStale()) {
    log("snapshot stale, ingesting...");
    void runIngest();
  }
}, CHECK_MS);
