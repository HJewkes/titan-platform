---
"@titan-design/speech-tts": patch
---

Fix Kokoro word timings after a word with no phonemes: the timeline no longer drifts one id per such word, so the last word keeps its timing. The "does not speak" warning names the 510-phoneme cut only when a chunk was cut.
