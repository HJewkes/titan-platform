import { describe, it, expect } from "vitest";
import { parseFile, getSupportedLanguages } from "./parser.js";

describe("parseFile", () => {
  it("parses TypeScript source code", async () => {
    const result = await parseFile(
      'const userName = "test";',
      "test.ts",
      "typescript",
    );

    expect(result.tree.rootNode.type).toBe("program");
    expect(result.filePath).toBe("test.ts");
    expect(result.language).toBe("typescript");
  });

  it("parses Python source code", async () => {
    const result = await parseFile(
      'user_name = "test"',
      "test.py",
      "python",
    );

    expect(result.tree.rootNode.type).toBe("module");
    expect(result.language).toBe("python");
  });

  it("parses TSX source code with the tsx grammar", async () => {
    const result = await parseFile("const el = <div />;", "App.tsx", "tsx");

    expect(result.tree.rootNode.type).toBe("program");
    expect(result.tree.rootNode.hasError).toBe(false);
  });

  it("throws for unsupported language", async () => {
    await expect(parseFile("code", "test.rb", "ruby")).rejects.toThrow(
      "Unsupported language: ruby",
    );
  });
});

describe("getSupportedLanguages", () => {
  it("returns typescript and python", () => {
    const languages = getSupportedLanguages();
    expect(languages).toContain("typescript");
    expect(languages).toContain("python");
  });
});
