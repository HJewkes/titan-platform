import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compilePattern, compileSpacyPatterns, translatePattern, type Span } from "./spacy-patterns.js";
import { loadSpacyTokenizerData } from "./spacy-tokenizer.js";

interface Probe {
  text: string;
  prefix_search: [number, number] | null;
  suffix_search: [number, number] | null;
  infix_finditer: [number, number][];
  token_match: [number, number] | null;
  url_match: [number, number] | null;
}

// Only the array is checked; each probe's fields are compared below.
const hasProbes = (v: unknown): v is { probes: Probe[] } =>
  typeof v === "object" && v !== null && "probes" in v && Array.isArray(v.probes);
const dump: unknown = JSON.parse(readFileSync(new URL("../data/spacy-en-tokenizer.json", import.meta.url), "utf8"));
if (!hasProbes(dump)) throw new Error("tokenizer dump has no probes");
const probes = dump.probes;
const patterns = compileSpacyPatterns(loadSpacyTokenizerData().patterns);

// Python reports code-point offsets; JS spans are UTF-16.
function pySpan(s: string, span: Span | null): [number, number] | null {
  if (!span) return null;
  const cp = (i: number): number => Array.from(s.slice(0, i)).length;
  return [cp(span.start), cp(span.end)];
}

describe("spaCy patterns in JS", () => {
  it("every dumped pattern compiles and reproduces Python's span on each recorded probe", () => {
    expect(probes.length).toBeGreaterThan(2000);
    for (const p of probes) {
      const actual = {
        prefix_search: pySpan(p.text, patterns.prefixSearch(p.text)),
        suffix_search: pySpan(p.text, patterns.suffixSearch(p.text)),
        infix_finditer: patterns.infixFinditer(p.text).map((m) => pySpan(p.text, m)),
        url_match: patterns.urlMatch(p.text),
      };
      expect(actual, p.text).toEqual({
        prefix_search: p.prefix_search,
        suffix_search: p.suffix_search,
        infix_finditer: p.infix_finditer,
        url_match: p.url_match !== null,
      });
    }
  });

  it("Python's \\d and \\w stay Unicode-aware, so Arabic-Indic digits and accented letters match", () => {
    const digits = compilePattern("probe", { pattern: "^\\d+$", flags: 32 });
    const word = compilePattern("probe", { pattern: "^\\w+$", flags: 32 });

    expect(digits.test("١٩٨٤")).toBe(true);
    expect(word.test("façade_2")).toBe(true);
  });

  it("an inline (?u) flag folds into the flags, and $ also matches before a final newline", () => {
    const { source, flags } = translatePattern("(?u)a$", 0);
    const re = new RegExp(source, flags);

    expect(re.test("a\n")).toBe(true);
    expect(re.test("a\nb")).toBe(false);
  });

  it("escaped punctuation, a leading ] in a class and a lone { read as literals, as Python reads them", () => {
    const re = compilePattern("probe", { pattern: "^\\'[]x]{a}\\!x{2}$", flags: 32 });

    expect(re.test("']{a}!xx")).toBe(true);
  });

  it("a construct with no JS translation fails loudly with the pattern's name", () => {
    expect(() => compilePattern("suffix_search", { pattern: "a(?P=n)", flags: 32 })).toThrow(/suffix_search/);
    expect(() => compilePattern("url_match", { pattern: "\\bword", flags: 32 })).toThrow(/url_match.*\\b/);
    expect(() => compilePattern("infix_finditer", { pattern: "a", flags: 64 })).toThrow(/flags 64/);
  });
});
