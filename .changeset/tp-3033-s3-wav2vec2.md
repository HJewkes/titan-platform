---
"@titan-design/speech-stt": minor
---

Add `wav2vec2Recognizer`: espeak-style phone recognition with `wav2vec2-lv-60-espeak-cv-ft` over transformers.js, pinned to one ONNX revision, with `dtype` (`fp32` by default; `q8` gives different verdicts), `device`, `cacheDir`, `revision` and `threads`. `recognizeWithLogits` returns the per-frame `CtcLogits`, ids and greedy decode for forced alignment. The vocab is vendored in `data/`. Under TITAN_SPEECH_OFFLINE it refuses to load unless the exact weights file for the requested dtype and revision is cached.
