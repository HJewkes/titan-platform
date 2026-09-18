import { describe, it, expect, beforeAll } from "vitest";
import { StructureExtractor } from "./structure.js";
import { parseFile } from "@titan-design/code-parser";
import type { ParsedFile } from "./types.js";
import type { Observation } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixture(
  filename: string,
  language: string,
): Promise<ParsedFile> {
  const fixturePath = path.join(__dirname, "../../fixtures", filename);
  const content = fs.readFileSync(fixturePath, "utf-8");
  return parseFile(content, fixturePath, language);
}

describe("StructureExtractor", () => {
  const extractor = new StructureExtractor();

  it("has name 'structure'", () => {
    expect(extractor.name).toBe("structure");
  });

  describe("TypeScript", () => {
    let observations: Observation[];

    beforeAll(async () => {
      const parsed = await loadFixture("structure-sample.ts", "typescript");
      observations = extractor.extract(parsed);
    });

    it("classifies builtin imports", () => {
      const builtin = observations.filter(
        (o) => o.type === "structure.import-group" && o.value === "builtin",
      );
      expect(builtin.length).toBe(2);
    });

    it("classifies external imports", () => {
      const external = observations.filter(
        (o) => o.type === "structure.import-group" && o.value === "external",
      );
      expect(external.length).toBe(2);
    });

    it("classifies internal (alias) imports", () => {
      const internal = observations.filter(
        (o) => o.type === "structure.import-group" && o.value === "internal",
      );
      expect(internal.length).toBe(2);
    });

    it("classifies relative imports", () => {
      const relative = observations.filter(
        (o) => o.type === "structure.import-group" && o.value === "relative",
      );
      expect(relative.length).toBe(2);
    });

    it("counts named exports", () => {
      const named = observations.filter(
        (o) => o.type === "structure.export-style" && o.value === "named",
      );
      expect(named.length).toBeGreaterThanOrEqual(3);
    });

    it("counts default exports", () => {
      const defaults = observations.filter(
        (o) => o.type === "structure.export-style" && o.value === "default",
      );
      expect(defaults.length).toBe(1);
    });

    it("detects export proximity (inline)", () => {
      const inline = observations.filter(
        (o) =>
          o.type === "structure.export-proximity" && o.value === "inline",
      );
      expect(inline.length).toBeGreaterThanOrEqual(3);
    });

    it("emits import-order observation with correct sequence", () => {
      const importOrder = observations.filter(
        (o) => o.type === "structure.import-order",
      );
      expect(importOrder.length).toBe(1);
      expect(JSON.parse(importOrder[0]!.value as string)).toEqual([
        "builtin",
        "external",
        "internal",
        "relative",
      ]);
      expect(importOrder[0]!.metadata?.groupCount).toBe(4);
    });

    it("sets correct category on all observations", () => {
      observations.forEach((o) => {
        expect(o.category).toBe("structure");
      });
    });
  });

  describe("Python", () => {
    let observations: Observation[];

    beforeAll(async () => {
      const parsed = await loadFixture("structure-sample.py", "python");
      observations = extractor.extract(parsed);
    });

    it("classifies builtin imports", () => {
      const builtin = observations.filter(
        (o) => o.type === "structure.import-group" && o.value === "builtin",
      );
      expect(builtin.length).toBeGreaterThanOrEqual(2);
    });

    it("classifies external imports", () => {
      const external = observations.filter(
        (o) => o.type === "structure.import-group" && o.value === "external",
      );
      expect(external.length).toBeGreaterThanOrEqual(1);
    });

    it("classifies relative imports", () => {
      const relative = observations.filter(
        (o) => o.type === "structure.import-group" && o.value === "relative",
      );
      expect(relative.length).toBe(2);
    });
  });
});
