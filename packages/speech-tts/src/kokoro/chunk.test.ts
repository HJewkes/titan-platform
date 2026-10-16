import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chunkTokens, enTokenize, offsetWords, styleRow } from "./chunk.js";

type RecordedToken = [text: string, phonemes: string | null, whitespace: string];

interface Span {
  readonly ps: string;
  readonly start: number;
  readonly end: number;
}

interface GoldenCase {
  readonly name: string;
  readonly en_tokenize: Span[];
  readonly chunks: Span[];
  readonly tokens: RecordedToken[];
}

// Only the top-level keys are checked; the tests check the contents.
function loadFixture<T extends object>(name: string, keys: readonly (keyof T & string)[]): T {
  const parsed: unknown = JSON.parse(readFileSync(new URL(`../fixtures/kokoro/${name}`, import.meta.url), "utf8"));
  const hasKeys = (v: unknown): v is T => typeof v === "object" && v !== null && keys.every((k) => k in v);
  if (!hasKeys(parsed)) throw new Error(`unexpected fixture shape: ${name}`);
  return parsed;
}

function loadCases(): Map<string, GoldenCase> {
  const golden = loadFixture<{ cases: GoldenCase[] }>("chunks.golden.json", ["cases"]);
  return new Map(golden.cases.map((c) => [c.name, c]));
}

function toTokens(recorded: readonly RecordedToken[]) {
  return recorded.map(([text, phonemes, whitespace]) => ({ text, phonemes, whitespace }));
}

function asSpans(chunks: readonly { ps: string; tokens: readonly unknown[] }[]): Span[] {
  let start = 0;
  return chunks.map((chunk) => {
    const span = { ps: chunk.ps, start, end: start + chunk.tokens.length };
    start = span.end;
    return span;
  });
}

const cases = loadCases();

describe("enTokenize against Python KPipeline.en_tokenize", () => {
  // Mutations caught: dropping the `)`/`”` bump moves the bump case's split one token early;
  // dropping the lstrip into an empty buffer splits synthetic-lstrip a second time.
  it.each([...cases.keys()])("splits %s at the same tokens with the same ps", (name) => {
    const golden = cases.get(name);
    if (!golden) throw new Error(name);

    const chunks = enTokenize(toTokens(golden.tokens));

    expect(asSpans(chunks)).toEqual(golden.en_tokenize);
  });

  it("returns each group as the input slice with null phonemes read as empty", () => {
    const golden = cases.get("synthetic-truncation");
    if (!golden) throw new Error("synthetic-truncation");
    const tokens = toTokens(golden.tokens);

    const grouped = enTokenize(tokens).flatMap((chunk) => chunk.tokens);

    expect(grouped).toEqual(tokens.map((t) => ({ ...t, phonemes: t.phonemes ?? "" })));
    expect(tokens.some((t) => t.phonemes === null)).toBe(true);
  });
});

describe("the golden covers each waterfall branch", () => {
  const splitAfter = (name: string): string[] => {
    const golden = cases.get(name);
    if (!golden) throw new Error(name);
    return golden.en_tokenize.slice(0, -1).map((span) => golden.tokens[span.end - 1]?.[1] ?? "");
  };

  it("splits the period case after a period, the bump case after its closer", () => {
    expect(splitAfter("split-at-period")).toEqual(["."]);
    expect(splitAfter("bump")).toEqual([")"]);
  });

  it("has no waterfall mark at all in the case that falls through to every token", () => {
    const golden = cases.get("no-punctuation");
    const marks = new Set([..."!.?…:;,—"]);

    expect(golden?.tokens.some(([, phonemes]) => marks.has(phonemes ?? ""))).toBe(false);
    expect(golden?.en_tokenize).toHaveLength(2);
  });
});

describe("chunkTokens against Python KPipeline.generate_from_tokens", () => {
  // Mutation caught: keeping empty chunks adds the synthetic case's leading empty chunk.
  it.each([...cases.keys()])("yields the chunks Python synthesizes for %s", (name) => {
    const golden = cases.get(name);
    if (!golden) throw new Error(name);

    const chunks = chunkTokens(toTokens(golden.tokens));

    expect(asSpans(chunks)).toEqual(golden.chunks);
  });

  // Mutation caught: dropping the 510 cut leaves 600 phonemes.
  it("cuts a single chunk over 510 phonemes to its first 510", () => {
    const tokens = [{ phonemes: "ə".repeat(600), whitespace: "" }];

    const chunks = chunkTokens(tokens);

    expect(chunks.map((chunk) => chunk.ps)).toEqual(["ə".repeat(510)]);
  });
});

describe("styleRow", () => {
  // Mutation caught: len(ps), the kokoro-js 1.2.1 row, gives 3 and 141.
  it("is the phoneme count minus one", () => {
    expect(styleRow("abc")).toBe(2);
  });

  it("matches the style index Python used for r4-8", () => {
    const r48 = loadFixture<{ ps: string; style_index: number }>("r4-8.golden.json", ["ps", "style_index"]);

    expect([...r48.ps]).toHaveLength(141);
    expect(styleRow(r48.ps)).toBe(r48.style_index);
  });
});

describe("offsetWords", () => {
  // Mutation caught: not shifting later chunks puts the second chunk's words back at zero.
  it("starts the second chunk's words after the first chunk's samples", () => {
    const first = { samples: 36_000, times: [{ start: 0.1, end: 0.5 }] };
    const second = { samples: 12_000, times: [{ start: 0.075, end: 0.3 }, { start: null, end: null }] };

    const words = offsetWords([first, second], 24_000);

    expect(words).toEqual([
      { start: 0.1, end: 0.5 },
      { start: 36_000 / 24_000 + 0.075, end: 36_000 / 24_000 + 0.3 },
      { start: null, end: null },
    ]);
  });
});
