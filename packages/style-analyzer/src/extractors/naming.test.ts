import { describe, it, expect, beforeAll } from "vitest";
import { NamingExtractor } from "./naming.js";
import { parseFile } from "@titan-design/code-parser";
import type { ParsedFile } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixture(filename: string, language: string): Promise<ParsedFile> {
  const fixturePath = path.join(__dirname, "../../fixtures", filename);
  const content = fs.readFileSync(fixturePath, "utf-8");
  return parseFile(content, fixturePath, language);
}

describe("NamingExtractor", () => {
  const extractor = new NamingExtractor();

  describe("TypeScript", () => {
    let observations: ReturnType<NamingExtractor["extract"]>;

    beforeAll(async () => {
      const parsed = await loadFixture("naming-sample.ts", "typescript");
      observations = extractor.extract(parsed);
    });

    it("has name 'naming'", () => {
      expect(extractor.name).toBe("naming");
    });

    it("detects camelCase variables", () => {
      const vars = observations.filter(
        (o) => o.type === "naming.variable" && o.value === "camelCase",
      );
      expect(vars.length).toBeGreaterThanOrEqual(2);
    });

    it("detects SCREAMING_SNAKE constants", () => {
      const constants = observations.filter(
        (o) => o.type === "naming.constant" && o.value === "SCREAMING_SNAKE",
      );
      expect(constants.length).toBe(2);
    });

    it("detects camelCase functions", () => {
      const fns = observations.filter(
        (o) => o.type === "naming.function" && o.value === "camelCase",
      );
      expect(fns.length).toBeGreaterThanOrEqual(2);
    });

    it("detects PascalCase types", () => {
      const types = observations.filter(
        (o) => o.type === "naming.type" && o.value === "PascalCase",
      );
      expect(types.length).toBeGreaterThanOrEqual(2);
    });

    it("detects boolean prefixes", () => {
      const booleans = observations.filter(
        (o) => o.type === "naming.boolean",
      );
      expect(booleans.length).toBeGreaterThanOrEqual(3);
      booleans.forEach((b) => {
        expect(["is", "has", "should"]).toContain(b.value);
      });
    });

    it("detects PascalCase enum", () => {
      const enums = observations.filter(
        (o) => o.type === "naming.enum",
      );
      expect(enums.length).toBeGreaterThanOrEqual(1);
      expect(enums[0]!.value).toBe("PascalCase");
    });

    it("detects camelCase parameters", () => {
      const params = observations.filter(
        (o) => o.type === "naming.parameter" && o.value === "camelCase",
      );
      expect(params.length).toBeGreaterThanOrEqual(2);
    });

    it("detects private member prefix", () => {
      const priv = observations.filter(
        (o) => o.type === "naming.private-member",
      );
      expect(priv.length).toBeGreaterThanOrEqual(1);
      expect(priv[0]!.value).toBe("underscore-prefix");
    });

    it("sets correct category on all observations", () => {
      observations.forEach((o) => {
        expect(o.category).toBe("naming");
      });
    });
  });

  describe("Python", () => {
    let observations: ReturnType<NamingExtractor["extract"]>;

    beforeAll(async () => {
      const parsed = await loadFixture("naming-sample.py", "python");
      observations = extractor.extract(parsed);
    });

    it("detects snake_case variables", () => {
      const vars = observations.filter(
        (o) => o.type === "naming.variable" && o.value === "snake_case",
      );
      expect(vars.length).toBeGreaterThanOrEqual(2);
    });

    it("detects snake_case functions", () => {
      const fns = observations.filter(
        (o) => o.type === "naming.function" && o.value === "snake_case",
      );
      expect(fns.length).toBeGreaterThanOrEqual(2);
    });

    it("detects PascalCase classes", () => {
      const types = observations.filter(
        (o) => o.type === "naming.type" && o.value === "PascalCase",
      );
      expect(types.length).toBeGreaterThanOrEqual(1);
    });

    it("detects boolean prefixes in Python", () => {
      const booleans = observations.filter(
        (o) => o.type === "naming.boolean",
      );
      expect(booleans.length).toBeGreaterThanOrEqual(2);
    });
  });
});
