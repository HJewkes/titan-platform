/** Mono PCM samples in [-1, 1]. Kept structurally equal to speech-stt's `Audio` so either can be passed. */
export interface Audio {
  samples: Float32Array;
  sampleRate: number;
}

/** `misaki` is Kokoro's phoneme set; `ipa` is plain IPA, which espeak and most engines read. */
export type PhonemeAlphabet = "ipa" | "misaki";

/** One word from a G2P pass. `phonemes` overrides the provider's own reading of `text`. */
export interface TtsToken {
  text: string;
  phonemes?: string;
  whitespace?: string;
}

export type TtsInput = { text: string } | { tokens: readonly TtsToken[]; alphabet: PhonemeAlphabet };

export interface SynthesizeOptions {
  /** 1 is the voice's natural rate. Needs `capabilities.speedControl`. */
  speed?: number;
  language?: string;
  /** Overrides the provider's default deadline for this call. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Seconds from the start of `audio`. */
export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface Synthesis {
  audio: Audio;
  durationS: number;
  /** Present only when the provider declares `wordTimestamps`. */
  words?: WordTiming[];
  /** The phoneme strings the engine actually spoke, when it reports them. */
  phonemes?: string[];
}

export interface TtsVoice {
  id: string;
  languages: readonly string[];
  description?: string;
}

/** What a provider can do. Selection compares requirements against this, before any audio is made. */
export interface TtsCapabilities {
  /** Alphabets accepted as token input. Empty means text input only. */
  phonemeInput: readonly PhonemeAlphabet[];
  wordTimestamps: boolean;
  speedControl: boolean;
  voices: readonly TtsVoice[];
  /** BCP 47 tags, such as `en-US`. */
  languages: readonly string[];
  sampleRate: number;
}

export interface TtsProvider {
  readonly id: string;
  readonly capabilities: TtsCapabilities;
  synthesize(input: TtsInput, voice: string, options?: SynthesizeOptions): Promise<Synthesis>;
}

/** What a caller needs from a provider. Every field left out is not required. */
export interface TtsRequirements {
  phonemeInput?: PhonemeAlphabet;
  wordTimestamps?: boolean;
  speedControl?: boolean;
  voice?: string;
  language?: string;
  sampleRate?: number;
}
