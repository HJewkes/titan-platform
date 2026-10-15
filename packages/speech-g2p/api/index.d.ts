/** A token as the spaCy tokenizer reports it: surface text, character offset, and trailing whitespace. */
interface RawToken {
    text: string;
    idx: number;
    whitespace: string;
}
/** One misaki output token. Structurally satisfies speech-vet's `PhonemeToken`. */
interface G2pToken {
    text: string;
    tag: string;
    phonemes: string | null;
    whitespace: string;
    rating: number | null;
}
interface Tokenizer {
    tokenize(text: string): RawToken[];
}
interface PosTagger {
    /** One Penn Treebank tag per token, in token order. */
    tag(text: string, tokens: readonly RawToken[]): string[];
}

export type { G2pToken, PosTagger, RawToken, Tokenizer };
