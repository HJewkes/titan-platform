---
"@titan-design/code-graph": patch
---

`classifyRole` now gives a `*.fixture.*` file (for example `big.fixture.ts` beside its test) the `fixture` role, as it already did for files under a `fixtures/` directory. `INDEX_VERSION` is now 0.25.0, so a snapshot indexed with the old roles is never reused.
