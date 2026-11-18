---
"@titan-design/retrieval": minor
---

Add pure vocabulary correction: `extractTerms`, `scoreTerm`, a banded `editDistance`, `maxEditDistance`, `findCorrection`, `correctQuery` and an in-memory `vocabularyFromEntries` source. Terms keep their cased form, so a camelCase identifier earns its bonus. The vocabulary source is injected, so no database is needed (TP-988).
