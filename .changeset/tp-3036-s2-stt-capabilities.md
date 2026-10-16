---
"@titan-design/speech-stt": minor
---

`SttProvider` gains a required `capabilities: SttCapabilities` with `tokenLogprobs`, true when word `probability` and segment `avgLogprob` / `compressionRatio` come from token log-probs. `whisperStt` declares it `false`, because transformers.js 3.8.1 returns no token scores.
