---
"@titan-design/explainer": minor
---

`eval cold` now asks about the spoken terms that cold viewers cannot define. Before the scoring runs, three fresh viewers each read the whole video's playback (rubric `l1-cold-terms.md`) and list the terms they could not define from it. A term is kept when at least two of the three runs name it, with case and plurals folded together. It is asked in the form the narration first speaks, at its first spoken beat, as a `spoken-term` question. The pass writes an `L1-cold-terms` run record holding its spend. If a terms call fails, the command exits 1. `coldTerms` is exported. The eval_version changes. The `paceBeats` wrapper is removed; use `paceInput(...).beats`.
