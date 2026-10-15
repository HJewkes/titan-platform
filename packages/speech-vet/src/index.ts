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
