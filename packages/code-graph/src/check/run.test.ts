import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { openCodeGraph, type CodeGraphStore } from "../store.js";
import { checkSnapshot, loadCheckRules, resolveSnapshot } from "./run.js";
import type { CheckRule } from "./types.js";

const MAX_LOC: CheckRule = { type: "metric-max", id: "max-loc", metric: "loc", max: 100 };

function snapshotWithLoc(store: CodeGraphStore, ref: string, loc: Record<string, number>): number {
  const id = store.createSnapshot({ ref, indexVersion: "1" });
  store.insertNodes(id, Object.keys(loc).map((nodeId) => ({ id: nodeId, kind: "file" as const, name: nodeId })));
  store.insertMetrics(id, Object.entries(loc).map(([nodeId, value]) => ({ nodeId, name: "loc", value })));
  return id;
}

function writeTemp(name: string, content: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "code-graph-run-")), name);
  writeFileSync(file, content);
  return file;
}

describe("checkSnapshot", () => {
  it("resolves ref names to their newest snapshot and ratchets against the baseline", () => {
    const store = openCodeGraph(":memory:");
    snapshotWithLoc(store, "baseline", { "old.ts": 500 });
    snapshotWithLoc(store, "head", { "old.ts": 1 });
    const head = snapshotWithLoc(store, "head", { "old.ts": 600, "new.ts": 700 });

    const { snapshot, baselineSnapshot, result } = checkSnapshot(store, {
      snapshot: "head",
      baseline: "baseline",
      rules: [MAX_LOC],
    });

    expect(snapshot.id).toBe(head);
    expect(baselineSnapshot?.ref).toBe("baseline");
    expect(result.violations.map((v) => [v.nodeId, v.isCarryover ?? false])).toEqual([
      ["old.ts", true],
      ["new.ts", false],
    ]);
    expect(result.passed).toBe(false);
  });

  it("accepts a numeric snapshot id, as a number or a digit string", () => {
    const store = openCodeGraph(":memory:");
    const id = snapshotWithLoc(store, "head", { "a.ts": 1 });
    expect(resolveSnapshot(store, id).id).toBe(id);
    expect(resolveSnapshot(store, String(id)).id).toBe(id);
  });

  it("fails loudly on an unknown ref or id", () => {
    const store = openCodeGraph(":memory:");
    expect(() => checkSnapshot(store, { snapshot: "head", rules: [] })).toThrow(/no snapshot found for ref "head"/);
    expect(() => resolveSnapshot(store, 42)).toThrow(/no snapshot with id 42/);
  });
});

describe("loadCheckRules", () => {
  it("validates the rules file and heals deprecated names through onWarn", async () => {
    const file = writeTemp("check.json", JSON.stringify({ rules: [{ ...MAX_LOC, metric: "lines" }] }));
    const warnings: string[] = [];

    const rules = await loadCheckRules(file, { onWarn: (m) => warnings.push(m) });

    expect(rules).toEqual([expect.objectContaining({ id: "max-loc", metric: "loc" })]);
    expect(warnings).toHaveLength(1);
  });

  it("names the file when it is missing or not JSON", async () => {
    const bad = writeTemp("check.json", "{ not json");
    await expect(loadCheckRules(bad)).rejects.toThrow(`Invalid JSON in ${bad}`);
    await expect(loadCheckRules(`${bad}.missing`)).rejects.toThrow("Cannot read rules file at");
  });
});
