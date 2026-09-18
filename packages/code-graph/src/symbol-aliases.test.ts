import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { INDEX_VERSION, indexPaths } from "./indexer.js";
import { loadReuseBasis } from "./incremental.js";
import { openCodeGraph, type CodeGraphStore } from "./store.js";
import { predatesQualifiedSymbols } from "./symbol-aliases.js";

const JOBS_TS = `export function run(): void {}

export class Alpha {
  constructor() {}
  run(): void {}
  only(): void {}
}

export class Beta {
  constructor() {}
}

function outer(): void {
  function helper(): void {}
  helper();
}
outer();
`;

async function makeProject(): Promise<{ root: string; store: CodeGraphStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-alias-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src/jobs.ts"), JOBS_TS);
  return { root, store: openCodeGraph(path.join(root, "graph.sqlite3")) };
}

describe("predatesQualifiedSymbols", () => {
  it("treats versions before 0.14.0 and unversioned snapshots as bare-name", () => {
    expect(["", "0.13.0", "0.9.9", "0.13.12"].map(predatesQualifiedSymbols)).toEqual([true, true, true, true]);
    expect(["0.14.0", "0.14.1", "1.0.0", INDEX_VERSION].map(predatesQualifiedSymbols)).toEqual([false, false, false, false]);
  });
});

describe("index version upgrades", () => {
  let root: string;
  let store: CodeGraphStore;

  beforeEach(async () => {
    ({ root, store } = await makeProject());
  });

  afterEach(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const index = () => indexPaths(store, { paths: [root], ref: "wd", detectRenames: false, computeChurn: false });
  const setIndexVersion = (snapshotId: number, version: string) =>
    store.db.prepare("UPDATE snapshot SET index_version = ? WHERE id = ?").run(version, snapshotId);

  it("aliases a bare-name id to its qualified id only where one declaration claims it", async () => {
    const legacy = await index();
    setIndexVersion(legacy.snapshotId, "0.13.0");
    const upgraded = await index();
    expect(store.listAliases(upgraded.snapshotId).sort((a, b) => a.oldId.localeCompare(b.oldId))).toEqual([
      { oldId: "src/jobs.ts#helper", newId: "src/jobs.ts#outer.helper", reason: "requalify" },
      { oldId: "src/jobs.ts#only", newId: "src/jobs.ts#Alpha.only", reason: "requalify" },
    ]);
  });

  it("writes no symbol aliases once the prior snapshot already has qualified ids", async () => {
    await index();
    const second = await index();
    expect(store.listAliases(second.snapshotId)).toEqual([]);
  });

  it("never reuses a snapshot written by a different index version", async () => {
    const legacy = await index();
    setIndexVersion(legacy.snapshotId, "0.13.0");
    expect(loadReuseBasis(store, INDEX_VERSION)).toBeNull();
    expect(loadReuseBasis(store, "0.13.0")?.snapshotId).toBe(legacy.snapshotId);

    const upgraded = await index();
    expect(upgraded.reused).toBe(0);
    expect(upgraded.reparsed).toBe(upgraded.files);

    const next = await index();
    expect(loadReuseBasis(store, INDEX_VERSION)?.snapshotId).toBe(next.snapshotId);
    expect(next.reused).toBe(next.files);
  });
});
