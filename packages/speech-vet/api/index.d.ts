import { z } from 'zod';
import { G2p } from '@titan-design/speech-g2p';
import { Audio, Transcript, SttCapabilities, SttProvider, WordDiff } from '@titan-design/speech-stt';
import { TtsProvider, SynthesizeOptions, Synthesis } from '@titan-design/speech-tts';

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
/**
 * One finding per heteronym occurrence among the G2P tokens of `g2pText(spoken)`: its reading, its declaration, and its status.
 * A `[w](=reading)` declaration that no token matches is a `fail` finding with `phonemes: null`, never dropped.
 */
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
 * whose `_comment` key is dropped, and an unversioned `{ entries }` list. Throws a `ZodError` on anything else, and an
 * `Error` naming both terms when two terms differ only in case, since terms match case-insensitively and one would be lost.
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
 * A `PhoneG2p` backed by speech-g2p's pure-TypeScript misaki G2P, so expected phones need no espeak-ng binary.
 * Each token becomes one IPA word with stress marks and punctuation removed, as the espeak path's cleaned words
 * have neither; a token with no phones becomes an empty word, which `g2pSentence` drops. Misaki is US English
 * only, so the `voice` argument is ignored. Verdict thresholds were tuned on espeak, so verdicts can differ.
 */
declare function misakiIpaG2p(g2p: Pick<G2p, "tokens">): PhoneG2p;

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

/** Misaki phonemes to IPA; speech-g2p's `misakiToIpa` fits. */
type MisakiToIpa = (misaki: string) => string;
interface HeardReadingOptions {
    toIpa: MisakiToIpa;
    table?: HeteronymTable;
}
/** `inconclusive`: the word's span in the audio is too short, or two readings fit it equally well. */
type HeardStatus = "ok" | "fail" | "inconclusive";
interface HeardReading {
    word: string;
    /** One-based ordinal among the occurrences of this spelling in the line. */
    occurrence: number;
    declared: string;
    /** The reading the audio's phones fit best, or `unknown`. */
    heard: string;
    /** The audio's phones aligned to the word. */
    heardPhones: string;
    /** The heard reading's distance, rounded to 3 places, half to even. */
    distance: number;
    status: HeardStatus;
}
/** Every literal string a reading pattern matches. Only literals and `[...]` classes occur in the tables. */
declare function expandReading(pattern: string): string[];
/** Per reading of `word`, the cleaned IPA of every string its pattern matches. */
declare function readingIpa(word: string, toIpa: MisakiToIpa, table?: HeteronymTable): Record<string, string[]>;
/**
 * Per declared heteronym (`[w](=reading)`) among the tokens the voice was given, the reading the
 * recognizer heard and whether it is the declared one. `recognized` is the recognizer's raw phone string.
 */
declare function checkHeardReadings(spoken: string, tokens: readonly PhonemeToken[], recognized: string, { toIpa, table }: HeardReadingOptions): HeardReading[];

/**
 * Take selection, a port of the audiobook backend's `tts/verified.py` (the re-roll loop) and the
 * tail-fix half of `scripts/fix_pass.py` (`keepTake`, regressions, best-of-N). Every model or file
 * touch is injected, so nothing here synthesizes, recognizes or writes.
 */

/** A take must beat the shipped audio's flagged-word distance by this much to count as an improvement. */
declare const KEEP_TAKE_MARGIN = 0.06;
/**
 * How much further an already-faulty word must degrade to count as a regression. Only words the take
 * leaves over the fault threshold are judged: a whole-chunk re-synthesis re-renders every word, so
 * sub-threshold distances jitter and scoring that jitter rejects good takes.
 */
declare const WORSE_MARGIN = 0.06;
/** Re-rolls after the first take. */
declare const DEFAULT_RETRIES = 5;
/** The shortest word, in letters, that a tail check scores for regressions. */
declare const MIN_TARGET_WORD_LENGTH = 3;
interface TakeScore {
    /** Words the take pronounces worse than the shipped audio. */
    brokeWords: number;
    /** Phones the audio runs on with past the last word. */
    strayLength: number;
    /** The flagged word's phone distance; 0 when nothing was flagged. */
    distance: number;
}
/**
 * Whether `take` replaces `shipped`. Never a take that damages a word, however clean its tail. Between
 * the rest, a shorter stray wins outright; at equal stray the distance must fall by more than `margin`,
 * so a tie keeps what is already on disk.
 */
declare function keepTake(shipped: TakeScore, take: TakeScore, margin?: number): boolean;
/** A word's phone distance and whether the audio mispronounces it (`xtts` source). */
interface WordDistance {
    distance: number;
    faulty: boolean;
}
/**
 * Words this take actively damages: left genuinely mispronounced AND worse than shipped, either because
 * it was fine before or because it was already faulty and has degraded past `margin`. Distances, not a
 * set of faulty words: a word that was already faulty and degrades never enters or leaves such a set.
 */
declare function regressions(shipped: ReadonlyMap<string, WordDistance>, take: ReadonlyMap<string, WordDistance>, margin?: number): string[];
interface WordDistanceOptions extends PhoneG2pOptions {
    /** Defaults to the words of `text` with at least `MIN_TARGET_WORD_LENGTH` letters. */
    targets?: readonly string[];
    unusual?: Iterable<string>;
}
/** Per-word distance for one rendering's phones, keyed by word. */
declare function wordDistances(text: string, actualPhones: string, options: WordDistanceOptions): Map<string, WordDistance>;
interface RawTake<T> {
    /** The caller's handle on the take, such as a file path; returned for the winner. */
    value: T;
    audio: Audio;
}
interface VerifiedTake<T> {
    value: T;
    /** Takes made, the winner included. */
    attempts: number;
    /** False when every take babbled and the least severe was kept. */
    clean: boolean;
    /** Hallucinations of the kept take. */
    hallucinations: Hallucination[];
}
interface SynthesizeVerifiedOptions<T> extends PhoneG2pOptions {
    synthesize: (attempt: number) => Promise<RawTake<T>>;
    /** Absent, one plain take is made and returned unchecked. */
    recognizer?: PhoneRecognizer;
    retries?: number;
    minRun?: number;
    /** Called once for every take that is not returned, so temp files do not accumulate. */
    discard?: (value: T) => void | Promise<void>;
}
/**
 * Synthesizes `text`, re-rolling babbled takes. The first hallucination-free take wins; if every attempt
 * babbles, the least severe is kept (the earliest on a tie), so a chunk is never dropped.
 */
declare function synthesizeVerified<T>(text: string, options: SynthesizeVerifiedOptions<T>): Promise<VerifiedTake<T>>;
interface TailCandidate<T> {
    label: string;
    /** Synthesizes one take and returns its recognized phones. */
    take: () => Promise<{
        value: T;
        phones: string;
    }>;
}
interface BestTailTakeOptions<T> extends WordDistanceOptions {
    text: string;
    shippedPhones: string;
    /** The tail artifact the shipped audio was flagged for. */
    before: Pick<TailArtifact, "length">;
    candidates: readonly TailCandidate<T>[];
    margin?: number;
}
interface TailFix<T> {
    label: string;
    value: T;
    kept: boolean;
    brokeWords: string[];
    afterLength: number;
    afterPhones: string;
}
/**
 * Tries every candidate and returns the best: fewest damaged words first, then shortest stray. It is
 * kept only through `keepTake`, so a take that clears the stray but breaks a word is disqualified
 * outright, and a take no better than the shipped audio never ships.
 */
declare function bestTailTake<T>(options: BestTailTakeOptions<T>): Promise<TailFix<T>>;

/** The audiobook also declares `insertion`, but never emits it: extra heard words are STT noise. */
type DefectKind = "substitution" | "omission" | "low_confidence";
/** `smushed` is absent: the audiobook looks for `-` or `/` inside a token, and its tokens never hold one. */
type DefectCause = "number" | "stylized_elongation" | "unusual_word" | "chunk_boundary" | "muddy_audio";
/** One suspected TTS defect in a chunk. Audio times are seconds; absent when the transcript had none. */
interface Defect {
    kind: DefectKind;
    expected: string;
    heard: string;
    /** Unrounded, in [0, 1]. */
    severity: number;
    causes: DefectCause[];
    audioStart?: number;
    audioEnd?: number;
    context: string;
}
interface DefectOptions {
    /**
     * Read signal A: word `probability` (the severity boost) and segment `avgLogprob` /
     * `compressionRatio` (`low_confidence` defects). Default false, which ignores them even when
     * the transcript carries them. Derive it with `defectOptionsFor(stt)` rather than setting it.
     */
    confidence?: boolean;
}
/** A source word: its text as written, its match form (lowercase, elongation collapsed) and its code-point offset. */
interface WordToken {
    original: string;
    norm: string;
    start: number;
}
/** Signal A only when the provider's transcripts carry token log-probs. */
declare function defectOptionsFor(stt: {
    readonly capabilities: SttCapabilities;
}): DefectOptions;
/** Splits text into match tokens, keeping each word's written form and code-point offset. */
declare function tokenizeWords(text: string): WordToken[];
/** A capitalised word longer than three letters: a proper noun or coinage, which TTS and G2P both guess at. */
declare function isUnusualWord(word: string): boolean;
/**
 * Aligns a chunk's source text against its transcript and returns suspected defects, most
 * severe first (ties keep alignment order).
 */
declare function detectDefects(expected: string, transcript: Transcript, options?: DefectOptions): Defect[];
/**
 * Keeps the base defects a second, stronger STT pass agrees on: its own defects that share a
 * content word with a base defect, or for `low_confidence` overlap a base time window. The
 * confirming STT can differ from the base one, so it takes its own options.
 */
declare function confirmDefects(base: readonly Defect[], expected: string, confirmTranscript: Transcript, options?: DefectOptions): Defect[];

/** The metaphone code of `word`, equal to jellyfish 1.2.1's `metaphone` (Rust build). Empty when nothing is pronounceable. */
declare function metaphone(word: string): string;
/** Normalized phonetic distance in [0, 1]; 0 is a homophone. Falls back to character distance when a side has no code (numbers, symbols). */
declare function phoneticDistance(a: string, b: string): number;

/**
 * Applies the lexicon's pronunciation levers to a spoken line, for the voice that will say it.
 *
 * `"misaki"` wraps each whole-term occurrence of a `phonemes.misaki` entry as `[word](/phonemes/)`, keeping the
 * original casing and leaving occurrences already inside a link alone. `"text"` strips the markup and applies the
 * `respell` entries. `spoken` rewrites are ignored because they change captions, which the caller applies itself, and
 * `phonemes.ipa` is espeak intent that no vet voice takes as input.
 */
declare function applyLexicon(spoken: string, lexicon: Lexicon, alphabet: "misaki" | "text"): string;

/**
 * The decision half of the vet cycle: which findings on a take are faults, which of two faulty takes to
 * keep, when retaking is futile, and what the kept take's remaining faults ask the caller to do. Pure:
 * the checks that produce the findings run elsewhere.
 */

/**
 * `hallucination`, `tail`, `omission` and `low-confidence` are stochastic: another take of the same input
 * can clear them. `word` and `reading` are the voice's pronunciation, which a retake rarely changes.
 */
type FaultKind = "hallucination" | "tail" | "omission" | "low-confidence" | "word" | "reading";
interface Fault {
    kind: FaultKind;
    /** The source word, for word, reading, omission and low-confidence faults. */
    word?: string;
    /** In [0, 1]; for an adjudicated word fault, its phone distance. */
    severity: number;
    detail: string;
}
/** The fields of a speech-vet `Defect` this module reads, plus the verdicts S3 attaches to it. */
interface DefectFinding {
    kind: "substitution" | "omission" | "low_confidence";
    expected: string;
    heard: string;
    severity: number;
    /** Word verdicts over this defect's words; absent when no recognizer ran, leaving it unadjudicated. */
    verdicts?: readonly WordVerdict[];
}
type Decision = {
    status: "accepted";
} | {
    status: "needs-override";
    word: string;
    evidence: Fault[];
} | {
    status: "needs-rewrite";
    span: string;
    reason: "reading";
} | {
    status: "retakes-exhausted";
    faults: Fault[];
};

/**
 * The vet cycle: precheck a line's declared readings, synthesize it, check every take in full, retake while a
 * fault remains, keep the best take, and say what its remaining faults ask of the caller. Every model arrives
 * as a provider, so nothing here loads one. The caller passes normalized text: `vet` does not normalize.
 */

interface VetDeps {
    tts: TtsProvider;
    voice: string;
    stt: SttProvider;
    /** Required when `tts` takes misaki phonemes; with a text voice it only gives the heard-reading check its spans. */
    g2p?: Pick<G2p, "tokens" | "version">;
    recognizer?: PhoneRecognizer;
    /** Required with a recognizer: whether misaki may drive verdicts is the caller's call, so there is no default. */
    phoneG2p?: PhoneG2p;
    confirmStt?: SttProvider;
    lexicon?: Lexicon;
    /** Defaults to speech-g2p's `misakiToIpa`. */
    toIpa?: MisakiToIpa;
}
interface VetPolicy {
    /** Retakes after the first take; defaults to `DEFAULT_RETRIES`. */
    maxRetakes?: number;
    /** Defaults to `KEEP_TAKE_MARGIN`. */
    margin?: number;
    /** `fail` stops on an undeclared heteronym before any audio is made. Default `warn`. */
    undeclaredHeteronym?: "warn" | "fail";
    table?: HeteronymTable;
    synthesize?: Pick<SynthesizeOptions, "speed" | "language" | "timeoutMs" | "signal">;
}
interface VetTake {
    /** One-based. */
    attempt: number;
    synthesis: Synthesis;
    transcript: Transcript;
}
/** One take's checks, JSON-safe. */
interface TakeReport {
    attempt: number;
    transcript: string;
    textDiff: WordDiff;
    defects: DefectFinding[];
    phones?: string;
    hallucinations: Hallucination[];
    tail: TailArtifact | null;
    heard: HeardReading[];
    /** Undeclared heteronyms the audio contradicts: warnings, not faults, while owner decision D-T11-3 is open. */
    warnings: HeardReading[];
    faults: Fault[];
    dismissed: WordVerdict[];
    kept: boolean;
}
/** `unverifiable`: the voice takes text, so the G2P reading checked is not the one it speaks. */
interface Precheck {
    status: "verified" | "unverifiable" | "stopped";
    findings: ReadingFinding[];
}
/** JSON-safe: no audio. */
interface VetReport {
    tts: string;
    voice: string;
    g2pVersion?: string;
    tableVersion: number;
    precheck: Precheck;
    defectOptions: {
        stt: DefectOptions;
        confirmStt?: DefectOptions;
    };
    takes: TakeReport[];
    keptAttempt?: number;
    /** `futile`: a take heard the same as the one before it, so the voice is deterministic and retakes cannot help. */
    stopReason: "clean" | "futile" | "budget" | "precheck";
}
type VetResult = (Decision & {
    take: VetTake;
    report: VetReport;
}) | {
    status: "stopped";
    findings: ReadingFinding[];
    report: VetReport;
};
/** Runs the vet cycle over `spoken`, a normalized line with optional `[w](=reading)` and `[w](/phonemes/)` markup. */
declare function vet(spoken: string, deps: VetDeps, policy?: VetPolicy): Promise<VetResult>;

interface GuardOptions {
    /** Run on both sides before numbers, terms and length are compared. */
    steps?: readonly NormalizeStep[];
    /** Terms (a lexicon's, say) that must survive whenever the source contains them. */
    protectedTerms?: readonly string[];
    maxDroppedTerms?: number;
    /** Allowed change in word count, as a fraction of the source's words. */
    lengthTolerance?: number;
    /** The least change in word count always allowed, so a short sentence can still be rephrased. */
    minLengthSlack?: number;
}
type GuardRule = "empty" | "number" | "entity" | "markup" | "terms" | "length";
interface GuardRejection {
    rule: GuardRule;
    detail: string;
}
/** Every reason `candidate` may not replace `source`; empty when it may. `span` is the flagged word, whose own markup may go. */
declare function guardRewrite(source: string, candidate: string, span: string, opts?: GuardOptions): GuardRejection[];
/** Lower-cased, stemmed content words, so "the reader" and "reads it" share a term. */
declare function contentTerms(text: string): Set<string>;

/** The `rewrites.json` file: accepted rewrites keyed by {@link pinKey} of the sentence they replace. */
declare const RewritePinsSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    pins: z.ZodRecord<z.ZodString, z.ZodObject<{
        source: z.ZodString;
        rewrite: z.ZodString;
        rewriter: z.ZodString;
        createdAt: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
type RewritePinsFile = z.infer<typeof RewritePinsSchema>;
interface RewritePinsOptions {
    now?: () => Date;
}
/**
 * Key of a pin. It covers the sentence only, so swapping the rewriter keeps reviewed pins; the rewriter id
 * is stored in the entry instead (D-T13-4, pending the owner's answer).
 */
declare function pinKey(sentence: string): string;
declare class RewritePins {
    private readonly pins;
    private readonly now;
    constructor(file?: RewritePinsFile, options?: RewritePinsOptions);
    static fromJson(json: unknown, options?: RewritePinsOptions): RewritePins;
    /** A missing file is an empty store; a malformed or wrong-version file throws rather than losing pins. */
    static load(path: string, options?: RewritePinsOptions): Promise<RewritePins>;
    toJson(): RewritePinsFile;
    /** Writes beside the target and renames, so a crash never leaves a half-written pin file. */
    save(path: string): Promise<void>;
    get(sentence: string): string | undefined;
    put(sentence: string, rewrite: string, rewriterId: string): void;
    isPinnedRewrite(text: string): boolean;
    /** Removes pins whose source sentence is not in `inUse`; returns how many went. */
    prune(inUse: Set<string>): number;
}
declare class UnpinnedRewriteError extends Error {
    readonly sentences: string[];
    constructor(sentences: string[]);
}
/** Substitutes every pinned sentence; throws if a sentence holding a flagged span has no pin and is not a pinned rewrite. */
declare function applyPins(line: string, pins: RewritePins, flaggedSpans?: readonly string[]): string;

interface CandidateSource {
    id: string;
    /** Up to `k` replacements for `sentence`; `reason` says why it needs one (a vet `needs-rewrite` reason). */
    candidates(sentence: string, reason: string, k: number): Promise<string[]>;
}
declare const SYMBOL_WORDS: readonly (readonly [string, string])[];
/** The rule tier: spells each table key inside a word-bearing token, outside markup. Offers nothing when nothing changes. */
declare function symbolRules(table?: readonly (readonly [string, string])[]): CandidateSource;
interface RewriteDeps {
    vet: VetDeps;
    pins: RewritePins;
    /** Asked in order, so put the rule tier before an LLM. */
    sources: readonly CandidateSource[];
}
interface RewritePolicy {
    vet?: VetPolicy;
    /** Candidates asked of each source; default 3. */
    k?: number;
    /** Protected terms come from `deps.vet.lexicon`. */
    guard?: Omit<GuardOptions, "protectedTerms">;
}
interface Tried {
    source: string;
    candidate: string;
    rejections: GuardRejection[];
    vetStatus?: string;
}
type RewriteResult = {
    status: "pinned";
    line: string;
} | {
    status: "refused";
    reason: "pinned-span";
    line: string;
} | {
    status: "rewritten";
    line: string;
    sentence: string;
    rewrite: string;
    source: string;
    result: VetResult;
} | {
    status: "no-candidate";
    tried: Tried[];
};
/**
 * Rewrites the sentence holding `need.span`. A pin resolves it with no source asked; a sentence that is itself a
 * pinned rewrite is refused. The caller saves `deps.pins` after a `rewritten` result.
 */
declare function rewriteLine(line: string, need: {
    span: string;
    reason: string;
}, deps: RewriteDeps, policy?: RewritePolicy): Promise<RewriteResult>;

export { type BestTailTakeOptions, type CandidateSource, DEFAULT_NORMALIZE_STEPS, DEFAULT_PHONE_VOICE, DEFAULT_RETRIES, type Defect, type DefectCause, type DefectKind, type DefectOptions, ESPEAK_TIMEOUT_MS, type EspeakCliOptions, type EspeakRunner, type Fault, type FaultKind, type GuardOptions, type GuardRejection, type GuardRule, HALLUCINATION_MIN_PHONES, type Hallucination, type HallucinationOptions, type HeardReading, type HeardReadingOptions, type HeardStatus, type HeteronymTable, HeteronymTableSchema, type InitialismOptions, KEEP_TAKE_MARGIN, type Lexicon, type LexiconEntry, LexiconEntrySchema, LexiconSchema, MIN_PHONES_FOR_VERDICT, MIN_SPAN_RATIO_FOR_VERDICT, MIN_TARGET_WORD_LENGTH, type MisakiToIpa, NUMBER_STEPS, type NormalizeStep, type PhoneG2p, type PhoneG2pOptions, type PhoneRecognizer, type PhoneSource, type PhonemeToken, RATE_UNITS, type RawTake, type ReadingFinding, type ReadingStatus, type Respeller, type RewriteDeps, RewritePins, type RewritePinsFile, type RewritePinsOptions, RewritePinsSchema, type RewritePolicy, type RewriteResult, SHORT_WORD_MAX_PHONES, SHOUTED_TWO_LETTER_WORDS, SPELLED_INITIALISMS, SYMBOL_WORDS, type SynthesizeVerifiedOptions, TAIL_STRAY_MIN_PHONES, type TailArtifact, type TailArtifactOptions, type TailCandidate, type TailFix, type TakeScore, UnpinnedRewriteError, VOWELLESS_INTERJECTIONS, type VerifiedTake, type VetDeps, type VetPolicy, type VetReport, type VetResult, type VetTake, WEAK_FORMS, WORSE_MARGIN, type WordDistance, type WordDistanceOptions, type WordToken, type WordVerdict, type WordVerdictOptions, XTTS_FAULT_THRESHOLD, XTTS_FAULT_THRESHOLD_SHORT, XTTS_FAULT_THRESHOLD_UNUSUAL, admissiblePhones, ageStep, applyLexicon, applyPins, bestTailTake, cardinalStep, checkHeardReadings, checkReadings, chunkWordVerdicts, cleanIpa, confirmDefects, contentTerms, currencyStep, decimalStep, defectOptionsFor, detectDefects, detectHallucinations, detectTailArtifact, englishHeteronyms, espeakCliG2p, espeakVersion, expandReading, expectedPhones, g2pSentence, g2pText, generateCandidates, guardRewrite, initialismStep, isInitialism, isUnusualWord, keepTake, loadLexicon, metaphone, misakiIpaG2p, normalize, numberToOrdinal, numberToWords, ordinalStep, phoneMatchDistance, phonemeDistance, phoneticDistance, pinKey, plainText, rateStep, readingIpa, readingOf, recognizePhones, regressions, respeller, respellingsOf, rewriteLine, spellDigits, spellInitialisms, symbolRules, synthesizeVerified, timeStep, tokenDump, tokenizeWords, vet, whitespaceStep, wordDistances };
