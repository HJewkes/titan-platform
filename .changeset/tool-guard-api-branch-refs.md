---
"@titan-design/tool-guard": patch
---

Add `apiBranchRefWrite`, a matcher for GitHub REST writes that move a branch ref (`git/refs/heads/<x>`, or POST `git/refs` with a `ref` field) (TP-2733 a); not wired into the merge family yet.
