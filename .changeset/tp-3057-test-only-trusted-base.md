---
"@titan-design/factory": patch
---

`testOnlyDiff` reads `.github/fix-proof.json` at the merge base of the default branch and the PR head, and refuses as unread a PR whose base is not the default branch, so a stacked parent branch can no longer loosen what counts as a test (TP-3057).
