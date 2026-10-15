import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { misakiEnglish } from "./misaki-english.js";
import { compareUnit, percent, tally, type Comparison, type Tally } from "./parity.test-helpers.js";
import { spacyTokenizer } from "./spacy-tokenizer.js";
import type { G2pToken } from "./types.js";

// Runs only on request. The E4 corpus is mostly third-party fiction, so it never enters this repo; point the test
// at the E4 run's raw directory (e4-corpus.jsonl, e4-tokens.jsonl, e4-misaki-v2.jsonl) where it already lives:
// SPEECH_G2P_CORPUS=<e4 raw dir> pnpm vitest run corpus-parity.smoke --silent=false (to see the figures)
const corpusDir = process.env.SPEECH_G2P_CORPUS ?? "";

interface CorpusRow {
  id: string;
  text: string;
}
interface TokensRow {
  id: string;
  text: string;
  tokens: { text: string; idx: number; ws: string }[];
}
interface MisakiRow {
  id: string;
  spacy: { text: string; ph: string }[];
}

// Only the keys each row is read by are checked.
function readJsonl<T>(name: string, keys: readonly string[]): T[] {
  const isRow = (v: unknown): v is T => typeof v === "object" && v !== null && keys.every((k) => k in v);
  return readFileSync(join(corpusDir, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row: unknown = JSON.parse(line);
      if (!isRow(row)) throw new Error(`unexpected row in ${name}`);
      return row;
    });
}

const summary = (t: Tally) => ({ ...t, parity: percent(t.agree, t.tokens), parityNoStress: percent(t.agreeNoStress, t.tokens) });

describe.skipIf(!corpusDir)("E4 corpus parity (opt-in)", () => {
  it("matches spaCy's tokenizer on every unit", () => {
    const tokenizer = spacyTokenizer();
    const rows = readJsonl<TokensRow>("e4-tokens.jsonl", ["id", "text", "tokens"]);
    const differing = rows.filter((row) => {
      const got = tokenizer.tokenize(row.text).map((t) => [t.text, t.idx, t.whitespace]);
      return JSON.stringify(got) !== JSON.stringify(row.tokens.map((t) => [t.text, t.idx, t.ws]));
    });
    console.log(`tokenizer parity: ${rows.length - differing.length}/${rows.length} units`);
    expect(differing.map((row) => row.id)).toEqual([]);
  });

  it("reads at least 99 % of non-heteronym word tokens as misaki with spaCy does, stress included", () => {
    const texts = new Map(readJsonl<CorpusRow>("e4-corpus.jsonl", ["id", "text"]).map((u) => [u.id, u.text]));
    const rows = readJsonl<MisakiRow>("e4-misaki-v2.jsonl", ["id", "spacy"]);
    // The reference run had espeak for unknown words; its readings of those words stand in for it.
    const espeak = new Map(rows.flatMap((row) => row.spacy.map((t) => [t.text, t.ph] as const)));
    const run = (fallback?: (tk: G2pToken) => string | null): Comparison[] => {
      const g2p = misakiEnglish({ fallback });
      return rows.flatMap((row) =>
        compareUnit(
          row.spacy.map((t) => ({ text: t.text, phonemes: t.ph })),
          g2p.tokens(texts.get(row.id)!).map((tk) => ({ text: tk.text, phonemes: tk.phonemes ?? "" })),
        ),
      );
    };
    const withFallback = summary(tally(run((tk) => espeak.get(tk.text) ?? null)));
    const noPeer = summary(tally(run()));
    console.log(JSON.stringify({ withFallback, noPeer }, null, 1));
    expect(withFallback.parity).toBeGreaterThanOrEqual(99);
  }, 600_000);
});
