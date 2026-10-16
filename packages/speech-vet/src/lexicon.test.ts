import { describe, expect, it } from "vitest";
import { LexiconSchema, loadLexicon, respellingsOf } from "./lexicon.js";
import { generateCandidates, respeller } from "./respell.js";

// Ported from the audiobook test_lexicon.py cases, with invented words in place of the original place names.
describe("pronunciation lexicon", () => {
  // Catches: a case-sensitive match, or a lookup by the matched spelling rather than its lowercase.
  it("apply replaces whole words case insensitively", () => {
    const lex = respeller({ Wythmoor: "Withmor", Tavi: "Taavee" });
    const out = lex.apply("From wythmoor, Tavi wrote to Wythmoor again.");
    expect(out).toBe("From Withmor, Taavee wrote to Withmor again.");
  });

  // Catches: dropping the word-boundary lookarounds, so `art` rewrites inside `cart` and `artist`.
  it("apply does not match substrings", () => {
    const lex = respeller({ art: "arrt" });
    expect(lex.apply("The cart and the artist")).toBe("The cart and the artist");
  });

  // Catches: a respelling that is re-matched as a key on a second pass.
  it("apply is idempotent", () => {
    const lex = respeller({ Brochel: "Brokel" });
    const once = lex.apply("a match in Brochel tonight");
    expect(lex.apply(once)).toBe(once);
  });

  // Catches: the `_comment` annotation kept as a word, so the file's own docs become a respelling.
  it("reserved comment key is ignored", () => {
    const lex = respeller({ _comment: "docs", Wrexmoor: "Rexmor" });
    expect(lex.entries).not.toHaveProperty("_comment");
    expect(lex.apply("Wrexmoor")).toBe("Rexmor");
  });

  // Catches: an empty alternation `()` compiled for no keys, which matches everywhere.
  it("empty lexicon is a noop", () => {
    const lex = respeller({});
    expect(lex.apply("nothing to change here")).toBe("nothing to change here");
  });

  // Catches: the original word, or a case-only repeat, offered as a candidate.
  it("generate candidates excludes original and dedups", () => {
    const cands = generateCandidates("Wrexmoor");
    expect(cands).not.toContain("Wrexmoor");
    expect(cands.length).toBe(new Set(cands.map((c) => c.toLowerCase())).size);
    expect(cands.length).toBeGreaterThan(0);
  });

  // Catches: a rule dropped from the table, here y→i and the anchored wr→r.
  it("generate candidates applies known rewrites", () => {
    const cands = generateCandidates("Wythmoor").map((c) => c.toLowerCase());
    expect(cands.some((c) => c.includes("with"))).toBe(true);
    const candsX = generateCandidates("Wrexmoor").map((c) => c.toLowerCase());
    expect(candsX.some((c) => c.startsWith("r"))).toBe(true);
  });

  // Catches: the limit ignored, so the sweep evaluates every candidate.
  it("generate candidates respects limit", () => {
    expect(generateCandidates("Knochelphy", 3).length).toBeLessThanOrEqual(3);
  });

  // The original drove this through the normalizer; T7 ports normalize(), and this pins the lexicon half of that path.
  // Catches: respellingsOf dropping entries, so a lexicon.v1 document's respellings never reach the text.
  it("normalizer applies lexicon", () => {
    const lexicon = loadLexicon({ schema: "lexicon.v1", entries: [{ term: "Zelvanian", respell: "Zelvayan" }] });
    expect(respeller(respellingsOf(lexicon)).apply("A Zelvanian striker signed today.")).toBe("A Zelvayan striker signed today.");
  });
});

describe("respelling candidates match the Python original", () => {
  // Recorded from audiobook generate_candidates. Catches: rules applied in another order, or not accreted onto earlier ones.
  it.each([
    ["Wythmoor", ["Withmoor"]],
    ["Wrexmoor", ["Rexmoor", "Wreksmoor", "Reksmoor"]],
    ["Knochelphy", ["Nochelphy", "Knochelfy", "Nochelfy", "Knochelphi", "Nochelfi", "Knokelphy", "Nokelfi"]],
    ["Taughwick", ["Tawwick", "Tawick"]],
  ])("%s", (word, expected) => {
    expect(generateCandidates(word)).toEqual(expected);
  });
});

describe("lexicon.v1", () => {
  // Catches: either pre-v1 shape rejected, so neither product can adopt the schema without rewriting its file first.
  it("upgrades a flat respelling map and an unversioned entries list", () => {
    const flat = loadLexicon({ _comment: "verified entries only", Wrexmoor: "Rexmor" });
    const unversioned = loadLexicon({ entries: [{ term: "CI", spoken: "C I" }] });

    expect([flat, unversioned]).toEqual([
      { schema: "lexicon.v1", entries: [{ term: "Wrexmoor", respell: "Rexmor" }] },
      { schema: "lexicon.v1", entries: [{ term: "CI", spoken: "C I" }] },
    ]);
  });

  // Catches: a respelling allowed to hold a space, which a voice reads as two words.
  it("rejects a respelling that is not a single token", () => {
    const result = LexiconSchema.safeParse({ schema: "lexicon.v1", entries: [{ term: "Tavi", respell: "Taa vee" }] });
    expect(result.success).toBe(false);
  });

  // Catches: the phonemes and evidence fields dropped from the schema, or unknown keys passed through silently.
  it("keeps phonemes and evidence and refuses unknown keys", () => {
    const entry = { term: "Zindlex", phonemes: { misaki: "zˈɪndlɛks" }, evidence: { tool: "stt", before: 0.4, after: 1, at: "2026-10-14" } };

    const kept = loadLexicon({ schema: "lexicon.v1", entries: [entry] });
    const unknown = LexiconSchema.safeParse({ schema: "lexicon.v1", entries: [{ ...entry, verified: true }] });

    expect([kept.entries, unknown.success]).toEqual([[entry], false]);
  });
});
