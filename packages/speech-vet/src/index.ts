export { g2pText, plainText } from "./markup.js";
export {
  checkReadings,
  englishHeteronyms,
  HeteronymTableSchema,
  readingOf,
  tokenDump,
  type HeteronymTable,
  type PhonemeToken,
  type ReadingFinding,
  type ReadingStatus,
} from "./heteronyms.js";
export { LexiconEntrySchema, LexiconSchema, loadLexicon, respellingsOf, type Lexicon, type LexiconEntry } from "./lexicon.js";
export { generateCandidates, respeller, type Respeller } from "./respell.js";
export {
  isInitialism,
  SHOUTED_TWO_LETTER_WORDS,
  SPELLED_INITIALISMS,
  spellInitialisms,
  VOWELLESS_INTERJECTIONS,
  type InitialismOptions,
} from "./initialisms.js";
export {
  ageStep,
  cardinalStep,
  currencyStep,
  decimalStep,
  DEFAULT_NORMALIZE_STEPS,
  initialismStep,
  normalize,
  NUMBER_STEPS,
  ordinalStep,
  RATE_UNITS,
  rateStep,
  timeStep,
  whitespaceStep,
  type NormalizeStep,
} from "./normalize.js";
export { numberToOrdinal, numberToWords, spellDigits } from "./number-words.js";
export {
  ESPEAK_TIMEOUT_MS,
  espeakCliG2p,
  espeakVersion,
  type EspeakCliOptions,
  type EspeakRunner,
} from "./espeak-g2p.js";
export { misakiIpaG2p } from "./misaki-ipa-g2p.js";
export {
  admissiblePhones,
  cleanIpa,
  DEFAULT_PHONE_VOICE,
  expectedPhones,
  g2pSentence,
  MIN_PHONES_FOR_VERDICT,
  MIN_SPAN_RATIO_FOR_VERDICT,
  phonemeDistance,
  phoneMatchDistance,
  SHORT_WORD_MAX_PHONES,
  WEAK_FORMS,
  XTTS_FAULT_THRESHOLD,
  XTTS_FAULT_THRESHOLD_SHORT,
  XTTS_FAULT_THRESHOLD_UNUSUAL,
  type PhoneG2p,
  type PhoneG2pOptions,
} from "./phones.js";
export {
  chunkWordVerdicts,
  detectHallucinations,
  detectTailArtifact,
  HALLUCINATION_MIN_PHONES,
  recognizePhones,
  TAIL_STRAY_MIN_PHONES,
  type Hallucination,
  type HallucinationOptions,
  type PhoneRecognizer,
  type PhoneSource,
  type TailArtifact,
  type TailArtifactOptions,
  type WordVerdict,
  type WordVerdictOptions,
} from "./phone-verdicts.js";
export {
  checkHeardReadings,
  expandReading,
  readingIpa,
  type HeardReading,
  type HeardReadingOptions,
  type HeardStatus,
  type MisakiToIpa,
} from "./reading-phones.js";
export {
  bestTailTake,
  DEFAULT_RETRIES,
  keepTake,
  KEEP_TAKE_MARGIN,
  MIN_TARGET_WORD_LENGTH,
  regressions,
  synthesizeVerified,
  WORSE_MARGIN,
  wordDistances,
  type BestTailTakeOptions,
  type RawTake,
  type SynthesizeVerifiedOptions,
  type TailCandidate,
  type TailFix,
  type TakeScore,
  type VerifiedTake,
  type WordDistance,
  type WordDistanceOptions,
} from "./retake.js";
export {
  confirmDefects,
  defectOptionsFor,
  detectDefects,
  isUnusualWord,
  tokenizeWords,
  type Defect,
  type DefectCause,
  type DefectKind,
  type DefectOptions,
  type WordToken,
} from "./defects.js";
export { metaphone, phoneticDistance } from "./metaphone.js";
