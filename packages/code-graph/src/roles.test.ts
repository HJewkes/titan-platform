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

const identityId = (_root: string, filePath: string): string => filePath;

describe("classifyRole", () => {
  it("recognizes test files", () => {
    expect(classifyRole("packages/foo/src/__tests__/bar.test.ts")).toBe("test");
    expect(classifyRole("src/foo.test.ts")).toBe("test");
    expect(classifyRole("src/foo.spec.ts")).toBe("test");
    expect(classifyRole("src/__tests__/foo")).toBe("test");
  });

  it("recognizes fixture directories", () => {
    expect(classifyRole("src/__tests__/fixtures/sample.ts")).toBe("test");
    expect(classifyRole("src/fixtures/sample.ts")).toBe("fixture");
    expect(classifyRole("fixtures/x")).toBe("fixture");
  });

  it("recognizes barrel files (index.*)", () => {
    expect(classifyRole("packages/foo/src/index.ts")).toBe("barrel");
    expect(classifyRole("foo/index")).toBe("barrel");
    expect(classifyRole("foo/index.js")).toBe("barrel");
  });

  it("recognizes types files", () => {
    expect(classifyRole("src/types.ts")).toBe("types");
    expect(classifyRole("src/foo.types.ts")).toBe("types");
    expect(classifyRole("packages/foo/src/types")).toBe("types");
  });

  it("recognizes config files", () => {
    expect(classifyRole("vite.config.ts")).toBe("config");
    expect(classifyRole("packages/foo/tsup.config.ts")).toBe("config");
  });

  it("recognizes scripts/ and archive/ files as script role", () => {
    expect(classifyRole("scripts/regenerate.ts")).toBe("script");
    expect(classifyRole("packages/render/scripts/build.ts")).toBe("script");
    expect(classifyRole("archive/old-thing.ts")).toBe("script");
    expect(classifyRole("scripts/diagnostic/run.ts")).toBe("script");
  });

  it("does not treat a non-segment 'scripts' substring as script role", () => {
    expect(classifyRole("src/scripts-utils.ts")).toBe("source");
    expect(classifyRole("src/typescripts/foo.ts")).toBe("source");
  });

  it("test wins over script for a test file under scripts/", () => {
    expect(classifyRole("scripts/foo.test.ts")).toBe("test");
  });

  it("falls through to source for everything else", () => {
    expect(classifyRole("packages/cli/src/commands/graph-top.ts")).toBe("source");
    expect(classifyRole("packages/graph/src/database")).toBe("source");
  });

  it("test takes precedence over barrel/types/config", () => {
    expect(classifyRole("__tests__/index.test.ts")).toBe("test");
    expect(classifyRole("src/__tests__/types.test.ts")).toBe("test");
  });

  it("classifies a shebang-prefixed index file as entry, not barrel", () => {
    expect(classifyRole("packages/cli/src/index.ts", { hasShebang: true })).toBe(
      "entry",
    );
    // Without the shebang hint it stays a barrel (filename heuristic).
    expect(classifyRole("packages/cli/src/index.ts")).toBe("barrel");
  });

  it("shebang hint does not override test/fixture/script roles", () => {
    expect(classifyRole("scripts/build.ts", { hasShebang: true })).toBe("script");
    expect(classifyRole("src/foo.test.ts", { hasShebang: true })).toBe("test");
  });
});

describe("annotateRoles", () => {
  const nodes: GraphNode[] = [
    { id: "src/foo.ts", kind: "file", name: "foo" },
    { id: "src/__tests__/foo.test.ts", kind: "file", name: "foo.test" },
    { id: "src/index", kind: "module", name: "index" },
    { id: "npm:lodash", kind: "external", name: "lodash" },
    { id: "src/foo", kind: "module", name: "foo" },
  ];

  it("assigns roles to file and module nodes", () => {
    const out = annotateRoles(nodes);
    expect(out.find((n) => n.id === "src/foo.ts")?.role).toBe("source");
    expect(out.find((n) => n.id === "src/__tests__/foo.test.ts")?.role).toBe("test");
    expect(out.find((n) => n.id === "src/index")?.role).toBe("barrel");
    expect(out.find((n) => n.id === "src/foo")?.role).toBe("source");
  });

  it("leaves external nodes alone", () => {
    const out = annotateRoles(nodes);
    expect(out.find((n) => n.id === "npm:lodash")?.role).toBeUndefined();
  });

  it("preserves an explicit role if already set", () => {
    const explicit: GraphNode[] = [
      { id: "src/foo.ts", kind: "file", name: "foo", role: "config" },
    ];
    expect(annotateRoles(explicit)[0]!.role).toBe("config");
  });

  it("classifies a shebang index node as entry via shebangIds", () => {
    const entry: GraphNode[] = [
      { id: "packages/cli/src/index.ts", kind: "file", name: "index" },
    ];
    const out = annotateRoles(entry, {
      shebangIds: new Set(["packages/cli/src/index.ts"]),
    });
    expect(out[0]!.role).toBe("entry");
  });

  it("computeRoleHints flags shebang entries and generated files by heuristic", () => {
    const hints = computeRoleHints(
      [
        { filePath: "src/cli.ts", content: "#!/usr/bin/env node\n" },
        { filePath: "src/api.gen.ts", content: "export const x = 1;\n" },
        { filePath: "src/plain.ts", content: "export const y = 2;\n" },
      ],
      "/repo",
      identityId,
    );
    expect(hints.shebangIds?.has("src/cli.ts")).toBe(true);
    expect(hints.generatedIds?.has("src/api.gen.ts")).toBe(true);
    expect(hints.generatedIds?.has("src/plain.ts")).toBe(false);
  });

  it("classifies a generated node via generatedIds, winning over filename roles", () => {
    // `client.gen` would read as a barrel-ish name; generated must win (C-73).
    const gen: GraphNode[] = [
      { id: "src/client.gen.ts", kind: "file", name: "client.gen" },
      { id: "src/index.ts", kind: "file", name: "index" },
    ];
    const out = annotateRoles(gen, {
      generatedIds: new Set(["src/client.gen.ts"]),
    });
    expect(out.find((n) => n.id === "src/client.gen.ts")?.role).toBe("generated");
    expect(out.find((n) => n.id === "src/index.ts")?.role).toBe("barrel");
  });
});
