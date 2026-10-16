---
"@titan-design/coordinator": minor
---

Add `authoredBlockSchema`, `parseAuthored` and `renderAuthored` for the seat's authored handoff block (TP-2896 a): parse never throws and caps the JSON text at 1,500 chars; render drops standing rules past their `expires` UTC day and omits empty sections.
