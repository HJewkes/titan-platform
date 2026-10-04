import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keepDb, keptDbPath } from "./dag-check-self.mjs";
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
