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

/**
 * Text normalization for narration: the general-purpose expansions any voice needs before it reads a text.
 *
 * Each step is one rewrite, and `normalize` runs a list of them in order. The default list is the mechanism half
 * of the audiobook normalizer: rates ("/week" to " per week"), initialisms, clock times, ages, ordinals, currency,
 * decimals, large cardinals and whitespace. A product's own rules (book preambles, house punctuation, its
 * lexicon) are steps it writes and splices into the list.
 *
 * Order matters inside the number steps: currency runs before decimals, so "£1.4m" is read as one amount, and
 * decimals run before cardinals, so "147.8" is not split into "one hundred forty-seven.8". Numbers under 100 are
 * left as digits, which voices read well.
 */

interface NormalizeStep {
    readonly name: string;
    readonly apply: (text: string) => string;
}
/** Rate units a slash reads as "per"; a domain adds its own ("match", "game") through `rateStep`. */
declare const RATE_UNITS: readonly string[];
/** "/week" reads as " per week"; any other slash is left to the caller's policy. */
declare function rateStep(units?: Iterable<string>): NormalizeStep;
/** Dotted letters for all-caps initialisms, through {@link spellInitialisms}. */
declare function initialismStep(opts?: InitialismOptions): NormalizeStep;
/** "7 pm" and "7 p.m." read as "seven P M". */
declare const timeStep: NormalizeStep;
/** "15-year-old" reads as "fifteen-year-old". */
declare const ageStep: NormalizeStep;
/** "21st" reads as "twenty-first"; only one- and two-digit ordinals are expanded. */
declare const ordinalStep: NormalizeStep;
/** "£1.4m" reads as "one point four million pounds", with the currency word last. */
declare const currencyStep: NormalizeStep;
/** "147.8" reads as "one hundred forty-seven point eight", and "0.28m" as "two hundred eighty thousand". */
declare const decimalStep: NormalizeStep;
/** Comma-grouped numbers and numbers of 100 or more read as words; "007" and "42" stay digits. */
declare const cardinalStep: NormalizeStep;
/** Tabs and runs of spaces become one space, three or more newlines a paragraph break, and the ends are trimmed. */
declare const whitespaceStep: NormalizeStep;
/** The audiobook normalizer's `normalize_numbers`, in its order. */
declare const NUMBER_STEPS: readonly NormalizeStep[];
declare const DEFAULT_NORMALIZE_STEPS: readonly NormalizeStep[];
/** Runs `steps` over `text` in order; a caller filters or splices the default list to pick its own. */
declare function normalize(text: string, steps?: readonly NormalizeStep[]): string;

/**
 * American cardinal words, with no "and": 147 is "one hundred forty-seven". From a trillion up the digits are
 * returned unchanged, as the audiobook original does.
 */
declare function numberToWords(n: number): string;
/** Ordinal words: 21 is "twenty-first", 42 is "forty-second". */
declare function numberToOrdinal(n: number): string;
/** A decimal fraction read digit by digit: "176" is "one seven six". */
declare function spellDigits(digits: string): string;

export { DEFAULT_NORMALIZE_STEPS, type HeteronymTable, HeteronymTableSchema, type InitialismOptions, type Lexicon, type LexiconEntry, LexiconEntrySchema, LexiconSchema, NUMBER_STEPS, type NormalizeStep, type PhonemeToken, RATE_UNITS, type ReadingFinding, type ReadingStatus, type Respeller, SHOUTED_TWO_LETTER_WORDS, SPELLED_INITIALISMS, VOWELLESS_INTERJECTIONS, ageStep, cardinalStep, checkReadings, currencyStep, decimalStep, englishHeteronyms, g2pText, generateCandidates, initialismStep, isInitialism, loadLexicon, normalize, numberToOrdinal, numberToWords, ordinalStep, plainText, rateStep, readingOf, respeller, respellingsOf, spellDigits, spellInitialisms, timeStep, tokenDump, whitespaceStep };
