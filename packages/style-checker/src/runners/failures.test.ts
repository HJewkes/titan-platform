import { describe, expect, it } from "vitest";
import { EXCERPT_MAX_CHARS, excerpt } from "./failures.js";

describe("excerpt", () => {
  it("returns text of exactly the maximum length unchanged", () => {
    const text = "a".repeat(EXCERPT_MAX_CHARS);
    expect(excerpt(text)).toBe(text);
  });

  it("truncates text one character over the maximum and appends an ellipsis", () => {
    expect(excerpt("a".repeat(EXCERPT_MAX_CHARS + 1))).toBe(`${"a".repeat(EXCERPT_MAX_CHARS)}…`);
  });

  it("trims surrounding whitespace before measuring", () => {
    expect(excerpt(`  ${"a".repeat(EXCERPT_MAX_CHARS)}\n`)).toBe("a".repeat(EXCERPT_MAX_CHARS));
  });
});
