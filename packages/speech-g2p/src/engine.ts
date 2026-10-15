// Port of misaki 0.9.4 `Lexicon.__call__`, `G2P.token_context`, `resolve_tokens` and `G2P.__call__`
// (en.py:476-493, 619-712), Apache-2.0. US English, misaki version 1.0 phonemes (ɾ as T, ʔ as t).
import { suffixEd, suffixIng, suffixS, type Lexicon, type Pronunciation, type TokenContext } from "./lexicon.js";
import { mergeTokens, stressWeight, type MToken } from "./merge.js";
import { appendCurrency, getNumber, isNumber, numericIfNeeded, type NumberLexicon } from "./numbers.js";
import { foldLeft, preprocess, retokenize, tokenize, type TaggedToken, type Word } from "./pipeline.js";
import { applyStress, PRIMARY_STRESS } from "./stress.js";
import type { G2pToken } from "./types.js";

interface EngineOptions {
  lexicon: Lexicon;
  /** Tokens and Penn tags for the preprocessed text, as spaCy's pipeline gives them. */
  analyze: (text: string) => TaggedToken[];
  /** Phonemes for a token the lexicon cannot read (misaki's espeak fallback, rating 2), or `null`. */
  fallback?: ((token: G2pToken) => string | null) | null;
  /** What a token with no phonemes contributes to the joined string. */
  unk?: string;
}

const UNKNOWN: Pronunciation = [null, null];
const VOWELS = new Set("AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ");
const CONSONANTS = new Set("bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ");
const NON_QUOTE_PUNCTS = new Set(";:,.!?—…");
const SUBTOKEN_JUNKS = new Set("',-._‘’/");
const isJunk = (text: string): boolean => [...text].every((c) => SUBTOKEN_JUNKS.has(c));

function toG2pToken(tk: MToken): G2pToken {
  return { text: tk.text, tag: tk.tag, phonemes: tk.phonemes, whitespace: tk.whitespace, rating: tk._.rating ?? tk.rating };
}

/** misaki `token_context`: whether the word read just now (the next one in text order) starts with a vowel. */
function tokenContext(ctx: TokenContext, ps: string | null, token: MToken): TokenContext {
  let futureVowel = ctx.futureVowel;
  const first = ps ? [...ps].find((c) => VOWELS.has(c) || CONSONANTS.has(c) || NON_QUOTE_PUNCTS.has(c)) : undefined;
  if (first !== undefined) futureVowel = NON_QUOTE_PUNCTS.has(first) ? null : VOWELS.has(first);
  const futureTo = token.text === "to" || token.text === "To" || (token.text === "TO" && (token.tag === "TO" || token.tag === "IN"));
  return { futureVowel, futureTo };
}

// 0 letter, 1 ASCII digit, 2 anything else.
const charClass = (c: string): number => (/^\p{L}$/u.test(c) ? 0 : /^[0-9]$/.test(c) ? 1 : 2);

function needsPrespace(text: string): boolean {
  if (text.includes(" ") || text.includes("/")) return true;
  return new Set([...text].filter((c) => !SUBTOKEN_JUNKS.has(c)).map(charClass)).size > 1;
}

type Stressed = readonly [primary: boolean, weight: number, index: number];
const compareStressed = (a: Stressed, b: Stressed): number => Number(a[0]) - Number(b[0]) || a[1] - b[1] || a[2] - b[2];

function demoteWeakerStress(tokens: MToken[]): void {
  const indices: Stressed[] = tokens.flatMap((tk, i) =>
    tk.phonemes ? [[tk.phonemes.includes(PRIMARY_STRESS), stressWeight(tk.phonemes), i] as const] : []
  );
  if (indices.length === 2 && [...tokens[indices[0]![2]]!.text].length === 1) {
    const tk = tokens[indices[1]![2]]!;
    tk.phonemes = applyStress(tk.phonemes, -0.5);
    return;
  }
  const primaries = indices.filter(([primary]) => primary).length;
  if (indices.length < 2 || primaries <= Math.floor((indices.length + 1) / 2)) return;
  for (const [, , i] of indices.sort(compareStressed).slice(0, Math.floor(indices.length / 2))) {
    tokens[i]!.phonemes = applyStress(tokens[i]!.phonemes, -0.5);
  }
}

/** misaki `resolve_tokens`: fills punctuation and junk parts of a word, then spaces or destresses its parts. */
function resolveTokens(tokens: MToken[]): void {
  const prespace = needsPrespace(mergeTokens(tokens).text);
  tokens.forEach((tk, i) => {
    if (tk.phonemes === null) {
      if (i === tokens.length - 1 && NON_QUOTE_PUNCTS.has(tk.text)) [tk.phonemes, tk._.rating] = [tk.text, 3];
      else if (isJunk(tk.text)) [tk.phonemes, tk._.rating] = ["", 3];
    } else if (i > 0) tk._.prespace = prespace;
  });
  if (!prespace) demoteWeakerStress(tokens);
}

const CAP_STRESSES = [0.5, 2] as const;

/** misaki `G2P` over an injected tokenizer and tagger: text in, misaki tokens and the joined phoneme string out. */
export class MisakiEngine {
  private readonly lexicon: Lexicon;
  private readonly numbers: NumberLexicon;
  private readonly analyze: EngineOptions["analyze"];
  private readonly fallback: EngineOptions["fallback"];
  private readonly unk: string;

  constructor(options: EngineOptions) {
    const lexicon = options.lexicon;
    this.lexicon = lexicon;
    this.numbers = {
      lookup: (word, tag, stress, ctx) => lexicon.lookup(word, tag, stress, ctx),
      stemS: (word, tag, stress, ctx) => lexicon.stemS(word, tag, stress, ctx),
      suffixS,
      suffixEd,
      suffixIng,
    };
    this.analyze = options.analyze;
    this.fallback = options.fallback ?? null;
    this.unk = options.unk ?? "";
  }

  /** misaki `Lexicon.__call__`: the lexicon, then number reading, for one token or merged sub-tokens. */
  readWord(tk: MToken, ctx: TokenContext): Pronunciation {
    const word = [...(tk._.alias ?? tk.text).replace(/[‘’]/g, "'").normalize("NFKC")].map(numericIfNeeded).join("");
    const stress = word === word.toLowerCase() ? null : CAP_STRESSES[word === word.toUpperCase() ? 1 : 0];
    const [ps, rating] = this.lexicon.getWord(word, tk.tag, stress, ctx);
    if (ps !== null) return [applyStress(appendCurrency(ps, tk._.currency, this.numbers), tk._.stress), rating];
    if (!isNumber(word, tk._.isHead)) return UNKNOWN;
    const [num, numRating] = getNumber(word, tk._.currency, tk._.isHead, tk._.numFlags, this.numbers);
    return [applyStress(num, tk._.stress), numRating];
  }

  private fallBack(tk: MToken): Pronunciation {
    const ps = this.fallback ? this.fallback(toG2pToken(tk)) : null;
    return ps === null ? UNKNOWN : [ps, 2];
  }

  private readSingle(w: MToken, ctx: TokenContext): TokenContext {
    if (w.phonemes === null) [w.phonemes, w.rating] = this.readWord(w, ctx);
    if (w.phonemes === null && this.fallback) [w.phonemes, w.rating] = this.fallBack(w);
    return tokenContext(ctx, w.phonemes, w);
  }

  private fallBackWhole(w: MToken[]): void {
    const [head, ...rest] = w;
    [head!.phonemes, head!._.rating] = this.fallBack(mergeTokens(w));
    for (const tk of rest) [tk.phonemes, tk._.rating] = ["", head!._.rating];
  }

  // Reads the longest known span ending at `right`, moving `right` left past each span read.
  private readParts(w: MToken[], ctx: TokenContext): TokenContext {
    let [left, right] = [0, w.length];
    while (left < right) {
      const span = w.slice(left, right);
      const tk = span.some((x) => x._.alias !== null || x.phonemes !== null) ? null : mergeTokens(span);
      const [ps, rating] = tk === null ? UNKNOWN : this.readWord(tk, ctx);
      if (ps !== null) {
        [w[left]!.phonemes, w[left]!._.rating] = [ps, rating];
        for (const x of w.slice(left + 1, right)) [x.phonemes, x.rating] = ["", rating];
        ctx = tokenContext(ctx, ps, tk!);
        [left, right] = [0, left];
      } else if (left + 1 < right) left++;
      else {
        right--;
        const last = w[right]!;
        if (last.phonemes === null && isJunk(last.text)) [last.phonemes, last._.rating] = ["", 3];
        else if (last.phonemes === null && this.fallback) {
          this.fallBackWhole(w);
          return ctx;
        }
        left = 0;
      }
    }
    resolveTokens(w);
    return ctx;
  }

  private readRightToLeft(words: Word[]): void {
    let ctx: TokenContext = { futureVowel: null, futureTo: false };
    for (const w of [...words].reverse()) ctx = Array.isArray(w) ? this.readParts(w, ctx) : this.readSingle(w, ctx);
  }

  phonemize(text: string): { phonemes: string; tokens: G2pToken[] } {
    const pre = preprocess(text);
    const words = retokenize(foldLeft(tokenize(pre, this.analyze(pre.text)), this.unk));
    this.readRightToLeft(words);
    const tokens = words.map((w) => (Array.isArray(w) ? mergeTokens(w, this.unk) : w));
    for (const tk of tokens) {
      if (tk.phonemes) tk.phonemes = tk.phonemes.replaceAll("ɾ", "T").replaceAll("ʔ", "t");
    }
    const phonemes = tokens.map((tk) => (tk.phonemes ?? this.unk) + tk.whitespace).join("");
    return { phonemes, tokens: tokens.map(toG2pToken) };
  }
}
