---
"@titan-design/code-graph": patch
---

A seeded index now matches a cold one when a file's export surface changes. An unchanged file whose edges land on a file whose exports changed, or on a file that re-exports from one, re-extracts instead of carrying edges resolved against the old surface. A body-only edit changes no export, so its importers stay reused. `INDEX_VERSION` moves to 0.32.0, so graphs that already carry such stale edges are not reused.
