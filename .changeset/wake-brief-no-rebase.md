---
"@titan-design/factory": patch
---

Every Shepherd fixer wake brief, whatever its kind, now forbids rebasing or resetting the pushed branch and says to `git merge` an updated base or sibling PR and push a plain new commit, so a refused push is never retried.
