---
"@titan-design/speech-stt": patch
---

`whisperStt` throws an `offline:` error, before any network call, when `TITAN_SPEECH_OFFLINE` is set and the model is not in `cacheDir`.
