---
"@titan-design/speech-tts": minor
---

Add speech-tts: the `TtsProvider` contract with capability descriptors and typed errors, a registry that selects a provider from a profile plus `TITAN_SPEECH_*` env overrides, and the `fakeTts`, `commandTts` (stdio JSON in, WAV or JSON out, process-group kill on timeout) and `httpTts` (template-mapped, no vendor SDK) adapters, all passing one conformance kit. Safe defaults for other deployments: no redirects, no plain http off loopback without `allowInsecureHttp`, a streamed `maxOutputBytes` cap (64 MB), a minimal command environment, secrets redacted from error text, a JSON `wav` path confined to the call's `outDir`, and fail-closed selection on misconfiguration unless `tts.fallback` is set.
