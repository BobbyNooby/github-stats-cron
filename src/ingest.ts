import { upsertSnapshot } from "./db";
import { languageColor } from "./colors";

const GITHUB_GRAPHQL_URL = process.env.GITHUB_API_URL ?? "https://api.github.com/graphql";
const GITHUB_API_BASE = (process.env.GITHUB_API_BASE ?? "https://api.github.com").replace(/\/$/, "");

const MAX_PAGES = 10;

interface RepoNode {
  name: string;
  stargazerCount: number;
  forkCount: number;
  pushedAt: string | null;
  languages: {
    edges: { size: number; node: { name: string; color: string | null } }[];
  };
}

interface ContributionsJson {
  contributionCalendar: {
    totalContributions: number;
    weeks: {
      contributionDays: { date: string; contributionCount: number }[];
    }[];
  };
}

// ---------- GraphQL path (1 request, includes language colors + contributions) ----------

const QUERY = /* GraphQL */ `
  query($login: String!, $cursor: String) {
    user(login: $login) {
      login
      followers {
        totalCount
      }
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
      repositories(
        first: 100
        after: $cursor
        ownerAffiliations: OWNER
        isFork: false
        isArchived: false
        orderBy: { field: PUSHED_AT, direction: DESC }
      ) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          name
          stargazerCount
          forkCount
          pushedAt
          languages(first: 100) {
            edges {
              size
              node {
                name
                color
              }
            }
          }
        }
      }
    }
  }
`;

interface GraphQLResponse {
  data?: {
    user: {
      login: string;
      followers: { totalCount: number };
      contributionsCollection: ContributionsJson;
      repositories: {
        totalCount: number;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: RepoNode[];
      };
    };
  };
  errors?: { message: string }[];
}

async function graphql(login: string, token: string, cursor: string | null) {
  const res = await fetch(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query: QUERY, variables: { login, cursor } }),
  });
  if (!res.ok) {
    throw new Error(`GitHub API HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as GraphQLResponse;
  if (body.errors?.length) {
    throw new Error(`GitHub API errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) {
    throw new Error("GitHub API returned no data");
  }
  return body.data;
}

async function ingestGraphQL(login: string, token: string) {
  const seen = new Set<string>();
  const repos: RepoNode[] = [];
  let followers = 0;
  let contributions: ContributionsJson | null = null;
  let repositoryTotal = 0;
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(login, token, cursor);
    const { followers: f, contributionsCollection, repositories } = data.user;
    followers = f.totalCount;
    contributions ??= contributionsCollection;
    repositoryTotal = repositories.totalCount;
    for (const node of repositories.nodes) {
      if (seen.has(node.name)) continue;
      seen.add(node.name);
      repos.push(node);
    }
    if (!repositories.pageInfo.hasNextPage) break;
    cursor = repositories.pageInfo.endCursor;
  }

  await saveSnapshot({ login, followers, contributions, repositoryTotal, repos });
  return { mode: "graphql" as const, repos };
}

// ---------- REST path (works with no token; 60 req/hr unauthenticated) ----------

interface RestRepo {
  name: string;
  full_name: string;
  fork: boolean;
  archived: boolean;
  stargazers_count: number;
  forks_count: number;
  pushed_at: string | null;
  owner: { login: string };
}

async function restFetch(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      `GitHub REST rate limited (HTTP ${res.status}) — set GITHUB_TOKEN to get 5000 req/hr`
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub REST HTTP ${res.status} for ${url}: ${await res.text()}`);
  }
  return res.json();
}

async function ingestRest(login: string) {
  const lower = login.toLowerCase();

  const user = (await restFetch(`${GITHUB_API_BASE}/users/${login}`)) as {
    followers: number;
    public_repos: number;
  };

  const allRepos: RestRepo[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const chunk = (await restFetch(
      `${GITHUB_API_BASE}/users/${login}/repos?per_page=100&page=${page}&sort=pushed`
    )) as RestRepo[];
    allRepos.push(...chunk);
    if (chunk.length < 100) break;
  }

  const owned = allRepos.filter(
    (r) => !r.fork && !r.archived && r.owner?.login?.toLowerCase() === lower
  );

  const repos: RepoNode[] = [];
  const CHUNK = 10;
  for (let i = 0; i < owned.length; i += CHUNK) {
    const batch = owned.slice(i, i + CHUNK);
    const langMaps = await Promise.all(
      batch.map((r) => restFetch(`${GITHUB_API_BASE}/repos/${r.full_name}/languages`))
    );
    for (let j = 0; j < batch.length; j++) {
      const bytes: Record<string, number> = langMaps[j] as Record<string, number>;
      repos.push({
        name: batch[j].name,
        stargazerCount: batch[j].stargazers_count,
        forkCount: batch[j].forks_count,
        pushedAt: batch[j].pushed_at,
        languages: {
          edges: Object.entries(bytes)
            .sort((a, b) => b[1] - a[1])
            .map(([name, size]) => ({ size, node: { name, color: languageColor(name) } })),
        },
      });
    }
  }

  await saveSnapshot({
    login,
    followers: user.followers,
    contributions: null,
    repositoryTotal: user.public_repos,
    repos,
  });
  return { mode: "rest" as const, repos };
}

// ---------- shared assembly ----------

async function saveSnapshot(input: {
  login: string;
  followers: number;
  contributions: ContributionsJson | null;
  repositoryTotal: number;
  repos: RepoNode[];
}): Promise<void> {
  const { login, followers, contributions, repositoryTotal, repos } = input;

  const languages = new Map<string, { bytes: number; color: string }>();
  let totalStars = 0;
  let totalForks = 0;

  for (const repo of repos) {
    totalStars += repo.stargazerCount;
    totalForks += repo.forkCount;
    for (const edge of repo.languages.edges) {
      const { name, color } = edge.node;
      const existing = languages.get(name);
      languages.set(name, {
        bytes: (existing?.bytes ?? 0) + edge.size,
        color: color ?? existing?.color ?? languageColor(name),
      });
    }
  }

  const languagesJson = JSON.stringify(
    Object.fromEntries([...languages.entries()].sort((a, b) => b[1].bytes - a[1].bytes))
  );

  const raw = {
    fetched_at: new Date().toISOString(),
    user: login,
    followers,
    contributions,
    repositories: { total: repositoryTotal, nodes: repos },
  };

  const takenAt = new Date().toISOString().slice(0, 10);
  upsertSnapshot({
    taken_at: takenAt,
    raw_json: JSON.stringify(raw),
    languages: languagesJson,
    total_stars: totalStars,
    total_forks: totalForks,
    followers,
    repo_count: repos.length,
  });
}

export interface IngestResult {
  taken_at: string;
  login: string;
  repos_fetched: number;
  languages: number;
  mode: "graphql" | "rest";
}

export async function ingest(login: string, token?: string): Promise<IngestResult> {
  const { repos } = token
    ? await ingestGraphQL(login, token)
    : await ingestRest(login);

  const uniqueNames = new Set<string>();
  let languageCount = 0;
  for (const repo of repos) {
    for (const edge of repo.languages.edges) uniqueNames.add(edge.node.name);
  }
  languageCount = uniqueNames.size;

  return {
    taken_at: new Date().toISOString().slice(0, 10),
    login,
    repos_fetched: repos.length,
    languages: languageCount,
    mode: token ? "graphql" : "rest",
  };
}
