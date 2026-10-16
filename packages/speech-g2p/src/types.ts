/** A token as the spaCy tokenizer reports it: surface text, character offset, and trailing whitespace. */
export interface RawToken {
  text: string;
  idx: number;
  whitespace: string;
}

/** One misaki output token. Structurally satisfies speech-vet's `PhonemeToken`. */
export interface G2pToken {
  text: string;
  tag: string;
  phonemes: string | null;
  whitespace: string;
  rating: number | null;
}

export interface Tokenizer {
  tokenize(text: string): RawToken[];
}

export interface PosTagger {
  /** One Penn Treebank tag per token, in token order. */
  tag(text: string, tokens: readonly RawToken[]): string[];
}
