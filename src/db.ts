import { Database } from "bun:sqlite";

export interface SnapshotRow {
  taken_at: string;
  raw_json: string;
  languages: string;
  total_stars: number;
  total_forks: number;
  followers: number;
  repo_count: number;
}

let db: Database | null = null;

export function initDb(path: string): Database {
  db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run(`
    CREATE TABLE IF NOT EXISTS snapshots (
      taken_at    TEXT PRIMARY KEY,
      raw_json    TEXT NOT NULL,
      languages   TEXT NOT NULL,
      total_stars INTEGER NOT NULL DEFAULT 0,
      total_forks INTEGER NOT NULL DEFAULT 0,
      followers   INTEGER NOT NULL DEFAULT 0,
      repo_count  INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS commit_history (
      month    TEXT NOT NULL,
      language TEXT NOT NULL,
      commits  INTEGER NOT NULL DEFAULT 0,
      added    INTEGER NOT NULL DEFAULT 0,
      deleted  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (month, language)
    );
  `);
  return db;
}

export function getDb(): Database {
  if (!db) throw new Error("database not initialised");
  return db;
}

export function latestSnapshot(): SnapshotRow | null {
  const row = getDb()
    .query<SnapshotRow, []>("SELECT * FROM snapshots ORDER BY taken_at DESC LIMIT 1")
    .get();
  return row ?? null;
}

export function allSnapshots(): SnapshotRow[] {
  return getDb()
    .query<SnapshotRow, []>("SELECT * FROM snapshots ORDER BY taken_at ASC")
    .all();
}

export function upsertSnapshot(row: SnapshotRow): void {
  getDb()
    .query(
      `INSERT INTO snapshots (taken_at, raw_json, languages, total_stars, total_forks, followers, repo_count)
       VALUES ($taken_at, $raw_json, $languages, $total_stars, $total_forks, $followers, $repo_count)
       ON CONFLICT(taken_at) DO UPDATE SET
         raw_json    = excluded.raw_json,
         languages   = excluded.languages,
         total_stars = excluded.total_stars,
         total_forks = excluded.total_forks,
         followers   = excluded.followers,
         repo_count  = excluded.repo_count;`
    )
    .run({
      $taken_at: row.taken_at,
      $raw_json: row.raw_json,
      $languages: row.languages,
      $total_stars: row.total_stars,
      $total_forks: row.total_forks,
      $followers: row.followers,
      $repo_count: row.repo_count,
    });
}

export interface CommitHistoryRow {
  month: string;
  language: string;
  commits: number;
  added: number;
  deleted: number;
}

export function upsertCommitHistory(row: CommitHistoryRow): void {
  getDb()
    .query(
      `INSERT INTO commit_history (month, language, commits, added, deleted)
       VALUES ($month, $language, $commits, $added, $deleted)
       ON CONFLICT(month, language) DO UPDATE SET
         commits = excluded.commits,
         added   = excluded.added,
         deleted = excluded.deleted;`
    )
    .run({
      $month: row.month,
      $language: row.language,
      $commits: row.commits,
      $added: row.added,
      $deleted: row.deleted,
    });
}

export interface MonthHistory {
  month: string;
  languages: { language: string; commits: number; added: number; deleted: number }[];
}

export function commitHistoryByMonth(): MonthHistory[] {
  const rows = getDb()
    .query<CommitHistoryRow, []>(
      "SELECT * FROM commit_history ORDER BY month ASC, added DESC"
    )
    .all();
  const byMonth = new Map<string, MonthHistory>();
  for (const r of rows) {
    let m = byMonth.get(r.month);
    if (!m) {
      m = { month: r.month, languages: [] };
      byMonth.set(r.month, m);
    }
    m.languages.push({
      language: r.language,
      commits: r.commits,
      added: r.added,
      deleted: r.deleted,
    });
  }
  return [...byMonth.values()];
}
