---
"@titan-design/memory": patch
---

`PlaybookStore.supersededBy` now skips supersedes edges whose target ref is not a memory ref, so a foreign-kind edge reads as absent instead of returning its id as a bullet id.
