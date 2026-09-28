import { describe, it, expect } from "vitest";
import {
  isGeneratedByHeuristic,
  isGeneratedFile,
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
});

describe("isGeneratedFile", () => {
  it("unions gitattributes patterns with the heuristic fallback", () => {
    const patterns = parseGeneratedPatterns("vendor/lib.ts linguist-generated");
    expect(isGeneratedFile("vendor/lib.ts", patterns)).toBe(true); // gitattributes
    expect(isGeneratedFile("src/api.gen.ts", patterns)).toBe(true); // heuristic
    expect(isGeneratedFile("src/api.ts", patterns)).toBe(false); // neither
  });
});
