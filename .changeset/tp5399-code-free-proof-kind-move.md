---
"@titan-design/factory": patch
---

Let a run whose diff touches no source and no test file go past fix-proof without an implementer wake, whatever its kind, recorded as `no-repro-non-source`. Let a correctness run move to refactor or feature with `register --kind-reason` before any review starts, recorded as a `kind-move` event; after review starts the move stays refused.
