/**
 * Backfill historical stats from git history.
 * Usage: bun scripts/backfill-history.ts [username] [--db /path/to/stats.db]
 * Prints a summary; with --db also upserts rows into the commit_history table.
 */
import { backfillGitHistory } from "../src/backfill";
import { initDb, upsertCommitHistory } from "../src/db";

const USER = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : process.env.GITHUB_USERNAME ?? "BobbyNooby";
const dbArgIdx = process.argv.indexOf("--db");
const DB_PATH = dbArgIdx !== -1 ? process.argv[dbArgIdx + 1] : undefined;
const CLONE_DIR = process.env.CLONE_DIR ?? "/tmp/gh-history";
const OUT = `${CLONE_DIR}/history.json`;

const result = await backfillGitHistory(USER, CLONE_DIR);

if (DB_PATH) {
  initDb(DB_PATH);
  for (const row of result.rows) upsertCommitHistory(row);
  console.log(`saved ${result.rows.length} commit_history rows to ${DB_PATH}`);
}

await Bun.write(
  OUT,
  JSON.stringify(
    {
      summary: {
        username: USER,
        ...result,
        byYear: undefined,
        topLanguages: undefined,
      },
      byYear: result.byYear,
      topLanguages: result.topLanguages,
    },
    null,
    2
  )
);

console.log(`\nwrote ${OUT}\n`);
console.log(JSON.stringify({ ...result, byYear: undefined, topLanguages: undefined, rows: `${result.rows.length} rows` }, null, 2));
console.log("\ncommits by year:");
for (const y of Object.keys(result.byYear).sort()) {
  const v = result.byYear[y]!;
  console.log(`  ${y}: ${v.commits} commits, +${v.added}/-${v.deleted} lines`);
}
console.log("\ntop languages (by lines added):");
for (const l of result.topLanguages.slice(0, 12)) {
  console.log(`  ${l.lang.padEnd(12)} +${String(l.added).padStart(8)}  (${l.commits} commits)`);
}
