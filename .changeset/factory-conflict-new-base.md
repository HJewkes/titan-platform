---
"@titan-design/factory": patch
---

A Shepherd conflict against a base that moved past the fixer's merge-main now counts as a new conflict: the fixer is woken again instead of the run being demoted to the seat. A new recorded step, `sh-conflict-base`, reads the base sha and whether the head contains the base recorded at the last conflict; a failed read counts as the same base, so the D9 demotion still applies.
