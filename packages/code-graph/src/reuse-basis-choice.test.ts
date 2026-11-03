import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  A_TS,
  C_TS,
  createProject,
  disposeProject,
  fullIndexSnapshot,
  readSnapshot,
  runIndex,
  type Project,
} from "./incremental.test-helpers.js";

// A seeded graph's newest snapshot is often another tree: a baseline indexed after its head,
// or another worktree's run. Reuse must start from the snapshot closest to the tree indexed (TP-4398).
describe("reuse basis choice", () => {
  let project: Project;
  const index = () => runIndex(project.store, project.rootDir);
  const write = (name: string, text: string) => fs.writeFile(path.join(project.rootDir, "src", name), text);

  beforeEach(async () => {
    project = await createProject();
  });

  afterEach(async () => {
    await disposeProject(project);
  });

  it("an unchanged tree re-parses nothing when a different tree was indexed after it", async () => {
    await index();
    await write("a.ts", "export const A = 2;\nexport const A3 = 3;\n");
    await write("c.ts", "export const counter = 0;\n");
    await index();
    await write("a.ts", A_TS);
    await write("c.ts", C_TS);

    const again = await index();

    expect(again.reparsed).toBe(0);
    expect(again.reused).toBe(3);
    expect(readSnapshot(project.store, again.snapshotId)).toEqual(await fullIndexSnapshot(project.rootDir));
  });
});
