---
"@titan-design/speech-vet": minor
"@titan-design/speech-stt": minor
---

speech-vet: add the phone check, a port of the audiobook backend's phoneme validation at verdict parity. `chunkWordVerdicts` gives each target word an `xtts`, `whisper` or `inconclusive` verdict, `detectHallucinations` finds babble runs and `detectTailArtifact` finds stray phones after the last word. G2P is injected as `PhoneG2p` (espeak-ng's raw `--ipa=3` output, voice `en-us` by default), and `recognizePhones` cleans a recognizer's raw decode. speech-vet now depends on speech-stt.

speech-stt: export `roundHalfEven(x, digits)`, Python's `round`, half to even on the exact binary value.
