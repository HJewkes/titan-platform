import { describe, it, expect } from "vitest";
import { FormattingExtractor } from "./formatting.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, "../../fixtures", "formatting-configs");

describe("FormattingExtractor", () => {
  const extractor = new FormattingExtractor();

  it("has name 'formatting'", () => {
    expect(extractor.name).toBe("formatting");
  });

  describe("config file detection", () => {
    it("parses .prettierrc and emits observations for each setting", async () => {
      const observations = await extractor.extractFromConfig(
        path.resolve(CONFIGS, ".prettierrc"),
      );

      const semiObs = observations.find(
        (o) => o.type === "formatting.semicolons",
      );
      expect(semiObs).toBeDefined();
      expect(semiObs!.value).toBe(true);
      expect(semiObs!.metadata?.source).toBe("config");

      const quoteObs = observations.find(
        (o) => o.type === "formatting.quoteStyle",
      );
      expect(quoteObs).toBeDefined();
      expect(quoteObs!.value).toBe("single");

      const trailingObs = observations.find(
        (o) => o.type === "formatting.trailingCommas",
      );
      expect(trailingObs).toBeDefined();
      expect(trailingObs!.value).toBe(true);

      const indentSizeObs = observations.find(
        (o) => o.type === "formatting.indentSize",
      );
      expect(indentSizeObs).toBeDefined();
      expect(indentSizeObs!.value).toBe(2);
    });

    it("parses .editorconfig and emits observations", async () => {
      const observations = await extractor.extractFromConfig(
        path.resolve(CONFIGS, ".editorconfig"),
      );

      const indentObs = observations.find(
        (o) => o.type === "formatting.indentStyle",
      );
      expect(indentObs).toBeDefined();
      expect(indentObs!.value).toBe("space");
      expect(indentObs!.metadata?.source).toBe("config");

      const sizeObs = observations.find(
        (o) => o.type === "formatting.indentSize",
      );
      expect(sizeObs).toBeDefined();
      expect(sizeObs!.value).toBe(2);
    });

    it("returns empty array when no config file exists", async () => {
      const observations = await extractor.extractFromConfig(
        "/nonexistent/.prettierrc",
      );
      expect(observations).toEqual([]);
    });
  });

  describe("frequency analysis on source code", () => {
    it("detects semicolon usage by frequency", () => {
      const source = [
        'const a = 1;',
        'const b = 2;',
        'function foo() {',
        '  return a + b;',
        '}',
      ].join("\n");
      const observations = extractor.extractFromSource(source, "test.ts");

      const semiObs = observations.find(
        (o) => o.type === "formatting.semicolons",
      );
      expect(semiObs).toBeDefined();
      expect(semiObs!.value).toBe(true);
    });

    it("detects no-semicolon usage by frequency", () => {
      const source = [
        'const a = 1',
        'const b = 2',
        'function foo() {',
        '  return a + b',
        '}',
      ].join("\n");
      const observations = extractor.extractFromSource(source, "test.ts");

      const semiObs = observations.find(
        (o) => o.type === "formatting.semicolons",
      );
      expect(semiObs).toBeDefined();
      expect(semiObs!.value).toBe(false);
    });

    it("detects single-quote preference", () => {
      const source = "const name = 'hello';\nconst greeting = 'world';\nconst template = `hello ${name}`;";
      const observations = extractor.extractFromSource(source, "test.ts");

      const quoteObs = observations.find(
        (o) => o.type === "formatting.quoteStyle",
      );
      expect(quoteObs).toBeDefined();
      expect(quoteObs!.value).toBe("single");
    });

    it("detects double-quote preference", () => {
      const source = 'const name = "hello";\nconst greeting = "world";\nconst template = `hello ${name}`;';
      const observations = extractor.extractFromSource(source, "test.ts");

      const quoteObs = observations.find(
        (o) => o.type === "formatting.quoteStyle",
      );
      expect(quoteObs).toBeDefined();
      expect(quoteObs!.value).toBe("double");
    });

    it("detects trailing comma usage", () => {
      const source = [
        'const obj = {',
        '  a: 1,',
        '  b: 2,',
        '};',
      ].join("\n");
      const observations = extractor.extractFromSource(source, "test.ts");

      const trailingObs = observations.find(
        (o) => o.type === "formatting.trailingCommas",
      );
      expect(trailingObs).toBeDefined();
      expect(trailingObs!.value).toBe(true);
    });

    it("detects no trailing commas", () => {
      const source = [
        'const obj = {',
        '  a: 1,',
        '  b: 2',
        '};',
      ].join("\n");
      const observations = extractor.extractFromSource(source, "test.ts");

      const trailingObs = observations.find(
        (o) => o.type === "formatting.trailingCommas",
      );
      expect(trailingObs).toBeDefined();
      expect(trailingObs!.value).toBe(false);
    });

    it("detects 1TBS brace style", () => {
      const source = [
        'function foo() {',
        '  if (true) {',
        '    return 1;',
        '  } else {',
        '    return 2;',
        '  }',
        '}',
      ].join("\n");
      const observations = extractor.extractFromSource(source, "test.ts");

      const braceObs = observations.find(
        (o) => o.type === "formatting.braceStyle",
      );
      expect(braceObs).toBeDefined();
      expect(braceObs!.value).toBe("1tbs");
    });

    it("detects Allman brace style", () => {
      const source = [
        'function foo()',
        '{',
        '  if (true)',
        '  {',
        '    return 1;',
        '  }',
        '  else',
        '  {',
        '    return 2;',
        '  }',
        '}',
      ].join("\n");
      const observations = extractor.extractFromSource(source, "test.ts");

      const braceObs = observations.find(
        (o) => o.type === "formatting.braceStyle",
      );
      expect(braceObs).toBeDefined();
      expect(braceObs!.value).toBe("allman");
    });

    it("detects space indentation with size", () => {
      const source = [
        'function foo() {',
        '  if (true) {',
        '    return 1;',
        '  }',
        '}',
      ].join("\n");
      const observations = extractor.extractFromSource(source, "test.ts");

      const styleObs = observations.find(
        (o) => o.type === "formatting.indentStyle",
      );
      expect(styleObs).toBeDefined();
      expect(styleObs!.value).toBe("space");

      const sizeObs = observations.find(
        (o) => o.type === "formatting.indentSize",
      );
      expect(sizeObs).toBeDefined();
      expect(sizeObs!.value).toBe(2);
    });

    it("detects tab indentation", () => {
      const source = [
        'function foo() {',
        '\tif (true) {',
        '\t\treturn 1;',
        '\t}',
        '}',
      ].join("\n");
      const observations = extractor.extractFromSource(source, "test.ts");

      const styleObs = observations.find(
        (o) => o.type === "formatting.indentStyle",
      );
      expect(styleObs).toBeDefined();
      expect(styleObs!.value).toBe("tab");
    });

    it("excludes template literals from quote style detection", () => {
      const source = "const name = 'hello';\nconst greeting = 'world';\nconst template = `hello ${name}`;";
      const observations = extractor.extractFromSource(source, "test.ts");

      const quoteObs = observations.filter(
        (o) => o.type === "formatting.quoteStyle",
      );
      const backticks = quoteObs.filter((o) => o.value === "backtick");
      expect(backticks).toHaveLength(0);
    });
  });

  describe("extract() with ParsedFile", () => {
    it("produces formatting observations from parsed file content", async () => {
      const { parseFile } = await import("@titan-design/code-parser");
      const fs = await import("node:fs");
      const fixturePath = path.join(__dirname, "../../fixtures", "formatting-sample.ts");
      const content = fs.readFileSync(fixturePath, "utf-8");
      const parsed = await parseFile(content, fixturePath, "typescript");

      const observations = extractor.extract(parsed);
      expect(observations.length).toBeGreaterThan(0);
      observations.forEach((o) => {
        expect(o.category).toBe("formatting");
      });
    });
  });
});
