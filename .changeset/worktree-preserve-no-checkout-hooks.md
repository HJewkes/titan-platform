---
"@titan-design/worktree": patch
---

Preserve the existing dispatcher CC410 guard by disabling repository checkout
hooks for each worktree-add invocation, without persisting configuration or
changing later git hooks. Keep timeout and late cleanup aware of the invocation
prefix; retain child cleanup coverage with the existing filter-timeout fixture.
