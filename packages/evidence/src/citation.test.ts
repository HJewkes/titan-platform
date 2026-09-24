import { describe, expect, it } from "vitest";
import { lineSourceFromTexts, splitLines } from "./line-source.js";
import { quoteInRange, verifyCitation } from "./citation.js";

const FILE = ["def area(r):", "    return 3.14159 * r * r", "", "def unused():", "    pass"].join("\n") + "\n";
const source = lineSourceFromTexts({ "geo.py": FILE, "other.py": "x = 1\n" });
const cite = (lineStart: number, lineEnd: number, quote: string, path = "geo.py") => ({ path, lineStart, lineEnd, quote });

describe("quote matching", () => {
  it("rejects a quote one character off the cited line", () => {
    const check = verifyCitation(source, cite(2, 2, "return 3.14158 * r * r"));
    expect(check).toMatchObject({ ok: false, reason: "quote-mismatch" });
  });

  it("accepts a quote that differs from the cited line only in whitespace", () => {
    expect(verifyCitation(source, cite(2, 2, "return   3.14159 *\tr * r  ")).ok).toBe(true);
  });

  it("rejects a quote that exists in the file but outside the cited range", () => {
    const check = verifyCitation(source, cite(4, 5, "return 3.14159"));
    expect(check).toMatchObject({ ok: false, reason: "quote-mismatch" });
  });

  it("accepts a multi-line quote with an elision when every fragment is in range", () => {
    expect(verifyCitation(source, cite(1, 2, "def area(r): ... * r * r")).ok).toBe(true);
    expect(verifyCitation(source, cite(1, 2, "def area(r):\n  return 3.14159")).ok).toBe(true);
  });

  it("rejects a quote with no fragment long enough to carry evidence", () => {
    expect(verifyCitation(source, cite(2, 2, " r ... * "))).toMatchObject({ ok: false, reason: "quote-empty" });
    expect(quoteInRange(splitLines(FILE), { lineStart: 2, lineEnd: 2 }, "")).toBeNull();
  });
});

describe("location checks", () => {
  const options = { allowedPaths: ["geo.py"], shown: new Map([["geo.py", new Set([1, 2, 3])]]) };

  it("rejects a range past the end of the file", () => {
    expect(verifyCitation(source, cite(5, 6, "pass"), options)).toMatchObject({ ok: false, reason: "past-eof" });
  });

  it("rejects a path outside the allowed paths even when the file is readable", () => {
    expect(verifyCitation(source, cite(1, 1, "x = 1", "other.py"), options)).toMatchObject({ ok: false, reason: "path-not-allowed" });
  });

  it("rejects a line the reader was not shown even when the quote matches", () => {
    const check = verifyCitation(source, cite(4, 4, "def unused():"), options);
    expect(check).toMatchObject({ ok: false, reason: "not-shown", detail: "geo.py:4 was not shown" });
  });

  it("accepts a citation inside the shown lines of an allowed path", () => {
    expect(verifyCitation(source, cite(1, 2, "def area(r):"), options).ok).toBe(true);
  });

  it("rejects an unreadable path and an inverted or zero range", () => {
    expect(verifyCitation(source, cite(1, 1, "abc", "missing.py"))).toMatchObject({ ok: false, reason: "path-unreadable" });
    expect(verifyCitation(source, cite(3, 2, "abc"))).toMatchObject({ ok: false, reason: "bad-range" });
    expect(verifyCitation(source, cite(0, 1, "abc"))).toMatchObject({ ok: false, reason: "bad-range" });
  });
});

describe("splitLines", () => {
  it("drops the trailing newline's empty entry and handles CRLF", () => {
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
  });
});
