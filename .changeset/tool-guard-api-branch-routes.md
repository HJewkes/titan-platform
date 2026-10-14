---
"@titan-design/tool-guard": patch
---

Add `apiBranchRouteWrite`, a matcher for GitHub REST writes that change a branch outside `git/refs`: contents PUT/DELETE, branch rename, merge-upstream, branch-protection writes and a repository PATCH of `default_branch` (TP-2755 a); not wired into the merge family yet. `api-branch-refs` now exports `routedPath`, `fieldKey`, `refBranch` and `asciiDecoded` for it.
