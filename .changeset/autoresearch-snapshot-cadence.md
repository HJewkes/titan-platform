---
"@titan-design/autoresearch": minor
---

Add snapshot cadence and the ar-sync recipe. A run with `snapshot` settings cuts a snapshot PR through the new optional `snapshot` port once enough ideas were kept or enough agent plus model dollars were spent, with one open at a time. While one is open, each round first syncs it through the optional `sync` port: a merged PR moves B onto main merged into the ratchet, re-measured when the tree changed, and a conflict or a frozen change holds the run at the `ar-sync-gate` assisted gate until the owner answers with a `resolved` sha. A run without `snapshot` settings records exactly what it did before.
