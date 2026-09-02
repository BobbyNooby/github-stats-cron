/**
 * Core git-history backfill: clone/update bare clones of all public repos,
 * walk git log, aggregate per-month per-language stats for the user's commits.
 */
import { $ } from "bun";
import type { CommitHistoryRow } from "./db";
import { EXT_LANGUAGE, LANGUAGE_TYPE } from "./linguist";

export function langFor(path: string): string {
  const base = path.split("/").pop() ?? path;
  const lower = base.toLowerCase();
  const key = lower.includes(".") ? lower.split(".").pop()! : lower;
  const hit = EXT_LANGUAGE[key] ?? EXT_LANGUAGE[lower];
  if (!hit) return "Other";
  const type = LANGUAGE_TYPE[hit] ?? "programming";
  if (type === "data") return "Config";
  if (type === "prose" && hit !== "Markdown") return "Other";
  return hit;
}

function isMine(username: string, name: string, email: string): boolean {
  const u = username.toLowerCase();
  const e = email.toLowerCase();
  return e.includes(u) || e.includes(`+${u}@`) || name.toLowerCase() === u;
}

interface CommitRecord {
  hash: string;
  date: string;
  authorName: string;
  authorEmail: string;
  files: { added: number; deleted: number; path: string }[];
}

async function cloneOrUpdateRepo(fullName: string, dir: string): Promise<string | null> {
  if (await Bun.file(`${dir}/HEAD`).exists()) {
    const proc = Bun.spawn(["git", "--git-dir", dir, "fetch", "--all", "--quiet"], {
      stdout: "ignore", stderr: "pipe",
    });
    if ((await proc.exited) !== 0) {
      console.error(`[backfill] fetch failed: ${fullName}`);
    }
    return dir;
  }
  const proc = Bun.spawn(
    ["git", "clone", "--quiet", "--bare", `https://github.com/${fullName}.git`, dir],
    { stdout: "ignore", stderr: "pipe" }
  );
  if ((await proc.exited) !== 0) {
    console.error(`[backfill] clone failed: ${fullName}: ${await new Response(proc.stderr).text()}`);
    return null;
  }
  return dir;
}

async function parseLog(dir: string): Promise<CommitRecord[]> {
  const proc = Bun.spawn(
    ["git", "--git-dir", dir, "log", "--all", "--no-merges", "--numstat", "--date=iso-strict", "--format=%x01%H%x02%aI%x03%an%x04%ae"],
    { stdout: "pipe", stderr: "ignore" }
  );
  const text = await new Response(proc.stdout).text();
  await proc.exited;

  const commits: CommitRecord[] = [];
  let current: CommitRecord | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("\x01")) {
      const parts = line.split("\x01")[1]!.split(/[\x02\x03\x04]/);
      const [hash = "", date = "", name = "", email = ""] = parts;
      if (!hash || !date) continue;
      current = { hash, date, authorName: name, authorEmail: email, files: [] };
      commits.push(current);
    } else if (current && line.trim() !== "") {
      const [added, deleted, path] = line.split("\t");
      if (added === undefined || deleted === undefined || path === undefined) continue;
      if (added === "-" || deleted === "-") continue; // binary
      const cleanPath = path.includes("=>") ? (path.split("=>").pop() ?? path).replace(/[{}]/g, "").trim() : path;
      current.files.push({ added: Number(added), deleted: Number(deleted), path: cleanPath });
    }
  }
  return commits;
}

export interface BackfillResult {
  rows: CommitHistoryRow[];
  repos_analyzed: number;
  repos_with_commits: number;
  my_commits: number;
  total_commits: number;
  byYear: Record<string, { commits: number; added: number; deleted: number }>;
  topLanguages: { lang: string; added: number; deleted: number; commits: number }[];
}

const API_BASE = (process.env.GITHUB_API_BASE ?? "https://api.github.com").replace(/\/$/, "");

export async function backfillGitHistory(
  username: string,
  cloneDir: string
): Promise<BackfillResult> {
  await $`mkdir -p ${cloneDir}`;

  const res = await fetch(`${API_BASE}/users/${username}/repos?per_page=100`);
  if (!res.ok) throw new Error(`repo list HTTP ${res.status}`);
  const repos = (await res.json()) as {
    full_name: string;
    fork: boolean;
    archived: boolean;
    owner: { login: string };
  }[];
  const targets = repos
    .filter((r) => !r.fork && !r.archived && r.owner.login.toLowerCase() === username.toLowerCase())
    .map((r) => r.full_name);

  const allCommits: (CommitRecord & { repo: string })[] = [];
  const BATCH = 8;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const dirs = await Promise.all(batch.map((fullName) => cloneOrUpdateRepo(fullName, `${cloneDir}/${fullName.replace("/", "__")}.git`)));
    for (let j = 0; j < batch.length; j++) {
      const dir = dirs[j];
      if (!dir) continue;
      for (const c of await parseLog(dir)) allCommits.push({ ...c, repo: batch[j]! });
    }
  }

  const mine = allCommits.filter((c) => isMine(username, c.authorName, c.authorEmail));
  // aggregate by DAY (chart-grade granularity); year summary derived below
  const rowsMap = new Map<string, CommitHistoryRow>();
  const byYear: Record<string, { commits: number; added: number; deleted: number }> = {};
  const topLangs: Record<string, { added: number; deleted: number; commits: Set<string> }> = {};
  const reposWithCommits = new Set<string>();

  for (const c of mine) {
    const day = c.date.slice(0, 10);
    const y = day.slice(0, 4);
    byYear[y] ??= { commits: 0, added: 0, deleted: 0 };
    byYear[y]!.commits++;
    reposWithCommits.add(c.repo);

    const touched = new Set<string>();
    for (const f of c.files) {
      const lang = langFor(f.path);
      touched.add(lang);
      byYear[y]!.added += f.added;
      byYear[y]!.deleted += f.deleted;

      const key = `${day}|${lang}`;
      let row = rowsMap.get(key);
      if (!row) {
        row = { day, language: lang, commits: 0, added: 0, deleted: 0 };
        rowsMap.set(key, row);
      }
      row.added += f.added;
      row.deleted += f.deleted;

      topLangs[lang] ??= { added: 0, deleted: 0, commits: new Set() };
      topLangs[lang]!.added += f.added;
      topLangs[lang]!.deleted += f.deleted;
      topLangs[lang]!.commits.add(c.hash);
    }
    for (const lang of touched) rowsMap.get(`${day}|${lang}`)!.commits++;
  }

  return {
    rows: [...rowsMap.values()],
    repos_analyzed: targets.length,
    repos_with_commits: reposWithCommits.size,
    my_commits: mine.length,
    total_commits: allCommits.length,
    byYear,
    topLanguages: Object.entries(topLangs)
      .map(([lang, v]) => ({ lang, added: v.added, deleted: v.deleted, commits: v.commits.size }))
      .sort((a, b) => b.added - a.added),
  };
}
