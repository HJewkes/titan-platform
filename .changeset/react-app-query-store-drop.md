---
"@titan-design/react-app": patch
---

The query store's `drop` now clears the entry's pending drop timer and deletes only when the map still holds that entry, so a stale timer can no longer delete a re-watched query's newer entry and leave it stuck on `loading`.
