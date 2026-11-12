---
"@titan-design/factory": patch
---

Let a run whose diff touches only Markdown (docs and changesets) go past fix-proof without an implementer wake, whatever its kind, recorded as `no-repro-non-source`. Let a correctness run move to refactor or feature with `register --kind-reason` before any review starts, recorded as a `kind-move` event; after review starts the move stays refused, and the registration keeps that a review started across a restart.
