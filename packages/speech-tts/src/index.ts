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
  TtsError,
  TtsFailedError,
  TtsTimeoutError,
  TtsUnavailableError,
  TtsUnsupportedError,
  type TtsErrorCode,
} from "./errors.js";
export { assertSupported, languageMatches, missingCapabilities, requirementsOf } from "./capabilities.js";
export { decodeWav, encodeWav } from "./wav.js";
export { FAKE_TTS_CAPABILITIES, fakeTts, type FakeTtsCall, type FakeTtsOptions, type FakeTtsProvider } from "./fake-tts.js";
export { commandTts, type CommandOutput, type CommandRequest, type CommandTtsOptions } from "./command-tts.js";
export { httpTts, type HttpResponseMapping, type HttpTtsOptions } from "./http-tts.js";
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
