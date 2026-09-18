import { describe, it, expect } from "vitest";
import { getLanguageFromPath, getSupportedLanguages, parseFile, shouldIncludeFile } from "./index.js";

// Documents a known defect carried over unchanged from @codewatch/core: fixing it is a behaviour change.
describe("a .js file under the current filter and parser", () => {
  it("passes the filter as javascript but has no grammar, so parsing it throws", async () => {
    const path = "src/legacy.js";

    const language = getLanguageFromPath(path);

    expect(shouldIncludeFile(path, ["javascript"])).toBe(true);
    expect(language).toBe("javascript");
    expect(getSupportedLanguages()).not.toContain("javascript");
    await expect(parseFile("const a = 1;", path, language ?? "")).rejects.toThrow(
      "Unsupported language: javascript",
    );
  });
});
