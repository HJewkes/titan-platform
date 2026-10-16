---
"@titan-design/speech-vet": minor
---

Add `detectDefects` and `confirmDefects`, a port of the audiobook defect check at output parity, with `defectOptionsFor(stt)` gating the recogniser-confidence signal on the provider's `tokenLogprobs` capability (off by default). Also export `isUnusualWord`, `tokenizeWords`, `metaphone` and `phoneticDistance`.
