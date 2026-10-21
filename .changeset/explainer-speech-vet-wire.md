---
"@titan-design/explainer": minor
---

`explainer eval l0 --speech-vet` vets each sentence of 26 to 32 words with speech-vet over local Kokoro and Whisper and passes the verdicts to Q-V9, so the 32-word cap takes effect. Off by default; then, or when the models cannot load, the 25-word cap stays and one stderr line says so. A vet error counts as not clean. Adds `vetSentences`, `speechVerdict`, `withSpeechVerdict`, `vettableSentences` and `localSentenceVet` (TP-3829).
