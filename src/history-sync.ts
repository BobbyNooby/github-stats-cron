/**
 * Keeps the commit_history table in sync with real git history.
 * Persists bare clones in <db_dir>/gh-history so daily runs only fetch
 * new commits. Recomputes + upserts everything each run: idempotent.
 */
import { basename, dirname, join } from "node:path";
import { backfillGitHistory } from "./backfill";
import { upsertCommitHistory } from "./db";

function log(...args: unknown[]) {
  console.log("[commit-history]", ...args);
}

export async function syncCommitHistory(username: string, dbPath: string): Promise<void> {
  const cloneDir = join(dirname(dbPath), `${basename(dbPath, ".db")}-clones`);
  try {
    const result = await backfillGitHistory(username, cloneDir);
    for (const row of result.rows) upsertCommitHistory(row);
    log(
      `synced ${result.rows.length} rows (${result.repos_with_commits}/${result.repos_analyzed} repos, ` +
        `${result.my_commits} commits by @${username})`
    );
  } catch (err) {
    log("sync failed (keeping existing rows):", err instanceof Error ? err.message : err);
  }
}
