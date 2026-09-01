import { Elysia } from "elysia";

// --- GraphQL fixtures ---

const repoOne = {
  name: "mock-repo-one",
  stargazerCount: 5,
  forkCount: 2,
  pushedAt: "2026-09-01T00:00:00Z",
  languages: {
    edges: [
      { size: 100_000, node: { name: "TypeScript", color: "#3178c6" } },
      { size: 50_000, node: { name: "Svelte", color: "#ff3e00" } },
      { size: 2_000, node: { name: "CSS", color: "#663399" } },
    ],
  },
};

const repoTwo = {
  name: "mock-repo-two",
  stargazerCount: 0,
  forkCount: 0,
  pushedAt: "2026-08-30T00:00:00Z",
  languages: {
    edges: [
      { size: 80_000, node: { name: "Python", color: "#3572A5" } },
      { size: 10_000, node: { name: "TypeScript", color: "#3178c6" } },
    ],
  },
};

function graphqlPage(cursor: string | null) {
  const firstPage = cursor === null;
  return {
    data: {
      user: {
        login: "mockuser",
        followers: { totalCount: 9 },
        contributionsCollection: {
          contributionCalendar: {
            totalContributions: 420,
            weeks: [
              {
                contributionDays: [
                  { date: "2026-08-31", contributionCount: 3 },
                  { date: "2026-09-01", contributionCount: 7 },
                ],
              },
            ],
          },
        },
        repositories: {
          totalCount: 2,
          pageInfo: { hasNextPage: firstPage, endCursor: firstPage ? "CURSOR2" : null },
          nodes: firstPage ? [repoOne] : [repoTwo],
        },
      },
    },
  };
}

// --- REST fixtures (tokenless path) ---

const restRepos = [
  {
    name: "mock-repo-one",
    full_name: "mockuser/mock-repo-one",
    fork: false,
    archived: false,
    stargazers_count: 5,
    forks_count: 2,
    pushed_at: "2026-09-01T00:00:00Z",
    owner: { login: "mockuser" },
  },
  {
    name: "mock-repo-two",
    full_name: "mockuser/mock-repo-two",
    fork: false,
    archived: false,
    stargazers_count: 0,
    forks_count: 0,
    pushed_at: "2026-08-30T00:00:00Z",
    owner: { login: "mockuser" },
  },
  {
    name: "someones-fork",
    full_name: "mockuser/someones-fork",
    fork: true,
    archived: false,
    stargazers_count: 0,
    forks_count: 0,
    pushed_at: "2026-08-01T00:00:00Z",
    owner: { login: "mockuser" },
  },
];

const restLanguages: Record<string, Record<string, number>> = {
  "mockuser/mock-repo-one": { TypeScript: 100_000, Svelte: 50_000, CSS: 2_000 },
  "mockuser/mock-repo-two": { Python: 80_000, TypeScript: 10_000 },
};

const app = new Elysia()
  .post("/graphql", ({ body }) => {
    const cursor = (body as { variables?: { cursor?: string | null } })?.variables?.cursor ?? null;
    return graphqlPage(cursor);
  })
  .get("/users/:login", ({ params }) => ({
    login: params.login,
    followers: 9,
    public_repos: 3,
  }))
  .get("/users/:login/repos", ({ query }) => {
    const page = Number(query.page ?? 1);
    const perPage = Number(query.per_page ?? 30);
    const start = (page - 1) * perPage;
    return restRepos.slice(start, start + perPage);
  })
  .get("/repos/:owner/:repo/languages", ({ params }) => {
    return restLanguages[`${params.owner}/${params.repo}`] ?? {};
  });

app.listen(9999);
console.log("[mock-github] graphql + rest mock on http://localhost:9999");
