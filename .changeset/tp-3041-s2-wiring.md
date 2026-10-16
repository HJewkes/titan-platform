---
"@titan-design/speech-tts": minor
---

Add `resolveSpeechRuntime`, which loads the profile through `TITAN_SPEECH_PROFILE`, looks for onnxruntime-node beside
the transformers.js peer and runs `detectSpeechRuntime` on the real host. `kokoroFactory` takes a `runtime`: its
env-chosen device and cache beat a profile entry's, and its other values fill what the entry omits.
