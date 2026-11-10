import { describe, expect, it } from "vitest";
import { truncateOutput, type TruncateResult } from "./truncation.js";

const bytes = (text: string) => Buffer.byteLength(text, "utf-8");
const numbered = (count: number, label: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => label(i)).join("\n");
const OMITTED = /\n--- \d+ lines omitted ---\n/;

function splitAtMarker(result: TruncateResult): [string[], string[]] {
  const parts = result.text.split(OMITTED);
  expect(parts).toHaveLength(2);
  return [parts[0]!.split("\n"), parts[1]!.split("\n")];
}

function expectWithinBudget(result: TruncateResult, maxBytes: number): void {
  expect(bytes(result.text)).toBeLessThanOrEqual(maxBytes);
  expect(result.omittedLines).toBeGreaterThanOrEqual(0);
  expect(result.omittedLines).toBeLessThanOrEqual(result.originalLines);
}

describe("truncateOutput under budget", () => {
  it("returns short input unchanged", () => {
    expect(truncateOutput("short text", { maxBytes: 1000 })).toEqual({
      text: "short text",
      truncated: false,
      originalLines: 1,
      omittedLines: 0,
    });
  });

  it("returns an empty string unchanged as one line", () => {
    expect(truncateOutput("", { maxBytes: 100 })).toEqual({
      text: "",
      truncated: false,
      originalLines: 1,
      omittedLines: 0,
    });
  });

  it("returns a single line unchanged when it fits", () => {
    const result = truncateOutput("just one line", { maxBytes: 1000 });
    expect(result.text).toBe("just one line");
    expect(result.truncated).toBe(false);
  });

  it("reports the original line count of a truncated input", () => {
    const result = truncateOutput(numbered(42, (i) => `line ${i}`), { maxBytes: 100 });
    expect(result.originalLines).toBe(42);
  });
});

describe("truncateOutput by whole lines", () => {
  it("inserts the omission marker and stays within the budget", () => {
    const result = truncateOutput(numbered(100, (i) => `line ${i + 1}`), { maxBytes: 300 });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("lines omitted");
    expect(result.originalLines).toBe(100);
    expect(result.omittedLines).toBeGreaterThan(0);
    expect(bytes(result.text)).toBeLessThanOrEqual(300);
  });

  it("keeps more head lines than tail lines at the default ratio", () => {
    const [head, tail] = splitAtMarker(truncateOutput(numbered(100, (i) => `L${i}`), { maxBytes: 200 }));
    expect(head.length).toBeGreaterThan(tail.length);
    expect(head[0]).toBe("L0");
    expect(tail[tail.length - 1]).toBe("L99");
  });

  it("names the omitted line count in the marker", () => {
    const result = truncateOutput(numbered(50, (i) => `line ${i}`), { maxBytes: 200 });
    const match = /--- (\d+) lines omitted ---/.exec(result.text);
    expect(Number(match?.[1])).toBe(result.omittedLines);
    const [head, tail] = splitAtMarker(result);
    expect(head.length + tail.length + result.omittedLines).toBe(50);
  });

  it("splits kept lines evenly at a 0.5 head ratio", () => {
    const result = truncateOutput(numbered(100, (i) => `L${i}`), { maxBytes: 200, headRatio: 0.5 });
    const [head, tail] = splitAtMarker(result);
    expect(Math.abs(head.length - tail.length)).toBeLessThanOrEqual(1);
  });

  it("uses a custom separator instead of the default marker", () => {
    const result = truncateOutput(numbered(50, (i) => `line ${i}`), { maxBytes: 200, separator: "\n[...]\n" });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[...]");
    expect(result.text).not.toContain("lines omitted");
  });

  it("counts multi-byte characters as bytes, not code units", () => {
    const input = numbered(20, (i) => `\u{1F600} line ${i}`);
    const cap = Math.floor(bytes(input) * 0.5);
    const result = truncateOutput(input, { maxBytes: cap });
    expect(result.truncated).toBe(true);
    expect(bytes(result.text)).toBeLessThanOrEqual(cap);
  });

  it("keeps the first and last line under a very small budget", () => {
    const result = truncateOutput(numbered(10, (i) => `line ${i}`), { maxBytes: 40 });
    expect(result.text).toBe("line 0\n--- 8 lines omitted ---\nline 9");
    expect(result.omittedLines).toBe(8);
  });

  it("writes the singular marker when exactly one line is omitted", () => {
    const result = truncateOutput(`head\n${"x".repeat(100)}\ntail`, { maxBytes: 40 });
    expect(result.text).toBe("head\n--- 1 line omitted ---\ntail");
    expect(result.omittedLines).toBe(1);
  });

  it("never exceeds the budget on wide rows", () => {
    const input = numbered(200, (i) => `data row ${i}: ${"x".repeat(50)}`);
    const result = truncateOutput(input, { maxBytes: 2000 });
    expect(result.truncated).toBe(true);
    expect(bytes(result.text)).toBeLessThanOrEqual(2000);
  });
});

describe("truncateOutput character fallback", () => {
  it("cuts a single over-budget line within the budget without repeating it", () => {
    const line = "y".repeat(500);
    const result = truncateOutput(line, { maxBytes: 100 });
    expect(bytes(result.text)).toBeLessThanOrEqual(100);
    expect(result.omittedLines).toBe(0);
    expect(result.originalLines).toBe(1);
    expect(result.text).toBe(`${"y".repeat(48)}\n--- truncated ---\n${"y".repeat(33)}`);
  });

  it("falls back when the first and last lines alone overflow", () => {
    const input = ["a".repeat(80), "middle", "z".repeat(80)].join("\n");
    const result = truncateOutput(input, { maxBytes: 60 });
    expect(bytes(result.text)).toBeLessThanOrEqual(60);
    expect(result.text.startsWith("a")).toBe(true);
    expect(result.text.endsWith("z")).toBe(true);
    expect(result.omittedLines).toBe(1);
  });

  it("returns a bare prefix when the marker itself overflows the budget", () => {
    const result = truncateOutput("abcdefghij\nklmnop", { maxBytes: 5 });
    expect(result).toEqual({ text: "abcde", truncated: true, originalLines: 2, omittedLines: 1 });
  });

  it("never splits a surrogate pair", () => {
    const result = truncateOutput("\u{1F600}".repeat(40), { maxBytes: 41 });
    expect(result.text).not.toContain("�");
    expect(Buffer.from(result.text, "utf-8").toString("utf-8")).toBe(result.text);
    expect(bytes(result.text)).toBeLessThanOrEqual(41);
  });

  it("rejects a negative budget and an out-of-range ratio", () => {
    expect(() => truncateOutput("x", { maxBytes: -1 })).toThrow(RangeError);
    expect(() => truncateOutput("x", { maxBytes: 10, headRatio: 1.5 })).toThrow(RangeError);
  });
});

describe("truncateOutput budget bound", () => {
  const inputs: Record<string, string> = {
    "one long line": "q".repeat(1024),
    "two long lines": `${"a".repeat(300)}\n${"b".repeat(300)}`,
    "many short lines": numbered(300, (i) => `row ${i}`),
    "mixed widths": numbered(60, (i) => "w".repeat((i * 37) % 120)),
    "multi-byte lines": numbered(80, (i) => `é中\u{1F600} ${i}`),
    "blank lines": "\n".repeat(200),
  };

  it.each(Object.entries(inputs))("keeps %s within every budget from 0 to its full size", (_name, input) => {
    for (let maxBytes = 0; maxBytes <= bytes(input) + 1; maxBytes++) {
      const result = truncateOutput(input, { maxBytes });
      expectWithinBudget(result, maxBytes);
      expect(result.originalLines).toBe(input.split("\n").length);
    }
  });

  it("keeps every head ratio within budget", () => {
    const input = inputs["mixed widths"]!;
    for (const headRatio of [0, 0.25, 0.6, 1]) {
      for (const maxBytes of [0, 10, 25, 50, 200, 1000]) {
        expectWithinBudget(truncateOutput(input, { maxBytes, headRatio }), maxBytes);
      }
    }
  });
});
