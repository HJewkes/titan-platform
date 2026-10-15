/** Mono PCM samples in [-1, 1]. Kept structurally equal to speech-stt's `Audio` so either can be passed. */
interface Audio {
    samples: Float32Array;
    sampleRate: number;
}
/** `misaki` is Kokoro's phoneme set; `ipa` is plain IPA, which espeak and most engines read. */
type PhonemeAlphabet = "ipa" | "misaki";
/** One word from a G2P pass. `phonemes` overrides the provider's own reading of `text`. */
interface TtsToken {
    text: string;
    phonemes?: string;
    whitespace?: string;
}
type TtsInput = {
    text: string;
} | {
    tokens: readonly TtsToken[];
    alphabet: PhonemeAlphabet;
};
interface SynthesizeOptions {
    /** 1 is the voice's natural rate. Needs `capabilities.speedControl`. */
    speed?: number;
    language?: string;
    /** Overrides the provider's default deadline for this call. */
    timeoutMs?: number;
    signal?: AbortSignal;
}
/** Seconds from the start of `audio`. */
interface WordTiming {
    word: string;
    start: number;
    end: number;
}
interface Synthesis {
    audio: Audio;
    durationS: number;
    /** Present only when the provider declares `wordTimestamps`. */
    words?: WordTiming[];
    /** The phoneme strings the engine actually spoke, when it reports them. */
    phonemes?: string[];
}
interface TtsVoice {
    id: string;
    languages: readonly string[];
    description?: string;
}
/** What a provider can do. Selection compares requirements against this, before any audio is made. */
interface TtsCapabilities {
    /** Alphabets accepted as token input. Empty means text input only. */
    phonemeInput: readonly PhonemeAlphabet[];
    wordTimestamps: boolean;
    speedControl: boolean;
    voices: readonly TtsVoice[];
    /** BCP 47 tags, such as `en-US`. */
    languages: readonly string[];
    sampleRate: number;
}
interface TtsProvider {
    readonly id: string;
    readonly capabilities: TtsCapabilities;
    synthesize(input: TtsInput, voice: string, options?: SynthesizeOptions): Promise<Synthesis>;
}
/** What a caller needs from a provider. Every field left out is not required. */
interface TtsRequirements {
    phonemeInput?: PhonemeAlphabet;
    wordTimestamps?: boolean;
    speedControl?: boolean;
    voice?: string;
    language?: string;
    sampleRate?: number;
}

type TtsErrorCode = "unavailable" | "unsupported" | "timeout" | "failed" | "misconfigured" | "unknown-kind";
/** A provider that selection passed over, and why. */
interface SkippedProvider {
    id: string;
    reason: string;
    /** Set when the provider was skipped for lacking capabilities. */
    missing?: readonly string[];
    /** Set when the provider's own config is wrong, as opposed to its engine being absent. */
    misconfigured?: true;
}
/** Every error this package throws. Branch on `code`, not on the message. */
declare class TtsError extends Error {
    readonly code: TtsErrorCode;
    readonly providerId: string;
    constructor(code: TtsErrorCode, providerId: string, message: string, options?: {
        cause?: unknown;
    });
}
/** The engine cannot be reached: missing binary, refused connection, nothing configured. */
declare class TtsUnavailableError extends TtsError {
    constructor(providerId: string, message: string, options?: {
        cause?: unknown;
    });
}
/** The request needs something the provider's capabilities do not list. `missing` names each gap. */
declare class TtsUnsupportedError extends TtsError {
    readonly missing: readonly string[];
    constructor(providerId: string, missing: readonly string[], message?: string);
}
declare class TtsTimeoutError extends TtsError {
    readonly timeoutMs: number;
    constructor(providerId: string, timeoutMs: number);
}
/**
 * Selection reached a provider whose config is wrong. `misconfigured`: a bad entry or a secret that resolves to
 * nothing, without `tts.fallback: true`. `unknown-kind`: a `kind` no factory is registered for, which never falls
 * back, because a typo would otherwise hand the text to the next engine, possibly a remote one.
 */
declare class TtsConfigError extends TtsError {
    readonly skipped: readonly SkippedProvider[];
    constructor(providerId: string, message: string, skipped: readonly SkippedProvider[], code?: "misconfigured" | "unknown-kind");
}
/** The engine ran and answered, but with an error or with output that breaks the contract. */
declare class TtsFailedError extends TtsError {
    constructor(providerId: string, message: string, options?: {
        cause?: unknown;
    });
}

/** `en` matches `en-US` in either direction; `en-GB` does not match `en-US`. */
declare function languageMatches(offered: readonly string[], wanted: string): boolean;
/** One readable phrase per requirement the capabilities do not meet; empty when all are met. */
declare function missingCapabilities(caps: TtsCapabilities, req: TtsRequirements): string[];
/** The requirements one synthesize call implies. A speed of exactly 1 asks for nothing. */
declare function requirementsOf(input: TtsInput, voice: string, options?: SynthesizeOptions): TtsRequirements;
/** Throws before any engine work when the call needs a capability the provider does not declare. */
declare function assertSupported(providerId: string, caps: TtsCapabilities, input: TtsInput, voice: string, options?: SynthesizeOptions): void;

/** Parses a RIFF/WAVE buffer, taking the sample rate from its header. */
declare function decodeWav(bytes: Uint8Array): Audio;
/** Mono PCM16, clipping samples outside [-1, 1]. */
declare function encodeWav(audio: Audio): Uint8Array;

interface FakeTtsOptions {
    id?: string;
    capabilities?: Partial<TtsCapabilities>;
    /** Simulated engine time per call, so tests can drive the deadline. */
    latencyMs?: number;
    timeoutMs?: number;
    /** Every call rejects with TtsUnavailableError, as a missing engine would. */
    unavailable?: boolean;
}
interface FakeTtsCall {
    input: TtsInput;
    voice: string;
    options: SynthesizeOptions;
}
interface FakeTtsProvider extends TtsProvider {
    readonly calls: readonly FakeTtsCall[];
}
declare const FAKE_TTS_CAPABILITIES: TtsCapabilities;
/** A deterministic in-memory provider for tests and dry runs; it honours its declared capabilities. */
declare function fakeTts(opts?: FakeTtsOptions): FakeTtsProvider;

/** `stdout-wav`: the command writes RIFF bytes to stdout. `json`: it writes one JSON object (see the README). */
type CommandOutput = "stdout-wav" | "json";
interface CommandTtsOptions {
    id: string;
    /** The program and its arguments, run without a shell. `["ssh", "gpu-box", "tts-cli"]` reaches a remote engine. */
    argv: readonly string[];
    capabilities: TtsCapabilities;
    output?: CommandOutput;
    /** Added to the child's minimal environment (see `INHERITED_ENV`); nothing else of the parent's is passed. */
    env?: Readonly<Record<string, string>>;
    cwd?: string;
    timeoutMs?: number;
    /** Past this many bytes of stdout, or of the named WAV file, the command is killed. Default 64 MB. */
    maxOutputBytes?: number;
    /** Values never quoted in an error, such as tokens passed in `env`. */
    secrets?: readonly string[];
    /** Exit codes that mean "engine not reachable" rather than "engine failed": EX_UNAVAILABLE, shell not-found, ssh. */
    unavailableExitCodes?: readonly number[];
}
/** The JSON document written to the command's stdin, then stdin is closed. */
interface CommandRequest {
    version: 1;
    voice: string;
    text?: string;
    tokens?: readonly TtsToken[];
    alphabet?: PhonemeAlphabet;
    speed?: number;
    language?: string;
    /** In `json` mode, a fresh directory for this call. A `wav` in the answer is a path relative to it. */
    outDir?: string;
    /** In `json` mode, a suggested file inside `outDir`. */
    out?: string;
}
/** The parent variables a child sees. Anything else, such as an API key, must be listed in `env`. */
declare const INHERITED_ENV: readonly ["PATH", "HOME", "LANG", "TMPDIR"];
/** Any external program that speaks the stdio contract in the README: a local engine, or one behind ssh. */
declare function commandTts(opts: CommandTtsOptions): TtsProvider;

/** `wav`: the body is RIFF bytes. `json`: dot paths into the JSON body name each field. */
type HttpResponseMapping = {
    type: "wav";
} | {
    type: "json";
    audioBase64: string;
    durationS?: string;
    words?: string;
    phonemes?: string;
};
interface HttpTtsOptions {
    id: string;
    /** `https:`, or `http:` to a loopback host. Any other `http:` URL needs `allowInsecureHttp`. */
    url: string;
    method?: "POST" | "PUT";
    /** Sent as given. Resolve secrets before this point; `resolveTtsConfig` expands `${env:NAME}`. */
    headers?: Readonly<Record<string, string>>;
    capabilities: TtsCapabilities;
    /** A JSON body template; see `fillTemplate` for the placeholders. */
    request: {
        body: unknown;
    };
    response: HttpResponseMapping;
    timeoutMs?: number;
    /** Past this many response bytes the read is cancelled. Default 64 MB. */
    maxOutputBytes?: number;
    /** Sends headers and text in the clear to a host that is not loopback. Off by default. */
    allowInsecureHttp?: boolean;
    /** Values never quoted in an error. Header values are always added. */
    secrets?: readonly string[];
}
/** Any HTTP speech endpoint, self-hosted or hosted, described by a request template and a response mapping. */
declare function httpTts(opts: HttpTtsOptions): TtsProvider;

/** The most engine output read into memory per call, unless a provider sets `maxOutputBytes`. */
declare const DEFAULT_MAX_OUTPUT_BYTES: number;

/**
 * The values a request template may name: `{{text}}`, `{{voice}}`, `{{speed}}`, `{{language}}`, `{{alphabet}}`,
 * `{{tokens}}`, and `{{phonemes}}` (each token's phonemes, or its text when it has none, joined by its whitespace).
 */
type TemplateValues = Record<string, unknown>;
/** Fills a JSON request template. Unknown placeholders are treated as unset. */
declare function fillTemplate(template: unknown, values: TemplateValues): unknown;

/** One provider entry. `kind` picks the registry factory; the factory validates the rest. */
type TtsProviderConfig = {
    kind: string;
} & Readonly<Record<string, unknown>>;
/** The `profile.json` document, version 1. Only the `tts` section is read here. */
interface TtsProfile {
    version: 1;
    tts?: {
        /** Provider ids to try first, in order. Providers not named follow in declaration order. */
        prefer?: readonly string[];
        providers?: Readonly<Record<string, TtsProviderConfig>>;
        /** Lets selection move past a misconfigured provider. Off by default: a broken preferred engine fails closed. */
        fallback?: boolean;
    };
}
interface ResolvedTtsConfig {
    /** Every provider id, in the order selection tries them. */
    order: readonly string[];
    providers: Readonly<Record<string, TtsProviderConfig>>;
    /** Providers that cannot be used as configured, with the reason, such as a secret that resolves to nothing. */
    unusable: Readonly<Record<string, string>>;
    fallback: boolean;
}
type Env = Readonly<Record<string, string | undefined>>;
declare const PROFILE_ENV = "TITAN_SPEECH_PROFILE";
declare const PREFER_ENV = "TITAN_SPEECH_TTS";
/** `TITAN_SPEECH_TTS_<ID>_<FIELD>`, with the id upper-cased and every other character as `_`. */
declare const providerEnvName: (id: string, field: string) => string;
/** Validates the document's shape; each provider's own fields are left to its factory. */
declare function parseTtsProfile(raw: unknown, source?: string): TtsProfile;
/** Reads a profile file. A missing file is no profile, not an error: nothing about the host is assumed. */
declare function loadTtsProfile(path: string): Promise<TtsProfile | undefined>;
/** Applies env over the profile: env wins. Neither is required; with neither, there are no providers. */
declare function resolveTtsConfig(opts?: {
    profile?: TtsProfile;
    env?: Env;
}): ResolvedTtsConfig;

/** Builds a provider from its profile entry, throwing TypeError when the entry is malformed. */
type TtsProviderFactory = (id: string, config: TtsProviderConfig) => TtsProvider;
/** Only `voices` and `sampleRate` are required; every other capability defaults to absent. */
declare function parseCapabilities(id: string, raw: unknown): TtsCapabilities;

interface TtsSelection {
    provider: TtsProvider;
    /** Providers tried before this one, and why each was passed over. Log it; it explains a fallback. */
    skipped: readonly SkippedProvider[];
}
interface TtsRegistry {
    /** Adds a provider kind, such as the in-process Kokoro adapter, under the `kind` a profile names. */
    register(kind: string, factory: TtsProviderFactory): TtsRegistry;
    kinds(): string[];
    /** The first provider, in the config's order, that meets every requirement. */
    select(config: ResolvedTtsConfig, requirements?: TtsRequirements): TtsSelection;
}
/** An empty registry. Use `defaultTtsRegistry` for the built-in kinds. */
declare function createTtsRegistry(): TtsRegistry;
/** The `command`, `http` and `fake` kinds. */
declare function defaultTtsRegistry(): TtsRegistry;
interface SelectTtsOptions {
    registry?: TtsRegistry;
    /** Falls back to `TITAN_SPEECH_PROFILE`. With neither, only env and registered kinds apply. */
    profilePath?: string;
    env?: Readonly<Record<string, string | undefined>>;
    requirements?: TtsRequirements;
}
/** Loads the profile, applies env overrides and selects: the one call a product needs. */
declare function selectTts(opts?: SelectTtsOptions): Promise<TtsSelection>;

interface SpeakingOptions {
    /** Silent runs at least this long between voiced frames are pauses and are not counted. */
    pauseS?: number;
    /** Frames quieter than this many dB below the loudest frame are silent. */
    silenceDb?: number;
}
/**
 * Seconds of speech in `audio`: leading and trailing silence trimmed, and silent runs
 * of `pauseS` or more removed, so a words-per-minute figure ignores deliberate pauses.
 */
declare function speakingSeconds(audio: Audio, opts?: SpeakingOptions): number;

interface CalibrateOptions {
    targetWpm: number;
    /** Words in the spoken text. The caller counts them: plain-text rules belong to the caller. */
    wordCount: number;
    toleranceWpm?: number;
    maxTries?: number;
    startSpeed?: number;
}
interface CalibrateTry {
    speed: number;
    wpm: number;
}
interface Calibration {
    best: CalibrateTry & {
        synthesis: Synthesis;
    };
    tries: CalibrateTry[];
}
/** Synthesizes until the speaking rate lands within tolerance of the target, else returns the closest try. */
declare function calibrateSpeed(provider: TtsProvider, input: TtsInput, voice: string, opts: CalibrateOptions): Promise<Calibration>;

/** The model behind `kokoroProvider`, which loads the real fp32 one unless given a `loadEngine`. */
interface KokoroEngine {
    /** Kokoro's input ids for one chunk's phonemes, `<bos>` and `<eos>` included. */
    tokenize(ps: string): number[];
    /** A voice's style pack: rows of 256 floats, one per phoneme count. */
    voicePack(voice: string): Promise<Float32Array>;
    /** One forward pass. `durations` are the unrounded frames per id. */
    run(input: {
        ids: readonly number[];
        style: Float32Array;
        speed: number;
    }, signal: AbortSignal): Promise<{
        waveform: Float32Array;
        durations: Float32Array;
    }>;
    dispose(): Promise<void>;
}
type ModuleImporter = (name: string) => Promise<unknown>;
interface KokoroEngineOptions {
    /** Where transformers.js caches the model. Its default sits inside node_modules, so products pass one. */
    cacheDir?: string;
    device: string;
    /** Injectable for tests; defaults to a dynamic import. */
    importModule?: ModuleImporter;
    /** Where the `<voice>.bin` packs live; defaults to the kokoro-js peer's `voices/`. */
    voicesDir?: string;
}

declare const KOKORO_CAPABILITIES: TtsCapabilities;
/** The G2P Kokoro reads. speech-g2p's `misakiEnglish()` satisfies it, so this package does not depend on it. */
interface KokoroG2p {
    tokens(text: string): readonly {
        text: string;
        phonemes: string | null;
        whitespace: string;
    }[];
}
interface KokoroProviderOptions {
    id?: string;
    g2p: KokoroG2p;
    /** Defaults to the fp32 model over the transformers.js peer. Called on first use, and again after a failed load. */
    loadEngine?: (options: KokoroEngineOptions) => Promise<KokoroEngine>;
    /** Voice ids offered, a subset of Kokoro's US voices. All of them by default. */
    voices?: readonly string[];
    device?: string;
    cacheDir?: string;
    /** Covers a cold load, which may download the 325 MB model. */
    timeoutMs?: number;
    /** Hears about words Kokoro will not speak; they keep a zero-width timing. Defaults to a process warning. */
    onWarning?: (message: string) => void;
}
/**
 * Kokoro-82M in process, at fp32, with word timings from the model's own durations, matching Python's
 * `KPipeline.join_timestamps`. Text goes through the injected G2P; misaki token input is spoken verbatim.
 */
declare function kokoroProvider(opts: KokoroProviderOptions): TtsProvider;
/** Register as `registry.register("kokoro", kokoroFactory({ g2p }))`; profile entries of kind `kokoro` then build it. */
declare function kokoroFactory(deps: Pick<KokoroProviderOptions, "g2p" | "loadEngine" | "onWarning">): TtsProviderFactory;

/** Seconds from the chunk start; null where Python leaves `start_ts`/`end_ts` unset. */
interface TokenTime {
    readonly start: number | null;
    readonly end: number | null;
}

export { type Audio, type CalibrateOptions, type CalibrateTry, type Calibration, type CommandOutput, type CommandRequest, type CommandTtsOptions, DEFAULT_MAX_OUTPUT_BYTES, FAKE_TTS_CAPABILITIES, type FakeTtsCall, type FakeTtsOptions, type FakeTtsProvider, type HttpResponseMapping, type HttpTtsOptions, INHERITED_ENV, KOKORO_CAPABILITIES, type KokoroEngine, type KokoroEngineOptions, type KokoroG2p, type KokoroProviderOptions, PREFER_ENV, PROFILE_ENV, type PhonemeAlphabet, type ResolvedTtsConfig, type SelectTtsOptions, type SkippedProvider, type SpeakingOptions, type Synthesis, type SynthesizeOptions, type TokenTime, type TtsCapabilities, TtsConfigError, TtsError, type TtsErrorCode, TtsFailedError, type TtsInput, type TtsProfile, type TtsProvider, type TtsProviderConfig, type TtsProviderFactory, type TtsRegistry, type TtsRequirements, type TtsSelection, TtsTimeoutError, type TtsToken, TtsUnavailableError, TtsUnsupportedError, type TtsVoice, type WordTiming, assertSupported, calibrateSpeed, commandTts, createTtsRegistry, decodeWav, defaultTtsRegistry, encodeWav, fakeTts, fillTemplate, httpTts, kokoroFactory, kokoroProvider, languageMatches, loadTtsProfile, missingCapabilities, parseCapabilities, parseTtsProfile, providerEnvName, requirementsOf, resolveTtsConfig, selectTts, speakingSeconds };
