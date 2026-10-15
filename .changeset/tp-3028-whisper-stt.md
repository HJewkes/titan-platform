---
"@titan-design/speech-stt": minor
---

Add `whisperStt`, a transformers.js Whisper recogniser (`onnx-community/whisper-base.en_timestamped` by default) that returns word-timed transcripts. It merges sub-word chunks into words, caches transcripts by audio hash, resamples to 16 kHz and passes `device` and `cacheDir` to the pipeline. `@huggingface/transformers` ^3 is an optional peer; when it is missing, the error names `npm i @huggingface/transformers`.
