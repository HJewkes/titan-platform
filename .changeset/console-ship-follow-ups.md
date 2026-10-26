---
"titan-console": minor
---

Ship rounds say, per side question, what would block Ship and send the PR back to the fixer, and badge each answer Blocks Ship or Won't block Ship (TP-3345). Each side answer can be marked This PR or Follow-up: a follow-up never blocks Ship, is recorded in a `follow-ups.json` sidecar, files an owner-inbox `review` item with the answer text and the round and PR, and is not asked to be addressed by a later round of the unit (TP-3346).
