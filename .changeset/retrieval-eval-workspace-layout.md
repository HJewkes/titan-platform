---
"@titan-design/retrieval-eval": patch
---

Own the active-work workspace layout in one module, so an archived note hit from `hybrid-fts-vector` now matches the label mined from its `archive/` path and the served base rate lists archived initiatives too. `newestNotes` merges the legacy `notes/` and `sources/notes/` dirs before sorting by filename date instead of concatenating them.
