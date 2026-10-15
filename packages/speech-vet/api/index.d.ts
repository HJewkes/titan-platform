import { z } from 'zod';
import { Audio } from '@titan-design/speech-stt';

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

/** Raw espeak-style IPA for `text` in `voice` (`espeak-ng -q --ipa=3 -v <voice>`), or "" on failure. */
type PhoneG2p = (text: string, voice: string) => string;
/** The accent expected phones are predicted in when the caller names none. */
declare const DEFAULT_PHONE_VOICE = "en-us";
/** Above this distance the audio mispronounces the word; below it a text mismatch is the transcriber's. */
declare const XTTS_FAULT_THRESHOLD = 0.45;
/** Proper nouns and coinages, where the expected side is the unreliable one. */
declare const XTTS_FAULT_THRESHOLD_UNUSUAL = 0.7;
/** Words with fewer expected phones never get an `xtts` verdict: the distance is too coarse. */
declare const MIN_PHONES_FOR_VERDICT = 3;
/** Words of up to this many expected phones are judged at `XTTS_FAULT_THRESHOLD_SHORT`. */
declare const SHORT_WORD_MAX_PHONES = 4;
declare const XTTS_FAULT_THRESHOLD_SHORT = 0.7;
/** A mapped span shorter than this share of the expected phones means the alignment degenerated. */
declare const MIN_SPAN_RATIO_FOR_VERDICT = 0.5;
/**
 * Drops stress, length and tie marks and folds the allophones the two sides disagree on for free:
 * the flap and glottal stop to t, open schwa to schwa, and a syllabic n, l or m to schwa plus the consonant.
 */
declare function cleanIpa(ipa: string): string;
/** Normalized phone edit distance in [0, 1] after cleaning both sides; 0 is the same pronunciation. */
declare function phonemeDistance(expected: string, actual: string): number;
/** The best distance of `expected` against any window of a whole chunk's phones; 1 when it is not found. */
declare function phoneMatchDistance(expected: string, actualFull: string): number;
/** Documented weak forms of English function words, in espeak's en-us inventory. Deliberately closed. */
declare const WEAK_FORMS: ReadonlyMap<string, readonly string[]>;
/** Every pronunciation accepted for `word`: the citation form, then its cleaned weak forms. */
declare function admissiblePhones(word: string, citation: string): string[];
interface PhoneG2pOptions {
    g2p: PhoneG2p;
    /** Defaults to `DEFAULT_PHONE_VOICE`. */
    voice?: string;
}
/** Cleaned phones of `text` from the G2P. */
declare function expectedPhones(text: string, { g2p, voice }: PhoneG2pOptions): string;
/** Per-word phones of a whole sentence, so each word gets its in-context reading; words that clean to nothing are dropped. */
declare function g2pSentence(text: string, { g2p, voice }: PhoneG2pOptions): string[];

/** Runs `argv[0]` with the rest as arguments and returns its stdout. Throws on a failed or timed-out run. */
type EspeakRunner = (argv: readonly string[], options: {
    timeoutMs: number;
}) => string;
interface EspeakCliOptions {
    /** Defaults to `DEFAULT_PHONE_VOICE`. */
    voice?: string;
    /** The espeak-ng executable; defaults to `espeak-ng` on the PATH. */
    bin?: string;
    /** Replaces the process spawn, so tests never need the binary. */
    run?: EspeakRunner;
    /** Called once per failed run; the G2P itself returns "" so one bad chunk never aborts a scan. */
    onError?: (error: unknown) => void;
}
declare const ESPEAK_TIMEOUT_MS = 10000;
/**
 * A `PhoneG2p` backed by the espeak-ng CLI, run exactly as the audiobook backend runs it:
 * `espeak-ng -q --ipa=3 -v <voice> <text>`. espeak-ng is a GPL binary the caller installs
 * (apt or brew); it is called as a process and never bundled or linked.
 */
declare function espeakCliG2p(options?: EspeakCliOptions): PhoneG2p;
/** The espeak-ng version (`1.52.0`), or `null` when the binary is missing or prints no version. */
declare function espeakVersion(options?: Pick<EspeakCliOptions, "bin" | "run">): string | null;

/**
 * Positional verdicts over a chunk's phones, a port of the verdict half of the audiobook backend's
 * `validation/phonemes.py`. Arrays here hold one code point per item, so indexes match Python's.
 */

/** A run of at least this many audio phones with no source text is a hallucinated outburst. */
declare const HALLUCINATION_MIN_PHONES = 5;
/** Phones after the last expected phone count from one: nothing follows for the recognizer to smear into. */
declare const TAIL_STRAY_MIN_PHONES = 1;
/** `xtts`: the audio mispronounces the word. `whisper`: the audio is fine. `inconclusive`: the alignment degenerated. */
type PhoneSource = "xtts" | "whisper" | "inconclusive";
interface WordVerdict {
    word: string;
    /** The admissible form the audio came closest to. */
    expectedPhones: string;
    actualPhones: string;
    /** Rounded to 3 places, half to even. */
    distance: number;
    source: PhoneSource;
}
interface Hallucination {
    phones: string;
    length: number;
    /** Where the run starts, 0 to 1 through the audio, rounded to 2 places. */
    position: number;
    severity: number;
}
interface TailArtifact {
    phones: string;
    length: number;
    /** The expected phones the stray run replaced, usually none. */
    displaced: string;
    severity: number;
}
interface WordVerdictOptions extends PhoneG2pOptions {
    /** The words to score; none scores nothing. */
    targets?: Iterable<string>;
    /** Targets judged at `XTTS_FAULT_THRESHOLD_UNUSUAL`, such as proper nouns. */
    unusual?: Iterable<string>;
}
interface HallucinationOptions extends PhoneG2pOptions {
    minRun?: number;
}
interface TailArtifactOptions extends PhoneG2pOptions {
    minPhones?: number;
}
/** Recognizes raw phones; `wav2vec2Recognizer` from speech-stt fits. */
interface PhoneRecognizer {
    recognize(audio: Audio): Promise<string>;
}
/**
 * A verdict per target word: its expected phones are located in the chunk's expected phones, and the
 * positionally aligned span of the audio's phones is scored, so a garbled word scores high even when
 * its phones occur elsewhere in the chunk.
 */
declare function chunkWordVerdicts(text: string, actualFull: string, options: WordVerdictOptions): WordVerdict[];
/** Runs of audio phones that match no source text: the babble a voice model injects, usually at boundaries. */
declare function detectHallucinations(text: string, actualFull: string, options: HallucinationOptions): Hallucination[];
/**
 * Phones the audio runs on with after the chunk's last expected phone, or null. Only the final alignment
 * opcode counts, and the stray run must outnumber the expected phones it displaced, so a mispronounced last
 * word stays the word verdict's job. A chunk whose text ends in a digit is never flagged.
 */
declare function detectTailArtifact(text: string, actualFull: string, options: TailArtifactOptions): TailArtifact | null;
/** The recognizer's phones, cleaned. Cleaning runs on every read, so a cache of raw decodes follows fold changes. */
declare function recognizePhones(recognizer: PhoneRecognizer, audio: Audio): Promise<string>;

export { DEFAULT_NORMALIZE_STEPS, DEFAULT_PHONE_VOICE, ESPEAK_TIMEOUT_MS, type EspeakCliOptions, type EspeakRunner, HALLUCINATION_MIN_PHONES, type Hallucination, type HallucinationOptions, type HeteronymTable, HeteronymTableSchema, type InitialismOptions, type Lexicon, type LexiconEntry, LexiconEntrySchema, LexiconSchema, MIN_PHONES_FOR_VERDICT, MIN_SPAN_RATIO_FOR_VERDICT, NUMBER_STEPS, type NormalizeStep, type PhoneG2p, type PhoneG2pOptions, type PhoneRecognizer, type PhoneSource, type PhonemeToken, RATE_UNITS, type ReadingFinding, type ReadingStatus, type Respeller, SHORT_WORD_MAX_PHONES, SHOUTED_TWO_LETTER_WORDS, SPELLED_INITIALISMS, TAIL_STRAY_MIN_PHONES, type TailArtifact, type TailArtifactOptions, VOWELLESS_INTERJECTIONS, WEAK_FORMS, type WordVerdict, type WordVerdictOptions, XTTS_FAULT_THRESHOLD, XTTS_FAULT_THRESHOLD_SHORT, XTTS_FAULT_THRESHOLD_UNUSUAL, admissiblePhones, ageStep, cardinalStep, checkReadings, chunkWordVerdicts, cleanIpa, currencyStep, decimalStep, detectHallucinations, detectTailArtifact, englishHeteronyms, espeakCliG2p, espeakVersion, expectedPhones, g2pSentence, g2pText, generateCandidates, initialismStep, isInitialism, loadLexicon, normalize, numberToOrdinal, numberToWords, ordinalStep, phoneMatchDistance, phonemeDistance, plainText, rateStep, readingOf, recognizePhones, respeller, respellingsOf, spellDigits, spellInitialisms, timeStep, tokenDump, whitespaceStep };
