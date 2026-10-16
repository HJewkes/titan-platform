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

interface MisakiEnglishOptions {
    /** Defaults to the spaCy en_core_web_sm 3.8.0 tokenizer port. */
    tokenizer?: Tokenizer;
    /** Defaults to the compromise-backed Penn tagger. */
    tagger?: PosTagger;
    /** Phonemes for a word the lexicon cannot read (misaki's espeak fallback, rating 2), or `null` to leave it unread. */
    fallback?: (token: G2pToken) => string | null;
    /** What a token with no phonemes contributes to the joined string. Default "", as Kokoro's pipeline uses. */
    unk?: string;
}
interface G2p {
    /** Tokens in text order, after misaki's merge. Overrides from `[w](/ph/)` arrive with rating 5. */
    tokens(text: string): G2pToken[];
    /** misaki's joined string: each token's phonemes (or `unk`) plus its whitespace, with the tokens it came from. */
    phonemize(text: string): {
        phonemes: string;
        tokens: G2pToken[];
    };
    /** Changes when the lexicon, the tokenizer data or the compromise release changes: a cache key and model version. */
    readonly version: string;
}
/** A token speech-tts accepts: phonemes always a string. */
interface TtsReadyToken {
    text: string;
    phonemes: string;
    whitespace: string;
}
/** misaki 0.9.4 US English G2P in pure TypeScript: spaCy-compatible tokens, compromise tags, misaki's lexicon. */
declare function misakiEnglish(options?: MisakiEnglishOptions): G2p;
/** Tokens in speech-tts's `TtsToken` shape: a token with no phonemes reads as `unk`, as Kokoro's `unk=''` does. */
declare function ttsTokens(tokens: readonly G2pToken[], unk?: string): TtsReadyToken[];

interface MisakiToIpaOptions {
    /** "keep" leaves ˈ and ˌ in place (default); "strip" removes them. */
    stress?: "keep" | "strip";
}
declare function misakiToIpa(phonemes: string, options?: MisakiToIpaOptions): string;

export { type G2p, type G2pToken, type MisakiEnglishOptions, type MisakiToIpaOptions, type PosTagger, type RawToken, type Tokenizer, type TtsReadyToken, misakiEnglish, misakiToIpa, ttsTokens };
