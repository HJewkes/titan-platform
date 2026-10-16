export type {
  Audio,
  PhonemeAlphabet,
  Synthesis,
  SynthesizeOptions,
  TtsCapabilities,
  TtsInput,
  TtsProvider,
  TtsRequirements,
  TtsToken,
  TtsVoice,
  WordTiming,
} from "./types.js";
export {
  TtsConfigError,
  TtsError,
  TtsFailedError,
  TtsTimeoutError,
  TtsUnavailableError,
  TtsUnknownWordsError,
  TtsUnsupportedError,
  type TtsErrorCode,
} from "./errors.js";
export { assertSupported, languageMatches, missingCapabilities, requirementsOf } from "./capabilities.js";
export { decodeWav, encodeWav } from "./wav.js";
export { FAKE_TTS_CAPABILITIES, fakeTts, type FakeTtsCall, type FakeTtsOptions, type FakeTtsProvider } from "./fake-tts.js";
export { commandTts, INHERITED_ENV, type CommandOutput, type CommandRequest, type CommandTtsOptions } from "./command-tts.js";
export { httpTts, type HttpResponseMapping, type HttpTtsOptions } from "./http-tts.js";
export { DEFAULT_MAX_OUTPUT_BYTES } from "./output-limits.js";
export { fillTemplate } from "./http-mapping.js";
export {
  loadTtsProfile,
  parseTtsProfile,
  PREFER_ENV,
  PROFILE_ENV,
  providerEnvName,
  resolveTtsConfig,
  type ResolvedTtsConfig,
  type TtsProfile,
  type TtsProviderConfig,
} from "./config.js";
export { parseCapabilities, type TtsProviderFactory } from "./factories.js";
export {
  createTtsRegistry,
  defaultTtsRegistry,
  selectTts,
  type SelectTtsOptions,
  type SkippedProvider,
  type TtsRegistry,
  type TtsSelection,
} from "./registry.js";
export { speakingSeconds, type SpeakingOptions } from "./speaking.js";
export { calibrateSpeed, type CalibrateOptions, type CalibrateTry, type Calibration } from "./calibrate.js";
export { KOKORO_CAPABILITIES, kokoroFactory, kokoroProvider, type KokoroG2p, type KokoroProviderOptions } from "./kokoro/provider.js";
export type { KokoroEngine, KokoroEngineOptions } from "./kokoro/engine.js";
export type { TokenTime } from "./kokoro/timestamps.js";
export type { SpeechComponent, SpeechEnv } from "./config.js";
export {
  detectSpeechRuntime,
  runtimeOptions,
  speechDeviceEnvName,
  SPEECH_CACHE_ENV,
  SPEECH_DEVICE_ENV,
  SpeechRuntimeError,
  type SpeechDevice,
  type SpeechRuntime,
  type SpeechRuntimeInput,
} from "./runtime.js";
export { resolveSpeechRuntime, type ResolveSpeechRuntimeOptions } from "./resolve-runtime.js";
