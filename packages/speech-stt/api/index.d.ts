import { z } from 'zod';

/** Mono PCM: one float per sample, nominally in [-1, 1]. */
interface Audio {
    samples: Float32Array;
    sampleRate: number;
}
/** One recognised or aligned word. Times are seconds from the start of the audio. */
declare const WordSchema: z.ZodObject<{
    text: z.ZodString;
    start: z.ZodNumber;
    end: z.ZodNumber;
    probability: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
type Word = z.infer<typeof WordSchema>;
/** A recogniser segment. The confidence fields are optional because not every backend reports them. */
declare const SegmentSchema: z.ZodObject<{
    text: z.ZodString;
    start: z.ZodNumber;
    end: z.ZodNumber;
    avgLogprob: z.ZodOptional<z.ZodNumber>;
    compressionRatio: z.ZodOptional<z.ZodNumber>;
    noSpeechProb: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
type Segment = z.infer<typeof SegmentSchema>;
declare const TranscriptSchema: z.ZodObject<{
    text: z.ZodString;
    words: z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        start: z.ZodNumber;
        end: z.ZodNumber;
        probability: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    segments: z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        start: z.ZodNumber;
        end: z.ZodNumber;
        avgLogprob: z.ZodOptional<z.ZodNumber>;
        compressionRatio: z.ZodOptional<z.ZodNumber>;
        noSpeechProb: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
}, z.core.$strip>;
type Transcript = z.infer<typeof TranscriptSchema>;

/**
 * Times each script word from what the recogniser heard. A word matched to a heard word
 * takes its times; a run of unmatched words between two anchors shares the gap evenly.
 * The first heard word's start and the last heard word's end anchor the two ends.
 */
declare function align(script: readonly string[], heard: readonly Word[]): Word[];

/**
 * Folds formatting and punctuation so a script and a transcript compare on their words:
 * lower case, no quotes, `*`, `_` or brackets, `u.s.` as `us`, hyphenated compounds split,
 * and every other non-word character dropped.
 */
declare function normalize(text: string): string;
interface WordDiff {
    /** Character-level `SequenceMatcher.ratio()` of the two normalised texts. */
    similarity: number;
    passed: boolean;
    issues: string[];
    /** Up to five heard words that the script lacks, in the order first heard. */
    insertions: string[];
    /** Up to five script words that were not heard, in script order. */
    deletions: string[];
    normalizedExpected: string;
    normalizedActual: string;
}
interface DiffOptions {
    /** The similarity at or above which the take passes. Default 0.9. */
    threshold?: number;
}
/** Compares a script with what was heard: character similarity of the normalised texts, plus word lists. */
declare function diff(expected: string, heard: string | Pick<Transcript, "text">, opts?: DiffOptions): WordDiff;

/**
 * Converts mono audio to `toRate` with a Blackman-windowed sinc, in TypeScript, so callers
 * need no ffmpeg. Kokoro's 24 kHz becomes a recogniser's 16 kHz. The output has
 * `round(n * toRate / fromRate)` samples.
 */
declare function resample(audio: Audio, toRate: number): Audio;

/**
 * Python's `round(x, digits)`: round half to even on the exact binary value. `toFixed` breaks
 * exact ties upward, so `roundHalfEven(0.0625, 3)` would give 0.063 where Python gives 0.062.
 * `digits` is a whole number from 0 to 20.
 */
declare function roundHalfEven(x: number, digits: number): number;

/**
 * A port of CPython's `difflib.SequenceMatcher` without `isjunk`. Callers that port Python
 * scoring code depend on its exact blocks and tie-breaking, not just on any longest match.
 */
/** `a[a..a+size]` equals `b[b..b+size]`. The last block is always `{a: len(a), b: len(b), size: 0}`. */
interface Block {
    a: number;
    b: number;
    size: number;
}
type OpcodeTag = "replace" | "delete" | "insert" | "equal";
/** Turns `a[i1..i2]` into `b[j1..j2]`, as CPython's `get_opcodes` tuples. */
type Opcode = [tag: OpcodeTag, i1: number, i2: number, j1: number, j2: number];
interface SequenceMatcherOptions {
    /** CPython's default: when `b` has 200 or more items, items filling over 1% of it are ignored as anchors. */
    autojunk?: boolean;
}
/** Items compare with `===` (Map key identity), as Python's `==` does for strings and numbers. */
declare class SequenceMatcher<T> {
    private readonly a;
    private readonly b;
    private readonly b2j;
    private blocks;
    /** Strings iterate by code point, as Python strings do. */
    constructor(a: Iterable<T>, b: Iterable<T>, opts?: SequenceMatcherOptions);
    matchingBlocks(): Block[];
    opcodes(): Opcode[];
    /** `2 * matches / (len(a) + len(b))`, and 1 when both are empty. */
    ratio(): number;
    private findBlocks;
    private findLongestMatch;
    /** Grows the match across neighbours that `b2j` dropped as popular. CPython's junk passes are no-ops without `isjunk`. */
    private extendOverEqualNeighbours;
}

/** Per-frame CTC logits, row-major: frame `t`, token `v` is `data[t * vocabSize + v]`. */
interface CtcLogits {
    data: Float32Array;
    frames: number;
    vocabSize: number;
    /** Seconds per frame. Frame `t` covers the audio from about `t * frameS`. */
    frameS: number;
}
/** The token every CTC model here uses as its blank, `<pad>`. */
declare const CTC_BLANK_ID = 0;
/**
 * `Wav2Vec2FeatureExtractor`'s zero-mean, unit-variance normalization: population variance, eps 1e-7, sums in
 * float64. A constant signal becomes zeros rather than a division by zero.
 */
declare function normalizeInput(samples: Float32Array): Float32Array;
/** The best token per frame. A tie goes to the lower id, as `torch.argmax` gives. */
declare function argmaxFrames(logits: CtcLogits): number[];
/**
 * Greedy CTC decode: collapse runs of one id, then drop the blank and every `<…>` special token, and join the
 * remaining tokens with a space. A blank between two equal ids keeps both.
 */
declare function ctcGreedyDecode(ids: readonly number[], tokens: readonly string[]): string;

type ModuleImporter = (name: string) => Promise<unknown>;

declare const WAV2VEC2_MODEL = "onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX";
/** The ONNX export's commit. A re-export changes the numerics, so it is pinned rather than `main`. */
declare const WAV2VEC2_REVISION = "c69750f5043e5e1f8a71ab95dd3b98338c280c92";
type Wav2vec2Dtype = "fp32" | "q8";
interface CtcLoadOptions {
    dtype: Wav2vec2Dtype;
    device?: string;
    cache_dir?: string;
    revision?: string;
    session_options?: {
        intraOpNumThreads: number;
        interOpNumThreads: number;
    };
}
/** A loaded CTC model. `run` takes normalized 16 kHz samples and returns `[1, frames, vocab]` logits. */
interface CtcSession {
    run(inputValues: Float32Array): Promise<{
        data: Float32Array;
        dims: readonly number[];
    }>;
    dispose(): Promise<void>;
}
type CtcFactory = (model: string, options: CtcLoadOptions) => Promise<CtcSession>;
/** Holds raw decodes by audio hash. A `Map` fits; a product can pass a persistent store with the same two methods. */
interface PhonesCache {
    get(key: string): string | undefined;
    set(key: string, phones: string): unknown;
}
interface Wav2vec2Options {
    /**
     * `fp32` (default) matches the PyTorch model frame for frame. `q8` uses a quarter of the memory but gives
     * different verdicts: thresholds tuned on fp32 do not hold for it.
     */
    dtype?: Wav2vec2Dtype;
    /** A transformers.js device, e.g. `cpu`. The runtime picks when unset. */
    device?: string;
    /** Where the runtime caches model weights. Pass one: the runtime's default sits inside `node_modules`. */
    cacheDir?: string;
    /** A commit of the model repo. Defaults to `WAV2VEC2_REVISION`. */
    revision?: string;
    /** Intra-op threads for the ONNX session. The runtime picks when unset. */
    threads?: number;
    cache?: PhonesCache;
    /** Injectable for tests; defaults to importing `@huggingface/transformers`. */
    loadModel?: () => Promise<CtcFactory>;
}
interface CtcRecognition {
    /** The raw greedy decode: space-separated vocab tokens, uncleaned. */
    phones: string;
    /** The best token id per frame. */
    ids: number[];
    logits: CtcLogits;
}
interface Wav2vec2Recognizer {
    /** The raw decode of `audio`, cached by audio hash. */
    recognize(audio: Audio): Promise<string>;
    /** The decode with its per-frame ids and logits. Always runs the model, and fills the decode cache. */
    recognizeWithLogits(audio: Audio): Promise<CtcRecognition>;
    /** Token text by id. */
    readonly vocab: readonly string[];
    readonly blankId: number;
    dispose(): Promise<void>;
}
/**
 * Resolves the peer's `AutoModelForCTC` and `Tensor` through `importModule`, naming the install command when the
 * peer is absent. The factory refuses weights that are not cached while TITAN_SPEECH_OFFLINE is set.
 */
declare function loadTransformersCtc(importModule?: ModuleImporter): Promise<CtcFactory>;
/**
 * Phone recognition with `wav2vec2-lv-60-espeak-cv-ft` over transformers.js: espeak-style IPA tokens per 20 ms
 * frame, greedy-decoded. Audio at any rate is resampled to 16 kHz; feed chunk-length audio (30 s or less), since
 * memory grows with the square of the length. Decodes are cached by a hash of the model, dtype, revision and audio.
 */
declare function wav2vec2Recognizer(options?: Wav2vec2Options): Wav2vec2Recognizer;

interface SttProvider {
    transcribe(audio: Audio): Promise<Transcript>;
}
/** One chunk of transformers.js word-timestamp output. A chunk not led by whitespace continues the previous word. */
interface AsrChunk {
    text: string;
    timestamp: [start: number, end: number | null];
}
interface AsrOutput {
    text: string;
    chunks?: AsrChunk[];
}
/** The slice of a transformers.js ASR pipeline this module uses, so the package can stay an optional peer. */
interface AsrPipeline {
    (samples: Float32Array, options: {
        return_timestamps: "word";
        chunk_length_s: number;
    }): Promise<AsrOutput>;
    dispose(): Promise<void>;
}
type AsrFactory = (task: "automatic-speech-recognition", model: string, options: {
    dtype: string;
    device?: string;
    cache_dir?: string;
}) => Promise<AsrPipeline>;
/** Holds transcripts by audio hash. A `Map` fits; a product can pass a persistent store with the same two methods. */
interface TranscriptCache {
    get(key: string): Transcript | undefined;
    set(key: string, transcript: Transcript): unknown;
}
interface WhisperSttOptions {
    /** A Hugging Face Whisper model with ONNX weights and word timestamps. */
    model?: string;
    dtype?: "fp32" | "fp16" | "q8" | "q4";
    /** A transformers.js device, e.g. `cpu`, `cuda` or `webgpu`. The runtime picks when unset. */
    device?: string;
    /** Where the runtime caches model weights. The runtime's default when unset. */
    cacheDir?: string;
    cache?: TranscriptCache;
    /** Injectable for tests; defaults to importing `@huggingface/transformers`. */
    loadPipeline?: () => Promise<AsrFactory>;
}
/**
 * Resolves the peer's `pipeline` through `importModule`, naming the install command when the peer is absent. The
 * returned factory refuses an uncached model while TITAN_SPEECH_OFFLINE is set.
 */
declare function loadTransformersPipeline(importModule?: ModuleImporter): Promise<AsrFactory>;
/**
 * Whisper over transformers.js with word timestamps. Audio at any rate is resampled to 16 kHz. Transcripts are
 * cached by a hash of the model, rate and samples, so re-checking unchanged audio never runs the model.
 * `segments` is empty: word-timestamp decoding reports no per-segment confidence.
 */
declare function whisperStt(options?: WhisperSttOptions): SttProvider & {
    dispose(): Promise<void>;
};

export { type AsrChunk, type AsrFactory, type AsrOutput, type AsrPipeline, type Audio, type Block, CTC_BLANK_ID, type CtcFactory, type CtcLoadOptions, type CtcLogits, type CtcRecognition, type CtcSession, type DiffOptions, type ModuleImporter, type Opcode, type OpcodeTag, type PhonesCache, type Segment, SegmentSchema, SequenceMatcher, type SequenceMatcherOptions, type SttProvider, type Transcript, type TranscriptCache, TranscriptSchema, WAV2VEC2_MODEL, WAV2VEC2_REVISION, type Wav2vec2Dtype, type Wav2vec2Options, type Wav2vec2Recognizer, type WhisperSttOptions, type Word, type WordDiff, WordSchema, align, argmaxFrames, ctcGreedyDecode, diff, loadTransformersCtc, loadTransformersPipeline, normalize, normalizeInput, resample, roundHalfEven, wav2vec2Recognizer, whisperStt };
