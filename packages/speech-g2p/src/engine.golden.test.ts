import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MisakiEngine } from "./engine.js";
import { Lexicon } from "./lexicon.js";
import { loadLexiconData } from "./lexicon-data.js";
import { subtokenize, type TaggedToken } from "./pipeline.js";
import type { G2pToken } from "./types.js";

interface GoldenUnit {
  id: string;
  pre: string;
  spacy: { text: string; idx: number; ws: string; tag: string }[];
  tokens: G2pToken[];
  phonemes: string;
}
interface Golden {
  fallback: Record<string, string>;
  subtokens: Record<string, string[]>;
  units: GoldenUnit[];
}

interface Corpus {
  units: { id: string; text: string }[];
}

// Only the top-level keys are checked; the tests check the contents.
function readJson<T>(name: string, keys: readonly string[]): T {
  const parsed: unknown = JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));
  const isShape = (v: unknown): v is T => typeof v === "object" && v !== null && keys.every((k) => k in v);
  if (!isShape(parsed)) throw new Error(`unexpected fixture shape: ${name}`);
  return parsed;
}

const golden = readJson<Golden>("misaki-golden.json", ["fallback", "subtokens", "units"]);
const corpus = new Map(readJson<Corpus>("corpus.json", ["units"]).units.map((u) => [u.id, u.text]));
const lexicon = new Lexicon(loadLexiconData());

const recordedFallback = (token: G2pToken): string | null => golden.fallback[token.text] ?? null;

function engineFor(unit: GoldenUnit, fallback: ((token: G2pToken) => string | null) | null): MisakiEngine {
  const analyze = (text: string): TaggedToken[] => {
    expect(text).toBe(unit.pre);
    return unit.spacy.map((t) => ({ text: t.text, idx: t.idx, whitespace: t.ws, tag: t.tag }));
  };
  return new MisakiEngine({ lexicon, analyze, fallback, unk: "" });
}

const phonemizeUnit = (unit: GoldenUnit, fallback: ((token: G2pToken) => string | null) | null = recordedFallback) =>
  engineFor(unit, fallback).phonemize(corpus.get(unit.id)!);

describe("engine golden: misaki 0.9.4 with spaCy's recorded tokens and tags", () => {
  it("every token equals misaki's, phonemes with stress, text, tag, whitespace and rating", () => {
    const misses: string[] = [];
    let total = 0;
    for (const unit of golden.units) {
      const { phonemes, tokens } = phonemizeUnit(unit);
      total += unit.tokens.length;
      if (tokens.length !== unit.tokens.length) misses.push(`${unit.id}: ${tokens.length} tokens, want ${unit.tokens.length}`);
      unit.tokens.forEach((want, i) => {
        if (JSON.stringify(tokens[i]) !== JSON.stringify(want)) {
          misses.push(`${unit.id}#${i}: got ${JSON.stringify(tokens[i])} want ${JSON.stringify(want)}`);
        }
      });
      if (phonemes !== unit.phonemes) misses.push(`${unit.id}: joined "${phonemes}" want "${unit.phonemes}"`);
    }
    expect(total).toBe(7502);
    expect(misses).toEqual([]);
  });

  // A compound word with no fallback resolves its known parts instead, so it keeps partial phonemes.
  it("without a fallback peer, only tokens misaki sent to espeak can lose their phonemes", () => {
    const lost: string[] = [];
    const fellBack = new Set<string>();
    for (const unit of golden.units) {
      const { tokens } = phonemizeUnit(unit, null);
      expect(tokens.map((tk) => tk.text)).toEqual(unit.tokens.map((tk) => tk.text));
      tokens.forEach((tk, i) => {
        if (tk.phonemes === null) lost.push(`${unit.id}#${i}`);
        if (unit.tokens[i]!.rating === 2) fellBack.add(`${unit.id}#${i}`);
      });
    }
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.filter((key) => !fellBack.has(key))).toEqual([]);
  });

  it("subtokenize matches misaki's regex on every recorded token text", () => {
    const misses = Object.entries(golden.subtokens).filter(([text, want]) => JSON.stringify(subtokenize(text)) !== JSON.stringify(want));
    expect(misses).toEqual([]);
  });
});
