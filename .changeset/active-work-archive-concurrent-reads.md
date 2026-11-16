---
"@titan-design/active-work": patch
---

Parse task files concurrently, up to 32 reads at a time, in the archive pass `active-work open` runs first. On a large initiative the pass no longer waits on one file read at a time.
