/**
 * Backfill historical stats by walking local git history of all public repos.
 * Usage: bun scripts/backfill-history.ts [username]
 * Clones repos (bare) into /tmp/gh-history, aggregates commits + lines per
 * language over time for commits authored by the user, prints a summary and
 * writes full JSON to /tmp/gh-history/history.json.
 */
import { $ } from "bun";

const USER = (process.argv[2] ?? process.env.GITHUB_USERNAME ?? "BobbyNooby").toLowerCase();
const CLONE_DIR = "/tmp/gh-history";
const OUT = `${CLONE_DIR}/history.json`;

const EXT_TO_LANG: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  svelte: "Svelte", vue: "Vue", astro: "Astro",
  py: "Python", pyi: "Python", ipynb: "Jupyter",
  java: "Java", cs: "C#", go: "Go", rs: "Rust", php: "PHP", rb: "Ruby",
  kt: "Kotlin", kts: "Kotlin", swift: "Swift", dart: "Dart", zig: "Zig",
  lua: "Lua", ex: "Elixir", exs: "Elixir", hs: "Haskell", scala: "Scala",
  c: "C", h: "C", cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++", hh: "C++",
  html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", sass: "SCSS", less: "Less",
  sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell",
  sql: "SQL", prisma: "Prisma", graphql: "GraphQL", proto: "Protobuf",
  md: "Markdown", mdx: "MDX", json: "Config", yml: "Config", yaml: "Config",
  toml: "Config", ini: "Config", cfg: "Config", lock: "Config",
};

function langFor(path: string): string {
  const base = path.split("/").pop() ?? path;
  if (/^dockerfile/i.test(base) || /^\.dockerignore/i.test(base)) return "Docker";
  if (/^makefile/i.test(base)) return "Makefile";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_TO_LANG[ext] ?? "Other";
}

function isMine(name: string, email: string): boolean {
  const e = email.toLowerCase();
  return e.includes(USER) || e.includes(`+${USER}@`) || name.toLowerCase() === USER;
}

interface CommitRecord {
  hash: string;
  date: string;
  authorName: string;
  authorEmail: string;
  files: { added: number; deleted: number; path: string }[];
}

async function cloneRepo(fullName: string): Promise<string | null> {
  const dir = `${CLONE_DIR}/${fullName.replace("/", "__")}.git`;
  if (await Bun.file(`${dir}/HEAD`).exists()) return dir;
  const proc = Bun.spawn(["git", "clone", "--quiet", "--bare", `https://github.com/${fullName}.git`, dir], {
    stdout: "ignore", stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`clone failed: ${fullName}: ${await new Response(proc.stderr).text()}`);
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
      if (!hash || !date) continue; // malformed record
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

// ---------- main ----------
await $`mkdir -p ${CLONE_DIR}`;

const res = await fetch(`https://api.github.com/users/${USER}/repos?per_page=100`);
const repos = (await res.json()) as { full_name: string; fork: boolean; archived: boolean; owner: { login: string } }[];
const targets = repos
  .filter((r) => !r.fork && !r.archived && r.owner.login.toLowerCase() === USER)
  .map((r) => r.full_name);
console.log(`analyzing ${targets.length} repos...\n`);

const BATCH = 8;
const allCommits: (CommitRecord & { repo: string })[] = [];
for (let i = 0; i < targets.length; i += BATCH) {
  const batch = targets.slice(i, i + BATCH);
  const dirs = await Promise.all(batch.map(cloneRepo));
  for (let j = 0; j < batch.length; j++) {
    const dir = dirs[j];
    if (!dir) continue;
    const commits = await parseLog(dir);
    for (const c of commits) allCommits.push({ ...c, repo: batch[j]! });
  }
  console.log(`  ${Math.min(i + BATCH, targets.length)}/${targets.length} repos parsed`);
}

const mine = allCommits.filter((c) => isMine(c.authorName, c.authorEmail));
const dayKey = (d: string) => d.slice(0, 10);
const monthKey = (d: string) => d.slice(0, 7);
const commitDays = new Set(mine.map((c) => dayKey(c.date)));

const byYear: Record<string, { commits: number; added: number; deleted: number }> = {};
const byMonth: Record<string, { commits: number; added: number; deleted: number }> = {};
const langByYear: Record<string, Record<string, number>> = {};
const topLangs: Record<string, { added: number; deleted: number; commits: Set<string> }> = {};
const byHour: Record<string, number> = {};
const byWeekday: Record<string, number> = {};
const reposByMe = new Set<string>();
let firstDate: string | null = null;
let lastDate: string | null = null;

for (const c of mine) {
  const y = c.date.slice(0, 4);
  const m = monthKey(c.date);
  byYear[y] ??= { commits: 0, added: 0, deleted: 0 };
  byMonth[m] ??= { commits: 0, added: 0, deleted: 0 };
  langByYear[y] ??= {};
  byYear[y]!.commits++;
  byMonth[m]!.commits++;
  reposByMe.add(c.repo);
  if (!firstDate || c.date < firstDate) firstDate = c.date;
  if (!lastDate || c.date > lastDate) lastDate = c.date;

  const hour = String(new Date(c.date).getHours()).padStart(2, "0");
  byHour[hour] = (byHour[hour] ?? 0) + 1;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(c.date).getDay()]!;
  byWeekday[wd] = (byWeekday[wd] ?? 0) + 1;

  for (const f of c.files) {
    const lang = langFor(f.path);
    byYear[y]!.added += f.added;
    byYear[y]!.deleted += f.deleted;
    byMonth[m]!.added += f.added;
    byMonth[m]!.deleted += f.deleted;
    langByYear[y]![lang] = (langByYear[y]![lang] ?? 0) + f.added;
    topLangs[lang] ??= { added: 0, deleted: 0, commits: new Set() };
    topLangs[lang]!.added += f.added;
    topLangs[lang]!.deleted += f.deleted;
    topLangs[lang]!.commits.add(c.hash);
  }
}

// longest streak (all-time, calendar days with >=1 commit)
const days = [...commitDays].sort();
let streak = 0, best = 0, prev: string | null = null;
for (const d of days) {
  if (prev && (Date.parse(d) - Date.parse(prev)) / 86_400_000 === 1) streak++;
  else streak = 1;
  best = Math.max(best, streak);
  prev = d;
}

const summary = {
  username: USER,
  repos_analyzed: targets.length,
  repos_with_commits: reposByMe.size,
  total_commits_all_authors: allCommits.length,
  my_commits: mine.length,
  first_commit: firstDate,
  last_commit: lastDate,
  days_with_commits: commitDays.size,
  longest_streak_days: best,
  lines_added: mine.reduce((s, c) => s + c.files.reduce((a, f) => a + f.added, 0), 0),
  lines_deleted: mine.reduce((s, c) => s + c.files.reduce((a, f) => a + f.deleted, 0), 0),
};

const topLanguages = Object.entries(topLangs)
  .map(([lang, v]) => ({ lang, added: v.added, deleted: v.deleted, commits: v.commits.size }))
  .sort((a, b) => b.added - a.added);

const out = { summary, byYear, byMonth, langByYear, topLanguages, byHour, byWeekday };
await Bun.write(OUT, JSON.stringify(out, null, 2));
console.log(`\nwrote ${OUT}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log("\ncommits by year:");
for (const y of Object.keys(byYear).sort()) {
  console.log(`  ${y}: ${byYear[y]!.commits} commits, +${byYear[y]!.added}/-${byYear[y]!.deleted} lines`);
}
console.log("\ntop languages (by lines added):");
for (const l of topLanguages.slice(0, 12)) {
  console.log(`  ${l.lang.padEnd(12)} +${String(l.added).padStart(8)}  (${l.commits} commits)`);
}
