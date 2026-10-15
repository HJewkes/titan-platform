---
"@titan-design/factory": patch
---

Shepherd's approve-merge carry now judges the whole range from the approved head by tree equality with `git merge-tree` of the approved head and the base. A fixer commit after the approval, however small, asks the owner again (TP-3070); a pure merge-up still carries. The small-fix rule and `SMALL_FIX_LIMITS` are removed.
