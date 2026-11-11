import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LOCK_DIR } from "./dag-check-lock.mjs";
import { COLD_DEFERRED_EXIT_CODE, ColdFallbackDeferred, MACHINE_SEED, openSeededWorkGraph, refreshSeed, runWithColdRetry, seedArgs, seedKeep } from "./dag-check-seed.mjs";
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

describe("seedKeep", () => {
  it("keeps several trees in the shared machine seed and one head with its baseline in any other", () => {
    expect(seedKeep(MACHINE_SEED)).toBeGreaterThan(2);
    expect(seedKeep(path.join(tmpdir(), "graph.db"))).toBe(2);
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

describe("retrying a seeded index that ran out of memory", () => {
  const setup = (results) => {
    const calls = [];
    const logs = [];
    let cleared = 0;
    const runWorker = async (argv) => {
      calls.push(argv);
      return results.shift();
    };
    return { calls, logs, cleared: () => cleared, run: (argv, deferCold, seeded) => runWithColdRetry({ argv, runWorker, clearWork: () => cleared++, log: (m) => logs.push(m), deferCold, ...(seeded === undefined ? {} : { seeded }) }) };
  };

  it("runs once more without the seed and returns that run's exit code", async () => {
    const t = setup([{ code: 2, heapAbort: true }, { code: 0, heapAbort: false }]);
    const code = await t.run(["--json", "--seed-db", "/seed.db"]);
    expect(code).toBe(0);
    expect(t.calls).toEqual([["--json", "--seed-db", "/seed.db"], ["--json"]]);
    expect(t.cleared()).toBe(1);
    expect(t.logs).toHaveLength(1);
  });

  it("defers instead of retrying cold when the caller forbids a cold index", async () => {
    const t = setup([{ code: 2, heapAbort: true }, { code: 0, heapAbort: false }]);
    const code = await t.run(["--json", "--seed-db", "/seed.db"], true);
    expect(code).toBe(COLD_DEFERRED_EXIT_CODE);
    expect(t.calls).toHaveLength(1);
    expect(t.cleared()).toBe(0);
  });

  it("does not retry an unseeded run that ran out of memory", async () => {
    const t = setup([{ code: 2, heapAbort: true }]);
    expect(await t.run(["--json"])).toBe(2);
    expect(t.calls).toHaveLength(1);
  });

  it("does not retry a seeded run that failed for another reason", async () => {
    const t = setup([{ code: 1, heapAbort: false }]);
    expect(await t.run(["--seed-db", "/seed.db"])).toBe(1);
    expect(t.calls).toHaveLength(1);
  });

  it("retries cold from plain argv when the caller names the seed it copied", async () => {
    const t = setup([{ code: 2, heapAbort: true }, { code: 0, heapAbort: false }]);
    const code = await t.run(["--json"], false, true);
    expect(code).toBe(0);
    expect(t.calls).toEqual([["--json"], ["--json"]]);
    expect(t.cleared()).toBe(1);
  });

  it("stops after one retry", async () => {
    const t = setup([{ code: 2, heapAbort: true }, { code: 2, heapAbort: true }]);
    expect(await t.run(["--seed-db", "/seed.db"])).toBe(2);
    expect(t.calls).toHaveLength(2);
  });
});

describe("opening a seeded work graph", () => {
  it("falls back to an empty graph when the seed is not a usable database", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dead-seed-"));
    const db = path.join(dir, "graph.db");
    writeFileSync(db, "not a sqlite database, a seed cut short");
    const graph = await import(ENTRY.href);
    const store = openSeededWorkGraph(graph, db);
    try {
      expect(store.listSnapshots({ limit: 1 })).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes a store that opens but fails to list snapshots before removing the db files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dead-seed-"));
    const db = path.join(dir, "graph.db");
    const events = [];
    const opened = { listSnapshots: () => { throw new Error("schema mismatch"); }, close: () => events.push(existsSync(db) ? "close-with-db-present" : "close-after-removal") };
    const graph = { openCodeGraph: () => { if (events.length === 0 && !existsSync(`${db}.opened`)) { writeFileSync(db, "seed"); writeFileSync(`${db}.opened`, ""); return opened; } return { listSnapshots: () => [] }; } };
    try {
      const store = openSeededWorkGraph(graph, db);
      expect(events).toEqual(["close-with-db-present"]);
      expect(existsSync(db)).toBe(false);
      expect(store.listSnapshots()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears the commit of every snapshot in a usable seed", async () => {
    const graph = await import(ENTRY.href);
    const dir = mkdtempSync(path.join(tmpdir(), "dead-seed-"));
    dirs.push(dir);
    const db = path.join(dir, "graph.db");
    const seed = graph.openCodeGraph(db);
    seed.db.prepare("UPDATE snapshot SET commit_hash = 'abc'").run();
    seed.close();
    const store = openSeededWorkGraph(graph, db);
    try {
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM snapshot WHERE commit_hash IS NOT NULL").get().n).toBe(0);
    } finally {
      store.close();
    }
  });

  it("refuses the cold fallback when a verify:changed run over the budget forbids it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dead-seed-"));
    const db = path.join(dir, "graph.db");
    writeFileSync(db, "not a sqlite database, a seed cut short");
    const graph = await import(ENTRY.href);
    try {
      expect(() => openSeededWorkGraph(graph, db, { deferCold: true })).toThrow(ColdFallbackDeferred);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
