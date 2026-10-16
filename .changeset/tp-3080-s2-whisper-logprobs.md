---
"@titan-design/speech-stt": minor
"@titan-design/speech-vet": patch
---

`whisperStt` now declares `capabilities.tokenLogprobs: true`. A logits processor records each decode step's token
log-prob, so words carry `probability` and each 30 s decode window is one segment with `avgLogprob` and
`compressionRatio`, with faster-whisper's semantics. `whisperStt({ tokenLogprobs: false })` keeps the old shape: no
`probability` and empty `segments`. `defectOptionsFor(whisperStt())` therefore turns speech-vet's signal A on.
