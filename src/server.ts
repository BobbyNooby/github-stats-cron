import { Elysia, t } from "elysia";
import cors from "@elysiajs/cors";
import swagger from "@elysiajs/swagger";
import { allSnapshots, latestSnapshot } from "./db";
import { ingest } from "./ingest";

interface ServerOptions {
  corsOrigin: string;
  username: string;
  token: string | undefined;
  apiSecret: string | undefined;
  refreshSecret: string | undefined;
  startedAt: Date;
}

const noSnapshot = () =>
  new Response(JSON.stringify({ error: "no snapshots yet" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });

export function createServer(opts: ServerOptions) {
  const app = new Elysia({ name: "github-stats-cron" })
    .use(
      cors({
        origin: opts.corsOrigin === "*" ? true : opts.corsOrigin.split(","),
      })
    )
    .use(
      swagger({
        documentation: {
          info: {
            title: "GitHub Stats API",
            version: "0.1.0",
            description:
              "Daily snapshots of public GitHub stats (languages, stars, forks, followers, contributions), stored in SQLite and served as JSON. A caching/history layer on top of the GitHub API.",
          },
          tags: [
            { name: "stats", description: "Snapshot data" },
            { name: "ingest", description: "Ingestion control" },
            { name: "meta", description: "Service metadata" },
          ],
          components: {
            securitySchemes: {
              bearerAuth: { type: "http", scheme: "bearer" },
            },
          },
        },
      })
    );

  if (opts.apiSecret) {
    app.onBeforeHandle(({ request, headers, set }) => {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith("/api")) return;
      const auth = headers["authorization"];
      const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
      if (provided !== opts.apiSecret) {
        set.status = 401;
        return { error: "unauthorized: set Authorization: Bearer <API_SECRET>" };
      }
    });
  }

  app
    .get(
      "/health",
      () => {
        const latest = latestSnapshot();
        return {
          ok: true,
          username: opts.username,
          started_at: opts.startedAt.toISOString(),
          last_snapshot: latest?.taken_at ?? null,
        };
      },
      {
        detail: {
          tags: ["meta"],
          summary: "Service health",
          description: "Liveness probe plus the date of the most recent snapshot.",
        },
      }
    )
    .get(
      "/api/stats",
      () => {
        const latest = latestSnapshot();
        if (!latest) return noSnapshot();
        const langs: Record<string, { bytes: number; color: string }> = JSON.parse(
          latest.languages
        );
        const totalBytes = Object.values(langs).reduce((sum, l) => sum + l.bytes, 0);
        const languages = Object.entries(langs)
          .map(([name, { bytes, color }]) => ({
            name,
            bytes,
            color,
            pct: totalBytes > 0 ? (bytes / totalBytes) * 100 : 0,
          }))
          .sort((a, b) => b.bytes - a.bytes);
        return {
          taken_at: latest.taken_at,
          languages,
          totals: {
            stars: latest.total_stars,
            forks: latest.total_forks,
            followers: latest.followers,
            repos: latest.repo_count,
          },
        };
      },
      {
        detail: {
          tags: ["stats"],
          summary: "Latest snapshot",
          description:
            "Aggregated language byte counts (with GitHub's official colors) and profile totals from the most recent daily snapshot.",
        },
      }
    )
    .get(
      "/api/history",
      () =>
        allSnapshots().map((row) => ({
          taken_at: row.taken_at,
          languages: JSON.parse(row.languages),
          totals: {
            stars: row.total_stars,
            forks: row.total_forks,
            followers: row.followers,
            repos: row.repo_count,
          },
        })),
      {
        detail: {
          tags: ["stats"],
          summary: "All snapshots",
          description:
            "One entry per day since deployment. This is the data GitHub does not keep for you — chart trends from it.",
        },
      }
    )
    .get(
      "/api/repos",
      () => {
        const latest = latestSnapshot();
        if (!latest) return noSnapshot();
        const raw = JSON.parse(latest.raw_json);
        return {
          taken_at: latest.taken_at,
          repos: raw.repositories.nodes.map(
            (r: {
              name: string;
              stargazerCount: number;
              forkCount: number;
              pushedAt: string | null;
              languages: { edges: { size: number; node: { name: string } }[] };
            }) => ({
              name: r.name,
              stars: r.stargazerCount,
              forks: r.forkCount,
              pushed_at: r.pushedAt,
              languages: Object.fromEntries(
                r.languages.edges
                  .map((e) => [e.node.name, e.size] as const)
                  .sort((a, b) => b[1] - a[1])
              ),
            })
          ),
        };
      },
      {
        detail: {
          tags: ["stats"],
          summary: "Per-repo breakdown",
          description: "Every non-fork, non-archived owned repo from the latest snapshot.",
        },
      }
    )
    .get(
      "/api/contributions",
      () => {
        const latest = latestSnapshot();
        if (!latest) return noSnapshot();
        const raw = JSON.parse(latest.raw_json);
        return { taken_at: latest.taken_at, contributions: raw.contributions ?? null };
      },
      {
        detail: {
          tags: ["stats"],
          summary: "Contribution calendar",
          description: "The contribution calendar (green squares data) from the latest snapshot.",
        },
      }
    )
    .post(
      "/api/refresh",
      async ({ headers, body }) => {
        if (!opts.refreshSecret) {
          return new Response(
            JSON.stringify({ error: "refresh disabled: set REFRESH_SECRET to enable" }),
            { status: 403, headers: { "Content-Type": "application/json" } }
          );
        }
        const auth = headers["authorization"];
        const provided =
          auth?.startsWith("Bearer ") && auth.slice(7)
            ? auth.slice(7)
            : body?.secret;
        if (provided !== opts.refreshSecret) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (!opts.token) {
          return new Response(JSON.stringify({ error: "GITHUB_TOKEN not configured" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
        try {
          const result = await ingest(opts.username, opts.token);
          return { ok: true, ...result };
        } catch (err) {
          return new Response(JSON.stringify({ error: String(err) }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
      {
        body: t.Optional(
          t.Object({
            secret: t.Optional(t.String({ description: "Alternative to the Authorization header" })),
          })
        ),
        detail: {
          tags: ["ingest"],
          summary: "Force an immediate ingest",
          description:
            "Triggers a snapshot now instead of waiting for the cron. Requires REFRESH_SECRET to be configured, passed as `Authorization: Bearer <secret>` or in the body.",
          security: [{ bearerAuth: [] }],
        },
      }
    );

  return app;
}
