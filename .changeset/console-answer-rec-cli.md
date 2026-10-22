---
"titan-console": patch
---

Add `titan-console rounds answer-rec <id> [--json]`, so tp-operator can relay the owner's text "rec" reply. It runs `rounds.answer-rec`'s own path in-process, bound to the sha256 of the round.json on disk, through the daemon's submit pipeline, and prints "<id>: answered N questions; feedback written". Each refusal prints its one-line reason to stderr and exits non-zero.
