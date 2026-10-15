# speech-tts: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You need speech audio and the engine must differ per deployment: an in-process model, a GPU box behind a command or ssh, or a hosted HTTP API. Callers state the capabilities they need (voice, word timestamps, phoneme input, speed), and a profile plus `TITAN_SPEECH_*` env picks the provider. Recognition and alignment are not here; they belong to the planned speech-stt package.
