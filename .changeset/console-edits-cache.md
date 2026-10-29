---
"titan-console": patch
---

`videos.edits` keeps each video's edit list until a ledger file, the run state or the CLI release changes, so a repeat read no longer spawns `explainer edit list`. A failed read is never kept.
