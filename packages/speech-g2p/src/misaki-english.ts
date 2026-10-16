import { readFileSync } from "node:fs";
import nlp from "compromise";
import { compromiseTagger } from "./compromise-tagger.js";
import { MisakiEngine } from "./engine.js";
import { Lexicon } from "./lexicon.js";
import { dataVersion, loadLexiconData, sha256Hex } from "./lexicon-data.js";
import type { TaggedToken } from "./pipeline.js";
import { spacyTokenizer } from "./spacy-tokenizer.js";
import type { G2pToken, PosTagger, Tokenizer } from "./types.js";

const TOKENIZER_DATA_URL = new URL("../data/spacy-en-tokenizer.json", import.meta.url);

export interface MisakiEnglishOptions {
  /** Defaults to the spaCy en_core_web_sm 3.8.0 tokenizer port. */
  tokenizer?: Tokenizer;
  /** Defaults to the compromise-backed Penn tagger. */
  tagger?: PosTagger;
  /** Phonemes for a word the lexicon cannot read (misaki's espeak fallback, rating 2), or `null` to leave it unread. */
  fallback?: (token: G2pToken) => string | null;
  /** What a token with no phonemes contributes to the joined string. Default "", as Kokoro's pipeline uses. */
  unk?: string;
}

export interface G2p {
  /** Tokens in text order, after misaki's merge. Overrides from `[w](/ph/)` arrive with rating 5. */
  tokens(text: string): G2pToken[];
  /** misaki's joined string: each token's phonemes (or `unk`) plus its whitespace, with the tokens it came from. */
  phonemize(text: string): { phonemes: string; tokens: G2pToken[] };
  /** Changes when the lexicon, the tokenizer data or the compromise release changes: a cache key and model version. */
  readonly version: string;
}

/** A token speech-tts accepts: phonemes always a string. */
export interface TtsReadyToken {
  text: string;
  phonemes: string;
  whitespace: string;
}

let cachedVersion: string | null = null;

function g2pVersion(): string {
  cachedVersion ??= sha256Hex(
    Buffer.from(`${dataVersion()}\n${sha256Hex(readFileSync(TOKENIZER_DATA_URL))}\ncompromise ${nlp.version}`),
  ).slice(0, 16);
  return `misaki-0.9.4+${cachedVersion}`;
}

/** misaki 0.9.4 US English G2P in pure TypeScript: spaCy-compatible tokens, compromise tags, misaki's lexicon. */
export function misakiEnglish(options: MisakiEnglishOptions = {}): G2p {
  const tokenizer = options.tokenizer ?? spacyTokenizer();
  const tagger = options.tagger ?? compromiseTagger();
  const analyze = (text: string): TaggedToken[] => {
    const raw = tokenizer.tokenize(text);
    const tags = tagger.tag(text, raw);
    return raw.map((tk, i) => ({ ...tk, tag: tags[i] ?? "" }));
  };
  const engine = new MisakiEngine({
    lexicon: new Lexicon(loadLexiconData()),
    analyze,
    fallback: options.fallback ?? null,
    unk: options.unk ?? "",
  });
  return {
    tokens: (text) => engine.phonemize(text).tokens,
    phonemize: (text) => engine.phonemize(text),
    version: g2pVersion(),
  };
}

/** Tokens in speech-tts's `TtsToken` shape: a token with no phonemes reads as `unk`, as Kokoro's `unk=''` does. */
export function ttsTokens(tokens: readonly G2pToken[], unk = ""): TtsReadyToken[] {
  return tokens.map(({ text, phonemes, whitespace }) => ({ text, phonemes: phonemes ?? unk, whitespace }));
}
