---
"@titan-design/retrieval-eval": patch
---

The `notes-fts` candidate reads `workspace_span` once a graph has been cut over, and the shared table before that or while a backfill is unfinished, so it no longer returns nothing after the cutover.
