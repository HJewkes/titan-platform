import { describe, it, expect, beforeAll } from "vitest";
import { ControlFlowExtractor } from "./control-flow.js";
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

describe("ControlFlowExtractor", () => {
  const extractor = new ControlFlowExtractor();

  it("has name 'control-flow'", () => {
    expect(extractor.name).toBe("control-flow");
  });

  describe("TypeScript", () => {
    let observations: Observation[];

    beforeAll(async () => {
      const parsed = await loadFixture(
        "control-flow-sample.ts",
        "typescript",
      );
      observations = extractor.extract(parsed);
    });

    it("detects guard clauses (early returns at top of function)", () => {
      const guards = observations.filter(
        (o) => o.type === "control-flow.guard-clause" && o.value === true,
      );
      expect(guards.length).toBeGreaterThanOrEqual(2);
    });

    it("detects else-after-return", () => {
      const elseAfterReturn = observations.filter(
        (o) => o.type === "control-flow.else-after-return",
      );
      expect(elseAfterReturn.length).toBeGreaterThanOrEqual(1);
    });

    it("counts ternary expressions", () => {
      const ternaries = observations.filter(
        (o) => o.type === "control-flow.ternary",
      );
      expect(ternaries.length).toBe(2);
    });

    it("counts if/else statements", () => {
      const ifElse = observations.filter(
        (o) => o.type === "control-flow.if-else",
      );
      expect(ifElse.length).toBeGreaterThanOrEqual(2);
    });

    it("counts array method calls", () => {
      const arrayMethods = observations.filter(
        (o) => o.type === "control-flow.array-method",
      );
      expect(arrayMethods.length).toBe(3);
    });

    it("counts indexed for loops", () => {
      const forLoops = observations.filter(
        (o) => o.type === "control-flow.for-loop",
      );
      expect(forLoops.length).toBeGreaterThanOrEqual(1);
    });

    it("counts for-of loops", () => {
      const forOf = observations.filter(
        (o) => o.type === "control-flow.for-of",
      );
      expect(forOf.length).toBe(1);
    });

    it("counts await expressions", () => {
      const awaits = observations.filter(
        (o) => o.type === "control-flow.async-await",
      );
      expect(awaits.length).toBe(2);
    });

    it("counts .then() chains", () => {
      const thens = observations.filter(
        (o) => o.type === "control-flow.promise-then",
      );
      expect(thens.length).toBeGreaterThanOrEqual(1);
    });

    it("sets correct category on all observations", () => {
      observations.forEach((o) => {
        expect(o.category).toBe("control-flow");
      });
    });
  });

  describe("Python", () => {
    let observations: Observation[];

    beforeAll(async () => {
      const parsed = await loadFixture("control-flow-sample.py", "python");
      observations = extractor.extract(parsed);
    });

    it("detects guard clauses", () => {
      const guards = observations.filter(
        (o) => o.type === "control-flow.guard-clause" && o.value === true,
      );
      expect(guards.length).toBeGreaterThanOrEqual(2);
    });

    it("counts conditional expressions (ternary)", () => {
      const ternaries = observations.filter(
        (o) => o.type === "control-flow.ternary",
      );
      expect(ternaries.length).toBe(2);
    });

    it("detects list comprehensions as array-method equivalent", () => {
      const comps = observations.filter(
        (o) => o.type === "control-flow.array-method",
      );
      expect(comps.length).toBeGreaterThanOrEqual(2);
    });

    it("counts for loops", () => {
      const forLoops = observations.filter(
        (o) => o.type === "control-flow.for-loop",
      );
      expect(forLoops.length).toBeGreaterThanOrEqual(1);
    });
  });
});
