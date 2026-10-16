# speech-tts: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need speech audio and the engine must differ per deployment: an in-process model, a GPU box behind a command or ssh, or a hosted HTTP API. Callers state the capabilities they need (voice, word timestamps, phoneme input, speed), and a profile plus `TITAN_SPEECH_*` env picks the provider. It ships an in-process Kokoro provider (fp32, misaki phonemes, word timings from the model's own durations) and helpers to tune speed to a words-per-minute target. `detectSpeechRuntime` picks each speech model's device (CPU by default, CUDA reported but opt-in) and cache directory from the platform, `TITAN_SPEECH_*` env and the profile, for speech-tts and speech-stt alike. Recognition and alignment are not here; they belong to speech-stt.
