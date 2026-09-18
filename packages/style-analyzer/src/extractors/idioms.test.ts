import { describe, it, expect } from "vitest";
import { IdiomsExtractor } from "./idioms.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const FIXTURES = resolve(__dirname, "../../fixtures");

describe("IdiomsExtractor", () => {
  const extractor = new IdiomsExtractor();

  describe("clone detection within a single file", () => {
    it("detects repeated structural patterns across functions", async () => {
      const source = await readFile(
        resolve(FIXTURES, "idiom-sample-a.ts"),
        "utf-8",
      );

      const observations = await extractor.extractFromSources([
        {
          content: source,
          path: "idiom-sample-a.ts",
          language: "typescript",
        },
      ]);

      const idiomObs = observations.filter((o) => o.type === "idiom.clone");

      expect(idiomObs.length).toBeGreaterThan(0);
      for (const obs of idiomObs) {
        expect(obs.value).toBeDefined();
        expect(
          (obs.metadata?.frequency as number),
        ).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe("clone detection across multiple files", () => {
    it("detects idioms repeated across different files", async () => {
      const fileA = await readFile(
        resolve(FIXTURES, "idiom-sample-a.ts"),
        "utf-8",
      );
      const fileB = await readFile(
        resolve(FIXTURES, "idiom-sample-b.ts"),
        "utf-8",
      );

      const observations = await extractor.extractFromSources([
        { content: fileA, path: "file-a.ts", language: "typescript" },
        { content: fileB, path: "file-b.ts", language: "typescript" },
      ]);

      const idiomObs = observations.filter((o) => o.type === "idiom.clone");

      expect(idiomObs.length).toBeGreaterThan(0);
    });
  });

  describe("no clones", () => {
    it("returns no clones for unique functions", async () => {
      const source = `function add(a: number, b: number): number {
  return a + b;
}

function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

function isEven(n: number): boolean {
  return n % 2 === 0;
}`;

      const observations = await extractor.extractFromSources([
        { content: source, path: "no-clones.ts", language: "typescript" },
      ]);

      const idiomObs = observations.filter((o) => o.type === "idiom.clone");
      expect(idiomObs).toHaveLength(0);
    });
  });

  describe("observation format", () => {
    it("includes clone fragment text in metadata", async () => {
      const source = await readFile(
        resolve(FIXTURES, "idiom-sample-a.ts"),
        "utf-8",
      );

      const observations = await extractor.extractFromSources([
        {
          content: source,
          path: "idiom-sample-a.ts",
          language: "typescript",
        },
      ]);

      const idiomObs = observations.filter((o) => o.type === "idiom.clone");

      expect(idiomObs.length).toBeGreaterThan(0);
      expect(idiomObs[0]!.metadata?.fragment).toBeDefined();
      expect(typeof idiomObs[0]!.metadata?.fragment).toBe("string");
    });

    it("includes location information for each clone instance", async () => {
      const source = await readFile(
        resolve(FIXTURES, "idiom-sample-a.ts"),
        "utf-8",
      );

      const observations = await extractor.extractFromSources([
        {
          content: source,
          path: "idiom-sample-a.ts",
          language: "typescript",
        },
      ]);

      const idiomObs = observations.filter((o) => o.type === "idiom.clone");

      expect(idiomObs.length).toBeGreaterThan(0);
      expect(idiomObs[0]!.metadata?.locations).toBeDefined();
      expect(Array.isArray(idiomObs[0]!.metadata?.locations)).toBe(true);
    });
  });

  describe("Extractor interface", () => {
    it("has correct name", () => {
      expect(extractor.name).toBe("idioms");
    });

    it("implements extract()", () => {
      expect(typeof extractor.extract).toBe("function");
    });
  });
});
