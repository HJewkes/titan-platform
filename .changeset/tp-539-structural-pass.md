---
"@titan-design/factory": minor
---

Shepherd's second `FIX_FIRST` on a pull request starts a structural pass instead of another patch round. A new `sh-wake-fix-first` step counts `FIX_FIRST` wakes across every head of the run. Every review after the first asks the reviewer for a `Defect class:` section naming the recurring defect class and the one boundary where a single fix covers it. From the second `FIX_FIRST` on, the fixer's brief carries that section and the whole findings verbatim, so no blocking item is dropped.
