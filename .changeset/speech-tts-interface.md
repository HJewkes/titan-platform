---
"@titan-design/speech-tts": minor
---

Add speech-tts: the `TtsProvider` contract with capability descriptors and typed errors, a registry that selects a provider from a profile plus `TITAN_SPEECH_*` env overrides, and the `fakeTts`, `commandTts` (stdio JSON in, WAV or JSON out, process-group kill on timeout) and `httpTts` (template-mapped, no vendor SDK) adapters, all passing one conformance kit.
