import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as path from "node:path";
import { openDatabase } from "@titan-design/store-sqlite";
import { checkSnapshot } from "../check/run.js";
import type { CheckRule } from "../check/types.js";
import { diffCheckResults } from "../diff/check-diff.js";
import { diffSnapshots } from "../diff/diff.js";
import { makeTestRepo, type TestRepo } from "../history/test-repo.js";
import { indexPaths } from "../indexer.js";
import { CodeGraphStore, openCodeGraph } from "../store.js";
import { ALIAS_BASE_ATTR } from "./lineage.js";
import { priorSnapshotForRef, resolveAlias } from "./store-identity.js";

const JOB = `import { helper } from "./util";

export class Job {
  run(flag: boolean): number {
    if (flag) {
      if (helper()) {
        if (flag) {
          return 1;
        }
      }
    }
    return 0;
  }

  stop(): void {
    helper();
  }
}

export function other(): number {
  return helper() ? 1 : 2;
}
`;

const RULES: CheckRule[] = [
  { type: "metric-max", id: "nesting", metric: "max_nesting_depth", kind: "file", max: 2 },
  { type: "forbid-import", id: "no-node", from: "**", to: "node:**" },
  { type: "forbid-import", id: "no-util", from: "**", to: "**/util.ts" },
];

interface Fixture {
  repo: TestRepo;
  store: CodeGraphStore;
  snaps: Record<string, number>;
}

async function commitAndIndex(f: Fixture, name: string, ref: string, change: () => Promise<void> | void) {
  await change();
  f.repo.commit(name);
  const result = await indexPaths(f.store, { paths: [f.repo.dir], ref, computeChurn: false });
  f.snaps[name] = result.snapshotId;
}

async function buildFixture(): Promise<Fixture> {
  const repo = await makeTestRepo();
  const f: Fixture = { repo, store: openCodeGraph(path.join(repo.dir, ".git", "graph.db")), snaps: {} };
  const mv = (from: string, to: string) => repo.git(["mv", from, to]);
  await commitAndIndex(f, "create", "main", async () => {
    await repo.write("src/job.ts", JOB);
    await repo.write("src/util.ts", "export function helper(): boolean {\n  return true;\n}\n");
  });
  await commitAndIndex(f, "rename", "main", () => mv("src/job.ts", "src/task.ts"));
  await commitAndIndex(f, "rename-again", "main", () => mv("src/task.ts", "src/worker.ts"));
  await commitAndIndex(f, "move-dir", "main", () => mv("src", "core"));
  await commitAndIndex(f, "new-violation", "main", () =>
    repo.write("core/worker.ts", `import { readFileSync } from "node:fs";\n${JOB}export const read = readFileSync;\n`),
  );
  return f;
}

describe("identity across renames, on a real git history", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await buildFixture();
  }, 30_000);

  afterAll(async () => {
    f.store.close();
    await f.repo.cleanup();
  });

  it("resolves a file through two renames and a directory move", () => {
    const trace = resolveAlias(f.store, "src/job.ts", f.snaps["move-dir"]!, { fromSnapshotId: f.snaps.create });

    expect(trace.id).toBe("core/worker.ts");
    expect(trace.hops.map((h) => h.newId)).toEqual(["src/task.ts", "src/worker.ts", "core/worker.ts"]);
    expect(trace.reason).toBe("move");
  });

  it("carries a symbol with its file", () => {
    const moveDir = f.snaps["move-dir"]!;

    const trace = resolveAlias(f.store, "src/job.ts#Job.run", moveDir, { fromSnapshotId: f.snaps.create });

    expect(trace.id).toBe("core/worker.ts#Job.run");
    expect(f.store.getNode(moveDir, trace.id)?.kind).toBe("symbol");
  });

  it("resolves an old id without naming the snapshot it came from", () => {
    expect(resolveAlias(f.store, "src/job", f.snaps["move-dir"]!).id).toBe("core/worker");
  });

  it("diffs across every rename as renames, with no node or edge churn", () => {
    const diff = diffSnapshots(f.store, { fromSnapshotId: f.snaps.create!, toSnapshotId: f.snaps["move-dir"]! });

    expect(diff.summary).toMatchObject({ addedNodes: 0, removedNodes: 0, addedEdges: 0, removedEdges: 0 });
    expect(diff.renamedNodes.find((r) => r.oldId === "src/job.ts")).toMatchObject({ newId: "core/worker.ts", reason: "move" });
  });

  it("carries a moved file's violation over instead of reporting it new", () => {
    const run = checkSnapshot(f.store, { snapshot: f.snaps["move-dir"]!, baseline: f.snaps.create!, rules: RULES });

    expect(run.result).toMatchObject({ newErrors: 0, newWarnings: 0, carryoverErrors: 2 });
    expect(run.result.violations.map((v) => [v.ruleId, v.nodeId, v.destinationId, v.isCarryover])).toEqual([
      ["nesting", "core/worker.ts", undefined, true],
      ["no-util", "core/worker.ts", "core/util.ts", true],
    ]);
  });

  it("buckets the pure move as unchanged in the check diff", () => {
    const diff = diffCheckResults(f.store, { fromSnapshotId: f.snaps.create!, toSnapshotId: f.snaps["move-dir"]!, rules: RULES });

    expect([diff.newViolations.length, diff.resolvedViolations.length, diff.unchanged.length]).toEqual([0, 0, 2]);
  });

  it("still reports a real new violation in the moved file", () => {
    const run = checkSnapshot(f.store, { snapshot: f.snaps["new-violation"]!, baseline: f.snaps.create!, rules: RULES });

    const fresh = run.result.violations.filter((v) => !v.isCarryover);
    expect(fresh.map((v) => [v.ruleId, v.nodeId, v.destinationId])).toEqual([["no-node", "core/worker.ts", "node:fs"]]);
    expect(run.result.carryoverErrors).toBe(2);
  });

  it("matches the baseline when the baseline was indexed after the checked snapshot", () => {
    const run = checkSnapshot(f.store, { snapshot: f.snaps.create!, baseline: f.snaps["move-dir"]!, rules: RULES });

    expect(run.result).toMatchObject({ newErrors: 0, carryoverErrors: 2 });
  });
});

describe("ref-scoped alias bases", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await buildFixture();
    f.repo.git(["checkout", "-q", "-b", "feature"]);
    await commitAndIndex(f, "feature-rename", "feature", () => f.repo.git(["mv", "core/util.ts", "core/helpers.ts"]));
    f.repo.git(["checkout", "-q", "main"]);
    await commitAndIndex(f, "main-edit", "main", () => f.repo.write("core/extra.ts", "export const extra = 1;\n"));
  }, 30_000);

  afterAll(async () => {
    f.store.close();
    await f.repo.cleanup();
  });

  it("computes a ref's aliases against that ref's own newest snapshot", () => {
    const base = (name: string) => f.store.getSnapshot(f.snaps[name]!)?.attrs[ALIAS_BASE_ATTR];

    expect(base("feature-rename")).toBe(f.snaps["new-violation"]);
    expect(base("main-edit")).toBe(f.snaps["new-violation"]);
  });

  it("finds the snapshot a git ref denotes before a given snapshot", () => {
    const prior = priorSnapshotForRef(f.store, "feature", { before: f.snaps["main-edit"], repoRoot: f.repo.dir });

    expect(prior?.id).toBe(f.snaps["feature-rename"]);
  });

  it("finds a snapshot by the commit an annotated tag points at, with no snapshot labelled by the tag", () => {
    const tagger = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
    f.repo.git([...tagger, "tag", "-a", "v0.1", "-m", "v0.1", "main~3"]);

    const prior = priorSnapshotForRef(f.store, "v0.1", { repoRoot: f.repo.dir });

    expect(prior?.id).toBe(f.snaps["rename-again"]);
  });

  it("falls back to the ref label without a checkout", () => {
    expect(priorSnapshotForRef(f.store, "main", { before: f.snaps["main-edit"] })?.id).toBe(f.snaps["new-violation"]);
  });

  it("undoes a branch's rename when resolving into the other branch", () => {
    const trace = resolveAlias(f.store, "core/helpers.ts", f.snaps["main-edit"]!, { fromSnapshotId: f.snaps["feature-rename"] });

    expect(trace.id).toBe("core/util.ts");
  });
});

describe("stores written before index version 0.15.0", () => {
  let f: Fixture;
  let dbPath: string;

  beforeAll(async () => {
    f = await buildFixture();
    dbPath = path.join(f.repo.dir, ".git", "graph.db");
    // A 0.14.0 indexer wrote no alias base and diffed against the newest committed snapshot.
    f.store.db.exec("UPDATE snapshot SET attrs = '{}', index_version = '0.14.0'");
    f.store.close();
  }, 30_000);

  afterAll(async () => {
    await f.repo.cleanup();
  });

  it("diffs across every rename on a read-only store by inferring the lineage", () => {
    const store = new CodeGraphStore(openDatabase(dbPath, { readonly: true }));

    const diff = diffSnapshots(store, { fromSnapshotId: f.snaps.create!, toSnapshotId: f.snaps["move-dir"]! });
    store.close();

    expect(diff.summary).toMatchObject({ addedNodes: 0, removedNodes: 0 });
    expect(diff.renamedNodes.map((r) => `${r.oldId} ${r.newId}`).sort()).toEqual([
      "src/job core/worker",
      "src/job.ts core/worker.ts",
      "src/util core/util",
      "src/util.ts core/util.ts",
    ]);
  });

  it("keeps an unmoved file's violation key identical, so old baselines still match", () => {
    const store = new CodeGraphStore(openDatabase(dbPath, { readonly: true }));
    const snaps = { snapshot: f.snaps["new-violation"]!, baseline: f.snaps["move-dir"]! };

    const run = checkSnapshot(store, { ...snaps, rules: RULES });
    store.close();

    const carried = run.result.violations.filter((v) => v.isCarryover);
    expect(carried.map((v) => `${v.ruleId} ${v.nodeId}`)).toEqual(["nesting core/worker.ts", "no-util core/worker.ts"]);
  });
});
