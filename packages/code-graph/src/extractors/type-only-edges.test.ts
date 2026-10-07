import { describe, expect, it } from "vitest";
import { ModuleKind, ModuleResolutionKind, Project, ScriptTarget } from "ts-morph";
import { parseFile } from "@titan-design/code-parser";
import { TsMorphGraphExtractor } from "./ts-morph-extractor.js";
import type { GraphEdge } from "../types.js";

const FILES: Record<string, string> = {
  "/repo/src/t.ts": `export type T = number;\nexport const v = 1;\n`,
  "/repo/src/decl.ts": `import type { T } from "./t.js";\nexport const d: T = 1;\n`,
  "/repo/src/inline.ts": `import { type T } from "./t.js";\nexport const i: T = 1;\n`,
  "/repo/src/value.ts": `import { v } from "./t.js";\nexport const w = v;\n`,
  "/repo/src/mixed.ts": `import type { T } from "./t.js";\nimport { v } from "./t.js";\nexport const m: T = v;\n`,
  "/repo/src/side.ts": `import "./t.js";\n`,
  "/repo/src/re-type.ts": `export type { T } from "./t.js";\n`,
  "/repo/src/re-value.ts": `export { v } from "./t.js";\n`,
};

async function edgesOf(file: string): Promise<GraphEdge[]> {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { target: ScriptTarget.ESNext, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.NodeNext },
  });
  for (const [filePath, content] of Object.entries(FILES)) project.createSourceFile(filePath, content);
  project.saveSync();
  const extractor = new TsMorphGraphExtractor({ repoRoot: "/repo", project });
  const [fragment] = extractor.extract(await parseFile(FILES[file]!, file, "typescript"));
  return fragment!.edges.filter((e) => e.dstId === "src/t.ts" && e.kind !== "references");
}

describe("type-only import and re-export edges", () => {
  it.each([
    ["/repo/src/decl.ts", true],
    ["/repo/src/inline.ts", true],
    ["/repo/src/re-type.ts", true],
    ["/repo/src/value.ts", undefined],
    ["/repo/src/mixed.ts", undefined],
    ["/repo/src/side.ts", undefined],
    ["/repo/src/re-value.ts", undefined],
  ])("%s marks typeOnly as %s", async (file, expected) => {
    const edges = await edgesOf(file);

    expect(edges).toHaveLength(1);
    expect(edges[0]!.attrs?.typeOnly).toBe(expected);
  });
});
