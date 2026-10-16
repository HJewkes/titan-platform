---
"@titan-design/speech-tts": patch
---

Add the unpublished `smoke:speech` script (spike E8 promoted): Kokoro, Whisper and wav2vec2 on one constructed sentence, with `--suite`, `--device` and `--profile` resolved through `resolveSpeechRuntime`, and a zod-checked JSON report whose RTF is audio seconds / wall seconds. The published package is unchanged; the README gains a section on running it.
