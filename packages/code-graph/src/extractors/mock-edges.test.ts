import { describe, expect, it } from "vitest";
import { ModuleKind, ModuleResolutionKind, Project, ScriptTarget } from "ts-morph";
import { parseFile } from "@titan-design/code-parser";
import { TsMorphGraphExtractor } from "./ts-morph-extractor.js";

const FILES: Record<string, string> = {
  "/repo/src/store.ts": `export const save = () => 1;\n`,
  "/repo/src/clock.ts": `export const now = () => 0;\n`,
  "/repo/src/feed.ts": `import { save } from "./store.js";\nexport const run = () => save();\n`,
  "/repo/src/feed.test.ts":
    `import { vi } from "vitest";\n` +
    `import { run } from "./feed.js";\n` +
    `vi.mock("./store.js");\n` +
    "jest.mock(`./clock`);\n" +
    `const name = "./feed.js";\n` +
    `vi.mock(name);\n` +
    `other.mock("./feed.js");\n` +
    `export const t = run();\n`,
};

async function mockTargets(file: string): Promise<string[]> {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { target: ScriptTarget.ESNext, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.NodeNext },
  });
  for (const [filePath, content] of Object.entries(FILES)) project.createSourceFile(filePath, content);
  project.saveSync();
  const extractor = new TsMorphGraphExtractor({ repoRoot: "/repo", project });
  const [fragment] = extractor.extract(await parseFile(FILES[file]!, file, "typescript"));
  return fragment!.edges.filter((e) => e.kind === "mocks").map((e) => e.dstId).sort();
}

describe("mocks edges", () => {
  it("point a test at each module a static vi.mock or jest.mock specifier resolves to", async () => {
    expect(await mockTargets("/repo/src/feed.test.ts")).toEqual(["src/clock.ts", "src/store.ts"]);
  });

  it("are absent from a file that mocks nothing", async () => {
    expect(await mockTargets("/repo/src/feed.ts")).toEqual([]);
  });
});
