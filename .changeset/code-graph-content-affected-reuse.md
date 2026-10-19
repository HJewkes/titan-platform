---
"@titan-design/code-graph": patch
---

A seeded index now matches a cold one when a file's export surface changes: an unchanged file whose edges land on a changed file, or on a file that re-exports from one, re-extracts instead of carrying edges resolved against the old surface. `INDEX_VERSION` moves to 0.32.0, so graphs that already carry such stale edges are not reused.
