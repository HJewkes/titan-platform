import { describe, expect, it } from "vitest";
import { matchesGlob } from "./glob.js";

describe("matchesGlob", () => {
  it("lets ** cross directories and match none", () => {
    expect(matchesGlob("a/b/c.ts", "**/c.ts")).toBe(true);
    expect(matchesGlob("c.ts", "**/c.ts")).toBe(true);
    expect(matchesGlob("a/b/c.ts", "a/**")).toBe(true);
  });

  it("keeps * within one segment", () => {
    expect(matchesGlob("a/b/c.ts", "a/*.ts")).toBe(false);
    expect(matchesGlob("a/c.ts", "a/*.ts")).toBe(true);
  });

  it("treats dots literally", () => {
    expect(matchesGlob(".github/CODEOWNERS", ".github/CODEOWNERS")).toBe(true);
    expect(matchesGlob("xgithub/CODEOWNERS", ".github/CODEOWNERS")).toBe(false);
  });
});
