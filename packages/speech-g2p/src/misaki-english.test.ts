import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { misakiEnglish, ttsTokens } from "./misaki-english.js";
import type { G2pToken, RawToken } from "./types.js";

// Structural copies of the tier-2 consumers' types (speech-vet heteronyms.ts, speech-tts types.ts); a tier-1
// package cannot import them.
interface PhonemeToken {
  text: string;
  phonemes: string | null;
  whitespace: string;
}
interface TtsToken {
  text: string;
  phonemes?: string;
  whitespace?: string;
}

const g2p = misakiEnglish();

// Each misakiEnglish() reloads the dictionary (~0.6 s measured); CI load once stretched one test past vitest's 5 s default.
const LOAD_TIMEOUT_MS = 20_000;

describe("misakiEnglish", { timeout: LOAD_TIMEOUT_MS }, () => {
  let fallbackG2p: ReturnType<typeof misakiEnglish>;

  beforeAll(() => {
    fallbackG2p = misakiEnglish({ fallback: (tk) => (tk.text === "Zxqv" ? "zˈɪk" : null) });
  }, LOAD_TIMEOUT_MS);

  it("reads a sentence into misaki tokens and their joined phoneme string", () => {
    const { phonemes, tokens } = g2p.phonemize("We live here.");

    expect(tokens.map((tk) => [tk.text, tk.phonemes])).toEqual([
      ["We", "wˌi"],
      ["live", "lˈɪv"],
      ["here", "hˈɪɹ"],
      [".", "."],
    ]);
    expect(phonemes).toBe("wˌi lˈɪv hˈɪɹ.");
  });

  it("keeps an override's phonemes verbatim with rating 5", () => {
    const memoizes = g2p.tokens("Each cache [memoizes](/mˈɛməwˌIzᵻz/) one call.").find((tk) => tk.text === "memoizes");

    expect(memoizes).toMatchObject({ phonemes: "mˈɛməwˌIzᵻz", rating: 5 });
  });

  it("leaves a word no lexicon knows unread unless a fallback reads it", () => {
    const unread = g2p.tokens("Zxqv here.")[0];
    const read = fallbackG2p.tokens("Zxqv here.")[0];

    expect(unread?.phonemes).toBeNull();
    expect(read).toMatchObject({ phonemes: "zˈɪk", rating: 2 });
  });

  it("runs on an injected tokenizer and tagger", () => {
    const tokenizer = { tokenize: (text: string): RawToken[] => [{ text, idx: 0, whitespace: "" }] };
    const tagger = { tag: (_text: string, tokens: readonly RawToken[]) => tokens.map(() => "NN") };

    expect(misakiEnglish({ tokenizer, tagger }).tokens("use")).toMatchObject([{ text: "use", tag: "NN", phonemes: "jˈus" }]);
  });

  it("reports a stable version naming misaki 0.9.4", () => {
    expect(g2p.version).toMatch(/^misaki-0\.9\.4\+[0-9a-f]{16}$/);
    expect(misakiEnglish().version).toBe(g2p.version);
  });

  it("gives tokens speech-vet accepts as PhonemeToken", () => {
    expectTypeOf(g2p.tokens("hi")).toExtend<PhonemeToken[]>();
  });
});

describe("ttsTokens", () => {
  const tokens: G2pToken[] = [
    { text: "Zxqv", tag: "NNP", phonemes: null, whitespace: " ", rating: null },
    { text: "here", tag: "RB", phonemes: "hˈɪɹ", whitespace: "", rating: 4 },
  ];

  it("reads a token with no phonemes as unk, empty by default as Kokoro's pipeline does", () => {
    expect(ttsTokens(tokens)).toEqual([
      { text: "Zxqv", phonemes: "", whitespace: " " },
      { text: "here", phonemes: "hˈɪɹ", whitespace: "" },
    ]);
    expect(ttsTokens(tokens, "❓")[0]?.phonemes).toBe("❓");
  });

  it("gives tokens speech-tts accepts as TtsToken", () => {
    expectTypeOf(ttsTokens(tokens)).toExtend<TtsToken[]>();
  });
});
