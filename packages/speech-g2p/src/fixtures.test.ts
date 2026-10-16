import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FIXTURES = new URL("./fixtures/", import.meta.url);
// Only the top-level keys are checked here; the tests below check the contents.
function read<T>(url: URL, isShape: (v: unknown) => v is T): T {
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  if (!isShape(parsed)) throw new Error(`unexpected fixture shape: ${url.pathname}`);
  return parsed;
}

interface Unit {
  id: string;
  source: string;
  text: string;
}
interface GoldenToken {
  text: string;
  tag: string;
  phonemes: string | null;
  whitespace: string;
  rating: number | null;
}
interface GoldenUnit {
  id: string;
  pre: string;
  spacy: { text: string; idx: number; ws: string; tag: string }[];
  tokens: GoldenToken[];
  phonemes: string;
}
interface Golden {
  _source: Record<string, string>;
  fallback: Record<string, string>;
  subtokens: Record<string, string[]>;
  units: GoldenUnit[];
}

interface SpacyGolden {
  _source: Record<string, string>;
  units: { id: string; text: string; tokens: { text: string; idx: number; ws: string }[] }[];
}
interface Num2wordsGolden {
  _source: Record<string, string>;
  cases: { form: string; value: number; words: string }[];
}

const hasKeys =
  <T>(...keys: string[]) =>
  (v: unknown): v is T =>
    typeof v === "object" && v !== null && keys.every((k) => k in v);

const corpus = read(new URL("corpus.json", FIXTURES), hasKeys<{ units: Unit[] }>("units"));
const golden = read(
  new URL("misaki-golden.json", FIXTURES),
  hasKeys<Golden>("_source", "fallback", "subtokens", "units"),
);
const spacyGolden = read(
  new URL("spacy-tokens.golden.json", FIXTURES),
  hasKeys<SpacyGolden>("_source", "units"),
);
const num2words = read(
  new URL("num2words.golden.json", FIXTURES),
  hasKeys<Num2wordsGolden>("_source", "cases"),
);
const tokenizerData = read(
  new URL("../data/spacy-en-tokenizer.json", import.meta.url),
  hasKeys<{ _source: Record<string, string> }>("_source"),
);

describe("golden fixtures", () => {
  it("header records misaki 0.9.4, spaCy 3.8.16, en_core_web_sm 3.8.0 and num2words 0.5.14", () => {
    expect(golden._source).toMatchObject({
      misaki: "0.9.4",
      spacy: "3.8.16",
      en_core_web_sm: "3.8.0",
      num2words: "0.5.14",
    });
    expect(spacyGolden._source).toMatchObject({ spacy: "3.8.16", model: "3.8.0" });
    expect(tokenizerData._source).toMatchObject({ spacy: "3.8.16", model: "3.8.0" });
    expect(num2words._source.num2words).toBe("0.5.14");
  });

  it("every rating-2 token has a recorded espeak fallback with the same phonemes", () => {
    const fallbackTokens = golden.units
      .flatMap((u) => u.tokens)
      .filter((t) => t.rating === 2);

    expect(fallbackTokens.length).toBeGreaterThan(0);
    for (const t of fallbackTokens) {
      expect(golden.fallback[t.text], t.text).toBe(t.phonemes);
    }
  });

  it("fixtures stay under 2 MB and the corpus holds only our own sources", () => {
    const bytes = readdirSync(FIXTURES)
      .map((name) => statSync(new URL(name, FIXTURES)).size)
      .reduce((a, b) => a + b, 0);
    const counts = new Map<string, number>();
    for (const u of corpus.units) counts.set(u.source, (counts.get(u.source) ?? 0) + 1);

    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    expect([...counts.keys()].sort()).toEqual(["authored", "het", "rf"]);
    expect(counts.get("rf")).toBe(181);
    expect(counts.get("het")).toBe(76);
    expect(counts.get("authored")).toBeGreaterThanOrEqual(150);
  });

  it("corpus text carries no local path or email address", () => {
    const text = JSON.stringify(corpus);

    const homeRoots = ["Users", "home"].map((dir) => `/${dir}/`);

    for (const root of homeRoots) expect(text).not.toContain(root);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });

  it("covers every corpus unit, in order, in each golden", () => {
    const ids = corpus.units.map((u) => u.id);

    expect(golden.units.map((u) => u.id)).toEqual(ids);
    expect(spacyGolden.units.map((u) => u.id)).toEqual(ids);
  });

  it("the joined phoneme string is each token's phonemes plus its whitespace", () => {
    for (const u of golden.units) {
      const joined = u.tokens.map((t) => (t.phonemes ?? "") + t.whitespace).join("");
      expect(joined, u.id).toBe(u.phonemes);
    }
  });

  it("records the spaCy tokens and tags misaki consumed, over the preprocessed text", () => {
    for (const u of golden.units) {
      const spacy = spacyGolden.units.find((s) => s.id === u.id);
      expect(
        u.spacy.map((t) => [t.text, t.idx, t.ws]),
        u.id,
      ).toEqual(spacy?.tokens.map((t) => [t.text, t.idx, t.ws]));
    }
  });

  it("records subtokenize output for every spaCy and output token text", () => {
    const texts = new Set(golden.units.flatMap((u) => [...u.spacy, ...u.tokens].map((t) => t.text)));

    expect([...texts].filter((t) => !(t in golden.subtokens))).toEqual([]);
    expect(golden.subtokens["well-known"]).toEqual(["well", "-", "known"]);
  });

  it("the speech-vet memoizes sentence matches its independent recording", () => {
    // Copied from packages/speech-vet/src/fixtures/misaki-tokens.json, recorded separately via
    // kokoro's KPipeline; copied rather than imported to keep tier order.
    const text = "Each cache [memoizes](/mˈɛmoʊˌaɪzᵻz/) one call; we live here.";
    const expected = [
      ["Each", "DT", "ˈiʧ", " "],
      ["cache", "NN", "kˈæʃ", " "],
      ["memoizes", "VBZ", "mˈɛmoʊˌaɪzᵻz", " "],
      ["one", "CD", "wˈʌn", " "],
      ["call", "NN", "kˈɔl", ""],
      [";", ":", ";", " "],
      ["we", "PRP", "wi", " "],
      ["live", "VBP", "lˈɪv", " "],
      ["here", "RB", "hˈɪɹ", ""],
      [".", ".", ".", ""],
    ];
    const id = corpus.units.find((u) => u.text === text)?.id;
    const unit = golden.units.find((u) => u.id === id);

    expect(unit?.tokens.map((t) => [t.text, t.tag, t.phonemes, t.whitespace])).toEqual(expected);
  });

  it("num2words keeps 'and' in cardinals and reads years in pairs", () => {
    const words = (form: string, value: number) =>
      num2words.cases.find((c) => c.form === form && c.value === value)?.words;

    expect(words("cardinal", 147)).toBe("one hundred and forty-seven");
    expect(words("year", 1984)).toBe("nineteen eighty-four");
    expect(words("ordinal", 21)).toBe("twenty-first");
  });
});
