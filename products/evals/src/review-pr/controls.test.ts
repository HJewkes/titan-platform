import { describe, expect, it } from "vitest";
import { plantDefect } from "./controls.js";

const SOURCE = ["export function clamp(value: number, max: number): number {", "  if (value > max) {", "    return max;", "  }", "  return value;", "}", ""].join("\n");
const TEST = [
  'import { clamp } from "./clamp.js";',
  "",
  'it("clamps above the max", () => {',
  "  const result = clamp(9, 5);",
  "  expect(result).toBe(5);",
  "});",
  "",
].join("\n");

const linesOf = (text: string) => text.split("\n");
/** The head's lines with line `index` (0-based) replaced, or removed when `line` is null. */
const editAt = (text: string, index: number, line: string | null) => {
  const lines = linesOf(text);
  lines.splice(index, 1, ...(line === null ? [] : [line]));
  return lines;
};

describe("plantDefect", () => {
  it("deletes exactly the recorded assertion line of a test file", () => {
    const planted = plantDefect("deleted-assertion", "src/clamp.test.ts", TEST);

    expect(planted?.line).toBe(5);
    expect(linesOf(TEST)[4]).toBe("  expect(result).toBe(5);");
    expect(linesOf(planted?.text ?? "")).toEqual(editAt(TEST, 4, null));
  });

  it("inverts the condition at exactly the recorded line of a source file", () => {
    const planted = plantDefect("inverted-condition", "src/clamp.ts", SOURCE);

    expect(planted?.line).toBe(2);
    expect(linesOf(planted?.text ?? "")).toEqual(editAt(SOURCE, 1, "  if (!(value > max)) {"));
  });

  it("defangs the assertion at exactly the recorded line so the test no longer bites", () => {
    const planted = plantDefect("toothless-test", "src/clamp.test.ts", TEST);

    expect(planted?.line).toBe(5);
    expect(linesOf(planted?.text ?? "")).toEqual(editAt(TEST, 4, "  expect(result).toBeDefined();"));
  });

  it("skips an assertion that already only checks definedness and defangs the next one", () => {
    const head = editAt(TEST, 4, "  expect(result).toBeDefined()");
    head.splice(5, 0, "  expect(result).toBe(5);");
    const text = head.join("\n");

    const planted = plantDefect("toothless-test", "src/clamp.test.ts", text);

    expect(planted?.line).toBe(6);
    expect(linesOf(planted?.text ?? "")).toEqual(editAt(text, 5, "  expect(result).toBeDefined();"));
  });

  it("plants no toothless test when every assertion already only checks definedness", () => {
    const text = editAt(TEST, 4, "  expect(result).toBeDefined();").join("\n");

    expect(plantDefect("toothless-test", "src/clamp.test.ts", text)).toBeUndefined();
  });

  it("plants nothing where the file cannot carry the kind", () => {
    expect(plantDefect("inverted-condition", "src/clamp.test.ts", TEST)).toBeUndefined();
    expect(plantDefect("deleted-assertion", "src/clamp.ts", SOURCE)).toBeUndefined();
    expect(plantDefect("toothless-test", "README.md", "expect(a).toBe(b);\n")).toBeUndefined();
    expect(plantDefect("inverted-condition", "src/plain.ts", "export const one = 1;\n")).toBeUndefined();
  });
});
