---
"@titan-design/speech-tts": patch
---

Add Kokoro's timing core (internal for now): a port of kokoro's `join_timestamps` with the divisor derived from the 600-sample hop, half-to-even duration rounding clamped to one frame, and a check that the frames sum to the waveform length, pinned by a golden recorded from Python Kokoro.
