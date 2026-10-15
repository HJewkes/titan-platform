import { describe, expect, it } from "vitest";
import golden from "./fixtures/misaki-tokens.json" with { type: "json" };
import { checkReadings, englishHeteronyms, tokenDump, type PhonemeToken } from "./heteronyms.js";
import { g2pText, plainText } from "./markup.js";

// Ported from the motion-spike test_phonemes.py cases. Tokens are golden misaki 0.9.4 dumps of g2pText(spoken), so no G2P runs here.
const MEMOIZES = "mˈɛmoʊˌaɪzᵻz";
const ZINDLEX = "zˈɪndlɛks";

const goldenTokens: Record<string, PhonemeToken[]> = golden.tokens;
const goldenChunks: Record<string, string[]> = golden.chunks;

function tokensOf(spoken: string): PhonemeToken[] {
  const tokens = goldenTokens[spoken];
  if (tokens === undefined) throw new Error(`no golden tokens for ${spoken}`);
  return tokens;
}

function phonemesOf(dump: readonly PhonemeToken[], word: string): Array<string | null> {
  return dump.filter((token) => token.text === word).map((token) => token.phonemes);
}

function statuses(spoken: string): Array<[string, string, string]> {
  return checkReadings(spoken, tokensOf(spoken)).map((finding) => [finding.word, finding.reading, finding.status]);
}

describe("PhonemeDump", () => {
  // Catches: the dump re-deriving phonemes or dropping whitespace, so the override or the chunk the voice got differs.
  it("dump holds the phonemes the voice received including overrides", () => {
    const spoken = `Each cache [memoizes](/${MEMOIZES}/) one call; we live here.`;

    const dump = tokenDump(tokensOf(spoken));

    expect(phonemesOf(dump, "memoizes")).toEqual([MEMOIZES]);
    expect(phonemesOf(dump, "live")).toEqual(["lˈɪv"]);
    const joined = dump.map((token) => `${token.phonemes}${token.whitespace ? " " : ""}`).join("").trim();
    expect([joined]).toEqual(goldenChunks[spoken]);
  });
});

describe("HeteronymCheck", () => {
  // Catches: a reading pattern matched anywhere instead of at the start, or stress marks left in, so live/adj reads unknown.
  it("undeclared live warns with each reading", () => {
    expect(statuses("We live here, and the show is live tonight.")).toEqual([
      ["live", "verb", "warn"],
      ["live", "adj", "warn"],
    ]);
  });

  // Catches: a declaration compared against the wrong token, so one of the two declared readings fails.
  it("declared live in both readings passes", () => {
    expect(statuses("We [live](=verb) here, and the show is [live](=adj) tonight.")).toEqual([
      ["live", "verb", "ok"],
      ["live", "adj", "ok"],
    ]);
  });

  // Catches: the check ignoring a declared mismatch, so the wrong-reading line passes as ok or warn.
  it("declared reading the g2p did not choose fails", () => {
    expect(statuses("The show is [live](=verb) tonight.")).toEqual([["live", "adj", "fail"]]);
  });

  // Catches: a declaration keyed by its word alone, so it applies to every occurrence of that word.
  it("declaration attaches to its own occurrence", () => {
    expect(statuses("We live here; the show is [live](=adj) tonight.")).toEqual([
      ["live", "verb", "warn"],
      ["live", "adj", "ok"],
    ]);
  });
});

describe("PronunciationOverride", () => {
  // Catches: g2pText stripping overrides as it strips declarations, or plainText keeping the link target.
  it("override sets the phonemes and leaves captions plain", () => {
    const spoken = `No cache [memoizes](/${MEMOIZES}/) like [Zindlex](/${ZINDLEX}/).`;

    const tokens = tokenDump(tokensOf(spoken));

    expect(phonemesOf(tokens, "memoizes")).toEqual([MEMOIZES]);
    expect(phonemesOf(tokens, "Zindlex")).toEqual([ZINDLEX]);
    expect(plainText(spoken)).toBe("No cache memoizes like Zindlex.");
  });

  // Catches: an override treated as undeclared, so a forced reading warns instead of reporting forced.
  it("override forces a heteronym reading against the g2p", () => {
    expect(statuses("We [live](/lˈIv/) here.")).toEqual([["live", "adj", "forced"]]);
  });
});

describe("heteronym table", () => {
  // Catches: a word dropped from heteronyms/en.json, or a form mapped to no word, so its occurrences go unchecked.
  it("ships the 19 English heteronyms, and every listed form is checked", () => {
    const words = Object.keys(englishHeteronyms.words);
    const forms = words.flatMap((word) => englishHeteronyms.words[word]!.forms.map((form) => ({ form, word })));

    const unchecked = forms.filter(({ form }) => checkReadings(form, [{ text: form, phonemes: null, whitespace: "" }]).length !== 1);

    expect([words.length, unchecked]).toEqual([19, []]);
  });

  // Catches: g2pText keeping a declaration's `(=reading)` target, which the voice would then read aloud.
  it("g2p text reduces declarations to the bare word and keeps overrides", () => {
    expect(g2pText(`We [live](=verb) on [memoizes](/${MEMOIZES}/).`)).toBe(`We live on [memoizes](/${MEMOIZES}/).`);
  });
});
