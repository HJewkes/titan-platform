import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createProject,
  disposeProject,
  fullIndexSnapshot,
  readSnapshot,
  runIndex,
  type Project,
} from "./incremental.test-helpers.js";

// A `references` edge lands past a barrel on the declaring file, and a stylesheet import on
// no indexed file, so neither target equals its specifier's re-resolution. Comparing them
// re-parsed every such importer whenever a PR added a file: 802 re-parses for a small diff (TP-4436).
describe("membership delta past barrels and non-source imports", () => {
  let project: Project;
  const index = () => runIndex(project.store, project.rootDir);
  const src = (...parts: string[]): string => path.join(project.rootDir, "src", ...parts);

  beforeEach(async () => {
    project = await createProject();
  });

  afterEach(async () => {
    await disposeProject(project);
  });

  it("re-parses only the added file when importers reach symbols through a barrel or import a stylesheet", async () => {
    await fs.writeFile(src("idx.ts"), 'export * from "./a.js";\n');
    await fs.writeFile(src("user.ts"), 'import { A } from "./idx.js";\nexport const U = A;\n');
    await fs.writeFile(src("view.ts"), 'import "./view.css";\nimport { A } from "./idx.js";\nexport const V = A;\n');
    await fs.writeFile(src("view.css"), "body {}\n");
    await index();
    await fs.writeFile(src("added.ts"), "export const Added = 1;\n");

    const incremental = await index();

    expect(incremental.reparsed).toBe(1);
    expect(incremental.reused).toBe(incremental.files - 1);
    expect(readSnapshot(project.store, incremental.snapshotId)).toEqual(await fullIndexSnapshot(project.rootDir));
  });

  it("re-points an importer through a barrel when an added file shadows the barrel's re-export", async () => {
    await fs.mkdir(src("m"), { recursive: true });
    await fs.writeFile(src("m", "index.ts"), "export const M = 1;\n");
    await fs.writeFile(src("idx.ts"), 'export * from "./m";\n');
    await fs.writeFile(src("user.ts"), 'import { M } from "./idx.js";\nexport const U = M;\n');
    await index();
    await fs.writeFile(src("m.ts"), "export const M = 2;\n");

    const incremental = await index();

    expect(readSnapshot(project.store, incremental.snapshotId)).toEqual(await fullIndexSnapshot(project.rootDir));
  });
});
