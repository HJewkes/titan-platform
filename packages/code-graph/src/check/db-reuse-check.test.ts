import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, disposeProject, readSnapshot, runIndex, type Project } from "../incremental.test-helpers.js";
import { openCodeGraph } from "../store.js";
import { checkSnapshot } from "./run.js";
import type { CheckRule } from "./types.js";

// TP-1854: CI restores a graph DB built at another commit and indexes the new tree on top of it.
const RULES: CheckRule[] = [
  { type: "forbid-import", id: "no-e-to-a", from: "src/e.ts", to: "src/a.ts" },
  { type: "forbid-import", id: "no-d-to-a", from: "src/d.ts", to: "src/a.ts" },
  { type: "metric-max", id: "a-stays-short", metric: "loc", max: 2, kind: "file" },
];

describe("dag-check on a graph DB built at an earlier tree", () => {
  let project: Project;
  const write = (name: string, body: string) => fs.writeFile(path.join(project.rootDir, "src", name), body);

  beforeEach(async () => {
    project = await createProject();
    await write("e.ts", 'import { A } from "./a.js";\nexport const E = A;\n');
  });

  afterEach(() => disposeProject(project));

  it("matches a cold index after a file is added, changed and deleted", async () => {
    await runIndex(project.store, project.rootDir);

    await fs.rm(path.join(project.rootDir, "src", "e.ts"));
    await write("a.ts", "export const A = 1;\nexport const A2 = A + 1;\nexport const A3 = A2 + 1;\n");
    await write("d.ts", 'import { A3 } from "./a.js";\nexport const D = A3;\n');

    const warm = await runIndex(project.store, project.rootDir);
    const warmRun = checkSnapshot(project.store, { snapshot: warm.snapshotId, rules: RULES });
    const coldStore = openCodeGraph(":memory:");
    const cold = await runIndex(coldStore, project.rootDir, { incremental: false });
    const coldRun = checkSnapshot(coldStore, { snapshot: cold.snapshotId, rules: RULES });

    expect(warm.reused).toBeGreaterThan(0);
    expect(warm.reparsed).toBeGreaterThan(0);
    expect(readSnapshot(project.store, warm.snapshotId)).toEqual(readSnapshot(coldStore, cold.snapshotId));
    const key = (r: typeof warmRun) => r.result.violations.map((v) => `${v.ruleId} ${v.nodeId}`).sort();
    expect(key(warmRun)).toEqual(key(coldRun));
    expect(key(warmRun)).toContain("no-d-to-a src/d.ts");
    expect(key(warmRun).some((k) => k.startsWith("no-e-to-a"))).toBe(false);
    coldStore.close();
  });
});
