---
"@titan-design/factory": patch
---

Add the `sh-review-scope` probe step (TP-3735 S1): for a fix-round head it diffs the reviewed head merged with the base against the head, so main's changes drop out, and answers scoped (paths, head-side hunks, changed lines) or full on a rebase, conflict, over 400 lines, over 40 paths, a shell-active path or any git failure. Registered but not yet dispatched.
