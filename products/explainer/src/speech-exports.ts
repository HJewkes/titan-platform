export { MAX_SENTENCE_WORDS, MAX_VETTED_SENTENCE_WORDS, MIN_PROJECT_SHARE, needsSpeechVet, overlongSentence, vettableSentences, voiceCheck, voiceCheckWith, type SpeechVerdict, type VoiceOptions } from "./lint-voice.js";
export { speechVerdict, verdictSummary, VETTED_RANGE, vetSentences, withSpeechVerdict, type SentenceVerdict, type SentenceVet } from "./speech-vet-gate.js";
export { localSentenceVet } from "./speech-vet-local.js";
export { hasSpokenDigits, spellSpokenNumbers, spokenDigitsCheck } from "./spoken-numbers.js";
