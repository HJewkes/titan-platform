import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { misakiEnglish, type G2p } from "./misaki-english.js";
import { agrees, compareUnit, percent, stripStress, tally, type Comparison } from "./parity.test-helpers.js";
import type { G2pToken } from "./types.js";

interface GoldenUnit {
  id: string;
  tokens: G2pToken[];
}
interface Golden {
  fallback: Record<string, string>;
  units: GoldenUnit[];
}
interface Corpus {
  units: { id: string; text: string }[];
}
type Cause = "tagger" | "stress-only" | "tokenizer" | "heteronym";
interface AllowEntry {
  unit: string;
  token: string;
  cause: Cause;
  note: string;
}
interface Miss extends Comparison {
  unit: string;
}

function readJson<T>(url: URL, keys: readonly string[]): T {
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  const isShape = (v: unknown): v is T => typeof v === "object" && v !== null && keys.every((k) => k in v);
  if (!isShape(parsed)) throw new Error(`unexpected shape: ${url.pathname}`);
  return parsed;
}

const golden = readJson<Golden>(new URL("fixtures/misaki-golden.json", import.meta.url), ["fallback", "units"]);
const corpus = new Map(readJson<Corpus>(new URL("fixtures/corpus.json", import.meta.url), ["units"]).units.map((u) => [u.id, u.text]));
const allowList = readJson<{ entries: AllowEntry[] }>(new URL("parity-allow-list.json", import.meta.url), ["entries"]).entries;
const allowKey = (unit: string, token: string): string => `${unit}\t${token}`;
const allowed = new Map(allowList.map((e) => [allowKey(e.unit, e.token), e]));

// misaki's reference run had espeak for words the lexicon lacks; the recorded espeak output stands in for it here.
const recordedFallback = (token: G2pToken): string | null => golden.fallback[token.text] ?? null;

function compareAll(g2p: G2p): Miss[] {
  return golden.units.flatMap((unit) =>
    compareUnit(unit.tokens, g2p.tokens(corpus.get(unit.id)!)).map((c) => ({ ...c, unit: unit.id })),
  );
}

const withFallback = compareAll(misakiEnglish({ fallback: recordedFallback }));
const misses = withFallback.filter((c) => !agrees(c));
const show = (m: Miss): string => `${m.unit} ${m.text}: want ${m.want} got ${m.aligned ? m.got : "(split differently)"}`;

describe("end-to-end parity: spacyTokenizer and compromiseTagger against misaki with spaCy", () => {
  // Stress is compared: Kokoro reads the marks, so a moved ˈ is a different reading.
  it("matches at least 99 % of non-heteronym word tokens, stress included", () => {
    const t = tally(withFallback);
    expect(percent(t.agree, t.tokens)).toBeGreaterThanOrEqual(99);
    expect({ ...t, parity: percent(t.agree, t.tokens), parityNoStress: percent(t.agreeNoStress, t.tokens) }).toEqual({
      tokens: 6069,
      agree: 6028,
      agreeNoStress: 6050,
      unaligned: 9,
      parity: 99.324,
      parityNoStress: 99.687,
    });
  });

  it("puts every disagreement on the allow-list", () => {
    expect(misses.filter((m) => !allowed.has(allowKey(m.unit, m.text))).map(show)).toEqual([]);
  });

  it("fails an allow-list entry whose token now agrees, as stale", () => {
    const missing = new Set(misses.map((m) => allowKey(m.unit, m.text)));
    expect(allowList.filter((e) => !missing.has(allowKey(e.unit, e.token)))).toEqual([]);
  });

  it("gives each allow-list entry the cause its disagreement shows", () => {
    const wrong = misses.filter((m) => {
      const cause = allowed.get(allowKey(m.unit, m.text))?.cause;
      if (cause === "heteronym") return !m.heteronym;
      if (cause === "stress-only") return !m.aligned || stripStress(m.want) !== stripStress(m.got);
      return m.heteronym;
    });
    expect(wrong.map(show)).toEqual([]);
  });

  it("reads 'cannot read' as present tense through the modal look-back", () => {
    const read = (unit: string) => withFallback.find((c) => c.unit === unit && c.text === "read");
    expect(read("rf:c4-4-failclosed")).toMatchObject({ want: "ɹˈid", got: "ɹˈid" });
    expect(read("auth:contraction-3")).toMatchObject({ want: "ɹˈid", got: "ɹˈid" });
  });
});

describe("end-to-end without a fallback peer", () => {
  const noPeer = compareAll(misakiEnglish());
  // An unread word also changes the word before it: "the" reads ði or ðə from the next word's first phoneme.
  const espeakWordsAndTheirLeft = new Set(
    golden.units.flatMap((unit) => {
      const words = unit.tokens.filter((tk) => tk.text.trim() !== "");
      return words.flatMap((tk, i) => {
        const next = words[i + 1];
        return tk.rating === 2 || next?.rating === 2 ? [allowKey(unit.id, tk.text)] : [];
      });
    }),
  );

  // A compound OOV (file_name.txt) keeps the phonemes of its known parts, so an espeak word may be partial, not null.
  it("loses only words misaki sent to espeak, some entirely and some in part", () => {
    const extra = noPeer.filter((c, i) => !agrees(c) && agrees(withFallback[i]!));
    expect(extra.filter((m) => !espeakWordsAndTheirLeft.has(allowKey(m.unit, m.text))).map(show)).toEqual([]);
    expect(extra.filter((m) => m.got === null).length).toBeGreaterThan(0);
    expect(extra.filter((m) => m.got !== null).length).toBeGreaterThan(0);
  });
});
