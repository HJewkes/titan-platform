import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  isGeneratedByHeuristic,
  isGeneratedFile,
  loadGeneratedPatterns,
  parseGeneratedPatterns,
} from "./generated.js";

describe("isGeneratedByHeuristic", () => {
  it("matches *.gen.* and *.generated.* basenames", () => {
    expect(isGeneratedByHeuristic("src/client.gen.ts")).toBe(true);
    expect(isGeneratedByHeuristic("api/schema.generated.ts")).toBe(true);
    expect(isGeneratedByHeuristic("api/schema.generated.d.ts")).toBe(true);
  });

  it("matches a generated/ path segment", () => {
    expect(isGeneratedByHeuristic("packages/api/generated/client.ts")).toBe(true);
  });

  it("rejects normal source and near-misses", () => {
    expect(isGeneratedByHeuristic("src/index.ts")).toBe(false);
    expect(isGeneratedByHeuristic("src/generator.ts")).toBe(false);
    expect(isGeneratedByHeuristic("src/regenerated/thing.ts")).toBe(false);
  });
});

describe("parseGeneratedPatterns", () => {
  it("honors linguist-generated (bare and =true)", () => {
    const patterns = parseGeneratedPatterns(
      [
        "# codegen",
        "src/client.ts linguist-generated",
        "openapi/*.ts linguist-generated=true",
        "docs/*.md linguist-documentation",
      ].join("\n"),
    );
    expect(isGeneratedFile("src/client.ts", patterns)).toBe(true);
    expect(isGeneratedFile("openapi/types.ts", patterns)).toBe(true);
    expect(isGeneratedFile("docs/readme.md", patterns)).toBe(false);
  });

  it("lets a later -linguist-generated / =false opt a path back out", () => {
    const patterns = parseGeneratedPatterns(
      "src/keep.ts linguist-generated -linguist-generated",
    );
    expect(patterns).toHaveLength(0);
  });

  it("matches a slash-free pattern at any depth", () => {
    const patterns = parseGeneratedPatterns("*.pb.ts linguist-generated");
    expect(isGeneratedFile("deep/nested/api.pb.ts", patterns)).toBe(true);
    expect(isGeneratedFile("api.pb.ts", patterns)).toBe(true);
  });

  it("anchors a leading-slash pattern to the repo root", () => {
    const patterns = parseGeneratedPatterns("/dist/x.js linguist-generated");
    expect(isGeneratedFile("dist/x.js", patterns)).toBe(true);
    expect(isGeneratedFile("pkg/dist/x.js", patterns)).toBe(false);
  });

  it("marks no file for a trailing-slash pattern, as git does", () => {
    const patterns = parseGeneratedPatterns("vendor/ linguist-generated");
    expect(isGeneratedFile("vendor", patterns)).toBe(false);
    expect(isGeneratedFile("vendor/x.js", patterns)).toBe(false);
    expect(isGeneratedFile("a/vendor/x.js", patterns)).toBe(false);
  });

  it("lets a leading **/ match a root-level file", () => {
    const patterns = parseGeneratedPatterns("**/x.ts linguist-generated");
    expect(isGeneratedFile("x.ts", patterns)).toBe(true);
    expect(isGeneratedFile("a/b/x.ts", patterns)).toBe(true);
  });

  it("lets an inner /**/ match zero directories", () => {
    const patterns = parseGeneratedPatterns("a/**/b.ts linguist-generated");
    expect(isGeneratedFile("a/b.ts", patterns)).toBe(true);
    expect(isGeneratedFile("a/x/y/b.ts", patterns)).toBe(true);
    expect(isGeneratedFile("c/a/b.ts", patterns)).toBe(false);
  });

  it("lets a later line's -linguist-generated override an earlier match", () => {
    const patterns = parseGeneratedPatterns(
      ["vendor/** linguist-generated", "vendor/ours/** -linguist-generated"].join("\n"),
    );
    expect(isGeneratedFile("vendor/lib/a.ts", patterns)).toBe(true);
    expect(isGeneratedFile("vendor/ours/a.ts", patterns)).toBe(false);
  });

  it("lets a later linguist-generated line re-mark an opted-out path", () => {
    const patterns = parseGeneratedPatterns(
      [
        "vendor/** -linguist-generated",
        "vendor/ours/** linguist-generated",
      ].join("\n"),
    );
    expect(isGeneratedFile("vendor/ours/a.ts", patterns)).toBe(true);
    expect(isGeneratedFile("vendor/lib/a.ts", patterns)).toBe(false);
  });
});

describe("isGeneratedFile", () => {
  it("unions gitattributes patterns with the heuristic fallback", () => {
    const patterns = parseGeneratedPatterns("vendor/lib.ts linguist-generated");
    expect(isGeneratedFile("vendor/lib.ts", patterns)).toBe(true); // gitattributes
    expect(isGeneratedFile("src/api.gen.ts", patterns)).toBe(true); // heuristic
    expect(isGeneratedFile("src/api.ts", patterns)).toBe(false); // neither
  });
});

describe("loadGeneratedPatterns", () => {
  const dirs: string[] = [];
  const makeRoot = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "generated-patterns-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns no patterns when .gitattributes is absent", () => {
    expect(loadGeneratedPatterns(makeRoot())).toEqual([]);
  });

  it("compiles the patterns of a readable .gitattributes", () => {
    const root = makeRoot();
    writeFileSync(path.join(root, ".gitattributes"), "vendor/lib.ts linguist-generated\n");
    expect(isGeneratedFile("vendor/lib.ts", loadGeneratedPatterns(root))).toBe(true);
  });

  it("surfaces an error when .gitattributes is unreadable (a directory)", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, ".gitattributes"));
    expect(() => loadGeneratedPatterns(root)).toThrow(/EISDIR/);
  });
});
