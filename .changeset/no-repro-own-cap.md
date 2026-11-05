---
"@titan-design/factory": patch
---

TP-3900: a fix-proof `NO_REPRO` send-back no longer records a `FIX_FIRST`, so it spends only the two fix-proof wakes and never reaches `fix-first-runaway`. The third goes to the `sh-sent-back` gate, worded `fix-proof did not reproduce (NO_REPRO)`. D8's convergence review starts only when the trail holds a reviewer `FIX_FIRST` and the head's fix-proof did not say `NO_REPRO`. A run recorded before this change replays its `sh-wake-fix-first` and D8 steps without diverging.
