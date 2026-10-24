import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGraph, type GraphReader } from "./graph.js";

interface PrFixture {
  repo: string;
  number: number;
  state: string | null;
  mergedAt: string | null;
  closedAt: string | null;
}

/** The session graph's `pr` table with the outcome columns the miner adds later. */
const SCHEMA = "create table pr (pr_ref text primary key, number integer, repo text, title text, state text, url text, merged_at text, closed_at text)";

function writeGraph(path: string, prs: readonly PrFixture[]): void {
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = WAL");
  db.exec(SCHEMA);
  const insert = db.prepare("insert into pr values (?, ?, ?, 'synthetic title', ?, null, ?, ?)");
  for (const pr of prs) insert.run(`${pr.repo}#${pr.number}`, pr.number, pr.repo, pr.state, pr.mergedAt, pr.closedAt);
  db.close();
}

const merged = (repo: string, number: number, mergedAt: string): PrFixture => ({ repo, number, state: "merged", mergedAt, closedAt: mergedAt });

const UNTIL = "2026-03-01T00:00:00Z";
const REPOS = ["acme/widgets", "acme/gadgets"];

describe("graph mergedPrs", () => {
  let dir: string;
  let graph: GraphReader | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "history-graph-"));
  });

  afterEach(() => {
    graph?.close();
    graph = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const open = (prs: readonly PrFixture[]): GraphReader => {
    writeGraph(join(dir, "graph.sqlite3"), prs);
    graph = openGraph(join(dir, "graph.sqlite3"));
    return graph;
  };

  // Kills: dropping the merged filter (closed-unmerged and open rows come back), dropping the
  // repo allowlist, and sorting by insertion order instead of repo then number.
  it("returns only merged, allowlisted rows at or before until, in repo then number order", () => {
    const reader = open([
      merged("acme/widgets", 12, "2026-02-10T09:00:00Z"),
      merged("acme/widgets", 3, "2026-01-05T09:00:00Z"),
      { repo: "acme/widgets", number: 4, state: "closed", mergedAt: null, closedAt: "2026-01-06T09:00:00Z" },
      { repo: "acme/widgets", number: 5, state: "open", mergedAt: null, closedAt: null },
      merged("acme/widgets", 6, "2026-03-02T09:00:00Z"),
      merged("acme/gadgets", 9, "2026-02-01T09:00:00Z"),
      merged("other/private-thing", 1, "2026-01-01T09:00:00Z"),
    ]);

    const prs = reader.mergedPrs({ repos: REPOS, until: UNTIL });

    expect(prs).toEqual([
      { repo: "acme/gadgets", number: 9, mergedAt: "2026-02-01T09:00:00Z", closedAt: "2026-02-01T09:00:00Z" },
      { repo: "acme/widgets", number: 3, mergedAt: "2026-01-05T09:00:00Z", closedAt: "2026-01-05T09:00:00Z" },
      { repo: "acme/widgets", number: 12, mergedAt: "2026-02-10T09:00:00Z", closedAt: "2026-02-10T09:00:00Z" },
    ]);
  });

  // Kills: `<=` turned to `<` on until, and a string compare that ranks `Z` after `.000Z`.
  it("includes a PR merged at exactly until, whatever the fraction spelling", () => {
    const reader = open([merged("acme/widgets", 7, "2026-03-01T00:00:00Z")]);

    const prs = reader.mergedPrs({ repos: REPOS, until: "2026-03-01T00:00:00.000Z" });

    expect(prs.map((pr) => pr.number)).toEqual([7]);
  });

  // Kills: an exact-case allowlist match, and returning the graph's spelling of the repo.
  it("matches the allowlist case-insensitively and reports the allowlist spelling", () => {
    const reader = open([merged("Acme/Widgets", 2, "2026-01-02T00:00:00Z")]);

    const prs = reader.mergedPrs({ repos: ["ACME/widgets"], until: UNTIL });

    expect(prs).toEqual([{ repo: "ACME/widgets", number: 2, mergedAt: "2026-01-02T00:00:00Z", closedAt: "2026-01-02T00:00:00Z" }]);
  });

  // Kills: passing an unparsable until to SQLite, where julianday(null) silently returns no rows.
  it("refuses an until that is not an ISO time", () => {
    const reader = open([merged("acme/widgets", 2, "2026-01-02T00:00:00Z")]);

    expect(() => reader.mergedPrs({ repos: REPOS, until: "last tuesday" })).toThrow(/not an ISO time/);
  });

  // Kills: dropping mode=ro, which lets SQLite create an empty graph at a mistyped path.
  it("refuses to open a graph path that does not exist rather than creating it", () => {
    const missing = join(dir, "missing.sqlite3");

    expect(() => openGraph(missing)).toThrow();
    expect(existsSync(missing)).toBe(false);
  });
});
