import { z } from 'zod';

/** The text the voice is given: `[w](/phonemes/)` overrides stay for misaki, `[w](=reading)` declarations become the bare word. */
declare function g2pText(spoken: string): string;
/** The text captions and word counts use, with all markup removed. */
declare function plainText(spoken: string): string;

/**
 * Per word, its readings in order, each a phoneme pattern matched at the start of the stress-stripped token phonemes
 * (misaki notation: I=aɪ, A=eɪ, O=oʊ, W=aʊ, Y=ɔɪ), and the spellings checked. Inflections that are not heteronyms are left out.
 */
declare const HeteronymTableSchema: z.ZodObject<{
    version: z.ZodNumber;
    notation: z.ZodLiteral<"misaki">;
    words: z.ZodRecord<z.ZodString, z.ZodObject<{
        readings: z.ZodRecord<z.ZodString, z.ZodString>;
        forms: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type HeteronymTable = z.infer<typeof HeteronymTableSchema>;
/** The 19-word English table, in misaki notation. */
declare const englishHeteronyms: HeteronymTable;
/** The token fields the check reads; a speech-g2p `G2pToken` satisfies it. */
interface PhonemeToken {
    text: string;
    phonemes: string | null;
    whitespace: string;
}
/**
 * `ok` and `fail` judge a `[w](=reading)` declaration, `forced` marks a `[w](/phonemes/)` override,
 * and `warn` is an undeclared occurrence.
 */
type ReadingStatus = "ok" | "fail" | "forced" | "warn";
interface ReadingFinding {
    word: string;
    /** One-based ordinal among the occurrences of this spelling in the line. */
    occurrence: number;
    phonemes: string | null;
    /** The reading the phonemes match, or `unknown`. */
    reading: string;
    declared: string | null;
    status: ReadingStatus;
}
/** The name of the first reading of `word` whose pattern matches the phonemes, or `unknown`. */
declare function readingOf(word: string, phonemes: string | null, table?: HeteronymTable): string;
/** One finding per heteronym occurrence among the G2P tokens of `g2pText(spoken)`: its reading, its declaration, and its status. */
declare function checkReadings(spoken: string, tokens: readonly PhonemeToken[], table?: HeteronymTable): ReadingFinding[];
/** Token text and the phonemes G2P chose for it, as the voice received them. */
declare function tokenDump(tokens: readonly PhonemeToken[]): PhonemeToken[];

declare const LexiconEntrySchema: z.ZodObject<{
    term: z.ZodString;
    spoken: z.ZodOptional<z.ZodString>;
    respell: z.ZodOptional<z.ZodString>;
    phonemes: z.ZodOptional<z.ZodObject<{
        misaki: z.ZodOptional<z.ZodString>;
        ipa: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    evidence: z.ZodOptional<z.ZodObject<{
        tool: z.ZodString;
        before: z.ZodNumber;
        after: z.ZodNumber;
        at: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
/** `lexicon.v1`: how each term is said aloud, by rewrite, respelling or phonemes. */
declare const LexiconSchema: z.ZodObject<{
    schema: z.ZodLiteral<"lexicon.v1">;
    entries: z.ZodArray<z.ZodObject<{
        term: z.ZodString;
        spoken: z.ZodOptional<z.ZodString>;
        respell: z.ZodOptional<z.ZodString>;
        phonemes: z.ZodOptional<z.ZodObject<{
            misaki: z.ZodOptional<z.ZodString>;
            ipa: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        evidence: z.ZodOptional<z.ZodObject<{
            tool: z.ZodString;
            before: z.ZodNumber;
            after: z.ZodNumber;
            at: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
type Lexicon = z.infer<typeof LexiconSchema>;
type LexiconEntry = z.infer<typeof LexiconEntrySchema>;
/**
 * Parses a `lexicon.v1` document. Also upgrades the two shapes that predate it: a flat `{ term: respelling }` map,
 * whose `_comment` key is dropped, and an unversioned `{ entries }` list. Throws a `ZodError` on anything else.
 */
declare function loadLexicon(json: unknown): Lexicon;
/** The `{ term: respelling }` map of the entries that carry a respelling. */
declare function respellingsOf(lexicon: Lexicon): Record<string, string>;

/** Whole-word, case-insensitive respelling of hard-to-pronounce words, for a voice whose only lever is the spelling. */
interface Respeller {
    readonly entries: Readonly<Record<string, string>>;
    /** Replaces every entry's word with its respelling; idempotent while no respelling is itself a key. */
    apply(text: string): string;
}
declare function respeller(map: Readonly<Record<string, string>>): Respeller;
/** Heuristic respelling candidates for a hard word, in rule order, without the word itself or case-insensitive repeats. */
declare function generateCandidates(word: string, limit?: number): string[];

/**
 * Spell out all-caps initialisms so a voice reads them letter by letter.
 *
 * A voice reads an unfamiliar all-caps token as a word ("ASAP" as "asaps"). Dotted letters ("A. S. A. P.") make it
 * say the letter names; bare spaced letters do not, because a lone "A" is read as the article. Not every all-caps
 * token is an initialism, though: prose shouts ordinary words ("I did NOT") and names acronyms said as words. So the
 * rule branches on token shape:
 *
 * - Two letters: spell out, except English two-letter words that only appear shouted (TO, IS, MY), interjections
 *   (OI, UM, OK), am/pm and Roman numerals.
 * - Three to five letters with no vowel (Y counts as one): spell out, since it cannot be read as a word (BBC),
 *   except interjections (HMM, HMPH).
 * - Three to five letters with a vowel: spell out only if listed. Most such tokens are shouted words, so a general
 *   rule here would spell out "NOT" and "BEST". A product adds its own domain's list through `spelled`.
 *
 * A trailing lowercase plural "s" stays on the last letter as "'s" ("CEOs" to "C. E. O's"), and tokens inside
 * contractions ("I'LL", "DON'T") are left alone.
 */
declare const SHOUTED_TWO_LETTER_WORDS: ReadonlySet<string>;
declare const VOWELLESS_INTERJECTIONS: ReadonlySet<string>;
/** General-English initialisms that contain a vowel; domain lists come from the caller. */
declare const SPELLED_INITIALISMS: ReadonlySet<string>;
interface InitialismOptions {
    /** Vowel-bearing tokens to spell out, beyond {@link SPELLED_INITIALISMS}. */
    spelled?: Iterable<string>;
}
/** Whether an all-caps token should be read letter by letter. */
declare function isInitialism(token: string, spelled?: ReadonlySet<string>): boolean;
/** Replaces every initialism in `text` with its dotted letters. */
declare function spellInitialisms(text: string, opts?: InitialismOptions): string;

export { type HeteronymTable, HeteronymTableSchema, type InitialismOptions, type Lexicon, type LexiconEntry, LexiconEntrySchema, LexiconSchema, type PhonemeToken, type ReadingFinding, type ReadingStatus, type Respeller, SHOUTED_TWO_LETTER_WORDS, SPELLED_INITIALISMS, VOWELLESS_INTERJECTIONS, checkReadings, englishHeteronyms, g2pText, generateCandidates, isInitialism, loadLexicon, plainText, readingOf, respeller, respellingsOf, spellInitialisms, tokenDump };
