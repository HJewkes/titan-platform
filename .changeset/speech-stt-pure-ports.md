---
"@titan-design/speech-stt": minor
---

Add speech-stt: a CPython-parity `SequenceMatcher` (matching blocks, opcodes, ratio, autojunk) checked against CPython goldens, `align` to time script words from a transcript, `normalize` and `diff` to score a take against its script, zod `Word`, `Segment` and `Transcript` schemas, and a pure TypeScript windowed-sinc `resample` so 24 kHz audio reaches a 16 kHz recogniser without ffmpeg.
