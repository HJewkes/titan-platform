---
"@titan-design/factory": minor
---

Shepherd now keeps an owner's approve-merge `merge` answer across a small reviewed fix as well as a clean merge-up. A new head that is the approved head merged with its base plus a diff of at most 40 changed lines across at most 3 files, all already in the pull request, with no added, deleted, renamed or mode-changed file and no `.github`, lockfile or `package.json` dependency change, follows the answer when a reviewer said MERGE at exactly that head and required CI is green. The limits are the exported `SMALL_FIX_LIMITS`. The `sh-approval-carry` step records the rule and the tree or diff proof; any error computing the tree or diff asks the owner again.
