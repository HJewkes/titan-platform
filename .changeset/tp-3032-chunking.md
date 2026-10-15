---
"@titan-design/speech-tts": patch
---

Add Kokoro's 510-phoneme chunking (internal for now): a port of kokoro's `en_tokenize` and `waterfall_last`, the 510 cut `generate_from_tokens` applies, the voice-pack style row `len(ps) - 1`, and an offset that puts later chunks' word times on one clock, pinned by a golden recorded from Python Kokoro without a model.
