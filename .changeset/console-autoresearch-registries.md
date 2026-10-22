---
"titan-console": minor
---

Add the autoresearch run page's registries and held-out validator panel. Registries tabs between the last 40 dead ends, the last 40 bugs, and a per-round bug-repeat rate (the share of L0 failures whose reason code an earlier round had already logged). The validator panel is set apart under a report-only notice and collapsed by default. It lists each look's date, ratchet sha, aggregate primary, gates and provenance from an optional `validator` field on `autoresearch.run`, and says "validator not reporting yet" while the run carries none. No other section reads that field.
