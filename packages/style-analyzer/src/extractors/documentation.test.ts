import { describe, it, expect, beforeAll } from "vitest";
import { DocumentationExtractor } from "./documentation.js";
import { parseFile } from "@titan-design/code-parser";
import type { ParsedFile } from "./types.js";
import type { Observation } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixture(filename: string, language: string): Promise<ParsedFile> {
  const fixturePath = path.join(__dirname, "../../fixtures", filename);
  const content = fs.readFileSync(fixturePath, "utf-8");
  return parseFile(content, fixturePath, language);
}

describe("DocumentationExtractor", () => {
  const extractor = new DocumentationExtractor();

  it("has name 'documentation'", () => {
    expect(extractor.name).toBe("documentation");
  });

  describe("TypeScript", () => {
    let observations: Observation[];

    beforeAll(async () => {
      const parsed = await loadFixture("documentation-sample.ts", "typescript");
      observations = extractor.extract(parsed);
    });

    it("detects JSDoc presence on exported functions", () => {
      const jsdocPresent = observations.filter(
        (o) => o.type === "documentation.jsdoc-presence" && o.value === true,
      );
      // fetchUserProfile and validateEmail have JSDoc
      expect(jsdocPresent.length).toBeGreaterThanOrEqual(2);
    });

    it("detects missing docs on exported functions", () => {
      const jsdocMissing = observations.filter(
        (o) => o.type === "documentation.jsdoc-presence" && o.value === false,
      );
      // undocumentedPublicFunction has no JSDoc
      expect(jsdocMissing.length).toBeGreaterThanOrEqual(1);
    });

    it("distinguishes public vs private doc coverage", () => {
      const publicDocs = observations.filter(
        (o) => o.type === "documentation.public-coverage",
      );
      const privateDocs = observations.filter(
        (o) => o.type === "documentation.private-coverage",
      );
      expect(publicDocs.length).toBeGreaterThan(0);
      expect(privateDocs.length).toBeGreaterThan(0);
    });

    it("detects inline comments", () => {
      const inline = observations.filter(
        (o) => o.type === "documentation.inline-comment",
      );
      expect(inline.length).toBeGreaterThanOrEqual(2);
    });

    it("detects leading vs trailing comment placement", () => {
      const leading = observations.filter(
        (o) => o.type === "documentation.comment-placement" && o.value === "leading",
      );
      const trailing = observations.filter(
        (o) => o.type === "documentation.comment-placement" && o.value === "trailing",
      );
      expect(leading.length).toBeGreaterThan(0);
      expect(trailing.length).toBeGreaterThan(0);
    });

    it("detects JSDoc tags", () => {
      const tags = observations.filter(
        (o) => o.type === "documentation.jsdoc-tag",
      );
      const tagValues = tags.map((t) => t.value);
      expect(tagValues).toContain("@param");
      expect(tagValues).toContain("@returns");
      expect(tagValues).toContain("@throws");
    });

    it("sets correct category on all observations", () => {
      observations.forEach((o) => {
        expect(o.category).toBe("documentation");
      });
    });
  });

  describe("Python", () => {
    let observations: Observation[];

    beforeAll(async () => {
      const parsed = await loadFixture("documentation-sample.py", "python");
      observations = extractor.extract(parsed);
    });

    it("detects docstring presence on functions", () => {
      const docPresent = observations.filter(
        (o) => o.type === "documentation.jsdoc-presence" && o.value === true,
      );
      // fetch_user_profile and validate_email have docstrings
      expect(docPresent.length).toBeGreaterThanOrEqual(2);
    });

    it("detects missing docstrings", () => {
      const docMissing = observations.filter(
        (o) => o.type === "documentation.jsdoc-presence" && o.value === false,
      );
      expect(docMissing.length).toBeGreaterThanOrEqual(1);
    });

    it("detects docstring tags (Args, Returns, Raises)", () => {
      const tags = observations.filter(
        (o) => o.type === "documentation.jsdoc-tag",
      );
      const tagValues = tags.map((t) => t.value);
      expect(tagValues).toContain("Args");
      expect(tagValues).toContain("Returns");
      expect(tagValues).toContain("Raises");
    });
  });
});
