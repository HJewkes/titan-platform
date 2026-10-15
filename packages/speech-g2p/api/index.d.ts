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

interface MisakiToIpaOptions {
    /** "keep" leaves ˈ and ˌ in place (default); "strip" removes them. */
    stress?: "keep" | "strip";
}
declare function misakiToIpa(phonemes: string, options?: MisakiToIpaOptions): string;

export { type G2pToken, type MisakiToIpaOptions, type PosTagger, type RawToken, type Tokenizer, misakiToIpa };
