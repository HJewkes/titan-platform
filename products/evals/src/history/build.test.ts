import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixtureEnv, withHistory } from "@titan-design/test-kit/git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { lines, scratchRepo } from "../corpus/test-fixture.js";
import type { ExclusionPolicy } from "../private/exclusion.js";
import { buildHistory, writeHistory, type HistoryInputs } from "./build.js";
import { openGraph, type GraphReader } from "./graph.js";
import { ensureMirror } from "./mirror.js";

const REPO = "acme/widgets";
const UNTIL = "2026-02-01T00:00:00Z";
const POLICY: ExclusionPolicy = { repos: ["widgets"], initiatives: ["eng"], markers: { slugs: [], prefixes: ["STPX"] } };

let root: string;
let graph: GraphReader;

/** PRs 7 and 9 squash-land on main off its tip, each with its branch head published as `refs/pull/<n>/head`. */
function buildOrigin(dir: string): void {
  const origin = scratchRepo(dir);
  const pr7 = { "src/x.ts": lines(15), "src/x.test.ts": lines(10) };
  const pr9 = { "src/y.ts": lines(2) };
  const [, head7, , head9] = withHistory(origin.dir, [
    { files: { "src/a.ts": lines(3) }, message: "init" },
    { files: pr7, message: "work for 7", branch: "pr7", from: "main" },
    { files: pr7, message: "Add x (#7)" },
    { files: pr9, message: "work for 9", branch: "pr9", from: "main" },
    { files: pr9, message: "Add y (#9)\n\nPart of STPX-3." },
  ]);
  execFileSync("git", ["-C", origin.dir, "update-ref", "--stdin"], { input: `update refs/pull/7/head ${head7}\nupdate refs/pull/9/head ${head9}\n`, env: fixtureEnv() });
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
