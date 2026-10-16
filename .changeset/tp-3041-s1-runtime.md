---
"@titan-design/speech-tts": minor
---

Add `detectSpeechRuntime` and `runtimeOptions`: pick each speech model's device (cpu by default; cuda reported, and
refused as unverified until spike E9) and the model cache directory from the platform, `TITAN_SPEECH_DEVICE`,
`TITAN_SPEECH_DEVICE_<TTS|STT|PHONES>`, `TITAN_SPEECH_CACHE` and a new `runtime` section in the profile. The default
cache comes from `@titan-design/app-paths`, now a runtime dependency.
