import { describe, it, expect, beforeAll } from "vitest";
import { ComplexityExtractor } from "./complexity.js";
import { parseFile } from "@titan-design/code-parser";
import type { ParsedFile, Observation } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadFixture(filename: string, language: string): Promise<ParsedFile> {
  const fixturePath = path.join(__dirname, "../../fixtures", filename);
  const content = fs.readFileSync(fixturePath, "utf-8");
  return parseFile(content, fixturePath, language);
}

describe("ComplexityExtractor", () => {
  const extractor = new ComplexityExtractor();

  it("has name 'complexity'", () => {
    expect(extractor.name).toBe("complexity");
  });

  describe("TypeScript", () => {
    let observations: Observation[];

    beforeAll(async () => {
      const parsed = await loadFixture("complexity-sample.ts", "typescript");
      observations = extractor.extract(parsed);
    });

    it("sets correct category on all observations", () => {
      observations.forEach((o) => {
        expect(o.category).toBe("complexity");
      });
    });

    describe("function length (statement count)", () => {
      it("counts statements in a short function", () => {
        const lengthObs = observations.filter(
          (o) =>
            o.type === "complexity.functionLength" &&
            o.metadata?.functionName === "add",
        );
        expect(lengthObs).toHaveLength(1);
        expect(lengthObs[0]!.value).toBe(1);
      });

      it("counts statements in a longer function", () => {
        const lengthObs = observations.filter(
          (o) =>
            o.type === "complexity.functionLength" &&
            o.metadata?.functionName === "processData",
        );
        expect(lengthObs).toHaveLength(1);
        expect(lengthObs[0]!.value as number).toBeGreaterThanOrEqual(5);
      });
    });

    describe("nesting depth", () => {
      it("detects shallow nesting in simple function", () => {
        const depthObs = observations.filter(
          (o) =>
            o.type === "complexity.nestingDepth" &&
            o.metadata?.functionName === "add",
        );
        expect(depthObs).toHaveLength(1);
        expect(depthObs[0]!.value).toBe(0);
      });

      it("detects deep nesting", () => {
        const depthObs = observations.filter(
          (o) =>
            o.type === "complexity.nestingDepth" &&
            o.metadata?.functionName === "deeplyNested",
        );
        expect(depthObs).toHaveLength(1);
        expect(depthObs[0]!.value as number).toBeGreaterThanOrEqual(4);
      });
    });

    describe("cyclomatic complexity", () => {
      it("reports complexity of 1 for branchless functions", () => {
        const complexityObs = observations.filter(
          (o) =>
            o.type === "complexity.cyclomatic" &&
            o.metadata?.functionName === "add",
        );
        expect(complexityObs).toHaveLength(1);
        expect(complexityObs[0]!.value).toBe(1);
      });

      it("counts branches in functions with conditionals", () => {
        const classifyObs = observations.filter(
          (o) =>
            o.type === "complexity.cyclomatic" &&
            o.metadata?.functionName === "classify",
        );
        expect(classifyObs).toHaveLength(1);
        expect(classifyObs[0]!.value as number).toBeGreaterThanOrEqual(5);
      });
    });

    describe("file-level metrics", () => {
      it("emits file length observation", () => {
        const fileObs = observations.filter(
          (o) => o.type === "complexity.fileLength",
        );
        expect(fileObs).toHaveLength(1);
        expect(fileObs[0]!.value as number).toBeGreaterThan(0);
      });
    });

    describe("multiple functions", () => {
      it("produces observations for all functions", () => {
        const functionNames = [
          ...new Set(
            observations
              .filter((o) => o.metadata?.functionName)
              .map((o) => o.metadata!.functionName),
          ),
        ];
        expect(functionNames).toContain("add");
        expect(functionNames).toContain("processData");
        expect(functionNames).toContain("deeplyNested");
        expect(functionNames).toContain("classify");
      });

      it("includes file path and line numbers", () => {
        for (const obs of observations) {
          expect(obs.file).toBeTruthy();
          if (obs.type !== "complexity.fileLength") {
            expect(obs.line).toBeGreaterThan(0);
          }
        }
      });
    });
  });

  describe("Python", () => {
    let observations: Observation[];

    beforeAll(async () => {
      const parsed = await loadFixture("complexity-sample.py", "python");
      observations = extractor.extract(parsed);
    });

    it("detects functions in Python", () => {
      const functionNames = [
        ...new Set(
          observations
            .filter((o) => o.metadata?.functionName)
            .map((o) => o.metadata!.functionName),
        ),
      ];
      expect(functionNames).toContain("add");
      expect(functionNames).toContain("process_data");
      expect(functionNames).toContain("deeply_nested");
    });

    it("counts statements in Python functions", () => {
      const addLength = observations.find(
        (o) =>
          o.type === "complexity.functionLength" &&
          o.metadata?.functionName === "add",
      );
      expect(addLength).toBeDefined();
      expect(addLength!.value).toBe(1);
    });

    it("detects nesting depth in Python", () => {
      const depthObs = observations.find(
        (o) =>
          o.type === "complexity.nestingDepth" &&
          o.metadata?.functionName === "deeply_nested",
      );
      expect(depthObs).toBeDefined();
      expect(depthObs!.value as number).toBeGreaterThanOrEqual(4);
    });
  });
});
