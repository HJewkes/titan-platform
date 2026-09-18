import { describe, it, expect, beforeAll } from "vitest";
import { ErrorHandlingExtractor } from "./error-handling.js";
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

describe("ErrorHandlingExtractor", () => {
  const extractor = new ErrorHandlingExtractor();

  it("has name 'error-handling'", () => {
    expect(extractor.name).toBe("error-handling");
  });

  describe("TypeScript", () => {
    let observations: Observation[];

    beforeAll(async () => {
      const parsed = await loadFixture("error-handling-sample.ts", "typescript");
      observations = extractor.extract(parsed);
    });

    it("counts try/catch statements", () => {
      const tryCatch = observations.filter(
        (o) => o.type === "error-handling.try-catch",
      );
      // fetchUser, parseConfig, safeParse
      expect(tryCatch.length).toBe(3);
    });

    it("detects specific catch clauses (instanceof checks)", () => {
      const specific = observations.filter(
        (o) => o.type === "error-handling.catch-specificity" && o.value === "specific",
      );
      expect(specific.length).toBeGreaterThanOrEqual(1);
    });

    it("detects generic catch clauses", () => {
      const generic = observations.filter(
        (o) => o.type === "error-handling.catch-specificity" && o.value === "generic",
      );
      expect(generic.length).toBeGreaterThanOrEqual(1);
    });

    it("detects Result type usage", () => {
      const resultTypes = observations.filter(
        (o) => o.type === "error-handling.result-type",
      );
      expect(resultTypes.length).toBeGreaterThanOrEqual(1);
    });

    it("detects custom error classes", () => {
      const customErrors = observations.filter(
        (o) => o.type === "error-handling.custom-error-class",
      );
      // HttpError, ValidationError
      expect(customErrors.length).toBe(2);
    });

    it("detects assertNever pattern", () => {
      const assertNever = observations.filter(
        (o) => o.type === "error-handling.assert-never",
      );
      expect(assertNever.length).toBe(1);
    });

    it("detects exhaustive switch (switch with default calling assertNever)", () => {
      const exhaustive = observations.filter(
        (o) => o.type === "error-handling.exhaustive-switch" && o.value === true,
      );
      expect(exhaustive.length).toBe(1);
    });

    it("sets correct category on all observations", () => {
      observations.forEach((o) => {
        expect(o.category).toBe("error-handling");
      });
    });
  });

  describe("Python", () => {
    let observations: Observation[];

    beforeAll(async () => {
      const parsed = await loadFixture("error-handling-sample.py", "python");
      observations = extractor.extract(parsed);
    });

    it("counts try/except statements", () => {
      const tryCatch = observations.filter(
        (o) => o.type === "error-handling.try-catch",
      );
      expect(tryCatch.length).toBe(2);
    });

    it("detects specific except clauses", () => {
      const specific = observations.filter(
        (o) => o.type === "error-handling.catch-specificity" && o.value === "specific",
      );
      expect(specific.length).toBeGreaterThanOrEqual(1);
    });

    it("detects generic except clauses (bare Exception)", () => {
      const generic = observations.filter(
        (o) => o.type === "error-handling.catch-specificity" && o.value === "generic",
      );
      expect(generic.length).toBeGreaterThanOrEqual(1);
    });

    it("detects custom exception classes", () => {
      const customErrors = observations.filter(
        (o) => o.type === "error-handling.custom-error-class",
      );
      expect(customErrors.length).toBe(2);
    });
  });
});
