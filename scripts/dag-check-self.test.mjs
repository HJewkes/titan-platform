import { existsSync, mkdirSync, mkdtempSync, renameSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { forgetSeedCommits, keepDb, keptDbPath, seedDbPath } from "./dag-check-self.mjs";
import { graphFromDb } from "./dead-code-check.mjs";

const ENTRY = new URL("../packages/code-graph/dist/index.js", import.meta.url);
const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scratchDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "dag-check-self-test-"));
  dirs.push(dir);
  return dir;
}

async function closedGraph(dir) {
  const graph = await import(ENTRY.href);
  const workDb = path.join(dir, "work", "graph.db");
  rmSync(path.dirname(workDb), { recursive: true, force: true });
  const store = graph.openCodeGraph(workDb);
  const id = store.createSnapshot({ ref: "head", indexVersion: "" });
  store.insertNodes(id, [{ id: "src/a.ts", kind: "file", name: "a.ts", role: "source" }]);
  store.close();
  return workDb;
}

const OVER_LIMIT = `${"export const x = 1;\n".repeat(5)}`;
const RULES = [{ type: "metric-max", id: "max-loc", metric: "loc", max: 3, kind: "file" }];

function gitIn(dir, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" }).trim();
}

/** A repo where commit X has packages/src/old.ts over the loc limit and commit Y renames it to new.ts. */
function renameRepo() {
  const dir = scratchDir();
  gitIn(dir, "init", "-q");
  mkdirSync(path.join(dir, "packages/src"), { recursive: true });
  writeFileSync(path.join(dir, "packages/src/old.ts"), OVER_LIMIT);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", "x");
  const x = gitIn(dir, "rev-parse", "HEAD");
  renameSync(path.join(dir, "packages/src/old.ts"), path.join(dir, "packages/src/new.ts"));
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", "y");
  return { dir, x };
}

async function checkHeadAgainstBaseline({ seeded }) {
  const graph = await import(ENTRY.href);
  const { dir, x } = renameRepo();
  const store = graph.openCodeGraph(path.join(scratchDir(), "graph.db"));
  const index = (root, ref) => graph.indexPaths(store, { paths: [path.join(root, "packages")], ref, computeChurn: false });
  if (seeded) {
    const base = path.join(scratchDir(), "x");
    gitIn(dir, "worktree", "add", "--detach", base, x);
    await index(base, "head");
    forgetSeedCommits(store);
  }
  await index(dir, "head");
  const base = path.join(scratchDir(), "baseline");
  gitIn(dir, "worktree", "add", "--detach", base, x);
  await index(base, "baseline");
  const run = graph.checkSnapshot(store, { snapshot: "head", baseline: "baseline", rules: RULES });
  store.close();
  return { passed: run.result.passed, violations: run.result.violations.map((v) => [v.nodeId, v.isCarryover ?? false]) };
}

describe("seeding the graph from a CI cache", () => {
  it("gives the same check result as a cold index when a file with a violation was renamed", async () => {
    const cold = await checkHeadAgainstBaseline({ seeded: false });
    expect(await checkHeadAgainstBaseline({ seeded: true })).toEqual(cold);
  });

  it("reads --seed-db as an absolute path and refuses a missing value", () => {
    expect(seedDbPath(["--db", "/tmp/g.db", "--seed-db", "/tmp/s.db"])).toBe("/tmp/s.db");
    expect(seedDbPath(["--db", "/tmp/g.db"])).toBeNull();
    expect(() => seedDbPath(["--seed-db"])).toThrow("--seed-db needs a path");
  });
});

describe("keeping the graph for dead:check", () => {
  it("reads --db as an absolute path and refuses a missing value", () => {
    expect(keptDbPath(["--report", "r.json", "--db", "/tmp/g.db"])).toBe("/tmp/g.db");
    expect(keptDbPath(["--json"])).toBeNull();
    expect(() => keptDbPath(["--db"])).toThrow("--db needs a path");
  });

  it("leaves a head graph dead:check can read after the work dir is cleared", async () => {
    const dir = scratchDir();
    const workDb = await closedGraph(dir);
    const dbPath = path.join(dir, "kept", "graph.db");
    keepDb({ workDb, dbPath, code: 1 });
    rmSync(path.dirname(workDb), { recursive: true, force: true });
    const { nodes } = await graphFromDb(dbPath);
    expect(nodes.map((n) => n.id)).toEqual(["src/a.ts"]);
  });

  it("keeps nothing from a failed index, not even an earlier run's graph", async () => {
    const dir = scratchDir();
    const workDb = await closedGraph(dir);
    const dbPath = path.join(dir, "graph.db");
    writeFileSync(dbPath, "an earlier run");
    keepDb({ workDb, dbPath, code: 2 });
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe("the dag CI job", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

  it("hands dag:check's graph to dead:check instead of indexing twice", () => {
    expect(ci).toContain('pnpm dag:check --report "$RUNNER_TEMP/codewatch-report.json" --db "$RUNNER_TEMP/graph.db"');
    expect(ci).toContain('pnpm dead:check --db "$RUNNER_TEMP/graph.db"');
  });
});
