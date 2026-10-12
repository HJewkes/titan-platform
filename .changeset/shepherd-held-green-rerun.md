---
"@titan-design/factory": patch
---

Shepherd: a held run that woke on red CI no longer waits in `sh-held-wait` forever when a rerun turns the held head green. The wait now also ends, once per head, when every required check at the held head passes; the next round reads CI afresh and goes on to review with the hold kept. FIX_FIRST and conflict wakes still wait for a push or a release, and a repo with no required checks keeps the old behaviour.
