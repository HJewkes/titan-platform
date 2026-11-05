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

const HUB = "export const H = 1;\nexport function hub(): number {\n  return H;\n}\n";
const HUB_PLUS = (extra: string): string => `${extra}export const H = 1;\nexport function hub(): number {\n  return H;\n}\n`;

// The shape of a PR that slowed dag-check (TP-3676, TP-4781): it adds a file and a hub
// that many files import gains an export, which re-extracted every importer of the hub.
describe("an export-surface change on a hub file", () => {
  let project: Project;
  const write = (name: string, text: string): Promise<void> => fs.writeFile(path.join(project.rootDir, "src", name), text);
  const index = () => runIndex(project.store, project.rootDir);
  const indexAgainstCold = async () => {
    const result = await index();
    expect(readSnapshot(project.store, result.snapshotId)).toEqual(await fullIndexSnapshot(project.rootDir));
    return result;
  };

  beforeEach(async () => {
    project = await createProject();
    await write("hub.ts", HUB);
    for (const name of ["u1", "u2", "u3"]) {
      await write(`${name}.ts`, `import { H, hub } from "./hub.js";\nexport const ${name.toUpperCase()} = H + hub();\n`);
    }
  });

  afterEach(async () => {
    await disposeProject(project);
  });

  it("re-extracts only the hub and the added file when the hub gains an export no importer names", async () => {
    await index();
    await write("added.ts", "export const ADDED = 2;\n");
    await write("hub.ts", HUB_PLUS('import { ADDED } from "./added.js";\nexport const H2 = ADDED;\n'));

    const result = await indexAgainstCold();

    expect(result.reparsed).toBe(2);
  });

  it("re-extracts a namespace importer, whose whole-object use credits every export", async () => {
    await write("ns.ts", 'import * as all from "./hub.js";\nexport const N = Object.keys(all);\n');
    await index();
    await write("hub.ts", HUB_PLUS("export const H2 = 2;\n"));

    const result = await indexAgainstCold();

    expect(result.reparsed).toBe(2);
  });

  it("re-extracts only the importer of an export the hub stopped exporting", async () => {
    await write("u1.ts", 'import { H } from "./hub.js";\nexport const U1 = H;\n');
    await write("u2.ts", 'import { hub } from "./hub.js";\nexport const U2 = hub();\n');
    await write("u3.ts", 'import { hub } from "./hub.js";\nexport const U3 = hub();\n');
    await index();
    await write("hub.ts", "const H = 1;\nexport function hub(): number {\n  return H;\n}\n");

    const result = await indexAgainstCold();

    expect(result.reparsed).toBe(2);
  });

  it("re-extracts an importer of a barrel over the hub when its text names the added export", async () => {
    await write("barrel.ts", 'export * from "./hub.js";\n');
    await write("late.ts", 'import { H } from "./barrel.js";\nexport const LATE = H;\nexport const LABEL = "H3";\n');
    await index();
    await write("hub.ts", HUB_PLUS("export const H3 = 3;\n"));

    const result = await indexAgainstCold();

    expect(result.reparsed).toBe(2);
  });

  it("re-extracts every importer when the hub gains a default export, which a default import binds unnamed", async () => {
    await write("dflt.ts", 'import main from "./hub.js";\nexport const D = main;\n');
    await index();
    await write("hub.ts", HUB_PLUS("export default function main(): number {\n  return 0;\n}\n"));

    const result = await indexAgainstCold();

    expect(result.reparsed).toBe(5);
  });

  it("stays identical to a cold index when the added file imports the hub", async () => {
    await index();
    await write("added.ts", 'import { hub } from "./hub.js";\nexport const ADDED = hub();\n');
    await write("hub.ts", HUB_PLUS("export const H2 = 2;\n"));

    const result = await indexAgainstCold();

    expect(result.reparsed).toBe(2);
  });
});
