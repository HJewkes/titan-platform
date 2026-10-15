---
"@titan-design/factory": patch
---

`testOnlyDiff` refuses as unread a PR whose base is not the default branch. It reads `.github/fix-proof.json` at both the merge base of the default branch and the PR head and the default branch's tip, and calls a diff test-only only when both configs agree. A stacked parent branch, an old fork point that has wider globs, or one that predates the config can no longer loosen what counts as a test (TP-3057).
