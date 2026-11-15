---
"@titan-design/memory": minor
---

`Provenance` now accepts `{ noteRef }` (`note:<slug>/<file>.md`) as well as `{ sessionRef, byteOffset? }`. The store persists and reloads both shapes, and `curate()` rejects a malformed note ref.
