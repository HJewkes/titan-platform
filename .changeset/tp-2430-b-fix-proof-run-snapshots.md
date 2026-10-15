---
"@titan-design/fix-proof": patch
---

`run()` gives the base side, the head side and the judge their own bare snapshot of the two commits, fetched before either side runs, and reads the base reports before the head side starts, so head code cannot plant config, smudge filters or objects in the caller's repo or the judge's inputs (TP-2430 b).
