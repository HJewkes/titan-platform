import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { lines, scratchRepo, type ScratchRepo } from "../corpus/test-fixture.js";
import type { ExclusionPolicy } from "../private/exclusion.js";
import { buildHistory, writeHistory, type HistoryInputs } from "./build.js";
import { openGraph, type GraphReader } from "./graph.js";
import { ensureMirror } from "./mirror.js";

const REPO = "acme/widgets";
const UNTIL = "2026-02-01T00:00:00Z";
const POLICY: ExclusionPolicy = { repos: ["widgets"], initiatives: ["eng"], markers: { slugs: [], prefixes: ["STPX"] } };

let root: string;
let graph: GraphReader;

/** Squash-lands a PR branch off main's tip as `<message>` and publishes its `refs/pull/<n>/head`. */
function landPr(repo: ScratchRepo, n: number, files: Record<string, string>, message: string, at: string): void {
  repo.git(["checkout", "-q", "-b", `pr${n}`]);
  const head = repo.commit(files, `work for ${n}`, at);
  repo.git(["update-ref", `refs/pull/${n}/head`, head]);
  repo.git(["checkout", "-q", "main"]);
  repo.commit(files, message, at);
}

function buildOrigin(dir: string): void {
  const origin = scratchRepo(dir);
  origin.commit({ "src/a.ts": lines(3) }, "init", "2026-01-01T00:00:00Z");
  landPr(origin, 7, { "src/x.ts": lines(15), "src/x.test.ts": lines(10) }, "Add x (#7)", "2026-01-02T00:00:00Z");
  landPr(origin, 9, { "src/y.ts": lines(2) }, "Add y (#9)\n\nPart of STPX-3.", "2026-01-03T00:00:00Z");
}

function writeGraph(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("create table pr (pr_ref text primary key, number integer, repo text, title text, state text, url text, merged_at text, closed_at text)");
  const insert = db.prepare("insert into pr values (?, ?, ?, 'synthetic title', 'merged', null, ?, ?)");
  for (const [n, at] of [[7, "2026-01-02T00:00:00Z"], [8, "2026-01-02T12:00:00Z"], [9, "2026-01-03T00:00:00Z"]] as const) insert.run(`${REPO}#${n}`, n, REPO, at, at);
  db.close();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "history-build-"));
  buildOrigin(join(root, "origin"));
  ensureMirror(join(root, "mirrors"), REPO, { fetch: true, url: join(root, "origin") });
  writeGraph(join(root, "graph.sqlite3"));
  graph = openGraph(join(root, "graph.sqlite3"));
});

afterAll(() => {
  graph.close();
  rmSync(root, { recursive: true, force: true });
});

const inputs = (): HistoryInputs => ({
  graph,
  mirrorFor: (repo) => ensureMirror(join(root, "mirrors"), repo, { fetch: false }),
  repos: [REPO],
  until: UNTIL,
  policy: POLICY,
});

const read = (dir: string) => ({ cases: readFileSync(join(dir, "cases.jsonl"), "utf8"), summary: readFileSync(join(dir, "summary.json"), "utf8") });

describe("history build", () => {
  // Kills: a wall-clock field in the output, and unsorted map iteration.
  it("writes byte-identical cases and summary on two no-fetch runs with one until", async () => {
    const first = join(root, "out-a");
    const second = join(root, "out-b");

    await writeHistory(first, inputs());
    await writeHistory(second, inputs());

    expect(read(second)).toEqual(read(first));
    expect(read(first).cases.trim().split("\n")).toHaveLength(1);
  });

  it("writes every fact of a squash-landed PR", () => {
    const { cases } = buildHistory(inputs());

    expect(cases).toEqual([
      expect.objectContaining({ case_id: "widgets#7", repo: REPO, pr_number: 7, landing_subject: "Add x (#7)", paths: ["src/x.test.ts", "src/x.ts"], test_paths: ["src/x.test.ts"], has_tests: true, size_band: "s" }),
    ]);
    expect(cases[0]?.base_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  // Kills: writing a half-filled case for a graph PR that never reached main.
  it("counts a graph PR with no merge commit on main as missing, not as a case", () => {
    const { cases, summary } = buildHistory(inputs());

    expect(cases.map((entry) => entry.pr_number)).not.toContain(8);
    expect(summary.missing).toEqual({ "not-on-main": 1 });
    expect(summary.repos[REPO]).toMatchObject({ graph_merged: 3, main_log_prs: 2, with_facts: 2 });
  });

  // Kills: skipping the filter layer, and a filter that reads only the written subject.
  it("excludes and counts a PR whose landing commit names a private task", () => {
    const { cases, summary } = buildHistory(inputs());

    expect(cases.map((entry) => entry.pr_number)).not.toContain(9);
    expect(summary.excluded).toEqual({ "private-marker": 1 });
  });

  it("refuses an --out inside a git work tree", async () => {
    await expect(writeHistory(join(root, "origin", "out"), inputs())).rejects.toThrow(/inside a git work tree/);
  });

  // Kills: the CLI widening the exclusion's repo allowlist to whatever --repo names.
  it("excludes every PR of a --repo outside the exclusion's allowlist as private-repo", async () => {
    const out = join(root, "out-cli");
    const awRoot = mkdtempSync(join(root, "aw-"));
    const argv = ["history", "build", "--until", UNTIL, "--out", out, "--repo", REPO, "--graph", join(root, "graph.sqlite3")];

    const code = await runCli([...argv, "--mirrors", join(root, "mirrors"), "--active-work-root", awRoot, "--no-fetch"]);

    expect(code).toBe(0);
    expect(JSON.parse(read(out).summary)).toMatchObject({ cases: 0, excluded: { "private-repo": 2 } });
  });
});
