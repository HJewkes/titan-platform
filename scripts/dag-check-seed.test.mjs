import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LOCK_DIR } from "./dag-check-lock.mjs";
import { MACHINE_SEED, refreshSeed, seedArgs } from "./dag-check-seed.mjs";
import { seedDbPath } from "./dag-check-self.mjs";

const ENTRY = new URL("../packages/code-graph/dist/index.js", import.meta.url);
const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scratchDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "dag-check-seed-test-"));
  dirs.push(dir);
  return dir;
}

describe("seedArgs", () => {
  const always = () => true;

  it("seeds from the machine graph beside the lock when one exists", () => {
    expect(path.dirname(MACHINE_SEED)).toBe(path.dirname(DEFAULT_LOCK_DIR));
    expect(seedArgs(["--json"], {}, always)).toEqual(["--json", "--seed-db", MACHINE_SEED]);
  });

  it("leaves an explicit --seed-db to win, as CI's cache does", () => {
    const argv = ["--seed-db", "/ci/graph.db"];
    expect(seedArgs(argv, {}, always)).toEqual(argv);
  });

  it("does not seed when DAG_CHECK_NO_SEED is set or no seed file exists yet", () => {
    expect(seedArgs(["--json"], { DAG_CHECK_NO_SEED: "1" }, always)).toEqual(["--json"]);
    expect(seedArgs(["--json"], {}, () => false)).toEqual(["--json"]);
  });
});

describe("refreshSeed", () => {
  function finishedRun() {
    const dir = scratchDir();
    const workDb = path.join(dir, "graph.db");
    const seedPath = path.join(dir, "seed.db");
    writeFileSync(workDb, "new graph");
    writeFileSync(seedPath, "old graph");
    return { dir, workDb, seedPath };
  }

  it.each([0, 1])("replaces the seed after exit %i and leaves no temp file", (code) => {
    const { dir, workDb, seedPath } = finishedRun();
    expect(refreshSeed({ workDb, seedPath, code })).toBe(true);
    expect(readFileSync(seedPath, "utf8")).toBe("new graph");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it.each([2, 75, null])("keeps the old seed after exit %s, whose graph may be partial", (code) => {
    const { dir, workDb, seedPath } = finishedRun();
    expect(refreshSeed({ workDb, seedPath, code })).toBe(false);
    expect(readFileSync(seedPath, "utf8")).toBe("old graph");
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});

function gitIn(dir, ...args) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir });
}

function fixtureRepo() {
  const dir = scratchDir();
  gitIn(dir, "init", "-q");
  mkdirSync(path.join(dir, "packages/src"), { recursive: true });
  for (const name of ["a", "b", "c"]) writeFileSync(path.join(dir, `packages/src/${name}.ts`), `export const ${name} = 1;\n`);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", "x");
  return dir;
}

/** What indexUnderLock does: start from the seed seedArgs names, index, refresh the seed from the finished graph. */
async function seededIndex(graph, root, seedPath) {
  const workDb = path.join(scratchDir(), "graph.db");
  const seed = seedDbPath(seedArgs([], {}, existsSync, seedPath));
  if (seed) copyFileSync(seed, workDb);
  const store = graph.openCodeGraph(workDb);
  const run = await graph.indexPaths(store, { paths: [path.join(root, "packages")], ref: "head", computeChurn: false });
  store.close();
  refreshSeed({ workDb, seedPath, code: 0 });
  return run;
}

describe.skipIf(!existsSync(ENTRY))("a seeded index (needs pnpm build for code-graph's dist)", () => {
  it("reuses every file a run in another worktree of the same repo indexed", async () => {
    const graph = await import(ENTRY.href);
    const repo = fixtureRepo();
    const other = path.join(scratchDir(), "other");
    gitIn(repo, "worktree", "add", "-q", "--detach", other);
    const seedPath = path.join(scratchDir(), "seed.db");

    const cold = await seededIndex(graph, repo, seedPath);
    const warm = await seededIndex(graph, other, seedPath);

    expect(cold.reused).toBe(0);
    expect(warm.reused).toBe(3);
  }, 60_000);
});
