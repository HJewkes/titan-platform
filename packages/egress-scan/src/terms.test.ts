import { describe, expect, it } from "vitest";
import { parseTerms, TermFileError } from "./terms.js";

const matching = (termText: string, candidate: string) =>
  parseTerms(termText)
    .filter((rule) => rule.matches(candidate))
    .map((rule) => rule.index);

describe("parseTerms", () => {
  it("skips comments and blank lines and numbers terms by file line", () => {
    const rules = parseTerms("# private\n\nzq-planted-term\n  \n# another\nzq-second\n");
    expect(rules.map((rule) => rule.index)).toEqual([3, 6]);
  });

  it("matches a term case-insensitively", () => {
    expect(matching("zq-planted-term", "see ZQ-Planted-Term here")).toEqual([1]);
  });

  it("does not match a term inside a longer word", () => {
    expect(matching("zqa", "zqabc and abczqa")).toEqual([]);
    expect(matching("zqa", "(zqa)")).toEqual([1]);
  });

  it("treats word boundaries as Unicode-aware", () => {
    expect(matching("zqa", "ézqa")).toEqual([]);
  });

  it("matches regex metacharacters in a plain term literally", () => {
    expect(matching("zq.a", "zqxa")).toEqual([]);
    expect(matching("zq.a", "a zq.a b")).toEqual([1]);
  });

  it("compiles a re: line case-insensitively", () => {
    expect(matching("re:zq-\\d+", "ref ZQ-42")).toEqual([1]);
  });

  it("ignores a leading byte-order mark", () => {
    expect(matching("\uFEFFzq-planted-term", "zq-planted-term")).toEqual([1]);
  });

  it("fails an invalid re: line with its line number and without the term", () => {
    const secret = "zq-planted-" + "secret(";
    const error = captureError(() => parseTerms(`# c\nzq-ok\nre:${secret}`));
    expect(error).toBeInstanceOf(TermFileError);
    expect((error as TermFileError).line).toBe(3);
    expect(String(error)).toContain("line 3");
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("zq-planted-");
  });

  it.each(["re:.*", "re:a?", "re:^"])("fails a term that matches the empty string: %s", (entry) => {
    const error = captureError(() => parseTerms(`zq-ok\n${entry}`));
    expect(error).toBeInstanceOf(TermFileError);
    expect(String(error)).toMatch(/line 2: matches the empty string/);
    expect(String(error)).not.toContain(entry.slice(3));
  });

  it("fails an empty re: line", () => {
    expect(() => parseTerms("re:")).toThrow(/line 1: empty regular expression/);
  });
});

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}
