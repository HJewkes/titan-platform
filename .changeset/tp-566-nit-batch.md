---
"@titan-design/github": patch
"@titan-design/egress-scan": patch
---

TP-566: `execGh` rejects a maxBuffer overflow with its own error instead of the timeout message, and takes an optional `maxBufferBytes`. The egress-scan README now says the hook's `PATH` lookup ignores relative entries.
