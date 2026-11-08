import { describe, expect, it } from "vitest";
import { ModuleKind, ModuleResolutionKind, Project, ScriptTarget } from "ts-morph";
import { parseFile } from "@titan-design/code-parser";
import type { GraphEdge } from "../types.js";
import { TsMorphGraphExtractor } from "./ts-morph-extractor.js";

const FILES: Record<string, string> = {
  "/repo/src/store.cjs": `module.exports = { save: () => 1 };\n`,
  "/repo/src/clock.cjs": `module.exports = { now: () => 0 };\n`,
  "/repo/src/feed.ts": `import { now } from "./clock.cjs";\nexport const run = () => now();\n`,
  "/repo/src/legacy.cjs":
    `const { save } = require("./store.cjs");\n` +
    "const clock = require(`./clock.cjs`);\n" +
    `const name = "./feed.js";\n` +
    `require(name);\n` +
    `require.resolve("./feed.js");\n` +
    `loader.require("./feed.js");\n` +
    `require("node:fs");\n` +
    `module.exports = () => save() + clock.now();\n`,
};

async function edgesOf(file: string): Promise<GraphEdge[]> {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, target: ScriptTarget.ESNext, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.NodeNext },
  });
  for (const [filePath, content] of Object.entries(FILES)) project.createSourceFile(filePath, content);
  project.saveSync();
  const extractor = new TsMorphGraphExtractor({ repoRoot: "/repo", project });
  const [fragment] = extractor.extract(await parseFile(FILES[file]!, file, "typescript"));
  return fragment!.edges.filter((e) => e.kind === "imports");
}

describe("require edges", () => {
  it("point a file at each in-repo module a static require() specifier resolves to, marked require", async () => {
    const edges = await edgesOf("/repo/src/legacy.cjs");

    expect(edges.map((e) => [e.dstId, e.attrs?.require]).sort()).toEqual([
      ["src/clock.cjs", true],
      ["src/store.cjs", true],
    ]);
  });

  it("leave an ESM import unmarked", async () => {
    const edges = await edgesOf("/repo/src/feed.ts");

    expect(edges.map((e) => [e.dstId, e.attrs?.require])).toEqual([["src/clock.cjs", undefined]]);
  });
});
