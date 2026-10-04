import { describe, expect, it } from "vitest";
import { namesTarget } from "./verdict-target.js";

const target = { repo: "owner/repo", pr: 7, head: "abc123" };

describe("namesTarget", () => {
  it("matches a block whose repo differs only in letter case", () => {
    expect(namesTarget({ repo: "Owner/Repo", pr: 7, head: "abc123" }, target)).toBe(true);
  });
  it("rejects a different PR number", () => {
    expect(namesTarget({ repo: "owner/repo", pr: 8, head: "abc123" }, target)).toBe(false);
  });
  it("rejects a different head", () => {
    expect(namesTarget({ repo: "owner/repo", pr: 7, head: "def456" }, target)).toBe(false);
  });
});
