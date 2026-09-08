import { describe, expect, it } from "vitest";
import { annotateRoles, classifyRole, computeRoleHints } from "./roles.js";
import { fileId } from "./extractors/ids.js";
import type { GraphNode } from "./types.js";

describe("role classification", () => {
  it("labels tests, fixtures, barrels, types, config, and scripts", () => {
    expect(classifyRole("src/a.test.ts")).toBe("test");
    expect(classifyRole("src/__tests__/a.ts")).toBe("test");
    expect(classifyRole("src/fixtures/sample.ts")).toBe("fixture");
    expect(classifyRole("src/index.ts")).toBe("barrel");
    expect(classifyRole("src/types.ts")).toBe("types");
    expect(classifyRole("tsup.config.ts")).toBe("config");
    expect(classifyRole("scripts/build.ts")).toBe("script");
    expect(classifyRole("src/thing.ts")).toBe("source");
  });

  it("prefers entry over barrel for a shebang file, and generated over everything", () => {
    expect(classifyRole("src/index.ts", { hasShebang: true })).toBe("entry");
    expect(classifyRole("src/a.test.ts", { isGenerated: true })).toBe("generated");
  });

  it("derives shebang and generated hints from file content and path", () => {
    const hints = computeRoleHints(
      [
        { filePath: "/repo/src/cli.ts", content: "#!/usr/bin/env node\n" },
        { filePath: "/repo/src/api.gen.ts", content: "export const x = 1;\n" },
      ],
      "/repo",
      fileId,
    );
    expect(hints.shebangIds).toContain("src/cli.ts");
    expect(hints.generatedIds).toContain("src/api.gen.ts");
  });

  it("annotates only file and module nodes, leaving symbols alone", () => {
    const nodes: GraphNode[] = [
      { id: "src/index.ts", kind: "file", name: "index.ts" },
      { id: "src/index", kind: "module", name: "index" },
      { id: "src/index.ts#run", kind: "symbol", name: "run" },
    ];
    const annotated = annotateRoles(nodes);
    expect(annotated.map((n) => n.role)).toEqual(["barrel", "barrel", undefined]);
  });
});
