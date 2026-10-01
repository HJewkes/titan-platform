---
"@titan-design/github": minor
---

`reviewRulesBypassable(repo, branch)` reports whether the caller can bypass every pull-request rule on a branch, read from `rules/branches` and each ruleset's `current_user_can_bypass`. The fake gains a settable `reviewBypass`.
