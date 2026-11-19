---
"titan-console": minor
---

An hourly deposit by-rec sweep in the console daemon answers an open owner deposit with its recommended option once the owner has left it silent for 24 h (or its own `onSilence apply-default afterHours`), attributed to auto-by-rec. With no policy file it runs in shadow and only logs would-resolve rows to `auto-by-rec.jsonl`; automation answers read back as `decided` and are ledgered as the decider's, not the owner's (TP-6774).
