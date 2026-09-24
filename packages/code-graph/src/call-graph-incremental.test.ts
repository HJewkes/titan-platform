import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { openCodeGraph, type CodeGraphStore } from "./store.js";
import { PY_FILES, TS_FILES, writeTree } from "./call-graph.test-helpers.js";
import { fullIndexSnapshot, readSnapshot, runIndex } from "./incremental.test-helpers.js";

let root: string;
let store: CodeGraphStore;

beforeEach(async () => {
  root = await writeTree({ ...TS_FILES, ...PY_FILES });
  store = openCodeGraph(path.join(root, ".codewatch", "graph.db"));
});

afterEach(async () => {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

const callsOf = (snapshotId: number) =>
  readSnapshot(store, snapshotId).edges.filter((e) => JSON.parse(e).kind === "calls");

describe("call edges under incremental reuse", () => {
  it("carries a reused caller's call edges forward, matching a full index", async () => {
    const first = await runIndex(store, root);
    await fs.appendFile(path.join(root, "py/helpers.py"), "\n\ndef extra():\n    return 2\n");
    const second = await runIndex(store, root);

    expect(second.reused).toBeGreaterThan(0);
    expect(callsOf(second.snapshotId)).toEqual(callsOf(first.snapshotId));
    expect(readSnapshot(store, second.snapshotId)).toEqual(await fullIndexSnapshot(root));
  });

  it("prunes a reused caller's edge to a callee that no longer exists, matching a full index", async () => {
    await runIndex(store, root);
    await fs.writeFile(path.join(root, "py/helpers.py"), "def renamed(a, b=1):\n    return a + b\n");
    const second = await runIndex(store, root);

    const dsts = callsOf(second.snapshotId).map((e) => JSON.parse(e).dstId as string);
    expect(dsts).not.toContain("py/helpers.py#shared_util");
    expect(readSnapshot(store, second.snapshotId)).toEqual(await fullIndexSnapshot(root));
  });
});
